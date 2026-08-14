import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotificationsService } from '@/modules/notifications/notifications.service';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { comoHora, estaAbierta, type EstadoDeTienda, type Franja } from './horario';

/**
 * Tiendas: horarios, seguidores, reseñas y el perfil público del vendedor.
 *
 * ─── Lo que une a estas cuatro cosas ───
 *
 * Todas responden la misma pregunta desde ángulos distintos: **¿le compro a
 * esta persona?** El horario dice si puedo ahora, los seguidores y las reseñas
 * dicen si otros lo hicieron, y el perfil los junta.
 */

export class NoEncontradoError extends DomainError {
  constructor(que: string) {
    super('NOT_FOUND', `No se encontró ${que}`);
  }
}

export class AccionInvalidaError extends DomainError {
  constructor(mensaje: string) {
    super('VALIDATION_FAILED', mensaje);
  }
}

@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // HORARIOS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ¿Esta tienda está abierta?
   *
   * Sin horario configurado, **abierta**. Es lo contrario del caso
   * `SCHEDULED` sin franjas, y la diferencia es intencional: quien nunca tocó
   * la configuración no eligió cerrar, mientras que quien eligió "por horarios"
   * y no cargó ninguno sí dijo que quiere horarios.
   *
   * Que una tienda nueva arranque cerrada sería el peor comportamiento posible:
   * el vendedor carga sus productos, no vende nada, y no tiene forma de
   * entender por qué.
   */
  async estadoDeTienda(storeId: string): Promise<EstadoDeTienda> {
    const [horario, liveActivo] = await Promise.all([
      this.prisma.storeSchedule.findUnique({
        where: { storeId },
        include: { slots: true },
      }),
      this.prisma.liveSession.count({
        where: { storeId, state: { in: ['LIVE', 'RECONNECTING'] } },
      }),
    ]);

    if (!horario) {
      return { abierta: true, motivo: 'Siempre abierta', abreEl: null };
    }

    return estaAbierta({
      modo: horario.mode,
      zona: horario.timezone,
      franjas: horario.slots.map(
        (s): Franja => ({
          weekday: s.weekday,
          opensAtMinutes: s.opensAtMinutes,
          closesAtMinutes: s.closesAtMinutes,
        }),
      ),
      hayLive: liveActivo > 0,
      ahora: new Date(),
    });
  }

  /** El horario configurado, para que el vendedor lo edite. */
  async miHorario(userId: string) {
    const tienda = await this.tiendaDe(userId);

    const horario = await this.prisma.storeSchedule.findUnique({
      where: { storeId: tienda.id },
      include: { slots: { orderBy: [{ weekday: 'asc' }, { opensAtMinutes: 'asc' }] } },
    });

    const estado = await this.estadoDeTienda(tienda.id);

    return {
      modo: horario?.mode ?? 'ALWAYS_OPEN',
      zona: horario?.timezone ?? 'America/Argentina/Buenos_Aires',
      franjas: (horario?.slots ?? []).map((s) => ({
        dia: s.weekday,
        abre: comoHora(s.opensAtMinutes),
        cierra: comoHora(s.closesAtMinutes),
        abreMinutos: s.opensAtMinutes,
        cierraMinutos: s.closesAtMinutes,
      })),
      estadoActual: estado,
    };
  }

  /**
   * Guarda el horario completo.
   *
   * ─── Se reemplaza entero, no se edita franja por franja ───
   *
   * Un `PATCH` por franja obligaría a manejar altas, bajas y modificaciones por
   * separado, y a mitad de camino la tienda quedaría con un horario que su
   * dueño nunca eligió — abierta un martes que quiso borrar.
   *
   * Mandar el horario completo y reemplazarlo en una transacción es más simple
   * y no tiene estados intermedios visibles.
   */
  async guardarHorario(
    userId: string,
    datos: {
      modo: 'ALWAYS_OPEN' | 'SCHEDULED' | 'LIVE_ONLY';
      zona?: string;
      franjas: Array<{ dia: number; abreMinutos: number; cierraMinutos: number }>;
    },
  ) {
    const tienda = await this.tiendaDe(userId);

    /**
     * Las franjas de un mismo día no se pueden solapar.
     *
     * Dos franjas superpuestas no rompen el cálculo —`some()` devuelve true
     * igual— pero son un síntoma de que quien las cargó se equivocó, y
     * mostrarle "abre de 9 a 13 y de 11 a 18" es confuso. Es mejor rechazarlo
     * en el momento que dejarlo pasar.
     */
    for (const dia of new Set(datos.franjas.map((f) => f.dia))) {
      const delDia = datos.franjas
        .filter((f) => f.dia === dia)
        .sort((a, b) => a.abreMinutos - b.abreMinutos);

      for (let i = 1; i < delDia.length; i++) {
        const previa = delDia[i - 1]!;
        const actual = delDia[i]!;
        // Una franja que cruza la medianoche termina "después" de todo lo que
        // sigue ese día, así que no se compara con el criterio simple.
        const previaCruza = previa.cierraMinutos < previa.abreMinutos;
        if (!previaCruza && actual.abreMinutos < previa.cierraMinutos) {
          throw new AccionInvalidaError(
            `Hay dos franjas superpuestas el día ${dia}: ${comoHora(previa.abreMinutos)}–${comoHora(previa.cierraMinutos)} y ${comoHora(actual.abreMinutos)}–${comoHora(actual.cierraMinutos)}`,
          );
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const horario = await tx.storeSchedule.upsert({
        where: { storeId: tienda.id },
        create: {
          id: newId('sch'),
          storeId: tienda.id,
          mode: datos.modo,
          timezone: datos.zona ?? 'America/Argentina/Buenos_Aires',
        },
        update: {
          mode: datos.modo,
          ...(datos.zona ? { timezone: datos.zona } : {}),
        },
      });

      await tx.storeScheduleSlot.deleteMany({ where: { scheduleId: horario.id } });

      if (datos.franjas.length > 0) {
        await tx.storeScheduleSlot.createMany({
          data: datos.franjas.map((f) => ({
            id: newId('sls'),
            scheduleId: horario.id,
            weekday: f.dia,
            opensAtMinutes: f.abreMinutos,
            closesAtMinutes: f.cierraMinutos,
          })),
        });
      }
    });

    await this.audit.log({
      action: 'store.schedule_updated',
      entityType: 'store',
      entityId: tienda.id,
      actorId: userId,
      after: { modo: datos.modo, franjas: datos.franjas.length },
    });

    return this.miHorario(userId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEGUIDORES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Seguir o dejar de seguir. Idempotente en los dos sentidos.
   *
   * ─── El contador se mueve en la MISMA transacción que la fila ───
   *
   * Y eso, junto con la restricción única de `Follow`, es lo que lo hace
   * confiable. Si dos peticiones concurrentes intentaran seguir al mismo
   * vendedor, la segunda choca contra el índice único y **su transacción entera
   * se deshace**, incremento incluido.
   *
   * Sin la restricción habría que elegir entre contar con un `COUNT(*)` en cada
   * lectura —caro en un feed que muestra veinte vendedores— o vivir con un
   * contador que se despega de la realidad sin que nadie sepa cuál miente.
   */
  async seguir(userId: string, sellerId: string): Promise<{ siguiendo: boolean; seguidores: number }> {
    const vendedor = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      select: { id: true, userId: true },
    });
    if (!vendedor) throw new NoEncontradoError('el vendedor');

    /**
     * Nadie se sigue a sí mismo.
     *
     * No es sólo raro: el número de seguidores es una señal de confianza, y
     * dejar que se auto-incremente la degrada. Con esto, el 1 que ve un
     * comprador es siempre otra persona.
     */
    if (vendedor.userId === userId) {
      throw new AccionInvalidaError('No podés seguirte a vos mismo');
    }

    try {
      const [, actualizado] = await this.prisma.$transaction([
        this.prisma.follow.create({
          data: { id: newId('flw'), userId, sellerId },
        }),
        this.prisma.seller.update({
          where: { id: sellerId },
          data: { followersCount: { increment: 1 } },
          select: { followersCount: true },
        }),
      ]);

      return { siguiendo: true, seguidores: actualizado.followersCount };
    } catch (err) {
      // P2002: ya lo seguía. Es idempotente, no un error.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const s = await this.prisma.seller.findUnique({
          where: { id: sellerId },
          select: { followersCount: true },
        });
        return { siguiendo: true, seguidores: s?.followersCount ?? 0 };
      }
      throw err;
    }
  }

  async dejarDeSeguir(userId: string, sellerId: string) {
    /**
     * El decremento va condicionado a que el borrado haya afectado una fila.
     *
     * Sin eso, tocar "dejar de seguir" dos veces restaría dos y el contador
     * quedaría por debajo de los seguidores reales — y el CHECK de la base
     * terminaría rechazando la escritura cuando llegara a cero, que es un error
     * confuso lejos de su causa.
     */
    const { count } = await this.prisma.follow.deleteMany({ where: { userId, sellerId } });

    if (count === 0) {
      const s = await this.prisma.seller.findUnique({
        where: { id: sellerId },
        select: { followersCount: true },
      });
      return { siguiendo: false, seguidores: s?.followersCount ?? 0 };
    }

    const actualizado = await this.prisma.seller.update({
      where: { id: sellerId },
      data: { followersCount: { decrement: 1 } },
      select: { followersCount: true },
    });

    return { siguiendo: false, seguidores: actualizado.followersCount };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESEÑAS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Deja una reseña.
   *
   * ─── Sólo se puede reseñar lo que se compró ───
   *
   * Las tres condiciones van en el `where` de la consulta, no en `if`
   * separados: la orden tiene que ser de quien reseña, del vendedor que
   * reseña, y estar en un estado que signifique que la compra se concretó.
   *
   * Una orden que no cumple las tres simplemente no se encuentra, y el 404 sale
   * solo. No hay forma de escribir mal la comprobación porque no hay
   * comprobación.
   */
  async resenar(
    userId: string,
    orderId: string,
    datos: { rating: number; comment?: string },
  ) {
    const orden = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        buyerId: userId,
        // Sólo compras concretadas. Una orden vencida sin pagar no da derecho
        // a opinar sobre el vendedor.
        status: { in: ['CONFIRMED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'] },
      },
      select: { id: true, sellerId: true, seller: { select: { userId: true } } },
    });

    if (!orden) {
      throw new NoEncontradoError('una compra tuya que se pueda reseñar');
    }

    // Nadie se reseña a sí mismo, ni comprándose a sí mismo.
    if (orden.seller.userId === userId) {
      throw new AccionInvalidaError('No podés reseñar tu propia tienda');
    }

    try {
      const [resena] = await this.prisma.$transaction([
        this.prisma.review.create({
          data: {
            id: newId('rev'),
            orderId: orden.id,
            sellerId: orden.sellerId,
            authorId: userId,
            rating: datos.rating,
            comment: datos.comment?.trim() || null,
          },
        }),
        this.prisma.seller.update({
          where: { id: orden.sellerId },
          data: {
            ratingSum: { increment: datos.rating },
            ratingCount: { increment: 1 },
          },
        }),
      ]);

      return {
        id: resena.id,
        rating: resena.rating,
        comentario: resena.comment,
        fecha: resena.createdAt,
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AccionInvalidaError('Ya reseñaste esta compra');
      }
      throw err;
    }
  }

  /** Las reseñas de un vendedor. */
  async resenasDe(sellerId: string, dto: { cursor?: string; limit: number }) {
    const filas = await this.prisma.review.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
      include: { author: { select: { firstName: true, lastName: true } } },
    });

    const hayMas = filas.length > dto.limit;
    const pagina = hayMas ? filas.slice(0, dto.limit) : filas;

    return {
      items: pagina.map((r) => ({
        id: r.id,
        rating: r.rating,
        comentario: r.comment,
        // Nombre e inicial: el apellido completo de un comprador no tiene por
        // qué quedar público en el perfil de una tienda.
        autor: `${r.author.firstName} ${r.author.lastName.charAt(0)}.`.trim(),
        fecha: r.createdAt,
      })),
      siguienteCursor: hayMas ? (pagina[pagina.length - 1]?.id ?? null) : null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PERFIL PÚBLICO
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Todo lo que un comprador necesita para decidir.
   *
   * ─── Las dos insignias no son la misma ───
   *
   *   **Identidad verificada** — sabemos quién es. Un hecho comprobable.
   *   **Vendedor confiable**   — tiene historial. Una reputación.
   *
   * Se devuelven por separado y la app las muestra distinto. Alguien con DNI
   * verificado puede estafar; alguien sin verificar puede llevar dos años
   * vendiendo bien. Mezclarlas en un solo sello engañaría en los dos sentidos.
   *
   * ─── No se inventan números ───
   *
   * Un vendedor sin ventas muestra 0 y "sin reseñas todavía". No hay valores
   * por defecto que aparenten actividad: un perfil nuevo que dice "4,8 ⭐" es
   * mentira, y quien compre por ese número y tenga una mala experiencia no
   * vuelve.
   */
  async perfilPublico(sellerId: string, userId?: string) {
    const vendedor = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      include: {
        stores: { where: { isPrimary: true }, take: 1 },
      },
    });

    if (!vendedor || vendedor.status === 'BLOCKED') {
      // Un vendedor bloqueado por fraude no tiene perfil público.
      throw new NoEncontradoError('el vendedor');
    }

    const tienda = vendedor.stores[0];

    const [ventas, siguiendo, estadoTienda, liveActivo] = await Promise.all([
      this.prisma.order.count({
        where: {
          sellerId,
          status: { in: ['CONFIRMED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'] },
        },
      }),
      userId
        ? this.prisma.follow.findUnique({
            where: { userId_sellerId: { userId, sellerId } },
            select: { id: true },
          })
        : Promise.resolve(null),
      tienda ? this.estadoDeTienda(tienda.id) : Promise.resolve(null),
      this.prisma.liveSession.findFirst({
        where: { sellerId, state: { in: ['LIVE', 'RECONNECTING'] } },
        select: { id: true, title: true },
      }),
    ]);

    /**
     * "Vendedor confiable" exige las tres cosas juntas.
     *
     * Identidad verificada, riesgo bajo y ventas concretadas. Cualquiera de las
     * tres por separado se puede conseguir sin ser confiable: alguien puede
     * verificar su DNI el primer día, y alguien puede tener riesgo bajo sin
     * haber vendido nunca.
     */
    const confiable =
      vendedor.verificationStatus === 'VERIFIED' && vendedor.riskLevel === 'LOW' && ventas >= 10;

    return {
      id: vendedor.id,
      nombre: vendedor.displayName,
      slug: vendedor.slug,
      bio: vendedor.bio,
      avatarUrl: vendedor.avatarUrl,
      coverUrl: vendedor.coverUrl,
      desdeEl: vendedor.createdAt,

      // Las dos insignias, separadas.
      identidadVerificada: vendedor.verificationStatus === 'VERIFIED',
      vendedorConfiable: confiable,

      seguidores: vendedor.followersCount,
      // `null` y no 0: "sin reseñas" es distinto de "promedio cero".
      rating:
        vendedor.ratingCount > 0
          ? Math.round((vendedor.ratingSum / vendedor.ratingCount) * 10) / 10
          : null,
      resenas: vendedor.ratingCount,
      ventas,

      /** `undefined` si no hay sesión: la app no muestra el botón. */
      loSigo: userId ? siguiendo !== null : undefined,

      tienda: tienda
        ? { id: tienda.id, nombre: tienda.name, slug: tienda.slug, estado: tienda.status }
        : null,
      horario: estadoTienda,
      enVivo: liveActivo ? { id: liveActivo.id, titulo: liveActivo.title } : null,
    };
  }

  /**
   * El catálogo de una tienda, paginado.
   *
   * Lo consume el panel de tienda que se abre sobre el vivo. Paginado desde el
   * principio: un vendedor con trescientos productos no puede mandarlos todos
   * en una respuesta mientras el video sigue corriendo atrás.
   */
  async catalogo(storeId: string, dto: { cursor?: string; limit: number; q?: string }) {
    const productos = await this.prisma.product.findMany({
      where: {
        storeId,
        status: 'ACTIVE',
        deletedAt: null,
        ...(dto.q ? { name: { contains: dto.q, mode: 'insensitive' } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
      include: {
        images: { where: { position: 0 }, take: 1 },
        variants: {
          where: { deletedAt: null, status: 'ACTIVE' },
          include: { inventory: true },
        },
      },
    });

    const hayMas = productos.length > dto.limit;
    const pagina = hayMas ? productos.slice(0, dto.limit) : productos;

    return {
      items: pagina.map((p) => {
        const disponible = p.variants.reduce(
          (t, v) => t + (v.inventory ? v.inventory.onHand - v.inventory.reserved : 0),
          0,
        );

        return {
          id: p.id,
          nombre: p.name,
          imagenUrl: p.images[0]?.url ?? null,
          precioCentavos: p.basePriceCents,
          moneda: p.currency,
          /** Suma de todas las variantes: es lo que decide si se muestra "agotado". */
          disponible,
          variantes: p.variants.length,
        };
      }),
      siguienteCursor: hayMas ? (pagina[pagina.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Un producto con sus opciones, variantes y stock, **para quien compra**.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * POR QUÉ NO ALCANZABA CON `GET /products/:id`
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Ese endpoint es del VENDEDOR: resuelve el producto por dueño y le contesta
   * `SELLER_NOT_FOUND` a cualquiera que no tenga tienda. La app lo estaba
   * usando para el selector de talles, así que un comprador real nunca podía
   * elegir una variante — se encontraba con un panel vacío y precio $0,00.
   *
   * No se detectó antes porque el cliente HTTP no lanza con 4xx
   * (`validateStatus: s < 500`, para poder reintentar tras refrescar el token)
   * y el modelo de Flutter lee todo a la defensiva: el cuerpo del error se
   * parseó como un producto sin nombre, sin precio y sin variantes.
   *
   * ─── Qué sale y qué no ───
   *
   * Sale `disponible` ya calculado. **No salen `onHand` ni `reserved`**: son
   * números internos del vendedor —cuánto tiene, cuánto está apartado— y a
   * quien compra sólo le importa si puede llevarlo. Además vale la regla de
   * siempre: la app no calcula disponibilidad, la recibe.
   *
   * Sólo productos y variantes ACTIVE y no borrados. Un producto pausado no se
   * puede comprar, y devolverlo sería ofrecer algo que la reserva va a
   * rechazar.
   */
  async detalleParaComprar(productId: string) {
    const producto = await this.prisma.product.findFirst({
      where: { id: productId, status: 'ACTIVE', deletedAt: null },
      include: {
        images: { orderBy: { position: 'asc' } },
        options: {
          orderBy: { position: 'asc' },
          include: { values: { orderBy: { position: 'asc' } } },
        },
        variants: {
          where: { deletedAt: null, status: 'ACTIVE' },
          include: { inventory: true, options: true },
        },
      },
    });

    // Pausado, borrado o inexistente dan lo mismo hacia afuera: 404. Distinguir
    // "existe pero está pausado" le confirmaría a cualquiera qué ids son reales.
    if (!producto) throw new NoEncontradoError('el producto');

    return {
      id: producto.id,
      nombre: producto.name,
      descripcion: producto.description,
      precioCentavos: producto.basePriceCents,
      moneda: producto.currency,
      imagenes: producto.images.map((i) => i.url),
      ejes: producto.options.map((o) => ({
        id: o.id,
        nombre: o.name,
        valores: o.values.map((v) => ({ id: v.id, valor: v.value })),
      })),
      variantes: producto.variants.map((v) => ({
        id: v.id,
        titulo: v.title,
        precioCentavos: v.priceOverrideCents ?? producto.basePriceCents,
        disponible: v.inventory ? v.inventory.onHand - v.inventory.reserved : 0,
        valoresDeOpcion: v.options.map((o) => o.optionValueId),
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTENCIÓN DE COMPRA
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Deja una intención cuando la tienda está cerrada.
   *
   * ⚠️ **No descuenta stock.** Una reserva real dura cinco minutos porque
   * bloquea una unidad: mientras existe, nadie más puede comprarla. Bloquear
   * stock durante las diez horas que una tienda está cerrada sacaría productos
   * de la venta para gente que quizás no vuelva, y con varias intenciones sobre
   * lo mismo dejaría el catálogo vacío sin haber vendido nada.
   *
   * Esto es una lista de espera. No promete nada.
   */
  async dejarIntencion(userId: string, variantId: string, cantidad: number) {
    const variante = await this.prisma.productVariant.findFirst({
      where: { id: variantId, deletedAt: null, product: { deletedAt: null } },
      select: { id: true },
    });
    if (!variante) throw new NoEncontradoError('el producto');

    const intencion = await this.prisma.purchaseIntent.upsert({
      where: { userId_productVariantId: { userId, productVariantId: variantId } },
      create: {
        id: newId('pin'),
        userId,
        productVariantId: variantId,
        quantity: cantidad,
      },
      // Tocar el botón dos veces actualiza la cantidad, no crea otra.
      update: { quantity: cantidad, notifiedAt: null },
    });

    return {
      ok: true as const,
      id: intencion.id,
      mensaje: 'Te avisamos cuando la tienda vuelva a abrir.',
    };
  }

  async quitarIntencion(userId: string, variantId: string) {
    await this.prisma.purchaseIntent.deleteMany({
      where: { userId, productVariantId: variantId },
    });
    return { ok: true as const };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // INTERESADOS: EL LADO DEL VENDEDOR
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Quién está esperando para comprar, agrupado por producto.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * SIN DATOS DE CONTACTO. A PROPÓSITO.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Devuelve cuántas personas y cuántas unidades, con nombre de pila. **No
   * devuelve teléfono, ni email, ni apellido completo.**
   *
   * Quien dejó una intención pidió que le avisen cuando la tienda abra. No le
   * dio su teléfono a un vendedor para que lo contacte por WhatsApp — y si lo
   * expusiéramos, eso es exactamente lo que pasaría el primer día. El aviso lo
   * manda VendoX.
   *
   * Lo que el vendedor necesita para decidir es el número: "hay once personas
   * esperando el talle M". Eso sí está, y es lo que le sirve para reponer.
   */
  async interesados(userId: string) {
    const tienda = await this.tiendaDe(userId);

    const intenciones = await this.prisma.purchaseIntent.findMany({
      // La pertenencia va en el WHERE. Un producto de otra tienda no aparece
      // ni aunque alguien conozca su id.
      where: {
        variant: {
          deletedAt: null,
          product: { storeId: tienda.id, deletedAt: null },
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        quantity: true,
        notifiedAt: true,
        createdAt: true,
        user: { select: { id: true, firstName: true } },
        variant: {
          select: {
            id: true,
            title: true,
            options: { select: { optionValueId: true } },
            inventory: { select: { onHand: true, reserved: true } },
            product: {
              select: {
                id: true,
                name: true,
                status: true,
                images: { orderBy: { position: 'asc' }, take: 1, select: { url: true } },
              },
            },
          },
        },
      },
    });

    /**
     * Se agrupa por producto y no por variante.
     *
     * El vendedor piensa en "el buzo verde", no en once filas de talles. Las
     * variantes van adentro, que es donde la información sirve para reponer.
     */
    const porProducto = new Map<
      string,
      {
        productoId: string;
        nombre: string;
        imagen: string | null;
        publicado: boolean;
        personas: number;
        unidades: number;
        variantes: Map<
          string,
          { varianteId: string; etiqueta: string | null; personas: number; unidades: number; disponible: number }
        >;
        gente: Array<{ nombre: string; cantidad: number; desde: Date; avisado: boolean }>;
      }
    >();

    for (const i of intenciones) {
      const producto = i.variant.product;

      let fila = porProducto.get(producto.id);
      if (!fila) {
        fila = {
          productoId: producto.id,
          nombre: producto.name,
          imagen: producto.images[0]?.url ?? null,
          publicado: producto.status === 'ACTIVE',
          personas: 0,
          unidades: 0,
          variantes: new Map(),
          gente: [],
        };
        porProducto.set(producto.id, fila);
      }

      fila.personas += 1;
      fila.unidades += i.quantity;
      fila.gente.push({
        // Nombre de pila solo. Ver el comentario de arriba.
        nombre: i.user.firstName,
        cantidad: i.quantity,
        desde: i.createdAt,
        avisado: i.notifiedAt !== null,
      });

      const clave = i.variant.id;
      const variante = fila.variantes.get(clave) ?? {
        varianteId: i.variant.id,
        // La variante interna no tiene ejes: para el vendedor es "el producto",
        // no una opción con nombre. Ver `variantePublica`.
        etiqueta: i.variant.options.length === 0 ? null : i.variant.title,
        personas: 0,
        unidades: 0,
        disponible: i.variant.inventory
          ? i.variant.inventory.onHand - i.variant.inventory.reserved
          : 0,
      };
      variante.personas += 1;
      variante.unidades += i.quantity;
      fila.variantes.set(clave, variante);
    }

    const items = [...porProducto.values()]
      .map((p) => ({
        ...p,
        variantes: [...p.variantes.values()].sort((a, b) => b.personas - a.personas),
      }))
      .sort((a, b) => b.personas - a.personas);

    return {
      items,
      totalPersonas: new Set(intenciones.map((i) => i.user.id)).size,
      totalUnidades: intenciones.reduce((suma, i) => suma + i.quantity, 0),
      /**
       * Sin stock para cubrir lo que la gente está esperando.
       *
       * Es el número que hace útil esta pantalla: no "hay interesados" sino
       * "hay interesados y no tenés qué venderles".
       */
      sinStock: [...porProducto.values()].filter((p) =>
        [...p.variantes.values()].some((v) => v.disponible < v.unidades),
      ).length,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REAPERTURA
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Avisa a quien dejó una intención en esta tienda.
   *
   * Devuelve cuántos avisos se crearon. Público para que el barrido de
   * reaperturas y los tests lo llamen sin depender del reloj.
   *
   * ─── Por qué se marcan las intenciones ANTES de crear los avisos ───
   *
   * Al revés, un fallo entre las dos escrituras dejaría avisos creados con las
   * intenciones sin marcar, y el siguiente barrido volvería a avisarle a la
   * misma gente. La deduplicación por clave lo frenaría igual, pero apoyarse en
   * dos defensas cuando el orden correcto es gratis es apoyarse en la de
   * repuesto.
   */
  async avisarInteresados(storeId: string, momento: Date): Promise<number> {
    const intenciones = await this.prisma.purchaseIntent.findMany({
      where: {
        notifiedAt: null,
        variant: {
          deletedAt: null,
          product: {
            storeId,
            deletedAt: null,
            // Un producto pausado o en borrador no genera aviso: sería mandar a
            // alguien a una pantalla donde no puede comprar.
            status: 'ACTIVE',
          },
        },
      },
      select: {
        id: true,
        userId: true,
        variant: {
          select: {
            id: true,
            product: { select: { id: true, name: true, store: { select: { name: true } } } },
          },
        },
      },
    });

    if (intenciones.length === 0) return 0;

    await this.prisma.purchaseIntent.updateMany({
      where: { id: { in: intenciones.map((i) => i.id) } },
      data: { notifiedAt: momento },
    });

    const marca = momento.toISOString();

    return this.notifications.crearVarios(
      intenciones.map((i) => ({
        userId: i.userId,
        type: 'STORE_REOPENED' as const,
        title: `${i.variant.product.store.name} volvió a abrir`,
        // El nombre del producto va en el cuerpo y no en el título: el título
        // lo trunca la barra de notificaciones del teléfono, y lo que hace que
        // alguien lo abra es reconocer la tienda.
        body: `Ya podés comprar ${i.variant.product.name}.`,
        data: {
          tipo: 'product',
          productId: i.variant.product.id,
          variantId: i.variant.id,
          storeId,
        },
        /**
         * La marca de la reapertura es lo que hace única la clave.
         *
         * Dos barridos simultáneos sobre la misma reapertura escriben lo mismo
         * y el índice único deja pasar uno solo. La reapertura de mañana lleva
         * otra marca y sí manda un aviso nuevo.
         */
        dedupeKey: `store_reopened:${storeId}:${i.userId}:${marca}`,
      })),
    );
  }

  /**
   * Detecta qué tiendas acaban de abrir y avisa.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * "REABRIR" NO ES UN EVENTO: ES UNA TRANSICIÓN QUE HAY QUE BUSCAR
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Que una tienda esté abierta se calcula con el horario y la hora actual.
   * Nadie aprieta un botón a las nueve de la mañana, así que no hay ningún
   * momento en el que el sistema se entere solo.
   *
   * Este barrido recorre las tiendas con horario configurado, calcula el estado
   * y lo compara con `wasOpen`. Cuando pasa de cerrada a abierta, ese es el
   * instante de la reapertura.
   *
   * ─── Sólo las que tienen horario ───
   *
   * Una tienda sin horario está siempre abierta y nunca reabre. Filtrarlas acá
   * evita recorrer el catálogo entero cada treinta segundos.
   */
  async barrerReaperturas(ahora = new Date()): Promise<{ reabiertas: number; avisos: number }> {
    const horarios = await this.prisma.storeSchedule.findMany({
      where: { store: { status: 'ACTIVE', seller: { status: 'ACTIVE' } } },
      include: { slots: true },
    });

    let reabiertas = 0;
    let avisos = 0;

    for (const horario of horarios) {
      const hayLive = await this.prisma.liveSession.count({
        where: { storeId: horario.storeId, state: { in: ['LIVE', 'RECONNECTING'] } },
      });

      const estado = estaAbierta({
        modo: horario.mode,
        zona: horario.timezone,
        franjas: horario.slots.map(
          (s): Franja => ({
            weekday: s.weekday,
            opensAtMinutes: s.opensAtMinutes,
            closesAtMinutes: s.closesAtMinutes,
          }),
        ),
        hayLive: hayLive > 0,
        ahora,
      });

      if (estado.abierta === horario.wasOpen) continue;

      /**
       * El UPDATE condicional es lo que hace que dos worker no avisen dos veces.
       *
       * La condición y la escritura son la misma operación: sólo uno puede
       * cambiar la fila de `wasOpen: false` a `true`, y el que pierde ve
       * `count: 0` y no avisa. Un `if` antes del `update` no da esa garantía.
       */
      const { count } = await this.prisma.storeSchedule.updateMany({
        where: { id: horario.id, wasOpen: horario.wasOpen },
        data: {
          wasOpen: estado.abierta,
          ...(estado.abierta ? { lastReopenedAt: ahora } : {}),
        },
      });
      if (count === 0) continue;

      // Sólo al abrir. Cerrar no le interesa a nadie.
      if (!estado.abierta) continue;

      reabiertas += 1;
      avisos += await this.avisarInteresados(horario.storeId, ahora);
    }

    return { reabiertas, avisos };
  }

  private async tiendaDe(userId: string) {
    const tienda = await this.prisma.store.findFirst({
      where: { seller: { userId }, isPrimary: true },
    });
    if (!tienda) throw new NoEncontradoError('tu tienda');
    return tienda;
  }
}
