import { Injectable, Logger } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';
import { PrismaService } from '@/shared/prisma/prisma.service';

/**
 * "Dame todo lo que tenés sobre mí."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La Ley 25.326 —artículo 14— le da a cualquier persona el derecho a acceder a
 * sus datos personales, gratis y cada seis meses como mínimo. No es opcional y
 * no depende de que alguien lo pida por escrito: si el producto no lo resuelve,
 * lo resuelve alguien del equipo a mano, con una consulta SQL, y esa es
 * exactamente la forma de que se filtre lo que no corresponde.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ SALE Y QUÉ NO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sale lo que es **de la persona**: su perfil, sus direcciones, sus compras,
 * sus reseñas, sus tickets de soporte, y si vende, su tienda y sus productos.
 *
 * NO sale:
 *
 *   · datos de otra gente. Sus ventas traen la dirección de quien compró, y esa
 *     dirección no es suya. Se recortan a lo que necesita para tener el
 *     registro de la operación;
 *   · el hash de su documento ni el de su CUIT. Devolver un hash no le sirve de
 *     nada y sí le sirve a quien le robe el archivo;
 *   · el nivel de riesgo ni los motivos que el equipo anotó. Es una evaluación
 *     interna, no un dato declarado por ella, y publicarla enseña a esquivarla;
 *   · ningún token, ni de Mercado Pago, ni de sesión, ni de push;
 *   · el código de entrega de pedidos ajenos. El propio sí, es suyo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ VA INLINE Y NO POR CORREO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo correcto a escala es generar el archivo en segundo plano y mandar un
 * enlace que vence. Hoy no hay ni cola dedicada ni correo transaccional
 * configurado, y montarlos para esto sería construir dos cosas para entregar
 * una.
 *
 * A cambio: la respuesta se arma en memoria y se limita. Una cuenta con diez
 * mil pedidos no puede tirar el proceso abajo, así que la exportación trae los
 * más recientes y dice cuántos quedaron afuera. Mentir por omisión —devolver
 * 500 pedidos como si fueran todos— sería peor que el límite.
 */

/**
 * Cuántas filas por colección.
 *
 * Alto para que a una persona real no le falte nada, y acotado para que la
 * respuesta entre en memoria. Cuando alguien lo supere, `truncado` lo dice.
 */
const LIMITE_POR_COLECCION = 1000;

