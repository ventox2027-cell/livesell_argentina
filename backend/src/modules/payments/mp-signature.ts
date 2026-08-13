import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verificación de la firma de los webhooks de Mercado Pago.
 *
 * ─── El formato ───
 *
 * Mercado Pago manda dos encabezados:
 *
 *   x-signature:  ts=1704908010,v1=618c8534...a5e839
 *   x-request-id: 5f1a2b3c-...
 *
 * y el id del recurso viaja en la QUERY STRING de la URL de notificación
 * (`?data.id=123456`), no en el cuerpo. Con esas tres piezas se arma un
 * manifiesto y se calcula un HMAC-SHA256 en hexadecimal con la clave secreta
 * del panel:
 *
 *   id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 *
 * Si alguno de los valores no viene, su segmento se omite entero del
 * manifiesto — no se deja vacío.
 *
 * ─── Por qué esto no es la última línea de defensa ───
 *
 * Es la primera, y es barata, pero la defensa real es que el estado del pago
 * NUNCA se toma del cuerpo del webhook: se consulta contra la API de Mercado
 * Pago con nuestro access token. Aun con una firma válida, el cuerpo es un
 * dato no confiable. Ver el comentario de cabecera del schema.
 *
 * ─── Las tres trampas conocidas ───
 *
 * 1. Los ids alfanuméricos van en MINÚSCULA en el manifiesto. Los ids
 *    numéricos de pagos no se ven afectados, así que el error aparece recién
 *    en producción con otro tipo de recurso.
 * 2. Hay plataformas de hosting que PISAN el `x-request-id` entrante. Si eso
 *    pasa, la firma jamás va a validar y el síntoma es indistinguible de una
 *    clave mal configurada. Por eso `reason` distingue los casos.
 * 3. `data.id` sale de la query string. Tomarlo del cuerpo funciona en las
 *    pruebas del simulador y falla con las notificaciones reales.
 */

/**
 * Coerción a texto de un valor que viene de un cuerpo JSON no confiable.
 *
 * `String(valor)` sobre un objeto devuelve `"[object Object]"`, y eso terminaría
 * escrito como `topic` en la base sin que nadie se entere. Sólo se aceptan
 * primitivos; cualquier otra cosa es `undefined`, que el código de arriba ya
 * sabe manejar.
 */
export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return undefined;
}

export interface SignatureInput {
  /** Encabezado `x-signature` crudo. */
  xSignature: string | undefined;
  /** Encabezado `x-request-id` crudo. */
  xRequestId: string | undefined;
  /** `data.id` de la query string. */
  dataId: string | undefined;
  secret: string;
  /** Reloj inyectable: los tests no pueden depender de la hora real. */
  nowMs?: number;
  /**
   * Ventana de tolerancia. Protege contra reenvío de una notificación
   * capturada: una firma vieja sigue siendo válida criptográficamente para
   * siempre, así que sin esto un atacante que consiga una notificación puede
   * repetirla cuando quiera.
   */
  toleranceMs?: number;
}

export type SignatureRejection =
  | 'MISSING_SIGNATURE'
  | 'MALFORMED_SIGNATURE'
  | 'MISSING_TIMESTAMP'
  | 'MISSING_HASH'
  | 'MISSING_REQUEST_ID'
  | 'MISSING_DATA_ID'
  | 'STALE_TIMESTAMP'
  | 'HASH_MISMATCH'
  | 'NO_SECRET_CONFIGURED';

export interface SignatureResult {
  valid: boolean;
  reason?: SignatureRejection;
  /** Manifiesto usado. Se registra para poder depurar sin exponer la clave. */
  manifest?: string;
  ageMs?: number;
}

/** Cinco minutos: holgado para reintentos legítimos, corto para un ataque. */
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1_000;

/**
 * Los ids alfanuméricos se normalizan a minúscula; los numéricos quedan igual.
 * Es la regla de Mercado Pago, y es la trampa que se cobra más integraciones.
 */
function canonicalId(id: string): string {
  return /^[0-9]+$/.test(id) ? id : id.toLowerCase();
}

