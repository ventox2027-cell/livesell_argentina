import { VersioningType, type INestApplication } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

/**
 * Recorrido completo de autenticación, contra PostgreSQL REAL.
 *
 * Google y Apple están fuera: verificar sus firmas es su trabajo, no el
 * nuestro, y depender de su disponibilidad haría que estos tests fallaran por
 * motivos que no tienen que ver con el código. Lo que sí se prueba acá es
 * NUESTRA lógica: rotación, detección de robo, vinculación de cuentas,
 * suspensión y cierre.
 *
 * Cada `it` marcado con ⛔ corresponde a un invariante de seguridad. Si alguno
 * se pone en rojo, hay cuentas en riesgo.
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
  JWT_ACCESS_TTL_S: '900',
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

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api', { exclude: ['health', 'ready', 'metrics', 'webhooks/(.*)'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
  await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  redis = app.get(RedisService);

  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('_test')) {
    throw new Error('Los tests de integración borran datos y sólo corren contra una base *_test');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE auth_events, refresh_tokens, devices, user_identities, users CASCADE',
  );
});

afterAll(async () => {
  await app?.close();
});

/**
 * Contador de peticiones a cero antes de cada test.
 *
 * Todos los tests salen de la misma IP, así que comparten cuota y a partir del
 * décimo login el limitador empieza a rechazar — haciendo exactamente lo que
 * tiene que hacer. Limpiar el contador aísla los tests SIN apagar el guard:
 * sigue ejecutándose en cada petición, y hay un test dedicado que comprueba
 * que efectivamente corta.
 */
beforeEach(async () => {
  const claves = await redis.client.keys('rl:*');
  if (claves.length > 0) await redis.client.del(...claves);
});

