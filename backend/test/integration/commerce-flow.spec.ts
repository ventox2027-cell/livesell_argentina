import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';

/**
 * Bloque comercial contra PostgreSQL REAL.
 *
 * ─── Lo que se prueba acá y no se puede probar en otro lado ───
 *
 * Los invariantes que vive la BASE, no el código: índices únicos, cascadas,
 * transacciones. Un test con la base mockeada pasaría igual con un índice mal
 * definido, que es exactamente el error que no se ve leyendo.
 *
 * Los casos marcados ⛔ son de seguridad. Si alguno se pone en rojo, un
 * vendedor puede tocar el catálogo de otro.
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
    .useValue({ wsUrl: '', ensureRoom: vi.fn(), issueToken: vi.fn(), verifyWebhook: vi.fn() })
    .compile();

  app = await crearAppDePrueba(moduleRef);

  prisma = app.get(PrismaService);
  redis = app.get(RedisService);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Los tests de integración borran datos y sólo corren contra una base *_test');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE seller_payment_accounts, seller_oauth_credentials, oauth_states, reports, moderation_actions, notifications, live_sessions, likes, audit_logs, product_variant_options, product_images, product_variants, ' +
      'product_option_values, product_options, products, stores, sellers, ' +
      'auth_events, refresh_tokens, devices, user_identities, users CASCADE',
  );
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  const claves = await redis.client.keys('rl:*');
  if (claves.length > 0) await redis.client.del(...claves);
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

/** Crea un usuario y devuelve su access token. */
async function nuevoUsuario(): Promise<{ token: string; userId: string }> {
  n += 1;
  const r = await call('POST', '/api/v1/auth/dev', {
    body: {
      email: `comercio${n}@test.com`,
      firstName: 'Test',
      lastName: `Usuario${n}`,
      device: {
        installId: `install-comercio-${n}`,
        platform: 'android',
        appVersion: '1.0.0',
        osVersion: '14',
      },
    },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { token: r.body.accessToken, userId: r.body.user.id };
}

/** Crea un usuario que además es vendedor con tienda. */
async function nuevoVendedor(displayName?: string) {
  const { token, userId } = await nuevoUsuario();
  n += 1;
  const r = await call('POST', '/api/v1/sellers', {
    token,
    body: { displayName: displayName ?? `Tienda de prueba ${n}` },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { token, userId, seller: r.body.seller, store: r.body.store };
}

/**
 * Sube un archivo como lo haría el teléfono.
 *
 * Se arma el multipart a mano en vez de usar una librería: lo que se quiere
 * ejercitar es el camino real —Fastify parsea el cuerpo, el servicio mira los
 * bytes— y una librería que "arregle" el content-type o el nombre del archivo
 * escondería justo los casos que hay que probar.
 */
async function subirArchivo(
  token: string,
  productId: string,
  bytes: Buffer,
  opts: { filename?: string; mimetype?: string } = {},
) {
  const boundary = '----vendoxtest0123456789';
  const cabecera =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${opts.filename ?? 'foto.jpg'}"\r\n` +
    `Content-Type: ${opts.mimetype ?? 'image/jpeg'}\r\n\r\n`;

  const payload = Buffer.concat([
    Buffer.from(cabecera, 'utf8'),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  const res = await (app as NestFastifyApplication)
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: `/api/v1/products/${productId}/images`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

/** JPEG mínimo válido: SOI + APP0 + relleno + EOI. */
function jpegDePrueba(): Buffer {
  return Buffer.concat([
    Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00,
    ]),
    Buffer.alloc(128),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function pngDePrueba(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);
}

async function crearProducto(token: string, extra: Record<string, unknown> = {}) {
  n += 1;
  const r = await call('POST', '/api/v1/products', {
    token,
    body: { name: `Producto ${n}`, basePriceCents: 1_549_900, ...extra },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

// ═══════════════════════════════════════════════════════════════════════════

describe('Convertirse en vendedor', () => {
  it('crea el perfil Y la tienda principal juntos', async () => {
    // Un vendedor sin tienda sería un estado intermedio que todo el resto del
    // código tendría que contemplar para siempre.
    const { seller, store } = await nuevoVendedor('Cancerianas');
    expect(seller.slug).toBe('cancerianas');
    expect(store.sellerId).toBe(seller.id);
    expect(store.isPrimary).toBe(true);
  });

  it('el usuario pasa a rol vendedor', async () => {
    const { token } = await nuevoVendedor();
    const me = await call('GET', '/api/v1/auth/me', { token });
    expect(me.body.role).toBe('seller');
  });

  it('⛔ el mismo usuario NO puede crear un segundo vendedor', async () => {
    const { token } = await nuevoVendedor();
    const segundo = await call('POST', '/api/v1/sellers', {
      token,
      body: { displayName: 'Otra tienda' },
    });
    expect(segundo.status).toBe(409);
  });

  it('⛔ rechaza un slug reservado', async () => {
    // Sin esto, alguien registra `admin` y su tienda queda en vendox.com/admin.
    const { token } = await nuevoUsuario();
    const r = await call('POST', '/api/v1/sellers', {
      token,
      body: { displayName: 'Administración', slug: 'admin' },
    });
    expect(r.status).toBe(400);
  });

  it('⛔ rechaza un slug ya ocupado', async () => {
    await nuevoVendedor('Marca Unica');
    const { token } = await nuevoUsuario();
    const r = await call('POST', '/api/v1/sellers', {
      token,
      body: { displayName: 'Otro', slug: 'marca-unica' },
    });
    expect(r.status).toBe(409);
  });

  it('genera un slug alternativo cuando el natural está tomado', async () => {
    // Dos vendedores con el mismo nombre es normal. No puede fallar el
    // registro del segundo.
    const a = await nuevoVendedor('Tejidos del Sur');
    const b = await nuevoVendedor('Tejidos del Sur');
    expect(a.seller.slug).toBe('tejidos-del-sur');
    expect(b.seller.slug).not.toBe(a.seller.slug);
  });

  it('normaliza tildes en el slug', async () => {
    // "café" y "cafe" tienen que dar la misma URL: nadie escribe la tilde.
    const { seller } = await nuevoVendedor('Café Andrés');
    expect(seller.slug).toBe('cafe-andres');
  });
});

describe('⛔ Vendedor suspendido', () => {
  it('no puede crear productos', async () => {
    const { token, seller } = await nuevoVendedor();
    await prisma.seller.update({ where: { id: seller.id }, data: { status: 'SUSPENDED' } });

    const r = await call('POST', '/api/v1/products', {
      token,
      body: { name: 'Algo', basePriceCents: 100_000 },
    });
    expect(r.status).toBe(403);
  });

  it('pero SÍ puede ver su perfil', async () => {
    // Tiene que poder entender qué le pasó. Bloquearle hasta la lectura sólo
    // genera un reclamo por soporte.
    const { token, seller } = await nuevoVendedor();
    await prisma.seller.update({ where: { id: seller.id }, data: { status: 'SUSPENDED' } });

    const r = await call('GET', '/api/v1/sellers/me', { token });
    expect(r.status).toBe(200);
    expect(r.body.seller.status).toBe('SUSPENDED');
  });
});

describe('Productos', () => {
  it('un producto simple genera UNA variante DEFAULT', async () => {
    /**
     * El invariante del que depende Inventory: nunca hay stock de producto y
     * stock de variante como dos cosas distintas.
     */
    const p = await crearProducto((await nuevoVendedor()).token);
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0].isDefault).toBe(true);
    expect(p.variants[0].title).toBe('Default');
  });

  it('un producto con opciones genera todas las combinaciones', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, {
      name: 'Remera Oversize',
      options: [
        { name: 'Color', values: ['Negro', 'Blanco'] },
        { name: 'Talle', values: ['S', 'M', 'L'] },
      ],
    });

    expect(p.variants).toHaveLength(6);
    expect(p.variants.map((v: { title: string }) => v.title)).toEqual([
      'Negro / S',
      'Negro / M',
      'Negro / L',
      'Blanco / S',
      'Blanco / M',
      'Blanco / L',
    ]);
    expect(p.options).toHaveLength(2);
    expect(p.options[0].values).toHaveLength(2);
  });

  it('ninguna variante generada es DEFAULT', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, {
      options: [{ name: 'Color', values: ['Negro', 'Blanco'] }],
    });
    expect(p.variants.every((v: { isDefault: boolean }) => !v.isDefault)).toBe(true);
  });

  it('⛔ rechaza un precio negativo', async () => {
    const { token } = await nuevoVendedor();
    const r = await call('POST', '/api/v1/products', {
      token,
      body: { name: 'Regalo', basePriceCents: -100 },
    });
    expect(r.status).toBe(400);
  });

  it('⛔ rechaza un precio con decimales', async () => {
    // El precio va en centavos. Un decimal significa que alguien mandó pesos.
    const { token } = await nuevoVendedor();
    const r = await call('POST', '/api/v1/products', {
      token,
      body: { name: 'Mal', basePriceCents: 1500.5 },
    });
    expect(r.status).toBe(400);
  });

  it('⛔ rechaza un precio tachado menor que el de venta', async () => {
    // Un "antes" menor que el "ahora" es publicidad engañosa y está regulado.
    const { token } = await nuevoVendedor();
    const r = await call('POST', '/api/v1/products', {
      token,
      body: { name: 'Oferta falsa', basePriceCents: 200_000, compareAtPriceCents: 100_000 },
    });
    expect(r.status).toBe(400);
  });

  it('⛔ rechaza una combinación explosiva de opciones', async () => {
    const { token } = await nuevoVendedor();
    const muchos = Array.from({ length: 30 }, (_, i) => `V${i}`);
    const r = await call('POST', '/api/v1/products', {
      token,
      body: {
        name: 'Explosivo',
        basePriceCents: 100_000,
        options: [
          { name: 'A', values: muchos },
          { name: 'B', values: muchos },
        ],
      },
    });
    expect(r.status).toBe(400);
  });

  it('⛔ dos productos de la MISMA tienda no comparten slug', async () => {
    const { token } = await nuevoVendedor();
    await crearProducto(token, { name: 'Remera Negra' });
    const segundo = await call('POST', '/api/v1/products', {
      token,
      body: { name: 'Otra', slug: 'remera-negra', basePriceCents: 100_000 },
    });
    expect(segundo.status).toBe(409);
  });

  it('dos TIENDAS distintas SÍ pueden usar el mismo slug de producto', async () => {
    // El slug de producto es único dentro de la tienda, no globalmente: dos
    // vendedores pueden vender una "remera negra".
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    const pa = await crearProducto(a.token, { name: 'Remera Negra' });
    const pb = await crearProducto(b.token, { name: 'Remera Negra' });
    expect(pa.slug).toBe('remera-negra');
    expect(pb.slug).toBe('remera-negra');
  });
});

describe('⛔ IDOR — el vendedor A no toca nada del vendedor B', () => {
  it('no puede LEER un producto ajeno', async () => {
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    const deB = await crearProducto(b.token);

    const r = await call('GET', `/api/v1/products/${deB.id}`, { token: a.token });
    // 404 y no 403: un 403 confirmaría que ese id existe, y con eso se puede
    // enumerar el catálogo ajeno probando ids.
    expect(r.status).toBe(404);
  });

  it('no puede MODIFICAR un producto ajeno', async () => {
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    const deB = await crearProducto(b.token);

    // El cuerpo tiene que ser VÁLIDO. Con uno inválido el 400 de validación
    // llegaría antes que la comprobación de pertenencia, y el test pasaría por
    // el motivo equivocado — sin probar nada de lo que dice probar.
    const r = await call('PATCH', `/api/v1/products/${deB.id}`, {
      token: a.token,
      body: { basePriceCents: 100 },
    });
    expect(r.status).toBe(404);

    // Y el producto quedó intacto.
    const sigue = await prisma.product.findUniqueOrThrow({ where: { id: deB.id } });
    expect(sigue.basePriceCents).toBe(deB.basePriceCents);
  });

  it('no puede BORRAR un producto ajeno', async () => {
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    const deB = await crearProducto(b.token);

    const r = await call('DELETE', `/api/v1/products/${deB.id}`, { token: a.token });
    expect(r.status).toBe(404);

    const sigue = await prisma.product.findUniqueOrThrow({ where: { id: deB.id } });
    expect(sigue.deletedAt).toBeNull();
  });

  it('no puede modificar la TIENDA ajena', async () => {
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();

    const r = await call('PATCH', `/api/v1/stores/${b.store.id}`, {
      token: a.token,
      body: { name: 'Secuestrada' },
    });
    expect(r.status).toBe(404);
  });

  it('no puede tocar una VARIANTE ajena', async () => {
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    const deB = await crearProducto(b.token);
    const varianteDeB = deB.variants[0].id;

    const r = await call('PATCH', `/api/v1/products/${deB.id}/variants/${varianteDeB}`, {
      token: a.token,
      body: { status: 'INACTIVE' },
    });
    expect(r.status).toBe(404);
  });

  it('no puede crear una variante en un producto ajeno', async () => {
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    const deB = await crearProducto(b.token);

    const r = await call('POST', `/api/v1/products/${deB.id}/variants`, {
      token: a.token,
      body: { optionValueIds: [] },
    });
    expect(r.status).toBe(404);
  });

  it('su listado sólo trae SUS productos', async () => {
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    await crearProducto(a.token);
    await crearProducto(b.token);
    await crearProducto(b.token);

    const r = await call('GET', '/api/v1/products/mine', { token: a.token });
    expect(r.body.items).toHaveLength(1);
  });

  it('⛔ un usuario SIN vendedor no puede crear productos', async () => {
    const { token } = await nuevoUsuario();
    const r = await call('POST', '/api/v1/products', {
      token,
      body: { name: 'Algo', basePriceCents: 100_000 },
    });
    expect(r.status).toBe(404);
  });
});

describe('Variantes', () => {
  it('permite desactivar una combinación que no se comercializa', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, {
      options: [{ name: 'Talle', values: ['S', 'M', 'XXL'] }],
    });
    const xxl = p.variants.find((v: { title: string }) => v.title === 'XXL');

    const r = await call('PATCH', `/api/v1/products/${p.id}/variants/${xxl.id}`, {
      token,
      body: { status: 'INACTIVE' },
    });
    expect(r.status).toBe(200);
    const actualizada = r.body.variants.find((v: { id: string }) => v.id === xxl.id);
    expect(actualizada.status).toBe('INACTIVE');
  });

  it('una variante puede tener precio propio', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, {
      basePriceCents: 1_000_000,
      options: [{ name: 'Talle', values: ['M', 'XXL'] }],
    });
    const xxl = p.variants.find((v: { title: string }) => v.title === 'XXL');

    const r = await call('PATCH', `/api/v1/products/${p.id}/variants/${xxl.id}`, {
      token,
      body: { priceOverrideCents: 1_200_000 },
    });

    const m = r.body.variants.find((v: { title: string }) => v.title === 'M');
    const nuevo = r.body.variants.find((v: { id: string }) => v.id === xxl.id);
    // El precio efectivo lo resuelve el backend: si lo hiciera cada cliente,
    // un día mostrarían números distintos.
    expect(m.priceCents).toBe(1_000_000);
    expect(nuevo.priceCents).toBe(1_200_000);
  });

  it('⛔ el mismo SKU no se puede repetir en la tienda', async () => {
    const { token } = await nuevoVendedor();
    const p1 = await crearProducto(token);
    const p2 = await crearProducto(token);

    const ok = await call('PATCH', `/api/v1/products/${p1.id}/variants/${p1.variants[0].id}`, {
      token,
      body: { sku: 'REM-001' },
    });
    expect(ok.status).toBe(200);

    // Otro PRODUCTO de la MISMA tienda con el mismo código: el inventario no
    // podría distinguirlos.
    const choque = await call('PATCH', `/api/v1/products/${p2.id}/variants/${p2.variants[0].id}`, {
      token,
      body: { sku: 'REM-001' },
    });
    expect(choque.status).toBe(409);
  });

  it('dos TIENDAS distintas sí pueden usar el mismo SKU', async () => {
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    const pa = await crearProducto(a.token);
    const pb = await crearProducto(b.token);

    expect(
      (await call('PATCH', `/api/v1/products/${pa.id}/variants/${pa.variants[0].id}`, {
        token: a.token,
        body: { sku: 'COMPARTIDO' },
      })).status,
    ).toBe(200);

    expect(
      (await call('PATCH', `/api/v1/products/${pb.id}/variants/${pb.variants[0].id}`, {
        token: b.token,
        body: { sku: 'COMPARTIDO' },
      })).status,
    ).toBe(200);
  });

  it('⛔ no se puede crear una combinación duplicada', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, {
      options: [{ name: 'Color', values: ['Negro', 'Blanco'] }],
    });
    const idNegro = p.options[0].values.find((v: { value: string }) => v.value === 'Negro').id;

    const r = await call('POST', `/api/v1/products/${p.id}/variants`, {
      token,
      body: { optionValueIds: [idNegro] },
    });
    // Dos "Negro" en el mismo producto, cada uno con su stock: el inventario
    // nunca cerraría.
    expect(r.status).toBe(409);
  });

  it('⛔ no se puede borrar la ÚNICA variante', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);

    const r = await call('DELETE', `/api/v1/products/${p.id}/variants/${p.variants[0].id}`, {
      token,
    });
    expect(r.status).toBe(400);
  });

  it('sí se puede borrar una si quedan otras', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, {
      options: [{ name: 'Talle', values: ['S', 'M'] }],
    });

    const r = await call('DELETE', `/api/v1/products/${p.id}/variants/${p.variants[0].id}`, {
      token,
    });
    expect(r.status).toBe(200);
    expect(r.body.variants).toHaveLength(1);
  });
});

