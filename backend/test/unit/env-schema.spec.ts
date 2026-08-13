import { describe, expect, it } from 'vitest';

import { envSchema } from '@/config/env.schema';

const VALID = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/livesell',
  REDIS_URL: 'redis://localhost:6379',
  LIVEKIT_API_KEY: 'APIkey123',
  LIVEKIT_API_SECRET: 'a-secret-of-at-least-16-chars',
  LIVEKIT_WS_URL: 'wss://x.livekit.cloud',
  LIVEKIT_HTTP_URL: 'https://x.livekit.cloud',
};

describe('envSchema', () => {
  it('acepta una configuración válida y aplica los valores por defecto', () => {
    const env = envSchema.parse(VALID);
    // El default es 3000 porque es el puerto del contenedor en Fly.io.
    // El 3100 es un override local en .env, no el valor por defecto.
    expect(env.PORT).toBe(3000);
    expect(env.SPIKE_ENABLED).toBe(false);
    expect(env.LIVEKIT_BROADCASTER_TOKEN_TTL_S).toBe(21_600);
  });

  it('rechaza un DATABASE_URL que no sea postgres', () => {
    const r = envSchema.safeParse({ ...VALID, DATABASE_URL: 'mysql://u:p@localhost/db' });
    expect(r.success).toBe(false);
  });

  it('rechaza un secreto de LiveKit demasiado corto', () => {
    const r = envSchema.safeParse({ ...VALID, LIVEKIT_API_SECRET: 'corto' });
    expect(r.success).toBe(false);
  });

  it('⛔ rechaza SPIKE_ENABLED sin SPIKE_API_KEY', () => {
    // Sin esta regla quedarían endpoints abiertos que crean salas de LiveKit.
    const r = envSchema.safeParse({ ...VALID, SPIKE_ENABLED: 'true' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.includes('SPIKE_API_KEY'))).toBe(true);
  });

  it('⛔ rechaza SPIKE_ENABLED en production, incluso con clave', () => {
    const r = envSchema.safeParse({
      ...VALID,
      NODE_ENV: 'production',
      SPIKE_ENABLED: 'true',
      SPIKE_API_KEY: 'una-clave-larga-y-suficiente',
    });
    expect(r.success).toBe(false);
  });

  it('acepta SPIKE_ENABLED con clave fuera de production', () => {
    const r = envSchema.safeParse({
      ...VALID,
      NODE_ENV: 'staging',
      SPIKE_ENABLED: 'true',
      SPIKE_API_KEY: 'una-clave-larga-y-suficiente',
    });
    expect(r.success).toBe(true);
  });

  // ─── Mercado Pago ─────────────────────────────────────────────────────────

  const MP = {
    MP_ACCESS_TOKEN: 'TEST-1234567890-abcdefghijklmno',
    MP_PUBLIC_KEY: 'TEST-pub-1234567890-abcdefghij',
    MP_WEBHOOK_SECRET: 'secreto-de-webhook',
  };

  it('⛔ rechaza PAYMENTS_SPIKE_ENABLED sin credenciales de Mercado Pago', () => {
    const r = envSchema.safeParse({ ...VALID, PAYMENTS_SPIKE_ENABLED: 'true' });
    expect(r.success).toBe(false);
  });

  it('⛔ rechaza PAYMENTS_SPIKE_ENABLED sin la clave de firma de webhooks', () => {
    // Sin ella cualquiera puede postear "pago aprobado" a nuestro endpoint.
    const r = envSchema.safeParse({
      ...VALID,
      PAYMENTS_SPIKE_ENABLED: 'true',
      MP_ACCESS_TOKEN: MP.MP_ACCESS_TOKEN,
      MP_PUBLIC_KEY: MP.MP_PUBLIC_KEY,
    });
    expect(r.success).toBe(false);
  });

  it('⛔ rechaza un token PRODUCTIVO de Mercado Pago fuera de production', () => {
    // El accidente más caro posible: cobrarle de verdad a alguien probando.
    const r = envSchema.safeParse({
      ...VALID,
      NODE_ENV: 'development',
      PAYMENTS_SPIKE_ENABLED: 'true',
      ...MP,
      MP_ACCESS_TOKEN: 'APP_USR-1234567890-produccion-de-verdad',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.message.includes('TEST-'))).toBe(true);
  });

  it('⛔ rechaza PAYMENTS_SPIKE_ENABLED en production', () => {
    const r = envSchema.safeParse({
      ...VALID,
      NODE_ENV: 'production',
      PAYMENTS_SPIKE_ENABLED: 'true',
      ...MP,
    });
    expect(r.success).toBe(false);
  });

  it('acepta el spike de pagos con credenciales de prueba completas', () => {
    const r = envSchema.safeParse({ ...VALID, PAYMENTS_SPIKE_ENABLED: 'true', ...MP });
    expect(r.success).toBe(true);
    expect(r.data?.MP_API_BASE_URL).toBe('https://api.mercadopago.com');
  });

  it('trata una variable vacía como ausente, no como valor inválido', () => {
    // `MP_ACCESS_TOKEN=` en el .env entrega "" y no undefined. Sin este
    // tratamiento el proceso no arranca y culpa a la longitud del token,
    // cuando lo que pasa es que todavía no se completó.
    const r = envSchema.safeParse({
      ...VALID,
      MP_ACCESS_TOKEN: '',
      MP_PUBLIC_KEY: '',
      MP_WEBHOOK_SECRET: '',
      MP_NOTIFICATION_URL: '',
    });
    expect(r.success).toBe(true);
    expect(r.data?.MP_ACCESS_TOKEN).toBeUndefined();
  });

  it('⛔ pero sigue rechazando un valor corto de verdad', () => {
    const r = envSchema.safeParse({ ...VALID, MP_ACCESS_TOKEN: 'TEST-corto' });
    expect(r.success).toBe(false);
  });

  // ─── Booleanos ────────────────────────────────────────────────────────────

  describe('interruptores booleanos', () => {
    it('⛔ "false" apaga de verdad', () => {
      // El bug que motivó `envBoolean`: `z.coerce.boolean()` hace
      // Boolean("false"), que es true. El interruptor maestro que impide
      // exponer endpoints sin autenticación no apagaba nada.
      const r = envSchema.parse({ ...VALID, SPIKE_ENABLED: 'false' });
      expect(r.SPIKE_ENABLED).toBe(false);
    });

    it('⛔ y "false" tampoco enciende el spike de pagos', () => {
      const r = envSchema.parse({ ...VALID, PAYMENTS_SPIKE_ENABLED: 'false' });
      expect(r.PAYMENTS_SPIKE_ENABLED).toBe(false);
    });

    it('acepta las grafías habituales', () => {
      for (const v of ['true', 'TRUE', 'True', '1', 'yes', 'on']) {
        expect(envSchema.parse({ ...VALID, METRICS_ENABLED: v }).METRICS_ENABLED, v).toBe(true);
      }
      for (const v of ['false', 'FALSE', '0', 'no', 'off', '']) {
        expect(envSchema.parse({ ...VALID, METRICS_ENABLED: v }).METRICS_ENABLED, v).toBe(false);
      }
    });

    it('respeta el valor por defecto cuando la variable no está', () => {
      const r = envSchema.parse(VALID);
      expect(r.METRICS_ENABLED).toBe(true);
      expect(r.SPIKE_ENABLED).toBe(false);
    });

    it('⛔ rechaza un valor que no es booleano en vez de adivinar', () => {
      // "si" parece razonable y no lo es. Mejor que el proceso avise a que
      // interprete algo distinto de lo que quiso decir quien lo escribió.
      const r = envSchema.safeParse({ ...VALID, SPIKE_ENABLED: 'si' });
      expect(r.success).toBe(false);
    });
  });
});
