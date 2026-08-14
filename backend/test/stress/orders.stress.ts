import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { JwtService } from '@/modules/auth/jwt.service';
import type { OrdersReconciler } from '@/modules/orders/reconciler.service';
import type { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { crearAppDePrueba } from '../helpers/app';
import { ProveedorFalso } from '../helpers/proveedor-falso';

/**
 * Prueba de estrés de la cadena de compra.
 *
 *   pnpm stress:orders
 *   COMPRADORES=500 STOCK=50 pnpm stress:orders
 *
 * ─── Qué demuestra ───
 *
 * Que con N compradores comprando a la vez sobre S unidades, la plata y el
 * stock cierran: cada orden confirmada consumió exactamente una unidad, cada
 * pago tardío sin stock terminó en devolución, y nadie quedó pagado sin
 * resolución.
 *
 * Se mezclan a propósito los tres desenlaces —aprobado, rechazado y **estado
 * desconocido**— porque el tercero es el que rompe sistemas de pago y el que
 * no se puede provocar contra Mercado Pago real.
 */

const COMPRADORES = Number(process.env.COMPRADORES ?? 300);
const STOCK = Number(process.env.STOCK ?? 40);

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
  INVENTORY_RECONCILER_ENABLED: 'false',
  INVENTORY_EXPIRATION_QUEUE_ENABLED: 'false',
  ORDERS_RECONCILER_ENABLED: 'false',
  VENDOX_PLATFORM_FEE_BPS: '600',
};

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let reconciler: OrdersReconciler;
let proveedor: ProveedorFalso;

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { JwtService } = await import('@/modules/auth/jwt.service');
  const { PaymentProvider } = await import('@/modules/orders/payment-provider');
  const { OrdersReconciler } = await import('@/modules/orders/reconciler.service');
  const { PrismaService } = await import('@/shared/prisma/prisma.service');

  proveedor = new ProveedorFalso();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({ wsUrl: '', ensureRoom: vi.fn(), issueToken: vi.fn(), verifyWebhook: vi.fn() })
    .overrideProvider(PaymentProvider)
    .useValue(proveedor)
    .compile();

  app = await crearAppDePrueba(moduleRef);
  prisma = app.get(PrismaService);
  jwt = app.get(JwtService);
  reconciler = app.get(OrdersReconciler);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('La prueba de estrés borra datos y sólo corre contra una base *_test');
  }
});

afterAll(async () => {
  await app?.close();
});

function percentil(valores: number[], p: number): number {
  if (valores.length === 0) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.min(ordenados.length - 1, Math.floor((p / 100) * ordenados.length))]!;
}

const ms = (n: number): string => `${n.toFixed(1)} ms`;

