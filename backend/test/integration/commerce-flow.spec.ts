import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.schema';
import { CategoriasService } from '@/modules/commerce/categorias.service';
import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';
import { NACIMIENTO_ADULTO_ISO } from '../helpers/edad';

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

  /**
   * VendoX es 18+ y el backend lo exige antes de comprar y de crear la tienda.
   *
   * Se declara por el mismo camino que usa la app —`PATCH /auth/me`— y no
   * escribiendo la columna: así el test también falla si ese endpoint se rompe.
   * Ver `helpers/edad.ts`.
   */
  await call('PATCH', '/api/v1/auth/me', {
    token: r.body.accessToken as string,
    body: { birthDate: NACIMIENTO_ADULTO_ISO },
  });

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


/**
 * Como , pero devuelve la respuesta cruda.
 *
 *  parsea el cuerpo como JSON y descarta las cabeceras, que es lo
 * correcto para una API. Las páginas de enlaces compartidos devuelven HTML y
 * lo que hay que verificar es justamente el  y el
 * .
 */
async function llamarCrudo(method: string, url: string) {
  const res = await (app as NestFastifyApplication)
    .getHttpAdapter()
    .getInstance()
    .inject({ method: method as never, url });
  return { status: res.statusCode, headers: res.headers, body: res.body };
}

