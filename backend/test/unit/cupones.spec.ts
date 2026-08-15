import { describe, expect, it } from 'vitest';

import {
  DESCUENTO_MINIMO_CENTAVOS,
  PORCENTAJE_MAXIMO,
  RESTO_MINIMO_CENTAVOS,
  calcularDescuento,
  exigirCuponValido,
  motivoDeRechazo,
  normalizarCodigo,
  type CuponGuardado,
} from '@/modules/commerce/cupones';
import { baseDeComision, calcularPrecio } from '@/modules/orders/pricing';

/**
 * Cupones.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL DESCUENTO SALE DEL BOLSILLO DEL VENDEDOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * VendoX no lo financia. Cada regla de acá existe para que un cupón no pueda
 * costarle al vendedor más de lo que él decidió arriesgar: el tope, el mínimo
 * de compra, el resto que siempre queda por pagar, el redondeo hacia abajo.
 *
 * Y para que VendoX no se quede con parte de su descuento: la comisión se cobra
 * sobre lo que se pagó.
 */

const AHORA = new Date('2026-08-15T21:00:00.000Z');
const enDias = (d: number) => new Date(AHORA.getTime() + d * 24 * 60 * 60 * 1000);

const BASE: CuponGuardado = {
  tipo: 'PORCENTAJE',
  valor: 20,
  minimoCentavos: null,
  topeCentavos: null,
  desde: null,
  hasta: null,
  usosMaximos: null,
  usos: 0,
  activo: true,
};

describe('El código', () => {
  it('se normaliza a mayúsculas y sin espacios', () => {
    // Quien lo tipea en el teclado del teléfono manda minúsculas y algún
    // espacio de más. Rechazarlo por eso sería perder la venta por un tipeo.
    expect(normalizarCodigo('  verano25 ')).toBe('VERANO25');
  });

  it('⛔ no se aceptan símbolos ni espacios al crear', () => {
    // Alguien va a tipearlo de memoria después de escucharlo en un vivo.
    expect(() =>
      exigirCuponValido({ codigo: 'VERANO 25', tipo: 'PORCENTAJE', valor: 20 }, AHORA),
    ).toThrow(/letras y números/);
  });

  it('⛔ demasiado corto, no', () => {
    expect(() => exigirCuponValido({ codigo: 'AB', tipo: 'PORCENTAJE', valor: 20 }, AHORA)).toThrow(
      /caracteres/,
    );
  });
});

describe('Lo que el vendedor puede cargar', () => {
  it('un cupón razonable se acepta', () => {
    expect(() =>
      exigirCuponValido(
        { codigo: 'VERANO25', tipo: 'PORCENTAJE', valor: 25, topeCentavos: 500_000 },
        AHORA,
      ),
    ).not.toThrow();
  });

  it('⛔ más del máximo no es un cupón, es regalar el producto', () => {
    expect(() =>
      exigirCuponValido(
        { codigo: 'GRATIS', tipo: 'PORCENTAJE', valor: PORCENTAJE_MAXIMO + 1 },
        AHORA,
      ),
    ).toThrow(/regalar/);
  });

  it('⛔ un monto fijo mayor o igual al mínimo de compra deja el producto gratis', () => {
    /**
     * «$5.000 de descuento con compra mínima de $5.000» da una orden de cero.
     * Se recorta al vender, pero el vendedor tiene que enterarse ahora y no
     * cuando mire las ventas.
     */
    expect(() =>
      exigirCuponValido(
        { codigo: 'CINCOMIL', tipo: 'MONTO_FIJO', valor: 500_000, minimoCentavos: 500_000 },
        AHORA,
      ),
    ).toThrow(/sale gratis/);
  });

  it('⛔ un tope sobre un monto fijo no significa nada', () => {
    expect(() =>
      exigirCuponValido(
        { codigo: 'FIJO', tipo: 'MONTO_FIJO', valor: 100_000, topeCentavos: 50_000 },
        AHORA,
      ),
    ).toThrow(/porcentaje/);
  });

  it('⛔ menos de un peso de descuento fijo es ruido', () => {
    expect(() =>
      exigirCuponValido(
        { codigo: 'CHIRO', tipo: 'MONTO_FIJO', valor: DESCUENTO_MINIMO_CENTAVOS - 1 },
        AHORA,
      ),
    ).toThrow(/mínimo/);
  });

  it('⛔ una ventana invertida se rechaza', () => {
    expect(() =>
      exigirCuponValido(
        {
          codigo: 'INVERTIDO',
          tipo: 'PORCENTAJE',
          valor: 10,
          desde: enDias(10),
          hasta: enDias(2),
        },
        AHORA,
      ),
    ).toThrow(/terminar después de empezar/);
  });

  it('⛔ crear algo ya vencido siempre es un error de tipeo', () => {
    expect(() =>
      exigirCuponValido(
        { codigo: 'VIEJO', tipo: 'PORCENTAJE', valor: 10, hasta: enDias(-1) },
        AHORA,
      ),
    ).toThrow(/ya estaría vencido/);
  });
});

