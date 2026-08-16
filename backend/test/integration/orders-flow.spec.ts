import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtService } from '@/modules/auth/jwt.service';
import type { InventoryService } from '@/modules/inventory/inventory.service';
import { AgendaService } from '@/modules/live/agenda.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import type { OrdersReconciler } from '@/modules/orders/reconciler.service';
import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { RUTA_WEBHOOK_MERCADOPAGO } from '@/shared/http/rutas-webhook';

import { crearAppDePrueba } from '../helpers/app';
import { datosDeAdulto } from '../helpers/edad';
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

/**
 * Un sufijo único POR CORRIDA.
 *
 * Los ids eran deterministas y la base de tests no se trunca entre corridas:
 * las filas de auditoría de la vez anterior quedaban con el mismo `entityId`,
 * y un test que contaba registros encontraba los de ayer. Falló exactamente
 * así, y sólo cuando corría la suite entera.
 */
const CORRIDA = Math.random().toString(36).slice(2, 8);
let n = 0;

/**
 * @param conEdad `false` deja la cuenta sin fecha declarada, como recién
 *   registrada. Sólo lo usa el bloque de mayoría de edad: para todo lo demás,
 *   una cuenta sin fecha no puede comprar y el test fallaría por un motivo que
 *   no es el suyo.
 */
async function nuevoUsuario(
  { conEdad = true }: { conEdad?: boolean } = {},
): Promise<{ token: string; userId: string }> {
  n += 1;
  const userId = `usr_${CORRIDA}${String(n).padStart(20, '0')}`;

  await prisma.user.create({
    data: {
      id: userId,
      firstName: 'Comprador',
      lastName: `${n}`,
      email: `ord-${n}-${Date.now()}@test.com`,
      emailVerified: true,
      role: 'buyer',
      // VendoX es 18+ y el backend lo exige antes de comprar. Ver helpers/edad.
      ...(conEdad ? datosDeAdulto() : {}),
    },
  });

  const { accessToken } = await jwt.issueAccessToken({
    userId,
    role: 'buyer',
    sessionId: `ses_${CORRIDA}${String(n).padStart(20, '0')}`,
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
    body: { name: `Producto ord ${n}`, basePriceCents: 890_000, status: 'ACTIVE', categoryId: 'cat_otros' },
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

async function crearOrden(
  token: string,
  reservationId: string,
  extra: Record<string, unknown> = {},
) {
  return call('POST', '/api/v1/orders', {
    token,
    idempotencyKey: clave('o'),
    body: { reservationId, ...extra },
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
        url: URL_WEBHOOK,
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

/**
 * La URL del webhook, como la va a llamar Mercado Pago.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE BLOQUE EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque no había ninguno, y por eso el defecto sobrevivió: los tests de
 * webhook probaban el COMPORTAMIENTO —firma, deduplicación, huérfanos— y
 * ninguno probaba **en qué URL responde**. El helper de tests excluía
 * `webhooks/(.*)` del prefijo global y `main.ts` enumeraba dos rutas: la suite
 * pasaba contra `/webhooks/orders/mercadopago` mientras el servidor real
 * servía `/api/webhooks/orders/mercadopago`.
 *
 * Habríamos cargado la URL probada en el panel de Mercado Pago y cada
 * notificación habría dado 404. Sin un solo test en rojo.
 */
describe('La ruta del webhook', () => {
  const pegar = (url: string) =>
    (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: { type: 'payment', data: { id: 'mp_x' } },
      });

  it('responde en /webhooks/orders/mercadopago', async () => {
    // La URL EXACTA que se carga en el panel. Sin /api y sin /v1.
    const res = await pegar('/webhooks/orders/mercadopago');
    expect(res.statusCode).toBe(200);
  });

  it('⛔ NO responde con el prefijo /api', async () => {
    // Era la ruta real antes del arreglo, y la que ningún test miraba.
    expect((await pegar('/api/webhooks/orders/mercadopago')).statusCode).toBe(404);
  });

  it('⛔ NO responde con versionado', async () => {
    expect((await pegar('/api/v1/webhooks/orders/mercadopago')).statusCode).toBe(404);
    expect((await pegar('/v1/webhooks/orders/mercadopago')).statusCode).toBe(404);
  });

  it('⛔ la ruta genérica "webhooks/mercadopago" no existe', async () => {
    /**
     * Es la que un humano apurado escribe de memoria en el panel.
     *
     * La ocupaba el webhook del spike, que acredita contra `SpikeOrder` — una
     * tabla que el flujo real de pedidos no usa. Pegarla en el panel habría
     * dejado todos los pedidos reales sin confirmar mientras el spike anotaba
     * pagos que nadie mira. Ahora da 404, que es un error que se nota.
     */
    expect((await pegar('/webhooks/mercadopago')).statusCode).toBe(404);
    expect((await pegar('/api/webhooks/mercadopago')).statusCode).toBe(404);
  });

  it('el webhook del spike vive en una URL que se anuncia como tal', async () => {
    /**
     * En la suite el spike está encendido (`test/setup.ts`), así que su ruta
     * responde. Lo que se verifica es que responde **en la suya**: si alguien
     * la devolviera a `webhooks/mercadopago`, el test de arriba se pondría en
     * rojo.
     *
     * Que no exista en producción no se prueba acá sino donde se decide:
     * `env-schema.spec.ts` verifica que `PAYMENTS_SPIKE_ENABLED=true` con
     * `NODE_ENV=production` no arranca.
     */
    const res = await pegar('/webhooks/spike/mercadopago');
    expect(res.statusCode).toBe(200);
    expect(RUTA_WEBHOOK_MERCADOPAGO).not.toContain('spike');
  });
});

/**
 * De dónde sale `data.id`, que es con lo que se arma el manifiesto de la firma.
 *
 * Si se tomara de un lugar distinto del que usó Mercado Pago para firmar, el
 * HMAC se calcularía sobre otro id y la verificación fallaría con
 * `HASH_MISMATCH` — indistinguible de una clave mal configurada, y un día
 * entero de depuración.
 */
describe('El origen de data.id', () => {
  it('la query string tiene prioridad sobre el cuerpo', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { status: 'approved', id: 'mp_query_gana' };
    await pagar(comprador.token, orden.body.id);
    proveedor.alConsultar = { status: 'approved', id: 'mp_query_gana' };

    /**
     * Los dos vienen y son DISTINTOS.
     *
     * La firma se calculó sobre el de la query, que es lo que hace Mercado
     * Pago. Si el código prefiriera el del cuerpo, el manifiesto no coincidiría
     * y esto respondería INVALID_SIGNATURE.
     */
    const r = await enviarWebhook('mp_query_gana', `prioridad-${Date.now()}`, {
      donde: 'ambos',
      idEnElCuerpo: 'mp_cuerpo_distinto',
    });

    expect(r.status).toBe(200);
    expect(r.body.status).not.toBe('INVALID_SIGNATURE');

    // Y lo que quedó registrado es el de la query.
    const evento = await prisma.mpWebhookEvent.findFirst({
      where: { resourceId: 'mp_query_gana' },
      orderBy: { receivedAt: 'desc' },
    });
    expect(evento).not.toBeNull();
  });

  it('el cuerpo sigue funcionando como respaldo, para el simulador', async () => {
    // El simulador del panel manda avisos con el id sólo en el cuerpo. Sirve
    // para probar sin armar la URL a mano.
    proveedor.alConsultar = { status: 'approved', id: 'mp_solo_cuerpo', externalReference: null };

    const r = await enviarWebhook('mp_solo_cuerpo', `respaldo-${Date.now()}`, { donde: 'body' });

    expect(r.status).toBe(200);
    // Llega a consultar el pago: la firma validó y el id se resolvió.
    expect(r.body.status).toBe('ORPHAN');
  });

  it('sin data.id en ningún lado se ignora con 200', async () => {
    const requestId = `req-sin-id-${Date.now()}`;
    const { createHmac } = await import('node:crypto');
    const ts = Math.floor(Date.now() / 1000);
    // Sin `data.id`, el manifiesto omite ese segmento entero.
    const manifest = `request-id:${requestId};ts:${ts};`;
    const v1 = createHmac('sha256', TEST_ENV.MP_WEBHOOK_SECRET).update(manifest).digest('hex');

    const res = await (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: URL_WEBHOOK,
        headers: {
          'content-type': 'application/json',
          'x-signature': `ts=${ts},v1=${v1}`,
          'x-request-id': requestId,
        },
        payload: { id: `sin-id-${Date.now()}`, type: 'payment' },
      });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('IGNORED');
  });
});

describe('La firma del webhook', () => {
  it('un timestamp vencido se rechaza aunque el HMAC sea correcto', async () => {
    /**
     * Una firma vieja sigue siendo válida criptográficamente para siempre.
     *
     * Sin ventana de tolerancia, quien capture una notificación puede
     * repetirla cuando quiera. Seis minutos: la tolerancia son cinco.
     */
    const viejo = Math.floor(Date.now() / 1000) - 6 * 60;
    const requestId = `req-viejo-${Date.now()}`;
    const firma = await firmar({ dataId: 'mp_viejo', requestId, ts: viejo });

    const res = await (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `${URL_WEBHOOK}?data.id=mp_viejo&type=payment`,
        headers: {
          'content-type': 'application/json',
          'x-signature': firma,
          'x-request-id': requestId,
        },
        payload: { id: `viejo-${Date.now()}`, type: 'payment' },
      });

    expect(res.statusCode).toBe(200);
    const cuerpo = JSON.parse(res.body);
    expect(cuerpo.status).toBe('INVALID_SIGNATURE');
    // El motivo distingue "aviso viejo" de "firma falsa": son dos incidentes
    // distintos y se investigan distinto.
    expect(cuerpo.detail).toBe('STALE_TIMESTAMP');
  });

  it('una firma calculada con otra clave se rechaza', async () => {
    const requestId = `req-otraclave-${Date.now()}`;
    const firma = await firmar({
      dataId: 'mp_otra',
      requestId,
      secret: 'una-clave-que-no-es-la-nuestra',
    });

    const res = await (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `${URL_WEBHOOK}?data.id=mp_otra&type=payment`,
        headers: {
          'content-type': 'application/json',
          'x-signature': firma,
          'x-request-id': requestId,
        },
        payload: { id: `otra-${Date.now()}`, type: 'payment' },
      });

    expect(JSON.parse(res.body).status).toBe('INVALID_SIGNATURE');
    expect(JSON.parse(res.body).detail).toBe('HASH_MISMATCH');
  });

  it('sin cabecera de firma se rechaza', async () => {
    const res = await (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `${URL_WEBHOOK}?data.id=mp_sinfirma&type=payment`,
        headers: { 'content-type': 'application/json' },
        payload: { id: `sinfirma-${Date.now()}`, type: 'payment' },
      });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).detail).toBe('MISSING_SIGNATURE');
  });

  it('la firma se guarda RECORTADA, nunca entera', async () => {
    proveedor.alConsultar = { status: 'approved', id: 'mp_recorte', externalReference: null };
    const notificationId = `recorte-${Date.now()}`;

    await enviarWebhook('mp_recorte', notificationId, { donde: 'query' });

    const evento = await prisma.mpWebhookEvent.findFirst({ where: { notificationId } });
    const guardada = (evento?.headers as Record<string, string>)['x-signature'] ?? '';

    // El HMAC entero es material derivado de MP_WEBHOOK_SECRET, guardado en
    // claro en una tabla que el admin lee entera. Ocho caracteres alcanzan para
    // comparar dos notificaciones, que es lo único que se hace con ese dato.
    expect(guardada).toMatch(/^ts=\d+,v1=[0-9a-f]{8}…$/);
    expect(guardada.length).toBeLessThan(40);
  });
});

