/**
 * El contrato con un procesador de pagos.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ÓRDENES NO CONOCE A MERCADO PAGO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `OrdersService` no importa `MercadoPagoService` en ningún lado. Habla con
 * esta interfaz.
 *
 * No es abstracción por deporte. Es que el día que haya que agregar MODO, o
 * que Mercado Pago cambie su API de Payments por la de Orders —cosa que ya
 * está marcada como recomendada—, el cambio tiene que ser una clase nueva y no
 * una cirugía sobre la lógica de ventas.
 *
 * ─── Y por qué no se abstrae más ───
 *
 * No hay `PaymentGatewayFactoryProvider` ni configuración por tienda. Hoy hay
 * un solo proveedor. La interfaz existe para marcar el límite —de acá para
 * allá es territorio del proveedor— no para soportar proveedores que nadie
 * pidió.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA DISTINCIÓN QUE HACE QUE ESTO SEA SEGURO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Los métodos distinguen tres desenlaces, no dos:
 *
 *   · Aprobado o rechazado  → sabemos qué pasó.
 *   · `ProviderUnavailableError` → **no sabemos**.
 *
 * El tercero es el que importa. Si se manda un cobro y se pierde la conexión,
 * el pago pudo haberse procesado igual. Tratarlo como rechazo significa
 * decirle a alguien que no le cobraron cuando sí, y dejarlo pagar de nuevo.
 *
 * Por eso un fallo de red lanza un error DISTINTO de un rechazo, y quien llama
 * está obligado a distinguirlos.
 */

/**
 * Estado del pago según el proveedor, tal cual lo manda.
 *
 * Es `string` a propósito y no una unión cerrada: Mercado Pago agrega estados
 * sin avisar, y un tipo cerrado haría que un estado nuevo ni siquiera compile
 * — o peor, que se lo trate como conocido. La interpretación ocurre en un solo
 * lugar, `mapearEstadoMp`, cuyo `default` marca lo desconocido para conciliar
 * en vez de adivinar.
 *
 * Los valores que hoy conocemos están documentados abajo, no en el tipo.
 *
 *   approved · rejected · pending · in_process · authorized
 *   cancelled · refunded · charged_back
 */
export type ProviderPaymentStatus = string;

export interface ProviderPayment {
  id: string;
  status: ProviderPaymentStatus;
  statusDetail?: string;
  amount?: number;
  currency?: string;
  /** Nuestro id de orden, para conciliar. */
  externalReference?: string;
  approvedAt?: string | null;
  /** Lo ÚNICO que se guarda de la tarjeta, además de la marca. */
  lastFour?: string;
  brand?: string;
  paymentType?: string;
  /** Cuánto cobró el proveedor, si lo informa en esta respuesta. */
  feeAmount?: number;
  /** Respuesta cruda YA SANEADA, para auditoría. */
  raw: Record<string, unknown>;
}

export interface ProviderRefund {
  id: string;
  /** `approved`, `pending` o `rejected`. Ver la nota de ProviderPaymentStatus. */
  status: string;
  amount?: number;
  raw: Record<string, unknown>;
}

export interface CobrarInput {
  /** Token de un solo uso. Nunca se guarda, nunca se registra. */
  cardToken: string;
  amount: number;
  installments: number;
  paymentMethodId: string;
  payerEmail: string;
  description: string;
  externalReference: string;

  /**
   * La comisión de VendoX, en CENTAVOS.
   *
   * En centavos como todo el dinero del proyecto. La conversión a unidades de
   * moneda -que es lo que Mercado Pago espera- la hace el proveedor, que es el
   * único que conoce el formato de su API.
   */
  applicationFee?: number;

  /**
   * El token del vendedor, si cobra en su propia cuenta.
   *
   * ⛔ Se pasa en claro y muere con la llamada. Sin esto, el cobro entra en la
   * cuenta de VendoX.
   */
  sellerAccessToken?: string;
}

/**
 * No sabemos qué pasó del otro lado.
 *
 * Timeout, corte de red, 5xx o 429. **No es un rechazo.** Quien recibe esto
 * tiene que dejar el intento en `UNKNOWN_PENDING_RECONCILIATION` y esperar al
 * conciliador. Nunca marcarlo fallido, nunca dejar reintentar a ciegas.
 */
export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * El proveedor entendió la petición y la rechazó por una razón concreta.
 *
 * A diferencia de la anterior, acá SÍ sabemos: no hay nada que conciliar.
 */
export class ProviderRejectedError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRejectedError';
  }
}

/** No existe ese pago del lado del proveedor. */
export class ProviderPaymentNotFoundError extends Error {
  constructor(readonly providerPaymentId: string) {
    super(`El proveedor no conoce el pago ${providerPaymentId}`);
    this.name = 'ProviderPaymentNotFoundError';
  }
}

/**
 * Clase abstracta y no `interface` a propósito: NestJS inyecta por token en
 * tiempo de ejecución, y una interfaz de TypeScript no existe ahí.
 */
export abstract class PaymentProvider {
  abstract readonly nombre: 'MERCADO_PAGO';

  /**
   * Cobra.
   *
   * La clave de idempotencia identifica UN COBRO. Reintentar por red usa la
   * misma; probar con otra tarjeta genera una nueva. Ver `PaymentAttempt`.
   */
  abstract cobrar(input: CobrarInput, idempotencyKey: string): Promise<ProviderPayment>;

  /** Le pregunta al proveedor cómo quedó un pago. Es la fuente de verdad externa. */
  abstract consultar(providerPaymentId: string): Promise<ProviderPayment>;

  /** Busca por nuestro id de orden. Para cuando ni siquiera se guardó el id del pago. */
  abstract buscarPorReferencia(externalReference: string): Promise<ProviderPayment[]>;

  abstract devolver(
    providerPaymentId: string,
    idempotencyKey: string,
    amount?: number,
  ): Promise<ProviderRefund>;

  /** Clave pública para el formulario de tarjeta. No es un secreto. */
  abstract get clavePublica(): string;

  abstract get urlDeNotificacion(): string | undefined;
}
