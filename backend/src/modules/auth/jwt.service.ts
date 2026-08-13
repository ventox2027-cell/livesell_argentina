import { Injectable, Logger } from '@nestjs/common';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

import { env } from '@/config/env.schema';
import { DomainError } from '@/shared/errors/domain.error';

/**
 * Emisión y verificación de access tokens.
 *
 * HS256 y no RS256: con un solo servicio verificando sus propios tokens, un
 * par de claves asimétricas agrega gestión de claves sin comprar nada. Cuando
 * haya un segundo servicio que necesite verificar sin poder firmar —el panel
 * de administración, por ejemplo— se cambia acá y en ningún otro lado.
 *
 * ─── Por qué el access token no se puede revocar ───
 *
 * Es deliberado. Un token que hay que consultar contra la base en cada
 * petición no es un JWT: es un identificador de sesión con pasos de más. El
 * valor del JWT es justamente que se verifica con matemática y sin E/S.
 *
 * El precio es que un token robado sirve hasta que expira. Por eso vive 15
 * minutos, y por eso lo que sí se revoca —al instante y desde el servidor— es
 * el refresh token.
 */

export class InvalidTokenError extends DomainError {
  constructor(reason: string) {
    super('INVALID_TOKEN', 'Token inválido o expirado', { reason });
  }
}

export interface AccessTokenPayload extends JWTPayload {
  sub: string;
  role: string;
  /** Id de sesión: la familia de refresh tokens a la que pertenece. */
  sid: string;
}

export interface IssuedAccessToken {
  accessToken: string;
  expiresInSec: number;
  expiresAt: string;
}

@Injectable()
export class JwtService {
  private readonly logger = new Logger(JwtService.name);
  private readonly key = new TextEncoder().encode(env.JWT_SECRET);

  async issueAccessToken(params: {
    userId: string;
    role: string;
    sessionId: string;
  }): Promise<IssuedAccessToken> {
    const ttl = env.JWT_ACCESS_TTL_S;
    const ahora = Math.floor(Date.now() / 1000);

    const accessToken = await new SignJWT({ role: params.role, sid: params.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(params.userId)
      .setIssuedAt(ahora)
      .setExpirationTime(ahora + ttl)
      .setIssuer(env.JWT_ISSUER)
      .setAudience(env.JWT_AUDIENCE)
      // `jti` para poder rastrear un token concreto en los logs sin que el
      // token entero aparezca escrito en ningún lado.
      .setJti(crypto.randomUUID())
      .sign(this.key);

    return {
      accessToken,
      expiresInSec: ttl,
      expiresAt: new Date((ahora + ttl) * 1000).toISOString(),
    };
  }

  /**
   * Verifica un access token.
   *
   * Comprueba firma, expiración, emisor y audiencia. Las dos últimas no son
   * ceremonia: sin validar `aud`, un token emitido por este mismo backend para
   * otro propósito —por ejemplo, un enlace de verificación de email— serviría
   * para autenticarse como el usuario.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        algorithms: ['HS256'],
        // Sin tolerancia de reloj: emisor y verificador son el mismo proceso.
        clockTolerance: 0,
      });

      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new InvalidTokenError('sin sub');
      }
      if (typeof payload.role !== 'string') throw new InvalidTokenError('sin role');
      if (typeof payload.sid !== 'string') throw new InvalidTokenError('sin sid');

      return payload as AccessTokenPayload;
    } catch (err) {
      if (err instanceof InvalidTokenError) throw err;
      /**
       * El motivo se registra pero NO se le devuelve a quien llama.
       *
       * Distinguir "firma inválida" de "expirado" de "audiencia equivocada" le
       * dice a un atacante exactamente qué ajustar en el próximo intento. Para
       * el cliente legítimo la respuesta útil es siempre la misma: pedí uno
       * nuevo con tu refresh token.
       */
      const motivo = err instanceof Error ? err.message : String(err);
      this.logger.debug({ msg: 'access token rechazado', motivo });
      throw new InvalidTokenError('verificación fallida');
    }
  }
}