describe('Los topics que no son de pago', () => {
  for (const topic of ['merchant_order', 'plan', 'subscription', 'point_integration_wh']) {
    it(`"${topic}" se registra y se ignora con 200`, async () => {
      const requestId = `req-${topic}-${Date.now()}`;
      const firma = await firmar({ dataId: `res_${topic}`, requestId });
      const notificationId = `${topic}-${Date.now()}`;

      const res = await (app as NestFastifyApplication)
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: `${URL_WEBHOOK}?data.id=res_${topic}&type=${topic}`,
          headers: {
            'content-type': 'application/json',
            'x-signature': firma,
            'x-request-id': requestId,
          },
          payload: { id: notificationId, type: topic, data: { id: `res_${topic}` } },
        });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('IGNORED');

      // Queda registrado y marcado como procesado: si mañana hay que soportar
      // merchant_order, el histórico está.
      const evento = await prisma.mpWebhookEvent.findFirst({ where: { notificationId } });
      expect(evento?.topic).toBe(topic);
      expect(evento?.processedAt).not.toBeNull();

      // Y no se consultó la API por algo que no es un pago.
      expect(proveedor.llamadasAConsultar).toBe(0);
    });
  }
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
  /**
   * La dirección de la casa de alguien, con su DNI y su teléfono.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * ESTO NO ESTABA PROBADO
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `update` y `remove` filtran por `userId` y el comentario del archivo lo
   * dice: «Ajena = no encontrada». Pero sacar `userId` de los dos WHERE dejaba
   * las 819 pruebas de integración en verde.
   *
   * Lo que quedaba abierto no es sólo escribir: `update` **devuelve la fila
   * completa**. Modificar la dirección ajena con cualquier cuerpo válido
   * respondía con el nombre, el DNI, el teléfono y la calle de la víctima.
   *
   * El camino de checkout —`direccionParaEnviar`— sí estaba atado y sigue
   * estándolo: se verificó que el `userId` va primero en el WHERE.
   */
  async function direccionDe(token: string) {
    const r = await call('GET', '/api/v1/addresses', { token });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lista = (r.body.items ?? r.body) as Array<{ id: string }>;
    const primera = lista[0];
    if (!primera) throw new Error('el comprador tendría que tener una dirección');
    return primera.id;
  }

  it('⛔ nadie modifica la dirección de otro', async () => {
    const duenio = await nuevoComprador();
    const intruso = await nuevoComprador();
    const suya = await direccionDe(duenio.token);

    const r = await call('PATCH', `/api/v1/addresses/${suya}`, {
      token: intruso.token,
      body: {
        recipientFullName: 'Quien Sea',
        documentType: 'DNI',
        documentNumber: '11111111',
        phoneE164: '+5491100000000',
        street: 'Otra',
        number: '1',
        city: 'CABA',
        province: 'Buenos Aires',
        postalCode: 'C1000',
        isDefault: false,
      },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(404);
    // Y sobre todo: la respuesta no puede traer los datos de la víctima.
    expect(JSON.stringify(r.body)).not.toContain('30123456');
    expect(JSON.stringify(r.body)).not.toContain('Corrientes');
  });

  it('⛔ nadie borra la dirección de otro', async () => {
    const duenio = await nuevoComprador();
    const intruso = await nuevoComprador();
    const suya = await direccionDe(duenio.token);

    const r = await call('DELETE', `/api/v1/addresses/${suya}`, { token: intruso.token });
    expect(r.status, JSON.stringify(r.body)).toBe(404);

    // Un borrado lógico exitoso pondría `deletedAt`. Se mira la base, no el
    // código de estado: el 404 podría llegar después de haber escrito.
    const fila = await prisma.userAddress.findUniqueOrThrow({ where: { id: suya } });
    expect(fila.deletedAt).toBeNull();
  });

  it('⛔ la dirección ajena no se modifica aunque el intento falle', async () => {
    const duenio = await nuevoComprador();
    const intruso = await nuevoComprador();
    const suya = await direccionDe(duenio.token);

    await call('PATCH', `/api/v1/addresses/${suya}`, {
      token: intruso.token,
      body: {
        recipientFullName: 'Quien Sea',
        documentType: 'DNI',
        documentNumber: '11111111',
        phoneE164: '+5491100000000',
        street: 'Otra',
        number: '1',
        city: 'CABA',
        province: 'Buenos Aires',
        postalCode: 'C1000',
        isDefault: false,
      },
    });

    const fila = await prisma.userAddress.findUniqueOrThrow({ where: { id: suya } });
    expect(fila.recipientFullName).toBe('Ana Pérez');
    expect(fila.street).toBe('Av. Corrientes');
  });

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
 * La URL exacta que se carga en el panel de Mercado Pago.
 *
 * Se arma con la constante y no con una cadena escrita a mano. La copia
 * literal fue justamente el defecto: el test decía
 * `/webhooks/orders/mercadopago` y pasaba en verde mientras el servidor real
 * servía `/api/webhooks/orders/mercadopago`, porque el helper de tests excluía
 * `webhooks/(.*)` del prefijo y `main.ts` sólo excluía dos rutas enumeradas.
 */
const URL_WEBHOOK = `/${RUTA_WEBHOOK_MERCADOPAGO}`;

/** Arma la cabecera `x-signature` como la manda Mercado Pago. */
async function firmar(params: {
  dataId: string;
  requestId: string;
  ts?: number;
  secret?: string;
}) {
  const { createHmac } = await import('node:crypto');
  const ts = params.ts ?? Math.floor(Date.now() / 1000);
  const manifest = `id:${params.dataId};request-id:${params.requestId};ts:${ts};`;
  const v1 = createHmac('sha256', params.secret ?? TEST_ENV.MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest('hex');
  return `ts=${ts},v1=${v1}`;
}

/**
 * Manda una notificación FIRMADA como lo hace Mercado Pago.
 *
 * La firma se calcula igual que del otro lado: sin esto, todos los tests de
 * webhook probarían nada más que el rechazo por firma inválida.
 *
 * `donde` decide si el `data.id` viaja en la query string —como en las
 * notificaciones reales— o sólo en el cuerpo, como en el simulador del panel.
 */
async function enviarWebhook(
  paymentId: string,
  notificationId: string,
  opts: { donde?: 'query' | 'body' | 'ambos'; idEnElCuerpo?: string } = {},
) {
  const donde = opts.donde ?? 'body';
  const requestId = `req-${notificationId}`;
  const firma = await firmar({ dataId: paymentId, requestId });

  const query = donde === 'query' || donde === 'ambos' ? `?data.id=${paymentId}&type=payment` : '';
  const idDelCuerpo =
    donde === 'query' ? undefined : (opts.idEnElCuerpo ?? paymentId);

  const res = await (app as NestFastifyApplication)
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: `${URL_WEBHOOK}${query}`,
      headers: {
        'content-type': 'application/json',
        'x-signature': firma,
        'x-request-id': requestId,
      },
      payload: {
        id: notificationId,
        type: 'payment',
        action: 'payment.updated',
        ...(idDelCuerpo ? { data: { id: idDelCuerpo } } : {}),
      },
    });

  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

/**
 * La confirmación de entrega con código.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL VENDEDOR YA NO DECIDE SOLO QUE ENTREGÓ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Entregado" es una afirmación sobre el mundo físico, y hasta acá la hacía
 * unilateralmente quien tiene interés en que sea cierta. Ahora hace falta un
 * código que sólo tiene el comprador.
 *
 * Lo que estos tests fijan: que el vendedor no pueda verlo, que no pueda
 * saltearlo, y que probando números se quede sin intentos.
 */
describe('Código de entrega', () => {
  /** Una orden confirmada y despachada, lista para entregar. */
  async function ordenDespachada() {
    const { variantId, sellerToken } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { status: 'approved' };
    await pagar(comprador.token, orden.body.id);

    for (const estado of ['PREPARING', 'READY_TO_SHIP', 'SHIPPED']) {
      const r = await call('PATCH', `/api/v1/seller/orders/${orden.body.id}/fulfillment`, {
        token: sellerToken,
        body: { status: estado },
      });
      expect(r.status, `${estado}: ${JSON.stringify(r.body)}`).toBe(200);
    }

    return { orderId: orden.body.id as string, compradorToken: comprador.token, sellerToken };
  }

  it('al despachar se emite el código y lo ve SÓLO el comprador', async () => {
    const { orderId, compradorToken } = await ordenDespachada();

    const vista = await call('GET', `/api/v1/orders/${orderId}`, { token: compradorToken });

    expect(vista.status).toBe(200);
    expect(vista.body.deliveryCode).toMatch(/^[0-9]{6}$/);
    expect(vista.body.deliveryCodeIssuedAt).toBeTruthy();
    expect(vista.body.shippedAt).toBeTruthy();
  });

  it('⛔ el vendedor NO puede ver el código en ninguna de sus respuestas', async () => {
    /**
     * Es el punto entero del mecanismo. Si pudiera leerlo, podría marcar
     * entregado sin haber entregado y no serviría para nada.
     */
    const { orderId, sellerToken } = await ordenDespachada();

    const lista = await call('GET', '/api/v1/seller/orders', { token: sellerToken });
    expect(JSON.stringify(lista.body)).not.toContain('deliveryCode');

    const detalle = await call('GET', `/api/v1/seller/orders/${orderId}`, { token: sellerToken });
    if (detalle.status === 200) {
      expect(JSON.stringify(detalle.body)).not.toContain('deliveryCode');
    }
  });

  it('⛔ el vendedor NO puede marcar entregado por el camino de siempre', async () => {
    const { orderId, sellerToken } = await ordenDespachada();

    const r = await call('PATCH', `/api/v1/seller/orders/${orderId}/fulfillment`, {
      token: sellerToken,
      body: { status: 'DELIVERED' },
    });

    // El DTO ni siquiera acepta ese valor: es la primera barrera.
    expect(r.status).toBe(400);

    const orden = await prisma.order.findUnique({ where: { id: orderId } });
    expect(orden?.status).toBe('SHIPPED');
    expect(orden?.deliveredAt).toBeNull();
  });

  it('con el código correcto, el pedido queda entregado', async () => {
    const { orderId, compradorToken, sellerToken } = await ordenDespachada();

    const vista = await call('GET', `/api/v1/orders/${orderId}`, { token: compradorToken });
    const codigo = vista.body.deliveryCode as string;

    const r = await call('POST', `/api/v1/seller/orders/${orderId}/delivery-confirmation`, {
      token: sellerToken,
      body: { code: codigo },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('DELIVERED');

    const orden = await prisma.order.findUnique({ where: { id: orderId } });
    expect(orden?.deliveredAt).not.toBeNull();
    expect(orden?.deliveryCodeAttempts).toBe(0);
  });

  it('confirmar dos veces con el mismo código no rompe', async () => {
    const { orderId, compradorToken, sellerToken } = await ordenDespachada();
    const vista = await call('GET', `/api/v1/orders/${orderId}`, { token: compradorToken });
    const codigo = vista.body.deliveryCode as string;

    const url = `/api/v1/seller/orders/${orderId}/delivery-confirmation`;
    await call('POST', url, { token: sellerToken, body: { code: codigo } });
    const segunda = await call('POST', url, { token: sellerToken, body: { code: codigo } });

    // El repartidor puede tocar dos veces con mala señal.
    expect(segunda.status).toBe(201);
    expect(segunda.body.status).toBe('DELIVERED');

    // Y una sola marca de entrega en la bitácora.
    const entregas = await prisma.auditLog.count({
      where: { entityId: orderId, action: 'order.delivered' },
    });
    expect(entregas).toBe(1);
  });

  it('⛔ un código equivocado no entrega y descuenta un intento', async () => {
    const { orderId, sellerToken } = await ordenDespachada();

    const r = await call('POST', `/api/v1/seller/orders/${orderId}/delivery-confirmation`, {
      token: sellerToken,
      body: { code: '000000' },
    });

    expect(r.status).toBe(422);

    const orden = await prisma.order.findUnique({ where: { id: orderId } });
    expect(orden?.status).toBe('SHIPPED');
    expect(orden?.deliveredAt).toBeNull();
    expect(orden?.deliveryCodeAttempts).toBe(1);
  });

  it('⛔ probar números agota los intentos y bloquea', async () => {
    const { orderId, compradorToken, sellerToken } = await ordenDespachada();
    const url = `/api/v1/seller/orders/${orderId}/delivery-confirmation`;

    // Cinco intentos con números inventados.
    for (let i = 0; i < 5; i++) {
      await call('POST', url, { token: sellerToken, body: { code: '000000' } });
    }

    const orden = await prisma.order.findUnique({ where: { id: orderId } });
    expect(orden?.deliveryCodeLockedUntil).not.toBeNull();

    // Y ahora ni el correcto pasa: si pasara, alcanzaría con esperar y seguir
    // probando de a cinco.
    const vista = await call('GET', `/api/v1/orders/${orderId}`, { token: compradorToken });
    const r = await call('POST', url, {
      token: sellerToken,
      body: { code: vista.body.deliveryCode as string },
    });

    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain('LOCKED');
  });

  it('cada intento fallido queda en la bitácora, sin el código probado', async () => {
    const { orderId, sellerToken } = await ordenDespachada();

    await call('POST', `/api/v1/seller/orders/${orderId}/delivery-confirmation`, {
      token: sellerToken,
      body: { code: '111111' },
    });

    const fallidos = await prisma.auditLog.findMany({
      where: { entityId: orderId, action: 'order.delivery_code_failed' },
    });

    expect(fallidos).toHaveLength(1);
    // Guardar los intentos de adivinar un secreto al lado del secreto sería
    // dejar la respuesta escrita en el margen.
    expect(JSON.stringify(fallidos[0])).not.toContain('111111');
  });

  it('⛔ un vendedor no puede confirmar la entrega de otro', async () => {
    const { orderId, compradorToken } = await ordenDespachada();
    const otro = await nuevaVarianteConStock(1);

    const vista = await call('GET', `/api/v1/orders/${orderId}`, { token: compradorToken });

    const r = await call('POST', `/api/v1/seller/orders/${orderId}/delivery-confirmation`, {
      token: otro.sellerToken,
      body: { code: vista.body.deliveryCode as string },
    });

    // 404 y no 403: la pertenencia va en el WHERE, así que la orden ajena no
    // se encuentra.
    expect(r.status).toBe(404);
  });

  it('⛔ el código NO está en claro en la base', async () => {
    /**
     * Lo que este test protege es el respaldo de la base, la réplica y el
     * volcado que alguien hizo para depurar. Con el código en claro en la
     * columna, todos los pedidos en camino quedan confirmables por quien tenga
     * ese archivo.
     *
     * No protege contra alguien con acceso al proceso —la llave está ahí— y no
     * es la defensa principal, que sigue siendo que el vendedor nunca lo ve.
     */
    const { orderId, compradorToken } = await ordenDespachada();

    const vista = await call('GET', `/api/v1/orders/${orderId}`, { token: compradorToken });
    const codigo = vista.body.deliveryCode as string;
    expect(codigo).toMatch(/^[0-9]{6}$/);

    const fila = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { deliveryCode: true },
    });

    expect(fila.deliveryCode).not.toBe(codigo);
    expect(fila.deliveryCode).not.toContain(codigo);
    expect(fila.deliveryCode?.startsWith('v1.')).toBe(true);
  });

  it('⛔ el código no aparece en claro en NINGUNA columna de la orden', async () => {
    /**
     * El test de arriba mira una columna. Este mira la fila entera, por si el
     * código termina de rebote en otro lado —una instantánea, un motivo de
     * estado, un JSON de auditoría— donde nadie lo buscaría.
     */
    const { orderId, compradorToken } = await ordenDespachada();
    const vista = await call('GET', `/api/v1/orders/${orderId}`, { token: compradorToken });
    const codigo = vista.body.deliveryCode as string;

    const fila = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(JSON.stringify(fila)).not.toContain(codigo);

    const bitacora = await prisma.auditLog.findMany({ where: { entityId: orderId } });
    expect(JSON.stringify(bitacora)).not.toContain(codigo);
  });

  it('después de entregado, el comprador ya no ve el código', async () => {
    /**
     * Terminada la entrega el código no sirve para nada, y la pantalla del
     * pedido se vuelve a abrir: para calificar la compra, para pedir un cambio.
     * Dejar un secreto inútil a la vista es exponerlo sin ganar nada.
     */
    const { orderId, compradorToken, sellerToken } = await ordenDespachada();
    const antes = await call('GET', `/api/v1/orders/${orderId}`, { token: compradorToken });
    expect(antes.body.deliveryCode).toMatch(/^[0-9]{6}$/);

    const r = await call('POST', `/api/v1/seller/orders/${orderId}/delivery-confirmation`, {
      token: sellerToken,
      body: { code: antes.body.deliveryCode as string },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const despues = await call('GET', `/api/v1/orders/${orderId}`, { token: compradorToken });
    expect(despues.body.status).toBe('DELIVERED');
    expect(despues.body.deliveryCode).toBeNull();
  });

  it('un código viejo, guardado en claro, se sigue pudiendo usar', async () => {
    /**
     * Los pedidos despachados antes del cifrado tienen seis dígitos en la
     * columna. No se migran, y sin compatibilidad hacia atrás quedarían
     * inconfirmables: el comprador vería un error donde antes veía su número y
     * el vendedor no podría cerrar la entrega.
     *
     * Se simula escribiendo la columna a mano, que es exactamente el estado en
     * que quedaron esas filas.
     */
    const { orderId, compradorToken, sellerToken } = await ordenDespachada();

    await prisma.order.update({
      where: { id: orderId },
      data: { deliveryCode: '004821' },
    });

    const vista = await call('GET', `/api/v1/orders/${orderId}`, { token: compradorToken });
    // Incluidos los ceros a la izquierda.
    expect(vista.body.deliveryCode).toBe('004821');

    const r = await call('POST', `/api/v1/seller/orders/${orderId}/delivery-confirmation`, {
      token: sellerToken,
      body: { code: '004821' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('DELIVERED');
  });

  it('⛔ un código con formato raro no consume intentos', async () => {
    const { orderId, sellerToken } = await ordenDespachada();

    const r = await call('POST', `/api/v1/seller/orders/${orderId}/delivery-confirmation`, {
      token: sellerToken,
      body: { code: 'abc' },
    });

    expect(r.status).toBe(400);

    // Gastar intentos de un vendedor legítimo por un cuerpo mal formado sería
    // castigarlo por nada.
    const orden = await prisma.order.findUnique({ where: { id: orderId } });
    expect(orden?.deliveryCodeAttempts).toBe(0);
  });

  it('las marcas de tiempo de la preparación quedan registradas', async () => {
    const { orderId } = await ordenDespachada();

    const orden = await prisma.order.findUnique({ where: { id: orderId } });

    // El estado dice dónde está el pedido; estas marcas dicen cuánto tardó cada
    // paso, que es lo que después permite hablar de demoras sin inventar.
    expect(orden?.preparingAt).not.toBeNull();
    expect(orden?.readyAt).not.toBeNull();
    expect(orden?.shippedAt).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ENVÍO Y COSTO DEL PROCESADOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Los tres números que ve el comprador antes de pagar.
 *
 * El total no es el precio del producto: es producto + envío + recargo del
 * medio de pago. Cada uno sale de una regla distinta y **ninguno del cliente**.
 * Un error acá no es cosmético: es plata que alguien paga de más, o un vendedor
 * que despacha un paquete que nadie le pagó.
 */
describe('Envío y costo del procesador', () => {
  /** Deja la política de la tienda como la dejaría el vendedor desde la app. */
  async function definirPolitica(
    sellerToken: string,
    storeId: string,
    body: Record<string, unknown>,
  ) {
    return call('PATCH', `/api/v1/stores/${storeId}/shipping`, { token: sellerToken, body });
  }

  async function tiendaDe(sellerToken: string) {
    const r = await call('GET', '/api/v1/stores/me', { token: sellerToken });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  }

  it('por omisión no cobra envío ni recargo: el total es el producto', async () => {
    const { variantId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);

    const r = await crearOrden(comprador.token, reservationId);

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.itemsSubtotal).toBe(890_000);
    expect(r.body.shippingAmount).toBe(0);
    expect(r.body.processorSurchargeAmount).toBe(0);
    expect(r.body.grossAmount).toBe(890_000);
    expect(r.body.shippingModeSnapshot).toBe('FREE');
    expect(r.body.processorFeeModeSnapshot).toBe('ABSORBED');
  });

  it('con envío fijo, el total lo incluye', async () => {
    const { sellerToken, variantId } = await nuevaVarianteConStock(3);
    const storeId = await tiendaDe(sellerToken);

    const politica = await definirPolitica(sellerToken, storeId, {
      shippingMode: 'FIXED_PRICE',
      shippingFlatAmount: 350_000,
      processorFeeMode: 'ABSORBED',
    });
    expect(politica.status, JSON.stringify(politica.body)).toBe(200);

    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);
    const r = await crearOrden(comprador.token, reservationId);

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.shippingAmount).toBe(350_000);
    expect(r.body.grossAmount).toBe(890_000 + 350_000);
    expect(r.body.shippingModeSnapshot).toBe('FIXED_PRICE');
  });

  it('⛔ decir que se retira NO saltea el envío si la tienda no ofrece retiro', async () => {
    /**
     * Es la defensa entera de este bloque. Si el cuerpo de la petición pudiera
     * decidirlo, alcanzaría con un campo para no pagar el envío — y el vendedor
     * despacharía un paquete que nadie le pagó.
     */
    const { sellerToken, variantId } = await nuevaVarianteConStock(3);
    const storeId = await tiendaDe(sellerToken);
    await definirPolitica(sellerToken, storeId, {
      shippingMode: 'FIXED_PRICE',
      shippingFlatAmount: 350_000,
      processorFeeMode: 'ABSORBED',
    });

    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);
    const r = await crearOrden(comprador.token, reservationId, { retiraEnPersona: true });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.shippingAmount).toBe(350_000);
    expect(r.body.pickupSelected).toBe(false);
    expect(r.body.grossAmount).toBe(890_000 + 350_000);
  });

  it('con las dos opciones, retirar sale cero y queda marcado', async () => {
    const { sellerToken, variantId } = await nuevaVarianteConStock(3);
    const storeId = await tiendaDe(sellerToken);
    await definirPolitica(sellerToken, storeId, {
      shippingMode: 'FIXED_OR_PICKUP',
      shippingFlatAmount: 350_000,
      processorFeeMode: 'ABSORBED',
    });

    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);
    const r = await crearOrden(comprador.token, reservationId, { retiraEnPersona: true });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.shippingAmount).toBe(0);
    // ⚠️ No se deduce de `shippingAmount === 0`: hay tiendas con envío gratis.
    // El vendedor tiene que saber que NO despache.
    expect(r.body.pickupSelected).toBe(true);
    expect(r.body.grossAmount).toBe(890_000);
  });

  it('con las dos opciones, no retirar cobra el envío', async () => {
    const { sellerToken, variantId } = await nuevaVarianteConStock(3);
    const storeId = await tiendaDe(sellerToken);
    await definirPolitica(sellerToken, storeId, {
      shippingMode: 'FIXED_OR_PICKUP',
      shippingFlatAmount: 350_000,
      processorFeeMode: 'ABSORBED',
    });

    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);
    const r = await crearOrden(comprador.token, reservationId);

    expect(r.body.shippingAmount).toBe(350_000);
    expect(r.body.pickupSelected).toBe(false);
  });

  it('⛔ en la beta el comprador NO paga recargo por el medio de pago', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ESTE TEST CAMBIÓ DE SIGNO A PROPÓSITO
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Antes verificaba que el recargo se calculara sobre producto + envío.
     * Sigue calculándose así —el test de `shipping.spec.ts` lo fija— pero
     * `BUYER_PROCESSOR_SURCHARGE_ENABLED` está en `false` y el comprador paga
     * producto + envío y nada más.
     *
     * El motivo no es técnico: el número que se trasladaba era una ESTIMACIÓN
     * calculada antes de que Mercado Pago dijera cuánto va a cobrar de verdad.
     * Cobrar un costo estimado de un tercero, y quedarse con la diferencia
     * cuando el real resulta menor, es exactamente el tipo de recargo que la
     * ley de defensa del consumidor mira con lupa.
     *
     * La tienda de este test tiene `PASSED_TO_BUYER` guardado a propósito: es
     * la comprobación de que la bandera del servidor gana sobre la
     * configuración del vendedor.
     */
    const { sellerToken, variantId } = await nuevaVarianteConStock(3);
    const storeId = await tiendaDe(sellerToken);
    await definirPolitica(sellerToken, storeId, {
      shippingMode: 'FIXED_PRICE',
      shippingFlatAmount: 350_000,
      processorFeeMode: 'PASSED_TO_BUYER',
    });

    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);
    const r = await crearOrden(comprador.token, reservationId);

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.processorSurchargeAmount).toBe(0);
    // Producto + envío. Nada más.
    expect(r.body.grossAmount).toBe(890_000 + 350_000);

    /**
     * El snapshot guarda lo que la tienda tenía configurado, no lo que se
     * aplicó.
     *
     * Es el registro de la política vigente al comprar, y sirve para explicar
     * un pedido viejo dentro de dos años. Que el importe haya sido cero lo dice
     * `processorSurchargeAmount`.
     */
    expect(r.body.processorFeeModeSnapshot).toBe('PASSED_TO_BUYER');
  });

  it('⛔ el catálogo tampoco anuncia un recargo que no se va a cobrar', async () => {
    /**
     * La app usa `trasladaCostoDelProcesador` para avisarle al comprador
     * "puede sumarse un costo por el medio de pago". Dejarlo en `true` con el
     * cálculo apagado sería anunciar un cargo que después no aparece: la
     * persona desconfía del total y el vendedor queda mal por algo que no hizo.
     */
    const { sellerToken, productId } = await nuevaVarianteConStock(3);
    const storeId = await tiendaDe(sellerToken);
    await definirPolitica(sellerToken, storeId, {
      shippingMode: 'FIXED_PRICE',
      shippingFlatAmount: 350_000,
      processorFeeMode: 'PASSED_TO_BUYER',
    });

    const publico = await call('GET', `/api/v1/catalog/products/${productId}`);

    expect(publico.status).toBe(200);
    expect(publico.body.envio.trasladaCostoDelProcesador).toBe(false);
  });

  it('⛔ la comisión del 6 % NO se cobra sobre el envío ni sobre el recargo', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * DECISIÓN COMERCIAL, NO UN DETALLE DE CÁLCULO
     * ═══════════════════════════════════════════════════════════════════════
     *
     * VendoX cobra 6 % **sobre lo que se vendió**, no sobre lo que se movió.
     *
     * El envío es plata que el vendedor cobra y le entrega a un tercero para
     * despachar el paquete: no es ingreso suyo. Cobrarle comisión sobre eso
     * sería cobrarle por gastar. Y el recargo del procesador existe justamente
     * para cubrir lo que Mercado Pago le va a descontar; cobrarle 6 % encima
     * haría que trasladar el costo le siga saliendo plata.
     *
     * Es distinto del costo del procesador, cuya base SÍ es producto + envío:
     * Mercado Pago cobra sobre todo lo que pasa por él, y esa base la define
     * Mercado Pago, no nosotros.
     *
     * Este test existe para que, si alguien "arregla" el cálculo para que la
     * comisión salga del bruto, se entere de que está cambiando el modelo de
     * negocio y no corrigiendo un bug.
     */
    const { sellerToken, variantId } = await nuevaVarianteConStock(3);
    const storeId = await tiendaDe(sellerToken);
    await definirPolitica(sellerToken, storeId, {
      shippingMode: 'FIXED_PRICE',
      shippingFlatAmount: 350_000,
      processorFeeMode: 'PASSED_TO_BUYER',
    });

    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);
    const r = await crearOrden(comprador.token, reservationId);

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.platformFeeBps).toBe(600);

    // 6 % de 890.000 = 53.400. NO de 1.316.756.
    expect(r.body.platformFeeAmount).toBe(53_400);

    // El vendedor se queda con el envío entero y con el recargo entero: los va
    // a gastar en el correo y en Mercado Pago.
    expect(r.body.sellerNetAmount).toBe((r.body.grossAmount as number) - 53_400);
  });

  it('cambiar la política después NO le cambia el total a quien ya compró', async () => {
    /**
     * Es el motivo entero de las fotos. Quien pagó $12.400 con envío incluido
     * tiene que seguir viendo $12.400 con envío incluido para siempre, aunque
     * mañana la tienda pase a retiro únicamente.
     */
    const { sellerToken, variantId } = await nuevaVarianteConStock(3);
    const storeId = await tiendaDe(sellerToken);
    await definirPolitica(sellerToken, storeId, {
      shippingMode: 'FIXED_PRICE',
      shippingFlatAmount: 350_000,
      processorFeeMode: 'ABSORBED',
    });

    const comprador = await nuevoComprador();
    const reservationId = await reservar(comprador.token, variantId);
    const r = await crearOrden(comprador.token, reservationId);
    const totalOriginal = r.body.grossAmount as number;

    await definirPolitica(sellerToken, storeId, {
      shippingMode: 'PICKUP_ONLY',
      shippingFlatAmount: 0,
      processorFeeMode: 'PASSED_TO_BUYER',
    });

    const releida = await call('GET', `/api/v1/orders/${r.body.id}`, { token: comprador.token });
    expect(releida.status, JSON.stringify(releida.body)).toBe(200);
    expect(releida.body.grossAmount).toBe(totalOriginal);
    expect(releida.body.shippingAmount).toBe(350_000);
    expect(releida.body.shippingModeSnapshot).toBe('FIXED_PRICE');
    expect(releida.body.processorFeeModeSnapshot).toBe('ABSORBED');
  });

  describe('Definir la política', () => {
    it('cobrar envío exige un monto', async () => {
      const { sellerToken } = await nuevaVarianteConStock(1);
      const storeId = await tiendaDe(sellerToken);

      const r = await definirPolitica(sellerToken, storeId, {
        shippingMode: 'FIXED_PRICE',
        shippingFlatAmount: 0,
        processorFeeMode: 'ABSORBED',
      });

      expect(r.status, JSON.stringify(r.body)).toBe(400);
    });

    it('no cobrar envío exige que no haya monto', async () => {
      const { sellerToken } = await nuevaVarianteConStock(1);
      const storeId = await tiendaDe(sellerToken);

      const r = await definirPolitica(sellerToken, storeId, {
        shippingMode: 'FREE',
        shippingFlatAmount: 350_000,
        processorFeeMode: 'ABSORBED',
      });

      expect(r.status, JSON.stringify(r.body)).toBe(400);
    });

    it('⛔ no se puede tocar la política de otra tienda', async () => {
      const propia = await nuevaVarianteConStock(1);
      const ajena = await nuevaVarianteConStock(1);
      const storeAjena = await tiendaDe(ajena.sellerToken);

      const r = await definirPolitica(propia.sellerToken, storeAjena, {
        shippingMode: 'FREE',
        shippingFlatAmount: 0,
        processorFeeMode: 'ABSORBED',
      });

      // 404 y no 403: confirmar que la tienda existe ya es información.
      expect(r.status, JSON.stringify(r.body)).toBe(404);
    });

    it('la vidriera pública muestra el envío antes del checkout', async () => {
      const { sellerToken } = await nuevaVarianteConStock(1);
      const storeId = await tiendaDe(sellerToken);
      await definirPolitica(sellerToken, storeId, {
        shippingMode: 'FIXED_OR_PICKUP',
        shippingFlatAmount: 350_000,
        shippingNote: 'Envíos los martes y jueves a CABA y GBA',
        processorFeeMode: 'ABSORBED',
      });

      const tienda = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
      const r = await call('GET', `/api/v1/stores/by-slug/${tienda.slug}`);

      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.envio.costoEnvio).toBe(350_000);
      expect(r.body.envio.permiteRetiro).toBe(true);
      expect(r.body.envio.permiteEnvio).toBe(true);
      expect(r.body.envio.etiquetaEnvio).toBe('Envío');
      expect(r.body.envio.shippingNote).toBe('Envíos los martes y jueves a CABA y GBA');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CAMBIOS Y DEVOLUCIONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El piso legal, extremo a extremo.
 *
 * El módulo puro ya prueba las reglas. Lo que se prueba acá es que esas reglas
 * lleguen hasta el HTTP y hasta la base: que el endpoint las rechace, que el
 * CHECK las rechace, y que el comprador vea el derecho de arrepentimiento antes
 * de pagar aunque el vendedor no haya elegido nada.
 */
describe('Cambios y devoluciones', () => {
  async function tiendaDe(sellerToken: string) {
    const r = await call('GET', '/api/v1/stores/me', { token: sellerToken });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  }

  async function definir(sellerToken: string, storeId: string, body: Record<string, unknown>) {
    return call('PATCH', `/api/v1/stores/${storeId}/exchange-policy`, {
      token: sellerToken,
      body,
    });
  }

  it('una tienda nueva ya ofrece el mínimo legal, sin configurar nada', async () => {
    /**
     * Es lo que evita que exista una tienda publicada sin política. El default
     * de la columna no es una comodidad: es la diferencia entre "todavía no lo
     * configuró" y "no ofrece devoluciones", que legalmente no es una opción.
     */
    const { sellerToken } = await nuevaVarianteConStock(1);
    const storeId = await tiendaDe(sellerToken);

    const tienda = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
    expect(tienda.exchangeMode).toBe('SOLO_LEGAL');
    expect(tienda.exchangeWindowDays).toBe(10);
    expect(tienda.returnShippingPaidBy).toBe('VENDEDOR');
  });

  it('⛔ el endpoint rechaza menos de diez días', async () => {
    const { sellerToken } = await nuevaVarianteConStock(1);
    const storeId = await tiendaDe(sellerToken);

    const r = await definir(sellerToken, storeId, {
      exchangeMode: 'SOLO_LEGAL',
      exchangeWindowDays: 3,
      returnShippingPaidBy: 'VENDEDOR',
    });

    expect(r.status, JSON.stringify(r.body)).toBe(400);
  });

  it('⛔ el arrepentimiento puro no puede cobrarle el envío al comprador', async () => {
    const { sellerToken } = await nuevaVarianteConStock(1);
    const storeId = await tiendaDe(sellerToken);

    const r = await definir(sellerToken, storeId, {
      exchangeMode: 'SOLO_LEGAL',
      exchangeWindowDays: 10,
      returnShippingPaidBy: 'COMPRADOR',
    });

    // 422 y no 400: el cuerpo está bien formado, lo que falla es una regla.
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error.code).toBe('EXCHANGE_POLICY_INVALID');
  });

  it('⛔ la base tampoco lo deja pasar por afuera del endpoint', async () => {
    /**
     * El CHECK cubre un UPDATE escrito a mano en una consola de producción, que
     * es el camino que ninguna validación de aplicación ve. No es redundancia
     * por miedo: es la única capa que sigue estando cuando alguien se salta el
     * backend.
     */
    const { sellerToken } = await nuevaVarianteConStock(1);
    const storeId = await tiendaDe(sellerToken);

    await expect(
      prisma.store.update({ where: { id: storeId }, data: { exchangeWindowDays: 2 } }),
    ).rejects.toThrow();

    await expect(
      prisma.store.update({
        where: { id: storeId },
        data: { exchangeMode: 'SOLO_LEGAL', returnShippingPaidBy: 'COMPRADOR' },
      }),
    ).rejects.toThrow();
  });

  it('el vendedor puede ofrecer más', async () => {
    const { sellerToken } = await nuevaVarianteConStock(1);
    const storeId = await tiendaDe(sellerToken);

    const r = await definir(sellerToken, storeId, {
      exchangeMode: 'DEVOLUCION_SIN_CAUSA',
      exchangeWindowDays: 30,
      returnShippingPaidBy: 'VENDEDOR',
      exchangeNote: 'Con la etiqueta puesta y sin uso.',
    });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.exchangeWindowDays).toBe(30);
    expect(r.body.diasEfectivos).toBe(30);
    expect(r.body.resumen.lineas.join(' ')).toContain('30 días');
  });

  it('⛔ no se puede tocar la política de otra tienda', async () => {
    const propia = await nuevaVarianteConStock(1);
    const ajena = await nuevaVarianteConStock(1);
    const storeAjena = await tiendaDe(ajena.sellerToken);

    const r = await definir(propia.sellerToken, storeAjena, {
      exchangeMode: 'SOLO_LEGAL',
      exchangeWindowDays: 10,
      returnShippingPaidBy: 'VENDEDOR',
    });

    expect(r.status, JSON.stringify(r.body)).toBe(404);
  });

  it('el comprador ve el derecho de arrepentimiento antes de pagar', async () => {
    /**
     * La Resolución 424/2020 pide que el botón de arrepentimiento sea visible y
     * fácil de encontrar. El texto sale del backend y no de Flutter para que
     * diga exactamente lo mismo en la app, en el detalle del pedido y en el
     * mail: tres textos escritos por separado terminan diciendo tres cosas, y
     * la que vale legalmente es la más favorable al comprador.
     */
    const { sellerToken } = await nuevaVarianteConStock(1);
    const storeId = await tiendaDe(sellerToken);
    const tienda = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });

    const r = await call('GET', `/api/v1/stores/by-slug/${tienda.slug}`);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.cambios.diasEfectivos).toBe(10);
    expect(r.body.cambios.resumen.derechoDeArrepentimiento).toContain('10 días corridos');
    expect(r.body.cambios.resumen.derechoDeArrepentimiento).toContain('sin costo');
  });

  it('cambiar la política queda auditado con el antes y el después', async () => {
    // Si un comprador reclama que le prometieron treinta días, esto es lo único
    // que reconstruye qué decía la publicación cuando compró.
    const { sellerToken } = await nuevaVarianteConStock(1);
    const storeId = await tiendaDe(sellerToken);

    await definir(sellerToken, storeId, {
      exchangeMode: 'DEVOLUCION_SIN_CAUSA',
      exchangeWindowDays: 30,
      returnShippingPaidBy: 'VENDEDOR',
    });

    const registro = await prisma.auditLog.findFirst({
      where: { action: 'store.exchange_policy_updated', entityId: storeId },
      orderBy: { createdAt: 'desc' },
    });

    expect(registro).not.toBeNull();
    const antes = registro?.before as Record<string, unknown>;
    const despues = registro?.after as Record<string, unknown>;
    expect(antes.exchangeWindowDays).toBe(10);
    expect(despues.exchangeWindowDays).toBe(30);
  });
});
// ═══════════════════════════════════════════════════════════════════════════
// VENDOX ES 18+
// ═══════════════════════════════════════════════════════════════════════════

