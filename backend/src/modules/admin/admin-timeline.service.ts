import { Injectable } from '@nestjs/common';

import { PrismaService } from '@/shared/prisma/prisma.service';

/**
 * La cronología de una orden, contada en castellano.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA PANTALLA QUE JUSTIFICA EL PANEL ENTERO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Todo lo demás del admin son listados que se podrían resolver con una consulta
 * a mano. Esto no.
 *
 * Cuando alguien escribe *"pagué y no me llegó"*, la respuesta está repartida
 * en cinco tablas y ninguna cuenta la historia completa: la orden dice
 * `PAYMENT_REQUIRES_REFUND`, hay dos intentos de pago con estados distintos,
 * un webhook llegó tarde, y hay una devolución en curso. Cada pieza por
 * separado es un dato; juntas y en orden son una explicación.
 *
 * Hoy eso se responde entrando a PostgreSQL con un `psql` y cruzando
 * timestamps a ojo. Eso no escala a nadie que no haya escrito el sistema, y es
 * exactamente lo que este panel existe para eliminar.
 *
 * ─── Por qué se arma en el backend y no en el frontend ───
 *
 * Porque ordenar cronológicamente eventos de cinco tablas requiere conocer las
 * reglas del dominio: que un `approvedAt` de un intento va después de su
 * `createdAt`, que un webhook duplicado no es un evento nuevo, que
 * `PAYMENT_REQUIRES_REFUND` significa "se cobró pero no había stock". Poner esa
 * lógica en React sería duplicar el dominio en un lugar donde nadie lo va a
 * mantener.
 *
 * ─── Sin JSON crudo ───
 *
 * Cada entrada tiene un texto legible. Si el operador tiene que interpretar un
 * volcado de la base para entender qué pasó, la pantalla no sirve: es el `psql`
 * de antes con más pasos.
 */

export type NivelEvento = 'ok' | 'aviso' | 'error' | 'neutro';

export interface EventoTimeline {
  fecha: Date;
  tipo: string;
  titulo: string;
  detalle?: string | null;
  nivel: NivelEvento;
  /** Para que el panel pueda enlazar a la entidad relacionada. */
  refTipo?: string;
  refId?: string;
}

/** Cómo se lee cada estado de orden en la cronología. */
const ESTADOS_ORDEN: Record<string, { titulo: string; nivel: NivelEvento }> = {
  PENDING_PAYMENT: { titulo: 'Orden creada, esperando pago', nivel: 'neutro' },
  PROCESSING_PAYMENT: { titulo: 'Cobro en curso', nivel: 'aviso' },
  PAID: { titulo: 'Pago acreditado', nivel: 'ok' },
  CONFIRMED: { titulo: 'Orden confirmada — stock descontado', nivel: 'ok' },
  PREPARING: { titulo: 'En preparación', nivel: 'ok' },
  READY_TO_SHIP: { titulo: 'Lista para despachar', nivel: 'ok' },
  SHIPPED: { titulo: 'Despachada', nivel: 'ok' },
  DELIVERED: { titulo: 'Entregada', nivel: 'ok' },
  PAYMENT_FAILED: { titulo: 'Pago rechazado', nivel: 'error' },
  PAYMENT_REQUIRES_REFUND: {
    titulo: 'Se cobró pero no había stock — hay que devolver',
    nivel: 'error',
  },
  CANCELLED: { titulo: 'Cancelada', nivel: 'neutro' },
  EXPIRED: { titulo: 'Vencida sin pagar', nivel: 'neutro' },
  REFUNDED: { titulo: 'Devuelta', nivel: 'neutro' },
};

const ESTADOS_INTENTO: Record<string, { titulo: string; nivel: NivelEvento }> = {
  CREATED: { titulo: 'Intento de cobro creado', nivel: 'neutro' },
  PROCESSING: { titulo: 'Cobro enviado al proveedor', nivel: 'aviso' },
  APPROVED: { titulo: 'Cobro aprobado', nivel: 'ok' },
  REJECTED: { titulo: 'Cobro rechazado', nivel: 'error' },
  CANCELLED: { titulo: 'Intento cancelado', nivel: 'neutro' },
  REFUNDED: { titulo: 'Cobro devuelto', nivel: 'neutro' },
  UNKNOWN_PENDING_RECONCILIATION: {
    titulo: 'Resultado desconocido — esperando conciliación',
    nivel: 'error',
  },
};

