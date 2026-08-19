import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';
import { NACIMIENTO_ADULTO_ISO } from '../helpers/edad';

import {
  inicioDeLaVentana,
  promedioSemanal,
  medirVolumenDe,
} from '@/modules/sellers/volumen';

/**
 * El volumen elegible, contra PostgreSQL real.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTE NÚMERO DECIDE CUÁNTA COMISIÓN SE COBRA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * De acá sale el promedio semanal, y del promedio sale el tramo. Si esta
 * consulta suma de más, VendoX cobra de menos —y al revés—, y en los dos casos
 * el error es plata que no vuelve.
 *
 * Por eso se prueba contra la base de verdad y no con un doble: lo que hay que
 * comprobar es la consulta misma. El `GREATEST(...)` por fila, el filtro de
 * estados y el corte de la ventana no existen en TypeScript; existen en SQL.
 * Un mock los daría todos por buenos.
 *
 * Las órdenes se insertan directas. El flujo de compra completo ya está probado
 * en `orders-flow.spec.ts`; acá lo único que importa es el estado y los
 * importes de cada fila.
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
  STORE_REOPEN_SWEEP_ENABLED: 'false',
  NOTIFICATIONS_DISPATCHER_ENABLED: 'false',
  ORDERS_RECONCILER_ENABLED: 'false',
  INVENTORY_RECONCILER_ENABLED: 'false',
  INVENTORY_EXPIRATION_QUEUE_ENABLED: 'false',
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
    'TRUNCATE order_items, payment_attempts, refunds, orders, stores, sellers, ' +
      'auth_events, refresh_tokens, devices, user_identities, users CASCADE',
  );
});

afterAll(async () => {
  await app?.close();
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

  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

let n = 0;

/**
 * Crear un vendedor está limitado por IP, y con razón: da de alta una tienda.
 *
 * Todos los tests salen de la misma IP, así que varias altas seguidas chocan
 * contra ese límite. Se limpia el contador antes de cada alta en vez de aflojar
 * la regla: bajarla para los tests dejaría sin probar el límite que sí corre en
 * producción.
 */
async function nuevoVendedor() {
  const claves = await redis.client.keys('rl:*');
  if (claves.length > 0) await redis.client.del(...claves);

  n += 1;
  const r = await call('POST', '/api/v1/auth/dev', {
    body: {
      email: `volumen${n}@test.com`,
      firstName: 'Test',
      lastName: `Volumen${n}`,
      device: {
        installId: `install-volumen-${n}`,
        platform: 'android',
        appVersion: '1.0.0',
        osVersion: '14',
      },
    },
  });
  const token = r.body.accessToken as string;

  await call('PATCH', '/api/v1/auth/me', {
    token,
    body: { birthDate: NACIMIENTO_ADULTO_ISO },
  });

  const s = await call('POST', '/api/v1/sellers', {
    token,
    body: { displayName: `Vendedor volumen ${n}`, storeName: `Local volumen ${n}` },
  });
  expect(s.status, JSON.stringify(s.body)).toBe(201);

  return {
    token,
    userId: r.body.user.id as string,
    sellerId: s.body.seller.id as string,
    storeId: s.body.store.id as string,
  };
}

/**
 * Devuelve plata de una orden, como lo haría el sistema.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CON UNA FILA DE `Refund` DE VERDAD, NO CAMBIANDO EL ESTADO A MANO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La primera versión de estos tests hacía `update({ status: 'REFUNDED' })` y
 * nada más. Pasaban, pero probaban un mundo que no existe: en producción una
 * orden devuelta SIEMPRE tiene su fila de devolución, porque es la fila la que
 * registra que la plata volvió.
 *
 * La diferencia dejó de ser cosmética cuando la medición pasó a mirar
 * `confirmed_at` y a restar devoluciones prorrateadas: sin la fila, la orden
 * seguía contando como venta. El test que decía «una venta devuelta deja de
 * contar» habría fallado — con razón.
 *
 * `monto` es sobre el BRUTO, igual que `Refund.amount` en producción. Omitirlo
 * devuelve todo, que es lo único que el sistema sabe hacer hoy.
 */
