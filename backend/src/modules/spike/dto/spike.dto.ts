import { z } from 'zod';

// =============================================================================
// Contratos del módulo de spike. Zod es la fuente de verdad: de acá salen la
// validación en runtime y los tipos de TypeScript, sin duplicar nada.
// =============================================================================

export const NetworkTypeSchema = z.enum([
  'WIFI',
  'CELLULAR_5G',
  'CELLULAR_4G',
  'CELLULAR_3G',
  'UNKNOWN',
]);

export const SpikeRoleSchema = z.enum(['BROADCASTER', 'VIEWER']);

export const DeviceInfoSchema = z.object({
  model: z.string().max(120),
  os: z.string().max(60),
  osVersion: z.string().max(40),
  appVersion: z.string().max(40),
  /// Sin esto no se puede distinguir "LiveKit anda mal" de "los Android
  /// de gama baja no dan abasto para codificar 1080p".
  isPhysicalDevice: z.boolean().default(true),
});

// ─── POST /spike/sessions ────────────────────────────────────────────────────
export const CreateSessionSchema = z.object({
  label: z.string().min(3).max(120),
  carrier: z.string().max(60).optional(),
  networkType: NetworkTypeSchema.default('UNKNOWN'),
  locationNote: z.string().max(200).optional(),
  device: DeviceInfoSchema.optional(),
  notes: z.string().max(1000).optional(),
}).strict();
export type CreateSessionDto = z.infer<typeof CreateSessionSchema>;

// ─── POST /spike/token ───────────────────────────────────────────────────────
export const IssueTokenSchema = z.object({
  sessionId: z.string().startsWith('spk_'),
  role: SpikeRoleSchema,
  /// Identidad legible: aparece en el panel de LiveKit y hace depurable
  /// una sesión de campo con 4 teléfonos conectados.
  identity: z.string().min(2).max(60).regex(/^[a-zA-Z0-9_-]+$/),
  displayName: z.string().max(60).optional(),
  device: DeviceInfoSchema.optional(),
}).strict();
export type IssueTokenDto = z.infer<typeof IssueTokenSchema>;

// ─── GET /spike/time ─────────────────────────────────────────────────────────
export const TimeSyncQuerySchema = z.object({
  /// Reloj del cliente al enviar, en ms. Se devuelve tal cual para que el
  /// cliente calcule el RTT sin depender de su propio registro.
  clientSentAtMs: z.coerce.number().int().nonnegative().optional(),
});
export type TimeSyncQueryDto = z.infer<typeof TimeSyncQuerySchema>;

// ─── POST /spike/samples ─────────────────────────────────────────────────────
export const SampleSchema = z.object({
  seq: z.number().int().nonnegative(),
  /// Instante en el reloj DEL SERVIDOR, ya corregido por el offset que el
  /// cliente calculó. Comparar relojes crudos de dos teléfonos no significa nada.
  atMs: z.number().int().positive(),

  probeLatencyMs: z.number().int().min(-5_000).max(60_000).nullish(),

  rttMs: z.number().int().min(0).max(60_000).nullish(),
  jitterMs: z.number().int().min(0).max(60_000).nullish(),
  packetsLost: z.number().int().min(0).nullish(),
  packetLossPct: z.number().min(0).max(100).nullish(),
  jitterBufferDelayMs: z.number().int().min(0).max(60_000).nullish(),
  framesDecoded: z.number().int().min(0).nullish(),
  framesDropped: z.number().int().min(0).nullish(),
  freezeCount: z.number().int().min(0).nullish(),
  bitrateKbps: z.number().int().min(0).max(100_000).nullish(),
  fps: z.number().min(0).max(240).nullish(),
  frameWidth: z.number().int().min(0).max(8_000).nullish(),
  frameHeight: z.number().int().min(0).max(8_000).nullish(),
  videoLayer: z.string().max(20).nullish(),

  connectionQuality: z.enum(['excellent', 'good', 'poor', 'lost', 'unknown']).nullish(),
  networkType: NetworkTypeSchema.default('UNKNOWN'),
  carrier: z.string().max(60).nullish(),
  clockOffsetMs: z.number().int().min(-600_000).max(600_000).nullish(),
}).strict();

export const IngestSamplesSchema = z.object({
  sessionId: z.string().startsWith('spk_'),
  role: SpikeRoleSchema,
  /// Lote. Un teléfono manda 10 muestras cada 10 s, no una petición por segundo:
  /// con 4 dispositivos en campo eso serían 4 req/s solo de telemetría.
  samples: z.array(SampleSchema).min(1).max(120),
}).strict();
export type IngestSamplesDto = z.infer<typeof IngestSamplesSchema>;

// ─── POST /spike/events ──────────────────────────────────────────────────────
export const SpikeEventTypeSchema = z.enum([
  'SESSION_START',
  'ROOM_CONNECTING',
  'ROOM_CONNECTED',
  'ROOM_RECONNECTING',
  'ROOM_RECONNECTED',
  'ROOM_DISCONNECTED',
  'TRACK_PUBLISHED',
  'TRACK_SUBSCRIBED',
  'TRACK_UNSUBSCRIBED',
  'FIRST_FRAME',
  'NETWORK_CHANGED',
  'QUALITY_CHANGED',
  'ERROR',
  'SESSION_END',
]);

export const IngestEventsSchema = z.object({
  sessionId: z.string().startsWith('spk_'),
  role: SpikeRoleSchema,
  events: z.array(
    z.object({
      type: SpikeEventTypeSchema,
      atMs: z.number().int().positive(),
      /// Para ROOM_RECONNECTED es el tiempo de reconexión; para FIRST_FRAME,
      /// el time-to-first-frame. Son los dos números de UX que más importan.
      durationMs: z.number().int().min(0).max(600_000).nullish(),
      detail: z.record(z.unknown()).nullish(),
    }),
  ).min(1).max(100),
}).strict();
export type IngestEventsDto = z.infer<typeof IngestEventsSchema>;

// ─── POST /spike/glass-to-glass ──────────────────────────────────────────────
export const GlassToGlassSchema = z.object({
  sessionId: z.string().startsWith('spk_'),
  /// Medición manual: reloj del overlay menos reloj visible dentro del video.
  /// Es la referencia de verdad contra la que se calibra la estimación.
  latencyMs: z.number().int().min(0).max(60_000),
  method: z.string().max(40).default('overlay_photo'),
  networkType: NetworkTypeSchema.default('UNKNOWN'),
  carrier: z.string().max(60).optional(),
  photoRef: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
}).strict();
export type GlassToGlassDto = z.infer<typeof GlassToGlassSchema>;

// ─── POST /spike/sessions/:id/end ────────────────────────────────────────────
export const EndSessionSchema = z.object({
  notes: z.string().max(1000).optional(),
}).strict();
export type EndSessionDto = z.infer<typeof EndSessionSchema>;
