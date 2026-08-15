import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtService } from '@/modules/auth/jwt.service';
import type { ExpirationQueue } from '@/modules/inventory/expiration.queue';
import type { InventoryService } from '@/modules/inventory/inventory.service';
import type { InventoryReconciler } from '@/modules/inventory/reconciler.service';
import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';
import { datosDeAdulto } from '../helpers/edad';

/**
 * Inventario y reservas contra PostgreSQL REAL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE ARCHIVO NO PUEDE USAR UNA BASE SIMULADA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que se prueba acá no es lógica de TypeScript: es que **PostgreSQL
 * serializa cien escrituras sobre la misma fila y sólo dos pasan**. Un mock
 * pasaría estos tests con el código más roto imaginable, porque el mock no
 * tiene bloqueos de fila ni restricciones CHECK.
 *
 * El test de los 100 compradores es bloqueante: si se pone en rojo, hay
 * sobreventa. No hay forma de que sea un falso positivo.
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

  /**
   * El reloj lo maneja el test, no el sistema.
   *
   * El reconciliador y la cola se apagan para que ningún barrido de fondo
   * venza una reserva a mitad de una comprobación. Los dos se ejercitan
   * llamándolos explícitamente, que además hace que el test diga QUÉ está
   * probando en vez de esperar a ver qué pasa.
   *
   * Apagar la cola tiene un segundo propósito: **todo este archivo corre como
   * si Redis no existiera para los jobs diferidos**. Que pase entero es la
   * demostración de que una caída de Redis no impide vender.
   */
  INVENTORY_RECONCILER_ENABLED: 'false',
  INVENTORY_EXPIRATION_QUEUE_ENABLED: 'false',
  INVENTORY_RESERVATION_TTL_SECONDS: '300',
  INVENTORY_MAX_QUANTITY_PER_RESERVATION: '10',
};

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let jwt: JwtService;
let inventory: InventoryService;
let reconciler: InventoryReconciler;
let expirationQueue: ExpirationQueue;

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { JwtService } = await import('@/modules/auth/jwt.service');
  const { ExpirationQueue } = await import('@/modules/inventory/expiration.queue');
  const { InventoryService } = await import('@/modules/inventory/inventory.service');
  const { InventoryReconciler } = await import('@/modules/inventory/reconciler.service');
  const { PrismaService } = await import('@/shared/prisma/prisma.service');
  const { RedisService } = await import('@/shared/redis/redis.service');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({ wsUrl: '', ensureRoom: vi.fn(), issueToken: vi.fn(), verifyWebhook: vi.fn() })
    .compile();

  app = await crearAppDePrueba(moduleRef);

  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  jwt = app.get(JwtService);
  inventory = app.get(InventoryService);
  reconciler = app.get(InventoryReconciler);
  expirationQueue = app.get(ExpirationQueue);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Los tests de integración borran datos y sólo corren contra una base *_test');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE audit_logs, inventory_reservations, inventory, product_variant_options, ' +
      'product_images, product_variants, product_option_values, product_options, products, ' +
      'stores, sellers, auth_events, refresh_tokens, devices, user_identities, users CASCADE',
  );
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  const claves = await redis.client.keys('rl:*');
  if (claves.length > 0) await redis.client.del(...claves);
});

// ─── Utilidades ─────────────────────────────────────────────────────────────

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

/**
 * Crea un usuario y le emite un token, sin pasar por `/auth/dev`.
 *
 * El login de desarrollo tiene límite de 30 por minuto y por IP. Los tests de
 * concurrencia necesitan cien usuarios: pasando por el endpoint, setenta se
 * llevarían un 429 y estaríamos midiendo el rate limit en vez del inventario.
 *
 * El guard sólo pide una firma válida y un usuario activo en la base, así que
 * esto produce exactamente lo mismo que un login real.
 */
async function nuevoComprador(): Promise<{ token: string; userId: string }> {
  n += 1;
  const userId = `usr_test${String(n).padStart(20, '0')}`;

  await prisma.user.create({
    data: {
      id: userId,
      firstName: 'Comprador',
      lastName: `${n}`,
      email: `inv-${n}-${Date.now()}@test.com`,
      emailVerified: true,
      role: 'buyer',
      // VendoX es 18+ y el backend lo exige antes de comprar. Ver helpers/edad.
      ...datosDeAdulto(),
    },
  });

  const { accessToken } = await jwt.issueAccessToken({
    userId,
    role: 'buyer',
    sessionId: `ses_test${String(n).padStart(19, '0')}`,
  });

  return { token: accessToken, userId };
}

/** Vendedor con tienda, producto publicado y una variante con stock. */
async function nuevaVarianteConStock(onHand: number) {
  const { token, userId } = await nuevoComprador();

  const seller = await call('POST', '/api/v1/sellers', {
    token,
    body: { displayName: `Vendedor inv ${n}` },
  });
  expect(seller.status, JSON.stringify(seller.body)).toBe(201);

  const producto = await call('POST', '/api/v1/products', {
    token,
    body: { name: `Producto inv ${n}`, basePriceCents: 1_000_000, status: 'ACTIVE', categoryId: 'cat_otros' },
  });
  expect(producto.status, JSON.stringify(producto.body)).toBe(201);

  const variantId = producto.body.variants[0].id as string;

  await prisma.inventory.update({
    where: { productVariantId: variantId },
    data: { onHand },
  });

  return {
    sellerToken: token,
    sellerUserId: userId,
    productId: producto.body.id as string,
    variantId,
    storeId: producto.body.storeId as string,
  };
}

