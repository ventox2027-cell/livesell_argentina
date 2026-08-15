import { DomainError } from '@/shared/errors/domain.error';

/**
 * El precio exclusivo de un vivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UN DESCUENTO ES UNA PROMESA, NO UNA ETIQUETA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «$12.500 ~~$18.000~~» le dice a alguien que si compra ahora paga menos que si
 * compra mañana. Si eso no es cierto —porque el precio tachado nunca existió, o
 * porque el descuento no vence nunca— es publicidad engañosa, y la ley de
 * defensa del consumidor argentina la trata como tal.
 *
 * Este archivo es donde esa promesa se vuelve verificable. Tres reglas:
 *
 *   1. **el precio de vivo tiene que ser MENOR** que el de lista. Un «precio
 *      especial» más caro con el real tachado al lado es el patrón oscuro más
 *      viejo que existe;
 *   2. **el tachado es el precio real**, el que estaba antes y va a volver. No
 *      un número inventado para que el descuento se vea más grande;
 *   3. **hay una ventana**, y fuera de ella no se muestra ni se cobra nada
 *      distinto. Un descuento permanente no es un descuento: es el precio.
 *
 * ⛔ Y la cuarta, que no está acá porque es de otro archivo: **la comisión del
 * 6 % se calcula sobre lo que la persona pagó de verdad**, no sobre el precio
 * de lista. Cobrarle al vendedor comisión sobre un precio que nadie pagó sería
 * quedarse con parte de su descuento.
 *
 * Archivo puro: reglas y aritmética, probable sin base y sin reloj real.
 */

/**
 * El descuento máximo que se puede cargar.
 *
 * ⚠️ 90 %, y no existe para limitar al vendedor: existe para atajar un cero de
 * más. Alguien que quiere poner $1.800 y escribe $180 en un producto de
 * $18.000 está a un toque de vender con 99 % de descuento, y para cuando se
 * dé cuenta ya lo compraron treinta personas.
 *
 * Quien de verdad quiera regalar algo puede hacerlo en dos pasos: bajar el
 * precio de lista y después el de vivo. Lo que no puede es hacerlo por error.
 */
export const DESCUENTO_MAXIMO_PORCENTAJE = 90;

/** Lo mínimo que se puede cobrar por algo. El mismo piso que cualquier precio. */
export const PRECIO_MINIMO_CENTAVOS = 100;

export class PrecioDeVivoInvalidoError extends DomainError {
  constructor(motivo: string) {
    super('LIVE_PRICE_INVALID', motivo);
  }
}

export interface VentanaDePrecio {
  livePriceCents: number | null;
  livePriceFrom: Date | null;
  livePriceUntil: Date | null;
}

/**
 * ¿El precio de vivo está activo AHORA?
 *
 * ⚠️ Sin fechas, está activo. Es lo que quiere el caso más común: el vendedor
 * pone un precio para el vivo que está haciendo, y termina cuando termina el
 * vivo — que no es una fecha, es un estado.
 *
 * La ventana existe para el otro caso: «esta oferta dura hasta las 22», que el
 * vendedor anuncia en cámara y tiene que cumplirse aunque el vivo siga.
 */
export function precioDeVivoActivo(v: VentanaDePrecio, ahora: Date = new Date()): boolean {
  if (v.livePriceCents === null) return false;
  if (v.livePriceFrom && ahora < v.livePriceFrom) return false;
  if (v.livePriceUntil && ahora > v.livePriceUntil) return false;
  return true;
}

export interface PrecioResuelto {
  /** Lo que se cobra. */
  precioCentavos: number;
  /** El precio de lista. Se muestra tachado **sólo** si hay descuento. */
  precioDeListaCentavos: number;
  /** `true` únicamente cuando el descuento está activo de verdad. */
  hayDescuento: boolean;
  /** Entero, para mostrar «-30 %». `null` sin descuento. */
  porcentaje: number | null;
}

/**
 * Cuánto sale esto, ahora.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ES LA ÚNICA FUNCIÓN QUE DECIDE UN PRECIO CON DESCUENTO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La usan la vidriera del vivo, el detalle del producto y la creación de la
 * orden. Que sea una sola es lo que garantiza que **el precio que se muestra es
 * el que se cobra**: con dos implementaciones, alcanza que una mire la ventana
 * y la otra no para que alguien vea $12.500 y le cobren $18.000.
 *
 * ⚠️ Y devuelve `hayDescuento: false` cuando no hay, en vez de dejar que la app
 * lo deduzca comparando dos números. Comparar es donde aparece el bug: con
 * precios iguales, un `<` mal escrito muestra «-0 %» tachando el mismo número.
 */
export function resolverPrecio(
  precioDeLista: number,
  ventana: VentanaDePrecio,
  ahora: Date = new Date(),
): PrecioResuelto {
  const sinDescuento: PrecioResuelto = {
    precioCentavos: precioDeLista,
    precioDeListaCentavos: precioDeLista,
    hayDescuento: false,
    porcentaje: null,
  };

  if (!precioDeVivoActivo(ventana, ahora)) return sinDescuento;

  const conDescuento = ventana.livePriceCents!;

  /**
   * Defensa en profundidad: si por lo que sea el precio de vivo no es menor,
   * se cobra el de lista y no se muestra descuento.
   *
   * La base ya lo impide con un CHECK y el alta lo valida. Esto es la tercera
   * capa, y existe porque el precio de lista **puede cambiar después** de que
   * se cargó el de vivo: un vendedor que baja el producto de $18.000 a $10.000
   * deja un «precio de vivo» de $12.500 que ya no es un descuento.
   */
  if (conDescuento >= precioDeLista) return sinDescuento;

  return {
    precioCentavos: conDescuento,
    precioDeListaCentavos: precioDeLista,
    hayDescuento: true,
    // Hacia abajo: mostrar «-30 %» cuando son 29,7 infla el descuento.
    porcentaje: Math.floor(((precioDeLista - conDescuento) / precioDeLista) * 100),
  };
}

/**
 * Valida lo que el vendedor quiere cargar.
 *
 * Lanza con un motivo en castellano. Los mismos límites están en CHECK de la
 * base; acá se puede decir QUÉ está mal en vez de devolver el nombre de una
 * restricción.
 */
export function exigirPrecioDeVivoValido(params: {
  precioDeLista: number;
  precioDeVivo: number;
  desde?: Date | null;
  hasta?: Date | null;
}): void {
  const { precioDeLista, precioDeVivo, desde, hasta } = params;

  if (!Number.isInteger(precioDeVivo)) {
    throw new PrecioDeVivoInvalidoError('El precio va en centavos, sin decimales');
  }

  if (precioDeVivo < PRECIO_MINIMO_CENTAVOS) {
    throw new PrecioDeVivoInvalidoError('El precio mínimo es $1');
  }

  if (precioDeVivo >= precioDeLista) {
    throw new PrecioDeVivoInvalidoError(
      'El precio del vivo tiene que ser menor que el precio normal. ' +
        'Si querés subirlo, cambiá el precio del producto.',
    );
  }

  const descuento = ((precioDeLista - precioDeVivo) / precioDeLista) * 100;
  if (descuento > DESCUENTO_MAXIMO_PORCENTAJE) {
    throw new PrecioDeVivoInvalidoError(
      `Ese descuento es del ${Math.floor(descuento)} %. ` +
        `El máximo es ${DESCUENTO_MAXIMO_PORCENTAJE} %: revisá que no te haya faltado un cero.`,
    );
  }

  if (desde && hasta && desde >= hasta) {
    throw new PrecioDeVivoInvalidoError('La oferta tiene que terminar después de empezar');
  }
}
