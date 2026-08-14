import { Injectable, Logger } from '@nestjs/common';

import { OrdersReconciler } from '@/modules/orders/reconciler.service';
import { OrderPaymentsService } from '@/modules/orders/payments.service';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';

import { AdminMetrics } from './admin.metrics';
import {
  verAuditoria,
  verDevolucion,
  verIntentoDePago,
  verOrden,
  verProducto,
  verUsuario,
  verVendedor,
  verWebhook,
} from './admin.view';
import type {
  ListaAuditoriaDto,
  ListaDevolucionesDto,
  ListaOrdenesDto,
  ListaPagosDto,
  ListaUsuariosDto,
  ListaVendedoresDto,
  ListaWebhooksDto,
  PaginaDto,
} from './dto/admin.dto';

/**
 * El panel de administración.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTO NO ES UN TABLERO PARA MIRAR EL NEGOCIO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es la herramienta para resolverlo cuando algo sale mal. Cada consulta que
 * hay acá existe porque responde una pregunta concreta de soporte, y cada
 * acción existe porque hoy se haría entrando a PostgreSQL a mano.
 *
 * ─── Las acciones usan el dominio, nunca Prisma directo ───
 *
 * Suspender un vendedor, conciliar un pago o reintentar una devolución pasan
 * por los servicios que ya existen. Un `prisma.seller.update()` desde acá se
 * saltearía los eventos de dominio, las invariantes y la auditoría — y crearía
 * un segundo camino con reglas propias que el día que difiera del primero
 * nadie va a saber cuál tiene razón.
 *
 * Las dos excepciones son suspender/reactivar usuario y vendedor, que no
 * tienen servicio de dominio propio todavía porque nunca hubo quién los
 * hiciera. Se escriben acá con su auditoría, y el día que exista un
 * `SellersService.suspender()` se mueven.
 */

export class NoEncontradoError extends DomainError {
  constructor(que: string) {
    // 404 y no 403 aunque exista: es la misma política que el resto del
    // sistema. Un panel de admin ve todo, así que acá el 404 significa
    // realmente que no está.
    super('NOT_FOUND', `No se encontró ${que}`);
  }
}

export class AccionInvalidaError extends DomainError {
  constructor(mensaje: string) {
    super('VALIDATION_FAILED', mensaje);
  }
}

/** Contexto de quien ejecuta: va a la auditoría en cada acción. */
export interface ActorAdmin {
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly metrics: AdminMetrics,
    private readonly payments: OrderPaymentsService,
    private readonly reconciler: OrdersReconciler,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // INICIO — qué necesita atención
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Lo que hay que mirar hoy.
   *
   * Cinco números, no cuarenta. La pantalla de inicio de una herramienta
   * operativa tiene que responder "¿hay algo roto?" de un vistazo; una grilla
   * de métricas obliga a leerlas todas para descubrir que no pasa nada, y a la
   * semana nadie la mira.
   *
   * Cada contador de acá corresponde a algo que **alguien tiene que hacer**.
   */
  async atencion() {
    const [
      pagosInciertos,
      devolucionesFallidas,
      devolucionesPendientes,
      ordenesPorDevolver,
      webhooksConError,
      vendedoresSuspendidos,
      vendedoresPendientes,
    ] = await Promise.all([
      this.prisma.paymentAttempt.count({
        where: { status: { in: ['PROCESSING', 'UNKNOWN_PENDING_RECONCILIATION'] } },
      }),
      this.prisma.refund.count({ where: { status: 'FAILED' } }),
      this.prisma.refund.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
      this.prisma.order.count({ where: { status: 'PAYMENT_REQUIRES_REFUND' } }),
      this.prisma.mpWebhookEvent.count({ where: { error: { not: null } } }),
      this.prisma.seller.count({ where: { status: 'SUSPENDED' } }),
      this.prisma.seller.count({ where: { status: 'PENDING' } }),
    ]);

    return {
      pagosInciertos,
      devolucionesFallidas,
      devolucionesPendientes,
      ordenesPorDevolver,
      webhooksConError,
      vendedoresSuspendidos,
      vendedoresPendientes,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // USUARIOS
  // ═══════════════════════════════════════════════════════════════════════════

  async listarUsuarios(dto: ListaUsuariosDto) {
    const usuarios = await this.prisma.user.findMany({
      where: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.role ? { role: dto.role } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });

    return this.paginar(usuarios, dto.limit, verUsuario);
  }

  async verUsuarioCompleto(id: string) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      include: { seller: true },
    });
    if (!u) throw new NoEncontradoError('el usuario');

