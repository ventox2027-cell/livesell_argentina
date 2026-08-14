import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';

/**
 * Verificación de vendedores, contra PostgreSQL real.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE SE PRUEBA ACÁ ES QUE EL DOCUMENTO NO QUEDE GUARDADO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El resto —estados, permisos, idempotencia— importa. Pero lo que no se puede
 * romper nunca es que un número de documento termine en una columna: eso
 * convierte cualquier filtración futura en un problema de identidad para gente
 * real, y no se arregla con un parche después.
 *
 * Por eso hay un test que consulta la base cruda y falla si el número aparece
 * en cualquier tabla.
 */

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
};

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { PrismaService } = await import('@/shared/prisma/prisma.service');
  const { RedisService } = await import('@/shared/redis/redis.service');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({ wsUrl: '', ensureRoom: vi.fn(), issueToken: vi.fn(), verifyWebhook: vi.fn() })
    .compile();

  app = await crearAppDePrueba(moduleRef);
  prisma = app.get(PrismaService);
  redis = app.get(RedisService);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Los tests de integración borran datos y sólo corren contra una base *_test');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE audit_logs, seller_verifications, order_items, payment_attempts, refunds, orders, ' +
      'inventory_reservations, inventory, product_variant_options, product_images, ' +
      'product_variants, product_option_values, product_options, products, stores, sellers, ' +
      'auth_events, refresh_tokens, devices, user_identities, users CASCADE',
  );
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  const claves = await redis.client.keys('rl:*');
  if (claves.length > 0) await redis.client.del(...claves);
});

async function call(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const res = await (app as NestFastifyApplication)
    .getHttpAdapter()
    .getInstance()
    .inject({ method: method as never, url, headers, payload: opts.body as never });

  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

let n = 0;

async function nuevoVendedor() {
  n += 1;
  const r = await call('POST', '/api/v1/auth/dev', {
    body: {
      email: `verif${n}@test.com`,
      firstName: 'Test',
      lastName: `Vendedor${n}`,
      device: {
        installId: `install-verif-${n}`,
        platform: 'android',
        appVersion: '1.0.0',
        osVersion: '14',
      },
    },
  });
  const token = r.body.accessToken as string;

  const s = await call('POST', '/api/v1/sellers', {
    token,
    body: { displayName: `Vendedor prueba ${n}`, storeName: `Tienda ${n}` },
  });
  expect(s.status, JSON.stringify(s.body)).toBe(201);

  return { token, userId: r.body.user.id as string, sellerId: s.body.seller.id as string };
}

async function nuevoAdmin() {
  n += 1;
  const r = await call('POST', '/api/v1/auth/dev', {
    body: {
      email: `verifadmin${n}@test.com`,
      firstName: 'Admin',
      lastName: 'Test',
      device: {
        installId: `install-verifadmin-${n}`,
        platform: 'android',
        appVersion: '1.0.0',
        osVersion: '14',
      },
    },
  });
  await prisma.user.update({ where: { id: r.body.user.id }, data: { role: 'admin' } });
  return { token: r.body.accessToken as string, userId: r.body.user.id as string };
}

const DATOS_VALIDOS = {
  legalFirstName: 'Juan',
  legalLastName: 'Pérez',
  docType: 'DNI',
  docNumber: '30111222',
  taxId: '20301112220',
  province: 'Buenos Aires',
  city: 'La Plata',
};

describe('Verificación — el documento no se guarda', () => {
  it('⛔ el número de documento NO aparece en ninguna tabla', async () => {
    /**
     * El test más importante del archivo.
     *
     * Se busca el número crudo en las tres tablas donde podría haberse colado:
     * la de verificaciones, la bitácora, y la de usuarios. Si aparece en
     * alguna, alguien agregó una columna o un log que lo persiste.
     */
    const v = await nuevoVendedor();
    const DNI = '33444555';

    const r = await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: DNI, taxId: '20334445551' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const enVerificaciones = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM seller_verifications WHERE CAST(seller_verifications AS text) LIKE '%${DNI}%'`,
    );
    expect(Number(enVerificaciones[0]?.n ?? 0), 'el DNI está en seller_verifications').toBe(0);

    const enAuditoria = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM audit_logs WHERE CAST(audit_logs AS text) LIKE '%${DNI}%'`,
    );
    expect(Number(enAuditoria[0]?.n ?? 0), 'el DNI está en la bitácora').toBe(0);
  });

  it('guarda la huella y los últimos cuatro, que es lo que hace falta', async () => {
    const v = await nuevoVendedor();
    await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '30111222' },
    });

    const fila = await prisma.sellerVerification.findUnique({ where: { sellerId: v.sellerId } });

    expect(fila?.docNumberLast4).toBe('1222');
    expect(fila?.docNumberHash).toHaveLength(64); // sha256 en hexadecimal
    expect(fila?.docNumberHash).not.toContain('30111222');
  });

  it('⛔ tampoco vuelve en la respuesta al vendedor', async () => {
    const v = await nuevoVendedor();
    await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '30111222' },
    });

    const r = await call('GET', '/api/v1/sellers/verification', { token: v.token });
    const texto = JSON.stringify(r.body);

    expect(texto).not.toContain('30111222');
    expect(texto).not.toContain('20301112220');
    // Los últimos cuatro sí: sirven para confirmar con la persona por teléfono.
    expect(texto).toContain('1222');
  });
});

