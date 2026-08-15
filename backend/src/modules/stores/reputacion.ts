import { DomainError } from '@/shared/errors/domain.error';

/**
 * La reputación de un vendedor, y las reglas de las reseñas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TODA CIFRA SALE DE UNA OPERACIÓN QUE PASÓ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «4,8 ★ · 327 ventas · 98 % de cumplimiento» es la línea que decide si alguien
 * le compra a un desconocido. Si uno solo de esos tres números está inflado,
 * VendoX deja de ser un lugar donde la reputación significa algo — y una vez
 * que eso pasa no se recupera avisando que ahora sí son reales.
 *
 * Por eso:
 *
 *   · **327 ventas** son 327 pedidos que llegaron a ENTREGADO, confirmados con
 *     el código de seis dígitos que tenía el comprador. No pedidos pagos, no
 *     pedidos despachados: entregados;
 *   · **4,8 ★** es la suma de estrellas sobre la cantidad de reseñas, sin
 *     ponderar, sin descartar las malas y sin redondear hacia arriba;
 *   · **98 %** son entregas sobre entregas más cancelaciones del vendedor.
 *
 * Archivo puro: son reglas y aritmética, y tienen que poder probarse sin base.
 */

/**
 * Cuántas operaciones hacen falta para mostrar un porcentaje.
 *
 * ⚠️ Con una sola venta entregada, el cumplimiento da 100 %. Eso no es
 * información: es una división con denominador uno disfrazada de trayectoria, y
 * un vendedor nuevo con «100 % de cumplimiento» se ve más confiable que uno con
 * 380 ventas y 97 %.
 *
 * Cinco es el mínimo donde una cancelación mueve el número de forma visible
 * (100 % → 83 %). Por debajo, se muestra la cantidad de ventas y nada más.
 */
export const MINIMO_PARA_CUMPLIMIENTO = 5;

/**
 * Cuántas reseñas hacen falta para mostrar un promedio.
 *
 * Mismo problema, más grave: una sola reseña de 5 estrellas muestra «5,0 ★», el
 * máximo posible, a alguien que vendió una vez.
 */
export const MINIMO_PARA_PROMEDIO = 3;

/** Cuánto tiempo se puede editar una reseña. */
export const HORAS_PARA_EDITAR = 48;

export interface DatosDeReputacion {
  ratingSum: number;
  ratingCount: number;
  salesCount: number;
  cancelledCount: number;
}

export interface Reputacion {
  /** Promedio de 1 a 5, con un decimal. `null` si hay muy pocas reseñas. */
  promedio: number | null;
  resenas: number;
  /** Pedidos ENTREGADOS. Siempre se muestra, aunque sea 0. */
  ventas: number;
  /** Porcentaje entero. `null` si hay muy pocas operaciones. */
  cumplimiento: number | null;
  /** Si es nuevo, la interfaz lo dice en vez de mostrar ceros. */
  esNuevo: boolean;
}

/**
 * Los números que se muestran en el perfil público.
 *
 * ⚠️ Devuelve `null` en vez de un valor por omisión cuando no hay datos
 * suficientes. Un `0` y un «todavía no sabemos» son cosas distintas, y si los
 * dos viajan como `0` la app no puede distinguirlos: terminaría mostrando
 * «0,0 ★» a un vendedor sin reseñas, que se lee como pésimo.
 */
export function calcularReputacion(d: DatosDeReputacion): Reputacion {
  const operaciones = d.salesCount + d.cancelledCount;

  const promedio =
    d.ratingCount >= MINIMO_PARA_PROMEDIO
      ? Math.round((d.ratingSum / d.ratingCount) * 10) / 10
      : null;

  const cumplimiento =
    operaciones >= MINIMO_PARA_CUMPLIMIENTO
      ? Math.round((d.salesCount / operaciones) * 100)
      : null;

  return {
    promedio,
    resenas: d.ratingCount,
    ventas: d.salesCount,
    cumplimiento,
    esNuevo: d.salesCount === 0 && d.ratingCount === 0,
  };
}

/**
 * ¿Este vendedor se puede destacar?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REGLAS OBJETIVAS, NO UNA DECISIÓN NUESTRA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «Destacado» tiene que ser algo que un vendedor pueda alcanzar sabiendo qué
 * hacer, y que pueda perder sabiendo por qué. Si lo decide alguien mirando una
 * lista, es un favor.
 *
 * ⛔ Y **no se compra**. Ni con VendoX Pro ni con promoción paga. Un destacado
 * que se compra es publicidad disfrazada de mérito, y arruina la señal para
 * todos los que lo consiguieron vendiendo bien.
 *
 * Tres condiciones, todas verificables:
 */
