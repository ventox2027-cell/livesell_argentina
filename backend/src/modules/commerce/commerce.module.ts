import { Module } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';
import { DomainEventBus } from '@/shared/events/domain-events';
import { LocalStorageProvider, StorageProvider } from '@/shared/storage/storage.provider';

import { CommerceController } from './commerce.controller';
import { ImagesService } from './images.service';
import { OwnershipService } from './ownership.service';
import { ProductsService } from './products.service';
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
 * Se elige acá y en ningún otro lado. Los servicios dependen de la clase
 * abstracta `StorageProvider`; cambiar disco por R2 es cambiar esta línea.
 */
@Module({
  controllers: [CommerceController],
  providers: [
    SellersService,
    ProductsService,
    ImagesService,
    OwnershipService,
    AuditService,
    DomainEventBus,
    LocalStorageProvider,
    {
      provide: StorageProvider,
      // Hoy siempre local. Cuando existan las credenciales de R2, acá se elige
      // según el entorno y ningún servicio se entera.
      useExisting: LocalStorageProvider,
    },
  ],
  exports: [OwnershipService, ProductsService, SellersService],
})
export class CommerceModule {}
