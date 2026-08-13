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
    'TRUNCATE audit_logs, product_variant_options, product_images, product_variants, ' +
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
