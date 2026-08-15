import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';
import { NACIMIENTO_ADULTO_ISO } from '../helpers/edad';

/**
 * El panel de administración, contra PostgreSQL real.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE SE PRUEBA ACÁ ES QUIÉN PUEDE ENTRAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un panel administrativo es, por definición, el conjunto de endpoints con más
 * poder del sistema: ve los datos de todos, suspende cuentas y mueve
 * devoluciones. Si uno solo queda accesible a un usuario común, no hay ninguna
 * otra defensa detrás.
 *
 * Los casos ⛔ son de seguridad. Si alguno se pone en rojo, cualquiera puede
 * hacer de administrador.
 *
 * ─── Por qué se enumeran TODAS las rutas ───
 *
 * El test de autorización no prueba "un endpoint". Recorre la lista completa,
 * porque el modo real de que esto falle no es que el guard esté mal escrito
 * —está a nivel de clase— sino que alguien agregue un endpoint nuevo en otro
 * controlador y se olvide. Agregar una ruta a la lista de abajo cuesta una
 * línea; descubrirla abierta en producción cuesta bastante más.
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
    'TRUNCATE audit_logs, order_items, payment_attempts, refunds, orders, ' +
      'inventory_reservations, inventory, product_variant_options, product_images, ' +
      'product_variants, product_option_values, product_options, products, stores, sellers, ' +
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

async function nuevoUsuario(): Promise<{ token: string; userId: string; email: string }> {
  n += 1;
  const email = `admin-test-${n}@test.com`;
  const r = await call('POST', '/api/v1/auth/dev', {
    body: {
      email,
      firstName: 'Test',
      lastName: `Usuario${n}`,
      device: {
        installId: `install-admin-${n}`,
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

  return { token: r.body.accessToken, userId: r.body.user.id, email };
}

/**
 * Un administrador.
 *
 * El rol se pone en la BASE y después se pide un token nuevo. No hay endpoint
 * para volverse admin —no debe haberlo— y el guard lee el rol de la base en
 * cada petición, así que el token viejo también serviría; se pide uno nuevo
 * para que el test refleje el flujo real de alguien que ya es admin.
 */
async function nuevoAdmin(): Promise<{ token: string; userId: string }> {
  const u = await nuevoUsuario();
  await prisma.user.update({ where: { id: u.userId }, data: { role: 'admin' } });
  return { token: u.token, userId: u.userId };
}

/** Toda ruta del panel. Agregar una acá al agregarla al controlador. */
const RUTAS: Array<[string, string, unknown?]> = [
  ['GET', '/api/v1/admin/attention'],
  ['GET', '/api/v1/admin/search?q=hola'],
  ['GET', '/api/v1/admin/users'],
  ['GET', '/api/v1/admin/users/usr_x'],
  ['POST', '/api/v1/admin/users/usr_x/suspend', { reason: 'motivo suficientemente largo' }],
  ['POST', '/api/v1/admin/users/usr_x/reactivate', { reason: 'motivo suficientemente largo' }],
  ['POST', '/api/v1/admin/users/usr_x/revoke-sessions', { reason: 'motivo suficientemente largo' }],
  ['GET', '/api/v1/admin/sellers'],
  ['GET', '/api/v1/admin/sellers/sel_x'],
  ['POST', '/api/v1/admin/sellers/sel_x/suspend', { reason: 'motivo suficientemente largo' }],
  ['POST', '/api/v1/admin/sellers/sel_x/reactivate', { reason: 'motivo suficientemente largo' }],
  ['POST', '/api/v1/admin/sellers/sel_x/block', { reason: 'motivo suficientemente largo' }],
  [
    'POST',
    '/api/v1/admin/sellers/sel_x/membership',
    { periodo: 'MENSUAL', origen: 'CORTESIA', reason: 'motivo suficientemente largo' },
  ],
  [
    'DELETE',
    '/api/v1/admin/sellers/sel_x/membership',
    { reason: 'motivo suficientemente largo' },
  ],
  [
    'POST',
    '/api/v1/admin/sellers/sel_x/promotion-credits',
    { cantidad: 10, reason: 'motivo suficientemente largo' },
  ],
  ['GET', '/api/v1/admin/products/prd_x'],
  ['POST', '/api/v1/admin/products/prd_x/pause', { reason: 'motivo suficientemente largo' }],
  ['POST', '/api/v1/admin/products/prd_x/reactivate', { reason: 'motivo suficientemente largo' }],
  ['GET', '/api/v1/admin/orders'],
  ['GET', '/api/v1/admin/orders/ord_x'],
  ['GET', '/api/v1/admin/orders/ord_x/timeline'],
  ['GET', '/api/v1/admin/payments'],
  ['POST', '/api/v1/admin/payments/pay_x/reconcile', { reason: 'motivo suficientemente largo' }],
  ['GET', '/api/v1/admin/refunds'],
  ['POST', '/api/v1/admin/refunds/ref_x/retry', { reason: 'motivo suficientemente largo' }],
  ['GET', '/api/v1/admin/webhooks'],
  ['GET', '/api/v1/admin/audit'],
  ['GET', '/api/v1/admin/audit/order/ord_x'],
];

