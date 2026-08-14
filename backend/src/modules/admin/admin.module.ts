import { Module } from '@nestjs/common';

import { OrdersModule } from '@/modules/orders/orders.module';
import { AuditService } from '@/shared/audit/audit.service';

import { AdminSearchService } from './admin-search.service';
import { AdminTimelineService } from './admin-timeline.service';
import { AdminController } from './admin.controller';
import { AdminMetrics } from './admin.metrics';
import { AdminService } from './admin.service';

/**
 * El panel de administración.
 *
 * Importa `OrdersModule` para reutilizar `OrderPaymentsService` y
 * `OrdersReconciler`: conciliar un pago o reintentar una devolución desde el
 * panel usa **exactamente la misma lógica** que corre en el worker. Un segundo
 * camino con criterios propios sería dos sistemas que el día que difieran
 * dejan a nadie sabiendo cuál tiene razón.
 */
@Module({
  imports: [OrdersModule],
  controllers: [AdminController],
  providers: [AdminService, AdminSearchService, AdminTimelineService, AdminMetrics, AuditService],
})
export class AdminModule {}
