import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

/**
 * Bloquear a alguien.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ HACE Y QUÉ NO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Bloquear **no es** reportar, y la diferencia importa:
 *
 *   · **bloquear** es una decisión personal, inmediata, reversible y que no
 *     involucra a nadie más. No hay revisión, no hay umbral, no hay cola. Es
 *     "no quiero ver más a esta persona";
 *   · **reportar** es pedirle a VendoX que revise algo. Tiene umbrales,
 *     revisión humana y consecuencias para la otra persona.
 *
 * Confundirlos es un error clásico: si bloquear tuviera consecuencias para el
 * bloqueado, se convertiría en un arma —bloqueos coordinados para bajar a un
 * vendedor— y si reportar sólo ocultara contenido para quien reporta, nadie
 * moderaría nada.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ES UNILATERAL Y SILENCIOSO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Quien es bloqueado **no se entera**. No hay aviso, no hay pantalla, y desde
 * su lado todo se ve igual. Avisarle es darle un motivo y un objetivo, y quien
 * bloquea suele estar tratando de que la otra persona pierda interés.
 *
 * Lo que cambia:
 *
 *   · en el **chat del vivo**, el silencio va en los dos sentidos. De nada
 *     sirve que A no lea a B si B puede seguir escribiéndole;
 *   · en el **catálogo y el feed**, quien bloquea deja de ver los productos y
 *     los vivos del bloqueado.
 *
 * ⚠️ Lo que NO hace: bloquear a un vendedor no cancela pedidos en curso ni
 * borra historial. Una compra hecha es un contrato entre dos personas, y no se
 * deshace porque una deje de querer ver a la otra. Está explicado en el mensaje
 * que ve quien bloquea.
 */

export class NoTePodesBloquearError extends DomainError {
  constructor() {
    super('CANNOT_BLOCK_SELF', 'No te podés bloquear a vos mismo');
  }
}

export class PersonaNoEncontradaError extends DomainError {
  constructor() {
    super('USER_NOT_FOUND', 'No encontramos a esa persona');
  }
}

