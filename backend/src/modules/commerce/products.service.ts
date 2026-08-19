import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { env } from '@/config/env.schema';
import { AuditService } from '@/shared/audit/audit.service';
import { conUrls } from '@/shared/storage/url-publica';
import { exigirHabilitada } from '@/shared/config/banderas';
import { DomainError } from '@/shared/errors/domain.error';
import { DomainEvent, DomainEventBus } from '@/shared/events/domain-events';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';
import { esComparativoValido } from '@/shared/utils/money';
import { slugDisponible } from '@/shared/utils/slug';

import type {
  CreateProductDto,
  CreateVariantDto,
  DiscoverQueryDto,
  DefinirOpcionesDto,
  PageQueryDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/commerce.dto';
import { categoriaResultante, exigirCategoriaParaPublicar } from './categorias';
import { CategoriasService } from './categorias.service';
import { OwnershipService } from './ownership.service';
import { intercalarPromocionados } from './promociones';
import { PromocionesService } from './promociones.service';
import { ordenarPorPuntaje } from './ranking';
import { SearchService } from './search.service';
import { SellerOAuthService } from '@/modules/payments/seller-oauth.service';
import { LimiteDeCatalogo } from '@/modules/sellers/limite-de-catalogo';

import { PRODUCTO_COMPRABLE, PRODUCTO_VISIBLE } from './visibilidad';
import {
  calcularOptionsKey,
  generarCombinaciones,
  KEY_DEFAULT,

  tituloDeVariante,
  validarCombinacion,
  type OpcionConValores,
} from './variants';

/**
 * Productos y variantes.
 *
 * ─── La regla que ordena todo el módulo ───
 *
 * **Todo producto tiene al menos una variante.** Uno "sin variantes" recibe
 * una `DEFAULT` automática.
 *
 * Sin esa regla habría dos arquitecturas de inventario conviviendo —stock de
 * producto y stock de variante— y cada consulta de stock tendría que preguntar
 * antes cuál de las dos aplica. Con la variante por defecto, Inventory apunta
 * siempre a `productVariantId` y no existe la pregunta.
 *
 * ─── Ninguna consulta busca sólo por id ───
 *
 * La pertenencia se resuelve en `OwnershipService` y va dentro del WHERE. Ver
 * la explicación ahí: es lo que hace que un IDOR no sea un chequeo olvidable.
 */

export class InvalidPriceError extends DomainError {
  constructor(motivo: string) {
    super('INVALID_PRICE', motivo);
  }
}

export class SkuTakenError extends DomainError {
  constructor(sku: string) {
    super('SKU_TAKEN', 'Ya usaste ese código en otro producto', { sku });
  }
}

export class VariantCombinationExistsError extends DomainError {
  constructor(title: string) {
    super('VARIANT_COMBINATION_EXISTS', `La combinación "${title}" ya existe`, { title });
  }
}

/**
 * Disponibilidad pública de una variante, para el feed.
 *
 * Vive acá y no en `InventoryService` para no crear una dependencia de
 * `CommerceModule` hacia `InventoryModule` — la flecha va al revés, y darla
 * vuelta crearía un ciclo entre módulos. Son cuatro líneas de aritmética; la
 * regla completa, con su explicación, está en `inventory/reservations.ts`.
 */
function vistaPublicaDeStock(
  inv: { onHand: number; reserved: number; lowStockThreshold: number | null } | null,
): { availability: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK'; remaining: number | null } {
  // Sin fila de inventario, la respuesta segura es "agotado": es preferible no
  // vender a ofrecer algo cuya existencia no consta.
  if (!inv) return { availability: 'OUT_OF_STOCK', remaining: null };

  const disponible = inv.onHand - inv.reserved;
  const umbral = inv.lowStockThreshold ?? env.INVENTORY_LOW_STOCK_THRESHOLD;

  if (disponible <= 0) return { availability: 'OUT_OF_STOCK', remaining: null };
  // El número sólo sale cuando quedan pocas: "Últimas 3" ayuda a decidir y no
  // revela volumen de ventas.
  if (disponible <= umbral) return { availability: 'LOW_STOCK', remaining: disponible };
  return { availability: 'IN_STOCK', remaining: null };
}

/** Campos que salen al cliente. Enumerados, no filtrados. */
const PRODUCT_SELECT = {
  id: true,
  storeId: true,
  categoryId: true,
  name: true,
  slug: true,
  description: true,
  status: true,
  currency: true,
  basePriceCents: true,
  compareAtPriceCents: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

/**
 * Lo que trae cada tarjeta del feed.
 *
 * Extraído a una constante porque lo usan DOS consultas: la página orgánica y
 * la de los productos promocionados. Con el bloque repetido, agregar un campo
 * en una y olvidarlo en la otra deja tarjetas promocionadas sin foto —y el
 * error se ve recién en producción, en la posición que alguien pagó.
 */
const FEED_SELECT = {
  ...PRODUCT_SELECT,
  likesCount: true,
  createdAt: true,
  images: { orderBy: { position: 'asc' }, take: 1, select: { id: true, storageKey: true, position: true } },
  // Un solo join en vez de una consulta por producto. Con 20 productos
  // por página, el N+1 serían 41 viajes a la base para armar un scroll.
  store: {
    select: {
      id: true,
      name: true,
      slug: true,
      logoUrl: true,
      seller: {
        select: { id: true, displayName: true, slug: true, avatarUrl: true, verificationStatus: true },
      },
    },
  },
  /**
   * Las variantes vendibles, con su inventario.
   *
   * Van en el feed —y no en una segunda consulta al tocar "Comprar"—
   * porque el botón tiene que poder apartar stock de UNA. Pedirlas
   * después agregaría un viaje justo en el momento en que la persona ya
   * decidió comprar, que es el peor momento para hacerla esperar.
   *
   * Se limitan a 10: alcanzan para saber si hay algo que apartar y para
   * el caso simple de una sola variante. El detalle completo de un
   * producto con muchas combinaciones se resuelve en su propia pantalla.
   */
  variants: {
    where: { deletedAt: null, status: 'ACTIVE' },
    orderBy: { position: 'asc' },
    take: 10,
    select: {
      id: true,
      title: true,
      priceOverrideCents: true,
      isDefault: true,
      inventory: { select: { onHand: true, reserved: true, lowStockThreshold: true } },
    },
  },
  _count: { select: { variants: { where: { deletedAt: null, status: 'ACTIVE' } } } },
} satisfies Prisma.ProductSelect;

/**
 * Tope de combinaciones por producto.
 *
 * No es una limitación técnica: es que un producto con más de cien variantes
 * es casi siempre un error de carga —alguien puso los valores en el eje
 * equivocado— y generar mil filas de inventario por accidente es peor que
 * frenarlo con un mensaje claro.
 */
const MAX_VARIANTES = 100;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly search: SearchService,
    private readonly sellerOAuth: SellerOAuthService,
    private readonly categorias: CategoriasService,
    private readonly promociones: PromocionesService,
    private readonly limiteDeCatalogo: LimiteDeCatalogo,
  ) {}

  /**
   * Crea un producto con sus opciones y todas sus variantes.
   *
   * Todo en una transacción: un producto a medias —con opciones pero sin
   * variantes, o con la mitad de las combinaciones— sería inconsistente y no
   * habría forma de saber cuál falta.
   */
  /**
   * Crea un producto.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * `idempotencyKey` — LA MISMA ALTA DOS VECES ES UNA SOLA ALTA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * La app manda una clave por sesión de editor. Si la respuesta se pierde y el
   * teléfono reintenta, la segunda petición trae la misma clave y acá se
   * devuelve el producto que ya se creó, en vez de crear otro.
   *
   * Es la única defensa contra el caso real: la petición LLEGÓ y lo que se
   * perdió fue la respuesta. Para el teléfono eso es indistinguible de «no
   * llegó», así que reintenta — y con razón.
   *
   * ─── Se devuelve el producto viejo, sin comparar el contenido ───
   *
   * `inventory.service.ts` sí compara una huella de la petición y falla si la
   * clave se reusó con otros datos. Acá no, y la diferencia es a propósito: una
   * reserva mal replicada le aparta stock equivocado a alguien —es plata—,
   * mientras que un alta replicada devuelve el producto que efectivamente se
   * creó.
   *
   * Si el vendedor había cambiado algo entre el envío perdido y el reintento,
   * la app adopta el id que vuelve y el próximo guardado es un `PATCH` que
   * aplica esos cambios. Converge, y no se pierde nada.
   */
  async create(userId: string, dto: CreateProductDto, idempotencyKey?: string) {
    /**
     * Interruptor de emergencia.
     *
     * La misma bandera cubre crear el producto y subirle fotos: «cargar un
     * producto» es una sola operación para quien la hace, y dejar crear la
     * ficha con las imágenes apagadas produce catálogos de productos sin foto
     * que después nadie completa.
     *
     * No toca los productos que ya existen: se siguen editando, pausando y
     * vendiendo.
     */
    exigirHabilitada('PRODUCT_UPLOAD_ENABLED');

    const { store } = await this.ownership.primaryStoreOf(userId, { requireActive: true });

    /**
     * La repetición se contesta ANTES de validar nada.
     *
     * Un reintento no tiene por qué volver a pasar por el interruptor de
     * emergencia, ni por el bloqueo de Mercado Pago, ni por el tope del plan.
     * Todo eso ya se evaluó cuando el producto se creó de verdad; volver a
     * exigirlo haría que el mismo reintento fallara por una regla que cambió
     * en el medio —el vendedor llegó al tope justamente porque este producto
     * ya existe—.
     */
    if (idempotencyKey) {
      const yaCreado = await this.prisma.product.findFirst({
        where: { storeId: store.id, idempotencyKey },
        select: { id: true },
      });
      if (yaCreado) return this.detail(userId, yaCreado.id);
    }

    /**
     * Sin Mercado Pago conectado se puede crear el BORRADOR, no publicarlo.
     *
     * La diferencia importa: alguien que se sienta una tarde a cargar cuarenta
     * productos no se topa con el bloqueo hasta el final, cuando ya tiene todo
     * hecho y le queda un solo paso. Frenarlo al primero sería mandarlo a
     * conectar una cuenta antes de saber si le sirve la app.
     */
    if (dto.status === 'ACTIVE') {
      await this.sellerOAuth.exigirParaVender(store.sellerId, 'publicar');
    }

    // La categoría se exige al publicar, no al crear el borrador: mismo
    // criterio que Mercado Pago, por el mismo motivo. Ver `categorias.ts`.
    exigirCategoriaParaPublicar({ estadoDestino: dto.status, categoriaId: dto.categoryId });
    if (dto.categoryId) await this.categorias.exigirQueExista(dto.categoryId);

    if (!esComparativoValido(dto.basePriceCents, dto.compareAtPriceCents)) {
      throw new InvalidPriceError('El precio tachado tiene que ser mayor que el de venta');
    }

    const slug = dto.slug
      ? await this.slugLibreOFalla(store.id, dto.slug)
      : await slugDisponible(dto.name, (s) => this.slugLibre(store.id, s));

    const productId = newId('prd');

    try {
      await this.prisma.$transaction(async (tx) => {
        /**
         * El límite de catálogo, DENTRO de la transacción.
         *
         * Tiene que estar acá y no antes: el guardián toma un cerrojo por
         * vendedor que se suelta al cerrar la transacción. Comprobarlo afuera
         * dejaría el hueco entre la comprobación y la escritura, que es
         * exactamente lo que dos toques rápidos aprovechan.
         */
        if (dto.status === 'ACTIVE') {
          await this.limiteDeCatalogo.exigirPoderPublicar(tx, store.sellerId);
        }

        await tx.product.create({
          data: {
            id: productId,
            storeId: store.id,
            name: dto.name,
            slug,
            description: dto.description ?? null,
            basePriceCents: dto.basePriceCents,
            compareAtPriceCents: dto.compareAtPriceCents ?? null,
            categoryId: dto.categoryId ?? null,
            status: dto.status,
            idempotencyKey: idempotencyKey ?? null,
          },
        });

        // Opciones y sus valores.
        const opciones: OpcionConValores[] = [];
        for (const [i, opt] of dto.options.entries()) {
          const optionId = newId('opt');
          await tx.productOption.create({
            data: { id: optionId, productId, name: opt.name, position: i },
          });

          const values = opt.values.map((valor, j) => ({
            id: newId('opv'),
            optionId,
            value: valor,
            position: j,
          }));
          await tx.productOptionValue.createMany({ data: values });

          opciones.push({
            optionId,
            name: opt.name,
            position: i,
            values: values.map((v) => ({ id: v.id, value: v.value, position: v.position })),
          });
        }

        // Variantes. Sin opciones, `generarCombinaciones` devuelve exactamente
        // una: la DEFAULT.
        const combinaciones = generarCombinaciones(opciones);
        const variantIds: string[] = [];

        for (const [i, combo] of combinaciones.entries()) {
          const variantId = newId('var');
          variantIds.push(variantId);

          await tx.productVariant.create({
            data: {
              id: variantId,
              productId,
              storeId: store.id,
              title: combo.title,
              optionsKey: combo.optionsKey,
              isDefault: combo.optionsKey === KEY_DEFAULT,
              position: i,
            },
          });

          if (combo.optionValueIds.length > 0) {
            await tx.productVariantOption.createMany({
              data: combo.optionValueIds.map((optionValueId) => ({ variantId, optionValueId })),
            });
          }
        }

        /**
         * Inventario en cero para cada variante, en la MISMA transacción.
         *
         * El invariante que sostiene todo el módulo de stock es "toda variante
         * viva tiene exactamente una fila de inventario". Crearla acá —y no
         * bajo demanda al primer intento de compra— hace que el camino de la
         * venta, que es el más caliente del sistema, nunca tenga que escribir
         * para poder leer.
         *
         * Arrancan en 0 y no en un número inventado: un vendedor que ve 0 carga
         * su stock; uno que ve 10 vende diez cosas que no tiene.
         */
        await tx.inventory.createMany({
          data: variantIds.map((productVariantId) => ({
            id: newId('inv'),
            productVariantId,
          })),
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        /**
         * Dos peticiones con la MISMA clave, a la vez.
         *
         * El chequeo de arriba no alcanza para esto: las dos leyeron «no hay
         * nada» antes de que ninguna escribiera. Es el doble toque real, o dos
         * reintentos que salen juntos cuando vuelve la red.
         *
         * El índice único las ordena: una gana y la otra llega acá. Se relee y
         * se devuelve la que ganó, así las dos peticiones reciben el mismo
         * producto y no queda ninguna duda de cuál es.
         *
         * ⚠️ Se distingue POR EL CAMPO, no por el mensaje. Este mismo `P2002`
         * también lo tira el slug repetido, que es un error de verdad y tiene
         * que seguir llegándole al vendedor como «ya tenés un producto con ese
         * nombre».
         */
        /**
         * ⚠️ Se pregunta por la CLAVE, no por qué índice se quejó.
         *
         * La primera versión miraba `err.meta.target` para ver si el choque
         * había sido el de idempotencia. No funciona: cuando dos peticiones con
         * la misma clave salen juntas, las dos calculan el mismo slug, y el que
         * salta primero es el índice del SLUG. La perdedora recibía «ya tenés un
         * producto con ese nombre» por un producto que era el suyo.
         *
         * La pregunta correcta no es qué índice se quejó sino si, ahora mismo,
         * ya existe un producto con esta clave. Si existe, esta petición es la
         * repetición de aquélla y le corresponde la misma respuesta.
         */
        if (idempotencyKey) {
          const ganador = await this.prisma.product.findFirst({
            where: { storeId: store.id, idempotencyKey },
            select: { id: true },
          });
          if (ganador) return this.detail(userId, ganador.id);
        }

        throw new DomainError('SLUG_TAKEN', 'Ya tenés un producto con ese nombre', { slug });
      }
      throw err;
    }

    this.events.publish(DomainEvent.productCreated, {
      entityId: productId,
      actorId: userId,
      data: { storeId: store.id, status: dto.status },
    });
    await this.audit.log({
      action: 'product.created',
      entityType: 'product',
      entityId: productId,
      actorId: userId,
      after: { name: dto.name, slug, basePriceCents: dto.basePriceCents, status: dto.status },
    });

    return this.detail(userId, productId);
  }

  /** Detalle completo, sólo si es del usuario. */
  async detail(userId: string, productId: string) {
    const { product } = await this.ownership.productOf(userId, productId);
    return this.cargarDetalle(product.id);
  }

  async update(userId: string, productId: string, dto: UpdateProductDto) {
    const { product } = await this.ownership.productOf(userId, productId, { requireActive: true });

    /**
     * Sólo al PASAR a publicado.
     *
     * Un producto que ya está publicado se puede seguir editando aunque el
     * vendedor haya desconectado su cuenta: quitarle la posibilidad de
     * corregir un precio mal puesto sería castigarlo dos veces.
     */
    if (dto.status === 'ACTIVE' && product.status !== 'ACTIVE') {
      const tienda = await this.prisma.store.findUniqueOrThrow({
        where: { id: product.storeId },
        select: { sellerId: true },
      });
      await this.sellerOAuth.exigirParaVender(tienda.sellerId, 'publicar');
    }

    /**
     * La categoría, contra el estado que va a QUEDAR, no contra el que llega.
     *
     * Son dos casos distintos y los dos tienen que fallar:
     *
     *   · publicar un borrador sin categoría (`status: 'ACTIVE'`);
     *   · sacarle la categoría a un producto YA publicado
     *     (`categoryId: null` sin tocar el estado).
     *
     * El segundo es el que se escapa si uno mira sólo `dto.status`: dejaría un
     * producto activo fuera de toda navegación por rubro, y su dueño lo vería
     * publicado.
     */
    const categoriaFinal = categoriaResultante(product.categoryId, dto.categoryId);
    exigirCategoriaParaPublicar({
      estadoDestino: dto.status ?? product.status,
      categoriaId: categoriaFinal,
    });
    if (dto.categoryId) await this.categorias.exigirQueExista(dto.categoryId);

    const base = dto.basePriceCents ?? product.basePriceCents;
    const comparativo =
      dto.compareAtPriceCents !== undefined ? dto.compareAtPriceCents : product.compareAtPriceCents;
    if (!esComparativoValido(base, comparativo)) {
      throw new InvalidPriceError('El precio tachado tiene que ser mayor que el de venta');
    }

    /**
     * Publicar un borrador también cuenta contra el límite, y por el mismo
     * camino que crear uno ya publicado.
     *
     * Sin esto, el tope se saltea en dos pasos: crear como borrador —que es
     * libre— y después editar el estado. Es el camino que usa la propia app
     * cuando alguien arma la ficha y publica al final, así que no es un caso
     * rebuscado: es el más común de los dos.
     *
     * Va en una transacción sólo cuando hace falta comprobar. Un cambio de
     * precio no necesita cerrojo, y envolverlo igual serializaría ediciones que
     * no compiten por nada.
     */
    const pasaAPublicado = dto.status === 'ACTIVE' && product.status !== 'ACTIVE';

    const actualizado = pasaAPublicado
      ? await this.prisma.$transaction(async (tx) => {
          const tienda = await tx.store.findUniqueOrThrow({
            where: { id: product.storeId },
            select: { sellerId: true },
          });
          await this.limiteDeCatalogo.exigirPoderPublicar(tx, tienda.sellerId);
          return tx.product.update({
            where: { id: product.id },
            data: this.camposAActualizar(dto),
          });
        })
      : await this.prisma.product.update({
          where: { id: product.id },
          data: this.camposAActualizar(dto),
        });

    await this.audit.logDiff({
      action: 'product.updated',
      entityType: 'product',
      entityId: product.id,
      actorId: userId,
      before: { ...product },
      after: { ...actualizado },
    });

    // Evento específico según a qué estado fue: un suscriptor de búsqueda
    // necesita saber si tiene que indexar o desindexar, no sólo "cambió".
    if (pasaAPublicado) {
      this.events.publish(DomainEvent.productActivated, { entityId: product.id, actorId: userId });
    } else if (dto.status === 'ARCHIVED' && product.status !== 'ARCHIVED') {
      this.events.publish(DomainEvent.productArchived, { entityId: product.id, actorId: userId });
    } else {
      this.events.publish(DomainEvent.productUpdated, { entityId: product.id, actorId: userId });
    }

    return this.cargarDetalle(product.id);
  }

  /** Los campos que el DTO pidió cambiar. Uno solo para los dos caminos. */
  private camposAActualizar(dto: UpdateProductDto) {
    return {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.basePriceCents !== undefined ? { basePriceCents: dto.basePriceCents } : {}),
      ...(dto.compareAtPriceCents !== undefined
        ? { compareAtPriceCents: dto.compareAtPriceCents }
        : {}),
      ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    };
  }

  /**
   * Borrado lógico.
   *
   * Nunca se borra de verdad. Una orden futura tiene que poder seguir
   * apuntando al producto que se vendió: sin eso, el historial del comprador
   * muestra "producto eliminado" y la contabilidad del vendedor no cierra.
   *
   * Orders todavía no existe, y por eso hay que dejarlo bien ahora — después
   * ya hay datos y arreglarlo es una migración con riesgo.
   */
  async softDelete(userId: string, productId: string) {
    const { product } = await this.ownership.productOf(userId, productId, { requireActive: true });
    const ahora = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: product.id },
        data: { deletedAt: ahora, status: 'ARCHIVED' },
      });
      // Las variantes también: si quedaran activas, aparecerían en consultas
      // de inventario de un producto que ya no existe.
      await tx.productVariant.updateMany({
        where: { productId: product.id, deletedAt: null },
        data: { deletedAt: ahora },
      });
    });

    this.events.publish(DomainEvent.productDeleted, { entityId: product.id, actorId: userId });
    await this.audit.log({
      action: 'product.deleted',
      entityType: 'product',
      entityId: product.id,
      actorId: userId,
      before: { status: product.status, name: product.name },
    });

    return { ok: true as const };
  }

  /**
   * Listado del vendedor. Incluye borradores y pausados: es su panel.
   *
   * Paginación por cursor. Los ids son ULID, ordenables por tiempo, así que
   * `id < cursor ORDER BY id DESC` recorre el índice primario y cuesta lo
   * mismo en la página 1 que en la 500.
   */
  async listMine(userId: string, query: PageQueryDto) {
    const { seller, store } = await this.ownership.primaryStoreOf(userId);

    const filas = await this.prisma.product.findMany({
      where: {
        storeId: store.id,
        deletedAt: null,
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      select: {
        ...PRODUCT_SELECT,
        // `take: 1` evita el N+1: una consulta con join en vez de una por
        // producto para traer la portada.
        images: { where: { position: 0 }, take: 1, select: { id: true, storageKey: true, position: true } },
        _count: { select: { variants: { where: { deletedAt: null } } } },
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });

    const pagina = this.paginar(
      filas.map((f) => ({ ...f, images: conUrls(f.images) })),
      query.limit,
    );

    /**
     * El contador del plan viaja con el listado.
     *
     * La app tiene que poder decir «2 de 3 productos publicados» sin pedir otra
     * cosa: un segundo viaje para un número que se muestra arriba de la misma
     * lista deja la pantalla mostrando el estado de hace un rato, y el momento
     * en que ese número importa es justo después de publicar.
     *
     * ⚠️ Sale en TODAS las páginas y no sólo en la primera. Es del vendedor, no
     * de la página, y sacarlo de la segunda haría que el contador desapareciera
     * al desplazarse.
     */
    return { ...pagina, catalogo: await this.limiteDeCatalogo.estado(seller.id) };
  }

  /**
   * Vidriera pública de una tienda.
   *
   * Sólo productos `ACTIVE` y no borrados. Un borrador o un archivado no puede
   * aparecerle a un comprador — es la mitad de la razón por la que existen esos
   * estados.
   */
  async listPublicByStore(storeSlug: string, query: PageQueryDto) {
    const store = await this.prisma.store.findFirst({
      where: { slug: storeSlug, status: 'ACTIVE', seller: { status: 'ACTIVE' } },
      select: { id: true },
    });
    if (!store) throw new DomainError('STORE_NOT_FOUND', 'Tienda no encontrada');

    const filas = await this.prisma.product.findMany({
      where: {
        storeId: store.id,
        ...PRODUCTO_VISIBLE,
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      select: {
        ...PRODUCT_SELECT,
        images: { orderBy: { position: 'asc' }, take: 1, select: { id: true, storageKey: true, position: true } },
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });

    return this.paginar(
      filas.map((f) => ({ ...f, images: conUrls(f.images) })),
      query.limit,
    );
  }

  /**
   * Descubrimiento: lo que alimenta el feed.
   *
   * ─── Por qué existe separado de la vidriera ───
   *
   * `listPublicByStore` responde "qué vende esta tienda". Esto responde "qué
   * hay para ver", que es una pregunta distinta: cruza tiendas y necesita traer
   * al vendedor con cada producto, porque en el feed la marca la pone quien
   * vende, no el catálogo.
   *
   * ─── Los tres filtros de estado no son redundantes ───
   *
   * Producto ACTIVE, tienda ACTIVE y vendedor ACTIVE. Un vendedor suspendido
   * puede tener productos que quedaron activos: sin el tercer filtro seguirían
   * apareciendo en el feed después de la suspensión, que es exactamente lo que
   * la suspensión tiene que impedir.
   *
   * ─── Orden ───
   *
   * **Frescura con un empujón por interés**, no al revés. Ver `ranking.ts`,
   * que explica por qué: un feed ordenado por popularidad se convierte en una
   * máquina de hacer ricos a los ricos, y a las dos semanas hay cinco
   * vendedores en pantalla y el resto no existe.
   *
   * ─── Por qué el ranking se aplica DESPUÉS de traer la página ───
   *
   * La paginación por cursor necesita un orden estable en la base. Un puntaje
   * que depende de la hora actual no lo es: entre dos scrolls, un producto
   * puede cambiar de posición y aparecer dos veces o no aparecer nunca.
   *
   * Así que la base ordena por fecha —estable, indexado— y el ranking reordena
   * dentro de la página. El efecto es el que se busca: lo de hoy con más
   * interés sube dentro de lo de hoy, y nada se pierde entre páginas.
   *
   * Cuando el catálogo crezca lo suficiente como para que eso no alcance, el
   * cambio es materializar el puntaje en una columna y ordenar por ahí. La
   * fórmula ya está aparte, así que no habría que reescribirla.
   */
  async listDiscover(query: DiscoverQueryDto) {
    /**
     * Con texto, la búsqueda manda.
     *
     * El orden lo da la relevancia del texto, no la frescura: alguien que
     * escribió "buzo negro" quiere buzos negros, no lo último publicado.
     */
    const idsBuscados = query.q ? await this.search.idsQueCoinciden(query.q) : null;
    if (idsBuscados !== null && idsBuscados.length === 0) {
      return { items: [], nextCursor: null };
    }

    /**
     * «En vivo ahora»: se resuelve ANTES de la consulta principal.
     *
     * ⚠️ Es el único filtro que no se puede expresar como una condición sobre
     * `product`: depende de qué vendedores están transmitiendo en este
     * instante, que vive en otra tabla y cambia cada pocos minutos.
     *
     * Se resuelve pidiendo primero la lista de vendedores al aire y filtrando
     * por ella.
     *
     * El corte con cero vendedores es un atajo, no una corrección. Escribiendo
     * esto se asumió que Prisma traduciría `in: []` a algo que devuelve todo;
     * se comprobó contra la base y no: lo traduce a `WHERE false` y devuelve
     * vacío, que es lo correcto. Lo que el corte ahorra es una consulta con
     * seis joins que ya se sabe que no va a traer nada — y esta es la pantalla
     * más visitada de la app.
     */
    let sellersEnVivo: string[] | null = null;
    if (query.enVivo) {
      const sesiones = await this.prisma.liveSession.findMany({
        where: { state: { in: ['LIVE', 'RECONNECTING'] } },
        select: { sellerId: true },
        distinct: ['sellerId'],
      });
      sellersEnVivo = sesiones.map((s) => s.sellerId);
      if (sellersEnVivo.length === 0) return { items: [], nextCursor: null };
    }

    /**
     * El orden de la base.
     *
     * ⚠️ `relevancia` NO se ordena acá: se ordena después, con
     * `ordenarPorPuntaje`, que es el ranking que ya existía. Acá sólo se le da
     * un orden estable a la página —el mismo de siempre— para que la
     * paginación por cursor siga funcionando.
     *
     * Los otros tres sí son órdenes de base porque son objetivos: el precio
     * más bajo es el precio más bajo, no hay nada que ponderar.
     */
    const orderBy = ((): Prisma.ProductOrderByWithRelationInput[] => {
      switch (query.orden) {
        case 'precio_asc':
          return [{ basePriceCents: 'asc' }, { id: 'desc' }];
        case 'precio_desc':
          return [{ basePriceCents: 'desc' }, { id: 'desc' }];
        case 'nuevos':
          return [{ createdAt: 'desc' }, { id: 'desc' }];
        default:
          return [{ id: 'desc' }];
      }
    })();

    const filas = await this.prisma.product.findMany({
      where: {
        ...PRODUCTO_COMPRABLE,
        ...(idsBuscados ? { id: { in: idsBuscados } } : {}),
        ...(query.cursor && !idsBuscados ? { id: { lt: query.cursor } } : {}),
        // El rubro se combina con el texto en vez de reemplazarlo: "botines"
        // dentro de Calzado es una búsqueda legítima.
        ...(query.categoria ? { categoryId: query.categoria } : {}),
        ...(query.tienda ? { storeId: query.tienda } : {}),
        ...(sellersEnVivo ? { store: { sellerId: { in: sellersEnVivo } } } : {}),

        /**
         * El precio filtra por `basePriceCents`, el precio del PRODUCTO.
         *
         * Una variante puede tener un precio distinto —el talle XXL sale más
         * caro— y filtrar por variante haría que un producto apareciera en un
         * rango por una combinación que quizá ni está disponible. Filtrar por
         * el precio base es lo que la persona ve en la tarjeta del feed, que
         * es sobre lo que está decidiendo.
         */
        ...(query.precioMin !== undefined || query.precioMax !== undefined
          ? {
              basePriceCents: {
                ...(query.precioMin !== undefined ? { gte: query.precioMin } : {}),
                ...(query.precioMax !== undefined ? { lte: query.precioMax } : {}),
              },
            }
          : {}),
      },
      orderBy,
      select: FEED_SELECT,
      take: query.limit + 1,
    });

    // La disponibilidad sale como ETIQUETA, no como número. Publicar el stock
    // exacto de cada variante le regala a la competencia el ritmo de ventas de
    // un vendedor: consultando dos veces por día se saca cuánto vendió.
    const conDisponibilidad = filas.map((p) => ({
      ...p,
      images: conUrls(p.images),
      variants: p.variants.map((v) => {
        const inv = v.inventory;
        const { inventory: _inventory, ...resto } = v;
        return {
          ...resto,
          priceCents: v.priceOverrideCents ?? p.basePriceCents,
          ...vistaPublicaDeStock(inv),
        };
      }),
    }));

    /**
     * El ranking reordena DENTRO de la página, no entre páginas.
     *
     * Con una búsqueda de texto no se aplica: ahí el orden lo da la relevancia,
     * y reordenar por frescura pondría arriba lo más nuevo aunque no sea lo que
     * la persona buscó.
     */
    const pagina = this.paginar(conDisponibilidad, query.limit);
    if (idsBuscados) return pagina;

    /**
     * ⚠️ Y tampoco se aplica cuando la persona pidió un orden explícito.
     *
     * Alguien que eligió «precio: menor a mayor» quiere eso, no una lista
     * reordenada por frescura y likes con el precio como una consideración
     * más. Reordenar encima de un orden pedido es ignorar lo que pidió.
     */
    if (query.orden !== 'relevancia') return pagina;

    const vivos = await this.vendedoresEnVivo(pagina.items.map((p) => p.store.seller.id));

    const ordenados = ordenarPorPuntaje(pagina.items, (p) => ({
      creadoEl: p.createdAt,
      likes: p.likesCount,
      enVivo: vivos.has(p.store.seller.id),
      verificado: p.store.seller.verificationStatus === 'VERIFIED',
    }));

    /**
     * Y recién ACÁ entran los promocionados.
     *
     * ⚠️ Después de ordenar, nunca antes. Lo pago no participa del puntaje: se
     * inserta en posiciones reservadas y el orgánico corre un lugar sin
     * reordenarse. Ver `promociones.ts` para por qué esto no es un detalle de
     * implementación sino la decisión central del módulo.
     *
     * Sólo en la primera página: promocionar en la página siete es cobrarle a
     * alguien por un lugar que casi nadie ve.
     */
    const items =
      query.cursor === undefined
        ? await this.conPromocionados(ordenados)
        : ordenados.map((item) => ({ ...item, promocionado: false }));

    return { ...pagina, items };
  }

  /**
   * Trae los productos promocionados y los mezcla.
   *
   * Usa `FEED_SELECT`, el mismo `select` que la página orgánica: una tarjeta
   * promocionada tiene que traer exactamente los mismos campos, o se ve rota
   * justo en la posición que alguien pagó.
   *
   * Y pasa por `PRODUCTO_VISIBLE`: una promoción no puede mostrar algo que la
   * tienda pausó o borró después de comprarla.
   */
  private async conPromocionados<T extends { id: string; store: { seller: { id: string } } }>(
    organicos: T[],
  ) {
    const ids = await this.promociones.productosPromocionadosAhora();
    if (ids.length === 0) return organicos.map((item) => ({ ...item, promocionado: false }));

    const filas = await this.prisma.product.findMany({
      where: { id: { in: ids }, ...PRODUCTO_VISIBLE },
      select: FEED_SELECT,
    });

    // El orden de compra lo define `productosPromocionadosAhora`; la base
    // devuelve lo que quiere, así que se reordena según los ids.
    const porId = new Map(filas.map((f) => [f.id, f]));
    const enOrden = ids.map((id) => porId.get(id)).filter((f) => f !== undefined);

    const conDisponibilidad = enOrden.map((p) => ({
      ...p,
      images: conUrls(p.images),
      variants: p.variants.map((v) => {
        const { inventory: inv, ...resto } = v;
        return {
          ...resto,
          priceCents: v.priceOverrideCents ?? p.basePriceCents,
          ...vistaPublicaDeStock(inv),
        };
      }),
    }));

    return intercalarPromocionados(
      organicos,
      conDisponibilidad as unknown as T[],
      (p) => p.id,
      (p) => p.store.seller.id,
    ).map(({ item, promocionado }) => ({ ...item, promocionado }));
  }

  /**
   * Qué vendedores de esta página están transmitiendo ahora.
   *
   * Una consulta para toda la página, no una por producto: con veinte
   * productos, el N+1 serían veinte viajes más para pintar un scroll.
   */
  private async vendedoresEnVivo(sellerIds: string[]): Promise<Set<string>> {
    if (sellerIds.length === 0) return new Set();

    const filas = await this.prisma.liveSession.findMany({
      where: { sellerId: { in: sellerIds }, state: { in: ['LIVE', 'RECONNECTING'] } },
      select: { sellerId: true },
    });
    return new Set(filas.map((f) => f.sellerId));
  }

  // ─── Variantes ────────────────────────────────────────────────────────────

  /**
   * Define los ejes de variación del producto y genera sus combinaciones.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * EL VENDEDOR NO ARMA VARIANTES: ARMA EJES
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Nadie quiere cargar "Negro / S", "Negro / M", "Negro / L", "Blanco / S"…
   * a mano. Carga dos listas —Color: Negro, Blanco · Talle: S, M, L— y las seis
   * combinaciones salen solas. Después ajusta stock y precio de cada una.
   *
   * Los ejes son libres: Color, Talle, Capacidad, Sabor, Medida, Material. Nada
   * acá conoce la ropa.
   *
   * ─── Lo que NO se puede romper ───
   *
   * **El stock de las combinaciones que sobreviven.** Si el vendedor agrega el
   * color Rojo a un producto que ya vendía Negro y Blanco, las variantes de
   * Negro y Blanco tienen que conservar sus unidades: son las mismas variantes.
   * Se reconocen por `optionsKey`, la huella canónica de la combinación, que es
   * estable aunque cambie el orden.
   *
   * **El historial.** Las variantes que dejan de corresponder NO se borran: se
   * marcan con `deletedAt`. Una orden vieja apunta a su variante, y borrarla
   * dejaría un pedido sin poder decir qué se compró.
   *
   * ⚠️ El producto cartesiano crece rápido: 5 colores × 6 talles × 4 medidas son
   * 120 variantes. Hay tope, y la app tiene que mostrar el número **antes** de
   * confirmar.
   */
  async definirOpciones(userId: string, productId: string, dto: DefinirOpcionesDto) {
    const { product } = await this.ownership.productOf(userId, productId);

    /**
     * Se cuenta ANTES de tocar nada.
     *
     * Los ids de valor todavía no existen, pero la cantidad de combinaciones
     * sólo depende de cuántos valores tiene cada eje. Contar primero evita
     * abrir una transacción que va a fallar a mitad de camino.
     */
    const cuantas = dto.opciones.reduce((t, o) => t * o.values.length, 1);
    if (cuantas > MAX_VARIANTES) {
      throw new InvalidPriceError(
        `Serían ${cuantas} variantes y el máximo es ${MAX_VARIANTES}. ` +
          'Probá con menos valores o separá el producto en dos.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      /**
       * ⚠️ Se REUTILIZAN las opciones y los valores que ya existen.
       *
       * La huella de una combinación (`optionsKey`) se arma con los **ids** de
       * los valores. Borrar las opciones y recrearlas genera ids nuevos, así
       * que ninguna combinación coincidiría con la anterior: agregar un color
       * archivaría todas las variantes viejas y crearía otras en cero.
       *
       * El vendedor que agrega "Rojo" a un producto que vende Negro y Blanco
       * perdería el stock de los dos. Se reconocen por nombre —que es lo que él
       * escribió— y conservan su id.
       */
      const existentes = await tx.productOption.findMany({
        where: { productId: product.id },
        include: { values: true },
      });

      const opciones: OpcionConValores[] = [];
      const optionIdsVigentes: string[] = [];

      for (const [i, opcion] of dto.opciones.entries()) {
        const previa = existentes.find(
          (o) => o.name.toLowerCase() === opcion.name.toLowerCase(),
        );

        const optionId = previa?.id ?? newId('opt');
        optionIdsVigentes.push(optionId);

        if (previa) {
          await tx.productOption.update({
            where: { id: optionId },
            data: { name: opcion.name, position: i },
          });
        } else {
          await tx.productOption.create({
            data: { id: optionId, productId: product.id, name: opcion.name, position: i },
          });
        }

        const valores: Array<{ id: string; value: string; position: number }> = [];
        for (const [j, valor] of opcion.values.entries()) {
          const previoValor = previa?.values.find(
            (v) => v.value.toLowerCase() === valor.toLowerCase(),
          );
          const valueId = previoValor?.id ?? newId('opv');

          if (previoValor) {
            await tx.productOptionValue.update({
              where: { id: valueId },
              data: { value: valor, position: j },
            });
          } else {
            await tx.productOptionValue.create({
              data: { id: valueId, optionId, value: valor, position: j },
            });
          }
          valores.push({ id: valueId, value: valor, position: j });
        }

        // Los valores que el vendedor sacó. La cascada se lleva sus uniones con
        // variantes; las variantes huérfanas se archivan más abajo.
        await tx.productOptionValue.deleteMany({
          where: { optionId, id: { notIn: valores.map((v) => v.id) } },
        });

        opciones.push({ optionId, name: opcion.name, position: i, values: valores });
      }

      // Ejes que ya no existen.
      await tx.productOption.deleteMany({
        where: { productId: product.id, id: { notIn: optionIdsVigentes } },
      });

      const combinaciones = generarCombinaciones(opciones);
      const clavesVigentes = new Set(combinaciones.map((c) => c.optionsKey));

      /**
       * Se miran TAMBIÉN las archivadas.
       *
       * El índice `[productId, optionsKey]` no distingue borradas: una variante
       * archivada sigue ocupando su huella. Crear otra con la misma clave falla
       * con un error opaco de base de datos.
       *
       * Y además es el comportamiento correcto: sacar "Rojo" y volver a
       * agregarlo tiene que devolver la MISMA variante, con su historial.
       */
      const todas = await tx.productVariant.findMany({
        where: { productId: product.id },
        select: { id: true, optionsKey: true, deletedAt: true },
      });

      for (const [i, combo] of combinaciones.entries()) {
        const previa = todas.find((v) => v.optionsKey === combo.optionsKey);
        const variantId = previa?.id ?? newId('var');

        if (previa) {
          await tx.productVariant.update({
            where: { id: variantId },
            data: {
              title: combo.title,
              position: i,
              isDefault: combo.optionsKey === KEY_DEFAULT,
              // Revivir la archivada: es la misma combinación de siempre.
              deletedAt: null,
              ...(previa.deletedAt ? { status: 'ACTIVE' as const } : {}),
            },
          });
        } else {
          await tx.productVariant.create({
            data: {
              id: variantId,
              productId: product.id,
              storeId: product.storeId,
              title: combo.title,
              optionsKey: combo.optionsKey,
              isDefault: combo.optionsKey === KEY_DEFAULT,
              position: i,
            },
          });
          // Toda variante nace con su fila de inventario en cero, en la misma
          // transacción: sin esto habría variantes sin stock consultable.
          await tx.inventory.create({ data: { id: newId('inv'), productVariantId: variantId } });
        }

        // Las uniones se rehacen: los valores borrados se llevaron las suyas.
        await tx.productVariantOption.deleteMany({ where: { variantId } });
        if (combo.optionValueIds.length > 0) {
          await tx.productVariantOption.createMany({
            data: combo.optionValueIds.map((optionValueId) => ({ variantId, optionValueId })),
          });
        }
      }

      /**
       * Las que ya no corresponden se ARCHIVAN, no se borran.
       *
       * Una orden vieja apunta a su variante. Borrarla dejaría un pedido sin
       * poder decir qué se compró, y el historial se rompería en silencio.
       */
      const aArchivar = todas.filter(
        (v) => !clavesVigentes.has(v.optionsKey) && v.deletedAt === null,
      );
      if (aArchivar.length > 0) {
        await tx.productVariant.updateMany({
          where: { id: { in: aArchivar.map((v) => v.id) } },
          data: { deletedAt: new Date(), status: 'INACTIVE' },
        });
      }
    });

    await this.audit.log({
      action: 'product.options_defined',
      entityType: 'product',
      entityId: product.id,
      actorId: userId,
      after: { ejes: dto.opciones.map((o) => o.name), variantes: cuantas },
    });

    return this.cargarDetalle(product.id);
  }

  async createVariant(userId: string, productId: string, dto: CreateVariantDto) {
    const { product } = await this.ownership.productOf(userId, productId, { requireActive: true });
    const opciones = await this.cargarOpciones(product.id);

    const validacion = validarCombinacion(dto.optionValueIds, opciones);
    if (!validacion.ok) throw new InvalidPriceError(validacion.motivo);

    const optionsKey = calcularOptionsKey(dto.optionValueIds);
    const title = tituloDeVariante(dto.optionValueIds, opciones);
    const variantId = newId('var');

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.productVariant.create({
          data: {
            id: variantId,
            productId: product.id,
            storeId: product.storeId,
            title,
            optionsKey,
            sku: dto.sku ?? null,
            priceOverrideCents: dto.priceOverrideCents ?? null,
            compareAtPriceOverrideCents: dto.compareAtPriceOverrideCents ?? null,
            status: dto.status,
            isDefault: optionsKey === KEY_DEFAULT,
          },
        });
        if (dto.optionValueIds.length > 0) {
          await tx.productVariantOption.createMany({
            data: dto.optionValueIds.map((optionValueId) => ({ variantId, optionValueId })),
          });
        }

        // Igual que al crear el producto: toda variante nace con su fila de
        // inventario en cero, en la misma transacción.
        await tx.inventory.create({ data: { id: newId('inv'), productVariantId: variantId } });
      });
    } catch (err) {
      throw this.traducirConflicto(err, title, dto.sku ?? null);
    }

    this.events.publish(DomainEvent.variantCreated, { entityId: variantId, actorId: userId });
    await this.audit.log({
      action: 'variant.created',
      entityType: 'variant',
      entityId: variantId,
      actorId: userId,
      after: { productId: product.id, title, sku: dto.sku ?? null },
    });

    return this.cargarDetalle(product.id);
  }

  async updateVariant(
    userId: string,
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ) {
    const { product, variant } = await this.ownership.variantOf(userId, productId, variantId, {
      requireActive: true,
    });

    const precio = dto.priceOverrideCents ?? variant.priceOverrideCents ?? product.basePriceCents;
    const comparativo =
      dto.compareAtPriceOverrideCents !== undefined
        ? dto.compareAtPriceOverrideCents
        : variant.compareAtPriceOverrideCents;
    if (!esComparativoValido(precio, comparativo)) {
      throw new InvalidPriceError('El precio tachado tiene que ser mayor que el de venta');
    }

    try {
      const actualizada = await this.prisma.productVariant.update({
        where: { id: variant.id },
        data: {
          ...(dto.sku !== undefined ? { sku: dto.sku } : {}),
          ...(dto.priceOverrideCents !== undefined
            ? { priceOverrideCents: dto.priceOverrideCents }
            : {}),
          ...(dto.compareAtPriceOverrideCents !== undefined
            ? { compareAtPriceOverrideCents: dto.compareAtPriceOverrideCents }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });

      await this.audit.logDiff({
        action: 'variant.updated',
        entityType: 'variant',
        entityId: variant.id,
        actorId: userId,
        before: { ...variant },
        after: { ...actualizada },
      });
      this.events.publish(DomainEvent.variantUpdated, { entityId: variant.id, actorId: userId });
    } catch (err) {
      throw this.traducirConflicto(err, variant.title, dto.sku ?? null);
    }

    return this.cargarDetalle(product.id);
  }

  /**
   * Borrado lógico de una variante.
   *
   * La última no se puede borrar: dejaría un producto sin nada que vender, y
   * rompería el invariante del que depende Inventory.
   */
  async deleteVariant(userId: string, productId: string, variantId: string) {
    const { product, variant } = await this.ownership.variantOf(userId, productId, variantId, {
      requireActive: true,
    });

    const vivas = await this.prisma.productVariant.count({
      where: { productId: product.id, deletedAt: null },
    });
    if (vivas <= 1) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'No podés borrar la única variante. Si no querés vender el producto, pausalo.',
      );
    }

    await this.prisma.productVariant.update({
      where: { id: variant.id },
      data: { deletedAt: new Date(), status: 'INACTIVE' },
    });

    this.events.publish(DomainEvent.variantDeleted, { entityId: variant.id, actorId: userId });
    await this.audit.log({
      action: 'variant.deleted',
      entityType: 'variant',
      entityId: variant.id,
      actorId: userId,
      before: { title: variant.title, sku: variant.sku },
    });

    return this.cargarDetalle(product.id);
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private async cargarDetalle(productId: string) {
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: productId },
      select: {
        ...PRODUCT_SELECT,
        options: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            name: true,
            position: true,
            values: {
              orderBy: { position: 'asc' },
              select: { id: true, value: true, position: true },
            },
          },
        },
        variants: {
          where: { deletedAt: null },
          orderBy: { position: 'asc' },
          select: {
            id: true,
            title: true,
            sku: true,
            priceOverrideCents: true,
            compareAtPriceOverrideCents: true,
            status: true,
            isDefault: true,
            options: { select: { optionValueId: true } },
          },
        },
        images: {
          orderBy: { position: 'asc' },
          select: { id: true, storageKey: true, position: true, altText: true },
        },
      },
    });

    return {
      ...product,
      images: conUrls(product.images),
      variants: product.variants.map((v) => ({
        ...v,
        optionValueIds: v.options.map((o) => o.optionValueId),
        // El precio efectivo se resuelve acá y no en la app: si cada cliente
        // aplicara la regla por su cuenta, un día mostrarían números distintos.
        priceCents: v.priceOverrideCents ?? product.basePriceCents,
        options: undefined,
      })),
    };
  }

  private async cargarOpciones(productId: string): Promise<OpcionConValores[]> {
    const opciones = await this.prisma.productOption.findMany({
      where: { productId },
      orderBy: { position: 'asc' },
      include: { values: { orderBy: { position: 'asc' } } },
    });

    return opciones.map((o) => ({
      optionId: o.id,
      name: o.name,
      position: o.position,
      values: o.values.map((v) => ({ id: v.id, value: v.value, position: v.position })),
    }));
  }

  private async slugLibre(storeId: string, slug: string): Promise<boolean> {
    return (await this.prisma.product.count({ where: { storeId, slug } })) === 0;
  }

  private async slugLibreOFalla(storeId: string, slug: string): Promise<string> {
    if (!(await this.slugLibre(storeId, slug))) {
      throw new DomainError('SLUG_TAKEN', 'Ya tenés un producto con ese nombre', { slug });
    }
    return slug;
  }

  /** Traduce una violación de índice a un error que se entienda. */
  private traducirConflicto(err: unknown, title: string, sku: string | null): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const campo = (err.meta?.target as string[] | undefined)?.join(',') ?? '';
      if (campo.includes('sku') && sku) return new SkuTakenError(sku);
      return new VariantCombinationExistsError(title);
    }
    return err;
  }

  /**
   * Arma la página.
   *
   * Se pide `limit + 1` fila: si vuelve la de más, hay página siguiente. Es
   * más barato que un `COUNT(*)` sobre toda la tabla, que además sería
   * inexacto para cuando el cliente lo lea.
   */
  private paginar<T extends { id: string }>(filas: T[], limit: number) {
    const hayMas = filas.length > limit;
    const items = hayMas ? filas.slice(0, limit) : filas;
    return {
      items,
      nextCursor: hayMas ? (items[items.length - 1]?.id ?? null) : null,
    };
  }
}
