import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';
import { NACIMIENTO_ADULTO_ISO } from '../helpers/edad';

/**
 * Sesiones en vivo, contra PostgreSQL real.
 *
 * LiveKit va simulado: es un servicio externo, y probar que emite tokens es
 * probar su SDK. Lo que sí se prueba es todo lo nuestro — el ciclo de vida, la
 * pertenencia, y sobre todo **qué pasa con el comercio cuando el video falla**.
 */

const TEST_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://livesell:livesell@127.0.0.1:5433/livesell_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380/1',
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
      wsUrl: 'wss://test.livekit.cloud',
      ensureRoom: vi.fn().mockResolvedValue(undefined),
      deleteRoom: vi.fn().mockResolvedValue(undefined),
      listParticipants: vi.fn().mockResolvedValue([]),
      verifyWebhook: vi.fn(),
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
    .compile();

  app = await crearAppDePrueba(moduleRef);
  prisma = app.get(PrismaService);
  redis = app.get(RedisService);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Los tests de integración borran datos y sólo corren contra una base *_test');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE live_session_products, live_sessions, audit_logs, seller_verifications, ' +
      'order_items, payment_attempts, refunds, orders, inventory_reservations, inventory, ' +
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
      email: `live${n}@test.com`,
      firstName: 'Test',
      lastName: `Live${n}`,
      device: {
        installId: `install-live-${n}`,
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

async function nuevoVendedorConProducto() {
  const u = await nuevoUsuario();
  n += 1;

  const s = await call('POST', '/api/v1/sellers', {
    token: u.token,
    body: { displayName: `Vendedor live ${n}`, storeName: `Tienda live ${n}` },
  });
  expect(s.status, JSON.stringify(s.body)).toBe(201);

  const p = await call('POST', '/api/v1/products', {
    token: u.token,
    body: {
      name: `Producto live ${n}`,
      slug: `producto-live-${n}-${Date.now().toString(36)}`,
      description: 'Para el vivo',
      basePriceCents: 890000,
      status: 'ACTIVE',
      categoryId: 'cat_otros',
    },
  });
  expect(p.status, JSON.stringify(p.body)).toBe(201);

  /**
   * Un producto sin ejes de variación recibe UNA variante `DEFAULT`
   * automática: nunca hay un producto sin variantes. Se lee de la respuesta del
   * detalle en vez de asumirla.
   */
  const detalle = await call('GET', `/api/v1/products/${p.body.id}`, { token: u.token });
  const variantId = (detalle.body.variants as Array<{ id: string }>)[0]?.id;
  expect(variantId, 'el producto debería tener una variante por defecto').toBeTruthy();

  const inv = await call(
    'PATCH',
    `/api/v1/products/${p.body.id}/variants/${variantId}/inventory`,
    { token: u.token, body: { onHand: 10 } },
  );
  expect(inv.status, JSON.stringify(inv.body)).toBe(200);

  return {
    ...u,
    sellerId: s.body.seller.id as string,
    productId: p.body.id as string,
    variantId: variantId as string,
  };
}

describe('Vivo — ciclo de vida', () => {
  it('preparar NO sale al aire', async () => {
    /**
     * Tocar "Iniciar LIVE" no puede encender la cámara en público de una. En
     * SCHEDULED la sala ya existe y el token ya está emitido, así que salir al
     * aire después es instantáneo.
     */
    const v = await nuevoVendedorConProducto();

    const r = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Mi primer vivo', productIds: [v.productId] },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.estado).toBe('SCHEDULED');
    expect(r.body.video.token).toBeTruthy();
    expect(r.body.productos).toContain(v.productId);

    // Y no aparece en el feed de activos.
    const feed = await call('GET', '/api/v1/live');
    expect((feed.body as Array<{ id: string }>).map((s) => s.id)).not.toContain(r.body.id);
  });

  it('preparar dos veces devuelve el MISMO vivo', async () => {
    /**
     * Es lo que quiere alguien que cerró la app y volvió a entrar. Crear uno
     * nuevo partiría su audiencia entre dos salas y dejaría el stock repartido
     * sin que ninguna sepa de la otra.
     */
    const v = await nuevoVendedorConProducto();

    const uno = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo', productIds: [] },
    });
    const dos = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Otro título', productIds: [] },
    });

    expect(dos.body.id).toBe(uno.body.id);
  });

  it('el camino completo: preparar, iniciar, terminar', async () => {
    const v = await nuevoVendedorConProducto();

    const creado = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo completo', productIds: [v.productId] },
    });

    const iniciado = await call('POST', `/api/v1/live/${creado.body.id}/start`, {
      token: v.token,
    });
    expect(iniciado.status).toBe(201);

    const enFeed = await call('GET', '/api/v1/live');
    expect((enFeed.body as Array<{ id: string }>).map((s) => s.id)).toContain(creado.body.id);

    const terminado = await call('POST', `/api/v1/live/${creado.body.id}/end`, {
      token: v.token,
    });
    expect(terminado.status).toBe(201);
    expect(terminado.body.resumen).toBeDefined();
    expect(terminado.body.resumen.ordenes).toBe(0);

    const fueraDelFeed = await call('GET', '/api/v1/live');
    expect((fueraDelFeed.body as Array<{ id: string }>).map((s) => s.id)).not.toContain(
      creado.body.id,
    );
  });

  it('terminar dos veces es idempotente', async () => {
    const v = await nuevoVendedorConProducto();
    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo', productIds: [] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });
    await call('POST', `/api/v1/live/${c.body.id}/end`, { token: v.token });

    const segunda = await call('POST', `/api/v1/live/${c.body.id}/end`, { token: v.token });
    expect(segunda.status).toBe(201);
    expect(segunda.body.yaEstaba).toBe(true);
  });

  it('⛔ un vendedor suspendido no puede transmitir', async () => {
    /**
     * Una transmisión es la superficie más visible de la plataforma. Alguien
     * suspendido por estafar no puede tener una.
     */
    const v = await nuevoVendedorConProducto();
    await prisma.seller.update({ where: { id: v.sellerId }, data: { status: 'SUSPENDED' } });

    const r = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'No debería salir', productIds: [] },
    });
    expect(r.status).toBe(403);
  });

  it('⛔ sin ser vendedor no se puede transmitir', async () => {
    const u = await nuevoUsuario();
    const r = await call('POST', '/api/v1/live', {
      token: u.token,
      body: { title: 'Sin tienda', productIds: [] },
    });
    expect(r.status).toBe(404);
  });
});

