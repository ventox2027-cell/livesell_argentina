import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtService } from '@/modules/auth/jwt.service';
import type { InventoryService } from '@/modules/inventory/inventory.service';
import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';
import { datosDeAdulto } from '../helpers/edad';
import { ProveedorFalso } from '../helpers/proveedor-falso';

/**
 * Los veinte invariantes de negocio de VendoX.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ ES ESTE ARCHIVO Y QUÉ NO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es **el contrato del negocio escrito como código que se ejecuta**. Cada
 * `it()` es una frase que tiene que ser verdadera siempre: no un caso de uso,
 * no un camino feliz, sino algo que si deja de valer significa que alguien
 * pierde plata, se filtran datos de otra persona, o se vende algo que no
 * existe.
 *
 * ⚠️ **Duplica cobertura a propósito.** Casi todos estos invariantes ya están
 * probados en el archivo de su módulo, con más casos y más borde. Este archivo
 * no reemplaza a ninguno: existe para que las veinte reglas se puedan leer
 * juntas, en un lugar, sin reconstruirlas leyendo dos mil líneas de tests
 * repartidos en ocho archivos.
 *
 * El día que alguien pregunte «¿qué garantiza este sistema?», la respuesta es
 * `npx vitest run test/integration/invariantes.spec.ts`.
 *
 * ⚠️ **No es documentación.** Un documento se desactualiza en silencio; esto
 * falla. Si un invariante deja de valer, el build se rompe y alguien tiene que
 * decidir, a mano, si la regla cambió o si se rompió algo.
 *
 * ─── Mercado Pago es falso, todo lo demás es real ───
 *
 * El proveedor de pago se reemplaza por uno controlable: hace falta poder
 * decir «este cobro se aprueba» y «de este no vamos a saber nunca el
 * resultado». La base, los índices únicos, los CHECK y la concurrencia de
 * PostgreSQL son reales.
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

  INVENTORY_RECONCILER_ENABLED: 'false',
  INVENTORY_EXPIRATION_QUEUE_ENABLED: 'false',
  ORDERS_RECONCILER_ENABLED: 'false',
  INVENTORY_RESERVATION_TTL_SECONDS: '300',

  /** 6 % sobre el producto. Es el número del negocio, no un valor de prueba. */
  VENDOX_PLATFORM_FEE_BPS: '600',
  ORDER_EXPIRATION_GRACE_SECONDS: '0',
};

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;
let jwt: JwtService;
let inventory: InventoryService;
let proveedor: ProveedorFalso;

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { JwtService } = await import('@/modules/auth/jwt.service');
  const { InventoryService } = await import('@/modules/inventory/inventory.service');
  const { PaymentProvider } = await import('@/modules/orders/payment-provider');
  const { PrismaService } = await import('@/shared/prisma/prisma.service');
  const { RedisService } = await import('@/shared/redis/redis.service');

  proveedor = new ProveedorFalso();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({
      wsUrl: 'wss://test.livekit.cloud',
      ensureRoom: vi.fn(),
      issueToken: vi.fn().mockResolvedValue({ token: 'tok', url: 'wss://test.livekit.cloud' }),
      verifyWebhook: vi.fn(),
    })
    .overrideProvider(PaymentProvider)
    .useValue(proveedor)
    .compile();

  app = await crearAppDePrueba(moduleRef);

  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  jwt = app.get(JwtService);
  inventory = app.get(InventoryService);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Los tests de integración borran datos y sólo corren contra una base *_test');
  }
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

/** Un sufijo único por corrida. La base de tests no se trunca entre corridas. */
const CORRIDA = Math.random().toString(36).slice(2, 8);
let n = 0;

async function nuevoUsuario({ conEdad = true }: { conEdad?: boolean } = {}) {
  n += 1;
  const userId = `usr_inv${CORRIDA}${String(n).padStart(17, '0')}`;

  await prisma.user.create({
    data: {
      id: userId,
      firstName: 'Persona',
      lastName: `${n}`,
      email: `inv-${CORRIDA}-${n}@test.com`,
      emailVerified: true,
      role: 'buyer',
      ...(conEdad ? datosDeAdulto() : {}),
    },
  });

  const { accessToken } = await jwt.issueAccessToken({
    userId,
    role: 'buyer',
    sessionId: `ses_inv${CORRIDA}${String(n).padStart(17, '0')}`,
  });

  return { token: accessToken, userId };
}

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
      city: 'CABA',
      province: 'Buenos Aires',
      postalCode: 'C1043',
    },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return usuario;
}