@Injectable()
export class AdminTimelineService {
  constructor(private readonly prisma: PrismaService) {}

  async de(orderId: string): Promise<EventoTimeline[]> {
    const orden = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        attempts: { orderBy: { createdAt: 'asc' } },
        refunds: { orderBy: { createdAt: 'asc' } },
        items: true,
      },
    });
    if (!orden) return [];

    const eventos: EventoTimeline[] = [];

    // ─── La orden ────────────────────────────────────────────────────────────

    eventos.push({
      fecha: orden.createdAt,
      tipo: 'order.created',
      titulo: 'Orden creada',
      detalle: `${orden.items.length} artículo(s) · total ${centavos(orden.grossAmount)}`,
      nivel: 'neutro',
      refTipo: 'order',
      refId: orden.id,
    });

    if (orden.reservationId) {
      eventos.push({
        fecha: orden.createdAt,
        tipo: 'inventory.reserved',
        titulo: 'Stock reservado',
        detalle: `reserva ${orden.reservationId}`,
        nivel: 'ok',
        refTipo: 'reservation',
        refId: orden.reservationId,
      });
    }

    // ─── Los intentos de cobro ───────────────────────────────────────────────

    for (const [i, intento] of orden.attempts.entries()) {
      const tarjeta = intento.brand
        ? ` · ${intento.brand}${intento.lastFour ? ` ****${intento.lastFour}` : ''}`
        : '';

      eventos.push({
        fecha: intento.createdAt,
        tipo: 'payment.attempt_created',
        titulo: `Intento de cobro #${i + 1}${tarjeta}`,
        detalle: centavos(intento.amount),
        nivel: 'neutro',
        refTipo: 'payment_attempt',
        refId: intento.id,
      });

      /**
       * El estado final del intento, fechado lo mejor que se pueda.
       *
       * `approvedAt` sólo existe si se aprobó. Para los demás desenlaces se usa
       * `updatedAt`, que es cuándo quedó en ese estado. No es exacto —una
       * modificación posterior lo corre— pero es la mejor aproximación que hay
       * sin agregar una tabla de transiciones, y para entender qué pasó alcanza.
       */
      const desenlace = ESTADOS_INTENTO[intento.status];
      if (desenlace && intento.status !== 'CREATED') {
        eventos.push({
          fecha: intento.approvedAt ?? intento.updatedAt,
          tipo: `payment.${intento.status.toLowerCase()}`,
          titulo: desenlace.titulo,
          detalle:
            intento.failureMessageSafe ??
            (intento.providerPaymentId ? `pago ${intento.providerPaymentId}` : null),
          nivel: desenlace.nivel,
          refTipo: 'payment_attempt',
          refId: intento.id,
        });
      }

      if (intento.lastCheckedAt) {
        eventos.push({
          fecha: intento.lastCheckedAt,
          tipo: 'payment.reconciled',
          titulo: 'Consultado contra el proveedor',
          detalle: `estado: ${intento.status}`,
          nivel: 'neutro',
          refTipo: 'payment_attempt',
          refId: intento.id,
        });
      }
    }

    // ─── Hitos de la orden ───────────────────────────────────────────────────

    const hito = (fecha: Date | null | undefined, estado: string) => {
      if (!fecha) return;
      const e = ESTADOS_ORDEN[estado];
      if (!e) return;
      eventos.push({
        fecha,
        tipo: `order.${estado.toLowerCase()}`,
        titulo: e.titulo,
        detalle: orden.statusReason,
        nivel: e.nivel,
        refTipo: 'order',
        refId: orden.id,
      });
    };

    hito(orden.paidAt, 'PAID');
    hito(orden.confirmedAt, 'CONFIRMED');
    hito(orden.cancelledAt, 'CANCELLED');
    hito(orden.expiredAt, 'EXPIRED');
    hito(orden.refundedAt, 'REFUNDED');

    // ─── Devoluciones ────────────────────────────────────────────────────────

    for (const dev of orden.refunds) {
      eventos.push({
        fecha: dev.createdAt,
        tipo: 'refund.created',
        titulo: 'Devolución iniciada',
        detalle: `${centavos(dev.amount)} · ${dev.reason}`,
        nivel: 'aviso',
        refTipo: 'refund',
        refId: dev.id,
      });

      if (dev.completedAt) {
        eventos.push({
          fecha: dev.completedAt,
          tipo: 'refund.completed',
          titulo: 'Devolución acreditada',
          detalle: dev.providerRefundId ? `devolución ${dev.providerRefundId}` : null,
          nivel: 'ok',
          refTipo: 'refund',
          refId: dev.id,
        });
      } else if (dev.status === 'FAILED') {
        eventos.push({
          fecha: dev.updatedAt,
          tipo: 'refund.failed',
          titulo: `Devolución fallida (intento ${dev.attempts})`,
          detalle: dev.failureMessageSafe,
          nivel: 'error',
          refTipo: 'refund',
          refId: dev.id,
        });
      }
    }

    // ─── Webhooks del proveedor ──────────────────────────────────────────────
    //
    // Se buscan por el id de pago del proveedor, que es lo que trae la
    // notificación. Un webhook sin intento asociado no aparece acá — aparece en
    // la pantalla de webhooks, que existe justamente para eso.

    const idsProveedor = orden.attempts
      .map((a) => a.providerPaymentId)
      .filter((x): x is string => !!x);

    if (idsProveedor.length > 0) {
      const webhooks = await this.prisma.mpWebhookEvent.findMany({
        where: { resourceId: { in: idsProveedor } },
        orderBy: { receivedAt: 'asc' },
        take: 50,
      });

      for (const w of webhooks) {
        /**
         * Un webhook duplicado no es un problema: Mercado Pago reintenta hasta
         * recibir un 200, y a veces manda la misma notificación dos veces. Lo
         * decimos explícitamente para que quien lee no crea que encontró algo.
         */
        const duplicado = w.processedAt !== null && w.error === null;

        eventos.push({
          fecha: w.receivedAt,
          tipo: 'webhook.received',
          titulo: w.signatureValid
            ? `Webhook de Mercado Pago (${w.topic})`
            : '⚠️ Webhook con firma inválida — descartado',
          detalle: w.error
            ? `error al procesar: ${w.error}`
            : duplicado
              ? 'procesado'
              : 'recibido, sin procesar',
          nivel: !w.signatureValid ? 'error' : w.error ? 'error' : 'neutro',
          refTipo: 'webhook',
          refId: w.id,
        });
      }
    }

    // ─── Acciones administrativas ────────────────────────────────────────────
    //
    // Si alguien de soporte tocó esta orden, tiene que verse en la misma
    // cronología. Una intervención manual invisible es la peor clase de dato
    // faltante cuando se investiga algo raro.

    const auditoria = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'order', entityId: orden.id },
          { entityType: 'payment_attempt', entityId: { in: orden.attempts.map((a) => a.id) } },
          { entityType: 'refund', entityId: { in: orden.refunds.map((r) => r.id) } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    for (const a of auditoria) {
      eventos.push({
        fecha: a.createdAt,
        tipo: `audit.${a.action}`,
        titulo:
          a.actorType === 'admin' ? `Acción de soporte: ${a.action}` : `Registro: ${a.action}`,
        detalle: a.reason,
        nivel: a.actorType === 'admin' ? 'aviso' : 'neutro',
        refTipo: a.entityType,
        refId: a.entityId,
      });
    }

    /**
     * Orden cronológico, con desempate estable.
     *
     * Varios eventos comparten timestamp al milisegundo: cuando un pago se
     * aprueba, la orden pasa a `PAID` y se confirma el inventario dentro de la
     * misma transacción. Sin desempate, el orden entre ellos cambiaría entre
     * dos cargas de la pantalla y contaría la historia distinta cada vez.
     */
    return eventos.sort((a, b) => {
      const d = a.fecha.getTime() - b.fecha.getTime();
      return d !== 0 ? d : a.tipo.localeCompare(b.tipo);
    });
  }
}

/** Centavos enteros a texto legible. Sólo para el detalle de la cronología. */
function centavos(v: number): string {
  return `$ ${(v / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
}