describe('Vivo — pertenencia', () => {
  it('⛔ nadie puede terminar el vivo de otro', async () => {
    const dueño = await nuevoVendedorConProducto();
    const ajeno = await nuevoVendedorConProducto();

    const c = await call('POST', '/api/v1/live', {
      token: dueño.token,
      body: { title: 'Mi vivo', productIds: [] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: dueño.token });

    const r = await call('POST', `/api/v1/live/${c.body.id}/end`, { token: ajeno.token });
    // 404 y no 403: confirmar que existe le diría a quien prueba que acertó un
    // id ajeno.
    expect(r.status).toBe(404);

    const sigue = await prisma.liveSession.findUnique({ where: { id: c.body.id } });
    expect(sigue?.state).toBe('LIVE');
  });

  it('⛔ no se puede destacar el producto de otro vendedor', async () => {
    const dueño = await nuevoVendedorConProducto();
    const ajeno = await nuevoVendedorConProducto();

    const c = await call('POST', '/api/v1/live', {
      token: dueño.token,
      body: { title: 'Mi vivo', productIds: [] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: dueño.token });

    const r = await call('POST', `/api/v1/live/${c.body.id}/feature`, {
      token: dueño.token,
      body: { variantId: ajeno.variantId },
    });
    expect(r.status).toBe(404);
  });

  it('⛔ un producto ajeno no entra en la bandeja', async () => {
    const dueño = await nuevoVendedorConProducto();
    const ajeno = await nuevoVendedorConProducto();

    const c = await call('POST', '/api/v1/live', {
      token: dueño.token,
      body: { title: 'Vivo', productIds: [dueño.productId, ajeno.productId] },
    });

    expect(c.body.productos).toContain(dueño.productId);
    expect(c.body.productos).not.toContain(ajeno.productId);
  });
});

describe('Vivo — producto destacado', () => {
  it('destacar devuelve el producto con su stock', async () => {
    const v = await nuevoVendedorConProducto();
    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo', productIds: [v.productId] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });

    const r = await call('POST', `/api/v1/live/${c.body.id}/feature`, {
      token: v.token,
      body: { variantId: v.variantId },
    });
    expect(r.status).toBe(201);

    const espectador = await nuevoUsuario();
    const vista = await call('GET', `/api/v1/live/${c.body.id}`, { token: espectador.token });

    expect(vista.body.destacado.variantId).toBe(v.variantId);
    expect(vista.body.destacado.disponible).toBe(10);
    expect(vista.body.destacado.precioCentavos).toBe(890000);
  });

  it('⛔ la variante interna NO viaja como nombre al comprador', async () => {
    /**
     * En el esquema, `title` es `@default("Default")`.
     *
     * Un producto sin talles ni colores tiene una única variante con ese
     * título, y la tarjeta del producto destacado lo mostraba al lado del
     * precio: "Campera de lana · Default", en la cara de quien está por
     * comprar. Apareció probando en un teléfono real.
     *
     * La señal de que la variante es interna no es el texto —un vendedor podría
     * escribir esa palabra— sino que **no tenga valores de opción**: si no hay
     * nada que elegir, no hay nada que nombrar.
     */
    const v = await nuevoVendedorConProducto();
    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo', productIds: [v.productId] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });
    await call('POST', `/api/v1/live/${c.body.id}/feature`, {
      token: v.token,
      body: { variantId: v.variantId },
    });

    const espectador = await nuevoUsuario();
    const vista = await call('GET', `/api/v1/live/${c.body.id}`, { token: espectador.token });

    expect(vista.body.destacado.variante).toBeNull();
    expect(JSON.stringify(vista.body.destacado)).not.toContain('Default');
  });

  it('dejar de destacar devuelve null, no se rompe', async () => {
    // `null` significa "dejó de destacar", no "no hay producto". La app tiene
    // que poder ocultar el panel de compra sin adivinar.
    const v = await nuevoVendedorConProducto();
    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo', productIds: [v.productId] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });
    await call('POST', `/api/v1/live/${c.body.id}/feature`, {
      token: v.token,
      body: { variantId: v.variantId },
    });

    const r = await call('POST', `/api/v1/live/${c.body.id}/feature`, {
      token: v.token,
      body: { variantId: null },
    });
    expect(r.status).toBe(201);

    const espectador = await nuevoUsuario();
    const vista = await call('GET', `/api/v1/live/${c.body.id}`, { token: espectador.token });
    expect(vista.body.destacado).toBeNull();
  });

  it('cuenta cuántas veces se destacó cada producto', async () => {
    const v = await nuevoVendedorConProducto();
    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo', productIds: [v.productId] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });

    for (let i = 0; i < 3; i++) {
      await call('POST', `/api/v1/live/${c.body.id}/feature`, {
        token: v.token,
        body: { variantId: v.variantId },
      });
    }

    const fila = await prisma.liveSessionProduct.findFirst({
      where: { liveSessionId: c.body.id, productId: v.productId },
    });
    expect(fila?.featuredCount).toBe(3);
  });
});

describe('Vivo — el espectador', () => {
  it('recibe token de video sólo si el vivo está al aire', async () => {
    const v = await nuevoVendedorConProducto();
    const espectador = await nuevoUsuario();

    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo', productIds: [] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });

    const enVivo = await call('GET', `/api/v1/live/${c.body.id}`, { token: espectador.token });
    expect(enVivo.body.video.token).toBeTruthy();
  });

  it('⛔ un vivo TERMINADO conserva el contexto comercial y no da video', async () => {
    /**
     * La decisión de producto más importante del bloque.
     *
     * Cuando el video se corta, el espectador NO se queda con una pantalla
     * negra: sigue viendo al vendedor, la tienda y el producto. El momento de
     * más intención de compra suele ser justo cuando el vivo termina, y perder
     * el contexto ahí es perder la venta.
     */
    const v = await nuevoVendedorConProducto();
    const espectador = await nuevoUsuario();

    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo que termina', productIds: [v.productId] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });
    await call('POST', `/api/v1/live/${c.body.id}/feature`, {
      token: v.token,
      body: { variantId: v.variantId },
    });
    await call('POST', `/api/v1/live/${c.body.id}/end`, { token: v.token });

    const despues = await call('GET', `/api/v1/live/${c.body.id}`, { token: espectador.token });

    expect(despues.status).toBe(200);
    expect(despues.body.estado).toBe('ENDED');
    expect(despues.body.video).toBeNull();

    // Y todo lo comercial sigue ahí.
    expect(despues.body.vendedor.nombre).toBeTruthy();
    expect(despues.body.tienda.nombre).toBeTruthy();
    expect(despues.body.destacado.variantId).toBe(v.variantId);
    expect(despues.body.terminadoEl).toBeTruthy();
  });

  it('⛔ un vivo inexistente da 404, no 500', async () => {
    const u = await nuevoUsuario();
    const r = await call('GET', '/api/v1/live/liv_noexiste', { token: u.token });
    expect(r.status).toBe(404);
  });

  it('el feed de vivos es público', async () => {
    // Alguien que todavía no se registró tiene que poder ver qué hay en vivo.
    const r = await call('GET', '/api/v1/live');
    expect(r.status).toBe(200);
  });

  it('⛔ pero entrar a uno pide sesión: el token de video es una credencial', async () => {
    const v = await nuevoVendedorConProducto();
    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo', productIds: [] },
    });

    const r = await call('GET', `/api/v1/live/${c.body.id}`);
    expect(r.status).toBe(401);
  });
});