async function devolver(
  orden: { id: string; grossAmount: number },
  opciones: { monto?: number; status?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' } = {},
) {
  m += 1;
  const sufijo = `dev${m}${Math.random().toString(36).slice(2, 8)}`;
  const monto = opciones.monto ?? orden.grossAmount;

  const intento = await prisma.paymentAttempt.create({
    data: {
      id: `pat_${sufijo}`,
      orderId: orden.id,
      status: 'APPROVED',
      amount: orden.grossAmount,
      idempotencyKey: `idem_${sufijo}`,
      providerPaymentId: `mp_${sufijo}`,
      approvedAt: AHORA,
    },
  });

  return prisma.refund.create({
    data: {
      id: `ref_${sufijo}`,
      orderId: orden.id,
      paymentAttemptId: intento.id,
      status: opciones.status ?? 'COMPLETED',
      amount: monto,
      reason: 'TEST',
      ...(opciones.status === undefined || opciones.status === 'COMPLETED'
        ? { completedAt: AHORA }
        : {}),
    },
  });
}

const AHORA = new Date('2026-08-19T12:00:00.000Z');
/** Bien adentro de la ventana. */
const HACE_UNA_SEMANA = new Date(AHORA.getTime() - 7 * 86_400_000);
/** Un día antes del corte: fuera. */
const HACE_29_DIAS = new Date(AHORA.getTime() - 29 * 86_400_000);

let m = 0;

/**
 * Inserta una orden con los importes exactos que pide el caso.
 *
 * Los CHECK de la base obligan a que el total cierre y a que las marcas de
 * tiempo sean coherentes con el estado, así que las fixtures no pueden mentir
 * más de lo que la base permitiría en producción. Eso es a propósito: un test
 * que arma una fila imposible prueba un mundo que no existe.
 */
async function crearOrden(
  v: { sellerId: string; storeId: string; userId: string },
  o: {
    status: string;
    itemsSubtotal: number;
    discountAmount?: number;
    shippingAmount?: number;
    processorSurchargeAmount?: number;
    createdAt?: Date;
  },
) {
  m += 1;
  const sufijo = `vol${m}${Math.random().toString(36).slice(2, 8)}`;
  const descuento = o.discountAmount ?? 0;
  const envio = o.shippingAmount ?? 0;
  const recargo = o.processorSurchargeAmount ?? 0;

  /**
   * El bruto INCLUYE el recargo del procesador. Lo exige `orden_total_coherente`
   * desde la migración `total_con_recargo`.
   *
   * Que el recargo viaje adentro del bruto es justamente por lo que el volumen
   * no se puede calcular sumando `grossAmount`: contaría plata que es de
   * Mercado Pago. Ver el test de abajo.
   */
  const bruto = o.itemsSubtotal + envio - descuento + recargo;

  const terminal = o.status;
  const pagada = ['PAID', 'CONFIRMED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED',
    'REFUNDED', 'REFUND_PENDING', 'PAYMENT_REQUIRES_REFUND'].includes(terminal);

  return prisma.order.create({
    data: {
      id: `ord_${sufijo}`,
      reference: `REF${sufijo.slice(-8).toUpperCase()}`,
      buyerId: v.userId,
      storeId: v.storeId,
      sellerId: v.sellerId,
      reservationId: `rsv_${sufijo}`,
      status: terminal as never,
      itemsSubtotal: o.itemsSubtotal,
      discountAmount: descuento,
      shippingAmount: envio,
      processorSurchargeAmount: recargo,
      grossAmount: bruto,
      platformFeeBps: 400,
      platformFeeAmount: 0,
      sellerNetAmount: bruto,
      ...(pagada ? { paidAt: o.createdAt ?? AHORA } : {}),
      ...(['CONFIRMED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'].includes(terminal)
        ? { confirmedAt: o.createdAt ?? AHORA }
        : {}),
      ...(terminal === 'CANCELLED' ? { cancelledAt: o.createdAt ?? AHORA } : {}),
      ...(terminal === 'EXPIRED' ? { expiredAt: o.createdAt ?? AHORA } : {}),
      ...(terminal === 'REFUNDED' ? { refundedAt: o.createdAt ?? AHORA } : {}),
      createdAt: o.createdAt ?? AHORA,
      shippingAddress: {},
      buyerSnapshot: {},
    },
  });
}

describe('Volumen elegible — qué suma', () => {
  it('suma las órdenes confirmadas por su valor de producto', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, { status: 'CONFIRMED', itemsSubtotal: 100_000 });
    await crearOrden(v, { status: 'DELIVERED', itemsSubtotal: 250_000 });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(350_000);
  });

  it('los cinco estados de venta suman, cada uno', async () => {
    const v = await nuevoVendedor();
    for (const status of ['CONFIRMED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED']) {
      await crearOrden(v, { status, itemsSubtotal: 10_000 });
    }

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(50_000);
  });

  it('sin ventas da cero, no null', async () => {
    const v = await nuevoVendedor();

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(0);
  });

  /**
   * El volumen de un vendedor es SUYO.
   *
   * Sin el filtro por `sellerId` cada vendedor heredaría el volumen de toda la
   * plataforma y todos caerían en el tramo más barato desde el primer día.
   */
  it('⛔ no mezcla el volumen de otro vendedor', async () => {
    const uno = await nuevoVendedor();
    const otro = await nuevoVendedor();
    await crearOrden(uno, { status: 'DELIVERED', itemsSubtotal: 900_000 });
    await crearOrden(otro, { status: 'DELIVERED', itemsSubtotal: 100_000 });

    expect((await medirVolumenDe(prisma, uno.sellerId, AHORA)).volumenElegible).toBe(900_000);
    expect((await medirVolumenDe(prisma, otro.sellerId, AHORA)).volumenElegible).toBe(100_000);
  });
});

