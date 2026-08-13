import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Carga `.env` en process.env ANTES de validar.
 *
 * Va acá, en el módulo de configuración, y no en main.ts: cualquier entrypoint
 * —el servidor, los workers, los scripts de CLI, los tests— importa este
 * archivo, así que todos obtienen la configuración de la misma forma. Ponerlo
 * en main.ts haría que `pnpm spike:report` arrancara sin variables.
 *
 * En Fly.io no existe `.env` y las variables vienen inyectadas; dotenv no
 * encuentra el archivo, no hace nada, y `override: false` garantiza que jamás
 * pise una variable ya presente en el entorno.
 */
loadDotenv({ override: false });

/**
 * Variable opcional que además tolera la cadena vacía.
 *
 * `z.string().optional()` NO cubre `""`. Y un `.env` con
 *
 *     MP_ACCESS_TOKEN=
 *
 * no entrega `undefined` sino `""`, que falla contra cualquier `.min()` o
 * `.url()`. El resultado es un proceso que no arranca con un mensaje que
 * apunta a la variable equivocada — "debe tener 20 caracteres" cuando lo que
 * pasa es que está sin completar.
 *
 * Dejar los placeholders vacíos en el `.env` es lo normal mientras se esperan
 * credenciales, así que la configuración tiene que tratarlos como ausentes.
 */
function optionalOrEmpty<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

/**
 * Booleano de variable de entorno, en serio.
 *
 * ⛔ NO usar `z.coerce.boolean()`. Hace `Boolean(valor)`, y en JavaScript
 * `Boolean("false")` es **`true`**: cualquier texto no vacío da verdadero.
 *
 * El daño concreto que causó: `SPIKE_ENABLED=false` dejaba el módulo de spike
 * ENCENDIDO. El interruptor maestro que existe para que endpoints sin
 * autenticación de usuario no queden expuestos no apagaba nada, y la única
 * forma de desactivarlos era borrar la variable del archivo. Se descubrió por
 * casualidad; en producción se habría descubierto de la peor manera.
 *
 * Acá los valores son explícitos y cualquier otra cosa es un error de
 * configuración, no un valor que el código adivina. `FALSE`, `False` y `false`
 * valen lo mismo; `si`, `sí` y `enabled` no valen nada y el proceso lo dice.
 */
const VERDADEROS = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSOS = new Set(['false', '0', 'no', 'n', 'off', '']);

function envBoolean(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v, ctx) => {
      if (typeof v === 'boolean') return v;
      const normalizado = v.trim().toLowerCase();
      if (VERDADEROS.has(normalizado)) return true;
      if (FALSOS.has(normalizado)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `valor booleano inválido: "${v}". Usá true o false.`,
      });
      return z.NEVER;
    });
}

/**
 * Contrato de configuración del proceso.
 *
 * Se valida UNA sola vez, al arrancar. Si falta o está mal una variable, el
 * proceso muere con un mensaje legible ANTES de aceptar tráfico.
 *
 * Es deliberado: la alternativa es `process.env.X!` desperdigado por el código
 * y un fallo a las 3 de la mañana porque un secreto quedó vacío en un deploy.
 */