describe('Vivo — el comercio sobrevive a los problemas de video', () => {
  it('en RECONNECTING el vivo sigue siendo comprable', async () => {
    /**
     * Que al vendedor se le haya caído el wifi no invalida el stock. El
     * espectador sigue viendo el producto destacado con su precio y su
     * disponibilidad.
     */
    const v = await nuevoVendedorConProducto();
    const espectador = await nuevoUsuario();

    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo', productIds: [v.productId] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });
    await call('POST', `/api/v1/live/${c.body.id}/feature`, {
      token: v.token,
      body: { variantId: v.variantId },
    });

    await prisma.liveSession.update({
      where: { id: c.body.id },
      data: { state: 'RECONNECTING' },
    });

    const vista = await call('GET', `/api/v1/live/${c.body.id}`, { token: espectador.token });

    expect(vista.body.estado).toBe('RECONNECTING');
    expect(vista.body.destacado.disponible).toBe(10);
    // Y sigue dando token: el espectador se queda en la sala esperando que
    // vuelva, no lo echamos.
    expect(vista.body.video.token).toBeTruthy();
  });

  it('el resumen cuenta las órdenes hechas durante la transmisión', async () => {
    const v = await nuevoVendedorConProducto();
    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo', productIds: [v.productId] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });

    const r = await call('POST', `/api/v1/live/${c.body.id}/end`, { token: v.token });

    // Sin ventas en este test, pero el resumen existe y está calculado.
    expect(r.body.resumen.ordenes).toBe(0);
    expect(r.body.resumen.brutoCentavos).toBe(0);
    expect(r.body.resumen.duracionSegundos).toBeGreaterThanOrEqual(0);

    const guardado = await prisma.liveSession.findUnique({ where: { id: c.body.id } });
    expect(guardado?.totalOrders).toBe(0);
    expect(guardado?.endedAt).toBeTruthy();
  });
});

/**
 * El lado del que transmite.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTAS RUTAS EXISTEN PORQUE LA APP NO TENÍA CÓMO TRANSMITIR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El backend del vivo estaba completo del lado del espectador, pero para probar
 * una transmisión había que publicar video desde una PC con el cliente web de
 * LiveKit: la app no tenía pantalla de vendedor y al backend le faltaba lo que
 * esa pantalla necesita —el panel, la bandeja editable y la vuelta desde
 * `RECONNECTING`—.
 */