describe('Admin — autorización', () => {
  it('⛔ sin token, TODA ruta del panel devuelve 401', async () => {
    for (const [metodo, url, body] of RUTAS) {
      const r = await call(metodo, url, { body });
      expect(r.status, `${metodo} ${url}`).toBe(401);
    }
  });

  it('⛔ con un usuario común, TODA ruta del panel devuelve 403', async () => {
    /**
     * El caso que importa de verdad.
     *
     * Un comprador con sesión válida es exactamente quien podría descubrir
     * `/api/v1/admin/users` probando URLs. Si alguna respondiera, tendría los
     * datos de toda la plataforma.
     */
    const { token } = await nuevoUsuario();

    for (const [metodo, url, body] of RUTAS) {
      const r = await call(metodo, url, { body, token });
      expect(r.status, `${metodo} ${url}`).toBe(403);
    }
  });

  it('⛔ un vendedor tampoco pasa: ser vendedor no es ser admin', async () => {
    const { token } = await nuevoUsuario();
    await call('POST', '/api/v1/sellers', {
      token,
      body: { displayName: `Vendedor prueba ${++n}`, storeName: `Tienda ${n}` },
    });

    const r = await call('GET', '/api/v1/admin/users', { token });
    expect(r.status).toBe(403);
  });

  it('⛔ con un token inventado devuelve 401, no 403', async () => {
    // La diferencia importa: un 403 confirmaría que el token se aceptó.
    const r = await call('GET', '/api/v1/admin/users', { token: 'no-es-un-token' });
    expect(r.status).toBe(401);
  });

  it('el admin sí entra', async () => {
    const { token } = await nuevoAdmin();
    const r = await call('GET', '/api/v1/admin/attention', { token });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('pagosInciertos');
  });

  it('⛔ un admin suspendido deja de entrar en la petición siguiente', async () => {
    /**
     * El rol se lee de la base en cada petición, no del token.
     *
     * Sin eso, revocarle el acceso a alguien no tendría efecto hasta que su
     * token expirara. Quince minutos de admin después de haberlo echado no es
     * aceptable.
     */
    const { token, userId } = await nuevoAdmin();
    expect((await call('GET', '/api/v1/admin/attention', { token })).status).toBe(200);

    await prisma.user.update({ where: { id: userId }, data: { status: 'suspended' } });

    const r = await call('GET', '/api/v1/admin/attention', { token });
    expect(r.status).toBe(403);
  });

  it('⛔ degradar el rol corta el acceso con el MISMO token', async () => {
    const { token, userId } = await nuevoAdmin();
    expect((await call('GET', '/api/v1/admin/attention', { token })).status).toBe(200);

    await prisma.user.update({ where: { id: userId }, data: { role: 'buyer' } });

    expect((await call('GET', '/api/v1/admin/attention', { token })).status).toBe(403);
  });
});

