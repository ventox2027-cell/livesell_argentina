import { Module } from '@nestjs/common';

import { SellerOAuthModule } from '@/modules/payments/seller-oauth.module';
import { SellersModule } from '@/modules/sellers/sellers.module';

import { AuditService } from '@/shared/audit/audit.service';
import { DomainEventBus } from '@/shared/events/domain-events';

import { CommerceController } from './commerce.controller';
import { CuponesDelCompradorController, CuponesDelVendedorController } from './cupones.controller';
import { CuponesService } from './cupones.service';
import { PromocionesController } from './promociones.controller';
import { PromocionesService } from './promociones.service';
import { CategoriasService } from './categorias.service';
import { ImagesService } from './images.service';
import { OwnershipService } from './ownership.service';
import { ProductsService } from './products.service';
import { SearchService } from './search.service';
import { SellersService } from './sellers.service';

/**
 * Bloque comercial: vendedores, tiendas, productos, variantes e imágenes.
 *
 * Un solo módulo para las cinco entidades porque son una sola jerarquía de
 * pertenencia —`User → Seller → Store → Product → Variant/Image`— y separarlas
 * obligaría a que cada una importara `OwnershipService` de otro módulo para
 * hacer exactamente lo mismo.
 *
 * ─── El proveedor de almacenamiento ───
 *
 * No se elige acá: lo inyecta `StorageModule`, que es global. `ImagesService`
 * depende de la clase abstracta `StorageProvider` y no tiene forma de saber si
 * detrás hay un disco o Cloudflare — que es lo que permite que sus tests
 * corran sin credenciales y sin red.
 */
@Module({
  // Para exigir Mercado Pago conectado antes de publicar. Ver `puede-vender.ts`.
  // `SellersModule` por las membresías: los cupones son función de VendoX Pro.
  imports: [SellerOAuthModule, SellersModule],
  controllers: [
    CommerceController,
    CuponesDelVendedorController,
    CuponesDelCompradorController,
    PromocionesController,
  ],
  providers: [
    SellersService,
    ProductsService,
    CategoriasService,
    SearchService,
    ImagesService,
    OwnershipService,
    CuponesService,
    PromocionesService,
    AuditService,
    DomainEventBus,
  ],
  exports: [OwnershipService, ProductsService, SellersService, CategoriasService, CuponesService, PromocionesService],
})
export class CommerceModule {}