describe('Vivo — panel del vendedor', () => {
  async function vivoAlAire() {
    const v = await nuevoVendedorConProducto();
    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo del panel', productIds: [v.productId] },
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });
    return { ...v, liveId: c.body.id as string };
  }

  it('el panel trae bandeja, stock y ventas en una sola llamada', async () => {
    const v = await vivoAlAire();

    const r = await call('GET', `/api/v1/live/${v.liveId}/panel`, { token: v.token });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.estado).toBe('LIVE');
    expect(r.body.bandeja).toHaveLength(1);
    expect(r.body.bandeja[0].productId).toBe(v.productId);
    expect(r.body.bandeja[0].vendible).toBe(true);
    expect(r.body.bandeja[0].variantes[0].disponible).toBe(10);
    // Las ventas del vivo arrancan en cero, no en null: es un número real.
    expect(r.body.ventas).toEqual({ ordenes: 0, brutoCentavos: 0, unidades: 0 });
  });

  it('⛔ el panel de un vivo ajeno da 404', async () => {
    const v = await vivoAlAire();
    const otro = await nuevoVendedorConProducto();

    const r = await call('GET', `/api/v1/live/${v.liveId}/panel`, { token: otro.token });

    // 404 y no 403: confirmar que existe le diría a quien prueba que acertó.
    expect(r.status).toBe(404);
  });

  it('la variante interna llega sin etiqueta también en el panel', async () => {
    const v = await vivoAlAire();
    const r = await call('GET', `/api/v1/live/${v.liveId}/panel`, { token: v.token });

    expect(r.body.bandeja[0].variantes[0].etiqueta).toBeNull();
  });

  it('un producto pausado sigue en la bandeja pero marcado como no vendible', async () => {
    const v = await vivoAlAire();

    await call('PATCH', `/api/v1/products/${v.productId}`, {
      token: v.token,
      body: { status: 'PAUSED' },
    });

    const r = await call('GET', `/api/v1/live/${v.liveId}/panel`, { token: v.token });

    // Sacarlo de la lista dejaría al vendedor sin entender por qué desapareció
    // algo que él mismo preparó.
    expect(r.body.bandeja).toHaveLength(1);
    expect(r.body.bandeja[0].vendible).toBe(false);
  });

  it('⛔ NO se puede destacar un producto pausado', async () => {
    const v = await vivoAlAire();

    await call('PATCH', `/api/v1/products/${v.productId}`, {
      token: v.token,
      body: { status: 'PAUSED' },
    });

    const r = await call('POST', `/api/v1/live/${v.liveId}/feature`, {
      token: v.token,
      body: { variantId: v.variantId },
    });

    // Antes se podía: la tarjeta aparecía con su botón de comprar en la
    // pantalla de todo el mundo y la reserva lo rechazaba después.
    expect(r.status).toBe(404);
  });

  it('mine dice si hay un vivo abierto', async () => {
    const v = await vivoAlAire();

    const r = await call('GET', '/api/v1/live/mine', { token: v.token });

    // Si esta ruta se declarara después de `:id`, entraría por ahí con
    // id='mine' y devolvería 404 siempre.
    expect(r.status).toBe(200);
    expect(r.body.vivo.id).toBe(v.liveId);
    expect(r.body.vivo.estado).toBe('LIVE');
  });

  it('mine devuelve null cuando no hay ninguno', async () => {
    const v = await nuevoVendedorConProducto();
    const r = await call('GET', '/api/v1/live/mine', { token: v.token });

    expect(r.status).toBe(200);
    expect(r.body.vivo).toBeNull();
  });

  it('la bandeja se reemplaza entera y respeta el orden', async () => {
    const v = await vivoAlAire();

    const segundo = await call('POST', '/api/v1/products', {
      token: v.token,
      body: { name: `Segundo ${Date.now()}`, basePriceCents: 100000, status: 'ACTIVE', categoryId: 'cat_otros' },
    });

    const r = await call('PUT', `/api/v1/live/${v.liveId}/products`, {
      token: v.token,
      body: { productIds: [segundo.body.id, v.productId] },
    });
    expect(r.status).toBe(200);

    const panel = await call('GET', `/api/v1/live/${v.liveId}/panel`, { token: v.token });
    expect(panel.body.bandeja.map((b: { productId: string }) => b.productId)).toEqual([
      segundo.body.id,
      v.productId,
    ]);
  });

  it('⛔ un producto ajeno no entra en la bandeja', async () => {
    const v = await vivoAlAire();
    const otro = await nuevoVendedorConProducto();

    await call('PUT', `/api/v1/live/${v.liveId}/products`, {
      token: v.token,
      body: { productIds: [otro.productId, v.productId] },
    });

    const panel = await call('GET', `/api/v1/live/${v.liveId}/panel`, { token: v.token });
    const ids = panel.body.bandeja.map((b: { productId: string }) => b.productId);

    expect(ids).toEqual([v.productId]);
    expect(ids).not.toContain(otro.productId);
  });

  it('reanudar saca al vivo de RECONNECTING', async () => {
    const v = await vivoAlAire();

    // El vivo se marca reconectando como lo haría el webhook de LiveKit.
    await prisma.liveSession.update({
      where: { id: v.liveId },
      data: { state: 'RECONNECTING' },
    });

    const r = await call('POST', `/api/v1/live/${v.liveId}/resume`, { token: v.token });

    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('LIVE');

    const sesion = await prisma.liveSession.findUnique({ where: { id: v.liveId } });
    expect(sesion?.state).toBe('LIVE');
  });

  it('reanudar un vivo que ya está al aire no rompe', async () => {
    const v = await vivoAlAire();
    const r = await call('POST', `/api/v1/live/${v.liveId}/resume`, { token: v.token });

    // Idempotente: la app puede llamarlo al recuperar la conexión sin saber en
    // qué estado quedó.
    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('LIVE');
  });

  it('el resumen del cierre trae unidades y no inventa el pico', async () => {
    const v = await vivoAlAire();

    const r = await call('POST', `/api/v1/live/${v.liveId}/end`, { token: v.token });

    expect(r.status).toBe(201);
    expect(r.body.resumen.ordenes).toBe(0);
    expect(r.body.resumen.unidades).toBe(0);
    expect(r.body.resumen.brutoCentavos).toBe(0);
    expect(r.body.resumen.duracionSegundos).toBeGreaterThanOrEqual(0);
    // Sin espectadores no hubo pico. `null` es la respuesta honesta.
    expect(r.body.resumen.espectadoresPico).toBeNull();
  });
});

