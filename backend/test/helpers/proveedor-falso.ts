import {
  PaymentProvider,
  ProviderPaymentNotFoundError,
  ProviderRejectedError,
  ProviderUnavailableError,
  type CobrarInput,
  type ProviderPayment,
  type ProviderRefund,
} from '@/modules/orders/payment-provider';

/**
 * Un procesador de pagos controlable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ MERCADO PAGO SE REEMPLAZA Y LA BASE NO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Los escenarios que rompen un sistema de pagos son tres, y sólo uno se puede
 * provocar contra Mercado Pago real:
 *
 *   · Un cobro aprobado — sí, con una tarjeta de prueba.
 *   · Un cobro rechazado — sí, con otra tarjeta de prueba.
 *   · **Un cobro del que nunca vamos a saber el resultado** — no.
 *
 * El tercero es el que importa. No hay forma de pedirle a Mercado Pago que
 * "acepte el cobro pero corte la conexión antes de responder", y ese es
 * exactamente el caso donde un sistema cobra dos veces o se queda con plata
 * ajena.
 *
 * Por eso el proveedor es falso y todo lo demás es real: PostgreSQL, las
 * transiciones, los índices únicos, los CHECK y la concurrencia. Lo que se
 * prueba no es que sepamos llamar a una API — eso ya se verificó en el Sprint
 * 0B contra Mercado Pago de verdad, con una compra real acreditada en 1,8 s—
 * sino que **no se pueda vender dos veces la misma unidad ni quedarse con la
 * plata de nadie**.
 */

type Guion =
  | { status: string; id?: string; statusDetail?: string; lastFour?: string; brand?: string; feeAmount?: number; externalReference?: string | null }
  | { fallo: 'red' }
  | { fallo: 'rechazo'; body?: unknown }
  | { fallo: 'no_encontrado' };

export class ProveedorFalso extends PaymentProvider {
  readonly nombre = 'MERCADO_PAGO' as const;

  /** Qué va a pasar en el próximo `cobrar()`. */
  proximo: Guion = { status: 'approved' };

  /**
   * Guion POR TOKEN de tarjeta.
   *
   * ─── Por qué hace falta además de `proximo` ───
   *
   * `proximo` es un campo compartido: con trescientos cobros concurrentes,
   * todos leen el último valor escrito y el escenario que cada uno quería
   * probar se pierde. Es un defecto sutil, y engañoso: la prueba de estrés
   * decía "70 % aprobados, 20 % rechazados" y en realidad daba 100 % de lo
   * que hubiera puesto la última petición en llegar.
   *
   * Con el guion atado al token, cada cobro concurrente obtiene el suyo.
   */
  readonly porToken = new Map<string, Guion>();
  /** Qué va a devolver `consultar()`. Lo usa el conciliador y el webhook. */
  alConsultar: Guion | null = null;
  /** Qué va a devolver `buscarPorReferencia()`. */
  alBuscar: ProviderPayment[] | null = null;
  /** Si las devoluciones fallan técnicamente. */
  devolucionFalla = false;

  llamadasACobrar = 0;
  llamadasAConsultar = 0;
  llamadasADevolver = 0;

  private secuencia = 0;
  /** Lo que se "cobró", por id: `consultar` responde coherente con `cobrar`. */
  private readonly cobrados = new Map<string, ProviderPayment>();

  reiniciar(): void {
    this.proximo = { status: 'approved' };
    this.alConsultar = null;
    this.alBuscar = null;
    this.devolucionFalla = false;
    this.llamadasACobrar = 0;
    this.llamadasAConsultar = 0;
    this.llamadasADevolver = 0;
    this.cobrados.clear();
    this.porToken.clear();
  }

  get clavePublica(): string {
    return 'TEST-public-key';
  }

  get urlDeNotificacion(): string | undefined {
    return 'https://test.local/webhooks/orders/mercadopago';
  }

  async cobrar(input: CobrarInput, _idempotencyKey: string): Promise<ProviderPayment> {
    this.llamadasACobrar += 1;
    await Promise.resolve();

    // El guion del token gana sobre el compartido: es el que sobrevive a la
    // concurrencia.
    const guion = this.porToken.get(input.cardToken) ?? this.proximo;

    if ('fallo' in guion) {
      /**
       * Un fallo de red deja el cobro REGISTRADO igual.
       *
       * Es el detalle que hace realista el escenario: del lado de Mercado Pago
       * el pago puede haberse procesado perfectamente, y sólo se perdió la
       * respuesta. Si el falso no guardara nada, el conciliador no podría
       * encontrarlo después y el test estaría probando un mundo más fácil que
       * el real.
       */
      const pago = this.construir({ status: 'approved' }, input);
      this.cobrados.set(pago.id, pago);
      throw this.lanzarFallo(guion);
    }

    const pago = this.construir(guion, input);
    this.cobrados.set(pago.id, pago);
    return pago;
  }

