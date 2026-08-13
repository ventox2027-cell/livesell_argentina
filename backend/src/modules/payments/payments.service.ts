import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PayOrderStatus, type PaySource } from '@prisma/client';

import { env, isLocalEnv } from '@/config/env.schema';
import {
  MercadoPagoService,
  MpApiError,
  MpNetworkError,
  scrubMpPayment,
  type MpPayment,
} from '@/modules/payments/mp.client';
import { asString, diagnoseSignature, verifyMpSignature } from '@/modules/payments/mp-signature';
import {
  describePaymentOutcome,
  MENSAJE_INCIERTO,
} from '@/modules/payments/payment-messages';
import {
  amountToCents,
  canAttemptPayment,
  centsToAmount,
  mapMpStatus,
  nextOrderStatus,
  paymentIdempotencyKey,
} from '@/modules/payments/order-state';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

export class OrderNotFoundError extends DomainError {
  constructor(id: string) {
    super('ORDER_NOT_FOUND', 'Orden no encontrada', { orderId: id });
  }
}

export class OrderNotPayableError extends DomainError {
  constructor(status: PayOrderStatus) {
    super('ORDER_NOT_PAYABLE', 'La orden no admite un nuevo intento de cobro', { status });
  }
}

export interface CreateOrderInput {
  idempotencyKey: string;
  buyerEmail: string;
  description: string;
  amountCents: number;
}

/**
 * Cuánto se espera antes de liberar una orden en PROCESSING para la que
 * Mercado Pago no registra ningún pago.
 *
 * Cinco minutos: holgado para que un cobro en vuelo aparezca en la búsqueda, y
 * corto para que un comprador no quede esperando frente a una orden trabada.
 */
export const RELEASE_AFTER_MS = 5 * 60_000;

