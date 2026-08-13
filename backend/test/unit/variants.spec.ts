import { describe, expect, it } from 'vitest';

import {
  calcularOptionsKey,
  generarCombinaciones,
  KEY_DEFAULT,
  TITULO_DEFAULT,
  tituloDeVariante,
  validarCombinacion,
  type OpcionConValores,
} from '../../src/modules/commerce/variants';

const COLOR: OpcionConValores = {
  optionId: 'opt_color',
  name: 'Color',
  position: 0,
  values: [
    { id: 'opv_negro', value: 'Negro', position: 0 },
    { id: 'opv_blanco', value: 'Blanco', position: 1 },
  ],
};

const TALLE: OpcionConValores = {
  optionId: 'opt_talle',
  name: 'Talle',
  position: 1,
  values: [
    { id: 'opv_s', value: 'S', position: 0 },
    { id: 'opv_m', value: 'M', position: 1 },
    { id: 'opv_l', value: 'L', position: 2 },
  ],
};

describe('calcularOptionsKey', () => {
  it('⛔ el mismo conjunto en otro orden da la MISMA huella', () => {
    // Sin ordenar, el índice UNIQUE dejaría entrar dos veces la misma
    // combinación: el producto tendría dos "Negro / M", cada una con su propio
    // stock, y el inventario nunca cerraría.
    expect(calcularOptionsKey(['opv_negro', 'opv_m'])).toBe(
      calcularOptionsKey(['opv_m', 'opv_negro']),
    );
  });

  it('combinaciones distintas dan huellas distintas', () => {
    expect(calcularOptionsKey(['opv_negro', 'opv_m'])).not.toBe(
      calcularOptionsKey(['opv_negro', 'opv_l']),
    );
  });

  it('sin opciones usa la huella por defecto', () => {
    expect(calcularOptionsKey([])).toBe(KEY_DEFAULT);
  });
});

describe('generarCombinaciones', () => {
  it('un producto sin opciones genera UNA variante por defecto', () => {
    // Es lo que unifica el inventario: nunca hay stock de producto y stock de
    // variante como dos cosas distintas.
    const r = generarCombinaciones([]);
    expect(r).toHaveLength(1);
    expect(r[0]!.title).toBe(TITULO_DEFAULT);
    expect(r[0]!.optionValueIds).toEqual([]);
  });

  it('genera el producto cartesiano completo', () => {
    const r = generarCombinaciones([COLOR, TALLE]);
    expect(r).toHaveLength(6);
    expect(r.map((c) => c.title)).toEqual([
      'Negro / S',
      'Negro / M',
      'Negro / L',
      'Blanco / S',
      'Blanco / M',
      'Blanco / L',
    ]);
  });

  it('agrupa por el primer eje, no saltea', () => {
    // El vendedor cargó Color primero: espera ver los tres talles de negro
    // juntos, no alternados con los blancos.
    const titulos = generarCombinaciones([COLOR, TALLE]).map((c) => c.title);
    expect(titulos.slice(0, 3).every((t) => t.startsWith('Negro'))).toBe(true);
  });

  it('respeta el orden aunque las opciones lleguen desordenadas', () => {
    const r = generarCombinaciones([TALLE, COLOR]);
    // TALLE tiene position 1, COLOR position 0: el título arranca por color.
    expect(r[0]!.title).toBe('Negro / S');
  });

  it('con un solo eje da una variante por valor', () => {
    expect(generarCombinaciones([COLOR]).map((c) => c.title)).toEqual(['Negro', 'Blanco']);
  });

  it('todas las huellas son distintas', () => {
    const r = generarCombinaciones([COLOR, TALLE]);
    expect(new Set(r.map((c) => c.optionsKey)).size).toBe(r.length);
  });

  it('tres ejes también', () => {
    const capacidad: OpcionConValores = {
      optionId: 'opt_cap',
      name: 'Capacidad',
      position: 2,
      values: [
        { id: 'opv_128', value: '128GB', position: 0 },
        { id: 'opv_256', value: '256GB', position: 1 },
      ],
    };
    const r = generarCombinaciones([COLOR, TALLE, capacidad]);
    expect(r).toHaveLength(12);
    expect(r[0]!.title).toBe('Negro / S / 128GB');
  });
});

describe('tituloDeVariante', () => {
  it('arma el título en el orden de las opciones, no en el de los ids', () => {
    // Al crear una variante a mano los ids llegan sueltos. Si el título
    // saliera en ese orden, el mismo producto mostraría "Negro / M" en unas
    // variantes y "M / Negro" en otras.
    expect(tituloDeVariante(['opv_m', 'opv_negro'], [COLOR, TALLE])).toBe('Negro / M');
    expect(tituloDeVariante(['opv_negro', 'opv_m'], [COLOR, TALLE])).toBe('Negro / M');
  });

  it('sin valores devuelve el título por defecto', () => {
    expect(tituloDeVariante([], [])).toBe(TITULO_DEFAULT);
  });
});

describe('validarCombinacion', () => {
  it('acepta exactamente un valor por eje', () => {
    expect(validarCombinacion(['opv_negro', 'opv_m'], [COLOR, TALLE]).ok).toBe(true);
  });

  it('⛔ rechaza si falta un eje', () => {
    // Una variante sin talle en un producto con talles no se puede vender ni
    // contar: el comprador no sabe qué está comprando.
    const r = validarCombinacion(['opv_negro'], [COLOR, TALLE]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toContain('Talle');
  });

  it('⛔ rechaza dos valores del mismo eje', () => {
    const r = validarCombinacion(['opv_negro', 'opv_blanco', 'opv_m'], [COLOR, TALLE]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toContain('más de un valor');
  });

  it('⛔ rechaza un valor de OTRO producto', () => {
    // Es un intento de IDOR por la puerta de atrás: armar una variante con
    // valores que no son del producto.
    const r = validarCombinacion(['opv_de_otro_producto'], [COLOR]);
    expect(r.ok).toBe(false);
  });

  it('un producto sin opciones sólo acepta la combinación vacía', () => {
    expect(validarCombinacion([], []).ok).toBe(true);
    expect(validarCombinacion(['opv_negro'], []).ok).toBe(false);
  });
});
