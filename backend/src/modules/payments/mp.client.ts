import { Injectable, Logger } from '@nestjs/common';

import { env } from '@/config/env.schema';

/**
 * Cliente HTTP de Mercado Pago.
 *
 * Es el ÚNICO lugar del backend que conoce `MP_ACCESS_TOKEN`. Cualquier otra
 * capa que quiera hablar con Mercado Pago pasa por acá, igual que
 * `LiveKitService` con el secreto de LiveKit.
 *
 * Tres responsabilidades, y ninguna más:
 *   1. Firmar cada llamada con el access token.
 *   2. Hacer que un timeout de red NUNCA se confunda con un rechazo.
 *   3. Sanear la respuesta antes de que llegue a un log o a la base.
 */

/** Error de transporte: no sabemos qué pasó con el cobro. */
export class MpNetworkError extends Error {
  constructor(
    message: string,
    // `override` porque Error ya define `cause`. Se mantiene ese nombre a
    // propósito: es el que esperan los formateadores de errores de Node.
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MpNetworkError';
  }
}

/** Mercado Pago respondió, y respondió que no. Sí sabemos qué pasó. */
export class MpApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'MpApiError';
  }
}

export interface MpPayment {
  id: number;
  status: string;
  status_detail?: string;
  transaction_amount?: number;
  currency_id?: string;
  installments?: number;
  payment_method_id?: string;
  payment_type_id?: string;
  external_reference?: string;
  date_approved?: string | null;
  card?: {
    last_four_digits?: string;
    first_six_digits?: string;
    expiration_month?: number;
    expiration_year?: number;
  };
  [key: string]: unknown;
}

export interface MpRefund {
  id: number | string;
  payment_id?: number | string;
  amount?: number;
  status?: string;
  date_created?: string;
  [key: string]: unknown;
}

/**
 * Lo que hace falta para armar un Checkout Pro.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CHECKOUT PRO Y CHECKOUT API SON DOS COSAS DISTINTAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Hasta ahora VendoX usaba **sólo Checkout API**: el CardForm genera un token
 * de tarjeta en el teléfono y nosotros creamos el pago con `POST /v1/payments`.
 * Todo el cobro pasa por nuestro backend.
 *
 * «Pagar con Mercado Pago» es lo otro: se crea una **preferencia** y la persona
 * termina de pagar del lado de ellos —en su app si la tiene instalada, o en su
 * web si no—. Nosotros nunca vemos el medio de pago.
 *
 * Los dos conviven sin pisarse porque comparten lo único que importa para
 * conciliar: `external_reference` es el id de nuestra orden, y el webhook es la
 * fuente de verdad en los dos casos.
 *
 * ─── La comisión se llama distinto en cada uno ───
 *
 * En Checkout API es `application_fee`. En una preferencia es
 * **`marketplace_fee`**. Es el mismo concepto —lo que Mercado Pago nos deposita
 * a nosotros del cobro que entra en la cuenta del vendedor— con dos nombres,
 * y mandar el de la otra API no da error: se ignora en silencio y la comisión
 * no se cobra.
 */
export interface CreatePreferenceInput {
  /** Nuestro id de orden. Es la llave para conciliar. */
  externalReference: string;
  titulo: string;
  /** En unidades de moneda, no en centavos. */
  monto: number;
  payerEmail: string;
  notificationUrl?: string;

  /**
   * La comisión de VendoX, en unidades de moneda.
   *
   * ⚠️ Sólo tiene sentido junto con `sellerAccessToken`: es lo que Mercado Pago
   * descuenta del cobro que entra en la cuenta del vendedor. Sin cuenta del
   * vendedor no hay de dónde descontarla.
   */
  marketplaceFee?: number;

  /**
   * A dónde vuelve la persona cuando termina.
   *
   * Son enlaces de `vendox.com.ar`, que es un App Link verificado: Android
   * abre la app directamente. Si no está instalada, cae en la web.
   */
  backUrls: { success: string; pending: string; failure: string };

  /**
   * El token del vendedor. El cobro entra en SU cuenta.
   *
   * Es el mismo mecanismo de marketplace que ya usa el cobro con tarjeta. Sin
   * esto, el dinero entraría en la cuenta de VendoX y tendríamos que girarlo a
   * mano — exactamente lo que se decidió no hacer nunca.
   */
  sellerAccessToken?: string;
}