    const [ordenes, sesionesActivas] = await Promise.all([
      this.prisma.order.findMany({
        where: { buyerId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.refreshToken.count({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);

    return {
      ...verUsuario(u),
      vendedor: u.seller ? verVendedor(u.seller) : null,
      sesionesActivas,
      ordenes: ordenes.map(verOrden),
      totalOrdenes: ordenes.length,
    };
  }

  async suspenderUsuario(actor: ActorAdmin, id: string, motivo: string) {
    const antes = await this.prisma.user.findUnique({ where: { id } });
    if (!antes) throw new NoEncontradoError('el usuario');

    /**
     * Un admin no se puede suspender a sí mismo.
     *
     * No es una hipótesis: el guard rechaza cuentas no activas, así que la
     * suspensión propia deja a esa persona fuera del panel de inmediato. Si
     * además fuera la única cuenta de admin, nadie podría revertirlo desde la
     * aplicación — habría que entrar a la base.
     */
    if (antes.id === actor.id) {
      throw new AccionInvalidaError('No podés suspender tu propia cuenta');
    }

    if (antes.status === 'suspended') {
      // Idempotente: repetir la acción no es un error, pero tampoco escribe
      // una segunda entrada de auditoría idéntica.
      return { ok: true as const, yaEstaba: true };
    }

    await this.prisma.user.update({ where: { id }, data: { status: 'suspended' } });

    /**
     * Se revocan las sesiones en la misma operación.
     *
     * Sin esto, suspender no hace casi nada: el access token de esa persona
     * sigue siendo válido hasta que expire. El guard consulta el estado en cada
     * petición y la va a rechazar, pero el refresh token seguiría vivo y
     * volvería a emitir tokens en cuanto se reactivara la cuenta — incluidas
     * sesiones en dispositivos que quizá sean el motivo de la suspensión.
     */
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'admin.user_suspended' },
    });

    await this.auditar(actor, {
      action: 'admin.user_suspended',
      entityType: 'user',
      entityId: id,
      reason: motivo,
      before: { status: antes.status },
      after: { status: 'suspended', sesionesRevocadas: count },
    });

    return { ok: true as const, sesionesRevocadas: count };
  }

  async reactivarUsuario(actor: ActorAdmin, id: string, motivo: string) {
    const antes = await this.prisma.user.findUnique({ where: { id } });
    if (!antes) throw new NoEncontradoError('el usuario');

    /**
     * Una cuenta eliminada no se reactiva desde acá.
     *
     * `deleted` es el resultado de que alguien ejerciera su derecho a que
     * borremos sus datos. Revertirlo con un botón sería deshacer una decisión
     * de la persona sin que se entere, y probablemente los datos ya estén
     * anonimizados: "reactivarla" devolvería una cuenta vacía con su historial
     * de compras colgando.
     */
    if (antes.status === 'deleted' || antes.deletedAt) {
      throw new AccionInvalidaError('Una cuenta eliminada no se puede reactivar desde el panel');
    }

    if (antes.status === 'active') return { ok: true as const, yaEstaba: true };

    await this.prisma.user.update({ where: { id }, data: { status: 'active' } });

    await this.auditar(actor, {
      action: 'admin.user_reactivated',
      entityType: 'user',
      entityId: id,
      reason: motivo,
      before: { status: antes.status },
      after: { status: 'active' },
    });

    return { ok: true as const };
  }

  async revocarSesiones(actor: ActorAdmin, id: string, motivo: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!u) throw new NoEncontradoError('el usuario');

    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'admin.sessions_revoked' },
    });

    await this.auditar(actor, {
      action: 'admin.sessions_revoked',
      entityType: 'user',
      entityId: id,
      reason: motivo,
      after: { sesionesRevocadas: count },
    });

    return { ok: true as const, sesionesRevocadas: count };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VENDEDORES
  // ═══════════════════════════════════════════════════════════════════════════

  async listarVendedores(dto: ListaVendedoresDto) {
    const vendedores = await this.prisma.seller.findMany({
      where: dto.status ? { status: dto.status } : {},
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    return this.paginar(vendedores, dto.limit, verVendedor);
  }

  async verVendedorCompleto(id: string) {
    const s = await this.prisma.seller.findUnique({
      where: { id },
      include: { user: true, stores: true },
    });
    if (!s) throw new NoEncontradoError('el vendedor');

    const [productos, ordenes, totales, devoluciones] = await Promise.all([
      this.prisma.product.findMany({
        where: { store: { sellerId: id }, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.order.findMany({
        where: { sellerId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      /**
       * Volumen sólo de lo CONFIRMADO.
       *
       * Sumar órdenes en cualquier estado inflaría el número con carritos
       * abandonados y pagos rechazados. Para juzgar a un vendedor —que es para
       * lo que se mira esto— sólo cuenta lo que efectivamente se vendió.
       */
      this.prisma.order.aggregate({
        where: { sellerId: id, status: { in: ['CONFIRMED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'] } },
        _count: true,
        _sum: { grossAmount: true, sellerNetAmount: true },
      }),
      this.prisma.refund.count({ where: { order: { sellerId: id } } }),
    ]);

    return {
      ...verVendedor(s),
      usuario: verUsuario(s.user),
      tiendas: s.stores.map((t) => ({
        id: t.id,
        nombre: t.name,
        slug: t.slug,
        estado: t.status,
        esPrincipal: t.isPrimary,
      })),
      productos: productos.map(verProducto),
      ordenesRecientes: ordenes.map(verOrden),
      volumen: {
        ordenesConfirmadas: totales._count,
        brutoCentavos: totales._sum.grossAmount ?? 0,
        netoCentavos: totales._sum.sellerNetAmount ?? 0,
      },
      devoluciones,
    };
  }

  /**
   * Suspender, bloquear o reactivar un vendedor.
   *
   * ─── Lo que NO hace, y es deliberado ───
   *
   * **No toca las órdenes históricas.** Una orden ya pagada y confirmada es una
   * obligación con un comprador que no tiene nada que ver con la infracción del
   * vendedor. Cancelarlas automáticamente convertiría una sanción en un
   * problema para gente que no hizo nada.
   *
   * **No borra nada.** Ni el vendedor, ni la tienda, ni los productos. El
   * historial tiene que sobrevivir a la sanción: si mañana hay un reclamo sobre
   * una venta vieja, los datos tienen que estar.
   *
   * Lo que sí hace: pausar las tiendas, con lo cual no se puede vender más.
   */
  async cambiarEstadoVendedor(
    actor: ActorAdmin,
    id: string,
    nuevo: 'SUSPENDED' | 'BLOCKED' | 'ACTIVE',
    motivo: string,
  ) {
    const antes = await this.prisma.seller.findUnique({ where: { id } });
    if (!antes) throw new NoEncontradoError('el vendedor');

    /**
     * `BLOCKED` es por fraude y no vuelve.
     *
     * Permitir `BLOCKED → ACTIVE` con un botón haría que la decisión más grave
     * del panel fuera la más fácil de deshacer por error. Si hace falta
     * revertir un bloqueo, que sea una operación deliberada en la base, con
     * alguien mirando.
     */
    if (antes.status === 'BLOCKED' && nuevo !== 'BLOCKED') {
      throw new AccionInvalidaError(
        'Un vendedor bloqueado por fraude no se reactiva desde el panel',
      );
    }

    if (antes.status === nuevo) return { ok: true as const, yaEstaba: true };

    const pausarTiendas = nuevo === 'SUSPENDED' || nuevo === 'BLOCKED';

    await this.prisma.$transaction(async (tx) => {
      await tx.seller.update({ where: { id }, data: { status: nuevo } });

      if (pausarTiendas) {
        await tx.store.updateMany({
          where: { sellerId: id, status: 'ACTIVE' },
          data: { status: 'PAUSED' },
        });
      } else {
        /**
         * Al reactivar NO se reabren las tiendas automáticamente.
         *
         * Una tienda puede estar pausada porque el vendedor se fue de
         * vacaciones, y eso es anterior e independiente a la suspensión.
         * Reabrirla al levantar la sanción publicaría un catálogo que su dueño
         * había cerrado a propósito. La reabre el vendedor.
         */
      }
    });

    const accion =
      nuevo === 'ACTIVE'
        ? 'admin.seller_reactivated'
        : nuevo === 'BLOCKED'
          ? 'admin.seller_blocked'
          : 'admin.seller_suspended';

    await this.auditar(actor, {
      action: accion,
      entityType: 'seller',
      entityId: id,
      reason: motivo,
      before: { status: antes.status },
      after: { status: nuevo, tiendasPausadas: pausarTiendas },
    });

    return { ok: true as const, tiendasPausadas: pausarTiendas };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCTOS E INVENTARIO
  // ═══════════════════════════════════════════════════════════════════════════

  async verProductoCompleto(id: string) {
    const p = await this.prisma.product.findUnique({
      where: { id },
      include: {
        store: { include: { seller: true } },
        images: { orderBy: { position: 'asc' } },
        variants: { include: { inventory: true } },
      },
    });
    if (!p) throw new NoEncontradoError('el producto');

    const idsVariante = p.variants.map((v) => v.id);

    const [reservas, ordenes] = await Promise.all([
      this.prisma.inventoryReservation.findMany({
        where: { productVariantId: { in: idsVariante }, status: 'ACTIVE' },
        orderBy: { expiresAt: 'asc' },
        take: 50,
      }),
      this.prisma.order.findMany({
        where: { items: { some: { productId: id } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    return {
      ...verProducto(p),
      tienda: { id: p.store.id, nombre: p.store.name, estado: p.store.status },
      vendedor: verVendedor(p.store.seller),
      imagenes: p.images.map((i) => ({
        id: i.id,
        url: i.url,
        posicion: i.position,
      })),
      variantes: p.variants.map((v) => ({
        id: v.id,
        titulo: v.title,
        sku: v.sku,
        precioCentavos: v.priceOverrideCents,
        inventario: v.inventory
          ? {
              onHand: v.inventory.onHand,
              reservado: v.inventory.reserved,
              // Se calcula acá y no se guarda: es siempre derivado, y una
              // columna `available` sería una tercera fuente que se puede
              // desincronizar de las otras dos.
              disponible: v.inventory.onHand - v.inventory.reserved,
              umbralBajo: v.inventory.lowStockThreshold,
            }
          : null,
      })),
      reservasActivas: reservas.map((r) => ({
        id: r.id,
        variantId: r.productVariantId,
        userId: r.userId,
        cantidad: r.quantity,
        venceEl: r.expiresAt,
        creadaEl: r.createdAt,
      })),
      ordenesRecientes: ordenes.map(verOrden),
    };
  }

  async cambiarEstadoProducto(
    actor: ActorAdmin,
    id: string,
    nuevo: 'PAUSED' | 'ACTIVE',
    motivo: string,
  ) {
    const antes = await this.prisma.product.findUnique({ where: { id } });
    if (!antes) throw new NoEncontradoError('el producto');
    if (antes.deletedAt) throw new AccionInvalidaError('El producto está eliminado');

    if (antes.status === nuevo) return { ok: true as const, yaEstaba: true };

    /**
     * Reactivar sólo desde `PAUSED`.
     *
     * Un producto en `DRAFT` nunca se publicó: activarlo desde el panel lo
     * publicaría sin que su dueño lo haya decidido, posiblemente a medio
     * cargar. Y uno `ARCHIVED` lo archivó el vendedor.
     */
    if (nuevo === 'ACTIVE' && antes.status !== 'PAUSED') {
      throw new AccionInvalidaError(
        `Sólo se reactiva un producto pausado. Éste está en ${antes.status}.`,
      );
    }

    await this.prisma.product.update({ where: { id }, data: { status: nuevo } });

    await this.auditar(actor, {
      action: nuevo === 'PAUSED' ? 'admin.product_paused' : 'admin.product_reactivated',
      entityType: 'product',
      entityId: id,
      reason: motivo,
      before: { status: antes.status },
      after: { status: nuevo },
    });

    return { ok: true as const };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ÓRDENES, PAGOS Y DEVOLUCIONES
  // ═══════════════════════════════════════════════════════════════════════════

  async listarOrdenes(dto: ListaOrdenesDto) {
    const ordenes = await this.prisma.order.findMany({
      where: {
        ...(dto.status ? { status: dto.status as never } : {}),
        ...(dto.sellerId ? { sellerId: dto.sellerId } : {}),
        ...(dto.buyerId ? { buyerId: dto.buyerId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    return this.paginar(ordenes, dto.limit, verOrden);
  }

  async verOrdenCompleta(id: string) {
    const o = await this.prisma.order.findUnique({
      where: { id },
      include: {
        items: true,
        attempts: { orderBy: { createdAt: 'asc' } },
        refunds: { orderBy: { createdAt: 'asc' } },
        buyer: true,
        seller: true,
        store: true,
      },
    });
    if (!o) throw new NoEncontradoError('la orden');

    return {
      ...verOrden(o),
      comprador: verUsuario(o.buyer),
      vendedor: verVendedor(o.seller),
      tienda: { id: o.store.id, nombre: o.store.name },
      /**
       * La dirección de envío es un snapshot en JSON y se devuelve entera.
       *
       * Es el único dato personal completo que expone el panel, y tiene una
       * razón operativa concreta: cuando alguien reclama que su pedido no
       * llegó, lo primero que hay que ver es a qué dirección se mandó.
       */
      direccionEnvio: o.shippingAddress,
      items: o.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        variantId: i.productVariantId,
        nombre: i.productNameSnapshot,
        variante: i.variantLabelSnapshot,
        sku: i.skuSnapshot,
        imagenUrl: i.imageUrlSnapshot,
        cantidad: i.quantity,
        precioUnitario: i.unitPrice,
        subtotal: i.subtotal,
      })),
      pagos: o.attempts.map(verIntentoDePago),
      devoluciones: o.refunds.map(verDevolucion),
    };
  }

  async listarPagos(dto: ListaPagosDto) {
    const pagos = await this.prisma.paymentAttempt.findMany({
      where: {
        ...(dto.status ? { status: dto.status as never } : {}),
        ...(dto.orderId ? { orderId: dto.orderId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    return this.paginar(pagos, dto.limit, verIntentoDePago);
  }

  /**
   * Conciliar un pago a mano.
   *
   * Le pregunta al proveedor por el estado real y aplica lo que responda, con
   * **la misma función que corre en el worker cada minuto**. El panel no decide
   * nada por su cuenta: si lo hiciera, habría dos sistemas de conciliación con
   * dos criterios.
   *
   * Idempotente: se le puede pegar al botón las veces que sea.
   */
  async conciliarPago(actor: ActorAdmin, attemptId: string, motivo: string) {
    const intento = await this.prisma.paymentAttempt.findUnique({
      where: { id: attemptId },
      select: { id: true, orderId: true, providerPaymentId: true, status: true },
    });
    if (!intento) throw new NoEncontradoError('el intento de pago');

    const estadoAnterior = intento.status;
    const { resuelto, error } = await this.reconciler.conciliarIntento(intento);

    const despues = await this.prisma.paymentAttempt.findUnique({
      where: { id: attemptId },
      select: { status: true },
    });

    this.metrics.conciliacionManual();

    await this.auditar(actor, {
      action: 'admin.payment_reconciled',
      entityType: 'payment_attempt',
      entityId: attemptId,
      reason: motivo,
      before: { status: estadoAnterior },
      after: { status: despues?.status ?? estadoAnterior, resuelto, error: error ?? null },
    });

    if (error) {
      throw new DomainError(
        'PROVIDER_UNAVAILABLE',
        'No se pudo consultar al proveedor. Probá de nuevo en un momento.',
        { detalle: error },
      );
    }

    return { ok: true as const, estadoAnterior, estado: despues?.status ?? estadoAnterior };
  }

  async listarDevoluciones(dto: ListaDevolucionesDto) {
    const devoluciones = await this.prisma.refund.findMany({
      where: dto.status ? { status: dto.status } : {},
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    return this.paginar(devoluciones, dto.limit, verDevolucion);
  }

  /**
   * Reintentar una devolución.
   *
   * ⚠️ **No existe un botón "devolver dinero" con monto libre.** El monto lo
   * determinó el dominio cuando creó la devolución; desde acá sólo se
   * reintenta lo que ya estaba decidido.
   *
   * Un campo de monto editable en un panel es la forma más directa de que un
   * error de tipeo mande diez veces de más, o de que una cuenta comprometida
   * saque plata. El monto no es un dato de entrada.
   */
  async reintentarDevolucion(actor: ActorAdmin, refundId: string, motivo: string) {
    const dev = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!dev) throw new NoEncontradoError('la devolución');

    if (dev.status === 'COMPLETED') {
      // Idempotente y explícito: no se manda una segunda devolución.
      return { ok: true as const, yaEstaba: true, estado: dev.status };
    }

    this.metrics.reintentoDevolucion();

    let error: string | null = null;
    try {
      await this.payments.ejecutarDevolucion(refundId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const despues = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: { status: true, attempts: true, failureMessageSafe: true },
    });

    await this.auditar(actor, {
      action: 'admin.refund_retried',
      entityType: 'refund',
      entityId: refundId,
      reason: motivo,
      before: { status: dev.status, attempts: dev.attempts },
      after: {
        status: despues?.status ?? dev.status,
        attempts: despues?.attempts ?? dev.attempts,
        error,
      },
    });

    if (error) {
      throw new DomainError('PROVIDER_UNAVAILABLE', 'El reintento falló. Queda registrado.', {
        detalle: despues?.failureMessageSafe ?? error,
      });
    }

    return { ok: true as const, estado: despues?.status ?? dev.status };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WEBHOOKS Y AUDITORÍA
  // ═══════════════════════════════════════════════════════════════════════════

  async listarWebhooks(dto: ListaWebhooksDto) {
    const webhooks = await this.prisma.mpWebhookEvent.findMany({
      where: {
        ...(dto.processed === 'true' ? { processedAt: { not: null } } : {}),
        ...(dto.processed === 'false' ? { processedAt: null } : {}),
      },
      orderBy: { receivedAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    return this.paginar(webhooks, dto.limit, verWebhook);
  }

  /**
   * La bitácora.
   *
   * Sólo lectura, y no por falta de tiempo: **una bitácora que se puede editar
   * no es una bitácora**. Su único valor es que nadie —ni siquiera quien tiene
   * la cuenta más privilegiada— pueda cambiar lo que dice. No hay endpoint de
   * modificación ni de borrado, y no debe haberlo.
   */
  async listarAuditoria(dto: ListaAuditoriaDto) {
    const registros = await this.prisma.auditLog.findMany({
      where: {
        ...(dto.actorId ? { actorId: dto.actorId } : {}),
        ...(dto.action ? { action: dto.action } : {}),
        ...(dto.entityType ? { entityType: dto.entityType } : {}),
        ...(dto.entityId ? { entityId: dto.entityId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    return this.paginar(registros, dto.limit, verAuditoria);
  }

  async auditoriaDe(entityType: string, entityId: string, dto: PaginaDto) {
    return this.listarAuditoria({ ...dto, entityType, entityId });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Interno
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Se pide un elemento de más para saber si hay página siguiente.
   *
   * La alternativa es un `count()` por cada listado, que en tablas grandes
   * cuesta un escaneo completo para responder algo que nadie mira: el total
   * exacto de órdenes no le sirve a quien está buscando una.
   */
  private paginar<T extends { id: string }, R>(
    filas: T[],
    limite: number,
    ver: (fila: T) => R,
  ): { items: R[]; siguienteCursor: string | null } {
    const hayMas = filas.length > limite;
    const pagina = hayMas ? filas.slice(0, limite) : filas;
    return {
      items: pagina.map(ver),
      siguienteCursor: hayMas ? (pagina[pagina.length - 1]?.id ?? null) : null,
    };
  }

  /** Toda acción administrativa pasa por acá. */
  private async auditar(
    actor: ActorAdmin,
    input: {
      action: string;
      entityType: string;
      entityId: string;
      reason: string;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    },
  ): Promise<void> {
    this.metrics.accion(input.action);

    // Además de la bitácora, al log estructurado: con el requestId permite
    // reconstruir qué pasó desde el lado de la observabilidad.
    this.logger.log({
      msg: 'acción administrativa',
      adminAction: input.action,
      adminUserId: actor.id,
      entityType: input.entityType,
      entityId: input.entityId,
    });

    await this.audit.log({
      ...input,
      actorId: actor.id,
      actorType: 'admin',
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }
}
