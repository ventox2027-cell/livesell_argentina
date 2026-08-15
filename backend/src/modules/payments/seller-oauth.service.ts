import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { env } from '@/config/env.schema';
import { AuditService } from '@/shared/audit/audit.service';
import {
  cifrar,
  descifrar,
  leerLlave,
  pista,
  type SecretoCifrado,
} from '@/shared/crypto/secretos';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { MercadoPagoOAuthClient, OAuthNoConfiguradoError } from './mp-oauth.client';
import { generarPkce } from './pkce';
import {
  RequiereMercadoPagoError,
  puedeVender,
  type AccionQueRequiereMp,
} from './puede-vender';

/**
 * La conexión de un vendedor con su cuenta de Mercado Pago.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NINGÚN TOKEN SALE DE ACÁ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `estado()` devuelve si está conectada, cuándo y con qué cuenta. No devuelve
 * el token, ni una parte, ni la referencia para pedirlo.
 *
 * El único método que entrega un token en claro es `accessTokenDe()`, y existe
 * para que el módulo de pagos pueda cobrar. No hay endpoint HTTP que llegue a
 * él, y no puede haberlo.
 */

export class NoEsVendedorError extends DomainError {
  constructor() {
    super('SELLER_NOT_FOUND', 'No tenés una tienda todavía');
  }
}

export class CuentaNoConectadaError extends DomainError {
  constructor() {
    super(
      'MP_ACCOUNT_NOT_CONNECTED',
      'Este vendedor todavía no conectó su cuenta de Mercado Pago',
    );
  }
}

export class EstadoInvalidoError extends DomainError {
  constructor() {
    // Deliberadamente vago hacia afuera. El detalle va al log, no a la
    // respuesta: quien está probando un ataque no necesita saber si falló
    // porque venció, porque ya se usó o porque nunca existió.
    super('MP_OAUTH_STATE_INVALID', 'El pedido de conexión no es válido o venció');
  }
}

/** Cuánto vive un `state`. Diez minutos es lo que tarda una persona en autorizar. */
const MINUTOS_DEL_STATE = 10;

@Injectable()
export class SellerOAuthService {
  private readonly logger = new Logger(SellerOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cliente: MercadoPagoOAuthClient,
    private readonly audit: AuditService,
  ) {}

  /**
   * La llave de cifrado, validada.
   *
   * Se resuelve en cada uso y no en el constructor a propósito: así el módulo
   * arranca sin llave y todo el sistema funciona igual —el bloque de conexión
   * responde "no configurado"— en vez de impedir que el proceso levante por
   * una función que la mayoría de los despliegues todavía no usa.
   */
  private get llave() {
    if (!env.CREDENTIALS_ENCRYPTION_KEY) throw new OAuthNoConfiguradoError();
    return leerLlave(env.CREDENTIALS_ENCRYPTION_KEY);
  }

