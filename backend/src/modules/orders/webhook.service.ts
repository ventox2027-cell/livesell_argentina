import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PaymentAttemptStatus } from '@prisma/client';

import { env } from '@/config/env.schema';
import { asString, verifyMpSignature } from '@/modules/payments/mp-signature';
import { scrubMpPayment } from '@/modules/payments/mp.client';
import { MetricsService } from '@/shared/observability/metrics.service';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { PaymentProvider, ProviderPaymentNotFoundError } from './payment-provider';
import { OrderPaymentsService } from './payments.service';

/**
 * Notificaciones de Mercado Pago, en producción.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UN WEBHOOK FIRMADO ES UN AVISO, NO UNA VERDAD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La firma HMAC prueba que el mensaje viene de Mercado Pago y que no lo
 * tocaron. **No prueba que su contenido siga siendo cierto.**
 *
 * Un aviso puede llegar reordenado —`approved` y después `pending` del mismo
 * pago, porque el reintento del primero se demoró más que el segundo envío— o
 * media hora tarde. Por eso el cuerpo se usa para saber QUÉ mirar, y el estado
 * se consulta contra la API.
 *
 * Es la misma regla del spike y se conserva entera: el estado del payload
 * nunca se aplica directamente.
 *
 * ─── Cuatro defensas, en orden ───
 *
 *   1. Firma HMAC con manifiesto y tolerancia de tiempo.
 *   2. Deduplicación por índice único sobre el id de notificación.
 *   3. Consulta a la API para saber el estado real.
 *   4. Transición monotónica: la orden nunca retrocede.
 */
@Injectable()
export class OrdersWebhookService {
  private readonly logger = new Logger(OrdersWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
    private readonly payments: OrderPaymentsService,
    private readonly metrics: MetricsService,
  ) {}

