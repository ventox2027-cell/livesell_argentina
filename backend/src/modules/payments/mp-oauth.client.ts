import { Injectable, Logger } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { DomainError } from '@/shared/errors/domain.error';

import { METODO_DE_DESAFIO } from './pkce';

/**
 * El cliente OAuth de Mercado Pago.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTA CLASE ES LA ÚNICA QUE VE UN TOKEN DE VENDEDOR EN CLARO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Y ni siquiera lo guarda: lo devuelve y se olvida. Quien lo cifra y lo
 * persiste es `SellerOAuthService`.
 *
 * ⛔ **Nada de lo que pasa por acá se loguea.** Ni el `client_secret`, ni el
 * `code`, ni el `access_token`, ni el `refresh_token`. Los mensajes de error
 * llevan el código HTTP y la descripción de Mercado Pago, nunca el cuerpo
 * completo de la petición.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ EL TOKEN NO PUEDE PASAR NUNCA POR FLUTTER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El flujo obvio sería: la app abre la autorización, Mercado Pago le devuelve
 * el `code`, la app se lo manda al backend. Está mal por dos razones:
 *
 *   1. el `code` viaja por el navegador del teléfono y queda en el historial,
 *      en los logs del sistema y a la vista de cualquier otra app que pueda
 *      interceptar el esquema del deep link;
 *   2. el intercambio `code` → `token` necesita el `client_secret`. Si lo
 *      hiciera la app, el secreto estaría en el APK, y un APK se descompila en
 *      dos minutos. Con ese secreto, cualquiera puede hacerse pasar por VendoX
 *      ante Mercado Pago.
 *
 * Por eso Mercado Pago redirige **al backend**, no a la app: el `redirect_uri`
 * apunta a nuestro servidor, el intercambio ocurre servidor a servidor, y a la
 * app sólo le vuelve un "listo, quedó conectada".
 */

/** Lo que devuelve Mercado Pago al canjear el código. */
export interface TokensDeVendedor {
  accessToken: string;
  refreshToken: string | null;
  /** El `user_id` del vendedor en Mercado Pago. No es un secreto. */
  providerAccountId: string;
  /** Segundos hasta que vence el access token. */
  expiresIn: number;
  scopes: string | null;
  /** Clave pública del vendedor, si viene. Es pública por diseño. */
  publicKey: string | null;
}

export class OAuthNoConfiguradoError extends DomainError {
  constructor() {
    super(
      'MP_OAUTH_NOT_CONFIGURED',
      'La conexión con Mercado Pago todavía no está habilitada en este servidor',
    );
  }
}

export class OAuthRechazadoError extends DomainError {
  constructor(detalle: string) {
    super('MP_OAUTH_REJECTED', 'Mercado Pago no aceptó la conexión', { detalle });
  }
}

@Injectable()
export class MercadoPagoOAuthClient {
  private readonly logger = new Logger(MercadoPagoOAuthClient.name);

  /** Sin credenciales, todo el bloque responde "no configurado" en vez de 500. */
  get configurado(): boolean {
    return Boolean(env.MP_CLIENT_ID && env.MP_CLIENT_SECRET && env.MP_OAUTH_REDIRECT_URI);
  }