/** `ts=123,v1=abc` → `{ ts: '123', v1: 'abc' }`, tolerante a espacios. */
export function parseSignatureHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function buildManifest(params: {
  dataId?: string;
  requestId?: string;
  ts: string;
}): string {
  // El orden es fijo y los segmentos ausentes se omiten completos.
  const parts: string[] = [];
  if (params.dataId) parts.push(`id:${canonicalId(params.dataId)};`);
  if (params.requestId) parts.push(`request-id:${params.requestId};`);
  parts.push(`ts:${params.ts};`);
  return parts.join('');
}

/** Comparación en tiempo constante: `===` filtra la clave carácter a carácter. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function verifyMpSignature(input: SignatureInput): SignatureResult {
  const { xSignature, xRequestId, dataId, secret } = input;
  const toleranceMs = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const nowMs = input.nowMs ?? Date.now();

  // Sin clave configurada NO se acepta nada. El modo "si no hay secreto, dejá
  // pasar" es cómodo en desarrollo y catastrófico si llega a producción.
  if (!secret) return { valid: false, reason: 'NO_SECRET_CONFIGURED' };
  if (!xSignature) return { valid: false, reason: 'MISSING_SIGNATURE' };

  const parts = parseSignatureHeader(xSignature);
  if (Object.keys(parts).length === 0) return { valid: false, reason: 'MALFORMED_SIGNATURE' };

  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts) return { valid: false, reason: 'MISSING_TIMESTAMP' };
  if (!v1) return { valid: false, reason: 'MISSING_HASH' };

  // Mercado Pago manda el ts en segundos; se acepta también en milisegundos
  // por si cambia, detectándolo por la magnitud.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { valid: false, reason: 'MISSING_TIMESTAMP' };
  const tsMs = tsNum > 1e12 ? tsNum : tsNum * 1_000;
  const ageMs = Math.abs(nowMs - tsMs);

  const manifest = buildManifest({ dataId, requestId: xRequestId, ts });

  // La firma se comprueba SIEMPRE, incluso si el timestamp está vencido: así
  // el motivo del rechazo distingue "notificación vieja" (reenvío, o reloj
  // desincronizado) de "firma falsa", que son dos incidentes distintos.
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');
  if (!safeEqualHex(expected, v1)) {
    // Un `x-request-id` faltante o pisado por el hosting es la causa más común
    // y la más difícil de diagnosticar: se nombra explícitamente.
    if (!xRequestId) return { valid: false, reason: 'MISSING_REQUEST_ID', manifest, ageMs };
    if (!dataId) return { valid: false, reason: 'MISSING_DATA_ID', manifest, ageMs };
    return { valid: false, reason: 'HASH_MISMATCH', manifest, ageMs };
  }

  if (ageMs > toleranceMs) return { valid: false, reason: 'STALE_TIMESTAMP', manifest, ageMs };

  return { valid: true, manifest, ageMs };
}

/**
 * Sólo para diagnóstico fuera de producción: dice cuál de las variantes
 * habituales SÍ habría validado.
 *
 * Convierte "la firma no valida" —que puede llevar un día de depuración— en
 * "el hosting te está pisando el x-request-id". No relaja la verificación:
 * el resultado de `verifyMpSignature` no cambia, esto sólo explica el fallo.
 */
export function diagnoseSignature(input: SignatureInput): string[] {
  const { xSignature, xRequestId, dataId, secret } = input;
  if (!xSignature || !secret) return [];
  const parts = parseSignatureHeader(xSignature);
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return [];

  const candidates: Array<[string, string]> = [
    ['canónico', buildManifest({ dataId, requestId: xRequestId, ts })],
    ['sin request-id', buildManifest({ dataId, ts })],
    ['sin data.id', buildManifest({ requestId: xRequestId, ts })],
    ['sólo ts', buildManifest({ ts })],
  ];
  if (dataId && canonicalId(dataId) !== dataId) {
    candidates.push([
      'data.id sin pasar a minúscula',
      `id:${dataId};${xRequestId ? `request-id:${xRequestId};` : ''}ts:${ts};`,
    ]);
  }

  return candidates
    .filter(([, manifest]) =>
      safeEqualHex(createHmac('sha256', secret).update(manifest).digest('hex'), v1),
    )
    .map(([name]) => name);
}
