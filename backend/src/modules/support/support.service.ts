import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type SupportCategory, type SupportStatus } from '@prisma/client';

import { NotificationsService } from '@/modules/notifications/notifications.service';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import {
  decidirEscalada,
  respuestaProhibida,
  sugerirCategoria,
  type MotivoDeEscalada,
} from './escalada';
import { SupportAgent } from './support-agent';

/**
 * Soporte: tickets, conversación y escalada.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL ORDEN IMPORTA: PRIMERO SE DECIDE SI ESCALA, DESPUÉS SE CONTESTA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nunca al revés. Un asistente que primero genera la respuesta y después mira
 * si debía escalar ya escribió algo que no le correspondía — y si esa respuesta
 * queda en el ticket, la persona ya la leyó.
 *
 * Por eso `decidirEscalada` corre sobre el mensaje ENTRANTE, antes de pedirle
 * nada al asistente.
 */

export class TicketNoEncontradoError extends DomainError {
  constructor() {
    super('SUPPORT_TICKET_NOT_FOUND', 'No encontramos esa conversación');
  }
}

export class TicketCerradoError extends DomainError {
  constructor() {
    super(
      'SUPPORT_TICKET_CLOSED',
      'Esta conversación está cerrada. Abrí una nueva y con gusto te ayudamos.',
    );
  }
}

/** Lo que sale al cliente. Enumerado, no filtrado. */
const TICKET_SELECT = {
  id: true,
  category: true,
  status: true,
  subject: true,
  orderId: true,
  escalatedAt: true,
  lastMessageAt: true,
  resolvedAt: true,
  createdAt: true,
  // ⚠️ `assignedToUserId` y `escalationReason` NO salen: son de la bandeja
  // interna. A quien abrió el ticket no le sirve saber a qué persona del equipo
  // le tocó, y el motivo técnico de la escalada sólo genera preguntas.
} satisfies Prisma.SupportTicketSelect;

const MENSAJE_SELECT = {
  id: true,
  author: true,
  body: true,
  escalated: true,
  createdAt: true,
  // `authorUserId` tampoco: quién del equipo contestó es interno.
} satisfies Prisma.SupportMessageSelect;

