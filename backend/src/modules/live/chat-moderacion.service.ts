import { Injectable, Logger } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { filtrarMensaje, type MotivoDelFiltro } from './filtro-de-chat';

/**
 * Moderar el chat de un vivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ PUEDE HACER CADA UNO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * | Acción                | Vendedor | Moderación |
 * |-----------------------|----------|------------|
 * | Borrar un mensaje     | En su vivo | Cualquiera |
 * | Silenciar (temporal)  | En su vivo | Cualquiera |
 * | Silenciar sin fecha   | ⛔ no     | Sí         |
 * | Silenciar en TODOS    | ⛔ no     | Sí         |
 * | Suspender la cuenta   | ⛔ no     | Sí         |
 *
 * El criterio: **el vendedor manda en su sala, no en la plataforma**. Callar a
 * alguien durante un vivo es moderar tu propio espacio; callarlo para siempre o
 * en todos lados es una sanción, y esa la decide VendoX.
 *
 * ⛔ Ningún filtro automático sanciona. El filtro frena el mensaje y lo
 * registra; todo lo demás lo decide una persona. Un filtro que sanciona
 * convierte cada falso positivo en un castigo, y los falsos positivos son
 * inevitables.
 */

export class NoPodesModerarEsteVivoError extends DomainError {
  constructor() {
    // 404 y no 403: confirmar que el vivo existe le diría a quien prueba que
    // acertó un id ajeno. Misma política que el resto del sistema.
    super('NOT_FOUND', 'No se encontró la transmisión');
  }
}

export class MensajeNoEncontradoError extends DomainError {
  constructor() {
    super('CHAT_MESSAGE_NOT_FOUND', 'Ese mensaje ya no está');
  }
}

/** Cuánto puede durar un silencio puesto por el vendedor. */
export const MAX_SILENCIO_DEL_VENDEDOR_MINUTOS = 60 * 24;

