import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type ProcessorFeeMode,
  type Seller,
  type ShippingMode,
  type Store,
} from '@prisma/client';

import {
  costoDeEnvio,
  etiquetaDeEnvio,
  permiteEnvio,
  permiteRetiro,
} from '@/modules/orders/shipping';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainEvent, DomainEventBus } from '@/shared/events/domain-events';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';
import { slugDisponible } from '@/shared/utils/slug';

import type {
  CreateSellerDto,
  ChangeStoreSlugDto,
  UpdateSellerDto,
  UpdateShippingPolicyDto,
  UpdateStoreDto,
} from './dto/commerce.dto';
import { OwnershipService } from './ownership.service';

/**
 * Vendedores y tiendas.
 *
 * ─── Convertirse en vendedor es un solo paso ───
 *
 * Crear el Seller crea **también la tienda principal**, en la misma
 * transacción. La alternativa —crear el perfil y después pedir "ahora creá tu
 * tienda"— agrega una pantalla que nadie entiende: para el vendedor, su perfil
 * y su tienda son la misma cosa.
 *
 * Además evita el estado intermedio "vendedor sin tienda", que todo el resto
 * del código tendría que contemplar para siempre.
 */

export class SellerAlreadyExistsError extends DomainError {
  constructor() {
    super('SELLER_EXISTS', 'Ya tenés un perfil de vendedor');
  }
}

export class SlugTakenError extends DomainError {
  constructor(slug: string) {
    super('SLUG_TAKEN', 'Ese nombre de tienda ya está ocupado', { slug });
  }
}

@Injectable()
export class SellersService {
  private readonly logger = new Logger(SellersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
  ) {}

