import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, type PaymentAttempt, type PaymentAttemptStatus } from '@prisma/client';

import { env } from '@/config/env.schema';
import { InventoryService } from '@/modules/inventory/inventory.service';
import { describePaymentOutcome } from '@/modules/payments/payment-messages';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { DomainEvent, DomainEventBus } from '@/shared/events/domain-events';
import { MetricsService } from '@/shared/observability/metrics.service';
import { SellerOAuthService } from '@/modules/payments/seller-oauth.service';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { admitePago, mapearEstadoMp } from './order-state';
import { netoConCostoDeProcesador, type Precio } from './pricing';
import {
  PaymentProvider,
  ProviderPaymentNotFoundError,
  ProviderRejectedError,
  ProviderUnavailableError,
  type ProviderCheckout,
  type ProviderPayment,
} from './payment-provider';

/**
 * Cobros.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TRES DESENLACES, NO DOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un cobro no termina en "salió" o "no salió". Termina en una de tres:
 *
 *   · APPROVED  → hay plata.
 *   · REJECTED  → la tarjeta dijo que no. Se puede reintentar con otra.
 *   · UNKNOWN   → **no sabemos**.
 *
 * El tercero es el que hace que esto sea difícil y el que hay que respetar. Si
 * se manda el cobro y se corta la conexión, el pago pudo haberse procesado.
 * Llamarlo "rechazado" es decirle a alguien que no le cobraron cuando sí, y
 * dejarlo pagar de nuevo.
 *
 * Un error de red **no es un pago fallido**.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA MISMA CONFIRMACIÓN LLEGA DOS VECES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Medido en la primera compra real del spike:
 *
 *     07:46:12.307  respuesta directa   PROCESSING → PAID
 *     07:46:12.988  webhook             PAID       → PAID
 *
 * 681 ms de diferencia. Los dos caminos son legítimos y los dos van a seguir
 * existiendo. Por eso cada transición se hace con la condición de estado
 * DENTRO del UPDATE: el primero mueve la orden, el segundo afecta cero filas y
 * no hace nada. Sin `if`, sin lectura previa, sin ventana.
 */

export class OrderNotPayableError extends DomainError {
  constructor(status: string) {
    super('ORDER_NOT_PAYABLE_V2', 'Este pedido no está en condiciones de pagarse', { status });
  }
}

/**
 * El vendedor no tiene cuenta de cobro conectada.
 *
 * No debería pasar: sin cuenta conectada no se puede publicar ni transmitir.
 * Si llega acá es que el producto se publicó antes de esa regla, o que el
 * vendedor desconectó entre la publicación y la compra.
 *
 * El mensaje habla del VENDEDOR y no de un error técnico: quien lo lee es la
 * persona que está intentando comprar, y no hizo nada mal.
 */
export class VendedorSinCuentaDeCobroError extends DomainError {
  constructor() {
    super(
      'SELLER_PAYMENT_ACCOUNT_MISSING',
      'Este vendedor no está pudiendo recibir pagos en este momento. Probá más tarde.',
    );
  }
}

/**
 * No se pudo abrir el checkout del proveedor.
 *
 * ⚠️ Es distinto de `PaymentStateUnknownError`, y la diferencia no es
 * cosmética: allá un cobro pudo haberse procesado y hay que esperar; acá NADIE
 * pagó nada.
 *
 * Se puede volver a intentar sin ningún riesgo, y el mensaje lo dice. Lo
 * encontró un test que esperaba un error y recibía un 202 con «estamos
 * verificando tu pago» — para un pago que nunca existió.
 */
export class CheckoutNoDisponibleError extends DomainError {
  constructor() {
    super(
      'CHECKOUT_UNAVAILABLE',
      'No pudimos abrir el pago. No se te cobró nada: probá de nuevo.',
    );
  }
}

export class PaymentInFlightError extends DomainError {
  constructor() {
    super(
      'PAYMENT_IN_FLIGHT',
      'Ya hay un pago en curso para este pedido. Esperá el resultado.',
    );
  }
}

export class PaymentStateUnknownError extends DomainError {
  constructor(attemptId: string) {
    super(
      'PAYMENT_STATE_UNKNOWN',
      'Estamos verificando tu pago. No lo intentes de nuevo todavía.',
      { attemptId },
    );
  }
}

export class PaymentRejectedError extends DomainError {
  constructor(mensaje: string, code?: string) {
    super('PAYMENT_REJECTED', mensaje, code ? { code } : undefined);
  }
}

export interface CobrarInput {
  orderId: string;
  buyerId: string;
  /** Token de un solo uso. No se guarda, no se registra, no sale de este método. */
  cardToken: string;
  installments: number;
  paymentMethodId: string;
}

