import { VersioningType, type INestApplication } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { JwtService } from '@/modules/auth/jwt.service';
import type { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

/**
 * Prueba de estrés del inventario.
 *
 *   pnpm stress:inventory
 *   COMPRADORES=2000 STOCK=3 pnpm stress:inventory
 *
 * ─── Qué demuestra, y qué NO ───
 *
 * Demuestra que con N compradores simultáneos peleando por S unidades salen
 * exactamente S reservas y ni una más. Con N=1000 y S=5, la única respuesta
 * aceptable es 5 éxitos, 995 sin stock, 0 errores.
 *
 * NO es una medición de rendimiento de producción: corre contra una base local
 * en Docker, sin red de por medio, con Node compitiendo por la misma CPU y con
 * las mil peticiones entrando de golpe —una ráfaga mucho más brutal que
 * cualquier vivo real—. Los percentiles sirven para comparar entre corridas
 * ("¿este cambio empeoró la reserva?"), no como número absoluto.
 */

const COMPRADORES = Number(process.env.COMPRADORES ?? 1000);
const STOCK = Number(process.env.STOCK ?? 5);

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
  INVENTORY_RECONCILER_ENABLED: 'false',
  INVENTORY_EXPIRATION_QUEUE_ENABLED: 'false',
};

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { JwtService } = await import('@/modules/auth/jwt.service');
  const { PrismaService } = await import('@/shared/prisma/prisma.service');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({ wsUrl: '', ensureRoom: vi.fn(), issueToken: vi.fn(), verifyWebhook: vi.fn() })
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api', { exclude: ['health', 'ready', 'metrics', 'webhooks/(.*)'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
  await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  jwt = app.get(JwtService);

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
  const i = Math.min(ordenados.length - 1, Math.floor((p / 100) * ordenados.length));
  return ordenados[i]!;
}

const ms = (n: number): string => `${n.toFixed(1)} ms`;