async function call(
  method: string,
  url: string,
  opts: { body?: unknown; token?: string } = {},
) {
  // El content-type sólo va si hay cuerpo. Declararlo con el cuerpo vacío hace
  // que Fastify responda 400 antes de llegar al controlador, que es lo
  // correcto de su parte y no lo que queremos probar acá.
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
function dispositivo(sufijo = '') {
  n += 1;
  return {
    installId: `install-de-prueba-${n}${sufijo}`,
    platform: 'android' as const,
    appVersion: '1.0.0',
    osVersion: '14',
    model: 'Pixel 7',
  };
}

async function entrar(email = `persona${++n}@test.com`, extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/v1/auth/dev', {
    body: { email, firstName: 'Ana', lastName: 'Gómez', device: dispositivo(), ...extra },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

// ═══════════════════════════════════════════════════════════════════════════

describe('Registro e inicio de sesión', () => {
  it('crea la cuenta en el primer login y devuelve un par de tokens', async () => {
    const s = await entrar('primera@test.com');
    expect(s.isNewUser).toBe(true);
    expect(s.accessToken).toBeTruthy();
    expect(s.refreshToken).toBeTruthy();
    expect(s.user.email).toBe('primera@test.com');
  });

  it('el segundo login entra a la MISMA cuenta', async () => {
    const a = await entrar('repetida@test.com');
    const b = await entrar('repetida@test.com');
    expect(b.isNewUser).toBe(false);
    expect(b.user.id).toBe(a.user.id);
  });

  it('normaliza el email: dos grafías, una sola cuenta', async () => {
    // Sin esto la persona pierde su historial según cómo haya escrito el mail
    // el día que se registró.
    const a = await entrar('Mayus@Test.com');
    const b = await entrar('  mayus@test.com ');
    expect(b.user.id).toBe(a.user.id);
  });

  it('dice qué falta para poder comprar', async () => {
    // Es el otro lado del onboarding rápido: se entra con un toque y lo que
    // falta se pide cuando hace falta.
    const s = await entrar('faltantes@test.com');
    expect(s.missing).toContain('phone');
  });

  it('registra el dispositivo y no lo duplica al reentrar', async () => {
    const disp = dispositivo('-fijo');
    const email = 'dispositivo@test.com';
    await call('POST', '/api/v1/auth/dev', {
      body: { email, firstName: 'A', lastName: 'B', device: disp },
    });
    await call('POST', '/api/v1/auth/dev', {
      body: { email, firstName: 'A', lastName: 'B', device: { ...disp, appVersion: '1.1.0' } },
    });

    const filas = await prisma.device.findMany({ where: { installId: disp.installId } });
    expect(filas).toHaveLength(1);
    expect(filas[0]!.appVersion).toBe('1.1.0');
  });
});

describe('Rotación de refresh tokens', () => {
  it('el refresco entrega un par NUEVO', async () => {
    const s = await entrar();
    const r = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: s.refreshToken },
    });
    expect(r.status).toBe(201);
    expect(r.body.refreshToken).not.toBe(s.refreshToken);
    expect(r.body.accessToken).toBeTruthy();
  });

  it('⛔ el token viejo deja de servir apenas se rota', async () => {
    const s = await entrar();
    await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: s.refreshToken } });

    const reintento = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: s.refreshToken },
    });
    expect(reintento.status).toBe(401);
  });

  it('⛔ REUSO: usar un token quemado revoca la familia entera', async () => {
    /**
     * El invariante más importante del módulo.
     *
     * Si un token ya usado reaparece, hay dos copias en circulación. Como no
     * se puede distinguir al dueño del ladrón, se cortan las dos.
     */
    const s = await entrar();
    const segundo = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: s.refreshToken },
    });
    const tercero = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: segundo.body.refreshToken },
    });
    expect(tercero.status).toBe(201);

    // Aparece el primero, que ya estaba quemado: es el robo.
    const robo = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: s.refreshToken },
    });
    expect(robo.status).toBe(401);

    // Y el token que el ladrón NO tiene también queda muerto: es el precio de
    // no poder distinguir quién es quién.
    const legitimo = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: tercero.body.refreshToken },
    });
    expect(legitimo.status).toBe(401);
  });

  it('el reuso queda registrado en la bitácora', async () => {
    // Un pico de estos es la señal de que hay tokens robados circulando.
    const s = await entrar();
    await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: s.refreshToken } });
    await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: s.refreshToken } });

    const evento = await prisma.authEvent.findFirst({
      where: { userId: s.user.id, kind: 'refresh.reuse' },
    });
    expect(evento).not.toBeNull();
    expect(evento!.success).toBe(false);
  });

  it('⛔ nunca guarda el token en claro', async () => {
    const s = await entrar();
    const filas = await prisma.refreshToken.findMany({ where: { userId: s.user.id } });
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas) {
      expect(f.tokenHash).not.toBe(s.refreshToken);
      expect(f.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(filas)).not.toContain(s.refreshToken);
  });

  it('rechaza un token inventado', async () => {
    const r = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: 'x'.repeat(43) },
    });
    expect(r.status).toBe(401);
  });
});

describe('Cierre de sesión', () => {
  it('cierra una sesión sin tocar las otras', async () => {
    // Cerrar sesión en el teléfono no puede desloguear la tablet.
    const email = 'dos-dispositivos@test.com';
    const tel = await entrar(email);
    const tablet = await entrar(email);

    await call('POST', '/api/v1/auth/logout', { body: { refreshToken: tel.refreshToken } });

    expect(
      (await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: tel.refreshToken } }))
        .status,
    ).toBe(401);
    expect(
      (await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: tablet.refreshToken } }))
        .status,
    ).toBe(201);
  });

  it('logout-all cierra todas', async () => {
    const email = 'todas@test.com';
    const a = await entrar(email);
    const b = await entrar(email);

    const r = await call('POST', '/api/v1/auth/logout-all', { token: a.accessToken });
    expect(r.status).toBe(201);

    for (const s of [a, b]) {
      expect(
        (await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: s.refreshToken } }))
          .status,
      ).toBe(401);
    }
  });

  it('cerrar sesión con un token inexistente responde 200 igual', async () => {
    // Responder distinto revelaría si un token es válido a quien está probando.
    const r = await call('POST', '/api/v1/auth/logout', {
      body: { refreshToken: 'y'.repeat(43) },
    });
    expect(r.status).toBe(201);
  });
});