export function esDestacado(d: DatosDeReputacion): boolean {
  const r = calcularReputacion(d);
  return (
    // Suficientes entregas como para que no sea suerte.
    r.ventas >= 20 &&
    // Y suficientes reseñas como para que el promedio signifique algo.
    (r.promedio ?? 0) >= 4.5 &&
    r.resenas >= 10 &&
    // Y que efectivamente entregue lo que vende.
    (r.cumplimiento ?? 0) >= 95
  );
}

/** Errores ────────────────────────────────────────────────────────────────── */

export class TodaviaNoSePuedeResenarError extends DomainError {
  constructor() {
    super(
      'REVIEW_NOT_ALLOWED_YET',
      'Vas a poder opinar cuando el pedido esté entregado.',
    );
  }
}

export class YaNoSePuedeEditarError extends DomainError {
  constructor() {
    super(
      'REVIEW_EDIT_WINDOW_CLOSED',
      `Las reseñas se pueden editar durante las primeras ${HORAS_PARA_EDITAR} horas.`,
    );
  }
}

export class NoEsTuResenaError extends DomainError {
  constructor() {
    super('REVIEW_NOT_FOUND', 'No encontramos esa reseña.');
  }
}

export class YaRespondisteError extends DomainError {
  constructor() {
    super('REVIEW_ALREADY_ANSWERED', 'Ya respondiste esta reseña.');
  }
}

/** Las reglas ─────────────────────────────────────────────────────────────── */

/**
 * ⛔ Sólo se reseña un pedido ENTREGADO.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ANTES ALCANZABA CON HABER PAGADO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La versión anterior aceptaba desde `CONFIRMED`: apenas se acreditaba el pago,
 * el comprador ya podía calificar. Eso rompía las dos direcciones.
 *
 * Contra el vendedor: una estrella a los diez minutos de comprar, antes de que
 * llegara a empaquetar nada. La reseña no hablaba de la venta; hablaba de la
 * ansiedad de quien compró.
 *
 * Y a favor del vendedor: podía cobrar, pedirle al comprador que lo calificara
 * bien, y no entregar nunca. La reseña quedaba.
 *
 * Se mira `deliveredAt` y **no el estado**, que es la parte importante: ese
 * campo lo escribe una sola cosa en todo el sistema —confirmar la entrega con
 * el código de seis dígitos que tiene el comprador— y no hay ningún otro camino
 * que lo llene. Con el estado alcanzaba que alguien agregara una transición.
 */
export function exigirEntregaConfirmada(orden: { deliveredAt: Date | null }): void {
  if (orden.deliveredAt === null) throw new TodaviaNoSePuedeResenarError();
}

/**
 * ¿Todavía se puede editar o borrar?
 *
 * 48 horas. La ventana existe porque el arrepentimiento inmediato es legítimo
 * —«puse 2 estrellas de bronca y el vendedor lo resolvió»— y la edición
 * indefinida no: una reseña que se puede reescribir para siempre es una que un
 * vendedor puede negociar seis meses después.
 */
export function sePuedeEditar(creada: Date, ahora: Date = new Date()): boolean {
  const horas = (ahora.getTime() - creada.getTime()) / 3_600_000;
  return horas <= HORAS_PARA_EDITAR;
}

/**
 * El promedio después de sacar o cambiar una reseña.
 *
 * ⚠️ Los contadores del vendedor son denormalizados: si una reseña se borra y
 * `ratingSum`/`ratingCount` no se ajustan, el promedio queda con una estrella
 * de una reseña que ya no existe — y como el número no se recalcula solo, ese
 * error es para siempre.
 *
 * Devuelve el delta a aplicar, no el valor final: el UPDATE tiene que ser un
 * incremento atómico, porque dos reseñas borradas a la vez leerían el mismo
 * valor y una pisaría a la otra.
 */
export function deltaAlBorrar(rating: number): { ratingSum: number; ratingCount: number } {
  return { ratingSum: -rating, ratingCount: -1 };
}

export function deltaAlEditar(anterior: number, nuevo: number): { ratingSum: number } {
  return { ratingSum: nuevo - anterior };
}
