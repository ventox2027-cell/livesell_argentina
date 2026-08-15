import { Injectable, Logger } from '@nestjs/common';

import { NotificationsService } from '@/modules/notifications/notifications.service';
import { AuditService } from '@/shared/audit/audit.service';
import { exigirHabilitada } from '@/shared/config/banderas';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { AVISO_ANTES_MINUTOS, cuandoEnCastellano, exigirFechaValida, toca_avisar } from './agenda';

/**
 * Vivos programados y recordatorios.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SEPARADO DE `LiveService` A PROPÓSITO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LiveService` maneja la transmisión: salas de LiveKit, tokens, estado,
 * reconexión, productos en la bandeja. Todo eso pasa mientras alguien está al
 * aire y cada milisegundo cuenta.
 *
 * Esto pasa antes y después: agendar, avisar, contar cuántos se anotaron. Son
 * ritmos distintos —uno es tiempo real y el otro es un barrido cada pocos
 * minutos— y meterlos en la misma clase hace que un cambio en la agenda
 * obligue a releer el código de la transmisión para estar seguro de no haber
 * roto nada.
 */
@Injectable()
export class AgendaService {
  private readonly logger = new Logger(AgendaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * El vendedor anuncia un vivo para más adelante.
   *
   * ⚠️ Crea la sesión en `SCHEDULED` **con fecha**, que es lo que la distingue
   * de una sesión recién preparada: esas también nacen en `SCHEDULED` y
   * arrancan enseguida.
   */
  async programar(
    userId: string,
    datos: { title: string; cuando: Date; coverUrl?: string; productIds?: string[] },
  ) {
    exigirHabilitada('LIVE_ENABLED');

    const vendedor = await this.prisma.seller.findUnique({
      where: { userId },
      include: { stores: { where: { isPrimary: true }, take: 1 } },
    });
    const tienda = vendedor?.stores[0];
    if (!vendedor || !tienda) {
      throw new DomainError('SELLER_NOT_FOUND', 'Todavía no tenés tienda');
    }

    // Ni muy cerca ni muy lejos. Ver `agenda.ts`.
    const cuando = exigirFechaValida(datos.cuando);

    /**
     * Se puede tener más de uno programado, pero no dos a la misma hora.
     *
     * A diferencia de las sesiones al aire —una sola por vendedor, porque dos
     * transmisiones simultáneas parten la audiencia— acá no hay conflicto
     * técnico: son anuncios. Lo que sí no tiene sentido es anunciar dos cosas
     * para el mismo momento, y casi siempre significa que alguien tocó dos
     * veces.
     */
    const yaHay = await this.prisma.liveSession.findFirst({
      where: {
        sellerId: vendedor.id,
        state: 'SCHEDULED',
        scheduledFor: cuando,
      },
      select: { id: true },
    });
    if (yaHay) {
      throw new DomainError('CONFLICT', 'Ya tenés un vivo programado para esa hora');
    }

    const id = newId('liv');

    const productos = datos.productIds?.length
      ? await this.prisma.product.findMany({
          where: {
            id: { in: datos.productIds.slice(0, 50) },
            store: { sellerId: vendedor.id },
            deletedAt: null,
          },
          select: { id: true },
        })
      : [];

    const sesion = await this.prisma.liveSession.create({
      data: {
        id,
        sellerId: vendedor.id,
        storeId: tienda.id,
        title: datos.title,
        coverUrl: datos.coverUrl ?? null,
        roomName: `live-${id}`,
        state: 'SCHEDULED',
        scheduledFor: cuando,
        products: {
          create: productos.map((p, i) => ({ id: newId('lsp'), productId: p.id, position: i })),
        },
      },
      select: { id: true, title: true, scheduledFor: true, coverUrl: true },
    });

    await this.audit.log({
      action: 'live.scheduled',
      entityType: 'live_session',
      entityId: sesion.id,
      actorId: userId,
      after: { scheduledFor: cuando.toISOString() },
    });

    return { ...sesion, cuando: cuandoEnCastellano(cuando), recordatorios: 0 };
  }

  /** Los vivos anunciados de un vendedor, para su perfil público. */
  async proximosDe(sellerId: string, userId?: string) {
    const sesiones = await this.prisma.liveSession.findMany({
      where: {
        sellerId,
        state: 'SCHEDULED',
        // Sólo los que todavía no pasaron. Un anuncio vencido en un perfil se
        // lee como una tienda abandonada.
        scheduledFor: { gte: new Date() },
      },
      orderBy: { scheduledFor: 'asc' },
      take: 10,
      select: {
        id: true,
        title: true,
        coverUrl: true,
        scheduledFor: true,
        _count: { select: { recordatorios: true } },
        // Si esta persona ya lo marcó. Sin sesión, la lista viene vacía.
        recordatorios: userId ? { where: { userId }, select: { id: true }, take: 1 } : false,
      },
    });

    return {
      items: sesiones.map((s) => ({
        id: s.id,
        titulo: s.title,
        portada: s.coverUrl,
        cuandoISO: s.scheduledFor,
        cuando: s.scheduledFor ? cuandoEnCastellano(s.scheduledFor) : null,
        /** Cuántos se anotaron. Dato real, no una estimación. */
        interesados: s._count.recordatorios,
        /** `undefined` sin sesión: la app no muestra el botón. */
        loVoyAVer: userId ? (s.recordatorios as { id: string }[]).length > 0 : undefined,
      })),
    };
  }

  /**
   * «Recordarme». Es un interruptor, igual que el corazón.
   *
   * Con `POST` y `DELETE` separados la app tiene que saber el estado actual
   * para elegir cuál llamar, y cuando el que tiene en pantalla es viejo el
   * resultado es al revés de lo que la persona quiso.
   */
  async alternarRecordatorio(userId: string, liveSessionId: string) {
    const sesion = await this.prisma.liveSession.findFirst({
      where: { id: liveSessionId, state: 'SCHEDULED' },
      select: { id: true },
    });
    if (!sesion) throw new DomainError('SESSION_NOT_FOUND', 'Ese vivo ya no está programado');

    const existente = await this.prisma.liveReminder.findUnique({
      where: { userId_liveSessionId: { userId, liveSessionId } },
      select: { id: true },
    });

    if (existente) {
      await this.prisma.liveReminder.delete({ where: { id: existente.id } });
      return { loVoyAVer: false };
    }

    try {
      await this.prisma.liveReminder.create({
        data: { id: newId('rem'), userId, liveSessionId },
      });
    } catch {
      // Dos toques a la vez. El índice único resolvió la carrera y el estado
      // final es el que la persona quería.
    }

    return { loVoyAVer: true };
  }

  /**
   * Avisa a quienes se anotaron que el vivo está por empezar.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * SE LLAMA DESDE UN BARRIDO, NO DESDE UN TEMPORIZADOR
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Un `setTimeout` por vivo programado se pierde con cada reinicio del
   * proceso —y un despliegue a las 19:55 haría que nadie se entere del vivo de
   * las 20:00—. El barrido pregunta a la base, que es lo único que sobrevive.
   *
   * Devuelve cuántos avisos mandó, para que el llamador lo registre.
   */
  async avisarLosQueEmpiezanPronto(): Promise<{ vivos: number; avisos: number }> {
    const ahora = new Date();
    const hasta = new Date(ahora.getTime() + AVISO_ANTES_MINUTOS * 60_000);

    const proximos = await this.prisma.liveSession.findMany({
      where: {
        state: 'SCHEDULED',
        scheduledFor: { lte: hasta, gte: new Date(ahora.getTime() - 5 * 60_000) },
        // Ya avisado, no se repite. Es la defensa contra dos barridos que se
        // pisan o contra uno que corre dos veces tras un reinicio.
        reminderSentAt: null,
      },
      select: {
        id: true,
        title: true,
        scheduledFor: true,
        seller: { select: { displayName: true } },
      },
      take: 50,
    });

    let avisos = 0;

    for (const vivo of proximos) {
      if (!vivo.scheduledFor || !toca_avisar(vivo.scheduledFor, ahora)) continue;

      const anotados = await this.prisma.liveReminder.findMany({
        where: { liveSessionId: vivo.id },
        select: { userId: true },
      });

      for (const { userId } of anotados) {
        const creado = await this.notifications.crear({
          userId,
          type: 'LIVE_SOON',
          title: `${vivo.seller.displayName} empieza en unos minutos`,
          body: vivo.title,
          // El deep link: la app abre el vivo directo en vez de dejar a la
          // persona buscándolo en el feed.
          data: { liveSessionId: vivo.id, ruta: `/live/${vivo.id}` },
          // Una sola vez por persona y por vivo, aunque el barrido se repita.
          dedupeKey: `live-soon:${vivo.id}:${userId}`,
        });
        if (creado) avisos++;
      }

      /**
       * Se marca DESPUÉS de mandar, no antes.
       *
       * Al revés, un fallo en el medio dejaría el vivo marcado como avisado sin
       * que nadie se hubiera enterado. Así, el peor caso es que el próximo
       * barrido lo reintente — y la clave de deduplicación evita que a alguien
       * le llegue dos veces.
       */
      await this.prisma.liveSession.update({
        where: { id: vivo.id },
        data: { reminderSentAt: new Date() },
      });
    }

    if (avisos > 0) {
      this.logger.log({ msg: 'avisos de vivos próximos', vivos: proximos.length, avisos });
    }

    return { vivos: proximos.length, avisos };
  }

  /**
   * Avisa que un vivo arrancó.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ESTE AVISO NO EXISTÍA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `LIVE_STARTED` estaba en el enum desde el principio y **nadie lo emitía**:
   * un vendedor arrancaba una transmisión y sus seguidores no se enteraban. La
   * función de seguir a alguien no servía para nada.
   *
   * Se descubrió escribiendo el aviso de los recordatorios, cuando el comentario
   * que decía «de los seguidores ya se encarga LIVE_STARTED» resultó ser falso.
   *
   * ─── Dos públicos, un solo aviso por persona ───
   *
   * Le avisa a quien SIGUE al vendedor y a quien marcó «recordarme» en este
   * vivo. Son dos grupos que se superponen, y la clave de deduplicación es lo
   * que impide que a quien está en los dos le lleguen dos push seguidos.
   */
  async avisarQueArranco(liveSessionId: string): Promise<number> {
    const vivo = await this.prisma.liveSession.findUnique({
      where: { id: liveSessionId },
      select: {
        id: true,
        title: true,
        sellerId: true,
        seller: { select: { displayName: true } },
      },
    });
    if (!vivo) return 0;

    const [seguidores, anotados] = await Promise.all([
      this.prisma.follow.findMany({
        where: { sellerId: vivo.sellerId },
        select: { userId: true },
        // Tope: un vendedor con cien mil seguidores no puede generar cien mil
        // filas en una transacción de arranque de vivo. El resto se entera
        // porque lo ve en el feed, que es donde los vivos ya aparecen.
        take: 5_000,
      }),
      this.prisma.liveReminder.findMany({
        where: { liveSessionId },
        select: { userId: true },
      }),
    ]);

    // Un Set: quien sigue al vendedor Y marcó el recordatorio es una sola
    // persona y recibe un solo aviso.
    const destinatarios = new Set([
      ...seguidores.map((f) => f.userId),
      ...anotados.map((r) => r.userId),
    ]);

    let mandados = 0;
    for (const userId of destinatarios) {
      const creado = await this.notifications.crear({
        userId,
        type: 'LIVE_STARTED',
        title: `${vivo.seller.displayName} está en vivo`,
        body: vivo.title,
        // El deep link: la app abre el vivo directo en vez de dejar a la
        // persona buscándolo en el feed.
        data: { liveSessionId: vivo.id, ruta: `/live/${vivo.id}` },
        dedupeKey: `live-started:${vivo.id}:${userId}`,
      });
      if (creado) mandados++;
    }

    return mandados;
  }
}
