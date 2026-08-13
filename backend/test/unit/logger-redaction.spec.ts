import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { REDACT_PATHS } from '../../src/shared/observability/logger.config';

/**
 * El comentario de `logger.config.ts` prometía este test desde el Sprint 0 y no
 * existía. Con datos de tarjeta circulando por el backend, un log con un PAN
 * adentro deja de ser un descuido y pasa a ser un incidente de cumplimiento.
 *
 * Se instancia un pino real con la MISMA lista de redacción que usa la
 * aplicación y se le tiran encima los datos que jamás deben salir.
 */

function capturar(): { logger: pino.Logger; salida: () => string } {
  let buffer = '';
  const destino = new Writable({
    write(chunk, _enc, cb) {
      buffer += String(chunk);
      cb();
    },
  });
  const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTADO]' } }, destino);
  return { logger, salida: () => buffer };
}

describe('redacción de logs', () => {
  it('tapa las credenciales de la aplicación', () => {
    const { logger, salida } = capturar();
    logger.info({
      req: {
        headers: {
          authorization: 'Bearer secreto-de-verdad',
          cookie: 'session=abc123',
          'x-spike-key': 'clave-del-spike',
        },
      },
    });

    const out = salida();
    expect(out).not.toContain('secreto-de-verdad');
    expect(out).not.toContain('session=abc123');
    expect(out).not.toContain('clave-del-spike');
    expect(out).toContain('[REDACTADO]');
  });

  it('⛔ tapa los datos de tarjeta de Mercado Pago', () => {
    const { logger, salida } = capturar();
    logger.info({
      msg: 'respuesta de Mercado Pago',
      pago: {
        token: 'token-de-tarjeta-de-un-solo-uso',
        card_number: '4509953566233704',
        security_code: '123',
        first_six_digits: '450995',
        cardholder: { name: 'JUAN PEREZ' },
        identification: { type: 'DNI', number: '30111222' },
      },
    });

    const out = salida();
    expect(out).not.toContain('4509953566233704');
    expect(out).not.toContain('token-de-tarjeta-de-un-solo-uso');
    expect(out).not.toContain('450995');
    expect(out).not.toContain('JUAN PEREZ');
    expect(out).not.toContain('30111222');
  });

  it('no tapa lo que sí necesitamos ver', () => {
    // Una redacción demasiado agresiva deja los logs inservibles, que es otra
    // forma de no tener logs.
    const { logger, salida } = capturar();
    logger.info({
      pago: { id: 123456789, status: 'approved', last_four_digits: '4242' },
      orderId: 'ord_01ABC',
    });

    const out = salida();
    expect(out).toContain('approved');
    expect(out).toContain('4242');
    expect(out).toContain('ord_01ABC');
  });
});
