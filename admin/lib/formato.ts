/**
 * Cómo se muestran las cosas.
 *
 * ─── El dinero llega en centavos enteros y se formatea acá ───
 *
 * El backend nunca divide por 100: hacerlo del lado del servidor introduce
 * decimales en un sistema que trabaja con enteros exactos a propósito. La
 * división pasa una sola vez, en el último momento, y sólo para mostrar.
 */

export function plata(centavos: number | null | undefined): string {
  if (centavos === null || centavos === undefined) return '—';
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 2,
  }).format(centavos / 100);
}

export function fecha(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function hora(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** "hace 3 minutos". Para saber si algo está pasando ahora o es de ayer. */
export function hace(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

export type Tono = 'ok' | 'aviso' | 'error' | 'neutro';

/**
 * Qué color le corresponde a cada estado.
 *
 * ⚠️ **El color nunca va solo.** Cada indicador del panel muestra además el
 * texto del estado. Entre el 5 y el 8 % de los varones tiene alguna deficiencia
 * en la visión del color, y "el rojo" como única señal de que una devolución
 * falló es una señal que parte del equipo no recibe.
 */
const TONOS: Record<string, Tono> = {
  // Órdenes
  CONFIRMED: 'ok',
  PAID: 'ok',
  PREPARING: 'ok',
  READY_TO_SHIP: 'ok',
  SHIPPED: 'ok',
  DELIVERED: 'ok',
  PENDING_PAYMENT: 'aviso',
  PROCESSING_PAYMENT: 'aviso',
  PAYMENT_FAILED: 'error',
  PAYMENT_REQUIRES_REFUND: 'error',
  CANCELLED: 'neutro',
  EXPIRED: 'neutro',
  REFUNDED: 'neutro',

  // Pagos
  APPROVED: 'ok',
  CREATED: 'neutro',
  PROCESSING: 'aviso',
  REJECTED: 'error',
  UNKNOWN_PENDING_RECONCILIATION: 'error',

  // Devoluciones
  COMPLETED: 'ok',
  PENDING: 'aviso',
  FAILED: 'error',

  // Usuarios y vendedores
  active: 'ok',
  ACTIVE: 'ok',
  suspended: 'error',
  SUSPENDED: 'error',
  deleted: 'neutro',
  BLOCKED: 'error',
  CLOSED: 'neutro',
  PAUSED: 'aviso',
  DRAFT: 'neutro',
  ARCHIVED: 'neutro',

  // Verificación
  VERIFIED: 'ok',
  UNVERIFIED: 'neutro',
  REJECTED_ID: 'error',
};

export function tonoDe(estado: string | null | undefined): Tono {
  if (!estado) return 'neutro';
  return TONOS[estado] ?? 'neutro';
}