/**
 * La mayoría de edad, de punta a punta.
 *
 * Los tests unitarios prueban la aritmética. Estos prueban que esté enchufada
 * donde tiene que estar, por HTTP: una regla correcta que nadie llama es
 * exactamente igual de útil que no tenerla.
 *
 * ─── Lo que NO prueban ───
 *
 * Que la edad sea cierta. Es declarada y no hay verificación contra ningún
 * registro. Está explicado en `users/edad.ts` y conviene leerlo antes de decir
 * en algún lado que la edad está comprobada.
 */
describe('Mayoría de edad', () => {
  /** Alguien recién registrado, sin fecha declarada. */
  async function recienLlegado() {
    const usuario = await nuevoUsuario({ conEdad: false });
    const r = await call('POST', '/api/v1/addresses', {
      token: usuario.token,
      body: {
        recipientFullName: 'Ana Pérez',
        documentType: 'DNI',
        documentNumber: '30123456',
        phoneE164: '+5491122334455',
        street: 'Av. Corrientes',
        number: '1234',
        city: 'CABA',
        province: 'Buenos Aires',
        postalCode: 'C1043',
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return usuario;
  }

  it('⛔ sin fecha declarada no se puede comprar', async () => {
    const comprador = await recienLlegado();
    const { variantId } = await nuevaVarianteConStock(3);
    const reservationId = await reservar(comprador.token, variantId);

    const r = await call('POST', '/api/v1/orders', {
      token: comprador.token,
      idempotencyKey: clave('edad-falta'),
      body: { reservationId },
    });

    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('BIRTH_DATE_REQUIRED');
    // El mensaje dice para qué se pide, no sólo que falta.
    expect(r.body.error.message).toContain('18');
  });

  it('⛔ un menor no puede comprar', async () => {
    const comprador = await recienLlegado();

    const perfil = await call('PATCH', '/api/v1/auth/me', {
      token: comprador.token,
      body: { birthDate: '2012-06-01' },
    });
    expect(perfil.status, JSON.stringify(perfil.body)).toBe(200);

    const { variantId } = await nuevaVarianteConStock(3);
    const reservationId = await reservar(comprador.token, variantId);

    const r = await call('POST', '/api/v1/orders', {
      token: comprador.token,
      idempotencyKey: clave('edad-menor'),
      body: { reservationId },
    });

    /**
     * 403 y no 422: a diferencia de la fecha que falta, esto NO se resuelve
     * completando un formulario. Un 422 haría que la app volviera a abrirlo en
     * un bucle.
     */
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('UNDERAGE');
    expect(r.body.error.message).toContain('requisito legal');
  });

  it('declarando la fecha, el mismo comprador sí puede', async () => {
    // La contracara. Sin esto, "arreglar" el bloqueo rechazando siempre pasaría
    // en verde.
    const comprador = await recienLlegado();
    await call('PATCH', '/api/v1/auth/me', {
      token: comprador.token,
      body: { birthDate: '1990-05-20' },
    });

    const { variantId } = await nuevaVarianteConStock(3);
    const reservationId = await reservar(comprador.token, variantId);

    const r = await call('POST', '/api/v1/orders', {
      token: comprador.token,
      idempotencyKey: clave('edad-ok'),
      body: { reservationId },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('⛔ la fecha se declara una vez y no se puede cambiar', async () => {
    /**
     * Si se pudiera, la regla no existiría: alguien pone una fecha cualquiera,
     * la app lo frena, y vuelve a la pantalla a poner otra. Sería un formulario
     * que enseña cuál es la respuesta correcta.
     */
    const usuario = await nuevoUsuario({ conEdad: false });

    const primera = await call('PATCH', '/api/v1/auth/me', {
      token: usuario.token,
      body: { birthDate: '2012-06-01' },
    });
    expect(primera.status).toBe(200);

    const segunda = await call('PATCH', '/api/v1/auth/me', {
      token: usuario.token,
      body: { birthDate: '1990-05-20' },
    });

    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('BIRTH_DATE_ALREADY_SET');
    // Y dice a dónde ir: quien lee esto suele ser alguien que tipeó mal el año.
    expect(segunda.body.error.message).toContain('Ayuda');
  });

  it('mandar la MISMA fecha otra vez no es un error', async () => {
    // La app reintenta peticiones. Un reintento no puede convertirse en un
    // error que no existe.
    const usuario = await nuevoUsuario({ conEdad: false });
    const cuerpo = { birthDate: '1990-05-20' };

    expect((await call('PATCH', '/api/v1/auth/me', { token: usuario.token, body: cuerpo })).status)
      .toBe(200);
    expect((await call('PATCH', '/api/v1/auth/me', { token: usuario.token, body: cuerpo })).status)
      .toBe(200);
  });

  it('⛔ una fecha imposible se rechaza sin guardarse', async () => {
    const usuario = await nuevoUsuario({ conEdad: false });

    const r = await call('PATCH', '/api/v1/auth/me', {
      token: usuario.token,
      body: { birthDate: '2030-01-01' },
    });

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('BIRTH_DATE_INVALID');

    // Y como no se guardó, todavía puede declarar la correcta.
    const buena = await call('PATCH', '/api/v1/auth/me', {
      token: usuario.token,
      body: { birthDate: '1990-05-20' },
    });
    expect(buena.status).toBe(200);
  });

  it('⛔ un formato que no es AAAA-MM-DD ni llega al servicio', async () => {
    const usuario = await nuevoUsuario({ conEdad: false });

    const r = await call('PATCH', '/api/v1/auth/me', {
      token: usuario.token,
      body: { birthDate: '15/03/2008' },
    });

    // Lo frena el DTO: `new Date('15/03/2008')` da resultados distintos según
    // el servidor, así que la forma se exige antes de interpretar nada.
    expect(r.status).toBe(400);
  });

  it('la fecha vuelve en el perfil, sin hora', async () => {
    /**
     * `DATE` en la base, `AAAA-MM-DD` en la respuesta. Mandar el ISO entero
     * haría que la app en Buenos Aires —UTC-3— muestre el día anterior.
     */
    const usuario = await nuevoUsuario({ conEdad: false });
    await call('PATCH', '/api/v1/auth/me', {
      token: usuario.token,
      body: { birthDate: '1990-01-01' },
    });

    const me = await call('GET', '/api/v1/auth/me', { token: usuario.token });

    expect(me.body.birthDate).toBe('1990-01-01');
    expect(me.body.missing).not.toContain('birthDate');
  });

  it('el perfil avisa que falta antes de que la persona se choque', async () => {
    // Para que la app pueda pedirla en el momento oportuno en vez de esperar al
    // error en medio de la compra.
    const usuario = await nuevoUsuario({ conEdad: false });

    const me = await call('GET', '/api/v1/auth/me', { token: usuario.token });

    expect(me.body.missing).toContain('birthDate');
    expect(me.body.birthDate).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOS DATOS SON DE LA PERSONA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Exportación y cierre de cuenta.
 *
 * Los dos derechos que la Ley 25.326 obliga a dar: acceder a los propios datos
 * (art. 14) e irse (art. 16). Ninguno de los dos estaba resuelto de verdad:
 * la exportación no existía, y el cierre era un `DELETE` sin condiciones que
 * dejaba a un vendedor cobrar y desaparecer.
 */
describe('Derechos sobre los propios datos', () => {
  /** Un comprador con una compra entregada, para tener algo que exportar. */
  async function conHistorial() {
    const { variantId, sellerToken } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));

    proveedor.proximo = { status: 'approved' };
    await pagar(comprador.token, orden.body.id);

    return { comprador, orderId: orden.body.id as string, sellerToken };
  }

  describe('Exportar', () => {
    it('trae el perfil, las direcciones y las compras', async () => {
      const { comprador } = await conHistorial();

      const r = await call('GET', '/api/v1/auth/me/export', { token: comprador.token });

      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.usuario.id).toBe(comprador.userId);
      expect(r.body.direcciones.length).toBeGreaterThan(0);
      expect(r.body.compras.items.length).toBeGreaterThan(0);
      expect(r.body.compras.truncado).toBe(false);
      // Y avisa de qué se trata el archivo que se está bajando.
      expect(r.body.aviso).toContain('datos personales');
    });

    it('⛔ no trae ningún token ni secreto', async () => {
      /**
       * El test más importante de este bloque.
       *
       * Una exportación es el paquete más completo de datos personales que el
       * sistema produce, y es el lugar donde un `select` de más pasa
       * inadvertido: nadie revisa un JSON de doscientas líneas.
       *
       * Se busca sobre el texto entero, no sobre campos concretos: así también
       * falla si mañana alguien agrega una relación que arrastra un token.
       */
      const { comprador } = await conHistorial();

      const r = await call('GET', '/api/v1/auth/me/export', { token: comprador.token });
      const texto = JSON.stringify(r.body);

      for (const prohibido of [
        'APP_USR-', // access token de Mercado Pago
        'TG-', // refresh token de Mercado Pago
        'accessToken',
        'refreshToken',
        'pushToken',
        'ciphertext',
        'docNumberHash',
        'taxIdHash',
        'riskLevel',
      ]) {
        expect(texto.includes(prohibido), `no debería aparecer ${prohibido}`).toBe(false);
      }
    });

    it('⛔ no trae el `subject` de la identidad', async () => {
      /**
       * El `sub` de Google es el identificador estable con el que se inicia
       * sesión. A la persona no le sirve de nada y a quien le robe el archivo
       * le sirve muchísimo.
       */
      const { comprador } = await conHistorial();

      const r = await call('GET', '/api/v1/auth/me/export', { token: comprador.token });

      expect(JSON.stringify(r.body)).not.toContain('subject');
    });

    it('⛔ el vendedor NO se lleva la dirección de quien le compró', async () => {
      /**
       * Sus ventas son suyas; la dirección de entrega de quien compró, no. Que
       * alguien haya comprado en su tienda no le transfiere sus datos.
       *
       * Es el error clásico del "exportá todo lo relacionado": una consulta con
       * `include` y de golpe cada vendedor se puede bajar el domicilio de todos
       * sus clientes en un archivo.
       */
      const { sellerToken } = await conHistorial();

      const r = await call('GET', '/api/v1/auth/me/export', { token: sellerToken });

      expect(r.status).toBe(200);
      expect(r.body.ventas.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.body.ventas)).not.toContain('shippingAddress');
      expect(JSON.stringify(r.body.ventas)).not.toContain('Av. Corrientes');
    });

    it('el vendedor SÍ se lleva el registro de sus ventas', async () => {
      // La contracara: recortar de más sería no cumplir el pedido de acceso.
      const { sellerToken } = await conHistorial();

      const r = await call('GET', '/api/v1/auth/me/export', { token: sellerToken });
      const venta = r.body.ventas.items[0];

      expect(venta.reference).toBeTruthy();
      expect(venta.grossAmount).toBeGreaterThan(0);
      expect(venta.platformFeeAmount).toBeGreaterThanOrEqual(0);
      expect(venta.items.length).toBeGreaterThan(0);
      // Su tienda y sus productos también.
      expect(r.body.vendedor.stores.length).toBeGreaterThan(0);
      expect(r.body.vendedor.productos.length).toBeGreaterThan(0);
    });

    it('⛔ sin sesión no se exporta nada', async () => {
      const r = await call('GET', '/api/v1/auth/me/export');
      expect(r.status).toBe(401);
    });

    it('queda registrado que se exportó', async () => {
      /**
       * Si mañana el archivo aparece filtrado, la bitácora dice quién lo pidió
       * y cuándo. Y si alguna vez alguien lo pide con una sesión robada, es el
       * único rastro que va a quedar.
       */
      const { comprador } = await conHistorial();

      await call('GET', '/api/v1/auth/me/export', { token: comprador.token });

      const registros = await prisma.auditLog.count({
        where: { entityId: comprador.userId, action: 'user.data_exported' },
      });
      expect(registros).toBe(1);
    });
  });

  describe('Cerrar la cuenta', () => {
    it('⛔ un vendedor con una venta sin entregar no puede irse', async () => {
      /**
       * El agujero concreto: cobrar diez pedidos, tocar "eliminar cuenta" y
       * desaparecer. Diez personas con la plata puesta y del otro lado una
       * cuenta anonimizada sin forma de contactar a nadie.
       */
      const { sellerToken } = await conHistorial();

      const r = await call('DELETE', '/api/v1/auth/me', { token: sellerToken });

      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('ACCOUNT_HAS_OPEN_ORDERS');
      expect(r.body.error.message).toContain('ya pagaron');
      expect(r.body.error.details.ventasComoVendedor).toBeGreaterThan(0);
    });

    it('⛔ y su sesión NO se cierra cuando el cierre falla', async () => {
      /**
       * El orden de las dos operaciones importaba y estaba al revés: se
       * cerraban todas las sesiones y después se intentaba cerrar la cuenta.
       * La persona perdía el acceso a todos sus dispositivos sin conseguir lo
       * que había pedido.
       */
      const { sellerToken } = await conHistorial();

      const fallido = await call('DELETE', '/api/v1/auth/me', { token: sellerToken });
      expect(fallido.status).toBe(409);

      // El token sigue sirviendo.
      const me = await call('GET', '/api/v1/auth/me', { token: sellerToken });
      expect(me.status).toBe(200);
    });

    it('⛔ un comprador con un pedido en camino tampoco', async () => {
      const { comprador } = await conHistorial();

      const r = await call('DELETE', '/api/v1/auth/me', { token: comprador.token });

      expect(r.status).toBe(409);
      expect(r.body.error.message).toContain('Mis pedidos');
    });

    it('sin nada en curso, se cierra y se anonimiza', async () => {
      const usuario = await nuevoUsuario();

      const r = await call('DELETE', '/api/v1/auth/me', { token: usuario.token });
      expect(r.status, JSON.stringify(r.body)).toBe(200);

      const fila = await prisma.user.findUniqueOrThrow({ where: { id: usuario.userId } });
      expect(fila.status).toBe('deleted');
      expect(fila.deletedAt).not.toBeNull();
      expect(fila.email).toContain('cuenta.invalid');
      expect(fila.phoneE164).toBeNull();

      /**
       * Y la fecha de nacimiento también se va.
       *
       * Se olvidaba. Sola no identifica a nadie, pero cruzada con las órdenes
       * —que sobreviven, con la dirección de entrega adentro— sí.
       */
      expect(fila.birthDate).toBeNull();
      // La constancia de que se declaró queda: es el registro de que se
      // preguntó, y no dice nada sobre la persona.
      expect(fila.birthDateDeclaredAt).not.toBeNull();
    });

    it('⛔ y la dirección se vacía: DNI, teléfono y calle', async () => {
      /**
       * ═════════════════════════════════════════════════════════════════════
       * ERA EL DATO MÁS SENSIBLE Y ERA EL QUE SOBREVIVÍA ENTERO
       * ═════════════════════════════════════════════════════════════════════
       *
       * El cierre anonimizaba el `User` y dejaba `user_addresses` intacta: DNI
       * completo, teléfono, calle, número, piso y departamento de la casa de
       * alguien que pidió irse. Anonimizar la fila que apunta y no la que tiene
       * los datos no anonimiza nada.
       *
       * Este test lee la tabla directo, sin pasar por la API: por la API la
       * dirección no se ve igual —la cuenta está cerrada— y el bug se veía
       * exactamente ahí, en lo que quedaba escrito en el disco.
       */
      const comprador = await nuevoComprador();

      expect((await call('DELETE', '/api/v1/auth/me', { token: comprador.token })).status).toBe(200);

      const direcciones = await prisma.userAddress.findMany({
        where: { userId: comprador.userId },
      });
      expect(direcciones).toHaveLength(1);

      const d = direcciones[0]!;
      expect(d.documentNumber).toBe('');
      expect(d.phoneE164).toBe('');
      expect(d.street).toBe('');
      expect(d.number).toBe('');
      expect(d.floor).toBeNull();
      expect(d.apartment).toBeNull();
      expect(d.references).toBeNull();
      expect(d.deletedAt).not.toBeNull();

      // Y nada del contenido original quedó en ningún campo.
      const enTexto = JSON.stringify(d);
      for (const dato of ['30123456', '+5491122334455', 'Av. Corrientes', 'Ana Pérez', 'Portón negro']) {
        expect(enTexto).not.toContain(dato);
      }
    });

    it('una vez entregado el pedido, el vendedor sí puede irse', async () => {
      /**
       * El bloqueo es temporal, no una retención. Convertir "tenés un pedido en
       * camino" en "no te podés ir nunca" sería usar una regla legítima para
       * atrapar gente.
       */
      const { comprador, orderId, sellerToken } = await conHistorial();

      for (const estado of ['PREPARING', 'READY_TO_SHIP', 'SHIPPED']) {
        await call('PATCH', `/api/v1/seller/orders/${orderId}/fulfillment`, {
          token: sellerToken,
          body: { status: estado },
        });
      }
      const vista = await call('GET', `/api/v1/orders/${orderId}`, { token: comprador.token });
      await call('POST', `/api/v1/seller/orders/${orderId}/delivery-confirmation`, {
        token: sellerToken,
        body: { code: vista.body.deliveryCode as string },
      });

      const r = await call('DELETE', '/api/v1/auth/me', { token: sellerToken });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOQUEAR A ALGUIEN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El bloqueo entre personas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE HAY QUE GARANTIZAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dos cosas que tiran para lados opuestos:
 *
 *   · **que funcione** — quien bloquea deja de ver a la otra persona en el
 *     feed, y el chat se corta en los dos sentidos;
 *   · **que no se pueda usar como arma** — bloquear no puede tener
 *     consecuencias para quien es bloqueado, ni hacerle desaparecer la tienda,
 *     ni avisarle nada.
 *
 * Si lo primero falla, la función no sirve. Si falla lo segundo, se convierte
 * en una herramienta para sabotear competidores.
 */
describe('Bloqueo entre personas', () => {
  async function dosPersonas() {
    const a = await nuevoUsuario();
    const b = await nuevoUsuario();
    return { a, b };
  }

  it('bloquear y desbloquear', async () => {
    const { a, b } = await dosPersonas();

    const bloqueo = await call('POST', `/api/v1/blocks/${b.userId}`, { token: a.token });
    expect(bloqueo.status, JSON.stringify(bloqueo.body)).toBe(201);
    expect(bloqueo.body.bloqueado).toBe(true);

    const estado = await call('GET', `/api/v1/blocks/${b.userId}`, { token: a.token });
    expect(estado.body.bloqueado).toBe(true);

    const quitar = await call('DELETE', `/api/v1/blocks/${b.userId}`, { token: a.token });
    expect(quitar.status).toBe(200);

    const despues = await call('GET', `/api/v1/blocks/${b.userId}`, { token: a.token });
    expect(despues.body.bloqueado).toBe(false);
  });

  it('bloquear dos veces no falla', async () => {
    /**
     * Idempotente a propósito. Alguien que toca el botón dos veces por nervios
     * —que es exactamente el estado de quien está bloqueando a alguien que lo
     * molesta— no tiene por qué ver un mensaje rojo.
     */
    const { a, b } = await dosPersonas();

    const uno = await call('POST', `/api/v1/blocks/${b.userId}`, { token: a.token });
    const dos = await call('POST', `/api/v1/blocks/${b.userId}`, { token: a.token });

    expect(uno.status).toBe(201);
    expect(dos.status).toBe(201);
    expect(dos.body.bloqueado).toBe(true);
    // Y queda UNA fila, no dos.
    expect(await prisma.userBlock.count({ where: { blockerId: a.userId } })).toBe(1);
  });

  it('desbloquear a quien no estaba tampoco falla', async () => {
    const { a, b } = await dosPersonas();
    const r = await call('DELETE', `/api/v1/blocks/${b.userId}`, { token: a.token });
    expect(r.status).toBe(200);
  });

  it('⛔ nadie se bloquea a sí mismo', async () => {
    const a = await nuevoUsuario();
    const r = await call('POST', `/api/v1/blocks/${a.userId}`, { token: a.token });

    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CANNOT_BLOCK_SELF');
  });

  it('⛔ no se puede bloquear a alguien que no existe', async () => {
    // Sin esta comprobación, la lista de bloqueados se llena de fantasmas que
    // la interfaz no puede mostrar.
    const a = await nuevoUsuario();
    const r = await call('POST', '/api/v1/blocks/usr_00000000000000000000000000', {
      token: a.token,
    });

    expect(r.status).toBe(404);
  });

  it('la lista muestra a quién bloqueó, con la inicial del apellido', async () => {
    /**
     * El apellido completo de alguien no tiene por qué quedar en una lista que
     * se abre delante de otra persona. "Comprador P." alcanza para
     * reconocerlo.
     */
    const { a, b } = await dosPersonas();
    await call('POST', `/api/v1/blocks/${b.userId}`, {
      token: a.token,
      body: { reason: 'me escribía cosas raras' },
    });

    const lista = await call('GET', '/api/v1/blocks', { token: a.token });

    expect(lista.status).toBe(200);
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0].userId).toBe(b.userId);
    expect(lista.body[0].motivo).toBe('me escribía cosas raras');
    // Nombre y una inicial con punto, no el apellido entero.
    expect(lista.body[0].nombre).toMatch(/^\S+ \S\.$/);
  });

  // ─── Lo que NO tiene que pasar ───────────────────────────────────────────

  it('⛔ quien es bloqueado NO se entera', async () => {
    /**
     * Avisarle a alguien que lo bloquearon es darle un motivo y un objetivo.
     * Quien bloquea suele estar tratando de que la otra persona pierda interés,
     * no de confrontarla.
     */
    const { a, b } = await dosPersonas();
    await call('POST', `/api/v1/blocks/${b.userId}`, { token: a.token });

    // Desde el lado de B no hay nada: ni en su lista, ni en el estado.
    const suLista = await call('GET', '/api/v1/blocks', { token: b.token });
    expect(suLista.body).toHaveLength(0);

    const suEstado = await call('GET', `/api/v1/blocks/${a.userId}`, { token: b.token });
    expect(suEstado.body.bloqueado).toBe(false);

    // Y no le llegó ningún aviso.
    const avisos = await prisma.notification.count({ where: { userId: b.userId } });
    expect(avisos).toBe(0);
  });

  it('⛔ el bloqueo NO cancela pedidos en curso', async () => {
    /**
     * Una compra hecha es un contrato entre dos personas y no se deshace porque
     * una deje de querer ver a la otra.
     *
     * Si bloquear cancelara pedidos, sería la forma más barata de arrepentirse
     * de una compra sin pasar por la cancelación —que tiene sus reglas— y de
     * dejarle una venta caída al vendedor.
     */
    const { variantId, sellerUserId } = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));
    expect(orden.status).toBe(201);

    await call('POST', `/api/v1/blocks/${sellerUserId}`, { token: comprador.token });

    const enBase = await prisma.order.findUniqueOrThrow({
      where: { id: orden.body.id as string },
    });
    expect(enBase.status).not.toBe('CANCELLED');

    // Y el comprador lo sigue viendo en sus pedidos.
    const detalle = await call('GET', `/api/v1/orders/${orden.body.id}`, {
      token: comprador.token,
    });
    expect(detalle.status).toBe(200);
  });

  it('⛔ bloquear a un vendedor no le esconde la tienda a NADIE MÁS', async () => {
    /**
     * El ocultamiento es unilateral. Si fuera recíproco, bloquear sería una
     * forma de hacerle desaparecer la tienda a un competidor.
     */
    const { sellerUserId, productId } = await nuevaVarianteConStock(3);
    const quienBloquea = await nuevoUsuario();
    const otraPersona = await nuevoUsuario();

    await call('POST', `/api/v1/blocks/${sellerUserId}`, { token: quienBloquea.token });

    // Para cualquier otro, el producto sigue estando.
    const publico = await call('GET', `/api/v1/catalog/products/${productId}`, {
      token: otraPersona.token,
    });
    expect(publico.status).toBe(200);

    // Y sin sesión también.
    const sinSesion = await call('GET', `/api/v1/catalog/products/${productId}`);
    expect(sinSesion.status).toBe(200);
  });

  it('queda en la bitácora, sin el motivo', async () => {
    /**
     * La secuencia de bloqueos es media investigación de acoso: quién, a quién,
     * cuándo, y si hubo desbloqueos en el medio.
     *
     * El motivo NO va: puede contener el relato de algo que le pasó a la
     * persona, y la bitácora se lee entera cuando se investiga cualquier otra
     * cosa.
     */
    const { a, b } = await dosPersonas();
    await call('POST', `/api/v1/blocks/${b.userId}`, {
      token: a.token,
      body: { reason: 'un relato personal que no tiene que quedar en la auditoría' },
    });

    const registros = await prisma.auditLog.findMany({
      where: { action: 'user.blocked', entityId: b.userId },
    });

    expect(registros).toHaveLength(1);
    expect(registros[0]!.actorId).toBe(a.userId);
    expect(JSON.stringify(registros)).not.toContain('un relato personal');
  });
});

describe('Reportar, desde todos lados', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * QUÉ CAMBIÓ
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Antes se podía reportar un producto, un vivo, una tienda, una reseña y
   * —a ciegas— un mensaje de chat. Faltaban dos cosas:
   *
   *   · **reportar a una persona**. Quien acosa en un chat puede no tener
   *     tienda, y sin el destino `USER` no había forma de reportarlo. Y hay
   *     casos donde ningún mensaje suelto alcanza para explicar el problema:
   *     lo reportable es el comportamiento sostenido;
   *   · **verificar que el mensaje exista**. El `case` de `CHAT_MESSAGE`
   *     devolvía 1 sin mirar nada, porque los mensajes no se guardaban.
   */

  it('se puede reportar a una persona', async () => {
    const denunciante = await nuevoUsuario();
    const denunciado = await nuevoUsuario();

    const r = await call('POST', '/api/v1/reports', {
      token: denunciante.token,
      body: {
        targetType: 'USER',
        targetId: denunciado.userId,
        reason: 'VIOLENCIA',
        detail: 'me viene escribiendo cosas en todos los vivos',
      },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const guardado = await prisma.report.findFirst({
      where: { targetType: 'USER', targetId: denunciado.userId },
    });
    expect(guardado?.reporterUserId).toBe(denunciante.userId);
    expect(guardado?.status).toBe('PENDIENTE');
  });

  it('⛔ reportar a alguien que no existe se rechaza', async () => {
    // Sin esto, la cola se llena de reportes contra ids inventados que nadie
    // puede revisar.
    const denunciante = await nuevoUsuario();

    const r = await call('POST', '/api/v1/reports', {
      token: denunciante.token,
      body: {
        targetType: 'USER',
        targetId: 'usr_00000000000000000000000000',
        reason: 'SPAM',
      },
    });

    expect(r.status).toBe(404);
  });

  it('⛔ reportar a una persona NO la sanciona sola', async () => {
    /**
     * El invariante que sostiene todo el sistema de reportes.
     *
     * El ocultamiento automático es SÓLO para productos. Suspender a alguien
     * tiene consecuencias económicas y lo decide una persona — si un umbral
     * pudiera suspender cuentas, un grupo organizado bajaría a cualquiera.
     */
    const denunciado = await nuevoUsuario();

    // Diez personas distintas lo reportan por lo más grave que hay.
    for (let i = 0; i < 10; i++) {
      const denunciante = await nuevoUsuario();
      await call('POST', '/api/v1/reports', {
        token: denunciante.token,
        body: { targetType: 'USER', targetId: denunciado.userId, reason: 'PROHIBIDO' },
      });
    }

    const enBase = await prisma.user.findUniqueOrThrow({ where: { id: denunciado.userId } });
    expect(enBase.status).toBe('active');
    expect(enBase.deletedAt).toBeNull();

    // Y no hay ninguna acción de moderación automática sobre la cuenta.
    const acciones = await prisma.moderationAction.count({
      where: { targetType: 'USER', targetId: denunciado.userId },
    });
    expect(acciones).toBe(0);
  }, 30_000);

  it('⛔ la misma persona no puede reportar dos veces lo mismo', async () => {
    // Sin el índice único, alguien reporta veinte veces y dispara solo el
    // umbral de ocultamiento. Convierte una campaña en un solo reporte.
    const denunciante = await nuevoUsuario();
    const denunciado = await nuevoUsuario();
    const cuerpo = {
      targetType: 'USER',
      targetId: denunciado.userId,
      reason: 'SPAM',
    };

    expect((await call('POST', '/api/v1/reports', { token: denunciante.token, body: cuerpo })).status)
      .toBe(201);

    const segunda = await call('POST', '/api/v1/reports', {
      token: denunciante.token,
      body: cuerpo,
    });

    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('ALREADY_REPORTED');
  });

  it('un producto sí se puede reportar', async () => {
    const { productId } = await nuevaVarianteConStock(3);
    const denunciante = await nuevoUsuario();

    const r = await call('POST', '/api/v1/reports', {
      token: denunciante.token,
      body: { targetType: 'PRODUCT', targetId: productId, reason: 'FALSIFICADO' },
    });

    expect(r.status).toBe(201);
  });

  it('⛔ sin sesión no se reporta nada', async () => {
    // Un reporte anónimo no se puede deduplicar ni pesar: cualquiera dispararía
    // umbrales con un script.
    const { productId } = await nuevaVarianteConStock(1);

    const r = await call('POST', '/api/v1/reports', {
      body: { targetType: 'PRODUCT', targetId: productId, reason: 'SPAM' },
    });

    expect(r.status).toBe(401);
  });

  it('a quien reporta se le contesta SIEMPRE lo mismo', async () => {
    /**
     * Decirle "con el tuyo lo bajamos" convertiría el umbral en un juego: la
     * gente aprendería cuántos reportes hacen falta y los coordinaría.
     */
    const { productId } = await nuevaVarianteConStock(3);

    const primero = await nuevoUsuario();
    const uno = await call('POST', '/api/v1/reports', {
      token: primero.token,
      body: { targetType: 'PRODUCT', targetId: productId, reason: 'PROHIBIDO' },
    });

    // `PROHIBIDO` tiene umbral 1, así que este reporte YA ocultó el producto.
    const segundo = await nuevoUsuario();
    const dos = await call('POST', '/api/v1/reports', {
      token: segundo.token,
      body: { targetType: 'PRODUCT', targetId: productId, reason: 'PROHIBIDO' },
    });

    // La misma respuesta, aunque uno disparó el ocultamiento y el otro no.
    expect(JSON.stringify(uno.body)).toBe(JSON.stringify(dos.body));
  });
});

describe('Interruptor de emergencia del checkout', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EL CASO QUE LO JUSTIFICA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Mercado Pago devuelve pagos duplicados. Hay que dejar de cobrar YA, antes
   * de cobrarle dos veces a diez personas más, y no hay tiempo de desplegar
   * nada.
   *
   * ⛔ Y en ese momento, lo peor que puede hacer el interruptor es romper las
   * órdenes que ya existen. Alguien que pagó hace dos minutos tiene que poder
   * recibir su pedido igual: abandonarlo a medio camino es peor que el
   * problema que se está apagando.
   */
  async function conCheckoutApagado<T>(fn: () => Promise<T>): Promise<T> {
    const { env } = await import('@/config/env.schema');
    const mutable = env as unknown as Record<string, boolean | undefined>;
    const antes = mutable.CHECKOUT_ENABLED;
    mutable.CHECKOUT_ENABLED = false;
    try {
      return await fn();
    } finally {
      mutable.CHECKOUT_ENABLED = antes;
    }
  }

  it('⛔ apagado, no se crean órdenes nuevas', async () => {
    const comprador = await nuevoComprador();
    const { variantId } = await nuevaVarianteConStock(3);
    const reservaId = await reservar(comprador.token, variantId, 1);

    await conCheckoutApagado(async () => {
      const r = await call('POST', '/api/v1/orders', {
        token: comprador.token,
        idempotencyKey: clave('o'),
        body: { reservationId: reservaId },
      });

      expect(r.status, JSON.stringify(r.body)).toBe(503);
      expect(r.body.error.code).toBe('FEATURE_PAUSED');
      // El mensaje le dice a la persona que su carrito no se pierde: sin eso,
      // lo primero que hace es volver a intentar y duplicar la reserva.
      expect(r.body.error.message).toContain('carrito');
    });
  });

  it('⛔ pero una orden YA PAGA se sigue preparando y entregando', async () => {
    /**
     * El invariante que sostiene todo el mecanismo. Si apagar el checkout
     * congelara los pedidos en curso, nadie lo apagaría nunca — y entonces no
     * sirve para la emergencia para la que existe.
     */
    const { variantId, sellerToken } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));
    proveedor.proximo = { status: 'approved' };
    await pagar(comprador.token, orden.body.id);
    const orderId = orden.body.id as string;

    await conCheckoutApagado(async () => {
      for (const estado of ['PREPARING', 'READY_TO_SHIP', 'SHIPPED']) {
        const r = await call('PATCH', `/api/v1/seller/orders/${orderId}/fulfillment`, {
          token: sellerToken,
          body: { status: estado },
        });
        expect(r.status, `${estado}: ${JSON.stringify(r.body)}`).toBe(200);
      }

      // Y el comprador la sigue viendo.
      const mia = await call('GET', `/api/v1/orders/${orderId}`, { token: comprador.token });
      expect(mia.status).toBe(200);
      expect(mia.body.status).toBe('SHIPPED');
    });
  });

  it('⛔ y la reserva no se pierde: al volver a encender, se compra', async () => {
    // Apagar el checkout no puede consumir la reserva de quien estaba por
    // pagar. Si la consumiera, la unidad quedaría trabada hasta que venza.
    const comprador = await nuevoComprador();
    const { variantId } = await nuevaVarianteConStock(2);
    const reservaId = await reservar(comprador.token, variantId, 1);

    await conCheckoutApagado(async () => {
      const bloqueado = await call('POST', '/api/v1/orders', {
        token: comprador.token,
        idempotencyKey: clave('o'),
        body: { reservationId: reservaId },
      });
      expect(bloqueado.status).toBe(503);
    });

    const ahora = await call('POST', '/api/v1/orders', {
      token: comprador.token,
      idempotencyKey: clave('o'),
        body: { reservationId: reservaId },
    });
    expect(ahora.status, JSON.stringify(ahora.body)).toBe(201);
  });
});

describe('Reseñas y reputación', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LA REGLA CENTRAL: SÓLO SE RESEÑA LO QUE SE RECIBIÓ
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * La versión anterior aceptaba desde `CONFIRMED` —apenas se acreditaba el
   * pago— y eso rompía en las dos direcciones:
   *
   *   · el comprador podía poner una estrella a los diez minutos de comprar,
   *     antes de que el vendedor llegara a empaquetar nada;
   *   · y el vendedor podía cobrar, pedir que lo calificaran bien, y no
   *     entregar nunca. La reseña quedaba.
   *
   * Nadie tenía un test que lo cubriera: endurecer la regla no hizo fallar
   * nada. Estos son esos tests.
   */

  /**
   * Los tres escalones de una compra, cada uno construido sobre el anterior.
   *
   * Están duplicados respecto de los del bloque de entrega porque aquéllos
   * viven adentro de su `describe` y no devuelven `sellerId`, que es lo que
   * estos tests necesitan para mirar la reputación.
   */

  /** Pagada. Todavía no entregada. */
  async function ordenPaga() {
    const { variantId, sellerToken, sellerId } = await nuevaVarianteConStock(5);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));
    proveedor.proximo = { status: 'approved' };
    await pagar(comprador.token, orden.body.id);
    return {
      orderId: orden.body.id as string,
      compradorToken: comprador.token,
      sellerToken,
      sellerId,
    };
  }

  /** Despachada. Es la palabra del vendedor, todavía no la del comprador. */
  async function despachada() {
    const datos = await ordenPaga();
    for (const estado of ['PREPARING', 'READY_TO_SHIP', 'SHIPPED']) {
      const r = await call('PATCH', `/api/v1/seller/orders/${datos.orderId}/fulfillment`, {
        token: datos.sellerToken,
        body: { status: estado },
      });
      expect(r.status, `${estado}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    return datos;
  }

  /** Entregada de verdad: confirmada con el código que tenía el comprador. */
  async function ordenEntregada() {
    const datos = await despachada();
    const vista = await call('GET', `/api/v1/orders/${datos.orderId}`, {
      token: datos.compradorToken,
    });
    const r = await call('POST', `/api/v1/seller/orders/${datos.orderId}/delivery-confirmation`, {
      token: datos.sellerToken,
      body: { code: vista.body.deliveryCode as string },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return datos;
  }

  it('⛔ un pedido PAGO pero no entregado todavía no se puede reseñar', async () => {
    const { orderId, compradorToken } = await ordenPaga();

    const r = await call('POST', `/api/v1/orders/${orderId}/review`, {
      token: compradorToken,
      body: { rating: 1, comment: 'todavía no llegó nada' },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error.code).toBe('REVIEW_NOT_ALLOWED_YET');
  });

  it('⛔ ni siquiera DESPACHADO alcanza', async () => {
    // Despachado es la palabra del vendedor. Entregado es el código que tenía
    // el comprador.
    const { orderId, compradorToken } = await despachada();

    const r = await call('POST', `/api/v1/orders/${orderId}/review`, {
      token: compradorToken,
      body: { rating: 5 },
    });

    expect(r.status).toBe(422);
  });

  it('entregado, sí se puede reseñar', async () => {
    const { orderId, compradorToken, sellerId } = await ordenEntregada();

    const r = await call('POST', `/api/v1/orders/${orderId}/review`, {
      token: compradorToken,
      body: { rating: 5, comment: 'llegó impecable' },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const s = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
    expect(s.ratingCount).toBe(1);
    expect(s.ratingSum).toBe(5);
    // Y la entrega movió el contador de ventas.
    expect(s.salesCount).toBe(1);
  });

  it('⛔ una sola reseña por compra', async () => {
    const { orderId, compradorToken, sellerId } = await ordenEntregada();
    const cuerpo = { token: compradorToken, body: { rating: 5 } };

    expect((await call('POST', `/api/v1/orders/${orderId}/review`, cuerpo)).status).toBe(201);
    expect((await call('POST', `/api/v1/orders/${orderId}/review`, cuerpo)).status).toBe(400);

    const s = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
    expect(s.ratingCount).toBe(1);
  });

  describe('La respuesta del vendedor', () => {
    it('el vendedor puede responder, una vez', async () => {
      const { orderId, compradorToken, sellerToken } = await ordenEntregada();
      const resena = await call('POST', `/api/v1/orders/${orderId}/review`, {
        token: compradorToken,
        body: { rating: 2, comment: 'tardó mucho' },
      });
      const reviewId = resena.body.id as string;

      const r = await call('POST', `/api/v1/reviews/${reviewId}/reply`, {
        token: sellerToken,
        body: { texto: 'La dirección estaba incompleta y el correo lo devolvió.' },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);

      // Una sola vez: en una discusión pública el vendedor siempre tiene la
      // última palabra, porque el comprador ya se fue.
      const segunda = await call('POST', `/api/v1/reviews/${reviewId}/reply`, {
        token: sellerToken,
        body: { texto: 'y además...' },
      });
      expect(segunda.status).toBe(409);
      expect(segunda.body.error.code).toBe('REVIEW_ALREADY_ANSWERED');
    });

    it('⛔ otro vendedor no puede responder una reseña ajena', async () => {
      const { orderId, compradorToken } = await ordenEntregada();
      const resena = await call('POST', `/api/v1/orders/${orderId}/review`, {
        token: compradorToken,
        body: { rating: 1 },
      });

      const intruso = await nuevaVarianteConStock(1);
      const r = await call('POST', `/api/v1/reviews/${resena.body.id}/reply`, {
        token: intruso.sellerToken,
        body: { texto: 'no es mi venta pero contesto igual' },
      });

      // 404, no 403: un 403 confirmaría que la reseña existe.
      expect(r.status).toBe(404);
    });

    it('la respuesta sale en el listado público', async () => {
      const { orderId, compradorToken, sellerToken, sellerId } = await ordenEntregada();
      const resena = await call('POST', `/api/v1/orders/${orderId}/review`, {
        token: compradorToken,
        body: { rating: 3, comment: 'ni fu ni fa' },
      });
      await call('POST', `/api/v1/reviews/${resena.body.id}/reply`, {
        token: sellerToken,
        body: { texto: 'Gracias por avisar, lo mejoramos.' },
      });

      const lista = await call('GET', `/api/v1/sellers/${sellerId}/reviews`);
      expect(lista.status).toBe(200);
      expect(lista.body.items[0].respuesta.texto).toContain('lo mejoramos');
    });
  });

  describe('Editar y borrar', () => {
    it('⛔ editar ajusta el promedio del vendedor', async () => {
      /**
       * `ratingSum` está denormalizado. Si alguien cambia de 5 a 1 estrella y
       * la suma no se mueve, el promedio queda con cuatro estrellas de una
       * calificación que ya no existe — y nada lo recalcula solo.
       */
      const { orderId, compradorToken, sellerId } = await ordenEntregada();
      const resena = await call('POST', `/api/v1/orders/${orderId}/review`, {
        token: compradorToken,
        body: { rating: 5 },
      });

      const r = await call('PATCH', `/api/v1/reviews/${resena.body.id}`, {
        token: compradorToken,
        body: { rating: 1 },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);

      const s = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
      expect(s.ratingSum).toBe(1);
      expect(s.ratingCount).toBe(1);
    });

    it('⛔ borrar descuenta del promedio y la fila queda', async () => {
      // Sin la fila, un vendedor que consigue que le borren tres reseñas malas
      // no deja rastro de que existieron.
      const { orderId, compradorToken, sellerId } = await ordenEntregada();
      const resena = await call('POST', `/api/v1/orders/${orderId}/review`, {
        token: compradorToken,
        body: { rating: 4 },
      });

      expect(
        (await call('DELETE', `/api/v1/reviews/${resena.body.id}`, { token: compradorToken }))
          .status,
      ).toBe(200);

      const s = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
      expect(s.ratingSum).toBe(0);
      expect(s.ratingCount).toBe(0);

      // La fila sigue, con su fecha de borrado.
      const enBase = await prisma.review.findUniqueOrThrow({
        where: { id: resena.body.id as string },
      });
      expect(enBase.deletedAt).not.toBeNull();

      // Y ya no se lista.
      const lista = await call('GET', `/api/v1/sellers/${sellerId}/reviews`);
      expect(lista.body.items).toHaveLength(0);
    });

    it('⛔ nadie edita la reseña de otro', async () => {
      const { orderId, compradorToken } = await ordenEntregada();
      const resena = await call('POST', `/api/v1/orders/${orderId}/review`, {
        token: compradorToken,
        body: { rating: 5 },
      });

      const otro = await nuevoUsuario();
      const r = await call('PATCH', `/api/v1/reviews/${resena.body.id}`, {
        token: otro.token,
        body: { rating: 1 },
      });
      expect(r.status).toBe(404);
    });

    it('⛔ pasada la ventana ya no se edita', async () => {
      // Una reseña que se puede reescribir para siempre es una que un vendedor
      // puede negociar seis meses después.
      const { orderId, compradorToken } = await ordenEntregada();
      const resena = await call('POST', `/api/v1/orders/${orderId}/review`, {
        token: compradorToken,
        body: { rating: 1 },
      });

      await prisma.review.update({
        where: { id: resena.body.id as string },
        data: { createdAt: new Date(Date.now() - 72 * 3_600_000) },
      });

      const r = await call('PATCH', `/api/v1/reviews/${resena.body.id}`, {
        token: compradorToken,
        body: { rating: 5 },
      });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('REVIEW_EDIT_WINDOW_CLOSED');
    });

    it('editada, el listado lo dice', async () => {
      // Una reseña editada después de que el vendedor respondió puede
      // cambiarle el sentido a la respuesta.
      const { orderId, compradorToken, sellerId } = await ordenEntregada();
      const resena = await call('POST', `/api/v1/orders/${orderId}/review`, {
        token: compradorToken,
        body: { rating: 3, comment: 'original' },
      });
      await call('PATCH', `/api/v1/reviews/${resena.body.id}`, {
        token: compradorToken,
        body: { comment: 'cambiado' },
      });

      const lista = await call('GET', `/api/v1/sellers/${sellerId}/reviews`);
      expect(lista.body.items[0].editada).toBe(true);
      expect(lista.body.items[0].comentario).toBe('cambiado');
    });
  });

  describe('Reputación', () => {
    it('⛔ un vendedor nuevo no muestra 0,0 estrellas', async () => {
      /**
       * «Sin reseñas» y «promedio cero» son cosas distintas. Si las dos viajan
       * como 0, la app termina mostrando «0,0 ★» a alguien que recién empieza,
       * y eso se lee como pésimo.
       */
      const { sellerId } = await nuevaVarianteConStock(1);

      const r = await call('GET', `/api/v1/sellers/${sellerId}/profile`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.rating).toBeNull();
      expect(r.body.cumplimiento).toBeNull();
      expect(r.body.ventas).toBe(0);
      expect(r.body.esNuevo).toBe(true);
    });

    it('⛔ con una sola venta no muestra «100 % de cumplimiento»', async () => {
      // Una división con denominador uno disfrazada de trayectoria. Un vendedor
      // nuevo con 100 % se ve más confiable que uno con 380 ventas y 97 %.
      const { sellerId } = await ordenEntregada();

      const r = await call('GET', `/api/v1/sellers/${sellerId}/profile`);
      expect(r.body.ventas).toBe(1);
      expect(r.body.cumplimiento).toBeNull();
    });

    it('las ventas cuentan ENTREGAS, no pedidos pagos', async () => {
      /**
       * El COUNT anterior incluía desde CONFIRMED: un vendedor con veinte
       * pedidos cobrados y ninguno entregado mostraba «20 ventas».
       */
      const { sellerId } = await ordenPaga(); // paga, no entregada

      const r = await call('GET', `/api/v1/sellers/${sellerId}/profile`);
      expect(r.body.ventas).toBe(0);
    });

    it('⛔ el destacado no se puede comprar: sale de las tres reglas', async () => {
      // Un destacado que se compra es publicidad disfrazada de mérito.
      const { sellerId } = await ordenEntregada();

      const r = await call('GET', `/api/v1/sellers/${sellerId}/profile`);
      expect(r.body.destacado).toBe(false);

      // Y con los números puestos a mano, sí.
      await prisma.seller.update({
        where: { id: sellerId },
        data: { salesCount: 40, cancelledCount: 1, ratingCount: 12, ratingSum: 56 },
      });

      const conHistoria = await call('GET', `/api/v1/sellers/${sellerId}/profile`);
      expect(conHistoria.body.destacado).toBe(true);
      expect(conHistoria.body.rating).toBeCloseTo(4.7, 1);
      expect(conHistoria.body.cumplimiento).toBe(98);
    });
  });
});

describe('Guardados y vistos recientemente', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * DOS LISTAS QUE PARECEN LA MISMA Y NO LO SON
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Guardados la arma la persona a propósito; vistos los arma el sistema
   * mirando. La diferencia que importa: sobre un guardado se puede notificar
   * —«volvió al stock» es un favor— y sobre un visto no. El mismo aviso sobre
   * algo que alguien apenas miró es perseguirlo por la app.
   */

  describe('Guardados', () => {
    it('⛔ es la MISMA tabla que los «me gusta», no un sistema paralelo', async () => {
      /**
       * El corazón de un producto y la lista de guardados son el mismo gesto
       * con dos nombres. Si fueran dos tablas, la persona tendría que decidir
       * la diferencia entre «me gusta» y «guardar» —una distinción que existe
       * en el modelo de datos y no en la cabeza de nadie— y nosotros
       * mantendríamos dos contadores que se desincronizan.
       */
      const { productId } = await nuevaVarianteConStock(3);
      const persona = await nuevoUsuario();

      // Se guarda tocando el corazón de siempre.
      const like = await call('POST', `/api/v1/products/${productId}/like`, {
        token: persona.token,
      });
      expect(like.status, JSON.stringify(like.body)).toBe(201);

      const guardados = await call('GET', '/api/v1/me/saved', { token: persona.token });
      expect(guardados.status).toBe(200);
      expect(guardados.body.items).toHaveLength(1);
      expect(guardados.body.items[0].id).toBe(productId);

      // Y se quita con el mismo interruptor.
      await call('POST', `/api/v1/products/${productId}/like`, { token: persona.token });
      const vacio = await call('GET', '/api/v1/me/saved', { token: persona.token });
      expect(vacio.body.items).toHaveLength(0);
    });

    it('trae el stock REAL, que es lo que hace útil la lista', async () => {
      // Sin eso, «guardados» es una lista de nombres. Con eso, es una lista de
      // lo que se puede comprar ahora.
      const { productId, variantId } = await nuevaVarianteConStock(2);
      const persona = await nuevoUsuario();
      await call('POST', `/api/v1/products/${productId}/like`, { token: persona.token });

      const conStock = await call('GET', '/api/v1/me/saved', { token: persona.token });
      expect(conStock.body.items[0].hayStock).toBe(true);

      await prisma.inventory.update({
        where: { productVariantId: variantId },
        data: { onHand: 0 },
      });

      const sinStock = await call('GET', '/api/v1/me/saved', { token: persona.token });
      expect(sinStock.body.items[0].hayStock).toBe(false);
    });

    it('⛔ un producto despublicado se saltea, no aparece roto', async () => {
      /**
       * `Like` es polimórfico y no tiene clave foránea: la fila sobrevive al
       * producto. La lista tiene que tolerar huecos.
       *
       * Se saltea en silencio: «este producto ya no está disponible» ocupando
       * un lugar en la lista de guardados es peor que no mostrarlo.
       */
      const { productId, sellerToken } = await nuevaVarianteConStock(1);
      const persona = await nuevoUsuario();
      await call('POST', `/api/v1/products/${productId}/like`, { token: persona.token });

      await call('PATCH', `/api/v1/products/${productId}`, {
        token: sellerToken,
        body: { status: 'PAUSED' },
      });

      const r = await call('GET', '/api/v1/me/saved', { token: persona.token });
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(0);
    });

    it('⛔ nadie ve los guardados de otro', async () => {
      const { productId } = await nuevaVarianteConStock(1);
      const a = await nuevoUsuario();
      const b = await nuevoUsuario();
      await call('POST', `/api/v1/products/${productId}/like`, { token: a.token });

      const r = await call('GET', '/api/v1/me/saved', { token: b.token });
      expect(r.body.items).toHaveLength(0);
    });
  });

  describe('Vistos recientemente', () => {
    it('ver un producto lo deja en la lista', async () => {
      const { productId } = await nuevaVarianteConStock(1);
      const persona = await nuevoUsuario();

      const marca = await call('POST', `/api/v1/products/${productId}/viewed`, {
        token: persona.token,
      });
      expect(marca.status).toBe(204);

      const r = await call('GET', '/api/v1/me/recently-viewed', { token: persona.token });
      expect(r.body.items).toHaveLength(1);
      expect(r.body.items[0].id).toBe(productId);
    });

    it('⛔ verlo diez veces no lo repite diez veces', async () => {
      // Sin la restricción única, quien mira un producto varias veces lo ve
      // varias veces en su lista y tapa todo lo demás.
      const { productId } = await nuevaVarianteConStock(1);
      const persona = await nuevoUsuario();

      for (let i = 0; i < 10; i++) {
        await call('POST', `/api/v1/products/${productId}/viewed`, { token: persona.token });
      }

      const r = await call('GET', '/api/v1/me/recently-viewed', { token: persona.token });
      expect(r.body.items).toHaveLength(1);

      const filas = await prisma.recentlyViewed.count({ where: { userId: persona.userId } });
      expect(filas).toBe(1);
    });

    it('el más reciente va primero', async () => {
      const a = await nuevaVarianteConStock(1);
      const b = await nuevaVarianteConStock(1);
      const persona = await nuevoUsuario();

      await call('POST', `/api/v1/products/${a.productId}/viewed`, { token: persona.token });
      await call('POST', `/api/v1/products/${b.productId}/viewed`, { token: persona.token });

      const r = await call('GET', '/api/v1/me/recently-viewed', { token: persona.token });
      expect(r.body.items[0].id).toBe(b.productId);
      expect(r.body.items[1].id).toBe(a.productId);
    });

    it('⛔ volver a ver algo lo sube al principio', async () => {
      /**
       * Es lo que el `upsert` aporta por encima del índice único.
       *
       * Con un `create` a secas, el índice rebota el duplicado y la fila vieja
       * queda con su fecha original: el producto que la persona acaba de mirar
       * sigue enterrado al final de la lista. La lista deja de estar ordenada
       * por «lo último que viste», que es su único motivo de existir.
       *
       * Un sabotaje que cambia el upsert por un create NO hace fallar el test
       * de duplicados —lo ataja la base— pero sí hace fallar éste.
       */
      const a = await nuevaVarianteConStock(1);
      const b = await nuevaVarianteConStock(1);
      const persona = await nuevoUsuario();

      await call('POST', `/api/v1/products/${a.productId}/viewed`, { token: persona.token });
      await call('POST', `/api/v1/products/${b.productId}/viewed`, { token: persona.token });

      // Y ahora vuelve al primero.
      await call('POST', `/api/v1/products/${a.productId}/viewed`, { token: persona.token });

      const r = await call('GET', '/api/v1/me/recently-viewed', { token: persona.token });
      expect(r.body.items).toHaveLength(2);
      expect(r.body.items[0].id).toBe(a.productId);
    });

    it('⛔ la lista tiene tope: no crece para siempre', async () => {
      /**
       * Sin tope, la tabla crece con cada scroll de cada persona. Con cien mil
       * usuarios navegando sería la tabla más grande del sistema por varios
       * órdenes de magnitud, y el 99 % de las filas no las leería nadie porque
       * sólo se muestran veinte.
       */
      const persona = await nuevoUsuario();

      // Se escriben directo: crear 55 productos por HTTP tardaría un minuto y
      // lo que se prueba es la poda, no el alta.
      const { productId } = await nuevaVarianteConStock(1);
      for (let i = 0; i < 55; i++) {
        await prisma.recentlyViewed.create({
          data: {
            id: `vst_test${CORRIDA}${String(i).padStart(14, '0')}`,
            userId: persona.userId,
            targetType: 'PRODUCT',
            targetId: `prd_inventado_${i}`,
            viewedAt: new Date(Date.now() - i * 60_000),
          },
        });
      }

      // Una vista más dispara la poda.
      await call('POST', `/api/v1/products/${productId}/viewed`, { token: persona.token });

      const filas = await prisma.recentlyViewed.count({ where: { userId: persona.userId } });
      expect(filas).toBeLessThanOrEqual(50);
    }, 30_000);

    it('⛔ se puede borrar el historial', async () => {
      // Es una lista de lo que alguien miró. Poder borrarla es la diferencia
      // entre una comodidad y algo que la persona no controla.
      const { productId } = await nuevaVarianteConStock(1);
      const persona = await nuevoUsuario();
      await call('POST', `/api/v1/products/${productId}/viewed`, { token: persona.token });

      const r = await call('DELETE', '/api/v1/me/recently-viewed', { token: persona.token });
      expect(r.status).toBe(200);
      expect(r.body.borrados).toBe(1);

      const despues = await call('GET', '/api/v1/me/recently-viewed', { token: persona.token });
      expect(despues.body.items).toHaveLength(0);
    });

    it('⛔ lo más viejo que la retención no se muestra', async () => {
      // 30 días. A partir de ahí deja de ser una ayuda y pasa a ser un
      // historial de navegación de meses.
      const { productId } = await nuevaVarianteConStock(1);
      const persona = await nuevoUsuario();
      await call('POST', `/api/v1/products/${productId}/viewed`, { token: persona.token });

      await prisma.recentlyViewed.updateMany({
        where: { userId: persona.userId },
        data: { viewedAt: new Date(Date.now() - 45 * 24 * 3_600_000) },
      });

      const r = await call('GET', '/api/v1/me/recently-viewed', { token: persona.token });
      expect(r.body.items).toHaveLength(0);
    });

    it('⛔ registrar una vista NUNCA rompe la pantalla', async () => {
      /**
       * Es una comodidad, no parte de la operación. Un producto que no existe
       * —o cualquier otro fallo— no puede impedir que la app siga.
       */
      const persona = await nuevoUsuario();

      const r = await call('POST', '/api/v1/products/prd_no_existe/viewed', {
        token: persona.token,
      });
      expect(r.status).toBe(204);
    });
  });
});

describe('Vivos programados y recordatorios', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PARA QUÉ SIRVE ANUNCIAR CON ANTICIPACIÓN
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Un vivo sin anuncio arranca con quien justo estaba en la app. Uno anunciado
   * arranca con quien decidió estar. Para el vendedor es la diferencia entre
   * transmitirle a tres personas y a treinta.
   */

  const enHoras = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  it('el vendedor programa un vivo', async () => {
    const v = await nuevaVarianteConStock(3);

    const r = await call('POST', '/api/v1/live/scheduled', {
      token: v.sellerToken,
      body: { title: 'Liquidación de invierno', cuando: enHoras(3) },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.cuando).toContain('3 horas');
    expect(r.body.recordatorios).toBe(0);
  });

  it('⛔ no se puede programar para dentro de cinco minutos', async () => {
    // El aviso previo se mandaría casi junto con el vivo. Y hay un camino
    // mejor para eso: Iniciar LIVE.
    const v = await nuevaVarianteConStock(1);

    const r = await call('POST', '/api/v1/live/scheduled', {
      token: v.sellerToken,
      body: { title: 'Ya', cuando: new Date(Date.now() + 5 * 60_000).toISOString() },
    });

    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('SCHEDULE_TOO_SOON');
  });

  it('⛔ ni dos veces para la misma hora', async () => {
    // Casi siempre significa que alguien tocó dos veces.
    const v = await nuevaVarianteConStock(1);
    const cuando = enHoras(5);

    expect(
      (await call('POST', '/api/v1/live/scheduled', {
        token: v.sellerToken,
        body: { title: 'Primero', cuando },
      })).status,
    ).toBe(201);

    const segundo = await call('POST', '/api/v1/live/scheduled', {
      token: v.sellerToken,
      body: { title: 'Segundo', cuando },
    });
    expect(segundo.status).toBe(409);
  });

  it('la cartelera del vendedor es pública', async () => {
    // Quien todavía no se registró tiene que poder ver que hay un vivo el
    // jueves: es parte de decidir si le interesa la tienda.
    const v = await nuevaVarianteConStock(1);
    await call('POST', '/api/v1/live/scheduled', {
      token: v.sellerToken,
      body: { title: 'Ofertas del jueves', cuando: enHoras(30) },
    });

    const r = await call('GET', `/api/v1/live/scheduled/seller/${v.sellerId}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].titulo).toBe('Ofertas del jueves');
    // Sin sesión no se muestra el botón de recordar.
    expect(r.body.items[0].loVoyAVer).toBeUndefined();
  });

  describe('Recordarme', () => {
    it('es un interruptor', async () => {
      const v = await nuevaVarianteConStock(1);
      const programado = await call('POST', '/api/v1/live/scheduled', {
        token: v.sellerToken,
        body: { title: 'Con recordatorio', cuando: enHoras(4) },
      });
      const liveId = programado.body.id as string;
      const persona = await nuevoUsuario();

      const marca = await call('POST', `/api/v1/live/scheduled/${liveId}/remind`, {
        token: persona.token,
      });
      expect(marca.status, JSON.stringify(marca.body)).toBe(201);
      expect(marca.body.loVoyAVer).toBe(true);

      const desmarca = await call('POST', `/api/v1/live/scheduled/${liveId}/remind`, {
        token: persona.token,
      });
      expect(desmarca.body.loVoyAVer).toBe(false);
    });

    it('⛔ es DISTINTO de seguir al vendedor', async () => {
      /**
       * Alguien puede querer ver ESTE vivo sin querer que le suene el teléfono
       * en cada transmisión de esa tienda. Si fueran lo mismo, marcar un
       * recordatorio lo convertiría en seguidor sin que lo pidiera.
       */
      const v = await nuevaVarianteConStock(1);
      const programado = await call('POST', '/api/v1/live/scheduled', {
        token: v.sellerToken,
        body: { title: 'Sin seguir', cuando: enHoras(4) },
      });
      const persona = await nuevoUsuario();

      await call('POST', `/api/v1/live/scheduled/${programado.body.id}/remind`, {
        token: persona.token,
      });

      const sigue = await prisma.follow.count({
        where: { userId: persona.userId, sellerId: v.sellerId },
      });
      expect(sigue).toBe(0);
    });

    it('el contador de interesados es real', async () => {
      const v = await nuevaVarianteConStock(1);
      const programado = await call('POST', '/api/v1/live/scheduled', {
        token: v.sellerToken,
        body: { title: 'Contar', cuando: enHoras(4) },
      });

      for (let i = 0; i < 3; i++) {
        const p = await nuevoUsuario();
        await call('POST', `/api/v1/live/scheduled/${programado.body.id}/remind`, {
          token: p.token,
        });
      }

      const r = await call('GET', `/api/v1/live/scheduled/seller/${v.sellerId}`);
      expect(r.body.items[0].interesados).toBe(3);
    });
  });

  describe('El aviso de «está por empezar»', () => {
    it('le llega a quien se anotó', async () => {
      const v = await nuevaVarianteConStock(1);
      const programado = await call('POST', '/api/v1/live/scheduled', {
        token: v.sellerToken,
        body: { title: 'En cinco minutos', cuando: enHoras(1) },
      });
      const liveId = programado.body.id as string;

      const persona = await nuevoUsuario();
      await call('POST', `/api/v1/live/scheduled/${liveId}/remind`, { token: persona.token });

      // Se adelanta el reloj moviendo la fecha, no esperando una hora.
      await prisma.liveSession.update({
        where: { id: liveId },
        data: { scheduledFor: new Date(Date.now() + 5 * 60_000) },
      });

      const { avisos } = await app.get(AgendaService).avisarLosQueEmpiezanPronto();
      expect(avisos).toBeGreaterThanOrEqual(1);

      const aviso = await prisma.notification.findFirst({
        where: { userId: persona.userId, type: 'LIVE_SOON' },
      });
      expect(aviso).not.toBeNull();
      // Con el deep link, para que la app abra el vivo y no el feed.
      expect(JSON.stringify(aviso?.data)).toContain(liveId);
    });

    it('⛔ no se manda dos veces', async () => {
      // El barrido corre cada dos minutos y la ventana es de diez: sin la
      // marca, la misma persona recibiría cinco avisos del mismo vivo.
      const v = await nuevaVarianteConStock(1);
      const programado = await call('POST', '/api/v1/live/scheduled', {
        token: v.sellerToken,
        body: { title: 'Una sola vez', cuando: enHoras(1) },
      });
      const persona = await nuevoUsuario();
      await call('POST', `/api/v1/live/scheduled/${programado.body.id}/remind`, {
        token: persona.token,
      });

      await prisma.liveSession.update({
        where: { id: programado.body.id as string },
        data: { scheduledFor: new Date(Date.now() + 5 * 60_000) },
      });

      const agenda = app.get(AgendaService);
      await agenda.avisarLosQueEmpiezanPronto();
      await agenda.avisarLosQueEmpiezanPronto();
      await agenda.avisarLosQueEmpiezanPronto();

      const cuantos = await prisma.notification.count({
        where: { userId: persona.userId, type: 'LIVE_SOON' },
      });
      expect(cuantos).toBe(1);
    });

    it('⛔ a quien NO se anotó, no le llega', async () => {
      const v = await nuevaVarianteConStock(1);
      const programado = await call('POST', '/api/v1/live/scheduled', {
        token: v.sellerToken,
        body: { title: 'Sin anotarse', cuando: enHoras(1) },
      });
      const ajeno = await nuevoUsuario();

      await prisma.liveSession.update({
        where: { id: programado.body.id as string },
        data: { scheduledFor: new Date(Date.now() + 5 * 60_000) },
      });
      await app.get(AgendaService).avisarLosQueEmpiezanPronto();

      const cuantos = await prisma.notification.count({
        where: { userId: ajeno.userId, type: 'LIVE_SOON' },
      });
      expect(cuantos).toBe(0);
    });
  });

  describe('Preferencias de aviso', () => {
    it('las categorías vienen encendidas', async () => {
      const persona = await nuevoUsuario();

      const r = await call('GET', '/api/v1/notifications/preferences', { token: persona.token });
      expect(r.status).toBe(200);
      expect(r.body.categorias.length).toBeGreaterThanOrEqual(4);
      expect(r.body.categorias.every((c: { activa: boolean }) => c.activa)).toBe(true);
    });

    it('⛔ apagar una categoría impide que el aviso se CREE, no sólo que se mande', async () => {
      /**
       * Es la parte que hace que la preferencia signifique algo.
       *
       * Si el aviso se creara igual y sólo no se mandara por push, quien apagó
       * «vivos» abriría la campana y encontraría veinte avisos de vivos
       * esperándolo — o sea, exactamente lo que pidió no ver.
       */
      const v = await nuevaVarianteConStock(1);
      const programado = await call('POST', '/api/v1/live/scheduled', {
        token: v.sellerToken,
        body: { title: 'No me avises', cuando: enHoras(1) },
      });
      const persona = await nuevoUsuario();
      await call('POST', `/api/v1/live/scheduled/${programado.body.id}/remind`, {
        token: persona.token,
      });

      const apagar = await call('PATCH', '/api/v1/notifications/preferences/vivos', {
        token: persona.token,
        body: { activa: false },
      });
      expect(apagar.status, JSON.stringify(apagar.body)).toBe(200);

      await prisma.liveSession.update({
        where: { id: programado.body.id as string },
        data: { scheduledFor: new Date(Date.now() + 5 * 60_000) },
      });
      await app.get(AgendaService).avisarLosQueEmpiezanPronto();

      const cuantos = await prisma.notification.count({
        where: { userId: persona.userId, type: 'LIVE_SOON' },
      });
      expect(cuantos).toBe(0);
    });

    it('⛔ los avisos de plata NO se pueden apagar', async () => {
      /**
       * No hay categoría para ellos, así que no hay forma de apagarlos desde la
       * API. Y aunque alguien escribiera el tipo directo en la base, el
       * servicio los deja pasar igual.
       *
       * Un pago rechazado que no llega deja a alguien creyendo que compró.
       */
      const persona = await nuevoUsuario();

      await prisma.user.update({
        where: { id: persona.userId },
        data: { mutedNotificationTypes: ['PAYMENT_REJECTED', 'ORDER_STATUS'] },
      });

      const notif = app.get(NotificationsService);
      await notif.crear({
        userId: persona.userId,
        type: 'PAYMENT_REJECTED',
        title: 'Tu pago se rechazó',
        body: 'Probá con otra tarjeta',
      });

      const cuantos = await prisma.notification.count({
        where: { userId: persona.userId, type: 'PAYMENT_REJECTED' },
      });
      expect(cuantos).toBe(1);
    });

    it('volver a encenderla la reactiva', async () => {
      const persona = await nuevoUsuario();

      await call('PATCH', '/api/v1/notifications/preferences/opiniones', {
        token: persona.token,
        body: { activa: false },
      });
      const r = await call('PATCH', '/api/v1/notifications/preferences/opiniones', {
        token: persona.token,
        body: { activa: true },
      });

      const opiniones = (r.body.categorias as Array<{ clave: string; activa: boolean }>).find(
        (c) => c.clave === 'opiniones',
      );
      expect(opiniones?.activa).toBe(true);
    });

    it('⛔ una categoría inventada se rechaza', async () => {
      const persona = await nuevoUsuario();
      const r = await call('PATCH', '/api/v1/notifications/preferences/inventada', {
        token: persona.token,
        body: { activa: false },
      });
      expect(r.status).toBe(400);
    });
  });
});

describe('Precio exclusivo del vivo', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EL DESCUENTO LO DECIDE EL SERVIDOR
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * La app manda desde qué vivo compra. **No manda el precio**, y no podría: si
   * el cuerpo de la petición pudiera decir cuánto sale algo, cualquiera
   * compraría a un peso.
   */

  /** Un vendedor con un vivo al aire y un producto adentro. */
  async function vivoConProducto(precio = 1_800_000) {
    const { variantId, sellerToken, sellerId, productId } = await nuevaVarianteConStock(5);
    const tienda = await prisma.store.findFirstOrThrow({ where: { sellerId } });

    await prisma.product.update({
      where: { id: productId },
      data: { basePriceCents: precio },
    });

    const vivo = await prisma.liveSession.create({
      data: {
        id: `liv_pre${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        sellerId,
        storeId: tienda.id,
        title: 'Vendiendo',
        roomName: `room-pre-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        state: 'LIVE',
        startedAt: new Date(),
        products: {
          create: [
            {
              id: `lsp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
              productId,
              position: 0,
            },
          ],
        },
      },
      select: { id: true },
    });

    return { variantId, sellerToken, sellerId, productId, liveId: vivo.id, precio };
  }

  it('⛔ la comisión del 6 % sale sobre lo que se PAGÓ, no sobre el precio de lista', async () => {
    /**
     * El invariante comercial de este bloque.
     *
     * Cobrarle al vendedor comisión sobre un precio que nadie pagó sería
     * quedarse con parte de su descuento: pone un producto de $18.000 a
     * $12.500, y VendoX le cobra $1.080 en vez de $750.
     */
    const v = await vivoConProducto(1_800_000);
    await prisma.liveSessionProduct.updateMany({
      where: { liveSessionId: v.liveId, productId: v.productId },
      data: { livePriceCents: 1_250_000 },
    });

    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId), {
      liveSessionId: v.liveId,
    });

    expect(orden.status, JSON.stringify(orden.body)).toBe(201);

    // Se cobró el precio de vivo.
    expect(orden.body.itemsSubtotal).toBe(1_250_000);

    // Y la comisión es el 6 % de ESO: $750, no $1.080.
    expect(orden.body.platformFeeAmount).toBe(75_000);
    expect(orden.body.platformFeeAmount).not.toBe(108_000);
  });

  it('⛔ sin mandar el vivo, se cobra el precio de lista', async () => {
    // Comprar el mismo producto desde el feed no da el descuento del vivo.
    const v = await vivoConProducto(1_800_000);
    await prisma.liveSessionProduct.updateMany({
      where: { liveSessionId: v.liveId, productId: v.productId },
      data: { livePriceCents: 1_250_000 },
    });

    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));

    expect(orden.body.itemsSubtotal).toBe(1_800_000);
  });

  it('⛔ el vivo de OTRO vendedor no da su descuento', async () => {
    /**
     * El agujero: mandar el id del vivo de otra tienda —donde hay un descuento
     * del 90 %— y llevarse este producto a ese precio.
     *
     * ⚠️ Para probarlo hay que meter el producto de la víctima en la bandeja
     * del atacante ESCRIBIENDO EN LA BASE, porque por la API no se puede: al
     * preparar un vivo, los productos se validan contra la tienda del vendedor.
     *
     * O sea que esto verifica la SEGUNDA capa. Un sabotaje que quita el filtro
     * por vendedor no hace fallar nada si el producto no está en la bandeja
     * ajena — y por eso el test lo pone ahí a mano. Sin este montaje, el test
     * pasaría con la validación borrada.
     */
    const mio = await vivoConProducto(1_800_000);
    const atacante = await vivoConProducto(1_000_000);

    await prisma.liveSessionProduct.create({
      data: {
        id: `lsp_atk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        liveSessionId: atacante.liveId,
        productId: mio.productId,
        position: 1,
        livePriceCents: 180_000,
      },
    });

    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, mio.variantId), {
      liveSessionId: atacante.liveId,
    });

    // Se cobró el precio real, no el descuento del vivo ajeno.
    expect(orden.body.itemsSubtotal).toBe(1_800_000);
  });

  it('⛔ una oferta vencida NO se cobra, aunque la app la siga mostrando', async () => {
    // El reloj es el del servidor. Una oferta que venció hace treinta segundos
    // no se aplica.
    const v = await vivoConProducto(1_800_000);
    await prisma.liveSessionProduct.updateMany({
      where: { liveSessionId: v.liveId, productId: v.productId },
      data: {
        livePriceCents: 1_250_000,
        livePriceUntil: new Date(Date.now() - 30_000),
      },
    });

    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId), {
      liveSessionId: v.liveId,
    });

    expect(orden.body.itemsSubtotal).toBe(1_800_000);
  });

  it('la orden guarda de dónde vino y a qué precio estaba en lista', async () => {
    // Es lo que permite responder, seis meses después, por qué dos órdenes del
    // mismo producto tienen precios distintos.
    const v = await vivoConProducto(1_800_000);
    await prisma.liveSessionProduct.updateMany({
      where: { liveSessionId: v.liveId, productId: v.productId },
      data: { livePriceCents: 1_250_000 },
    });

    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId), {
      liveSessionId: v.liveId,
    });

    const enBase = await prisma.order.findUniqueOrThrow({
      where: { id: orden.body.id as string },
    });
    expect(enBase.liveSessionId).toBe(v.liveId);
    expect(enBase.listPriceCents).toBe(1_800_000);
    expect(enBase.itemsSubtotal).toBe(1_250_000);
  });

  describe('Lo que el vendedor puede cargar', () => {
    it('pone y saca el precio', async () => {
      const v = await vivoConProducto(1_800_000);

      const puesto = await call('PUT', `/api/v1/live/${v.liveId}/products/${v.productId}/price`, {
        token: v.sellerToken,
        body: { precioCentavos: 1_250_000 },
      });
      expect(puesto.status, JSON.stringify(puesto.body)).toBe(200);

      const sacado = await call('PUT', `/api/v1/live/${v.liveId}/products/${v.productId}/price`, {
        token: v.sellerToken,
        body: { precioCentavos: null },
      });
      expect(sacado.status).toBe(200);
      expect(sacado.body.precioDeVivo).toBeNull();
    });

    it('⛔ un precio MAYOR al normal se rechaza', async () => {
      // El patrón oscuro más viejo: mostrar un precio inflado tachado al lado
      // de uno que en realidad es el de siempre.
      const v = await vivoConProducto(1_000_000);

      const r = await call('PUT', `/api/v1/live/${v.liveId}/products/${v.productId}/price`, {
        token: v.sellerToken,
        body: { precioCentavos: 1_500_000 },
      });

      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('LIVE_PRICE_INVALID');
    });

    it('⛔ un vendedor no puede tocar el vivo de otro', async () => {
      const mio = await vivoConProducto();
      const ajeno = await vivoConProducto();

      const r = await call(
        'PUT',
        `/api/v1/live/${ajeno.liveId}/products/${ajeno.productId}/price`,
        { token: mio.sellerToken, body: { precioCentavos: 100_000 } },
      );

      // 404, no 403: confirmar que el vivo existe ya sería información.
      expect(r.status).toBe(404);
    });

    it('⛔ queda en la bitácora, con el precio de lista al lado', async () => {
      /**
       * Es lo que permite responder «¿este descuento existió de verdad?» meses
       * después. Sin el precio de lista en el mismo registro, la bitácora diría
       * que alguien puso $12.500 sin decir contra qué.
       */
      const v = await vivoConProducto(1_800_000);

      await call('PUT', `/api/v1/live/${v.liveId}/products/${v.productId}/price`, {
        token: v.sellerToken,
        body: { precioCentavos: 1_250_000 },
      });

      const registro = await prisma.auditLog.findFirst({
        where: { action: 'live.price_set', entityId: v.liveId },
        orderBy: { createdAt: 'desc' },
      });

      expect(registro).not.toBeNull();
      const datos = JSON.stringify(registro?.after);
      expect(datos).toContain('1800000');
      expect(datos).toContain('1250000');
    });
  });
});

