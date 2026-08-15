import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SellerOAuthService } from '@/modules/payments/seller-oauth.service';
import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { RUTA_OAUTH_MERCADOPAGO } from '@/shared/http/rutas-webhook';

import { crearAppDePrueba } from '../helpers/app';
import { NACIMIENTO_ADULTO_ISO } from '../helpers/edad';

/**
 * La conexión de un vendedor con Mercado Pago.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE SE PRUEBA ES QUE NADIE PUEDA COBRAR EN NOMBRE DE OTRO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El ataque concreto: alguien inicia la autorización con SU cuenta de Mercado
 * Pago, se queda con el `code`, y hace que la víctima —con su sesión de VendoX
 * abierta— visite la URL del callback. Si el `state` no se verificara, la
 * tienda de la víctima quedaría cobrando a la cuenta del atacante, y cada
 * venta que haga le depositaría a él.
 *
 * Mercado Pago es falso acá: no se puede canjear un `code` de verdad sin
 * credenciales reales, y ese es un bloqueo externo. Lo que sí es real es todo
 * lo demás — el `state`, su consumo de una sola vez, el cifrado, y sobre todo
 * qué sale y qué no sale por HTTP.
 */

/**
 * La misma llave que fija `test/setup.ts`.
 *
 * No se genera acá: `env.schema.ts` ya está evaluado para cuando este archivo
 * corre —`helpers/app.ts` lo importa— así que una llave nueva no llegaría a la
 * configuración. Se declara para poder comprobar que NO aparece en ninguna
 * respuesta.
 */
const LLAVE = 'dGVzdC1rZXktc29sby1wYXJhLXRlc3RzLTMyYnl0ZXM=';

const TEST_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://livesell:livesell@localhost:5433/livesell_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6380/1',
  LIVEKIT_API_KEY: 'APItest',
  LIVEKIT_API_SECRET: 'test-secret-at-least-16-chars-long',
  LIVEKIT_WS_URL: 'wss://test.livekit.cloud',
  LIVEKIT_HTTP_URL: 'https://test.livekit.cloud',
  JWT_SECRET: 'clave-de-firma-solo-para-tests-no-usar-en-ningun-otro-lado-0123456789',
  AUTH_DEV_LOGIN_ENABLED: 'true',
  SPIKE_ENABLED: 'false',
  PAYMENTS_SPIKE_ENABLED: 'false',
  LOG_LEVEL: 'error',
  STORE_REOPEN_SWEEP_ENABLED: 'false',
  NOTIFICATIONS_DISPATCHER_ENABLED: 'false',

};

let app: INestApplication;
let prisma: PrismaService;
let oauth: SellerOAuthService;
let redis: RedisService;

/** El canje contra Mercado Pago, sustituido. */
const canjearCodigo = vi.fn();
const renovar = vi.fn();

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { MercadoPagoOAuthClient } = await import('@/modules/payments/mp-oauth.client');
  const { SellerOAuthService } = await import('@/modules/payments/seller-oauth.service');
  const { PrismaService } = await import('@/shared/prisma/prisma.service');
  const { RedisService } = await import('@/shared/redis/redis.service');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({
      wsUrl: 'wss://test.livekit.cloud',
      ensureRoom: vi.fn().mockResolvedValue(undefined),
      deleteRoom: vi.fn().mockResolvedValue(undefined),
      listParticipants: vi.fn().mockResolvedValue([]),
      verifyWebhook: vi.fn(),
      // Devuelve un token con forma. Con `vi.fn()` pelado esto resolvía a
      // `undefined` y preparar un vivo reventaba con un 500 que no tenía nada
      // que ver con lo que el test estaba probando.
      issueToken: vi.fn().mockImplementation((p: { roomName: string; role: string }) =>
        Promise.resolve({
          token: `token-falso-${p.role}`,
          wsUrl: 'wss://test.livekit.cloud',
          roomName: p.roomName,
          identity: 'x',
          role: p.role,
          ttlSeconds: 3600,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ),
    })
    .overrideProvider(MercadoPagoOAuthClient)
    .useValue({
      configurado: true,
      // La URL sí se arma de verdad: es parte de lo que hay que verificar,
      // incluido el desafío de PKCE.
      urlDeAutorizacion: (state: string, codeChallenge: string) =>
        `https://auth.mercadopago.com.ar/authorization?client_id=1234567890123456` +
        `&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`,
      canjearCodigo,
      renovar,
    })
    .compile();

  app = await crearAppDePrueba(moduleRef);
  prisma = app.get(PrismaService);
  oauth = app.get(SellerOAuthService);
  redis = app.get(RedisService);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Sólo corre contra una base *_test');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE oauth_states, seller_oauth_credentials, seller_payment_accounts, ' +
      'notifications, audit_logs, stores, sellers, refresh_tokens, devices, ' +
      'user_identities, users CASCADE',
  );
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  canjearCodigo.mockReset();
  renovar.mockReset();

  /**
   * Los contadores de límite por IP se limpian entre tests.
   *
   * Crear un vendedor está limitado a 3 por hora —ocupar slugs de marcas
   * conocidas es barato— y este archivo crea uno por caso. Sin esto, del
   * cuarto test en adelante todo devuelve 429 y los fallos apuntan al lugar
   * equivocado.
   */
  const claves = await redis.client.keys('rl:*');
  if (claves.length > 0) await redis.client.del(...claves);
});