@Injectable()
export class BloqueosService {
  private readonly logger = new Logger(BloqueosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Bloquea. Idempotente.
   *
   * Bloquear a alguien que ya estaba bloqueado devuelve lo mismo y no falla:
   * alguien que toca el botón dos veces por nervios no tiene por qué ver un
   * mensaje rojo.
   */
  async bloquear(
    blockerId: string,
    blockedId: string,
    motivo?: string,
  ): Promise<{ bloqueado: true; desde: Date }> {
    if (blockerId === blockedId) throw new NoTePodesBloquearError();

    /**
     * Se comprueba que exista y que no esté borrada.
     *
     * Sin esto se pueden crear filas contra ids inventados —el índice único no
     * lo impide— y la lista de bloqueados de alguien se llena de fantasmas que
     * la interfaz no puede mostrar.
     */
    const existe = await this.prisma.user.count({
      where: { id: blockedId, deletedAt: null },
    });
    if (existe === 0) throw new PersonaNoEncontradaError();

    try {
      const bloqueo = await this.prisma.userBlock.create({
        data: {
          id: newId('blk'),
          blockerId,
          blockedId,
          reason: motivo?.trim() || null,
        },
      });

      /**
       * Queda en la bitácora.
       *
       * No para castigar a nadie: para investigar. Cuando alguien denuncia
       * acoso, la secuencia de bloqueos —quién, a quién, cuándo, y si hubo
       * desbloqueos en el medio— es la mitad de la historia.
       *
       * ⚠️ El motivo NO se guarda en la auditoría, sólo si lo hubo. Puede
       * contener el relato de algo que le pasó a la persona, y la bitácora se
       * lee entera cuando se investiga cualquier otra cosa.
       */
      void this.audit.log({
        action: 'user.blocked',
        entityType: 'user',
        entityId: blockedId,
        actorId: blockerId,
        after: { conMotivo: Boolean(bloqueo.reason) },
      });

      return { bloqueado: true, desde: bloqueo.createdAt };
    } catch (err) {
      // Ya estaba bloqueado. Es idempotente: se devuelve el que ya existe.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const previo = await this.prisma.userBlock.findUniqueOrThrow({
          where: { blockerId_blockedId: { blockerId, blockedId } },
        });
        return { bloqueado: true, desde: previo.createdAt };
      }
      throw err;
    }
  }

  /**
   * El `userId` que hay detrás de un vendedor.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * POR QUÉ LA APP NO CONOCE EL `userId` DE UN VENDEDOR
   * ═══════════════════════════════════════════════════════════════════════
   *
   * El perfil público de un vendedor devuelve su `sellerId`, no el id de la
   * persona detrás. Podría devolver los dos y ahorrarse esta consulta, pero un
   * identificador de cuenta en una respuesta pública es un identificador que
   * después aparece en logs de terceros, en capturas y en cualquier
   * integración — y no hace falta para nada más.
   *
   * Así que el bloqueo por vendedor resuelve del lado del servidor.
   */
  async userIdDeVendedor(sellerId: string): Promise<string> {
    const seller = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      select: { userId: true },
    });
    if (!seller) throw new PersonaNoEncontradaError();
    return seller.userId;
  }

  /** Desbloquea. También idempotente: desbloquear a quien no estaba, no falla. */
  async desbloquear(blockerId: string, blockedId: string): Promise<{ bloqueado: false }> {
    const borrados = await this.prisma.userBlock.deleteMany({
      where: { blockerId, blockedId },
    });

    if (borrados.count > 0) {
      void this.audit.log({
        action: 'user.unblocked',
        entityType: 'user',
        entityId: blockedId,
        actorId: blockerId,
      });
    }

    return { bloqueado: false };
  }

  /** A quiénes bloqueó esta persona. Para la pantalla del perfil. */
  async lista(blockerId: string) {
    const filas = await this.prisma.userBlock.findMany({
      where: { blockerId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        createdAt: true,
        reason: true,
        blocked: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            seller: { select: { displayName: true, slug: true } },
          },
        },
      },
    });

    return filas.map((f) => ({
      userId: f.blocked.id,
      /**
       * Nombre y la inicial del apellido, como en el chat.
       *
       * El apellido completo de alguien no tiene por qué quedar en una lista
       * que se abre delante de otra persona, y "Juan P." alcanza para
       * reconocerlo.
       */
      nombre: `${f.blocked.firstName} ${f.blocked.lastName.charAt(0)}.`.trim(),
      tienda: f.blocked.seller?.displayName ?? null,
      avatarUrl: f.blocked.avatarUrl,
      motivo: f.reason,
      desde: f.createdAt,
    }));
  }

  /** ¿Esta persona bloqueó a esta otra? Para pintar el botón. */
  async estaBloqueado(blockerId: string, blockedId: string): Promise<boolean> {
    const n = await this.prisma.userBlock.count({ where: { blockerId, blockedId } });
    return n > 0;
  }

  /**
   * ¿Hay bloqueo entre estas dos personas, en CUALQUIER dirección?
   *
   * Es la que usa el chat. El bloqueo se declara en un sentido pero el silencio
   * tiene que ir en los dos: de nada sirve que A no lea a B si B puede seguir
   * escribiéndole y viéndolo participar.
   *
   * Una sola consulta con `OR` y no dos: esto corre en cada mensaje de chat de
   * cada persona en la sala, y ahí una consulta de más se nota.
   */
  async hayBloqueoEntre(unUsuario: string, otroUsuario: string): Promise<boolean> {
    if (unUsuario === otroUsuario) return false;

    const n = await this.prisma.userBlock.count({
      where: {
        OR: [
          { blockerId: unUsuario, blockedId: otroUsuario },
          { blockerId: otroUsuario, blockedId: unUsuario },
        ],
      },
    });
    return n > 0;
  }

  /**
   * Los ids que esta persona no quiere ver.
   *
   * Devuelve **sólo a quienes bloqueó**, no a quienes la bloquearon: el
   * ocultamiento del catálogo es unilateral. Si B bloquea a A, A sigue viendo
   * los productos de B — lo contrario permitiría hacerle desaparecer la tienda
   * a alguien bloqueándolo.
   *
   * Se usa para filtrar el feed y el catálogo. Va acotado: alguien con miles de
   * bloqueos convertiría cada consulta del feed en un `NOT IN` gigante, y a esa
   * altura el problema es otro.
   */
  async bloqueadosPor(blockerId: string): Promise<string[]> {
    const filas = await this.prisma.userBlock.findMany({
      where: { blockerId },
      select: { blockedId: true },
      take: 500,
    });
    return filas.map((f) => f.blockedId);
  }
}
