import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DomainEvent } from '@/shared/events/domain-events';
import { PrismaService } from '@/shared/prisma/prisma.service';

import { LiveService } from './live.service';

/**
 * Avisa a los vivos cuando cambia el stock de lo que están mostrando.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ UN OYENTE DE EVENTOS Y NO UNA LLAMADA DIRECTA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo directo sería que `InventoryService` llamara a `LiveService.avisarStock()`
 * al reservar. Eso está mal por dos razones:
 *
 * **El acoplamiento va al revés.** El inventario es el núcleo del sistema y no
 * tiene por qué saber que existen los vivos. Los vivos son una forma de vender;
 * mañana hay otra, y el inventario no debería enterarse de ninguna.
 *
 * **La dependencia sería circular.** El vivo necesita consultar inventario para
 * mostrar el producto destacado. Si además el inventario dependiera del vivo,
 * los dos módulos se importarían mutuamente.
 *
 * Con el bus, el inventario publica "se creó una reserva" sin saber quién
 * escucha, y esto traduce ese hecho a un aviso para la sala.
 *
 * ─── Es un aviso, no una autorización ───
 *
 * Lo que llega a la app se usa para mostrar "últimas 3" y deshabilitar el
 * botón. **No autoriza ninguna venta.** Si este oyente fallara, se perdiera un
 * evento o llegara tarde, lo peor que pasa es que alguien vea un número viejo y
 * al tocar comprar reciba "sin stock" — que es exactamente lo que el UPDATE
 * condicional de PostgreSQL está ahí para decidir.
 */
@Injectable()
export class LiveStockListener {
  private readonly logger = new Logger(LiveStockListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
  ) {}

  /**
   * Los cuatro momentos en que cambia lo disponible de una variante.
   *
   * Reservar y consumir lo bajan; cancelar y vencer lo devuelven. Los cuatro
   * importan: ver que el stock **vuelve** cuando alguien abandona su carrito es
   * la mitad de la urgencia que genera un vivo.
   */
  @OnEvent(DomainEvent.reservationCreated)
  @OnEvent(DomainEvent.reservationCancelled)
  @OnEvent(DomainEvent.reservationExpired)
  @OnEvent(DomainEvent.reservationConsumed)
  async alCambiarUnaReserva(evento: { data?: { productVariantId?: string } }): Promise<void> {
    const variantId = evento.data?.productVariantId;
    if (!variantId) return;

    try {
      const inventario = await this.prisma.inventory.findUnique({
        where: { productVariantId: variantId },
        select: { onHand: true, reserved: true },
      });
      if (!inventario) return;

      await this.live.avisarStock(variantId, inventario.onHand - inventario.reserved);
    } catch (err) {
      /**
       * Nunca propaga.
       *
       * Esto corre después de que la reserva ya está cometida. Si avisar
       * fallara y el error subiera, la petición del comprador devolvería un
       * error habiendo reservado el stock: vería "no se pudo" con la unidad ya
       * apartada a su nombre.
       */
      this.logger.warn({
        msg: 'no se pudo avisar el cambio de stock a los vivos',
        variantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
