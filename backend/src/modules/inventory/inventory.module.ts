import { Module } from '@nestjs/common';

import { CommerceModule } from '@/modules/commerce/commerce.module';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainEventBus } from '@/shared/events/domain-events';

import { ExpirationQueue } from './expiration.queue';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { InventoryReconciler } from './reconciler.service';

/**
 * Inventario y reservas.
 *
 * Importa `CommerceModule` por `OwnershipService`: el inventario nunca
 * resuelve la pertenencia por su cuenta. Que exista un solo lugar donde se
 * decide "¿esto es tuyo?" es lo que hace que la regla no se implemente
 * distinta en cada módulo.
 *
 * `InventoryService` se exporta porque Orders lo va a necesitar para
 * `consume()` cuando un pago se acredite.
 */
@Module({
  imports: [CommerceModule],
  controllers: [InventoryController],
  providers: [
    InventoryService,
    ExpirationQueue,
    InventoryReconciler,
    // Sin estado: cada módulo tiene su instancia y da igual. Hacerlos globales
    // por comodidad escondería quién audita y quién publica eventos.
    AuditService,
    DomainEventBus,
  ],
  exports: [InventoryService],
})
export class InventoryModule {}