describe('Vivo — el precio que ve el comprador', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LA TARJETA Y EL COBRO SALEN DEL MISMO LUGAR
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * El cobro ya resolvía el precio de vivo (ver `orders-flow.spec.ts`). La
   * tarjeta no: mostraba el precio de lista. El comprador se enteraba del
   * descuento en el resumen de pago, que es el único momento en que un
   * descuento no sirve para nada.
   */

  /** Un vivo al aire con el producto destacado. */
  async function vivoConDestacado() {
    const v = await nuevoVendedorConProducto();
    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vivo', productIds: [v.productId] },
    });
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });
    await call('POST', `/api/v1/live/${c.body.id}/feature`, {
      token: v.token,
      body: { variantId: v.variantId },
    });
    return { ...v, liveId: c.body.id as string };
  }

  it('con descuento activo, la tarjeta muestra el precio de vivo y el tachado', async () => {
    const v = await vivoConDestacado();

    await call('PUT', `/api/v1/live/${v.liveId}/products/${v.productId}/price`, {
      token: v.token,
      body: { precioCentavos: 620_000 },
    });

    const espectador = await nuevoUsuario();
    const vista = await call('GET', `/api/v1/live/${v.liveId}`, { token: espectador.token });

    expect(vista.body.destacado.precioCentavos).toBe(620_000);
    expect(vista.body.destacado.hayDescuento).toBe(true);
    expect(vista.body.destacado.precioDeListaCentavos).toBe(890_000);
    expect(vista.body.destacado.porcentajeDescuento).toBe(30);
  });

  it('⛔ sin descuento, no viaja nada que la app pueda tachar', async () => {
    /**
     * `hayDescuento: false` es lo que la app mira. Si en cambio comparara los
     * dos números por su cuenta, cualquier producto tacharía su propio precio.
     */
    const v = await vivoConDestacado();

    const espectador = await nuevoUsuario();
    const vista = await call('GET', `/api/v1/live/${v.liveId}`, { token: espectador.token });

    expect(vista.body.destacado.precioCentavos).toBe(890_000);
    expect(vista.body.destacado.hayDescuento).toBe(false);
  });

  it('⛔ una oferta que todavía no empezó no se muestra como descuento', async () => {
    // El vendedor la deja programada. Hasta que arranque, la tarjeta dice el
    // precio de siempre — y el cobro también.
    const v = await vivoConDestacado();

    await call('PUT', `/api/v1/live/${v.liveId}/products/${v.productId}/price`, {
      token: v.token,
      body: {
        precioCentavos: 620_000,
        desde: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
    });

    const espectador = await nuevoUsuario();
    const vista = await call('GET', `/api/v1/live/${v.liveId}`, { token: espectador.token });

    expect(vista.body.destacado.precioCentavos).toBe(890_000);
    expect(vista.body.destacado.hayDescuento).toBe(false);
  });

  it('el panel del vendedor SÍ ve la oferta programada, para poder corregirla', async () => {
    /**
     * La única vista que no resuelve la ventana.
     *
     * Si el panel escondiera la oferta hasta que arranca, el vendedor no
     * tendría dónde ver que la cargó mal.
     */
    const v = await vivoConDestacado();
    const desde = new Date(Date.now() + 30 * 60_000);

    await call('PUT', `/api/v1/live/${v.liveId}/products/${v.productId}/price`, {
      token: v.token,
      body: { precioCentavos: 620_000, desde: desde.toISOString() },
    });

    const panel = await call('GET', `/api/v1/live/${v.liveId}/panel`, { token: v.token });
    const enBandeja = panel.body.bandeja.find(
      (b: { productId: string }) => b.productId === v.productId,
    );

    expect(enBandeja.precioDeVivoCentavos).toBe(620_000);
    // Cargada pero todavía no vigente: las dos cosas a la vez.
    expect(enBandeja.precioDeVivoActivo).toBe(false);
  });
});