  async consultar(providerPaymentId: string): Promise<ProviderPayment> {
    this.llamadasAConsultar += 1;
    await Promise.resolve();

    const guion = this.alConsultar;
    if (guion && 'fallo' in guion) throw this.lanzarFallo(guion, providerPaymentId);

    const guardado = this.cobrados.get(providerPaymentId);

    if (guion) {
      return {
        ...(guardado ?? this.construirVacio(providerPaymentId)),
        ...this.desdeGuion(guion),
        id: guion.id ?? providerPaymentId,
        externalReference:
          guion.externalReference === null
            ? undefined
            : (guion.externalReference ?? guardado?.externalReference),
      };
    }

    if (!guardado) throw new ProviderPaymentNotFoundError(providerPaymentId);
    return guardado;
  }

  async buscarPorReferencia(externalReference: string): Promise<ProviderPayment[]> {
    this.llamadasAConsultar += 1;
    await Promise.resolve();
    if (this.alBuscar !== null) return this.alBuscar;

    /**
     * Buscar y consultar son la misma pregunta por caminos distintos.
     *
     * Si `alConsultar` dice que el proveedor está caído, buscar también tiene
     * que fallar: son la misma llamada a la misma API. Sin esto, un test que
     * simula "no se puede preguntar" pasaría igual por este camino y estaría
     * probando un mundo más fácil que el real.
     */
    if (this.alConsultar && 'fallo' in this.alConsultar) {
      throw this.lanzarFallo(this.alConsultar, externalReference);
    }

    const encontrados = [...this.cobrados.values()].filter(
      (p) => p.externalReference === externalReference,
    );

    // Si hay un guion de consulta, se aplica también acá: es el mismo hecho
    // visto por otro camino.
    const guion = this.alConsultar;
    if (guion && !('fallo' in guion) && encontrados[0]) {
      return [{ ...encontrados[0], ...this.desdeGuion(guion) }];
    }
    return encontrados;
  }

  async devolver(
    providerPaymentId: string,
    _idempotencyKey: string,
    amount?: number,
  ): Promise<ProviderRefund> {
    this.llamadasADevolver += 1;
    await Promise.resolve();

    if (this.devolucionFalla) {
      throw new ProviderUnavailableError('el proveedor no pudo procesar la devolución');
    }

    return {
      id: `refund_${providerPaymentId}_${this.llamadasADevolver}`,
      status: 'approved',
      amount,
      raw: {},
    };
  }

  // ───────────────────────────────────────────────────────────────────────────

  private lanzarFallo(guion: Guion, id?: string): Error {
    if (!('fallo' in guion)) throw new Error('guion sin fallo');

    switch (guion.fallo) {
      case 'red':
        return new ProviderUnavailableError('se cortó la conexión con el proveedor');
      case 'rechazo':
        return new ProviderRejectedError(400, guion.body ?? { cause: [] }, 'petición rechazada');
      case 'no_encontrado':
        return new ProviderPaymentNotFoundError(id ?? 'desconocido');
    }
  }

  private construir(guion: Guion, input: CobrarInput): ProviderPayment {
    if ('fallo' in guion) throw new Error('guion con fallo');
    this.secuencia += 1;

    return {
      id: guion.id ?? `mp_${this.secuencia}_${Date.now()}`,
      status: guion.status,
      statusDetail: guion.statusDetail,
      amount: input.amount,
      currency: 'ARS',
      externalReference: input.externalReference,
      approvedAt: guion.status === 'approved' ? new Date().toISOString() : null,
      lastFour: guion.lastFour ?? '3704',
      brand: guion.brand ?? 'visa',
      paymentType: 'credit_card',
      feeAmount: guion.feeAmount,
      raw: { status: guion.status },
    };
  }

  private construirVacio(id: string): ProviderPayment {
    return { id, status: 'pending', raw: {} };
  }

  private desdeGuion(guion: Guion): Partial<ProviderPayment> {
    if ('fallo' in guion) return {};
    return {
      status: guion.status,
      statusDetail: guion.statusDetail,
      approvedAt: guion.status === 'approved' ? new Date().toISOString() : null,
      lastFour: guion.lastFour,
      brand: guion.brand,
      feeAmount: guion.feeAmount,
    };
  }
}
