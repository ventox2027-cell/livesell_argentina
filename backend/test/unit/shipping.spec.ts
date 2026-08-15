import { describe, expect, it } from 'vitest';

import { porcentajeDe } from '@/modules/orders/pricing';
import {
  baseDelCostoDeProcesador,
  costoDeEnvio,
  etiquetaDeEnvio,
  permiteEnvio,
  permiteRetiro,
  recargoAlComprador,
  type PoliticaDeEnvio,
} from '@/modules/orders/shipping';

/**
 * Envío manual y costo del procesador.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ES PLATA QUE ALGUIEN PAGA DE VERDAD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un error acá no es un número mal en una pantalla: es un comprador al que se
 * le cobró de más, o un vendedor que despachó un paquete y perdió el costo del
 * envío. Por eso la aritmética vive en un módulo puro y se prueba entera,
 * incluidos los bordes.
 */
describe('Costo de envío', () => {
  const gratis: PoliticaDeEnvio = { modo: 'FREE', montoFijo: 0 };
  const fijo: PoliticaDeEnvio = { modo: 'FIXED_PRICE', montoFijo: 350000 };
  const soloRetiro: PoliticaDeEnvio = { modo: 'PICKUP_ONLY', montoFijo: 0 };
  const ambos: PoliticaDeEnvio = { modo: 'FIXED_OR_PICKUP', montoFijo: 350000 };

  it('gratis no cobra nada', () => {
    expect(costoDeEnvio(gratis)).toBe(0);
  });

  it('fijo cobra su monto', () => {
    expect(costoDeEnvio(fijo)).toBe(350000);
  });

  it('sólo retiro no cobra envío', () => {
    // No es "gratis": es que no hay envío. Ver la etiqueta.
    expect(costoDeEnvio(soloRetiro)).toBe(0);
  });

  it('con las dos opciones, retirar sale cero y enviar cobra', () => {
    expect(costoDeEnvio(ambos, true)).toBe(0);
    expect(costoDeEnvio(ambos, false)).toBe(350000);
  });

  it('⛔ decir que se retira NO saltea el costo si la tienda no ofrece retiro', () => {
    /**
     * El comprador manda esa elección desde la app. Si el modo es `FIXED_PRICE`
     * y se aceptara, alcanzaría con un campo en el cuerpo para no pagar el
     * envío — y el vendedor despacharía un paquete que nadie le pagó.
     */
    expect(costoDeEnvio(fijo, true)).toBe(350000);
    expect(costoDeEnvio(gratis, true)).toBe(0);
  });

  describe('Qué se le ofrece al comprador', () => {
    it('sólo retiro no ofrece envío', () => {
      expect(permiteEnvio('PICKUP_ONLY')).toBe(false);
      expect(permiteRetiro('PICKUP_ONLY')).toBe(true);
    });

    it('gratis y fijo no ofrecen retiro', () => {
      for (const modo of ['FREE', 'FIXED_PRICE'] as const) {
        expect(permiteRetiro(modo), modo).toBe(false);
        expect(permiteEnvio(modo), modo).toBe(true);
      }
    });

    it('el modo mixto ofrece las dos', () => {
      expect(permiteEnvio('FIXED_OR_PICKUP')).toBe(true);
      expect(permiteRetiro('FIXED_OR_PICKUP')).toBe(true);
    });
  });

  describe('Etiqueta', () => {
    it('⛔ "sólo retiro" NUNCA dice envío gratis', () => {
      // Son cosas distintas, y confundirlas hace que alguien espere un paquete
      // que nunca sale.
      expect(etiquetaDeEnvio(soloRetiro)).toBe('Retiro en persona');
      expect(etiquetaDeEnvio(ambos, true)).toBe('Retiro en persona');
    });

    it('gratis dice gratis', () => {
      expect(etiquetaDeEnvio(gratis)).toBe('Envío gratis');
    });

    it('con costo dice envío a secas: el monto va al lado', () => {
      expect(etiquetaDeEnvio(fijo)).toBe('Envío');
    });
  });
});

