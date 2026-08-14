import { describe, expect, it } from 'vitest';

import {
  calcularPrecio,
  netoConCostoDeProcesador,
  porcentajeDe,
  referenciaDeOrden,
  verificarCoherencia,
  centavosAMonto,
  montoACentavos,
} from '@/modules/orders/pricing';

/**
 * La aritmética del dinero.
 *
 * Un error acá no rompe nada visible: produce un número levemente distinto que
 * nadie nota hasta que alguien concilia contra el extracto bancario, meses
 * después. Por eso se prueba con números exactos y no con aproximaciones.
 */

const BPS_6 = 600; // 6,00 %

describe('Comisión', () => {
  it('el 6 % de $999 son $59,94 exactos', () => {
    // 99900 centavos × 600 bps / 10000 = 5994 centavos, sin resto.
    expect(porcentajeDe(99_900, BPS_6)).toBe(5_994);
  });

  it('redondea medio hacia arriba', () => {
    // 99999 × 600 / 10000 = 5999,94 → 6000
    expect(porcentajeDe(99_999, BPS_6)).toBe(6_000);
    // Exactamente medio: 1000 × 500 / 10000 = 50, sin resto. Se busca uno con .5:
    // 833 × 600 / 10000 = 49,98 → 50
    expect(porcentajeDe(833, BPS_6)).toBe(50);
  });

  it('no usa coma flotante en ningún paso', () => {
    /**
     * El caso que delata una implementación con flotantes.
     *
     * `Math.round(2_000_000 * 0.06)` da 120000 igual, pero
     * `Math.round(2_000_000 * (600/10000))` puede dar 119999,99999999999 según
     * cómo se agrupe. Con enteros puros no hay forma de que pase.
     */
    expect(porcentajeDe(2_000_000, BPS_6)).toBe(120_000);
    expect(porcentajeDe(1, BPS_6)).toBe(0); // 0,06 centavos → 0
    expect(porcentajeDe(9, BPS_6)).toBe(1); // 0,54 → 1
  });

  it('cero por ciento no cobra nada', () => {
    expect(porcentajeDe(1_000_000, 0)).toBe(0);
  });

  it('el resultado nunca supera el monto', () => {
    // El tope de 5000 bps es 50 %.
    expect(porcentajeDe(1_000, 5_000)).toBe(500);
  });
});

describe('Precio de una orden', () => {
  it('caso simple: una unidad de $8.900', () => {
    const p = calcularPrecio({ unitPrice: 890_000, quantity: 1, platformFeeBps: BPS_6 });

    expect(p.itemsSubtotal).toBe(890_000);
    expect(p.grossAmount).toBe(890_000);
    expect(p.platformFeeAmount).toBe(53_400); // 6 % de 8900 = 534
    expect(p.sellerNetAmount).toBe(836_600);
    expect(verificarCoherencia(p)).toEqual({ ok: true });
  });

  it('multiplica por la cantidad', () => {
    const p = calcularPrecio({ unitPrice: 100_000, quantity: 3, platformFeeBps: BPS_6 });

    expect(p.itemsSubtotal).toBe(300_000);
    expect(p.platformFeeAmount).toBe(18_000);
  });

  it('⛔ la comisión NO se cobra sobre el envío', () => {
    /**
     * El envío no es ganancia del vendedor: es el costo de mandar el paquete.
     * Cobrarle comisión sería cobrarle por gastar.
     */
    const sinEnvio = calcularPrecio({ unitPrice: 100_000, quantity: 1, platformFeeBps: BPS_6 });
    const conEnvio = calcularPrecio({
      unitPrice: 100_000,
      quantity: 1,
      shippingAmount: 50_000,
      platformFeeBps: BPS_6,
    });

    // La comisión es idéntica; sólo cambia el total y el neto.
    expect(conEnvio.platformFeeAmount).toBe(sinEnvio.platformFeeAmount);
    expect(conEnvio.grossAmount).toBe(150_000);
    // El envío vuelve entero al vendedor: lo pagó el comprador para que despache.
    expect(conEnvio.sellerNetAmount).toBe(150_000 - 6_000);
  });

  it('el descuento baja el total', () => {
    const p = calcularPrecio({
      unitPrice: 100_000,
      quantity: 1,
      discountAmount: 20_000,
      platformFeeBps: BPS_6,
    });

    expect(p.grossAmount).toBe(80_000);
    // La comisión sigue siendo sobre el subtotal de productos.
    expect(p.platformFeeAmount).toBe(6_000);
  });

  it('el total siempre cierra con sus partes', () => {
    for (const cantidad of [1, 2, 7, 13]) {
      for (const envio of [0, 50_000, 123_456]) {
        const p = calcularPrecio({
          unitPrice: 99_999,
          quantity: cantidad,
          shippingAmount: envio,
          platformFeeBps: BPS_6,
        });
        expect(p.grossAmount).toBe(p.itemsSubtotal + p.shippingAmount - p.discountAmount);
        expect(p.sellerNetAmount).toBe(p.grossAmount - p.platformFeeAmount);
        expect(verificarCoherencia(p)).toEqual({ ok: true });
      }
    }
  });
});

