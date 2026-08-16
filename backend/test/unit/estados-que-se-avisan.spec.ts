import { describe, expect, it } from 'vitest';

import {
  ESTADOS_QUE_AVISAN,
  avisoDeEstado,
  esEstadoQueSeAvisa,
} from '@/modules/notifications/estados-que-se-avisan';

/**
 * Qué estados de un pedido merecen un aviso.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AVISAR DE MÁS ES PERDER LOS QUE IMPORTAN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La máquina de estados tiene once. Avisar los once convierte una compra en
 * once vibraciones, y a la tercera la persona apaga la categoría — con lo cual
 * se pierden también las que sí importaban.
 *
 * El criterio es uno: ¿esto cambia algo para quien está esperando?
 */

describe('Los estados que avisan', () => {
  it('son exactamente cuatro', () => {
    // Si esta lista crece, que sea una decisión y no un descuido.
    expect(ESTADOS_QUE_AVISAN.sort()).toEqual(
      ['DELIVERED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED'].sort(),
    );
  });

  it('los cuatro tienen texto', () => {
    for (const estado of ESTADOS_QUE_AVISAN) {
      const texto = avisoDeEstado(estado);
      expect(texto?.title, estado).toBeTruthy();
      expect(texto?.body, estado).toBeTruthy();
    }
  });

  it('⛔ los estados de PAGO no avisan por acá', () => {
    /**
     * Los cubren `PAYMENT_APPROVED` y `PAYMENT_REJECTED`, que además llevan el
     * motivo. Avisar los dos manda dos notificaciones por lo mismo con treinta
     * segundos de diferencia.
     */
    for (const estado of ['PAID', 'CONFIRMED', 'PAYMENT_FAILED', 'PROCESSING_PAYMENT']) {
      expect(esEstadoQueSeAvisa(estado), estado).toBe(false);
    }
  });

  it('⛔ los estados que la persona está mirando tampoco', () => {
    // Está con la pantalla del checkout abierta mientras pasan.
    expect(esEstadoQueSeAvisa('PENDING_PAYMENT')).toBe(false);
  });

  it('⛔ cancelado y vencido quedan afuera a propósito', () => {
    /**
     * Merecen aviso, pero con un texto que depende de QUIÉN canceló y por qué.
     * Un «tu pedido fue cancelado» genérico, sin motivo, es exactamente la
     * clase de aviso que genera un ticket de soporte en vez de resolverlo.
     */
    for (const estado of ['CANCELLED', 'EXPIRED', 'REFUNDED']) {
      expect(esEstadoQueSeAvisa(estado), estado).toBe(false);
    }
  });

  it('⛔ un estado inventado no avisa', () => {
    expect(esEstadoQueSeAvisa('ALGO_NUEVO')).toBe(false);
    expect(avisoDeEstado('ALGO_NUEVO')).toBeNull();
  });

  it('⛔ ningún texto puede llevar datos personales', () => {
    /**
     * Un aviso se lee en la pantalla bloqueada de un teléfono que puede estar
     * sobre una mesa.
     *
     * ⚠️ La comprobación es que los textos sean CONSTANTES, no que eviten
     * ciertas palabras. «Sale para tu dirección» nombra la palabra y no filtra
     * nada; lo que filtraría es interpolar un valor. Sin marcadores de
     * interpolación no hay forma de que entre el dato de nadie.
     *
     * Lo que sí se prohíbe por palabra es el código de entrega y los importes:
     * son los dos que, si alguien los agregara, entrarían como texto fijo mal
     * pensado antes que como interpolación.
     */
    for (const estado of ESTADOS_QUE_AVISAN) {
      const texto = JSON.stringify(avisoDeEstado(estado));

      // Son literales del módulo: no hay dónde meter un valor.
      expect(texto, estado).not.toContain('${');

      for (const prohibido of ['código de entrega', 'dni', '$ ']) {
        expect(texto.toLowerCase(), `${estado} · ${prohibido}`).not.toContain(prohibido);
      }
    }
  });

  it('el texto está escrito desde quien espera, no desde el sistema', () => {
    // El estado interno se llama READY_TO_SHIP; lo que la persona necesita
    // leer es que está listo.
    expect(avisoDeEstado('READY_TO_SHIP')?.title.toLowerCase()).not.toContain('ready');
    expect(avisoDeEstado('SHIPPED')?.title.toLowerCase()).toContain('camino');
  });
});