describe('Borrado lógico y visibilidad pública', () => {
  it('el borrado es lógico: la fila sobrevive', async () => {
    // Una orden futura tiene que poder seguir apuntando al producto vendido.
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);

    await call('DELETE', `/api/v1/products/${p.id}`, { token });

    const fila = await prisma.product.findUnique({ where: { id: p.id } });
    expect(fila).not.toBeNull();
    expect(fila!.deletedAt).not.toBeNull();
  });

  it('un producto borrado desaparece del listado del vendedor', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);
    await call('DELETE', `/api/v1/products/${p.id}`, { token });

    const r = await call('GET', '/api/v1/products/mine', { token });
    expect(r.body.items.map((i: { id: string }) => i.id)).not.toContain(p.id);
  });

  it('⛔ un producto ARCHIVADO no aparece en la vidriera pública', async () => {
    const { token, store } = await nuevoVendedor();
    const activo = await crearProducto(token, { status: 'ACTIVE' });
    const archivado = await crearProducto(token, { status: 'ACTIVE' });
    await call('PATCH', `/api/v1/products/${archivado.id}`, {
      token,
      body: { status: 'ARCHIVED' },
    });

    const r = await call('GET', `/api/v1/stores/by-slug/${store.slug}/products`);
    const ids = r.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(activo.id);
    expect(ids).not.toContain(archivado.id);
  });

  it('⛔ un BORRADOR tampoco aparece en la vidriera', async () => {
    const { token, store } = await nuevoVendedor();
    await crearProducto(token, { status: 'DRAFT' });

    const r = await call('GET', `/api/v1/stores/by-slug/${store.slug}/products`);
    expect(r.body.items).toHaveLength(0);
  });

  it('la vidriera de un vendedor suspendido no existe', async () => {
    const { token, seller, store } = await nuevoVendedor();
    await crearProducto(token, { status: 'ACTIVE' });
    await prisma.seller.update({ where: { id: seller.id }, data: { status: 'SUSPENDED' } });

    const r = await call('GET', `/api/v1/stores/by-slug/${store.slug}/products`);
    expect(r.status).toBe(404);
  });
});