describe('Estrés de inventario', () => {
  it(`${COMPRADORES} compradores simultáneos contra ${STOCK} unidades`, async () => {
    const marca = Date.now();

    // ─── Vendedor con una variante y stock conocido ───
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
        lastName: 'Vendedor',
        email: `estres-vend-${marca}@test.local`,
        emailVerified: true,
        role: 'seller',
      },
    });

    await prisma.$transaction([
      prisma.seller.create({
        data: {
          id: sellerId,
          userId: vendedorId,
          displayName: 'Estres',
          slug: `estres-${marca}`,
          status: 'ACTIVE',
        },
      }),
      prisma.store.create({
        data: {
          id: storeId,
          sellerId,
          name: 'Tienda de estrés',
          slug: `tienda-estres-${marca}`,
          isPrimary: true,
          status: 'ACTIVE',
        },
      }),
      prisma.product.create({
        data: {
          id: productId,
          storeId,
          name: 'Producto de estrés',
          slug: `producto-estres-${marca}`,
          basePriceCents: 1_000_000,
          status: 'ACTIVE',
        },
      }),
      prisma.productVariant.create({
        data: {
          id: variantId,
          productId,
          storeId,
          title: 'Default',
          optionsKey: '__default__',
          isDefault: true,
        },
      }),
      prisma.inventory.create({
        data: { id: inventoryId, productVariantId: variantId, onHand: STOCK, reserved: 0 },
      }),
    ]);

    // ─── Compradores ───
    //
    // Se insertan en lote y se les emite el token directo: mil llamadas a
    // `/auth/dev` tardarían más que la prueba y además chocarían contra el
    // límite de peticiones, que no es lo que se quiere medir.
    const usuarios = Array.from({ length: COMPRADORES }, (_, i) => ({
      id: newId('usr'),
      firstName: 'Comprador',
      lastName: `${i}`,
      email: `estres-${marca}-${i}@test.local`,
      emailVerified: true,
      role: 'buyer' as const,
    }));
    await prisma.user.createMany({ data: usuarios });

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

    const servidor = (app as NestFastifyApplication).getHttpAdapter().getInstance();

    // ─── La ráfaga ───
    //
    // Sin `await` dentro del map: se lanzan las mil y recién después se espera.
    // Con un await por vuelta serían mil peticiones secuenciales y no habría
    // contención que medir.
    const latencias: number[] = [];
    const conteo = { exito: 0, sinStock: 0, error: 0 };
    const erroresVistos = new Map<string, number>();

    const arranque = process.hrtime.bigint();

    await Promise.all(
      tokens.map(async (token, i) => {
        const t0 = process.hrtime.bigint();
        const res = await servidor.inject({
          method: 'POST',
          url: '/api/v1/inventory/reservations',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'idempotency-key': `estres-${marca}-${i}`,
          },
          payload: { productVariantId: variantId, quantity: 1 },
        });
        latencias.push(Number(process.hrtime.bigint() - t0) / 1e6);

        if (res.statusCode === 201) {
          conteo.exito += 1;
          return;
        }

        const cuerpo = res.body ? (JSON.parse(res.body) as { error?: { code?: string } }) : null;
        const codigo = cuerpo?.error?.code ?? `HTTP_${res.statusCode}`;

        if (codigo === 'OUT_OF_STOCK') {
          conteo.sinStock += 1;
        } else {
          conteo.error += 1;
          erroresVistos.set(codigo, (erroresVistos.get(codigo) ?? 0) + 1);
        }
      }),
    );

    const totalMs = Number(process.hrtime.bigint() - arranque) / 1e6;

    // ─── Estado final según la BASE, que es la única que cuenta ───
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } });
    const activas = await prisma.inventoryReservation.count({
      where: { productVariantId: variantId, status: 'ACTIVE' },
    });

    const salida = [
      '',
      '  ─── Peticiones ───',
      `  total            ${COMPRADORES}`,
      `  éxito            ${conteo.exito}`,
      `  sin stock        ${conteo.sinStock}`,
      `  errores          ${conteo.error}`,
      ...[...erroresVistos].map(([codigo, veces]) => `      ${codigo}: ${veces}`),
      '',
      '  ─── Latencia de la reserva ───',
      `  p50              ${ms(percentil(latencias, 50))}`,
      `  p95              ${ms(percentil(latencias, 95))}`,
      `  p99              ${ms(percentil(latencias, 99))}`,
      `  máx              ${ms(Math.max(...latencias))}`,
      `  ráfaga completa  ${ms(totalMs)}`,
      `  throughput       ${((COMPRADORES / totalMs) * 1000).toFixed(0)} req/s`,
      '',
      '  ─── Estado final de PostgreSQL ───',
      `  onHand           ${inv.onHand}`,
      `  reserved         ${inv.reserved}`,
      `  disponibles      ${inv.onHand - inv.reserved}`,
      `  reservas activas ${activas}`,
      '',
    ].join('\n');

    console.log(salida);

    // ─── Veredicto ───
    //
    // El criterio es binario. No hay "casi": una unidad de más es una venta que
    // no se puede cumplir.
    expect(conteo.error, 'peticiones fallidas por algo que no es falta de stock').toBe(0);
    expect(conteo.exito, 'reservas exitosas').toBe(STOCK);
    expect(conteo.sinStock, 'rechazos por falta de stock').toBe(COMPRADORES - STOCK);
    expect(inv.reserved, 'unidades reservadas en la base').toBe(STOCK);
    expect(inv.onHand - inv.reserved, 'disponibles').toBe(0);
    expect(activas, 'reservas activas').toBe(STOCK);

    // Limpieza: sin esto cada corrida deja mil usuarios en la base.
    await prisma.user.deleteMany({ where: { email: { startsWith: `estres-${marca}` } } });
    await prisma.user.deleteMany({ where: { email: `estres-vend-${marca}@test.local` } });
  });

  it('latencia por nivel de concurrencia, con stock de sobra', async () => {
    /**
     * ─── Por qué hace falta esta segunda medición ───
     *
     * La prueba de arriba dispara mil peticiones en el mismo milisegundo. Eso
     * no mide cuánto tarda reservar: mide cuánto tarda hacer cola. El p50 de
     * ~1,5 s es tiempo de espera detrás de otras 999, no trabajo.
     *
     * Ningún vivo se comporta así. Lo que sí puede pasar es que haya unas
     * decenas de compras en vuelo a la vez, y ESE es el número que importa.
     *
     * Con stock de sobra, además, no hay contención sobre la fila: se mide el
     * camino completo —validar que sea vendible, idempotencia, transacción—
     * sin el ruido de la pelea por la última unidad.
     *
     * ─── Sobre qué se afirma y qué sólo se informa ───
     *
     * La curva medida en el portátil de desarrollo:
     *
     *     en vuelo │  p50   │  p95
     *     ─────────┼────────┼────────
     *         5    │  18 ms │  21 ms
     *        10    │  30 ms │  76 ms
     *        20    │  48 ms │ 203 ms
     *        40    │ 112 ms │ 243 ms
     *
     * El trabajo real de una reserva son ~18 ms. Todo lo de arriba es cola: un
     * solo proceso de Node, PostgreSQL en Docker Desktop y el propio corredor
     * de tests peleando por la misma CPU.
     *
     * Se comprobó que NO es el fsync de los commits: 500 transacciones sueltas
     * contra esta misma base tardan 335 ms, o sea 0,67 ms cada una. Quitar un
     * viaje a la base y paralelizar otros dos tampoco movió el p95, lo que
     * confirma que el límite es de capacidad del entorno y no del camino de
     * código.
     *
     * Por eso se AFIRMA sobre `CONCURRENCIA_AFIRMADA`, donde hay margen de
     * sobra y una regresión real se ve enseguida, y sólo se INFORMA el resto.
     * Un test que se pone en rojo porque el portátil está ocupado deja de
     * mirarse a la tercera vez.
     *
     * Medir capacidad de verdad requiere hardware de staging. Está anotado
     * como deuda técnica.
     */
    const marca = Date.now();
    const EN_VUELO = Number(process.env.EN_VUELO ?? 10);
    const CONCURRENCIA_AFIRMADA = 10;
    const TOTAL = EN_VUELO * 10;

    const vendedorId = newId('usr');
    const variantId = newId('var');
    const inventoryId = newId('inv');

    await prisma.user.create({
      data: {
        id: vendedorId,
        firstName: 'Latencia',
        lastName: 'Vendedor',
        email: `lat-vend-${marca}@test.local`,
        emailVerified: true,
        role: 'seller',
      },
    });

    const sellerId = newId('sel');
    const storeId = newId('sto');
    const productId = newId('prd');

    await prisma.$transaction([
      prisma.seller.create({
        data: { id: sellerId, userId: vendedorId, displayName: 'Lat', slug: `lat-${marca}`, status: 'ACTIVE' },
      }),
      prisma.store.create({
        data: { id: storeId, sellerId, name: 'Lat', slug: `lat-tienda-${marca}`, isPrimary: true, status: 'ACTIVE' },
      }),
      prisma.product.create({
        data: {
          id: productId,
          storeId,
          name: 'Lat',
          slug: `lat-prod-${marca}`,
          basePriceCents: 1_000_000,
          status: 'ACTIVE',
        },
      }),
      prisma.productVariant.create({
        data: { id: variantId, productId, storeId, title: 'Default', optionsKey: '__default__', isDefault: true },
      }),
      // Stock de sobra: no se mide la pelea por la última unidad.
      prisma.inventory.create({
        data: { id: inventoryId, productVariantId: variantId, onHand: TOTAL * 2, reserved: 0 },
      }),
    ]);

    const usuarios = Array.from({ length: TOTAL }, (_, i) => ({
      id: newId('usr'),
      firstName: 'Comprador',
      lastName: `${i}`,
      email: `lat-${marca}-${i}@test.local`,
      emailVerified: true,
      role: 'buyer' as const,
    }));
    await prisma.user.createMany({ data: usuarios });

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

    const servidor = (app as NestFastifyApplication).getHttpAdapter().getInstance();
    const latencias: number[] = [];
    let siguiente = 0;

    // Ventana deslizante: siempre hay `EN_VUELO` peticiones en curso, ni una
    // más. Es lo que se parece a tráfico real.
    async function obrero(): Promise<void> {
      for (;;) {
        const i = siguiente;
        siguiente += 1;
        if (i >= TOTAL) return;

        const t0 = process.hrtime.bigint();
        const res = await servidor.inject({
          method: 'POST',
          url: '/api/v1/inventory/reservations',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tokens[i]}`,
            'idempotency-key': `lat-${marca}-${i}`,
          },
          payload: { productVariantId: variantId, quantity: 1 },
        });
        latencias.push(Number(process.hrtime.bigint() - t0) / 1e6);
        expect(res.statusCode).toBe(201);
      }
    }

    await Promise.all(Array.from({ length: EN_VUELO }, () => obrero()));

    const p50 = percentil(latencias, 50);
    const p95 = percentil(latencias, 95);
    const p99 = percentil(latencias, 99);

    console.log(
      [
        '',
        `  ─── Latencia con ${EN_VUELO} peticiones en vuelo (${TOTAL} reservas) ───`,
        `  p50              ${ms(p50)}`,
        `  p95              ${ms(p95)}`,
        `  p99              ${ms(p99)}`,
        `  máx              ${ms(Math.max(...latencias))}`,
        '',
      ].join('\n'),
    );

    // Sólo se afirma en el nivel donde el entorno no es el que manda. Ver la
    // explicación larga arriba.
    if (EN_VUELO <= CONCURRENCIA_AFIRMADA) {
      expect(p95, `p95 con ${EN_VUELO} en vuelo`).toBeLessThan(200);
    }

    await prisma.user.deleteMany({ where: { email: { startsWith: `lat-${marca}` } } });
    await prisma.user.deleteMany({ where: { email: `lat-vend-${marca}@test.local` } });
  });
});
