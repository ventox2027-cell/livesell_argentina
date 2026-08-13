import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { DomainEvent, DomainEventBus } from '@/shared/events/domain-events';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';
import { esComparativoValido } from '@/shared/utils/money';
import { slugDisponible } from '@/shared/utils/slug';

import type {
  CreateProductDto,
  CreateVariantDto,
  PageQueryDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/commerce.dto';
import { OwnershipService } from './ownership.service';
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

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
  ) {}

  /**
   * Crea un producto con sus opciones y todas sus variantes.
   *
   * Todo en una transacción: un producto a medias —con opciones pero sin
   * variantes, o con la mitad de las combinaciones— sería inconsistente y no
   * habría forma de saber cuál falta.
   */
  async create(userId: string, dto: CreateProductDto) {
    const { store } = await this.ownership.primaryStoreOf(userId, { requireActive: true });

    if (!esComparativoValido(dto.basePriceCents, dto.compareAtPriceCents)) {
      throw new InvalidPriceError('El precio tachado tiene que ser mayor que el de venta');
    }

    const slug = dto.slug
      ? await this.slugLibreOFalla(store.id, dto.slug)
      : await slugDisponible(dto.name, (s) => this.slugLibre(store.id, s));

    const productId = newId('prd');

    try {
      await this.prisma.$transaction(async (tx) => {
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
        for (const [i, combo] of combinaciones.entries()) {
          const variantId = newId('var');
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
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
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

    const base = dto.basePriceCents ?? product.basePriceCents;
    const comparativo =
      dto.compareAtPriceCents !== undefined ? dto.compareAtPriceCents : product.compareAtPriceCents;
    if (!esComparativoValido(base, comparativo)) {
      throw new InvalidPriceError('El precio tachado tiene que ser mayor que el de venta');
    }

    const actualizado = await this.prisma.product.update({
      where: { id: product.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.basePriceCents !== undefined ? { basePriceCents: dto.basePriceCents } : {}),
        ...(dto.compareAtPriceCents !== undefined
          ? { compareAtPriceCents: dto.compareAtPriceCents }
          : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
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
    if (dto.status === 'ACTIVE' && product.status !== 'ACTIVE') {
      this.events.publish(DomainEvent.productActivated, { entityId: product.id, actorId: userId });
    } else if (dto.status === 'ARCHIVED' && product.status !== 'ARCHIVED') {
      this.events.publish(DomainEvent.productArchived, { entityId: product.id, actorId: userId });
    } else {
      this.events.publish(DomainEvent.productUpdated, { entityId: product.id, actorId: userId });
    }

    return this.cargarDetalle(product.id);
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
    const { store } = await this.ownership.primaryStoreOf(userId);

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
        images: { where: { position: 0 }, take: 1, select: { url: true } },
        _count: { select: { variants: { where: { deletedAt: null } } } },
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });

    return this.paginar(filas, query.limit);
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
        status: 'ACTIVE',
        deletedAt: null,
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      select: {
        ...PRODUCT_SELECT,
        images: { orderBy: { position: 'asc' }, take: 1, select: { url: true } },
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });

    return this.paginar(filas, query.limit);
  }

  // ─── Variantes ────────────────────────────────────────────────────────────

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
          select: { id: true, url: true, position: true, altText: true },
        },
      },
    });

    return {
      ...product,
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