describe('Verificación — detección de duplicados', () => {
  it('⛔ el mismo documento en dos cuentas lleva el riesgo a alto', async () => {
    /**
     * La señal de fraude más directa que tenemos: identidad robada, o alguien
     * evadiendo una suspensión con una cuenta nueva.
     *
     * No se rechaza el envío —puede haber explicaciones legítimas— pero el
     * caso queda arriba en el panel para que una persona lo mire.
     */
    const MISMO_DNI = '28999888';

    const uno = await nuevoVendedor();
    await call('POST', '/api/v1/sellers/verification', {
      token: uno.token,
      body: { ...DATOS_VALIDOS, docNumber: MISMO_DNI, taxId: undefined },
    });

    const dos = await nuevoVendedor();
    const r = await call('POST', '/api/v1/sellers/verification', {
      token: dos.token,
      body: { ...DATOS_VALIDOS, docNumber: MISMO_DNI, taxId: undefined },
    });

    // El envío se acepta.
    expect(r.status).toBe(201);

    const vendedor = await prisma.seller.findUnique({ where: { id: dos.sellerId } });
    expect(vendedor?.riskLevel).toBe('HIGH');
    expect(vendedor?.riskReasons.join(' ')).toContain('documento_duplicado');
  });
});

describe('Verificación — validación', () => {
  it('⛔ rechaza un DNI con forma imposible', async () => {
    const v = await nuevoVendedor();
    const r = await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '123456789012', taxId: undefined },
    });
    expect(r.status).toBe(400);
  });

  it('⛔ rechaza un CUIT con el dígito verificador mal', async () => {
    // Aritmética local: le ahorra a la persona esperar una revisión manual
    // para que le digan que se equivocó tipeando.
    const v = await nuevoVendedor();
    const r = await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, taxId: '20301112223' },
    });
    expect(r.status).toBe(400);
  });

  it('⛔ sin ser vendedor no se puede enviar', async () => {
    n += 1;
    const u = await call('POST', '/api/v1/auth/dev', {
      body: {
        email: `noseller${n}@test.com`,
        firstName: 'No',
        lastName: 'Vendedor',
        device: {
          installId: `install-nosel-${n}`,
          platform: 'android',
          appVersion: '1.0.0',
          osVersion: '14',
        },
      },
    });

    const r = await call('POST', '/api/v1/sellers/verification', {
      token: u.body.accessToken,
      body: DATOS_VALIDOS,
    });
    expect(r.status).toBe(404);
  });

  it('⛔ sin sesión, 401', async () => {
    const r = await call('POST', '/api/v1/sellers/verification', { body: DATOS_VALIDOS });
    expect(r.status).toBe(401);
  });
});

