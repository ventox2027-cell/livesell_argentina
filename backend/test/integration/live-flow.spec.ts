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
