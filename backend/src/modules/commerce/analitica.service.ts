import { Injectable } from '@nestjs/common';

import { MembresiasService } from '@/modules/sellers/membresias.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';

import { VISTOS_RETENCION_DIAS } from '@/modules/social/vistos';

import { Embudo, dondeSePierde, recorteDeHistorial, tasasDe } from './analitica';

/**
 * Las métricas del vendedor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SE CUENTA LO QUE HAY, Y SE DICE QUÉ SE CONTÓ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cada número sale de una tabla. Cuando un dato no existe, la respuesta dice
 * `null` y la app muestra «todavía no sabemos» — nunca un cero que se lee como
 * «te fue mal».
 *
 * Ver `analitica.ts` para por qué el primer escalón se llama «personas que lo
 * miraron» y no «visitas».
 */
@Injectable()
export class AnaliticaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membresias: MembresiasService,
  ) {}

  private async vendedorDe(userId: string) {
    const vendedor = await this.prisma.seller.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendedor) throw new DomainError('SELLER_NOT_FOUND', 'Todavía no sos vendedor');
    return vendedor.id;
  }

  /**
   * El embudo de la tienda entera.
   *
   * Es de VendoX Pro: `ANALITICA_AVANZADA`. Un vendedor Free ve sus ventas —eso
   * está en «Mis ventas» y siempre fue gratis—; lo que compra Pro es el embudo,
   * que es lo que permite entender por qué no vende más.
   */
  async embudoDeLaTienda(userId: string) {
    const sellerId = await this.vendedorDe(userId);
    await this.membresias.exigirBeneficio(sellerId, 'ANALITICA_AVANZADA');

    const limites = await this.membresias.limitesDe(sellerId);
    const desde = recorteDeHistorial(limites.diasDeHistorial);

    const productos = await this.prisma.product.findMany({
      where: { store: { sellerId }, deletedAt: null },
      select: { id: true },
    });
    const ids = productos.map((p) => p.id);

    if (ids.length === 0) {
      return {
        desde,
        /** Nunca publicó nada. No es un embudo vacío: es que no hay embudo. */
        sinProductos: true as const,
        embudo: null,
        tasas: null,
        dondeSePierde: null,
        ventanaDeInteresadosEnDias: VISTOS_RETENCION_DIAS,
      };
    }

    const embudo = await this.contar(sellerId, ids, desde);

    return {
      desde,
      sinProductos: false as const,
      embudo,
      tasas: tasasDe(embudo),
      dondeSePierde: dondeSePierde(embudo),
      /**
       * ⚠️ Se informa la ventana explícitamente.
       *
       * «120 personas lo miraron» sin decir en cuánto tiempo no significa nada,
       * y el vendedor lo va a leer como «desde siempre». Son 30 días porque es
       * lo que `RecentlyViewed` conserva. Ver `social/vistos.ts`.
       */
      ventanaDeInteresadosEnDias: VISTOS_RETENCION_DIAS,
    };
  }

  /** El embudo de UN producto. Mismo criterio, misma advertencia. */
  async embudoDeProducto(userId: string, productId: string) {
    const sellerId = await this.vendedorDe(userId);
    await this.membresias.exigirBeneficio(sellerId, 'ANALITICA_AVANZADA');

    // La pertenencia va en el WHERE: un producto ajeno no se encuentra.
    const producto = await this.prisma.product.findFirst({
      where: { id: productId, store: { sellerId }, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!producto) throw new DomainError('PRODUCT_NOT_FOUND', 'No existe ese producto');

    const limites = await this.membresias.limitesDe(sellerId);
    const desde = recorteDeHistorial(limites.diasDeHistorial);
    const embudo = await this.contar(sellerId, [producto.id], desde);

    return {
      productId: producto.id,
      nombre: producto.name,
      desde,
      embudo,
      tasas: tasasDe(embudo),
      dondeSePierde: dondeSePierde(embudo),
      ventanaDeInteresadosEnDias: VISTOS_RETENCION_DIAS,
    };
  }

  /**
   * Los cuatro escalones, contados de sus tablas.
   *
   * Las cuatro consultas van en paralelo: son independientes y esperar una
   * atrás de otra multiplicaría por cuatro la espera de una pantalla que ya es
   * lenta por naturaleza.
   */
  private async contar(sellerId: string, productIds: string[], desde: Date): Promise<Embudo> {
    /**
     * Las reservas apuntan a la VARIANTE, no al producto.
     *
     * Hay que resolver los ids antes: `InventoryReservation` no tiene relación
     * navegable hacia `Product`, y la alternativa —una consulta cruda con
     * `JOIN`— sería más rápida y mucho más fácil de romper en la próxima
     * migración.
     */
    const variantes = await this.prisma.productVariant.findMany({
      where: { productId: { in: productIds } },
      select: { id: true },
    });
    const variantIds = variantes.map((v) => v.id);

    const [interesados, guardados, apartados, vendidos] = await Promise.all([
      /**
       * ⚠️ Personas distintas, no visitas.
       *
       * La restricción única de `RecentlyViewed` es por (persona, producto), y
       * la tabla se poda a 30 días. Contar filas ES contar personas distintas
       * en esa ventana — que es exactamente lo que se informa.
       */
      this.prisma.recentlyViewed.count({
        where: { targetType: 'PRODUCT', targetId: { in: productIds } },
      }),

      this.prisma.like.count({
        where: { targetType: 'PRODUCT', targetId: { in: productIds } },
      }),

      /**
       * ⚠️ Con cero variantes se devuelve cero sin consultar.
       *
       * Prisma traduce `in: []` a `WHERE false`, así que la consulta también
       * daría cero — pero el atajo evita un viaje a la base y deja explícito
       * que el caso está contemplado.
       */
      variantIds.length === 0
        ? Promise.resolve(0)
        : this.prisma.inventoryReservation.count({
            where: { productVariantId: { in: variantIds }, createdAt: { gte: desde } },
          }),

      /**
       * Vendidos = órdenes que llegaron a cobrarse.
       *
       * No las creadas: un carrito abandonado no es una venta, y contarlo
       * inflaría el último escalón justo donde el vendedor busca la verdad.
       */
      this.prisma.order.count({
        where: {
          sellerId,
          createdAt: { gte: desde },
          items: { some: { productId: { in: productIds } } },
          status: { in: ['PAID', 'CONFIRMED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'] },
        },
      }),
    ]);

    return { interesados, guardados, apartados, vendidos };
  }
}