export interface MpPreference {
  id: string;
  /** La URL donde se paga. Es la que se abre en el teléfono. */
  init_point?: string;
  sandbox_init_point?: string;
}

export interface CreatePaymentInput {
  /** Token de tarjeta de un solo uso, generado en el cliente. Nunca se guarda. */
  token: string;
  transactionAmount: number;
  installments: number;
  paymentMethodId: string;
  payerEmail: string;
  description: string;
  /** Nuestro id de orden. Es la llave para conciliar. */
  externalReference: string;
  notificationUrl?: string;
  /** Para cobrar con tarjeta guardada. */
  issuerId?: string;
  payerCustomerId?: string;

  /**
   * La comisión de VendoX, en unidades de moneda (no en centavos).
   *
   * Mercado Pago la descuenta del cobro y la deposita en NUESTRA cuenta; el
   * resto va a la del vendedor, en el mismo movimiento. Nunca tocamos la plata
   * de nadie.
   *
   * Sólo tiene efecto junto con `sellerAccessToken`: sobre nuestra propia
   * cuenta, cobrarnos comisión a nosotros mismos no significa nada.
   */
  applicationFee?: number;

  /**
   * El access token del vendedor, para cobrar en SU cuenta.
   *
   * ⛔ Llega en claro, se usa y muere con la llamada. No se guarda, no se
   * registra y no se reenvía. Lo descifra `SellerOAuthService` justo antes.
   *
   * Sin esto, el cobro entra en la cuenta de VendoX: estaríamos moviendo plata
   * de terceros por nuestro balance, que es exactamente lo que el modelo de
   * marketplace existe para evitar.
   */
  sellerAccessToken?: string;
}

/**
 * Campos que NO pueden quedar registrados en ningún lado.
 *
 * `first_six_digits` (el BIN) técnicamente se puede almacenar, pero junto con
 * los últimos cuatro reduce mucho el espacio de búsqueda de un PAN y no lo
 * necesitamos para nada. Se va.
 */
const SENSITIVE_PATHS = [
  ['card', 'cardholder'],
  ['card', 'first_six_digits'],
  ['payer', 'identification'],
  ['additional_info', 'payer'],
  ['token'],
  ['three_ds_info'],
];

/**
 * Devuelve una copia sin los campos sensibles.
 *
 * Se aplica ANTES de escribir en la base y ANTES de loguear, no después: un
 * `logger.debug(response)` puesto al apuro durante una depuración es
 * exactamente cómo un número de tarjeta termina en un agregador de logs.
 */
export function scrubMpPayment(payment: unknown): Record<string, unknown> {
  if (payment == null || typeof payment !== 'object') return {};
  const copy = structuredClone(payment) as Record<string, unknown>;

  for (const path of SENSITIVE_PATHS) {
    let node: Record<string, unknown> | undefined = copy;
    for (let i = 0; i < path.length - 1 && node; i += 1) {
      const next: unknown = node[path[i]!];
      node =
        next != null && typeof next === 'object' ? (next as Record<string, unknown>) : undefined;
    }
    if (node) delete node[path[path.length - 1]!];
  }

  return copy;
}

