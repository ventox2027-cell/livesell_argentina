import { Controller, HttpCode, Logger, Post, Req, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { Public } from '@/modules/auth/auth.guard';
import { MetricsService } from '@/shared/observability/metrics.service';

import { asString } from './mp-signature';
import { PaymentsService } from './payments.service';

/**
 * Receptor de notificaciones de Mercado Pago.
 *
 * ─── Sin guard, a propósito ───
 *
 * Quien llama es Mercado Pago, que no tiene nuestra clave compartida. Su
 * credencial es la firma HMAC, que se verifica dentro de `handleWebhook`.
 * Poner el `SpikeKeyGuard` acá haría que ninguna notificación entrara nunca.
 *
 * ─── Siempre 200 ───
 *
 * Incluso ante una firma inválida. Un 401 haría que Mercado Pago reintentara
 * en bucle una notificación que jamás vamos a aceptar, y un 500 haría que
 * reintentara una que ya procesamos. El único caso en que conviene un error es
 * cuando el fallo es NUESTRO y transitorio —la API de Mercado Pago no responde
 * al consultar el estado—: ahí sí queremos el reintento.
 */
// VERSION_NEUTRAL: la URL se carga a mano en el panel de Mercado Pago. Si
// mañana saliera /api/v2/, nadie va a ir a actualizarla.
// Quien llama es Mercado Pago. Su credencial es la firma HMAC.
@Public()
@Controller({ path: 'webhooks', version: VERSION_NEUTRAL })
export class MpWebhookController {
  private readonly logger = new Logger(MpWebhookController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly metrics: MetricsService,
  ) {}

  @Post('mercadopago')
  @HttpCode(200)
  async handle(@Req() req: FastifyRequest): Promise<{ received: boolean; status?: string }> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    // Etiqueta de métrica: acotada a valores conocidos para que un cuerpo
    // hostil no pueda hacer explotar la cardinalidad de Prometheus.
    const topic = asString(body.type) ?? asString(body.topic) ?? 'unknown';

    try {
      const result = await this.payments.handleWebhook({ headers: req.headers, query, body });

      this.metrics.webhookReceived.inc({
        provider: 'mercadopago',
        event: topic,
        result: result.status.toLowerCase(),
      });

      if (result.status === 'INVALID_SIGNATURE') {
        this.logger.warn({ ip: req.ip, reason: result.reason }, 'notificación con firma inválida');
        return { received: false, status: result.status };
      }

      return { received: true, status: result.status };
    } catch (err) {
      /**
       * Único caso en el que devolvemos error: el fallo es nuestro y es
       * transitorio (no pudimos consultar el estado contra Mercado Pago).
       * Queremos que reintente, porque la notificación es legítima y todavía
       * no la procesamos.
       */
      this.metrics.webhookReceived.inc({
        provider: 'mercadopago',
        event: topic,
        result: 'error',
      });
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'fallo procesando la notificación; se pide reintento',
      );
      throw err;
    }
  }
}
