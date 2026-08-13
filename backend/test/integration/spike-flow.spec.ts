import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { crearAppDePrueba } from '../helpers/app';

/**
 * Recorrido completo del spike contra PostgreSQL REAL (docker compose).
 *
 * LiveKit está mockeado a propósito: este test valida NUESTRA lógica de
 * ingesta, agregación y veredicto. Que LiveKit funcione se valida en campo con
 * dos teléfonos, no acá.
 *
 * Requiere:  pnpm infra:up && pnpm prisma:deploy
 */

const TEST_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://livesell:livesell@localhost:5432/livesell',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  LIVEKIT_API_KEY: 'APItest',
  LIVEKIT_API_SECRET: 'test-secret-at-least-16-chars-long',
  LIVEKIT_WS_URL: 'wss://test.livekit.cloud',
  LIVEKIT_HTTP_URL: 'https://test.livekit.cloud',
  SPIKE_ENABLED: 'true',
  SPIKE_API_KEY: 'test-spike-key-suficientemente-larga',
  LOG_LEVEL: 'error',
};

const KEY = TEST_ENV.SPIKE_API_KEY;

let app: INestApplication;

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({
      wsUrl: TEST_ENV.LIVEKIT_WS_URL,
      ensureRoom: vi.fn().mockResolvedValue({ name: 'mock' }),
      deleteRoom: vi.fn().mockResolvedValue(undefined),
      issueToken: vi.fn().mockImplementation(({ roomName, identity, role }) => ({
        token: 'mock.jwt.token',
        wsUrl: TEST_ENV.LIVEKIT_WS_URL,
        roomName,
        identity,
        role,
        ttlSeconds: 3600,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })),
      verifyWebhook: vi.fn(),
    })
    .compile();

  app = await crearAppDePrueba(moduleRef);
});

afterAll(async () => {
  await app?.close();
});

