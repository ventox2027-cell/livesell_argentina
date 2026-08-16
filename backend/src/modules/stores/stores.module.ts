import { Module } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';

import { ReaperturasService } from './reaperturas.service';
import { StoresController } from './stores.controller';
import { DomainEventBus } from '@/shared/events/domain-events';

import { StoresService } from './stores.service';

/**
 * Tiendas: horarios, seguidores, reseñas y perfil público.
 *
 * Las cuatro responden la misma pregunta desde ángulos distintos —¿le compro a
 * esta persona?— y comparten las mismas entidades, así que separarlas en cuatro
 * módulos sería repetir las mismas dependencias cuatro veces.
 */
@Module({
  controllers: [StoresController],
  providers: [StoresService, ReaperturasService, AuditService, DomainEventBus],
  exports: [StoresService, ReaperturasService],
})
export class StoresModule {}