describe('Volumen elegible — qué NO suma', () => {
  /**
   * El envío no es facturación del vendedor: es un costo que se le traslada al
   * comprador. Contarlo como volumen le regalaría tramo a quien vende barato y
   * manda lejos.
   */
  it('⛔ el envío no cuenta', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, { status: 'DELIVERED', itemsSubtotal: 100_000, shippingAmount: 80_000 });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(100_000);
  });

  /** El recargo del procesador es plata de Mercado Pago, no del vendedor. */
  it('⛔ el recargo del procesador no cuenta', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, {
      status: 'DELIVERED',
      itemsSubtotal: 100_000,
      processorSurchargeAmount: 6_190,
    });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(100_000);
  });

  /**
   * El volumen se mide sobre lo que se pagó de verdad, no sobre el precio de
   * lista. Si no, un vendedor llegaría a un tramo publicando precios altos y
   * regalando cupones que nadie paga.
   */
  it('⛔ el descuento se resta: cuenta lo efectivamente pagado', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, { status: 'DELIVERED', itemsSubtotal: 100_000, discountAmount: 30_000 });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(70_000);
  });

  it('⛔ las canceladas no cuentan', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, { status: 'DELIVERED', itemsSubtotal: 100_000 });
    await crearOrden(v, { status: 'CANCELLED', itemsSubtotal: 500_000 });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(100_000);
  });

  it('⛔ las vencidas y las de pago fallido no cuentan', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, { status: 'EXPIRED', itemsSubtotal: 400_000 });
    await crearOrden(v, { status: 'PAYMENT_FAILED', itemsSubtotal: 400_000 });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(0);
  });

  it('⛔ las que todavía no se cobraron no cuentan', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, { status: 'PENDING_PAYMENT', itemsSubtotal: 400_000 });
    await crearOrden(v, { status: 'PROCESSING_PAYMENT', itemsSubtotal: 400_000 });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(0);
  });

  /**
   * ESTE ES EL TEST DE «LAS DEVOLUCIONES SE DESCUENTAN».
   *
   * La orden entra en `brutoConfirmado` —llegó a ser una venta, y `confirmed_at`
   * lo dice para siempre— y sale entera por `devuelto`. El neto es cero.
   *
   * Que aparezca en las dos columnas y no simplemente desaparezca es lo que
   * hace posible medir la tasa de devolución: si la orden se esfumara, un
   * vendedor que devuelve todo tendría tasa `0 / 0` y mediría mejor que nadie.
   */
  it('⛔ una venta devuelta deja de contar', async () => {
    const v = await nuevoVendedor();
    const orden = await crearOrden(v, { status: 'DELIVERED', itemsSubtotal: 200_000 });
    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(200_000);

    await prisma.order.update({
      where: { id: orden.id },
      data: { status: 'REFUNDED', refundedAt: AHORA },
    });
    await devolver(orden);

    const medicion = await medirVolumenDe(prisma, v.sellerId, AHORA);

    expect(medicion.volumenElegible).toBe(0);
    // Y se sigue viendo que existió: es el denominador de la tasa.
    expect(medicion.brutoConfirmado).toBe(200_000);
    expect(medicion.devuelto).toBe(200_000);
    expect(medicion.tasaDeDevolucionBps).toBe(10_000);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * UNA DEVOLUCIÓN QUE TODAVÍA NO SE COMPLETÓ NO DESCUENTA NADA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `PENDING` y `PROCESSING` no devolvieron plata todavía; `FAILED` no la
   * devolvió nunca. Contarlas le sacaría el tramo a un vendedor por una
   * devolución que quizá falle — y la comisión de las órdenes hechas mientras
   * tanto ya quedó congelada, así que el error no se puede deshacer.
   */
  it('⛔ una devolución PENDING no descuenta ni mide', async () => {
    const v = await nuevoVendedor();
    const orden = await crearOrden(v, { status: 'DELIVERED', itemsSubtotal: 200_000 });
    await devolver(orden, { status: 'PENDING' });

    const medicion = await medirVolumenDe(prisma, v.sellerId, AHORA);

    expect(medicion.volumenElegible).toBe(200_000);
    expect(medicion.devuelto).toBe(0);
    expect(medicion.tasaDeDevolucionBps).toBe(0);
  });

  it('⛔ una devolución FAILED tampoco', async () => {
    const v = await nuevoVendedor();
    const orden = await crearOrden(v, { status: 'DELIVERED', itemsSubtotal: 200_000 });
    await devolver(orden, { status: 'FAILED' });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).devuelto).toBe(0);
  });

  it('⛔ una devolución en curso tampoco cuenta', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, { status: 'REFUND_PENDING', itemsSubtotal: 300_000 });
    await crearOrden(v, { status: 'PAYMENT_REQUIRES_REFUND', itemsSubtotal: 300_000 });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(0);
  });

  /**
   * `PAID` es la diferencia entre esta definición y la de analítica, y por eso
   * tiene test propio: el día que alguien las «unifique», acá se ve.
   */
  it('⛔ PAID no cuenta: cobrada todavía no es confirmada', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, { status: 'PAID', itemsSubtotal: 500_000 });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(0);
  });
});