describe('Si se puede usar', () => {
  it('uno normal, sí', () => {
    expect(motivoDeRechazo(BASE, 1_000_000, AHORA)).toBeNull();
  });

  it('⛔ pausado', () => {
    expect(motivoDeRechazo({ ...BASE, activo: false }, 1_000_000, AHORA)).toBe('PAUSADO');
  });

  it('⛔ vencido', () => {
    expect(motivoDeRechazo({ ...BASE, hasta: enDias(-1) }, 1_000_000, AHORA)).toBe('VENCIDO');
  });

  it('⛔ todavía no empezó', () => {
    expect(motivoDeRechazo({ ...BASE, desde: enDias(1) }, 1_000_000, AHORA)).toBe(
      'TODAVIA_NO_EMPEZO',
    );
  });

  it('⛔ agotado', () => {
    expect(motivoDeRechazo({ ...BASE, usosMaximos: 50, usos: 50 }, 1_000_000, AHORA)).toBe(
      'AGOTADO',
    );
  });

  it('⛔ no llega al mínimo', () => {
    expect(motivoDeRechazo({ ...BASE, minimoCentavos: 2_000_000 }, 1_000_000, AHORA)).toBe(
      'NO_LLEGA_AL_MINIMO',
    );
  });

  it('justo en el mínimo, entra', () => {
    // Un `>` mal escrito acá rechaza al que compró exactamente lo que pedía el
    // cupón, que es el caso más frustrante posible.
    expect(motivoDeRechazo({ ...BASE, minimoCentavos: 1_000_000 }, 1_000_000, AHORA)).toBeNull();
  });
});

describe('Cuánto descuenta', () => {
  it('un porcentaje simple', () => {
    expect(calcularDescuento(BASE, 1_000_000)).toBe(200_000);
  });

  it('un monto fijo', () => {
    expect(
      calcularDescuento({ ...BASE, tipo: 'MONTO_FIJO', valor: 300_000 }, 1_000_000),
    ).toBe(300_000);
  });

  it('⛔ el porcentaje redondea HACIA ABAJO', () => {
    /**
     * El descuento lo paga el vendedor. Redondear hacia arriba le saca un
     * centavo que no ofreció, y sobre miles de órdenes eso se nota.
     */
    expect(calcularDescuento({ ...BASE, valor: 10 }, 199_599)).toBe(19_959);
  });

  it('⛔ el tope recorta', () => {
    // Es lo que evita que «20 % de descuento» le cueste $40.000 en la única
    // venta de $200.000 del mes.
    expect(calcularDescuento({ ...BASE, topeCentavos: 100_000 }, 2_000_000)).toBe(100_000);
  });

  it('⛔ SIEMPRE queda algo por pagar', () => {
    /**
     * EL TEST QUE IMPORTA.
     *
     * Una orden de $0 no se puede cobrar: Mercado Pago la rechaza, y aunque no
     * lo hiciera, no habría pago que conciliar ni comisión que cobrar.
     *
     * Un cupón de monto fijo sin mínimo de compra activa este recorte en cuanto
     * alguien lo usa en un producto barato.
     */
    const gordo = { ...BASE, tipo: 'MONTO_FIJO' as const, valor: 900_000 };
    const descuento = calcularDescuento(gordo, 500_000);

    expect(descuento).toBe(500_000 - RESTO_MINIMO_CENTAVOS);
    expect(500_000 - descuento).toBe(RESTO_MINIMO_CENTAVOS);
  });

  it('⛔ nunca devuelve un descuento negativo', () => {
    // Con un subtotal menor que el resto mínimo, el recorte da cero y no un
    // número negativo que después sumaría al total.
    expect(calcularDescuento({ ...BASE, tipo: 'MONTO_FIJO', valor: 500_000 }, 50)).toBe(0);
  });
});

describe('La comisión con descuento', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EL 6 % SALE DE LO QUE SE PAGÓ
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Es el mismo invariante que en el precio de vivo, por el otro camino: allá
   * el descuento venía en el precio unitario, acá viene como línea aparte.
   *
   * Cobrar sobre el precio de lista sería quedarse con parte del descuento del
   * vendedor. Sobre descuentos grandes la comisión efectiva se dispara —un 50 %
   * la duplica— y el vendedor deja de hacer promociones.
   */

  it('⛔ se cobra sobre el subtotal MENOS el descuento', () => {
    const p = calcularPrecio({
      unitPrice: 1_000_000,
      quantity: 1,
      discountAmount: 300_000,
      platformFeeBps: 600,
    });

    // 6 % de $7.000, no de $10.000.
    expect(p.platformFeeAmount).toBe(42_000);
    expect(p.platformFeeAmount).not.toBe(60_000);
  });

  it('sin descuento, nada cambia', () => {
    const p = calcularPrecio({ unitPrice: 1_000_000, quantity: 1, platformFeeBps: 600 });
    expect(p.platformFeeAmount).toBe(60_000);
  });

  it('⛔ el envío sigue afuera de la base', () => {
    // Es la regla vieja y sigue valiendo: el envío no es ingreso del vendedor.
    const p = calcularPrecio({
      unitPrice: 1_000_000,
      quantity: 1,
      shippingAmount: 500_000,
      discountAmount: 200_000,
      platformFeeBps: 600,
    });

    // 6 % de $8.000: ni el envío suma, ni el descuento deja de restar.
    expect(p.platformFeeAmount).toBe(48_000);
  });

  it('⛔ un descuento que supera el subtotal no da comisión negativa', () => {
    /**
     * `verificarCoherencia` permite que el descuento cubra también el envío, o
     * sea que puede superar el subtotal de productos. Sin el piso en cero,
     * VendoX le estaría pagando al vendedor por vender.
     */
    expect(baseDeComision(500_000, 800_000)).toBe(0);

    const p = calcularPrecio({
      unitPrice: 500_000,
      quantity: 1,
      shippingAmount: 500_000,
      discountAmount: 800_000,
      platformFeeBps: 600,
    });
    expect(p.platformFeeAmount).toBe(0);
    expect(p.sellerNetAmount).toBe(p.grossAmount);
  });
});
