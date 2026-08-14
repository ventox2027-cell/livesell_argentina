import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CurrentUser, Public, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { DomainError } from '@/shared/errors/domain.error';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';
import { MAX_BYTES, type ArchivoSubido } from '@/shared/storage/storage.provider';

import {
  ChangeStoreSlugSchema,
  CreateProductSchema,
  CreateSellerSchema,
  CreateVariantSchema,
  DiscoverQuerySchema,
  PageQuerySchema,
  ReorderImagesSchema,
  UpdateProductSchema,
  UpdateSellerSchema,
  UpdateExchangePolicySchema,
  UpdateShippingPolicySchema,
  UpdateStoreSchema,
  UpdateVariantSchema,
  type ChangeStoreSlugDto,
  type CreateProductDto,
  type CreateSellerDto,
  type CreateVariantDto,
  type DiscoverQueryDto,
  type PageQueryDto,
  type ReorderImagesDto,
  type UpdateProductDto,
  type UpdateSellerDto,
  type UpdateExchangePolicyDto,
  type UpdateShippingPolicyDto,
  type UpdateStoreDto,
  type UpdateVariantDto,
  DefinirOpcionesSchema,
  type DefinirOpcionesDto,
} from './dto/commerce.dto';
import { ImagesService } from './images.service';
import { ProductsService } from './products.service';
import { SellersService } from './sellers.service';

/**
 * API del bloque comercial.
 *
 * ─── Ningún endpoint recibe el id del dueño ───
 *
 * No hay `sellerId` ni `storeId` de propiedad en ningún cuerpo. La pertenencia
 * sale del usuario autenticado, siempre. Si un endpoint lo aceptara, alguien
 * podría mandar el de otro vendedor.
 *
 * Los ids que SÍ viajan en la URL —`:productId`, `:variantId`— se resuelven
 * filtrando por el dueño dentro del WHERE, así que un id ajeno devuelve 404.
 */
@Controller({ version: '1' })
export class CommerceController {
  constructor(
    private readonly sellers: SellersService,
    private readonly products: ProductsService,
    private readonly images: ImagesService,
  ) {}

  // ─── Vendedor ─────────────────────────────────────────────────────────────

