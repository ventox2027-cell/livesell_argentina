import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';

/**
 * Seguidores, reseñas, horarios y perfil, contra PostgreSQL real.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE SE PRUEBA ES QUE LOS NÚMEROS NO MIENTAN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Seguidores y reseñas son señales de confianza: un comprador decide con ellas.
 * Un contador que se despega de la realidad —o que alguien puede inflar
 * siguiéndose a sí mismo— no es un bug cosmético, es publicidad engañosa.
 *
 * Por eso los contadores están denormalizados y los tests comprueban que
 * coinciden con las filas reales después de cada operación.
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
    .useValue({
      wsUrl: '',
      ensureRoom: vi.fn(),
      deleteRoom: vi.fn(),
      issueToken: vi.fn().mockResolvedValue({ token: 't', wsUrl: '', roomName: 'r' }),
      verifyWebhook: vi.fn(),
    })
    .compile();

  app = await crearAppDePrueba(moduleRef);
  prisma = app.get(PrismaService);
  redis = app.get(RedisService);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Los tests de integración borran datos y sólo corren contra una base *_test');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE purchase_intents, reviews, follows, store_schedule_slots, store_schedules, ' +
      'live_session_products, live_sessions, audit_logs, seller_verifications, order_items, ' +
      'payment_attempts, refunds, orders, inventory_reservations, inventory, ' +
      'product_variant_options, product_images, product_variants, product_option_values, ' +
      'product_options, products, stores, sellers, auth_events, refresh_tokens, devices, ' +
      'user_identities, users CASCADE',
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

async function nuevoUsuario() {
  n += 1;
  const r = await call('POST', '/api/v1/auth/dev', {
    body: {
      email: `tienda${n}@test.com`,
      firstName: 'Test',
      lastName: `Tienda${n}`,
      device: {
        installId: `install-tienda-${n}`,
        platform: 'android',
        appVersion: '1.0.0',
        osVersion: '14',
      },
    },
  });
  return { token: r.body.accessToken as string, userId: r.body.user.id as string };
}

async function nuevoVendedor() {
  const u = await nuevoUsuario();
  n += 1;
  const s = await call('POST', '/api/v1/sellers', {
    token: u.token,
    body: { displayName: `Tienda de prueba ${n}`, storeName: `Local ${n}` },
  });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return { ...u, sellerId: s.body.seller.id as string, storeId: s.body.store.id as string };
}

describe('Seguidores', () => {
  it('seguir incrementa el contador y se refleja en el perfil', async () => {
    const vendedor = await nuevoVendedor();
    const fan = await nuevoUsuario();

    const r = await call('POST', `/api/v1/sellers/${vendedor.sellerId}/follow`, {
      token: fan.token,
    });

    expect(r.status).toBe(201);
    expect(r.body.siguiendo).toBe(true);
    expect(r.body.seguidores).toBe(1);

    const perfil = await call('GET', `/api/v1/sellers/${vendedor.sellerId}/profile`, {
      token: fan.token,
    });
    expect(perfil.body.seguidores).toBe(1);
    expect(perfil.body.loSigo).toBe(true);
  });

  it('seguir dos veces NO cuenta dos', async () => {
    /**
     * La restricción única de la base es lo que lo garantiza: la segunda
     * inserción choca y su transacción entera se deshace, incremento incluido.
     */
    const vendedor = await nuevoVendedor();
    const fan = await nuevoUsuario();
    const url = `/api/v1/sellers/${vendedor.sellerId}/follow`;

    await call('POST', url, { token: fan.token });
    const segunda = await call('POST', url, { token: fan.token });

    expect(segunda.body.seguidores).toBe(1);

    const filas = await prisma.follow.count({ where: { sellerId: vendedor.sellerId } });
    const contador = await prisma.seller.findUnique({
      where: { id: vendedor.sellerId },
      select: { followersCount: true },
    });

    // Lo que importa: el contador coincide con las filas reales.
    expect(filas).toBe(1);
    expect(contador?.followersCount).toBe(1);
  });

  it('dejar de seguir dos veces no baja de cero', async () => {
    // Sin la condición sobre el borrado, el segundo decremento chocaría contra
    // el CHECK de la base con un error confuso lejos de su causa.
    const vendedor = await nuevoVendedor();
    const fan = await nuevoUsuario();
    const url = `/api/v1/sellers/${vendedor.sellerId}/follow`;

    await call('POST', url, { token: fan.token });
    await call('DELETE', url, { token: fan.token });
    const tercera = await call('DELETE', url, { token: fan.token });

    expect(tercera.status).toBe(200);
    expect(tercera.body.seguidores).toBe(0);

    const contador = await prisma.seller.findUnique({
      where: { id: vendedor.sellerId },
      select: { followersCount: true },
    });
    expect(contador?.followersCount).toBe(0);
  });

  it('⛔ nadie se sigue a sí mismo', async () => {
    /**
     * El número de seguidores es una señal de confianza. Dejar que se
     * auto-incremente la degrada: con esto, el 1 que ve un comprador es siempre
     * otra persona.
     */
    const vendedor = await nuevoVendedor();

    const r = await call('POST', `/api/v1/sellers/${vendedor.sellerId}/follow`, {
      token: vendedor.token,
    });
    expect(r.status).toBe(400);

    const contador = await prisma.seller.findUnique({
      where: { id: vendedor.sellerId },
      select: { followersCount: true },
    });
    expect(contador?.followersCount).toBe(0);
  });

  it('varios seguidores cuentan bien', async () => {
    const vendedor = await nuevoVendedor();

    for (let i = 0; i < 3; i++) {
      const fan = await nuevoUsuario();
      await call('POST', `/api/v1/sellers/${vendedor.sellerId}/follow`, { token: fan.token });
    }

    const contador = await prisma.seller.findUnique({
      where: { id: vendedor.sellerId },
      select: { followersCount: true },
    });
    expect(contador?.followersCount).toBe(3);
  });

  it('⛔ sin sesión no se puede seguir', async () => {
    const vendedor = await nuevoVendedor();
    const r = await call('POST', `/api/v1/sellers/${vendedor.sellerId}/follow`);
    expect(r.status).toBe(401);
  });
});