describe('Costo del procesador', () => {
  it('la base es producto MÁS envío', () => {
    /**
     * Es sobre lo que el procesador efectivamente cobra: es la plata que pasa
     * por él. Calcularlo sólo sobre el producto dejaría al vendedor pagando de
     * su bolsillo la parte del envío.
     */
    expect(baseDelCostoDeProcesador(1_000_000, 350_000)).toBe(1_350_000);
  });

  it('absorbido no le suma nada al comprador', () => {
    expect(
      recargoAlComprador({
        modo: 'ABSORBED',
        itemsSubtotal: 1_000_000,
        envio: 350_000,
        bps: 619,
        habilitado: true,
      }),
    ).toBe(0);
  });

  it('trasladado suma el porcentaje sobre producto + envío', () => {
    const recargo = recargoAlComprador({
      modo: 'PASSED_TO_BUYER',
      itemsSubtotal: 1_000_000,
      envio: 350_000,
      bps: 619,
      habilitado: true,
    });

    // 1.350.000 × 6,19 % = 83.565
    expect(recargo).toBe(83_565);
  });

  it('redondea igual que la comisión de la plataforma', () => {
    // Dos redondeos distintos sobre la misma orden dan totales que no cierran
    // por un centavo, y ese centavo aparece en la conciliación.
    for (const base of [1, 99, 100, 12_345, 999_999, 1_000_000]) {
      expect(
        recargoAlComprador({ modo: 'PASSED_TO_BUYER', itemsSubtotal: base, envio: 0, bps: 619, habilitado: true }),
        `base ${base}`,
      ).toBe(porcentajeDe(base, 619));
    }
  });

  it('nunca devuelve decimales', () => {
    // Todo es centavos enteros de punta a punta. Un decimal acá termina en un
    // total que el procesador rechaza.
    for (const base of [333, 777, 1_111, 99_999]) {
      const r = recargoAlComprador({
        modo: 'PASSED_TO_BUYER',
        itemsSubtotal: base,
        envio: 0,
        bps: 619,
        habilitado: true,
      });
      expect(Number.isInteger(r), `base ${base}`).toBe(true);
    }
  });

  it('con importes chicos no se cobra de más', () => {
    // Un peso: 100 centavos × 6,19 % = 6,19 → 6.
    expect(
      recargoAlComprador({ modo: 'PASSED_TO_BUYER', itemsSubtotal: 100, envio: 0, bps: 619, habilitado: true }),
    ).toBe(6);
  });
});

describe('El recargo está apagado para la beta', () => {
  /**
   * El comprador paga producto + envío y nada más.
   *
   * El número que se trasladaba era una ESTIMACIÓN calculada antes de que
   * Mercado Pago dijera cuánto va a cobrar de verdad. Cobrarle a alguien un
   * costo estimado de un tercero, y quedarse con la diferencia cuando el real
   * resulta menor, es exactamente el tipo de recargo que la ley de defensa del
   * consumidor mira con lupa.
   */
  it('⛔ apagado, no suma nada aunque la tienda lo tenga trasladado', () => {
    expect(
      recargoAlComprador({
        modo: 'PASSED_TO_BUYER',
        itemsSubtotal: 1_000_000,
        envio: 350_000,
        bps: 619,
        habilitado: false,
      }),
    ).toBe(0);
  });

  it('⛔ la bandera gana sobre cualquier configuración de tienda', () => {
    // Ninguna combinación produce un recargo con la bandera apagada.
    for (const modo of ['ABSORBED', 'PASSED_TO_BUYER'] as const) {
      for (const bps of [0, 619, 2000]) {
        expect(
          recargoAlComprador({
            modo,
            itemsSubtotal: 5_000_000,
            envio: 900_000,
            bps,
            habilitado: false,
          }),
          `${modo} con ${bps} bps`,
        ).toBe(0);
      }
    }
  });

  it('el cálculo sigue existiendo para el día que se encienda', () => {
    /**
     * Se apaga, no se borra. El modelo entero —la columna, el modo por tienda,
     * el snapshot en cada orden— se conserva: borrarlo significaría una
     * migración destructiva y volver a escribir todo el día que se decida
     * implementarlo bien.
     *
     * Y las órdenes históricas ya tienen su `processorSurchargeAmount`
     * guardado: si el cálculo desapareciera, esos pedidos dejarían de cuadrar.
     */
    expect(
      recargoAlComprador({
        modo: 'PASSED_TO_BUYER',
        itemsSubtotal: 1_000_000,
        envio: 350_000,
        bps: 619,
        habilitado: true,
      }),
    ).toBe(83_565);
  });
});
