import { Injectable } from '@nestjs/common';
import { Prisma, type LikeTarget } from '@prisma/client';

import { env } from '@/config/env.schema';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { PRODUCTO_VISIBLE } from '@/modules/commerce/visibilidad';

import { mensajeDeCompartido, type CosaCompartible, type OrigenDeCompartido } from './compartir';
import {
  VISTOS_EN_PANTALLA,
  VISTOS_MAXIMO_POR_PERSONA,
  VISTOS_RETENCION_DIAS,
} from './vistos';

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

  // ═══════════════════════════════════════════════════════════════════════════
  // GUARDADOS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Lo que la persona guardó.
   *
   * ⚠️ **Es la misma tabla que los «me gusta».** No hay un sistema paralelo de
   * favoritos: el corazón de un producto Y la lista de guardados leen y
   * escriben `Like` con `targetType: 'PRODUCT'`.
   *
   * Son dos nombres para el mismo gesto. Separarlos hubiera obligado a la
   * persona a decidir la diferencia entre «me gusta» y «guardar», que es una
   * distinción que existe en el modelo de datos y no en la cabeza de nadie —
   * y a nosotros a mantener dos contadores que se desincronizan.
   *
   * Lo que sí cambia es el nombre en la interfaz: «Guardados» dice qué se
   * puede hacer con la lista; «Me gusta» no dice nada.
   */
  async misGuardados(userId: string, dto: { cursor?: string; limit: number }) {
    const filas = await this.prisma.like.findMany({
      where: { userId, targetType: 'PRODUCT' },
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });

    const hayMas = filas.length > dto.limit;
    const pagina = hayMas ? filas.slice(0, dto.limit) : filas;

    /**
     * Los productos se leen en UNA consulta, no una por guardado.
     *
     * `Like` es polimórfico —apunta a productos y a vivos por id, sin clave
     * foránea— así que Prisma no puede hacer el join solo. Con veinte
     * guardados en pantalla, la alternativa ingenua son veintiuna consultas.
     */
    const productos = await this.prisma.product.findMany({
      where: { id: { in: pagina.map((l) => l.targetId) }, ...PRODUCTO_VISIBLE },
      select: {
        id: true,
        name: true,
        basePriceCents: true,
        currency: true,
        images: { where: { position: 0 }, take: 1, select: { url: true } },
        store: { select: { id: true, name: true, slug: true } },
        variants: {
          where: { deletedAt: null, status: 'ACTIVE' },
          select: { inventory: { select: { onHand: true, reserved: true } } },
        },
      },
    });

    const porId = new Map(productos.map((p) => [p.id, p]));

    return {
      /**
       * ⚠️ Los que ya no están se saltean, no se muestran rotos.
       *
       * Un producto guardado puede haber sido despublicado, borrado o su
       * tienda suspendida. La fila de `Like` sigue —no hay clave foránea que
       * la limpie— así que la lista tiene que tolerar huecos.
       *
       * Se saltean en silencio: «este producto ya no está disponible» ocupando
       * un lugar en la lista de guardados es peor que no mostrarlo.
       */
      items: pagina.flatMap((l) => {
        const p = porId.get(l.targetId);
        if (!p) return [];

        const disponible = p.variants.some(
          (v) => (v.inventory?.onHand ?? 0) - (v.inventory?.reserved ?? 0) > 0,
        );

        return [
          {
            id: p.id,
            nombre: p.name,
            precioCentavos: p.basePriceCents,
            moneda: p.currency,
            portada: p.images[0]?.url ?? null,
            tienda: p.store,
            /** Dato real del inventario. Es lo que hace útil la lista. */
            hayStock: disponible,
            guardadoEl: l.createdAt,
          },
        ];
      }),
      siguienteCursor: hayMas ? (pagina[pagina.length - 1]?.id ?? null) : null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VISTOS RECIENTEMENTE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Registra que alguien vio algo.
   *
   * ⚠️ **Nunca lanza.** Si esto falla, la persona igual tiene que poder ver el
   * producto: es una comodidad, no parte de la operación. Un error acá que
   * tumbe la pantalla del producto sería cambiar algo que funciona por algo
   * que ayuda.
   *
   * ─── Y no espera ───
   *
   * Quien llama hace `void`: registrar la visita no puede sumarle latencia a
   * abrir un producto, que es de las cosas más frecuentes que pasan en la app.
   */
  async registrarVista(userId: string, targetType: LikeTarget, targetId: string): Promise<void> {
    try {
      await this.prisma.recentlyViewed.upsert({
        where: { userId_targetType_targetId: { userId, targetType, targetId } },
        // Volver a verlo actualiza la fecha, no agrega otra fila. Sin esto,
        // quien mira un producto diez veces lo ve diez veces en su lista.
        update: { viewedAt: new Date() },
        create: { id: newId('vst'), userId, targetType, targetId },
      });

      await this.podarVistos(userId);
    } catch {
      // Deliberadamente en silencio. Ver arriba.
    }
  }

  /**
   * Deja los últimos [VISTOS_MAXIMO_POR_PERSONA] y borra el resto.
   *
   * Sin esto la tabla crece con cada scroll de cada persona, para siempre. Con
   * cien mil usuarios navegando sería la tabla más grande del sistema por
   * varios órdenes de magnitud, y el 99 % de las filas no las leería nadie
   * nunca porque sólo se muestran veinte.
   *
   * Se poda al escribir y no con un barrido periódico porque el costo es de
   * quien genera las filas, y porque un barrido global tendría que recorrer
   * todos los usuarios para encontrar a los pocos que se pasaron.
   */
  private async podarVistos(userId: string): Promise<void> {
    const cuantos = await this.prisma.recentlyViewed.count({ where: { userId } });
    if (cuantos <= VISTOS_MAXIMO_POR_PERSONA) return;

    const sobrantes = await this.prisma.recentlyViewed.findMany({
      where: { userId },
      orderBy: { viewedAt: 'desc' },
      skip: VISTOS_MAXIMO_POR_PERSONA,
      select: { id: true },
    });

    await this.prisma.recentlyViewed.deleteMany({
      where: { id: { in: sobrantes.map((s) => s.id) } },
    });
  }

  /**
   * Lo que vio, lo más reciente primero.
   *
   * Sólo productos por ahora: a un vivo terminado no se vuelve, y a una tienda
   * se llega desde cualquiera de sus productos.
   */
  async misVistosRecientes(userId: string) {
    const desde = new Date(Date.now() - VISTOS_RETENCION_DIAS * 24 * 3_600_000);

    const filas = await this.prisma.recentlyViewed.findMany({
      where: { userId, targetType: 'PRODUCT', viewedAt: { gte: desde } },
      orderBy: { viewedAt: 'desc' },
      take: VISTOS_EN_PANTALLA,
    });

    if (filas.length === 0) return { items: [] };

    const productos = await this.prisma.product.findMany({
      where: { id: { in: filas.map((f) => f.targetId) }, ...PRODUCTO_VISIBLE },
      select: {
        id: true,
        name: true,
        basePriceCents: true,
        currency: true,
        images: { where: { position: 0 }, take: 1, select: { url: true } },
        store: { select: { id: true, name: true, slug: true } },
      },
    });

    const porId = new Map(productos.map((p) => [p.id, p]));

    return {
      // El orden lo da la lista de vistas, no el de la consulta de productos.
      items: filas.flatMap((f) => {
        const p = porId.get(f.targetId);
        if (!p) return [];
        return [
          {
            id: p.id,
            nombre: p.name,
            precioCentavos: p.basePriceCents,
            moneda: p.currency,
            portada: p.images[0]?.url ?? null,
            tienda: p.store,
            vistoEl: f.viewedAt,
          },
        ];
      }),
    };
  }

  /**
   * Borra el historial de vistos de una persona.
   *
   * Tiene que existir. Es una lista de lo que alguien miró, y aunque no salga
   * de la app, poder borrarla es la diferencia entre una comodidad y algo que
   * la persona no controla.
   */
  async borrarVistos(userId: string): Promise<{ borrados: number }> {
    const { count } = await this.prisma.recentlyViewed.deleteMany({ where: { userId } });
    return { borrados: count };
  }

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
