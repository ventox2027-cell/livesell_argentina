import type { OrderStatus, PaymentAttemptStatus } from '@prisma/client';

/**
 * Las dos máquinas de estados del bloque de órdenes.
 *
 * Sin Prisma, sin Nest, sin red: es la lógica donde un error se traduce
 * directamente en plata perdida o en alguien cobrado dos veces, y tiene que
 * poder martillarse con tests en milisegundos.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ `PAID` Y `CONFIRMED` SON ESTADOS DISTINTOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es la decisión que estructura todo el módulo.
 *
 *   · `PAID`      = Mercado Pago acreditó el dinero.
 *   · `CONFIRMED` = además el stock quedó consumido y la venta es válida.
 *
 * Entre los dos hay una realidad incómoda: **puede haber plata acreditada sin
 * inventario disponible**. Pasa cuando el pago se aprueba tarde —el comprador
 * perdió señal, el webhook llegó demorado— y para entonces otro ya se llevó la
 * última unidad.
 *
 * Con un solo estado "pagado", ese caso se resolvería de una de dos maneras,
 * las dos malas: o se le roba la unidad al segundo comprador, o se marca la
 * orden como completa y se le manda un paquete que no existe.
 *
 * Separarlos hace el problema VISIBLE: la orden queda en
 * `PAYMENT_REQUIRES_REFUND` y se devuelve la plata. No se esconde.
 */

// ═══════════════════════════════════════════════════════════════════════════
// ORDEN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Transiciones válidas.
 *
 *   PENDING_PAYMENT ──┬─→ PROCESSING_PAYMENT ──┬─→ PAID ──┬─→ CONFIRMED ──→ PREPARING
 *                     │                        │          │                     ↓
 *                     │                        │          │              READY_TO_SHIP
 *                     │                        │          │                     ↓
 *                     │                        │          │                  SHIPPED
 *                     │                        │          │                     ↓
 *                     │                        │          │                 DELIVERED
 *                     │                        │          │
 *                     │                        │          └─→ PAYMENT_REQUIRES_REFUND
 *                     │                        │                       ↓
 *                     │                        └─→ PAYMENT_FAILED  REFUND_PENDING
 *                     │                                 │                ↓
 *                     ├─→ EXPIRED                       │            REFUNDED
 *                     └─→ CANCELLED ←───────────────────┘
 */
const TRANSICIONES: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING_PAYMENT: ['PROCESSING_PAYMENT', 'EXPIRED', 'CANCELLED'],

  /**
   * Desde un cobro en vuelo se puede ir a cualquier desenlace.
   *
   * `EXPIRED` NO está: una orden con un cobro del que no se conoce el
   * resultado no se puede dar por vencida y olvidar. Si el pago se aprobó y
   * nadie se enteró, marcarla vencida sería quedarse con la plata. El
   * conciliador tiene que resolverla primero.
   */
  PROCESSING_PAYMENT: ['PAID', 'PAYMENT_FAILED', 'CANCELLED'],

  /**
   * Hay plata. Sólo dos salidas, y las dos son honestas: o se confirma la
   * venta, o se devuelve.
   */
  PAID: ['CONFIRMED', 'PAYMENT_REQUIRES_REFUND'],

  /** Se puede reintentar con otra tarjeta. */
  PAYMENT_FAILED: ['PROCESSING_PAYMENT', 'EXPIRED', 'CANCELLED'],

  CONFIRMED: ['PREPARING', 'PAYMENT_REQUIRES_REFUND'],
  PREPARING: ['READY_TO_SHIP', 'PAYMENT_REQUIRES_REFUND'],
  READY_TO_SHIP: ['SHIPPED', 'PAYMENT_REQUIRES_REFUND'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],

  PAYMENT_REQUIRES_REFUND: ['REFUND_PENDING'],
  REFUND_PENDING: ['REFUNDED', 'PAYMENT_REQUIRES_REFUND'],
  REFUNDED: [],

  EXPIRED: [],
  CANCELLED: [],
};

export function transicionValida(desde: OrderStatus, hacia: OrderStatus): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

export function esFinal(status: OrderStatus): boolean {
  return TRANSICIONES[status].length === 0;
}

/**
 * ¿Se puede lanzar un cobro sobre esta orden?
 *
 * `PROCESSING_PAYMENT` queda afuera a propósito: si hay un cobro en vuelo del
 * que no se conoce el resultado, lanzar otro es la receta para cobrar dos
 * veces. La base además lo impide con un índice único parcial.
 */
export function admitePago(status: OrderStatus): boolean {
  return status === 'PENDING_PAYMENT' || status === 'PAYMENT_FAILED';
}

/**
 * ¿Puede vencer sola?
 *
 * Sólo si no hay nada de plata en juego. Una orden con un cobro en vuelo o ya
 * pagada nunca vence por tiempo: se resuelve.
 */
export function puedeVencer(status: OrderStatus): boolean {
  return status === 'PENDING_PAYMENT' || status === 'PAYMENT_FAILED';
}

/** ¿El comprador todavía puede cancelarla? */
export function admiteCancelacionDelComprador(status: OrderStatus): boolean {
  return status === 'PENDING_PAYMENT' || status === 'PAYMENT_FAILED';
}