  get disponible(): boolean {
    return this.cliente.configurado && Boolean(env.CREDENTIALS_ENCRYPTION_KEY);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONECTAR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Arranca la autorización: devuelve la URL a la que hay que mandar al
   * vendedor.
   *
   * ─── El `state` se guarda ANTES de devolver la URL ───
   *
   * Si se devolviera primero y se guardara después, existiría un instante con
   * la URL viva y la fila inexistente. Un vendedor rápido —o un reintento
   * automático— llegaría al callback con un `state` que todavía no está, y
   * vería un error después de haber puesto su contraseña de Mercado Pago.
   */
  async iniciar(userId: string): Promise<{ url: string; expiraEn: number }> {
    const seller = await this.sellerDe(userId);
    if (!this.disponible) throw new OAuthNoConfiguradoError();

    /**
     * 32 bytes de `randomBytes`, no `Math.random()`.
     *
     * Este valor es lo único que impide que alguien conecte SU cuenta de
     * Mercado Pago a la tienda de otro. `Math.random()` no es criptográfico:
     * su secuencia se puede predecir observando salidas anteriores.
     */
    const state = randomBytes(32).toString('base64url');

    /**
     * PKCE: el verificador se guarda, el desafío viaja.
     *
     * Ata el código a ESTA petición. El `state` ata el callback a esta persona;
     * son defensas distintas y las dos hacen falta. Ver `pkce.ts`.
     */
    const pkce = generarPkce();
    const expiresAt = new Date(Date.now() + MINUTOS_DEL_STATE * 60_000);

    /**
     * Los `state` anteriores de este vendedor se invalidan.
     *
     * Alguien que toca "conectar" tres veces deja tres autorizaciones vivas, y
     * la que termine primero gana. Es confuso y no aporta nada: la última
     * intención es la que vale.
     */
    await this.prisma.oAuthState.updateMany({
      where: { sellerId: seller.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    await this.prisma.oAuthState.create({
      data: {
        id: newId('oas'),
        sellerId: seller.id,
        state,
        expiresAt,
        // ⛔ El verificador vive sólo acá. Nunca sale por HTTP.
        codeVerifier: pkce.verifier,
      },
    });

    return {
      url: this.cliente.urlDeAutorizacion(state, pkce.challenge),
      expiraEn: MINUTOS_DEL_STATE * 60,
    };
  }

  /**
   * El callback de Mercado Pago: canjea el código y guarda los tokens.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * NO HAY SESIÓN ACÁ
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Esto lo invoca el NAVEGADOR del vendedor siguiendo una redirección de
   * Mercado Pago. No lleva nuestro encabezado de autorización y no puede
   * llevarlo.
   *
   * Entonces, ¿de dónde sale la identidad? **Del `state`.** La fila dice a qué
   * vendedor pertenece esa autorización, y esa fila la escribimos nosotros
   * cuando esa persona, con su sesión válida, tocó "conectar".
   *
   * Por eso el `state` no es un detalle de protocolo: es la autenticación de
   * este endpoint.
   */
  async completar(state: string, code: string): Promise<{ sellerId: string }> {
    if (!this.disponible) throw new OAuthNoConfiguradoError();

    /**
     * Se consume con un UPDATE condicional, no con "buscar y después marcar".
     *
     * La condición y la escritura son la misma operación: dos peticiones
     * simultáneas con el mismo `state` —un doble toque, un reintento del
     * navegador— sólo pueden hacer que UNA gane. La que pierde ve `count: 0` y
     * se rechaza, en vez de canjear el mismo código dos veces.
     */
    const ahora = new Date();
    const { count } = await this.prisma.oAuthState.updateMany({
      where: { state, usedAt: null, expiresAt: { gt: ahora } },
      data: { usedAt: ahora },
    });

    if (count === 0) {
      // El log distingue los casos; la respuesta no. Ver `EstadoInvalidoError`.
      this.logger.warn({ msg: 'callback de OAuth con state inválido, vencido o repetido' });
      throw new EstadoInvalidoError();
    }

    const fila = await this.prisma.oAuthState.findUnique({
      where: { state },
      select: { sellerId: true, codeVerifier: true },
    });
    if (!fila) throw new EstadoInvalidoError();

    const tokens = await this.cliente.canjearCodigo(code, fila.codeVerifier);
    await this.guardar(fila.sellerId, tokens);

    return { sellerId: fila.sellerId };
  }

  /** Guarda los tokens cifrados y deja la cuenta como conectada. */
  private async guardar(
    sellerId: string,
    tokens: {
      accessToken: string;
      refreshToken: string | null;
      providerAccountId: string;
      expiresIn: number;
      scopes: string | null;
    },
  ): Promise<void> {
    const llave = this.llave;
    const acceso = cifrar(tokens.accessToken, llave);
    const refresco = tokens.refreshToken ? cifrar(tokens.refreshToken, llave) : null;
    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1_000);

    await this.prisma.$transaction(async (tx) => {
      await tx.sellerOAuthCredential.upsert({
        where: { sellerId_provider: { sellerId, provider: 'MERCADO_PAGO' } },
        create: {
          id: newId('soc'),
          sellerId,
          accessCiphertext: acceso.ciphertext,
          accessIv: acceso.iv,
          accessTag: acceso.tag,
          refreshCiphertext: refresco?.ciphertext ?? null,
          refreshIv: refresco?.iv ?? null,
          refreshTag: refresco?.tag ?? null,
          keyVersion: acceso.version,
          accessHint: pista(tokens.accessToken),
          expiresAt,
        },
        update: {
          accessCiphertext: acceso.ciphertext,
          accessIv: acceso.iv,
          accessTag: acceso.tag,
          refreshCiphertext: refresco?.ciphertext ?? null,
          refreshIv: refresco?.iv ?? null,
          refreshTag: refresco?.tag ?? null,
          keyVersion: acceso.version,
          accessHint: pista(tokens.accessToken),
          expiresAt,
          refreshedAt: new Date(),
        },
      });

      await tx.sellerPaymentAccount.upsert({
        where: { sellerId_provider: { sellerId, provider: 'MERCADO_PAGO' } },
        create: {
          id: newId('spa'),
          sellerId,
          providerAccountId: tokens.providerAccountId,
          status: 'CONNECTED',
          scopes: tokens.scopes,
          expiresAt,
          connectedAt: new Date(),
        },
        update: {
          providerAccountId: tokens.providerAccountId,
          status: 'CONNECTED',
          scopes: tokens.scopes,
          expiresAt,
          connectedAt: new Date(),
          disconnectedAt: null,
        },
      });
    });

    /**
     * Se audita la conexión, nunca el token.
     *
     * Lo que queda registrado es: qué vendedor, qué cuenta de Mercado Pago y
     * cuándo. Con eso se puede investigar un cobro que fue a la cuenta
     * equivocada sin que la bitácora sea, ella misma, una filtración.
     */
    await this.audit.log({
      action: 'seller.mp_connected',
      entityType: 'seller',
      entityId: sellerId,
      actorId: sellerId,
      after: {
        providerAccountId: tokens.providerAccountId,
        // ⚠️ La pista, no el token.
        accessHint: pista(tokens.accessToken),
        expiresAt: expiresAt.toISOString(),
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONSULTAR Y DESCONECTAR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * El estado de la conexión. **Sin tokens.**
   *
   * Es lo que ve el vendedor en su panel: si puede cobrar, con qué cuenta y
   * hasta cuándo.
   */
  async estado(userId: string) {
    const seller = await this.sellerDe(userId);

    const cuenta = await this.prisma.sellerPaymentAccount.findUnique({
      where: { sellerId_provider: { sellerId: seller.id, provider: 'MERCADO_PAGO' } },
      select: {
        status: true,
        providerAccountId: true,
        connectedAt: true,
        disconnectedAt: true,
        expiresAt: true,
      },
    });

    const credencial = await this.prisma.sellerOAuthCredential.findUnique({
      where: { sellerId_provider: { sellerId: seller.id, provider: 'MERCADO_PAGO' } },
      // ⚠️ Sólo la pista y las fechas. El texto cifrado tampoco sale: no sirve
      // sin la llave, pero mandarlo sería regalarle a un atacante la mitad del
      // problema.
      select: { accessHint: true, expiresAt: true, refreshedAt: true },
    });

    return {
      disponible: this.disponible,
      conectada: cuenta?.status === 'CONNECTED',
      estado: cuenta?.status ?? 'NOT_CONNECTED',
      cuentaDeMercadoPago: cuenta?.providerAccountId ?? null,
      conectadaEl: cuenta?.connectedAt ?? null,
      desconectadaEl: cuenta?.disconnectedAt ?? null,
      venceEl: credencial?.expiresAt ?? cuenta?.expiresAt ?? null,
      ultimaRenovacion: credencial?.refreshedAt ?? null,
      tokenTerminaEn: credencial?.accessHint ?? null,
      /** La comisión que se le descuenta a cada venta. Vigente, no histórica. */
      comisionBps: env.VENDOX_PLATFORM_FEE_BPS,
      /**
       * ═══════════════════════════════════════════════════════════════════
       * TRES CAMPOS PORQUE SON TRES PREGUNTAS DISTINTAS
       * ═══════════════════════════════════════════════════════════════════
       *
       * Antes había uno solo, `obligatoriaParaVender`, que en realidad
       * respondía "¿te falta conectarla?". Para un vendedor YA conectado valía
       * `false`, y leído desde afuera eso parecía decir que Mercado Pago no era
       * obligatorio — cuando sí lo es.
       *
       * Un nombre que hace dudar de si la regla está activa es un nombre malo,
       * aunque el valor sea correcto. Los tres los decide el servidor: la regla
       * depende de un interruptor y de si el OAuth está configurado acá, y la
       * app no tiene forma de saber ninguna de las dos cosas.
       */

      /** ¿Este servidor exige Mercado Pago para vender? Es la REGLA. */
      mercadoPagoObligatorio: env.SELLER_MUST_CONNECT_MP && this.disponible,

      /** ¿Este vendedor puede publicar y transmitir AHORA? */
      puedeVender:
        !env.SELLER_MUST_CONNECT_MP ||
        !this.disponible ||
        cuenta?.status === 'CONNECTED',

      /**
       * ¿Le falta conectarla? Es la llamada a la acción de la interfaz.
       *
       * Es lo que antes se llamaba `obligatoriaParaVender`.
       */
      faltaConectar:
        env.SELLER_MUST_CONNECT_MP && this.disponible && cuenta?.status !== 'CONNECTED',
    };
  }

  /**
   * Desconecta la cuenta.
   *
   * ─── Los tokens se BORRAN, no se marcan ───
   *
   * Alguien que desconecta su cuenta está diciendo "no quiero que puedan cobrar
   * en mi nombre". Dejar el token cifrado en la base con una bandera de
   * `disconnected` sería no cumplir eso: la fila sigue ahí, y la bandera es una
   * línea de código que alguien puede saltearse.
   *
   * Lo que sí queda es el registro en `SellerPaymentAccount` —cuándo conectó,
   * cuándo desconectó— que es historia, no una credencial.
   */
  async desconectar(userId: string): Promise<{ ok: true }> {
    const seller = await this.sellerDe(userId);

    await this.prisma.$transaction(async (tx) => {
      await tx.sellerOAuthCredential.deleteMany({
        where: { sellerId: seller.id, provider: 'MERCADO_PAGO' },
      });
      await tx.sellerPaymentAccount.updateMany({
        where: { sellerId: seller.id, provider: 'MERCADO_PAGO' },
        // `REVOKED` y no `NOT_CONNECTED`: son cosas distintas. El primero es
        // "conectó y después revocó" —hay historia, y hay que saber desde
        // cuándo no puede cobrar—; el segundo es "nunca conectó".
        data: { status: 'REVOKED', disconnectedAt: new Date(), expiresAt: null },
      });
    });

    await this.audit.log({
      action: 'seller.mp_disconnected',
      entityType: 'seller',
      entityId: seller.id,
      actorId: seller.id,
    });

    return { ok: true };
  }

  /**
   * ¿Este vendedor puede publicar y transmitir?
   *
   * Lo llaman productos y vivos antes de dejar publicar, y también la app para
   * mostrar el estado. Por eso devuelve un booleano y no lanza: la pantalla de
   * "Mi tienda" necesita la respuesta, no una excepción.
   */
  async puedeVender(sellerId: string): Promise<boolean> {
    const [conectada, vendedor] = await Promise.all([
      this.prisma.sellerPaymentAccount.count({
        where: { sellerId, provider: 'MERCADO_PAGO', status: 'CONNECTED' },
      }),
      /**
       * La marca de cuenta de revisión sale de `User`, no de un parámetro.
       *
       * Sólo la escribe `scripts/cuenta-de-revision.mjs`: no hay ningún
       * endpoint que la toque, así que no se puede convertir una cuenta
       * cualquiera en exenta desde afuera.
       */
      this.prisma.seller.findUnique({
        where: { id: sellerId },
        select: { user: { select: { isDemoAccount: true } } },
      }),
    ]);

    return puedeVender({
      reglaActiva: env.SELLER_MUST_CONNECT_MP,
      oauthDisponible: this.disponible,
      cuentaConectada: conectada > 0,
      esCuentaDeDemostracion: vendedor?.user.isDemoAccount === true,
    });
  }

  /** Lo mismo, pero lanza. Para los puntos donde hay que frenar. */
  async exigirParaVender(sellerId: string, accion: AccionQueRequiereMp): Promise<void> {
    if (!(await this.puedeVender(sellerId))) throw new RequiereMercadoPagoError(accion);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // USAR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * El access token de un vendedor, en claro, para cobrar en su nombre.
   *
   * ⛔ **No hay ni puede haber un endpoint HTTP que llegue acá.** Lo llama el
   * módulo de pagos y nadie más.
   *
   * Renueva solo si está por vencer. Mercado Pago los da por seis meses, así
   * que en la práctica esto casi nunca se dispara — y por eso mismo tiene que
   * funcionar cuando lo haga: un fallo silencioso acá deja al vendedor sin
   * poder cobrar medio año después de conectar, sin haber hecho nada.
   */
  async accessTokenDe(sellerId: string): Promise<string> {
    const credencial = await this.prisma.sellerOAuthCredential.findUnique({
      where: { sellerId_provider: { sellerId, provider: 'MERCADO_PAGO' } },
    });
    if (!credencial) throw new CuentaNoConectadaError();

    const llave = this.llave;

    // Un día de margen: renovar justo al vencer deja sin cobrar a quien esté
    // pagando en ese momento.
    const porVencer =
      credencial.expiresAt !== null &&
      credencial.expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1_000;

    if (porVencer && credencial.refreshCiphertext) {
      const renovado = await this.renovar(sellerId, credencial, llave);
      if (renovado) return renovado;
      // Si el refresco falló, se sigue con el token viejo: puede que todavía
      // sirva, y negarse a cobrar por precaución sería peor que intentar.
    }

    return descifrar(
      {
        ciphertext: credencial.accessCiphertext,
        iv: credencial.accessIv,
        tag: credencial.accessTag,
        version: credencial.keyVersion,
      },
      llave,
    );
  }

  /**
   * Renueva con el refresh token.
   *
   * ⚠️ Mercado Pago **rota** el refresh token: la respuesta trae uno nuevo y el
   * viejo deja de valer. Guardarlo no es opcional.
   */
  private async renovar(
    sellerId: string,
    credencial: {
      refreshCiphertext: string | null;
      refreshIv: string | null;
      refreshTag: string | null;
      keyVersion: number;
    },
    llave: Buffer,
  ): Promise<string | null> {
    if (!credencial.refreshCiphertext || !credencial.refreshIv || !credencial.refreshTag) {
      return null;
    }

    try {
      const refresh = descifrar(
        {
          ciphertext: credencial.refreshCiphertext,
          iv: credencial.refreshIv,
          tag: credencial.refreshTag,
          version: credencial.keyVersion,
        },
        llave,
      );

      const tokens = await this.cliente.renovar(refresh);
      await this.guardar(sellerId, tokens);
      return tokens.accessToken;
    } catch (err) {
      /**
       * Que el refresco falle no puede tumbar el cobro en curso.
       *
       * Se registra —hay que enterarse— y se devuelve `null` para que quien
       * llamó siga con el token viejo. Si ese también falló, el error va a
       * venir de Mercado Pago con un mensaje que sí explica qué pasa.
       */
      this.logger.error({
        msg: 'no se pudo renovar el token de un vendedor',
        sellerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MANTENIMIENTO
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Borra los `state` vencidos.
   *
   * No es higiene: es que la tabla crece con cada toque de "conectar" y sin
   * esto acumula filas muertas para siempre. Lo llama el barrido periódico.
   */
  async limpiarEstadosVencidos(antesDe = new Date()): Promise<number> {
    const { count } = await this.prisma.oAuthState.deleteMany({
      where: { expiresAt: { lt: antesDe } },
    });
    return count;
  }

  /**
   * Compara dos `state` en tiempo constante.
   *
   * Hoy la comparación la hace PostgreSQL en el WHERE y esto no se usa; queda
   * por si algún día hace falta comparar en memoria, que es donde una
   * comparación de cadenas normal filtra información por el tiempo que tarda.
   */
  static sonIguales(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  private async sellerDe(userId: string) {
    const seller = await this.prisma.seller.findUnique({
      where: { userId },
      select: { id: true, status: true },
    });
    if (!seller) throw new NoEsVendedorError();
    return seller;
  }
}

export type { SecretoCifrado };
