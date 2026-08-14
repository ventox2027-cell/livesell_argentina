import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type OrderStatus } from '@prisma/client';

import { env } from '@/config/env.schema';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { DomainEvent, DomainEventBus } from '@/shared/events/domain-events';
import { MetricsService } from '@/shared/observability/metrics.service';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import {
  admiteCancelacionDelComprador,
  esTransicionDelVendedor,
  puedeVencer,
  transicionValida,
} from './order-state';
import { calcularPrecio, referenciaDeOrden, verificarCoherencia } from './pricing';

/**
 * Órdenes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TODO LO QUE PUEDE CAMBIAR SE COPIA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una orden guarda el nombre del producto, el precio, la variante, el SKU, la
 * foto y la dirección completa. No referencias: **copias**.
 *
 * El motivo es una pregunta que hay que poder responder dentro de dos años:
 * "¿qué compró esta persona, a qué precio y a qué dirección?". Si la orden
 * guardara sólo `productId`, la respuesta dependería de que el producto siga
 * existiendo, con el mismo nombre y el mismo precio. Ninguna de las tres cosas
 * se puede garantizar: el vendedor archiva productos, les cambia el nombre y
 * les sube el precio todos los días.
 *
 * Lo mismo con la dirección. Alguien se muda, actualiza su perfil, y de golpe
 * todas sus compras anteriores figuran enviadas a la casa nueva.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NADA DE PLATA VIENE DEL CLIENTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El cuerpo de `POST /orders` tiene exactamente dos campos: la reserva y la
 * dirección. Ni precio, ni subtotal, ni comisión, ni `sellerId`, ni moneda.
 *
 * Todo eso lo deriva el backend del producto real. Un DTO que aceptara
 * `unitPrice` sería un endpoint donde alguien compra un televisor por un peso.
 */

export class OrderNotFoundError extends DomainError {
  constructor() {
    super('ORDER_NOT_FOUND_V2', 'Pedido no encontrado');
  }
}

export class ReservationExpiredError extends DomainError {
  constructor() {
    super(
      'RESERVATION_EXPIRED',
      'Se te venció el tiempo para completar la compra. Probá de nuevo.',
    );
  }
}

export class AddressRequiredError extends DomainError {
  constructor() {
    super('ADDRESS_REQUIRED', 'Necesitamos una dirección de entrega antes de comprar');
  }
}

/** Lo que sale al cliente. Enumerado, no filtrado. */
const ORDER_SELECT = {
  id: true,
  reference: true,
  buyerId: true,
  sellerId: true,
  storeId: true,
  reservationId: true,
  status: true,
  currency: true,
  itemsSubtotal: true,
  shippingAmount: true,
  discountAmount: true,
  grossAmount: true,
  platformFeeBps: true,
  platformFeeAmount: true,
  paymentProcessorFeeAmount: true,
  sellerNetAmount: true,
  shippingAddress: true,
  statusReason: true,
  createdAt: true,
  paidAt: true,
  confirmedAt: true,
  cancelledAt: true,
  expiredAt: true,
  refundedAt: true,
} satisfies Prisma.OrderSelect;

/**
 * La forma de una orden tal como sale al cliente.
 *
 * Derivada de la proyección y no del modelo de Prisma: si fuera `Order`, el
 * tipo prometería campos que la proyección no trae —`buyerSnapshot`,
 * `updatedAt`— y el compilador dejaría pasar código que los lee y encuentra
 * `undefined` en producción.
 */