/** Largo del asunto que se guarda para la lista. */
const LARGO_DEL_ASUNTO = 80;

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agente: SupportAgent,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // ABRIR Y CONVERSAR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Abre un ticket con el primer mensaje.
   *
   * La categoría se sugiere mirando el texto, pero la puede mandar quien abre:
   * adivinar mal y no dejar corregir mandaría una consulta de plata al flujo
   * equivocado.
   */
  async abrir(
    userId: string,
    dto: { mensaje: string; categoria?: SupportCategory; orderId?: string; asunto?: string },
  ) {
    const categoria = dto.categoria ?? sugerirCategoria(dto.mensaje);
    const ticketId = newId('sup');
    const ahora = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.supportTicket.create({
        data: {
          id: ticketId,
          userId,
          category: categoria,
          // El que escribió, o el derivado del mensaje. Ver `asunto()`.
          subject: dto.asunto?.trim() || this.asunto(dto.mensaje),
          orderId: dto.orderId ?? null,
          lastMessageAt: ahora,
        },
      });

      await tx.supportMessage.create({
        data: {
          id: newId('sms'),
          ticketId,
          author: 'USUARIO',
          authorUserId: userId,
          body: dto.mensaje,
        },
      });
    });

    await this.responderAutomaticamente(ticketId, userId, categoria, dto.mensaje);

    return this.detalle(userId, ticketId);
  }

  /**
   * Agrega un mensaje a un ticket existente.
   *
   * La pertenencia va en el WHERE: un ticket ajeno no se encuentra.
   */
  async responder(userId: string, ticketId: string, mensaje: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, userId },
      select: { id: true, status: true, category: true },
    });
    if (!ticket) throw new TicketNoEncontradoError();
    if (ticket.status === 'CERRADO') throw new TicketCerradoError();

    const ahora = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.supportMessage.create({
        data: {
          id: newId('sms'),
          ticketId,
          author: 'USUARIO',
          authorUserId: userId,
          body: mensaje,
        },
      });

      await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          lastMessageAt: ahora,
          /**
           * Contestar reabre un ticket resuelto.
           *
           * Alguien que escribe en una conversación cerrada tiene algo más que
           * decir sobre lo mismo. Obligarlo a abrir otra desde cero pierde el
           * contexto y hace que el equipo lea la historia dos veces.
           *
           * Un ticket ESCALADO no cambia de estado: sigue esperando a la misma
           * persona.
           */
          ...(ticket.status === 'RESUELTO' || ticket.status === 'ESPERANDO_RESPUESTA'
            ? { status: 'ABIERTO' as const, resolvedAt: null }
            : {}),
        },
      });
    });

    await this.responderAutomaticamente(ticketId, userId, ticket.category, mensaje);

    return this.detalle(userId, ticketId);
  }

  /**
   * El asistente contesta, o el ticket escala.
   *
   * ─── Las tres formas de terminar en una persona ───
   *
   *   1. las reglas lo exigen —plata, disputa, lo pidió— y el asistente ni
   *      llega a opinar;
   *   2. el asistente no sabe qué contestar;
   *   3. el asistente contestó algo que no puede decir, y la red lo atajó.
   *
   * La tercera no debería pasar nunca con el asistente guionado. Existe para el
   * día que haya un modelo de lenguaje del otro lado.
   */
  private async responderAutomaticamente(
    ticketId: string,
    userId: string,
    categoria: SupportCategory,
    mensaje: string,
  ): Promise<void> {
    const vueltasPrevias = await this.prisma.supportMessage.count({
      where: { ticketId, author: 'ASISTENTE' },
    });

    // ⚠️ ANTES de pedirle nada al asistente.
    const decision = decidirEscalada({ categoria, mensaje, vueltasPrevias });

    if (decision.escalar) {
      await this.escalar(ticketId, userId, decision.motivo!, decision.aviso!);
      return;
    }

    const respuesta = await this.agente.responder({
      categoria,
      mensaje,
      vueltasPrevias,
      tieneOrden: false,
    });

    if (respuesta.noSabe || !respuesta.texto) {
      await this.escalar(
        ticketId,
        userId,
        'sin_respuesta_automatica',
        'No tengo la respuesta a esto. Le paso tu consulta a una persona del equipo.',
      );
      return;
    }

    if (respuestaProhibida(respuesta.texto)) {
      /**
       * La respuesta NO se guarda. Ni siquiera para auditoría del contenido:
       * lo que se registra es que pasó, no lo que decía.
       *
       * Guardar el texto sería dejar la promesa escrita en algún lado, y de ahí
       * a que aparezca en una captura de pantalla hay un paso.
       */
      this.logger.error({
        msg: '⚠️ el asistente intentó prometer algo que no puede: se escaló',
        ticketId,
        categoria,
      });
      await this.escalar(
        ticketId,
        userId,
        'sin_respuesta_automatica',
        'Prefiero que esto lo vea una persona del equipo. Ya le pasamos tu consulta.',
      );
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.supportMessage.create({
        data: { id: newId('sms'), ticketId, author: 'ASISTENTE', body: respuesta.texto! },
      });
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { status: 'ESPERANDO_RESPUESTA', lastMessageAt: new Date() },
      });
    });

    await this.avisar(userId, ticketId, 'Te respondimos tu consulta');
  }

  /** Deja el ticket esperando a una persona del equipo. */
  private async escalar(
    ticketId: string,
    userId: string,
    motivo: MotivoDeEscalada,
    aviso: string,
  ): Promise<void> {
    const ahora = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.supportMessage.create({
        data: {
          id: newId('sms'),
          ticketId,
          author: 'SISTEMA',
          body: aviso,
          escalated: true,
        },
      });
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: 'ESCALADO',
          escalationReason: motivo,
          escalatedAt: ahora,
          lastMessageAt: ahora,
        },
      });
    });

    await this.audit.log({
      action: 'support.escalated',
      entityType: 'support_ticket',
      entityId: ticketId,
      actorId: userId,
      after: { motivo },
    });

    await this.avisar(userId, ticketId, 'Tu consulta pasó a una persona del equipo');
  }

  /**
   * Un aviso en el centro de notificaciones.
   *
   * Con clave de deduplicación por mensaje: si el mismo evento se procesara dos
   * veces —un reintento, dos worker— la persona recibiría el mismo aviso
   * repetido.
   */
  private async avisar(userId: string, ticketId: string, titulo: string): Promise<void> {
    const ultimo = await this.prisma.supportMessage.findFirst({
      where: { ticketId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    await this.notifications.crear({
      userId,
      type: 'SUPPORT_REPLY',
      title: titulo,
      body: 'Entrá para ver la respuesta.',
      data: { tipo: 'support', ticketId },
      dedupeKey: ultimo ? `support:${ultimo.id}` : undefined,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LEER
  // ═══════════════════════════════════════════════════════════════════════

  async listar(userId: string) {
    const items = await this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { lastMessageAt: 'desc' },
      take: 50,
      select: TICKET_SELECT,
    });
    return { items };
  }

  async detalle(userId: string, ticketId: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, userId },
      select: { ...TICKET_SELECT, messages: { orderBy: { createdAt: 'asc' }, select: MENSAJE_SELECT } },
    });
    if (!ticket) throw new TicketNoEncontradoError();
    return ticket;
  }

  /** Quien abrió el ticket lo puede dar por resuelto. */
  async marcarResuelto(userId: string, ticketId: string) {
    const { count } = await this.prisma.supportTicket.updateMany({
      where: { id: ticketId, userId, status: { notIn: ['CERRADO', 'RESUELTO'] } },
      data: { status: 'RESUELTO', resolvedAt: new Date() },
    });
    if (count === 0) throw new TicketNoEncontradoError();
    return this.detalle(userId, ticketId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LA BANDEJA DEL EQUIPO
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lo que espera a una persona.
   *
   * ⚠️ Sólo para administradores. El control está en el controlador, con el
   * guardia de rol; acá no se vuelve a comprobar porque duplicarlo crea la
   * ilusión de que alguna de las dos capas es opcional.
   */
  async bandeja(params: { status?: SupportStatus } = {}) {
    const items = await this.prisma.supportTicket.findMany({
      where: { status: params.status ?? 'ESCALADO' },
      // Lo más viejo arriba: quien espera hace más rato se atiende primero.
      orderBy: { lastMessageAt: 'asc' },
      take: 100,
      select: {
        ...TICKET_SELECT,
        escalationReason: true,
        assignedToUserId: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    return { items };
  }

  /** Una persona del equipo contesta. */
  async responderComoEquipo(agenteUserId: string, ticketId: string, mensaje: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, userId: true, status: true },
    });
    if (!ticket) throw new TicketNoEncontradoError();

    const ahora = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.supportMessage.create({
        data: {
          id: newId('sms'),
          ticketId,
          author: 'EQUIPO',
          authorUserId: agenteUserId,
          body: mensaje,
        },
      });
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: 'ESPERANDO_RESPUESTA',
          lastMessageAt: ahora,
          // Queda asignado a quien contestó primero: evita que dos personas del
          // equipo escriban lo mismo con minutos de diferencia.
          assignedToUserId: ticket.status === 'ESCALADO' ? agenteUserId : undefined,
        },
      });
    });

    await this.audit.log({
      action: 'support.replied',
      entityType: 'support_ticket',
      entityId: ticketId,
      actorId: agenteUserId,
    });

    await this.avisar(ticket.userId, ticketId, 'Te respondimos tu consulta');
    return { ok: true as const };
  }

  /**
   * El primer mensaje, recortado, para la lista.
   *
   * Se corta en la última palabra completa: un asunto que termina en "quería
   * consul…" se lee peor que uno que termina en "quería…".
   */
  private asunto(mensaje: string): string {
    const limpio = mensaje.trim().replace(/\s+/g, ' ');
    if (limpio.length <= LARGO_DEL_ASUNTO) return limpio;

    const cortado = limpio.slice(0, LARGO_DEL_ASUNTO);
    const ultimoEspacio = cortado.lastIndexOf(' ');
    return `${ultimoEspacio > 40 ? cortado.slice(0, ultimoEspacio) : cortado}…`;
  }
}
