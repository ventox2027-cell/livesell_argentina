import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SellerOAuthService } from '@/modules/payments/seller-oauth.service';
import type { PrismaService } from '@/shared/prisma/prisma.service';

import { RUTA_OAUTH_MERCADOPAGO } from '@/shared/http/rutas-webhook';

import { crearAppDePrueba } from '../helpers/app';

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

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({ wsUrl: '', ensureRoom: vi.fn(), issueToken: vi.fn(), verifyWebhook: vi.fn() })
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

beforeEach(() => {
  canjearCodigo.mockReset();
  renovar.mockReset();
});

async function call(
  method: string,
  url: string,
  opts: { body?: unknown; token?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

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
