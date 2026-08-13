import { describe, expect, it } from 'vitest';

import {
  describePaymentOutcome,
  extractCauseCodes,
  MENSAJE_INCIERTO,
} from '../../src/modules/payments/payment-messages';

/** Cuerpo de error tal como lo devuelve Mercado Pago. */
function errorMp(code: number, description: string) {
  return {
    message: description,
    error: 'bad_request',
    status: 400,
    cause: [{ code, description, data: '13-08-2026T07:51:22UTC;abc' }],
  };
}

describe('describePaymentOutcome', () => {
  it('traduce el error que apareció en la prueba de campo', () => {
    // El comprador vio "Rechazado: invalid card_number_validation", que es
    // correcto, preciso e inútil.
    const m = describePaymentOutcome({ errorBody: errorMp(3034, 'Invalid card_number_validation') });
    expect(m.text).toBe('Revisá el número de la tarjeta: parece que hay un número mal.');
    expect(m.remedy).toBe('CORREGIR_DATOS');
  });

  it('distingue número incompleto de número mal tipeado', () => {
    // Dos causas distintas y dos acciones distintas para la persona.
    expect(describePaymentOutcome({ errorBody: errorMp(3033, 'x') }).text).toContain('incompleto');
    expect(describePaymentOutcome({ errorBody: errorMp(3034, 'x') }).text).toContain('mal');
  });

  it('el token vencido no se le echa en cara a la persona', () => {
    // No hizo nada mal: el token dura poco por diseño.
    const m = describePaymentOutcome({ errorBody: errorMp(3003, 'Invalid card_token_id') });
    expect(m.text).toContain('sesión de pago venció');
    expect(m.remedy).toBe('CORREGIR_DATOS');
  });

  it('fondos insuficientes sugiere otra tarjeta, no reintentar', () => {
    // Reintentar con la misma tarjeta no puede funcionar. Ofrecerlo es
    // hacerle perder el tiempo a alguien que quiere comprar.
    const m = describePaymentOutcome({ statusDetail: 'cc_rejected_insufficient_amount' });
    expect(m.text).toContain('fondos');
    expect(m.remedy).toBe('OTRO_MEDIO');
  });

  it('el código de seguridad incorrecto sí es corregible', () => {
    const m = describePaymentOutcome({ statusDetail: 'cc_rejected_bad_filled_security_code' });
    expect(m.remedy).toBe('CORREGIR_DATOS');
  });

  it('“llamá a tu banco” es su propia categoría', () => {
    // No es corregible en la app ni se arregla con otra tarjeta: la persona
    // tiene que hacer algo afuera.
    expect(describePaymentOutcome({ statusDetail: 'cc_rejected_call_for_authorize' }).remedy).toBe(
      'CONTACTAR_BANCO',
    );
    expect(describePaymentOutcome({ statusDetail: 'cc_rejected_card_disabled' }).remedy).toBe(
      'CONTACTAR_BANCO',
    );
  });

  it('un pago pendiente no se presenta como un fallo', () => {
    const m = describePaymentOutcome({ statusDetail: 'pending_contingency' });
    expect(m.remedy).toBe('ESPERAR');
    expect(m.text).not.toMatch(/rechaz|error|fall/i);
  });

  it('el status_detail manda sobre las causas', () => {
    const m = describePaymentOutcome({
      statusDetail: 'cc_rejected_insufficient_amount',
      errorBody: errorMp(3034, 'x'),
    });
    expect(m.text).toContain('fondos');
  });

  it('ante algo desconocido da un mensaje honesto, no un código', () => {
    const m = describePaymentOutcome({ statusDetail: 'algo_que_no_existe_todavia' });
    expect(m.text).toBe('No se pudo completar el pago. Probá de nuevo o usá otra tarjeta.');
  });

  it('⛔ ningún mensaje filtra jerga interna', () => {
    // Es la razón de ser del módulo: nada de códigos ni nombres de campo.
    const casos = [
      { statusDetail: 'cc_rejected_insufficient_amount' },
      { statusDetail: 'cc_rejected_call_for_authorize' },
      { errorBody: errorMp(3034, 'Invalid card_number_validation') },
      { statusDetail: 'desconocido' },
    ];
    for (const caso of casos) {
      const t = describePaymentOutcome(caso).text;
      expect(t).not.toMatch(/cc_rejected|card_number|status_detail|_|[0-9]{4}/);
    }
    expect(MENSAJE_INCIERTO.text).not.toMatch(/_/);
  });

  it('el mensaje de incertidumbre NUNCA dice que se rechazó', () => {
    // Si dijera "rechazado" ante un timeout, la persona pagaría otra vez y
    // quedaría cobrada dos veces.
    expect(MENSAJE_INCIERTO.text).not.toMatch(/rechaz|fall/i);
    expect(MENSAJE_INCIERTO.remedy).toBe('ESPERAR');
  });
});

describe('extractCauseCodes', () => {
  it('saca los códigos del cuerpo de error', () => {
    expect(extractCauseCodes(errorMp(3034, 'x'))).toEqual(['3034']);
  });

  it('no explota con formas inesperadas', () => {
    expect(extractCauseCodes(null)).toEqual([]);
    expect(extractCauseCodes('texto')).toEqual([]);
    expect(extractCauseCodes({ cause: 'no es un array' })).toEqual([]);
    expect(extractCauseCodes({ cause: [{ sin: 'code' }] })).toEqual([]);
  });
});