describe('Límite de peticiones en endpoints con sesión', () => {
  it('⛔ el contador es POR USUARIO, no por IP', async () => {
    /**
     * Todos los usuarios de este test salen de la misma IP —127.0.0.1—, igual
     * que salen de la misma IP todos los abonados detrás del CGNAT de una
     * operadora móvil argentina.
     *
     * `POST /sellers` permite 3 por hora. Si el contador fuera por IP, el
     * cuarto vendedor de este archivo no podría abrir su tienda. Y en
     * producción, la cuarta persona de un bloque entero de abonados tampoco.
     *
     * Este test existe porque eso pasaba: `RateLimitGuard` corre antes que
     * `AuthGuard`, así que `req.user` todavía no está y la clave caía a la IP
     * sin que nada lo delatara.
     */
    const estados: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { token } = await nuevoUsuario();
      const r = await call('POST', '/api/v1/sellers', {
        token,
        body: { displayName: `Tienda cgnat ${i}-${n}` },
      });
      estados.push(r.status);
    }

    expect(estados.every((s) => s === 201)).toBe(true);
  });

  it('sigue limitando al mismo usuario que insiste', async () => {
    // La protección tiene que seguir existiendo: por usuario, pero existir.
    const { token } = await nuevoUsuario();

    const estados: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await call('POST', '/api/v1/sellers', {
        token,
        body: { displayName: `Insistente ${i}-${n}` },
      });
      estados.push(r.status);
    }

    // El primero crea; los siguientes chocan contra "ya tenés un vendedor"
    // (409) hasta que el límite de 3 por hora los corta con 429.
    expect(estados[0]).toBe(201);
    expect(estados).toContain(429);
  });
});

describe('Imágenes de producto', () => {
  // Es el único endpoint que recibe bytes arbitrarios de internet. Todo lo que
  // se prueba acá es lo que impide que ese archivo se convierta en un problema.

  it('sube una imagen y la primera queda de portada', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);

    const r = await subirArchivo(token, p.id, jpegDePrueba());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.position).toBe(0);
    expect(r.body.url).toContain('/media/');
  });

  it('acepta PNG además de JPEG', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);

    const r = await subirArchivo(token, p.id, pngDePrueba(), { mimetype: 'image/png' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('⛔ rechaza un ejecutable disfrazado de JPEG', async () => {
    // El content-type lo elige quien sube. Si se confiara en él, bastaría con
    // mentir en una cabecera para dejar un .exe servido desde nuestro dominio.
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);

    const exe = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(64)]);
    const r = await subirArchivo(token, p.id, exe, {
      filename: 'inocente.jpg',
      mimetype: 'image/jpeg',
    });

    // 415 y no 400: el problema no es que la petición esté mal armada, es que
    // el tipo de archivo no se acepta. Es la respuesta que corresponde.
    expect(r.status).toBe(415);
    expect(r.body.error.code).toBe('INVALID_FILE');
  });

  it('⛔ el nombre del archivo del cliente no se usa como ruta', async () => {
    // `../../` en el filename escribiría fuera del directorio de storage.
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);

    const r = await subirArchivo(token, p.id, jpegDePrueba(), {
      filename: '../../../../etc/passwd.jpg',
    });

    expect(r.status).toBe(201);
    expect(r.body.url).not.toContain('..');
    expect(r.body.url).not.toContain('passwd');
  });

  it('⛔ no se puede subir una foto al producto de otro vendedor', async () => {
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    const suyo = await crearProducto(a.token);

    const r = await subirArchivo(b.token, suyo.id, jpegDePrueba());
    expect(r.status).toBe(404);
  });

  it('borrar una foto compacta las posiciones', async () => {
    // Si quedara un hueco, la segunda foto tendría position 2 y el reordenado
    // siguiente no tendría forma de saber cuál es la portada.
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);

    const primera = await subirArchivo(token, p.id, jpegDePrueba());
    await subirArchivo(token, p.id, jpegDePrueba());
    await subirArchivo(token, p.id, jpegDePrueba());

    await call('DELETE', `/api/v1/products/${p.id}/images/${primera.body.id}`, { token });

    const imagenes = await prisma.productImage.findMany({
      where: { productId: p.id },
      orderBy: { position: 'asc' },
      select: { position: true },
    });
    expect(imagenes.map((i) => i.position)).toEqual([0, 1]);
  });

  it('reordenar cambia la portada', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);

    const a = await subirArchivo(token, p.id, jpegDePrueba());
    const b = await subirArchivo(token, p.id, jpegDePrueba());

    const r = await call('PATCH', `/api/v1/products/${p.id}/images/reorder`, {
      token,
      body: { imageIds: [b.body.id, a.body.id] },
    });
    expect(r.status).toBe(200);

    const portada = await prisma.productImage.findFirst({
      where: { productId: p.id, position: 0 },
      select: { id: true },
    });
    expect(portada!.id).toBe(b.body.id);
  });

  it('la foto llega al feed como portada', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE' });
    const img = await subirArchivo(token, p.id, jpegDePrueba());

    const r = await call('GET', '/api/v1/discover/products?limit=50');
    const item = r.body.items.find((i: { id: string }) => i.id === p.id);
    expect(item.images[0].url).toBe(img.body.url);
  });
});