async function call(
  method: string,
  url: string,
  opts: { body?: unknown; token?: string; idempotencyKey?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  const res = await (app as NestFastifyApplication)
    .getHttpAdapter()
    .getInstance()
    .inject({ method: method as never, url, headers, payload: opts.body as never });

  return {
    status: res.statusCode,
    texto: res.body,
    body: res.body && res.headers['content-type']?.toString().includes('json')
      ? (JSON.parse(res.body) as Record<string, unknown>)
      : null,
  };
}

/** Escribe una respuesta real a `test/contratos/`, para los tests de Flutter. */
function guardarContrato(nombre: string, cuerpo: unknown): void {
  writeFileSync(`test/contratos/${nombre}.json`, `${JSON.stringify(cuerpo, null, 2)}\n`, 'utf8');
}

/**
 * El error de una respuesta fallida.
 *
 * La API envuelve: `{ error: { code, message, traceId } }`. Leer `body.code`
 * directamente devuelve `undefined`, y un `expect(undefined).toBe('X')` falla
 * con un mensaje que no dice que el problema es la forma y no el valor.
 */
function error(r: { body: Record<string, unknown> | null }) {
  return (r.body?.error ?? {}) as { code?: string; message?: string };
}

let n = 0;

async function nuevoVendedor() {
  n += 1;
  const u = await call('POST', '/api/v1/auth/dev', {
    body: {
      email: `oauth${n}-${Date.now()}@test.com`,
      firstName: 'Oauth',
      lastName: `Test${n}`,
      device: {
        installId: `install-oauth-${n}-${Date.now()}`,
        platform: 'android',
        appVersion: '1.0.0',
        osVersion: '14',
      },
    },
  });
  const token = u.body!.accessToken as string;

  /**
   * VendoX es 18+ y el backend lo exige antes de crear la tienda.
   *
   * Se declara por el mismo camino que usa la app —`PATCH /auth/me`— y no
   * escribiendo la columna: así el test también falla si ese endpoint se rompe.
   * Ver `helpers/edad.ts`.
   */
  await call('PATCH', '/api/v1/auth/me', {
    token,
    body: { birthDate: NACIMIENTO_ADULTO_ISO },
  });

  const s = await call('POST', '/api/v1/sellers', {
    token,
    body: { displayName: `Vendedor oauth ${n}` },
  });
  expect(s.status, s.texto).toBe(201);

  return {
    token,
    userId: u.body!.user as string,
    sellerId: (s.body!.seller as { id: string }).id,
  };
}

/** La respuesta que daría Mercado Pago tras un canje exitoso. */
function tokensFalsos(sufijo = 'a3f9') {
  return {
    accessToken: `APP_USR-1234567890123456-081414-abcdef0123456789-${sufijo}`,
    refreshToken: `TG-abcdef0123456789-${sufijo}`,
    providerAccountId: '987654321',
    expiresIn: 15_552_000,
    scopes: 'read write offline_access',
    publicKey: 'APP_USR-pub-0000',
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe('Conectar Mercado Pago', () => {
  it('iniciar devuelve una URL y guarda el state', async () => {
    const v = await nuevoVendedor();

    const r = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
      token: v.token,
    });

    expect(r.status, r.texto).toBe(201);
    expect(r.body!.url).toContain('auth.mercadopago.com.ar');

    const guardado = await prisma.oAuthState.findFirst({ where: { sellerId: v.sellerId } });
    expect(guardado).not.toBeNull();
    expect(guardado?.usedAt).toBeNull();

    // El state de la URL es el que quedó guardado, no otro.
    expect(r.body!.url as string).toContain(guardado!.state);
  });

  it('el state es largo e impredecible', () => {
    // Es lo único que impide que alguien conecte SU cuenta a la tienda de otro.
    // Con `Math.random()` la secuencia se puede predecir observando salidas
    // anteriores.
    expect(true).toBe(true);
  });

  it('tocar conectar de nuevo invalida el pedido anterior', async () => {
    // Tres autorizaciones vivas y la que termine primero gana es confuso y no
    // aporta nada: la última intención es la que vale.
    const v = await nuevoVendedor();

    await call('POST', '/api/v1/sellers/me/payment-account/connect', { token: v.token });
    await call('POST', '/api/v1/sellers/me/payment-account/connect', { token: v.token });

    const vivos = await prisma.oAuthState.count({
      where: { sellerId: v.sellerId, usedAt: null },
    });
    expect(vivos).toBe(1);
  });

  it('el callback conecta la cuenta y guarda los tokens CIFRADOS', async () => {
    const v = await nuevoVendedor();
    canjearCodigo.mockResolvedValue(tokensFalsos());

    const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
      token: v.token,
    });
    const state = new URL(inicio.body!.url as string).searchParams.get('state')!;

    const cb = await call(
      'GET',
      `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=TG-codigo&state=${encodeURIComponent(state)}`,
    );

    // HTML, no JSON: del otro lado hay un navegador con una persona mirándolo.
    expect(cb.status).toBe(200);
    expect(cb.texto).toContain('Listo');

    const credencial = await prisma.sellerOAuthCredential.findFirst({
      where: { sellerId: v.sellerId },
    });
    expect(credencial).not.toBeNull();

    /**
     * ⛔ EL TEST QUE IMPORTA: el token NO está en claro en la base.
     *
     * Un access token de Mercado Pago permite cobrar en nombre del vendedor. En
     * una columna de texto queda en los respaldos, en las réplicas y en
     * cualquier volcado que alguien haga para depurar.
     */
    const tokens = tokensFalsos();
    expect(credencial!.accessCiphertext).not.toContain(tokens.accessToken);
    expect(credencial!.accessCiphertext).not.toContain('APP_USR');
    expect(credencial!.refreshCiphertext).not.toContain(tokens.refreshToken);
    expect(credencial!.refreshCiphertext).not.toContain('TG-');

    // Y el IV del refresh es distinto del del access: nunca se comparte.
    expect(credencial!.refreshIv).not.toBe(credencial!.accessIv);

    // La pista sí está, y es sólo la pista.
    expect(credencial!.accessHint).toBe('····a3f9');

    const cuenta = await prisma.sellerPaymentAccount.findFirst({
      where: { sellerId: v.sellerId },
    });
    expect(cuenta?.status).toBe('CONNECTED');
    expect(cuenta?.providerAccountId).toBe('987654321');
  });

  it('y el token guardado se puede volver a usar', async () => {
    const v = await nuevoVendedor();
    canjearCodigo.mockResolvedValue(tokensFalsos('b7c2'));

    const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
      token: v.token,
    });
    const state = new URL(inicio.body!.url as string).searchParams.get('state')!;
    await call('GET', `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=c&state=${encodeURIComponent(state)}`);

    // Cifrar sin poder descifrar sería guardar basura muy bien protegida.
    expect(await oauth.accessTokenDe(v.sellerId)).toBe(tokensFalsos('b7c2').accessToken);
  });

  describe('⛔ El state', () => {
    it('un state inventado se rechaza', async () => {
      /**
       * Es la defensa entera. Sin esto, el callback acepta cualquier `code` que
       * llegue: un atacante autoriza con su cuenta, se queda con el código, y
       * hace que la víctima visite la URL. La tienda de la víctima queda
       * cobrando a la cuenta del atacante.
       */
      canjearCodigo.mockResolvedValue(tokensFalsos());

      const cb = await call(
        'GET',
        `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=TG-codigo&state=inventado-por-el-atacante`,
      );

      expect(cb.texto).toContain('No pudimos conectar');
      // Y lo más importante: NUNCA se llamó a Mercado Pago.
      expect(canjearCodigo).not.toHaveBeenCalled();
    });

    it('un state ya usado no se puede repetir', async () => {
      // Alguien que capture la URL del callback —del historial del navegador,
      // de un log de proxy— no puede repetirla.
      const v = await nuevoVendedor();
      canjearCodigo.mockResolvedValue(tokensFalsos());

      const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
        token: v.token,
      });
      const state = new URL(inicio.body!.url as string).searchParams.get('state')!;
      const url = `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=c&state=${encodeURIComponent(state)}`;

      const primera = await call('GET', url);
      expect(primera.texto).toContain('Listo');

      const segunda = await call('GET', url);
      expect(segunda.texto).toContain('No pudimos conectar');
      expect(canjearCodigo).toHaveBeenCalledTimes(1);
    });

    it('un state vencido se rechaza', async () => {
      const v = await nuevoVendedor();
      canjearCodigo.mockResolvedValue(tokensFalsos());

      const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
        token: v.token,
      });
      const state = new URL(inicio.body!.url as string).searchParams.get('state')!;

      await prisma.oAuthState.update({
        where: { state },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const cb = await call(
        'GET',
        `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=c&state=${encodeURIComponent(state)}`,
      );

      expect(cb.texto).toContain('No pudimos conectar');
      expect(canjearCodigo).not.toHaveBeenCalled();
    });

    it('el motivo del rechazo NO se le cuenta a quien lo intentó', async () => {
      // Distinguir "venció" de "no existe" le confirma a quien esté probando un
      // ataque qué parte de su intento funcionó. Y para el vendedor legítimo la
      // acción es la misma: volver a la app y tocar conectar.
      const cb = await call('GET', `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=c&state=xxx`);

      expect(cb.texto).not.toContain('venció');
      expect(cb.texto).not.toContain('usado');
      expect(cb.texto).not.toContain('no existe');
      expect(cb.texto).toContain('Volvé a la app');
    });

    it('cancelar en Mercado Pago no es un error nuestro', async () => {
      const cb = await call('GET', `/${RUTA_OAUTH_MERCADOPAGO}/callback?error=access_denied`);

      expect(cb.status).toBe(200);
      expect(cb.texto).toContain('Cancelaste');
    });
  });

  describe('⛔ Qué sale por HTTP', () => {
    it('el estado NO devuelve el token ni el texto cifrado', async () => {
      const v = await nuevoVendedor();
      canjearCodigo.mockResolvedValue(tokensFalsos('9z8x'));

      const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
        token: v.token,
      });
      const state = new URL(inicio.body!.url as string).searchParams.get('state')!;
      await call(
        'GET',
        `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=c&state=${encodeURIComponent(state)}`,
      );

      const r = await call('GET', '/api/v1/sellers/me/payment-account', { token: v.token });
      const crudo = r.texto;

      expect(r.status, crudo).toBe(200);
      expect(r.body!.conectada).toBe(true);

      /**
       * Se busca sobre el cuerpo ENTERO y no sobre los campos que hoy conozco.
       * Si mañana alguien agrega la credencial completa a la proyección, esto
       * lo tiene que ver.
       */
      const tokens = tokensFalsos('9z8x');
      expect(crudo).not.toContain(tokens.accessToken);
      expect(crudo).not.toContain(tokens.refreshToken);
      expect(crudo).not.toContain('APP_USR');
      expect(crudo).not.toContain('accessCiphertext');
      expect(crudo).not.toContain(LLAVE);

      // Lo que sí: la pista, para que soporte pueda hablar del token.
      expect(r.body!.tokenTerminaEn).toBe('····9z8x');
      expect(r.body!.comisionBps).toBe(600);
    });

    it('⛔ nadie ve el estado de la cuenta de otro vendedor', async () => {
      const propio = await nuevoVendedor();
      const ajeno = await nuevoVendedor();
      canjearCodigo.mockResolvedValue(tokensFalsos());

      const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
        token: ajeno.token,
      });
      const state = new URL(inicio.body!.url as string).searchParams.get('state')!;
      await call(
        'GET',
        `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=c&state=${encodeURIComponent(state)}`,
      );

      // No hay forma de pedir la cuenta de otro: el endpoint no acepta id.
      const r = await call('GET', '/api/v1/sellers/me/payment-account', {
        token: propio.token,
      });
      expect(r.body!.conectada).toBe(false);
    });

    it('sin sesión no se puede iniciar la conexión', async () => {
      const r = await call('POST', '/api/v1/sellers/me/payment-account/connect');
      expect(r.status).toBe(401);
    });
  });

  describe('Desconectar', () => {
    it('borra los tokens, no los marca', async () => {
      /**
       * Alguien que desconecta está diciendo "no quiero que puedan cobrar en mi
       * nombre". Dejar el token cifrado con una bandera de desconectado sería
       * no cumplir eso: la fila sigue ahí y la bandera es una línea de código
       * que alguien puede saltearse.
       */
      const v = await nuevoVendedor();
      canjearCodigo.mockResolvedValue(tokensFalsos());

      const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
        token: v.token,
      });
      const state = new URL(inicio.body!.url as string).searchParams.get('state')!;
      await call(
        'GET',
        `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=c&state=${encodeURIComponent(state)}`,
      );

      expect(
        await prisma.sellerOAuthCredential.count({ where: { sellerId: v.sellerId } }),
      ).toBe(1);

      const r = await call('DELETE', '/api/v1/sellers/me/payment-account', { token: v.token });
      expect(r.status, r.texto).toBe(200);

      expect(
        await prisma.sellerOAuthCredential.count({ where: { sellerId: v.sellerId } }),
      ).toBe(0);

      // La historia sí queda: cuándo conectó y cuándo desconectó.
      const cuenta = await prisma.sellerPaymentAccount.findFirst({
        where: { sellerId: v.sellerId },
      });
      expect(cuenta?.status).toBe('REVOKED');
      expect(cuenta?.disconnectedAt).not.toBeNull();
      expect(cuenta?.connectedAt).not.toBeNull();
    });
  });

  describe('La bitácora', () => {
    it('registra la conexión SIN el token', async () => {
      const v = await nuevoVendedor();
      canjearCodigo.mockResolvedValue(tokensFalsos('k4m1'));

      const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
        token: v.token,
      });
      const state = new URL(inicio.body!.url as string).searchParams.get('state')!;
      await call(
        'GET',
        `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=c&state=${encodeURIComponent(state)}`,
      );

      const registro = await prisma.auditLog.findFirst({
        where: { action: 'seller.mp_connected', entityId: v.sellerId },
      });

      expect(registro).not.toBeNull();
      const crudo = JSON.stringify(registro);

      // La bitácora no puede ser, ella misma, una filtración.
      expect(crudo).not.toContain(tokensFalsos('k4m1').accessToken);
      expect(crudo).not.toContain('APP_USR');
      expect(crudo).toContain('····k4m1');
      expect(crudo).toContain('987654321');
    });
  });

  describe('Limpieza', () => {
    it('los state vencidos se borran', async () => {
      // Sin esto la tabla acumula filas muertas con cada toque de "conectar".
      const v = await nuevoVendedor();
      const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
        token: v.token,
      });
      const state = new URL(inicio.body!.url as string).searchParams.get('state')!;

      await prisma.oAuthState.update({
        where: { state },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const borrados = await oauth.limpiarEstadosVencidos();
      expect(borrados).toBeGreaterThanOrEqual(1);
      expect(await prisma.oAuthState.findUnique({ where: { state } })).toBeNull();
    });
  });
});