describe('Reseñas', () => {
  it('⛔ no se puede reseñar sin haber comprado', async () => {
    /**
     * La defensa central contra reseñas falsas. Sin compra no hay reseña, y no
     * hace falta moderar nada.
     */
    const vendedor = await nuevoVendedor();
    const cualquiera = await nuevoUsuario();

    const r = await call('POST', '/api/v1/orders/ord_inventado/review', {
      token: cualquiera.token,
      body: { rating: 5, comment: 'excelente' },
    });
    expect(r.status).toBe(404);

    // Y la reputación del vendedor no se movió.
    const s = await prisma.seller.findUnique({
      where: { id: vendedor.sellerId },
      select: { ratingCount: true, ratingSum: true },
    });
    expect(s?.ratingCount).toBe(0);
    expect(s?.ratingSum).toBe(0);
  });

  it('⛔ un rating fuera de 1..5 se rechaza', async () => {
    const cualquiera = await nuevoUsuario();

    for (const rating of [0, 6, -1, 100]) {
      const r = await call('POST', '/api/v1/orders/ord_x/review', {
        token: cualquiera.token,
        body: { rating },
      });
      expect(r.status, `rating ${rating}`).toBe(400);
    }
  });

  it('el perfil sin reseñas dice null, no cero', async () => {
    /**
     * "Sin reseñas todavía" es distinto de "promedio cero". Un perfil nuevo que
     * mostrara 0,0 ⭐ parecería un vendedor pésimo en vez de uno nuevo.
     */
    const vendedor = await nuevoVendedor();

    const perfil = await call('GET', `/api/v1/sellers/${vendedor.sellerId}/profile`);

    expect(perfil.body.rating).toBeNull();
    expect(perfil.body.resenas).toBe(0);
    expect(perfil.body.ventas).toBe(0);
  });
});