async function leerInventario(variantId: string) {
  const inv = await prisma.inventory.findUniqueOrThrow({
    where: { productVariantId: variantId },
  });
  return { onHand: inv.onHand, reserved: inv.reserved, available: inv.onHand - inv.reserved };
}

function clave(sufijo: string | number): string {
  return `idem-${sufijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function reservar(
  token: string,
  variantId: string,
  opciones: { quantity?: number; idempotencyKey?: string } = {},
) {
  return call('POST', '/api/v1/inventory/reservations', {
    token,
    idempotencyKey: opciones.idempotencyKey ?? clave('r'),
    body: { productVariantId: variantId, quantity: opciones.quantity ?? 1 },
  });
}

// ═══════════════════════════════════════════════════════════════════════════

describe('Toda variante nace con inventario', () => {
  it('un producto simple crea la fila de inventario de su variante DEFAULT', async () => {
    // Es el invariante del que cuelga todo: si una variante pudiera existir sin
    // inventario, el camino de compra tendría que crear filas — escribir en el
    // punto más caliente del sistema para poder leer.
    const { variantId } = await nuevaVarianteConStock(0);
    const inv = await prisma.inventory.findUnique({ where: { productVariantId: variantId } });
    expect(inv).not.toBeNull();
    expect(inv!.onHand).toBe(0);
    expect(inv!.reserved).toBe(0);
  });

  it('un producto con opciones crea una fila por combinación', async () => {
    const { token } = await nuevoComprador();
    await call('POST', '/api/v1/sellers', { token, body: { displayName: `Vend opts ${n}` } });

    const p = await call('POST', '/api/v1/products', {
      token,
      body: {
        name: `Con variantes ${n}`,
        basePriceCents: 1_000_000,
        options: [
          { name: 'Color', values: ['Negro', 'Blanco'] },
          { name: 'Talle', values: ['S', 'M', 'L'] },
        ],
      },
    });
    expect(p.status).toBe(201);
    expect(p.body.variants).toHaveLength(6);

    const filas = await prisma.inventory.count({
      where: { productVariantId: { in: p.body.variants.map((v: { id: string }) => v.id) } },
    });
    expect(filas).toBe(6);
  });
});

describe('⛔ EL TEST QUE NO PUEDE FALLAR — 100 compradores, 2 unidades', () => {
  it('exactamente 2 reservan y 98 reciben OUT_OF_STOCK', async () => {
    /**
     * Esta es la prueba del módulo entero.
     *
     * Cien peticiones simultáneas contra dos unidades. Si el código leyera el
     * stock, decidiera y después escribiera, las cien leerían "hay 2" y las
     * cien pasarían. Lo único que lo impide es que la condición viva DENTRO
     * del UPDATE:
     *
     *     WHERE id = $1 AND (on_hand - reserved) >= $qty
     *
     * PostgreSQL serializa las escrituras sobre la fila: la tercera petición
     * evalúa el WHERE contra el valor que dejaron las dos primeras, no contra
     * el que leyó al empezar.
     *
     * Cien compradores DISTINTOS a propósito. Con uno solo repitiendo, el
     * índice único parcial colapsaría las cien en una y estaríamos probando la
     * idempotencia, no la contención por stock.
     */
    const { variantId } = await nuevaVarianteConStock(2);

    const compradores = await Promise.all(
      Array.from({ length: 100 }, () => nuevoComprador()),
    );

    // Sin `await` entre medio: se lanzan las cien y recién después se espera.
    const respuestas = await Promise.all(
      compradores.map((c, i) =>
        reservar(c.token, variantId, { idempotencyKey: clave(`cien-${i}`) }),
      ),
    );

    const exitosas = respuestas.filter((r) => r.status === 201);
    const sinStock = respuestas.filter((r) => r.body?.error?.code === 'OUT_OF_STOCK');
    const otras = respuestas.filter(
      (r) => r.status !== 201 && r.body?.error?.code !== 'OUT_OF_STOCK',
    );

    expect(otras.map((r) => JSON.stringify(r.body))).toEqual([]);
    expect(exitosas).toHaveLength(2);
    expect(sinStock).toHaveLength(98);

    // La base tiene la última palabra.
    const inv = await leerInventario(variantId);
    expect(inv.onHand).toBe(2);
    expect(inv.reserved).toBe(2);
    expect(inv.available).toBe(0);

    const activas = await prisma.inventoryReservation.count({
      where: { productVariantId: variantId, status: 'ACTIVE' },
    });
    expect(activas).toBe(2);
  }, 60_000);

  it('con cantidades mixtas tampoco se pasa', async () => {
    // 5 unidades y peticiones de 1, 2 y 3: la suma de lo reservado nunca puede
    // superar 5, sin importar en qué orden entren.
    const { variantId } = await nuevaVarianteConStock(5);

    const compradores = await Promise.all(Array.from({ length: 30 }, () => nuevoComprador()));

    const respuestas = await Promise.all(
      compradores.map((c, i) =>
        reservar(c.token, variantId, {
          quantity: (i % 3) + 1,
          idempotencyKey: clave(`mix-${i}`),
        }),
      ),
    );

    const reservado = respuestas
      .filter((r) => r.status === 201)
      .reduce((suma, r) => suma + (r.body.quantity as number), 0);

    const inv = await leerInventario(variantId);
    expect(inv.reserved).toBe(reservado);
    expect(inv.reserved).toBeLessThanOrEqual(5);
    expect(inv.available).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

describe('⛔ Idempotencia', () => {
  it('20 peticiones simultáneas con la MISMA clave crean UNA sola reserva', async () => {
    /**
     * El caso real: la persona toca "Comprar" en el subte. La petición llega,
     * el backend aparta la unidad, y la respuesta se pierde. La app cree que
     * falló y reintenta con la misma clave.
     *
     * Sin idempotencia, cada reintento aparta otra unidad y el stock se evapora
     * en zonas con mala señal — un síntoma casi imposible de diagnosticar
     * después.
     */
    const { variantId } = await nuevaVarianteConStock(1);
    const { token } = await nuevoComprador();
    const laClave = clave('misma');

    const respuestas = await Promise.all(
      Array.from({ length: 20 }, () =>
        reservar(token, variantId, { idempotencyKey: laClave }),
      ),
    );

    const ok = respuestas.filter((r) => r.status === 201 || r.status === 200);
    expect(ok.length).toBeGreaterThan(0);

    // Todas las que respondieron bien apuntan a la MISMA reserva.
    const ids = new Set(ok.map((r) => r.body.reservationId as string));
    expect(ids.size).toBe(1);

    const inv = await leerInventario(variantId);
    expect(inv.reserved).toBe(1);

    const filas = await prisma.inventoryReservation.count({
      where: { productVariantId: variantId },
    });
    expect(filas).toBe(1);
  }, 30_000);

  it('reintento secuencial devuelve la misma reserva sin apartar de nuevo', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const { token } = await nuevoComprador();
    const laClave = clave('secuencial');

    const primera = await reservar(token, variantId, { idempotencyKey: laClave, quantity: 2 });
    const segunda = await reservar(token, variantId, { idempotencyKey: laClave, quantity: 2 });

    expect(primera.body.reservationId).toBe(segunda.body.reservationId);
    expect((await leerInventario(variantId)).reserved).toBe(2);
  });

  it('⛔ la misma clave con OTRO cuerpo se rechaza', async () => {
    // Reusar la clave de otro intento es un bug del cliente. Devolverle la
    // reserva anterior en silencio le haría creer que reservó 5 cuando pidió 1.
    const { variantId } = await nuevaVarianteConStock(10);
    const { token } = await nuevoComprador();
    const laClave = clave('cuerpo-distinto');

    await reservar(token, variantId, { idempotencyKey: laClave, quantity: 1 });
    const distinta = await reservar(token, variantId, { idempotencyKey: laClave, quantity: 5 });

    expect(distinta.status).toBe(409);
    expect(distinta.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await leerInventario(variantId)).reserved).toBe(1);
  });

  it('⛔ sin cabecera Idempotency-Key no se reserva', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const { token } = await nuevoComprador();

    const r = await call('POST', '/api/v1/inventory/reservations', {
      token,
      body: { productVariantId: variantId, quantity: 1 },
    });

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await leerInventario(variantId)).reserved).toBe(0);
  });

  it('⛔ una clave basura se rechaza en vez de compartirse entre peticiones', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId, { idempotencyKey: 'x' });
    expect(r.status).toBe(400);
  });
});

describe('Una sola reserva activa por persona y variante', () => {
  it('tocar Comprar de nuevo reutiliza la reserva en vez de duplicarla', async () => {
    const { variantId } = await nuevaVarianteConStock(10);
    const { token } = await nuevoComprador();

    const primera = await reservar(token, variantId);
    const segunda = await reservar(token, variantId); // clave DISTINTA

    expect(segunda.status).toBe(201);
    expect(segunda.body.reservationId).toBe(primera.body.reservationId);
    expect(segunda.body.reused).toBe(true);
    expect((await leerInventario(variantId)).reserved).toBe(1);
  });

  it('⛔ la BASE lo impide aunque el código falle', async () => {
    /**
     * Este test no pasa por la aplicación: escribe directo contra PostgreSQL.
     *
     * Existe para que el índice único parcial no desaparezca sin que nadie se
     * entere. Prisma no sabe expresarlo y lo crea la migración a mano; si un
     * `prisma migrate dev` futuro propusiera borrarlo, esto se pone en rojo.
     */
    const { variantId } = await nuevaVarianteConStock(10);
    const { token, userId } = await nuevoComprador();

    const primera = await reservar(token, variantId);
    expect(primera.status).toBe(201);

    const inv = await prisma.inventory.findUniqueOrThrow({
      where: { productVariantId: variantId },
    });

    await expect(
      prisma.inventoryReservation.create({
        data: {
          id: `rsv_dup${String(n).padStart(19, '0')}`,
          inventoryId: inv.id,
          productVariantId: variantId,
          userId,
          quantity: 1,
          status: 'ACTIVE',
          idempotencyKey: clave('duplicada'),
          requestHash: 'x'.repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
  });

  it('después de cancelar sí puede reservar de nuevo', async () => {
    // La unicidad es sólo sobre las ACTIVE: una cancelada no tiene que
    // bloquear a la persona para siempre.
    const { variantId } = await nuevaVarianteConStock(10);
    const { token } = await nuevoComprador();

    const primera = await reservar(token, variantId);
    await call('DELETE', `/api/v1/inventory/reservations/${primera.body.reservationId}`, { token });

    const segunda = await reservar(token, variantId);
    expect(segunda.status).toBe(201);
    expect(segunda.body.reservationId).not.toBe(primera.body.reservationId);
    expect((await leerInventario(variantId)).reserved).toBe(1);
  });
});

describe('Expiración', () => {
  it('libera exactamente lo reservado y no toca onHand', async () => {
    const { variantId } = await nuevaVarianteConStock(1);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    expect((await leerInventario(variantId)).reserved).toBe(1);

    // Se envejece la reserva en vez de esperar cinco minutos. El vencimiento
    // se evalúa con `now()` de PostgreSQL, así que mover la fecha en la base
    // es equivalente a que haya pasado el tiempo.
    await prisma.inventoryReservation.update({
      where: { id: r.body.reservationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await inventory.expireIfDue(r.body.reservationId)).toBe(true);

    const inv = await leerInventario(variantId);
    expect(inv.onHand).toBe(1);
    expect(inv.reserved).toBe(0);
    expect(inv.available).toBe(1);
  });

  it('⛔ expirar dos veces no libera dos veces', async () => {
    // Es el caso de dos workers agarrando la misma reserva. La transición de
    // estado ES el candado: la segunda llamada afecta cero filas.
    const { variantId } = await nuevaVarianteConStock(2);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    await prisma.inventoryReservation.update({
      where: { id: r.body.reservationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await inventory.expireIfDue(r.body.reservationId)).toBe(true);
    expect(await inventory.expireIfDue(r.body.reservationId)).toBe(false);

    expect((await leerInventario(variantId)).reserved).toBe(0);
  });

  it('⛔ dos expiraciones SIMULTÁNEAS liberan una sola vez', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId, { quantity: 2 });
    await prisma.inventoryReservation.update({
      where: { id: r.body.reservationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const resultados = await Promise.all(
      Array.from({ length: 8 }, () => inventory.expireIfDue(r.body.reservationId)),
    );

    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect((await leerInventario(variantId)).reserved).toBe(0);
  });

  it('una reserva que todavía no venció no se toca', async () => {
    const { variantId } = await nuevaVarianteConStock(2);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    expect(await inventory.expireIfDue(r.body.reservationId)).toBe(false);
    expect((await leerInventario(variantId)).reserved).toBe(1);
  });

  it('el reconciliador barre las vencidas por lote', async () => {
    const { variantId } = await nuevaVarianteConStock(5);

    const compradores = await Promise.all(Array.from({ length: 3 }, () => nuevoComprador()));
    for (const c of compradores) {
      const r = await reservar(c.token, variantId);
      await prisma.inventoryReservation.update({
        where: { id: r.body.reservationId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
    }
    expect((await leerInventario(variantId)).reserved).toBe(3);

    const resultado = await reconciler.barrer();

    expect(resultado.vencidas).toBeGreaterThanOrEqual(3);
    expect((await leerInventario(variantId)).reserved).toBe(0);
  });

  it('una reserva vencida sin barrer no bloquea una nueva del mismo comprador', async () => {
    /**
     * El caso que rompería la experiencia: la reserva venció hace dos segundos
     * pero ni el job ni el reconciliador llegaron. Sin tratarlo, el índice
     * único parcial rechazaría la nueva —para él sigue habiendo una activa— y
     * el comprador recibiría de vuelta una reserva muerta con el contador en
     * 00:00.
     */
    const { variantId } = await nuevaVarianteConStock(4);
    const { token } = await nuevoComprador();

    const vieja = await reservar(token, variantId);
    await prisma.inventoryReservation.update({
      where: { id: vieja.body.reservationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const nueva = await reservar(token, variantId);

    expect(nueva.status).toBe(201);
    expect(nueva.body.reservationId).not.toBe(vieja.body.reservationId);
    expect(nueva.body.remainingSeconds).toBeGreaterThan(0);

    // La vieja quedó vencida y la nueva ocupa una sola unidad.
    const anterior = await prisma.inventoryReservation.findUniqueOrThrow({
      where: { id: vieja.body.reservationId },
    });
    expect(anterior.status).toBe('EXPIRED');
    expect((await leerInventario(variantId)).reserved).toBe(1);
  });
});

describe('Consumir', () => {
  it('descuenta de onHand Y de reserved: la unidad se vendió', async () => {
    /**
     *   antes:   onHand 3 · reserved 1 · disponibles 2
     *   consume 1
     *   después: onHand 2 · reserved 0 · disponibles 2
     *
     * Restar sólo de `reserved` daría 3 y 0: la unidad vendida volvería al
     * mostrador. Por eso `available` no se mueve.
     */
    const { variantId } = await nuevaVarianteConStock(3);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    const antes = await leerInventario(variantId);
    expect(antes).toEqual({ onHand: 3, reserved: 1, available: 2 });

    const resultado = await inventory.consume(r.body.reservationId);
    expect(resultado.status).toBe('CONSUMED');
    expect(resultado.changed).toBe(true);

    const despues = await leerInventario(variantId);
    expect(despues).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('⛔ consumir dos veces no descuenta dos veces', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    await inventory.consume(r.body.reservationId);
    const segunda = await inventory.consume(r.body.reservationId);

    expect(segunda.changed).toBe(false);
    expect(segunda.status).toBe('CONSUMED');
    expect(await leerInventario(variantId)).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('⛔ una reserva vencida NO se puede consumir', async () => {
    // EXPIRED → CONSUMED no es una transición válida. El stock ya volvió a
    // estar disponible y puede haberlo tomado otro.
    const { variantId } = await nuevaVarianteConStock(2);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    await prisma.inventoryReservation.update({
      where: { id: r.body.reservationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await inventory.expireIfDue(r.body.reservationId);

    const resultado = await inventory.consume(r.body.reservationId);
    expect(resultado.changed).toBe(false);
    expect(resultado.status).toBe('EXPIRED');
    expect(await leerInventario(variantId)).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('⛔ una reserva cancelada NO se puede consumir', async () => {
    const { variantId } = await nuevaVarianteConStock(2);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    await call('DELETE', `/api/v1/inventory/reservations/${r.body.reservationId}`, { token });

    const resultado = await inventory.consume(r.body.reservationId);
    expect(resultado.changed).toBe(false);
    expect(resultado.status).toBe('CANCELLED');
    expect(await leerInventario(variantId)).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });
});

describe('Cancelar', () => {
  it('libera reserved y deja onHand intacto', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    const cancel = await call(
      'DELETE',
      `/api/v1/inventory/reservations/${r.body.reservationId}`,
      { token },
    );

    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('CANCELLED');
    expect(await leerInventario(variantId)).toEqual({ onHand: 3, reserved: 0, available: 3 });
  });

  it('⛔ cancelar dos veces no libera dos veces', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    await call('DELETE', `/api/v1/inventory/reservations/${r.body.reservationId}`, { token });
    const segunda = await call(
      'DELETE',
      `/api/v1/inventory/reservations/${r.body.reservationId}`,
      { token },
    );

    expect(segunda.body.changed).toBe(false);
    expect(await leerInventario(variantId)).toEqual({ onHand: 3, reserved: 0, available: 3 });
  });

  it('⛔ ocho cancelaciones simultáneas liberan una sola vez', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId, { quantity: 3 });
    const respuestas = await Promise.all(
      Array.from({ length: 8 }, () =>
        call('DELETE', `/api/v1/inventory/reservations/${r.body.reservationId}`, { token }),
      ),
    );

    expect(respuestas.filter((x) => x.body?.changed === true)).toHaveLength(1);
    expect(await leerInventario(variantId)).toEqual({ onHand: 5, reserved: 0, available: 5 });
  });
});

describe('⛔ IDOR', () => {
  it('un comprador NO puede cancelar la reserva de otro', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const duenio = await nuevoComprador();
    const intruso = await nuevoComprador();

    const r = await reservar(duenio.token, variantId);
    const ajeno = await call(
      'DELETE',
      `/api/v1/inventory/reservations/${r.body.reservationId}`,
      { token: intruso.token },
    );

    // 404 y no 403: un 403 confirmaría que esa reserva existe.
    expect(ajeno.status).toBe(404);
    expect((await leerInventario(variantId)).reserved).toBe(1);
  });

  it('un comprador NO puede ver la reserva de otro', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const duenio = await nuevoComprador();
    const intruso = await nuevoComprador();

    const r = await reservar(duenio.token, variantId);
    const ajeno = await call(
      'GET',
      `/api/v1/inventory/reservations/${r.body.reservationId}`,
      { token: intruso.token },
    );

    expect(ajeno.status).toBe(404);
  });

  it('un vendedor NO puede tocar el stock de otro', async () => {
    const a = await nuevaVarianteConStock(10);
    const b = await nuevaVarianteConStock(10);

    const ajeno = await call(
      'PATCH',
      `/api/v1/products/${a.productId}/variants/${a.variantId}/inventory`,
      { token: b.sellerToken, body: { onHand: 999 } },
    );

    expect(ajeno.status).toBe(404);
    expect((await leerInventario(a.variantId)).onHand).toBe(10);
  });

  it('un vendedor NO puede leer el inventario de otro', async () => {
    const a = await nuevaVarianteConStock(7);
    const b = await nuevaVarianteConStock(7);

    const ajeno = await call('GET', `/api/v1/products/${a.productId}/inventory`, {
      token: b.sellerToken,
    });
    expect(ajeno.status).toBe(404);
  });

  it('⛔ ningún endpoint permite escribir `reserved`', async () => {
    // Poder ponerlo en cero permitiría "liberar" unidades que otro ya tiene
    // apartadas y venderlas dos veces.
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    await reservar(comprador.token, variantId, { quantity: 2 });

    const intento = await call(
      'PATCH',
      `/api/v1/products/${productId}/variants/${variantId}/inventory`,
      { token: sellerToken, body: { reserved: 0, onHand: 5 } },
    );

    expect(intento.status).toBe(200);
    // El campo se ignoró: `reserved` sigue siendo consecuencia de la reserva.
    expect((await leerInventario(variantId)).reserved).toBe(2);
  });
});

describe('El vendedor cambia el stock', () => {
  it('⛔ no puede bajarlo por debajo de lo ya reservado', async () => {
    /**
     * onHand 10 · reserved 8 → el vendedor pone 5.
     *
     * Aceptarlo dejaría ocho personas con una unidad apartada de un total de
     * cinco. Tres se quedan sin lo que ya creían tener.
     */
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(10);

    const compradores = await Promise.all(Array.from({ length: 8 }, () => nuevoComprador()));
    for (const c of compradores) await reservar(c.token, variantId);
    expect((await leerInventario(variantId)).reserved).toBe(8);

    const r = await call(
      'PATCH',
      `/api/v1/products/${productId}/variants/${variantId}/inventory`,
      { token: sellerToken, body: { onHand: 5 } },
    );

    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STOCK_BELOW_RESERVED');
    expect(r.body.error.details.minimo).toBe(8);
    expect((await leerInventario(variantId)).onHand).toBe(10);
  }, 30_000);

  it('puede bajarlo hasta exactamente lo reservado', async () => {
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(10);

    const compradores = await Promise.all(Array.from({ length: 8 }, () => nuevoComprador()));
    for (const c of compradores) await reservar(c.token, variantId);

    const r = await call(
      'PATCH',
      `/api/v1/products/${productId}/variants/${variantId}/inventory`,
      { token: sellerToken, body: { onHand: 8 } },
    );

    expect(r.status).toBe(200);
    expect(await leerInventario(variantId)).toEqual({ onHand: 8, reserved: 8, available: 0 });
  }, 30_000);

  it('puede subirlo siempre', async () => {
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(10);
    const comprador = await nuevoComprador();
    await reservar(comprador.token, variantId);

    const r = await call(
      'PATCH',
      `/api/v1/products/${productId}/variants/${variantId}/inventory`,
      { token: sellerToken, body: { onHand: 20 } },
    );

    expect(r.status).toBe(200);
    expect(await leerInventario(variantId)).toEqual({ onHand: 20, reserved: 1, available: 19 });
  });

  it('el ajuste incremental suma sobre el valor de la base', async () => {
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(47);

    const r = await call(
      'PATCH',
      `/api/v1/products/${productId}/variants/${variantId}/inventory`,
      { token: sellerToken, body: { adjust: 10, motivo: 'Entró mercadería' } },
    );

    expect(r.status).toBe(200);
    expect(r.body.onHand).toBe(57);
  });

  it('⛔ dos ajustes simultáneos NO se pisan', async () => {
    // Leer-sumar-escribir perdería uno de los dos. El delta se aplica dentro
    // del UPDATE, así que se aplican los dos.
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(100);

    await Promise.all(
      Array.from({ length: 10 }, () =>
        call('PATCH', `/api/v1/products/${productId}/variants/${variantId}/inventory`, {
          token: sellerToken,
          body: { adjust: 5 },
        }),
      ),
    );

    expect((await leerInventario(variantId)).onHand).toBe(150);
  }, 30_000);

  it('⛔ un ajuste negativo no puede dejar el stock por debajo de lo reservado', async () => {
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(5);
    const compradores = await Promise.all(Array.from({ length: 4 }, () => nuevoComprador()));
    for (const c of compradores) await reservar(c.token, variantId);

    const r = await call(
      'PATCH',
      `/api/v1/products/${productId}/variants/${variantId}/inventory`,
      { token: sellerToken, body: { adjust: -3 } },
    );

    expect(r.status).toBe(409);
    expect((await leerInventario(variantId)).onHand).toBe(5);
  });

  it('⛔ el stock nunca puede quedar negativo', async () => {
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(3);

    const r = await call(
      'PATCH',
      `/api/v1/products/${productId}/variants/${variantId}/inventory`,
      { token: sellerToken, body: { adjust: -10 } },
    );

    expect(r.status).toBe(409);
    expect((await leerInventario(variantId)).onHand).toBe(3);
  });
});

describe('⛔ Qué NO se puede reservar', () => {
  it('un producto en borrador', async () => {
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(5);
    await call('PATCH', `/api/v1/products/${productId}`, {
      token: sellerToken,
      body: { status: 'DRAFT' },
    });

    const comprador = await nuevoComprador();
    const r = await reservar(comprador.token, variantId);

    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NOT_PURCHASABLE');
    expect((await leerInventario(variantId)).reserved).toBe(0);
  });

  it('un producto pausado', async () => {
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(5);
    await call('PATCH', `/api/v1/products/${productId}`, {
      token: sellerToken,
      body: { status: 'PAUSED' },
    });

    const comprador = await nuevoComprador();
    expect((await reservar(comprador.token, variantId)).status).toBe(409);
  });

  it('un producto borrado', async () => {
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(5);
    await call('DELETE', `/api/v1/products/${productId}`, { token: sellerToken });

    const comprador = await nuevoComprador();
    const r = await reservar(comprador.token, variantId);
    // La variante también quedó borrada: no se distingue de una inexistente.
    expect([404, 409]).toContain(r.status);
  });

  it('una variante desactivada', async () => {
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(5);
    await call('PATCH', `/api/v1/products/${productId}/variants/${variantId}`, {
      token: sellerToken,
      body: { status: 'INACTIVE' },
    });

    const comprador = await nuevoComprador();
    const r = await reservar(comprador.token, variantId);
    expect(r.status).toBe(409);
    expect(r.body.error.details.motivo).toBe('variante_inactiva');
  });

  it('una tienda pausada', async () => {
    const { variantId, storeId, sellerToken } = await nuevaVarianteConStock(5);
    await call('PATCH', `/api/v1/stores/${storeId}`, {
      token: sellerToken,
      body: { status: 'PAUSED' },
    });

    const comprador = await nuevoComprador();
    const r = await reservar(comprador.token, variantId);
    expect(r.status).toBe(409);
    expect(r.body.error.details.motivo).toBe('tienda_pausada');
  });

  it('un vendedor suspendido', async () => {
    const { variantId, sellerUserId } = await nuevaVarianteConStock(5);
    await prisma.seller.update({
      where: { userId: sellerUserId },
      data: { status: 'SUSPENDED' },
    });

    const comprador = await nuevoComprador();
    const r = await reservar(comprador.token, variantId);
    expect(r.status).toBe(409);
    expect(r.body.error.details.motivo).toBe('vendedor_inactivo');
  });

  it('una variante sin stock cargado', async () => {
    const { variantId } = await nuevaVarianteConStock(0);
    const comprador = await nuevoComprador();

    const r = await reservar(comprador.token, variantId);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('OUT_OF_STOCK');
  });

  it('sin sesión', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const r = await call('POST', '/api/v1/inventory/reservations', {
      idempotencyKey: clave('anon'),
      body: { productVariantId: variantId, quantity: 1 },
    });
    expect(r.status).toBe(401);
  });
});

describe('Cantidades inválidas', () => {
  it.each([
    ['cero', 0],
    ['negativa', -1],
    ['decimal', 1.5],
    ['absurda', 999_999],
  ])('rechaza una cantidad %s', async (_nombre, quantity) => {
    const { variantId } = await nuevaVarianteConStock(5);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId, { quantity });
    expect(r.status).toBe(400);
    expect((await leerInventario(variantId)).reserved).toBe(0);
  });

  it('rechaza más unidades que el tope por reserva', async () => {
    const { variantId } = await nuevaVarianteConStock(100);
    const { token } = await nuevoComprador();

    expect((await reservar(token, variantId, { quantity: 11 })).status).toBe(400);
    expect((await reservar(token, variantId, { quantity: 10 })).status).toBe(201);
  });
});

describe('Disponibilidad pública', () => {
  it('no expone el stock exacto cuando hay de sobra', async () => {
    // Publicarlo le regala a la competencia el ritmo de ventas del vendedor:
    // consultando dos veces por día se saca cuánto vendió.
    const { variantId } = await nuevaVarianteConStock(50);

    const r = await call('GET', `/api/v1/variants/${variantId}/availability`);
    expect(r.status).toBe(200);
    expect(r.body.availability).toBe('IN_STOCK');
    expect(r.body.remaining).toBeNull();
  });

  it('sí dice cuántas quedan cuando quedan pocas', async () => {
    const { variantId } = await nuevaVarianteConStock(2);

    const r = await call('GET', `/api/v1/variants/${variantId}/availability`);
    expect(r.body.availability).toBe('LOW_STOCK');
    expect(r.body.remaining).toBe(2);
  });

  it('las reservas de otros cuentan como no disponible', async () => {
    const { variantId } = await nuevaVarianteConStock(1);
    const comprador = await nuevoComprador();
    await reservar(comprador.token, variantId);

    const r = await call('GET', `/api/v1/variants/${variantId}/availability`);
    expect(r.body.availability).toBe('OUT_OF_STOCK');
  });

  it('es pública: no hace falta sesión', async () => {
    const { variantId } = await nuevaVarianteConStock(10);
    const r = await call('GET', `/api/v1/variants/${variantId}/availability`);
    expect(r.status).toBe(200);
  });
});

describe('Redis caído', () => {
  it('se puede reservar igual', async () => {
    /**
     * Todo este archivo corre con `INVENTORY_EXPIRATION_QUEUE_ENABLED=false`,
     * o sea como si Redis no existiera para los jobs diferidos. Que las
     * reservas funcionen es la demostración: la fuente de verdad es
     * PostgreSQL y `expires_at` ya está ahí.
     *
     * Es preferible que una reserva quede apartada 30 segundos de más a que
     * una caída de Redis impida vender.
     */
    const { variantId } = await nuevaVarianteConStock(3);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    expect(r.status).toBe(201);
    expect((await leerInventario(variantId)).reserved).toBe(1);
  });

  it('programar la expiración NUNCA lanza', async () => {
    // Se llama después de que la reserva ya está cometida. Si lanzara, un
    // fallo de la cola desharía una venta que ya ocurrió.
    await expect(
      expirationQueue.programar('rsv_inexistente', new Date(Date.now() + 60_000)),
    ).resolves.toBeUndefined();
  });

  it('el reconciliador vence lo que la cola no pudo', async () => {
    const { variantId } = await nuevaVarianteConStock(2);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    await prisma.inventoryReservation.update({
      where: { id: r.body.reservationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await reconciler.barrer();
    expect((await leerInventario(variantId)).reserved).toBe(0);
  });
});

describe('Auditoría', () => {
  it('registra la reserva y el cambio de stock', async () => {
    const { variantId, productId, sellerToken } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();

    const r = await reservar(comprador.token, variantId);
    await call('PATCH', `/api/v1/products/${productId}/variants/${variantId}/inventory`, {
      token: sellerToken,
      body: { onHand: 8, motivo: 'Recuento' },
    });

    const acciones = await prisma.auditLog.findMany({
      where: { entityId: { in: [r.body.reservationId] } },
      select: { action: true },
    });
    expect(acciones.map((a) => a.action)).toContain('reservation.created');

    const stock = await prisma.auditLog.findFirst({
      where: { action: 'inventory.set' },
      orderBy: { createdAt: 'desc' },
    });
    expect(stock).not.toBeNull();
    expect((stock!.after as Record<string, unknown>).onHand).toBe(8);
    expect((stock!.after as Record<string, unknown>).motivo).toBe('Recuento');
  });
});

describe('⛔ Peticiones tal como las manda la app de verdad', () => {
  /**
   * ─── El test que faltaba, y lo que costó no tenerlo ───
   *
   * Dio deja `content-type: application/json` puesto como cabecera por defecto
   * de TODAS sus peticiones. Un DELETE sale entonces anunciando JSON y con cero
   * bytes de cuerpo, y Fastify responde:
   *
   *     400 · Body cannot be empty when content-type is set to 'application/json'
   *
   * Eso rompió los CUATRO DELETE de la aplicación al mismo tiempo —cancelar
   * una reserva, borrar un producto, borrar una foto, eliminar la cuenta— con
   * la suite entera en verde, porque el ayudante `call()` sólo manda
   * `content-type` cuando hay cuerpo.
   *
   * O sea: el servidor estaba muy bien probado contra un cliente que no era el
   * nuestro. Estos tests mandan la cabecera igual que la app.
   */
  async function comoLaApp(method: string, url: string, token: string) {
    const res = await (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as never,
        url,
        headers: {
          authorization: `Bearer ${token}`,
          // La cabecera que manda Dio aunque no haya cuerpo.
          'content-type': 'application/json',
        },
      });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  it('DELETE de una reserva con content-type y sin cuerpo', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const { token } = await nuevoComprador();
    const r = await reservar(token, variantId);

    const cancel = await comoLaApp(
      'DELETE',
      `/api/v1/inventory/reservations/${r.body.reservationId}`,
      token,
    );

    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.status).toBe('CANCELLED');
    expect((await leerInventario(variantId)).reserved).toBe(0);
  });

  it('DELETE de un producto con content-type y sin cuerpo', async () => {
    const { productId, sellerToken } = await nuevaVarianteConStock(1);

    const r = await comoLaApp('DELETE', `/api/v1/products/${productId}`, sellerToken);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('GET con content-type y sin cuerpo', async () => {
    // El mismo problema afectaría a cualquier GET que Dio mande con la
    // cabecera puesta.
    const { token } = await nuevoComprador();

    const r = await comoLaApp('GET', '/api/v1/inventory/reservations/mine', token);
    expect(r.status).toBe(200);
  });

  it('un POST con cuerpo sigue funcionando', async () => {
    // La contracara: quitar la cabecera cuando no hay cuerpo no puede romper
    // las peticiones que sí lo tienen.
    const { variantId } = await nuevaVarianteConStock(2);
    const { token } = await nuevoComprador();

    const r = await reservar(token, variantId);
    expect(r.status).toBe(201);
  });
});

describe('El feed refleja el stock', () => {
  it('trae la variante y su disponibilidad, sin el número exacto', async () => {
    // El botón "Comprar" del feed tiene que poder apartar stock de una variante
    // concreta sin una segunda consulta: pedirla después agregaría un viaje
    // justo cuando la persona ya decidió comprar.
    const { variantId } = await nuevaVarianteConStock(50);

    const r = await call('GET', '/api/v1/discover/products?limit=50');
    const item = r.body.items.find(
      (i: { variants: { id: string }[] }) => i.variants.some((v) => v.id === variantId),
    );

    expect(item).toBeDefined();
    const variante = item.variants.find((v: { id: string }) => v.id === variantId);
    expect(variante.availability).toBe('IN_STOCK');
    expect(variante.remaining).toBeNull();
    expect(variante.priceCents).toBeGreaterThan(0);
  });

  it('dice cuántas quedan cuando quedan pocas', async () => {
    const { variantId } = await nuevaVarianteConStock(2);

    const r = await call('GET', '/api/v1/discover/products?limit=50');
    const item = r.body.items.find(
      (i: { variants: { id: string }[] }) => i.variants.some((v) => v.id === variantId),
    );
    const variante = item.variants.find((v: { id: string }) => v.id === variantId);

    expect(variante.availability).toBe('LOW_STOCK');
    expect(variante.remaining).toBe(2);
  });

  it('una variante reservada por completo aparece agotada', async () => {
    const { variantId } = await nuevaVarianteConStock(1);
    const comprador = await nuevoComprador();
    await reservar(comprador.token, variantId);

    const r = await call('GET', '/api/v1/discover/products?limit=50');
    const item = r.body.items.find(
      (i: { variants: { id: string }[] }) => i.variants.some((v) => v.id === variantId),
    );
    const variante = item.variants.find((v: { id: string }) => v.id === variantId);

    expect(variante.availability).toBe('OUT_OF_STOCK');
    expect(variante.remaining).toBeNull();
  });

  it('⛔ el feed NUNCA expone onHand ni reserved', async () => {
    // Publicarlos le regala a la competencia el ritmo de ventas de un vendedor.
    const { variantId } = await nuevaVarianteConStock(137);

    const r = await call('GET', '/api/v1/discover/products?limit=50');

    // Se recorre la respuesta entera buscando las claves prohibidas, en vez de
    // buscar "137" como texto: ese número aparece como subcadena dentro de
    // cualquier ULID y el test fallaría según qué otros datos haya en la base.
    const prohibidas = new Set(['onHand', 'on_hand', 'reserved', 'inventory']);
    const encontradas: string[] = [];

    const recorrer = (valor: unknown, ruta: string): void => {
      if (Array.isArray(valor)) {
        valor.forEach((v, i) => recorrer(v, `${ruta}[${i}]`));
        return;
      }
      if (valor === null || typeof valor !== 'object') return;

      for (const [clave, v] of Object.entries(valor)) {
        if (prohibidas.has(clave)) encontradas.push(`${ruta}.${clave}`);
        recorrer(v, `${ruta}.${clave}`);
      }
    };
    recorrer(r.body, 'respuesta');

    expect(encontradas).toEqual([]);

    // Y lo que SÍ tiene que estar: la variante y su etiqueta.
    const item = r.body.items.find(
      (i: { variants: { id: string }[] }) => i.variants.some((v) => v.id === variantId),
    );
    expect(item.variants.find((v: { id: string }) => v.id === variantId).availability).toBe(
      'IN_STOCK',
    );
  });
});

describe('Mis reservas', () => {
  it('devuelve las activas con los segundos que faltan', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const { token } = await nuevoComprador();

    await reservar(token, variantId);
    const r = await call('GET', '/api/v1/inventory/reservations/mine', { token });

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].remainingSeconds).toBeGreaterThan(0);
    expect(r.body[0].remainingSeconds).toBeLessThanOrEqual(300);
  });

  it('no devuelve las de otros', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const uno = await nuevoComprador();
    const otro = await nuevoComprador();

    await reservar(uno.token, variantId);
    const r = await call('GET', '/api/v1/inventory/reservations/mine', { token: otro.token });

    expect(r.body).toHaveLength(0);
  });
});