describe('⛔ El guard: todo cerrado por defecto', () => {
  it('rechaza sin token', async () => {
    expect((await call('GET', '/api/v1/auth/me')).status).toBe(401);
  });

  it('rechaza un token inventado', async () => {
    expect((await call('GET', '/api/v1/auth/me', { token: 'no.es.un.jwt' })).status).toBe(401);
  });

  it('⛔ rechaza un token firmado con OTRA clave', async () => {
    // Es el ataque directo: fabricarse un token con los datos que uno quiera.
    const { SignJWT } = await import('jose');
    const falso = await new SignJWT({ role: 'admin', sid: 'ses_falsa' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr_inventado')
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('livesell')
      .setAudience('livesell-app')
      .sign(new TextEncoder().encode('la-clave-de-un-atacante-que-mide-mas-de-32'));

    expect((await call('GET', '/api/v1/auth/me', { token: falso })).status).toBe(401);
  });

  it('⛔ rechaza un token vencido', async () => {
    const { SignJWT } = await import('jose');
    const vencido = await new SignJWT({ role: 'buyer', sid: 'ses_x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr_x')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .setIssuer('livesell')
      .setAudience('livesell-app')
      .sign(new TextEncoder().encode(TEST_ENV.JWT_SECRET));

    expect((await call('GET', '/api/v1/auth/me', { token: vencido })).status).toBe(401);
  });

  it('⛔ rechaza un token con otra audiencia', async () => {
    // Sin validar `aud`, un token emitido por este backend para otro propósito
    // —un enlace de verificación, por ejemplo— serviría para autenticarse.
    const { SignJWT } = await import('jose');
    const otraAud = await new SignJWT({ role: 'buyer', sid: 'ses_x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr_x')
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('livesell')
      .setAudience('otra-cosa')
      .sign(new TextEncoder().encode(TEST_ENV.JWT_SECRET));

    expect((await call('GET', '/api/v1/auth/me', { token: otraAud })).status).toBe(401);
  });

  it('acepta un token legítimo', async () => {
    const s = await entrar();
    const r = await call('GET', '/api/v1/auth/me', { token: s.accessToken });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(s.user.id);
  });

  it('/health sigue abierto', async () => {
    expect((await call('GET', '/health')).status).toBe(200);
  });
});

describe('⛔ Suspensión: efecto inmediato', () => {
  it('una cuenta suspendida no puede usar su access token vigente', async () => {
    /**
     * El motivo por el que el guard consulta la base en cada petición.
     *
     * Si el rol y el estado se leyeran del token, suspender a un estafador lo
     * dejaría operando hasta que su token expirara. Quince minutos vendiendo
     * con una cuenta bloqueada no es aceptable.
     */
    const s = await entrar('suspendida@test.com');
    expect((await call('GET', '/api/v1/auth/me', { token: s.accessToken })).status).toBe(200);

    await prisma.user.update({ where: { id: s.user.id }, data: { status: 'suspended' } });

    expect((await call('GET', '/api/v1/auth/me', { token: s.accessToken })).status).toBe(403);
  });

  it('y tampoco puede renovar la sesión', async () => {
    const s = await entrar('suspendida2@test.com');
    await prisma.user.update({ where: { id: s.user.id }, data: { status: 'suspended' } });

    expect(
      (await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: s.refreshToken } }))
        .status,
    ).toBe(401);
  });

  it('⛔ el rol sale de la BASE, no del token', async () => {
    // Alguien degradado de admin a buyer no puede seguir siendo admin hasta
    // que su token expire.
    const s = await entrar('rol@test.com', { role: 'admin' });
    expect(s.user.role).toBe('admin');

    await prisma.user.update({ where: { id: s.user.id }, data: { role: 'buyer' } });

    const r = await call('GET', '/api/v1/auth/me', { token: s.accessToken });
    expect(r.body.role).toBe('buyer');
  });
});

describe('Perfil', () => {
  it('completa el teléfono y lo normaliza a E.164', async () => {
    const s = await entrar('perfil@test.com');
    const r = await call('PATCH', '/api/v1/auth/me', {
      token: s.accessToken,
      body: { phone: '011 15 5555 6666' },
    });
    expect(r.status).toBe(200);
    expect(r.body.phone).toBe('+5491155556666');
  });

  it('⛔ cambiar el teléfono invalida la verificación anterior', async () => {
    // Si no, alguien con un número verificado lo cambia por otro y conserva el
    // estado de verificado sobre un número que nadie comprobó.
    const s = await entrar('verificado@test.com');
    await prisma.user.update({
      where: { id: s.user.id },
      data: { phoneE164: '+5491100000000', phoneVerified: true },
    });

    const r = await call('PATCH', '/api/v1/auth/me', {
      token: s.accessToken,
      body: { phone: '11 5555 7777' },
    });
    expect(r.body.phoneVerified).toBe(false);
  });

  it('rechaza un teléfono que no se puede normalizar', async () => {
    const s = await entrar('telmalo@test.com');
    const r = await call('PATCH', '/api/v1/auth/me', {
      token: s.accessToken,
      body: { phone: '123' },
    });
    expect(r.status).toBe(400);
  });
});

describe('Cierre de cuenta', () => {
  it('anonimiza, corta las sesiones y libera el email', async () => {
    const s = await entrar('me-voy@test.com');
    const r = await call('DELETE', '/api/v1/auth/me', { token: s.accessToken });
    expect(r.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: s.user.id } });
    expect(user.status).toBe('deleted');
    expect(user.email).not.toBe('me-voy@test.com');
    expect(user.phoneE164).toBeNull();

    // No puede volver a entrar con la sesión que tenía.
    expect(
      (await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: s.refreshToken } }))
        .status,
    ).toBe(401);

    // Y el email queda libre: alguien que se va y vuelve puede registrarse.
    const nueva = await entrar('me-voy@test.com');
    expect(nueva.user.id).not.toBe(s.user.id);
  });
});

