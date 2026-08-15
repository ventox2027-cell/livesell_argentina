/**
 * El embudo del vendedor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TODA CIFRA VIENE DE UNA FILA QUE EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es la regla que ordena el archivo entero. Cada número de este embudo se
 * cuenta de una tabla real:
 *
 *   · **Interesados** — `RecentlyViewed`. Personas distintas que abrieron el
 *     producto en los últimos 30 días.
 *   · **Guardados** — `Like`.
 *   · **Apartados** — `InventoryReservation`.
 *   · **Vendidos** — `Order` que llegó a cobrarse.
 *
 * No hay estimaciones, ni proyecciones, ni «impresiones» calculadas a partir
 * de nada. Un vendedor que toma decisiones sobre un número inventado toma
 * decisiones peores que uno que no tiene el número.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * «INTERESADOS», NO «VISITAS»
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El nombre importa tanto como el número.
 *
 * `RecentlyViewed` tiene una restricción única por (persona, producto): alguien
 * que abre el mismo producto diez veces deja **una** fila. Además se poda a 30
 * días y a 50 productos por persona (ver `social/vistos.ts`).
 *
 * O sea que ese número NO es «cuántas veces se vio». Llamarlo «visitas» sería
 * mentir por elección de palabra: el vendedor compararía con las visitas de
 * otra plataforma y sacaría conclusiones sobre una cifra que mide otra cosa.
 *
 * Se llama «personas que lo miraron» porque es exactamente lo que es.
 */

/** Los cuatro escalones, en orden. */
export interface Embudo {
  readonly interesados: number;
  readonly guardados: number;
  readonly apartados: number;
  readonly vendidos: number;
}

/**
 * Cuántos interesados hacen falta para calcular un porcentaje.
 *
 * Con tres personas, «33 % de conversión» es una anécdota disfrazada de
 * métrica: una venta más y salta a 66 %. Un vendedor que ve ese número cree
 * que descubrió algo y cambia sus precios por ruido.
 *
 * Treinta es bajo para lo que pide la estadística y alto para lo que tolera
 * alguien que recién empieza. Es un punto intermedio elegido a conciencia, no
 * un umbral con respaldo teórico.
 */
export const MINIMO_PARA_PORCENTAJE = 30;

/**
 * Convierte el embudo en tasas.
 *
 * ⚠️ Devuelve `null` —no cero— cuando no hay datos suficientes. Es la misma
 * decisión que en la reputación: un cero se lee como «malo» y un `null` se
 * puede mostrar como «todavía no sabemos», que es la verdad.
 */
export interface TasasDelEmbudo {
  /** De los que lo miraron, cuántos lo compraron. */
  readonly conversion: number | null;
  /** De los que lo apartaron, cuántos terminaron pagando. */
  readonly cierre: number | null;
}

export function tasasDe(e: Embudo): TasasDelEmbudo {
  return {
    conversion:
      e.interesados >= MINIMO_PARA_PORCENTAJE
        ? Math.round((e.vendidos / e.interesados) * 1000) / 10
        : null,
    /**
     * El cierre usa los apartados como base y tiene su propio mínimo bajo: una
     * reserva es una señal mucho más fuerte que una vista, y con diez ya dice
     * algo. Pero no se calcula con menos de diez por el mismo motivo de arriba.
     */
    cierre: e.apartados >= 10 ? Math.round((e.vendidos / e.apartados) * 1000) / 10 : null,
  };
}

/**
 * Dónde se está cayendo la gente.
 *
 * Devuelve el escalón con la mayor pérdida relativa, o `null` si no hay datos
 * para decirlo. Es lo único de este módulo que se parece a un consejo, y por
 * eso es descriptivo y no prescriptivo: dice **dónde** se pierde, no qué hacer.
 *
 * Un «subí el precio» o «mejorá las fotos» automático sería exactamente la
 * clase de recomendación inventada que el proyecto prohíbe: no tenemos ninguna
 * evidencia de que esas cosas arreglen nada en particular.
 */
export type Escalon = 'MIRAR_A_GUARDAR' | 'GUARDAR_A_APARTAR' | 'APARTAR_A_PAGAR';

export function dondeSePierde(e: Embudo): Escalon | null {
  if (e.interesados < MINIMO_PARA_PORCENTAJE) return null;
  if (e.vendidos >= e.apartados && e.apartados >= e.guardados) return null;

  const caidas: Array<{ escalon: Escalon; perdida: number }> = [
    {
      escalon: 'MIRAR_A_GUARDAR',
      perdida: e.interesados === 0 ? 0 : (e.interesados - e.guardados) / e.interesados,
    },
    {
      escalon: 'GUARDAR_A_APARTAR',
      perdida: e.guardados === 0 ? 0 : (e.guardados - e.apartados) / e.guardados,
    },
    {
      escalon: 'APARTAR_A_PAGAR',
      perdida: e.apartados === 0 ? 0 : (e.apartados - e.vendidos) / e.apartados,
    },
  ];

  const peor = caidas.reduce((a, b) => (b.perdida > a.perdida ? b : a));
  return peor.perdida > 0 ? peor.escalon : null;
}

/**
 * Cuánto historial ve, según el plan.
 *
 * Free ve 30 días porque es lo que `RecentlyViewed` conserva de todos modos —
 * ofrecerle más sería prometer un dato que la poda ya borró—. Pro ve un año de
 * ventas, que sí están completas en `Order`.
 *
 * ⚠️ El límite viene de `limitesDe()` en `sellers/membresias.ts`. No se
 * hardcodea acá: dos lugares que definen el mismo tope terminan discrepando.
 */
export function recorteDeHistorial(diasDelPlan: number, ahora: Date = new Date()): Date {
  return new Date(ahora.getTime() - diasDelPlan * 24 * 60 * 60 * 1000);
}