describe('Cupones', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EL DESCUENTO LO DECIDE EL SERVIDOR, Y LO PAGA EL VENDEDOR
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * La app manda el **código**. Nunca cuánto descuenta: si el cuerpo de la
   * petición pudiera decirlo, cualquiera compraría a un peso.
   *
   * Y la comisión del 6 % se cobra sobre lo que se pagó. Cobrarla sobre el
   * precio de lista sería quedarse con parte del descuento del vendedor.
   */

  /** Un vendedor con Pro, un producto con stock y un cupón cargado. */
  async function vendedorConCupon(
    cupon: Record<string, unknown> = { codigo: 'VERANO25', tipo: 'PORCENTAJE', valor: 25 },
    precio = 1_000_000,
  ) {
    const { variantId, sellerToken, sellerId, productId } = await nuevaVarianteConStock(5);
    await prisma.product.update({ where: { id: productId }, data: { basePriceCents: precio } });

    // Pro se otorga desde el panel: no hay cobro. Ver `membresias.ts`.
    await prisma.sellerMembership.create({
      data: {
        id: `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        sellerId,
        plan: 'PRO',
        periodo: 'MENSUAL',
        origen: 'CORTESIA',
        vigenteHasta: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const creado = await call('POST', '/api/v1/seller/coupons', {
      token: sellerToken,
      body: cupon,
    });
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);

    return { variantId, sellerToken, sellerId, productId, precio, cuponId: creado.body.id };
  }

  it('⛔ un vendedor Free NO puede crear cupones', async () => {
    // Es la regla que el producto define explícitamente: los cupones son Pro.
    const { sellerToken } = await nuevaVarianteConStock(1);

    const r = await call('POST', '/api/v1/seller/coupons', {
      token: sellerToken,
      body: { codigo: 'GRATIS', tipo: 'PORCENTAJE', valor: 10 },
    });

    // 402 y no 403: la función existe y está bien pedida, lo que falta es el
    // plan. La app muestra qué es Pro, no un «no podés hacer eso».
    expect(r.status, JSON.stringify(r.body)).toBe(402);
    expect(r.body.error.code).toBe('PRO_REQUIRED');
  });

  it('⛔ un Pro VENCIDO tampoco', async () => {
    /**
     * La fila sigue diciendo PRO hasta que algo la actualice, y no hay nada que
     * la actualice. Si `crear` leyera el plan sin mirar la fecha, un vendedor
     * que dejó de pagar seguiría con cupones para siempre.
     */
    const v = await vendedorConCupon();
    await prisma.sellerMembership.update({
      where: { sellerId: v.sellerId },
      data: { vigenteHasta: new Date(Date.now() - 60_000) },
    });

    const r = await call('POST', '/api/v1/seller/coupons', {
      token: v.sellerToken,
      body: { codigo: 'OTRO', tipo: 'PORCENTAJE', valor: 10 },
    });

    expect(r.status).toBe(402);
  });

  it('⛔ la comisión del 6 % sale sobre lo que se PAGÓ', async () => {
    /**
     * EL INVARIANTE COMERCIAL DE ESTE BLOQUE.
     *
     * Un cupón del 25 % sobre $10.000 deja $7.500. La comisión es $450, no
     * $600. Cobrar sobre el precio de lista sería quedarse con parte del
     * descuento que puso el vendedor de su bolsillo.
     */
    const v = await vendedorConCupon();
    const comprador = await nuevoComprador();

    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId), {
      cupon: 'VERANO25',
    });

    expect(orden.status, JSON.stringify(orden.body)).toBe(201);
    expect(orden.body.discountAmount).toBe(250_000);
    expect(orden.body.grossAmount).toBe(750_000);

    // 6 % de $7.500, no de $10.000.
    expect(orden.body.platformFeeAmount).toBe(45_000);
    expect(orden.body.platformFeeAmount).not.toBe(60_000);
  });

  it('⛔ el cupón de OTRA tienda no sirve acá', async () => {
    /**
     * El cupón lo paga el vendedor que lo creó. Aplicar el «VERANO25» de una
     * tienda grande en la compra de otra sería sacarle plata a quien no lo
     * ofreció.
     */
    await vendedorConCupon();
    const otra = await vendedorConCupon({
      codigo: 'AJENO50',
      tipo: 'PORCENTAJE',
      valor: 50,
    });
    // Se compra en la tienda que NO tiene AJENO50... salvo que sí lo tiene.
    const victima = await vendedorConCupon({ codigo: 'PROPIO10', tipo: 'PORCENTAJE', valor: 10 });
    expect(otra.cuponId).not.toBe(victima.cuponId);

    const comprador = await nuevoComprador();
    const orden = await crearOrden(
      comprador.token,
      await reservar(comprador.token, victima.variantId),
      { cupon: 'AJENO50' },
    );

    expect(orden.status).toBe(422);
    expect(orden.body.error.code).toBe('COUPON_NOT_APPLICABLE');
  });

  /**
   * Otro producto de la MISMA tienda, con stock.
   *
   * Hace falta porque una segunda compra del mismo producto reusaría la reserva
   * activa —el inventario devuelve la que ya tenía— y el pedido saldría siendo
   * el mismo. Sin esto, un test de «dos compras» no prueba dos compras.
   */
  async function otroProductoDe(sellerToken: string, precio = 1_000_000) {
    const producto = await call('POST', '/api/v1/products', {
      token: sellerToken,
      body: {
        name: `Otro producto ${Math.random().toString(36).slice(2, 8)}`,
        basePriceCents: precio,
        status: 'ACTIVE',
        categoryId: 'cat_otros',
      },
    });
    expect(producto.status, JSON.stringify(producto.body)).toBe(201);

    const variantId = producto.body.variants[0].id as string;
    await prisma.inventory.update({ where: { productVariantId: variantId }, data: { onHand: 5 } });
    return variantId;
  }

  it('⛔ la MISMA persona no puede usarlo dos veces', async () => {
    // La restricción única lo impide. Va en la base y no en un `if`: dos
    // pedidos simultáneos pasarían los dos por cualquier comprobación previa.
    const v = await vendedorConCupon();
    const otraVariante = await otroProductoDe(v.sellerToken);
    const comprador = await nuevoComprador();

    const primera = await crearOrden(
      comprador.token,
      await reservar(comprador.token, v.variantId),
      { cupon: 'VERANO25' },
    );
    expect(primera.status, JSON.stringify(primera.body)).toBe(201);

    const segunda = await crearOrden(
      comprador.token,
      await reservar(comprador.token, otraVariante),
      { cupon: 'VERANO25' },
    );

    expect(segunda.status, JSON.stringify(segunda.body)).toBe(422);
    expect(segunda.body.error.message).toMatch(/[Yy]a usaste/);
  });

  it('⛔ cuando el cupón falla, NO queda una orden a medias', async () => {
    /**
     * El canje va adentro de la transacción que crea la orden. Si el cupón se
     * rechaza en el último paso, se deshace todo — no puede quedar una orden
     * cobrando el precio entero de una compra que la persona hizo esperando un
     * descuento.
     *
     * Es el caso que el orden de las operaciones hace posible: el cupo se toma
     * ANTES de crear la orden y el canje se registra DESPUÉS, porque la fila
     * apunta a la orden por clave foránea.
     */
    const v = await vendedorConCupon();
    const otraVariante = await otroProductoDe(v.sellerToken);
    const comprador = await nuevoComprador();

    await crearOrden(comprador.token, await reservar(comprador.token, v.variantId), {
      cupon: 'VERANO25',
    });

    const reservaNueva = await reservar(comprador.token, otraVariante);
    const segunda = await crearOrden(comprador.token, reservaNueva, { cupon: 'VERANO25' });
    expect(segunda.status).toBe(422);

    const huerfana = await prisma.order.findUnique({ where: { reservationId: reservaNueva } });
    expect(huerfana).toBeNull();

    // Y el cupo tampoco se gastó: la transacción se deshizo entera.
    const cupon = await prisma.coupon.findUniqueOrThrow({ where: { id: v.cuponId } });
    expect(cupon.usos).toBe(1);
  });

  it('⛔ un cupón vencido corta el pedido en vez de cobrar el precio entero', async () => {
    /**
     * Ignorarlo en silencio sería peor que fallar: alguien que escribió un
     * código espera ese descuento, y enterarse después de que se lo cobraron
     * completo es exactamente el reclamo que no queremos.
     */
    const v = await vendedorConCupon();
    await prisma.coupon.update({
      where: { id: v.cuponId },
      data: { hasta: new Date(Date.now() - 60_000) },
    });

    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId), {
      cupon: 'VERANO25',
    });

    expect(orden.status).toBe(422);
    expect(orden.body.error.message).toMatch(/venció/);
  });

  it('⛔ el límite de usos se respeta aunque dos pedidos lleguen juntos', async () => {
    /**
     * EL TEST DE LA CARRERA.
     *
     * Un cupón de un solo uso, dos compradores distintos pidiendo a la vez. Con
     * un «leer y después incrementar», los dos leerían 0 usos y los dos
     * escribirían 1. Con el UPDATE condicional, la base deja pasar uno.
     */
    const v = await vendedorConCupon({
      codigo: 'UNICO',
      tipo: 'PORCENTAJE',
      valor: 20,
      usosMaximos: 1,
    });

    const a = await nuevoComprador();
    const b = await nuevoComprador();
    const reservaA = await reservar(a.token, v.variantId);
    const reservaB = await reservar(b.token, v.variantId);

    const [ra, rb] = await Promise.all([
      crearOrden(a.token, reservaA, { cupon: 'UNICO' }),
      crearOrden(b.token, reservaB, { cupon: 'UNICO' }),
    ]);

    const exitosas = [ra, rb].filter((r) => r.status === 201);
    const rechazadas = [ra, rb].filter((r) => r.status === 422);

    expect(exitosas).toHaveLength(1);
    expect(rechazadas).toHaveLength(1);

    const cupon = await prisma.coupon.findUniqueOrThrow({ where: { id: v.cuponId } });
    expect(cupon.usos).toBe(1);
  });

  it('⛔ sin cupón, nada cambia', async () => {
    // La comisión sigue siendo el 6 % del subtotal y no hay descuento.
    const v = await vendedorConCupon();
    const comprador = await nuevoComprador();

    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));

    expect(orden.body.discountAmount).toBe(0);
    expect(orden.body.platformFeeAmount).toBe(60_000);
  });

  it('el tope recorta el descuento', async () => {
    // Es lo que evita que «20 % de descuento» le cueste $40.000 en la única
    // venta grande del mes.
    const v = await vendedorConCupon(
      { codigo: 'TOPE', tipo: 'PORCENTAJE', valor: 50, topeCentavos: 100_000 },
      2_000_000,
    );

    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId), {
      cupon: 'TOPE',
    });

    // 50 % de $20.000 serían $10.000, pero el tope es $1.000.
    expect(orden.body.discountAmount).toBe(100_000);
  });

  it('el código se normaliza: se acepta en minúsculas y con espacios', async () => {
    // Quien lo tipea en el teclado del teléfono manda esto. Rechazarlo sería
    // perder la venta por un detalle de tipeo.
    const v = await vendedorConCupon();
    const comprador = await nuevoComprador();

    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId), {
      cupon: '  verano25 ',
    });

    expect(orden.status, JSON.stringify(orden.body)).toBe(201);
    expect(orden.body.discountAmount).toBe(250_000);
  });

  describe('Lo que el vendedor administra', () => {
    it('⛔ no puede repetir un código', async () => {
      const v = await vendedorConCupon();

      const r = await call('POST', '/api/v1/seller/coupons', {
        token: v.sellerToken,
        body: { codigo: 'verano25', tipo: 'PORCENTAJE', valor: 10 },
      });

      expect(r.status).toBe(422);
      expect(r.body.error.message).toMatch(/ya tenés/i);
    });

    it('dos tiendas distintas SÍ pueden tener el mismo código', async () => {
      // Hacerlos globales sería que la primera tienda se quede con los códigos
      // buenos.
      await vendedorConCupon();
      const otra = await vendedorConCupon();
      expect(otra.cuponId).toBeTruthy();
    });

    it('⛔ no puede tocar el cupón de otro', async () => {
      const mio = await vendedorConCupon();
      const ajeno = await vendedorConCupon({ codigo: 'AJENO', tipo: 'PORCENTAJE', valor: 10 });

      const r = await call('POST', `/api/v1/seller/coupons/${ajeno.cuponId}/toggle`, {
        token: mio.sellerToken,
        body: { activo: false },
      });

      expect(r.status).toBe(404);
    });

    it('pausar deja de aplicarlo, pero no borra el historial', async () => {
      const v = await vendedorConCupon();

      await call('POST', `/api/v1/seller/coupons/${v.cuponId}/toggle`, {
        token: v.sellerToken,
        body: { activo: false },
      });

      const comprador = await nuevoComprador();
      const orden = await crearOrden(
        comprador.token,
        await reservar(comprador.token, v.variantId),
        { cupon: 'VERANO25' },
      );

      expect(orden.status).toBe(422);

      // Sigue en la lista del vendedor, apagado.
      const lista = await call('GET', '/api/v1/seller/coupons', { token: v.sellerToken });
      const enLista = lista.body.find((c: { id: string }) => c.id === v.cuponId);
      expect(enLista.activo).toBe(false);
    });

    it('la lista dice cuántos usos quedan, y null cuando es ilimitado', async () => {
      // `null` y no un número inventado: no se puede mostrar una cifra que no
      // existe.
      const v = await vendedorConCupon();

      const lista = await call('GET', '/api/v1/seller/coupons', { token: v.sellerToken });
      const enLista = lista.body.find((c: { id: string }) => c.id === v.cuponId);

      expect(enLista.usosRestantes).toBeNull();
      expect(enLista.usos).toBe(0);
    });

    it('⛔ queda en la bitácora', async () => {
      const v = await vendedorConCupon();

      const registro = await prisma.auditLog.findFirst({
        where: { action: 'coupon.created', entityId: v.cuponId },
      });

      expect(registro).not.toBeNull();
      expect(JSON.stringify(registro?.after)).toContain('VERANO25');
    });
  });

  describe('Probar un código antes de pagar', () => {
    it('dice cuánto descontaría', async () => {
      const v = await vendedorConCupon();
      const comprador = await nuevoComprador();

      const r = await call(
        'GET',
        `/api/v1/coupons/check?sellerId=${v.sellerId}&codigo=VERANO25&subtotalCentavos=1000000`,
        { token: comprador.token },
      );

      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.aplica).toBe(true);
      expect(r.body.descuentoCentavos).toBe(250_000);
    });

    it('⛔ un código que no existe responde lo MISMO que uno pausado', async () => {
      /**
       * A propósito.
       *
       * Responder distinto convertiría este endpoint en un oráculo para
       * descubrir qué códigos tiene una tienda probando palabras.
       */
      const v = await vendedorConCupon();
      const comprador = await nuevoComprador();

      const inventado = await call(
        'GET',
        `/api/v1/coupons/check?sellerId=${v.sellerId}&codigo=NOEXISTE&subtotalCentavos=1000000`,
        { token: comprador.token },
      );

      await call('POST', `/api/v1/seller/coupons/${v.cuponId}/toggle`, {
        token: v.sellerToken,
        body: { activo: false },
      });

      const pausado = await call(
        'GET',
        `/api/v1/coupons/check?sellerId=${v.sellerId}&codigo=VERANO25&subtotalCentavos=1000000`,
        { token: comprador.token },
      );

      expect(inventado.body.aplica).toBe(false);
      expect(pausado.body.aplica).toBe(false);
      expect(inventado.body.motivo).toBe(pausado.body.motivo);
    });

    it('dice POR QUÉ no aplica cuando no es un secreto', async () => {
      // «No se puede usar» hace que la persona lo intente tres veces más;
      // «venció» hace que deje de intentar y compre igual.
      const v = await vendedorConCupon({
        codigo: 'MINIMO',
        tipo: 'PORCENTAJE',
        valor: 20,
        minimoCentavos: 5_000_000,
      });
      const comprador = await nuevoComprador();

      const r = await call(
        'GET',
        `/api/v1/coupons/check?sellerId=${v.sellerId}&codigo=MINIMO&subtotalCentavos=1000000`,
        { token: comprador.token },
      );

      expect(r.body.aplica).toBe(false);
      expect(r.body.motivo).toMatch(/mínimo/);
    });
  });
});

describe('Aplicar un cupón a un pedido ya creado', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * POR QUÉ ESTE CAMINO EXISTE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * El checkout crea el pedido apenas se abre, para que la persona vea el total
   * mientras decide. El cupón se escribe después, en el resumen — que es donde
   * todo el mundo espera escribirlo.
   *
   * Es el mismo canje que en `create`, no un segundo sistema: usa `tomarCupo` y
   * `registrarCanje`. Lo que cambia es cuándo.
   */

  async function pedidoPendienteConCupon(cupon = 25) {
    const { variantId, sellerToken, sellerId, productId } = await nuevaVarianteConStock(5);
    await prisma.product.update({
      where: { id: productId },
      data: { basePriceCents: 1_000_000 },
    });

    await prisma.sellerMembership.create({
      data: {
        id: `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        sellerId,
        plan: 'PRO',
        periodo: 'MENSUAL',
        origen: 'CORTESIA',
        vigenteHasta: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const creado = await call('POST', '/api/v1/seller/coupons', {
      token: sellerToken,
      body: { codigo: 'DESPUES', tipo: 'PORCENTAJE', valor: cupon },
    });
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);

    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, variantId));
    expect(orden.status, JSON.stringify(orden.body)).toBe(201);

    return { comprador, orden: orden.body, sellerToken, cuponId: creado.body.id as string };
  }

  it('aplica el descuento y recalcula la comisión', async () => {
    const p = await pedidoPendienteConCupon();

    const r = await call('POST', `/api/v1/orders/${p.orden.id}/coupon`, {
      token: p.comprador.token,
      body: { codigo: 'DESPUES' },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.discountAmount).toBe(250_000);
    expect(r.body.grossAmount).toBe(750_000);
    // ⚠️ La comisión se rehace: 6 % de $7.500. No alcanza con restar del total.
    expect(r.body.platformFeeAmount).toBe(45_000);
    expect(r.body.sellerNetAmount).toBe(705_000);
  });

  it('⛔ no se puede aplicar dos veces', async () => {
    const p = await pedidoPendienteConCupon();

    await call('POST', `/api/v1/orders/${p.orden.id}/coupon`, {
      token: p.comprador.token,
      body: { codigo: 'DESPUES' },
    });
    const segunda = await call('POST', `/api/v1/orders/${p.orden.id}/coupon`, {
      token: p.comprador.token,
      body: { codigo: 'DESPUES' },
    });

    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('ORDER_NOT_EDITABLE');
  });

  it('⛔ no se puede aplicar a un pedido AJENO', async () => {
    // La pertenencia va en el WHERE: 404, no 403.
    const p = await pedidoPendienteConCupon();
    const otro = await nuevoComprador();

    const r = await call('POST', `/api/v1/orders/${p.orden.id}/coupon`, {
      token: otro.token,
      body: { codigo: 'DESPUES' },
    });

    expect(r.status).toBe(404);
  });

  it('⛔ no se puede aplicar después de pagar', async () => {
    // Lo ataja el estado: pagar saca al pedido de PENDING_PAYMENT.
    const p = await pedidoPendienteConCupon();
    await pagar(p.comprador.token, p.orden.id);

    const r = await call('POST', `/api/v1/orders/${p.orden.id}/coupon`, {
      token: p.comprador.token,
      body: { codigo: 'DESPUES' },
    });

    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ORDER_NOT_EDITABLE');
  });

  it('⛔ ni con un cobro EN CURSO, aunque el pedido siga pendiente', async () => {
    /**
     * EL TEST QUE IMPORTA, y el que el estado NO alcanza a cubrir.
     *
     * Un pago que Mercado Pago deja `in_process` —revisión antifraude, débito
     * en proceso— crea el intento y deja la orden en `PENDING_PAYMENT`. La
     * preferencia ya está abierta por el importe viejo.
     *
     * Si el cupón se aplicara ahí, el comprador terminaría pagando $10.000 por
     * una orden que dice $7.500, y la conciliación no cerraría nunca. Por eso
     * la guarda mira los intentos y no sólo el estado.
     *
     * ⚠️ El intento se inserta a mano justamente porque es un estado que el
     * flujo normal de este test no produce. Sin este montaje, sacar la guarda
     * de `_count.attempts` no rompería ningún test.
     */
    const p = await pedidoPendienteConCupon();

    await prisma.paymentAttempt.create({
      data: {
        id: `pat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        orderId: p.orden.id as string,
        status: 'PROCESSING',
        amount: p.orden.grossAmount as number,
        idempotencyKey: `idem-pat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      },
    });

    // La orden sigue pendiente: es exactamente el estado del agujero.
    const antes = await prisma.order.findUniqueOrThrow({ where: { id: p.orden.id as string } });
    expect(antes.status).toBe('PENDING_PAYMENT');

    const r = await call('POST', `/api/v1/orders/${p.orden.id}/coupon`, {
      token: p.comprador.token,
      body: { codigo: 'DESPUES' },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toBe('ORDER_NOT_EDITABLE');
  });

  it('quitarlo devuelve el cupo', async () => {
    /**
     * Sin esto, probar y arrepentirse gastaría un uso de un cupón limitado. Y
     * peor: por la restricción de uno por persona, esa persona no podría
     * volver a usarlo nunca.
     */
    const p = await pedidoPendienteConCupon();

    await call('POST', `/api/v1/orders/${p.orden.id}/coupon`, {
      token: p.comprador.token,
      body: { codigo: 'DESPUES' },
    });
    const conCupon = await prisma.coupon.findUniqueOrThrow({ where: { id: p.cuponId } });
    expect(conCupon.usos).toBe(1);

    const r = await call('DELETE', `/api/v1/orders/${p.orden.id}/coupon`, {
      token: p.comprador.token,
    });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.discountAmount).toBe(0);
    expect(r.body.grossAmount).toBe(1_000_000);
    expect(r.body.platformFeeAmount).toBe(60_000);

    const sinCupon = await prisma.coupon.findUniqueOrThrow({ where: { id: p.cuponId } });
    expect(sinCupon.usos).toBe(0);

    // Y puede volver a usarlo: el canje se borró.
    const otraVez = await call('POST', `/api/v1/orders/${p.orden.id}/coupon`, {
      token: p.comprador.token,
      body: { codigo: 'DESPUES' },
    });
    expect(otraVez.status, JSON.stringify(otraVez.body)).toBe(201);
  });

  it('⛔ un código que no aplica no toca el pedido', async () => {
    const p = await pedidoPendienteConCupon();

    const r = await call('POST', `/api/v1/orders/${p.orden.id}/coupon`, {
      token: p.comprador.token,
      body: { codigo: 'NOEXISTE' },
    });

    expect(r.status).toBe(422);

    const enBase = await prisma.order.findUniqueOrThrow({ where: { id: p.orden.id } });
    expect(enBase.discountAmount).toBe(0);
    expect(enBase.grossAmount).toBe(1_000_000);
    expect(enBase.platformFeeAmount).toBe(60_000);
  });
});

describe('Los avisos de la venta', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * CINCO TIPOS QUE ESTABAN DECLARADOS Y NO LOS CREABA NADIE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `ORDER_RECEIVED`, `ORDER_STATUS`, `PAYMENT_APPROVED`, `PAYMENT_REJECTED` y
   * `REVIEW_RECEIVED` vivían en el enum, tenían categoría y semántica de
   * obligatorios, y la campana quedaba muda justo para lo que más importa.
   *
   * Los cinco cuelgan de eventos de dominio que YA se publicaban. El comentario
   * de `domain-events.ts` lo anticipaba: «se emiten ahora aunque no los escuche
   * nadie». Éste es el suscriptor.
   */

  /**
   * Los avisos que le llegaron a alguien, esperando a que aparezcan.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * LOS AVISOS SON ASINCRÓNICOS, Y ESO ES DELIBERADO
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `DomainEventBus.publish()` no espera a los suscriptores: «quien publica ya
   * terminó su trabajo». Es lo correcto — una venta no puede quedar colgada
   * porque el aviso tarda— pero significa que el aviso puede no existir
   * todavía cuando la petición ya respondió.
   *
   * Sin esta espera los tests pasan o fallan según la carga de la máquina, que
   * es la peor clase de test: el que un día se pone rojo sin que nadie haya
   * tocado nada.
   */
  async function avisosDe(userId: string, tipo?: string, minimo = 0) {
    const donde = { userId, ...(tipo ? { type: tipo as never } : {}) };

    for (let intento = 0; intento < 40; intento += 1) {
      const filas = await prisma.notification.findMany({
        where: donde,
        orderBy: { createdAt: 'asc' },
      });
      if (filas.length >= minimo && (minimo > 0 || intento > 0)) return filas;
      await new Promise((r) => setTimeout(r, 25));
    }

    return prisma.notification.findMany({ where: donde, orderBy: { createdAt: 'asc' } });
  }

  it('ORDER_RECEIVED · le llega al VENDEDOR cuando entra una venta', async () => {
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();

    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    expect(orden.status, JSON.stringify(orden.body)).toBe(201);

    const delVendedor = await avisosDe(v.sellerUserId, 'ORDER_RECEIVED', 1);
    expect(delVendedor).toHaveLength(1);
    expect(delVendedor[0]!.title).toContain('compraron');

    /**
     * ⚠️ Y al COMPRADOR no le llega este aviso.
     *
     * Acaba de tocar «pagar» y está mirando la pantalla: avisarle de su propia
     * acción es ruido.
     */
    expect(await avisosDe(comprador.userId, 'ORDER_RECEIVED')).toHaveLength(0);
  });

  it('⛔ el aviso de venta NO lleva datos del comprador', async () => {
    /**
     * EL TEST DE PRIVACIDAD.
     *
     * Esto se lee en la pantalla bloqueada de un teléfono que puede estar sobre
     * una mesa. El nombre, el teléfono, la dirección y el documento de quien
     * compró están en el pedido, detrás de la sesión del vendedor.
     */
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));

    const aviso = (await avisosDe(v.sellerUserId, 'ORDER_RECEIVED', 1))[0]!;
    const todo = JSON.stringify(aviso).toLowerCase();

    for (const dato of ['30123456', '+5491122334455', 'av. corrientes', 'ana pérez']) {
      expect(todo, dato).not.toContain(dato.toLowerCase());
    }
  });

  it('PAYMENT_APPROVED · le llega al COMPRADOR cuando se acredita', async () => {
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));

    await pagar(comprador.token, orden.body.id as string);

    const avisos = await avisosDe(comprador.userId, 'PAYMENT_APPROVED', 1);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.title).toContain('acreditó');
  });

  it('⛔ el aviso del pago NO lleva el importe', async () => {
    // Cuánto pagó alguien es información financiera. El importe está en el
    // pedido, detrás de la sesión.
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    await pagar(comprador.token, orden.body.id as string);

    const aviso = (await avisosDe(comprador.userId, 'PAYMENT_APPROVED', 1))[0]!;
    expect(JSON.stringify(aviso)).not.toMatch(/\$\s?\d/);
  });

  it('⛔ UN WEBHOOK REPETIDO NO PRODUCE DOS AVISOS', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL TEST QUE JUSTIFICA TODO EL DISEÑO
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Mercado Pago repite las notificaciones: es su comportamiento normal, no
     * un fallo. Con el aviso colgado del webhook, cada repetición sería otra
     * vibración diciendo «se acreditó tu pago» por el mismo pago.
     *
     * No pasa, y la garantía no está en el oyente: está en `acreditar()`, que
     * mueve la orden con un `updateMany` condicionado al estado y publica el
     * evento **sólo si afectó una fila**. El segundo webhook encuentra la orden
     * ya en PAID, afecta cero filas y no publica nada.
     *
     * El oyente hereda esa garantía en vez de inventar la suya.
     */
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));

    const cobro = await pagar(comprador.token, orden.body.id as string);
    expect(cobro.status).toBe(201);

    const intento = await prisma.paymentAttempt.findFirstOrThrow({
      where: { orderId: orden.body.id as string },
      select: { providerPaymentId: true },
    });

    // Dos webhooks del MISMO pago, con ids de notificación distintos: es
    // exactamente lo que manda Mercado Pago cuando reintenta.
    await enviarWebhook(intento.providerPaymentId!, 'notif-uno');
    await enviarWebhook(intento.providerPaymentId!, 'notif-dos');

    const avisos = await avisosDe(comprador.userId, 'PAYMENT_APPROVED', 1);
    expect(avisos, 'un pago acreditado, un solo aviso').toHaveLength(1);
  });

  it('⛔ la dedupeKey es la segunda red', async () => {
    /**
     * La primera es la guarda de monotonía de `acreditar()`. Ésta cubre el día
     * que aparezca un camino que publique el evento sin esa guarda.
     *
     * Se prueba insertando el mismo aviso dos veces a mano: el índice único
     * sobre `dedupeKey` rechaza el segundo y `crear()` devuelve `null` en vez
     * de tirar.
     */
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    const orderId = orden.body.id as string;

    const clave = `payment_approved:${orderId}`;
    const existentes = await prisma.notification.count({ where: { dedupeKey: clave } });

    await expect(
      prisma.notification.create({
        data: {
          id: `ntf_dup${Date.now().toString(36)}`,
          userId: comprador.userId,
          type: 'PAYMENT_APPROVED',
          title: 'x',
          body: 'x',
          dedupeKey: clave,
        },
      }),
    ).resolves.toBeTruthy();

    // El segundo con la misma clave choca contra el índice único.
    await expect(
      prisma.notification.create({
        data: {
          id: `ntf_dup2${Date.now().toString(36)}`,
          userId: comprador.userId,
          type: 'PAYMENT_APPROVED',
          title: 'x',
          body: 'x',
          dedupeKey: clave,
        },
      }),
    ).rejects.toThrow();

    expect(existentes).toBeGreaterThanOrEqual(0);
  });

  it('ORDER_STATUS · le llega al COMPRADOR en una transición relevante', async () => {
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    const orderId = orden.body.id as string;
    await pagar(comprador.token, orderId);

    const r = await call('PATCH', `/api/v1/seller/orders/${orderId}/fulfillment`, {
      token: v.sellerToken,
      body: { status: 'PREPARING' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const avisos = await avisosDe(comprador.userId, 'ORDER_STATUS', 1);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.title.toLowerCase()).toContain('preparando');
  });

  it('⛔ una transición IRRELEVANTE no manda nada', async () => {
    /**
     * `PAID` y `CONFIRMED` ya los cubre `PAYMENT_APPROVED`. Avisar los dos
     * manda dos notificaciones por lo mismo con treinta segundos de diferencia,
     * y a la tercera la persona apaga la categoría — con lo cual se pierden
     * también las que sí importaban.
     */
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));

    // Pagar mueve la orden a PAID y después a CONFIRMED. Ninguna avisa por acá.
    await pagar(comprador.token, orden.body.id as string);

    expect(await avisosDe(comprador.userId, 'ORDER_STATUS')).toHaveLength(0);
  });

  it('⛔ marcar dos veces el MISMO estado avisa una sola vez', async () => {
    // La clave es (pedido, estado): un pedido pasa por varios estados y cada
    // uno merece su aviso, pero repetir el mismo no.
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    const orderId = orden.body.id as string;
    await pagar(comprador.token, orderId);

    const mover = (estado: string) =>
      call('PATCH', `/api/v1/seller/orders/${orderId}/fulfillment`, {
        token: v.sellerToken,
        body: { status: estado },
      });

    await mover('PREPARING');
    await mover('PREPARING');

    const avisos = await avisosDe(comprador.userId, 'ORDER_STATUS', 1);
    expect(avisos.filter((a) => a.title.toLowerCase().includes('preparando'))).toHaveLength(1);
  });

  it('cada estado nuevo SÍ manda su aviso', async () => {
    // No es que se avise una vez y nunca más: preparándose, listo y en camino
    // son tres novedades distintas.
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    const orderId = orden.body.id as string;
    await pagar(comprador.token, orderId);

    for (const estado of ['PREPARING', 'READY_TO_SHIP', 'SHIPPED']) {
      await call('PATCH', `/api/v1/seller/orders/${orderId}/fulfillment`, {
        token: v.sellerToken,
        body: { status: estado },
      });
    }

    expect(await avisosDe(comprador.userId, 'ORDER_STATUS', 3)).toHaveLength(3);
  });

  it('⛔ ningún aviso de estado lleva el código de entrega', async () => {
    /**
     * Es el dato más sensible del pedido: quien lo tiene puede hacerse pasar
     * por quien compró y cerrar una entrega que no recibió. Nunca sale del
     * detalle del pedido, y menos en una notificación.
     */
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    const orderId = orden.body.id as string;
    await pagar(comprador.token, orderId);
    await call('PATCH', `/api/v1/seller/orders/${orderId}/fulfillment`, {
      token: v.sellerToken,
      body: { status: 'SHIPPED' },
    });

    const enBase = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { deliveryCode: true },
    });
    const avisos = await avisosDe(comprador.userId, 'ORDER_STATUS', 1);
    const todo = JSON.stringify(avisos);

    if (enBase.deliveryCode) expect(todo).not.toContain(enBase.deliveryCode);
    // Y por las dudas, ningún grupo suelto de seis dígitos.
    expect(todo).not.toMatch(/\b\d{6}\b/);
  });