describe('Volumen elegible — la ventana', () => {
  it('lo de hace una semana entra', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, {
      status: 'DELIVERED',
      itemsSubtotal: 100_000,
      createdAt: HACE_UNA_SEMANA,
    });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(100_000);
  });

  it('⛔ lo de hace 29 días queda afuera', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, { status: 'DELIVERED', itemsSubtotal: 100_000, createdAt: HACE_29_DIAS });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(0);
  });

  /**
   * El borde exacto. Vale la pena escribirlo porque un `>` en vez de un `>=`
   * no lo nota nadie hasta que un vendedor reclama por qué no le bajó la
   * comisión.
   */
  it('el borde de los 28 días está incluido', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, {
      status: 'DELIVERED',
      itemsSubtotal: 100_000,
      createdAt: inicioDeLaVentana(AHORA),
    });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(100_000);
  });

  it('un milisegundo antes del borde ya no', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, {
      status: 'DELIVERED',
      itemsSubtotal: 100_000,
      createdAt: new Date(inicioDeLaVentana(AHORA).getTime() - 1),
    });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(0);
  });
});

describe('Volumen elegible — el descuento que se come el envío', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EL CASO QUE OBLIGÓ A ESCRIBIR LA CONSULTA EN SQL
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * La base permite `discount_amount <= items_subtotal + shipping_amount`. O
   * sea: un cupón puede superar el valor de los productos si además cubre el
   * envío. En esa orden, `itemsSubtotal - discountAmount` es NEGATIVO.
   *
   * Con `aggregate` habría que sumar las dos columnas por separado y restarlas
   * después, y ese negativo le comería volumen a las demás órdenes. El
   * `GREATEST(..., 0)` por fila lo evita, igual que `baseDeComision` en
   * `pricing.ts`.
   *
   * Acá: una orden aporta 100.000 y la otra, con descuento total, aporta 0. Si
   * la resta fuera global daría 100.000 − 20.000 = 80.000, y el vendedor
   * perdería volumen por haber dado envío gratis.
   */
  it('una orden con descuento mayor al subtotal aporta cero, no negativo', async () => {
    const v = await nuevoVendedor();
    await crearOrden(v, { status: 'DELIVERED', itemsSubtotal: 100_000 });
    await crearOrden(v, {
      status: 'DELIVERED',
      itemsSubtotal: 50_000,
      shippingAmount: 20_000,
      discountAmount: 70_000,
    });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible).toBe(100_000);
  });
});