export interface PayOrderInput {
  /** Token de un solo uso generado en el cliente. No se persiste jamás. */
  token: string;
  paymentMethodId: string;
  installments: number;
  issuerId?: string;
  /** Guardar el medio de pago para la segunda compra en dos clics. */
  saveCard?: boolean;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mp: MercadoPagoService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Órdenes
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Crea una orden, o devuelve la que ya existe con la misma clave.
   *
   * La idempotencia se apoya en el índice UNIQUE de `idempotency_key`, no en un
   * "buscar y si no existe crear": ese patrón tiene una ventana de carrera
   * entre las dos consultas por la que se cuelan dos órdenes cuando el
   * comprador toca dos veces. Acá la carrera la resuelve el motor y nosotros
   * sólo atrapamos la violación de unicidad.
   */
  async createOrder(input: CreateOrderInput) {
    try {
      const order = await this.prisma.spikeOrder.create({
        data: {
          id: newId('ord'),
          idempotencyKey: input.idempotencyKey,
          buyerEmail: input.buyerEmail,
          description: input.description,
          amountCents: input.amountCents,
        },
      });
      await this.audit(order.id, 'API', 'order.created', null, order.status, {
        amountCents: input.amountCents,
      });
      return { order, reused: false };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.spikeOrder.findUniqueOrThrow({
          where: { idempotencyKey: input.idempotencyKey },
        });
        this.logger.log({ msg: 'orden reutilizada por idempotencia', orderId: existing.id });
        return { order: existing, reused: true };
      }
      throw err;
    }
  }

  async getOrder(orderId: string) {
    const order = await this.prisma.spikeOrder.findUnique({
      where: { id: orderId },
      include: {
        payments: { orderBy: { createdAt: 'desc' } },
        events: { orderBy: { at: 'asc' } },
      },
    });
    if (!order) throw new OrderNotFoundError(orderId);
    return order;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Cobro
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Intenta cobrar una orden.
   *
   * El corazón del spike. Los tres caminos importan por igual:
   *
   *   · Mercado Pago responde aprobado  → orden PAID.
   *   · Mercado Pago responde rechazado → orden FAILED, con el motivo.
   *   · No sabemos qué respondió        → orden PROCESSING, y que el
   *                                       conciliador averigüe.
   *
   * El tercero es el que separa una integración seria de una que pierde plata.
   */
  async payOrder(orderId: string, input: PayOrderInput) {
    const order = await this.prisma.spikeOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new OrderNotFoundError(orderId);
    if (!canAttemptPayment(order.status)) throw new OrderNotPayableError(order.status);

    /**
     * Clave por INTENTO, derivada del token de tarjeta. La explicación
     * completa —y el incidente que la motivó— está en `paymentIdempotencyKey`.
     *
     * En corto: si fuera por orden, reintentar con otra tarjeta devolvería la
     * respuesta guardada del intento anterior y la orden quedaría condenada.
     */
    const idempotencyKey = paymentIdempotencyKey(order.id, input.token);

    // La orden se mueve a PROCESSING ANTES de llamar. Si el proceso se muere
    // en el medio, queda el rastro de que había un cobro en vuelo.
    await this.transition(order.id, order.status, 'PROCESSING', 'API', 'payment.attempt', {
      idempotencyKey,
    });

    let mpPayment: MpPayment;
    try {
      mpPayment = await this.mp.createPayment(
        {
          token: input.token,
          transactionAmount: centsToAmount(order.amountCents),
          installments: input.installments,
          paymentMethodId: input.paymentMethodId,
          payerEmail: order.buyerEmail,
          description: order.description,
          externalReference: order.id,
          issuerId: input.issuerId,
        },
        idempotencyKey,
      );
    } catch (err) {
      if (err instanceof MpNetworkError) {
        /**
         * NO se marca FAILED. Es la regla más importante del módulo.
         *
         * Un timeout no dice que el cobro falló: dice que no sabemos. El pago
         * puede estar perfectamente creado del lado de Mercado Pago. Si acá
         * pusiéramos FAILED, el comprador vería "rechazado", pagaría de nuevo
         * y terminaría con dos cobros por un producto.
         */
        await this.audit(order.id, 'API', 'payment.network_error', 'PROCESSING', 'PROCESSING', {
          error: err.message,
        });
        this.logger.error({
          msg: 'no se supo el resultado del cobro; queda para el conciliador',
          orderId: order.id,
        });
        return {
          order: await this.prisma.spikeOrder.findUniqueOrThrow({ where: { id: order.id } }),
          outcome: 'UNKNOWN' as const,
          message: MENSAJE_INCIERTO.text,
          remedy: MENSAJE_INCIERTO.remedy,
        };
      }

      // 4xx: Mercado Pago sí respondió, y respondió que no.
      if (err instanceof MpApiError) {
        await this.transition(order.id, 'PROCESSING', 'FAILED', 'API', 'payment.rejected', {
          status: err.status,
          body: scrubMpPayment(err.body),
        });
        /**
         * El mensaje que sale hacia la app es el TRADUCIDO, no el de Mercado
         * Pago. "invalid card_number_validation" es correcto, preciso e
         * inútil para quien está comprando. El código técnico igual queda en
         * la auditoría, que es donde sirve.
         */
        const explicacion = describePaymentOutcome({ errorBody: err.body });
        return {
          order: await this.prisma.spikeOrder.findUniqueOrThrow({ where: { id: order.id } }),
          outcome: 'REJECTED' as const,
          message: explicacion.text,
          remedy: explicacion.remedy,
        };
      }
      throw err;
    }

    const applied = await this.applyMpPayment(order.id, mpPayment, 'API');

    if (input.saveCard && applied.paymentStatus === 'APPROVED') {
      // Falla silenciosa a propósito: que no se pueda guardar la tarjeta no
      // puede tumbar un cobro que ya se acreditó.
      await this.saveCardSafely(order.buyerEmail, mpPayment);
    }

    // También cuando el banco rechaza: `cc_rejected_insufficient_amount` le
    // dice tan poco a un comprador como el código de validación.
    const explicacion = describePaymentOutcome({ statusDetail: mpPayment.status_detail });

    return {
      order: applied.order,
      outcome: 'RESOLVED' as const,
      payment: applied.payment,
      message: explicacion.text,
      remedy: explicacion.remedy,
    };
  }

  /**
   * Escribe en nuestra base el estado que reportó Mercado Pago.
   *
   * Único punto por el que pasan TODOS los cambios de estado de un pago, vengan
   * de la API, de un webhook o del conciliador. Tener un solo camino es lo que
   * hace que la garantía de monotonía valga: si hubiera dos, alcanzaría con que
   * uno se olvidara de la guarda.
   */
  private async applyMpPayment(orderId: string, mpPayment: MpPayment, source: PaySource) {
    const paymentStatus = mapMpStatus(mpPayment.status);
    const scrubbed = scrubMpPayment(mpPayment);

    const payment = await this.prisma.spikePayment.upsert({
      where: { mpPaymentId: String(mpPayment.id) },
      create: {
        id: newId('pay'),
        orderId,
        mpPaymentId: String(mpPayment.id),
        status: paymentStatus,
        statusDetail: mpPayment.status_detail ?? null,
        amountCents: amountToCents(mpPayment.transaction_amount ?? 0),
        installments: mpPayment.installments ?? 1,
        paymentMethodId: mpPayment.payment_method_id ?? null,
        paymentTypeId: mpPayment.payment_type_id ?? null,
        cardLastFour: mpPayment.card?.last_four_digits ?? null,
        cardBrand: mpPayment.payment_method_id ?? null,
        rawResponse: scrubbed as Prisma.InputJsonValue,
      },
      update: {
        status: paymentStatus,
        statusDetail: mpPayment.status_detail ?? null,
        rawResponse: scrubbed as Prisma.InputJsonValue,
      },
    });

    const current = await this.prisma.spikeOrder.findUniqueOrThrow({ where: { id: orderId } });
    const decision = nextOrderStatus(current.status, paymentStatus);

    if (!decision.changed) {
      await this.audit(orderId, source, 'payment.no_change', current.status, current.status, {
        mpStatus: mpPayment.status,
        reason: decision.ignoredReason,
      });
      return { order: current, payment, paymentStatus };
    }

    const order = await this.transition(
      orderId,
      current.status,
      decision.status,
      source,
      'payment.status_changed',
      { mpPaymentId: String(mpPayment.id), mpStatus: mpPayment.status },
    );

    return { order, payment, paymentStatus };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Webhooks
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Procesa una notificación de Mercado Pago.
   *
   * Cuatro barreras, en este orden:
   *   1. Firma HMAC válida y fresca.
   *   2. UNIQUE sobre el id de notificación: el duplicado ni siquiera ejecuta.
   *   3. El estado se consulta contra la API, nunca se lee del cuerpo.
   *   4. La transición pasa por la guarda de monotonía.
   *
   * La tercera es la que hace que un webhook falsificado sea inofensivo: aunque
   * alguien lograra firmar, lo único que consigue es que le preguntemos a
   * Mercado Pago, que va a decir la verdad.
   */
  async handleWebhook(params: {
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, string | undefined>;
    body: Record<string, unknown>;
  }) {
    const header = (name: string): string | undefined => {
      const v = params.headers[name] ?? params.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };

    // `data.id` sale de la QUERY STRING. Tomarlo del cuerpo funciona con el
    // simulador del panel y falla con las notificaciones reales.
    const bodyData = params.body.data as Record<string, unknown> | undefined;
    const dataId =
      params.query['data.id'] ?? params.query['id'] ?? asString(bodyData?.id);

    const signature = verifyMpSignature({
      xSignature: header('x-signature'),
      xRequestId: header('x-request-id'),
      dataId,
      secret: env.MP_WEBHOOK_SECRET ?? '',
    });

    const notificationId =
      asString(params.body.id) ??
      `${dataId ?? 'sin-id'}-${header('x-request-id') ?? newId('mpw')}`;

    const topic = asString(params.body.type) ?? asString(params.body.topic) ?? 'desconocido';
    const action = asString(params.body.action) ?? null;

    // Se registra SIEMPRE, válida o no. Un pico de firmas inválidas es la señal
    // de que alguien está probando el endpoint, y sin registro no se ve.
    let record;
    try {
      record = await this.prisma.mpWebhookEvent.create({
        data: {
          id: newId('mpw'),
          notificationId,
          topic,
          action,
          resourceId: dataId ?? null,
          signatureValid: signature.valid,
          rejectionReason: signature.reason ?? null,
          headers: {
            'x-request-id': header('x-request-id') ?? null,
            'x-signature': header('x-signature') ?? null,
            'user-agent': header('user-agent') ?? null,
          },
          payload: params.body as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Barrera 2: reintento de Mercado Pago. Se responde 200 para que deje
        // de reintentar, sin volver a ejecutar nada.
        this.logger.log({ msg: 'webhook duplicado ignorado', notificationId });
        return { status: 'DUPLICATE' as const };
      }
      throw err;
    }

    if (!signature.valid) {
      this.logger.warn({
        msg: 'webhook con firma inválida',
        reason: signature.reason,
        notificationId,
        // Sólo fuera de producción: dice qué variante habría validado y
        // convierte un día de depuración en un renglón de log.
        ...(isLocalEnv(env.NODE_ENV)
          ? {
              diagnostico: diagnoseSignature({
                xSignature: header('x-signature'),
                xRequestId: header('x-request-id'),
                dataId,
                secret: env.MP_WEBHOOK_SECRET ?? '',
              }),
            }
          : {}),
      });
      return { status: 'INVALID_SIGNATURE' as const, reason: signature.reason };
    }

    if (topic !== 'payment' || !dataId) {
      await this.prisma.mpWebhookEvent.update({
        where: { id: record.id },
        data: { processedAt: new Date() },
      });
      return { status: 'IGNORED' as const, topic };
    }

    try {
      // Barrera 3: la verdad se le pregunta a Mercado Pago.
      const mpPayment = await this.mp.getPayment(dataId);
      const orderId = mpPayment.external_reference;

      /**
       * Notificación huérfana: el pago existe en Mercado Pago pero no
       * corresponde a ninguna orden nuestra.
       *
       * Pasa de verdad, y con más frecuencia de la que uno esperaría: pagos
       * creados a mano en el panel, notificaciones de otra aplicación
       * apuntando al mismo webhook, o una base restaurada desde un respaldo
       * anterior a la orden.
       *
       * Se responde 200 y se archiva. Si dejáramos que reventara contra la
       * clave foránea, Mercado Pago reintentaría esa misma notificación
       * indefinidamente y el error taparía los fallos que sí importan.
       */
      const orderExists =
        orderId != null &&
        (await this.prisma.spikeOrder.count({ where: { id: orderId } })) > 0;

      if (!orderExists) {
        await this.prisma.mpWebhookEvent.update({
          where: { id: record.id },
          data: {
            processedAt: new Date(),
            error:
              orderId == null
                ? 'el pago no tiene external_reference'
                : `external_reference "${orderId}" no corresponde a ninguna orden`,
          },
        });
        this.logger.warn({ msg: 'notificación huérfana archivada', dataId, orderId });
        return { status: 'ORPHAN' as const };
      }

      const applied = await this.applyMpPayment(orderId, mpPayment, 'WEBHOOK');
      await this.prisma.mpWebhookEvent.update({
        where: { id: record.id },
        data: { processedAt: new Date() },
      });
      return { status: 'PROCESSED' as const, orderStatus: applied.order.status };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      /**
       * Mercado Pago dice que ese pago NO EXISTE.
       *
       * Reintentar no puede cambiar la respuesta, así que se archiva y se
       * responde 200. Pasa en tres situaciones reales:
       *
       *   · El simulador del panel, que manda ids de ejemplo.
       *   · Notificaciones de otra aplicación apuntando a este mismo webhook.
       *   · Alguien probando el endpoint a mano.
       *
       * Devolver 500 haría que Mercado Pago reintentara indefinidamente algo
       * que nunca va a resolverse, y esos errores taparían los que sí importan.
       */
      if (err instanceof MpApiError && err.status === 404) {
        await this.prisma.mpWebhookEvent.update({
          where: { id: record.id },
          data: { processedAt: new Date(), error: `el pago ${dataId} no existe en Mercado Pago` },
        });
        this.logger.warn({ msg: 'notificación sobre un pago inexistente', dataId });
        return { status: 'UNKNOWN_PAYMENT' as const };
      }

      await this.prisma.mpWebhookEvent.update({
        where: { id: record.id },
        data: { error: message },
      });
      // Se relanza: el fallo es nuestro y transitorio. Mercado Pago reintenta,
      // y el registro queda sin `processedAt` para que el conciliador lo levante.
      throw err;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Conciliación
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Resuelve las órdenes que quedaron en PROCESSING.
   *
   * Es la red que atrapa los dos casos que ninguna otra capa cubre: el webhook
   * que nunca llegó y el timeout que dejó un cobro sin resultado conocido.
   *
   * En producción esto es un trabajo periódico. Acá se expone como endpoint
   * para poder ejecutarlo a mano durante la prueba de campo y ver que funciona.
   */
  async reconcile(olderThanMs = 60_000, releaseAfterMs = RELEASE_AFTER_MS) {
    /**
     * `olderThanMs = 0` significa "todas", sin filtro de tiempo.
     *
     * No es azúcar sintáctico: `updatedAt` lo escribe el reloj de PostgreSQL y
     * el corte lo calcula el reloj de Node. Unos milisegundos de desfase entre
     * los dos alcanzan para que una orden recién marcada quede fuera del
     * filtro, y eso convertía la prueba de conciliación en intermitente.
     * Comparar relojes distintos con una tolerancia de cero nunca funciona.
     */
    const stuck = await this.prisma.spikeOrder.findMany({
      where: {
        status: 'PROCESSING',
        ...(olderThanMs > 0 ? { updatedAt: { lt: new Date(Date.now() - olderThanMs) } } : {}),
      },
      take: 50,
    });

    const results: Array<{ orderId: string; before: PayOrderStatus; after: PayOrderStatus }> = [];

    for (const order of stuck) {
      try {
        // Se busca por NUESTRA referencia: no hace falta conocer el id del
        // pago, que es justo lo que no tenemos cuando el webhook se perdió.
        const payments = await this.mp.searchPaymentsByExternalReference(order.id);

        if (payments.length === 0) {
          /**
           * Mercado Pago no tiene NINGÚN pago para esta orden.
           *
           * Pasa cuando la petición se cortó antes de que llegara: el cobro
           * nunca ocurrió. Verificado en campo el 13/08/2026 con un timeout
           * de 1 s.
           *
           * Si la dejáramos en PROCESSING, la orden quedaría trabada para
           * siempre: `canAttemptPayment` no permite reintentar sobre una orden
           * con un cobro en vuelo, así que nadie podría pagarla nunca más.
           * Es el mismo tipo de callejón sin salida que tenía la clave de
           * idempotencia, con otra causa.
           *
           * ─── Por qué se espera antes de liberar ───
           *
           * Liberarla al instante sería peligroso: si el pago SÍ se creó y
           * todavía no aparece en la búsqueda, el comprador reintentaría y
           * pagaría dos veces. La ventana da tiempo a que cualquier cobro en
           * vuelo se materialice.
           *
           * Y liberar a FAILED es seguro incluso si nos equivocamos: si más
           * tarde apareciera el pago, la guarda de monotonía permite
           * FAILED → PAID, así que el webhook o el propio conciliador
           * corrigen el estado.
           */
          const enProcesoMs = Date.now() - order.updatedAt.getTime();
          if (enProcesoMs >= releaseAfterMs) {
            await this.transition(
              order.id,
              order.status,
              'FAILED',
              'RECONCILER',
              'reconcile.released',
              { motivo: 'Mercado Pago no registra ningún pago para esta orden', enProcesoMs },
            );
            results.push({ orderId: order.id, before: order.status, after: 'FAILED' });
          } else {
            await this.audit(
              order.id,
              'RECONCILER',
              'reconcile.no_payment',
              order.status,
              order.status,
              { enProcesoMs, liberaEnMs: releaseAfterMs - enProcesoMs },
            );
          }
          continue;
        }

        // El aprobado manda; si no hay ninguno, el más reciente.
        const winner = payments.find((p) => p.status === 'approved') ?? payments[0]!;
        const applied = await this.applyMpPayment(order.id, winner, 'RECONCILER');
        results.push({ orderId: order.id, before: order.status, after: applied.order.status });
      } catch (err) {
        this.logger.error({
          msg: 'falló la conciliación de una orden',
          orderId: order.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { checked: stuck.length, changed: results };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tarjetas guardadas
  // ───────────────────────────────────────────────────────────────────────────

  async listSavedCards(email: string) {
    const customer = await this.prisma.spikeCustomer.findUnique({
      where: { email },
      include: { cards: true },
    });
    return customer?.cards ?? [];
  }

  /**
   * Guarda la tarjeta en Mercado Pago y su referencia acá.
   *
   * Nunca lanza: se ejecuta después de un cobro aprobado, y un fallo guardando
   * la tarjeta no puede convertir una compra exitosa en un error.
   */
  private async saveCardSafely(email: string, mpPayment: MpPayment): Promise<void> {
    try {
      const cardId = (mpPayment.card as { id?: string | number } | undefined)?.id;
      if (!cardId) return;

      const mpCustomer =
        (await this.mp.findCustomerByEmail(email)) ?? (await this.mp.createCustomer(email));

      const customer = await this.prisma.spikeCustomer.upsert({
        where: { email },
        create: { id: newId('cus'), email, mpCustomerId: mpCustomer.id },
        update: {},
      });

      await this.prisma.spikeCustomerCard.upsert({
        where: { mpCardId: String(cardId) },
        create: {
          id: newId('crd'),
          customerId: customer.id,
          mpCardId: String(cardId),
          lastFour: mpPayment.card?.last_four_digits ?? '????',
          brand: mpPayment.payment_method_id ?? null,
          expirationMonth: mpPayment.card?.expiration_month ?? null,
          expirationYear: mpPayment.card?.expiration_year ?? null,
        },
        update: {},
      });
    } catch (err) {
      this.logger.warn({
        msg: 'no se pudo guardar el medio de pago; el cobro no se ve afectado',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────

  private async transition(
    orderId: string,
    from: PayOrderStatus,
    to: PayOrderStatus,
    source: PaySource,
    kind: string,
    detail?: Record<string, unknown>,
  ) {
    const order = await this.prisma.spikeOrder.update({
      where: { id: orderId },
      data: { status: to, ...(to === 'PAID' ? { paidAt: new Date() } : {}) },
    });
    await this.audit(orderId, source, kind, from, to, detail);
    return order;
  }

  /** Bitácora append-only. Es la respuesta a "¿por qué figura pagada?". */
  private async audit(
    orderId: string,
    source: PaySource,
    kind: string,
    fromStatus: string | null,
    toStatus: string | null,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.spikePaymentEvent.create({
      data: {
        id: newId('pev'),
        orderId,
        source,
        kind,
        fromStatus,
        toStatus,
        detail: detail === undefined ? undefined : (detail as Prisma.InputJsonValue),
      },
    });
  }
}
