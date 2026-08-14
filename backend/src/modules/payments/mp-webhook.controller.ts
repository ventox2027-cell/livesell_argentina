import { Controller, HttpCode, Logger, Post, Req, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { Public } from '@/modules/auth/auth.guard';
import { RUTA_WEBHOOK_SPIKE } from '@/shared/http/rutas-webhook';
import { MetricsService } from '@/shared/observability/metrics.service';

import { asString } from './mp-signature';
import { PaymentsService } from './payments.service';

/**
 * ⚠️ WEBHOOK DEL SPIKE. **NO ES EL DE PRODUCCIÓN.**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO CARGAR ESTA URL EN EL PANEL DE MERCADO PAGO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El webhook productivo es `OrdersWebhookController`, en
 * `modules/orders/orders.controller.ts`, sobre la ruta
 * `POST /webhooks/orders/mercadopago` — la constante
 * `RUTA_WEBHOOK_MERCADOPAGO` de `shared/http/rutas-webhook.ts`. Éste opera
 * sobre `SpikeOrder`, una tabla que el flujo real de pedidos no usa.
 *
 * Existe sólo para que `payments-flow.spec.ts` siga cubriendo el spike. El
 * módulo entero está detrás de `PAYMENTS_SPIKE_ENABLED`, y `env.schema.ts`
 * impide que esa bandera sea `true` en producción: esta ruta **no puede
 * existir** en el entorno real.
 *
 * ─── Por qué la URL dice "spike" ───
 *
 * Antes vivía en `webhooks/mercadopago`: la más corta, la más obvia y la más
 * creíble de las dos. Era la que alguien iba a pegar en el panel por error, y
 * habría acreditado pagos contra la tabla equivocada. El segmento está en la
 * ruta para que ese error sea imposible de cometer distraído.
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
// VERSION_NEUTRAL para que la ruta coincida con la exclusión del prefijo, que
// vive en `http-setup.ts`. Quien llama es Mercado Pago; su credencial es la
// firma HMAC.
@Public()
@Controller({ path: RUTA_WEBHOOK_SPIKE, version: VERSION_NEUTRAL })
export class MpWebhookController {
  private readonly logger = new Logger(MpWebhookController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly metrics: MetricsService,
  ) {}

  // La ruta completa está en el @Controller.
  @Post()
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