/**
 * Estados de preparación que maneja el VENDEDOR.
 *
 * El comprador no los toca: son declaraciones sobre el mundo físico —"ya lo
 * empaqueté"— que sólo puede hacer quien tiene el paquete.
 */
export const ESTADOS_DE_PREPARACION: readonly OrderStatus[] = [
  'PREPARING',
  'READY_TO_SHIP',
  'SHIPPED',
];

export function esTransicionDelVendedor(desde: OrderStatus, hacia: OrderStatus): boolean {
  return ESTADOS_DE_PREPARACION.includes(hacia) && transicionValida(desde, hacia);
}

// ═══════════════════════════════════════════════════════════════════════════
// INTENTO DE COBRO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Transiciones de un intento.
 *
 * `UNKNOWN_PENDING_RECONCILIATION` es el estado que hace que todo esto sea
 * seguro: puede ir a cualquier desenlace, porque cuando el conciliador
 * finalmente pregunta, la respuesta puede ser cualquiera.
 */
const TRANSICIONES_INTENTO: Readonly<Record<PaymentAttemptStatus, readonly PaymentAttemptStatus[]>> =
  {
    CREATED: ['PROCESSING', 'APPROVED', 'REJECTED', 'UNKNOWN_PENDING_RECONCILIATION', 'CANCELLED'],
    PROCESSING: ['APPROVED', 'REJECTED', 'UNKNOWN_PENDING_RECONCILIATION', 'CANCELLED'],
    UNKNOWN_PENDING_RECONCILIATION: ['APPROVED', 'REJECTED', 'CANCELLED'],
    /** Sólo hacia la devolución. Un aprobado no se "desaprueba". */
    APPROVED: ['REFUNDED'],
    REJECTED: [],
    CANCELLED: [],
    REFUNDED: [],
  };

export function transicionDeIntentoValida(
  desde: PaymentAttemptStatus,
  hacia: PaymentAttemptStatus,
): boolean {
  return TRANSICIONES_INTENTO[desde].includes(hacia);
}

/** Estados en los que el conciliador tiene que preguntarle al proveedor. */
export function necesitaConciliacion(status: PaymentAttemptStatus): boolean {
  return status === 'PROCESSING' || status === 'UNKNOWN_PENDING_RECONCILIATION';
}

/** ¿Terminó de una forma que ya no cambia sola? */
export function intentoResuelto(status: PaymentAttemptStatus): boolean {
  return TRANSICIONES_INTENTO[status].length === 0 || status === 'APPROVED';
}

/**
 * Traduce el estado de Mercado Pago al nuestro.
 *
 * ─── La línea que más importa de este archivo ───
 *
 * El `default`. Un estado que no conocemos **no se adivina**: se marca para
 * conciliar. Mapear lo desconocido a `REJECTED` sería decirle a alguien que no
 * le cobraron cuando quizá sí, y dejarlo pagar de nuevo.
 */
export function mapearEstadoMp(mpStatus: string | undefined): PaymentAttemptStatus {
  switch ((mpStatus ?? '').toLowerCase()) {
    case 'approved':
      return 'APPROVED';
    case 'rejected':
      return 'REJECTED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    case 'refunded':
    case 'charged_back':
      return 'REFUNDED';
    case 'pending':
    case 'in_process':
    case 'in_mediation':
    case 'authorized':
      // Todavía se está resolviendo del lado de ellos.
      return 'PROCESSING';
    default:
      return 'UNKNOWN_PENDING_RECONCILIATION';
  }
}

/**
 * Estado de orden que corresponde a un desenlace del cobro.
 *
 * Devuelve `null` cuando el intento no dice nada definitivo sobre la orden: un
 * cobro incierto NO mueve la orden, la deja donde está hasta que se sepa.
 */
export function estadoDeOrdenPara(intento: PaymentAttemptStatus): OrderStatus | null {
  switch (intento) {
    case 'APPROVED':
      return 'PAID';
    case 'REJECTED':
      return 'PAYMENT_FAILED';
    case 'PROCESSING':
    case 'CREATED':
      return 'PROCESSING_PAYMENT';
    case 'UNKNOWN_PENDING_RECONCILIATION':
      // Se queda en PROCESSING_PAYMENT: hay un cobro en vuelo y no se puede
      // lanzar otro hasta saber qué pasó.
      return 'PROCESSING_PAYMENT';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'REFUNDED':
      return 'REFUNDED';
  }
}

/**
 * ¿Hay que aplicar este cambio de estado a la orden?
 *
 * ─── La guarda de monotonía, medida en producción ───
 *
 * En la primera compra real del spike pasó esto:
 *
 *     07:46:12.307  respuesta directa   PROCESSING → PAID
 *     07:46:12.988  webhook             PAID       → PAID
 *
 * El webhook llegó 681 ms después de que la respuesta directa ya había
 * acreditado. Sin esta guarda, dos caminos de confirmación habrían acreditado
 * el mismo pago dos veces — y habría pasado en la PRIMERA compra, sin que
 * nadie lo provocara.
 *
 * La regla: una orden que ya tiene plata no retrocede. Ningún aviso posterior
 * de "pendiente" o "rechazado" la despaga. Sólo se avanza.
 */
export function debeAplicarse(actual: OrderStatus, propuesto: OrderStatus): boolean {
  if (actual === propuesto) return false;
  return transicionValida(actual, propuesto);
}
