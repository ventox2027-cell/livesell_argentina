import { Injectable } from '@nestjs/common';
import { Prisma, type LikeTarget } from '@prisma/client';

import { env } from '@/config/env.schema';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { mensajeDeCompartido, type CosaCompartible, type OrigenDeCompartido } from './compartir';

/**
 * "Me gusta" y compartir.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL CONTADOR SE MUEVE EN LA MISMA TRANSACCIÓN QUE LA FILA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es la única forma de que no se despeguen. Con dos operaciones separadas, un
 * fallo entre medio deja un "me gusta" sin contar —o un contador con un número
 * que no corresponde a nada— y no hay forma de detectarlo sin recorrer la
 * tabla entera.
 *
 * Y es también la razón por la que el contador está denormalizado: contar la
 * tabla en cada tarjeta del feed sería una consulta agregada por fila en la
 * pantalla más visitada de la app.
 */

export class NoEncontradoParaGustarError extends DomainError {
  constructor() {
    super('LIKE_TARGET_NOT_FOUND', 'Eso ya no existe');
  }
}

@Injectable()
export class SocialService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Da o quita "me gusta". Es un interruptor, no dos endpoints.
   *
   * ─── Por qué uno solo ───
   *
   * En la app es un corazón que se toca. Con `POST` y `DELETE` separados, la
   * app tiene que saber el estado actual para elegir cuál llamar — y si se
   * equivoca, o si el estado que tenía era viejo, el resultado es al revés de
   * lo que la persona quiso.
   *
   * Con un interruptor, el backend sabe el estado real y devuelve el nuevo. La
   * app pinta lo que le dicen.
   */
  async alternarMeGusta(
    userId: string,
    targetType: LikeTarget,
    targetId: string,
  ): Promise<{ meGusta: boolean; total: number }> {
    await this.verificarQueExiste(targetType, targetId);

    const existente = await this.prisma.like.findUnique({
      where: { userId_targetType_targetId: { userId, targetType, targetId } },
      select: { id: true },
    });

    if (existente) {
      const total = await this.prisma.$transaction(async (tx) => {
        /**
         * `deleteMany` con el id, no `delete`.
         *
         * Dos toques simultáneos: el segundo `delete` lanzaría porque la fila
         * ya no está, y el error subiría como un 500 por tocar un corazón dos
         * veces rápido. `deleteMany` devuelve `count: 0` y sigue.
         */
        const { count } = await tx.like.deleteMany({ where: { id: existente.id } });
        if (count === 0) return this.contar(tx, targetType, targetId);

        return this.moverContador(tx, targetType, targetId, -1);
      });

      return { meGusta: false, total };
    }

    try {
      const total = await this.prisma.$transaction(async (tx) => {
        await tx.like.create({
          data: { id: newId('lik'), userId, targetType, targetId },
        });
        return this.moverContador(tx, targetType, targetId, 1);
      });

      return { meGusta: true, total };
    } catch (err) {
      /**
       * Carrera: dos toques simultáneos y el otro ganó.
       *
       * El índice único la resuelve y la transacción entera se deshace,
       * incremento incluido. Lo que corresponde devolver es el estado real, que
       * es "sí le gusta".
       */
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { meGusta: true, total: await this.contar(this.prisma, targetType, targetId) };
      }
      throw err;
    }
  }

  /** Si a esta persona le gusta, y cuántos son en total. */
  async estadoDeMeGusta(
    userId: string | null,
    targetType: LikeTarget,
    targetId: string,
  ): Promise<{ meGusta: boolean; total: number }> {
    const [mio, total] = await Promise.all([
      userId
        ? this.prisma.like.findUnique({
            where: { userId_targetType_targetId: { userId, targetType, targetId } },
            select: { id: true },
          })
        : Promise.resolve(null),
      this.contar(this.prisma, targetType, targetId),
    ]);

    return { meGusta: mio !== null, total };
  }

  /**
   * El enlace para compartir.
   *
   * Lo arma el backend: un enlace compartido sobrevive a la versión de la app
   * que lo generó. Ver el comentario largo en `compartir.ts`.
   */
  async enlaceDeCompartido(
    cosa: CosaCompartible,
    identificador: string,
    origen?: OrigenDeCompartido,
  ) {
    const titulo = await this.tituloDe(cosa, identificador);
    if (titulo === null) throw new NoEncontradoParaGustarError();

    return mensajeDeCompartido({
      baseUrl: env.PUBLIC_WEB_URL,
      cosa,
      identificador,
      titulo: titulo.nombre,
      precio: titulo.precio,
      origen,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AUXILIARES
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Que el destino exista y sea visible.
   *
   * La tabla es polimórfica y no puede tener clave foránea, así que esto es lo
   * único que impide acumular "me gusta" sobre ids inventados — que además
   * infla contadores de cosas que nadie puede ver.
   */
  private async verificarQueExiste(targetType: LikeTarget, targetId: string): Promise<void> {
    const existe =
      targetType === 'LIVE'
        ? await this.prisma.liveSession.count({ where: { id: targetId } })
        : await this.prisma.product.count({
            where: { id: targetId, status: 'ACTIVE', deletedAt: null },
          });

    if (existe === 0) throw new NoEncontradoParaGustarError();
  }

  private async moverContador(
    tx: Prisma.TransactionClient,
    targetType: LikeTarget,
    targetId: string,
    delta: number,
  ): Promise<number> {
    if (targetType === 'LIVE') {
      const fila = await tx.liveSession.update({
        where: { id: targetId },
        data: { likesCount: { increment: delta } },
        select: { likesCount: true },
      });
      return fila.likesCount;
    }

    const fila = await tx.product.update({
      where: { id: targetId },
      data: { likesCount: { increment: delta } },
      select: { likesCount: true },
    });
    return fila.likesCount;
  }

  private async contar(
    tx: Prisma.TransactionClient | PrismaService,
    targetType: LikeTarget,
    targetId: string,
  ): Promise<number> {
    if (targetType === 'LIVE') {
      const fila = await tx.liveSession.findUnique({
        where: { id: targetId },
        select: { likesCount: true },
      });
      return fila?.likesCount ?? 0;
    }

    const fila = await tx.product.findUnique({
      where: { id: targetId },
      select: { likesCount: true },
    });
    return fila?.likesCount ?? 0;
  }

  /** El nombre —y el precio, si lo tiene— de lo que se comparte. */
  private async tituloDe(
    cosa: CosaCompartible,
    identificador: string,
  ): Promise<{ nombre: string; precio?: string } | null> {
    switch (cosa) {
      case 'live': {
        const live = await this.prisma.liveSession.findUnique({
          where: { id: identificador },
          select: { seller: { select: { displayName: true } } },
        });
        return live ? { nombre: live.seller.displayName } : null;
      }
      case 'product': {
        const p = await this.prisma.product.findFirst({
          where: { id: identificador, status: 'ACTIVE', deletedAt: null },
          select: { name: true, basePriceCents: true },
        });
        return p
          ? { nombre: p.name, precio: this.comoPesos(p.basePriceCents) }
          : null;
      }
      case 'store': {
        const s = await this.prisma.store.findFirst({
          where: { slug: identificador, status: 'ACTIVE' },
          select: { name: true },
        });
        return s ? { nombre: s.name } : null;
      }
      case 'seller': {
        const s = await this.prisma.seller.findFirst({
          where: { slug: identificador, status: 'ACTIVE' },
          select: { displayName: true },
        });
        return s ? { nombre: s.displayName } : null;
      }
    }
  }

  /**
   * Centavos a pesos, para el texto del mensaje.
   *
   * Con separador de miles porque el mensaje lo lee una persona: `$890000` se
   * lee mal y `$8.900,00` sobra. `$8.900` es lo que espera alguien en Argentina.
   */
  private comoPesos(centavos: number): string {
    const pesos = Math.round(centavos / 100);
    return `$${pesos.toLocaleString('es-AR')}`;
  }
}
