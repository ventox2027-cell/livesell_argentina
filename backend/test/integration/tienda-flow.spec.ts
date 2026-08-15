import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationsService } from '@/modules/notifications/notifications.service';
import type { ReaperturasService } from '@/modules/stores/reaperturas.service';
import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';
import { NACIMIENTO_ADULTO_ISO } from '../helpers/edad';

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

  // Los barridos se invocan a mano para que cada caso diga QUÉ está probando
  // en vez de esperar a ver qué pasa.
  STORE_REOPEN_SWEEP_ENABLED: 'false',
  NOTIFICATIONS_DISPATCHER_ENABLED: 'false',
};

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let reaperturas: ReaperturasService;
let notifications: NotificationsService;

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { PrismaService } = await import('@/shared/prisma/prisma.service');
  const { RedisService } = await import('@/shared/redis/redis.service');
  const { ReaperturasService } = await import('@/modules/stores/reaperturas.service');
  const { NotificationsService } = await import('@/modules/notifications/notifications.service');

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
  reaperturas = app.get(ReaperturasService);
  notifications = app.get(NotificationsService);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Los tests de integración borran datos y sólo corren contra una base *_test');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE likes, notifications, purchase_intents, reviews, follows, store_schedule_slots, store_schedules, ' +
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

  /**
   * VendoX es 18+ y el backend lo exige antes de comprar y de crear la tienda.
   *
   * Se declara por el mismo camino que usa la app —`PATCH /auth/me`— y no
   * escribiendo la columna: así el test también falla si ese endpoint se rompe.
   * Ver `helpers/edad.ts`.
   */
  await call('PATCH', '/api/v1/auth/me', {
    token: r.body.accessToken as string,
    body: { birthDate: NACIMIENTO_ADULTO_ISO },
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

/**
 * El catálogo y el detalle que ve QUIEN COMPRA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO HABÍA NINGÚN TEST DE ESTO, Y SE NOTÓ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La app pedía el detalle de producto a `GET /products/:id`, que es del
 * VENDEDOR: resuelve por dueño y contesta `SELLER_NOT_FOUND` a cualquiera que
 * no tenga tienda. O sea que el selector de talles **nunca funcionó para un
 * comprador**: abría un panel sin nombre, con precio $0,00 y "esa combinación
 * no existe".
 *
 * Ni el backend ni la app lo vieron. El backend porque nadie probaba el
 * catálogo desde una sesión sin tienda; la app porque su test de contrato
 * estaba escrito contra un JSON inventado en vez de una respuesta real, y
 * porque `ApiClient` no lanza con 4xx —usa `validateStatus: s < 500` para poder
 * reintentar tras refrescar el token—, así que el cuerpo del error se parseó
 * como si fuera un producto.
 *
 * Lo encontró abrir la pantalla en el emulador.
 */
describe('Catálogo del comprador', () => {
  /** Un vendedor con un producto publicado y stock. */
  async function tiendaConProducto(onHand = 5) {
    const vendedor = await nuevoVendedor();
    n += 1;

    const p = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: `Producto catálogo ${n}`,
        slug: `producto-catalogo-${n}-${Date.now().toString(36)}`,
        basePriceCents: 4_500_000,
        status: 'ACTIVE',
      },
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);

    const detalle = await call('GET', `/api/v1/products/${p.body.id}`, { token: vendedor.token });
    const variantId = detalle.body.variants[0].id as string;

    await call('PATCH', `/api/v1/products/${p.body.id}/variants/${variantId}/inventory`, {
      token: vendedor.token,
      body: { onHand },
    });

    return { ...vendedor, productId: p.body.id as string, variantId };
  }

  it('⛔ el detalle del vendedor le da 404 a quien compra', async () => {
    // El defecto original, clavado: si alguien vuelve a apuntar la app acá,
    // este test explica por qué no.
    const tienda = await tiendaConProducto();
    const comprador = await nuevoUsuario();

    const r = await call('GET', `/api/v1/products/${tienda.productId}`, {
      token: comprador.token,
    });

    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('SELLER_NOT_FOUND');
  });

  it('el detalle del catálogo funciona SIN sesión', async () => {
    const tienda = await tiendaConProducto(3);

    // Sin token: mirar un producto no exige cuenta. Se pide al reservar.
    const r = await call('GET', `/api/v1/catalog/products/${tienda.productId}`);

    expect(r.status).toBe(200);
    expect(r.body.nombre).toContain('Producto catálogo');
    expect(r.body.precioCentavos).toBe(4_500_000);
    expect(r.body.variantes).toHaveLength(1);
    expect(r.body.variantes[0].disponible).toBe(3);
  });

  it('el disponible sale calculado, y onHand/reserved NO viajan', async () => {
    const tienda = await tiendaConProducto(7);

    // Se apartan dos unidades para que onHand y disponible no coincidan: si el
    // backend mandara onHand, este test no notaría la diferencia.
    const reserva = await call('POST', '/api/v1/inventory/reservations', {
      token: (await nuevoUsuario()).token,
      idempotencyKey: `cat-${Date.now()}-${n}`,
      body: { productVariantId: tienda.variantId, quantity: 2 },
    });
    expect(reserva.status, JSON.stringify(reserva.body)).toBe(201);

    const r = await call('GET', `/api/v1/catalog/products/${tienda.productId}`);

    expect(r.body.variantes[0].disponible).toBe(5);

    // Cuánto tiene el vendedor y cuánto está apartado son números suyos.
    const crudo = JSON.stringify(r.body);
    expect(crudo).not.toContain('onHand');
    expect(crudo).not.toContain('reserved');
  });

  it('⛔ un producto pausado no se puede mirar', async () => {
    const tienda = await tiendaConProducto();

    const pausa = await call('PATCH', `/api/v1/products/${tienda.productId}`, {
      token: tienda.token,
      body: { status: 'PAUSED' },
    });
    expect(pausa.status, JSON.stringify(pausa.body)).toBe(200);

    // 404 y no "existe pero está pausado": confirmar qué ids son reales le
    // sirve a quien esté probando ids al azar, y a nadie más.
    const r = await call('GET', `/api/v1/catalog/products/${tienda.productId}`);
    expect(r.status).toBe(404);
  });

  it('un id que no existe da 404 y no rompe', async () => {
    const r = await call('GET', '/api/v1/catalog/products/prd_que_no_existe');
    expect(r.status).toBe(404);
  });

  it('el catálogo de la tienda lista el producto', async () => {
    const tienda = await tiendaConProducto(4);

    const r = await call('GET', `/api/v1/stores/${tienda.storeId}/catalog`);

    expect(r.status).toBe(200);
    const item = r.body.items.find((i: { id: string }) => i.id === tienda.productId);
    expect(item).toBeDefined();
    expect(item.disponible).toBe(4);
    expect(item.variantes).toBe(1);
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

// ═══════════════════════════════════════════════════════════════════════════
// INTERESADOS Y REAPERTURA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El otro lado de la intención de compra.
 *
 * Alguien deja "avisame cuando abran". Lo que sigue son dos cosas: que el
 * vendedor pueda ver cuánta gente está esperando —para reponer— y que a esa
 * gente efectivamente se le avise cuando la tienda abre.
 *
 * Lo que se prueba con más insistencia es lo que NO se devuelve: quien dejó una
 * intención pidió un aviso, no le dio su teléfono a un vendedor.
 */
describe('Interesados y reapertura', () => {
  /** Producto activo con stock, listo para que alguien lo espere. */
  async function productoDe(vendedor: { token: string }, stock = 0) {
    n += 1;
    const p = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: `Buzo interesados ${n}`,
        slug: `buzo-interesados-${n}-${Date.now().toString(36)}`,
        basePriceCents: 890_000,
        status: 'ACTIVE',
      },
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);

    const detalle = await call('GET', `/api/v1/products/${p.body.id}`, { token: vendedor.token });
    const variantId = detalle.body.variants[0].id as string;

    if (stock > 0) {
      await call('PATCH', `/api/v1/products/${p.body.id}/variants/${variantId}/inventory`, {
        token: vendedor.token,
        body: { onHand: stock },
      });
    }

    return { productId: p.body.id as string, variantId };
  }

  /** Cierra la tienda con un horario que hoy no cubre este momento. */
  async function cerrar(vendedor: { token: string }) {
    const r = await call('PUT', '/api/v1/stores/me/schedule', {
      token: vendedor.token,
      body: {
        modo: 'SCHEDULED',
        zona: 'America/Argentina/Buenos_Aires',
        // Sin franjas: con modo por horarios y ninguna franja, está cerrada
        // siempre. Es lo contrario de "sin horario configurado".
        franjas: [],
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  /** La vuelve a abrir de par en par. */
  async function abrir(vendedor: { token: string }) {
    const r = await call('PUT', '/api/v1/stores/me/schedule', {
      token: vendedor.token,
      body: { modo: 'ALWAYS_OPEN', zona: 'America/Argentina/Buenos_Aires', franjas: [] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  describe('La lista del vendedor', () => {
    it('cuenta personas y unidades, agrupadas por producto', async () => {
      const vendedor = await nuevoVendedor();
      const { productId, variantId } = await productoDe(vendedor, 1);

      const uno = await nuevoUsuario();
      const dos = await nuevoUsuario();
      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: uno.token,
        body: { quantity: 2 },
      });
      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: dos.token,
        body: { quantity: 1 },
      });

      const r = await call('GET', '/api/v1/stores/me/intents', { token: vendedor.token });

      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.totalPersonas).toBe(2);
      expect(r.body.totalUnidades).toBe(3);
      expect(r.body.items).toHaveLength(1);
      expect(r.body.items[0].productoId).toBe(productId);
      expect(r.body.items[0].personas).toBe(2);
      expect(r.body.items[0].unidades).toBe(3);
    });

    it('⛔ NUNCA devuelve teléfono, email ni apellido', async () => {
      /**
       * ═══════════════════════════════════════════════════════════════════
       * ES EL TEST MÁS IMPORTANTE DE ESTE BLOQUE
       * ═══════════════════════════════════════════════════════════════════
       *
       * Quien dejó una intención pidió que le AVISEN. No le dio su teléfono a
       * un vendedor para que lo contacte por WhatsApp. Si esos datos
       * aparecieran acá, eso es exactamente lo que pasaría el primer día, y no
       * habría forma de volver atrás.
       *
       * Se busca sobre el JSON entero y no sobre los campos que conozco: si
       * mañana alguien agrega `user: {...}` completo a la proyección, esto lo
       * tiene que ver.
       */
      const vendedor = await nuevoVendedor();
      const { variantId } = await productoDe(vendedor, 1);

      const comprador = await nuevoUsuario();
      const perfil = await prisma.user.update({
        where: { id: comprador.userId },
        data: { phoneE164: '+5491133445566', lastName: 'Apellidoraro' },
      });

      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: comprador.token,
        body: { quantity: 1 },
      });

      const r = await call('GET', '/api/v1/stores/me/intents', { token: vendedor.token });
      const crudo = JSON.stringify(r.body);

      expect(crudo).not.toContain(perfil.phoneE164);
      expect(crudo).not.toContain(perfil.email);
      expect(crudo).not.toContain('Apellidoraro');
      expect(crudo).not.toContain(comprador.userId);

      // Lo que sí: el nombre de pila, para que la lista no sea anónima.
      expect(r.body.items[0].gente[0].nombre).toBe(perfil.firstName);
    });

    it('⛔ no muestra interesados de otra tienda', async () => {
      const propio = await nuevoVendedor();
      const ajeno = await nuevoVendedor();
      const { variantId } = await productoDe(ajeno, 1);

      const comprador = await nuevoUsuario();
      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: comprador.token,
        body: { quantity: 1 },
      });

      const r = await call('GET', '/api/v1/stores/me/intents', { token: propio.token });

      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(0);
      expect(r.body.totalPersonas).toBe(0);
    });

    it('marca los productos donde el stock no alcanza', async () => {
      // Es el número que hace útil la pantalla: no "hay interesados" sino "hay
      // interesados y no tenés qué venderles".
      const vendedor = await nuevoVendedor();
      const { variantId } = await productoDe(vendedor, 1);

      const uno = await nuevoUsuario();
      const dos = await nuevoUsuario();
      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: uno.token,
        body: { quantity: 2 },
      });
      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: dos.token,
        body: { quantity: 2 },
      });

      const r = await call('GET', '/api/v1/stores/me/intents', { token: vendedor.token });

      // Cuatro unidades esperadas, una disponible.
      expect(r.body.items[0].variantes[0].disponible).toBe(1);
      expect(r.body.items[0].variantes[0].unidades).toBe(4);
      expect(r.body.sinStock).toBe(1);
    });
  });

  describe('El aviso al reabrir', () => {
    it('la tienda que reabre le avisa a quien estaba esperando', async () => {
      const vendedor = await nuevoVendedor();
      const { productId, variantId } = await productoDe(vendedor, 3);
      await cerrar(vendedor);

      const comprador = await nuevoUsuario();
      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: comprador.token,
        body: { quantity: 1 },
      });

      // El barrido tiene que ver la tienda cerrada antes de verla abierta: es
      // una TRANSICIÓN, no un estado.
      await reaperturas.barrer();
      await abrir(vendedor);
      const resumen = await reaperturas.barrer();

      expect(resumen.reabiertas).toBe(1);
      expect(resumen.avisos).toBe(1);

      const avisos = await call('GET', '/api/v1/notifications', { token: comprador.token });
      expect(avisos.status, JSON.stringify(avisos.body)).toBe(200);
      expect(avisos.body.items).toHaveLength(1);
      expect(avisos.body.items[0].type).toBe('STORE_REOPENED');
      expect(avisos.body.items[0].data.productId).toBe(productId);
      expect(avisos.body.sinLeer).toBe(1);
    });

    it('⛔ dos barridos seguidos NO avisan dos veces', async () => {
      /**
       * Es lo que hace que un vendedor probando su horario a las diez de la
       * mañana no le mande cuatro notificaciones a la misma persona. Lo
       * garantizan dos cosas: el UPDATE condicional sobre `wasOpen` y la clave
       * de deduplicación.
       */
      const vendedor = await nuevoVendedor();
      const { variantId } = await productoDe(vendedor, 3);
      await cerrar(vendedor);

      const comprador = await nuevoUsuario();
      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: comprador.token,
        body: { quantity: 1 },
      });

      await reaperturas.barrer();
      await abrir(vendedor);

      await reaperturas.barrer();
      const segundo = await reaperturas.barrer();
      const tercero = await reaperturas.barrer();

      expect(segundo.avisos).toBe(0);
      expect(tercero.avisos).toBe(0);

      const cuantos = await prisma.notification.count({
        where: { userId: comprador.userId, type: 'STORE_REOPENED' },
      });
      expect(cuantos).toBe(1);
    });

    it('una tienda que nunca cerró no manda nada', async () => {
      // `wasOpen` arranca en `true` justamente para esto: si arrancara en
      // `false`, la primera corrida vería una reapertura falsa en TODAS las
      // tiendas y les avisaría a todos de golpe.
      const vendedor = await nuevoVendedor();
      const { variantId } = await productoDe(vendedor, 3);
      await abrir(vendedor);

      const comprador = await nuevoUsuario();
      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: comprador.token,
        body: { quantity: 1 },
      });

      const resumen = await reaperturas.barrer();

      expect(resumen.avisos).toBe(0);
      expect(
        await prisma.notification.count({ where: { userId: comprador.userId } }),
      ).toBe(0);
    });

    it('⛔ no avisa por un producto pausado', async () => {
      // Sería mandar a alguien a una pantalla donde no puede comprar.
      const vendedor = await nuevoVendedor();
      const { productId, variantId } = await productoDe(vendedor, 3);
      await cerrar(vendedor);

      const comprador = await nuevoUsuario();
      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: comprador.token,
        body: { quantity: 1 },
      });

      await call('PATCH', `/api/v1/products/${productId}`, {
        token: vendedor.token,
        body: { status: 'PAUSED' },
      });

      await reaperturas.barrer();
      await abrir(vendedor);
      const resumen = await reaperturas.barrer();

      expect(resumen.reabiertas).toBe(1);
      expect(resumen.avisos).toBe(0);
    });

    it('la intención queda marcada como avisada', async () => {
      const vendedor = await nuevoVendedor();
      const { variantId } = await productoDe(vendedor, 3);
      await cerrar(vendedor);

      const comprador = await nuevoUsuario();
      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: comprador.token,
        body: { quantity: 1 },
      });

      await reaperturas.barrer();
      await abrir(vendedor);
      await reaperturas.barrer();

      const intencion = await prisma.purchaseIntent.findFirst({
        where: { userId: comprador.userId, productVariantId: variantId },
      });
      expect(intencion?.notifiedAt).not.toBeNull();

      // Y el vendedor lo ve en su lista.
      const lista = await call('GET', '/api/v1/stores/me/intents', { token: vendedor.token });
      expect(lista.body.items[0].gente[0].avisado).toBe(true);
    });
  });

  describe('El centro de notificaciones', () => {
    async function avisarA(comprador: { token: string; userId: string }) {
      const vendedor = await nuevoVendedor();
      const { variantId } = await productoDe(vendedor, 3);
      await cerrar(vendedor);
      await call('POST', `/api/v1/variants/${variantId}/intent`, {
        token: comprador.token,
        body: { quantity: 1 },
      });
      await reaperturas.barrer();
      await abrir(vendedor);
      await reaperturas.barrer();
    }

    it('marcar una como leída baja el contador', async () => {
      const comprador = await nuevoUsuario();
      await avisarA(comprador);

      const antes = await call('GET', '/api/v1/notifications/unread-count', {
        token: comprador.token,
      });
      expect(antes.body.sinLeer).toBe(1);

      const lista = await call('GET', '/api/v1/notifications', { token: comprador.token });
      const id = lista.body.items[0].id as string;

      const marcada = await call('PATCH', `/api/v1/notifications/${id}/read`, {
        token: comprador.token,
      });
      expect(marcada.status, JSON.stringify(marcada.body)).toBe(200);

      const despues = await call('GET', '/api/v1/notifications/unread-count', {
        token: comprador.token,
      });
      expect(despues.body.sinLeer).toBe(0);
    });

    it('⛔ no se puede marcar leída la notificación de otro', async () => {
      const dueño = await nuevoUsuario();
      const intruso = await nuevoUsuario();
      await avisarA(dueño);

      const lista = await call('GET', '/api/v1/notifications', { token: dueño.token });
      const id = lista.body.items[0].id as string;

      // Responde OK: confirmar que el id existe ya sería información. Lo que
      // importa es que NO cambió nada.
      await call('PATCH', `/api/v1/notifications/${id}/read`, { token: intruso.token });

      const sinLeer = await call('GET', '/api/v1/notifications/unread-count', {
        token: dueño.token,
      });
      expect(sinLeer.body.sinLeer).toBe(1);
    });

    it('⛔ nadie ve las notificaciones de otro', async () => {
      const dueño = await nuevoUsuario();
      const intruso = await nuevoUsuario();
      await avisarA(dueño);

      const r = await call('GET', '/api/v1/notifications', { token: intruso.token });

      expect(r.body.items).toHaveLength(0);
      expect(r.body.sinLeer).toBe(0);
    });

    it('sin Firebase configurado el aviso queda OMITIDO, no ENVIADO', async () => {
      /**
       * Marcarlo como enviado sería mentirle a la base. El día que se conecte
       * Firebase de verdad, nadie sabría cuáles salieron y cuáles no.
       */
      const comprador = await nuevoUsuario();
      await avisarA(comprador);

      const resumen = await notifications.despachar();
      expect(resumen.omitidos).toBeGreaterThanOrEqual(1);
      expect(resumen.enviados).toBe(0);

      const fila = await prisma.notification.findFirst({
        where: { userId: comprador.userId },
      });
      expect(fila?.pushStatus).toBe('SKIPPED');
      expect(fila?.nextAttemptAt).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ME GUSTA Y COMPARTIR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El corazón y su contador.
 *
 * El contador está denormalizado —contar la tabla en cada tarjeta del feed
 * sería una consulta agregada por fila en la pantalla más visitada— así que lo
 * que hay que probar no es que sume, sino que **no se despegue** de las filas
 * reales pase lo que pase.
 */
describe('Me gusta', () => {
  async function productoPublicado(vendedor: { token: string }) {
    n += 1;
    const p = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: `Producto like ${n}`,
        slug: `producto-like-${n}-${Date.now().toString(36)}`,
        basePriceCents: 890_000,
        status: 'ACTIVE',
      },
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    return p.body.id as string;
  }

  /** Cuenta las filas reales, no el contador. */
  async function filasReales(productId: string) {
    return prisma.like.count({ where: { targetType: 'PRODUCT', targetId: productId } });
  }

  it('el corazón es un interruptor', async () => {
    /**
     * Un solo endpoint que alterna, no `POST` y `DELETE`. Con dos, la app tiene
     * que saber el estado actual para elegir cuál llamar, y si el que tenía era
     * viejo el resultado es al revés de lo que la persona quiso.
     */
    const vendedor = await nuevoVendedor();
    const productId = await productoPublicado(vendedor);
    const fan = await nuevoUsuario();

    const dado = await call('POST', `/api/v1/products/${productId}/like`, { token: fan.token });
    expect(dado.status, JSON.stringify(dado.body)).toBe(201);
    expect(dado.body.meGusta).toBe(true);
    expect(dado.body.total).toBe(1);

    const quitado = await call('POST', `/api/v1/products/${productId}/like`, {
      token: fan.token,
    });
    expect(quitado.body.meGusta).toBe(false);
    expect(quitado.body.total).toBe(0);
  });

  it('⛔ el contador NUNCA se despega de las filas', async () => {
    // Es lo único que importa de un contador denormalizado. Se hace una
    // secuencia larga y al final se comparan las dos fuentes.
    const vendedor = await nuevoVendedor();
    const productId = await productoPublicado(vendedor);

    const fans = [await nuevoUsuario(), await nuevoUsuario(), await nuevoUsuario()];
    const url = `/api/v1/products/${productId}/like`;

    for (const f of fans) await call('POST', url, { token: f.token });
    // El primero se arrepiente.
    await call('POST', url, { token: fans[0]!.token });
    // Y vuelve.
    await call('POST', url, { token: fans[0]!.token });

    const producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(producto.likesCount).toBe(await filasReales(productId));
    expect(producto.likesCount).toBe(3);
  });

  it('tocar dos veces seguidas no cuenta dos', async () => {
    // En un vivo pasa todo el tiempo. Lo garantiza el índice único, no un `if`:
    // dos toques rápidos llegan como dos peticiones y una comprobación previa
    // perdería la carrera.
    const vendedor = await nuevoVendedor();
    const productId = await productoPublicado(vendedor);
    const fan = await nuevoUsuario();
    const url = `/api/v1/products/${productId}/like`;

    const [a, b] = await Promise.all([
      call('POST', url, { token: fan.token }),
      call('POST', url, { token: fan.token }),
    ]);

    // Uno da y el otro quita, o los dos ven el mismo estado. Lo que NO puede
    // pasar es que queden dos filas.
    expect([a.status, b.status].every((s) => s === 201)).toBe(true);
    expect(await filasReales(productId)).toBeLessThanOrEqual(1);

    const producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(producto.likesCount).toBe(await filasReales(productId));
  });

  it('⛔ no se puede dar me gusta a algo que no existe', async () => {
    // La tabla es polimórfica y no puede tener clave foránea: esto es lo único
    // que impide acumular corazones sobre ids inventados.
    const fan = await nuevoUsuario();
    const r = await call('POST', '/api/v1/products/prd_00000000000000000000000000/like', {
      token: fan.token,
    });
    expect(r.status).toBe(400);
  });

  it('⛔ ni a un producto pausado', async () => {
    const vendedor = await nuevoVendedor();
    const productId = await productoPublicado(vendedor);
    await call('PATCH', `/api/v1/products/${productId}`, {
      token: vendedor.token,
      body: { status: 'PAUSED' },
    });

    const fan = await nuevoUsuario();
    const r = await call('POST', `/api/v1/products/${productId}/like`, { token: fan.token });
    expect(r.status).toBe(400);
  });

  it('sin sesión se ve el total pero no el propio', async () => {
    // Alguien que todavía no se registró tiene que poder ver cuántos me gusta
    // tiene un producto: es parte de decidir si comprar.
    const vendedor = await nuevoVendedor();
    const productId = await productoPublicado(vendedor);
    const fan = await nuevoUsuario();
    await call('POST', `/api/v1/products/${productId}/like`, { token: fan.token });

    const anonimo = await call('GET', `/api/v1/products/${productId}/like`);
    expect(anonimo.status, JSON.stringify(anonimo.body)).toBe(200);
    expect(anonimo.body.total).toBe(1);
    expect(anonimo.body.meGusta).toBe(false);

    const conSesion = await call('GET', `/api/v1/products/${productId}/like`, {
      token: fan.token,
    });
    expect(conSesion.body.meGusta).toBe(true);
  });

  it('el me gusta de una persona no afecta al de otra', async () => {
    const vendedor = await nuevoVendedor();
    const productId = await productoPublicado(vendedor);
    const uno = await nuevoUsuario();
    const dos = await nuevoUsuario();
    const url = `/api/v1/products/${productId}/like`;

    await call('POST', url, { token: uno.token });
    await call('POST', url, { token: dos.token });
    await call('POST', url, { token: uno.token });

    const deDos = await call('GET', url, { token: dos.token });
    expect(deDos.body.meGusta).toBe(true);
    expect(deDos.body.total).toBe(1);
  });
});

describe('Compartir', () => {
  it('el enlace de un producto lleva el precio', async () => {
    const vendedor = await nuevoVendedor();
    n += 1;
    const p = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: 'Buzo oversize',
        slug: `buzo-compartir-${n}-${Date.now().toString(36)}`,
        basePriceCents: 890_000,
        status: 'ACTIVE',
      },
    });

    const r = await call('GET', `/api/v1/share/product/${p.body.id}`);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.url).toContain(`/p/${p.body.id}`);
    expect(r.body.texto).toContain('Buzo oversize');
    expect(r.body.texto).toContain('$8.900');
    // La URL va última: es lo que hace que WhatsApp previsualice.
    expect((r.body.texto as string).endsWith(r.body.url as string)).toBe(true);
  });

  it('es público: compartir es cómo llega gente sin la app', async () => {
    const vendedor = await nuevoVendedor();
    const tienda = await prisma.store.findFirstOrThrow({
      where: { seller: { id: vendedor.sellerId } },
    });

    const r = await call('GET', `/api/v1/share/store/${tienda.slug}`);
    expect(r.status).toBe(200);
    expect(r.body.texto).toContain('Mirá lo que vende');
  });

  it('⛔ un tipo que no se puede compartir se rechaza', async () => {
    const r = await call('GET', '/api/v1/share/usuario/algo');
    expect(r.status).toBe(400);
  });

  it('compartir algo que no existe da error, no un enlace roto', async () => {
    // Un enlace generado sobre un id inventado se comparte igual y no funciona
    // para nadie.
    const r = await call('GET', '/api/v1/share/product/prd_00000000000000000000000000');
    expect(r.status).toBe(400);
  });
});
