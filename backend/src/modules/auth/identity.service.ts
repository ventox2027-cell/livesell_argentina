import { Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import { env } from '@/config/env.schema';
import { DomainError } from '@/shared/errors/domain.error';

/**
 * Verificación de los tokens de identidad de Google y Apple.
 *
 * ─── Lo que este archivo evita ───
 *
 * La app manda un `idToken` que dice "soy juan@gmail.com". Si lo creyéramos,
 * cualquiera podría mandar un JSON con el email de otro y entrar a su cuenta.
 *
 * El token viene firmado por Google o Apple con una clave privada suya. Acá se
 * verifica esa firma contra sus claves públicas, y además:
 *
 *   · `iss` — que lo haya emitido quien decimos.
 *   · `aud` — que sea **para nuestra app**. Sin esto, un token válido emitido
 *     para cualquier otra aplicación de Google serviría para entrar acá. Es el
 *     error más común y el más grave de esta integración.
 *   · `exp` — que no esté vencido.
 *
 * ─── Las claves ───
 *
 * `createRemoteJWKSet` las descarga y las cachea, y las vuelve a pedir cuando
 * aparece un `kid` desconocido. Es importante que sea así: Google y Apple
 * rotan sus claves sin avisar, y una copia fija dejaría de validar de un día
 * para el otro.
 */

export class IdentityRejectedError extends DomainError {
  constructor(provider: string, reason: string) {
    super('IDENTITY_REJECTED', 'No pudimos verificar tu identidad', { provider, reason });
  }
}

export interface VerifiedIdentity {
  provider: 'google' | 'apple';
  /** `sub`: el identificador estable. Es la llave, no el email. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
}

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const APPLE_ISSUER = 'https://appleid.apple.com';

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  private readonly googleKeys: JWTVerifyGetKey = createRemoteJWKSet(
    new URL('https://www.googleapis.com/oauth2/v3/certs'),
  );
  private readonly appleKeys: JWTVerifyGetKey = createRemoteJWKSet(
    new URL('https://appleid.apple.com/auth/keys'),
  );

  /**
   * Audiencias aceptadas de Google.
   *
   * Son varias porque Android, iOS y web tienen client IDs distintos y la app
   * puede mandar cualquiera de los tres según dónde corra.
   */
  private googleAudiences(): string[] {
    return [
      env.GOOGLE_CLIENT_ID_ANDROID,
      env.GOOGLE_CLIENT_ID_IOS,
      env.GOOGLE_CLIENT_ID_WEB,
    ].filter((v): v is string => !!v);
  }

  async verifyGoogle(idToken: string): Promise<VerifiedIdentity> {
    const audiencias = this.googleAudiences();
    if (audiencias.length === 0) {
      // Sin `aud` configurado NO se verifica "de forma laxa": se rechaza. Una
      // verificación sin audiencia acepta tokens de cualquier app de Google.
      throw new IdentityRejectedError('google', 'sin client id configurado');
    }

    try {
      const { payload } = await jwtVerify(idToken, this.googleKeys, {
        audience: audiencias,
        algorithms: ['RS256'],
        clockTolerance: 30, // relojes de teléfonos: 30 s de gracia
      });

      if (!GOOGLE_ISSUERS.has(String(payload.iss))) {
        throw new IdentityRejectedError('google', 'emisor inesperado');
      }
      const subject = typeof payload.sub === 'string' ? payload.sub : null;
      if (!subject) throw new IdentityRejectedError('google', 'sin sub');

      const nombre = this.partirNombre(
        typeof payload.given_name === 'string' ? payload.given_name : null,
        typeof payload.family_name === 'string' ? payload.family_name : null,
        typeof payload.name === 'string' ? payload.name : null,
      );

      return {
        provider: 'google',
        subject,
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true,
        firstName: nombre.firstName,
        lastName: nombre.lastName,
        avatarUrl: typeof payload.picture === 'string' ? payload.picture : null,
      };
    } catch (err) {
      throw this.rechazar('google', err);
    }
  }

  /**
   * Verifica el token de identidad de Apple.
   *
   * Apple manda el nombre **una sola vez**, en la primera autorización, y por
   * fuera del token. Por eso `firstName` y `lastName` llegan como parámetro:
   * si no se guardan en ese primer login, no hay forma de recuperarlos después
   * y la cuenta queda sin nombre para siempre.
   */
  async verifyApple(
    idToken: string,
    nombreDeLaPrimeraVez?: { firstName?: string; lastName?: string },
  ): Promise<VerifiedIdentity> {
    const bundleId = env.APPLE_BUNDLE_ID;
    if (!bundleId) throw new IdentityRejectedError('apple', 'sin bundle id configurado');

    try {
      const { payload } = await jwtVerify(idToken, this.appleKeys, {
        issuer: APPLE_ISSUER,
        audience: bundleId,
        algorithms: ['RS256'],
        clockTolerance: 30,
      });

      const subject = typeof payload.sub === 'string' ? payload.sub : null;
      if (!subject) throw new IdentityRejectedError('apple', 'sin sub');

      return {
        provider: 'apple',
        subject,
        email: typeof payload.email === 'string' ? payload.email : null,
        // Apple manda `email_verified` como booleano o como el texto "true".
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        firstName: nombreDeLaPrimeraVez?.firstName?.trim() || null,
        lastName: nombreDeLaPrimeraVez?.lastName?.trim() || null,
        avatarUrl: null, // Apple no entrega foto
      };
    } catch (err) {
      throw this.rechazar('apple', err);
    }
  }

  /**
   * Convierte cualquier fallo en un rechazo genérico.
   *
   * El motivo se registra pero no sale hacia el cliente: decir "la firma no
   * valida" o "la audiencia es otra" le indica a un atacante exactamente qué
   * corregir.
   */
  private rechazar(provider: 'google' | 'apple', err: unknown): DomainError {
    if (err instanceof IdentityRejectedError) return err;
    const motivo = err instanceof Error ? err.message : String(err);
    this.logger.warn({ msg: 'token de identidad rechazado', provider, motivo });
    return new IdentityRejectedError(provider, 'verificación fallida');
  }

  /**
   * Los proveedores no siempre mandan nombre y apellido por separado.
   *
   * Con un nombre completo se parte por el primer espacio: el resto va al
   * apellido, porque "María José Pérez García" es más probable que sea
   * "María" + "José Pérez García" mal que "María José Pérez" + "García" mal.
   * En cualquier caso la persona lo puede corregir en su perfil.
   */
  private partirNombre(
    given: string | null,
    family: string | null,
    full: string | null,
  ): { firstName: string | null; lastName: string | null } {
    if (given || family) return { firstName: given, lastName: family };
    if (!full) return { firstName: null, lastName: null };

    const partes = full.trim().split(/\s+/);
    if (partes.length === 1) return { firstName: partes[0]!, lastName: null };
    return { firstName: partes[0]!, lastName: partes.slice(1).join(' ') };
  }
}
