import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { LiveKitService as LiveKitServiceType } from '@/modules/livekit/livekit.service';

/**
 * El test más importante del Sprint 0 en materia de seguridad.
 *
 * Verifica el invariante que exigiste: **un viewer nunca puede publicar audio
 * ni video.** Se aplica en el servidor de LiveKit vía los grants del token, así
 * que no depende de que la app se comporte bien — pero sí depende de que el
 * backend firme los grants correctos. Eso es lo que se prueba acá.
 */

const TEST_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  LIVEKIT_API_KEY: 'APItestkey',
  LIVEKIT_API_SECRET: 'test-secret-at-least-16-chars-long',
  LIVEKIT_WS_URL: 'wss://test.livekit.cloud',
  LIVEKIT_HTTP_URL: 'https://test.livekit.cloud',
  SPIKE_ENABLED: 'false',
};

// Sólo el tipo: la clase se importa dinámicamente después de fijar el entorno.
let LiveKitService: typeof LiveKitServiceType;
let service: InstanceType<typeof LiveKitService>;

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);
  ({ LiveKitService } = await import('@/modules/livekit/livekit.service'));

  const metrics = {
    livekitTokenIssued: { inc: vi.fn() },
    livekitApiDuration: { startTimer: () => vi.fn() },
  };
  service = new LiveKitService(metrics as never);
});

describe('LiveKitService.issueToken', () => {
  it('un BROADCASTER puede publicar y suscribirse', async () => {
    const issued = await service.issueToken({
      roomName: 'spike_test',
      identity: 'broadcaster_a',
      role: 'broadcaster',
    });

    const grant = decodeJwtPayload(issued.token).video as Record<string, unknown>;
    expect(grant.roomJoin).toBe(true);
    expect(grant.room).toBe('spike_test');
    expect(grant.canPublish).toBe(true);
    expect(grant.canSubscribe).toBe(true);
    expect(grant.canPublishData).toBe(true);
  });

  it('⛔ un VIEWER NO puede publicar audio ni video', async () => {
    const issued = await service.issueToken({
      roomName: 'spike_test',
      identity: 'viewer_b',
      role: 'viewer',
    });

    const grant = decodeJwtPayload(issued.token).video as Record<string, unknown>;
    expect(grant.canPublish).toBe(false);
    expect(grant.canPublishData).toBe(false);
    expect(grant.canSubscribe).toBe(true);
  });

  it('ningún rol puede crear salas ni administrar: eso es del backend', async () => {
    for (const role of ['broadcaster', 'viewer'] as const) {
      const issued = await service.issueToken({ roomName: 'spike_test', identity: 'x', role });
      const grant = decodeJwtPayload(issued.token).video as Record<string, unknown>;

      expect(grant.roomCreate).toBeFalsy();
      expect(grant.roomAdmin).toBeFalsy();
    }
  });

  it('el token está acotado a UNA sala concreta', async () => {
    const issued = await service.issueToken({
      roomName: 'spike_only_this',
      identity: 'x',
      role: 'viewer',
    });
    const grant = decodeJwtPayload(issued.token).video as Record<string, unknown>;

    // Sin `room`, un token de espectador serviría para entrar a CUALQUIER live.
    expect(grant.room).toBe('spike_only_this');
    expect(grant.roomJoin).toBe(true);
  });

  it('el broadcaster recibe un TTL más largo que el viewer', async () => {
    const b = await service.issueToken({ roomName: 'r', identity: 'b', role: 'broadcaster' });
    const v = await service.issueToken({ roomName: 'r', identity: 'v', role: 'viewer' });

    // Una transmisión puede durar horas; una sesión de espectador se re-emite.
    expect(b.ttlSeconds).toBeGreaterThan(v.ttlSeconds);
  });

  it('el token nunca contiene el API secret', async () => {
    const { token } = await service.issueToken({ roomName: 'r', identity: 'x', role: 'viewer' });
    expect(token).not.toContain(TEST_ENV.LIVEKIT_API_SECRET);
    expect(JSON.stringify(decodeJwtPayload(token))).not.toContain(TEST_ENV.LIVEKIT_API_SECRET);
  });
});
