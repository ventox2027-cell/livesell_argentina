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

  it('⛔ tapa las credenciales del almacenamiento', () => {
    /**
     * El código nunca registra estas credenciales a propósito. El riesgo real
     * es otro: los errores del SDK de AWS traen la configuración completa del
     * cliente adentro, credenciales incluidas. Un `logger.error({ err })`
     * puesto sin pensar mientras se depura las volcaría enteras al log.
     */
    const { logger, salida } = capturar();
    logger.error({
      msg: 'falló la subida',
      err: {
        name: 'CredentialsProviderError',
        config: {
          endpoint: 'https://cuenta.r2.cloudflarestorage.com',
          credentials: {
            accessKeyId: 'AKIA-CLAVE-DE-ACCESO-REAL',
            secretAccessKey: 'el-secreto-que-jamas-debe-salir',
            sessionToken: 'token-de-sesion-temporal',
          },
        },
      },
    });

    const out = salida();
    expect(out).not.toContain('el-secreto-que-jamas-debe-salir');
    expect(out).not.toContain('AKIA-CLAVE-DE-ACCESO-REAL');
    expect(out).not.toContain('token-de-sesion-temporal');
    expect(out).toContain('[REDACTADO]');
  });

  it('⚠️ el comodín de pino matchea UN nivel: a más profundidad no protege', () => {
    /**
     * Este test documenta una limitación, no una garantía. Está escrito para
     * que la limitación sea visible en vez de sorpresiva.
     *
     * `*.token` tapa `{ pago: { token } }` y NO tapa
     * `{ err: { data: { token } } }`. Pino no tiene `**`.
     *
     * La consecuencia práctica: la redacción es la red debajo, no el plan. El
     * plan es no registrar objetos crudos de terceros —los errores de SDKs se
     * registran por `err.message`— y escribir la ruta completa cuando un dato
     * sensible pueda aparecer hondo.
     *
     * Si algún día pino soporta profundidad arbitraria, este test se va a poner
     * rojo. Eso sería una buena noticia y hay que borrarlo.
     */
    const { logger, salida } = capturar();
    logger.info({ err: { data: { anidado: { token: 'sobrevive-por-la-profundidad' } } } });

    expect(salida()).toContain('sobrevive-por-la-profundidad');
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

  it('la clave de un objeto de storage SÍ se ve: hace falta para encontrarlo', () => {
    // Un `storageKey` no es un secreto —sin firma no sirve para bajar nada— y
    // es el único dato con el que se rastrea una imagen huérfana.
    const { logger, salida } = capturar();
    logger.error({
      msg: 'objeto huérfano en R2',
      storageKey: 'products/prd_01ABC/4ca42b31-3aba-4f7d-b04f-22901f7da689.png',
    });

    expect(salida()).toContain('products/prd_01ABC');
  });
});