export type OrdenPublica = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly metrics: MetricsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // CREAR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Convierte una reserva en una orden.
   *
   * ─── Por qué la reserva ES la clave de idempotencia ───
   *
   * `Order.reservationId` tiene un índice único. Eso hace que dos peticiones
   * simultáneas con la misma reserva no puedan crear dos órdenes: la segunda
   * choca contra el índice, se relee y se devuelve la que ganó.
   *
   * La cabecera `Idempotency-Key` se exige igual, porque obliga al cliente a
   * tener la disciplina que va a necesitar sí o sí en el cobro. Pero la
   * garantía real la da la base, no la cabecera — una cabecera se puede
   * olvidar, un índice único no.
   *
   * ─── Por qué no se consume el stock acá ───
   *
   * La orden no toca el inventario. Las unidades siguen apartadas por la
   * reserva hasta que el pago se apruebe de verdad. Consumirlas al crear la
   * orden significaría descontar stock por cada carrito abandonado.
   */
  async create(params: {
    buyerId: string;
    reservationId: string;
    addressId?: string;
  }): Promise<OrdenPublica> {
    const { buyerId, reservationId } = params;

    // 1 · La reserva, **sólo si es de esta persona**. Ajena = no encontrada.
    const reserva = await this.prisma.inventoryReservation.findFirst({
      where: { id: reservationId, userId: buyerId },
    });
    if (!reserva) throw new OrderNotFoundError();

    // 2 · ¿Ya tiene orden? Reintento o doble toque.
    const existente = await this.prisma.order.findUnique({
      where: { reservationId },
      select: ORDER_SELECT,
    });
    if (existente) {
      if (existente.buyerId !== buyerId) throw new OrderNotFoundError();
      return existente;
    }

    if (reserva.status !== 'ACTIVE') throw new ReservationExpiredError();
    if (reserva.expiresAt.getTime() <= Date.now()) throw new ReservationExpiredError();

    // 3 · El producto real. De acá sale el precio, no del cliente.
    const variante = await this.prisma.productVariant.findFirst({
      where: { id: reserva.productVariantId, deletedAt: null },
      select: {
        id: true,
        title: true,
        sku: true,
        priceOverrideCents: true,
        product: {
          select: {
            id: true,
            name: true,
            basePriceCents: true,
            status: true,
            deletedAt: true,
            images: { orderBy: { position: 'asc' }, take: 1, select: { url: true } },
            store: {
              select: {
                id: true,
                status: true,
                seller: { select: { id: true, status: true, displayName: true } },
              },
            },
          },
        },
      },
    });
    if (!variante) throw new OrderNotFoundError();

    const producto = variante.product;
    const tienda = producto.store;

    /**
     * Un vendedor suspendido no recibe órdenes nuevas.
     *
     * Las que ya pagó alguien siguen existiendo y hay que gestionarlas —no se
     * borra historial— pero la venta nueva se corta acá.
     */
    if (tienda.seller.status !== 'ACTIVE') {
      throw new DomainError('SELLER_NOT_ACTIVE', 'Este vendedor no está operando en este momento');
    }
    if (tienda.status !== 'ACTIVE' || producto.status !== 'ACTIVE' || producto.deletedAt) {
      throw new DomainError('NOT_PURCHASABLE', 'Este producto ya no está disponible');
    }

    // 4 · Dirección de entrega.
    const direccion = await this.direccionParaEnviar(buyerId, params.addressId);

    const comprador = await this.prisma.user.findUniqueOrThrow({
      where: { id: buyerId },
      select: { id: true, firstName: true, lastName: true, email: true, phoneE164: true },
    });

    // 5 · Los números. Una sola función los calcula, y se comprueban antes de
    // escribir: la base tiene los mismos CHECK, pero fallar acá permite decir
    // QUÉ no cierra en vez de devolver el nombre de una restricción.
    const unitPrice = variante.priceOverrideCents ?? producto.basePriceCents;
    const precio = calcularPrecio({
      unitPrice,
      quantity: reserva.quantity,
      platformFeeBps: env.VENDOX_PLATFORM_FEE_BPS,
    });

    const coherencia = verificarCoherencia(precio);
    if (!coherencia.ok) {
      // Nunca debería pasar. Si pasa, es un bug de cálculo y hay que verlo.
      this.logger.error({ msg: 'precio incoherente al crear la orden', motivo: coherencia.motivo });
      throw new DomainError('VALIDATION_FAILED', 'No pudimos calcular el total de tu compra');
    }

    const orderId = newId('ord');

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.order.create({
          data: {
            id: orderId,
            reference: referenciaDeOrden(),
            buyerId,
            storeId: tienda.id,
            sellerId: tienda.seller.id,
            reservationId,
            status: 'PENDING_PAYMENT',
            ...precio,
            // Fotos: nada de esto se vuelve a leer de su tabla original.
            shippingAddress: direccion,
            buyerSnapshot: {
              id: comprador.id,
              nombre: `${comprador.firstName} ${comprador.lastName}`.trim(),
              email: comprador.email,
              telefono: comprador.phoneE164,
            },
          },
        });

        await tx.orderItem.create({
          data: {
            id: newId('oit'),
            orderId,
            productId: producto.id,
            productVariantId: variante.id,
            productNameSnapshot: producto.name,
            variantLabelSnapshot: variante.title,
            skuSnapshot: variante.sku,
            imageUrlSnapshot: producto.images[0]?.url ?? null,
            quantity: reserva.quantity,
            unitPrice,
            subtotal: precio.itemsSubtotal,
          },
        });
      });
    } catch (err) {
      // Carrera: otra petición con la misma reserva ganó. Se devuelve la suya,
      // que es exactamente lo que esperaba quien reintentó.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const ganadora = await this.prisma.order.findUnique({
          where: { reservationId },
          select: ORDER_SELECT,
        });
        if (ganadora && ganadora.buyerId === buyerId) return ganadora;
      }
      throw err;
    }

    this.metrics.orders.inc({ result: 'created' });
    this.events.publish(DomainEvent.orderCreated, {
      entityId: orderId,
      actorId: buyerId,
      data: { sellerId: tienda.seller.id, grossAmount: precio.grossAmount },
    });
    void this.audit.log({
      action: 'order.created',
      entityType: 'order',
      entityId: orderId,
      actorId: buyerId,
      after: {
        reservationId,
        grossAmount: precio.grossAmount,
        platformFeeBps: precio.platformFeeBps,
        platformFeeAmount: precio.platformFeeAmount,
      },
    });

    return this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: ORDER_SELECT,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LECTURA
  // ═══════════════════════════════════════════════════════════════════════

  /** Una orden del comprador. Ajena = 404, no 403. */
  async forBuyer(orderId: string, buyerId: string) {
    const orden = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId },
      select: {
        ...ORDER_SELECT,
        items: true,
        attempts: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            brand: true,
            lastFour: true,
            failureMessageSafe: true,
            createdAt: true,
            approvedAt: true,
          },
        },
        refunds: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, amount: true, createdAt: true, completedAt: true },
        },
      },
    });
    if (!orden) throw new OrderNotFoundError();
    return orden;
  }

  async listForBuyer(buyerId: string, query: { cursor?: string; limit: number }) {
    const filas = await this.prisma.order.findMany({
      where: { buyerId, ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
      select: {
        ...ORDER_SELECT,
        items: {
          select: {
            productNameSnapshot: true,
            variantLabelSnapshot: true,
            imageUrlSnapshot: true,
            quantity: true,
            unitPrice: true,
          },
        },
        store: { select: { name: true, slug: true } },
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    return this.paginar(filas, query.limit);
  }

  /**
   * Las ventas de un vendedor.
   *
   * Ve lo que necesita para despachar —qué, cuánto, a quién y a dónde— y su
   * neto. No ve datos del cobro que no le sirven: con qué tarjeta pagaron o el
   * id del pago en Mercado Pago no le aportan nada y son información de otro.
   */
  async listForSeller(
    sellerId: string,
    query: { cursor?: string; limit: number; status?: OrderStatus },
  ) {
    const filas = await this.prisma.order.findMany({
      where: {
        sellerId,
        // Las órdenes sin pagar no son ventas: no ensucian el panel hasta que
        // hay plata de por medio.
        status: query.status ?? { notIn: ['PENDING_PAYMENT', 'EXPIRED', 'CANCELLED'] },
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      select: {
        id: true,
        reference: true,
        status: true,
        currency: true,
        itemsSubtotal: true,
        shippingAmount: true,
        grossAmount: true,
        platformFeeAmount: true,
        sellerNetAmount: true,
        shippingAddress: true,
        buyerSnapshot: true,
        createdAt: true,
        paidAt: true,
        confirmedAt: true,
        items: true,
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    return this.paginar(filas, query.limit);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TRANSICIONES
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Cambia el estado de preparación. **Sólo el vendedor.**
   *
   * `sellerId` va en el WHERE: la orden de otro vendedor no es una operación
   * prohibida, es una que no encuentra nada.
   *
   * El comprador no puede tocar estos estados. "Ya lo empaqueté" es una
   * declaración sobre el mundo físico que sólo puede hacer quien tiene el
   * paquete en la mano.
   */
  async advanceFulfillment(orderId: string, sellerId: string, hacia: OrderStatus) {
    const orden = await this.prisma.order.findFirst({
      where: { id: orderId, sellerId },
      select: { id: true, status: true },
    });
    if (!orden) throw new OrderNotFoundError();

    if (!esTransicionDelVendedor(orden.status, hacia)) {
      throw new DomainError(
        'INVALID_TRANSITION',
        `No se puede pasar de ${orden.status} a ${hacia}`,
        { desde: orden.status, hacia },
      );
    }

    const actualizada = await this.prisma.order.update({
      where: { id: orden.id },
      data: { status: hacia },
      select: ORDER_SELECT,
    });

    this.events.publish(DomainEvent.orderFulfillmentChanged, {
      entityId: orden.id,
      actorId: sellerId,
      data: { desde: orden.status, hacia },
    });
    void this.audit.log({
      action: 'order.fulfillment_changed',
      entityType: 'order',
      entityId: orden.id,
      actorId: sellerId,
      before: { status: orden.status },
      after: { status: hacia },
    });

    return actualizada;
  }

  /** El comprador se arrepiente antes de pagar. */
  async cancelByBuyer(orderId: string, buyerId: string) {
    const orden = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId },
      select: { id: true, status: true, reservationId: true },
    });
    if (!orden) throw new OrderNotFoundError();

    if (!admiteCancelacionDelComprador(orden.status)) {
      throw new DomainError(
        'INVALID_TRANSITION',
        'Este pedido ya no se puede cancelar',
        { status: orden.status },
      );
    }

    const actualizada = await this.prisma.order.update({
      where: { id: orden.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), statusReason: 'Cancelado por vos' },
      select: ORDER_SELECT,
    });

    this.metrics.orders.inc({ result: 'cancelled' });
    this.events.publish(DomainEvent.orderCancelled, {
      entityId: orden.id,
      actorId: buyerId,
      data: { reservationId: orden.reservationId },
    });
    void this.audit.log({
      action: 'order.cancelled',
      entityType: 'order',
      entityId: orden.id,
      actorId: buyerId,
      before: { status: orden.status },
    });

    return actualizada;
  }

  /**
   * Marca vencidas las órdenes que nadie pagó.
   *
   * ─── La condición delicada ───
   *
   * Sólo vencen las que están en `PENDING_PAYMENT` o `PAYMENT_FAILED`. Una
   * orden con un cobro en vuelo —`PROCESSING_PAYMENT`— **no vence nunca por
   * tiempo**, aunque su reserva ya no exista.
   *
   * El motivo: si ese cobro se aprobó y todavía no nos enteramos, marcarla
   * vencida sería quedarse con la plata de alguien. El conciliador tiene que
   * resolverla primero; recién cuando se sabe que no hubo cobro, puede vencer.
   *
   * Es exactamente el mismo error que ya cometimos en el spike con las órdenes
   * trabadas en `PROCESSING`, visto desde el otro lado.
   */
  async expireStale(limite = 200): Promise<{ revisadas: number; vencidas: number }> {
    const corte = new Date(Date.now() - env.ORDER_EXPIRATION_GRACE_SECONDS * 1000);

    const posibles = await this.prisma.order.findMany({
      where: {
        status: { in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] },
        createdAt: { lt: corte },
      },
      select: { id: true, status: true, buyerId: true, reservationId: true },
      orderBy: { createdAt: 'asc' },
      take: limite,
    });

    /**
     * Se filtra por el estado de la reserva en una segunda consulta.
     *
     * `Order.reservationId` es una columna suelta, sin relación declarada, a
     * propósito: una clave foránea ataría el ciclo de vida de una orden PAGADA
     * al de una reserva que puede vencerse y limpiarse. Una venta tiene que
     * sobrevivir a la reserva que la originó.
     *
     * El costo es una consulta más por barrido, sobre a lo sumo 200 ids.
     */
    const idsDeReserva = posibles.map((o) => o.reservationId).filter((id): id is string => !!id);

    const activas = new Set(
      idsDeReserva.length === 0
        ? []
        : (
            await this.prisma.inventoryReservation.findMany({
              where: { id: { in: idsDeReserva }, status: 'ACTIVE' },
              select: { id: true },
            })
          ).map((r) => r.id),
    );

    // Vence la que no tiene reserva, o cuya reserva ya no está viva.
    const candidatas = posibles.filter(
      (o) => !o.reservationId || !activas.has(o.reservationId),
    );

    let vencidas = 0;
    for (const orden of candidatas) {
      try {
        // La condición va en el WHERE del UPDATE: entre que se leyó la
        // candidata y ahora, alguien pudo haber empezado a pagar.
        const { count } = await this.prisma.order.updateMany({
          where: { id: orden.id, status: { in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] } },
          data: {
            status: 'EXPIRED',
            expiredAt: new Date(),
            statusReason: 'Se venció el tiempo para pagar',
          },
        });
        if (count === 0) continue;

        vencidas += 1;
        this.metrics.orders.inc({ result: 'expired' });
        this.events.publish(DomainEvent.orderExpired, {
          entityId: orden.id,
          actorId: null,
          data: { buyerId: orden.buyerId },
        });
      } catch (err) {
        this.logger.error({
          msg: 'no se pudo vencer una orden',
          orderId: orden.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { revisadas: candidatas.length, vencidas };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNOS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Dirección de entrega, como foto.
   *
   * Se copia entera en la orden. Cambiar la dirección del perfil mañana no
   * puede reescribir a dónde se mandó una compra de hoy.
   */
  private async direccionParaEnviar(
    userId: string,
    addressId?: string,
  ): Promise<Prisma.InputJsonValue> {
    const direccion = await this.prisma.userAddress.findFirst({
      where: {
        userId,
        deletedAt: null,
        ...(addressId ? { id: addressId } : { isDefault: true }),
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!direccion) throw new AddressRequiredError();

    return {
      recipientFullName: direccion.recipientFullName,
      documentType: direccion.documentType,
      documentNumber: direccion.documentNumber,
      phoneE164: direccion.phoneE164,
      street: direccion.street,
      number: direccion.number,
      floor: direccion.floor,
      apartment: direccion.apartment,
      city: direccion.city,
      province: direccion.province,
      postalCode: direccion.postalCode,
      references: direccion.references,
    };
  }

  private paginar<T extends { id: string }>(filas: T[], limit: number) {
    const hayMas = filas.length > limit;
    const items = hayMas ? filas.slice(0, limit) : filas;
    return { items, nextCursor: hayMas ? (items[items.length - 1]?.id ?? null) : null };
  }

  /** Expuesto para los tests y para el conciliador. */
  puedeVencerEstado(status: OrderStatus): boolean {
    return puedeVencer(status);
  }

  /** Expuesto para los tests. */
  transicionEsValida(desde: OrderStatus, hacia: OrderStatus): boolean {
    return transicionValida(desde, hacia);
  }
}