describe('Bloquear a un vendedor lo saca del listado de vivos', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ESTE BLOQUE EXISTE PORQUE UN SABOTAJE NO ROMPIÓ NADA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `activos()` filtra los vivos de quien la persona bloqueó, y ese filtro
   * estaba sin probar: al quitarlo, los 36 tests de vivos seguían en verde.
   *
   * O sea que bloquear a alguien podía dejar de funcionar en el feed y nadie se
   * iba a enterar hasta que una persona bloqueada volviera a aparecer en la
   * pantalla de quien la bloqueó — que es exactamente el momento en que un
   * bloqueo tiene que haber funcionado.
   */

  /** Un vendedor con un vivo al aire. */
  async function vendedorTransmitiendo() {
    const v = await nuevoVendedorConProducto();
    const c = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vendiendo en vivo', productIds: [v.productId] },
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await call('POST', `/api/v1/live/${c.body.id}/start`, { token: v.token });

    return { ...v, liveId: c.body.id as string };
  }

  /** Los ids de los vivos que ve esta persona. */
  async function vivosQueVe(token: string): Promise<string[]> {
    const r = await call('GET', '/api/v1/live?limit=50', { token });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const items = (r.body.items ?? r.body) as Array<{ id: string }>;
    return items.map((i) => i.id);
  }

  it('⛔ el vivo de un vendedor bloqueado NO aparece', async () => {
    const vendedor = await vendedorTransmitiendo();
    const espectador = await nuevoUsuario();

    // Antes de bloquear, lo ve.
    expect(await vivosQueVe(espectador.token)).toContain(vendedor.liveId);

    const bloqueo = await call('POST', `/api/v1/blocks/seller/${vendedor.sellerId}`, {
      token: espectador.token,
      body: { reason: 'no quiero ver esta tienda' },
    });
    expect(bloqueo.status, JSON.stringify(bloqueo.body)).toBe(201);

    // Después, no.
    expect(await vivosQueVe(espectador.token)).not.toContain(vendedor.liveId);
  });

  it('⛔ el bloqueo es UNILATERAL: el bloqueado sigue viendo al otro', async () => {
    /**
     * Lo contrario permitiría hacerle desaparecer la tienda a alguien
     * bloqueándolo, que es una forma barata y silenciosa de sabotear a un
     * competidor.
     */
    const a = await vendedorTransmitiendo();
    const b = await vendedorTransmitiendo();

    await call('POST', `/api/v1/blocks/seller/${b.sellerId}`, {
      token: a.token,
      body: { reason: 'no quiero ver esta tienda' },
    });

    // A dejó de ver a B.
    expect(await vivosQueVe(a.token)).not.toContain(b.liveId);
    // Pero B sigue viendo a A.
    expect(await vivosQueVe(b.token)).toContain(a.liveId);
  });

  it('sin sesión, el listado no se filtra por nadie', async () => {
    // El feed se ve sin entrar. Sin `userId` no hay lista de bloqueados que
    // aplicar, y la consulta tiene que salir igual.
    const vendedor = await vendedorTransmitiendo();

    const r = await call('GET', '/api/v1/live?limit=50');
    expect(r.status).toBe(200);
    const items = (r.body.items ?? r.body) as Array<{ id: string }>;
    expect(items.map((i) => i.id)).toContain(vendedor.liveId);
  });

  it('desbloquear lo devuelve al listado', async () => {
    // Un bloqueo que no se puede deshacer es una decisión permanente tomada en
    // caliente. Ver `bloqueos.service.ts`.
    const vendedor = await vendedorTransmitiendo();
    const espectador = await nuevoUsuario();

    await call('POST', `/api/v1/blocks/seller/${vendedor.sellerId}`, {
      token: espectador.token,
      body: { reason: 'no quiero ver esta tienda' },
    });
    expect(await vivosQueVe(espectador.token)).not.toContain(vendedor.liveId);

    await call('DELETE', `/api/v1/blocks/seller/${vendedor.sellerId}`, { token: espectador.token });
    expect(await vivosQueVe(espectador.token)).toContain(vendedor.liveId);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SANCIONAR A UN VENDEDOR NO LE CORTABA LA TRANSMISIÓN
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * El bloqueo de arriba es de una persona a otra: «no me muestres esta
   * tienda». Esto es distinto — es la plataforma sacando a alguien.
   *
   * `cambiarEstadoVendedor` pausa las tiendas, pero `activos()` no miraba el
   * estado del vendedor. O sea: un vendedor bloqueado POR FRAUDE, en el
   * segundo siguiente a la sanción, seguía en el feed de todo el mundo,
   * vendiendo. La sanción le pausaba el catálogo y le dejaba el micrófono.
   *
   * El mismo agujero deja en el feed a quien cerró su cuenta mientras
   * transmitía, ahora con el cartel «Cuenta eliminada» encima.
   */
  async function sancionar(sellerId: string, estado: 'SUSPENDED' | 'BLOCKED') {
    const admin = await nuevoUsuario();
    await prisma.user.update({ where: { id: admin.userId }, data: { role: 'admin' } });
    const ruta = estado === 'SUSPENDED' ? 'suspend' : 'block';
    const r = await call('POST', `/api/v1/admin/sellers/${sellerId}/${ruta}`, {
      token: admin.token,
      body: { reason: 'sancionado durante la auditoría de preproducción' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }

  it('⛔ el vivo de un vendedor SUSPENDIDO desaparece del feed', async () => {
    const vendedor = await vendedorTransmitiendo();
    const espectador = await nuevoUsuario();

    expect(await vivosQueVe(espectador.token)).toContain(vendedor.liveId);

    await sancionar(vendedor.sellerId, 'SUSPENDED');

    expect(await vivosQueVe(espectador.token)).not.toContain(vendedor.liveId);
  });

  it('⛔ el de uno BLOQUEADO por fraude, también', async () => {
    const vendedor = await vendedorTransmitiendo();
    const espectador = await nuevoUsuario();

    await sancionar(vendedor.sellerId, 'BLOCKED');

    expect(await vivosQueVe(espectador.token)).not.toContain(vendedor.liveId);
  });

  it('⛔ y el de quien cerró su cuenta en medio del vivo', async () => {
    const vendedor = await vendedorTransmitiendo();
    const espectador = await nuevoUsuario();

    expect(
      (await call('DELETE', '/api/v1/auth/me', { token: vendedor.token })).status,
    ).toBe(200);

    expect(await vivosQueVe(espectador.token)).not.toContain(vendedor.liveId);
  });

  it('el vivo de un vendedor en regla sigue apareciendo', async () => {
    // El contrapeso: si el filtro nuevo fuera demasiado estricto —por ejemplo
    // exigiendo un estado que casi nadie tiene— vaciaría el feed y los tests
    // de arriba pasarían igual, porque todos afirman ausencias.
    const vendedor = await vendedorTransmitiendo();
    const espectador = await nuevoUsuario();

    expect(await vivosQueVe(espectador.token)).toContain(vendedor.liveId);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EL BOTÓN «TIENDA» DEL VIVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El recorrido completo, de punta a punta: entrar a un vivo, sacar del contexto
 * comercial el id de la tienda, y pedir con ese id el catálogo público.
 *
 * Cada pieza estaba probada por su lado —el contexto del vivo acá, el catálogo
 * en `tienda-flow`— y el recorrido entero, que es lo que la persona toca, no lo
 * probaba nadie. Un id que no encaja con el endpoint del otro lado no rompe
 * ningún test de esos, y en el teléfono se ve como un botón que no hace nada.
 */
describe('La tienda del vendedor, desde el vivo', () => {
  /** Deja un vivo al aire y devuelve lo que ve un espectador. */
  async function vivoAlAire() {
    const v = await nuevoVendedorConProducto();
    const espectador = await nuevoUsuario();

    const creado = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Vendiendo en vivo', productIds: [v.productId] },
    });
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);

    const alAire = await call('POST', `/api/v1/live/${creado.body.id}/start`, { token: v.token });
    expect(alAire.status, JSON.stringify(alAire.body)).toBe(201);

    const visto = await call('GET', `/api/v1/live/${creado.body.id}`, {
      token: espectador.token,
    });
    expect(visto.status, JSON.stringify(visto.body)).toBe(200);

    return { vendedor: v, espectador, liveId: creado.body.id as string, live: visto.body };
  }

  /**
   * ⛔ EL CONTEXTO DEL VIVO TRAE CON QUÉ ABRIR LA TIENDA.
   *
   * Sin `tienda.id`, la app no tiene a qué tienda ir: el botón queda con las
   * manos vacías y no puede hacer nada.
   */
  it('⛔ el vivo trae el id de la tienda del vendedor', async () => {
    const { live } = await vivoAlAire();

    expect(live.tienda).toBeTruthy();
    expect(live.tienda.id).toMatch(/^sto_/);
    expect(live.tienda.nombre).toBeTruthy();
  });

  /**
   * ⛔ Y ESE ID SIRVE PARA PEDIR EL CATÁLOGO.
   *
   * Es el test que ata las dos mitades. El endpoint del catálogo resuelve por
   * **id de tienda**; si algún día resolviera por slug —como hace la vidriera
   * pública— este recorrido devolvería 404 sin que nada más se entere.
   */
  it('⛔ con ese id se abre el catálogo, y trae los productos', async () => {
    const { live, espectador, vendedor } = await vivoAlAire();

    const catalogo = await call('GET', `/api/v1/stores/${live.tienda.id}/catalog?limit=20`, {
      token: espectador.token,
    });

    expect(catalogo.status, JSON.stringify(catalogo.body)).toBe(200);
    expect(catalogo.body.items.map((p: { id: string }) => p.id)).toContain(vendedor.productId);
  });

  /**
   * ⛔ LA TIENDA NO DEPENDE DE QUE EL VIVO SIGA AL AIRE.
   *
   * Es una vidriera permanente: existe antes del vivo y sigue existiendo
   * después. Si el catálogo se apagara al terminar la transmisión, quien
   * entrara por un enlace viejo vería una tienda vacía.
   */
  it('⛔ el catálogo sigue estando cuando el vivo termina', async () => {
    const { live, liveId, vendedor, espectador } = await vivoAlAire();

    const fin = await call('POST', `/api/v1/live/${liveId}/end`, { token: vendedor.token });
    expect([200, 201], JSON.stringify(fin.body)).toContain(fin.status);

    const catalogo = await call('GET', `/api/v1/stores/${live.tienda.id}/catalog?limit=20`, {
      token: espectador.token,
    });

    expect(catalogo.status).toBe(200);
    expect(catalogo.body.items.map((p: { id: string }) => p.id)).toContain(vendedor.productId);
  });

  /**
   * Un vendedor sin nada publicado devuelve una lista vacía, no un error.
   *
   * Es lo que deja a la app dibujar un estado vacío amigable en vez de la
   * pantalla de error técnico.
   */
  it('una tienda sin productos publicados devuelve vacío, no error', async () => {
    const v = await nuevoVendedorConProducto();
    const espectador = await nuevoUsuario();

    // Se pausa el único producto: la tienda queda sin nada que mostrar.
    const pausa = await call('PATCH', `/api/v1/products/${v.productId}`, {
      token: v.token,
      body: { status: 'PAUSED' },
    });
    expect(pausa.status, JSON.stringify(pausa.body)).toBe(200);

    const tienda = await call('GET', '/api/v1/stores/me', { token: v.token });
    const catalogo = await call('GET', `/api/v1/stores/${tienda.body.id}/catalog?limit=20`, {
      token: espectador.token,
    });

    expect(catalogo.status).toBe(200);
    expect(catalogo.body.items).toEqual([]);
  });

  /**
   * ⛔ Y EL PERFIL DEL VENDEDOR DICE SI ESTÁ TRANSMITIENDO.
   *
   * Es lo que permite mostrar «EN VIVO» en la tienda y ofrecer volver a la
   * transmisión. Sin este dato, alguien que llega a la tienda desde otro lado
   * no se entera de que el vendedor está al aire en ese momento.
   */
  it('⛔ el perfil del vendedor avisa que hay un vivo, y cuál', async () => {
    const { vendedor, espectador, liveId } = await vivoAlAire();

    const perfil = await call('GET', `/api/v1/sellers/${vendedor.sellerId}/profile`, {
      token: espectador.token,
    });

    expect(perfil.status, JSON.stringify(perfil.body)).toBe(200);
    expect(perfil.body.enVivo).toBeTruthy();
    expect(perfil.body.enVivo.id).toBe(liveId);
  });

  it('y cuando no transmite, no lo dice', async () => {
    const { vendedor, espectador, liveId } = await vivoAlAire();
    await call('POST', `/api/v1/live/${liveId}/end`, { token: vendedor.token });

    const perfil = await call('GET', `/api/v1/sellers/${vendedor.sellerId}/profile`, {
      token: espectador.token,
    });

    expect(perfil.body.enVivo ?? null).toBeNull();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `vendox.com.ar/t/<slug>` — RESOLVER EL SLUG
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Los enlaces que se comparten llevan el slug; el catálogo y el horario
 * resuelven por id. Este endpoint traduce, y de paso decide si esa tienda se
 * puede mostrar.
 */
describe('La tienda por su slug', () => {
  /** El slug que le tocó a la tienda de este vendedor. */
  async function slugDeSuTienda(token: string): Promise<string> {
    const tienda = await call('GET', '/api/v1/stores/me', { token });
    expect(tienda.status, JSON.stringify(tienda.body)).toBe(200);
    return tienda.body.slug as string;
  }

  it('un slug válido devuelve la tienda', async () => {
    const v = await nuevoVendedorConProducto();
    const slug = await slugDeSuTienda(v.token);

    const r = await call('GET', `/api/v1/stores/by-slug/${slug}`);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.slug).toBe(slug);
    expect(r.body.id).toMatch(/^sto_/);
    expect(r.body.name).toBeTruthy();
    expect(r.body.seller.id).toBe(v.sellerId);
  });

  /**
   * ⛔ Y ESE ID SIRVE PARA EL CATÁLOGO.
   *
   * Es lo que ata el enlace compartido con la pantalla de tienda: el mismo
   * camino que ya usa quien la abre desde un vivo. Sin esto, resolver el slug
   * no serviría de nada.
   */
  it('⛔ el id que devuelve abre el catálogo', async () => {
    const v = await nuevoVendedorConProducto();
    const slug = await slugDeSuTienda(v.token);

    const tienda = await call('GET', `/api/v1/stores/by-slug/${slug}`);
    const catalogo = await call('GET', `/api/v1/stores/${tienda.body.id}/catalog?limit=20`);

    expect(catalogo.status, JSON.stringify(catalogo.body)).toBe(200);
    expect(catalogo.body.items.map((p: { id: string }) => p.id)).toContain(v.productId);
  });

  /**
   * ⛔ UN SLUG QUE NO EXISTE ES 404, NO 500 NI UNA TIENDA CUALQUIERA.
   *
   * Pasa con un enlace viejo o mal copiado. La app dibuja «no encontramos esta
   * tienda» con esto; un 500 la mandaría a la pantalla de error técnico.
   */
  it('⛔ un slug inexistente da 404', async () => {
    const r = await call('GET', '/api/v1/stores/by-slug/esta-tienda-no-existe-jamas');

    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('STORE_NOT_FOUND');
  });

  /** Sin sesión también: un enlace compartido lo abre cualquiera. */
  it('se puede abrir sin cuenta', async () => {
    const v = await nuevoVendedorConProducto();
    const slug = await slugDeSuTienda(v.token);

    expect((await call('GET', `/api/v1/stores/by-slug/${slug}`)).status).toBe(200);
  });

  /**
   * ⛔ UN VENDEDOR SUSPENDIDO NO TIENE VIDRIERA.
   *
   * Es la razón por la que esto vive en el servidor y no en la app. Si la app
   * resolviera el slug por su cuenta, o si acá se devolviera cualquier tienda,
   * bastaría con tener el enlace guardado para seguir viendo —y comprando— lo
   * de alguien suspendido.
   */
  it('⛔ la tienda de un vendedor suspendido no se resuelve', async () => {
    const v = await nuevoVendedorConProducto();
    const slug = await slugDeSuTienda(v.token);

    await prisma.seller.update({
      where: { id: v.sellerId },
      data: { status: 'SUSPENDED' },
    });

    const r = await call('GET', `/api/v1/stores/by-slug/${slug}`);

    expect(r.status).toBe(404);
  });

  /**
   * ⛔ Y DICE SI ESTÁ TRANSMITIENDO, PARA MOSTRAR «EN VIVO».
   *
   * Quien llega por un enlace no sabe si hay alguien mostrando esto ahora
   * mismo, y es lo primero que le sirve saber.
   */
  it('⛔ con el vendedor al aire, trae el vivo', async () => {
    const v = await nuevoVendedorConProducto();
    const slug = await slugDeSuTienda(v.token);

    const creado = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Al aire', productIds: [v.productId] },
    });
    await call('POST', `/api/v1/live/${creado.body.id}/start`, { token: v.token });

    const r = await call('GET', `/api/v1/stores/by-slug/${slug}`);

    expect(r.body.enVivo).toBeTruthy();
    expect(r.body.enVivo.id).toBe(creado.body.id);
  });

  /**
   * ⛔ Y CUANDO NO TRANSMITE, NO LO INVENTA.
   *
   * «EN VIVO» sobre un vendedor offline manda a la persona a buscar una
   * transmisión que no existe.
   */
  it('⛔ offline, enVivo viene en null', async () => {
    const v = await nuevoVendedorConProducto();
    const slug = await slugDeSuTienda(v.token);

    const r = await call('GET', `/api/v1/stores/by-slug/${slug}`);

    expect(r.body.enVivo).toBeNull();
  });

  /**
   * ⛔ Y AL TERMINAR EL VIVO, DEJA DE DECIRLO.
   *
   * La tienda es permanente; el vivo no. Un `enVivo` que quedara pegado
   * mandaría a la gente a una transmisión terminada.
   */
  it('⛔ terminado el vivo, vuelve a null', async () => {
    const v = await nuevoVendedorConProducto();
    const slug = await slugDeSuTienda(v.token);

    const creado = await call('POST', '/api/v1/live', {
      token: v.token,
      body: { title: 'Corto', productIds: [v.productId] },
    });
    await call('POST', `/api/v1/live/${creado.body.id}/start`, { token: v.token });
    await call('POST', `/api/v1/live/${creado.body.id}/end`, { token: v.token });

    const r = await call('GET', `/api/v1/stores/by-slug/${slug}`);

    expect(r.body.enVivo).toBeNull();
  });
});