describe('Perfil público', () => {
  it('separa identidad verificada de vendedor confiable', async () => {
    /**
     * Las dos insignias no son la misma. Alguien puede verificar su DNI el
     * primer día sin haber vendido nunca: eso es identidad, no reputación.
     */
    const vendedor = await nuevoVendedor();

    await prisma.seller.update({
      where: { id: vendedor.sellerId },
      data: { verificationStatus: 'VERIFIED', riskLevel: 'LOW' },
    });

    const perfil = await call('GET', `/api/v1/sellers/${vendedor.sellerId}/profile`);

    expect(perfil.body.identidadVerificada).toBe(true);
    // Sin ventas todavía: verificado no es confiable.
    expect(perfil.body.vendedorConfiable).toBe(false);
  });

  it('es público, pero `loSigo` sólo aparece con sesión', async () => {
    const vendedor = await nuevoVendedor();

    const anonimo = await call('GET', `/api/v1/sellers/${vendedor.sellerId}/profile`);
    expect(anonimo.status).toBe(200);
    expect(anonimo.body.loSigo).toBeUndefined();

    const conSesion = await nuevoUsuario();
    const identificado = await call('GET', `/api/v1/sellers/${vendedor.sellerId}/profile`, {
      token: conSesion.token,
    });
    expect(identificado.body.loSigo).toBe(false);
  });

  it('⛔ un vendedor bloqueado por fraude no tiene perfil público', async () => {
    const vendedor = await nuevoVendedor();
    await prisma.seller.update({
      where: { id: vendedor.sellerId },
      data: { status: 'BLOCKED' },
    });

    const r = await call('GET', `/api/v1/sellers/${vendedor.sellerId}/profile`);
    expect(r.status).toBe(404);
  });

  it('incluye el estado de la tienda', async () => {
    const vendedor = await nuevoVendedor();
    const perfil = await call('GET', `/api/v1/sellers/${vendedor.sellerId}/profile`);

    // Sin horario configurado, abierta.
    expect(perfil.body.horario.abierta).toBe(true);
    expect(perfil.body.tienda.id).toBe(vendedor.storeId);
  });
});

describe('Horarios', () => {
  it('sin configurar, la tienda está ABIERTA', async () => {
    /**
     * Lo contrario sería el peor comportamiento posible: el vendedor carga sus
     * productos, no vende nada, y no tiene forma de entender por qué.
     */
    const vendedor = await nuevoVendedor();
    const r = await call('GET', `/api/v1/stores/${vendedor.storeId}/status`);

    expect(r.status).toBe(200);
    expect(r.body.abierta).toBe(true);
  });

  it('guardar y leer el horario', async () => {
    const vendedor = await nuevoVendedor();

    const guardado = await call('PUT', '/api/v1/stores/me/schedule', {
      token: vendedor.token,
      body: {
        modo: 'SCHEDULED',
        franjas: [
          { dia: 1, abreMinutos: 540, cierraMinutos: 780 },
          { dia: 1, abreMinutos: 960, cierraMinutos: 1200 },
        ],
      },
    });

    expect(guardado.status).toBe(200);
    expect(guardado.body.modo).toBe('SCHEDULED');
    expect(guardado.body.franjas).toHaveLength(2);
    expect(guardado.body.franjas[0].abre).toBe('09:00');
    expect(guardado.body.franjas[0].cierra).toBe('13:00');
  });

  it('guardar reemplaza el horario entero, no acumula', async () => {
    // Un PATCH por franja dejaría a la tienda, a mitad de camino, con un
    // horario que su dueño nunca eligió.
    const vendedor = await nuevoVendedor();

    await call('PUT', '/api/v1/stores/me/schedule', {
      token: vendedor.token,
      body: { modo: 'SCHEDULED', franjas: [{ dia: 1, abreMinutos: 540, cierraMinutos: 1080 }] },
    });
    const segundo = await call('PUT', '/api/v1/stores/me/schedule', {
      token: vendedor.token,
      body: { modo: 'SCHEDULED', franjas: [{ dia: 2, abreMinutos: 600, cierraMinutos: 1200 }] },
    });

    expect(segundo.body.franjas).toHaveLength(1);
    expect(segundo.body.franjas[0].dia).toBe(2);
  });

  it('⛔ rechaza franjas superpuestas', async () => {
    const vendedor = await nuevoVendedor();

    const r = await call('PUT', '/api/v1/stores/me/schedule', {
      token: vendedor.token,
      body: {
        modo: 'SCHEDULED',
        franjas: [
          { dia: 1, abreMinutos: 540, cierraMinutos: 780 },
          { dia: 1, abreMinutos: 660, cierraMinutos: 1080 },
        ],
      },
    });

    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('superpuestas');
  });

  it('⛔ rechaza una franja de duración cero', async () => {
    const vendedor = await nuevoVendedor();
    const r = await call('PUT', '/api/v1/stores/me/schedule', {
      token: vendedor.token,
      body: { modo: 'SCHEDULED', franjas: [{ dia: 1, abreMinutos: 540, cierraMinutos: 540 }] },
    });
    expect(r.status).toBe(400);
  });

  it('modo sólo-en-vivo: cerrada sin transmisión', async () => {
    const vendedor = await nuevoVendedor();

    await call('PUT', '/api/v1/stores/me/schedule', {
      token: vendedor.token,
      body: { modo: 'LIVE_ONLY', franjas: [] },
    });

    const cerrada = await call('GET', `/api/v1/stores/${vendedor.storeId}/status`);
    expect(cerrada.body.abierta).toBe(false);
    expect(cerrada.body.motivo).toContain('sólo en vivo');
  });

  it('modo sólo-en-vivo: abre cuando arranca la transmisión', async () => {
    /**
     * La conexión entre los dos módulos. El estado de la tienda depende de si
     * hay un vivo al aire, y eso se consulta en el momento — no hay un booleano
     * que alguien tenga que acordarse de actualizar.
     */
    const vendedor = await nuevoVendedor();

    await call('PUT', '/api/v1/stores/me/schedule', {
      token: vendedor.token,
      body: { modo: 'LIVE_ONLY', franjas: [] },
    });

    const live = await call('POST', '/api/v1/live', {
      token: vendedor.token,
      body: { title: 'Vendiendo ahora', productIds: [] },
    });
    await call('POST', `/api/v1/live/${live.body.id}/start`, { token: vendedor.token });

    const abierta = await call('GET', `/api/v1/stores/${vendedor.storeId}/status`);
    expect(abierta.body.abierta).toBe(true);

    // Y al terminar el vivo, cierra.
    await call('POST', `/api/v1/live/${live.body.id}/end`, { token: vendedor.token });

    const despues = await call('GET', `/api/v1/stores/${vendedor.storeId}/status`);
    expect(despues.body.abierta).toBe(false);
  });

  it('⛔ sin ser vendedor no se puede configurar horario', async () => {
    const u = await nuevoUsuario();
    const r = await call('PUT', '/api/v1/stores/me/schedule', {
      token: u.token,
      body: { modo: 'ALWAYS_OPEN', franjas: [] },
    });
    expect(r.status).toBe(404);
  });
});

