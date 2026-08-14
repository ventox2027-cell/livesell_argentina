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

    return this.request<MpPayment>('POST', '/v1/payments', {
      body,
      idempotencyKey,
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
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const url = `${env.MP_API_BASE_URL}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
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