async function crearProducto(token: string, extra: Record<string, unknown> = {}) {
  n += 1;

  /**
   * Publicar exige rubro, así que el helper le pone uno.
   *
   * Sólo al publicar, y sólo si quien llama no eligió otro. Si lo pusiera
   * siempre, el test de "un borrador sin rubro no se puede publicar" quedaría
   * sin sentido: su borrador ya tendría categoría.
   */
  const publica = extra.status === 'ACTIVE';
  const rubro = publica && !('categoryId' in extra) ? { categoryId: 'cat_otros' } : {};

  const r = await call('POST', '/api/v1/products', {
    token,
    body: { name: `Producto ${n}`, basePriceCents: 1_549_900, ...rubro, ...extra },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

/** Un vendedor con un producto publicado. Los helpers de este archivo no
 *  devuelven el sellerId, así que se resuelve acá. */
async function nuevoVendedorConProducto() {
  const v = await nuevoVendedor();
  const producto = await crearProducto(v.token, { status: 'ACTIVE' });
  return {
    token: v.token,
    sellerId: v.seller.id as string,
    productId: producto.id as string,
  };
}

/** Un administrador. El rol se pone en la base: no hay endpoint. */
async function nuevoAdmin() {
  const u = await nuevoUsuario();
  await prisma.user.update({ where: { id: u.userId }, data: { role: 'admin' } });
  return u;
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

  /**
   * El tercer salto: producto PROPIO, variante AJENA.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * POR QUÉ LOS TESTS DE ARRIBA NO ALCANZAN
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Todos mandan el producto de la víctima, así que los frena el PRIMER salto
   * —`productOf`, que no encuentra un producto ajeno— y nunca se llega a
   * comprobar el tercero.
   *
   * El ataque real es otro: el atacante manda un producto suyo, que existe y
   * es suyo, y le cuelga el `variantId` de la víctima. Si la búsqueda de la
   * variante no exigiera `productId`, la encontraría igual.
   *
   * Se descubrió sacando `productId: product.id` del WHERE de `variantOf`: las
   * 817 pruebas de integración seguían en verde. Tres operaciones dependen de
   * ese filtro, y las tres son graves.
   */
  it('⛔ con un producto propio no puede alcanzar la variante de otro', async () => {
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    const deA = await crearProducto(a.token);
    const deB = await crearProducto(b.token);
    const varianteDeB = deB.variants[0].id as string;

    // Cambiarle el precio.
    const precio = await call('PATCH', `/api/v1/products/${deA.id}/variants/${varianteDeB}`, {
      token: a.token,
      body: { priceOverrideCents: 100_000 },
    });
    expect(precio.status, JSON.stringify(precio.body)).toBe(404);

    // Borrársela.
    const borrado = await call('DELETE', `/api/v1/products/${deA.id}/variants/${varianteDeB}`, {
      token: a.token,
    });
    expect(borrado.status, JSON.stringify(borrado.body)).toBe(404);

    // Y la peor: moverle el stock. Poner en cero el stock de la competencia
    // durante su vivo no le cuesta plata a nadie y le arruina la transmisión.
    const stock = await call(
      'PATCH',
      `/api/v1/products/${deA.id}/variants/${varianteDeB}/inventory`,
      { token: a.token, body: { onHand: 0 } },
    );
    expect(stock.status, JSON.stringify(stock.body)).toBe(404);
  });

  it('⛔ la variante ajena queda intacta después del intento', async () => {
    // El 404 podría llegar DESPUÉS de haber escrito. Lo que importa no es el
    // código de estado sino que el dato de la víctima no se haya movido.
    const a = await nuevoVendedor();
    const b = await nuevoVendedor();
    const deA = await crearProducto(a.token);
    const deB = await crearProducto(b.token);
    const varianteDeB = deB.variants[0].id as string;

    const antes = await prisma.productVariant.findUniqueOrThrow({
      where: { id: varianteDeB },
      select: { priceOverrideCents: true, deletedAt: true, status: true },
    });

    await call('PATCH', `/api/v1/products/${deA.id}/variants/${varianteDeB}`, {
      token: a.token,
      body: { priceOverrideCents: 100_000 },
    });
    await call('DELETE', `/api/v1/products/${deA.id}/variants/${varianteDeB}`, {
      token: a.token,
    });

    const despues = await prisma.productVariant.findUniqueOrThrow({
      where: { id: varianteDeB },
      select: { priceOverrideCents: true, deletedAt: true, status: true },
    });
    expect(despues).toEqual(antes);
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

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * LA URL DE LA FOTO NO PUEDE VENIR DE UN HOST QUE YA NO EXISTE
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Pasó en un celular: «Mi tienda» mostraba el recuadro gris en vez de la
   * foto. El archivo estaba entero en el almacenamiento y la fila en la base.
   * Lo que estaba muerto era la columna `url`, escrita meses antes con el host
   * de un túnel de desarrollo efímero.
   *
   * No es un problema sólo de desarrollo: toda foto subida durante la beta
   * queda apuntando al host de la beta. El día que el backend pase a
   * `api.vendox.com.ar`, todas dejan de verse a la vez y nada falla ni avisa.
   *
   * Estos tests recorren las respuestas REALES buscando hosts ajenos al
   * configurado. Están escritos así —y no comparando contra una URL armada a
   * mano— para que también atrapen un punto de emisión NUEVO que se olvide de
   * resolver: hay una docena, y el propio `FEED_SELECT` ya advertía que
   * duplicar este bloque deja tarjetas sin foto.
   */
  describe('La URL de la foto se deriva del storageKey', () => {
    /** Todas las URLs que aparecen en una respuesta, a cualquier profundidad. */
    function urlsDe(valor: unknown, encontradas: string[] = []): string[] {
      if (typeof valor === 'string') {
        if (valor.startsWith('http://') || valor.startsWith('https://')) encontradas.push(valor);
      } else if (Array.isArray(valor)) {
        for (const v of valor) urlsDe(v, encontradas);
      } else if (valor && typeof valor === 'object') {
        for (const v of Object.values(valor)) urlsDe(v, encontradas);
      }
      return encontradas;
    }

    /** Las que apuntan a una imagen de producto, que son las que nos importan. */
    const deMedia = (urls: string[]) => urls.filter((u) => u.includes('/media/products/'));

    it('⛔ el listado de Mi tienda no devuelve el host viejo', async () => {
      const { token } = await nuevoVendedor();
      const p = await crearProducto(token, { status: 'ACTIVE' });
      await subirArchivo(token, p.id, jpegDePrueba());

      const r = await call('GET', '/api/v1/products/mine', { token });
      expect(r.status, JSON.stringify(r.body)).toBe(200);

      const urls = deMedia(urlsDe(r.body));
      expect(urls.length, 'el producto tiene foto: tiene que haber una URL').toBeGreaterThan(0);
      for (const u of urls) {
        expect(u.startsWith(env.PUBLIC_BASE_URL), `URL de otro host: ${u}`).toBe(true);
      }
    });

    it('⛔ un producto con foto nunca sale sin portada', async () => {
      const { token } = await nuevoVendedor();
      const p = await crearProducto(token, { status: 'ACTIVE', categoryId: 'cat_otros' });
      await subirArchivo(token, p.id, jpegDePrueba());

      const r = await call('GET', '/api/v1/products/mine', { token });
      const producto = (r.body.items as Array<{ id: string; images: unknown[] }>).find(
        (x) => x.id === p.id,
      );

      expect(producto, 'el producto tiene que estar en el listado').toBeDefined();
      expect(producto!.images.length, 'con foto subida, images no puede venir vacío').toBe(1);
    });

    it('la portada es la PRIMERA foto, no una cualquiera', async () => {
      const { token } = await nuevoVendedor();
      const p = await crearProducto(token, { status: 'ACTIVE' });

      const a = await subirArchivo(token, p.id, jpegDePrueba());
      await subirArchivo(token, p.id, jpegDePrueba());

      const enBase = await prisma.productImage.findFirstOrThrow({
        where: { productId: p.id, position: 0 },
        select: { id: true, storageKey: true },
      });
      expect(enBase.id, 'la primera que se sube es la portada').toBe(a.body.id);

      const r = await call('GET', '/api/v1/products/mine', { token });
      const producto = (r.body.items as Array<{ id: string; images: Array<{ id: string }> }>).find(
        (x) => x.id === p.id,
      );

      expect(producto!.images[0]!.id).toBe(enBase.id);
    });

    it('la URL se arma con el storageKey de la fila, no con lo guardado', async () => {
      /**
       * El corazón del arreglo. Se ensucia la columna `url` a mano —igual que
       * quedó en la base real— y la respuesta tiene que ignorarla.
       */
      const { token } = await nuevoVendedor();
      const p = await crearProducto(token, { status: 'ACTIVE' });
      const img = await subirArchivo(token, p.id, jpegDePrueba());

      await prisma.productImage.update({
        where: { id: img.body.id as string },
        data: { url: 'https://un-tunel-que-ya-no-existe.example.com/media/loquesea.jpg' },
      });

      const r = await call('GET', '/api/v1/products/mine', { token });
      const cuerpo = JSON.stringify(r.body);

      expect(cuerpo).not.toContain('un-tunel-que-ya-no-existe');

      const fila = await prisma.productImage.findUniqueOrThrow({
        where: { id: img.body.id as string },
        select: { storageKey: true },
      });
      expect(cuerpo).toContain(fila.storageKey);
    });

    it('⛔ el FEED tampoco devuelve el host viejo', async () => {
      /**
       * El feed y la vidriera van por otro camino que «Mi tienda»: usan
       * `portadaDe` en vez de `conUrls`. Se probó y hacía falta — con sólo los
       * tests de arriba, hacer que `portadaDe` volviera a leer la columna
       * guardada dejaba las 840 pruebas en verde.
       *
       * Y es el camino que mira quien COMPRA, que es el que más importa.
       */
      const { token } = await nuevoVendedor();
      const p = await crearProducto(token, { status: 'ACTIVE', categoryId: 'cat_otros' });
      const img = await subirArchivo(token, p.id, jpegDePrueba());

      // Se ensucia la columna igual que quedó en la base real.
      await prisma.productImage.update({
        where: { id: img.body.id as string },
        data: { url: 'https://un-tunel-que-ya-no-existe.example.com/media/loquesea.jpg' },
      });

      const fila = await prisma.productImage.findUniqueOrThrow({
        where: { id: img.body.id as string },
        select: { storageKey: true },
      });

      /**
       * Se afirma que la URL BUENA está, no sólo que la mala no está.
       *
       * Sin la primera mitad este test no sirve: al sacar `url` del `select`,
       * una portada que quedara en `null` tampoco «contiene» el host viejo, y
       * el sabotaje pasaría en verde. Se midió.
       */
      function revisar(cuerpo: unknown, donde: string) {
        const texto = JSON.stringify(cuerpo);
        expect(texto, `${donde}: falta la URL de la foto`).toContain(fila.storageKey);
        expect(texto, `${donde}: sigue el host viejo`).not.toContain('un-tunel-que-ya-no-existe');
      }

      const feed = await call('GET', '/api/v1/discover/products?limit=50');
      expect(feed.status, JSON.stringify(feed.body)).toBe(200);
      revisar(feed.body, 'feed');

      const store = await prisma.store.findFirstOrThrow({
        where: { products: { some: { id: p.id as string } } },
        select: { id: true, slug: true },
      });
      const vidriera = await call('GET', `/api/v1/stores/by-slug/${store.slug}/products`);
      revisar(vidriera.body, 'vidriera');

      /**
       * El catálogo de la tienda va por `portadaDe`, que es OTRO camino que el
       * feed y la vidriera —esos usan `conUrls`—. Sin este caso, romper
       * `portadaDe` dejaba las 199 pruebas en verde: se midió dos veces.
       */
      const catalogo = await call('GET', `/api/v1/stores/${store.id}/catalog?limit=20`);
      expect(catalogo.status, JSON.stringify(catalogo.body)).toBe(200);
      revisar(catalogo.body, 'catálogo de la tienda');
    });

    it('reordenar devuelve URLs, no claves de almacenamiento', async () => {
      /**
       * Este test existe por una regresión que se metió arreglando lo de
       * arriba: al cambiar el `select` a `storageKey`, el endpoint de
       * reordenar pasó a devolver las filas crudas — con la clave interna y
       * sin ninguna URL. La suite entera siguió en verde.
       *
       * Lo que se veía: reordenás las fotos en el editor y todas se vuelven
       * grises hasta recargar.
       */
      const { token } = await nuevoVendedor();
      const p = await crearProducto(token);
      const a = await subirArchivo(token, p.id, jpegDePrueba());
      const b = await subirArchivo(token, p.id, jpegDePrueba());

      const r = await call('PATCH', `/api/v1/products/${p.id}/images/reorder`, {
        token,
        body: { imageIds: [b.body.id, a.body.id] },
      });

      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const imagenes = r.body as Array<Record<string, unknown>>;
      expect(imagenes).toHaveLength(2);
      for (const img of imagenes) {
        expect(typeof img.url, 'cada imagen tiene que traer su url').toBe('string');
        expect(img.storageKey, 'la clave de almacenamiento no sale de la API').toBeUndefined();
      }
      // Y el orden nuevo se respeta: la portada es la que se puso primera.
      expect(imagenes[0]!.id).toBe(b.body.id);
    });

    it('subir una foto devuelve su url, no la clave', async () => {
      const { token } = await nuevoVendedor();
      const p = await crearProducto(token);

      const r = await subirArchivo(token, p.id, jpegDePrueba());

      expect(typeof r.body.url).toBe('string');
      expect((r.body.url as string).startsWith(env.PUBLIC_BASE_URL)).toBe(true);
    });

    it('un producto SIN fotos devuelve la lista vacía, no una URL rota', async () => {
      // La contraparte: sin esto, un resolver que devolviera siempre una URL
      // armada pasaría los tests de arriba y pondría una imagen inexistente en
      // cada tarjeta sin foto.
      const { token } = await nuevoVendedor();
      const p = await crearProducto(token, { status: 'ACTIVE' });

      const r = await call('GET', '/api/v1/products/mine', { token });
      const producto = (r.body.items as Array<{ id: string; images: unknown[] }>).find(
        (x) => x.id === p.id,
      );

      expect(producto!.images).toEqual([]);
    });
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
      body: { name: `${nombre} ${Date.now()}`, basePriceCents: 1_500_000, status: 'ACTIVE', categoryId: 'cat_otros' },
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
        categoryId: 'cat_otros',
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
        categoryId: 'cat_otros',
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
        categoryId: 'cat_otros',
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
        categoryId: 'cat_otros',
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
        categoryId: 'cat_otros',
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
        categoryId: 'cat_otros',
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
        categoryId: 'cat_otros',
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
        categoryId: 'cat_otros',
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
            categoryId: 'cat_otros',
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
          body: { status: 'ACTIVE', categoryId: 'cat_otros' },
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
            categoryId: 'cat_otros',
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
            categoryId: 'cat_otros',
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
            categoryId: 'cat_otros',
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
            categoryId: 'cat_otros',
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

// ═══════════════════════════════════════════════════════════════════════════
// CODIFICACIÓN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Los acentos sobreviven la ida y la vuelta.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL BUG QUE ORIGINÓ ESTE BLOQUE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * En el teléfono apareció `Vela arom�tica` en la búsqueda. Los bytes guardados
 * en la base eran `…6f 6d EF BF BD 74…`: U+FFFD, el carácter de reemplazo. El
 * texto estaba roto EN EL DISCO, no era un problema de cómo se mostraba.
 *
 * Lo escribió un script desde una consola de Windows con página de códigos
 * 1252. La ruta viva —app, API, base— estaba bien, pero nada impedía guardar
 * texto ya roto ni normalizaba dos formas Unicode de la misma palabra.
 *
 * Esto prueba las dos cosas contra PostgreSQL de verdad, que es el único lugar
 * donde se puede verificar que los bytes son los correctos.
 */
describe('Codificación', () => {
  const PALABRAS = ['Vela aromática', 'Muñeca de trapo', 'Niñez', 'Té de hierbas'];

  async function crear(vendedor: { token: string }, nombre: string) {
    n += 1;
    return call('POST', '/api/v1/products', {
      token: vendedor.token,
      body: {
        name: nombre,
        slug: `enc-${n}-${Date.now().toString(36)}`,
        basePriceCents: 500_000,
        status: 'ACTIVE',
        categoryId: 'cat_otros',
      },
    });
  }

  it('⛔ los acentos sobreviven de la app a la base y de vuelta', async () => {
    const v = await nuevoVendedor();
    /**
     * Pro porque este test publica una palabra por cada caso de codificación, y
     * son más de tres.
     *
     * Es una decisión del test, no un agujero de la regla: lo que se prueba acá
     * son los bytes que llegan a PostgreSQL, y el tope del plan Free no tiene
     * nada que ver. Reducir la lista de palabras para no chocarlo habría dejado
     * casos de codificación sin cubrir por una razón ajena.
     */
    await prisma.sellerMembership.create({
      data: {
        id: `mem_enc_${(v.seller.id as string).slice(-16)}`,
        sellerId: v.seller.id as string,
        plan: 'PRO',
        periodo: 'MENSUAL',
        origen: 'CORTESIA',
        vigenteHasta: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    for (const palabra of PALABRAS) {
      const creado = await crear(v, palabra);
      expect(creado.status, `${palabra} → ${JSON.stringify(creado.body)}`).toBe(201);

      // Lo que devuelve la API.
      expect(creado.body.name, palabra).toBe(palabra);

      // Y lo que hay en la base, en BYTES. Es lo único que prueba de verdad que
      // no se rompió: una cadena que se lee bien en la consola puede tener el
      // carácter de reemplazo adentro.
      const enLaBase = await prisma.$queryRawUnsafe<Array<{ hex: string }>>(
        `select encode(convert_to(name,'UTF8'),'hex') hex from products where id = $1`,
        creado.body.id as string,
      );
      expect(enLaBase[0]?.hex, palabra).toBe(Buffer.from(palabra, 'utf8').toString('hex'));
    }
  });

  it('⛔ el texto ya roto se RECHAZA, no se guarda', async () => {
    /**
     * Un U+FFFD en algo que escribió una persona siempre es una decodificación
     * fallida más arriba. Nadie lo escribe: no está en ningún teclado. Se
     * rechaza en el borde, que es el único momento en que todavía se puede
     * pedir el texto de nuevo.
     */
    const v = await nuevoVendedor();

    // Exactamente como se rompió: el `á` como byte suelto de cp1252.
    const comoLlego = Buffer.from([0xe1]).toString('utf8');
    const r = await crear(v, `Vela arom${comoLlego}tica`);

    expect(r.status, JSON.stringify(r.body)).toBe(400);
    // El nombre EXACTO: 'Vela arom' es prefijo del producto sano que crea el
    // test anterior, y contarlo daría un falso positivo.
    expect(
      await prisma.product.count({ where: { name: { contains: comoLlego } } }),
    ).toBe(0);
  });

  it('⛔ la misma palabra en dos formas Unicode queda igual', async () => {
    /**
     * "á" se puede escribir como U+00E1 o como a + U+0301. Se ven idénticos y
     * no son iguales: un producto cargado desde un iPhone no se encontraría
     * buscando desde un Android.
     */
    const v = await nuevoVendedor();

    const descompuesta = 'Vela aromática'.normalize('NFD');
    const compuesta = 'Vela aromática'.normalize('NFC');
    expect(descompuesta).not.toBe(compuesta);

    const r = await crear(v, descompuesta);
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    // Se guardó en la forma canónica, no como llegó.
    expect(r.body.name).toBe(compuesta);
  });

  it('la búsqueda encuentra con y sin acento', async () => {
    // Es donde el bug se vio. El stemmer de PostgreSQL ya lo resolvía; lo que
    // faltaba era que el texto llegara entero.
    const v = await nuevoVendedor();
    await crear(v, 'Vela aromática de lavanda');

    for (const q of ['aromática', 'aromatica', 'vela']) {
      const r = await call('GET', `/api/v1/discover/products?q=${encodeURIComponent(q)}`);
      const nombres = (r.body.items as Array<{ name: string }>).map((p) => p.name);
      expect(nombres, q).toContain('Vela aromática de lavanda');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VENDER TAMBIÉN ES 18+
// ═══════════════════════════════════════════════════════════════════════════

/**
 * La mayoría de edad del lado del vendedor.
 *
 * Importa más que del lado del comprador: detrás de una tienda hay una cuenta
 * bancaria, retenciones y responsabilidad fiscal. Un menor vendiendo deja
 * obligaciones a nombre de alguien sin capacidad para contraerlas.
 *
 * La edad es DECLARADA, no verificada. Ver `users/edad.ts`.
 */
describe('Abrir tienda es 18+', () => {
  /** Un usuario recién registrado, sin fecha declarada. */
  async function sinEdad() {
    n += 1;
    const r = await call('POST', '/api/v1/auth/dev', {
      body: {
        email: `sinedad${n}-${Date.now()}@test.com`,
        firstName: 'Sin',
        lastName: `Edad${n}`,
        device: {
          installId: `install-sinedad-${n}-${Date.now()}`,
          platform: 'android',
          appVersion: '1.0.0',
          osVersion: '14',
        },
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.accessToken as string;
  }

  it('⛔ sin fecha declarada no se puede crear la tienda', async () => {
    const token = await sinEdad();

    const r = await call('POST', '/api/v1/sellers', {
      token,
      body: { displayName: 'Tejidos sin edad' },
    });

    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('BIRTH_DATE_REQUIRED');
    // El mensaje habla de la tienda, no de comprar: quien lo lee tiene que
    // reconocer qué estaba intentando hacer.
    expect(r.body.error.message).toContain('tienda');
  });

  it('⛔ un menor no puede abrir tienda', async () => {
    const token = await sinEdad();
    await call('PATCH', '/api/v1/auth/me', { token, body: { birthDate: '2012-06-01' } });

    const r = await call('POST', '/api/v1/sellers', {
      token,
      body: { displayName: 'Tejidos de un menor' },
    });

    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('UNDERAGE');
    expect(r.body.error.message).toContain('vender');
  });

  it('⛔ y no queda nada a medio crear', async () => {
    /**
     * Crear un vendedor crea también su tienda y le cambia el rol al usuario,
     * todo en una transacción. Si el bloqueo estuviera adentro y no antes,
     * podría quedar un usuario con rol `seller` y sin tienda.
     */
    const token = await sinEdad();
    await call('PATCH', '/api/v1/auth/me', { token, body: { birthDate: '2012-06-01' } });

    await call('POST', '/api/v1/sellers', { token, body: { displayName: 'Nada' } });

    const me = await call('GET', '/api/v1/auth/me', { token });
    expect(me.body.role).toBe('buyer');

    const mio = await call('GET', '/api/v1/sellers/me', { token });
    expect(mio.status).toBe(404);
  });

  it('declarando la fecha, el mismo usuario sí puede', async () => {
    const token = await sinEdad();
    await call('PATCH', '/api/v1/auth/me', { token, body: { birthDate: '1990-05-20' } });

    const r = await call('POST', '/api/v1/sellers', {
      token,
      body: { displayName: `Tejidos con edad ${Date.now()}` },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

describe('Categorías de producto', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LA TABLA EXISTÍA VACÍA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `categories` y `products.category_id` estaban en el esquema desde el
   * principio, el DTO aceptaba `categoryId`, y no había ni una fila ni un
   * endpoint que las listara: un campo opcional que nadie podía completar.
   */

  it('el catálogo se lista sin sesión', async () => {
    // Quien está por publicar su primer producto necesita la lista antes de
    // tener tienda, y navegar por rubro es mirar la vidriera.
    const r = await call('GET', '/api/v1/categories');

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.length).toBeGreaterThanOrEqual(14);

    const primera = r.body[0];
    expect(primera).toHaveProperty('id');
    expect(primera).toHaveProperty('slug');
    expect(primera).toHaveProperty('nombre');
  });

  it('vienen en orden de presentación, no alfabético', async () => {
    // Arriba va lo que más se vende en vivo. Alfabético pondría "Accesorios"
    // primero y "Otros" en el medio.
    const r = await call('GET', '/api/v1/categories');
    const ids = (r.body as { id: string }[]).map((c) => c.id);

    expect(ids[0]).toBe('cat_indumentaria');
    expect(ids[ids.length - 1]).toBe('cat_otros');
  });

  it('⛔ publicar sin categoría se rechaza', async () => {
    /**
     * Un producto activo sin categoría no sale en ninguna navegación por rubro.
     * Está publicado y no lo encuentra nadie — que para quien vende es peor que
     * no haberlo publicado, porque cree que está a la venta.
     */
    const { token } = await nuevoVendedor();
    n += 1;

    const r = await call('POST', '/api/v1/products', {
      token,
      body: { name: `Sin rubro ${n}`, basePriceCents: 100_000, status: 'ACTIVE' },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error.code).toBe('CATEGORY_REQUIRED');
  });

  it('⛔ pero el BORRADOR sin categoría se guarda igual', async () => {
    // Mismo criterio que Mercado Pago: quien carga cuarenta productos los
    // carga, y recién al publicar completa lo que falta.
    const { token } = await nuevoVendedor();
    n += 1;

    const r = await call('POST', '/api/v1/products', {
      token,
      body: { name: `Borrador sin rubro ${n}`, basePriceCents: 100_000, status: 'DRAFT' },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.categoryId).toBeNull();
  });

  it('⛔ pasar un borrador a publicado sin categoría también se rechaza', async () => {
    // El segundo camino a publicado. La primera versión de la regla sólo
    // cubría el primero.
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'DRAFT' });

    const r = await call('PATCH', `/api/v1/products/${p.id}`, {
      token,
      body: { status: 'ACTIVE' },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error.code).toBe('CATEGORY_REQUIRED');
  });

  it('⛔ y a un producto YA publicado no se le puede sacar la categoría', async () => {
    /**
     * El caso que se escapa si uno mira sólo `dto.status`: el PATCH no toca el
     * estado, así que "no está publicando" — y sin embargo deja un producto
     * activo fuera de toda navegación por rubro.
     */
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE', categoryId: 'cat_calzado' });
    expect(p.status).toBe('ACTIVE');

    const r = await call('PATCH', `/api/v1/products/${p.id}`, {
      token,
      body: { categoryId: null },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error.code).toBe('CATEGORY_REQUIRED');
  });

  it('con categoría, se publica', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE', categoryId: 'cat_hogar' });

    expect(p.status).toBe('ACTIVE');
    expect(p.categoryId).toBe('cat_hogar');
  });

  /**
   * El rubro elegido tiene que estar cuando el vendedor vuelve a abrir.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * LO QUE SE PROBABA ERA LA RESPUESTA DE CREACIÓN, NO LA VUELTA
   * ═════════════════════════════════════════════════════════════════════════
   *
   * El test de arriba mira lo que devuelve el POST. Eso no prueba que el dato
   * haya quedado guardado: un `categoryId` que se devolviera desde el cuerpo
   * del pedido sin escribirse en la base pasaría igual.
   *
   * Lo que el vendedor vive es otra cosa — cierra el editor, vuelve a entrar,
   * y el campo Rubro tiene que estar completo. Si aparece vacío, va a elegir
   * de nuevo o, peor, va a creer que se despublicó.
   */
  it('el rubro sobrevive a cerrar y reabrir el producto', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE', categoryId: 'cat_hogar' });

    // Reabrir es un GET del detalle, que es lo que hace el editor.
    const alReabrir = await call('GET', `/api/v1/products/${p.id}`, { token });

    expect(alReabrir.status, JSON.stringify(alReabrir.body)).toBe(200);
    expect(alReabrir.body.categoryId).toBe('cat_hogar');
  });

  it('cambiar el rubro lo cambia de verdad, no sólo en la respuesta', async () => {
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE', categoryId: 'cat_hogar' });

    const editado = await call('PATCH', `/api/v1/products/${p.id}`, {
      token,
      body: { categoryId: 'cat_mascotas' },
    });
    expect(editado.status, JSON.stringify(editado.body)).toBe(200);
    expect(editado.body.categoryId).toBe('cat_mascotas');

    // Y en la base, que es donde importa.
    const enBase = await prisma.product.findUniqueOrThrow({ where: { id: p.id as string } });
    expect(enBase.categoryId).toBe('cat_mascotas');

    // Y al reabrir.
    const alReabrir = await call('GET', `/api/v1/products/${p.id}`, { token });
    expect(alReabrir.body.categoryId).toBe('cat_mascotas');
  });

  it('el id que devuelve el catálogo es uno que el editor puede guardar', async () => {
    /**
     * El contrato entre las dos puntas, en un solo test.
     *
     * La app llena el desplegable con lo que devuelve `/categories` y manda de
     * vuelta el `id` que eligió la persona. Si esos dos vocabularios se
     * separaran —por ejemplo si el catálogo empezara a devolver el `slug` como
     * `id`— cada intento de publicar daría 404 y ninguno de los tests de
     * arriba se enteraría, porque todos usan ids escritos a mano.
     */
    const catalogo = await call('GET', '/api/v1/categories');
    const primera = (catalogo.body as { id: string }[])[0];
    expect(primera, 'el catálogo no puede venir vacío').toBeDefined();

    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE', categoryId: primera!.id });

    expect(p.categoryId).toBe(primera!.id);
  });

  it('⛔ una categoría inventada se rechaza con 404, no con un 500 de Prisma', async () => {
    /**
     * Antes `categoryId` era texto libre de hasta 40 caracteres que se escribía
     * tal cual en la columna: la clave foránea lo rebotaba con un P2003, o sea
     * un 500 con traza de Prisma en la respuesta.
     */
    const { token } = await nuevoVendedor();
    n += 1;

    const r = await call('POST', '/api/v1/products', {
      token,
      body: {
        name: `Rubro inventado ${n}`,
        basePriceCents: 100_000,
        status: 'ACTIVE',
        categoryId: 'cat_no_existe',
      },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(r.body.error.code).toBe('CATEGORY_NOT_FOUND');
  });

  it('⛔ una categoría APAGADA se rechaza igual', async () => {
    /**
     * No hay clave foránea que detecte esto: la fila existe. Apagar una
     * categoría la saca del selector, y sin esta validación alguien con el id
     * viejo la seguiría usando desde una app sin actualizar.
     */
    const { token } = await nuevoVendedor();
    n += 1;

    await prisma.category.update({ where: { id: 'cat_otros' }, data: { active: false } });
    // El servicio cachea el catálogo en memoria: sin esto leería la lista vieja.
    app.get(CategoriasService).olvidar();

    try {
      const r = await call('POST', '/api/v1/products', {
        token,
        body: {
          name: `Rubro apagado ${n}`,
          basePriceCents: 100_000,
          status: 'ACTIVE',
          categoryId: 'cat_otros',
        },
      });

      expect(r.status, JSON.stringify(r.body)).toBe(404);
      expect(r.body.error.code).toBe('CATEGORY_NOT_FOUND');

      // Y desaparece del catálogo público.
      const lista = await call('GET', '/api/v1/categories');
      expect((lista.body as { id: string }[]).some((c) => c.id === 'cat_otros')).toBe(false);
    } finally {
      await prisma.category.update({ where: { id: 'cat_otros' }, data: { active: true } });
      app.get(CategoriasService).olvidar();
    }
  });

  it('⛔ apagar una categoría NO toca los productos que ya la tienen', async () => {
    /**
     * Borrarla los dejaría en `category_id NULL`: publicados y fuera de toda
     * navegación por rubro, sin que su dueño se entere. Por eso `active` y no
     * un DELETE.
     */
    const { token } = await nuevoVendedor();
    const p = await crearProducto(token, { status: 'ACTIVE', categoryId: 'cat_mascotas' });

    await prisma.category.update({ where: { id: 'cat_mascotas' }, data: { active: false } });
    app.get(CategoriasService).olvidar();

    try {
      const enBase = await prisma.product.findUniqueOrThrow({ where: { id: p.id as string } });
      expect(enBase.categoryId).toBe('cat_mascotas');
      expect(enBase.status).toBe('ACTIVE');
    } finally {
      await prisma.category.update({ where: { id: 'cat_mascotas' }, data: { active: true } });
      app.get(CategoriasService).olvidar();
    }
  });

  it('el feed se puede filtrar por rubro', async () => {
    const { token } = await nuevoVendedor();
    const dentro = await crearProducto(token, {
      status: 'ACTIVE',
      categoryId: 'cat_libreria',
    });
    const fuera = await crearProducto(token, {
      status: 'ACTIVE',
      categoryId: 'cat_deportes',
    });

    const r = await call('GET', '/api/v1/discover/products?categoria=cat_libreria&limit=50');
    expect(r.status).toBe(200);

    const ids = (r.body.items as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(dentro.id);
    expect(ids).not.toContain(fuera.id);
  });

  it('un rubro que no existe devuelve vacío, no un error', async () => {
    // Un filtro es una vista, no una operación: un enlace viejo a una categoría
    // apagada tiene que mostrar "no hay nada acá".
    const r = await call('GET', '/api/v1/discover/products?categoria=cat_no_existe');

    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });
});

describe('Interruptores de emergencia', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PARA QUÉ EXISTEN
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Apagar una parte del sistema sin desplegar nada. El caso es siempre urgente:
   * Mercado Pago devolviendo pagos duplicados, LiveKit caído, alguien subiendo
   * ejecutables disfrazados de imagen.
   *
   * Lo que estos tests protegen no es que apaguen —eso es un `if`— sino que
   * apaguen **sólo la puerta de entrada**. Una bandera que además cancela
   * órdenes pagas o corta un vivo al aire convierte un problema en dos.
   */

  /**
   * ⚠️ Se toca `env`, no `process.env`.
   *
   * `env` se evalúa y se congela al importar el módulo de configuración, así
   * que cambiar `process.env` a esta altura no mueve nada. Es feo y sólo vale
   * en un test; la alternativa —levantar otra aplicación entera por caso—
   * tarda diez segundos cada vez.
   */
  async function conBanderaApagada<T>(bandera: string, fn: () => Promise<T>): Promise<T> {
    const { env } = await import('@/config/env.schema');
    const mutable = env as unknown as Record<string, boolean | undefined>;
    const antes = mutable[bandera];
    mutable[bandera] = false;
    try {
      return await fn();
    } finally {
      mutable[bandera] = antes;
    }
  }

  it('el estado de las cuatro se publica en /auth/config', async () => {
    // La app las usa para esconder lo que está pausado, en vez de dejar que
    // alguien complete un checkout entero y choque contra un 503 al final.
    const r = await call('GET', '/api/v1/auth/config');

    expect(r.status).toBe(200);
    expect(r.body.banderas).toEqual({
      LIVE_ENABLED: true,
      CHECKOUT_ENABLED: true,
      SELLER_SIGNUP_ENABLED: true,
      PRODUCT_UPLOAD_ENABLED: true,
    });
  });

  it('⛔ SELLER_SIGNUP_ENABLED=false frena el alta de vendedores', async () => {
    await conBanderaApagada('SELLER_SIGNUP_ENABLED', async () => {
      const usuario = await nuevoUsuario();
      n += 1;

      const r = await call('POST', '/api/v1/sellers', {
        token: usuario.token,
        body: { displayName: `Tienda pausada ${n}` },
      });

      expect(r.status, JSON.stringify(r.body)).toBe(503);
      expect(r.body.error.code).toBe('FEATURE_PAUSED');
      // El mensaje no dice "bandera" ni qué se rompió: dice qué no se puede
      // hacer ahora y que es temporal.
      expect(r.body.error.message).toContain('pausada');
    });
  });

  it('⛔ pero quien YA es vendedor sigue operando', async () => {
    /**
     * El invariante de todas las banderas: cierran la puerta de entrada, no
     * rompen lo que está adentro. Una bandera que además suspende a los
     * vendedores existentes convierte un problema en dos.
     */
    const v = await nuevoVendedor();

    await conBanderaApagada('SELLER_SIGNUP_ENABLED', async () => {
      const perfil = await call('GET', '/api/v1/sellers/me', { token: v.token });
      expect(perfil.status).toBe(200);
      expect(perfil.body.seller.status).toBe('ACTIVE');
    });
  });

  it('⛔ PRODUCT_UPLOAD_ENABLED=false frena crear productos', async () => {
    const v = await nuevoVendedor();

    await conBanderaApagada('PRODUCT_UPLOAD_ENABLED', async () => {
      n += 1;
      const r = await call('POST', '/api/v1/products', {
        token: v.token,
        body: { name: `Producto pausado ${n}`, basePriceCents: 100_000 },
      });

      expect(r.status, JSON.stringify(r.body)).toBe(503);
      expect(r.body.error.code).toBe('FEATURE_PAUSED');
    });
  });

  it('⛔ y también subir fotos', async () => {
    // Es la misma bandera: "cargar un producto" es una sola operación para
    // quien la hace, y dejar crear la ficha con las imágenes apagadas produce
    // catálogos de productos sin foto que después nadie completa.
    const v = await nuevoVendedor();
    const p = await crearProducto(v.token);

    await conBanderaApagada('PRODUCT_UPLOAD_ENABLED', async () => {
      const r = await subirArchivo(v.token, p.id as string, jpegDePrueba());
      expect(r.status, JSON.stringify(r.body)).toBe(503);
    });
  });

  it('⛔ pero los productos que ya existen se siguen editando y viendo', async () => {
    const v = await nuevoVendedor();
    const p = await crearProducto(v.token, { status: 'ACTIVE', categoryId: 'cat_otros' });

    await conBanderaApagada('PRODUCT_UPLOAD_ENABLED', async () => {
      const editado = await call('PATCH', `/api/v1/products/${p.id}`, {
        token: v.token,
        body: { basePriceCents: 200_000 },
      });
      expect(editado.status, JSON.stringify(editado.body)).toBe(200);

      // Y sigue en el feed: apagar la carga no esconde el catálogo.
      const feed = await call('GET', '/api/v1/discover/products?limit=50');
      expect(feed.status).toBe(200);
    });
  });

  it('⛔ LIVE_ENABLED=false frena preparar un vivo', async () => {
    const v = await nuevoVendedor();

    await conBanderaApagada('LIVE_ENABLED', async () => {
      const r = await call('POST', '/api/v1/live', {
        token: v.token,
        body: { title: 'Vivo pausado', productIds: [] },
      });

      expect(r.status, JSON.stringify(r.body)).toBe(503);
      expect(r.body.error.code).toBe('FEATURE_PAUSED');
    });
  });

  it('encendidas de vuelta, todo vuelve a funcionar', async () => {
    /**
     * Que se puedan apagar no sirve de nada si no se pueden volver a prender.
     *
     * Suena obvio y no lo es: una bandera que además borra o marca algo al
     * apagarse deja restos que impiden volver al estado anterior. Éstas son
     * `if` sobre configuración y nada más, y este test lo fija.
     */
    const usuario = await nuevoUsuario();
    n += 1;

    await conBanderaApagada('SELLER_SIGNUP_ENABLED', async () => {
      const bloqueado = await call('POST', '/api/v1/sellers', {
        token: usuario.token,
        body: { displayName: `Vuelve ${n}` },
      });
      expect(bloqueado.status).toBe(503);
    });

    const ahora = await call('POST', '/api/v1/sellers', {
      token: usuario.token,
      body: { displayName: `Vuelve ${n}` },
    });
    expect(ahora.status, JSON.stringify(ahora.body)).toBe(201);
  });
});

describe('Filtros del feed', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SIN ROMPER EL RANKING QUE YA EXISTÍA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * El feed ya ordenaba por un puntaje —frescura, likes, si el vendedor está en
   * vivo, si está verificado— y esa lógica no se toca. Los filtros acotan QUÉ
   * entra; el puntaje sigue decidiendo el orden de lo que entró.
   *
   * Salvo que la persona pida un orden explícito, y ahí manda ella.
   */

  async function productoDe(precio: number, extra: Record<string, unknown> = {}) {
    const { token } = await nuevoVendedor();
    n += 1;
    const r = await call('POST', '/api/v1/products', {
      token,
      body: {
        name: `Filtrable ${n}`,
        basePriceCents: precio,
        status: 'ACTIVE',
        categoryId: 'cat_otros',
        ...extra,
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  }

  it('por rango de precio', async () => {
    const barato = await productoDe(50_000); // $500
    const caro = await productoDe(5_000_000); // $50.000

    const r = await call('GET', '/api/v1/discover/products?precioMin=10000&precioMax=100000&limit=50');
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const ids = (r.body.items as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(barato.id);
    expect(ids).not.toContain(caro.id);
  });

  it('⛔ un rango invertido se rechaza en vez de devolver vacío', async () => {
    // Casi siempre es un error de tipeo, y devolver vacío en silencio deja a
    // la persona pensando que no hay nada.
    const r = await call('GET', '/api/v1/discover/products?precioMin=500000&precioMax=1000');
    expect(r.status).toBe(400);
  });

  it('⛔ los precios del filtro son CENTAVOS, como todo el dinero', async () => {
    /**
     * Si acá viajaran en pesos, este sería el único lugar del sistema donde un
     * número de dinero significa otra cosa — y el día que alguien lo compare
     * con `basePriceCents` sin darse cuenta, el filtro va a andar cien veces
     * mal sin fallar.
     */
    const producto = await productoDe(1_000_000); // $10.000 = 1.000.000 centavos

    // En centavos, entra.
    const enCentavos = await call(
      'GET',
      '/api/v1/discover/products?precioMin=999999&precioMax=1000001&limit=50',
    );
    expect((enCentavos.body.items as { id: string }[]).map((p) => p.id)).toContain(producto.id);

    // Si fueran pesos, "10000" lo encontraría. No lo encuentra.
    const comoSiFueranPesos = await call(
      'GET',
      '/api/v1/discover/products?precioMin=9999&precioMax=10001&limit=50',
    );
    expect((comoSiFueranPesos.body.items as { id: string }[]).map((p) => p.id)).not.toContain(
      producto.id,
    );
  });

  it('por tienda', async () => {
    const a = await productoDe(100_000);
    const b = await productoDe(100_000);

    const r = await call(`GET`, `/api/v1/discover/products?tienda=${a.storeId}&limit=50`);
    const ids = (r.body.items as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  describe('EN VIVO AHORA', () => {
    it('⛔ todo lo que devuelve es de alguien que está al aire', async () => {
      /**
       * ⚠️ La primera versión de este test afirmaba «devuelve vacío» y fallaba
       * en la suite completa: la base de tests no se trunca entre archivos, así
       * que otros tests dejan vivos abiertos y el filtro —correctamente—
       * devolvía sus productos.
       *
       * El test estaba mal, no el filtro. La garantía real no es «vacío» sino
       * «todo lo que sale es de alguien transmitiendo», y eso no depende de lo
       * que hayan dejado otros archivos.
       *
       * De paso cubre el caso límite: si no hubiera nadie al aire, la lista
       * viene vacía y el bucle no itera.
       */
      const quieto = await productoDe(100_000);

      const r = await call('GET', '/api/v1/discover/products?enVivo=true&limit=50');
      expect(r.status).toBe(200);

      const ids = (r.body.items as { id: string }[]).map((p) => p.id);
      expect(ids).not.toContain(quieto.id);

      // Y cada uno de los que sí salieron tiene a su vendedor transmitiendo.
      for (const item of r.body.items as { store: { seller: { id: string } } }[]) {
        const alAire = await prisma.liveSession.count({
          where: { sellerId: item.store.seller.id, state: { in: ['LIVE', 'RECONNECTING'] } },
        });
        expect(alAire, `el vendedor ${item.store.seller.id} no está en vivo`).toBeGreaterThan(0);
      }
    });

    it('sólo trae productos de quien está al aire', async () => {
      const enVivo = await productoDe(100_000);
      const quieto = await productoDe(100_000);

      // Se pone al aire directo en la base: lo que se prueba es el filtro, no
      // el flujo de LiveKit.
      const tienda = await prisma.store.findFirstOrThrow({
        where: { id: enVivo.storeId as string },
      });
      await prisma.liveSession.create({
        data: {
          id: `liv_filtro${Date.now().toString(36)}`,
          sellerId: tienda.sellerId,
          storeId: tienda.id,
          title: 'Al aire',
          roomName: `room-filtro-${Date.now()}`,
          state: 'LIVE',
          startedAt: new Date(),
        },
      });

      const r = await call('GET', '/api/v1/discover/products?enVivo=true&limit=50');
      const ids = (r.body.items as { id: string }[]).map((p) => p.id);
      expect(ids).toContain(enVivo.id);
      expect(ids).not.toContain(quieto.id);
    });
  });

  describe('Orden', () => {
    it('precio de menor a mayor', async () => {
      await productoDe(900_000);
      await productoDe(100_000);

      const r = await call('GET', '/api/v1/discover/products?orden=precio_asc&limit=50');
      const precios = (r.body.items as { basePriceCents: number }[]).map((p) => p.basePriceCents);

      const ordenados = [...precios].sort((a, b) => a - b);
      expect(precios).toEqual(ordenados);
    });

    it('⛔ un orden explícito NO lo reordena el ranking después', async () => {
      /**
       * El ranking del feed reordena la página por frescura, likes y si el
       * vendedor está en vivo. Aplicarlo encima de «precio: menor a mayor»
       * sería ignorar lo que la persona pidió.
       */
      await productoDe(800_000);
      await productoDe(200_000);
      await productoDe(500_000);

      const r = await call('GET', '/api/v1/discover/products?orden=precio_asc&limit=50');
      const precios = (r.body.items as { basePriceCents: number }[]).map((p) => p.basePriceCents);
      expect(precios).toEqual([...precios].sort((a, b) => a - b));
    });

    it('sin orden explícito, el ranking sigue mandando', async () => {
      // El comportamiento de siempre no cambió.
      const r = await call('GET', '/api/v1/discover/products?limit=50');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.items)).toBe(true);
    });
  });

  it('los filtros se combinan', async () => {
    const objetivo = await productoDe(300_000, { categoryId: 'cat_calzado' });
    await productoDe(300_000, { categoryId: 'cat_hogar' });
    await productoDe(9_000_000, { categoryId: 'cat_calzado' });

    const r = await call(
      'GET',
      '/api/v1/discover/products?categoria=cat_calzado&precioMax=500000&limit=50',
    );
    const ids = (r.body.items as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(objetivo.id);
    expect(ids).toHaveLength(1);
  });
});

describe('Enlaces compartidos', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ESTOS ENLACES DABAN 404
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `compartir.ts` viene generando `vendox.com.ar/p/…` desde hace meses, y su
   * propio comentario avisaba que la página no existía. Cada producto
   * compartido por WhatsApp llevaba a una pantalla de error — y compartir es
   * justamente cómo llega gente que todavía no tiene la app.
   */

  /** Un producto publicado, con stock y su vendedor. */
  async function productoCompartible(stock = 3) {
    const v = await nuevoVendedor();
    const p = await crearProducto(v.token, { status: 'ACTIVE', categoryId: 'cat_otros' });
    await prisma.inventory.update({
      where: { productVariantId: p.variants[0].id as string },
      data: { onHand: stock },
    });
    return { productId: p.id as string, sellerToken: v.token, sellerId: v.seller.id as string };
  }

  it('⛔ el enlace que genera compartir ABRE una página', async () => {
    /**
     * Se toma la URL del endpoint de compartir y se pide esa misma ruta. Es el
     * test que ata las dos mitades: si mañana cambia el formato en
     * `compartir.ts` y la ruta no, esto falla.
     */
    const { productId } = await productoCompartible(3);
    const persona = await nuevoUsuario();

    const enlace = await call('GET', `/api/v1/share/product/${productId}`, {
      token: persona.token,
    });
    expect(enlace.status).toBe(200);

    const ruta = new URL(enlace.body.url as string).pathname;
    const pagina = await llamarCrudo('GET', ruta);

    expect(pagina.status, `la ruta ${ruta} no responde`).toBe(200);
  });

  it('la página de un producto trae las etiquetas de previsualización', async () => {
    const { productId } = await productoCompartible(3);

    const r = await llamarCrudo('GET', `/p/${productId}`);
    expect(r.status).toBe(200);

    const html = r.body;
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:url"');
    expect(html).toContain('VendoX');
  });

  it('⛔ un producto pausado NO tiene página', async () => {
    /**
     * Reutiliza `PRODUCTO_COMPRABLE`, el mismo filtro del feed. Si la página
     * tuviera su propio criterio, una sanción de moderación se podría esquivar
     * compartiendo el enlace.
     */
    const { productId, sellerToken } = await productoCompartible(1);

    await call('PATCH', `/api/v1/products/${productId}`, {
      token: sellerToken,
      body: { status: 'PAUSED' },
    });

    const r = await llamarCrudo('GET', `/p/${productId}`);
    expect(r.status).toBe(404);
    expect(r.body).toContain('ya no está disponible');
  });

  it('⛔ y la página de «ya no está» no dice por qué', async () => {
    // «Este producto fue despublicado» filtra una decisión del vendedor a
    // cualquiera que tenga el enlace.
    const r = await llamarCrudo('GET', '/p/prd_no_existe');
    expect(r.status).toBe(404);

    const html = (r.body).toLowerCase();
    for (const filtracion of ['despublicado', 'suspendido', 'moderación']) {
      expect(html).not.toContain(filtracion);
    }
  });

  it('⛔ la página NO muestra el stock exacto', async () => {
    /**
     * Es la misma regla que el feed: publicar el stock de cada variante le
     * regala a la competencia el ritmo de ventas de un vendedor. En una página
     * pública sin sesión sería todavía más fácil de raspar.
     */
    const { productId } = await productoCompartible(7);

    const html = (await llamarCrudo('GET', `/p/${productId}`)).body;
    expect(html).toContain('Disponible');
    expect(html).not.toContain('7 unidades');
    expect(html).not.toMatch(/quedan\s*7/i);
  });

  it('un vivo al aire se anuncia como tal', async () => {
    const v = await productoCompartible(1);
    const tienda = await prisma.store.findFirstOrThrow({ where: { sellerId: v.sellerId } });

    const vivo = await prisma.liveSession.create({
      data: {
        id: `liv_land${Date.now().toString(36)}`,
        sellerId: v.sellerId,
        storeId: tienda.id,
        title: 'Vendiendo ahora',
        roomName: `room-land-${Date.now()}`,
        state: 'LIVE',
        startedAt: new Date(),
      },
    });

    const html = (await llamarCrudo('GET', `/v/${vivo.id}`)).body;
    expect(html).toContain('EN VIVO AHORA');
    expect(html).toContain('Vendiendo ahora');
  });

  it('⛔ no se indexa en buscadores', async () => {
    /**
     * Estas páginas existen para que un enlace compartido se abra, no para
     * posicionar. Dejarlas indexar llenaría Google de productos agotados y
     * vivos terminados con el nombre de VendoX al lado.
     */
    const { productId } = await productoCompartible(1);
    const r = await llamarCrudo('GET', `/p/${productId}`);
    expect(r.headers['x-robots-tag']).toContain('noindex');
  });

  it('el HTML se sirve como HTML, no como JSON', async () => {
    // Sin el content-type correcto, el navegador muestra el código fuente.
    const { productId } = await productoCompartible(1);
    const r = await llamarCrudo('GET', `/p/${productId}`);
    expect(r.headers['content-type']).toContain('text/html');
  });

  it('⛔ assetlinks está vacío hasta que exista la clave de firma', async () => {
    /**
     * Devolver una huella inventada sería peor que no devolver nada: Android
     * la compara con la real y falla en silencio, y quien depure eso va a
     * mirar el manifiesto durante horas antes de sospechar de un JSON.
     *
     * Con la lista vacía, los enlaces abren la página web. Está incompleto, no
     * roto.
     */
    const r = await call('GET', '/.well-known/assetlinks.json');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
  /**
   * La huella real de Play App Signing. Es pública: el archivo que la publica
   * lo es por diseño, y Google la muestra en la consola de cualquiera que
   * tenga acceso a la ficha.
   */
  const HUELLA_DE_PLAY =
    '66:03:89:1D:04:BB:9C:C1:9A:4D:84:89:31:1A:4E:3A:B3:D4:43:90:ED:11:B8:CE:DA:51:DB:00:21:48:8B:2F';

  /** Corre algo con las huellas puestas y las devuelve a como estaban. */
  async function conHuellas<T>(valor: string, fn: () => Promise<T>): Promise<T> {
    const { env } = await import('@/config/env.schema');
    const antes = env.ANDROID_CERT_SHA256;
    (env as { ANDROID_CERT_SHA256?: string }).ANDROID_CERT_SHA256 = valor;
    try {
      return await fn();
    } finally {
      (env as { ANDROID_CERT_SHA256?: string }).ANDROID_CERT_SHA256 = antes;
    }
  }

  it('con la huella de Play, el archivo tiene la forma que Android espera', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ANDROID NO PERDONA UNA COMA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Este JSON lo lee un verificador que no reporta nada: si la relación está
     * mal escrita, si el namespace no es `android_app`, o si el package no
     * coincide con el del manifiesto, la verificación falla y el enlace abre el
     * navegador. Sin error en ningún lado.
     *
     * Por eso el test comprueba la forma entera y no sólo que la huella esté.
     */
    const r = await conHuellas(HUELLA_DE_PLAY, () =>
      call('GET', '/.well-known/assetlinks.json'),
    );

    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.vendox.app',
          sha256_cert_fingerprints: [HUELLA_DE_PLAY],
        },
      },
    ]);
  });

  it('⛔ el package del archivo es el del manifiesto', async () => {
    /**
     * Si no coinciden, Android descarta la entrada entera. Es un error de una
     * sola letra que cuesta una tarde: el archivo se ve perfecto y no funciona.
     */
    const r = await conHuellas(HUELLA_DE_PLAY, () =>
      call('GET', '/.well-known/assetlinks.json'),
    );

    const entrada = (r.body as Array<{ target: { package_name: string } }>)[0]!;
    expect(entrada.target.package_name).toBe('com.vendox.app');
  });

  it('las DOS huellas conviven: la de Play y la de la clave de subida', async () => {
    /**
     * Es el estado final. Con una sola, los enlaces funcionan en un teléfono y
     * en el resto no — y cuál de los dos depende de con qué clave se firmó lo
     * que tenés instalado, que es lo más confuso posible de depurar.
     *
     * La segunda de este test es ficticia y se nota que lo es: sirve para
     * probar que la lista admite dos, no para configurar nada.
     */
    const segunda = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:'
      + '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';

    const r = await conHuellas(`${HUELLA_DE_PLAY},${segunda}`, () =>
      call('GET', '/.well-known/assetlinks.json'),
    );

    const entrada = (r.body as Array<{ target: { sha256_cert_fingerprints: string[] } }>)[0]!;
    expect(entrada.target.sha256_cert_fingerprints).toEqual([HUELLA_DE_PLAY, segunda]);
  });

  it('⛔ una sola entrada, con las huellas adentro', async () => {
    /**
     * No dos objetos con un package repetido. Android acepta las dos formas,
     * pero la duplicada hace que agregar una tercera huella sea copiar y pegar
     * un bloque — y ahí es donde alguien cambia el package de uno solo.
     */
    const segunda = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:'
      + '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';

    const r = await conHuellas(`${HUELLA_DE_PLAY},${segunda}`, () =>
      call('GET', '/.well-known/assetlinks.json'),
    );

    expect(r.body).toHaveLength(1);
  });

});

describe('Promociones pagas', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PAGAR COMPRA UN LUGAR, NO PUNTOS — Y NO TOCA LA REPUTACIÓN
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Un producto promocionado ocupa una posición reservada del feed, etiquetada
   * como tal. No recibe puntaje, no sube estrellas, no verifica a nadie.
   */


  /** Un vendedor con créditos y un producto publicado. */
  async function vendedorConCreditos(creditos = 10) {
    const v = await nuevoVendedorConProducto();
    const admin = await nuevoAdmin();

    // Con cero no se otorga nada: el endpoint exige una cantidad positiva
    // —un movimiento de cero ensucia el libro mayor sin decir nada—.
    if (creditos > 0) {
      const r = await call('POST', `/api/v1/admin/sellers/${v.sellerId}/promotion-credits`, {
        token: admin.token,
        body: { cantidad: creditos, reason: 'créditos de bienvenida del beta cerrado' },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }

    return { ...v, admin };
  }

  it('el saldo sale del libro mayor', async () => {
    // No hay una columna `creditos` en `Seller`: el saldo es la suma de los
    // movimientos, y por eso siempre se puede reconstruir.
    const v = await vendedorConCreditos(10);

    const panel = await call('GET', '/api/v1/seller/promotions', { token: v.token });

    expect(panel.status, JSON.stringify(panel.body)).toBe(200);
    expect(panel.body.saldoEnCreditos).toBe(10);
  });

  it('comprar descuenta los créditos y deja la promoción corriendo', async () => {
    const v = await vendedorConCreditos(10);

    const r = await call('POST', '/api/v1/seller/promotions', {
      token: v.token,
      body: { tipo: 'PRODUCTO_EN_FEED', targetId: v.productId, horas: 24 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const panel = await call('GET', '/api/v1/seller/promotions', { token: v.token });
    expect(panel.body.saldoEnCreditos).toBe(10 - (r.body.creditos as number));
    expect(panel.body.promociones[0].corriendo).toBe(true);
  });

  it('⛔ sin créditos suficientes NO se compra', async () => {
    const v = await vendedorConCreditos(0);

    const r = await call('POST', '/api/v1/seller/promotions', {
      token: v.token,
      body: { tipo: 'PRODUCTO_EN_FEED', targetId: v.productId, horas: 168 },
    });

    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('NOT_ENOUGH_CREDITS');
  });

  it('⛔ no se puede promocionar el producto de OTRO', async () => {
    /**
     * Le daría visibilidad a alguien que no la pidió y le cobraría los créditos
     * a quien no corresponde. La pertenencia va en el `where`: 404, no 403.
     */
    const mio = await vendedorConCreditos(10);
    const ajeno = await nuevoVendedorConProducto();

    const r = await call('POST', '/api/v1/seller/promotions', {
      token: mio.token,
      body: { tipo: 'PRODUCTO_EN_FEED', targetId: ajeno.productId, horas: 24 },
    });

    expect(r.status).toBe(404);
  });

  it('⛔ tampoco un producto pausado', async () => {
    // Promocionar algo que no se puede comprar es cobrarle al vendedor por
    // mandar gente a una pantalla sin botón.
    const v = await vendedorConCreditos(10);
    await prisma.product.update({ where: { id: v.productId }, data: { status: 'PAUSED' } });

    const r = await call('POST', '/api/v1/seller/promotions', {
      token: v.token,
      body: { tipo: 'PRODUCTO_EN_FEED', targetId: v.productId, horas: 24 },
    });

    expect(r.status).toBe(404);
  });

  it('⛔ una duración inventada se rechaza', async () => {
    const v = await vendedorConCreditos(10);

    const r = await call('POST', '/api/v1/seller/promotions', {
      token: v.token,
      body: { tipo: 'PRODUCTO_EN_FEED', targetId: v.productId, horas: 5 },
    });

    expect(r.status).toBe(400);
  });

  it('⛔ otorgar créditos NO toca la reputación ni la verificación', async () => {
    /**
     * EL TEST QUE IMPORTA.
     *
     * Pagar por exposición no puede comprar confianza. Ni estrellas, ni
     * cumplimiento, ni el sello de identidad.
     */
    const v = await nuevoVendedorConProducto();
    const admin = await nuevoAdmin();
    const antes = await prisma.seller.findUniqueOrThrow({ where: { id: v.sellerId } });

    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/promotion-credits`, {
      token: admin.token,
      body: { cantidad: 50, reason: 'acuerdo comercial con la marca' },
    });
    await call('POST', '/api/v1/seller/promotions', {
      token: v.token,
      body: { tipo: 'PRODUCTO_EN_FEED', targetId: v.productId, horas: 168 },
    });

    const despues = await prisma.seller.findUniqueOrThrow({ where: { id: v.sellerId } });
    expect(despues.ratingSum).toBe(antes.ratingSum);
    expect(despues.ratingCount).toBe(antes.ratingCount);
    expect(despues.salesCount).toBe(antes.salesCount);
    expect(despues.verificationStatus).toBe(antes.verificationStatus);
    expect(despues.riskLevel).toBe(antes.riskLevel);
  });

  it('cancelar la saca del feed y NO devuelve créditos', async () => {
    /**
     * Ya se mostró. Devolver el total sería regalar la exposición que ya tuvo;
     * devolver una parte proporcional sería inventar una cuenta que nadie
     * pactó.
     */
    const v = await vendedorConCreditos(10);

    const compra = await call('POST', '/api/v1/seller/promotions', {
      token: v.token,
      body: { tipo: 'PRODUCTO_EN_FEED', targetId: v.productId, horas: 24 },
    });
    const saldoDespuesDeComprar = 10 - (compra.body.creditos as number);

    const r = await call('DELETE', `/api/v1/seller/promotions/${compra.body.id}`, {
      token: v.token,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const panel = await call('GET', '/api/v1/seller/promotions', { token: v.token });
    expect(panel.body.saldoEnCreditos).toBe(saldoDespuesDeComprar);
    expect(panel.body.promociones[0].corriendo).toBe(false);
  });

  it('⛔ no se puede cancelar la promoción de otro', async () => {
    const mio = await vendedorConCreditos(10);
    const ajeno = await vendedorConCreditos(10);

    const compra = await call('POST', '/api/v1/seller/promotions', {
      token: ajeno.token,
      body: { tipo: 'PRODUCTO_EN_FEED', targetId: ajeno.productId, horas: 24 },
    });

    const r = await call('DELETE', `/api/v1/seller/promotions/${compra.body.id}`, {
      token: mio.token,
    });

    expect(r.status).toBe(404);
  });

  it('los costos viajan en CRÉDITOS, sin ningún precio en pesos', async () => {
    /**
     * Cuánto sale un crédito es una decisión comercial que todavía no está
     * tomada y que va a cambiar con la inflación varias veces por año. Un
     * precio en la respuesta sería un número que la app muestra viejo.
     */
    const v = await vendedorConCreditos(1);

    const r = await call('GET', '/api/v1/seller/promotions/options', { token: v.token });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.duracionesEnHoras).toEqual([24, 72, 168]);
    expect(JSON.stringify(r.body)).not.toMatch(/pesos|ARS|precio/i);
  });

  it('⛔ queda en la bitácora, con el motivo', async () => {
    // Es la función que regala exposición: sin registro, un crédito de
    // cortesía es indistinguible de uno puesto por error.
    const v = await nuevoVendedorConProducto();
    const admin = await nuevoAdmin();

    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/promotion-credits`, {
      token: admin.token,
      body: { cantidad: 25, reason: 'compensación por la caída del sábado' },
    });

    const registro = await prisma.auditLog.findFirst({
      where: { action: 'promotion.credits_granted', entityId: v.sellerId },
      orderBy: { createdAt: 'desc' },
    });

    expect(registro).not.toBeNull();
    expect(registro?.actorId).toBe(admin.userId);
    expect(JSON.stringify(registro?.after)).toContain('sábado');
  });

  describe('En el feed', () => {
    /**
     * ⚠️ Se limpian las promociones antes de cada test de este bloque.
     *
     * No es higiene decorativa: sólo hay TRES posiciones promocionadas por
     * página, y las ocupan las promociones compradas primero. Con las que
     * dejaron los tests de arriba corriendo, la de este test nunca entra y el
     * resultado depende del orden en que vitest ejecute los casos.
     */
    beforeEach(async () => {
      await prisma.promotion.deleteMany({});
    });
    it('lo promocionado sale ETIQUETADO', async () => {
      /**
       * Sin la etiqueta no hay forma de distinguir publicidad de resultado, que
       * es lo que la ley de defensa del consumidor exige poder hacer.
       */
      const v = await vendedorConCreditos(10);

      /**
       * ⚠️ Se lo envejece y se pide UNA sola tarjeta.
       *
       * Es el caso real de una promoción: un producto viejo que paga para
       * volver a verse. Sin este montaje el test no probaría nada — un producto
       * recién creado ya sale primero por frescura, y el módulo lo descarta
       * como promocionado justamente para no mostrarlo dos veces en pantalla.
       */
      await prisma.product.update({
        where: { id: v.productId },
        data: { createdAt: new Date('2020-01-01T00:00:00.000Z') },
      });

      // Algo más nuevo que ocupe el lugar orgánico.
      const otro = await nuevoVendedorConProducto();
      expect(otro.productId).not.toBe(v.productId);

      await call('POST', '/api/v1/seller/promotions', {
        token: v.token,
        body: { tipo: 'PRODUCTO_EN_FEED', targetId: v.productId, horas: 24 },
      });

      const comprador = await nuevoUsuario();
      const feed = await call('GET', '/api/v1/discover/products?limit=1', {
        token: comprador.token,
      });

      expect(feed.status, JSON.stringify(feed.body)).toBe(200);
      const items = feed.body.items as Array<{ id: string; promocionado: boolean }>;

      const promocionados = items.filter((i) => i.promocionado);
      expect(promocionados.map((i) => i.id)).toEqual([v.productId]);

      // Y lo orgánico sigue ahí, sin etiqueta.
      expect(items.find((i) => i.id === otro.productId)?.promocionado).toBe(false);
    });
    it('⛔ sin promociones, TODO sale sin etiqueta', async () => {
      // El caso normal. Una etiqueta de más sobre algo orgánico sería una
      // mentira igual de grave que una de menos sobre algo pago.
      const comprador = await nuevoUsuario();
      const feed = await call('GET', '/api/v1/discover/products?limit=20&orden=nuevos', {
        token: comprador.token,
      });

      expect(feed.status).toBe(200);
      // Con un orden explícito el feed no intercala nada: quien pidió «nuevos»
      // quiere eso.
      const items = feed.body.items as Array<{ promocionado?: boolean }>;
      expect(items.every((i) => i.promocionado !== true)).toBe(true);
    });

    it('⛔ una promoción cancelada desaparece del feed', async () => {
      const v = await vendedorConCreditos(10);
      const compra = await call('POST', '/api/v1/seller/promotions', {
        token: v.token,
        body: { tipo: 'PRODUCTO_EN_FEED', targetId: v.productId, horas: 24 },
      });
      await call('DELETE', `/api/v1/seller/promotions/${compra.body.id}`, { token: v.token });

      const comprador = await nuevoUsuario();
      const feed = await call('GET', '/api/v1/discover/products?limit=20', { token: comprador.token });

      const items = feed.body.items as Array<{ id: string; promocionado: boolean }>;
      const suyo = items.find((i) => i.id === v.productId);
      expect(suyo?.promocionado ?? false).toBe(false);
    });
  });
});

describe('El embudo del vendedor', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * TODA CIFRA VIENE DE UNA FILA QUE EXISTE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Ninguno de estos números se estima. Y cuando no alcanzan para decir algo,
   * la respuesta dice `null` en vez de cero: un cero se lee como «te fue mal»
   * y un `null` se puede mostrar como «todavía no sabemos».
   */

  async function vendedorPro() {
    const v = await nuevoVendedorConProducto();

    await prisma.sellerMembership.create({
      data: {
        id: `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        sellerId: v.sellerId,
        plan: 'PRO',
        periodo: 'MENSUAL',
        origen: 'CORTESIA',
        vigenteHasta: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    return v;
  }

  it('⛔ un vendedor Free NO ve el embudo', async () => {
    // Ver sus ventas siempre fue gratis. Lo que compra Pro es entender POR QUÉ
    // no vende más.
    const v = await nuevoVendedorConProducto();

    const r = await call('GET', '/api/v1/seller/analytics/funnel', { token: v.token });

    expect(r.status, JSON.stringify(r.body)).toBe(402);
    expect(r.body.error.code).toBe('PRO_REQUIRED');
  });

  it('⛔ un Pro VENCIDO tampoco', async () => {
    const v = await vendedorPro();
    await prisma.sellerMembership.update({
      where: { sellerId: v.sellerId },
      data: { vigenteHasta: new Date(Date.now() - 60_000) },
    });

    const r = await call('GET', '/api/v1/seller/analytics/funnel', { token: v.token });
    expect(r.status).toBe(402);
  });

  it('cuenta los cuatro escalones de sus tablas', async () => {
    const v = await vendedorPro();

    // Tres personas distintas lo miran. La restricción única de
    // `RecentlyViewed` es por (persona, producto): son tres filas.
    for (let i = 0; i < 3; i += 1) {
      const curioso = await nuevoUsuario();
      await prisma.recentlyViewed.create({
        data: {
          id: `vst_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          userId: curioso.userId,
          targetType: 'PRODUCT',
          targetId: v.productId,
        },
      });
    }

    const r = await call('GET', '/api/v1/seller/analytics/funnel', { token: v.token });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.embudo.interesados).toBe(3);
    expect(r.body.embudo.vendidos).toBe(0);
  });

  it('⛔ la misma persona mirando diez veces cuenta UNA', async () => {
    /**
     * EL TEST QUE JUSTIFICA EL NOMBRE.
     *
     * El escalón se llama «personas que lo miraron» y no «visitas» porque es
     * exactamente eso. Si lo llamáramos visitas, el vendedor lo compararía con
     * las visitas de otra plataforma y sacaría conclusiones sobre una cifra
     * que mide otra cosa.
     */
    const v = await vendedorPro();
    const curioso = await nuevoUsuario();

    for (let i = 0; i < 10; i += 1) {
      await prisma.recentlyViewed.upsert({
        where: {
          userId_targetType_targetId: {
            userId: curioso.userId,
            targetType: 'PRODUCT',
            targetId: v.productId,
          },
        },
        create: {
          id: `vst_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          userId: curioso.userId,
          targetType: 'PRODUCT',
          targetId: v.productId,
        },
        update: { viewedAt: new Date() },
      });
    }

    const r = await call('GET', '/api/v1/seller/analytics/funnel', { token: v.token });
    expect(r.body.embudo.interesados).toBe(1);
  });

  it('⛔ un carrito abandonado NO cuenta como venta', async () => {
    /**
     * EL TEST QUE PROTEGE EL ÚLTIMO ESCALÓN.
     *
     * Una orden creada y nunca pagada es exactamente lo contrario de una venta:
     * es alguien que llegó hasta el final y se fue. Contarla inflaría el número
     * justo donde el vendedor busca la verdad, y le haría creer que su problema
     * está antes cuando está ahí.
     *
     * La orden se inserta directamente porque el flujo de compra completo vive
     * en `orders-flow.spec.ts`; acá lo único que importa es su estado.
     */
    const v = await vendedorPro();
    const comprador = await nuevoUsuario();
    const producto = await prisma.product.findUniqueOrThrow({
      where: { id: v.productId },
      select: { storeId: true, variants: { select: { id: true }, take: 1 } },
    });

    const sufijo = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await prisma.order.create({
      data: {
        id: `ord_${sufijo}`,
        reference: `REF${sufijo.slice(-8).toUpperCase()}`,
        buyerId: comprador.userId,
        storeId: producto.storeId,
        sellerId: v.sellerId,
        reservationId: `rsv_${sufijo}`,
        // Nunca se pagó.
        status: 'PENDING_PAYMENT',
        itemsSubtotal: 100_000,
        grossAmount: 100_000,
        platformFeeBps: 600,
        platformFeeAmount: 6_000,
        sellerNetAmount: 94_000,
        shippingAddress: {},
        buyerSnapshot: {},
        items: {
          create: [
            {
              id: `oit_${sufijo}`,
              productId: v.productId,
              productVariantId: producto.variants[0]!.id,
              productNameSnapshot: 'Producto',
              variantLabelSnapshot: 'Default',
              quantity: 1,
              unitPrice: 100_000,
              subtotal: 100_000,
            },
          ],
        },
      },
    });

    const r = await call('GET', '/api/v1/seller/analytics/funnel', { token: v.token });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.embudo.vendidos).toBe(0);
  });

  it('⛔ con pocos datos NO devuelve un porcentaje', async () => {
    // «33 % de conversión» con tres personas es una anécdota disfrazada de
    // métrica: una venta más y salta a 66 %.
    const v = await vendedorPro();

    const r = await call('GET', '/api/v1/seller/analytics/funnel', { token: v.token });

    expect(r.body.tasas.conversion).toBeNull();
    expect(r.body.dondeSePierde).toBeNull();
  });

  it('dice en cuántos días se contaron los interesados', async () => {
    /**
     * «120 personas lo miraron» sin decir en cuánto tiempo no significa nada, y
     * el vendedor lo lee como «desde siempre». Son 30 días porque es lo que
     * conserva la tabla.
     */
    const v = await vendedorPro();

    const r = await call('GET', '/api/v1/seller/analytics/funnel', { token: v.token });

    expect(r.body.ventanaDeInteresadosEnDias).toBe(30);
  });

  it('un vendedor sin productos NO tiene un embudo en cero', async () => {
    /**
     * Es distinto de «te fue mal»: es que todavía no publicó nada. Mostrarle
     * cuatro ceros sería inventar un diagnóstico sobre algo que no existe.
     */
    const u = await nuevoUsuario();
    const seller = await call('POST', '/api/v1/sellers', {
      token: u.token,
      body: { displayName: `Sin productos ${u.userId.slice(-6)}` },
    });
    await prisma.sellerMembership.create({
      data: {
        id: `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        sellerId: seller.body.seller.id as string,
        plan: 'PRO',
        periodo: 'MENSUAL',
        origen: 'CORTESIA',
        vigenteHasta: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const r = await call('GET', '/api/v1/seller/analytics/funnel', { token: u.token });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sinProductos).toBe(true);
    expect(r.body.embudo).toBeNull();
  });

  describe('Por producto', () => {
    it('⛔ el producto de OTRO no se encuentra', async () => {
      // La pertenencia va en el WHERE: 404, no 403. Las métricas de una tienda
      // son de las cosas más sensibles que tiene un vendedor.
      const mio = await vendedorPro();
      const ajeno = await nuevoVendedorConProducto();

      const r = await call('GET', `/api/v1/seller/analytics/funnel/${ajeno.productId}`, {
        token: mio.token,
      });

      expect(r.status).toBe(404);
    });

    it('devuelve el embudo de ese producto', async () => {
      const v = await vendedorPro();

      const r = await call('GET', `/api/v1/seller/analytics/funnel/${v.productId}`, {
        token: v.token,
      });

      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.productId).toBe(v.productId);
      expect(r.body.embudo).not.toBeNull();
    });
  });

  describe('Las tasas que la app necesita para estimar', () => {
    /**
     * La pantalla de políticas le muestra al vendedor cuánto va a ver quien
     * compre, y lo recalcula mientras mueve el monto del envío. Ese cálculo lo
     * hace la app, sin ir al servidor en cada tecla.
     *
     * Las OPERACIONES se copian —no hay forma de evitarlo— pero las TASAS no:
     * estaban escritas a mano en el Dart, 600 y 619, los mismos valores que hay
     * acá por omisión. Daban bien de casualidad. Mover
     * `VENDOX_PLATFORM_FEE_BPS` en el servidor dejaba al vendedor leyendo una
     * comisión que ya no era la suya, sin que nada fallara.
     *
     * Este test existe para que sacar los campos del payload rompa algo.
     */
    it('la política de envío incluye la comisión y el costo del procesador', async () => {
      const v = await nuevoVendedor();

      const r = await call('PATCH', `/api/v1/stores/${v.store.id}/shipping`, {
        token: v.token,
        body: { shippingMode: 'FREE', processorFeeMode: 'ABSORBED' },
      });

      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.comisionBps).toBe(env.VENDOX_PLATFORM_FEE_BPS);
      expect(r.body.costoDelProcesadorBps).toBe(env.PROCESSOR_FEE_ESTIMATE_BPS);
    });

    it('son números, no textos con el signo adentro', async () => {
      // La app divide por 100 y multiplica. Un "6 %" que llegue como texto se
      // convierte en NaN y el ejemplo muestra un guión donde va la plata.
      const v = await nuevoVendedor();

      const r = await call('PATCH', `/api/v1/stores/${v.store.id}/shipping`, {
        token: v.token,
        body: { shippingMode: 'FREE', processorFeeMode: 'ABSORBED' },
      });

      expect(Number.isInteger(r.body.comisionBps)).toBe(true);
      expect(Number.isInteger(r.body.costoDelProcesadorBps)).toBe(true);
    });
  });
});

/**
 * El límite de catálogo del plan Free.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTOS TESTS SON LA REGLA. LA APP SÓLO LA MUESTRA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Flutter va a esconder el botón al llegar al tope, y está bien. Pero esconder
 * un botón no es una restricción: `POST /products` es una petición HTTP que
 * cualquiera puede repetir. Todo lo que se prueba acá entra por HTTP, sin pasar
 * por la app, que es exactamente como entraría alguien que quiera saltearlo.
 */
async function darPlan(sellerId: string, plan: 'PRO' | 'BUSINESS') {
  await prisma.sellerMembership.create({
    data: {
      id: `mem_${sellerId.slice(-20)}`,
      sellerId,
      plan,
      periodo: 'MENSUAL',
      origen: 'CORTESIA',
      vigenteHasta: new Date(Date.now() + 30 * 86_400_000),
    },
  });
}

/** Publica sin exigir que salga bien: los tests del tope necesitan el rechazo. */
async function intentarPublicar(token: string, nombre: string) {
  return call('POST', '/api/v1/products', {
    token,
    body: {
      name: nombre,
      basePriceCents: 1_549_900,
      categoryId: 'cat_otros',
      status: 'ACTIVE',
    },
  });
}

describe('Límite de productos publicados (Free)', () => {
  it('un Free publica tres productos sin problema', async () => {
    const v = await nuevoVendedor();

    for (let i = 1; i <= 3; i += 1) {
      const r = await intentarPublicar(v.token, `Producto libre ${i}`);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });

  it('⛔ el cuarto se rechaza, con el mensaje que explica qué hacer', async () => {
    const v = await nuevoVendedor();
    for (let i = 1; i <= 3; i += 1) await intentarPublicar(v.token, `Producto tope ${i}`);

    const r = await intentarPublicar(v.token, 'Producto cuarto');

    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(r.body.error.message).toBe(
      'Llegaste al límite de 3 productos publicados del plan Free. ' +
        'Pasate a VendoX Pro para ampliar tu catálogo.',
    );
    expect(r.body.error.details.limite).toBe(3);
    expect(r.body.error.details.publicados).toBe(3);
  });

  /**
   * Los borradores son libres, y esa es la mitad del diseño.
   *
   * Alguien en Free tiene que poder sentarse una tarde a cargar cuarenta
   * productos con sus fotos y sus variantes, y decidir después cuáles tres
   * muestra. Si el tope contara lo cargado, la app le diría «borrá productos
   * para poder publicar» y el trabajo se perdería.
   */
  it('los borradores NO cuentan: puede cargar todos los que quiera', async () => {
    const v = await nuevoVendedor();
    for (let i = 1; i <= 3; i += 1) await intentarPublicar(v.token, `Publicado ${i}`);

    for (let i = 1; i <= 5; i += 1) {
      const r = await call('POST', '/api/v1/products', {
        token: v.token,
        body: { name: `Borrador ${i}`, basePriceCents: 100_000, status: 'DRAFT' },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });

  /**
   * Pausar tiene que liberar un lugar. Es la vía por la que un vendedor Free
   * rota su catálogo por temporada sin borrar nada.
   */
  it('pausar uno libera lugar para publicar otro', async () => {
    const v = await nuevoVendedor();
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const r = await intentarPublicar(v.token, `Rotación ${i}`);
      ids.push(r.body.id as string);
    }

    expect((await intentarPublicar(v.token, 'De más')).status).toBe(409);

    const pausa = await call('PATCH', `/api/v1/products/${ids[0]}`, {
      token: v.token,
      body: { status: 'PAUSED' },
    });
    expect(pausa.status, JSON.stringify(pausa.body)).toBe(200);

    expect((await intentarPublicar(v.token, 'Ahora sí')).status).toBe(201);
  });

  /**
   * EL CAMINO QUE SE ESCAPA SI SÓLO SE MIRA `create`.
   *
   * Crear borrador y después editarlo a publicado es el flujo NORMAL de la app
   * —se arma la ficha, se suben fotos, se publica al final—, no un truco. Sin
   * guardián en `update`, el tope se saltea en dos pasos sin proponérselo.
   */
  it('⛔ tampoco se puede pasar el tope publicando un borrador', async () => {
    const v = await nuevoVendedor();
    for (let i = 1; i <= 3; i += 1) await intentarPublicar(v.token, `Lleno ${i}`);

    const borrador = await call('POST', '/api/v1/products', {
      token: v.token,
      body: { name: 'Borrador que quiere colarse', basePriceCents: 100_000, status: 'DRAFT' },
    });
    expect(borrador.status).toBe(201);

    const r = await call('PATCH', `/api/v1/products/${borrador.body.id}`, {
      token: v.token,
      body: { status: 'ACTIVE', categoryId: 'cat_otros' },
    });

    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  /**
   * Editar un producto YA publicado no puede chocar contra el tope. Estando
   * lleno, corregir un precio mal puesto tiene que seguir funcionando: si no,
   * el vendedor Free queda con su catálogo congelado.
   */
  it('con el catálogo lleno se puede seguir editando lo publicado', async () => {
    const v = await nuevoVendedor();
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const r = await intentarPublicar(v.token, `Editable ${i}`);
      ids.push(r.body.id as string);
    }

    const r = await call('PATCH', `/api/v1/products/${ids[0]}`, {
      token: v.token,
      body: { basePriceCents: 999_900 },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.basePriceCents).toBe(999_900);
  });

  it('borrar uno libera lugar', async () => {
    const v = await nuevoVendedor();
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const r = await intentarPublicar(v.token, `Borrable ${i}`);
      ids.push(r.body.id as string);
    }

    expect((await call('DELETE', `/api/v1/products/${ids[0]}`, { token: v.token })).status).toBe(
      200,
    );

    expect((await intentarPublicar(v.token, 'Después de borrar')).status).toBe(201);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ESTE TEST EXISTE PORQUE EL DE ARRIBA NO ALCANZABA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * «Borrar uno libera lugar» pasaba aunque el conteo NO filtrara por
   * `deletedAt`. Se descubrió sacando ese filtro a propósito: los 215 tests
   * siguieron en verde.
   *
   * El motivo es que `softDelete` hace dos cosas —marca `deletedAt` y pasa el
   * estado a `ARCHIVED`—, así que el filtro de estado ya lo saca de la cuenta
   * por su lado. El test probaba la consecuencia, no la causa.
   *
   * Acá se arma la fila que hoy ningún camino produce: publicada y borrada a la
   * vez. Es lo único que ejercita el `deletedAt: null` de verdad, y protege al
   * vendedor del día que un camino nuevo borre sin archivar — donde el síntoma
   * sería que alguien no puede publicar nunca más y su catálogo se ve vacío.
   */
  it('⛔ un producto borrado pero todavía ACTIVE no ocupa lugar', async () => {
    const v = await nuevoVendedor();
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const r = await intentarPublicar(v.token, `Fantasma ${i}`);
      ids.push(r.body.id as string);
    }

    expect((await intentarPublicar(v.token, 'Bloqueado')).status).toBe(409);

    // Borrado sin archivar: sólo `deletedAt` puede sacarlo de la cuenta.
    await prisma.product.update({
      where: { id: ids[0] },
      data: { deletedAt: new Date() },
    });

    const lista = await call('GET', '/api/v1/products/mine', { token: v.token });
    expect(lista.body.catalogo.publicados).toBe(2);

    expect((await intentarPublicar(v.token, 'Ahora entra')).status).toBe(201);
  });

  it('⛔ el tope es del vendedor, no de cada uno de sus productos', async () => {
    // Dos vendedores distintos no comparten cupo: el de al lado publicando tres
    // no puede dejar sin publicar a nadie.
    const uno = await nuevoVendedor();
    const otro = await nuevoVendedor();
    for (let i = 1; i <= 3; i += 1) await intentarPublicar(uno.token, `Del uno ${i}`);

    expect((await intentarPublicar(otro.token, 'Del otro')).status).toBe(201);
  });
});

describe('Los planes pagos no tienen tope de catálogo', () => {
  it('un Pro publica más de tres', async () => {
    const v = await nuevoVendedor();
    await darPlan(v.seller.id as string, 'PRO');

    for (let i = 1; i <= 5; i += 1) {
      const r = await intentarPublicar(v.token, `Pro sin tope ${i}`);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });

  it('un Business también', async () => {
    const v = await nuevoVendedor();
    await darPlan(v.seller.id as string, 'BUSINESS');

    for (let i = 1; i <= 5; i += 1) {
      const r = await intentarPublicar(v.token, `Business sin tope ${i}`);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EL CASO QUE NO PUEDE DEGRADAR A NADIE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Un vendedor que ya tenía diez productos publicados cuando se introdujo el
   * límite los CONSERVA. El tope frena publicar uno más; no despublica nada, no
   * borra nada y no le pide que elija cuáles tres se queda.
   *
   * Es la diferencia entre una regla nueva y una expropiación.
   */
  it('⛔ un Free que ya tenía más de tres los conserva, sólo no puede publicar más', async () => {
    const v = await nuevoVendedor();
    await darPlan(v.seller.id as string, 'PRO');
    for (let i = 1; i <= 6; i += 1) await intentarPublicar(v.token, `Heredado ${i}`);

    // Se le vence el plan: pasa a Free con seis publicados.
    await prisma.sellerMembership.update({
      where: { sellerId: v.seller.id as string },
      data: { vigenteHasta: new Date(Date.now() - 86_400_000) },
    });

    const lista = await call('GET', '/api/v1/products/mine?limit=20', { token: v.token });
    expect(lista.body.items.filter((p: { status: string }) => p.status === 'ACTIVE')).toHaveLength(
      6,
    );

    // Los conserva, pero no puede sumar.
    const r = await intentarPublicar(v.token, 'El séptimo');
    expect(r.status).toBe(409);
    expect(r.body.error.details.publicados).toBe(6);
  });
});

describe('El contador que ve el vendedor', () => {
  it('un Free recién creado ve 0 de 3', async () => {
    const v = await nuevoVendedor();

    const r = await call('GET', '/api/v1/products/mine', { token: v.token });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.catalogo).toEqual({ publicados: 0, limite: 3, puedePublicar: true });
  });

  it('después de publicar dos, ve 2 de 3 y todavía puede', async () => {
    const v = await nuevoVendedor();
    await intentarPublicar(v.token, 'Contador uno');
    await intentarPublicar(v.token, 'Contador dos');

    const r = await call('GET', '/api/v1/products/mine', { token: v.token });

    expect(r.body.catalogo).toEqual({ publicados: 2, limite: 3, puedePublicar: true });
  });

  /**
   * `puedePublicar: false` es lo que la app usa para apagar el botón ANTES de
   * que alguien intente. Sin él, la única forma de saberlo sería chocar contra
   * el error — que funciona, pero es una mala manera de enterarse.
   */
  it('en el tope, puedePublicar pasa a false', async () => {
    const v = await nuevoVendedor();
    for (let i = 1; i <= 3; i += 1) await intentarPublicar(v.token, `Tope contador ${i}`);

    const r = await call('GET', '/api/v1/products/mine', { token: v.token });

    expect(r.body.catalogo).toEqual({ publicados: 3, limite: 3, puedePublicar: false });
  });

  /**
   * `limite: null` es lo que le dice a la app «no muestres contador». Un
   * «12 de ∞» no le sirve a nadie.
   */
  it('un Pro ve limite null y puede siempre', async () => {
    const v = await nuevoVendedor();
    await darPlan(v.seller.id as string, 'PRO');
    await intentarPublicar(v.token, 'Pro contador');

    const r = await call('GET', '/api/v1/products/mine', { token: v.token });

    expect(r.body.catalogo).toEqual({ publicados: 1, limite: null, puedePublicar: true });
  });

  it('los borradores no mueven el contador', async () => {
    const v = await nuevoVendedor();
    await intentarPublicar(v.token, 'El único publicado');
    await call('POST', '/api/v1/products', {
      token: v.token,
      body: { name: 'Un borrador', basePriceCents: 100_000, status: 'DRAFT' },
    });

    const r = await call('GET', '/api/v1/products/mine', { token: v.token });

    expect(r.body.catalogo.publicados).toBe(1);
  });
});

/**
 * Lo que la app necesita para explicar la comisión.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTE ES EL CONTRATO QUE FLUTTER CONSUME
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El editor de producto arma el desglose con `comisionBps` y escribe la línea
 * con `comision.etiqueta`. Si alguno de los dos desaparece o cambia de forma,
 * la app cae a su respaldo —la tasa base— y le muestra al vendedor Business un
 * número que no es el suyo, sin que nada falle.
 *
 * Ese es exactamente el modo de falla que estos tests existen para cortar: no
 * un error, sino un número equivocado en una pantalla que sigue funcionando.
 */
describe('La comisión que ve el vendedor', () => {
  async function conBusinessYVolumen(sellerId: string, storeId: string, userId: string, porSemana: number) {
    await prisma.sellerMembership.create({
      data: {
        id: `mem_${sellerId.slice(-20)}`,
        sellerId,
        plan: 'BUSINESS',
        periodo: 'MENSUAL',
        origen: 'CORTESIA',
        vigenteHasta: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    for (let semana = 0; semana < 4; semana += 1) {
      const sufijo = `tr${Math.random().toString(36).slice(2, 10)}`;
      const cuando = new Date(Date.now() - semana * 7 * 86_400_000 - 3_600_000);
      await prisma.order.create({
        data: {
          id: `ord_${sufijo}`,
          reference: `REF${sufijo.slice(-8).toUpperCase()}`,
          buyerId: userId,
          storeId,
          sellerId,
          reservationId: `rsv_${sufijo}`,
          status: 'DELIVERED',
          itemsSubtotal: porSemana,
          grossAmount: porSemana,
          platformFeeBps: 400,
          platformFeeAmount: 0,
          sellerNetAmount: porSemana,
          paidAt: cuando,
          confirmedAt: cuando,
          createdAt: cuando,
          shippingAddress: {},
          buyerSnapshot: {},
        },
      });
    }
  }

  it('un vendedor sin plan ve la tasa base y ningún aviso', async () => {
    const v = await nuevoVendedor();

    const r = await call('GET', '/api/v1/stores/me', { token: v.token });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.comisionBps).toBe(env.VENDOX_PLATFORM_FEE_BPS);
    expect(r.body.comision.etiqueta).toBe('Comisión VendoX (4%)');
    expect(r.body.comision.bajoPorVolumen).toBe(false);
    expect(r.body.comision.aviso).toBeNull();
  });

  /**
   * EL CASO QUE LE DA SENTIDO A TODO EL BLOQUE.
   *
   * El vendedor Business con volumen tiene que ver SU tasa, con su nombre y con
   * el aviso de por qué bajó. Un descuento que nadie ve no motiva a nadie.
   */
  it('un Business con volumen ve su tasa reducida y por qué', async () => {
    const v = await nuevoVendedor();
    await conBusinessYVolumen(
      v.seller.id as string,
      v.store.id as string,
      v.userId,
      300_000_000,
    );

    const r = await call('GET', '/api/v1/stores/me', { token: v.token });

    expect(r.body.comisionBps).toBe(350);
    expect(r.body.comision.etiqueta).toBe('Comisión VendoX Business (3,5%)');
    expect(r.body.comision.bajoPorVolumen).toBe(true);
    expect(r.body.comision.aviso).toBe('Tu comisión bajó por volumen de ventas.');
  });

  it('con $5.000.000 semanales la etiqueta dice 3%', async () => {
    const v = await nuevoVendedor();
    await conBusinessYVolumen(
      v.seller.id as string,
      v.store.id as string,
      v.userId,
      500_000_000,
    );

    const r = await call('GET', '/api/v1/stores/me', { token: v.token });

    expect(r.body.comisionBps).toBe(300);
    expect(r.body.comision.etiqueta).toBe('Comisión VendoX Business (3%)');
  });

  /**
   * ⛔ NO SE LE OCULTA POR QUÉ NO ACCEDIÓ.
   *
   * Un Business con volumen de sobra pero con devoluciones altas paga la base.
   * Callarlo sería lo peor de los dos mundos: paga más y no sabe que hay algo
   * que puede corregir.
   */
  it('⛔ con devoluciones altas se le explica por qué no accedió', async () => {
    const v = await nuevoVendedor();
    await conBusinessYVolumen(
      v.seller.id as string,
      v.store.id as string,
      v.userId,
      400_000_000,
    );

    // Se devuelve una de las cuatro: 25 %.
    const orden = await prisma.order.findFirstOrThrow({
      where: { sellerId: v.seller.id as string },
      orderBy: { createdAt: 'desc' },
    });
    const sufijo = `dv${Math.random().toString(36).slice(2, 10)}`;
    const intento = await prisma.paymentAttempt.create({
      data: {
        id: `pat_${sufijo}`,
        orderId: orden.id,
        status: 'APPROVED',
        amount: orden.grossAmount,
        idempotencyKey: `idem_${sufijo}`,
        providerPaymentId: `mp_${sufijo}`,
        approvedAt: new Date(),
      },
    });
    await prisma.refund.create({
      data: {
        id: `ref_${sufijo}`,
        orderId: orden.id,
        paymentAttemptId: intento.id,
        status: 'COMPLETED',
        amount: orden.grossAmount,
        reason: 'TEST',
        completedAt: new Date(),
      },
    });

    const r = await call('GET', '/api/v1/stores/me', { token: v.token });

    expect(r.body.comisionBps).toBe(env.VENDOX_PLATFORM_FEE_BPS);
    expect(r.body.comision.bajoPorVolumen).toBe(false);
    expect(r.body.comision.aviso).toContain('devoluciones');
    expect(r.body.comision.aviso).toContain('vuelve solo');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LA COMISIÓN DEL VENDEDOR NO ES DE LOS COMPRADORES
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Antes `comisionBps` salía también en la vidriera pública. Con una comisión
   * única era información sin dueño; con tramos por volumen pasa a decir qué
   * plan tiene cada vendedor y cuánto factura por semana.
   *
   * Un comprador que lee «3 %» puede deducir que esa tienda vende más de cinco
   * millones semanales. Eso no es de nadie más que del vendedor.
   */
  it('⛔ la vidriera pública NO expone la comisión del vendedor', async () => {
    const v = await nuevoVendedor();
    await conBusinessYVolumen(
      v.seller.id as string,
      v.store.id as string,
      v.userId,
      500_000_000,
    );

    const publica = await call('GET', `/api/v1/stores/by-slug/${v.store.slug}`);

    expect(publica.status, JSON.stringify(publica.body)).toBe(200);
    expect(publica.body.envio).toBeDefined();
    expect(publica.body.envio.comisionBps).toBeUndefined();
    expect(publica.body.envio.comision).toBeUndefined();
    // Y ni siquiera aparece el número en la respuesta serializada.
    expect(JSON.stringify(publica.body)).not.toContain('comisionBps');
  });

  it('la política de envío del vendedor sí la trae', async () => {
    const v = await nuevoVendedor();
    await conBusinessYVolumen(
      v.seller.id as string,
      v.store.id as string,
      v.userId,
      500_000_000,
    );

    const r = await call('PATCH', `/api/v1/stores/${v.store.id}/shipping`, {
      token: v.token,
      body: { shippingMode: 'FREE', processorFeeMode: 'ABSORBED' },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.comisionBps).toBe(300);
    expect(r.body.comision.etiqueta).toBe('Comisión VendoX Business (3%)');
  });

  /**
   * El formato del porcentaje, que es lo que se lee en la pantalla.
   *
   * «4%» y no «4.00%». Un porcentaje redondo con dos decimales se lee como si
   * alguien hubiera dejado el número sin terminar de formatear.
   */
  it('el porcentaje se escribe a la argentina', async () => {
    const v = await nuevoVendedor();
    const base = await call('GET', '/api/v1/stores/me', { token: v.token });
    expect(base.body.comision.etiqueta).toContain('(4%)');
    expect(base.body.comision.etiqueta).not.toContain('4.00');

    const otro = await nuevoVendedor();
    await conBusinessYVolumen(
      otro.seller.id as string,
      otro.store.id as string,
      otro.userId,
      300_000_000,
    );
    const business = await call('GET', '/api/v1/stores/me', { token: otro.token });
    // Coma decimal, no punto.
    expect(business.body.comision.etiqueta).toContain('(3,5%)');
  });
});

/**
 * Un alta es un producto. Aunque se pida dos veces.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL CASO QUE NINGÚN BOTÓN DESHABILITADO CUBRE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El teléfono manda `POST /products`. El servidor lo crea. La respuesta se
 * pierde —un timeout, la red que cambia de celda, la app que pasa a segundo
 * plano—. Para el teléfono eso es indistinguible de «no llegó», así que
 * reintenta. Y aparece el segundo producto.
 *
 * Apagar el botón mientras viaja la petición no ayuda: el problema no es el
 * segundo toque, es el segundo VIAJE.
 */
describe('Alta de producto idempotente', () => {
  function clave() {
    return `prd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function crear(
    token: string,
    nombre: string,
    opciones: { clave?: string; status?: string } = {},
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opciones.clave) headers['idempotency-key'] = opciones.clave;

    const res = await (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/products',
        headers: { ...headers, authorization: `Bearer ${token}` },
        payload: {
          name: nombre,
          basePriceCents: 500_000,
          status: opciones.status ?? 'DRAFT',
          ...(opciones.status === 'ACTIVE' ? { categoryId: 'cat_otros' } : {}),
        },
      });

    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function cuantosProductos(storeId: string) {
    return prisma.product.count({ where: { storeId, deletedAt: null } });
  }

  it('crear una vez deja una fila', async () => {
    const v = await nuevoVendedor();
    const r = await crear(v.token, 'Producto único', { clave: clave() });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await cuantosProductos(v.store.id as string)).toBe(1);
  });

  /**
   * EL TEST DEL REINTENTO.
   *
   * Dos peticiones idénticas con la misma clave. La segunda tiene que devolver
   * el MISMO producto, no crear otro. Es exactamente lo que hace el teléfono
   * cuando no le llegó la respuesta.
   */
  it('⛔ reintentar con la misma clave devuelve el mismo producto', async () => {
    const v = await nuevoVendedor();
    const k = clave();

    const primera = await crear(v.token, 'Reintentado', { clave: k });
    const segunda = await crear(v.token, 'Reintentado', { clave: k });

    expect(primera.status).toBe(201);
    expect(segunda.body.id).toBe(primera.body.id);
    expect(await cuantosProductos(v.store.id as string)).toBe(1);
  });

  /**
   * EL DOBLE TOQUE REAL: las dos peticiones salen a la vez.
   *
   * El chequeo previo no alcanza —las dos leen «no hay nada» antes de que
   * ninguna escriba—. Lo que las ordena es el índice único, y la que pierde
   * relee y devuelve la que ganó.
   */
  it('⛔ dos altas simultáneas con la misma clave dejan UNA fila', async () => {
    const v = await nuevoVendedor();
    const k = clave();

    const [a, b] = await Promise.all([
      crear(v.token, 'Doble toque', { clave: k }),
      crear(v.token, 'Doble toque', { clave: k }),
    ]);

    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(a.body.id).toBe(b.body.id);
    expect(await cuantosProductos(v.store.id as string)).toBe(1);
  });

  /**
   * El reintento devuelve el producto que se creó, aunque el vendedor haya
   * cambiado algo en el medio.
   *
   * No se pierde nada: la app adopta el id que vuelve y el próximo guardado es
   * un `PATCH` que aplica los cambios nuevos. Converge.
   */
  it('con la misma clave y otro nombre, sigue siendo el mismo producto', async () => {
    const v = await nuevoVendedor();
    const k = clave();

    const primera = await crear(v.token, 'Nombre original', { clave: k });
    const segunda = await crear(v.token, 'Nombre cambiado', { clave: k });

    expect(segunda.body.id).toBe(primera.body.id);
    expect(segunda.body.name).toBe('Nombre original');
    expect(await cuantosProductos(v.store.id as string)).toBe(1);
  });

  it('claves distintas crean productos distintos', async () => {
    const v = await nuevoVendedor();

    const a = await crear(v.token, 'Uno', { clave: clave() });
    const b = await crear(v.token, 'Dos', { clave: clave() });

    expect(a.body.id).not.toBe(b.body.id);
    expect(await cuantosProductos(v.store.id as string)).toBe(2);
  });

  /**
   * La clave es POR TIENDA. Si el índice fuera global, dos vendedores que
   * generan la misma clave —son aleatorias, pero nada lo garantiza— harían que
   * el segundo recibiera el producto del primero.
   */
  it('⛔ la misma clave en dos tiendas NO comparte producto', async () => {
    const uno = await nuevoVendedor();
    const otro = await nuevoVendedor();
    const k = clave();

    const a = await crear(uno.token, 'De uno', { clave: k });
    const b = await crear(otro.token, 'Del otro', { clave: k });

    expect(a.body.id).not.toBe(b.body.id);
    expect(b.body.name).toBe('Del otro');
  });

  /**
   * Sin clave el alta funciona igual: una app vieja instalada en un teléfono no
   * se puede actualizar desde el servidor, y romperle el alta sería peor que
   * dejarla como estaba. Sigue pudiendo duplicar, y eso es sabido.
   */
  it('sin clave el alta sigue funcionando', async () => {
    const v = await nuevoVendedor();
    const r = await crear(v.token, 'Sin clave');

    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  /**
   * Una clave basura tiene que fallar en voz alta. Un cliente que mande
   * `"undefined"` como constante compartiría la misma clave entre todos sus
   * productos y recibiría siempre el primero — un bug mucho peor y mucho más
   * difícil de encontrar que un 400.
   */
  it('⛔ una clave demasiado corta se rechaza', async () => {
    const v = await nuevoVendedor();
    const r = await crear(v.token, 'Clave corta', { clave: 'x' });

    expect(r.status).toBe(400);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * DOS PRODUCTOS CON EL MISMO NOMBRE SON DOS PRODUCTOS
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Y está bien que así sea: un vendedor puede tener dos «Buzo negro» y no le
   * corresponde al sistema decidir que se equivocó. `slugDisponible` le busca
   * un slug libre al segundo y los dos conviven.
   *
   * Se deja escrito porque es justo lo que hace que los duplicados accidentales
   * NO se detecten solos: para la base son dos filas legítimas. La defensa
   * tiene que ser la clave de idempotencia, no el nombre.
   */
  it('dos altas con el mismo nombre y claves distintas son dos productos', async () => {
    const v = await nuevoVendedor();
    const primero = await crear(v.token, 'Mismo nombre', { clave: clave() });
    const segundo = await crear(v.token, 'Mismo nombre', { clave: clave() });

    expect(primero.status).toBe(201);
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(201);
    expect(segundo.body.id).not.toBe(primero.body.id);
    expect(segundo.body.slug).not.toBe(primero.body.slug);
    expect(await cuantosProductos(v.store.id as string)).toBe(2);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PUBLICAR UN BORRADOR CAMBIA EL ESTADO, NO CREA OTRO PRODUCTO
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Es el recorrido normal del editor: se guarda el borrador, se le suben
   * fotos, se publica al final. El id tiene que ser el mismo de punta a punta.
   */
  it('guardar borrador y publicar es el MISMO id', async () => {
    const v = await nuevoVendedor();
    const borrador = await crear(v.token, 'Borrador que se publica', { clave: clave() });
    const id = borrador.body.id as string;

    const publicado = await call('PATCH', `/api/v1/products/${id}`, {
      token: v.token,
      body: { status: 'ACTIVE', categoryId: 'cat_otros' },
    });

    expect(publicado.status, JSON.stringify(publicado.body)).toBe(200);
    expect(publicado.body.id).toBe(id);
    expect(publicado.body.status).toBe('ACTIVE');
    expect(await cuantosProductos(v.store.id as string)).toBe(1);
  });

  it('editar un publicado no crea otra fila', async () => {
    const v = await nuevoVendedor();
    const creado = await crear(v.token, 'Publicado editable', { clave: clave(), status: 'ACTIVE' });
    const id = creado.body.id as string;

    for (const precio of [600_000, 700_000, 800_000]) {
      const r = await call('PATCH', `/api/v1/products/${id}`, {
        token: v.token,
        body: { basePriceCents: precio },
      });
      expect(r.body.id).toBe(id);
    }

    expect(await cuantosProductos(v.store.id as string)).toBe(1);
  });
});

/**
 * El tope de Free bajo concurrencia.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * «CONTAR Y DESPUÉS ESCRIBIR» NO ES UNA REGLA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Con dos publicaciones simultáneas, las dos cuentan 2, las dos concluyen que
 * pueden, y quedan 4. El tope no se rompe por un descuido: se rompe porque la
 * comprobación y la escritura no son la misma operación.
 *
 * En el resto del sistema eso se resuelve con un UPDATE condicional atómico,
 * que acá no sirve: la condición no es sobre la fila que se escribe sino sobre
 * cuántas OTRAS filas cumplen algo, y no hay WHERE que exprese eso.
 *
 * Lo que lo resuelve es `pg_advisory_xact_lock` por vendedor, tomado DENTRO de
 * la transacción que después escribe.
 */
describe('Tope de Free bajo concurrencia', () => {
  async function publicarNuevo(token: string, nombre: string) {
    return call('POST', '/api/v1/products', {
      token,
      body: {
        name: nombre,
        basePriceCents: 500_000,
        categoryId: 'cat_otros',
        status: 'ACTIVE',
      },
    });
  }

  async function publicados(sellerId: string) {
    return prisma.product.count({
      where: { store: { sellerId }, status: 'ACTIVE', deletedAt: null },
    });
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EL TEST QUE PEDÍA LA AUDITORÍA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Free con 2 publicados dispara DOS publicaciones a la vez. Una tiene que
   * entrar y la otra tiene que rebotar. Jamás pueden quedar 4.
   */
  it('⛔ con 2 publicados, dos altas simultáneas dejan 3 — nunca 4', async () => {
    const v = await nuevoVendedor();
    const sellerId = v.seller.id as string;
    await publicarNuevo(v.token, 'Ocupa uno');
    await publicarNuevo(v.token, 'Ocupa dos');
    expect(await publicados(sellerId)).toBe(2);

    const [a, b] = await Promise.all([
      publicarNuevo(v.token, 'Carrera A'),
      publicarNuevo(v.token, 'Carrera B'),
    ]);

    const estados = [a.status, b.status].sort();
    expect(estados).toEqual([201, 409]);
    expect(await publicados(sellerId)).toBe(3);
  });

  /**
   * Y con más presión. Cuatro a la vez sobre un vendedor vacío: entran tres,
   * rebotan las demás.
   */
  it('⛔ cuatro altas simultáneas desde cero dejan exactamente 3', async () => {
    const v = await nuevoVendedor();
    const sellerId = v.seller.id as string;

    const rs = await Promise.all([
      publicarNuevo(v.token, 'Simultáneo 1'),
      publicarNuevo(v.token, 'Simultáneo 2'),
      publicarNuevo(v.token, 'Simultáneo 3'),
      publicarNuevo(v.token, 'Simultáneo 4'),
    ]);

    expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(1);
    expect(await publicados(sellerId)).toBe(3);
  });

  /**
   * El otro camino de publicación —editar un borrador a ACTIVE— tiene que
   * estar igual de protegido. Es el flujo normal de la app: se arma la ficha,
   * se suben las fotos, se publica al final.
   */
  it('⛔ publicar dos borradores a la vez tampoco pasa de 3', async () => {
    const v = await nuevoVendedor();
    const sellerId = v.seller.id as string;
    await publicarNuevo(v.token, 'Lleno uno');
    await publicarNuevo(v.token, 'Lleno dos');

    const borradores = await Promise.all([
      call('POST', '/api/v1/products', {
        token: v.token,
        body: { name: 'Borrador A', basePriceCents: 100_000, status: 'DRAFT' },
      }),
      call('POST', '/api/v1/products', {
        token: v.token,
        body: { name: 'Borrador B', basePriceCents: 100_000, status: 'DRAFT' },
      }),
    ]);

    const [a, b] = await Promise.all(
      borradores.map((r) =>
        call('PATCH', `/api/v1/products/${r.body.id}`, {
          token: v.token,
          body: { status: 'ACTIVE', categoryId: 'cat_otros' },
        }),
      ),
    );

    expect([a!.status, b!.status].sort()).toEqual([200, 409]);
    expect(await publicados(sellerId)).toBe(3);
  });

  /**
   * El cerrojo es POR VENDEDOR. Dos vendedores publicando a la vez no se
   * esperan entre sí: si se serializaran todos contra el mismo cerrojo, cada
   * alta de la plataforma haría cola detrás de las demás.
   */
  it('dos vendedores distintos no se bloquean entre sí', async () => {
    const uno = await nuevoVendedor();
    const otro = await nuevoVendedor();

    const [a, b] = await Promise.all([
      publicarNuevo(uno.token, 'Del uno'),
      publicarNuevo(otro.token, 'Del otro'),
    ]);

    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
  });

  /**
   * Los borradores no ocupan lugar, tampoco bajo concurrencia. Alguien en Free
   * tiene que poder cargar veinte fichas y elegir cuáles tres muestra.
   */
  it('los borradores simultáneos no consumen el tope', async () => {
    const v = await nuevoVendedor();
    const sellerId = v.seller.id as string;

    const rs = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        call('POST', '/api/v1/products', {
          token: v.token,
          body: { name: `Borrador paralelo ${i}`, basePriceCents: 100_000, status: 'DRAFT' },
        }),
      ),
    );

    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await publicados(sellerId)).toBe(0);

    // Y todavía puede publicar tres.
    expect((await publicarNuevo(v.token, 'Después de los borradores')).status).toBe(201);
  });

  /**
   * Y el tope es de Free. Un plan pago publica en paralelo sin tope: si el
   * cerrojo los frenara igual, el beneficio no existiría.
   */
  it('un Pro publica cinco a la vez sin problema', async () => {
    const v = await nuevoVendedor();
    await darPlan(v.seller.id as string, 'PRO');

    const rs = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => publicarNuevo(v.token, `Pro paralelo ${i}`)),
    );

    expect(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status))).toBe(true);
    expect(await publicados(v.seller.id as string)).toBe(5);
  });
});