describe('Feed de descubrimiento', () => {
  // Este endpoint es el único que cruza tiendas, y es el que ve alguien que
  // todavía no se registró. Cualquier fuga acá es pública por definición.

  it('es público: no hace falta sesión', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE' });

    const r = await call('GET', '/api/v1/discover/products?limit=50');
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toContain(p.id);
  });

  it('cruza tiendas: trae productos de vendedores distintos', async () => {
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    const pa = await crearProducto(a.token, { status: 'ACTIVE' });
    const pb = await crearProducto(b.token, { status: 'ACTIVE' });

    const r = await call('GET', '/api/v1/discover/products?limit=50');
    const ids = r.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(pa.id);
    expect(ids).toContain(pb.id);
  });

  it('cada producto viene con su tienda y su vendedor', async () => {
    // En el feed la marca la pone quien vende. Sin estos datos, la publicación
    // no se puede ni dibujar.
    const { token, seller, store } = await nuevoVendedor('Marca Del Feed');
    const p = await crearProducto(token, { status: 'ACTIVE' });

    const r = await call('GET', '/api/v1/discover/products?limit=50');
    const item = r.body.items.find((i: { id: string }) => i.id === p.id);
    expect(item).toBeDefined();
    expect(item.store.slug).toBe(store.slug);
    expect(item.store.seller.displayName).toBe(seller.displayName);
  });

  it('⛔ no expone datos internos del vendedor', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE' });

    const r = await call('GET', '/api/v1/discover/products?limit=50');
    const item = r.body.items.find((i: { id: string }) => i.id === p.id);
    expect(item.store.seller.userId).toBeUndefined();
    expect(item.store.seller.email).toBeUndefined();
  });

  it('⛔ un borrador nunca llega al feed', async () => {
    const { token } = await nuevoVendedor();
    const borrador = await crearProducto(token, { status: 'DRAFT' });

    const r = await call('GET', '/api/v1/discover/products?limit=50');
    expect(r.body.items.map((i: { id: string }) => i.id)).not.toContain(borrador.id);
  });

  it('⛔ suspender al vendedor le saca los productos del feed', async () => {
    // El filtro por estado del vendedor no es redundante con el del producto:
    // los productos siguen ACTIVE después de la suspensión.
    const { token, seller } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE' });

    const antes = await call('GET', '/api/v1/discover/products?limit=50');
    expect(antes.body.items.map((i: { id: string }) => i.id)).toContain(p.id);

    await prisma.seller.update({ where: { id: seller.id }, data: { status: 'SUSPENDED' } });

    const despues = await call('GET', '/api/v1/discover/products?limit=50');
    expect(despues.body.items.map((i: { id: string }) => i.id)).not.toContain(p.id);
  });

  it('⛔ pausar la tienda le saca los productos del feed', async () => {
    const { token, store } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE' });

    await call('PATCH', `/api/v1/stores/${store.id}`, { token, body: { status: 'PAUSED' } });

    const r = await call('GET', '/api/v1/discover/products?limit=50');
    expect(r.body.items.map((i: { id: string }) => i.id)).not.toContain(p.id);
  });

  it('pagina por cursor', async () => {
    const { token } = await nuevoVendedor();
    for (let i = 0; i < 3; i += 1) await crearProducto(token, { status: 'ACTIVE' });

    const p1 = await call('GET', '/api/v1/discover/products?limit=2');
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();

    const p2 = await call('GET', `/api/v1/discover/products?limit=2&cursor=${p1.body.nextCursor}`);
    const ids = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('⛔ Forma de las imágenes en los listados', () => {
  /**
   * ─── El defecto que estos tests fijan ───
   *
   * Los listados mandaban SÓLO `url` en cada imagen —alcanza para dibujar la
   * portada— pero el modelo de Flutter esperaba el objeto completo y hacía
   * `j['id'] as String`. La lista de productos del vendedor se caía entera con
   * `type 'Null' is not a subtype of type 'String'`.
   *
   * Y sólo pasaba cuando un producto TENÍA foto, así que sobrevivió a toda la
   * suite, a `flutter analyze` limpio y a varias pruebas en el teléfono.
   *
   * La lección: una proyección más chica "para ahorrar" no ahorra nada —esas
   * columnas ya están en la fila que se trajo— y rompe el contrato con quien
   * consume. Una imagen es siempre `{id, url, position}`, en todos los
   * endpoints.
   */
  const CAMPOS = ['id', 'url', 'position'];

  it('en el listado del vendedor', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);
    await subirArchivo(token, p.id, jpegDePrueba());

    const r = await call('GET', '/api/v1/products/mine?limit=10', { token });
    const item = r.body.items.find((i: { id: string }) => i.id === p.id);

    expect(item.images).toHaveLength(1);
    expect(Object.keys(item.images[0]).sort()).toEqual([...CAMPOS].sort());
  });

  it('en la vidriera pública de una tienda', async () => {
    const { token, store } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE' });
    await subirArchivo(token, p.id, jpegDePrueba());

    const r = await call('GET', `/api/v1/stores/by-slug/${store.slug}/products`);
    const item = r.body.items.find((i: { id: string }) => i.id === p.id);

    expect(Object.keys(item.images[0]).sort()).toEqual([...CAMPOS].sort());
  });

  it('en el feed', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE' });
    await subirArchivo(token, p.id, jpegDePrueba());

    const r = await call('GET', '/api/v1/discover/products?limit=50');
    const item = r.body.items.find((i: { id: string }) => i.id === p.id);

    expect(Object.keys(item.images[0]).sort()).toEqual([...CAMPOS].sort());
  });

  it('en el detalle, que además trae el texto alternativo', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);
    await subirArchivo(token, p.id, jpegDePrueba());

    const r = await call('GET', `/api/v1/products/${p.id}`, { token });

    // El detalle es un superconjunto: los tres campos comunes están, y suma
    // `altText`, que en un listado no se usa.
    for (const campo of CAMPOS) {
      expect(Object.keys(r.body.images[0])).toContain(campo);
    }
  });
});

describe('Paginación', () => {
  it('pagina por cursor sin repetir ni saltear', async () => {
    const { token } = await nuevoVendedor();
    for (let i = 0; i < 5; i += 1) await crearProducto(token);

    const p1 = await call('GET', '/api/v1/products/mine?limit=2', { token });
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();

    const p2 = await call('GET', `/api/v1/products/mine?limit=2&cursor=${p1.body.nextCursor}`, {
      token,
    });
    expect(p2.body.items).toHaveLength(2);

    const ids = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('la última página no tiene cursor', async () => {
    const { token } = await nuevoVendedor();
    await crearProducto(token);

    const r = await call('GET', '/api/v1/products/mine?limit=10', { token });
    expect(r.body.nextCursor).toBeNull();
  });
});

describe('Perfil público', () => {
  it('la vidriera del vendedor no expone datos internos', async () => {
    const { seller } = await nuevoVendedor();
    const r = await call('GET', `/api/v1/sellers/by-slug/${seller.slug}`);

    expect(r.status).toBe(200);
    // La proyección enumera lo que sale. `userId` conecta al vendedor con una
    // cuenta y no tiene por qué ser público.
    expect(r.body.userId).toBeUndefined();
  });

  it('un vendedor suspendido no tiene vidriera', async () => {
    const { seller } = await nuevoVendedor();
    await prisma.seller.update({ where: { id: seller.id }, data: { status: 'SUSPENDED' } });

    const r = await call('GET', `/api/v1/sellers/by-slug/${seller.slug}`);
    expect(r.status).toBe(404);
  });
});

describe('Auditoría', () => {
  it('registra la creación del vendedor y del producto', async () => {
    const { token, seller } = await nuevoVendedor();
    const p = await crearProducto(token);

    const acciones = await prisma.auditLog.findMany({
      where: { entityId: { in: [seller.id, p.id] } },
      select: { action: true },
    });
    const nombres = acciones.map((a) => a.action);
    expect(nombres).toContain('seller.created');
    expect(nombres).toContain('product.created');
  });

  it('registra sólo lo que cambió', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token);
    await call('PATCH', `/api/v1/products/${p.id}`, {
      token,
      body: { basePriceCents: 999_900 },
    });

    const log = await prisma.auditLog.findFirst({
      where: { entityId: p.id, action: 'product.updated' },
    });
    expect(log).not.toBeNull();
    const despues = log!.after as Record<string, unknown>;
    expect(despues.basePriceCents).toBe(999_900);
    // El nombre no cambió: no tiene por qué estar en el diff.
    expect(despues.name).toBeUndefined();
  });
});

/**
 * Los ejes de variación, editables después de crear el producto.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL VENDEDOR NO ARMA VARIANTES: ARMA EJES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nadie carga "Negro / S", "Negro / M", "Negro / L", "Blanco / S"… a mano.
 * Carga dos listas y las seis combinaciones salen solas.
 *
 * Lo que estos tests protegen es lo que no se puede romper al reeditarlas: el
 * stock de las combinaciones que sobreviven, y el historial de las que dejan de
 * existir.
 */