@Injectable()
export class ExportacionService {
  private readonly logger = new Logger(ExportacionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async exportar(userId: string): Promise<Record<string, unknown>> {
    const usuario = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        emailVerified: true,
        phoneE164: true,
        phoneVerified: true,
        whatsappOptIn: true,
        avatarUrl: true,
        birthDate: true,
        birthDateDeclaredAt: true,
        role: true,
        status: true,
        locale: true,
        timezone: true,
        createdAt: true,
        lastSeenAt: true,
      },
    });

    const [identidades, direcciones, compras, ventas, resenias, tickets, avisos, vendedor] =
      await Promise.all([
        // El proveedor con el que entra y cuándo lo usó por última vez. NO el
        // `subject`: es un identificador que sirve para hacerse pasar por ella.
        this.prisma.userIdentity.findMany({
          where: { userId },
          select: { provider: true, email: true, createdAt: true, lastUsedAt: true },
        }),
        this.prisma.userAddress.findMany({
          where: { userId },
          take: LIMITE_POR_COLECCION,
          orderBy: { createdAt: 'desc' },
        }),
        this.comprasDe(userId),
        this.ventasDe(userId),
        this.prisma.review.findMany({
          where: { authorId: userId },
          take: LIMITE_POR_COLECCION,
          orderBy: { createdAt: 'desc' },
          select: { id: true, rating: true, comment: true, createdAt: true, orderId: true },
        }),
        this.prisma.supportTicket.findMany({
          where: { userId },
          take: LIMITE_POR_COLECCION,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            subject: true,
            status: true,
            category: true,
            createdAt: true,
            closedAt: true,
          },
        }),
        this.prisma.notification.findMany({
          where: { userId },
          take: LIMITE_POR_COLECCION,
          orderBy: { createdAt: 'desc' },
          select: { id: true, type: true, title: true, body: true, createdAt: true, readAt: true },
        }),
        this.tiendaDe(userId),
      ]);

    /**
     * Queda registrado que se exportó.
     *
     * Una exportación es el paquete más completo de datos personales que este
     * sistema produce. Si mañana aparece filtrado, la bitácora dice quién la
     * pidió y cuándo — y si alguna vez alguien la pide con una sesión robada,
     * es el único rastro que va a quedar.
     *
     * Se `await`ea, a diferencia del resto de las bitácoras del sistema: acá el
     * registro es parte de la operación, no un efecto secundario.
     */
    await this.audit.log({
      action: 'user.data_exported',
      entityType: 'user',
      entityId: userId,
      actorId: userId,
    });

    return {
      /** Cuándo se generó. Sirve para saber qué tan viejo es el archivo. */
      generadoEl: new Date().toISOString(),
      aviso:
        'Este archivo tiene tus datos personales. Guardalo en un lugar seguro: ' +
        'incluye tus direcciones de entrega y el detalle de tus compras.',
      usuario: {
        ...usuario,
        // Sin hora: es una fecha, no un instante. Ver `edad.ts`.
        birthDate: usuario.birthDate ? usuario.birthDate.toISOString().slice(0, 10) : null,
      },
      identidades,
      direcciones,
      compras,
      ventas,
      resenias,
      tickets,
      avisos,
      vendedor,
    };
  }

  /** Los pedidos donde esta persona compró. Con su código de entrega: es suyo. */
  private async comprasDe(userId: string) {
    const items = await this.prisma.order.findMany({
      where: { buyerId: userId },
      take: LIMITE_POR_COLECCION,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        reference: true,
        status: true,
        currency: true,
        itemsSubtotal: true,
        shippingAmount: true,
        processorSurchargeAmount: true,
        grossAmount: true,
        shippingAddress: true,
        createdAt: true,
        paidAt: true,
        deliveredAt: true,
        cancelledAt: true,
        refundedAt: true,
        items: {
          select: {
            productNameSnapshot: true,
            variantLabelSnapshot: true,
            quantity: true,
            unitPrice: true,
            subtotal: true,
          },
        },
      },
    });

    const total = await this.prisma.order.count({ where: { buyerId: userId } });
    return this.conRecorte(items, total);
  }

  /**
   * Los pedidos donde esta persona vendió.
   *
   * ⚠️ SIN la dirección de entrega y sin los datos de quien compró: esos son
   * datos de otra persona, y que hayan comprado en su tienda no se los
   * transfiere. Lo que sí es suyo es el registro de la operación: qué vendió,
   * en cuánto, cuándo y cuánto cobró.
   */
  private async ventasDe(userId: string) {
    const items = await this.prisma.order.findMany({
      where: { seller: { userId } },
      take: LIMITE_POR_COLECCION,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        reference: true,
        status: true,
        currency: true,
        itemsSubtotal: true,
        grossAmount: true,
        platformFeeBps: true,
        platformFeeAmount: true,
        sellerNetAmount: true,
        createdAt: true,
        paidAt: true,
        deliveredAt: true,
        items: {
          select: {
            productNameSnapshot: true,
            variantLabelSnapshot: true,
            quantity: true,
            unitPrice: true,
            subtotal: true,
          },
        },
      },
    });

    const total = await this.prisma.order.count({ where: { seller: { userId } } });
    return this.conRecorte(items, total);
  }

  /** La tienda y los productos, si vende. */
  private async tiendaDe(userId: string) {
    const seller = await this.prisma.seller.findUnique({
      where: { userId },
      select: {
        id: true,
        displayName: true,
        slug: true,
        bio: true,
        status: true,
        createdAt: true,
        stores: {
          select: { id: true, name: true, slug: true, status: true, createdAt: true },
        },
        // ⚠️ `verification` NO se incluye. Tiene el hash del documento y el
        // nivel de riesgo: lo primero no le sirve y lo segundo es una
        // evaluación interna.
      },
    });
    if (!seller) return null;

    const productos = await this.prisma.product.findMany({
      where: { store: { sellerId: seller.id } },
      take: LIMITE_POR_COLECCION,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        basePriceCents: true,
        status: true,
        createdAt: true,
        deletedAt: true,
      },
    });

    return { ...seller, productos };
  }

  /**
   * Dice la verdad sobre lo que no entró.
   *
   * Devolver mil pedidos sin aclarar que hay tres mil sería contestar el pedido
   * de acceso con un archivo incompleto que parece completo. Con esto, quien lo
   * lea sabe que tiene que pedir el resto.
   */
  private conRecorte<T>(items: T[], total: number) {
    return {
      items,
      total,
      truncado: total > items.length,
      ...(total > items.length
        ? {
            nota:
              `Se incluyen los ${items.length} más recientes de ${total}. ` +
              'Escribinos desde Ayuda para pedir el resto.',
          }
        : {}),
    };
  }
}