describe('Volumen elegible — el promedio que decide el tramo', () => {
  /**
   * El recorrido completo, con los números reales de los tramos: cuatro semanas
   * de $3.000.000 tienen que dar exactamente el umbral, ni un centavo menos.
   */
  it('cuatro semanas de $3.000.000 promedian justo el umbral del tramo', async () => {
    const v = await nuevoVendedor();
    for (let semana = 0; semana < 4; semana += 1) {
      await crearOrden(v, {
        status: 'DELIVERED',
        itemsSubtotal: 300_000_000,
        createdAt: new Date(AHORA.getTime() - semana * 7 * 86_400_000),
      });
    }

    const total = (await medirVolumenDe(prisma, v.sellerId, AHORA)).volumenElegible;

    expect(total).toBe(1_200_000_000);
    expect(promedioSemanal(total)).toBe(300_000_000);
  });

  /**
   * Y el mismo vendedor, con una de esas cuatro devuelta, cae por debajo. Es
   * el escenario que junta las dos mitades: la devolución sale del volumen y
   * el promedio deja de alcanzar el tramo.
   */
  it('si una de las cuatro se devuelve, el promedio ya no alcanza', async () => {
    const v = await nuevoVendedor();
    const ordenes = [];
    for (let semana = 0; semana < 4; semana += 1) {
      ordenes.push(
        await crearOrden(v, {
          status: 'DELIVERED',
          itemsSubtotal: 300_000_000,
          createdAt: new Date(AHORA.getTime() - semana * 7 * 86_400_000),
        }),
      );
    }

    await prisma.order.update({
      where: { id: ordenes[0]!.id },
      data: { status: 'REFUNDED', refundedAt: AHORA },
    });
    await devolver(ordenes[0]!);

    const medicion = await medirVolumenDe(prisma, v.sellerId, AHORA);

    expect(medicion.promedioSemanal).toBe(225_000_000);
    // Una de cuatro devuelta es exactamente el 25 %.
    expect(medicion.tasaDeDevolucionBps).toBe(2_500);
  });
});

/**
 * El prorrateo de las devoluciones.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOY NO HAY DEVOLUCIONES PARCIALES. ESTOS TESTS SON PARA EL DÍA QUE LAS HAYA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `payments.service.ts` crea toda devolución con `amount: intento.amount` —el
 * cobro completo—, y la máquina de estados ni siquiera deja devolver una orden
 * ya despachada. O sea: hoy toda devolución es total.
 *
 * El prorrateo está escrito y probado igual porque el cálculo tiene que estar
 * bien ANTES de que exista el flujo parcial. Si sumara el monto crudo sin
 * prorratear, una devolución de una orden con mucho envío descontaría del
 * volumen de producto plata que nunca fue producto — y el error saldría a la
 * luz como una comisión mal cobrada, no como una excepción.
 */