  /**
   * Convertirse en vendedor. Crea el perfil y la tienda principal juntos.
   *
   * Con límite: crear vendedores en serie con slugs de marcas conocidas es una
   * forma barata de ocupar nombres para revenderlos o para hacerse pasar por
   * otro.
   */
  @RateLimit({ limit: 3, windowSec: 3600, bucket: 'seller:create' })
  @Post('sellers')
  createSeller(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateSellerSchema)) dto: CreateSellerDto,
  ) {
    return this.sellers.create(user.id, dto);
  }

  @Get('sellers/me')
  mySeller(@CurrentUser() user: AuthenticatedUser) {
    return this.sellers.me(user.id);
  }

  @Patch('sellers/me')
  updateSeller(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdateSellerSchema)) dto: UpdateSellerDto,
  ) {
    return this.sellers.update(user.id, dto);
  }

  /** Perfil público. Sin sesión: es una vidriera. */
  @Public()
  @Get('sellers/by-slug/:slug')
  sellerBySlug(@Param('slug') slug: string) {
    return this.sellers.publicBySlug(slug);
  }

  // ─── Tienda ───────────────────────────────────────────────────────────────

  @Get('stores/me')
  myStore(@CurrentUser() user: AuthenticatedUser) {
    return this.sellers.myStore(user.id);
  }

  @Patch('stores/:id')
  updateStore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateStoreSchema)) dto: UpdateStoreDto,
  ) {
    return this.sellers.updateStore(user.id, id, dto);
  }

  /** Endpoint aparte: cambiar el slug rompe los enlaces ya compartidos. */
  @Patch('stores/:id/slug')
  changeStoreSlug(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ChangeStoreSlugSchema)) dto: ChangeStoreSlugDto,
  ) {
    return this.sellers.changeStoreSlug(user.id, id, dto);
  }

  /**
   * Endpoint aparte: define plata que se le cobra a compradores reales.
   *
   * Ver el comentario largo en `UpdateShippingPolicySchema`.
   */
  @Patch('stores/:id/shipping')
  updateShippingPolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateShippingPolicySchema)) dto: UpdateShippingPolicyDto,
  ) {
    return this.sellers.updateShippingPolicy(user.id, id, dto);
  }

  /**
   * Endpoint aparte: define obligaciones frente a compradores reales.
   *
   * El piso legal —diez días de arrepentimiento— se aplica igual. Ver
   * `politicas.ts`.
   */
  @Patch('stores/:id/exchange-policy')
  updateExchangePolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateExchangePolicySchema)) dto: UpdateExchangePolicyDto,
  ) {
    return this.sellers.updateExchangePolicy(user.id, id, dto);
  }

  @Public()
  @Get('stores/by-slug/:slug')
  storeBySlug(@Param('slug') slug: string) {
    return this.sellers.storeBySlug(slug);
  }

  /** Vidriera pública: sólo productos activos. */
  @Public()
  @Get('stores/by-slug/:slug/products')
  publicProducts(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(PageQuerySchema)) query: PageQueryDto,
  ) {
    return this.products.listPublicByStore(slug, query);
  }

  // ─── Descubrimiento ───────────────────────────────────────────────────────

  /**
   * El feed. Público a propósito.
   *
   * Alguien que todavía no se registró tiene que poder ver qué se vende acá.
   * Pedir sesión para mirar la vidriera es la forma más rápida de no tener
   * usuarios: la cuenta se pide cuando quiere comprar, no antes.
   */
  @Public()
  @Get('discover/products')
  discover(@Query(new ZodValidationPipe(DiscoverQuerySchema)) query: DiscoverQueryDto) {
    return this.products.listDiscover(query);
  }

  // ─── Productos ────────────────────────────────────────────────────────────

  @Get('products/mine')
  myProducts(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(PageQuerySchema)) query: PageQueryDto,
  ) {
    return this.products.listMine(user.id, query);
  }

  @Post('products')
  createProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateProductSchema)) dto: CreateProductDto,
  ) {
    return this.products.create(user.id, dto);
  }

  @Get('products/:id')
  product(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.products.detail(user.id, id);
  }

  @Patch('products/:id')
  updateProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateProductSchema)) dto: UpdateProductDto,
  ) {
    return this.products.update(user.id, id, dto);
  }

  @Delete('products/:id')
  deleteProduct(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.products.softDelete(user.id, id);
  }

  // ─── Variantes ────────────────────────────────────────────────────────────

  /**
   * Define los ejes de variación y genera las combinaciones.
   *
   * `PUT` y no `PATCH`: se manda la definición completa y reemplaza. Editar de
   * a un eje dejaría estados intermedios donde el producto tiene talles pero
   * todavía no colores, y las variantes generadas en el medio serían basura.
   *
   * Las combinaciones que ya existían **conservan su stock**: se reconocen por
   * la huella de la combinación, no por su posición en la lista.
   */
  @Put('products/:productId/options')
  definirOpciones(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body(new ZodValidationPipe(DefinirOpcionesSchema)) dto: DefinirOpcionesDto,
  ) {
    return this.products.definirOpciones(user.id, productId, dto);
  }

  @Post('products/:productId/variants')
  createVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body(new ZodValidationPipe(CreateVariantSchema)) dto: CreateVariantDto,
  ) {
    return this.products.createVariant(user.id, productId, dto);
  }

  @Patch('products/:productId/variants/:variantId')
  updateVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body(new ZodValidationPipe(UpdateVariantSchema)) dto: UpdateVariantDto,
  ) {
    return this.products.updateVariant(user.id, productId, variantId, dto);
  }

  @Delete('products/:productId/variants/:variantId')
  deleteVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
  ) {
    return this.products.deleteVariant(user.id, productId, variantId);
  }

  // ─── Imágenes ─────────────────────────────────────────────────────────────

  /**
   * Sube una imagen.
   *
   * El archivo se lee del cuerpo multipart. El límite de tamaño lo aplica
   * Fastify ANTES de que el buffer llegue acá: sin eso, alguien puede mandar
   * 500 MB y el servidor los aloja en memoria antes de rechazarlos.
   */
  @RateLimit({ limit: 60, windowSec: 3600, bucket: 'product:image' })
  @Post('products/:productId/images')
  async uploadImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Req() req: FastifyRequest,
  ) {
    const archivo = await this.leerArchivo(req);
    return this.images.upload(user.id, productId, archivo);
  }

  @Delete('products/:productId/images/:imageId')
  deleteImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Param('imageId') imageId: string,
  ) {
    return this.images.remove(user.id, productId, imageId);
  }

  @Patch('products/:productId/images/reorder')
  reorderImages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body(new ZodValidationPipe(ReorderImagesSchema)) dto: ReorderImagesDto,
  ) {
    return this.images.reorder(user.id, productId, dto);
  }

  /**
   * Extrae el archivo de una petición multipart.
   *
   * `@fastify/multipart` expone `req.file()`. El `filename` que llega es del
   * cliente y **no se usa como ruta** — sólo se pasa para registro. El nombre
   * real lo genera `StorageProvider`.
   */
  private async leerArchivo(req: FastifyRequest): Promise<ArchivoSubido> {
    const conMultipart = req as FastifyRequest & {
      file?: () => Promise<{
        filename: string;
        mimetype: string;
        toBuffer: () => Promise<Buffer>;
      } | undefined>;
    };

    if (typeof conMultipart.file !== 'function') {
      throw new DomainError('INVALID_FILE', 'La petición no es multipart/form-data');
    }

    const parte = await conMultipart.file();
    if (!parte) throw new DomainError('INVALID_FILE', 'No se recibió ningún archivo');

    const buffer = await parte.toBuffer();
    if (buffer.length > MAX_BYTES) {
      throw new DomainError('FILE_TOO_LARGE', 'La imagen supera los 10 MB');
    }

    return { buffer, filename: parte.filename, mimetype: parte.mimetype };
  }
}
