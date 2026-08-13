import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildManifest,
  diagnoseSignature,
  parseSignatureHeader,
  verifyMpSignature,
} from '../../src/modules/payments/mp-signature';

const SECRET = 'clave-secreta-de-prueba';
const NOW_MS = 1_760_000_000_000;
const TS = String(Math.floor(NOW_MS / 1_000));

function sign(manifest: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(manifest).digest('hex');
}

/** Arma un webhook legítimo, tal como lo mandaría Mercado Pago. */
function legit(overrides: Partial<Parameters<typeof verifyMpSignature>[0]> = {}) {
  const dataId = '123456789';
  const requestId = 'req-abc-123';
  const manifest = buildManifest({ dataId, requestId, ts: TS });
  return {
    xSignature: `ts=${TS},v1=${sign(manifest)}`,
    xRequestId: requestId,
    dataId,
    secret: SECRET,
    nowMs: NOW_MS,
    ...overrides,
  };
}

describe('parseSignatureHeader', () => {
  it('separa ts y v1', () => {
    expect(parseSignatureHeader('ts=1704908010,v1=abc123')).toEqual({
      ts: '1704908010',
      v1: 'abc123',
    });
  });

  it('tolera espacios alrededor de las comas', () => {
    expect(parseSignatureHeader('ts=111 , v1=def')).toEqual({ ts: '111', v1: 'def' });
  });

  it('no rompe con basura', () => {
    expect(parseSignatureHeader('')).toEqual({});
    expect(parseSignatureHeader('sinigual')).toEqual({});
  });
});

describe('buildManifest', () => {
  it('usa el orden y los separadores exactos de Mercado Pago', () => {
    expect(buildManifest({ dataId: '999', requestId: 'r1', ts: '123' })).toBe(
      'id:999;request-id:r1;ts:123;',
    );
  });

  it('omite el segmento entero cuando falta el valor', () => {
    // Dejarlo vacío (`id:;`) es el error clásico: produce un hash distinto.
    expect(buildManifest({ requestId: 'r1', ts: '123' })).toBe('request-id:r1;ts:123;');
    expect(buildManifest({ ts: '123' })).toBe('ts:123;');
  });

  it('pasa a minúscula los ids alfanuméricos y deja intactos los numéricos', () => {
    expect(buildManifest({ dataId: 'AbC-123', ts: '1' })).toBe('id:abc-123;ts:1;');
    expect(buildManifest({ dataId: '00123', ts: '1' })).toBe('id:00123;ts:1;');
  });
});

describe('verifyMpSignature', () => {
  it('acepta una notificación legítima', () => {
    const r = verifyMpSignature(legit());
    expect(r.valid).toBe(true);
    expect(r.manifest).toBe('id:123456789;request-id:req-abc-123;ts:' + TS + ';');
  });

  it('rechaza si cambia el id del recurso', () => {
    // El ataque directo: reusar una firma válida apuntando a otro pago.
    const r = verifyMpSignature(legit({ dataId: '987654321' }));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('HASH_MISMATCH');
  });

  it('rechaza con la clave equivocada', () => {
    const r = verifyMpSignature(legit({ secret: 'otra-clave' }));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('HASH_MISMATCH');
  });

  it('rechaza cuando no hay clave configurada', () => {
    // Nunca "si no hay secreto, dejá pasar".
    const r = verifyMpSignature(legit({ secret: '' }));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('NO_SECRET_CONFIGURED');
  });

  it('rechaza sin encabezado de firma', () => {
    expect(verifyMpSignature(legit({ xSignature: undefined })).reason).toBe('MISSING_SIGNATURE');
  });

  it('rechaza un encabezado sin v1', () => {
    expect(verifyMpSignature(legit({ xSignature: `ts=${TS}` })).reason).toBe('MISSING_HASH');
  });

  it('rechaza un encabezado sin ts', () => {
    expect(verifyMpSignature(legit({ xSignature: 'v1=deadbeef' })).reason).toBe(
      'MISSING_TIMESTAMP',
    );
  });

  it('rechaza una notificación vieja aunque la firma sea válida', () => {
    // Reenvío: la firma sigue siendo criptográficamente correcta para siempre.
    const r = verifyMpSignature(legit({ nowMs: NOW_MS + 10 * 60 * 1_000 }));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('STALE_TIMESTAMP');
  });

  it('acepta dentro de la ventana de tolerancia', () => {
    expect(verifyMpSignature(legit({ nowMs: NOW_MS + 4 * 60 * 1_000 })).valid).toBe(true);
  });

  it('tolera un reloj adelantado, no sólo atrasado', () => {
    expect(verifyMpSignature(legit({ nowMs: NOW_MS - 60_000 })).valid).toBe(true);
  });

  it('nombra la falta de x-request-id en vez de reportar un hash genérico', () => {
    // Es la falla que provoca el hosting que pisa el encabezado: si dijera
    // HASH_MISMATCH se buscaría el problema en la clave, que está bien.
    const r = verifyMpSignature(legit({ xRequestId: undefined }));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('MISSING_REQUEST_ID');
  });

  it('acepta ts en milisegundos si Mercado Pago llegara a cambiarlo', () => {
    const manifest = buildManifest({ dataId: '1', requestId: 'r', ts: String(NOW_MS) });
    const r = verifyMpSignature({
      xSignature: `ts=${NOW_MS},v1=${sign(manifest)}`,
      xRequestId: 'r',
      dataId: '1',
      secret: SECRET,
      nowMs: NOW_MS,
    });
    expect(r.valid).toBe(true);
  });

  it('no explota con un v1 que no es hexadecimal', () => {
    const r = verifyMpSignature(legit({ xSignature: `ts=${TS},v1=no-es-hex!!` }));
    expect(r.valid).toBe(false);
  });
});

describe('diagnoseSignature', () => {
  it('detecta que el hosting pisó el x-request-id', () => {
    // Mercado Pago firmó sin request-id; nosotros recibimos uno inventado por
    // el proxy. Sin este diagnóstico, el síntoma es un HASH_MISMATCH mudo.
    const firmadoSinRequestId = buildManifest({ dataId: '55', ts: TS });
    const input = {
      xSignature: `ts=${TS},v1=${sign(firmadoSinRequestId)}`,
      xRequestId: 'id-inventado-por-el-proxy',
      dataId: '55',
      secret: SECRET,
      nowMs: NOW_MS,
    };
    expect(verifyMpSignature(input).valid).toBe(false);
    expect(diagnoseSignature(input)).toContain('sin request-id');
  });

  it('no devuelve nada cuando la firma es simplemente falsa', () => {
    const input = legit({ xSignature: `ts=${TS},v1=${'0'.repeat(64)}` });
    expect(diagnoseSignature(input)).toEqual([]);
  });
});