describe('Estrés de la cadena de compra', () => {
  it(`${COMPRADORES} compradores contra ${STOCK} unidades`, async () => {
    const marca = Date.now();
    const servidor = (app as NestFastifyApplication).getHttpAdapter().getInstance();

    // ─── Vendedor con stock conocido ───
    const vendedorId = newId('usr');
    const sellerId = newId('sel');
    const storeId = newId('sto');
    const productId = newId('prd');
    const variantId = newId('var');
    const inventoryId = newId('inv');

    await prisma.user.create({
      data: {
        id: vendedorId,
        firstName: 'Estres',
        lastName: 'Ord',
        email: `estres-ord-vend-${marca}@test.local`,
        emailVerified: true,
        role: 'seller',
      },
    });

    await prisma.$transaction([
      prisma.seller.create({
        data: { id: sellerId, userId: vendedorId, displayName: 'E', slug: `e-ord-${marca}`, status: 'ACTIVE' },
      }),
      prisma.store.create({
        data: { id: storeId, sellerId, name: 'E', slug: `e-tienda-ord-${marca}`, isPrimary: true, status: 'ACTIVE' },
      }),
      prisma.product.create({
        data: {
          id: productId,
          storeId,
          name: 'Producto de estrés',
          slug: `e-prod-ord-${marca}`,
          basePriceCents: 890_000,
          status: 'ACTIVE',
        },
      }),
      prisma.productVariant.create({
        data: { id: variantId, productId, storeId, title: 'Default', optionsKey: '__default__', isDefault: true },
      }),
      prisma.inventory.create({
        data: { id: inventoryId, productVariantId: variantId, onHand: STOCK, reserved: 0 },
      }),
    ]);

    // ─── Compradores, con dirección ───
    const usuarios = Array.from({ length: COMPRADORES }, (_, i) => ({
      id: newId('usr'),
      firstName: 'Comprador',
      lastName: `${i}`,
      email: `estres-ord-${marca}-${i}@test.local`,
      emailVerified: true,
      role: 'buyer' as const,
    }));
    await prisma.user.createMany({ data: usuarios });
    await prisma.userAddress.createMany({
      data: usuarios.map((u) => ({
        id: newId('adr'),
        userId: u.id,
        recipientFullName: 'Ana Pérez',
        documentNumber: '30123456',
        phoneE164: '+5491122334455',
        street: 'Av. Corrientes',
        number: '1234',
        city: 'CABA',
        province: 'Buenos Aires',
        postalCode: 'C1043',
        isDefault: true,
      })),
    });

    const tokens = await Promise.all(
      usuarios.map(async (u) => {
        const { accessToken } = await jwt.issueAccessToken({
          userId: u.id,
          role: 'buyer',
          sessionId: newId('ses'),
        });
        return accessToken;
      }),
    );

    // ─── La ráfaga ───
    const latencias: number[] = [];
    const conteo = {
      sinStock: 0,
      ordenes: 0,
      aprobados: 0,
      rechazados: 0,
      inciertos: 0,
      errores: 0,
    };
    const erroresVistos = new Map<string, number>();

    const arranque = process.hrtime.bigint();

    await Promise.all(
      tokens.map(async (token, i) => {
        const t0 = process.hrtime.bigint();

        const pedir = async (method: string, url: string, body?: unknown, idem?: string) => {
          const headers: Record<string, string> = { authorization: `Bearer ${token}` };
          if (body !== undefined) headers['content-type'] = 'application/json';
          if (idem) headers['idempotency-key'] = idem;
          const res = await servidor.inject({
            method: method as never,
            url,
            headers,
            payload: body as never,
          });
          return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
        };

        // 1 · Reservar
        const reserva = await pedir(
          'POST',
          '/api/v1/inventory/reservations',
          { productVariantId: variantId, quantity: 1 },
          `est-r-${marca}-${i}`,
        );
        if (reserva.status !== 201) {
          conteo.sinStock += 1;
          latencias.push(Number(process.hrtime.bigint() - t0) / 1e6);
          return;
        }

        // 2 · Crear la orden
        const orden = await pedir(
          'POST',
          '/api/v1/orders',
          { reservationId: reserva.body.reservationId },
          `est-o-${marca}-${i}`,
        );
        if (orden.status !== 201) {
          conteo.errores += 1;
          erroresVistos.set(
            orden.body?.error?.code ?? `HTTP_${orden.status}`,
            (erroresVistos.get(orden.body?.error?.code ?? `HTTP_${orden.status}`) ?? 0) + 1,
          );
          return;
        }
        conteo.ordenes += 1;

        /**
         * 3 · Pagar, con los tres desenlaces mezclados.
         *
         * 70 % aprobado, 20 % rechazado, 10 % "no sabemos". La proporción no
         * pretende ser realista: busca que los tres caminos se ejerciten a la
         * vez, sobre todo el tercero.
         *
         * Se asigna por índice y no al azar para que la corrida sea
         * reproducible: un fallo que aparece una vez cada diez ejecuciones no
         * se puede depurar.
         *
         * ─── El guion va atado al TOKEN, no a un campo compartido ───
         *
         * Con trescientos cobros concurrentes, escribir `proveedor.proximo`
         * hace que todos lean el último valor: la primera versión de esta
         * prueba decía "70/20/10" y en realidad daba 100 % de lo que hubiera
         * puesto la última petición en llegar. El resultado se veía bien y no
         * probaba nada.
         */
        const suerte = i % 10;
        const cardToken = `tok_${marca}_${i}`;
        proveedor.porToken.set(
          cardToken,
          suerte < 7 ? { status: 'approved' } : suerte < 9 ? { status: 'rejected' } : { fallo: 'red' },
        );

        const pago = await pedir(
          'POST',
          `/api/v1/orders/${orden.body.id}/payment-attempts`,
          { cardToken, installments: 1, paymentMethodId: 'visa' },
        );

        if (pago.status === 201) conteo.aprobados += 1;
        else if (pago.status === 402) conteo.rechazados += 1;
        else if (pago.status === 202) conteo.inciertos += 1;
        else {
          conteo.errores += 1;
          const codigo = pago.body?.error?.code ?? `HTTP_${pago.status}`;
          erroresVistos.set(codigo, (erroresVistos.get(codigo) ?? 0) + 1);
        }

        latencias.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }),
    );

    const totalMs = Number(process.hrtime.bigint() - arranque) / 1e6;

    // ─── El conciliador resuelve los inciertos ───
    proveedor.alConsultar = { status: 'approved' };
    const conciliacion = await reconciler.barrer();

    // ─── Estado final según la BASE ───
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } });
    const porEstado = await prisma.order.groupBy({
      by: ['status'],
      where: { storeId },
      _count: true,
    });
    const confirmadas = porEstado.find((g) => g.status === 'CONFIRMED')?._count ?? 0;
    const conDevolucion =
      (porEstado.find((g) => g.status === 'REFUNDED')?._count ?? 0) +
      (porEstado.find((g) => g.status === 'PAYMENT_REQUIRES_REFUND')?._count ?? 0) +
      (porEstado.find((g) => g.status === 'REFUND_PENDING')?._count ?? 0);
    const pagadasSinResolver = porEstado.find((g) => g.status === 'PAID')?._count ?? 0;

    console.log(
      [
        '',
        '  ─── Recorrido ───',
        `  compradores          ${COMPRADORES}`,
        `  sin stock            ${conteo.sinStock}`,
        `  órdenes creadas      ${conteo.ordenes}`,
        `  cobros aprobados     ${conteo.aprobados}`,
        `  cobros rechazados    ${conteo.rechazados}`,
        `  cobros inciertos     ${conteo.inciertos}`,
        `  errores              ${conteo.errores}`,
        ...[...erroresVistos].map(([c, v]) => `      ${c}: ${v}`),
        '',
        '  ─── Latencia del recorrido completo (reservar + orden + cobro) ───',
        `  p50                  ${ms(percentil(latencias, 50))}`,
        `  p95                  ${ms(percentil(latencias, 95))}`,
        `  p99                  ${ms(percentil(latencias, 99))}`,
        `  ráfaga completa      ${ms(totalMs)}`,
        '',
        '  ─── Conciliación ───',
        `  cobros resueltos     ${conciliacion.cobrosResueltos}`,
        `  devoluciones         ${conciliacion.devolucionesReintentadas}`,
        '',
        '  ─── Estado final de PostgreSQL ───',
        `  onHand               ${inv.onHand}`,
        `  reserved             ${inv.reserved}`,
        `  disponibles          ${inv.onHand - inv.reserved}`,
        `  órdenes confirmadas  ${confirmadas}`,
        `  con devolución       ${conDevolucion}`,
        `  pagadas sin resolver ${pagadasSinResolver}`,
        ...porEstado.map((g) => `      ${g.status}: ${g._count}`),
        '',
      ].join('\n'),
    );

    // ─── Veredicto ───
    //
    // El criterio es la conservación: cada unidad que salió del inventario
    // corresponde a una orden confirmada, y ninguna orden quedó pagada sin
    // resolverse en un sentido o en el otro.

    expect(conteo.errores, 'peticiones fallidas por algo inesperado').toBe(0);

    expect(inv.onHand, 'unidades restantes').toBe(STOCK - confirmadas);
    expect(inv.onHand, 'stock nunca negativo').toBeGreaterThanOrEqual(0);
    expect(inv.reserved, 'reserved nunca supera onHand').toBeLessThanOrEqual(inv.onHand);

    expect(confirmadas, 'no se vendió más de lo que había').toBeLessThanOrEqual(STOCK);
    expect(pagadasSinResolver, 'órdenes pagadas sin confirmar ni devolver').toBe(0);

    // Toda orden que se llevó plata sin poder entregar tiene su devolución.
    const devolucionesCreadas = await prisma.refund.count({ where: { order: { storeId } } });
    expect(devolucionesCreadas, 'devoluciones creadas').toBe(conDevolucion);

    /**
     * Limpieza, en orden de dependencias.
     *
     * Los usuarios no se pueden borrar mientras tengan órdenes: hay una clave
     * foránea, y está bien que la haya — una orden sin comprador sería un
     * registro contable sin dueño. Primero se van las órdenes.
     */
    await prisma.refund.deleteMany({ where: { order: { storeId } } });
    await prisma.paymentAttempt.deleteMany({ where: { order: { storeId } } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.user.deleteMany({ where: { email: { startsWith: `estres-ord-${marca}` } } });
    await prisma.user.deleteMany({ where: { email: `estres-ord-vend-${marca}@test.local` } });
  });
});
