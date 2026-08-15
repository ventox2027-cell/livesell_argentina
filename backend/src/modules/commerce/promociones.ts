import { DomainError } from '@/shared/errors/domain.error';

/**
 * Promociones pagas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PAGAR NO MEJORA EL PUNTAJE. PAGAR COMPRA UN LUGAR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es la decisión de diseño más importante de este archivo y la razón de que sea
 * un módulo aparte de `ranking.ts`.
 *
 * Un producto promocionado **no recibe puntos**. `puntaje()` no sabe que las
 * promociones existen y no va a saberlo nunca. Lo que hace una promoción es
 * ocupar una posición reservada del feed, marcada como tal.
 *
 * La alternativa —sumarle puntos al puntaje orgánico— es la que aparece sola
 * cuando alguien quiere «que se vea más», y rompe tres cosas a la vez:
 *
 *   · **Deja de poder etiquetarse.** Si lo pago cambia el orden orgánico, no
 *     hay forma de decir cuál resultado es publicidad. La ley argentina de
 *     defensa del consumidor exige que lo sea; el sentido común, también.
 *   · **Contamina la señal.** El puntaje deja de significar «esto le interesa a
 *     la gente» y pasa a significar «esto le interesa a la gente, o alguien
 *     pagó». Nadie puede volver a usarlo para decidir nada.
 *   · **No tiene techo.** Con puntos, pagar el doble compra el doble de
 *     empujón, y el feed se convierte en una subasta. Con posiciones, hay tres
 *     lugares y se acabó.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Y NO TOCA LA REPUTACIÓN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ni las estrellas, ni el cumplimiento, ni el sello de identidad, ni el
 * distintivo de destacado. Nada de este módulo escribe en `Seller`.
 *
 * Un vendedor que paga aparece más veces. Sigue teniendo las estrellas que le
 * pusieron sus compradores.
 */

/** Qué se puede promocionar. */
export type TipoDePromocion =
  /** Un producto, en el feed de descubrimiento. */
  | 'PRODUCTO_EN_FEED'
  /** Un vivo programado, en la franja de «próximos». */
  | 'VIVO_PROGRAMADO';

/**
 * Cuántas posiciones del feed son promocionadas.
 *
 * Tres de las primeras veinte. Es poco a propósito: con más, el feed deja de
 * ser un feed y pasa a ser un catálogo de quien paga, y la gente lo nota antes
 * de poder explicar por qué.
 */
export const POSICIONES_PROMOCIONADAS = [2, 8, 15] as const;

/**
 * Cuánto dura una promoción, en horas.
 *
 * Las opciones, no un número libre: un vendedor que puede escribir «1 hora»
 * paga por algo que no le sirve, y uno que puede escribir «720» compra un mes
 * de feed sin darse cuenta.
 */
export const DURACIONES_EN_HORAS = [24, 72, 168] as const;
export type DuracionEnHoras = (typeof DURACIONES_EN_HORAS)[number];

/**
 * El costo, en créditos.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO HAY UN PRECIO EN PESOS EN NINGÚN LADO DE ESTE ARCHIVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Las promociones se pagan con **créditos**, y los créditos se otorgan desde el
 * panel. Cuánto sale un crédito en pesos es una decisión comercial que todavía
 * no está tomada y que va a cambiar con la inflación varias veces por año.
 *
 * Un precio hardcodeado acá significaría un despliegue por cada ajuste, y
 * —peor— que la app muestre un número viejo mientras tanto. Que el costo esté
 * en créditos hace que la conversión sea un solo dato, en un solo lugar, el día
 * que exista.
 */
export const COSTO_EN_CREDITOS: Record<TipoDePromocion, Record<DuracionEnHoras, number>> = {
  PRODUCTO_EN_FEED: { 24: 1, 72: 2, 168: 4 },
  VIVO_PROGRAMADO: { 24: 2, 72: 4, 168: 7 },
};

export function costoDe(tipo: TipoDePromocion, horas: DuracionEnHoras): number {
  return COSTO_EN_CREDITOS[tipo][horas];
}