  /**
   * Convierte un usuario en vendedor.
   *
   * Seller + Store en una transacción: o queda todo o no queda nada. Un
   * vendedor sin tienda sería un estado que hay que contemplar en cada
   * consulta posterior.
   */
  async create(userId: string, dto: CreateSellerDto): Promise<{ seller: Seller; store: Store }> {
    const existente = await this.prisma.seller.findUnique({ where: { userId } });
    if (existente) throw new SellerAlreadyExistsError();

    const slugSeller = dto.slug
      ? await this.verificarSlugLibre(dto.slug)
      : await slugDisponible(dto.displayName, (s) => this.slugSellerLibre(s));

    const nombreTienda = dto.storeName ?? dto.displayName;
    const slugStore = await slugDisponible(nombreTienda, (s) => this.slugStoreLibre(s));

    try {
      const { seller, store } = await this.prisma.$transaction(async (tx) => {
        const seller = await tx.seller.create({
          data: {
            id: newId('sel'),
            userId,
            displayName: dto.displayName,
            slug: slugSeller,
            bio: dto.bio ?? null,
          },
        });

        const store = await tx.store.create({
          data: {
            id: newId('sto'),
            sellerId: seller.id,
            name: nombreTienda,
            slug: slugStore,
            isPrimary: true,
          },
        });

        // El rol del usuario pasa a `seller`. Es lo que le habilita las
        // pantallas de vendedor en la app, y se lee de la base en cada
        // petición — no del token — así que tiene efecto inmediato.
        await tx.user.update({ where: { id: userId }, data: { role: 'seller' } });

        return { seller, store };
      });

      // Los eventos se publican DESPUÉS de cometer. Publicar adentro haría que
      // un suscriptor reaccionara a un vendedor que todavía no existe para
      // nadie más, o peor, a uno cuya transacción se revirtió.
      this.events.publish(DomainEvent.sellerCreated, {
        entityId: seller.id,
        actorId: userId,
        data: { slug: seller.slug, storeId: store.id },
      });
      this.events.publish(DomainEvent.storeCreated, {
        entityId: store.id,
        actorId: userId,
        data: { slug: store.slug, sellerId: seller.id },
      });

      await this.audit.log({
        action: 'seller.created',
        entityType: 'seller',
        entityId: seller.id,
        actorId: userId,
        after: { displayName: seller.displayName, slug: seller.slug },
      });

      return { seller, store };
    } catch (err) {
      // Carrera con otro registro simultáneo: el índice UNIQUE la resuelve y
      // acá sólo se traduce a un mensaje que se entienda.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const campo = (err.meta?.target as string[] | undefined)?.join(',') ?? '';
        if (campo.includes('user_id')) throw new SellerAlreadyExistsError();
        throw new SlugTakenError(slugSeller);
      }
      throw err;
    }
  }

  /** Perfil propio. Se permite aunque esté suspendido: la persona tiene que poder ver qué le pasó. */
  async me(userId: string) {
    const seller = await this.ownership.sellerOf(userId);
    const store = await this.prisma.store.findFirst({
      where: { sellerId: seller.id, isPrimary: true },
    });

    const productos = store
      ? await this.prisma.product.count({ where: { storeId: store.id, deletedAt: null } })
      : 0;

    return { seller: this.publicSeller(seller), store, stats: { productos } };
  }

  async update(userId: string, dto: UpdateSellerDto) {
    const seller = await this.ownership.sellerOf(userId, { requireActive: true });

    const actualizado = await this.prisma.seller.update({
      where: { id: seller.id },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
        ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
        ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl } : {}),
        ...(dto.coverUrl !== undefined ? { coverUrl: dto.coverUrl } : {}),
      },
    });

    await this.audit.logDiff({
      action: 'seller.updated',
      entityType: 'seller',
      entityId: seller.id,
      actorId: userId,
      before: { ...seller },
      after: { ...actualizado },
    });
    this.events.publish(DomainEvent.sellerUpdated, { entityId: seller.id, actorId: userId });

    return this.publicSeller(actualizado);
  }

  /**
   * Perfil público de un vendedor.
   *
   * Sólo se muestran los activos. Un vendedor suspendido no puede tener una
   * vidriera pública, y responder 404 evita confirmar que la cuenta existe.
   */
  async publicBySlug(slug: string) {
    const seller = await this.prisma.seller.findFirst({
      where: { slug, status: 'ACTIVE' },
      include: {
        stores: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });
    if (!seller) throw new DomainError('SELLER_NOT_FOUND', 'Vendedor no encontrado');

    return {
      ...this.publicSeller(seller),
      store: seller.stores[0]
        ? {
            id: seller.stores[0].id,
            name: seller.stores[0].name,
            slug: seller.stores[0].slug,
            description: seller.stores[0].description,
            logoUrl: seller.stores[0].logoUrl,
            coverUrl: seller.stores[0].coverUrl,
          }
        : null,
    };
  }

  // ─── Tiendas ──────────────────────────────────────────────────────────────

  async myStore(userId: string) {
    const { store } = await this.ownership.primaryStoreOf(userId);
    return store;
  }

  async updateStore(userId: string, storeId: string, dto: UpdateStoreDto) {
    const { store } = await this.ownership.storeOf(userId, storeId, { requireActive: true });

    const actualizada = await this.prisma.store.update({
      where: { id: store.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.coverUrl !== undefined ? { coverUrl: dto.coverUrl } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
    });

    await this.audit.logDiff({
      action: 'store.updated',
      entityType: 'store',
      entityId: store.id,
      actorId: userId,
      before: { ...store },
      after: { ...actualizada },
    });
    this.events.publish(DomainEvent.storeUpdated, { entityId: store.id, actorId: userId });

    return actualizada;
  }

  /**
   * Define cómo cobra el envío esta tienda y quién paga el medio de pago.
   *
   * ─── Por qué no afecta a las órdenes ya creadas ───
   *
   * Cada orden guarda su propia foto (`shippingModeSnapshot`,
   * `processorFeeModeSnapshot`). Cambiar esto hoy no le cambia el total a nadie
   * que ya compró: quien pagó $12.400 con envío incluido tiene que seguir
   * viendo $12.400 con envío incluido para siempre, aunque mañana la tienda
   * pase a retiro únicamente.
   *
   * ─── Por qué se audita entero ───
   *
   * Es el registro de "en esta fecha esta tienda pasó a trasladar el costo del
   * procesador". Si un comprador reclama que le cobraron un recargo que no
   * esperaba, esta es la única forma de reconstruir qué política estaba vigente
   * cuando compró.
   */
  async updateShippingPolicy(userId: string, storeId: string, dto: UpdateShippingPolicyDto) {
    const { store } = await this.ownership.storeOf(userId, storeId, { requireActive: true });

    const actualizada = await this.prisma.store.update({
      where: { id: store.id },
      data: {
        shippingMode: dto.shippingMode,
        shippingFlatAmount: dto.shippingFlatAmount,
        processorFeeMode: dto.processorFeeMode,
        ...(dto.shippingNote !== undefined ? { shippingNote: dto.shippingNote } : {}),
      },
    });

    await this.audit.logDiff({
      action: 'store.shipping_policy_updated',
      entityType: 'store',
      entityId: store.id,
      actorId: userId,
      before: {
        shippingMode: store.shippingMode,
        shippingFlatAmount: store.shippingFlatAmount,
        shippingNote: store.shippingNote,
        processorFeeMode: store.processorFeeMode,
      },
      after: {
        shippingMode: actualizada.shippingMode,
        shippingFlatAmount: actualizada.shippingFlatAmount,
        shippingNote: actualizada.shippingNote,
        processorFeeMode: actualizada.processorFeeMode,
      },
    });

    return this.politicaDeEnvio(actualizada);
  }

  /** La política tal como la ve el vendedor y tal como la ve quien compra. */
  private politicaDeEnvio(store: {
    shippingMode: ShippingMode;
    shippingFlatAmount: number;
    shippingNote: string | null;
    processorFeeMode: ProcessorFeeMode;
  }) {
    const politica = { modo: store.shippingMode, montoFijo: store.shippingFlatAmount };
    return {
      shippingMode: store.shippingMode,
      shippingFlatAmount: store.shippingFlatAmount,
      shippingNote: store.shippingNote,
      processorFeeMode: store.processorFeeMode,
      // Derivados, para que la app no reimplemente las reglas y se desincronice.
      permiteEnvio: permiteEnvio(store.shippingMode),
      permiteRetiro: permiteRetiro(store.shippingMode),
      etiquetaEnvio: etiquetaDeEnvio(politica, false),
      costoEnvio: costoDeEnvio(politica, false),
    };
  }

  /**
   * Cambia el slug de la tienda.
   *
   * Endpoint aparte del resto de la edición a propósito: cambiar el slug rompe
   * todos los enlaces que la gente ya compartió. Merece una confirmación
   * explícita en la interfaz, y separarlo obliga a que exista.
   */
  async changeStoreSlug(userId: string, storeId: string, dto: ChangeStoreSlugDto) {
    const { store } = await this.ownership.storeOf(userId, storeId, { requireActive: true });
    if (store.slug === dto.slug) return store;

    if (!(await this.slugStoreLibre(dto.slug))) throw new SlugTakenError(dto.slug);

    try {
      const actualizada = await this.prisma.store.update({
        where: { id: store.id },
        data: { slug: dto.slug },
      });
      await this.audit.log({
        action: 'store.slug_changed',
        entityType: 'store',
        entityId: store.id,
        actorId: userId,
        before: { slug: store.slug },
        after: { slug: dto.slug },
      });
      return actualizada;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new SlugTakenError(dto.slug);
      }
      throw err;
    }
  }

  /** Vidriera pública de una tienda. */
  async storeBySlug(slug: string) {
    const store = await this.prisma.store.findFirst({
      where: { slug, status: 'ACTIVE', seller: { status: 'ACTIVE' } },
      include: { seller: true },
    });
    if (!store) throw new DomainError('STORE_NOT_FOUND', 'Tienda no encontrada');

    return {
      id: store.id,
      name: store.name,
      slug: store.slug,
      description: store.description,
      logoUrl: store.logoUrl,
      coverUrl: store.coverUrl,
      seller: this.publicSeller(store.seller),
      // Quien mira la vidriera tiene que saber cuánto sale el envío ANTES de
      // llegar al checkout. Enterarse del costo con la tarjeta en la mano es la
      // razón número uno por la que alguien abandona una compra.
      envio: this.politicaDeEnvio(store),
    };
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private async verificarSlugLibre(slug: string): Promise<string> {
    if (!(await this.slugSellerLibre(slug))) throw new SlugTakenError(slug);
    return slug;
  }

  private async slugSellerLibre(slug: string): Promise<boolean> {
    return (await this.prisma.seller.count({ where: { slug } })) === 0;
  }

  private async slugStoreLibre(slug: string): Promise<boolean> {
    return (await this.prisma.store.count({ where: { slug } })) === 0;
  }

  /**
   * Proyección pública.
   *
   * Se enumeran los campos que salen en vez de borrar los que no. Con un
   * `delete seller.userId`, agregar una columna sensible a la tabla la expone
   * sin que nadie lo note.
   */
  private publicSeller(seller: Seller) {
    return {
      id: seller.id,
      displayName: seller.displayName,
      slug: seller.slug,
      bio: seller.bio,
      avatarUrl: seller.avatarUrl,
      coverUrl: seller.coverUrl,
      status: seller.status,
      verificationStatus: seller.verificationStatus,
      createdAt: seller.createdAt,
    };
  }
}

/** Slug propuesto por el vendedor, ya validado por el DTO. */
export type { CreateSellerDto };
