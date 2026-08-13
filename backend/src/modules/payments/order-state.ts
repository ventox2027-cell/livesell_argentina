import type { PayOrderStatus, PayPaymentStatus } from '@prisma/client';

/**
 * Máquina de estados de la orden.
 *
 * Está en un archivo aparte, sin Prisma ni Nest, por una razón concreta: es la
 * lógica donde un error se traduce directamente en plata perdida o en un
 * comprador cobrado dos veces, y tiene que poder martillarse con tests sin
 * base de datos ni red.
 *
 * ─── El problema real que resuelve ───
 *
 * Los webhooks de Mercado Pago llegan duplicados, desordenados, o no llegan.
 * Concretamente, esto pasa y hay que sobrevivirlo:
 *
 *   1. Llega `approved` y después `pending` del MISMO pago, en ese orden,
 *      porque el reintento del primero se demoró más que el segundo envío.
 *   2. Llega el mismo `approved` cuatro veces.
 *   3. No llega nada y el conciliador descubre el pago media hora después.
 *
 * La regla que hace que los tres casos terminen bien es la MONOTONÍA: una
 * orden nunca retrocede. Si ya está paga, ningún aviso posterior de "pendiente"
 * o "rechazado" puede despagarla. Sólo una devolución o un contracargo la
 * mueven, y hacia adelante.
 */

/** Traduce el estado de Mercado Pago al nuestro sin interpretar de más. */
export function mapMpStatus(mpStatus: string | undefined): PayPaymentStatus {
  switch ((mpStatus ?? '').toLowerCase()) {
    case 'pending':
      return 'PENDING';
    case 'in_process':
      return 'IN_PROCESS';
    case 'authorized':
      return 'AUTHORIZED';
    case 'approved':
      return 'APPROVED';
    case 'rejected':
      return 'REJECTED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    case 'refunded':
      return 'REFUNDED';
    case 'charged_back':
      return 'CHARGED_BACK';
    default:
      // Un estado que no conocemos NO se adivina. `UNKNOWN` deja la orden
      // quieta y visible en el panel, que es preferible a que el código elija
      // mal en nombre de nadie.
      return 'UNKNOWN';
  }
}

/**
 * Grado de avance de un estado de orden. Sólo se permite avanzar.
 *
 * Los cuatro estados de rango 0 son "todavía en juego": entre ellos la orden
 * se mueve libremente en cualquier dirección, porque todos son transiciones
 * legítimas de un cobro que aún no se resolvió. Un pago en proceso que después
 * se rechaza TIENE que poder pasar a `FAILED`; si la guarda se lo impidiera,
 * la orden quedaría clavada en `PROCESSING` para siempre y el comprador no
 * podría reintentar con otra tarjeta.
 *
 * Lo que la guarda protege es exactamente esto: **una vez que hay plata
 * acreditada, no se retrocede**. De `PAID` sólo se sale hacia adelante, y el
 * único camino hacia adelante es una devolución o un contracargo.
 */
const RANK: Record<PayOrderStatus, number> = {
  PENDING_PAYMENT: 0,
  PROCESSING: 0,
  FAILED: 0,
  CANCELLED: 0,
  PAID: 2,
  REFUNDED: 3,
};

/** Estado de orden que corresponde a un estado de pago, ignorando el historial. */
function statusFor(payment: PayPaymentStatus): PayOrderStatus | null {
  switch (payment) {
    case 'APPROVED':
      return 'PAID';
    case 'PENDING':
    case 'IN_PROCESS':
    case 'AUTHORIZED':
      return 'PROCESSING';
    case 'REJECTED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'REFUNDED':
    case 'CHARGED_BACK':
      return 'REFUNDED';
    case 'UNKNOWN':
      // Nada que decidir: dejar la orden como está.
      return null;
  }
}

export interface TransitionResult {
  status: PayOrderStatus;
  changed: boolean;
  /** Motivo por el que se ignoró el cambio. Se escribe en la auditoría. */
  ignoredReason?: 'MONOTONIC_GUARD' | 'UNKNOWN_STATUS' | 'SAME_STATUS';
}

/**
 * Calcula el próximo estado de la orden.
 *
 * `nextOrderStatus(actual, nuevoPago)` es total y determinista: mismas
 * entradas, misma salida, sin efectos. Todo el resto del módulo de pagos
 * depende de que esto sea correcto.
 */
export function nextOrderStatus(
  current: PayOrderStatus,
  paymentStatus: PayPaymentStatus,
): TransitionResult {
  const target = statusFor(paymentStatus);
  if (target == null) {
    return { status: current, changed: false, ignoredReason: 'UNKNOWN_STATUS' };
  }
  if (target === current) {
    return { status: current, changed: false, ignoredReason: 'SAME_STATUS' };
  }

  // La guarda que hace todo lo demás seguro: nunca hacia atrás.
  if (RANK[target] < RANK[current]) {
    return { status: current, changed: false, ignoredReason: 'MONOTONIC_GUARD' };
  }

  return { status: target, changed: true };
}

/** ¿El estado permite iniciar un nuevo intento de cobro? */
export function canAttemptPayment(status: PayOrderStatus): boolean {
  // PROCESSING queda fuera adrede: si hay un cobro en vuelo del que no sabemos
  // el resultado, lanzar otro es la receta para cobrar dos veces.
  return status === 'PENDING_PAYMENT' || status === 'FAILED';
}

/** ¿Hay que preguntarle a Mercado Pago por esta orden? */
export function needsReconciliation(status: PayOrderStatus): boolean {
  return status === 'PROCESSING';
}

/** Centavos → unidades de moneda, que es como los quiere Mercado Pago. */
export function centsToAmount(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Unidades → centavos.
 *
 * `Math.round` y no `Math.trunc`: `1500.00` puede volver de JSON como
 * `1499.9999999999998`, y truncar convertiría $1500 en $1499,99.
 */
export function amountToCents(amount: number): number {
  return Math.round(amount * 100);
}
