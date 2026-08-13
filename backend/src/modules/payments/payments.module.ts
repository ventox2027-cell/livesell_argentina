import { Module } from '@nestjs/common';

import { SpikeKeyGuard } from '@/modules/spike/spike-key.guard';

import { CheckoutPageController } from './checkout-page.controller';
import { MercadoPagoService } from './mp.client';
import { MpWebhookController } from './mp-webhook.controller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Módulo del Sprint 0B.
 *
 * Se registra solo si PAYMENTS_SPIKE_ENABLED=true, y env.schema.ts impide que
 * eso ocurra en producción o sin credenciales de prueba.
 *
 * A diferencia del spike de LiveKit, este código NO se borra del todo cuando
 * termine el sprint: `mp-signature.ts`, `order-state.ts` y el saneado de
 * `mp.client.ts` son la base del módulo de pagos real. Lo que se descarta es
 * el controlador de spike y las tablas `spike_*`.
 */
@Module({
  controllers: [PaymentsController, MpWebhookController, CheckoutPageController],
  providers: [PaymentsService, MercadoPagoService, SpikeKeyGuard],
  exports: [PaymentsService],
})
export class PaymentsModule {}
