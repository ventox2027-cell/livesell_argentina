import { Injectable } from '@nestjs/common';

import {
  MercadoPagoService,
  MpApiError,
  MpNetworkError,
  scrubMpPayment,
  type MpPayment,
  type MpRefund,
} from '@/modules/payments/mp.client';

import {
  PaymentProvider,
  ProviderPaymentNotFoundError,
  ProviderRejectedError,
  ProviderUnavailableError,
  type CobrarInput,
  type ProviderPayment,
  type ProviderRefund,
} from './payment-provider';
import { centavosAMonto, montoACentavos } from './pricing';

/**
 * Mercado Pago detrás del contrato genérico.
 *
 * ─── Qué hace esta clase, exactamente ───
 *
 * Traduce. El cliente HTTP del Sprint 0B ya funciona y está probado contra
 * Mercado Pago real: no se reescribe. Lo que falta es la capa que convierte
 * sus formas —`MpPayment`, `MpNetworkError`— en las del dominio, para que
 * `OrdersService` nunca vea un tipo con `Mp` en el nombre.
 *
 * ─── La traducción que importa ───
 *
 *     MpNetworkError  →  ProviderUnavailableError   (no sabemos)
 *     MpApiError 4xx  →  ProviderRejectedError      (sabemos que no)
 *     MpApiError 404  →  ProviderPaymentNotFoundError
 *
 * La primera es la crítica. El cliente ya distingue bien —lanza
 * `MpNetworkError` ante timeouts, 5xx y 429— y esa distinción se conserva
 * hasta arriba. Si se aplastaran las dos en un solo error, el módulo de
 * órdenes no podría saber si un cobro se procesó, y la única salida segura
 * sería no cobrar nunca dos veces... o cobrar dos veces siempre.
 *
 * ─── Centavos afuera, unidades adentro ───
 *
 * Todo el proyecto trabaja en centavos enteros. Mercado Pago quiere unidades
 * con decimales. La conversión ocurre acá y en ningún otro lado: si se
 * repartiera, algún día un camino mandaría centavos donde iban pesos y se
 * cobraría cien veces de más.
 */
@Injectable()
export class MercadoPagoPaymentProvider extends PaymentProvider {
  readonly nombre = 'MERCADO_PAGO' as const;

  constructor(private readonly mp: MercadoPagoService) {
    super();
  }

  get clavePublica(): string {
    return this.mp.publicKey;
  }

  get urlDeNotificacion(): string | undefined {
    return this.mp.notificationUrl;
  }

  async cobrar(input: CobrarInput, idempotencyKey: string): Promise<ProviderPayment> {
    try {
      const pago = await this.mp.createPayment(
        {
          token: input.cardToken,
          transactionAmount: centavosAMonto(input.amount),
          installments: input.installments,
          paymentMethodId: input.paymentMethodId,
          payerEmail: input.payerEmail,
          description: input.description,
          externalReference: input.externalReference,
          notificationUrl: this.mp.notificationUrl,
          // Centavos adentro, unidades de moneda hacia afuera. La conversión
          // vive acá porque es un detalle del formato de la API de Mercado
          // Pago, no una regla de negocio.
          applicationFee:
            input.applicationFee === undefined ? undefined : centavosAMonto(input.applicationFee),
          sellerAccessToken: input.sellerAccessToken,
        },
        idempotencyKey,
      );
      return this.traducir(pago);
    } catch (err) {
      throw this.traducirError(err);
    }
  }

  async consultar(providerPaymentId: string): Promise<ProviderPayment> {
    try {
      return this.traducir(await this.mp.getPayment(providerPaymentId));
    } catch (err) {
      // El simulador de Mercado Pago manda notificaciones con ids inventados.
      // Un 404 no es un fallo del sistema: es un pago que no existe.
      if (err instanceof MpApiError && err.status === 404) {
        throw new ProviderPaymentNotFoundError(providerPaymentId);
      }
      throw this.traducirError(err);
    }
  }

  async buscarPorReferencia(externalReference: string): Promise<ProviderPayment[]> {
    try {
      const pagos = await this.mp.searchPaymentsByExternalReference(externalReference);
      return pagos.map((p) => this.traducir(p));
    } catch (err) {
      throw this.traducirError(err);
    }
  }

  async devolver(
    providerPaymentId: string,
    idempotencyKey: string,
    amount?: number,
  ): Promise<ProviderRefund> {
    try {
      const devolucion = await this.mp.refundPayment(
        providerPaymentId,
        idempotencyKey,
        amount === undefined ? undefined : centavosAMonto(amount),
      );
      return this.traducirDevolucion(devolucion);
    } catch (err) {
      throw this.traducirError(err);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────

  private traducir(pago: MpPayment): ProviderPayment {
    return {
      id: String(pago.id),
      status: pago.status,
      statusDetail: pago.status_detail,
      amount: pago.transaction_amount === undefined ? undefined : montoACentavos(pago.transaction_amount),
      currency: pago.currency_id,
      externalReference: pago.external_reference,
      approvedAt: pago.date_approved,
      // Últimos cuatro y marca. Nada más de la tarjeta cruza esta frontera.
      lastFour: pago.card?.last_four_digits,
      brand: pago.payment_method_id,
      paymentType: pago.payment_type_id,
      feeAmount: this.costoDelProcesador(pago),
      // Saneado ANTES de salir de acá: esto se guarda y se registra.
      raw: scrubMpPayment(pago),
    };
  }

  private traducirDevolucion(d: MpRefund): ProviderRefund {
    return {
      id: String(d.id),
      status: d.status ?? 'pending',
      amount: d.amount === undefined ? undefined : montoACentavos(d.amount),
      raw: scrubMpPayment(d),
    };
  }

  /**
   * Cuánto se quedó Mercado Pago.
   *
   * Viene en `fee_details`, una lista con varios conceptos. Sólo interesa el de
   * tipo `mercadopago_fee`: los otros —descuentos financiados, cuotas sin
   * interés— son cosas distintas que no van a esta columna.
   *
   * Devuelve `undefined` si no está. **No se estima nunca**: una estimación
   * guardada junto a datos reales es indistinguible de un dato real meses
   * después, y la diferencia aparece al conciliar contra el banco.
   */
  private costoDelProcesador(pago: MpPayment): number | undefined {
    const detalles = pago.fee_details;
    if (!Array.isArray(detalles)) return undefined;

    const comision = detalles.find(
      (d): d is { type?: string; amount?: number } =>
        typeof d === 'object' && d !== null && (d as { type?: string }).type === 'mercadopago_fee',
    );
    if (!comision || typeof comision.amount !== 'number') return undefined;

    return montoACentavos(comision.amount);
  }

  private traducirError(err: unknown): Error {
    // El orden importa: MpNetworkError es lo que el cliente lanza ante
    // timeouts, 5xx y 429, y es lo que NO se puede confundir con un rechazo.
    if (err instanceof MpNetworkError) {
      return new ProviderUnavailableError(err.message, err.cause);
    }
    if (err instanceof MpApiError) {
      return new ProviderRejectedError(err.status, err.body, err.message);
    }
    // Cualquier otra cosa es también "no sabemos". Ante la duda, la respuesta
    // segura es la que obliga a conciliar, no la que da el cobro por perdido.
    return new ProviderUnavailableError(
      err instanceof Error ? err.message : String(err),
      err,
    );
  }
}
