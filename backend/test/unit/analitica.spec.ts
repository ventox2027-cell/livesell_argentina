import { describe, expect, it } from 'vitest';

import {
  MINIMO_PARA_PORCENTAJE,
  dondeSePierde,
  recorteDeHistorial,
  tasasDe,
  type Embudo,
} from '@/modules/commerce/analitica';

/**
 * El embudo del vendedor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UN NÚMERO QUE NO SE MIDIÓ NO SE MUESTRA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Estos tests protegen una sola cosa: que el vendedor no tome decisiones sobre
 * cifras inventadas. Con tres personas mirando, «33 % de conversión» es una
 * anécdota disfrazada de métrica — una venta más y salta a 66 %.
 *
 * `null` y no cero, siempre. Un cero se lee como «malo»; un `null` se puede
 * mostrar como «todavía no sabemos», que es la verdad.
 */

const embudo = (e: Partial<Embudo>): Embudo => ({
  interesados: 0,
  guardados: 0,
  apartados: 0,
  vendidos: 0,
  ...e,
});

describe('Las tasas', () => {
  it('⛔ con pocos interesados NO hay porcentaje', () => {
    const t = tasasDe(embudo({ interesados: 3, vendidos: 1 }));
    expect(t.conversion).toBeNull();
  });

  it('justo en el mínimo, ya se calcula', () => {
    const t = tasasDe(embudo({ interesados: MINIMO_PARA_PORCENTAJE, vendidos: 3 }));
    expect(t.conversion).toBe(10);
  });

  it('⛔ con cero interesados no divide por cero', () => {
    const t = tasasDe(embudo({}));
    expect(t.conversion).toBeNull();
    expect(t.cierre).toBeNull();
  });

  it('el cierre tiene su propio mínimo, más bajo', () => {
    /**
     * Una reserva es una señal mucho más fuerte que una vista: quien apartó ya
     * decidió. Con diez ya dice algo, y por eso no comparte el umbral de la
     * conversión.
     */
    const t = tasasDe(embudo({ interesados: 5, apartados: 10, vendidos: 7 }));
    expect(t.conversion).toBeNull();
    expect(t.cierre).toBe(70);
  });

  it('⛔ con nueve reservas todavía no', () => {
    const t = tasasDe(embudo({ apartados: 9, vendidos: 9 }));
    expect(t.cierre).toBeNull();
  });

  it('redondea a un decimal', () => {
    // Dos decimales en una tasa de conversión es precisión falsa: sugiere que
    // el número es estable hasta la centésima y no lo es.
    const t = tasasDe(embudo({ interesados: 300, vendidos: 7 }));
    expect(t.conversion).toBe(2.3);
  });
});

describe('Dónde se pierde la gente', () => {
  it('⛔ sin datos suficientes no se opina', () => {
    // Señalar un escalón con cinco personas es inventar un diagnóstico.
    expect(dondeSePierde(embudo({ interesados: 5, guardados: 1 }))).toBeNull();
  });

  it('detecta la caída más grande', () => {
    // 100 miraron, 90 guardaron, 80 apartaron, 5 pagaron: el problema está en
    // el último paso y es donde hay que mirar.
    const e = embudo({ interesados: 100, guardados: 90, apartados: 80, vendidos: 5 });
    expect(dondeSePierde(e)).toBe('APARTAR_A_PAGAR');
  });

  it('detecta cuando el problema está arriba', () => {
    // 100 miraron y 5 guardaron: el producto no engancha, y eso pasa antes de
    // cualquier problema de precio o de pago.
    const e = embudo({ interesados: 100, guardados: 5, apartados: 4, vendidos: 4 });
    expect(dondeSePierde(e)).toBe('MIRAR_A_GUARDAR');
  });

  it('⛔ sin ninguna caída, no señala nada', () => {
    // Todos los que miraron compraron. No hay problema que marcar, y marcar
    // uno igual sería inventar.
    const e = embudo({ interesados: 40, guardados: 40, apartados: 40, vendidos: 40 });
    expect(dondeSePierde(e)).toBeNull();
  });

  it('⛔ no devuelve consejos, sólo el escalón', () => {
    /**
     * Es descriptivo a propósito. Un «subí el precio» o «mejorá las fotos»
     * automático sería una recomendación inventada: no tenemos ninguna
     * evidencia de que esas cosas arreglen algo en particular.
     */
    const e = embudo({ interesados: 100, guardados: 10, apartados: 5, vendidos: 1 });
    const escalon = dondeSePierde(e);

    expect(['MIRAR_A_GUARDAR', 'GUARDAR_A_APARTAR', 'APARTAR_A_PAGAR']).toContain(escalon);
  });
});

describe('El recorte de historial', () => {
  it('sale del plan, no de una constante local', () => {
    // Dos lugares que definen el mismo tope terminan discrepando. El número
    // viene de `limitesDe()`.
    const ahora = new Date('2026-08-15T21:00:00.000Z');

    expect(recorteDeHistorial(30, ahora)).toEqual(new Date('2026-07-16T21:00:00.000Z'));
    expect(recorteDeHistorial(365, ahora)).toEqual(new Date('2025-08-15T21:00:00.000Z'));
  });
});