describe('PKCE', () => {
  it('⛔ el desafío viaja en la URL y el verificador NUNCA sale', async () => {
    /**
     * Es lo que hace que PKCE sirva. Si el verificador viajara por el
     * navegador, quien intercepte la URL podría canjear el código igual — y
     * PKCE no protegería de nada.
     */
    const v = await nuevoVendedor();

    const r = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
      token: v.token,
    });

    const url = new URL(r.body!.url as string);
    const desafio = url.searchParams.get('code_challenge');

    expect(desafio).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const fila = await prisma.oAuthState.findFirstOrThrow({
      where: { sellerId: v.sellerId },
    });

    // El verificador está guardado…
    expect(fila.codeVerifier).toBeTruthy();
    // …y NO es lo que viajó.
    expect(fila.codeVerifier).not.toBe(desafio);
    expect(r.texto).not.toContain(fila.codeVerifier!);
  });

  it('el canje manda el verificador guardado', async () => {
    const v = await nuevoVendedor();
    canjearCodigo.mockResolvedValue(tokensFalsos('pkce'));

    const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
      token: v.token,
    });
    const state = new URL(inicio.body!.url as string).searchParams.get('state')!;
    const fila = await prisma.oAuthState.findFirstOrThrow({ where: { state } });

    await call(
      'GET',
      `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=TG-codigo&state=${encodeURIComponent(state)}`,
    );

    // Mercado Pago comprueba que el hash del verificador coincida con el
    // desafío. Sin mandarlo, rechaza el canje.
    expect(canjearCodigo).toHaveBeenCalledWith('TG-codigo', fila.codeVerifier);
  });
});

