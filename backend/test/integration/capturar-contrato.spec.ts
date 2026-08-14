import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '@/shared/prisma/prisma.service';

import { crearAppDePrueba } from '../helpers/app';

/**
 * Captura las respuestas REALES de la API para los tests de contrato de Flutter.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE ESTE ARCHIVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ya pasó una vez y costó caro: un test de contrato en Flutter escrito con un
 * JSON **inventado a mano** pasaba en verde mientras la app de verdad mostraba
 * `$0,00` en la hoja de variantes. El JSON inventado se parecía al real, pero
 * no lo era, y el test confirmaba una fantasía.
 *
 * La regla que salió de ahí: **el JSON de un test de contrato se copia de una
 * respuesta real, nunca se escribe a mano**. Esto es lo que la hace cumplible
 * sin tener el servidor levantado: arranca la aplicación de verdad, con la base
 * de verdad, pide los endpoints y escribe las respuestas a
 * `test/contratos/*.json`.
 *
 * Esos archivos son los que después leen los tests de Flutter.
 *
 * ⚠️ No es un test: no afirma nada sobre el negocio. Es una herramienta que
 * vive como test porque necesita la aplicación entera arrancada, que es
 * exactamente lo que el arnés de integración ya sabe hacer.
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
  STORE_REOPEN_SWEEP_ENABLED: 'false',
  NOTIFICATIONS_DISPATCHER_ENABLED: 'false',
  INVENTORY_RECONCILER_ENABLED: 'false',
  INVENTORY_EXPIRATION_QUEUE_ENABLED: 'false',
  ORDERS_RECONCILER_ENABLED: 'false',
};

let app: INestApplication;
let prisma: PrismaService;

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { PrismaService } = await import('@/shared/prisma/prisma.service');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({ wsUrl: '', ensureRoom: vi.fn(), issueToken: vi.fn(), verifyWebhook: vi.fn() })
    .compile();

  app = await crearAppDePrueba(moduleRef);
  prisma = app.get(PrismaService);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Sólo corre contra una base *_test');
  }
});

afterAll(async () => {
  await app?.close();
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

  return { status: res.statusCode, texto: res.body, body: res.body ? JSON.parse(res.body) : null };
}

function guardar(nombre: string, cuerpo: unknown): void {
  writeFileSync(
    `test/contratos/${nombre}.json`,
    `${JSON.stringify(cuerpo, null, 2)}\n`,
    'utf8',
  );
}

describe('Captura de contratos', () => {
  it('escribe las respuestas reales a test/contratos/', async () => {
    const marca = Date.now().toString(36);

    // ── Un vendedor con política de envío y de cambios ────────────────────
    const vendedor = await call('POST', '/api/v1/auth/dev', {
      body: {
        email: `contrato-${marca}@test.com`,
        firstName: 'Contrato',
        lastName: 'Captura',
        device: {
          installId: `install-contrato-${marca}`,
          platform: 'android',
          appVersion: '1.0.0',
          osVersion: '14',
        },
      },
    });
    const token = vendedor.body.accessToken as string;

    const seller = await call('POST', '/api/v1/sellers', {
      token,
      body: { displayName: `Tejidos Marta ${marca}`, storeName: `Tejidos Marta ${marca}` },
    });
    expect(seller.status, seller.texto).toBe(201);
    const storeId = seller.body.store.id as string;

    const envio = await call('PATCH', `/api/v1/stores/${storeId}/shipping`, {
      token,
      body: {
        shippingMode: 'FIXED_OR_PICKUP',
        shippingFlatAmount: 350_000,
        shippingNote: 'Envíos los martes y jueves. Retiro por Palermo.',
        processorFeeMode: 'PASSED_TO_BUYER',
      },
    });
    expect(envio.status, envio.texto).toBe(200);

    const cambios = await call('PATCH', `/api/v1/stores/${storeId}/exchange-policy`, {
      token,
      body: {
        exchangeMode: 'CAMBIO_SIN_CAUSA',
        exchangeWindowDays: 30,
        returnShippingPaidBy: 'COMPRADOR',
        exchangeNote: 'Con la etiqueta puesta y sin uso.',
      },
    });
    expect(cambios.status, cambios.texto).toBe(200);

    // ── Un producto con dos ejes ──────────────────────────────────────────
    const producto = await call('POST', '/api/v1/products', {
      token,
      body: {
        name: 'Buzo oversize de algodón',
        description: 'Tejido a mano, algodón peinado.',
        basePriceCents: 890_000,
        status: 'ACTIVE',
        options: [
          { name: 'Talle', values: ['S', 'M'] },
          { name: 'Color', values: ['Negro'] },
        ],
      },
    });
    expect(producto.status, producto.texto).toBe(201);
    const productId = producto.body.id as string;

    const detalleSeller = await call('GET', `/api/v1/products/${productId}`, { token });
    for (const v of detalleSeller.body.variants as Array<{ id: string }>) {
      await prisma.inventory.update({
        where: { productVariantId: v.id },
        data: { onHand: 4 },
      });
    }

    // ── Lo que ve quien compra ────────────────────────────────────────────
    const publico = await call('GET', `/api/v1/catalog/products/${productId}`);
    expect(publico.status, publico.texto).toBe(200);
    guardar('catalogo-producto', publico.body);

    // ── Una orden con envío y recargo ─────────────────────────────────────
    const comprador = await call('POST', '/api/v1/auth/dev', {
      body: {
        email: `contrato-c-${marca}@test.com`,
        firstName: 'Ana',
        lastName: 'Pérez',
        device: {
          installId: `install-contrato-c-${marca}`,
          platform: 'android',
          appVersion: '1.0.0',
          osVersion: '14',
        },
      },
    });
    const tokenComprador = comprador.body.accessToken as string;

    await call('POST', '/api/v1/addresses', {
      token: tokenComprador,
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
      },
    });

    const variantId = (publico.body.variantes as Array<{ id: string }>)[0]!.id;
    const reserva = await call('POST', '/api/v1/inventory/reservations', {
      token: tokenComprador,
      idempotencyKey: `contrato-r-${marca}`,
      body: { productVariantId: variantId, quantity: 1 },
    });
    expect(reserva.status, reserva.texto).toBe(201);

    const orden = await call('POST', '/api/v1/orders', {
      token: tokenComprador,
      idempotencyKey: `contrato-o-${marca}`,
      body: { reservationId: reserva.body.reservationId },
    });
    expect(orden.status, orden.texto).toBe(201);
    guardar('orden-con-envio', orden.body);

    // ── Una orden con retiro en persona ───────────────────────────────────
    //
    // Con la OTRA variante a propósito: una reserva activa del mismo producto se
    // reutiliza, y con la misma reserva `POST /orders` devuelve la orden que ya
    // existe —es idempotente por reserva— así que la captura habría guardado dos
    // veces el mismo pedido.
    const otraVariante = (publico.body.variantes as Array<{ id: string }>)[1]!.id;
    const reserva2 = await call('POST', '/api/v1/inventory/reservations', {
      token: tokenComprador,
      idempotencyKey: `contrato-r2-${marca}`,
      body: { productVariantId: otraVariante, quantity: 1 },
    });
    expect(reserva2.status, reserva2.texto).toBe(201);
    const orden2 = await call('POST', '/api/v1/orders', {
      token: tokenComprador,
      idempotencyKey: `contrato-o2-${marca}`,
      body: { reservationId: reserva2.body.reservationId, retiraEnPersona: true },
    });
    expect(orden2.status, orden2.texto).toBe(201);
    guardar('orden-con-retiro', orden2.body);

    // ── El centro de notificaciones ───────────────────────────────────────
    const avisos = await call('GET', '/api/v1/notifications', { token: tokenComprador });
    expect(avisos.status, avisos.texto).toBe(200);
    guardar('notificaciones-vacio', avisos.body);
  });
});
