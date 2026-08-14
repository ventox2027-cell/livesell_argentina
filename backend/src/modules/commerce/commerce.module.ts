import { Module } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';
import { DomainEventBus } from '@/shared/events/domain-events';

import { CommerceController } from './commerce.controller';
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
  controllers: [CommerceController],
  providers: [
    SellersService,
    ProductsService,
    SearchService,
    ImagesService,
    OwnershipService,
    AuditService,
    DomainEventBus,
  ],
  exports: [OwnershipService, ProductsService, SellersService],
})
export class CommerceModule {}