it('⛔ un rechazo TARDÍO sobre un pedido ya pago no avisa nada', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA DIFERENCIA ENTRE UN RECHAZO ACCIONABLE Y UNO QUE NO LO ES
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Pasa de verdad: alguien prueba una tarjeta, se queda esperando, prueba
     * otra que sí funciona. Después llega el webhook del primer intento con el
     * rechazo. Para entonces el pedido está pago.
     *
     * La rama de rechazo mueve la orden con un `updateMany` condicionado a
     * `PROCESSING_PAYMENT`, así que ahí afecta cero filas y el pedido sigue
     * pago — pero el evento se publica igual.
     *
     * Si el oyente confiara en el evento, le diría «no pudimos cobrar tu
     * pedido» a alguien cuya compra salió bien. Por eso relee el estado.
     *
     * ⚠️ El evento se publica a mano porque montar la carrera real —dos
     * intentos, uno lento, un webhook desordenado— es mucho andamiaje para
     * probar una condición de una línea. Lo que importa es el estado de la
     * orden, y ése es real: está pagada.
     */
    const { DomainEventBus, DomainEvent } = await import('@/shared/events/domain-events');
    const bus = app.get(DomainEventBus);

    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    const orderId = orden.body.id as string;

    await pagar(comprador.token, orderId);

    const pagada = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(pagada.status, 'el montaje del test').not.toBe('PAYMENT_FAILED');

    bus.publish(DomainEvent.paymentRejected, {
      entityId: `pat_tardio_${Date.now().toString(36)}`,
      data: { orderId },
    });

    // Se espera de más a propósito: si el aviso fuera a salir, con esto sale.
    await new Promise((r) => setTimeout(r, 400));

    expect(
      await prisma.notification.count({
        where: { userId: comprador.userId, type: 'PAYMENT_REJECTED' },
      }),
      'un pedido pago no puede recibir un aviso de rechazo',
    ).toBe(0);
  });

  it('⛔ un rechazo TARDÍO no despaga el pedido', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA GUARDA MÁS CARA DEL SISTEMA, Y NO TENÍA PRUEBA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El test de arriba mira los AVISOS. Este mira la plata.
     *
     * La rama de rechazo mueve la orden con un `updateMany` condicionado a
     * `PROCESSING_PAYMENT`. Sin esa condición, el webhook rechazado del primer
     * intento —el de la tarjeta que no funcionó— encuentra el pedido en `PAID`
     * y lo pasa a `PAYMENT_FAILED`.
     *
     * Lo que eso significa: alguien pagó, el pedido figura como fallido, el
     * stock se libera y el vendedor nunca despacha. La plata está cobrada.
     *
     * Se descubrió sacando la condición del WHERE: las 828 pruebas de
     * integración seguían en verde. El comentario del código afirmaba que la
     * guarda funcionaba y nada lo comprobaba.
     *
     * ─── Por qué el segundo intento se arma a mano ───
     *
     * La carrera real —dos tarjetas, la primera lenta, el webhook desordenado—
     * necesita controlar los tiempos del proveedor. Lo que importa acá es el
     * estado desde el que llega el rechazo, y ése es exacto: un intento vivo
     * sobre una orden que YA está paga, que es justo la situación.
     */
    const { OrderPaymentsService } = await import('@/modules/orders/payments.service');
    const pagos = app.get(OrderPaymentsService);

    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    const orderId = orden.body.id as string;

    // Se paga con la segunda tarjeta. El pedido queda pago.
    await pagar(comprador.token, orderId);
    const pagada = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(['PAID', 'CONFIRMED'], 'el montaje del test').toContain(pagada.status);

    // El primer intento, el de la tarjeta que no funcionó, todavía sin resolver.
    const sufijo = Date.now().toString(36);
    const primerIntento = await prisma.paymentAttempt.create({
      data: {
        id: `pat_lento${sufijo}`,
        orderId,
        status: 'PROCESSING',
        amount: pagada.grossAmount,
        idempotencyKey: `idem-lento-${sufijo}`,
      },
    });

    // Y ahora llega su webhook, tarde y con el rechazo.
    await pagos.aplicarResultado(
      primerIntento.id,
      {
        id: `mp_lento_${sufijo}`,
        status: 'rejected',
        statusDetail: 'cc_rejected_insufficient_amount',
        raw: {},
      },
      'webhook',
    );

    const despues = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(despues.status, 'un pedido pago no se despaga con un webhook viejo').toBe(
      pagada.status,
    );
    expect(despues.status).not.toBe('PAYMENT_FAILED');
  });

  it('PAYMENT_REJECTED · sí avisa cuando el rechazo es real', async () => {
    // La contraparte del anterior. Sin esto, el test de arriba pasaría igual
    // con un oyente que no avisa nunca.
    const { DomainEventBus, DomainEvent } = await import('@/shared/events/domain-events');
    const bus = app.get(DomainEventBus);

    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    const orderId = orden.body.id as string;

    // El estado que deja un cobro rechazado de verdad.
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'PAYMENT_FAILED', statusReason: 'La tarjeta no tiene fondos' },
    });

    bus.publish(DomainEvent.paymentRejected, {
      entityId: `pat_real_${Date.now().toString(36)}`,
      data: { orderId },
    });

    const avisos = await avisosDe(comprador.userId, 'PAYMENT_REJECTED', 1);
    expect(avisos).toHaveLength(1);
    // El motivo viene de `statusReason`, que escribe `describePaymentOutcome`:
    // mensajes pensados para una persona, sin códigos del procesador.
    expect(avisos[0]!.body).toContain('fondos');
  });

  it('REVIEW_RECEIVED · le llega al VENDEDOR cuando lo reseñan', async () => {
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    const orderId = orden.body.id as string;
    await pagar(comprador.token, orderId);

    // Sólo se reseña lo que se recibió. Ver `reputacion.ts`.
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });

    const r = await call('POST', `/api/v1/orders/${orderId}/review`, {
      token: comprador.token,
      body: { rating: 5, comment: 'Todo perfecto' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const avisos = await avisosDe(v.sellerUserId, 'REVIEW_RECEIVED', 1);
    expect(avisos).toHaveLength(1);
  });

  it('⛔ el aviso de reseña NO dice cuántas estrellas', async () => {
    /**
     * «Te dejaron 2 estrellas» en la pantalla bloqueada, sin poder ver el
     * comentario ni responder, es una mala noticia sin contexto. La reacción
     * es no volver a abrir la app.
     *
     * El aviso lleva a la reseña; la calificación se ve ahí, con el texto al
     * lado y el botón de responder.
     */
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();
    const orden = await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));
    const orderId = orden.body.id as string;
    await pagar(comprador.token, orderId);
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
    await call('POST', `/api/v1/orders/${orderId}/review`, {
      token: comprador.token,
      body: { rating: 1, comment: 'Malísimo' },
    });

    const aviso = (await avisosDe(v.sellerUserId, 'REVIEW_RECEIVED', 1))[0]!;
    const todo = `${aviso.title} ${aviso.body}`;

    expect(todo).not.toMatch(/[1-5]\s*(estrella|★|\*)/i);
    expect(todo).not.toContain('Malísimo');
  });

  it('⛔ si la persona apagó la categoría, no se crea el aviso', async () => {
    /**
     * El filtro está en `crear()`, el único lugar donde se crean avisos. Este
     * test comprueba que los tipos nuevos pasan por ahí igual que el resto —
     * no que se agregó un filtro aparte.
     *
     * ⚠️ Se usa un tipo APAGABLE. Los de plata son obligatorios por diseño y
     * eso se prueba en el bloque de categorías.
     */
    const v = await nuevaVarianteConStock(3);
    const comprador = await nuevoComprador();

    await prisma.user.update({
      where: { id: v.sellerUserId },
      data: { mutedNotificationTypes: ['REVIEW_RECEIVED'] },
    });

    await crearOrden(comprador.token, await reservar(comprador.token, v.variantId));

    // La venta sí llega: ORDER_RECEIVED es obligatorio.
    expect(await avisosDe(v.sellerUserId, 'ORDER_RECEIVED', 1)).toHaveLength(1);
  });
});