describe('⛔ Límite de peticiones', () => {
  it('corta después de 10 intentos de login por minuto', async () => {
    /**
     * Un endpoint de login público sin límite es una invitación a probar
     * tokens en serie. El límite es lo único que separa "alguien intenta" de
     * "alguien lo logra".
     */
    const cuerpo = {
      idToken: 'x'.repeat(64),
      device: dispositivo('-límite'),
    };

    const estados: number[] = [];
    for (let i = 0; i < 13; i += 1) {
      const r = await call('POST', '/api/v1/auth/google', { body: cuerpo });
      estados.push(r.status);
    }

    // Los primeros fallan por token inválido (401), no por límite.
    expect(estados.slice(0, 10).every((s) => s !== 429)).toBe(true);
    // Y a partir del undécimo, el limitador corta.
    expect(estados.slice(10)).toContain(429);
  });

  it('Google y Apple COMPARTEN cuota', async () => {
    // Separarlas le daría a un atacante el doble de intentos con sólo
    // alternar entre las dos.
    const device = dispositivo('-compartido');
    for (let i = 0; i < 10; i += 1) {
      await call('POST', '/api/v1/auth/google', { body: { idToken: 'x'.repeat(64), device } });
    }
    const apple = await call('POST', '/api/v1/auth/apple', {
      body: { idToken: 'x'.repeat(64), device },
    });
    expect(apple.status).toBe(429);
  });
});

describe('Sesiones activas', () => {
  it('lista las sesiones abiertas con su dispositivo', async () => {
    const email = 'sesiones@test.com';
    const a = await entrar(email);
    await entrar(email);

    const r = await call('GET', '/api/v1/auth/sessions', { token: a.accessToken });
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThanOrEqual(2);
    expect(r.body[0].device?.platform).toBe('android');
  });
});