@Injectable()
export class OrderPaymentsService {
  private readonly logger = new Logger(OrderPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly metrics: MetricsService,
    private readonly sellerOAuth: SellerOAuthService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // COBRAR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * «Pagar con Mercado Pago»: crea el checkout alojado y dice a dónde ir.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * QUÉ CAMBIA Y QUÉ NO, RESPECTO DEL COBRO CON TARJETA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Cambia quién cobra. Con tarjeta, el CardForm genera un token en el teléfono
   * y nosotros creamos el pago; acá se crea una **preferencia** y la persona
   * termina de pagar del lado de Mercado Pago —en su app si la tiene, o en su
   * web si no—.
   *
   * NO cambia nada de lo que hace que el sistema sea confiable:
   *
   *   · `external_reference` sigue siendo el id de nuestra orden;
   *   · el **webhook sigue siendo la fuente de verdad** de PAID/CONFIRMED;
   *   · el cobro entra en la cuenta del VENDEDOR, con nuestra comisión como
   *     `marketplace_fee`;
   *   · la comisión es la que se congeló al crear el pedido: 4 % del PRODUCTO,
   *     sin envío ni recargo del procesador.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * POR QUÉ SE CREA UN `PaymentAttempt` SI TODAVÍA NO PAGÓ NADIE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Porque si no, el webhook no tendría a qué atar el pago. `WebhookService`
   * busca un intento en `CREATED`/`PROCESSING`/`UNKNOWN_PENDING_RECONCILIATION`
   * para esa orden y, si no lo encuentra, archiva el pago como **ORPHAN** y no
   * hace nada.
   *
   * O sea: sin este intento, cada pago hecho por Checkout Pro se perdería en
   * silencio y la orden nunca pasaría a pagada. Con él, el webhook y el
   * conciliador funcionan sin una sola línea nueva.
   *
   * Y de yapa da la idempotencia gratis: el índice parcial
   * `intento_en_vuelo_unico_por_orden` ya garantiza **un solo intento activo
   * por orden**, y ahora lo comparten los dos caminos de pago. Tocar el botón
   * dos veces devuelve la misma preferencia; empezar por tarjeta y seguir por
   * Mercado Pago choca contra el mismo índice.
   */
  async iniciarCheckoutAlojado(input: {
    orderId: string;
    buyerId: string;
  }): Promise<{ attemptId: string; checkoutUrl: string; orderStatus: string }> {
    const orden = await this.prisma.order.findFirst({
      where: { id: input.orderId, buyerId: input.buyerId },
      select: {
        id: true,
        status: true,
        grossAmount: true,
        reference: true,
        buyerSnapshot: true,
        sellerId: true,
        platformFeeAmount: true,
        items: { select: { productNameSnapshot: true }, take: 1 },
      },
    });
    if (!orden) throw new DomainError('ORDER_NOT_FOUND_V2', 'Pedido no encontrado');

    /**
     * Si ya hay un checkout vivo para esta orden, se devuelve ESE.
     *
     * Es la idempotencia vista desde arriba: el segundo toque no crea otra
     * preferencia ni falla, devuelve dónde estaba pagando. Volver del checkout
     * sin pagar y tocar de nuevo tiene que llevar al mismo lado.
     */
    const enVuelo = await this.prisma.paymentAttempt.findFirst({
      where: {
        orderId: orden.id,
        status: { in: ['CREATED', 'PROCESSING', 'UNKNOWN_PENDING_RECONCILIATION'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (enVuelo?.checkoutUrl) {
      this.metrics.paymentAttempts.inc({ result: 'idempotent_replay' });
      return {
        attemptId: enVuelo.id,
        checkoutUrl: enVuelo.checkoutUrl,
        orderStatus: orden.status,
      };
    }

    /**
     * ⚠️ Un intento en vuelo SIN checkout es un cobro con tarjeta en curso.
     *
     * Mandarla a Mercado Pago ahí sería abrir un segundo camino de pago sobre
     * un cobro que puede estar aprobándose en este mismo instante.
     */
    if (enVuelo) throw new PaymentInFlightError();

    if (!admitePago(orden.status)) {
      if (orden.status === 'PROCESSING_PAYMENT') throw new PaymentInFlightError();
      if (orden.status === 'PAID' || orden.status === 'CONFIRMED') {
        throw new DomainError('PAYMENT_ALREADY_APPROVED', 'Este pedido ya está pago');
      }
      throw new OrderNotPayableError(orden.status);
    }

    /**
     * La misma regla que en el cobro con tarjeta: sin cuenta del vendedor
     * conectada, no se cobra.
     *
     * Acá es todavía más claro que allá. Una preferencia creada con NUESTRO
     * token cobra en NUESTRA cuenta, y esa plata habría que girarla a mano.
     */
    const sellerAccessToken = await this.tokenDelVendedor(orden.sellerId);
    if (!sellerAccessToken && !env.ALLOW_PAYMENT_WITHOUT_SELLER_ACCOUNT) {
      this.logger.error({
        msg: '⛔ checkout rechazado: el vendedor no tiene Mercado Pago conectado',
        orderId: orden.id,
        sellerId: orden.sellerId,
      });
      throw new VendedorSinCuentaDeCobroError();
    }

    const attemptId = newId('pat');
    const idempotencyKey = `mp-checkout-${orden.id}`;
    const comprador = orden.buyerSnapshot as { email?: string } | null;
    const titulo = orden.items[0]?.productNameSnapshot ?? `Pedido ${orden.reference}`;

    let checkout: ProviderCheckout;
    try {
      checkout = await this.provider.crearCheckoutAlojado(
        {
          externalReference: orden.id,
          titulo,
          amount: orden.grossAmount,
          payerEmail: comprador?.email ?? '',
          applicationFee: sellerAccessToken ? orden.platformFeeAmount : undefined,
          backUrls: this.dondeVolver(orden.id),
          sellerAccessToken: sellerAccessToken ?? undefined,
        },
        idempotencyKey,
      );
    } catch (err) {
      /**
       * ⚠️ Si la preferencia no se pudo crear, NO queda ningún intento.
       *
       * Es la diferencia con el cobro con tarjeta, donde el intento se crea
       * antes de llamar al proveedor porque el cobro puede haberse procesado
       * igual. Acá no hay nada que conciliar: sin preferencia, nadie pagó nada.
       * Dejar un intento en vuelo bloquearía la orden para siempre.
       */
      this.metrics.paymentAttempts.inc({ result: 'provider_error' });

      /**
       * ⚠️ Acá NO se usa `traducirFallo`, y la diferencia importa.
       *
       * `traducirFallo` está pensado para el cobro con tarjeta: ahí un
       * proveedor caído significa «no sabemos si se cobró», y por eso devuelve
       * un 202 con «estamos verificando tu pago».
       *
       * Para una preferencia eso es falso y confuso. Si no se pudo crear, nadie
       * pagó nada: no hay pago que verificar, no hay nada que conciliar, y
       * decirle a alguien que espere sin intentar de nuevo lo deja trabado por
       * un error que se resuelve tocando el botón otra vez.
       *
       * Lo encontró un test: esperaba un error y recibía un 202.
       */
      this.logger.warn({
        msg: 'no se pudo crear el checkout alojado',
        orderId: orden.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err instanceof DomainError ? err : new CheckoutNoDisponibleError();
    }

    try {
      await this.prisma.paymentAttempt.create({
        data: {
          id: attemptId,
          orderId: orden.id,
          idempotencyKey,
          amount: orden.grossAmount,
          status: 'CREATED',
          providerPreferenceId: checkout.id,
          checkoutUrl: checkout.url,
        },
      });
    } catch (err) {
      // Alguien ganó la carrera y creó su intento primero. Se devuelve el suyo.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existente = await this.prisma.paymentAttempt.findUnique({
          where: { idempotencyKey },
        });
        if (existente?.checkoutUrl) {
          return {
            attemptId: existente.id,
            checkoutUrl: existente.checkoutUrl,
            orderStatus: orden.status,
          };
        }
        throw new PaymentInFlightError();
      }
      throw err;
    }

    this.metrics.paymentAttempts.inc({ result: 'created' });
    this.events.publish(DomainEvent.paymentAttemptCreated, {
      entityId: attemptId,
      actorId: input.buyerId,
      data: { orderId: orden.id, amount: orden.grossAmount },
    });

    return { attemptId, checkoutUrl: checkout.url, orderStatus: orden.status };
  }

  /**
   * A dónde vuelve la persona cuando termina en Mercado Pago.
   *
   * Son enlaces de `vendox.com.ar`, que el `AndroidManifest` declara como App
   * Link verificado sin prefijo de ruta: Android abre VendoX directamente. Si
   * la app no está instalada, cae en la web y la página explica qué pasó.
   *
   * ⚠️ El estado que viene en la URL es sólo para MOSTRAR algo mientras tanto.
   * Quien decide si la orden está paga es el webhook, siempre. Un enlace de
   * vuelta lo puede escribir cualquiera.
   */
  private dondeVolver(orderId: string): { success: string; pending: string; failure: string } {
    const base = `${env.PUBLIC_WEB_URL}/pago/${orderId}`;
    return {
      success: `${base}?estado=aprobado`,
      pending: `${base}?estado=pendiente`,
      failure: `${base}?estado=rechazado`,
    };
  }

  /**
   * Intenta cobrar una orden.
   *
   * ─── La clave de idempotencia sale del TOKEN, no de la orden ───
   *
   * Es el arreglo de un error real, medido en el spike:
   *
   *     08:14:50  tarjeta rechazada  clave pay-ord_X  → pago 1350327873
   *     08:15:39  otra tarjeta       clave pay-ord_X  → pago 1350327873, el MISMO
   *
   * Con una clave por orden, Mercado Pago —haciendo exactamente lo que debe—
   * devolvía la respuesta guardada del primer intento. El segundo cobro nunca
   * se procesaba. Una orden rechazada quedaba condenada: ninguna tarjeta podía
   * pagarla nunca más.
   *
   * El token de tarjeta es la unidad correcta: se genera uno nuevo cada vez que
   * alguien completa el formulario.
   *
   *   · Doble toque en "Pagar" → mismo token → misma clave → un solo cobro.
   *   · Otra tarjeta           → token nuevo → clave nueva → cobro nuevo.
   *
   * Se guarda el HASH del token, nunca el token: la clave viaja en cabeceras y
   * termina en la bitácora, y ahí no puede quedar nada que sirva para cobrar.
   */
  async cobrar(input: CobrarInput): Promise<{ attempt: PaymentAttempt; orderStatus: string }> {
    const inicio = process.hrtime.bigint();

    const orden = await this.prisma.order.findFirst({
      where: { id: input.orderId, buyerId: input.buyerId },
      select: {
        id: true,
        status: true,
        grossAmount: true,
        currency: true,
        reference: true,
        buyerSnapshot: true,
        // Para el cobro en la cuenta del vendedor: a quién pertenece y cuánta
        // comisión se calculó CUANDO se creó el pedido. Ver el comentario en
        // la llamada al proveedor.
        sellerId: true,
        platformFeeAmount: true,
        items: { select: { productNameSnapshot: true }, take: 1 },
      },
    });
    // Ajena o inexistente: indistinguibles desde afuera.
    if (!orden) throw new DomainError('ORDER_NOT_FOUND_V2', 'Pedido no encontrado');

    const idempotencyKey = this.claveDeCobro(orden.id, input.cardToken);

    /**
     * La idempotencia se comprueba ANTES que el estado de la orden.
     *
     * ─── El caso que obliga a este orden ───
     *
     * La persona toca "Pagar", el cobro se aprueba y la orden queda
     * confirmada — pero la respuesta se pierde en el camino de vuelta. La app
     * reintenta con el MISMO token.
     *
     * Si primero se mirara el estado, ese reintento chocaría contra
     * "este pedido ya está pago": un error, para alguien que hizo todo bien y
     * cuya compra salió perfecta. La app tendría que interpretar un 409 como
     * éxito, que es exactamente el tipo de regla que alguien va a implementar
     * mal.
     *
     * Comprobando la clave primero, el reintento devuelve el mismo intento con
     * el mismo resultado. Que es lo que significa idempotente.
     */
    const previo = await this.prisma.paymentAttempt.findUnique({ where: { idempotencyKey } });
    if (previo) {
      this.metrics.paymentAttempts.inc({ result: 'idempotent_replay' });
      return { attempt: previo, orderStatus: orden.status };
    }

    // Recién ahora: ¿esta orden admite un cobro NUEVO?
    if (!admitePago(orden.status)) {
      if (orden.status === 'PROCESSING_PAYMENT') throw new PaymentInFlightError();
      if (orden.status === 'PAID' || orden.status === 'CONFIRMED') {
        throw new DomainError('PAYMENT_ALREADY_APPROVED', 'Este pedido ya está pago');
      }
      throw new OrderNotPayableError(orden.status);
    }

    const attemptId = newId('pat');

    /**
     * Se crea el intento y se marca la orden en curso ANTES de llamar a
     * Mercado Pago.
     *
     * Si se hiciera al revés y el proceso muriera entre la llamada y la
     * escritura, habría un cobro real sin ninguna fila que lo mencione:
     * imposible de conciliar, porque no sabríamos ni que existió.
     *
     * El índice único parcial sobre los estados en vuelo hace lo demás: dos
     * peticiones simultáneas no pueden dejar dos intentos abiertos.
     */
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.paymentAttempt.create({
          data: {
            id: attemptId,
            orderId: orden.id,
            provider: this.provider.nombre,
            status: 'CREATED',
            amount: orden.grossAmount,
            currency: orden.currency,
            idempotencyKey,
          },
        });

        const { count } = await tx.order.updateMany({
          where: { id: orden.id, status: { in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] } },
          data: { status: 'PROCESSING_PAYMENT' },
        });
        // Alguien más movió la orden en el medio.
        if (count === 0) throw new PaymentInFlightError();
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Índice de "un intento en vuelo por orden", o clave repetida.
        const existente = await this.prisma.paymentAttempt.findUnique({
          where: { idempotencyKey },
        });
        if (existente) return { attempt: existente, orderStatus: orden.status };
        throw new PaymentInFlightError();
      }
      throw err;
    }

    this.metrics.paymentAttempts.inc({ result: 'created' });
    this.events.publish(DomainEvent.paymentAttemptCreated, {
      entityId: attemptId,
      actorId: input.buyerId,
      data: { orderId: orden.id, amount: orden.grossAmount },
    });

    // ─── La llamada al proveedor ───
    const comprador = orden.buyerSnapshot as { email?: string } | null;

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL COBRO VA A LA CUENTA DEL VENDEDOR. SIN EXCEPCIONES.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Si el vendedor no tiene su cuenta conectada, **el cobro no se hace**.
     *
     * Hasta hace un rato había un respaldo: sin cuenta conectada, el cobro
     * entraba en la de VendoX. Se eliminó, y no por prolijidad —era una bomba
     * de tiempo:
     *
     *   · nos convierte en intermediarios del dinero de terceros, con todo lo
     *     que eso implica legalmente;
     *   · cada venta así es plata que le debemos a alguien y que hay que girar
     *     a mano, una por una, sin ningún registro pensado para eso;
     *   · y el problema crece en silencio: nadie se entera hasta que hay que
     *     devolver.
     *
     * El bloqueo de verdad está antes —sin cuenta conectada no se puede
     * publicar ni transmitir— así que llegar acá sin token significa que algo
     * se saltó esa regla: un producto publicado antes de la regla, o una cuenta
     * desconectada entre la publicación y la compra.
     *
     * En los dos casos, cobrar sería peor que fallar.
     *
     * ─── La comisión sale de la ORDEN, no del entorno ───
     *
     *  es la foto de lo que se calculó al crear el
     * pedido, y es **6 % del producto solamente** — no del envío ni del recargo
     * del procesador. Recalcularlo acá haría que un cambio de comisión entre la
     * creación y el pago cobre un número distinto del que se le mostró a la
     * persona.
     */
    const sellerAccessToken = await this.tokenDelVendedor(orden.sellerId);

    if (!sellerAccessToken && !env.ALLOW_PAYMENT_WITHOUT_SELLER_ACCOUNT) {
      this.logger.error({
        msg: '⛔ cobro rechazado: el vendedor no tiene Mercado Pago conectado',
        orderId: orden.id,
        sellerId: orden.sellerId,
      });
      throw new VendedorSinCuentaDeCobroError();
    }

    let pago: ProviderPayment;
    try {
      pago = await this.provider.cobrar(
        {
          cardToken: input.cardToken,
          amount: orden.grossAmount,
          installments: input.installments,
          paymentMethodId: input.paymentMethodId,
          payerEmail: comprador?.email ?? '',
          description: orden.items[0]?.productNameSnapshot ?? `Pedido ${orden.reference}`,
          externalReference: orden.id,
          // La comisión sólo tiene sentido si el cobro va a la cuenta del
          // vendedor. Sobre la nuestra, cobrarnos a nosotros mismos no
          // significa nada y Mercado Pago lo rechaza.
          // 6 % del PRODUCTO. La foto que se calculó al crear el pedido.
          // La comisión sólo tiene sentido cobrando en la cuenta del vendedor.
          // Sobre la nuestra —el respaldo de desarrollo— Mercado Pago la
          // rechaza, porque sería cobrarnos a nosotros mismos.
          applicationFee: sellerAccessToken ? orden.platformFeeAmount : undefined,
          sellerAccessToken: sellerAccessToken ?? undefined,
        },
        idempotencyKey,
      );
    } catch (err) {
      const desenlace = await this.manejarFalloDelProveedor(attemptId, orden.id, err);
      this.metrics.paymentConfirmation.observe(
        { result: desenlace },
        Number(process.hrtime.bigint() - inicio) / 1e9,
      );
      throw err instanceof DomainError ? err : this.traducirFallo(err, attemptId);
    }

    const resultado = await this.aplicarResultado(attemptId, pago, 'direct');

    this.metrics.paymentConfirmation.observe(
      { result: resultado.attempt.status.toLowerCase() },
      Number(process.hrtime.bigint() - inicio) / 1e9,
    );

    if (resultado.attempt.status === 'REJECTED') {
      throw new PaymentRejectedError(
        resultado.attempt.failureMessageSafe ?? 'No pudimos procesar el pago',
        resultado.attempt.failureCode ?? undefined,
      );
    }

    return resultado;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // APLICAR UN RESULTADO
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Toma lo que dijo el proveedor y lo aplica a la orden.
   *
   * Es el único camino por el que una orden pasa a `PAID`, y lo llaman los
   * tres orígenes posibles: la respuesta directa, el webhook y el conciliador.
   * Tener uno solo es lo que hace que la idempotencia se pueda razonar: si
   * hubiera tres implementaciones, bastaría con que una olvidara la guarda.
   */
  async aplicarResultado(
    attemptId: string,
    pago: ProviderPayment,
    origen: 'direct' | 'webhook' | 'reconciler',
  ): Promise<{ attempt: PaymentAttempt; orderStatus: string }> {
    const nuevoEstado = mapearEstadoMp(pago.status);

    const intento = await this.prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: { id: true, orderId: true, status: true, amount: true },
    });

    const mensaje =
      nuevoEstado === 'REJECTED'
        ? describePaymentOutcome({ statusDetail: pago.statusDetail })
        : null;

    const actualizado = await this.prisma.paymentAttempt.update({
      where: { id: attemptId },
      data: {
        status: nuevoEstado,
        providerPaymentId: pago.id,
        brand: pago.brand,
        lastFour: pago.lastFour,
        paymentMethodType: pago.paymentType,
        processorFeeAmount: pago.feeAmount,
        approvedAt: nuevoEstado === 'APPROVED' ? new Date(pago.approvedAt ?? Date.now()) : null,
        failureCode: nuevoEstado === 'REJECTED' ? (pago.statusDetail ?? null) : null,
        failureMessageSafe: mensaje?.text ?? null,
        lastCheckedAt: new Date(),
      },
    });

    void this.audit.log({
      action: `payment.${nuevoEstado.toLowerCase()}`,
      entityType: 'payment_attempt',
      entityId: attemptId,
      actorId: null,
      after: {
        orderId: intento.orderId,
        origen,
        providerPaymentId: pago.id,
        status: nuevoEstado,
        // Últimos cuatro y marca. Nada más de la tarjeta llega a la bitácora.
        brand: pago.brand,
        lastFour: pago.lastFour,
      },
    });

    let orderStatus: string;

    switch (nuevoEstado) {
      case 'APPROVED':
        orderStatus = await this.acreditar(intento.orderId, attemptId, pago);
        break;

      case 'REJECTED': {
        // La condición va en el WHERE: si el webhook llega después de que otro
        // intento ya acreditó, esto afecta cero filas y no despaga nada.
        await this.prisma.order.updateMany({
          where: { id: intento.orderId, status: 'PROCESSING_PAYMENT' },
          data: {
            status: 'PAYMENT_FAILED',
            statusReason: mensaje?.text ?? 'El pago fue rechazado',
          },
        });
        this.metrics.paymentAttempts.inc({ result: 'rejected' });
        this.events.publish(DomainEvent.paymentRejected, {
          entityId: attemptId,
          data: { orderId: intento.orderId, code: pago.statusDetail },
        });
        orderStatus = 'PAYMENT_FAILED';
        break;
      }

      default: {
        // PROCESSING o UNKNOWN: la orden se queda donde está. Un cobro que no
        // se resolvió no autoriza a moverla ni a permitir otro intento.
        this.metrics.paymentAttempts.inc({ result: 'unknown' });
        const actual = await this.prisma.order.findUniqueOrThrow({
          where: { id: intento.orderId },
          select: { status: true },
        });
        orderStatus = actual.status;
      }
    }

    return { attempt: actualizado, orderStatus };
  }

  /**
   * Hay plata: `PAID`, y después se intenta confirmar el inventario.
   *
   * ─── Los dos pasos son distintos a propósito ───
   *
   * Primero se registra que el dinero entró. Recién después se ve si se puede
   * entregar. Si fueran una sola operación y el inventario fallara, la
   * transacción se revertiría y **la orden no diría que le cobraron a alguien**
   * — que es la peor forma posible de manejar este caso.
   */
  private async acreditar(
    orderId: string,
    attemptId: string,
    pago: ProviderPayment,
  ): Promise<string> {
    /**
     * La guarda de monotonía, en una sola sentencia.
     *
     * `count === 0` significa que otro camino ya la acreditó — típicamente la
     * respuesta directa, 681 ms antes que el webhook. No es un error: es el
     * caso normal, y la respuesta correcta es no hacer nada dos veces.
     */
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, status: { in: ['PENDING_PAYMENT', 'PROCESSING_PAYMENT'] } },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paymentProcessorFeeAmount: pago.feeAmount ?? undefined,
      },
    });

    if (count > 0) {
      this.metrics.paymentAttempts.inc({ result: 'approved' });
      this.events.publish(DomainEvent.orderPaid, {
        entityId: orderId,
        data: { attemptId, providerPaymentId: pago.id },
      });
      this.events.publish(DomainEvent.paymentApproved, {
        entityId: attemptId,
        data: { orderId },
      });
      // El costo real del procesador cambia el neto del vendedor.
      if (pago.feeAmount !== undefined) await this.recalcularNeto(orderId);
    }

    return this.confirmarInventario(orderId, attemptId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INVENTARIO
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Convierte una orden pagada en una venta confirmada.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * EL CASO DIFÍCIL DE TODO EL MÓDULO
   * ═══════════════════════════════════════════════════════════════════════
   *
   * El camino feliz es corto: la reserva sigue viva, se consume, `CONFIRMED`.
   *
   * El otro es el que importa. La persona reservó la última unidad, empezó a
   * pagar, perdió señal. La reserva venció y el stock se liberó. Cinco minutos
   * después, Mercado Pago acredita.
   *
   * Ahora hay plata de alguien y una unidad que **quizá se llevó otro**.
   *
   * ─── Lo que NO se hace ───
   *
   * No se revive la reserva vencida. `EXPIRED → CONSUMED` está prohibido y
   * seguirá estándolo: si en el medio otro comprador reservó esa unidad,
   * revivir la primera se la robaría a alguien que hizo todo bien.
   *
   * ─── Lo que sí ───
   *
   * Se intenta tomar stock disponible con una operación atómica que descuenta
   * de `onHand` sólo si hay. Si hay, la venta se confirma y nadie se entera. Si
   * no hay, la orden queda en `PAYMENT_REQUIRES_REFUND` y se devuelve la plata.
   *
   * ─── El principio ───
   *
   * **El dinero acreditado no autoriza a romper las reglas de inventario.**
   */
  async confirmarInventario(orderId: string, attemptId: string): Promise<string> {
    const orden = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        reservationId: true,
        items: { select: { productVariantId: true, quantity: true }, take: 1 },
      },
    });

    // Ya confirmada: webhook duplicado o reintento del conciliador.
    if (orden.status === 'CONFIRMED') return orden.status;
    // Todavía no hay plata, o ya se resolvió de otra forma.
    if (orden.status !== 'PAID') return orden.status;

    // ─── Camino feliz: la reserva sigue viva ───
    if (orden.reservationId) {
      const consumo = await this.inventory.consume(orden.reservationId);
      // `CONSUMED` cubre las dos formas de éxito: la consumió esta llamada, o
      // ya la había consumido una anterior (webhook duplicado).
      if (consumo.status === 'CONSUMED') return this.marcarConfirmada(orderId, attemptId);
    }

    // ─── Pago tardío ───
    const item = orden.items[0];
    if (!item) {
      this.logger.error({ msg: 'orden pagada sin líneas', orderId });
      return orden.status;
    }

    const recuperado = await this.inventory.consumeAvailableStockAfterLatePayment({
      productVariantId: item.productVariantId,
      quantity: item.quantity,
      orderId,
    });

    if (recuperado.ok) return this.marcarConfirmada(orderId, attemptId);

    return this.exigirDevolucion(
      orderId,
      attemptId,
      'LATE_PAYMENT_OUT_OF_STOCK',
      'Tu pago se acreditó pero el producto se agotó. Te estamos devolviendo el dinero.',
    );
  }

  private async marcarConfirmada(orderId: string, attemptId: string): Promise<string> {
    // La transición ES el candado: sólo la primera llamada afecta una fila.
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, status: 'PAID' },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });

    if (count > 0) {
      this.metrics.orders.inc({ result: 'confirmed' });
      this.events.publish(DomainEvent.orderConfirmed, {
        entityId: orderId,
        data: { attemptId },
      });
      void this.audit.log({
        action: 'order.confirmed',
        entityType: 'order',
        entityId: orderId,
        actorId: null,
        after: { attemptId },
      });
    }

    return 'CONFIRMED';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DEVOLUCIONES
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Hay plata que no corresponde. Se devuelve.
   *
   * La orden queda en `PAYMENT_REQUIRES_REFUND` **antes** de llamar al
   * proveedor. Si el proceso muriera en el medio, el estado ya dice que hay
   * una devolución pendiente y el conciliador la retoma. Al revés —llamar
   * primero y registrar después— dejaría plata devuelta sin rastro, o peor,
   * plata sin devolver sin rastro.
   */
  private async exigirDevolucion(
    orderId: string,
    attemptId: string,
    motivo: string,
    mensajeParaElComprador: string,
  ): Promise<string> {
    await this.prisma.order.updateMany({
      where: { id: orderId, status: 'PAID' },
      data: { status: 'PAYMENT_REQUIRES_REFUND', statusReason: mensajeParaElComprador },
    });

    this.metrics.orders.inc({ result: 'refund_required' });
    this.events.publish(DomainEvent.orderRefundRequired, {
      entityId: orderId,
      data: { attemptId, motivo },
    });
    void this.audit.log({
      action: 'order.payment_requires_refund',
      entityType: 'order',
      entityId: orderId,
      actorId: null,
      after: { attemptId, motivo },
    });

    await this.iniciarDevolucion(orderId, attemptId, motivo);
    return 'PAYMENT_REQUIRES_REFUND';
  }

  /**
   * Crea la devolución y la ejecuta.
   *
   * El índice único parcial sobre las devoluciones vivas de un intento impide
   * que dos ejecuciones simultáneas devuelvan la plata dos veces.
   */
  async iniciarDevolucion(orderId: string, attemptId: string, motivo: string): Promise<void> {
    const intento = await this.prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: { id: true, amount: true, providerPaymentId: true, status: true },
    });

    if (intento.status !== 'APPROVED' || !intento.providerPaymentId) {
      this.logger.error({
        msg: 'se pidió devolver un cobro que no está aprobado',
        attemptId,
        status: intento.status,
      });
      return;
    }

    const refundId = newId('ref');

    try {
      await this.prisma.refund.create({
        data: {
          id: refundId,
          orderId,
          paymentAttemptId: attemptId,
          provider: this.provider.nombre,
          status: 'PENDING',
          amount: intento.amount,
          reason: motivo,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Ya hay una devolución viva para este cobro. No se crea otra.
        this.logger.log({ msg: 'la devolución ya estaba en curso', attemptId });
        return;
      }
      throw err;
    }

    this.metrics.refunds.inc({ result: 'started' });
    this.events.publish(DomainEvent.refundStarted, {
      entityId: refundId,
      data: { orderId, attemptId, amount: intento.amount },
    });
    void this.audit.log({
      action: 'refund.started',
      entityType: 'refund',
      entityId: refundId,
      actorId: null,
      after: { orderId, attemptId, amount: intento.amount, motivo },
    });

    await this.ejecutarDevolucion(refundId);
  }

  /**
   * Le pide la devolución al proveedor.
   *
   * Idempotente por la clave: reintentar no devuelve la plata dos veces.
   * Separado de `iniciarDevolucion` para que el conciliador pueda reintentar
   * las que fallaron sin volver a crear la fila.
   */
  async ejecutarDevolucion(refundId: string): Promise<void> {
    const devolucion = await this.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { paymentAttempt: { select: { providerPaymentId: true } } },
    });

    if (devolucion.status === 'COMPLETED') return;

    const providerPaymentId = devolucion.paymentAttempt.providerPaymentId;
    if (!providerPaymentId) return;

    await this.prisma.$transaction([
      this.prisma.refund.update({
        where: { id: refundId },
        data: { status: 'PROCESSING', attempts: { increment: 1 } },
      }),
      this.prisma.order.updateMany({
        where: { id: devolucion.orderId, status: 'PAYMENT_REQUIRES_REFUND' },
        data: { status: 'REFUND_PENDING' },
      }),
    ]);

    try {
      const resultado = await this.provider.devolver(
        providerPaymentId,
        // La misma clave siempre para esta devolución: reintentar es seguro.
        `refund-${refundId}`,
        devolucion.amount,
      );

      const aprobada = resultado.status === 'approved' || resultado.status === 'refunded';

      if (!aprobada) {
        // El proveedor la aceptó pero todavía no la procesó. Queda en curso y
        // el conciliador vuelve a mirar.
        await this.prisma.refund.update({
          where: { id: refundId },
          data: { providerRefundId: resultado.id },
        });
        return;
      }

      await this.prisma.$transaction([
        this.prisma.refund.update({
          where: { id: refundId },
          data: {
            status: 'COMPLETED',
            providerRefundId: resultado.id,
            completedAt: new Date(),
            failureMessageSafe: null,
          },
        }),
        this.prisma.paymentAttempt.update({
          where: { id: devolucion.paymentAttemptId },
          data: { status: 'REFUNDED' },
        }),
        this.prisma.order.updateMany({
          where: { id: devolucion.orderId, status: { in: ['REFUND_PENDING', 'PAYMENT_REQUIRES_REFUND'] } },
          data: { status: 'REFUNDED', refundedAt: new Date() },
        }),
      ]);

      this.metrics.refunds.inc({ result: 'completed' });
      this.metrics.orders.inc({ result: 'refunded' });
      this.events.publish(DomainEvent.refundCompleted, {
        entityId: refundId,
        data: { orderId: devolucion.orderId },
      });
      this.events.publish(DomainEvent.orderRefunded, {
        entityId: devolucion.orderId,
        data: { refundId },
      });
      void this.audit.log({
        action: 'refund.completed',
        entityType: 'refund',
        entityId: refundId,
        actorId: null,
        after: { orderId: devolucion.orderId, providerRefundId: resultado.id },
      });
    } catch (err) {
      /**
       * Falló técnicamente. La orden **no** se da por resuelta.
       *
       * Se marca la devolución fallida y se vuelve a poner la orden en
       * `PAYMENT_REQUIRES_REFUND`, que es donde el conciliador la busca. Una
       * devolución que falla en silencio es plata de alguien que se queda acá
       * sin que nadie lo sepa.
       */
      const mensaje = err instanceof Error ? err.message : String(err);

      await this.prisma.$transaction([
        this.prisma.refund.update({
          where: { id: refundId },
          data: { status: 'FAILED', failureMessageSafe: 'No se pudo procesar la devolución' },
        }),
        this.prisma.order.updateMany({
          where: { id: devolucion.orderId, status: 'REFUND_PENDING' },
          data: { status: 'PAYMENT_REQUIRES_REFUND' },
        }),
      ]);

      this.metrics.refunds.inc({ result: 'failed' });
      this.events.publish(DomainEvent.refundFailed, {
        entityId: refundId,
        data: { orderId: devolucion.orderId },
      });
      void this.audit.log({
        action: 'refund.failed',
        entityType: 'refund',
        entityId: refundId,
        actorId: null,
        after: { orderId: devolucion.orderId, intentos: devolucion.attempts + 1 },
      });

      this.logger.error({
        msg: 'falló la devolución: queda pendiente para el conciliador',
        refundId,
        orderId: devolucion.orderId,
        intentos: devolucion.attempts + 1,
        error: mensaje,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNOS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Qué hacer cuando la llamada al proveedor no terminó bien.
   *
   * ─── La distinción que evita cobrar dos veces ───
   *
   * `ProviderUnavailableError` significa **no sabemos**: el cobro pudo haberse
   * procesado. El intento queda en `UNKNOWN_PENDING_RECONCILIATION` y la orden
   * en `PROCESSING_PAYMENT`, que es un estado que NO admite otro intento. El
   * conciliador va a preguntarle al proveedor.
   *
   * `ProviderRejectedError` significa que sí sabemos: no hay nada que
   * conciliar, y la persona puede probar con otra tarjeta.
   */
  private async manejarFalloDelProveedor(
    attemptId: string,
    orderId: string,
    err: unknown,
  ): Promise<string> {
    if (err instanceof ProviderRejectedError) {
      const mensaje = describePaymentOutcome({ errorBody: err.body });

      await this.prisma.$transaction([
        this.prisma.paymentAttempt.update({
          where: { id: attemptId },
          data: {
            status: 'REJECTED',
            failureCode: String(err.statusCode),
            failureMessageSafe: mensaje.text,
            lastCheckedAt: new Date(),
          },
        }),
        this.prisma.order.updateMany({
          where: { id: orderId, status: 'PROCESSING_PAYMENT' },
          data: { status: 'PAYMENT_FAILED', statusReason: mensaje.text },
        }),
      ]);

      this.metrics.paymentAttempts.inc({ result: 'rejected' });
      this.events.publish(DomainEvent.paymentRejected, {
        entityId: attemptId,
        data: { orderId },
      });
      return 'rejected';
    }

    // No sabemos. La orden se queda en PROCESSING_PAYMENT.
    await this.prisma.paymentAttempt.update({
      where: { id: attemptId },
      data: { status: 'UNKNOWN_PENDING_RECONCILIATION', lastCheckedAt: new Date() },
    });

    this.metrics.paymentAttempts.inc({ result: 'unknown' });
    this.events.publish(DomainEvent.paymentUnknown, {
      entityId: attemptId,
      data: { orderId },
    });
    void this.audit.log({
      action: 'payment.unknown',
      entityType: 'payment_attempt',
      entityId: attemptId,
      actorId: null,
      after: { orderId, motivo: err instanceof Error ? err.message : String(err) },
    });

    this.logger.warn({
      msg: 'cobro en estado desconocido: lo resuelve el conciliador',
      attemptId,
      orderId,
    });

    return 'unknown';
  }

  private traducirFallo(err: unknown, attemptId: string): DomainError {
    if (err instanceof ProviderUnavailableError) return new PaymentStateUnknownError(attemptId);
    if (err instanceof ProviderPaymentNotFoundError) {
      return new DomainError('PAYMENT_STATE_UNKNOWN', 'Estamos verificando tu pago', { attemptId });
    }
    return new PaymentStateUnknownError(attemptId);
  }

  /**
   * Clave de idempotencia de un cobro. Ver la explicación larga en `cobrar`.
   *
   * Se guarda el hash y no el token: esta cadena viaja en cabeceras y termina
   * en la bitácora, y ahí no puede quedar nada que sirva para cobrar.
   */
  private claveDeCobro(orderId: string, cardToken: string): string {
    const huella = createHash('sha256').update(cardToken).digest('hex').slice(0, 16);
    return `pay-${orderId}-${huella}`;
  }

  /** El neto del vendedor cambia cuando se conoce el costo real del procesador. */
  private async recalcularNeto(orderId: string): Promise<void> {
    const orden = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        grossAmount: true,
        platformFeeAmount: true,
        paymentProcessorFeeAmount: true,
      },
    });
    if (orden.paymentProcessorFeeAmount == null) return;

    /**
     * ⚠️ Se usa `netoConCostoDeProcesador` y no la resta escrita a mano.
     *
     * Estaba duplicada: la fórmula vivía acá en línea Y en `pricing.ts`, donde
     * la cubren los tests. O sea que lo probado no era lo que corría — cambiar
     * la función dejaba los tests en verde y la producción con la cuenta
     * vieja.
     *
     * Las dos daban el mismo número, así que no había un error de plata. Lo
     * que había era una prueba que no protegía nada.
     */
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        sellerNetAmount: netoConCostoDeProcesador(
          {
            grossAmount: orden.grossAmount,
            platformFeeAmount: orden.platformFeeAmount,
          } as Precio,
          orden.paymentProcessorFeeAmount,
        ),
      },
    });
  }

  /** Estados que el conciliador tiene que resolver. Expuesto para los tests. */
  static necesitaConciliacion(status: PaymentAttemptStatus): boolean {
    return status === 'PROCESSING' || status === 'UNKNOWN_PENDING_RECONCILIATION';
  }

  /** Tope de reintentos de una devolución antes de escalarla a mano. */
  static get maxIntentosDeDevolucion(): number {
    return env.REFUND_MAX_ATTEMPTS;
  }
  /**
   * El token del vendedor, o `null` si no se puede obtener.
   *
   * Quien llama DEBE tratar el `null` como un cobro que no se hace. Ya no hay
   * respaldo a la cuenta de VendoX: ver el comentario largo en `cobrar()`.
   *
   * ⛔ El token que devuelve no se guarda en ningún lado ni se registra.
   */
  private async tokenDelVendedor(sellerId: string): Promise<string | null> {
    if (!this.sellerOAuth.disponible) return null;

    try {
      return await this.sellerOAuth.accessTokenDe(sellerId);
    } catch (err) {
      /**
       * Que no se pueda leer el token no puede tumbar el cobro.
       *
       * Se registra —hay que enterarse de que ese vendedor no está cobrando en
       * su cuenta— y se sigue con la nuestra. La alternativa es que la persona
       * que está comprando vea un error por un problema de configuración del
       * vendedor, que no puede resolver ni entender.
       */
      this.logger.warn({
        msg: 'no se pudo usar la cuenta del vendedor: el cobro va a la cuenta de VendoX',
        sellerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