describe('Intención de compra', () => {
  it('⛔ NO descuenta stock', async () => {
    /**
     * El punto central del modelo. Una reserva real bloquea una unidad durante
     * cinco minutos; bloquearla las diez horas que una tienda está cerrada
     * sacaría productos de la venta para gente que quizás no vuelva.
     */
    const vendedor = await nuevoVendedor();
    n += 1;

    const p = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: `Producto intención ${n}`,
        slug: `producto-intencion-${n}-${Date.now().toString(36)}`,
        basePriceCents: 500000,
        status: 'ACTIVE',
      },
    });
    const detalle = await call('GET', `/api/v1/products/${p.body.id}`, { token: vendedor.token });
    const variantId = detalle.body.variants[0].id as string;

    await call('PATCH', `/api/v1/products/${p.body.id}/variants/${variantId}/inventory`, {
      token: vendedor.token,
      body: { onHand: 5 },
    });

    const comprador = await nuevoUsuario();
    const r = await call('POST', `/api/v1/variants/${variantId}/intent`, {
      token: comprador.token,
      body: { quantity: 2 },
    });

    expect(r.status).toBe(201);

    const inv = await prisma.inventory.findUnique({ where: { productVariantId: variantId } });
    expect(inv?.onHand).toBe(5);
    // Lo que importa: NADA reservado.
    expect(inv?.reserved).toBe(0);
  });

  it('dejarla dos veces actualiza la cantidad, no crea otra', async () => {
    const vendedor = await nuevoVendedor();
    n += 1;

    const p = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: `Producto intención dup ${n}`,
        slug: `prod-int-dup-${n}-${Date.now().toString(36)}`,
        basePriceCents: 500000,
        status: 'ACTIVE',
      },
    });
    const detalle = await call('GET', `/api/v1/products/${p.body.id}`, { token: vendedor.token });
    const variantId = detalle.body.variants[0].id as string;

    const comprador = await nuevoUsuario();
    const url = `/api/v1/variants/${variantId}/intent`;

    await call('POST', url, { token: comprador.token, body: { quantity: 1 } });
    await call('POST', url, { token: comprador.token, body: { quantity: 3 } });

    const intenciones = await prisma.purchaseIntent.findMany({
      where: { productVariantId: variantId },
    });
    expect(intenciones).toHaveLength(1);
    expect(intenciones[0]?.quantity).toBe(3);
  });
});
