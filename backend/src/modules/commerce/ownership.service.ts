import { Injectable } from '@nestjs/common';

import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';

/**
 * Resolución de pertenencia.
 *
 * ─── La idea central del bloque comercial ───
 *
 * La forma habitual de proteger un recurso es:
 *
 *     const producto = await prisma.product.findUnique({ where: { id } });
 *     if (producto.store.sellerId !== usuario.sellerId) throw Forbidden;
 *
 * Funciona, y falla de una manera concreta: es un chequeo, y los chequeos se
 * olvidan. Alcanza con que alguien agregue un endpoint nuevo y no lo copie.
 * Nada en el código señala la ausencia — no hay una línea rota, hay una línea
 * que no está.
 *
 * Acá se hace al revés. **La pertenencia va en el WHERE:**
 *
 *     await prisma.product.findFirst({
 *       where: { id, store: { sellerId } },
 *     });
 *
 * Un producto ajeno simplemente no aparece. No hay un `if` que olvidar, porque
 * no hay `if`: la consulta no puede devolver algo que no sea del usuario.
 *
 * Este servicio existe para que los demás no tengan que acordarse de armar ese
 * filtro. Toda escritura pasa por acá y recibe ids ya verificados.
 *
 * ─── Por qué 404 y no 403 ───
 *
 * Ver la nota en `HTTP_STATUS_BY_CODE`. En resumen: un 403 confirma que el id
 * existe, y con eso se puede enumerar el catálogo ajeno probando ids.
 */

export class SellerRequiredError extends DomainError {
  constructor() {
    super('SELLER_NOT_FOUND', 'Todavía no tenés un perfil de vendedor');
  }
}

export class SellerNotActiveError extends DomainError {
  constructor(status: string) {
    super('SELLER_NOT_ACTIVE', 'Tu cuenta de vendedor no está activa', { status });
  }
}

export class StoreNotFoundError extends DomainError {
  constructor() {
    super('STORE_NOT_FOUND', 'Tienda no encontrada');
  }
}

export class ProductNotFoundError extends DomainError {
  constructor() {
    super('PRODUCT_NOT_FOUND', 'Producto no encontrado');
  }
}

export class VariantNotFoundError extends DomainError {
  constructor() {
    super('VARIANT_NOT_FOUND', 'Variante no encontrada');
  }
}

/** Estados de vendedor que permiten operar sobre el catálogo. */
const PUEDEN_EDITAR = new Set(['PENDING', 'ACTIVE']);

/**
 * Estados que permiten TRANSMITIR EN VIVO.
 *
 * Más estricto que editar a propósito: un vendedor suspendido puede seguir
 * ordenando su catálogo, pero **no puede salir en vivo**. La regla se aplicará
 * al emitir el token de LiveKit — el token es lo único que el servidor
 * controla y lo único que la app no puede falsificar.
 *
 * Live Sessions todavía no existe. Esta constante queda acá para que cuando se
 * implemente, la regla ya esté escrita y no se reinvente distinta.
 */
export const PUEDEN_TRANSMITIR = new Set(['ACTIVE']);

@Injectable()
export class OwnershipService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Vendedor del usuario autenticado.
   *
   * `requireActive` distingue leer de escribir: ver el propio perfil se
   * permite siempre —incluso suspendido, para que la persona entienda qué le
   * pasó— pero modificar el catálogo no.
   */
  async sellerOf(userId: string, opciones: { requireActive?: boolean } = {}) {
    const seller = await this.prisma.seller.findUnique({ where: { userId } });
    if (!seller) throw new SellerRequiredError();

    if (opciones.requireActive && !PUEDEN_EDITAR.has(seller.status)) {
      throw new SellerNotActiveError(seller.status);
    }
    return seller;
  }

  /** Tienda principal. Hoy hay exactamente una por vendedor. */
  async primaryStoreOf(userId: string, opciones: { requireActive?: boolean } = {}) {
    const seller = await this.sellerOf(userId, opciones);
    const store = await this.prisma.store.findFirst({
      where: { sellerId: seller.id, isPrimary: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!store) throw new StoreNotFoundError();
    return { seller, store };
  }

  /**
   * Tienda por id, **sólo si es del usuario**.
   *
   * `sellerId` va en el WHERE. Una tienda ajena no se encuentra.
   */
  async storeOf(userId: string, storeId: string, opciones: { requireActive?: boolean } = {}) {
    const seller = await this.sellerOf(userId, opciones);
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, sellerId: seller.id },
    });
    if (!store) throw new StoreNotFoundError();
    return { seller, store };
  }

  /**
   * Producto por id, **sólo si es del usuario**.
   *
   * La pertenencia atraviesa dos saltos —producto → tienda → vendedor— y los
   * dos van en el WHERE. `deletedAt: null` también: un producto borrado no se
   * puede seguir editando.
   */
  async productOf(userId: string, productId: string, opciones: { requireActive?: boolean } = {}) {
    const seller = await this.sellerOf(userId, opciones);
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null, store: { sellerId: seller.id } },
    });
    if (!product) throw new ProductNotFoundError();
    return { seller, product };
  }

  /**
   * Variantes vivas de un producto **ya verificado como propio**.
   *
   * No recibe `userId` a propósito: se llama después de `productOf`, que es
   * quien resolvió la pertenencia. Pedirlo otra vez acá sugeriría que este
   * método se puede llamar con un `productId` arbitrario, y no se puede.
   */
  async variantsOf(productId: string) {
    return this.prisma.productVariant.findMany({
      where: { productId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true, title: true, status: true, isDefault: true, sku: true },
    });
  }

  /** Variante por id, **sólo si es del usuario**. Tres saltos, todos en el WHERE. */
  async variantOf(
    userId: string,
    productId: string,
    variantId: string,
    opciones: { requireActive?: boolean } = {},
  ) {
    const { seller, product } = await this.productOf(userId, productId, opciones);
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, productId: product.id, deletedAt: null },
    });
    if (!variant) throw new VariantNotFoundError();
    return { seller, product, variant };
  }
}