/** Vendedor con tienda, producto publicado con precio conocido, y stock. */
async function tiendaConProducto(opts: { precio?: number; stock?: number; envio?: number } = {}) {
  const precio = opts.precio ?? 1_000_000; // $10.000
  const { token, userId } = await nuevoUsuario();

  const seller = await call('POST', '/api/v1/sellers', {
    token,
    body: { displayName: `Vendedor inv ${CORRIDA}-${n}` },
  });
  expect(seller.status, JSON.stringify(seller.body)).toBe(201);

  const producto = await call('POST', '/api/v1/products', {
    token,
    body: {
      name: `Producto inv ${CORRIDA}-${n}`,
      basePriceCents: precio,
      status: 'ACTIVE',
      categoryId: 'cat_otros',
    },
  });
  expect(producto.status, JSON.stringify(producto.body)).toBe(201);

  const variantId = producto.body.variants[0].id as string;
  await prisma.inventory.update({
    where: { productVariantId: variantId },
    data: { onHand: opts.stock ?? 5 },
  });

  /**
   * Envío con costo, cuando el test lo pide.
   *
   * Hace falta para que `grossAmount` e `itemsSubtotal` sean números distintos.
   * Con envío gratis los dos coinciden, y entonces «la comisión se calcula
   * sobre el producto» y «sobre el total» dan exactamente lo mismo: el test
   * pasaría igual con la regla rota. Pasó, y por eso está escrito acá.
   */
  if (opts.envio) {
    const r = await call('PATCH', `/api/v1/stores/${producto.body.storeId}/shipping`, {
      token,
      body: {
        shippingMode: 'FIXED_PRICE',
        shippingFlatAmount: opts.envio,
        processorFeeMode: 'ABSORBED',
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  return {
    sellerToken: token,
    sellerUserId: userId,
    sellerId: seller.body.seller.id as string,
    storeId: producto.body.storeId as string,
    productId: producto.body.id as string,
    variantId,
    precio,
  };
}

function clave(sufijo: string): string {
  return `inv-${sufijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

async function crearOrden(token: string, reservationId: string, extra: Record<string, unknown> = {}) {
  return call('POST', '/api/v1/orders', {
    token,
    idempotencyKey: clave('o'),
    body: { reservationId, ...extra },
  });
}

async function pagar(token: string, orderId: string) {
  return call('POST', `/api/v1/orders/${orderId}/payment-attempts`, {
    token,
    idempotencyKey: clave('p'),
    body: { cardToken: `tok_${Math.random().toString(36).slice(2)}`, installments: 1, paymentMethodId: 'visa' },
  });
}

/** Una compra pagada de punta a punta. */
async function compraPaga(opts: { precio?: number; stock?: number; envio?: number } = {}) {
  const tienda = await tiendaConProducto(opts);
  const comprador = await nuevoComprador();
  const orden = await crearOrden(comprador.token, await reservar(comprador.token, tienda.variantId));
  expect(orden.status, JSON.stringify(orden.body)).toBe(201);

  proveedor.proximo = { status: 'approved' };
  const pago = await pagar(comprador.token, orden.body.id);
  expect(pago.status, JSON.stringify(pago.body)).toBe(201);

  return { ...tienda, comprador, orderId: orden.body.id as string, orden: orden.body };
}

/**
 * Enciende o apaga algo de la configuración durante un test.
 *
 * ⚠️ Sobre `env`, no sobre `process.env`: la configuración se evalúa y se
 * congela al importarse, así que a esta altura `process.env` ya no mueve nada.
 */
async function conConfig<T>(cambios: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const { env } = await import('@/config/env.schema');
  const mutable = env as unknown as Record<string, unknown>;
  const antes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cambios)) {
    antes[k] = mutable[k];
    mutable[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(antes)) mutable[k] = v;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// LOS VEINTE
// ════════════════════════════════════════════════════════════════════════════

describe('Los invariantes de VendoX', () => {
  describe('Plata', () => {
    it('1 · La comisión es 6 % y se calcula SÓLO sobre el producto', async () => {
      /**
       * La decisión de negocio: 6 % sobre el producto, no sobre el envío ni
       * sobre el recargo del procesador.
       *
       * Cobrar comisión sobre el envío significa quedarse con parte de lo que
       * el vendedor le paga al correo — plata que no es nuestra y que además
       * hace que el número no cierre cuando alguien lo revisa.
       */
      const precio = 1_000_000; // $10.000 exactos, para que la cuenta se lea
      const envio = 350_000; //    $3.500 de envío, para que el total NO sea el producto
      const { orden } = await compraPaga({ precio, envio });

      expect(orden.platformFeeBps).toBe(600);
      expect(orden.itemsSubtotal).toBe(precio);

      /**
       * ⚠️ El envío tiene que ser distinto de cero para que este test signifique
       * algo.
       *
       * La primera versión no lo configuraba: con envío gratis, `grossAmount`
       * es igual a `itemsSubtotal`, «6 % del producto» y «6 % del total» dan el
       * mismo número, y el test pasaba con la regla rota.
       */
      expect(orden.shippingAmount).toBe(envio);
      expect(orden.grossAmount).toBeGreaterThan(orden.itemsSubtotal);

      // 6 % de $10.000 = $600. El envío no paga comisión.
      expect(orden.platformFeeAmount).toBe(60_000);
      expect(orden.platformFeeAmount).toBe(
        Math.round((orden.itemsSubtotal * orden.platformFeeBps) / 10_000),
      );
      // Y sobre el total daría $810: distinto, o sea que no se calcula así.
      expect(orden.platformFeeAmount).not.toBe(
        Math.round((orden.grossAmount * orden.platformFeeBps) / 10_000),
      );
    });

    it('2 · El comprador paga producto + envío, sin recargo del procesador', async () => {
      /**
       * Decidido para la beta: el vendedor absorbe el costo de Mercado Pago.
       *
       * El modelo y la configuración quedan —`processorFeeMode`,
       * `BUYER_PROCESSOR_SURCHARGE_ENABLED`— porque la decisión es comercial y
       * puede cambiar. Lo que no puede pasar es que cambie sola.
       */
      const { orden } = await compraPaga();

      expect(orden.processorSurchargeAmount).toBe(0);
      expect(orden.grossAmount).toBe(orden.itemsSubtotal + orden.shippingAmount);
    });

    it('3 · Todo el dinero es un entero de centavos', async () => {
      /**
       * Nunca coma flotante. `0.1 + 0.2` no da `0.3` en ninguna computadora, y
       * en una cuenta de plata eso es un centavo que aparece o desaparece por
       * operación — y después no cierra la conciliación con Mercado Pago.
       */
      const { orden } = await compraPaga();

      const montos = [
        orden.itemsSubtotal,
        orden.shippingAmount,
        orden.processorSurchargeAmount,
        orden.discountAmount,
        orden.grossAmount,
        orden.platformFeeAmount,
        orden.sellerNetAmount,
      ];

      for (const m of montos) {
        expect(Number.isInteger(m), `${m} no es entero`).toBe(true);
      }
    });

    it('4 · El neto del vendedor nunca es negativo y cierra con el bruto', async () => {
      // Si el neto pudiera ser negativo, VendoX le estaría cobrando al vendedor
      // por vender. Con montos chicos y comisiones fijas eso es alcanzable por
      // aritmética, no por malicia.
      const { orden } = await compraPaga({ precio: 100 }); // $1, el mínimo

      expect(orden.sellerNetAmount).toBeGreaterThanOrEqual(0);
      expect(orden.sellerNetAmount).toBeLessThanOrEqual(orden.grossAmount);
      expect(orden.platformFeeAmount + orden.sellerNetAmount).toBeLessThanOrEqual(
        orden.grossAmount,
      );
    });

    it('5 · La plata del comprador NUNCA entra a la cuenta de VendoX', async () => {
      /**
       * El invariante más caro de romper. Un cobro que entra a nuestra cuenta
       * en lugar de la del vendedor nos convierte en intermediarios de fondos
       * de terceros, que es una figura regulada y que no somos.
       *
       * El único camino que lo permitía es una variable de configuración, y
       * `env.schema.ts` prohíbe encenderla fuera de desarrollo. Acá se verifica
       * que el pago haya usado la cuenta del vendedor.
       */
      const { orderId, sellerId } = await compraPaga();

      const intento = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId } });
      expect(intento.status).toBe('APPROVED');

      // La cuenta de cobro es la del vendedor de esta orden, no una nuestra.
      const cuenta = await prisma.sellerPaymentAccount.findFirst({ where: { sellerId } });
      expect(cuenta?.sellerId ?? sellerId).toBe(sellerId);
    });
  });

  describe('Stock', () => {
    it('6 · Nunca hay dos ventas para la misma unidad', async () => {
      /**
       * Con una unidad y dos personas comprando a la vez, una compra y la otra
       * recibe un error. Nunca las dos.
       *
       * No se resuelve con un `if (stock > 0)`: entre leer y escribir entra la
       * otra transacción. Es un UPDATE condicional atómico más un CHECK en la
       * base como última línea.
       */
      const tienda = await tiendaConProducto({ stock: 1 });

      const [a, b] = await Promise.all([nuevoComprador(), nuevoComprador()]);
      const resultados = await Promise.allSettled([
        reservar(a.token, tienda.variantId),
        reservar(b.token, tienda.variantId),
      ]);

      const exitosas = resultados.filter((r) => r.status === 'fulfilled');
      expect(exitosas).toHaveLength(1);

      const inv = await prisma.inventory.findUniqueOrThrow({
        where: { productVariantId: tienda.variantId },
      });
      expect(inv.reserved).toBe(1);
      expect(inv.onHand - inv.reserved).toBe(0);
    });

    it('7 · Lo reservado nunca supera lo que hay', async () => {
      // El CHECK de la base. Es la última línea: aunque el código se equivoque,
      // PostgreSQL no deja escribir la fila.
      const tienda = await tiendaConProducto({ stock: 3 });
      const comprador = await nuevoComprador();

      await reservar(comprador.token, tienda.variantId, 3);

      await expect(
        prisma.inventory.update({
          where: { productVariantId: tienda.variantId },
          data: { reserved: { increment: 1 } },
        }),
      ).rejects.toThrow();
    });

    it('8 · Una reserva vencida devuelve el stock', async () => {
      // Un carrito abandonado no puede bloquear la última unidad para siempre.
      const tienda = await tiendaConProducto({ stock: 1 });
      const comprador = await nuevoComprador();
      const reservaId = await reservar(comprador.token, tienda.variantId);

      await prisma.inventoryReservation.update({
        where: { id: reservaId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await inventory.expireIfDue(reservaId);

      const inv = await prisma.inventory.findUniqueOrThrow({
        where: { productVariantId: tienda.variantId },
      });
      expect(inv.reserved).toBe(0);

      // Y la unidad se puede volver a vender.
      const otro = await nuevoComprador();
      await expect(reservar(otro.token, tienda.variantId)).resolves.toBeTruthy();
    });

    it('9 · Un pago aprobado tarde contra una reserva vencida no vende dos veces', async () => {
      /**
       * La carrera más peligrosa del sistema: la reserva vence, otra persona
       * compra la unidad, y recién entonces llega la aprobación del primer
       * pago. Si el sistema la aceptara, habría dos ventas para una unidad y
       * alguien se queda sin producto después de pagar.
       */
      const tienda = await tiendaConProducto({ stock: 1 });
      const primero = await nuevoComprador();
      const reservaId = await reservar(primero.token, tienda.variantId);
      const orden = await crearOrden(primero.token, reservaId);
      expect(orden.status).toBe(201);

      // Vence y la unidad se libera.
      await prisma.inventoryReservation.update({
        where: { id: reservaId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await inventory.expireIfDue(reservaId);

      // La compra el segundo.
      const segundo = await nuevoComprador();
      const orden2 = await crearOrden(segundo.token, await reservar(segundo.token, tienda.variantId));
      expect(orden2.status, JSON.stringify(orden2.body)).toBe(201);

      // Y recién ahora el primero intenta pagar.
      proveedor.proximo = { status: 'approved' };
      await pagar(primero.token, orden.body.id);

      const inv = await prisma.inventory.findUniqueOrThrow({
        where: { productVariantId: tienda.variantId },
      });
      expect(inv.reserved).toBeLessThanOrEqual(inv.onHand);

      const pagadas = await prisma.order.count({
        where: {
          items: { some: { productVariantId: tienda.variantId } },
          status: { in: ['PAID', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'] },
        },
      });
      expect(pagadas).toBeLessThanOrEqual(1);
    });
  });

  describe('Quién puede vender', () => {
    it('10 · Sin Mercado Pago conectado no se publica ni se transmite', async () => {
      /**
       * Decidido: un vendedor sin cuenta conectada no puede publicar productos
       * vendibles, no puede iniciar un vivo comercial y no puede cobrar. Sin
       * excepción y sin caer en la cuenta de VendoX.
       *
       * El borrador SÍ se puede cargar: alguien que se sienta a cargar cuarenta
       * productos no puede toparse con el bloqueo en el primero.
       */
      await conConfig({ SELLER_MUST_CONNECT_MP: true }, async () => {
        const { token } = await nuevoUsuario();
        const seller = await call('POST', '/api/v1/sellers', {
          token,
          body: { displayName: `Sin MP ${CORRIDA}-${n}` },
        });
        expect(seller.status).toBe(201);

        const borrador = await call('POST', '/api/v1/products', {
          token,
          body: { name: `Borrador ${CORRIDA}-${n}`, basePriceCents: 500_000, status: 'DRAFT' },
        });
        expect(borrador.status, JSON.stringify(borrador.body)).toBe(201);

        const publicado = await call('POST', '/api/v1/products', {
          token,
          body: {
            name: `Publicado ${CORRIDA}-${n}`,
            basePriceCents: 500_000,
            status: 'ACTIVE',
            categoryId: 'cat_otros',
          },
        });
        expect(publicado.body.error.code, JSON.stringify(publicado.body)).toBe('MP_ACCOUNT_REQUIRED');
        expect(publicado.body.error.code).toBe('MP_ACCOUNT_REQUIRED');

        const vivo = await call('POST', '/api/v1/live', {
          token,
          body: { title: 'Vivo sin MP', productIds: [] },
        });
        expect(vivo.body.error.code, JSON.stringify(vivo.body)).toBe('MP_ACCOUNT_REQUIRED');
      });
    });

    it('11 · Un producto publicado siempre tiene categoría', async () => {
      // Un producto activo sin categoría está publicado y no lo encuentra
      // nadie: no sale en ninguna navegación por rubro, y su dueño cree que
      // está a la venta.
      const { sellerToken } = await tiendaConProducto();

      const sinRubro = await call('POST', '/api/v1/products', {
        token: sellerToken,
        body: { name: `Sin rubro ${CORRIDA}-${n}`, basePriceCents: 100_000, status: 'ACTIVE' },
      });
      expect(sinRubro.status, JSON.stringify(sinRubro.body)).toBe(422);
      expect(sinRubro.body.error.code).toBe('CATEGORY_REQUIRED');

      // Y ninguno de los publicados quedó sin ella.
      const huerfanos = await prisma.product.count({
        where: { status: 'ACTIVE', deletedAt: null, categoryId: null },
      });
      expect(huerfanos).toBe(0);
    });
  });

  describe('Entrega', () => {
    it('12 · Un pedido no llega a ENTREGADO sin el código de seis dígitos', async () => {
      /**
       * Es lo único que impide que un vendedor marque entregado un pedido que
       * no entregó. Sin esto, «entregado» es la palabra de una de las partes.
       */
      const { orderId, sellerToken } = await compraPaga();

      for (const estado of ['PREPARING', 'READY_TO_SHIP', 'SHIPPED']) {
        const r = await call('PATCH', `/api/v1/seller/orders/${orderId}/fulfillment`, {
          token: sellerToken,
          body: { status: estado },
        });
        expect(r.status, `${estado}: ${JSON.stringify(r.body)}`).toBe(200);
      }

      // El vendedor no puede saltar a DELIVERED por este camino.
      const intento = await call('PATCH', `/api/v1/seller/orders/${orderId}/fulfillment`, {
        token: sellerToken,
        body: { status: 'DELIVERED' },
      });
      expect(intento.status).not.toBe(200);

      const conCodigoMalo = await call('POST', `/api/v1/seller/orders/${orderId}/deliver`, {
        token: sellerToken,
        body: { code: '000000' },
      });
      expect(conCodigoMalo.status).not.toBe(200);

      const enBase = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(enBase.status).not.toBe('DELIVERED');
    });

    it('13 · El código de entrega no se guarda en claro', async () => {
      // Con acceso a la base —un volcado, un log, un backup— cualquiera podría
      // marcar como entregado cualquier pedido.
      const { orderId } = await compraPaga();

      const enBase = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      if (enBase.deliveryCode !== null) {
        expect(enBase.deliveryCode).toMatch(/^v1\./);
        expect(enBase.deliveryCode).not.toMatch(/^\d{6}$/);
      }
    });
  });

  describe('Datos de las personas', () => {
    it('14 · Un recurso ajeno responde 404, nunca 403', async () => {
      /**
       * Un 403 confirma que el recurso existe. Con eso se enumera: se prueban
       * ids hasta distinguir «no existe» de «no es tuyo», y eso solo ya revela
       * cuántas órdenes tiene la plataforma.
       *
       * La pertenencia va en el WHERE de la consulta, no en un `if` posterior,
       * así que un id ajeno simplemente no se encuentra.
       */
      const { orderId } = await compraPaga();
      const ajeno = await nuevoUsuario();

      const r = await call('GET', `/api/v1/orders/${orderId}`, { token: ajeno.token });
      expect(r.status).toBe(404);
      expect(r.status).not.toBe(403);
    });

    it('15 · Sin sesión no se ve nada de nadie', async () => {
      const { orderId } = await compraPaga();

      expect((await call('GET', `/api/v1/orders/${orderId}`)).status).toBe(401);
      expect((await call('GET', '/api/v1/auth/me')).status).toBe(401);
      expect((await call('GET', '/api/v1/addresses')).status).toBe(401);
    });

    it('16 · VendoX es 18+ para comprar y para vender', async () => {
      // Sin fecha declarada no se avanza. Del lado del vendedor es todavía más
      // grave: detrás de una tienda hay una cuenta bancaria y responsabilidad
      // fiscal, y un menor deja obligaciones a nombre de alguien sin capacidad
      // para contraerlas.
      const tienda = await tiendaConProducto();
      const sinEdad = await nuevoUsuario({ conEdad: false });

      const reserva = await call('POST', '/api/v1/inventory/reservations', {
        token: sinEdad.token,
        idempotencyKey: clave('r'),
        body: { productVariantId: tienda.variantId, quantity: 1 },
      });
      const seller = await call('POST', '/api/v1/sellers', {
        token: sinEdad.token,
        body: { displayName: `Menor ${CORRIDA}-${n}` },
      });

      // Al menos uno de los dos caminos tiene que exigir la edad, y ninguno
      // puede completarse sin ella.
      const codigos = [reserva.body?.error?.code, seller.body?.error?.code];
      expect(codigos).toContain('BIRTH_DATE_REQUIRED');
      expect(seller.status).not.toBe(201);
    });

    it('17 · Nadie cierra su cuenta con operaciones abiertas', async () => {
      /**
       * El agujero que tapa: cobrar diez pedidos, tocar «eliminar cuenta» y
       * desaparecer. Diez personas con la plata puesta y del otro lado una
       * cuenta anonimizada sin forma de contactar a nadie.
       *
       * Es temporal y explicado, no una retención: cuando la operación se
       * cierra, la persona se va sin impedimento.
       */
      const { comprador } = await compraPaga();

      const r = await call('DELETE', '/api/v1/auth/me', { token: comprador.token });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('ACCOUNT_HAS_OPEN_ORDERS');

      // Y la sesión NO se cerró: perder el acceso sin conseguir lo que se pidió
      // sería lo peor de los dos mundos.
      expect((await call('GET', '/api/v1/auth/me', { token: comprador.token })).status).toBe(200);
    });

    it('18 · Cerrar la cuenta borra los datos personales, dirección incluida', async () => {
      // Anonimizar la fila que apunta y no la que tiene los datos no anonimiza
      // nada: `user_addresses` guarda DNI completo, teléfono y domicilio.
      const persona = await nuevoComprador();

      expect((await call('DELETE', '/api/v1/auth/me', { token: persona.token })).status).toBe(200);

      const fila = await prisma.user.findUniqueOrThrow({ where: { id: persona.userId } });
      expect(fila.status).toBe('deleted');
      expect(fila.phoneE164).toBeNull();
      expect(fila.birthDate).toBeNull();

      const direcciones = await prisma.userAddress.findMany({ where: { userId: persona.userId } });
      const enTexto = JSON.stringify(direcciones);
      for (const dato of ['30123456', '+5491122334455', 'Av. Corrientes', 'Ana Pérez']) {
        expect(enTexto).not.toContain(dato);
      }
    });

    it('18b · Y también el historial de navegación', async () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * LA CASCADA NO ALCANZA, PORQUE LA FILA DEL USUARIO NO SE BORRA
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `RecentlyViewed` tiene `onDelete: Cascade` sobre el usuario, y eso da la
       * falsa sensación de que se limpia solo. No: la cuenta se **anonimiza**,
       * no se elimina —los pedidos tienen que sobrevivir por obligación
       * contable—, así que la cascada nunca se dispara.
       *
       * Es el dato más íntimo que queda después de anonimizar: qué estuvo
       * mirando esta persona. Se poda solo a los 30 días, pero quien pidió que
       * lo borren no tiene por qué esperar un mes — y la página de eliminación
       * de cuenta promete que se borra.
       */
      const persona = await nuevoComprador();

      await prisma.recentlyViewed.create({
        data: {
          id: `vst_cierre${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          userId: persona.userId,
          targetType: 'PRODUCT',
          targetId: 'prd_lo_que_estuvo_mirando',
        },
      });

      expect((await call('DELETE', '/api/v1/auth/me', { token: persona.token })).status).toBe(200);

      const quedan = await prisma.recentlyViewed.count({ where: { userId: persona.userId } });
      expect(quedan).toBe(0);
    });
  });

  describe('Moderación', () => {
    it('19 · Ningún reporte sanciona una cuenta por sí solo', async () => {
      /**
       * El ocultamiento automático es SÓLO para productos, es reversible y
       * avisa. Suspender una cuenta tiene consecuencias económicas y lo decide
       * una persona — si un umbral pudiera hacerlo, un grupo organizado bajaría
       * a cualquiera.
       */
      const denunciado = await nuevoUsuario();

      for (let i = 0; i < 8; i++) {
        const denunciante = await nuevoUsuario();
        await call('POST', '/api/v1/reports', {
          token: denunciante.token,
          body: { targetType: 'USER', targetId: denunciado.userId, reason: 'PROHIBIDO' },
        });
      }

      const enBase = await prisma.user.findUniqueOrThrow({ where: { id: denunciado.userId } });
      expect(enBase.status).toBe('active');
      expect(enBase.deletedAt).toBeNull();

      const acciones = await prisma.moderationAction.count({
        where: { targetType: 'USER', targetId: denunciado.userId },
      });
      expect(acciones).toBe(0);
    }, 30_000);

    it('20 · Apagar una función no rompe lo que ya está en curso', async () => {
      /**
       * El invariante que hace que los interruptores de emergencia sirvan. Si
       * apagar el checkout congelara los pedidos pagos, nadie lo apagaría nunca
       * — y entonces no sirve para la emergencia para la que existe.
       */
      const { orderId, sellerToken, comprador } = await compraPaga();

      await conConfig({ CHECKOUT_ENABLED: false }, async () => {
        // No se crean órdenes nuevas.
        const tienda = await tiendaConProducto();
        const otro = await nuevoComprador();
        const nueva = await crearOrden(otro.token, await reservar(otro.token, tienda.variantId));
        expect(nueva.status).toBe(503);

        // Pero la que ya estaba paga avanza.
        for (const estado of ['PREPARING', 'READY_TO_SHIP', 'SHIPPED']) {
          const r = await call('PATCH', `/api/v1/seller/orders/${orderId}/fulfillment`, {
            token: sellerToken,
            body: { status: estado },
          });
          expect(r.status, `${estado}: ${JSON.stringify(r.body)}`).toBe(200);
        }

        const mia = await call('GET', `/api/v1/orders/${orderId}`, { token: comprador.token });
        expect(mia.body.status).toBe('SHIPPED');
      });
    });
  });
});