describe('Ejes de variación', () => {
  async function productoSimple(nombre = 'Remera') {
    const v = await nuevoVendedor();
    const p = await call('POST', '/api/v1/products', {
      token: v.token,
      body: { name: `${nombre} ${Date.now()}`, basePriceCents: 1_500_000, status: 'ACTIVE' },
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    return { ...v, productId: p.body.id as string };
  }

  it('define dos ejes y genera el producto cartesiano', async () => {
    const { token, productId } = await productoSimple();

    const r = await call('PUT', `/api/v1/products/${productId}/options`, {
      token,
      body: {
        opciones: [
          { name: 'Color', values: ['Negro', 'Blanco'] },
          { name: 'Talle', values: ['S', 'M', 'L'] },
        ],
      },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const titulos = (r.body.variants as Array<{ title: string }>).map((v) => v.title);
    expect(titulos).toHaveLength(6);
    // El orden importa: agrupadas por el primer eje, como las cargó el vendedor.
    expect(titulos).toEqual([
      'Negro / S',
      'Negro / M',
      'Negro / L',
      'Blanco / S',
      'Blanco / M',
      'Blanco / L',
    ]);
  });

  it('los ejes son libres, no sólo ropa', async () => {
    const { token, productId } = await productoSimple('Perfume');

    const r = await call('PUT', `/api/v1/products/${productId}/options`, {
      token,
      body: { opciones: [{ name: 'Capacidad', values: ['100 ml', '500 ml'] }] },
    });

    expect(r.status).toBe(200);
    expect((r.body.variants as Array<{ title: string }>).map((v) => v.title)).toEqual([
      '100 ml',
      '500 ml',
    ]);
  });

  it('⛔ agregar un eje NO borra el stock de las combinaciones que siguen', async () => {
    /**
     * El caso que rompe una tienda: el vendedor vende Negro y Blanco, agrega
     * Rojo, y se le va el inventario de los otros dos.
     *
     * Las variantes se reconocen por la huella de su combinación, no por su
     * posición en la lista.
     */
    const { token, productId } = await productoSimple();

    await call('PUT', `/api/v1/products/${productId}/options`, {
      token,
      body: { opciones: [{ name: 'Color', values: ['Negro', 'Blanco'] }] },
    });

    const antes = await call('GET', `/api/v1/products/${productId}`, { token });
    const negro = (antes.body.variants as Array<{ id: string; title: string }>).find(
      (v) => v.title === 'Negro',
    )!;

    await call('PATCH', `/api/v1/products/${productId}/variants/${negro.id}/inventory`, {
      token,
      body: { onHand: 7 },
    });

    // Se agrega un color.
    await call('PUT', `/api/v1/products/${productId}/options`, {
      token,
      body: { opciones: [{ name: 'Color', values: ['Negro', 'Blanco', 'Rojo'] }] },
    });

    const despues = await call('GET', `/api/v1/products/${productId}`, { token });
    const negroDespues = (despues.body.variants as Array<{ id: string; title: string }>).find(
      (v) => v.title === 'Negro',
    )!;

    // Misma variante: mismo id.
    expect(negroDespues.id).toBe(negro.id);

    const inv = await prisma.inventory.findUnique({ where: { productVariantId: negro.id } });
    expect(inv?.onHand).toBe(7);
  });

  it('⛔ las combinaciones que desaparecen se ARCHIVAN, no se borran', async () => {
    /**
     * Una orden vieja apunta a su variante. Borrarla dejaría un pedido sin
     * poder decir qué se compró.
     */
    const { token, productId } = await productoSimple();

    await call('PUT', `/api/v1/products/${productId}/options`, {
      token,
      body: { opciones: [{ name: 'Color', values: ['Negro', 'Blanco'] }] },
    });

    const antes = await call('GET', `/api/v1/products/${productId}`, { token });
    const blanco = (antes.body.variants as Array<{ id: string; title: string }>).find(
      (v) => v.title === 'Blanco',
    )!;

    await call('PUT', `/api/v1/products/${productId}/options`, {
      token,
      body: { opciones: [{ name: 'Color', values: ['Negro'] }] },
    });

    // Ya no se ofrece...
    const despues = await call('GET', `/api/v1/products/${productId}`, { token });
    expect((despues.body.variants as Array<{ title: string }>).map((v) => v.title)).toEqual([
      'Negro',
    ]);

    // ...pero la fila sigue existiendo, archivada.
    const fila = await prisma.productVariant.findUnique({ where: { id: blanco.id } });
    expect(fila).not.toBeNull();
    expect(fila?.deletedAt).not.toBeNull();
    expect(fila?.status).toBe('INACTIVE');
  });

  it('quitar todos los ejes deja la variante única', async () => {
    const { token, productId } = await productoSimple();

    await call('PUT', `/api/v1/products/${productId}/options`, {
      token,
      body: { opciones: [{ name: 'Color', values: ['Negro', 'Blanco'] }] },
    });

    const r = await call('PUT', `/api/v1/products/${productId}/options`, {
      token,
      body: { opciones: [] },
    });

    expect(r.status).toBe(200);
    // Todo producto tiene al menos una variante: es la regla que ordena el
    // módulo entero de inventario.
    expect(r.body.variants).toHaveLength(1);
    expect((r.body.variants as Array<{ isDefault: boolean }>)[0]?.isDefault).toBe(true);
  });

  it('⛔ el producto cartesiano tiene tope', async () => {
    const { token, productId } = await productoSimple();

    // 12 × 12 = 144, más que el máximo de 100.
    const doce = Array.from({ length: 12 }, (_, i) => `v${i}`);
    const r = await call('PUT', `/api/v1/products/${productId}/options`, {
      token,
      body: {
        opciones: [
          { name: 'A', values: doce },
          { name: 'B', values: doce },
        ],
      },
    });

    expect(r.status).toBe(422);
    // El mensaje dice cuántas serían: es lo que le permite al vendedor entender
    // que puso los valores en el eje equivocado.
    expect(JSON.stringify(r.body)).toContain('144');
  });

  it('⛔ valores repetidos en un eje se rechazan', async () => {
    const { token, productId } = await productoSimple();

    // Dos "Negro" generarían dos variantes idénticas que el índice UNIQUE
    // rechazaría con un error opaco.
    const r = await call('PUT', `/api/v1/products/${productId}/options`, {
      token,
      body: { opciones: [{ name: 'Color', values: ['Negro', 'negro'] }] },
    });

    // 400 y no 422: es un cuerpo mal formado, no una regla de negocio.
    expect(r.status).toBe(400);
  });

  it('⛔ el producto de otro vendedor da 404', async () => {
    const { productId } = await productoSimple();
    const otro = await nuevoVendedor();

    const r = await call('PUT', `/api/v1/products/${productId}/options`, {
      token: otro.token,
      body: { opciones: [{ name: 'Color', values: ['Negro'] }] },
    });

    expect(r.status).toBe(404);
  });

  it('cada variante generada nace con su fila de inventario', async () => {
    const { token, productId } = await productoSimple();

    await call('PUT', `/api/v1/products/${productId}/options`, {
      token,
      body: { opciones: [{ name: 'Talle', values: ['S', 'M'] }] },
    });

    const r = await call('GET', `/api/v1/products/${productId}`, { token });
    for (const v of r.body.variants as Array<{ id: string }>) {
      const inv = await prisma.inventory.findUnique({ where: { productVariantId: v.id } });
      // Sin fila de inventario, la variante no se podría vender ni consultar.
      expect(inv, `la variante ${v.id} quedó sin inventario`).not.toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BÚSQUEDA Y RANKING DEL FEED
// ═══════════════════════════════════════════════════════════════════════════

/**
 * La búsqueda, contra PostgreSQL de verdad.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL STEMMER NO SE PUEDE PROBAR CON UN MOCK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que hace útil esta búsqueda es que "zapatos" encuentre "zapato" y que
 * "remeras" encuentre "remera". Eso lo hace `to_tsvector('spanish', ...)`
 * adentro de PostgreSQL: cualquier prueba que no consulte la base de verdad
 * estaría probando otra cosa.
 */
describe('Búsqueda en el catálogo', () => {
  /** Un producto publicado con nombre y descripción concretos. */
  async function publicar(
    vendedor: { token: string },
    nombre: string,
    descripcion?: string,
  ) {
    n += 1;
    const r = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: nombre,
        slug: `busq-${n}-${Date.now().toString(36)}`,
        description: descripcion,
        basePriceCents: 500_000,
        status: 'ACTIVE',
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }

  async function buscar(q: string) {
    const r = await call('GET', `/api/v1/discover/products?q=${encodeURIComponent(q)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body.items as Array<{ id: string; name: string }>).map((p) => p.name);
  }

  it('encuentra por el nombre', async () => {
    const v = await nuevoVendedor();
    await publicar(v, 'Buzo oversize de algodón');

    expect(await buscar('buzo')).toContain('Buzo oversize de algodón');
  });

  it('⛔ el plural encuentra el singular', async () => {
    /**
     * Es lo que hace útil la búsqueda en castellano. Sin el stemmer, alguien
     * que escribe "zapatos" no encuentra un producto llamado "Zapato de cuero"
     * y cree que no vendemos eso.
     */
    const v = await nuevoVendedor();
    await publicar(v, 'Zapato de cuero marrón');

    expect(await buscar('zapatos')).toContain('Zapato de cuero marrón');
  });

  it('encuentra sin acentos', async () => {
    // Nadie escribe con acentos desde el teléfono.
    const v = await nuevoVendedor();
    await publicar(v, 'Camisa de algodón');

    expect(await buscar('algodon')).toContain('Camisa de algodón');
  });

  it('busca también en la descripción', async () => {
    const v = await nuevoVendedor();
    await publicar(v, 'Prenda tejida a mano', 'Hecha con lana merino patagónica');

    expect(await buscar('merino')).toContain('Prenda tejida a mano');
  });

  it('el nombre pesa más que la descripción', async () => {
    // Alguien que busca "buzo" quiere productos que SE LLAMAN buzo, no los que
    // lo mencionan al pasar.
    const v = await nuevoVendedor();
    await publicar(v, 'Campera de lana', 'Combina bien con un buzo');
    await publicar(v, 'Buzo de lana');

    const resultados = await buscar('buzo');
    expect(resultados[0]).toBe('Buzo de lana');
  });

  it('⛔ no encuentra productos pausados', async () => {
    const v = await nuevoVendedor();
    const id = await publicar(v, 'Pantalón cargo verde');
    await call('PATCH', `/api/v1/products/${id}`, {
      token: v.token,
      body: { status: 'PAUSED' },
    });

    expect(await buscar('cargo')).not.toContain('Pantalón cargo verde');
  });

  it('⛔ una búsqueda con símbolos no rompe la consulta', async () => {
    /**
     * `to_tsquery` respondería con un error de sintaxis ante `&` o `|`.
     * `websearch_to_tsquery` los trata como texto. Lo que se verifica es que
     * llegue un 200 con una lista, no un 500.
     */
    for (const q of ["remera & short", "'; DROP TABLE products; --", 'zapato | bota']) {
      const r = await call('GET', `/api/v1/discover/products?q=${encodeURIComponent(q)}`);
      expect(r.status, `${q} → ${JSON.stringify(r.body)}`).toBe(200);
      expect(Array.isArray(r.body.items)).toBe(true);
    }

    // Y la tabla sigue ahí.
    expect(await prisma.product.count()).toBeGreaterThan(0);
  });

  it('una búsqueda sin resultados devuelve una lista vacía, no un error', async () => {
    const r = await call('GET', '/api/v1/discover/products?q=xilofonoinexistente');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(0);
    expect(r.body.nextCursor).toBeNull();
  });

  it('sin q devuelve el feed completo', async () => {
    const v = await nuevoVendedor();
    await publicar(v, 'Producto del feed sin búsqueda');

    const r = await call('GET', '/api/v1/discover/products');
    expect(r.status).toBe(200);
    expect((r.body.items as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('Ranking del feed', () => {
  it('un vivo en curso sube el producto de ese vendedor', async () => {
    /**
     * No es favoritismo: un producto que se está mostrando en vivo AHORA se
     * puede comprar con el vendedor explicándolo, que es literalmente el
     * producto que estamos construyendo.
     */
    const conVivo = await nuevoVendedor();
    const sinVivo = await nuevoVendedor();

    n += 1;
    await call('POST', '/api/v1/products', {
      token: conVivo.token,
      body: {
        name: `Producto con vivo ${n}`,
        slug: `rank-vivo-${n}-${Date.now().toString(36)}`,
        basePriceCents: 500_000,
        status: 'ACTIVE',
      },
    });

    // El otro se publica DESPUÉS, así que por frescura iría primero.
    n += 1;
    await call('POST', '/api/v1/products', {
      token: sinVivo.token,
      body: {
        name: `Producto sin vivo ${n}`,
        slug: `rank-sin-${n}-${Date.now().toString(36)}`,
        basePriceCents: 500_000,
        status: 'ACTIVE',
      },
    });

    const antes = await call('GET', '/api/v1/discover/products');
    const ordenAntes = (antes.body.items as Array<{ name: string }>).map((p) => p.name);
    expect(ordenAntes[0]).toContain('sin vivo');

    // Ahora el primero arranca un vivo.
    await prisma.liveSession.create({
      data: {
        id: `liv_rank${String(n).padStart(21, '0')}`,
        sellerId: conVivo.seller.id as string,
        storeId: conVivo.store.id as string,
        title: 'Vivo de ranking',
        state: 'LIVE',
        roomName: `rank-${n}`,
      },
    });

    const despues = await call('GET', '/api/v1/discover/products');
    const ordenDespues = (despues.body.items as Array<{ name: string }>).map((p) => p.name);
    expect(ordenDespues[0]).toContain('con vivo');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REPORTES Y MODERACIÓN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ocultar un producto tiene que ocultarlo EN TODOS LADOS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL BUG QUE ESTE BLOQUE EXISTE PARA IMPEDIR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un producto se muestra en cinco lugares: el feed, la búsqueda, la vidriera de
 * la tienda, el catálogo del vivo y la ficha del producto. Cada uno tenía su
 * `where` copiado a mano.
 *
 * Olvidarse de uno significa que un producto ocultado por contenido prohibido
 * **sigue apareciendo** en la búsqueda mientras el equipo cree que lo bajó. Y
 * peor: nadie se entera, porque el panel dice que está oculto.
 *
 * La búsqueda además usa SQL a mano y no puede importar la definición común, así
 * que su copia SÓLO está protegida por este test.
 */
describe('Moderación: ocultar', () => {
  async function productoBuscable(vendedor: { token: string }, nombre: string) {
    n += 1;
    const r = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: nombre,
        slug: `mod-${n}-${Date.now().toString(36)}`,
        basePriceCents: 500_000,
        status: 'ACTIVE',
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }

  /** Los cinco lugares donde un producto puede aparecer. */
  async function apareceEn(productId: string, storeSlug: string, storeId: string, nombre: string) {
    const feed = await call('GET', '/api/v1/discover/products?limit=50');
    const busqueda = await call(
      'GET',
      `/api/v1/discover/products?q=${encodeURIComponent(nombre.split(' ')[0]!)}`,
    );
    const vidriera = await call('GET', `/api/v1/stores/by-slug/${storeSlug}/products`);
    const catalogo = await call('GET', `/api/v1/stores/${storeId}/catalog`);
    const ficha = await call('GET', `/api/v1/catalog/products/${productId}`);

    const tiene = (r: { body: unknown }) =>
      JSON.stringify((r.body as { items?: unknown })?.items ?? []).includes(productId);

    return {
      feed: tiene(feed),
      busqueda: tiene(busqueda),
      vidriera: tiene(vidriera),
      catalogo: tiene(catalogo),
      ficha: ficha.status === 200,
    };
  }

  it('⛔ un producto oculto desaparece de LOS CINCO lugares', async () => {
    const vendedor = await nuevoVendedor();
    const tienda = await prisma.store.findFirstOrThrow({
      where: { sellerId: vendedor.seller.id as string },
    });
    const nombre = `Chomba moderada ${n}`;
    const productId = await productoBuscable(vendedor, nombre);

    // Primero: aparece en todos.
    const antes = await apareceEn(productId, tienda.slug, tienda.id, nombre);
    expect(antes).toEqual({
      feed: true,
      busqueda: true,
      vidriera: true,
      catalogo: true,
      ficha: true,
    });

    await prisma.product.update({
      where: { id: productId },
      data: { hiddenAt: new Date() },
    });

    // Y después: en ninguno.
    const despues = await apareceEn(productId, tienda.slug, tienda.id, nombre);
    expect(despues).toEqual({
      feed: false,
      busqueda: false,
      vidriera: false,
      catalogo: false,
      ficha: false,
    });
  });

  it('el vendedor SÍ lo sigue viendo en su panel', async () => {
    /**
     * Enterarse de que una publicación desapareció sin explicación es peor que
     * la sanción: el vendedor no sabe qué corregir, asume que fue un error del
     * sistema, y vuelve a publicar lo mismo.
     */
    const vendedor = await nuevoVendedor();
    const productId = await productoBuscable(vendedor, `Producto oculto visible ${n}`);

    await prisma.product.update({
      where: { id: productId },
      data: { hiddenAt: new Date() },
    });

    const mios = await call('GET', '/api/v1/products/mine', { token: vendedor.token });
    expect(JSON.stringify(mios.body)).toContain(productId);
  });

  it('ocultar es distinto de pausar', async () => {
    /**
     * Pausar lo decide el vendedor y lo puede revertir cuando quiera; ocultar lo
     * decide la moderación. Si fueran el mismo campo, el vendedor deshacería una
     * sanción despausando.
     */
    const vendedor = await nuevoVendedor();
    const productId = await productoBuscable(vendedor, `Producto pausa vs oculto ${n}`);

    await prisma.product.update({ where: { id: productId }, data: { hiddenAt: new Date() } });

    // El vendedor lo "despausa": no cambia nada, porque nunca estuvo pausado.
    const r = await call('PATCH', `/api/v1/products/${productId}`, {
      token: vendedor.token,
      body: { status: 'ACTIVE' },
    });
    expect(r.status).toBe(200);

    const producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(producto.hiddenAt).not.toBeNull();

    const ficha = await call('GET', `/api/v1/catalog/products/${productId}`);
    expect(ficha.status).toBe(404);
  });
});

describe('Reportar', () => {
  async function productoDe(vendedor: { token: string }) {
    n += 1;
    const r = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: `Producto reportable ${n}`,
        slug: `rep-${n}-${Date.now().toString(36)}`,
        basePriceCents: 500_000,
        status: 'ACTIVE',
      },
    });
    return r.body.id as string;
  }

  it('un reporte se guarda y no baja nada', async () => {
    const vendedor = await nuevoVendedor();
    const productId = await productoDe(vendedor);
    const quienReporta = await nuevoUsuario();

    const r = await call('POST', '/api/v1/reports', {
      token: quienReporta.token,
      body: { targetType: 'PRODUCT', targetId: productId, reason: 'SPAM', detail: 'Repite' },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(producto.hiddenAt).toBeNull();
  });

  it('⛔ la misma persona no puede reportar dos veces lo mismo', async () => {
    /**
     * Sin el índice único, alguien reporta veinte veces y dispara solo el
     * umbral. Es la forma más barata de bajarle la publicación a un competidor.
     */
    const vendedor = await nuevoVendedor();
    const productId = await productoDe(vendedor);
    const quienReporta = await nuevoUsuario();

    const cuerpo = { targetType: 'PRODUCT', targetId: productId, reason: 'SPAM' };
    await call('POST', '/api/v1/reports', { token: quienReporta.token, body: cuerpo });
    const segunda = await call('POST', '/api/v1/reports', {
      token: quienReporta.token,
      body: cuerpo,
    });

    expect(segunda.status).toBe(409);
    expect(await prisma.report.count({ where: { targetId: productId } })).toBe(1);
  });

  it('⛔ un reporte de contenido prohibido oculta al instante', async () => {
    const vendedor = await nuevoVendedor();
    const productId = await productoDe(vendedor);
    const quienReporta = await nuevoUsuario();

    await call('POST', '/api/v1/reports', {
      token: quienReporta.token,
      body: {
        targetType: 'PRODUCT',
        targetId: productId,
        reason: 'PROHIBIDO',
        detail: 'Vende algo que no se puede vender',
      },
    });

    const producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(producto.hiddenAt).not.toBeNull();

    // Y queda registrado como automático, para poder medir si el umbral está
    // mal calibrado.
    const accion = await prisma.moderationAction.findFirst({
      where: { targetId: productId, action: 'HIDE' },
    });
    expect(accion?.automatic).toBe(true);
    expect(accion?.reason).toBe('PROHIBIDO');
  });

  it('el vendedor recibe un aviso con el motivo, sin saber quién reportó', async () => {
    const vendedor = await nuevoVendedor();
    const productId = await productoDe(vendedor);
    const quienReporta = await nuevoUsuario();

    await call('POST', '/api/v1/reports', {
      token: quienReporta.token,
      body: { targetType: 'PRODUCT', targetId: productId, reason: 'PROHIBIDO' },
    });

    const avisos = await call('GET', '/api/v1/notifications', { token: vendedor.token });
    const crudo = JSON.stringify(avisos.body);

    expect(crudo).toContain('Ocultamos');
    expect(crudo).toContain('no se puede vender');
    // ⚠️ Un vendedor que sabe quién lo reportó puede represaliar.
    expect(crudo).not.toContain(quienReporta.userId);
  });

  it('⛔ el spam necesita cinco personas distintas', async () => {
    const vendedor = await nuevoVendedor();
    const productId = await productoDe(vendedor);

    for (let i = 0; i < 4; i += 1) {
      const u = await nuevoUsuario();
      await call('POST', '/api/v1/reports', {
        token: u.token,
        body: { targetType: 'PRODUCT', targetId: productId, reason: 'SPAM' },
      });
    }

    let producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(producto.hiddenAt).toBeNull();

    const quinto = await nuevoUsuario();
    await call('POST', '/api/v1/reports', {
      token: quinto.token,
      body: { targetType: 'PRODUCT', targetId: productId, reason: 'SPAM' },
    });

    producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(producto.hiddenAt).not.toBeNull();
  });

  it('reportar algo que no existe se rechaza', async () => {
    // Sin esto se acumulan reportes sobre ids inventados que ensucian la cola.
    const u = await nuevoUsuario();
    const r = await call('POST', '/api/v1/reports', {
      token: u.token,
      body: {
        targetType: 'PRODUCT',
        targetId: 'prd_00000000000000000000000000',
        reason: 'SPAM',
      },
    });
    expect(r.status).toBe(404);
  });

  it('sin sesión no se puede reportar', async () => {
    const r = await call('POST', '/api/v1/reports', {
      body: { targetType: 'PRODUCT', targetId: 'prd_x', reason: 'SPAM' },
    });
    expect(r.status).toBe(401);
  });
});

describe('La cola de moderación', () => {
  it('⛔ un usuario común no la ve', async () => {
    const u = await nuevoUsuario();
    const r = await call('GET', '/api/v1/admin/moderation/queue', { token: u.token });
    expect(r.status).toBe(403);
  });

  it('agrupa por contenido, no por reporte', async () => {
    /**
     * Un producto con ocho reportes genera ocho filas, y quien modera revisa el
     * producto UNA vez. Con la lista plana, resuelve el primero y los otros
     * siete siguen pidiendo la misma decisión.
     */
    const admin = await nuevoUsuario();
    await prisma.user.update({ where: { id: admin.userId }, data: { role: 'admin' } });

    const vendedor = await nuevoVendedor();
    n += 1;
    const p = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: `Producto cola ${n}`,
        slug: `cola-${n}-${Date.now().toString(36)}`,
        basePriceCents: 500_000,
        status: 'ACTIVE',
      },
    });
    const productId = p.body.id as string;

    for (let i = 0; i < 3; i += 1) {
      const u = await nuevoUsuario();
      await call('POST', '/api/v1/reports', {
        token: u.token,
        body: { targetType: 'PRODUCT', targetId: productId, reason: 'ENGANOSO' },
      });
    }

    const cola = await call('GET', '/api/v1/admin/moderation/queue', { token: admin.token });
    expect(cola.status, JSON.stringify(cola.body)).toBe(200);

    const grupo = (cola.body.items as Array<Record<string, unknown>>).find(
      (g) => g.targetId === productId,
    );
    expect(grupo).toBeDefined();
    expect(grupo!.reportes).toBe(3);
    expect(grupo!.motivos).toEqual(['ENGANOSO']);
  });

  it('resolver cierra TODOS los reportes de ese contenido', async () => {
    const admin = await nuevoUsuario();
    await prisma.user.update({ where: { id: admin.userId }, data: { role: 'admin' } });

    const vendedor = await nuevoVendedor();
    n += 1;
    const p = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: `Producto resolver ${n}`,
        slug: `resolver-${n}-${Date.now().toString(36)}`,
        basePriceCents: 500_000,
        status: 'ACTIVE',
      },
    });
    const productId = p.body.id as string;

    for (let i = 0; i < 2; i += 1) {
      const u = await nuevoUsuario();
      await call('POST', '/api/v1/reports', {
        token: u.token,
        body: { targetType: 'PRODUCT', targetId: productId, reason: 'SPAM' },
      });
    }

    const r = await call('POST', '/api/v1/admin/moderation/resolve', {
      token: admin.token,
      body: {
        targetType: 'PRODUCT',
        targetId: productId,
        decision: 'DESESTIMADO',
        resolution: 'Revisado: el producto está bien, no hay spam.',
        accion: 'NADA',
      },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.resueltos).toBe(2);
    expect(
      await prisma.report.count({ where: { targetId: productId, status: 'PENDIENTE' } }),
    ).toBe(0);
  });

  it('⛔ resolver sin un motivo de verdad se rechaza', async () => {
    // "ok" no es un motivo. Cuando el vendedor reclame, esto es lo único que
    // hay para mirar.
    const admin = await nuevoUsuario();
    await prisma.user.update({ where: { id: admin.userId }, data: { role: 'admin' } });

    const r = await call('POST', '/api/v1/admin/moderation/resolve', {
      token: admin.token,
      body: {
        targetType: 'PRODUCT',
        targetId: 'prd_x',
        decision: 'DESESTIMADO',
        resolution: 'ok',
      },
    });
    expect(r.status).toBe(400);
  });

  it('devolver un producto a la venta queda en el historial', async () => {
    /**
     * Con un booleano en el producto, la historia no existiría: quién ocultó,
     * cuándo, por qué, y quién lo devolvió. Es lo que se mira ante un reclamo.
     */
    const admin = await nuevoUsuario();
    await prisma.user.update({ where: { id: admin.userId }, data: { role: 'admin' } });

    const vendedor = await nuevoVendedor();
    n += 1;
    const p = await call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: `Producto restaurado ${n}`,
        slug: `restaurar-${n}-${Date.now().toString(36)}`,
        basePriceCents: 500_000,
        status: 'ACTIVE',
      },
    });
    const productId = p.body.id as string;

    const u = await nuevoUsuario();
    await call('POST', '/api/v1/reports', {
      token: u.token,
      body: { targetType: 'PRODUCT', targetId: productId, reason: 'PROHIBIDO' },
    });

    await call('POST', '/api/v1/admin/moderation/resolve', {
      token: admin.token,
      body: {
        targetType: 'PRODUCT',
        targetId: productId,
        decision: 'DESESTIMADO',
        resolution: 'Falso positivo: el producto es legítimo.',
        accion: 'UNHIDE',
      },
    });

    const producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(producto.hiddenAt).toBeNull();

    const historial = await call(
      'GET',
      `/api/v1/admin/moderation/history/PRODUCT/${productId}`,
      { token: admin.token },
    );
    const acciones = historial.body.items as Array<{ action: string; automatic: boolean }>;
    expect(acciones.map((a) => a.action)).toEqual(['UNHIDE', 'HIDE']);
    // El HIDE fue automático; el UNHIDE lo hizo una persona.
    expect(acciones[0]!.automatic).toBe(false);
    expect(acciones[1]!.automatic).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SIN MERCADO PAGO NO SE VENDE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * La regla de negocio, extremo a extremo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE PROTEGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Si un vendedor publica sin conectar su cuenta, el cobro entra en la de
 * VendoX. Cada venta así es plata que le debemos a alguien y que hay que girar
 * a mano — y legalmente nos convierte en intermediarios del dinero de terceros.
 *
 * Pero el bloqueo tiene que caer en el lugar correcto: **publicar y
 * transmitir**, no crear ni configurar. Alguien que se sienta una tarde a
 * cargar cuarenta productos no puede toparse con esto al primero.
 *
 * ⚠️ Estos tests encienden la regla a mano. En la suite está apagada porque cien
 * tests que crean productos publicados no tienen nada que ver con Mercado Pago.
 */
describe('Sin Mercado Pago no se vende', () => {
  /** Enciende la regla sólo para este bloque. */
  const original = process.env.SELLER_MUST_CONNECT_MP;

  beforeAll(() => {
    process.env.SELLER_MUST_CONNECT_MP = 'true';
  });

  afterAll(() => {
    process.env.SELLER_MUST_CONNECT_MP = original;
  });

  /**
   * ⚠️ `env` ya está evaluado y congelado: cambiar `process.env` no lo mueve.
   *
   * Así que el interruptor se toca sobre el objeto de configuración, que es lo
   * que el código lee de verdad. Es feo y sólo vale en un test; la alternativa
   * —levantar una segunda aplicación entera con otra configuración— tarda diez
   * segundos por caso.
   */
  async function conReglaEncendida<T>(fn: () => Promise<T>): Promise<T> {
    const { env } = await import('@/config/env.schema');
    const antes = env.SELLER_MUST_CONNECT_MP;
    (env as { SELLER_MUST_CONNECT_MP: boolean }).SELLER_MUST_CONNECT_MP = true;
    try {
      return await fn();
    } finally {
      (env as { SELLER_MUST_CONNECT_MP: boolean }).SELLER_MUST_CONNECT_MP = antes;
    }
  }

  describe('Lo que SÍ puede hacer sin conectar', () => {
    it('crear su tienda', async () => {
      await conReglaEncendida(async () => {
        const v = await nuevoVendedor();
        expect(v.seller.id).toBeTruthy();
      });
    });

    it('⛔ cargar un producto en BORRADOR', async () => {
      /**
       * Es la mitad más importante de la regla. Frenarlo acá lo mandaría a
       * conectar una cuenta antes de saber si le sirve la app.
       */
      await conReglaEncendida(async () => {
        const v = await nuevoVendedor();
        n += 1;
        const r = await call('POST', '/api/v1/products', {
          token: v.token,
          body: {
            name: `Borrador sin MP ${n}`,
            slug: `borrador-sin-mp-${n}-${Date.now().toString(36)}`,
            basePriceCents: 500_000,
            status: 'DRAFT',
          },
        });

        expect(r.status, JSON.stringify(r.body)).toBe(201);
      });
    });

    it('configurar envío y devoluciones', async () => {
      await conReglaEncendida(async () => {
        const v = await nuevoVendedor();
        const tienda = await prisma.store.findFirstOrThrow({
          where: { sellerId: v.seller.id as string },
        });

        const r = await call('PATCH', `/api/v1/stores/${tienda.id}/shipping`, {
          token: v.token,
          body: {
            shippingMode: 'FIXED_PRICE',
            shippingFlatAmount: 350_000,
            processorFeeMode: 'ABSORBED',
          },
        });

        expect(r.status, JSON.stringify(r.body)).toBe(200);
      });
    });
  });

  describe('⛔ Lo que NO puede', () => {
    it('publicar un producto', async () => {
      await conReglaEncendida(async () => {
        const v = await nuevoVendedor();
        n += 1;
        const r = await call('POST', '/api/v1/products', {
          token: v.token,
          body: {
            name: `Publicado sin MP ${n}`,
            slug: `publicado-sin-mp-${n}-${Date.now().toString(36)}`,
            basePriceCents: 500_000,
            status: 'ACTIVE',
          },
        });

        // 422 y no 403: no es falta de permiso, es un requisito que PUEDE
        // cumplir. La app tiene que ofrecer el botón de conectar.
        expect(r.status, JSON.stringify(r.body)).toBe(422);
        expect(r.body.error.code).toBe('MP_ACCOUNT_REQUIRED');
        expect(r.body.error.message).toContain('Mercado Pago');
      });
    });

    it('pasar un borrador a publicado', async () => {
      await conReglaEncendida(async () => {
        const v = await nuevoVendedor();
        n += 1;
        const creado = await call('POST', '/api/v1/products', {
          token: v.token,
          body: {
            name: `Borrador a publicar ${n}`,
            slug: `borr-pub-${n}-${Date.now().toString(36)}`,
            basePriceCents: 500_000,
            status: 'DRAFT',
          },
        });
        expect(creado.status).toBe(201);

        const r = await call('PATCH', `/api/v1/products/${creado.body.id}`, {
          token: v.token,
          body: { status: 'ACTIVE' },
        });

        expect(r.status, JSON.stringify(r.body)).toBe(422);
        expect(r.body.error.code).toBe('MP_ACCOUNT_REQUIRED');
      });
    });

    it('el mensaje dice qué acción se frenó', async () => {
      // Un mensaje genérico deja a la persona sin saber qué estaba haciendo,
      // sobre todo si tocó "publicar" en una lista de veinte productos.
      await conReglaEncendida(async () => {
        const v = await nuevoVendedor();
        n += 1;
        const r = await call('POST', '/api/v1/products', {
          token: v.token,
          body: {
            name: `Mensaje ${n}`,
            slug: `mensaje-${n}-${Date.now().toString(36)}`,
            basePriceCents: 500_000,
            status: 'ACTIVE',
          },
        });

        expect(r.body.error.message).toContain('publicar un producto');
        expect(r.body.error.message).toContain('una sola vez');
      });
    });
  });

  describe('Con la cuenta conectada', () => {
    /** Deja al vendedor con la cuenta conectada, sin pasar por el OAuth real. */
    async function conectar(sellerId: string) {
      await prisma.sellerPaymentAccount.create({
        data: {
          id: `spa_test${sellerId.slice(-20)}`,
          sellerId,
          provider: 'MERCADO_PAGO',
          providerAccountId: '987654321',
          status: 'CONNECTED',
          connectedAt: new Date(),
        },
      });
    }

    it('publicar funciona', async () => {
      await conReglaEncendida(async () => {
        const v = await nuevoVendedor();
        await conectar(v.seller.id as string);

        n += 1;
        const r = await call('POST', '/api/v1/products', {
          token: v.token,
          body: {
            name: `Publicado con MP ${n}`,
            slug: `pub-con-mp-${n}-${Date.now().toString(36)}`,
            basePriceCents: 500_000,
            status: 'ACTIVE',
          },
        });

        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.status).toBe('ACTIVE');
      });
    });

    it('una cuenta REVOCADA no alcanza', async () => {
      // Desconectar tiene que volver a frenar la publicación: si no, alguien
      // conecta, publica y desconecta.
      await conReglaEncendida(async () => {
        const v = await nuevoVendedor();
        const sellerId = v.seller.id as string;
        await conectar(sellerId);
        await prisma.sellerPaymentAccount.updateMany({
          where: { sellerId },
          data: { status: 'REVOKED' },
        });

        n += 1;
        const r = await call('POST', '/api/v1/products', {
          token: v.token,
          body: {
            name: `Revocado ${n}`,
            slug: `revocado-${n}-${Date.now().toString(36)}`,
            basePriceCents: 500_000,
            status: 'ACTIVE',
          },
        });

        expect(r.status).toBe(422);
      });
    });

    it('un producto YA publicado se puede seguir editando', async () => {
      /**
       * Quitarle la posibilidad de corregir un precio mal puesto sería
       * castigarlo dos veces. Sólo se frena el paso A publicado.
       */
      await conReglaEncendida(async () => {
        const v = await nuevoVendedor();
        const sellerId = v.seller.id as string;
        await conectar(sellerId);

        n += 1;
        const creado = await call('POST', '/api/v1/products', {
          token: v.token,
          body: {
            name: `Editable ${n}`,
            slug: `editable-${n}-${Date.now().toString(36)}`,
            basePriceCents: 500_000,
            status: 'ACTIVE',
          },
        });

        await prisma.sellerPaymentAccount.updateMany({
          where: { sellerId },
          data: { status: 'REVOKED' },
        });

        const r = await call('PATCH', `/api/v1/products/${creado.body.id}`, {
          token: v.token,
          body: { basePriceCents: 400_000 },
        });

        expect(r.status, JSON.stringify(r.body)).toBe(200);
      });
    });
  });
});
