import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtService } from '@/modules/auth/jwt.service';
import type { InventoryService } from '@/modules/inventory/inventory.service';
import type { OrdersReconciler } from '@/modules/orders/reconciler.service';
import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';
import { ProveedorFalso } from '../helpers/proveedor-falso';

/**
 * Órdenes, cobros y devoluciones contra PostgreSQL REAL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCADO PAGO ES FALSO. LA BASE NO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El proveedor de pago se reemplaza por uno controlable: hace falta poder
 * decir "este cobro se aprueba", "este se rechaza" y —lo más importante—
 * "de este no vamos a saber nunca el resultado". Contra Mercado Pago real esos
 * escenarios no se pueden provocar a voluntad, y son justo los que rompen
 * sistemas.
 *
 * Todo lo demás es real: las transiciones, los índices únicos, los CHECK, la
 * concurrencia de PostgreSQL y el inventario. Lo que se prueba acá no es que
 * el código llame bien a una API: es que **no se pueda vender dos veces la
 * misma unidad ni quedarse con la plata de nadie**.
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
  MP_WEBHOOK_SECRET: 'secreto-de-webhook-para-tests',

  // El reloj lo maneja el test. Los barridos se invocan a mano para que cada
  // caso diga QUÉ está probando en vez de esperar a ver qué pasa.
  INVENTORY_RECONCILER_ENABLED: 'false',
  INVENTORY_EXPIRATION_QUEUE_ENABLED: 'false',
  ORDERS_RECONCILER_ENABLED: 'false',
  INVENTORY_RESERVATION_TTL_SECONDS: '300',
  VENDOX_PLATFORM_FEE_BPS: '600',
  ORDER_EXPIRATION_GRACE_SECONDS: '0',
};

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let jwt: JwtService;
let inventory: InventoryService;
let reconciler: OrdersReconciler;
let proveedor: ProveedorFalso;

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { JwtService } = await import('@/modules/auth/jwt.service');
  const { InventoryService } = await import('@/modules/inventory/inventory.service');
  const { PaymentProvider } = await import('@/modules/orders/payment-provider');
  const { OrdersReconciler } = await import('@/modules/orders/reconciler.service');
  const { PrismaService } = await import('@/shared/prisma/prisma.service');
  const { RedisService } = await import('@/shared/redis/redis.service');

  proveedor = new ProveedorFalso();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({ wsUrl: '', ensureRoom: vi.fn(), issueToken: vi.fn(), verifyWebhook: vi.fn() })
    .overrideProvider(PaymentProvider)
    .useValue(proveedor)
    .compile();

  app = await crearAppDePrueba(moduleRef);

  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  jwt = app.get(JwtService);
  inventory = app.get(InventoryService);
  reconciler = app.get(OrdersReconciler);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Los tests de integración borran datos y sólo corren contra una base *_test');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE mp_webhook_events, audit_logs, refunds, payment_attempts, order_items, orders, ' +
      'user_addresses, ' +
      'inventory_reservations, inventory, product_variant_options, product_images, ' +
      'product_variants, product_option_values, product_options, products, stores, ' +
      'seller_payment_accounts, sellers, auth_events, refresh_tokens, devices, ' +
      'user_identities, users CASCADE',
  );
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  proveedor.reiniciar();
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

async function nuevoUsuario(): Promise<{ token: string; userId: string }> {
  n += 1;
  const userId = `usr_ord${String(n).padStart(21, '0')}`;

  await prisma.user.create({
    data: {
      id: userId,
      firstName: 'Comprador',
      lastName: `${n}`,
      email: `ord-${n}-${Date.now()}@test.com`,
      emailVerified: true,
      role: 'buyer',
    },
  });

  const { accessToken } = await jwt.issueAccessToken({
    userId,
    role: 'buyer',
    sessionId: `ses_ord${String(n).padStart(20, '0')}`,
  });

  return { token: accessToken, userId };
}

/** Un comprador con dirección cargada, listo para comprar. */
async function nuevoComprador() {
  const usuario = await nuevoUsuario();
  const r = await call('POST', '/api/v1/addresses', {
    token: usuario.token,
    body: {
      recipientFullName: 'Ana Pérez',
      documentType: 'DNI',
      documentNumber: '30123456',
      phoneE164: '+5491122334455',
      street: 'Av. Corrientes',
      number: '1234',
      floor: '3',
      apartment: 'B',
      city: 'CABA',
      province: 'Buenos Aires',
      postalCode: 'C1043',
      references: 'Portón negro',
    },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return usuario;
}

/** Vendedor con producto publicado y stock. */
async function nuevaVarianteConStock(onHand: number) {
  const { token, userId } = await nuevoUsuario();

  const seller = await call('POST', '/api/v1/sellers', {
    token,
    body: { displayName: `Vendedor ord ${n}` },
  });
  expect(seller.status, JSON.stringify(seller.body)).toBe(201);

  const producto = await call('POST', '/api/v1/products', {
    token,
    body: { name: `Producto ord ${n}`, basePriceCents: 890_000, status: 'ACTIVE' },
  });
  expect(producto.status, JSON.stringify(producto.body)).toBe(201);

  const variantId = producto.body.variants[0].id as string;
  await prisma.inventory.update({ where: { productVariantId: variantId }, data: { onHand } });

  return {
    sellerToken: token,
    sellerUserId: userId,
    sellerId: seller.body.seller.id as string,
    productId: producto.body.id as string,
    variantId,
  };
}

function clave(sufijo: string | number): string {
  return `idem-${sufijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function reservar(token: string, variantId: string, quantity = 1) {
  const r = await call('POST', '/api/v1/inventory/reservations', {
    token,
    idempotencyKey: clave('r'),
    body: { productVariantId: variantId, quantity },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.reservationId as string;
}

async function crearOrden(token: string, reservationId: string) {
  return call('POST', '/api/v1/orders', {
    token,
    idempotencyKey: clave('o'),
    body: { reservationId },
  });
}

async function pagar(token: string, orderId: string, cardToken = `tok_${Math.random()}`) {
  return call('POST', `/api/v1/orders/${orderId}/payment-attempts`, {
    token,
    body: { cardToken, installments: 1, paymentMethodId: 'visa' },
  });
}

async function leerInventario(variantId: string) {
  const inv = await prisma.inventory.findUniqueOrThrow({
    where: { productVariantId: variantId },
  });
  return { onHand: inv.onHand, reserved: inv.reserved, available: inv.onHand - inv.reserved };
}

async function leerOrden(orderId: string) {
  return prisma.order.findUniqueOrThrow({ where: { id: orderId } });
}

// ═══════════════════════════════════════════════════════════════════════════

describe('Crear una orden', () => {
  it('sale de la reserva, con todo copiado', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);

    const r = await crearOrden(comprador.token, reservationId);

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('PENDING_PAYMENT');
    expect(r.body.itemsSubtotal).toBe(890_000);
    expect(r.body.grossAmount).toBe(890_000);
    // 6 % de $8.900 = $534
    expect(r.body.platformFeeBps).toBe(600);
    expect(r.body.platformFeeAmount).toBe(53_400);
    expect(r.body.sellerNetAmount).toBe(836_600);
    expect(r.body.reference).toHaveLength(8);

    // La dirección viajó como foto, no como referencia.
    expect(r.body.shippingAddress.street).toBe('Av. Corrientes');
    expect(r.body.shippingAddress.postalCode).toBe('C1043');

    const items = await prisma.orderItem.findMany({ where: { orderId: r.body.id } });
    expect(items).toHaveLength(1);
    expect(items[0]!.productNameSnapshot).toContain('Producto ord');
    expect(items[0]!.unitPrice).toBe(890_000);
  });

  it('⛔ el precio que manda el cliente se IGNORA', async () => {
    /**
     * El ataque más obvio contra un checkout: mandar el precio en el cuerpo.
     * El DTO ni siquiera tiene esos campos, así que Zod los descarta y el
     * precio sale del producto real.
     */
    const { variantId } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);

    const r = await call('POST', '/api/v1/orders', {
      token: comprador.token,
      idempotencyKey: clave('hack'),
      body: {
        reservationId,
        unitPrice: 1,
        itemsSubtotal: 1,
        grossAmount: 1,
        platformFeeAmount: 0,
        sellerNetAmount: 999_999,
        currency: 'USD',
      },
    });

    expect(r.status).toBe(201);
    expect(r.body.grossAmount).toBe(890_000);
    expect(r.body.currency).toBe('ARS');
    expect(r.body.sellerNetAmount).toBe(836_600);
  });

  it('⛔ el sellerId que manda el cliente se IGNORA', async () => {
    const victima = await nuevaVarianteConStock(5);
    const otro = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, victima.variantId);

    const r = await call('POST', '/api/v1/orders', {
      token: comprador.token,
      idempotencyKey: clave('seller'),
      body: { reservationId, sellerId: otro.sellerId, storeId: 'sto_falso' },
    });

    expect(r.status).toBe(201);
    // El vendedor sale del producto, no del cuerpo.
    expect(r.body.sellerId).toBe(victima.sellerId);
  });

  it('la misma reserva devuelve la MISMA orden', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);

    const primera = await crearOrden(comprador.token, reservationId);
    const segunda = await crearOrden(comprador.token, reservationId);

    expect(segunda.body.id).toBe(primera.body.id);
    expect(await prisma.order.count({ where: { reservationId } })).toBe(1);
  });

  it('⛔ diez peticiones simultáneas crean UNA sola orden', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);

    const respuestas = await Promise.all(
      Array.from({ length: 10 }, () => crearOrden(comprador.token, reservationId)),
    );

    const ids = new Set(respuestas.filter((r) => r.status === 201).map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(await prisma.order.count({ where: { reservationId } })).toBe(1);
  });

  it('⛔ una reserva ajena no existe', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const duenio = await nuevoComprador();
    const intruso = await nuevoComprador();
    const reservationId = await reservar(duenio.token, variantId);

    const r = await crearOrden(intruso.token, reservationId);
    expect(r.status).toBe(404);
  });

  it('⛔ una reserva vencida no genera orden', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);

    await prisma.inventoryReservation.update({
      where: { id: reservationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const r = await crearOrden(comprador.token, reservationId);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('RESERVATION_EXPIRED');
  });

  it('⛔ sin dirección no se puede comprar', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const sinDireccion = await nuevoUsuario();
    const reservationId = await reservar(sinDireccion.token, variantId);

    const r = await crearOrden(sinDireccion.token, reservationId);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ADDRESS_REQUIRED');
  });

  it('⛔ un vendedor suspendido no recibe órdenes nuevas', async () => {
    const { variantId, sellerUserId } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);

    await prisma.seller.update({
      where: { userId: sellerUserId },
      data: { status: 'SUSPENDED' },
    });

    const r = await crearOrden(comprador.token, reservationId);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SELLER_NOT_ACTIVE');
  });

  it('⛔ sin cabecera de idempotencia no se crea', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);

    const r = await call('POST', '/api/v1/orders', {
      token: comprador.token,
      body: { reservationId },
    });
    expect(r.status).toBe(400);
  });

  it('crear la orden NO consume el stock', async () => {
    // Las unidades siguen apartadas por la reserva. Consumirlas acá
    // descontaría stock por cada carrito abandonado.
    const { variantId } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);
    await crearOrden(comprador.token, reservationId);

    expect(await leerInventario(variantId)).toEqual({ onHand: 5, reserved: 1, available: 4 });
  });
});

describe('Cobrar', () => {
  it('camino feliz: aprobado → PAID → CONFIRMED, stock consumido', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);
    const orden = await crearOrden(comprador.token, reservationId);

    proveedor.proximo = { status: 'approved' };
    const pago = await pagar(comprador.token, orden.body.id);

    expect(pago.status, JSON.stringify(pago.body)).toBe(201);
    expect(pago.body.status).toBe('APPROVED');
    expect(pago.body.orderStatus).toBe('CONFIRMED');

    const final = await leerOrden(orden.body.id);
    expect(final.status).toBe('CONFIRMED');
    expect(final.paidAt).not.toBeNull();
    expect(final.confirmedAt).not.toBeNull();

    // Consumir descuenta de onHand Y de reserved: la unidad se vendió.
    expect(await leerInventario(variantId)).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('sólo se guardan los últimos cuatro y la marca', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { status: 'approved', lastFour: '3704', brand: 'visa' };
    await pagar(comprador.token, orden.body.id);

    const intento = await prisma.paymentAttempt.findFirstOrThrow({
      where: { orderId: orden.body.id },
    });
    expect(intento.lastFour).toBe('3704');
    expect(intento.brand).toBe('visa');

    // Nada más de la tarjeta quedó en ningún lado.
    const todo = JSON.stringify(intento);
    expect(todo).not.toContain('450995');
    expect(todo).not.toContain('cardholder');
  });

  it('rechazado → PAYMENT_FAILED, el stock sigue apartado', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { status: 'rejected', statusDetail: 'cc_rejected_insufficient_amount' };
    const pago = await pagar(comprador.token, orden.body.id);

    expect(pago.status).toBe(402);
    expect((await leerOrden(orden.body.id)).status).toBe('PAYMENT_FAILED');
    // La reserva sigue viva: puede reintentar con otra tarjeta.
    expect(await leerInventario(variantId)).toEqual({ onHand: 3, reserved: 1, available: 2 });
  });

  it('⛔ el mensaje de error es humano, no el código de Mercado Pago', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { status: 'rejected', statusDetail: 'cc_rejected_insufficient_amount' };
    const pago = await pagar(comprador.token, orden.body.id);

    const mensaje = pago.body.error.message as string;
    expect(mensaje).not.toContain('cc_rejected');
    expect(mensaje).not.toContain('internal_error');
    expect(mensaje.length).toBeGreaterThan(10);
  });

  it('tras un rechazo se puede intentar con OTRA tarjeta', async () => {
    /**
     * El bug del spike: una clave de idempotencia por orden hacía que el
     * segundo intento devolviera la respuesta guardada del primero. Una orden
     * rechazada quedaba condenada para siempre.
     */
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { status: 'rejected' };
    await pagar(comprador.token, orden.body.id, 'tok_visa_rechazada');

    proveedor.proximo = { status: 'approved' };
    const segundo = await pagar(comprador.token, orden.body.id, 'tok_master_aprobada');

    expect(segundo.status).toBe(201);
    expect(segundo.body.orderStatus).toBe('CONFIRMED');

    // Dos intentos distintos, cada uno con su historia.
    const intentos = await prisma.paymentAttempt.findMany({ where: { orderId: orden.body.id } });
    expect(intentos).toHaveLength(2);
    expect(new Set(intentos.map((i) => i.idempotencyKey)).size).toBe(2);
  });

  it('⛔ el MISMO token reintentado NO cobra dos veces', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { status: 'approved' };
    const primero = await pagar(comprador.token, orden.body.id, 'tok_igual');
    const segundo = await pagar(comprador.token, orden.body.id, 'tok_igual');

    expect(segundo.body.attemptId).toBe(primero.body.attemptId);
    expect(await prisma.paymentAttempt.count({ where: { orderId: orden.body.id } })).toBe(1);
    // Una sola llamada al proveedor.
    expect(proveedor.llamadasACobrar).toBe(1);
  });

  it('⛔ no se puede pagar la orden de otro', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const duenio = await nuevoComprador();
    const intruso = await nuevoComprador();
    const orden = await crearOrden(duenio.token, await reservar(duenio.token, variantId));

    const r = await pagar(intruso.token, orden.body.id);
    expect(r.status).toBe(404);
  });

  it('⛔ una orden ya pagada no se vuelve a cobrar', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { status: 'approved' };
    await pagar(comprador.token, orden.body.id);

    const otra = await pagar(comprador.token, orden.body.id, 'tok_otro');
    expect(otra.status).toBe(409);
    expect(otra.body.error.code).toBe('PAYMENT_ALREADY_APPROVED');
  });
});

describe('⛔ Un error de red NO es un pago fallido', () => {
  it('queda en estado desconocido, no rechazado', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA REGLA QUE EVITA COBRAR DOS VECES
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Se manda el cobro y se corta la conexión. El pago pudo haberse procesado
     * perfectamente del lado de Mercado Pago.
     *
     * Marcarlo `REJECTED` sería decirle a la persona que no le cobraron —y
     * dejarla pagar de nuevo— cuando quizá ya le cobraron.
     */
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { fallo: 'red' };
    const r = await pagar(comprador.token, orden.body.id);

    // 202: la petición se aceptó, el resultado llega después.
    expect(r.status).toBe(202);
    expect(r.body.error.code).toBe('PAYMENT_STATE_UNKNOWN');

    const intento = await prisma.paymentAttempt.findFirstOrThrow({
      where: { orderId: orden.body.id },
    });
    expect(intento.status).toBe('UNKNOWN_PENDING_RECONCILIATION');
    expect((await leerOrden(orden.body.id)).status).toBe('PROCESSING_PAYMENT');
  });

  it('⛔ y NO deja lanzar otro cobro a ciegas', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { fallo: 'red' };
    await pagar(comprador.token, orden.body.id, 'tok_perdido');

    const segundo = await pagar(comprador.token, orden.body.id, 'tok_nuevo');
    expect(segundo.status).toBe(409);
    expect(segundo.body.error.code).toBe('PAYMENT_IN_FLIGHT');
  });

  it('el conciliador lo resuelve: estaba aprobado', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { fallo: 'red' };
    await pagar(comprador.token, orden.body.id);

    // Del otro lado sí se había procesado.
    proveedor.alConsultar = { status: 'approved' };
    await reconciler.barrer();

    const final = await leerOrden(orden.body.id);
    expect(final.status).toBe('CONFIRMED');
    expect(await leerInventario(variantId)).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('el conciliador lo resuelve: estaba rechazado', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { fallo: 'red' };
    await pagar(comprador.token, orden.body.id);

    proveedor.alConsultar = { status: 'rejected' };
    await reconciler.barrer();

    expect((await leerOrden(orden.body.id)).status).toBe('PAYMENT_FAILED');
    // El stock sigue apartado: puede reintentar.
    expect((await leerInventario(variantId)).reserved).toBe(1);
  });

  it('el conciliador libera la orden si el cobro nunca existió', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { fallo: 'red' };
    await pagar(comprador.token, orden.body.id);

    // Mercado Pago no conoce ningún pago para esta orden: la red se cortó
    // antes de que llegara.
    proveedor.alBuscar = [];
    proveedor.alConsultar = { fallo: 'no_encontrado' };
    await reconciler.barrer();

    const final = await leerOrden(orden.body.id);
    expect(final.status).toBe('PENDING_PAYMENT');

    // Y ahora sí puede volver a pagar.
    proveedor.proximo = { status: 'approved' };
    const reintento = await pagar(comprador.token, orden.body.id, 'tok_nuevo');
    expect(reintento.status).toBe(201);
  });
});

describe('⛔ LA CARRERA — pago tardío contra reserva vencida', () => {
  it('si la unidad se la llevó otro: PAYMENT_REQUIRES_REFUND y devolución', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL CASO QUE JUSTIFICA SEPARAR `PAID` DE `CONFIRMED`
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Stock = 1.
     *
     *   · A reserva la última unidad y empieza a pagar.
     *   · A pierde señal. Su reserva vence y el stock se libera.
     *   · B reserva esa unidad, legítimamente.
     *   · Recién ahí Mercado Pago acredita el pago de A.
     *
     * Hay plata de A y una unidad que ya es de B.
     *
     * Lo que NO puede pasar: que A se quede con la unidad de B. B hizo todo
     * bien y su reserva es válida.
     *
     * Lo que tiene que pasar: A queda en `PAYMENT_REQUIRES_REFUND`, se le
     * devuelve la plata, y B conserva lo suyo.
     *
     * **El dinero acreditado no autoriza a romper las reglas de inventario.**
     */
    const { variantId } = await nuevaVarianteConStock(1);
    const compradorA = await nuevoComprador();
    const compradorB = await nuevoComprador();

    // A reserva y crea su orden.
    const reservaA = await reservar(compradorA.token, variantId);
    const ordenA = await crearOrden(compradorA.token, reservaA);
    expect(ordenA.status).toBe(201);

    // A empieza a pagar y se corta la red.
    proveedor.proximo = { fallo: 'red' };
    await pagar(compradorA.token, ordenA.body.id);

    // Se vence la reserva de A y el stock se libera.
    await prisma.inventoryReservation.update({
      where: { id: reservaA },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await inventory.expireIfDue(reservaA);
    expect(await leerInventario(variantId)).toEqual({ onHand: 1, reserved: 0, available: 1 });

    // B se lleva la unidad.
    const reservaB = await reservar(compradorB.token, variantId);
    expect(await leerInventario(variantId)).toEqual({ onHand: 1, reserved: 1, available: 0 });

    // Ahora Mercado Pago acredita el pago de A.
    proveedor.alConsultar = { status: 'approved' };
    await reconciler.barrer();

    // ─── Lo que tiene que haber pasado ───
    const finalA = await leerOrden(ordenA.body.id);
    expect(['PAYMENT_REQUIRES_REFUND', 'REFUND_PENDING', 'REFUNDED']).toContain(finalA.status);
    expect(finalA.paidAt).not.toBeNull();
    expect(finalA.confirmedAt).toBeNull();

    // B conserva su reserva intacta.
    const deB = await prisma.inventoryReservation.findUniqueOrThrow({ where: { id: reservaB } });
    expect(deB.status).toBe('ACTIVE');

    // El stock nunca se rompió.
    const inv = await leerInventario(variantId);
    expect(inv.onHand).toBe(1);
    expect(inv.reserved).toBe(1);
    expect(inv.available).toBe(0);

    // Y se inició la devolución.
    const devolucion = await prisma.refund.findFirst({ where: { orderId: ordenA.body.id } });
    expect(devolucion).not.toBeNull();
    expect(devolucion!.reason).toBe('LATE_PAYMENT_OUT_OF_STOCK');
  });

  it('si queda stock: se recupera y CONFIRMED', async () => {
    /**
     * Mismo pago tardío, pero con una unidad libre.
     *
     * Se toma con una operación atómica que descuenta de `onHand` sólo si hay
     * disponible. Nunca se revive la reserva vencida: `EXPIRED → CONSUMED`
     * sigue prohibido.
     */
    const { variantId } = await nuevaVarianteConStock(2);
    const compradorA = await nuevoComprador();

    const reservaA = await reservar(compradorA.token, variantId);
    const ordenA = await crearOrden(compradorA.token, reservaA);

    proveedor.proximo = { fallo: 'red' };
    await pagar(compradorA.token, ordenA.body.id);

    await prisma.inventoryReservation.update({
      where: { id: reservaA },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await inventory.expireIfDue(reservaA);

    proveedor.alConsultar = { status: 'approved' };
    await reconciler.barrer();

    const final = await leerOrden(ordenA.body.id);
    expect(final.status).toBe('CONFIRMED');
    expect(final.confirmedAt).not.toBeNull();

    // Se descontó una unidad física. `reserved` no se tocó.
    expect(await leerInventario(variantId)).toEqual({ onHand: 1, reserved: 0, available: 1 });

    // La reserva vencida sigue vencida: no se revivió.
    const reserva = await prisma.inventoryReservation.findUniqueOrThrow({
      where: { id: reservaA },
    });
    expect(reserva.status).toBe('EXPIRED');

    expect(await prisma.refund.count({ where: { orderId: ordenA.body.id } })).toBe(0);
  });

  it('⛔ nunca hay dos ventas para una unidad, en veinte corridas', async () => {
    /**
     * La versión repetida del caso anterior.
     *
     * Los dos desenlaces son válidos según el orden en que PostgreSQL
     * serialice las operaciones:
     *
     *   · A recupera la unidad y B se queda sin stock.
     *   · B se lleva la unidad y A va a devolución.
     *
     * Lo que NUNCA es válido: que A quede CONFIRMED y B con su reserva ACTIVE
     * sobre una sola unidad. O que el stock quede negativo.
     */
    for (let vuelta = 0; vuelta < 20; vuelta += 1) {
      proveedor.reiniciar();

      const { variantId } = await nuevaVarianteConStock(1);
      const a = await nuevoComprador();
      const b = await nuevoComprador();

      const reservaA = await reservar(a.token, variantId);
      const ordenA = await crearOrden(a.token, reservaA);

      proveedor.proximo = { fallo: 'red' };
      await pagar(a.token, ordenA.body.id);

      await prisma.inventoryReservation.update({
        where: { id: reservaA },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      await inventory.expireIfDue(reservaA);

      proveedor.alConsultar = { status: 'approved' };

      // Los dos a la vez: la confirmación del pago de A y la reserva de B.
      const [, reservaB] = await Promise.all([
        reconciler.barrer(),
        call('POST', '/api/v1/inventory/reservations', {
          token: b.token,
          idempotencyKey: clave(`carrera-${vuelta}`),
          body: { productVariantId: variantId, quantity: 1 },
        }),
      ]);

      const finalA = await leerOrden(ordenA.body.id);
      const inv = await leerInventario(variantId);
      const bReservo = reservaB.status === 201;

      // ─── Lo que nunca puede pasar ───
      expect(inv.onHand, `vuelta ${vuelta}: onHand`).toBeGreaterThanOrEqual(0);
      expect(inv.reserved, `vuelta ${vuelta}: reserved`).toBeLessThanOrEqual(inv.onHand);
      expect(inv.available, `vuelta ${vuelta}: disponibles`).toBeGreaterThanOrEqual(0);

      const aSeLlevoLaUnidad = finalA.status === 'CONFIRMED';
      expect(
        aSeLlevoLaUnidad && bReservo,
        `vuelta ${vuelta}: A confirmada Y B reservó sobre una sola unidad`,
      ).toBe(false);

      // A siempre termina resuelta de alguna forma honesta.
      expect(
        ['CONFIRMED', 'PAYMENT_REQUIRES_REFUND', 'REFUND_PENDING', 'REFUNDED'],
        `vuelta ${vuelta}: estado de A`,
      ).toContain(finalA.status);

      // Y si no se llevó la unidad, hay una devolución en marcha.
      if (!aSeLlevoLaUnidad) {
        expect(
          await prisma.refund.count({ where: { orderId: ordenA.body.id } }),
          `vuelta ${vuelta}: devolución de A`,
        ).toBe(1);
      }
    }
  }, 180_000);
});

describe('⛔ Webhook duplicado', () => {
  it('veinte notificaciones del mismo pago acreditan UNA vez', async () => {
    /**
     * Mercado Pago reintenta. Y además la respuesta directa ya acreditó 681 ms
     * antes —medido en la primera compra real del spike—.
     *
     * Sin la guarda de monotonía y la deduplicación, veinte avisos serían
     * veinte acreditaciones y veinte consumos de stock.
     */
    const { variantId } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { status: 'approved', id: 'mp_1234567890' };
    await pagar(comprador.token, orden.body.id);

    const inventarioTrasElPago = await leerInventario(variantId);

    proveedor.alConsultar = { status: 'approved', id: 'mp_1234567890' };

    const respuestas = await Promise.all(
      Array.from({ length: 20 }, () => enviarWebhook('mp_1234567890', `notif-${Date.now()}`)),
    );

    expect(respuestas.every((r) => r.status === 200)).toBe(true);

    // Nada cambió: ni el stock ni el estado.
    expect(await leerInventario(variantId)).toEqual(inventarioTrasElPago);
    expect((await leerOrden(orden.body.id)).status).toBe('CONFIRMED');

    // Un solo intento, una sola confirmación en la bitácora.
    expect(await prisma.paymentAttempt.count({ where: { orderId: orden.body.id } })).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { entityId: orden.body.id, action: 'order.confirmed' },
      }),
    ).toBe(1);
  });

  it('el mismo id de notificación se descarta por índice único', async () => {
    const { variantId } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { status: 'approved', id: 'mp_dedupe' };
    await pagar(comprador.token, orden.body.id);
    proveedor.alConsultar = { status: 'approved', id: 'mp_dedupe' };

    // Fijo dentro del test, único entre corridas: si quedara algo de una
    // ejecución anterior, la PRIMERA llamada ya vendría deduplicada y el test
    // pasaría por el motivo equivocado.
    const fija = `notif-fija-${Date.now()}`;
    const primera = await enviarWebhook('mp_dedupe', fija);
    const segunda = await enviarWebhook('mp_dedupe', fija);

    expect(segunda.body.status).toBe('DUPLICATE');
    expect(primera.body.status).not.toBe('DUPLICATE');
  });

  it('⛔ una firma inválida se rechaza pero responde 200', async () => {
    // Un 401 haría que Mercado Pago reintentara en bucle algo que nunca vamos
    // a aceptar.
    const res = await (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/webhooks/orders/mercadopago',
        headers: {
          'content-type': 'application/json',
          'x-signature': 'ts=123,v1=firmafalsa',
          'x-request-id': 'req-falso',
        },
        payload: {
          id: `firma-falsa-${Date.now()}`,
          type: 'payment',
          data: { id: 'mp_falso' },
        },
      });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('INVALID_SIGNATURE');
  });

  it('un pago que no conocemos se archiva sin romper', async () => {
    // Pasa con los pagos de prueba creados desde el panel de Mercado Pago. En
    // el spike este caso producía un 500 por violación de clave foránea.
    proveedor.alConsultar = { status: 'approved', id: 'mp_huerfano', externalReference: null };

    const r = await enviarWebhook('mp_huerfano', `huerfano-${Date.now()}`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ORPHAN');
  });
});

describe('Devoluciones', () => {
  it('se completan y la orden queda REFUNDED', async () => {
    const { variantId } = await nuevaVarianteConStock(1);
    const a = await nuevoComprador();
    const b = await nuevoComprador();

    const reservaA = await reservar(a.token, variantId);
    const ordenA = await crearOrden(a.token, reservaA);
    proveedor.proximo = { fallo: 'red' };
    await pagar(a.token, ordenA.body.id);

    await prisma.inventoryReservation.update({
      where: { id: reservaA },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await inventory.expireIfDue(reservaA);
    await reservar(b.token, variantId);

    proveedor.alConsultar = { status: 'approved' };
    await reconciler.barrer();

    const final = await leerOrden(ordenA.body.id);
    expect(final.status).toBe('REFUNDED');
    expect(final.refundedAt).not.toBeNull();

    const devolucion = await prisma.refund.findFirstOrThrow({
      where: { orderId: ordenA.body.id },
    });
    expect(devolucion.status).toBe('COMPLETED');
    expect(devolucion.completedAt).not.toBeNull();
  });

  it('⛔ una devolución que falla NO da la orden por resuelta', async () => {
    const { variantId } = await nuevaVarianteConStock(1);
    const a = await nuevoComprador();
    const b = await nuevoComprador();

    const reservaA = await reservar(a.token, variantId);
    const ordenA = await crearOrden(a.token, reservaA);
    proveedor.proximo = { fallo: 'red' };
    await pagar(a.token, ordenA.body.id);

    await prisma.inventoryReservation.update({
      where: { id: reservaA },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await inventory.expireIfDue(reservaA);
    await reservar(b.token, variantId);

    proveedor.alConsultar = { status: 'approved' };
    proveedor.devolucionFalla = true;
    await reconciler.barrer();

    const final = await leerOrden(ordenA.body.id);
    // Queda pendiente de devolver, no "resuelta".
    expect(final.status).toBe('PAYMENT_REQUIRES_REFUND');

    const devolucion = await prisma.refund.findFirstOrThrow({
      where: { orderId: ordenA.body.id },
    });
    expect(devolucion.status).toBe('FAILED');
    expect(devolucion.attempts).toBeGreaterThan(0);

    // Y el conciliador la retoma cuando el proveedor se recupera.
    proveedor.devolucionFalla = false;
    await reconciler.barrer();

    expect((await leerOrden(ordenA.body.id)).status).toBe('REFUNDED');
  });

  it('⛔ dos ejecuciones no devuelven la plata dos veces', async () => {
    const { variantId } = await nuevaVarianteConStock(1);
    const a = await nuevoComprador();
    const b = await nuevoComprador();

    const reservaA = await reservar(a.token, variantId);
    const ordenA = await crearOrden(a.token, reservaA);
    proveedor.proximo = { fallo: 'red' };
    await pagar(a.token, ordenA.body.id);

    await prisma.inventoryReservation.update({
      where: { id: reservaA },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await inventory.expireIfDue(reservaA);
    await reservar(b.token, variantId);

    proveedor.alConsultar = { status: 'approved' };
    await reconciler.barrer();

    const llamadasIniciales = proveedor.llamadasADevolver;
    await reconciler.barrer();
    await reconciler.barrer();

    // Una sola fila y ninguna devolución extra.
    expect(await prisma.refund.count({ where: { orderId: ordenA.body.id } })).toBe(1);
    expect(proveedor.llamadasADevolver).toBe(llamadasIniciales);
  });
});

describe('⛔ IDOR', () => {
  it('un comprador no ve la orden de otro', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const duenio = await nuevoComprador();
    const intruso = await nuevoComprador();
    const orden = await crearOrden(duenio.token, await reservar(duenio.token, variantId));

    const r = await call('GET', `/api/v1/orders/${orden.body.id}`, { token: intruso.token });
    expect(r.status).toBe(404);
  });

  it('un comprador no cancela la orden de otro', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const duenio = await nuevoComprador();
    const intruso = await nuevoComprador();
    const orden = await crearOrden(duenio.token, await reservar(duenio.token, variantId));

    const r = await call('DELETE', `/api/v1/orders/${orden.body.id}`, { token: intruso.token });
    expect(r.status).toBe(404);
    expect((await leerOrden(orden.body.id)).status).toBe('PENDING_PAYMENT');
  });

  it('un vendedor sólo ve sus ventas', async () => {
    const a = await nuevaVarianteConStock(3);
    const b = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();

    const orden = await crearOrden(comprador.token, await reservar(comprador.token, a.variantId));
    proveedor.proximo = { status: 'approved' };
    await pagar(comprador.token, orden.body.id);

    const suyas = await call('GET', '/api/v1/seller/orders', { token: a.sellerToken });
    const ajenas = await call('GET', '/api/v1/seller/orders', { token: b.sellerToken });

    expect(suyas.body.items.map((o: { id: string }) => o.id)).toContain(orden.body.id);
    expect(ajenas.body.items.map((o: { id: string }) => o.id)).not.toContain(orden.body.id);
  });

  it('⛔ un vendedor no puede mover la orden de otro', async () => {
    const a = await nuevaVarianteConStock(3);
    const b = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();

    const orden = await crearOrden(comprador.token, await reservar(comprador.token, a.variantId));
    proveedor.proximo = { status: 'approved' };
    await pagar(comprador.token, orden.body.id);

    const r = await call('PATCH', `/api/v1/seller/orders/${orden.body.id}/fulfillment`, {
      token: b.sellerToken,
      body: { status: 'PREPARING' },
    });
    expect(r.status).toBe(404);
  });

  it('⛔ el comprador NO puede mover estados de preparación', async () => {
    const { variantId, sellerToken } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));
    proveedor.proximo = { status: 'approved' };
    await pagar(comprador.token, orden.body.id);

    // No hay endpoint para él: el del vendedor le devuelve 404 porque no es
    // vendedor de nada.
    const r = await call('PATCH', `/api/v1/seller/orders/${orden.body.id}/fulfillment`, {
      token: comprador.token,
      body: { status: 'SHIPPED' },
    });
    expect([403, 404]).toContain(r.status);

    // Y el vendedor sí puede, en orden.
    const ok = await call('PATCH', `/api/v1/seller/orders/${orden.body.id}/fulfillment`, {
      token: sellerToken,
      body: { status: 'PREPARING' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('PREPARING');
  });

  it('⛔ el vendedor no puede saltarse pasos de preparación', async () => {
    const { variantId, sellerToken } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));
    proveedor.proximo = { status: 'approved' };
    await pagar(comprador.token, orden.body.id);

    const salto = await call('PATCH', `/api/v1/seller/orders/${orden.body.id}/fulfillment`, {
      token: sellerToken,
      body: { status: 'SHIPPED' },
    });
    expect(salto.status).toBe(409);
    expect(salto.body.error.code).toBe('INVALID_TRANSITION');
  });
});

describe('Órdenes sin pagar', () => {
  it('vencen cuando su reserva ya no está', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);
    const orden = await crearOrden(comprador.token, reservationId);

    await prisma.inventoryReservation.update({
      where: { id: reservationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await inventory.expireIfDue(reservationId);
    // La orden tiene que ser más vieja que el margen de gracia.
    await prisma.order.update({
      where: { id: orden.body.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    await reconciler.barrer();

    const final = await leerOrden(orden.body.id);
    expect(final.status).toBe('EXPIRED');
    expect(final.expiredAt).not.toBeNull();
  });

  it('⛔ una orden con un cobro en vuelo NUNCA vence por tiempo', async () => {
    /**
     * Si ese cobro se aprobó y todavía no nos enteramos, marcarla vencida
     * sería quedarse con la plata de alguien.
     */
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);
    const orden = await crearOrden(comprador.token, reservationId);

    proveedor.proximo = { fallo: 'red' };
    await pagar(comprador.token, orden.body.id);

    await prisma.inventoryReservation.update({
      where: { id: reservationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await inventory.expireIfDue(reservationId);
    await prisma.order.update({
      where: { id: orden.body.id },
      data: { createdAt: new Date(Date.now() - 3_600_000) },
    });

    // El conciliador no puede resolver el cobro todavía.
    proveedor.alConsultar = { fallo: 'red' };
    await reconciler.barrer();

    expect((await leerOrden(orden.body.id)).status).toBe('PROCESSING_PAYMENT');
  });

  it('el comprador puede cancelar antes de pagar', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    const r = await call('DELETE', `/api/v1/orders/${orden.body.id}`, { token: comprador.token });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('CANCELLED');
  });
});

describe('Mis pedidos', () => {
  it('el comprador ve los suyos con lo que necesita', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));
    proveedor.proximo = { status: 'approved', lastFour: '3704', brand: 'visa' };
    await pagar(comprador.token, orden.body.id);

    const lista = await call('GET', '/api/v1/orders', { token: comprador.token });
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0].items[0].productNameSnapshot).toBeTruthy();

    const detalle = await call('GET', `/api/v1/orders/${orden.body.id}`, {
      token: comprador.token,
    });
    expect(detalle.body.status).toBe('CONFIRMED');
    expect(detalle.body.attempts[0].lastFour).toBe('3704');
  });

  it('⛔ el vendedor NO ve datos del cobro que no le sirven', async () => {
    const { variantId, sellerToken } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));
    proveedor.proximo = { status: 'approved', lastFour: '3704' };
    await pagar(comprador.token, orden.body.id);

    const ventas = await call('GET', '/api/v1/seller/orders', { token: sellerToken });
    const crudo = JSON.stringify(ventas.body);

    // Ve lo que necesita para despachar y su neto.
    expect(ventas.body.items[0].sellerNetAmount).toBeGreaterThan(0);
    expect(ventas.body.items[0].shippingAddress.street).toBe('Av. Corrientes');
    // No ve con qué tarjeta le pagaron ni el id del pago.
    expect(crudo).not.toContain('3704');
    expect(crudo).not.toContain('idempotencyKey');
  });
});

// ─── Webhook ────────────────────────────────────────────────────────────────

/**
 * Manda una notificación FIRMADA como lo hace Mercado Pago.
 *
 * La firma se calcula igual que del otro lado: sin esto, todos los tests de
 * webhook probarían nada más que el rechazo por firma inválida.
 */
async function enviarWebhook(paymentId: string, notificationId: string) {
  const { createHmac } = await import('node:crypto');
  const ts = Math.floor(Date.now() / 1000);
  const manifest = `id:${paymentId};request-id:req-${notificationId};ts:${ts};`;
  const v1 = createHmac('sha256', TEST_ENV.MP_WEBHOOK_SECRET).update(manifest).digest('hex');

  const res = await (app as NestFastifyApplication)
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: '/webhooks/orders/mercadopago',
      headers: {
        'content-type': 'application/json',
        'x-signature': `ts=${ts},v1=${v1}`,
        'x-request-id': `req-${notificationId}`,
      },
      payload: { id: notificationId, type: 'payment', action: 'payment.updated', data: { id: paymentId } },
    });

  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
