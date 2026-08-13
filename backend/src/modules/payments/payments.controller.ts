import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { Public } from '@/modules/auth/auth.guard';
import { env } from '@/config/env.schema';
import { SpikeKeyGuard } from '@/modules/spike/spike-key.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import {
  CreateOrderSchema,
  PayOrderSchema,
  ReconcileSchema,
  SavedCardsQuerySchema,
  type CreateOrderDto,
  type PayOrderDto,
  type ReconcileDto,
  type SavedCardsQueryDto,
} from './dto/payments.dto';
import { PaymentsService } from './payments.service';

/**
 * API del spike de pagos.
 *
 * Protegida con la misma clave compartida que el spike de LiveKit, por el mismo
 * motivo: Auth todavía no existe y construirlo antes de validar que podemos
 * cobrar sería empezar la casa por el techo.
 *
 * El endpoint de webhooks NO está acá: vive en `MpWebhookController`, sin
 * guard, porque quien lo llama es Mercado Pago y su credencial es la firma.
 */
// Se protege con SpikeKeyGuard (clave compartida), no con sesión de usuario.
@Public()
@Controller({ path: 'payments', version: '1' })
@UseGuards(SpikeKeyGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Configuración que el teléfono necesita para tokenizar.
   *
   * Devuelve la PUBLIC KEY, que es pública por diseño: sólo sirve para crear
   * tokens de un solo uso. El access token jamás sale del backend.
   */
  @Get('config')
  config() {
    return {
      publicKey: env.MP_PUBLIC_KEY ?? null,
      notificationUrl: env.MP_NOTIFICATION_URL ?? null,
      currency: 'ARS',
    };
  }

  @Post('orders')
  createOrder(@Body(new ZodValidationPipe(CreateOrderSchema)) dto: CreateOrderDto) {
    return this.payments.createOrder(dto);
  }

  @Get('orders/:id')
  getOrder(@Param('id') id: string) {
    return this.payments.getOrder(id);
  }

  @Post('orders/:id/pay')
  payOrder(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PayOrderSchema)) dto: PayOrderDto,
  ) {
    return this.payments.payOrder(id, dto);
  }

  /**
   * Dispara la conciliación a mano.
   *
   * En producción es un trabajo periódico; acá se expone para poder demostrar
   * en la prueba de campo que una orden con el webhook perdido se resuelve
   * igual. Es uno de los criterios PASS/FAIL del sprint.
   */
  @Post('reconcile')
  reconcile(@Body(new ZodValidationPipe(ReconcileSchema)) dto: ReconcileDto) {
    return this.payments.reconcile(dto.olderThanMs, dto.releaseAfterMs);
  }

  @Get('cards')
  savedCards(@Query(new ZodValidationPipe(SavedCardsQuerySchema)) q: SavedCardsQueryDto) {
    return this.payments.listSavedCards(q.email);
  }
}