describe('Devoluciones prorrateadas', () => {
  /**
   * $100.000 de producto, $50.000 de envío. El bruto es $150.000.
   *
   * Devolver los $150.000 completos tiene que descontar $100.000 de volumen de
   * producto, no $150.000: el envío nunca fue volumen. Sumar el monto crudo
   * habría dejado el volumen en negativo.
   */
  it('una devolución total descuenta sólo la parte de producto', async () => {
    const v = await nuevoVendedor();
    const orden = await crearOrden(v, {
      status: 'DELIVERED',
      itemsSubtotal: 100_000,
      shippingAmount: 50_000,
    });

    await devolver(orden);
    const medicion = await medirVolumenDe(prisma, v.sellerId, AHORA);

    expect(medicion.brutoConfirmado).toBe(100_000);
    expect(medicion.devuelto).toBe(100_000);
    expect(medicion.volumenElegible).toBe(0);
  });

  /**
   * EL TEST DEL PRORRATEO.
   *
   * Sobre la misma orden —$100.000 producto + $50.000 envío = $150.000 bruto—,
   * devolver $75.000 es la mitad del bruto. La mitad del producto son $50.000.
   *
   * Sin prorratear se habrían descontado $75.000 de volumen: $25.000 de envío
   * contados como producto que se dejó de vender.
   */
  it('una devolución parcial descuenta la fracción proporcional', async () => {
    const v = await nuevoVendedor();
    const orden = await crearOrden(v, {
      status: 'DELIVERED',
      itemsSubtotal: 100_000,
      shippingAmount: 50_000,
    });

    await devolver(orden, { monto: 75_000 });
    const medicion = await medirVolumenDe(prisma, v.sellerId, AHORA);

    expect(medicion.devuelto).toBe(50_000);
    expect(medicion.volumenElegible).toBe(50_000);
    expect(medicion.tasaDeDevolucionBps).toBe(5_000);
  });

  it('varias devoluciones parciales sobre la misma orden se suman', async () => {
    const v = await nuevoVendedor();
    const orden = await crearOrden(v, { status: 'DELIVERED', itemsSubtotal: 100_000 });

    await devolver(orden, { monto: 30_000 });
    await devolver(orden, { monto: 20_000 });

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).devuelto).toBe(50_000);
  });

  /**
   * El techo. Una devolución no puede sacar más valor de producto del que la
   * orden tenía, pase lo que pase con los otros importes.
   */
  it('⛔ el descuento nunca supera la base de la orden', async () => {
    const v = await nuevoVendedor();
    const orden = await crearOrden(v, {
      status: 'DELIVERED',
      itemsSubtotal: 40_000,
      shippingAmount: 60_000,
    });

    await devolver(orden, { monto: 100_000 });
    const medicion = await medirVolumenDe(prisma, v.sellerId, AHORA);

    expect(medicion.devuelto).toBe(40_000);
    expect(medicion.volumenElegible).toBe(0);
  });

  /** El recargo del procesador tampoco es producto: mismo prorrateo. */
  it('el recargo del procesador no infla lo devuelto', async () => {
    const v = await nuevoVendedor();
    const orden = await crearOrden(v, {
      status: 'DELIVERED',
      itemsSubtotal: 100_000,
      processorSurchargeAmount: 20_000,
    });

    await devolver(orden);

    expect((await medirVolumenDe(prisma, v.sellerId, AHORA)).devuelto).toBe(100_000);
  });

  /**
   * Una devolución sobre una orden que nunca confirmó no mide nada: esa orden
   * no está en el denominador, así que tampoco puede estar en el numerador.
   */
  it('⛔ una devolución de una orden sin confirmar no entra en la tasa', async () => {
    const v = await nuevoVendedor();
    const orden = await crearOrden(v, { status: 'PAYMENT_REQUIRES_REFUND', itemsSubtotal: 500_000 });

    await devolver(orden);
    const medicion = await medirVolumenDe(prisma, v.sellerId, AHORA);

    expect(medicion.brutoConfirmado).toBe(0);
    expect(medicion.devuelto).toBe(0);
    expect(medicion.tasaDeDevolucionBps).toBe(0);
  });
});