describe('Coherencia', () => {
  const base = calcularPrecio({ unitPrice: 100_000, quantity: 1, platformFeeBps: BPS_6 });

  it.each([
    ['subtotal negativo', { itemsSubtotal: -1 }],
    ['envío negativo', { shippingAmount: -1 }],
    ['descuento negativo', { discountAmount: -1 }],
    ['total que no cierra', { grossAmount: 999 }],
    ['comisión mayor que el total', { platformFeeAmount: 999_999 }],
    ['porcentaje fuera de rango', { platformFeeBps: 9_999 }],
    ['neto que no coincide', { sellerNetAmount: 1 }],
  ])('⛔ detecta %s', (_nombre, cambio) => {
    const resultado = verificarCoherencia({ ...base, ...cambio });
    expect(resultado.ok).toBe(false);
  });

  it('⛔ un descuento mayor que la compra', () => {
    const resultado = verificarCoherencia({
      ...base,
      discountAmount: 200_000,
      grossAmount: -100_000,
    });
    expect(resultado.ok).toBe(false);
  });
});

describe('Costo del procesador', () => {
  it('recalcula el neto cuando Mercado Pago informa lo que cobró', () => {
    const p = calcularPrecio({ unitPrice: 100_000, quantity: 1, platformFeeBps: BPS_6 });

    expect(p.sellerNetAmount).toBe(94_000); // sin conocer el costo todavía
    // MP cobró $63,90.
    expect(netoConCostoDeProcesador(p, 6_390)).toBe(87_610);
  });

  it('el neto baja, nunca sube', () => {
    const p = calcularPrecio({ unitPrice: 500_000, quantity: 1, platformFeeBps: BPS_6 });
    expect(netoConCostoDeProcesador(p, 20_000)).toBeLessThan(p.sellerNetAmount);
  });
});

describe('Referencia de la orden', () => {
  it('ocho caracteres', () => {
    expect(referenciaDeOrden()).toHaveLength(8);
  });

  it('⛔ sin caracteres que se confundan al dictar por teléfono', () => {
    // 0/O, 1/I/L y 5/S son los que hacen que soporte pida repetir tres veces.
    const prohibidos = /[01IOLS]/;
    for (let i = 0; i < 500; i += 1) {
      expect(referenciaDeOrden()).not.toMatch(prohibidos);
    }
  });

  it('con un generador determinista da siempre lo mismo', () => {
    const fijo = () => 0;
    expect(referenciaDeOrden(fijo)).toBe(referenciaDeOrden(fijo));
  });
});

describe('Centavos y unidades', () => {
  it('convierte en las dos direcciones', () => {
    expect(centavosAMonto(890_000)).toBe(8_900);
    expect(montoACentavos(8_900)).toBe(890_000);
  });

  it('⛔ redondea en vez de truncar', () => {
    /**
     * `1500.00` puede volver de un JSON como `1499.9999999999998`. Truncar
     * convertiría $1500 en $1499,99 — un centavo de menos por operación, que
     * sobre miles de órdenes deja de ser un centavo.
     */
    expect(montoACentavos(1499.9999999999998)).toBe(150_000);
    expect(montoACentavos(0.1 + 0.2)).toBe(30);
  });

  it('ida y vuelta no pierde nada', () => {
    for (const centavos of [1, 99, 100, 12_345, 890_000, 999_999_99]) {
      expect(montoACentavos(centavosAMonto(centavos))).toBe(centavos);
    }
  });
});