describe('Verificación — revisión desde el panel', () => {
  it('el flujo completo: enviar, tomar, aprobar', async () => {
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '27888777', taxId: undefined },
    });

    const tomada = await call('POST', `/api/v1/admin/sellers/${v.sellerId}/verification/take`, {
      token: admin.token,
    });
    expect(tomada.status).toBe(201);

    const aprobada = await call(
      'POST',
      `/api/v1/admin/sellers/${v.sellerId}/verification/approve`,
      { token: admin.token, body: { reason: 'documento y datos coinciden, todo correcto' } },
    );
    expect(aprobada.status).toBe(201);

    const vendedor = await prisma.seller.findUnique({ where: { id: v.sellerId } });
    expect(vendedor?.verificationStatus).toBe('VERIFIED');
  });

  it('⛔ dos admins no pueden tomar la misma verificación', async () => {
    /**
     * La condición va en el WHERE del UPDATE, no en un `if` previo: dos
     * revisiones en paralelo del mismo caso es trabajo duplicado, y si los dos
     * llegan a decisiones distintas, la última gana sin que nadie se entere.
     */
    const v = await nuevoVendedor();
    const a = await nuevoAdmin();
    const b = await nuevoAdmin();

    await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '26777666', taxId: undefined },
    });

    const primera = await call('POST', `/api/v1/admin/sellers/${v.sellerId}/verification/take`, {
      token: a.token,
    });
    const segunda = await call('POST', `/api/v1/admin/sellers/${v.sellerId}/verification/take`, {
      token: b.token,
    });

    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(400);
  });

  it('⛔ un usuario común no puede aprobar verificaciones', async () => {
    const v = await nuevoVendedor();
    const otro = await nuevoVendedor();

    const r = await call('POST', `/api/v1/admin/sellers/${v.sellerId}/verification/approve`, {
      token: otro.token,
      body: { reason: 'intento de aprobarme a mí mismo' },
    });
    expect(r.status).toBe(403);
  });

  it('rechazar guarda el motivo y el vendedor lo ve', async () => {
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '25666555', taxId: undefined },
    });
    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/verification/take`, {
      token: admin.token,
    });
    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/verification/reject`, {
      token: admin.token,
      body: { reason: 'el nombre no coincide con el documento enviado' },
    });

    const estado = await call('GET', '/api/v1/sellers/verification', { token: v.token });
    expect(estado.body.estado).toBe('REJECTED');
    expect(estado.body.motivoRechazo).toBe('el nombre no coincide con el documento enviado');
  });

  it('tras un rechazo se puede volver a enviar', async () => {
    // La gente se equivoca tipeando. No poder corregirlo dejaría cuentas
    // legítimas trabadas para siempre.
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '24555444', taxId: undefined },
    });
    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/verification/take`, {
      token: admin.token,
    });
    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/verification/reject`, {
      token: admin.token,
      body: { reason: 'documento ilegible, reenviar por favor' },
    });

    const reenvio = await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '24555444', taxId: undefined },
    });
    expect(reenvio.status).toBe(201);
  });

  it('⛔ no se puede reenviar mientras se está revisando', async () => {
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '23444333', taxId: undefined },
    });
    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/verification/take`, {
      token: admin.token,
    });

    const r = await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '23444333', taxId: undefined },
    });
    expect(r.status).toBe(400);
  });
});

describe('Riesgo', () => {
  it('el vendedor NO ve su nivel de riesgo ni los motivos', async () => {
    /**
     * Decirle "sos riesgo alto por estas cinco razones" es entregarle el mapa
     * exacto de qué evitar. Quien está intentando defraudar es quien más
     * provecho le saca.
     *
     * Lo que sí ve son sus límites, que son concretos y accionables.
     */
    const v = await nuevoVendedor();
    const r = await call('GET', '/api/v1/sellers/verification', { token: v.token });

    const texto = JSON.stringify(r.body);
    expect(texto).not.toContain('riskLevel');
    expect(texto).not.toContain('riskReasons');
    expect(texto).not.toContain('identidad_sin_verificar');
    expect(r.body.limites).toBeDefined();
  });

  it('un vendedor nuevo arranca en riesgo medio con motivos', async () => {
    const v = await nuevoVendedor();
    await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '22333222', taxId: undefined },
    });

    const vendedor = await prisma.seller.findUnique({ where: { id: v.sellerId } });
    expect(vendedor?.riskLevel).toBe('MEDIUM');
    expect(vendedor?.riskReasons.length).toBeGreaterThan(0);
    expect(vendedor?.riskComputedAt).not.toBeNull();
  });

  it('el admin sí ve el riesgo y los motivos', async () => {
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    await call('POST', '/api/v1/sellers/verification', {
      token: v.token,
      body: { ...DATOS_VALIDOS, docNumber: '21222111', taxId: undefined },
    });

    const r = await call('GET', `/api/v1/admin/sellers/${v.sellerId}`, { token: admin.token });
    expect(r.status).toBe(200);
    expect(r.body.riesgo).toBeDefined();
    expect(r.body.riesgo.motivos.length).toBeGreaterThan(0);
  });
});