describe('Admin — motivo obligatorio', () => {
  it('⛔ sin motivo, la acción se rechaza', async () => {
    const { token } = await nuevoAdmin();
    const victima = await nuevoUsuario();

    const r = await call('POST', `/api/v1/admin/users/${victima.userId}/suspend`, {
      token,
      body: {},
    });
    expect(r.status).toBe(400);
  });

  it('⛔ un motivo de relleno tampoco pasa', async () => {
    // "x" cumpliría un `min(1)` y dejaría la bitácora tan inútil como vacía,
    // con la diferencia de que ahora parece completa.
    const { token } = await nuevoAdmin();
    const victima = await nuevoUsuario();

    for (const reason of ['x', 'test', '   ', 'asdf']) {
      const r = await call('POST', `/api/v1/admin/users/${victima.userId}/suspend`, {
        token,
        body: { reason },
      });
      expect(r.status, `motivo: "${reason}"`).toBe(400);
    }
  });

  it('la acción sí pasa con un motivo real', async () => {
    const { token } = await nuevoAdmin();
    const victima = await nuevoUsuario();

    const r = await call('POST', `/api/v1/admin/users/${victima.userId}/suspend`, {
      token,
      body: { reason: 'fraude reportado en el ticket #1234' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

describe('Admin — acciones sobre usuarios', () => {
  it('suspender revoca las sesiones y deja al usuario afuera', async () => {
    const { token: admin } = await nuevoAdmin();
    const victima = await nuevoUsuario();

    // Antes: la víctima puede operar.
    expect((await call('GET', '/api/v1/auth/me', { token: victima.token })).status).toBe(200);

    const r = await call('POST', `/api/v1/admin/users/${victima.userId}/suspend`, {
      token: admin,
      body: { reason: 'cuenta usada para spam masivo' },
    });
    expect(r.status).toBe(201);
    expect(r.body.sesionesRevocadas).toBeGreaterThan(0);

    // Después: no. El guard rechaza cuentas suspendidas.
    const despues = await call('GET', '/api/v1/auth/me', { token: victima.token });
    expect(despues.status).toBe(403);
  });

  it('la acción queda auditada con el motivo y el admin que la hizo', async () => {
    const { token: admin, userId: adminId } = await nuevoAdmin();
    const victima = await nuevoUsuario();

    await call('POST', `/api/v1/admin/users/${victima.userId}/suspend`, {
      token: admin,
      body: { reason: 'identidad robada, denuncia policial 555' },
    });

    const registros = await prisma.auditLog.findMany({
      where: { entityType: 'user', entityId: victima.userId, action: 'admin.user_suspended' },
    });

    expect(registros).toHaveLength(1);
    expect(registros[0]?.actorId).toBe(adminId);
    expect(registros[0]?.actorType).toBe('admin');
    expect(registros[0]?.reason).toBe('identidad robada, denuncia policial 555');
  });

  it('repetir la acción es idempotente y no duplica la auditoría', async () => {
    const { token: admin } = await nuevoAdmin();
    const victima = await nuevoUsuario();
    const cuerpo = { reason: 'suspensión por revisión de identidad' };

    await call('POST', `/api/v1/admin/users/${victima.userId}/suspend`, { token: admin, body: cuerpo });
    const segunda = await call('POST', `/api/v1/admin/users/${victima.userId}/suspend`, {
      token: admin,
      body: cuerpo,
    });

    expect(segunda.status).toBe(201);
    expect(segunda.body.yaEstaba).toBe(true);

    const registros = await prisma.auditLog.count({
      where: { entityType: 'user', entityId: victima.userId, action: 'admin.user_suspended' },
    });
    expect(registros).toBe(1);
  });

  it('⛔ un admin no puede suspenderse a sí mismo', async () => {
    /**
     * Si además fuera la única cuenta de admin, nadie podría revertirlo desde
     * la aplicación: habría que entrar a la base.
     */
    const { token, userId } = await nuevoAdmin();

    const r = await call('POST', `/api/v1/admin/users/${userId}/suspend`, {
      token,
      body: { reason: 'intento de suspenderme a mí mismo' },
    });
    expect(r.status).toBe(400);
  });

  it('reactivar devuelve el acceso', async () => {
    const { token: admin } = await nuevoAdmin();
    const victima = await nuevoUsuario();

    await call('POST', `/api/v1/admin/users/${victima.userId}/suspend`, {
      token: admin,
      body: { reason: 'suspensión preventiva mientras se revisa' },
    });
    await call('POST', `/api/v1/admin/users/${victima.userId}/reactivate`, {
      token: admin,
      body: { reason: 'revisión terminada, cuenta legítima' },
    });

    const u = await prisma.user.findUnique({ where: { id: victima.userId } });
    expect(u?.status).toBe('active');
  });
});

describe('Admin — búsqueda', () => {
  it('⛔ no lista usuarios con una búsqueda parcial', async () => {
    /**
     * Un panel que devuelve personas por coincidencia parcial es un exportador
     * de base de datos con otra interfaz. El email se busca por igualdad.
     */
    const { token } = await nuevoAdmin();
    await nuevoUsuario();

    const r = await call('GET', '/api/v1/admin/search?q=admin-test', { token });
    expect(r.status).toBe(200);
    expect(r.body.usuarios).toHaveLength(0);
  });

  it('⛔ rechaza búsquedas de menos de 3 caracteres', async () => {
    const { token } = await nuevoAdmin();
    const r = await call('GET', '/api/v1/admin/search?q=a', { token });
    expect(r.status).toBe(400);
  });

  it('encuentra por email exacto', async () => {
    const { token } = await nuevoAdmin();
    const victima = await nuevoUsuario();

    const r = await call('GET', `/api/v1/admin/search?q=${victima.email}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.interpretadoComo).toBe('email');
    expect(r.body.usuarios).toHaveLength(1);
    expect(r.body.usuarios[0].id).toBe(victima.userId);
  });

  it('encuentra por id de usuario, y no consulta otras tablas', async () => {
    const { token } = await nuevoAdmin();
    const victima = await nuevoUsuario();

    const r = await call('GET', `/api/v1/admin/search?q=${victima.userId}`, { token });
    expect(r.body.interpretadoComo).toBe('id de usuario');
    expect(r.body.usuarios).toHaveLength(1);
    expect(r.body.ordenes).toHaveLength(0);
  });

  it('⛔ el email vuelve enmascarado', async () => {
    const { token } = await nuevoAdmin();
    const victima = await nuevoUsuario();

    const r = await call('GET', `/api/v1/admin/search?q=${victima.userId}`, { token });
    const devuelto = r.body.usuarios[0].email as string;

    expect(devuelto).not.toBe(victima.email);
    expect(devuelto).toContain('*');
    // El dominio sí se ve: sirve para reconocer y no identifica a nadie.
    expect(devuelto).toContain('@test.com');
  });
});

describe('Admin — la bitácora es de sólo lectura', () => {
  it('⛔ no hay ninguna forma de modificarla ni borrarla', async () => {
    /**
     * El único valor de una bitácora es que nadie pueda cambiar lo que dice —
     * ni siquiera quien tiene la cuenta más privilegiada. Este test existe para
     * que agregar un endpoint de escritura sobre `/audit` sea imposible por
     * descuido.
     */
    const { token } = await nuevoAdmin();

    for (const metodo of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const r = await call(metodo, '/api/v1/admin/audit', {
        token,
        body: { action: 'inventado' },
      });
      expect([404, 405], `${metodo} /audit devolvió ${r.status}`).toContain(r.status);
    }

    for (const metodo of ['PATCH', 'PUT', 'DELETE']) {
      const r = await call(metodo, '/api/v1/admin/audit/aud_x', { token });
      expect([404, 405]).toContain(r.status);
    }
  });

  it('el listado muestra las acciones con su motivo', async () => {
    const { token: admin } = await nuevoAdmin();
    const victima = await nuevoUsuario();

    await call('POST', `/api/v1/admin/users/${victima.userId}/revoke-sessions`, {
      token: admin,
      body: { reason: 'dispositivo perdido reportado por el usuario' },
    });

    const r = await call('GET', '/api/v1/admin/audit?action=admin.sessions_revoked', {
      token: admin,
    });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items[0].motivo).toBe('dispositivo perdido reportado por el usuario');
    expect(r.body.items[0].actorTipo).toBe('admin');
  });
});

describe('Admin — paginación', () => {
  it('devuelve cursor cuando hay más páginas, y null cuando no', async () => {
    const { token } = await nuevoAdmin();
    for (let i = 0; i < 3; i++) await nuevoUsuario();

    const primera = await call('GET', '/api/v1/admin/users?limit=2', { token });
    expect(primera.body.items).toHaveLength(2);
    expect(primera.body.siguienteCursor).toBeTruthy();

    const segunda = await call(
      'GET',
      `/api/v1/admin/users?limit=2&cursor=${primera.body.siguienteCursor}`,
      { token },
    );
    // No repite el último de la página anterior.
    const idsPrimera = primera.body.items.map((u: { id: string }) => u.id);
    for (const u of segunda.body.items as Array<{ id: string }>) {
      expect(idsPrimera).not.toContain(u.id);
    }
  });

  it('⛔ el límite tiene techo: no se puede pedir la tabla entera', async () => {
    const { token } = await nuevoAdmin();
    const r = await call('GET', '/api/v1/admin/users?limit=100000', { token });
    expect(r.status).toBe(400);
  });
});

describe('Admin — entidades inexistentes', () => {
  it('devuelve 404, no 500', async () => {
    const { token } = await nuevoAdmin();

    for (const url of [
      '/api/v1/admin/users/usr_noexiste',
      '/api/v1/admin/sellers/sel_noexiste',
      '/api/v1/admin/products/prd_noexiste',
      '/api/v1/admin/orders/ord_noexiste',
    ]) {
      const r = await call('GET', url, { token });
      expect(r.status, url).toBe(404);
    }
  });

  it('la cronología de una orden inexistente es una lista vacía, no un error', async () => {
    // Una pantalla que revienta con un id viejo obliga a quien atiende a
    // adivinar si el problema es el dato o el panel.
    const { token } = await nuevoAdmin();
    const r = await call('GET', '/api/v1/admin/orders/ord_noexiste/timeline', { token });
    expect(r.status).toBe(200);
    expect(r.body.eventos).toEqual([]);
  });
});

describe('VendoX Pro', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PRO NO ES VERIFICADO
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Son dos cosas distintas y estos tests las mantienen separadas:
   *
   *   · **Verificado** dice que VendoX comprobó quién es esa persona.
   *   · **Pro** dice que contrató herramientas.
   *
   * Si otorgar Pro tocara la verificación, el sello de identidad pasaría a
   * estar en venta.
   */

  /** Un vendedor cualquiera, sin plan. */
  async function nuevoVendedor() {
    const u = await nuevoUsuario();
    const r = await call('POST', '/api/v1/sellers', {
      token: u.token,
      body: { displayName: `Tienda ${u.userId.slice(-6)}` },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const vendedor = await prisma.seller.findFirstOrThrow({ where: { userId: u.userId } });
    return { ...u, sellerId: vendedor.id };
  }

  it('sin nada otorgado, es Free y no tiene beneficios', async () => {
    // El estado de la enorme mayoría: no hay fila hasta que se otorga algo.
    const v = await nuevoVendedor();

    const r = await call('GET', '/api/v1/seller/membership', { token: v.token });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.plan).toBe('FREE');
    expect(r.body.beneficios).toEqual([]);
    expect(r.body.vigenteHasta).toBeNull();
    expect(r.body.diasRestantes).toBeNull();
  });

  it('otorgado desde el panel, pasa a Pro con fecha', async () => {
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    const otorgado = await call('POST', `/api/v1/admin/sellers/${v.sellerId}/membership`, {
      token: admin.token,
      body: {
        periodo: 'MENSUAL',
        origen: 'CORTESIA',
        reason: 'vendedor inicial del beta cerrado',
      },
    });
    expect(otorgado.status, JSON.stringify(otorgado.body)).toBe(201);

    const mia = await call('GET', '/api/v1/seller/membership', { token: v.token });
    expect(mia.body.plan).toBe('PRO');
    expect(mia.body.beneficios).toContain('CUPONES');
    expect(mia.body.diasRestantes).toBe(30);
    // El vendedor tiene derecho a saber que se lo regalaron: si cree que lo
    // paga, no entiende por qué le vence.
    expect(mia.body.origen).toBe('CORTESIA');
  });

  it('⛔ otorgar Pro NO verifica la identidad', async () => {
    /**
     * EL TEST QUE IMPORTA.
     *
     * Es lo que impide que el sello de identidad se vuelva comprable. Un
     * `update` de más en `otorgar` —o un futuro «los Pro salen verificados»—
     * rompe acá.
     */
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/membership`, {
      token: admin.token,
      body: { periodo: 'ANUAL', origen: 'PAGO', reason: 'pagó por transferencia en agosto' },
    });

    const enBase = await prisma.seller.findUniqueOrThrow({ where: { id: v.sellerId } });
    expect(enBase.verificationStatus).toBe('UNVERIFIED');
  });

  it('⛔ ni toca la reputación', async () => {
    // Pagar no puede subir estrellas. Es la regla de veracidad aplicada al
    // lugar donde más tentador sería romperla.
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();
    const antes = await prisma.seller.findUniqueOrThrow({ where: { id: v.sellerId } });

    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/membership`, {
      token: admin.token,
      body: { periodo: 'MENSUAL', origen: 'CORTESIA', reason: 'compensación por caída del vivo' },
    });

    const despues = await prisma.seller.findUniqueOrThrow({ where: { id: v.sellerId } });
    expect(despues.ratingSum).toBe(antes.ratingSum);
    expect(despues.ratingCount).toBe(antes.ratingCount);
    expect(despues.salesCount).toBe(antes.salesCount);
    expect(despues.riskLevel).toBe(antes.riskLevel);
  });

  it('⛔ un Pro vencido responde Free, aunque la fila diga PRO', async () => {
    /**
     * La fila sigue diciendo `PRO` hasta que algo la actualice, y no hay nada
     * que la actualice: decidimos no tener tarea. La verdad la da la fecha.
     */
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/membership`, {
      token: admin.token,
      body: { periodo: 'MENSUAL', origen: 'PRUEBA', reason: 'prueba de treinta días' },
    });

    // Se vence a mano, que es lo que hace el paso del tiempo.
    await prisma.sellerMembership.update({
      where: { sellerId: v.sellerId },
      data: { vigenteHasta: new Date(Date.now() - 60_000) },
    });

    const mia = await call('GET', '/api/v1/seller/membership', { token: v.token });
    expect(mia.body.plan).toBe('FREE');
    expect(mia.body.beneficios).toEqual([]);

    // Y en la base sigue diciendo PRO: es justamente lo que no hay que leer.
    const fila = await prisma.sellerMembership.findUniqueOrThrow({
      where: { sellerId: v.sellerId },
    });
    expect(fila.plan).toBe('PRO');
  });

  it('renovar temprano suma en vez de reemplazar', async () => {
    // Alguien con veinte días por delante que renueva termina con cincuenta.
    // Reemplazar la fecha le cobraría un mes y le sacaría veinte días.
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();
    const cuerpo = { periodo: 'MENSUAL', origen: 'PAGO', reason: 'renovación mensual de agosto' };

    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/membership`, {
      token: admin.token,
      body: cuerpo,
    });
    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/membership`, {
      token: admin.token,
      body: cuerpo,
    });

    const mia = await call('GET', '/api/v1/seller/membership', { token: v.token });
    // 60 días, no 30.
    expect(mia.body.diasRestantes).toBe(60);
  });

  it('revocar lo deja en Free pero no borra el historial', async () => {
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/membership`, {
      token: admin.token,
      body: { periodo: 'ANUAL', origen: 'CORTESIA', reason: 'acuerdo con la tienda' },
    });

    const r = await call('DELETE', `/api/v1/admin/sellers/${v.sellerId}/membership`, {
      token: admin.token,
      body: { reason: 'se otorgó al vendedor equivocado' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const mia = await call('GET', '/api/v1/seller/membership', { token: v.token });
    expect(mia.body.plan).toBe('FREE');

    // La fila sigue: es lo que permite responder un reclamo.
    const fila = await prisma.sellerMembership.findUnique({ where: { sellerId: v.sellerId } });
    expect(fila).not.toBeNull();
  });

  it('⛔ queda en la bitácora, con el motivo y con quién lo dio', async () => {
    /**
     * `otorgar` es, literalmente, la función que regala dinero. Sin registro,
     * un Pro de cortesía en la base es indistinguible de uno que alguien puso
     * por error.
     */
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/membership`, {
      token: admin.token,
      body: {
        periodo: 'ANUAL',
        origen: 'CORTESIA',
        reason: 'acuerdo con la marca por el lanzamiento',
      },
    });

    const registro = await prisma.auditLog.findFirst({
      where: { action: 'membership.granted', entityId: v.sellerId },
      orderBy: { createdAt: 'desc' },
    });

    expect(registro).not.toBeNull();
    expect(registro?.actorId).toBe(admin.userId);
    expect(JSON.stringify(registro?.after)).toContain('lanzamiento');
  });

  it('⛔ no se puede otorgar a un vendedor que no existe', async () => {
    // Dejaría una fila huérfana que nadie va a mirar nunca.
    const admin = await nuevoAdmin();

    const r = await call('POST', '/api/v1/admin/sellers/sel_inventado/membership', {
      token: admin.token,
      body: { periodo: 'MENSUAL', origen: 'CORTESIA', reason: 'motivo suficientemente largo' },
    });

    expect(r.status).toBe(404);
  });

  it('⛔ el motivo es obligatorio', async () => {
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    const r = await call('POST', `/api/v1/admin/sellers/${v.sellerId}/membership`, {
      token: admin.token,
      body: { periodo: 'MENSUAL', origen: 'CORTESIA' },
    });

    expect(r.status).toBe(400);
  });

  it('⛔ la base rechaza un PRO sin vencimiento', async () => {
    /**
     * La última línea de defensa.
     *
     * `planVigente()` ya trata un Pro sin fecha como vencido, pero eso es
     * código y el código se puede saltear: un `UPDATE` a mano desde una
     * consola, una migración futura mal escrita. El CHECK no se saltea.
     */
    const v = await nuevoVendedor();
    const admin = await nuevoAdmin();

    await call('POST', `/api/v1/admin/sellers/${v.sellerId}/membership`, {
      token: admin.token,
      body: { periodo: 'MENSUAL', origen: 'CORTESIA', reason: 'motivo suficientemente largo' },
    });

    await expect(
      prisma.sellerMembership.update({
        where: { sellerId: v.sellerId },
        data: { vigenteHasta: null },
      }),
    ).rejects.toThrow();
  });
});
