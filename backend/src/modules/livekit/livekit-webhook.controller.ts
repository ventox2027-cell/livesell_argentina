import { Controller, Headers, HttpCode, Logger, Post, Req, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { newId } from '@/shared/utils/id';
import { MetricsService } from '@/shared/observability/metrics.service';
import { PrismaService } from '@/shared/prisma/prisma.service';

import { LiveKitService } from './livekit.service';

/**
 * Receptor de webhooks de LiveKit.
 *
 * Sigue las mismas cinco reglas que aplicaremos con Mercado Pago
 * (blueprint/09-pagos-mercadopago.md §5). Vale la pena estrenarlas acá, donde
 * un error no cuesta dinero:
 *
 *   1. Verificar la firma ANTES de mirar el cuerpo.
 *   2. Deduplicar por id de evento del proveedor (UNIQUE en la base).
 *   3. Responder rápido; el trabajo pesado va a una cola.
 *   4. No confiar en el cuerpo para decisiones importantes.
 *   5. Procesamiento idempotente.
 */
// VERSION_NEUTRAL: /webhooks/livekit. La URL se carga a mano en el panel de
// LiveKit; si mañana saliera /api/v2/, nadie va a ir a actualizarla.
@Controller({ path: 'webhooks', version: VERSION_NEUTRAL })
export class LiveKitWebhookController {
  private readonly logger = new Logger(LiveKitWebhookController.name);

  constructor(
    private readonly livekit: LiveKitService,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  @Post('livekit')
  @HttpCode(200)
  async handle(
    @Req() req: FastifyRequest,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ received: boolean }> {
    // rawBody lo provee Nest (opción `rawBody: true` en main.ts) para
    // application/json, y el parser propio de main.ts para
    // application/webhook+json, que es el que usa LiveKit.
    // La firma se calcula sobre los bytes exactos: reserializar la invalidaría.
    const raw = (req as FastifyRequest & { rawBody?: Buffer | string }).rawBody;
    const rawBody = typeof raw === 'string' ? raw : (raw?.toString('utf8') ?? '');

    // ── Regla 1: firma ──
    if (!authHeader) {
      this.metrics.webhookReceived.inc({ provider: 'livekit', event: 'unknown', result: 'no_signature' });
      this.logger.warn({ ip: req.ip }, 'webhook de LiveKit sin firma');
      return { received: false };
    }

    let event: Awaited<ReturnType<LiveKitService['verifyWebhook']>>;
    try {
      event = await this.livekit.verifyWebhook(rawBody, authHeader);
    } catch (err) {
      this.metrics.webhookReceived.inc({ provider: 'livekit', event: 'unknown', result: 'bad_signature' });
      this.logger.warn({ err, ip: req.ip }, 'firma de webhook de LiveKit inválida');
      // 200 a propósito: si devolviéramos 401, LiveKit reintentaría en bucle
      // un evento que nunca vamos a aceptar.
      return { received: false };
    }

    const eventId = event.id ?? `${event.event}:${event.createdAt ?? Date.now()}`;

    // ── Regla 2: deduplicar. El UNIQUE de la base es la garantía real. ──
    try {
      await this.prisma.livekitWebhookEvent.create({
        data: {
          id: newId('whk'),
          eventId,
          event: event.event,
          roomName: event.room?.name ?? null,
          participantId: event.participant?.identity ?? null,
          payload: JSON.parse(rawBody) as object,
          signatureValid: true,
          processedAt: new Date(),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.metrics.webhookReceived.inc({ provider: 'livekit', event: event.event, result: 'duplicate' });
        return { received: true }; // ya lo vimos, no es un error
      }
      throw err;
    }

    this.metrics.webhookReceived.inc({ provider: 'livekit', event: event.event, result: 'ok' });
    this.logger.log(
      { event: event.event, room: event.room?.name, participant: event.participant?.identity },
      'webhook de LiveKit procesado',
    );

    // ── Regla 3: responder rápido. En Sprint 0 solo persistimos: el ciclo de
    // vida real del live (LiveSession → LIVE/ENDED) llega con su módulo. ──
    return { received: true };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002';
}
