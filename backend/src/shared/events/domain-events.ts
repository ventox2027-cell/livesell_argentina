import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Eventos de dominio del monolito.
 *
 * ─── Por qué un emisor en proceso y no una cola ───
 *
 * Kafka, RabbitMQ o incluso BullMQ resuelven un problema que todavía no
 * tenemos: comunicación entre servicios que no comparten proceso. Acá todo
 * corre en el mismo, así que un emisor en memoria hace exactamente lo mismo
 * sin agregar infraestructura que hay que operar, monitorear y pagar.
 *
 * Lo que sí compra publicar eventos ahora es el **desacoplamiento**: cuando
 * llegue el índice de búsqueda, las notificaciones o el feed, se van a
 * suscribir acá en vez de meterle llamadas al servicio de productos. El día
 * que haga falta una cola de verdad, se cambia la implementación de esta clase
 * y los publicadores no se enteran.
 *
 * ─── La regla que hace que esto no rompa nada ───
 *
 * **Los eventos se publican DESPUÉS de que la transacción cometió.**
 *
 * Publicar dentro de la transacción es un error clásico: un suscriptor
 * reacciona a un producto que todavía no existe para nadie más, o peor, la
 * transacción se revierte y el evento ya salió — el índice de búsqueda queda
 * con un producto fantasma.
 *
 * ─── Y la que evita que un suscriptor tumbe una venta ───
 *
 * Un fallo en un suscriptor **no puede** propagarse a quien publicó. Que el
 * índice de búsqueda esté caído no puede impedir que un vendedor cargue un
 * producto.
 */

export const DomainEvent = {
  sellerCreated: 'seller.created',
  sellerUpdated: 'seller.updated',
  sellerSuspended: 'seller.suspended',

  storeCreated: 'store.created',
  storeUpdated: 'store.updated',

  productCreated: 'product.created',
  productUpdated: 'product.updated',
  productActivated: 'product.activated',
  productArchived: 'product.archived',
  productDeleted: 'product.deleted',

  variantCreated: 'variant.created',
  variantUpdated: 'variant.updated',
  variantDeleted: 'variant.deleted',

  imageAdded: 'image.added',
  imageRemoved: 'image.removed',

  // ─── Inventario ───
  //
  // Estos van a alimentar, sin que el inventario se entere: el chat del vivo
  // ("¡quedan 2!"), el feed, las notificaciones al vendedor y las analíticas.
  // Por eso se emiten ahora aunque todavía no los escuche nadie: el día que
  // exista el suscriptor, no hay que tocar el camino de la venta.
  inventoryCreated: 'inventory.created',
  inventoryUpdated: 'inventory.updated',
  /// La disponibilidad cruzó hacia abajo el umbral de "quedan pocas".
  inventoryLow: 'inventory.low',
  inventoryOutOfStock: 'inventory.out_of_stock',
  inventoryBackInStock: 'inventory.back_in_stock',

  reservationCreated: 'reservation.created',
  reservationExpired: 'reservation.expired',
  reservationCancelled: 'reservation.cancelled',
  reservationConsumed: 'reservation.consumed',
} as const;

export type DomainEventName = (typeof DomainEvent)[keyof typeof DomainEvent];

export interface DomainEventPayload {
  /** Id de la entidad afectada. */
  entityId: string;
  /** Quién lo provocó. `null` cuando lo hizo el sistema. */
  actorId?: string | null;
  /** Datos mínimos para que un suscriptor no tenga que volver a consultar. */
  data?: Record<string, unknown>;
}

@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);

  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Publica un evento.
   *
   * No espera a los suscriptores y nunca lanza. Quien publica ya terminó su
   * trabajo; lo que pase después es problema de quien escucha.
   */
  publish(name: DomainEventName, payload: DomainEventPayload): void {
    try {
      this.emitter.emit(name, { name, at: new Date(), ...payload });
    } catch (err) {
      this.logger.error({
        msg: 'no se pudo publicar un evento de dominio',
        event: name,
        entityId: payload.entityId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