export const envSchema = z
  .object({
    // ─── Aplicación ─────────────────────────────────────────────────────────
    // 'test' está porque Vitest fuerza NODE_ENV=test y no podemos (ni queremos)
    // pisarlo: varias librerías cambian de comportamiento según ese valor.
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    GIT_SHA: z.string().default('unknown'),

    // ─── PostgreSQL ─────────────────────────────────────────────────────────
    DATABASE_URL: z.string().url().startsWith('postgres'),

    // ─── Redis ──────────────────────────────────────────────────────────────
    REDIS_URL: z.string().url(),

    // ─── LiveKit ────────────────────────────────────────────────────────────
    LIVEKIT_API_KEY: z.string().min(3),
    // El secreto de LiveKit firma los tokens. Nunca sale del backend.
    LIVEKIT_API_SECRET: z.string().min(16),
    LIVEKIT_WS_URL: z.string().url().startsWith('ws'),
    LIVEKIT_HTTP_URL: z.string().url().startsWith('http'),
    LIVEKIT_WEBHOOK_ENABLED: envBoolean(true),
    LIVEKIT_BROADCASTER_TOKEN_TTL_S: z.coerce.number().int().min(60).default(21_600),
    LIVEKIT_VIEWER_TOKEN_TTL_S: z.coerce.number().int().min(60).default(7_200),

    // ─── Spike (Sprint 0) ───────────────────────────────────────────────────
    SPIKE_ENABLED: envBoolean(false),
    SPIKE_API_KEY: optionalOrEmpty(z.string().min(16)),

    // ─── Mercado Pago (Sprint 0B) ───────────────────────────────────────────
    // El access token cobra dinero real si es de producción. Nunca sale del
    // backend, jamás llega a Flutter.
    MP_ACCESS_TOKEN: optionalOrEmpty(z.string().min(20)),
    // La public key SÍ va al cliente: es su función. Sólo sirve para tokenizar.
    MP_PUBLIC_KEY: optionalOrEmpty(z.string().min(20)),
    // Clave de firma de webhooks, del panel de Mercado Pago.
    MP_WEBHOOK_SECRET: optionalOrEmpty(z.string().min(8)),
    // URL pública a la que Mercado Pago manda las notificaciones. En el spike
    // es el túnel de Cloudflare; en staging, el dominio de Fly.
    MP_NOTIFICATION_URL: optionalOrEmpty(z.string().url()),
    MP_API_BASE_URL: z.string().url().default('https://api.mercadopago.com'),
    MP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    PAYMENTS_SPIKE_ENABLED: envBoolean(false),

    // ─── Observabilidad ─────────────────────────────────────────────────────
    SENTRY_DSN: z.string().url().optional().or(z.literal('')),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
    METRICS_ENABLED: envBoolean(true),
  })
  // El módulo de spike no tiene autenticación de usuarios porque Auth todavía
  // no existe. Se protege con una clave compartida, así que habilitarlo sin
  // clave sería dejar endpoints abiertos que crean salas de LiveKit.
  .refine((e) => !e.SPIKE_ENABLED || !!e.SPIKE_API_KEY, {
    message: 'SPIKE_ENABLED=true requiere SPIKE_API_KEY (generar con: openssl rand -hex 32)',
    path: ['SPIKE_API_KEY'],
  })
  // Salvaguarda explícita: el spike jamás debe quedar encendido en producción.
  .refine((e) => !(e.NODE_ENV === 'production' && e.SPIKE_ENABLED), {
    message: 'SPIKE_ENABLED debe ser false en production',
    path: ['SPIKE_ENABLED'],
  })
  // Igual que arriba: el spike de pagos no tiene Auth y mueve dinero.
  .refine((e) => !(e.NODE_ENV === 'production' && e.PAYMENTS_SPIKE_ENABLED), {
    message: 'PAYMENTS_SPIKE_ENABLED debe ser false en production',
    path: ['PAYMENTS_SPIKE_ENABLED'],
  })
  .refine(
    (e) =>
      !e.PAYMENTS_SPIKE_ENABLED ||
      (!!e.MP_ACCESS_TOKEN && !!e.MP_PUBLIC_KEY && !!e.MP_WEBHOOK_SECRET),
    {
      message:
        'PAYMENTS_SPIKE_ENABLED=true requiere MP_ACCESS_TOKEN, MP_PUBLIC_KEY y MP_WEBHOOK_SECRET',
      path: ['MP_ACCESS_TOKEN'],
    },
  )
  /**
   * Guardia contra el accidente más caro posible: cobrarle de verdad a alguien
   * durante una prueba. Las credenciales de prueba de Mercado Pago empiezan con
   * `TEST-`; las de producción, no. Fuera de producción exigimos las de prueba.
   */
  .refine(
    (e) =>
      e.NODE_ENV === 'production' ||
      !e.MP_ACCESS_TOKEN ||
      e.MP_ACCESS_TOKEN.startsWith('TEST-'),
    {
      message:
        'Fuera de production el MP_ACCESS_TOKEN debe ser de prueba (empieza con "TEST-"). ' +
        'Con un token productivo, cada spike cobra dinero real.',
      path: ['MP_ACCESS_TOKEN'],
    },
  );

export type Env = z.infer<typeof envSchema>;

/** Entornos donde se permite exponer detalles internos (stacks, logs verbosos). */
export function isLocalEnv(nodeEnv: Env['NODE_ENV']): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  · ${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('\n');
    // console.error y no el logger: el logger se configura DESPUÉS de validar
    // la configuración, así que acá todavía no existe.
    console.error(`\n✖ Configuración inválida. El proceso no puede arrancar:\n\n${details}\n`);
    process.exit(1);
  }

  cached = parsed.data;
  return cached;
}

/** Solo para tests: permite recargar la configuración entre casos. */
export function resetEnvCache(): void {
  cached = null;
}

export const env: Env = loadEnv();
