import { describe, expect, it } from 'vitest';

import { scrubMpPayment } from '../../src/modules/payments/mp.client';

/**
 * Respuesta de Mercado Pago recortada a los campos que importan para esta
 * prueba, con la forma real que tiene el objeto `card`.
 */
const RESPUESTA_MP = {
  id: 123456789,
  status: 'approved',
  status_detail: 'accredited',
  transaction_amount: 1500,
  external_reference: 'ord_01ABC',
  token: 'a1b2c3d4e5f6-token-de-un-solo-uso',
  card: {
    id: '1234567',
    last_four_digits: '4242',
    first_six_digits: '450995',
    expiration_month: 11,
    expiration_year: 2030,
    cardholder: {
      name: 'JUAN PEREZ',
      // Valor deliberadamente distinto del id de pago: si fuera substring de
    // otro campo, la prueba de serialización daría un falso positivo.
    identification: { type: 'DNI', number: '30111222' },
    },
  },
  payer: {
    id: '987654',
    email: 'comprador@test.com',
    // Valor deliberadamente distinto del id de pago: si fuera substring de
    // otro campo, la prueba de serialización daría un falso positivo.
    identification: { type: 'DNI', number: '30111222' },
  },
  additional_info: {
    payer: { first_name: 'Juan', last_name: 'Perez', phone: { number: '1155556666' } },
  },
};

describe('scrubMpPayment', () => {
  const limpio = scrubMpPayment(RESPUESTA_MP);

  it('conserva lo que la aplicación necesita', () => {
    expect(limpio.id).toBe(123456789);
    expect(limpio.status).toBe('approved');
    expect(limpio.status_detail).toBe('accredited');
    expect(limpio.external_reference).toBe('ord_01ABC');
    expect((limpio.card as Record<string, unknown>).last_four_digits).toBe('4242');
  });

  it('⛔ borra el token de la tarjeta', () => {
    expect(limpio.token).toBeUndefined();
  });

  it('⛔ borra el BIN', () => {
    // Últimos cuatro + BIN reduce mucho el espacio de búsqueda de un PAN, y
    // no lo necesitamos para nada.
    expect((limpio.card as Record<string, unknown>).first_six_digits).toBeUndefined();
  });

  it('⛔ borra el titular y su documento', () => {
    expect((limpio.card as Record<string, unknown>).cardholder).toBeUndefined();
    expect((limpio.payer as Record<string, unknown>).identification).toBeUndefined();
    expect((limpio.additional_info as Record<string, unknown>).payer).toBeUndefined();
  });

  it('no muta el objeto original', () => {
    // Si mutara, el saneado para el log rompería el objeto que la lógica de
    // negocio todavía tiene que leer.
    expect(RESPUESTA_MP.token).toBe('a1b2c3d4e5f6-token-de-un-solo-uso');
    expect(RESPUESTA_MP.card.cardholder.name).toBe('JUAN PEREZ');
  });

  it('el resultado serializado no contiene ningún dato sensible', () => {
    // Red de seguridad: si mañana alguien agrega un campo anidado con el DNI,
    // esta prueba lo caza aunque nadie haya actualizado SENSITIVE_PATHS.
    const json = JSON.stringify(limpio);
    expect(json).not.toContain('30111222');
    expect(json).not.toContain('JUAN PEREZ');
    expect(json).not.toContain('450995');
    expect(json).not.toContain('token-de-un-solo-uso');
    expect(json).not.toContain('1155556666');
  });

  it('no explota con entradas raras', () => {
    expect(scrubMpPayment(null)).toEqual({});
    expect(scrubMpPayment('texto')).toEqual({});
    expect(scrubMpPayment({ card: null })).toEqual({ card: null });
  });
});