@Injectable()
export class ChatModeracionService {
  private readonly logger = new Logger(ChatModeracionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Pasa el mensaje por el filtro y lo guarda.
   *
   * Devuelve si se puede emitir. **Guarda siempre**, incluso lo que el filtro
   * frenó: sin los frenados no hay forma de saber si el filtro se está pasando
   * de estricto y silenciando gente que no hizo nada.
   *
   * ─── El costo ───
   *
   * Un INSERT por mensaje de chat. En un vivo con mil personas escribiendo son
   * unos pocos por segundo, que para PostgreSQL no es nada. Se hace **después**
   * de emitir cuando el mensaje pasa el filtro: quien escribe no espera a la
   * base para ver su mensaje en pantalla.
   */
  filtrar(texto: string): { permitido: boolean; motivo?: MotivoDelFiltro } {
    return filtrarMensaje(texto, {
      palabrasProhibidas: env.CHAT_PALABRAS_PROHIBIDAS.length
        ? env.CHAT_PALABRAS_PROHIBIDAS
        : undefined,
    });
  }

  /**
   * Guarda el mensaje. No bloquea la emisión.
   *
   * Nunca lanza: si guardar falla, el chat tiene que seguir funcionando. Lo que
   * se pierde es la capacidad de moderar ESE mensaje, no el vivo entero.
   */
  async registrar(params: {
    id: string;
    liveSessionId: string;
    userId: string;
    texto: string;
    frenadoPor?: MotivoDelFiltro;
  }): Promise<void> {
    try {
      await this.prisma.liveChatMessage.create({
        data: {
          id: params.id,
          liveSessionId: params.liveSessionId,
          userId: params.userId,
          text: params.texto,
          blockedByFilter: params.frenadoPor ?? null,
        },
      });
    } catch (err) {
      this.logger.warn({
        msg: 'no se pudo guardar un mensaje de chat',
        liveSessionId: params.liveSessionId,
        // ⚠️ Sin el texto: puede ser cualquier cosa y los logs se leen enteros.
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * ¿Está callado?
   *
   * Corre en CADA mensaje, así que es una sola consulta con índice. Cubre las
   * dos formas: el silencio de este vivo y el global de moderación.
   */
  async estaSilenciado(userId: string, liveSessionId: string): Promise<boolean> {
    const ahora = new Date();
    const n = await this.prisma.liveChatMute.count({
      where: {
        userId,
        // El de este vivo, o el global.
        OR: [{ liveSessionId }, { liveSessionId: null }],
        // Sin vencer, o sin fecha de vencimiento.
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: ahora } }] }],
      },
    });
    return n > 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ACCIONES DEL VENDEDOR, EN SU PROPIO VIVO
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Borra un mensaje del chat.
   *
   * Borrado lógico: el mensaje es la evidencia de por qué se sancionó a
   * alguien, y borrarlo de verdad deja la sanción sin respaldo.
   */
  async borrarMensaje(params: {
    mensajeId: string;
    porUserId: string;
    /** `true` si quien borra es moderación y no el dueño del vivo. */
    esModerador?: boolean;
  }): Promise<{ ok: true; liveSessionId: string }> {
    const mensaje = await this.prisma.liveChatMessage.findUnique({
      where: { id: params.mensajeId },
      select: {
        id: true,
        liveSessionId: true,
        userId: true,
        deletedAt: true,
        session: { select: { seller: { select: { userId: true } } } },
      },
    });
    if (!mensaje) throw new MensajeNoEncontradoError();

    if (!params.esModerador && mensaje.session.seller.userId !== params.porUserId) {
      throw new NoPodesModerarEsteVivoError();
    }

    // Idempotente: borrar dos veces no es un error del vendedor.
    if (!mensaje.deletedAt) {
      await this.prisma.liveChatMessage.update({
        where: { id: mensaje.id },
        data: { deletedAt: new Date(), deletedByUserId: params.porUserId },
      });

      await this.audit.log({
        action: 'live.chat_message_deleted',
        entityType: 'live_session',
        entityId: mensaje.liveSessionId,
        actorId: params.porUserId,
        // ⚠️ Se registra a QUIÉN se le borró, no QUÉ decía. El texto queda en
        // la fila del mensaje, que es donde corresponde mirarlo.
        after: { mensajeId: mensaje.id, autorId: mensaje.userId },
      });
    }

    return { ok: true, liveSessionId: mensaje.liveSessionId };
  }

  /**
   * Silencia a alguien en un vivo.
   *
   * ─── Por qué el vendedor no puede silenciar para siempre ───
   *
   * Un silencio permanente es una expulsión de la plataforma, y esa la decide
   * VendoX. Lo que el vendedor puede hacer es callar a alguien durante su vivo:
   * es su espacio y está pasando ahora.
   *
   * El tope son 24 horas. Más que eso ya no es "durante mi vivo".
   */
  async silenciar(params: {
    liveSessionId: string;
    aUserId: string;
    porUserId: string;
    motivo: string;
    minutos: number;
    esModerador?: boolean;
  }): Promise<{ ok: true; hasta: Date }> {
    const sesion = await this.prisma.liveSession.findUnique({
      where: { id: params.liveSessionId },
      select: { id: true, seller: { select: { userId: true } } },
    });
    if (!sesion) throw new NoPodesModerarEsteVivoError();

    if (!params.esModerador && sesion.seller.userId !== params.porUserId) {
      throw new NoPodesModerarEsteVivoError();
    }

    /**
     * El vendedor no se puede silenciar a sí mismo, ni a un moderador.
     *
     * Lo primero no rompe nada pero es un estado sin sentido; lo segundo sí
     * sería un problema: dejaría a alguien apagar a quien lo está moderando.
     */
    if (params.aUserId === params.porUserId) {
      throw new DomainError('CANNOT_MUTE_SELF', 'No te podés silenciar a vos mismo');
    }
    const objetivo = await this.prisma.user.findUnique({
      where: { id: params.aUserId },
      select: { role: true },
    });
    if (!objetivo) throw new DomainError('USER_NOT_FOUND', 'No encontramos a esa persona');
    if (!params.esModerador && (objetivo.role === 'admin' || objetivo.role === 'moderator')) {
      throw new NoPodesModerarEsteVivoError();
    }

    const tope = params.esModerador ? Number.MAX_SAFE_INTEGER : MAX_SILENCIO_DEL_VENDEDOR_MINUTOS;
    const minutos = Math.min(Math.max(1, params.minutos), tope);
    const hasta = new Date(Date.now() + minutos * 60_000);

    await this.prisma.liveChatMute.create({
      data: {
        id: newId('mut'),
        liveSessionId: params.liveSessionId,
        userId: params.aUserId,
        byUserId: params.porUserId,
        reason: params.motivo,
        expiresAt: hasta,
      },
    });

    await this.audit.log({
      action: 'live.chat_muted',
      entityType: 'user',
      entityId: params.aUserId,
      actorId: params.porUserId,
      reason: params.motivo,
      after: { liveSessionId: params.liveSessionId, minutos, hasta },
    });

    return { ok: true, hasta };
  }

  /** Devuelve la voz. Idempotente. */
  async devolverLaVoz(params: {
    liveSessionId: string;
    aUserId: string;
    porUserId: string;
    esModerador?: boolean;
  }): Promise<{ ok: true }> {
    const sesion = await this.prisma.liveSession.findUnique({
      where: { id: params.liveSessionId },
      select: { seller: { select: { userId: true } } },
    });
    if (!sesion) throw new NoPodesModerarEsteVivoError();
    if (!params.esModerador && sesion.seller.userId !== params.porUserId) {
      throw new NoPodesModerarEsteVivoError();
    }

    const borrados = await this.prisma.liveChatMute.deleteMany({
      where: {
        userId: params.aUserId,
        // ⚠️ Sólo los de ESTE vivo. Un vendedor no puede levantar un silencio
        // global puesto por moderación.
        liveSessionId: params.liveSessionId,
      },
    });

    if (borrados.count > 0) {
      await this.audit.log({
        action: 'live.chat_unmuted',
        entityType: 'user',
        entityId: params.aUserId,
        actorId: params.porUserId,
        after: { liveSessionId: params.liveSessionId },
      });
    }

    return { ok: true };
  }

  /**
   * Lanza si este vivo no es de esta persona.
   *
   * 404 y no 403: confirmar que el vivo existe le diría a quien prueba que
   * acertó un id ajeno.
   */
  async exigirSerDuenoDelVivo(liveSessionId: string, userId: string): Promise<void> {
    const n = await this.prisma.liveSession.count({
      where: { id: liveSessionId, seller: { userId } },
    });
    if (n === 0) throw new NoPodesModerarEsteVivoError();
  }

  /**
   * El chat de un vivo, para moderar.
   *
   * Incluye los borrados y los frenados por el filtro: es lo que hace falta
   * para revisar un reporte y para saber si el filtro se está pasando.
   */
  async historial(liveSessionId: string, limite = 200) {
    return this.prisma.liveChatMessage.findMany({
      where: { liveSessionId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limite, 500),
      select: {
        id: true,
        text: true,
        createdAt: true,
        blockedByFilter: true,
        deletedAt: true,
        userId: true,
        user: { select: { firstName: true, lastName: true } },
      },
    });
  }

  /**
   * Borra los mensajes viejos.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * TREINTA DÍAS, Y EL NÚMERO TIENE MOTIVO
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Es el tiempo en que un reporte se abre, se revisa y se resuelve. Más allá
   * de eso, un mensaje de chat de un vivo no le sirve a nadie: el chat de un
   * vivo es efímero por naturaleza, nadie lo consulta como historial, y sí es
   * una base de conversaciones privadas creciendo sin límite.
   *
   * Lo corre el worker, no el proceso web. Ver `shared/app-role.ts`.
   */
  async borrarLosViejos(): Promise<number> {
    const corte = new Date(Date.now() - env.CHAT_RETENCION_DIAS * 24 * 60 * 60_000);

    const { count } = await this.prisma.liveChatMessage.deleteMany({
      where: { createdAt: { lt: corte } },
    });

    if (count > 0) {
      this.logger.log({ msg: 'mensajes de chat borrados por retención', cantidad: count, corte });
    }
    return count;
  }
}