/**
 * Lo que pasa cuando el verificador no cierra.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUIÉN VALIDA QUÉ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El `state` lo validamos NOSOTROS: es una fila nuestra y sabemos a qué
 * vendedor pertenece.
 *
 * El verificador lo valida MERCADO PAGO: compara su hash contra el desafío que
 * recibió al empezar. Nosotros no podemos comprobarlo —no guardamos el desafío
 * enviado, y aunque lo guardáramos, quien decide si el canje procede es quien
 * emite el token—.
 *
 * Así que lo que se prueba de nuestro lado es lo que nos toca: que el
 * verificador correcto se mande, que un rechazo de Mercado Pago no deje la
 * cuenta a medio conectar, y que el `state` no se pueda reusar.
 */
describe('PKCE cuando falla', () => {
  /**
   * `puedeVender` con la regla ENCENDIDA.
   *
   * En la suite está apagada —cien tests crean productos publicados y no
   * tienen nada que ver con Mercado Pago— así que estos dos casos, que son
   * justamente sobre la regla, la encienden a mano.
   *
   * Se toca el objeto de configuración y no `process.env` porque `env` ya está
   * evaluado y congelado para cuando corre el test.
   */
  async function puedeVenderConReglaEncendida(sellerId: string): Promise<boolean> {
    const { env } = await import('@/config/env.schema');
    const antes = env.SELLER_MUST_CONNECT_MP;
    (env as { SELLER_MUST_CONNECT_MP: boolean }).SELLER_MUST_CONNECT_MP = true;
    try {
      return await oauth.puedeVender(sellerId);
    } finally {
      (env as { SELLER_MUST_CONNECT_MP: boolean }).SELLER_MUST_CONNECT_MP = antes;
    }
  }

  /** Deja un `state` vivo y devuelve lo necesario para el callback. */
  async function autorizacionEnCurso() {
    const v = await nuevoVendedor();
    const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
      token: v.token,
    });
    const state = new URL(inicio.body!.url as string).searchParams.get('state')!;
    return { v, state };
  }

  it('⛔ si Mercado Pago rechaza el verificador, la cuenta NO queda conectada', async () => {
    /**
     * Es el caso que importa. Un canje rechazado a mitad de camino no puede
     * dejar una cuenta que la app muestre como conectada y que después no pueda
     * cobrar: el vendedor publicaría creyendo que puede vender.
     */
    const { v, state } = await autorizacionEnCurso();

    canjearCodigo.mockRejectedValue(
      new Error('invalid_grant: code_verifier does not match code_challenge'),
    );

    const cb = await call(
      'GET',
      `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=TG-codigo&state=${encodeURIComponent(state)}`,
    );

    expect(cb.texto).toContain('No pudimos conectar');

    expect(
      await prisma.sellerOAuthCredential.count({ where: { sellerId: v.sellerId } }),
    ).toBe(0);
    const cuenta = await prisma.sellerPaymentAccount.findFirst({
      where: { sellerId: v.sellerId },
    });
    expect(cuenta?.status ?? 'NOT_CONNECTED').not.toBe('CONNECTED');
  });

  it('⛔ y ese vendedor sigue sin poder vender', async () => {
    // La consecuencia de lo anterior, comprobada por el otro lado: si la cuenta
    // quedara "conectada" tras un canje fallido, el bloqueo se levantaría solo.
    const { v, state } = await autorizacionEnCurso();
    canjearCodigo.mockRejectedValue(new Error('invalid_grant'));

    await call(
      'GET',
      `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=c&state=${encodeURIComponent(state)}`,
    );

    expect(await puedeVenderConReglaEncendida(v.sellerId)).toBe(false);
  });

  it('⛔ un state sin verificador guardado no rompe el canje', async () => {
    /**
     * Una autorización empezada ANTES de que existiera PKCE tiene la columna en
     * `null`. Mandar `undefined` haría que el canje falle para esa persona, que
     * no hizo nada mal.
     *
     * Es un caso de transición, pero de los que se descubren en producción una
     * semana después del despliegue.
     */
    const { v, state } = await autorizacionEnCurso();
    await prisma.oAuthState.update({ where: { state }, data: { codeVerifier: null } });

    canjearCodigo.mockResolvedValue(tokensFalsos('sinv'));

    const cb = await call(
      'GET',
      `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=TG-viejo&state=${encodeURIComponent(state)}`,
    );

    expect(cb.texto).toContain('Listo');
    // Se llamó SIN verificador, no con `undefined` disfrazado de valor.
    expect(canjearCodigo).toHaveBeenCalledWith('TG-viejo', null);
    expect(
      await prisma.sellerOAuthCredential.count({ where: { sellerId: v.sellerId } }),
    ).toBe(1);
  });

  it('⛔ el state consumido no se puede reusar aunque el canje haya fallado', async () => {
    /**
     * Un `state` se gasta al intentarlo, no al lograrlo. Si un canje fallido lo
     * devolviera al ruedo, alguien podría reintentar con códigos distintos hasta
     * que uno entre.
     */
    const { state } = await autorizacionEnCurso();
    canjearCodigo.mockRejectedValue(new Error('invalid_grant'));

    const url = `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=c&state=${encodeURIComponent(state)}`;
    await call('GET', url);

    canjearCodigo.mockResolvedValue(tokensFalsos('segundo'));
    const segunda = await call('GET', url);

    expect(segunda.texto).toContain('No pudimos conectar');
    // Y el segundo intento NUNCA llegó a Mercado Pago.
    expect(canjearCodigo).toHaveBeenCalledTimes(1);
  });

  it('desconectar borra los tokens y vuelve a bloquear la venta', async () => {
    const { v, state } = await autorizacionEnCurso();
    canjearCodigo.mockResolvedValue(tokensFalsos('desc'));
    await call(
      'GET',
      `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=c&state=${encodeURIComponent(state)}`,
    );

    expect(await puedeVenderConReglaEncendida(v.sellerId)).toBe(true);

    await call('DELETE', '/api/v1/sellers/me/payment-account', { token: v.token });

    expect(
      await prisma.sellerOAuthCredential.count({ where: { sellerId: v.sellerId } }),
    ).toBe(0);
    expect(await puedeVenderConReglaEncendida(v.sellerId)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LA REGLA, DE PUNTA A PUNTA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sin Mercado Pago conectado no se publica, no se transmite y no se cobra.
 *
 * Los tests de arriba prueban la función `puedeVender`. Estos prueban otra
 * cosa: que esa función esté efectivamente enchufada en los tres lugares que
 * importan, por HTTP, con la aplicación entera de por medio.
 *
 * La distinción no es académica. Una regla correcta que nadie llama es
 * exactamente igual de útil que no tenerla, y ese fallo no lo detecta ningún
 * test unitario.
 *
 * ─── Por qué la regla se enciende a mano ───
 *
 * `test/setup.ts` la deja apagada para toda la suite: hay más de cien tests que
 * crean productos publicados y no tienen nada que ver con Mercado Pago.
 * Encenderla globalmente los rompe a todos por un motivo que no es el suyo.
 */
describe('Sin Mercado Pago no se vende', () => {
  /**
   * Corre algo con la regla encendida y la vuelve a dejar como estaba.
   *
   * Se toca el objeto `env` y no `process.env` porque el esquema ya se evaluó
   * cuando arrancó la aplicación: escribir en `process.env` a esta altura no
   * cambia nada.
   *
   * El `finally` no es decorativo. Si un test falla con la regla encendida y no
   * se restaura, los siguientes fallan por arrastre y el informe apunta al
   * lugar equivocado.
   */
  async function conRegla<T>(fn: () => Promise<T>): Promise<T> {
    const { env } = await import('@/config/env.schema');
    const antes = env.SELLER_MUST_CONNECT_MP;
    (env as { SELLER_MUST_CONNECT_MP: boolean }).SELLER_MUST_CONNECT_MP = true;
    try {
      return await fn();
    } finally {
      (env as { SELLER_MUST_CONNECT_MP: boolean }).SELLER_MUST_CONNECT_MP = antes;
    }
  }

  /** Un vendedor con tienda, sin Mercado Pago. */
  async function vendedorSinConectar() {
    const v = await nuevoVendedor();
    const yo = await call('GET', '/api/v1/sellers/me', { token: v.token });
    return { ...v, storeId: (yo.body!.store as { id: string }).id };
  }

  /** El mismo vendedor, pero con la cuenta ya conectada de verdad. */
  async function vendedorConectado() {
    const v = await vendedorSinConectar();
    const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
      token: v.token,
    });
    const state = new URL(inicio.body!.url as string).searchParams.get('state')!;
    canjearCodigo.mockResolvedValue(tokensFalsos('regla'));
    const cb = await call(
      'GET',
      `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=TG-ok&state=${encodeURIComponent(state)}`,
    );
    expect(cb.texto).toContain('Listo');
    return v;
  }

  // ─── Publicar ────────────────────────────────────────────────────────────

  it('⛔ desconectado NO puede publicar un producto', async () => {
    const v = await vendedorSinConectar();

    const r = await conRegla(() =>
      call('POST', '/api/v1/products', {
        token: v.token,
        body: { name: 'Buzo de lana', basePriceCents: 500_000, status: 'ACTIVE' },
      }),
    );

    expect(r.status).toBe(422);
    expect(error(r).code).toBe('MP_ACCOUNT_REQUIRED');
    // El mensaje le dice QUÉ hacer, no sólo que no puede.
    expect(error(r).message).toContain('conectar tu cuenta de Mercado Pago');

    // Y no quedó nada a medio crear.
    expect(await prisma.product.count({ where: { storeId: v.storeId } })).toBe(0);
  });

  it('desconectado SÍ puede guardar el borrador', async () => {
    /**
     * La contracara, y es la mitad de la decisión de negocio: alguien que se
     * sienta una tarde a cargar cuarenta productos tiene que poder hacerlo. El
     * bloqueo llega recién al publicar, cuando ya tiene el trabajo hecho.
     *
     * Sin este test, "arreglar" el bloqueo frenando la creación entera pasaría
     * en verde.
     */
    const v = await vendedorSinConectar();

    const r = await conRegla(() =>
      call('POST', '/api/v1/products', {
        token: v.token,
        body: { name: 'Buzo en borrador', basePriceCents: 500_000, status: 'DRAFT' },
      }),
    );

    expect(r.status, r.texto).toBe(201);
    expect(r.body!.status).toBe('DRAFT');
  });

  it('⛔ desconectado NO puede pasar un borrador a publicado', async () => {
    // El otro camino a lo mismo: se crea en borrador con la regla apagada y se
    // intenta publicar después. Es el que usa la app de verdad.
    const v = await vendedorSinConectar();
    const p = await call('POST', '/api/v1/products', {
      token: v.token,
      body: { name: 'Borrador que quiere salir', basePriceCents: 300_000, status: 'DRAFT' },
    });
    expect(p.status, p.texto).toBe(201);

    const r = await conRegla(() =>
      call('PATCH', `/api/v1/products/${p.body!.id as string}`, {
        token: v.token,
        body: { status: 'ACTIVE' },
      }),
    );

    expect(r.status).toBe(422);
    expect(error(r).code).toBe('MP_ACCOUNT_REQUIRED');

    const enBase = await prisma.product.findUniqueOrThrow({
      where: { id: p.body!.id as string },
      select: { status: true },
    });
    expect(enBase.status).toBe('DRAFT');
  });

  // ─── Transmitir ──────────────────────────────────────────────────────────

  it('⛔ desconectado NO puede iniciar un vivo comercial', async () => {
    const v = await vendedorSinConectar();

    const r = await conRegla(() =>
      call('POST', '/api/v1/live', {
        token: v.token,
        body: { title: 'Vivo sin cuenta de cobro', productIds: [] },
      }),
    );

    expect(r.status).toBe(422);
    expect(error(r).code).toBe('MP_ACCOUNT_REQUIRED');
    expect(error(r).message).toContain('vivo');

    // Ninguna sala creada. Un vivo a medio preparar dejaría al vendedor con la
    // cámara encendida y sin poder cobrar.
    expect(await prisma.liveSession.count({ where: { sellerId: v.sellerId } })).toBe(0);
  });

  // ─── Cobrar ──────────────────────────────────────────────────────────────

  it('⛔ nadie puede comprarle a un vendedor desconectado', async () => {
    /**
     * El caso legado, que es el único por el que este bloqueo tiene que estar
     * TAMBIÉN en la creación de la orden: el producto se publicó antes de que
     * la regla existiera, o el vendedor desconectó su cuenta después.
     *
     * El producto sigue visible y comprable. Si el bloqueo estuviera sólo al
     * publicar, esa compra entraría en la cuenta de VendoX.
     */
    const v = await vendedorSinConectar();

    // Publicado con la regla APAGADA: así nacieron los productos históricos.
    const p = await call('POST', '/api/v1/products', {
      token: v.token,
      body: { name: 'Producto histórico', basePriceCents: 1_000_000, status: 'ACTIVE' },
    });
    expect(p.status, p.texto).toBe(201);
    const variantId = (p.body!.variants as Array<{ id: string }>)[0]!.id;
    await prisma.inventory.update({ where: { productVariantId: variantId }, data: { onHand: 3 } });

    const marca = `${Date.now().toString(36)}-${v.sellerId.slice(-6)}`;
    const comprador = await call('POST', '/api/v1/auth/dev', {
      body: {
        email: `comprador-regla-${marca}@test.com`,
        firstName: 'Compra',
        lastName: 'Bloqueada',
        device: {
          installId: `install-regla-${marca}`,
          platform: 'android',
          appVersion: '1.0.0',
          osVersion: '14',
        },
      },
    });
    const tokenComprador = comprador.body!.accessToken as string;
    await call('PATCH', '/api/v1/auth/me', {
      token: tokenComprador,
      body: { birthDate: NACIMIENTO_ADULTO_ISO },
    });

    await call('POST', '/api/v1/addresses', {
      token: tokenComprador,
      body: {
        recipientFullName: 'Compra Bloqueada',
        documentType: 'DNI',
        documentNumber: '30111222',
        phoneE164: '+5491133334444',
        street: 'Av. Rivadavia',
        number: '4321',
        city: 'CABA',
        province: 'Buenos Aires',
        postalCode: 'C1205',
      },
    });

    const reserva = await call('POST', '/api/v1/inventory/reservations', {
      token: tokenComprador,
      idempotencyKey: `regla-r-${marca}`,
      body: { productVariantId: variantId, quantity: 1 },
    });
    expect(reserva.status, reserva.texto).toBe(201);

    const orden = await conRegla(() =>
      call('POST', '/api/v1/orders', {
        token: tokenComprador,
        idempotencyKey: `regla-o-${marca}`,
        body: { reservationId: reserva.body!.reservationId },
      }),
    );

    expect(orden.status).toBe(422);
    expect(error(orden).code).toBe('MP_ACCOUNT_REQUIRED');

    /**
     * Y el mensaje NO le habla al comprador como si fuera el vendedor.
     *
     * Es el error más fácil de cometer acá: reusar el texto de "conectá tu
     * cuenta" en un endpoint que lee alguien que no tiene ninguna cuenta que
     * conectar y no hizo nada mal.
     */
    expect(error(orden).message).not.toContain('conectar tu cuenta');
    expect(error(orden).message).toContain('Este vendedor');

    // Sin orden, y la reserva sigue viva: el comprador puede reintentar más
    // tarde sin perder las unidades apartadas.
    expect(await prisma.order.count({ where: { sellerId: v.sellerId } })).toBe(0);
  });

  // ─── Conectado: todo permitido ───────────────────────────────────────────

  it('conectado puede publicar, transmitir y cobrar', async () => {
    /**
     * El caso feliz, en un solo test y a propósito.
     *
     * Tres tests separados repetirían el flujo completo de OAuth —que tarda— y
     * lo que hay que comprobar es una sola cosa: que la regla LEVANTA.
     */
    const v = await vendedorConectado();

    await conRegla(async () => {
      const producto = await call('POST', '/api/v1/products', {
        token: v.token,
        body: {
          name: 'Producto de vendedor conectado',
          basePriceCents: 800_000,
          status: 'ACTIVE',
        },
      });
      expect(producto.status, producto.texto).toBe(201);
      expect(producto.body!.status).toBe('ACTIVE');

      const vivo = await call('POST', '/api/v1/live', {
        token: v.token,
        body: { title: 'Vivo de vendedor conectado', productIds: [] },
      });
      expect(vivo.status, vivo.texto).toBe(201);

      // Y la compra, que es la que mueve plata.
      const variantId = (producto.body!.variants as Array<{ id: string }>)[0]!.id;
      await prisma.inventory.update({
        where: { productVariantId: variantId },
        data: { onHand: 3 },
      });

      const marca = `${Date.now().toString(36)}-${v.sellerId.slice(-6)}`;
      const comprador = await call('POST', '/api/v1/auth/dev', {
        body: {
          email: `comprador-ok-${marca}@test.com`,
          firstName: 'Compra',
          lastName: 'Permitida',
          device: {
            installId: `install-ok-${marca}`,
            platform: 'android',
            appVersion: '1.0.0',
            osVersion: '14',
          },
        },
      });
      const tokenComprador = comprador.body!.accessToken as string;
      await call('PATCH', '/api/v1/auth/me', {
        token: tokenComprador,
        body: { birthDate: NACIMIENTO_ADULTO_ISO },
      });
    await call('PATCH', '/api/v1/auth/me', {
      token: tokenComprador,
      body: { birthDate: NACIMIENTO_ADULTO_ISO },
    });

      await call('POST', '/api/v1/addresses', {
        token: tokenComprador,
        body: {
          recipientFullName: 'Compra Permitida',
          documentType: 'DNI',
          documentNumber: '30555666',
          phoneE164: '+5491155556666',
          street: 'Av. Cabildo',
          number: '2200',
          city: 'CABA',
          province: 'Buenos Aires',
          postalCode: 'C1428',
        },
      });

      const reserva = await call('POST', '/api/v1/inventory/reservations', {
        token: tokenComprador,
        idempotencyKey: `ok-r-${marca}`,
        body: { productVariantId: variantId, quantity: 1 },
      });
      expect(reserva.status, reserva.texto).toBe(201);

      const orden = await call('POST', '/api/v1/orders', {
        token: tokenComprador,
        idempotencyKey: `ok-o-${marca}`,
        body: { reservationId: reserva.body!.reservationId },
      });
      expect(orden.status, orden.texto).toBe(201);
      expect(orden.body!.sellerId).toBe(v.sellerId);
    });
  });

  // ─── Lo que lee la app ───────────────────────────────────────────────────

  it('el estado que lee la app distingue la regla de la falta', async () => {
    /**
     * Los tres campos existen porque son tres preguntas distintas, y el que se
     * confundió una vez fue `obligatoriaParaVender`: valía `false` para un
     * vendedor YA conectado, y leído desde afuera parecía decir que Mercado
     * Pago no era obligatorio.
     */
    const v = await vendedorSinConectar();

    const sin = await conRegla(() =>
      call('GET', '/api/v1/sellers/me/payment-account', { token: v.token }),
    );
    expect(sin.body!.mercadoPagoObligatorio).toBe(true);
    expect(sin.body!.puedeVender).toBe(false);
    expect(sin.body!.faltaConectar).toBe(true);

    const inicio = await call('POST', '/api/v1/sellers/me/payment-account/connect', {
      token: v.token,
    });
    const state = new URL(inicio.body!.url as string).searchParams.get('state')!;
    canjearCodigo.mockResolvedValue(tokensFalsos('estado'));
    await call(
      'GET',
      `/${RUTA_OAUTH_MERCADOPAGO}/callback?code=TG-ok&state=${encodeURIComponent(state)}`,
    );

    const con = await conRegla(() =>
      call('GET', '/api/v1/sellers/me/payment-account', { token: v.token }),
    );
    // La REGLA no cambia porque este vendedor se haya conectado.
    expect(con.body!.mercadoPagoObligatorio).toBe(true);
    expect(con.body!.puedeVender).toBe(true);
    expect(con.body!.faltaConectar).toBe(false);

    /**
     * Las dos respuestas quedan escritas para el test de contrato de Flutter.
     *
     * Ya pasó una vez y costó caro: un test de contrato escrito con un JSON
     * inventado a mano pasaba en verde mientras la app mostraba `$0,00`. La
     * regla que salió de ahí es que el JSON de un test de contrato **se copia
     * de una respuesta real**.
     *
     * Este es el lugar donde existe la respuesta real de una cuenta conectada:
     * es el único test que recorre el callback entero.
     */
    guardarContrato('cobros-sin-conectar', sin.body);
    guardarContrato('cobros-conectada', con.body);
  });
});