// Helper: inject de Fastify, más rápido y fiable que supertest con este adapter.
async function call(method: string, url: string, opts: { body?: unknown; key?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key !== null) headers['x-spike-key'] = opts.key ?? KEY;

  const res = await (app as NestFastifyApplication)
    .getHttpAdapter()
    .getInstance()
    .inject({ method: method as never, url, headers, payload: opts.body as never });

  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

describe('Autenticación del módulo de spike', () => {
  it('rechaza sin la clave', async () => {
    const r = await call('POST', '/api/v1/spike/sessions', { body: { label: 'x' }, key: null });
    expect(r.status).toBe(401);
  });

  it('rechaza con una clave incorrecta', async () => {
    const r = await call('POST', '/api/v1/spike/sessions', {
      body: { label: 'test session' },
      key: 'clave-incorrecta-pero-igual-de-larga',
    });
    expect(r.status).toBe(401);
  });
});

describe('Sincronización de reloj', () => {
  it('devuelve el tiempo del servidor y hace eco del envío del cliente', async () => {
    const sent = Date.now();
    const r = await call('GET', `/api/v1/spike/time?clientSentAtMs=${sent}`);
    expect(r.status).toBe(200);
    expect(r.body.clientSentAtMs).toBe(sent);
    expect(Math.abs(r.body.serverTimeMs - sent)).toBeLessThan(10_000);
  });
});

describe('Recorrido completo del spike', () => {
  let sessionId: string;

  it('crea una sesión y devuelve la sala', async () => {
    const r = await call('POST', '/api/v1/spike/sessions', {
      body: {
        label: 'Integración · Personal 4G',
        carrier: 'Personal',
        networkType: 'CELLULAR_4G',
        locationNote: 'CI',
      },
    });

    expect(r.status).toBe(201);
    expect(r.body.sessionId).toMatch(/^spk_/);
    expect(r.body.roomName).toBe(`spike_${r.body.sessionId}`);
    sessionId = r.body.sessionId;
  });

  it('rechaza propiedades desconocidas en el body (.strict)', async () => {
    const r = await call('POST', '/api/v1/spike/sessions', {
      body: { label: 'con basura', propiedadInventada: 'x' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('emite tokens para ambos roles', async () => {
    for (const role of ['BROADCASTER', 'VIEWER']) {
      const r = await call('POST', '/api/v1/spike/token', {
        body: { sessionId, role, identity: `phone-${role.toLowerCase()}` },
      });
      expect(r.status).toBe(201);
      expect(r.body.wsUrl).toBe(TEST_ENV.LIVEKIT_WS_URL);
      expect(r.body.identity).toContain(role.toLowerCase());
    }
  });

  it('ingiere un lote de muestras y calcula la estimación de e2e', async () => {
    const now = Date.now();
    const samples = Array.from({ length: 30 }, (_, i) => ({
      seq: i,
      atMs: now + i * 1000,
      probeLatencyMs: 180 + (i % 5) * 20,
      rttMs: 60,
      jitterMs: 8,
      packetLossPct: 0.4,
      jitterBufferDelayMs: 45,
      bitrateKbps: 1_800,
      fps: 29.5,
      frameWidth: 540,
      frameHeight: 960,
      connectionQuality: 'good' as const,
      networkType: 'CELLULAR_4G' as const,
      carrier: 'Personal',
      clockOffsetMs: -120,
    }));

    const r = await call('POST', '/api/v1/spike/samples', {
      body: { sessionId, role: 'VIEWER', samples },
    });
    expect(r.status).toBe(201);
    expect(r.body.accepted).toBe(30);
  });

  it('ingiere eventos de conexión y reconexión', async () => {
    const now = Date.now();
    const r = await call('POST', '/api/v1/spike/events', {
      body: {
        sessionId,
        role: 'VIEWER',
        events: [
          { type: 'ROOM_CONNECTED', atMs: now, durationMs: 850 },
          { type: 'FIRST_FRAME', atMs: now + 400, durationMs: 1_250 },
          { type: 'ROOM_RECONNECTING', atMs: now + 30_000 },
          { type: 'ROOM_RECONNECTED', atMs: now + 32_400, durationMs: 2_400 },
        ],
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.accepted).toBe(4);
  });

  it('el veredicto es INSUFFICIENT_DATA sin mediciones manuales', async () => {
    // Es el comportamiento correcto y honesto: la estimación automática NO
    // alcanza para decidir un GO. Hacen falta al menos 10 fotos.
    const r = await call('GET', `/api/v1/spike/sessions/${sessionId}/report`);
    expect(r.status).toBe(200);
    expect(r.body.verdict.status).toBe('INSUFFICIENT_DATA');
    expect(r.body.counts.viewerSamples).toBe(30);
  });

  it('con 10 mediciones manuales buenas, el veredicto pasa a GO', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await call('POST', '/api/v1/spike/glass-to-glass', {
        body: {
          sessionId,
          latencyMs: 520 + i * 15, // p95 muy por debajo de 800 ms
          networkType: 'CELLULAR_4G',
          carrier: 'Personal',
        },
      });
      expect(r.status).toBe(201);
    }

    const r = await call('GET', `/api/v1/spike/sessions/${sessionId}/report`);
    expect(r.body.verdict.status).toBe('GO');
    expect(r.body.latency.glassToGlassManualMs.count).toBe(10);
    expect(r.body.calibration.pairs).toBeGreaterThanOrEqual(3);
    expect(r.body.calibration.biasMs).not.toBeNull();
  });

  it('con latencias altas el veredicto es NO_GO', async () => {
    const created = await call('POST', '/api/v1/spike/sessions', {
      body: { label: 'Sesión mala', networkType: 'CELLULAR_3G' },
    });
    const badId = created.body.sessionId;

    for (let i = 0; i < 12; i++) {
      await call('POST', '/api/v1/spike/glass-to-glass', {
        body: { sessionId: badId, latencyMs: 2_400 + i * 50, networkType: 'CELLULAR_3G' },
      });
    }

    const r = await call('GET', `/api/v1/spike/sessions/${badId}/report`);
    expect(r.body.verdict.status).toBe('NO_GO');
  });

  it('cierra la sesión y devuelve el informe final', async () => {
    const r = await call('POST', `/api/v1/spike/sessions/${sessionId}/end`, {
      body: { notes: 'Prueba de integración terminada' },
    });
    expect(r.status).toBe(201);
    expect(r.body.session.endedAt).toBeTruthy();
  });

  it('no permite cerrar dos veces la misma sesión', async () => {
    const r = await call('POST', `/api/v1/spike/sessions/${sessionId}/end`, { body: {} });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SESSION_ALREADY_ENDED');
  });

  it('devuelve 404 con un sessionId inexistente', async () => {
    const r = await call('GET', '/api/v1/spike/sessions/spk_01JBQ8X7ZVJ2K9M4NPQRSTUVW/report');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('SESSION_NOT_FOUND');
  });
});

describe('Health checks', () => {
  it('/health responde sin consultar dependencias', async () => {
    const r = await call('GET', '/health', { key: null });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  it('/ready comprueba Postgres y Redis', async () => {
    const r = await call('GET', '/ready', { key: null });
    expect(r.status).toBe(200);
    expect(r.body.checks.database.status).toBe('ok');
    expect(r.body.checks.redis.status).toBe('ok');
  });

  it('/metrics expone el formato de Prometheus', async () => {
    const res = await (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('spike_samples_ingested_total');
  });
});
