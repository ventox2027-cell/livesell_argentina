import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { NotificationsService } from '@/modules/notifications/notifications.service';
import { DomainEvent } from '@/shared/events/domain-events';
import { PrismaService } from '@/shared/prisma/prisma.service';

/**
 * Avisa cuando algo que alguien GUARDÓ vuelve a tener stock.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ES EL ÚNICO AVISO QUE SALE DE UNA LISTA, Y POR ESO ES DE GUARDADOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El mismo aviso sobre «vistos recientemente» sería perseguir a alguien por
 * haber mirado algo diez segundos. Sobre un guardado es un favor: la persona
 * dijo explícitamente que le interesaba y se encontró con que no había stock.
 *
 * Esa diferencia es la razón entera por la que guardados y vistos son dos
 * tablas y no una con una bandera.
 *
 * ─── Por qué un oyente de eventos ───
 *
 * Mismo motivo que `LiveStockListener`: el inventario es el núcleo del sistema
 * y no tiene por qué saber que existen los guardados. Publica «cambió una
 * reserva» sin saber quién escucha.
 */
@Injectable()
export class StockGuardadosListener {
  private readonly logger = new Logger(StockGuardadosListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Un solo evento: `inventoryBackInStock`.
   *
   * ⚠️ Ya existía y se emite **sólo en el cruce** de cero a disponible, no en
   * cada movimiento de stock. Eso es exactamente lo que hace falta acá.
   *
   * Escuchar las cancelaciones y los vencimientos de reserva hubiera sido peor
   * por partida doble: se dispararía en cada abandono de carrito aunque el
   * producto siguiera agotado por otras reservas, y habría que reimplementar
   * la detección del cruce que el inventario ya hace bien.
   *
   * Además cubre el caso más común de «volvió», que no es una reserva que
   * vence sino el vendedor cargando mercadería nueva.
   */
  @OnEvent(DomainEvent.inventoryBackInStock)
  async alVolverElStock(evento: { data?: { productVariantId?: string } }): Promise<void> {
    const variantId = evento.data?.productVariantId;
    if (!variantId) return;

    try {
      const variante = await this.prisma.productVariant.findUnique({
        where: { id: variantId },
        select: {
          productId: true,
          inventory: { select: { onHand: true, reserved: true } },
          product: { select: { name: true, status: true, deletedAt: true } },
        },
      });

      if (!variante?.inventory || !variante.product) return;

      // Sólo si de verdad hay algo para comprar. El evento dice «cambió», no
      // «hay»: una cancelación puede devolver una unidad de un producto que
      // igual sigue agotado por otras reservas.
      const disponible = variante.inventory.onHand - variante.inventory.reserved;
      if (disponible <= 0) return;

      // Y sólo si el producto se puede comprar. Un producto pausado que recupera
      // stock no es una noticia.
      if (variante.product.status !== 'ACTIVE' || variante.product.deletedAt) return;

      const guardaron = await this.prisma.like.findMany({
        where: { targetType: 'PRODUCT', targetId: variante.productId },
        select: { userId: true },
        // Tope: un producto muy guardado no puede generar cien mil avisos en
        // el camino de una cancelación de reserva.
        take: 2_000,
      });

      for (const { userId } of guardaron) {
        await this.notifications.crear({
          userId,
          type: 'SAVED_BACK_IN_STOCK',
          title: 'Volvió lo que guardaste',
          body: variante.product.name,
          data: { productId: variante.productId, ruta: `/producto/${variante.productId}` },
          /**
           * ⚠️ La clave incluye el producto y la persona, pero **no** la fecha.
           *
           * Así, si el stock se agota y vuelve cinco veces en una tarde —cosa
           * que pasa durante un vivo cada vez que alguien abandona su carrito—
           * la persona recibe UN aviso, no cinco.
           *
           * El costo es que si vuelve de verdad tres meses después no se avisa
           * otra vez. Es el lado correcto del error: el ruido espanta más que
           * el silencio.
           */
          dedupeKey: `back-in-stock:${variante.productId}:${userId}`,
        });
      }
    } catch (err) {
      /**
       * Nunca propaga.
       *
       * Esto corre después de que la reserva ya está cometida. Si avisar
       * fallara y el error subiera, la petición del comprador devolvería un
       * error por algo que ya salió bien.
       */
      this.logger.error({
        msg: 'no se pudo avisar el regreso de stock',
        variantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