  /**
   * La URL a la que hay que mandar al vendedor.
   *
   * ─── El `state` no se genera acá ───
   *
   * Lo genera y lo guarda el servicio, porque tiene que quedar persistido ANTES
   * de que la persona salga de la app. Si esta clase lo inventara, existiría un
   * instante en que la URL ya está armada y la fila todavía no, y el callback
   * de un usuario muy rápido llegaría a un `state` que no existe.
   */
  urlDeAutorizacion(state: string, codeChallenge: string): string {
    if (!this.configurado) throw new OAuthNoConfiguradoError();

    const url = new URL('https://auth.mercadopago.com.ar/authorization');
    url.searchParams.set('client_id', env.MP_CLIENT_ID!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('platform_id', 'mp');
    url.searchParams.set('redirect_uri', env.MP_OAUTH_REDIRECT_URI!);
    url.searchParams.set('state', state);

    /**
     * PKCE. Viaja el DESAFÍO, nunca el verificador.
     *
     * Quien vea esta URL —el historial del navegador, un log de proxy— ve el
     * hash. Del hash no se puede volver al verificador, así que interceptar el
     * código no alcanza para canjearlo. Ver `pkce.ts`.
     */
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', METODO_DE_DESAFIO);

    return url.toString();
  }

  /**
   * Canjea el código por los tokens. **Servidor a servidor.**
   *
   * El `client_secret` sale del entorno de este proceso y no viaja a ningún
   * lado más.
   */
  async canjearCodigo(code: string, codeVerifier: string | null): Promise<TokensDeVendedor> {
    return this.pedirTokens({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.MP_OAUTH_REDIRECT_URI!,
      /**
       * El verificador cierra el circuito de PKCE.
       *
       * Mercado Pago comprueba que su hash coincida con el desafío que recibió
       * al empezar. Si no coincide —o si falta— rechaza el canje.
       *
       * Se manda condicionalmente porque una autorización empezada ANTES de que
       * existiera PKCE tiene la columna en `null`. Mandar `undefined` haría que
       * el canje fallara para esa persona, que no hizo nada mal.
       */
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    });
  }

  /**
   * Renueva el access token con el refresh token.
   *
   * ⚠️ Mercado Pago **rota el refresh token**: la respuesta trae uno nuevo y el
   * viejo deja de valer. Guardar el nuevo no es opcional — si se descarta, el
   * vendedor queda sin poder renovar y hay que pedirle que autorice de nuevo,
   * seis meses después, sin que él haya hecho nada mal.
   */
  async renovar(refreshToken: string): Promise<TokensDeVendedor> {
    return this.pedirTokens({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  private async pedirTokens(extra: Record<string, string>): Promise<TokensDeVendedor> {
    if (!this.configurado) throw new OAuthNoConfiguradoError();

    const cuerpo = {
      client_id: env.MP_CLIENT_ID!,
      client_secret: env.MP_CLIENT_SECRET!,
      ...extra,
    };

    let respuesta: Response;
    try {
      respuesta = await fetch('https://api.mercadopago.com/oauth/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(env.MP_TIMEOUT_MS),
      });
    } catch (err) {
      /**
       * Un fallo de red NO es lo mismo que un rechazo.
       *
       * Si Mercado Pago no contestó, el código podría haberse canjeado igual
       * del otro lado. Se distingue para que el vendedor vea "probá de nuevo"
       * y no "Mercado Pago rechazó tu conexión", que lo mandaría a revisar su
       * cuenta buscando un problema que no existe.
       */
      this.logger.error({
        msg: 'no se pudo hablar con el OAuth de Mercado Pago',
        // El mensaje de red no lleva credenciales. El cuerpo NUNCA se registra.
        error: err instanceof Error ? err.message : String(err),
      });
      throw new DomainError(
        'MP_OAUTH_UNAVAILABLE',
        'No pudimos conectar con Mercado Pago. Probá de nuevo en un momento.',
      );
    }

    const texto = await respuesta.text();

    if (!respuesta.ok) {
      /**
       * Se registra el código y el mensaje corto, no el cuerpo entero.
       *
       * Mercado Pago devuelve el `client_id` en varios errores, y algunos
       * incluyen parte de lo que se mandó. Un log completo terminaría con
       * material sensible en el agregador de logs, que es justamente donde más
       * gente tiene acceso.
       */
      const breve = this.motivoBreve(texto);
      this.logger.warn({ msg: 'el OAuth de Mercado Pago rechazó', status: respuesta.status, breve });
      throw new OAuthRechazadoError(breve);
    }

    let datos: Record<string, unknown>;
    try {
      datos = JSON.parse(texto) as Record<string, unknown>;
    } catch {
      throw new OAuthRechazadoError('respuesta ilegible');
    }

    const accessToken = typeof datos.access_token === 'string' ? datos.access_token : '';
    if (!accessToken) throw new OAuthRechazadoError('no vino el token');

    return {
      accessToken,
      refreshToken: typeof datos.refresh_token === 'string' ? datos.refresh_token : null,
      // Mercado Pago lo manda como número. Se guarda como texto porque es un
      // identificador, no una cantidad: nadie va a sumar dos user_id.
      //
      // Se acepta sólo número o texto: si llegara un objeto -por un cambio de
      // la API- `String()` daría "[object Object]" y guardaríamos esa cadena
      // como identificador de cuenta, que después nadie sabe de dónde salió.
      providerAccountId: this.comoTexto(datos.user_id),
      expiresIn: typeof datos.expires_in === 'number' ? datos.expires_in : 15_552_000,
      scopes: typeof datos.scope === 'string' ? datos.scope : null,
      publicKey: typeof datos.public_key === 'string' ? datos.public_key : null,
    };
  }

  /**
   * Saca un motivo corto del error sin arrastrar el cuerpo entero.
   *
   * Cortado a 200 caracteres: alcanza para entender qué pasó y no alcanza para
   * que entre un token en el log por accidente.
   */
  /**
   * Un valor desconocido convertido a texto, sin "[object Object]".
   *
   * Convertir cualquier cosa con `String()` parece inofensivo hasta que la
   * API cambia y termina guardado un "[object Object]" como identificador de
   * cuenta de un vendedor. Se acepta lo que es texto o número; lo demás es
   * cadena vacía, que al menos se nota.
   */
  private comoTexto(valor: unknown): string {
    if (typeof valor === 'string') return valor;
    if (typeof valor === 'number' || typeof valor === 'bigint') return valor.toString();
    return '';
  }

  private motivoBreve(texto: string): string {
    try {
      const j = JSON.parse(texto) as Record<string, unknown>;
      const mensaje = this.comoTexto(j.message ?? j.error ?? j.error_description);
      return (mensaje || 'sin detalle').slice(0, 200);
    } catch {
      return texto.slice(0, 200);
    }
  }
}