  async recibir(params: {
    headers: Record<string, unknown>;
    query: Record<string, string | undefined>;
    body: Record<string, unknown>;
    rawBody?: Buffer;
  }): Promise<{ status: string; detail?: string }> {
    const { headers, query, body } = params;

    const topic = asString(body.type) ?? asString(body.topic) ?? 'unknown';
    const action = asString(body.action);
    const resourceId =
      asString((body.data as Record<string, unknown> | undefined)?.id) ??
      asString(query['data.id']) ??
      asString(query.id);

    /**
     * Id de la notificación, para deduplicar.
     *
     * Mercado Pago no siempre manda uno propio. Cuando falta se compone uno
     * estable con lo que identifica el hecho: el mismo aviso reenviado produce
     * la misma clave y choca contra el índice único.
     *
     * Sin esto, un reintento de Mercado Pago volvería a ejecutar toda la
     * lógica — que es idempotente igual, pero hacerlo dos veces cuesta una
     * llamada a su API por cada reintento.
     */
    const notificationId =
      asString(body.id) ?? `${topic}:${action ?? 'na'}:${resourceId ?? 'na'}`;

    const firma = verifyMpSignature({
      xSignature: asString(headers['x-signature']),
      xRequestId: asString(headers['x-request-id']),
      dataId: resourceId,
      // Sin clave configurada, la verificación devuelve `NO_SECRET_CONFIGURED`
      // y la notificación se rechaza. Es el comportamiento correcto: aceptar
      // webhooks sin firmar porque falta una variable de entorno sería dejar
      // que cualquiera declare pagos.
      secret: env.MP_WEBHOOK_SECRET ?? '',
    });

    // Se registra ANTES de procesar y con el resultado de la firma. Una
    // notificación rechazada también deja rastro: sin eso, depurar en
    // producción es adivinar.
    const eventId = newId('mpw');
    try {
      await this.prisma.mpWebhookEvent.create({
        data: {
          id: eventId,
          notificationId,
          topic,
          action,
          resourceId,
          signatureValid: firma.valid,
          rejectionReason: firma.valid ? null : (firma.reason ?? 'DESCONOCIDO'),
          headers: this.cabecerasSeguras(headers),
          payload: scrubMpPayment(body) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Ya lo procesamos. El índice único hizo la deduplicación sin que la
        // lógica llegara a ejecutarse.
        this.metrics.webhookReceived.inc({ provider: 'mercadopago', event: topic, result: 'duplicate' });
        return { status: 'DUPLICATE' };
      }
      throw err;
    }

    if (!firma.valid) {
      this.metrics.webhookReceived.inc({
        provider: 'mercadopago',
        event: topic,
        result: 'invalid_signature',
      });
      this.logger.warn({ msg: 'webhook con firma inválida', motivo: firma.reason, topic });
      // 200 igual: un 401 haría que Mercado Pago reintentara en bucle algo que
      // nunca vamos a aceptar.
      return { status: 'INVALID_SIGNATURE', detail: firma.reason };
    }

    // Sólo interesan los avisos de pagos.
    if (topic !== 'payment' || !resourceId) {
      await this.marcarProcesado(eventId);
      this.metrics.webhookReceived.inc({ provider: 'mercadopago', event: topic, result: 'ignored' });
      return { status: 'IGNORED' };
    }

    return this.procesarPago(eventId, resourceId, topic);
  }

  /**
   * Consulta el pago y lo aplica.
   *
   * ─── Por qué se busca el intento por `providerPaymentId` ───
   *
   * El aviso trae el id del pago según Mercado Pago, no el nuestro. Ese id se
   * guarda en el intento cuando se cobra, así que alcanza para encontrarlo.
   *
   * Si no aparece, se usa `external_reference` —nuestro id de orden— que viaja
   * en cada cobro justamente para este caso: cuando la red se cortó antes de
   * que pudiéramos guardar el id del pago.
   */
  private async procesarPago(
    eventId: string,
    providerPaymentId: string,
    topic: string,
  ): Promise<{ status: string; detail?: string }> {
    let pago;
    try {
      pago = await this.provider.consultar(providerPaymentId);
    } catch (err) {
      if (err instanceof ProviderPaymentNotFoundError) {
        /**
         * El simulador de Mercado Pago manda ids inventados.
         *
         * Se archiva con 200: reintentarlo no va a cambiar nada, y devolver un
         * error haría que insistieran con una notificación que no existe.
         */
        await this.marcarProcesado(eventId, 'UNKNOWN_PAYMENT');
        this.metrics.webhookReceived.inc({
          provider: 'mercadopago',
          event: topic,
          result: 'unknown_payment',
        });
        return { status: 'UNKNOWN_PAYMENT' };
      }

      /**
       * Falló NUESTRA consulta, no el aviso.
       *
       * Este es el único caso donde conviene que Mercado Pago reintente: el
       * aviso era bueno y el problema es transitorio de este lado. Se propaga
       * para que el controlador devuelva 5xx.
       */
      await this.marcarProcesado(eventId, err instanceof Error ? err.message : String(err));
      throw err;
    }

    const intento = await this.prisma.paymentAttempt.findFirst({
      where: {
        OR: [
          { providerPaymentId: String(pago.id) },
          // Cuando nunca llegamos a guardar el id del pago.
          ...(pago.externalReference
            ? [
                {
                  orderId: pago.externalReference,
                  status: {
                    in: [
                      'CREATED',
                      'PROCESSING',
                      'UNKNOWN_PENDING_RECONCILIATION',
                    ] satisfies PaymentAttemptStatus[],
                  },
                },
              ]
            : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (!intento) {
      /**
       * Un pago sin intento nuestro.
       *
       * Pasa con los pagos de prueba que alguien crea desde el panel de
       * Mercado Pago. Se archiva con 200 en vez de reventar: en el spike este
       * caso producía un 500 por violación de clave foránea.
       */
      await this.marcarProcesado(eventId, 'ORPHAN');
      this.metrics.webhookReceived.inc({ provider: 'mercadopago', event: topic, result: 'orphan' });
      return { status: 'ORPHAN' };
    }

    const resultado = await this.payments.aplicarResultado(intento.id, pago, 'webhook');

    await this.marcarProcesado(eventId);
    this.metrics.webhookReceived.inc({ provider: 'mercadopago', event: topic, result: 'processed' });

    return { status: resultado.attempt.status, detail: resultado.orderStatus };
  }

  private async marcarProcesado(eventId: string, error?: string): Promise<void> {
    await this.prisma.mpWebhookEvent.update({
      where: { id: eventId },
      data: { processedAt: new Date(), error: error ?? null },
    });
  }

  /**
   * Sólo las cabeceras que sirven para depurar.
   *
   * Enumeradas y no filtradas: guardar todas metería `authorization` y
   * cualquier cookie en una tabla que se lee entera cuando se investiga algo.
   */
  private cabecerasSeguras(headers: Record<string, unknown>): Prisma.InputJsonValue {
    const permitidas = ['x-signature', 'x-request-id', 'user-agent', 'content-type'];
    const salida: Record<string, string> = {};
    for (const clave of permitidas) {
      const valor = asString(headers[clave]);
      if (valor) salida[clave] = valor;
    }
    return salida;
  }
}