export class PromocionInvalidaError extends DomainError {
  constructor(mensaje: string, detalles?: Record<string, unknown>) {
    super('PROMOTION_INVALID', mensaje, detalles);
  }
}

export class SinCreditosError extends DomainError {
  constructor(necesarios: number, disponibles: number) {
    super('NOT_ENOUGH_CREDITS', 'No te alcanzan los créditos para esta promoción', {
      necesarios,
      disponibles,
    });
  }
}

export function exigirDuracionValida(horas: number): asserts horas is DuracionEnHoras {
  if (!DURACIONES_EN_HORAS.includes(horas as DuracionEnHoras)) {
    throw new PromocionInvalidaError('Esa duración no está disponible', {
      opciones: DURACIONES_EN_HORAS,
    });
  }
}

/** Una promoción guardada, para decidir si está corriendo. */
export interface PromocionGuardada {
  readonly desde: Date;
  readonly hasta: Date;
  readonly cancelada: boolean;
}

export function estaCorriendo(p: PromocionGuardada, ahora: Date = new Date()): boolean {
  if (p.cancelada) return false;
  const t = ahora.getTime();
  return t >= p.desde.getTime() && t < p.hasta.getTime();
}

/**
 * Mezcla los promocionados con el feed orgánico.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL ORGÁNICO NO SE REORDENA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Los promocionados se **insertan** en las posiciones reservadas; el resto
 * corre un lugar. Nadie pierde su orden relativo, y nada de lo orgánico sube
 * ni baja por lo que pagó otro.
 *
 * ─── Tres reglas que parecen detalles y no lo son ───
 *
 * 1. **Un producto que ya está en la página no se duplica.** Alguien que paga
 *    por algo que igual iba a salir primero no compra dos apariciones: compra
 *    la etiqueta y nada más. Ver el filtro por id.
 *
 * 2. **Un vendedor aparece promocionado una sola vez por página.** Sin eso, el
 *    que tiene más créditos se lleva las tres posiciones y el feed se ve como
 *    lo que la gente odia.
 *
 * 3. **Si no hay promociones, la lista sale intacta.** Literalmente el mismo
 *    arreglo, sin copiar ni reordenar: el caso normal no paga nada.
 */
export function intercalarPromocionados<T>(
  organicos: T[],
  promocionados: T[],
  idDe: (item: T) => string,
  vendedorDe: (item: T) => string,
): Array<{ item: T; promocionado: boolean }> {
  if (promocionados.length === 0) {
    return organicos.map((item) => ({ item, promocionado: false }));
  }

  const yaEnLaPagina = new Set(organicos.map(idDe));
  const vendedoresUsados = new Set<string>();

  const elegidos: T[] = [];
  for (const p of promocionados) {
    if (elegidos.length >= POSICIONES_PROMOCIONADAS.length) break;
    if (yaEnLaPagina.has(idDe(p))) continue;
    const vendedor = vendedorDe(p);
    if (vendedoresUsados.has(vendedor)) continue;
    vendedoresUsados.add(vendedor);
    elegidos.push(p);
  }

  const salida: Array<{ item: T; promocionado: boolean }> = [];
  const cola = [...organicos];
  let siguiente = 0;

  for (let posicion = 0; cola.length > 0 || siguiente < elegidos.length; posicion += 1) {
    const tocaPromocionado =
      siguiente < elegidos.length &&
      (POSICIONES_PROMOCIONADAS as readonly number[]).includes(posicion);

    if (tocaPromocionado) {
      salida.push({ item: elegidos[siguiente]!, promocionado: true });
      siguiente += 1;
      continue;
    }

    if (cola.length === 0) {
      /**
       * Se acabó lo orgánico y quedan promocionados sin ubicar.
       *
       * Pasa en una tienda nueva o con un filtro muy angosto. Se agregan al
       * final igual —siguen etiquetados—, porque la alternativa es cobrarle a
       * alguien por una promoción que no se mostró.
       */
      salida.push({ item: elegidos[siguiente]!, promocionado: true });
      siguiente += 1;
      continue;
    }

    salida.push({ item: cola.shift()!, promocionado: false });
  }

  return salida;
}
