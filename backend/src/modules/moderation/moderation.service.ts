import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ReportReason, type ReportTarget } from '@prisma/client';

import { NotificationsService } from '@/modules/notifications/notifications.service';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { avisoDeOcultamiento, motivoQueOculta, umbralDe } from './umbrales';

/**
 * Reportes y moderación.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UN REPORTE NO SANCIONA A NADIE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Arma una cola para que una persona mire. La única acción automática es
 * **ocultar preventivamente** cuando varias personas distintas reportan lo
 * mismo por el mismo motivo — y ocultar es reversible, con aviso al vendedor.
 *
 * Nadie queda suspendido por un umbral. Suspender es una decisión con
 * consecuencias económicas para alguien, y esas las toma una persona.
 */

export class YaReportadoError extends DomainError {
  constructor() {
    super('ALREADY_REPORTED', 'Ya reportaste esto. Lo estamos revisando.');
  }
}

export class ReporteNoEncontradoError extends DomainError {
  constructor() {
    super('REPORT_NOT_FOUND', 'No encontramos ese reporte');
  }
}

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // REPORTAR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Alguien reporta algo.
   *
   * ─── Se responde lo mismo haya o no acción ───
   *
   * Quien reporta recibe "gracias, lo revisamos" siempre. Decirle "esto ya
   * tenía cuatro reportes y con el tuyo lo bajamos" le confirma que su reporte
   * fue el que faltaba, y eso convierte el umbral en un juego: alguien que
   * quiere bajar la publicación de un competidor sabría exactamente cuántas
   * cuentas necesita.
   */
  async reportar(
    userId: string,
    dto: {
      targetType: ReportTarget;
      targetId: string;
      reason: ReportReason;
      detail?: string;
    },
  ): Promise<{ ok: true }> {
    await this.verificarQueExiste(dto.targetType, dto.targetId);

    try {
      await this.prisma.report.create({
        data: {
          id: newId('rep'),
          reporterUserId: userId,
          targetType: dto.targetType,
          targetId: dto.targetId,
          reason: dto.reason,
          detail: dto.detail ?? null,
        },
      });
    } catch (err) {
      /**
       * Ya lo había reportado.
       *
       * El índice único lo garantiza: sin él, alguien puede reportar veinte
       * veces lo mismo y disparar solo el umbral. Se responde con un mensaje
       * claro en vez de un error genérico — la persona hizo algo razonable.
       */
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new YaReportadoError();
      }
      throw err;
    }

    await this.evaluarUmbral(dto.targetType, dto.targetId);

    return { ok: true };
  }

  /**
   * ¿Este contenido junta suficientes reportes como para ocultarlo ya?
   *
   * Se evalúa POR MOTIVO y no sobre el total: cinco reportes repartidos entre
   * cinco motivos distintos son ruido; cinco por el mismo son una señal. Ver
   * `umbrales.ts`.
   */
  private async evaluarUmbral(targetType: ReportTarget, targetId: string): Promise<void> {
    // Sólo los productos se ocultan solos por ahora. Un vivo dura minutos —para
    // cuando el umbral se cumpla ya terminó— y suspender a un vendedor nunca es
    // automático.
    if (targetType !== 'PRODUCT') return;

    const porMotivo = await this.prisma.report.groupBy({
      by: ['reason'],
      where: { targetType, targetId, status: 'PENDIENTE' },
      _count: { reason: true },
    });

    const motivo = motivoQueOculta(
      porMotivo.map((r) => ({ reason: r.reason, cantidad: r._count.reason })),
    );
    if (!motivo) return;

    await this.ocultarProducto(targetId, {
      razon: motivo,
      // El texto depende del motivo: "contenido sexual" y "spam" no se le
      // avisan igual a un vendedor.
      aviso: avisoDeOcultamiento(motivo),
      actorUserId: null,
      automatico: true,
    });
  }

  /**
   * Oculta un producto.
   *
   * ─── El UPDATE es condicional ───
   *
   * `hiddenAt: null` en el WHERE: si ya estaba oculto, no se vuelve a ocultar,
   * no se registra otra acción y —lo importante— no se le manda otro aviso al
   * vendedor. Sin eso, cada reporte nuevo sobre algo ya oculto sería una
   * notificación más sobre lo mismo.
   */
  private async ocultarProducto(
    productId: string,
    p: {
      /** Lo que queda registrado en la acción de moderación. */
      razon: string;
      /** Lo que se le dice al vendedor. Puede ser distinto de la razón. */
      aviso: string;
      actorUserId: string | null;
      automatico: boolean;
    },
  ): Promise<void> {
    const producto = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true, store: { select: { seller: { select: { userId: true } } } } },
    });
    if (!producto) return;

    const { count } = await this.prisma.product.updateMany({
      where: { id: productId, hiddenAt: null },
      data: { hiddenAt: new Date() },
    });
    if (count === 0) return;

    await this.prisma.moderationAction.create({
      data: {
        id: newId('mod'),
        targetType: 'PRODUCT',
        targetId: productId,
        action: 'HIDE',
        actorUserId: p.actorUserId,
        reason: p.razon,
        automatic: p.automatico,
      },
    });

    this.logger.warn({
      msg: p.automatico
        ? 'producto oculto por umbral de reportes'
        : 'producto oculto por moderación',
      productId,
      razon: p.razon,
    });

    /**
     * El vendedor se entera, con el motivo.
     *
     * Enterarse de que una publicación desapareció sin explicación es peor que
     * la sanción: no sabe qué corregir, asume que fue un error y vuelve a
     * publicar lo mismo. ⚠️ Nunca se le dice QUIÉN lo reportó.
     */
    await this.notifications.crear({
      userId: producto.store.seller.userId,
      type: 'ACCOUNT',
      title: `Ocultamos "${producto.name}"`,
      body: p.aviso,
      data: { tipo: 'product', productId },
      dedupeKey: `product_hidden:${productId}`,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LA COLA DEL EQUIPO
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lo que espera revisión, agrupado por contenido.
   *
   * ─── Por qué agrupado y no una lista de reportes ───
   *
   * Un producto con ocho reportes genera ocho filas, y quien modera tiene que
   * revisar el producto UNA vez. Con la lista plana, resuelve el primero y los
   * otros siete siguen en la cola pidiendo la misma decisión.
   */
  async cola(params: { limit?: number } = {}) {
    const limite = Math.min(params.limit ?? 50, 100);

    const grupos = await this.prisma.report.groupBy({
      by: ['targetType', 'targetId'],
      where: { status: 'PENDIENTE' },
      _count: { id: true },
      _min: { createdAt: true },
      orderBy: { _min: { createdAt: 'asc' } },
      take: limite,
    });

    // Los motivos de cada grupo, en una sola consulta.
    const detalles = await this.prisma.report.findMany({
      where: {
        status: 'PENDIENTE',
        OR: grupos.map((g) => ({ targetType: g.targetType, targetId: g.targetId })),
      },
      select: {
        id: true,
        targetType: true,
        targetId: true,
        reason: true,
        detail: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      items: grupos.map((g) => {
        const suyos = detalles.filter(
          (d) => d.targetType === g.targetType && d.targetId === g.targetId,
        );
        return {
          targetType: g.targetType,
          targetId: g.targetId,
          reportes: g._count.id,
          primero: g._min.createdAt,
          motivos: [...new Set(suyos.map((s) => s.reason))],
          // El texto libre es lo más útil para decidir, así que va entero.
          detalles: suyos.filter((s) => s.detail).map((s) => s.detail),
          umbrales: Object.fromEntries(
            [...new Set(suyos.map((s) => s.reason))].map((r) => [r, umbralDe(r)]),
          ),
          reporteIds: suyos.map((s) => s.id),
        };
      }),
    };
  }

  /**
   * Una persona resuelve un grupo de reportes.
   *
   * Resuelve TODOS los reportes pendientes sobre ese contenido de una vez: el
   * moderador revisó el producto, no cada reporte por separado.
   */
  async resolver(
    moderadorUserId: string,
    dto: {
      targetType: ReportTarget;
      targetId: string;
      decision: 'CONFIRMADO' | 'DESESTIMADO';
      resolution: string;
      /** Qué hacer con el contenido. */
      accion?: 'HIDE' | 'UNHIDE' | 'NADA';
    },
  ) {
    const ahora = new Date();

    const { count } = await this.prisma.report.updateMany({
      where: { targetType: dto.targetType, targetId: dto.targetId, status: 'PENDIENTE' },
      data: {
        status: dto.decision,
        reviewedByUserId: moderadorUserId,
        reviewedAt: ahora,
        resolution: dto.resolution,
      },
    });

    if (count === 0) throw new ReporteNoEncontradoError();

    if (dto.accion === 'HIDE' && dto.targetType === 'PRODUCT') {
      await this.ocultarProducto(dto.targetId, {
        razon: dto.resolution,
        // Lo decidió una persona: el aviso es neutro y el motivo detallado se
        // le da por soporte si lo pide. Copiar la nota interna del moderador
        // en una notificación sería exponer cómo se decide por dentro.
        aviso: 'Revisamos tu publicación y la ocultamos. Escribinos si querés que lo veamos de nuevo.',
        actorUserId: moderadorUserId,
        automatico: false,
      });
    }
    if (dto.accion === 'UNHIDE' && dto.targetType === 'PRODUCT') {
      await this.mostrarProducto(dto.targetId, dto.resolution, moderadorUserId);
    }

    await this.audit.log({
      action: 'moderation.resolved',
      entityType: dto.targetType.toLowerCase(),
      entityId: dto.targetId,
      actorId: moderadorUserId,
      after: { decision: dto.decision, accion: dto.accion ?? 'NADA', reportes: count },
    });

    return { ok: true as const, resueltos: count };
  }

  /** Devuelve un producto a la venta. */
  private async mostrarProducto(
    productId: string,
    motivo: string,
    actorUserId: string,
  ): Promise<void> {
    const { count } = await this.prisma.product.updateMany({
      where: { id: productId, hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
    if (count === 0) return;

    await this.prisma.moderationAction.create({
      data: {
        id: newId('mod'),
        targetType: 'PRODUCT',
        targetId: productId,
        action: 'UNHIDE',
        actorUserId,
        reason: motivo,
      },
    });

    const producto = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { name: true, store: { select: { seller: { select: { userId: true } } } } },
    });
    if (!producto) return;

    await this.notifications.crear({
      userId: producto.store.seller.userId,
      type: 'ACCOUNT',
      title: `"${producto.name}" volvió a estar visible`,
      body: 'Revisamos los reportes y no encontramos problemas. Disculpá la molestia.',
      data: { tipo: 'product', productId },
      dedupeKey: `product_unhidden:${productId}:${Date.now()}`,
    });
  }

  /**
   * La historia de moderación de algo.
   *
   * Es lo que se mira cuando un vendedor reclama: quién ocultó, cuándo, por
   * qué, y si alguien lo devolvió. Con un booleano en el producto, esa historia
   * no existiría.
   */
  async historial(targetType: ReportTarget, targetId: string) {
    const items = await this.prisma.moderationAction.findMany({
      where: { targetType, targetId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items };
  }

  /**
   * Que el contenido exista.
   *
   * Sin esto se acumulan reportes sobre ids inventados, que además ensucian la
   * cola con grupos que no llevan a ningún lado.
   */
  private async verificarQueExiste(targetType: ReportTarget, targetId: string): Promise<void> {
    const existe = await (async () => {
      switch (targetType) {
        case 'PRODUCT':
          return this.prisma.product.count({ where: { id: targetId, deletedAt: null } });
        case 'LIVE':
          return this.prisma.liveSession.count({ where: { id: targetId } });
        case 'SELLER':
          return this.prisma.seller.count({ where: { id: targetId } });
        case 'REVIEW':
          return this.prisma.review.count({ where: { id: targetId } });
        case 'USER':
          return this.prisma.user.count({ where: { id: targetId, deletedAt: null } });
        case 'CHAT_MESSAGE':
          /**
           * Los mensajes del chat AHORA SÍ se guardan.
           *
           * Antes vivían sólo en el socket y este `case` devolvía 1 sin mirar
           * nada: el reporte se aceptaba a ciegas y quien moderaba tenía
           * únicamente la versión de quien reportaba.
           *
           * Con la tabla, un reporte sobre un mensaje inexistente se rechaza,
           * y quien revisa ve el texto original. Ver
           * `live/chat-moderacion.service.ts`.
           */
          return this.prisma.liveChatMessage.count({ where: { id: targetId } });
      }
    })();

    if (existe === 0) {
      throw new DomainError('REPORT_TARGET_NOT_FOUND', 'Eso ya no existe');
    }
  }
}