@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);

  private get token(): string {
    const token = env.MP_ACCESS_TOKEN;
    if (!token) throw new MpNetworkError('MP_ACCESS_TOKEN no está configurado');
    return token;
  }

  /** La public key es lo único que puede viajar al teléfono. */
  get publicKey(): string {
    return env.MP_PUBLIC_KEY ?? '';
  }

  get notificationUrl(): string | undefined {
    return env.MP_NOTIFICATION_URL;
  }

  /**
   * Crea un pago.
   *
   * `idempotencyKey` es obligatorio y no tiene valor por defecto a propósito:
   * quien llama tiene que decidir conscientemente cuál es la unidad de
   * "el mismo cobro". Un default generado acá haría que dos toques del botón
   * produjeran dos cobros, que es justo lo que hay que evitar.
   */
  async createPayment(input: CreatePaymentInput, idempotencyKey: string): Promise<MpPayment> {
    const body: Record<string, unknown> = {
      token: input.token,
      transaction_amount: input.transactionAmount,
      installments: input.installments,
      payment_method_id: input.paymentMethodId,
      description: input.description,
      external_reference: input.externalReference,
      payer: { email: input.payerEmail },
    };
    if (input.issuerId) body.issuer_id = input.issuerId;
    if (input.payerCustomerId) {
      body.payer = { ...(body.payer as object), type: 'customer', id: input.payerCustomerId };
    }
    const notificationUrl = input.notificationUrl ?? this.notificationUrl;
    if (notificationUrl) body.notification_url = notificationUrl;

    /**
     * La comisión sólo viaja si es mayor que cero.
     *
     * Mercado Pago rechaza `application_fee: 0` con un error que no dice cuál
     * es el problema. Y un cobro sin comisión es un caso legítimo —una venta de
     * un peso, donde el 6 % redondea a cero— así que no puede fallar.
     */
    if (input.applicationFee !== undefined && input.applicationFee > 0) {
      body.application_fee = input.applicationFee;
    }

    return this.request<MpPayment>('POST', '/v1/payments', {
      body,
      idempotencyKey,
      // Con el token del vendedor, el cobro entra en SU cuenta y Mercado Pago
      // nos deposita la comisión en el mismo movimiento. Sin él, entra en la
      // nuestra — que es lo que hace el spike.
      accessToken: input.sellerAccessToken,
    });
  }

  /**
   * Crea una preferencia de Checkout Pro.
   *
   * ⚠️ `idempotencyKey` es obligatoria por el mismo motivo que en `createPayment`:
   * dos toques del botón no pueden dejar dos preferencias abiertas para la
   * misma orden.
   */
  async createPreference(
    input: CreatePreferenceInput,
    idempotencyKey: string,
  ): Promise<MpPreference> {
    const body: Record<string, unknown> = {
      items: [
        {
          title: input.titulo,
          quantity: 1,
          unit_price: input.monto,
          currency_id: 'ARS',
        },
      ],
      payer: { email: input.payerEmail },
      external_reference: input.externalReference,
      back_urls: input.backUrls,

      /**
       * Vuelve sola cuando el pago se aprueba.
       *
       * ⚠️ Sólo con `approved`. Con `all`, Mercado Pago devuelve también los
       * pagos pendientes de la misma forma, y la app no tendría cómo distinguir
       * «pagaste» de «falta que se acredite» sin preguntar igual. Prefiere que
       * la persona toque «Volver» y que el estado lo diga el webhook.
       */
      auto_return: 'approved',

      /**
       * Que no ofrezca lo que no podemos cumplir.
       *
       * Un pago en efectivo se acredita en días. Para una compra en un vivo,
       * donde el stock está reservado por minutos, eso es prometer algo que la
       * reserva no aguanta.
       */
      payment_methods: {
        excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }],
      },
    };

    const notificationUrl = input.notificationUrl ?? this.notificationUrl;
    if (notificationUrl) body.notification_url = notificationUrl;

    // Igual que `application_fee`: cero lo rechaza, y una venta chica puede
    // redondear a cero legítimamente.
    if (input.marketplaceFee !== undefined && input.marketplaceFee > 0) {
      body.marketplace_fee = input.marketplaceFee;
    }

    return this.request<MpPreference>('POST', '/checkout/preferences', {
      body,
      idempotencyKey,
      accessToken: input.sellerAccessToken,
    });
  }

  /**
   * Estado autoritativo de un pago.
   *
   * Es la llamada más importante del módulo: el estado NUNCA se toma del
   * cuerpo de un webhook, siempre de acá.
   */
  async getPayment(mpPaymentId: string | number): Promise<MpPayment> {
    return this.request<MpPayment>('GET', `/v1/payments/${mpPaymentId}`);
  }

  /**
   * Busca pagos por nuestra referencia de orden. Es lo que usa el conciliador
   * cuando un webhook se pierde: preguntamos "¿hay algún pago para esta orden?"
   * en vez de esperar un aviso que quizá nunca llegue.
   */
  /**
   * Devuelve la plata de un cobro.
   *
   * ─── Por qué la clave de idempotencia es obligatoria acá ───
   *
   * Una devolución reintentada sin clave devuelve la plata DOS veces. Con
   * clave, Mercado Pago reconoce el reintento y responde lo mismo que la
   * primera vez.
   *
   * Sin `amount` devuelve el total. Devoluciones parciales quedan soportadas
   * por el parámetro aunque hoy no se usen: el caso que tenemos —pago
   * acreditado sin stock— siempre devuelve todo.
   */
  async refundPayment(
    mpPaymentId: string | number,
    idempotencyKey: string,
    amount?: number,
  ): Promise<MpRefund> {
    return this.request<MpRefund>('POST', `/v1/payments/${mpPaymentId}/refunds`, {
      body: amount === undefined ? {} : { amount },
      idempotencyKey,
    });
  }

  /** Estado de una devolución concreta. Lo usa el conciliador. */
  async getRefund(mpPaymentId: string | number, refundId: string | number): Promise<MpRefund> {
    return this.request<MpRefund>('GET', `/v1/payments/${mpPaymentId}/refunds/${refundId}`);
  }

  async searchPaymentsByExternalReference(externalReference: string): Promise<MpPayment[]> {
    const res = await this.request<{ results?: MpPayment[] }>(
      'GET',
      `/v1/payments/search?external_reference=${encodeURIComponent(externalReference)}&sort=date_created&criteria=desc`,
    );
    return res.results ?? [];
  }

  async findCustomerByEmail(email: string): Promise<{ id: string } | null> {
    const res = await this.request<{ results?: Array<{ id: string }> }>(
      'GET',
      `/v1/customers/search?email=${encodeURIComponent(email)}`,
    );
    return res.results?.[0] ?? null;
  }

  async createCustomer(email: string): Promise<{ id: string }> {
    return this.request<{ id: string }>('POST', '/v1/customers', { body: { email } });
  }

  /**
   * Guarda la tarjeta EN MERCADO PAGO a partir de un token de un solo uso.
   * Nosotros nos quedamos con el id que devuelve; el número no pasa por acá.
   */
  async saveCard(customerId: string, token: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'POST',
      `/v1/customers/${customerId}/cards`,
      { body: { token } },
    );
  }

  async listCards(customerId: string): Promise<Array<Record<string, unknown>>> {
    return this.request<Array<Record<string, unknown>>>(
      'GET',
      `/v1/customers/${customerId}/cards`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; accessToken?: string } = {},
  ): Promise<T> {
    const url = `${env.MP_API_BASE_URL}${path}`;
    const headers: Record<string, string> = {
      // El token del vendedor cuando se cobra en su nombre; el nuestro si no.
      // ⛔ NUNCA se registra: ni acá, ni en el log de la petición, ni en el del
      // error. Ver `camposProhibidos`.
      Authorization: `Bearer ${opts.accessToken ?? this.token}`,
      'Content-Type': 'application/json',
    };
    if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;

    // AbortSignal.timeout y no un setTimeout manual: sin esto una llamada
    // colgada bloquea el request del comprador hasta el timeout del proxy.
    const controller = AbortSignal.timeout(env.MP_TIMEOUT_MS);
    const startedAt = Date.now();

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller,
      });
    } catch (err) {
      /**
       * Acá está el matiz que decide si perdemos plata.
       *
       * Un timeout NO significa que el cobro falló: significa que no sabemos.
       * El pago puede haberse creado perfectamente del lado de Mercado Pago.
       * Por eso esto lanza `MpNetworkError` y no un error de negocio: quien
       * llama tiene que dejar la orden en PROCESSING y dejar que el
       * conciliador averigüe la verdad. Marcarla FAILED sería mentir.
       */
      this.logger.error({
        msg: 'fallo de red contra Mercado Pago',
        path,
        elapsedMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new MpNetworkError(`No se pudo contactar a Mercado Pago (${path})`, err);
    }

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      // 5xx y 429 tampoco son "el pago falló": son "no sabemos".
      if (res.status >= 500 || res.status === 429) {
        throw new MpNetworkError(`Mercado Pago respondió ${res.status} en ${path}`, parsed);
      }
      const message =
        (parsed as { message?: string } | null)?.message ?? `Mercado Pago rechazó ${path}`;
      this.logger.warn({
        msg: 'Mercado Pago devolvió error',
        path,
        status: res.status,
        // Ya saneado: el cuerpo de error puede repetir datos del pagador.
        body: scrubMpPayment(parsed),
      });
      throw new MpApiError(res.status, parsed, message);
    }

    return parsed as T;
  }
}
