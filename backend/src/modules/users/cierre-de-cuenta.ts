import type { OrderStatus } from '@prisma/client';

import { DomainError } from '@/shared/errors/domain.error';

/**
 * Cuándo se puede cerrar una cuenta, y cuándo no.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL AGUJERO QUE ESTE ARCHIVO TAPA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cerrar la cuenta era un `DELETE` sin condiciones. Eso significa que un
 * vendedor podía cobrar diez pedidos, tocar "eliminar cuenta" y desaparecer:
 * diez personas con la plata puesta, esperando algo que nunca iba a llegar, y
 * del otro lado una cuenta anonimizada sin forma de contactar a nadie.
 *
 * No es un caso hipotético. Es la forma más barata de estafar en una
 * plataforma de venta, y no requiere saber nada de tecnología.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PERO EL DERECHO A IRSE ES REAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La Ley 25.326 le da a cualquier persona el derecho a que se supriman sus
 * datos. No se puede convertir "tenés un pedido en camino" en "no te podés ir
 * nunca": eso sería usar una regla legítima para retener gente.
 *
 * Por eso el bloqueo es **temporal y explicado**: dura lo que dura la
 * operación en curso, se dice cuántas son y qué hacer mientras tanto. Un pedido
 * entregado, cancelado o reembolsado no frena nada.
 *
 * ─── Módulo puro ───
 *
 * La lista de estados que bloquean es una decisión de negocio que se va a
 * discutir. Tiene que poder leerse de un vistazo y probarse sin base de datos.
 */

/**
 * Los estados en los que alguien está esperando algo.
 *
 * Se listan uno por uno en vez de excluir los terminales. La diferencia
 * importa: con una lista negativa, un estado nuevo agregado al enum entraría
 * automáticamente en "bloquea", y eso es un cambio de comportamiento que nadie
 * decidió. Así, un estado nuevo no bloquea hasta que alguien lo agregue acá.
 */
export const ESTADOS_QUE_IMPIDEN_CERRAR: readonly OrderStatus[] = [
  // Hay plata en juego y todavía no se resolvió.
  'PROCESSING_PAYMENT',
  'PAID',
  'CONFIRMED',
  'PAYMENT_REQUIRES_REFUND',
  'REFUND_PENDING',
  // Hay un producto en movimiento.
  'PREPARING',
  'READY_TO_SHIP',
  'SHIPPED',
];

/**
 * `PENDING_PAYMENT` NO está en la lista, y es deliberado.
 *
 * Es un carrito sin pagar: nadie puso plata y nadie está esperando nada. Vence
 * solo en minutos. Bloquear el cierre por eso sería retener a alguien por una
 * compra que abandonó.
 */

export interface OperacionesEnCurso {
  /** Pedidos donde esta persona es quien compra. */
  comoComprador: number;
  /** Pedidos donde esta persona es quien vende. */
  comoVendedor: number;
}

export function puedeCerrarCuenta(o: OperacionesEnCurso): boolean {
  return o.comoComprador === 0 && o.comoVendedor === 0;
}

export class CuentaConOperacionesEnCursoError extends DomainError {
  constructor(o: OperacionesEnCurso) {
    super('ACCOUNT_HAS_OPEN_ORDERS', mensaje(o), {
      pedidosComoComprador: o.comoComprador,
      ventasComoVendedor: o.comoVendedor,
    });
  }
}

/**
 * El mensaje dice CUÁNTAS operaciones y QUÉ hacer.
 *
 * "No podés cerrar tu cuenta ahora" a secas deja a la persona sin saber si es
 * un error del sistema, cuánto tiene que esperar, ni qué le falta. Con el
 * número puede ir a mirar sus pedidos y entender.
 *
 * Y el caso del vendedor se dice distinto: no es que él esté esperando algo, es
 * que hay gente esperándolo a él. Es la diferencia entre "aguantá un poco" y
 * "hay personas que te pagaron".
 */
function mensaje(o: OperacionesEnCurso): string {
  if (o.comoVendedor > 0 && o.comoComprador > 0) {
    return (
      `Tenés ${o.comoVendedor} ${plural(o.comoVendedor, 'venta', 'ventas')} sin entregar y ` +
      `${o.comoComprador} ${plural(o.comoComprador, 'compra', 'compras')} en curso. ` +
      'Cuando se completen vas a poder cerrar tu cuenta.'
    );
  }

  if (o.comoVendedor > 0) {
    return (
      `Tenés ${o.comoVendedor} ${plural(o.comoVendedor, 'venta', 'ventas')} sin entregar. ` +
      'Esas personas ya pagaron y están esperando su pedido. ' +
      'Cuando las completes vas a poder cerrar tu cuenta.'
    );
  }

  return (
    `Tenés ${o.comoComprador} ${plural(o.comoComprador, 'compra', 'compras')} en curso. ` +
    'Cuando llegue lo que compraste vas a poder cerrar tu cuenta. ' +
    'Si querés cancelar alguna, hacelo desde Mis pedidos.'
  );
}

function plural(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}
