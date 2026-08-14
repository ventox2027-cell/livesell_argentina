import { createHmac } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Sólo el tipo: la clase real se importa dinámicamente dentro de `beforeAll`,
// después de que el entorno de prueba esté puesto en process.env.
import type { PrismaService } from '@/shared/prisma/prisma.service';

import { crearAppDePrueba } from '../helpers/app';

/**
 * Robustez del flujo de pagos, contra PostgreSQL REAL.
 *
 * Mercado Pago está simulado a propósito. Lo que se valida acá no es que
 * Mercado Pago funcione —eso se prueba en campo con tarjetas de prueba— sino
 * que NUESTRO código sobreviva a lo que Mercado Pago hace de verdad:
 * duplicar notificaciones, mandarlas desordenadas, no mandarlas, y cortarse en
 * el medio de un cobro.
 *
 * Cada `it` de este archivo es una línea de la tabla de robustez del
 * RESULTS.md. Si alguno se pone en rojo, el Sprint 0B no pasa.
 *
 * Requiere:  pnpm infra:up && pnpm prisma:deploy
 */

const WEBHOOK_SECRET = 'secreto-de-webhook-para-tests';

const TEST_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://livesell:livesell@localhost:5433/livesell_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6380/1',
  LIVEKIT_API_KEY: 'APItest',
  LIVEKIT_API_SECRET: 'test-secret-at-least-16-chars-long',
  LIVEKIT_WS_URL: 'wss://test.livekit.cloud',
  LIVEKIT_HTTP_URL: 'https://test.livekit.cloud',
  SPIKE_ENABLED: 'true',
  SPIKE_API_KEY: 'test-spike-key-suficientemente-larga',
  PAYMENTS_SPIKE_ENABLED: 'true',
  MP_ACCESS_TOKEN: 'TEST-token-de-prueba-suficientemente-largo',
  MP_PUBLIC_KEY: 'TEST-public-key-de-prueba-larga',
  MP_WEBHOOK_SECRET: WEBHOOK_SECRET,
  LOG_LEVEL: 'error',
};

const KEY = TEST_ENV.SPIKE_API_KEY;

/**
 * Doble de Mercado Pago.
 *
 * `getPayment` es lo que devuelve la API cuando le preguntamos por el estado
 * autoritativo — el test controla ese valor para simular cada escenario.
 */
class MpFake {
  /** Estado que la "API" va a reportar para cada id de pago. */
  estados = new Map<string, string>();
  /** Fuerza un fallo de red en el próximo `createPayment`. */
  proximoTimeout = false;
  /** Pagos que `searchPaymentsByExternalReference` va a encontrar. */
  porReferencia = new Map<string, unknown[]>();
  llamadasCreate = 0;

  publicKey = TEST_ENV.MP_PUBLIC_KEY;
  notificationUrl = undefined;

  private siguienteId = 700000001;

  /**
   * Respuestas ya devueltas por clave de idempotencia.
   *
   * Reproduce el comportamiento REAL de Mercado Pago, que es justamente el que
   * destapó el bug de campo: ante una clave repetida no procesa nada nuevo,
   * devuelve la respuesta guardada.
   */
  porClaveIdempotencia = new Map<string, ReturnType<MpFake['pago']>>();
  /** Estado que devolverá el próximo `createPayment`. */
  proximoEstado = 'approved';

  async createPayment(
    input: { externalReference: string; transactionAmount: number },
    idempotencyKey: string,
  ) {
    const guardada = this.porClaveIdempotencia.get(idempotencyKey);
    if (guardada) return guardada;

    this.llamadasCreate += 1;
    if (this.proximoTimeout) {
      this.proximoTimeout = false;
      const { MpNetworkError } = await import('@/modules/payments/mp.client');
      throw new MpNetworkError('timeout simulado');
    }
    const id = this.siguienteId++;
    const estado = this.proximoEstado;
    this.estados.set(String(id), estado);
    const respuesta = this.pago(id, estado, input.externalReference, input.transactionAmount);
    this.porClaveIdempotencia.set(idempotencyKey, respuesta);
    return respuesta;
  }

  /// Ids que la "API" va a reportar como inexistentes (404).
  noExiste = new Set<string>();

  // Sin `async`: devolver el valor directo alcanza porque el servicio los
  // consume con `await`, y evita prometer asincronía que no existe.
  async getPayment(id: string | number) {
    if (this.noExiste.has(String(id))) {
      const { MpApiError } = await import('@/modules/payments/mp.client');
      throw new MpApiError(404, { message: 'Payment not found' }, 'Payment not found');
    }
    const estado = this.estados.get(String(id)) ?? 'approved';
    return this.pago(Number(id), estado, this.referencias.get(String(id)) ?? 'ord_desconocida', 15);
  }

  searchPaymentsByExternalReference(ref: string) {
    return this.porReferencia.get(ref) ?? [];
  }

  findCustomerByEmail() {
    return { id: 'cus_mp_1' };
  }
  createCustomer() {
    return { id: 'cus_mp_1' };
  }
  saveCard() {
    return {};
  }
  listCards() {
    return [];
  }

  referencias = new Map<string, string>();

  pago(id: number, status: string, externalReference: string, amount: number) {
    this.referencias.set(String(id), externalReference);
    return {
      id,
      status,
      status_detail: status === 'approved' ? 'accredited' : status,
      transaction_amount: amount,
      currency_id: 'ARS',
      installments: 1,
      payment_method_id: 'visa',
      payment_type_id: 'credit_card',
      external_reference: externalReference,
      // Datos sensibles a propósito: uno de los tests verifica que no lleguen
      // a la base.
      token: 'token-de-un-solo-uso-secreto',
      card: {
        id: 'card_mp_1',
        last_four_digits: '4242',
        first_six_digits: '450995',
        cardholder: { name: 'JUAN PEREZ', identification: { type: 'DNI', number: '30111222' } },
      },
    };
  }
}

let app: INestApplication;
let mp: MpFake;
let prisma: PrismaService;

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { MercadoPagoService } = await import('@/modules/payments/mp.client');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { PrismaService } = await import('@/shared/prisma/prisma.service');

  mp = new MpFake();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MercadoPagoService)
    .useValue(mp)
    .overrideProvider(LiveKitService)
    .useValue({ wsUrl: '', ensureRoom: vi.fn(), issueToken: vi.fn(), verifyWebhook: vi.fn() })
    .compile();

  app = await crearAppDePrueba(moduleRef);

  prisma = app.get(PrismaService);

  /**
   * Base limpia antes de empezar.
   *
   * No es cosmético: `mp_payment_id` es UNIQUE y el doble de Mercado Pago
   * reinicia su contador de ids en cada proceso. Con datos de una corrida
   * anterior, el `upsert` encontraba el pago viejo —atado a OTRA orden— y lo
   * actualizaba en vez de crear uno nuevo. Cuatro tests en verde la primera
   * vez y en rojo la segunda, que es la peor clase de test.
   *
   * La guarda del nombre de base existe porque este bloque BORRA datos: si
   * alguien apunta los tests a desarrollo por error, preferimos que fallen.
   */
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('_test')) {
    throw new Error(
      `Los tests de integración borran datos y sólo corren contra una base *_test. ` +
        `DATABASE_URL apunta a otra cosa: ${url.replace(/:\/\/[^@]*@/, '://***@')}`,
    );
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE spike_payment_events, spike_payments, spike_orders, ' +
      'mp_webhook_events, spike_customer_cards, spike_customers CASCADE',
  );
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  mp.estados.clear();
  mp.porReferencia.clear();
  mp.noExiste.clear();
  mp.porClaveIdempotencia.clear();
  mp.proximoEstado = 'approved';
  mp.proximoTimeout = false;
  mp.llamadasCreate = 0;
});

async function call(
  method: string,
  url: string,
  opts: { body?: unknown; headers?: Record<string, string>; key?: string | null } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.key !== null) headers['x-spike-key'] = opts.key ?? KEY;

  const res = await (app as NestFastifyApplication)
    .getHttpAdapter()
    .getInstance()
    .inject({ method: method as never, url, headers, payload: opts.body as never });

  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

let contador = 0;
async function crearOrden(amountCents = 150_000) {
  contador += 1;
  const r = await call('POST', '/api/v1/payments/orders', {
    body: {
      idempotencyKey: `test-${Date.now()}-${contador}`,
      buyerEmail: `comprador${contador}@test.com`,
      description: 'Remera de prueba',
      amountCents,
    },
  });
  expect(r.status).toBe(201);
  return r.body.order as { id: string; status: string };
}

/** Arma una notificación con firma válida, como la mandaría Mercado Pago. */
function webhookFirmado(params: {
  mpPaymentId: string;
  notificationId?: string;
  requestId?: string;
  tsMs?: number;
  secreto?: string;
}) {
  const ts = String(Math.floor((params.tsMs ?? Date.now()) / 1_000));
  const requestId = params.requestId ?? `req-${params.mpPaymentId}`;
  const manifest = `id:${params.mpPaymentId};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac('sha256', params.secreto ?? WEBHOOK_SECRET).update(manifest).digest('hex');

  return {
    url: `/webhooks/spike/mercadopago?data.id=${params.mpPaymentId}&type=payment`,
    headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
    body: {
      id: params.notificationId ?? `notif-${params.mpPaymentId}-${Date.now()}`,
      type: 'payment',
      action: 'payment.updated',
      data: { id: params.mpPaymentId },
    },
  };
}

async function enviarWebhook(w: ReturnType<typeof webhookFirmado>) {
  return call('POST', w.url, { body: w.body, headers: w.headers, key: null });
}

// ═══════════════════════════════════════════════════════════════════════════

describe('Idempotencia al crear la orden', () => {
  it('dos toques del botón con la misma clave crean UNA orden', async () => {
    const key = `idem-${Date.now()}`;
    const cuerpo = {
      idempotencyKey: key,
      buyerEmail: 'doble@test.com',
      description: 'Remera',
      amountCents: 150_000,
    };

    const a = await call('POST', '/api/v1/payments/orders', { body: cuerpo });
    const b = await call('POST', '/api/v1/payments/orders', { body: cuerpo });

    expect(a.body.order.id).toBe(b.body.order.id);
    expect(a.body.reused).toBe(false);
    expect(b.body.reused).toBe(true);
  });

  it('dos toques SIMULTÁNEOS también crean una sola', async () => {
    // Es el caso que un "buscar y si no existe crear" NO cubre: las dos
    // consultas no encuentran nada y las dos insertan. Acá la carrera la
    // resuelve el índice UNIQUE.
    const key = `idem-carrera-${Date.now()}`;
    const cuerpo = {
      idempotencyKey: key,
      buyerEmail: 'carrera@test.com',
      description: 'Remera',
      amountCents: 150_000,
    };

    const [a, b] = await Promise.all([
      call('POST', '/api/v1/payments/orders', { body: cuerpo }),
      call('POST', '/api/v1/payments/orders', { body: cuerpo }),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.order.id).toBe(b.body.order.id);

    const total = await prisma.spikeOrder.count({ where: { idempotencyKey: key } });
    expect(total).toBe(1);
  });
});

describe('Cobro', () => {
  it('un pago aprobado deja la orden PAID', async () => {
    const orden = await crearOrden();
    const r = await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 },
    });

    expect(r.status).toBe(201);
    expect(r.body.order.status).toBe('PAID');
    expect(r.body.order.paidAt).not.toBeNull();
  });

  it('⛔ no se puede cobrar dos veces la misma orden', async () => {
    const orden = await crearOrden();
    const cuerpo = { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 };

    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, { body: cuerpo });
    const segundo = await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, { body: cuerpo });

    expect(segundo.status).toBe(409);
    expect(mp.llamadasCreate).toBe(1); // no se volvió a llamar a Mercado Pago
  });

  it('⛔ después de un rechazo se puede pagar con OTRA tarjeta', async () => {
    /**
     * El bug de campo del 13/08/2026.
     *
     * La clave de idempotencia era el id de la orden, así que el reintento
     * mandaba la misma y Mercado Pago devolvía la respuesta guardada del
     * primer intento. La orden quedaba condenada: ninguna tarjeta podía
     * pagarla nunca más.
     *
     * El doble de Mercado Pago replica ese comportamiento —cachea por clave—
     * para que este test falle de verdad si la clave vuelve a ser por orden.
     */
    const orden = await crearOrden();

    mp.proximoEstado = 'rejected';
    const rechazado = await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'token-de-la-tarjeta-sin-fondos', paymentMethodId: 'visa', installments: 1 },
    });
    expect(rechazado.body.order.status).toBe('FAILED');

    // Otra tarjeta ⇒ otro token ⇒ otro intento.
    mp.proximoEstado = 'approved';
    const aprobado = await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'token-de-la-tarjeta-buena', paymentMethodId: 'visa', installments: 1 },
    });

    expect(aprobado.body.order.status).toBe('PAID');
    expect(mp.llamadasCreate).toBe(2); // se procesaron los DOS cobros
  });

  it('⛔ pero el MISMO token dos veces sigue siendo un solo cobro', async () => {
    // La otra mitad del invariante: la clave protege contra el doble toque
    // sin bloquear el reintento legítimo.
    const orden = await crearOrden();
    const cuerpo = { token: 'token-repetido-abc', paymentMethodId: 'visa', installments: 1 };

    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, { body: cuerpo });
    expect(mp.llamadasCreate).toBe(1);

    const pagos = await prisma.spikePayment.count({ where: { orderId: orden.id } });
    expect(pagos).toBe(1);
  });

  it('⛔ un timeout deja la orden en PROCESSING, NUNCA en FAILED', async () => {
    // El escenario que hace perder plata: si acá dijéramos "rechazado", el
    // comprador pagaría otra vez y quedaría cobrado dos veces por un producto.
    const orden = await crearOrden();
    mp.proximoTimeout = true;

    const r = await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 },
    });

    expect(r.body.outcome).toBe('UNKNOWN');
    expect(r.body.order.status).toBe('PROCESSING');
    expect(r.body.order.status).not.toBe('FAILED');
  });
});

describe('Webhooks', () => {
  it('acredita una sola vez aunque llegue cuatro veces', async () => {
    const orden = await crearOrden();
    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 },
    });

    const pago = await prisma.spikePayment.findFirstOrThrow({ where: { orderId: orden.id } });
    const w = webhookFirmado({ mpPaymentId: pago.mpPaymentId!, notificationId: 'notif-repetida' });

    const respuestas = [];
    for (let i = 0; i < 4; i += 1) respuestas.push(await enviarWebhook(w));

    expect(respuestas[0]!.body.status).toBe('PROCESSED');
    expect(respuestas.slice(1).every((r) => r.body.status === 'DUPLICATE')).toBe(true);

    // Una sola fila de pago, una sola acreditación.
    const pagos = await prisma.spikePayment.count({ where: { orderId: orden.id } });
    expect(pagos).toBe(1);
  });

  it('⛔ rechaza una firma inválida sin tocar la orden', async () => {
    const orden = await crearOrden();
    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 },
    });
    const pago = await prisma.spikePayment.findFirstOrThrow({ where: { orderId: orden.id } });

    // Alguien intenta marcar la orden como devuelta con una firma falsa.
    mp.estados.set(pago.mpPaymentId!, 'refunded');
    const falso = webhookFirmado({
      mpPaymentId: pago.mpPaymentId!,
      secreto: 'la-clave-equivocada',
    });
    const r = await enviarWebhook(falso);

    expect(r.body.received).toBe(false);
    expect(r.body.status).toBe('INVALID_SIGNATURE');

    const despues = await prisma.spikeOrder.findUniqueOrThrow({ where: { id: orden.id } });
    expect(despues.status).toBe('PAID');
  });

  it('⛔ rechaza una notificación vieja aunque la firma sea legítima', async () => {
    // Reenvío: una firma válida lo sigue siendo para siempre.
    const w = webhookFirmado({ mpPaymentId: '999888777', tsMs: Date.now() - 20 * 60 * 1_000 });
    const r = await enviarWebhook(w);
    expect(r.body.status).toBe('INVALID_SIGNATURE');
  });

  it('registra los intentos con firma inválida', async () => {
    // Un pico de estos es la señal de que alguien está probando el endpoint.
    const antes = await prisma.mpWebhookEvent.count({ where: { signatureValid: false } });
    await enviarWebhook(webhookFirmado({ mpPaymentId: '111222333', secreto: 'mala' }));
    const despues = await prisma.mpWebhookEvent.count({ where: { signatureValid: false } });
    expect(despues).toBe(antes + 1);
  });

  it('⛔ una orden pagada no se despaga con un webhook desordenado', async () => {
    // El reintento del `pending` llega DESPUÉS del `approved`. Pasa de verdad.
    const orden = await crearOrden();
    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 },
    });
    const pago = await prisma.spikePayment.findFirstOrThrow({ where: { orderId: orden.id } });

    mp.estados.set(pago.mpPaymentId!, 'pending');
    await enviarWebhook(
      webhookFirmado({ mpPaymentId: pago.mpPaymentId!, notificationId: `tarde-${Date.now()}` }),
    );

    const despues = await prisma.spikeOrder.findUniqueOrThrow({ where: { id: orden.id } });
    expect(despues.status).toBe('PAID');
  });
});

describe('Conciliación · el webhook que nunca llegó', () => {
  it('resuelve una orden atascada preguntándole a Mercado Pago', async () => {
    const orden = await crearOrden();
    mp.proximoTimeout = true;
    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 },
    });

    const atascada = await prisma.spikeOrder.findUniqueOrThrow({ where: { id: orden.id } });
    expect(atascada.status).toBe('PROCESSING');

    // Del lado de Mercado Pago el pago SÍ se había creado y aprobado.
    mp.porReferencia.set(orden.id, [mp.pago(800000123, 'approved', orden.id, 1500)]);

    const r = await call('POST', '/api/v1/payments/reconcile', { body: { olderThanMs: 0 } });
    expect(r.body.changed.some((c: { orderId: string }) => c.orderId === orden.id)).toBe(true);

    const resuelta = await prisma.spikeOrder.findUniqueOrThrow({ where: { id: orden.id } });
    expect(resuelta.status).toBe('PAID');
  });

  it('no inventa un pago cuando Mercado Pago no tiene ninguno', async () => {
    const orden = await crearOrden();
    mp.proximoTimeout = true;
    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 },
    });

    // Con la ventana de liberación por delante, la orden NO se toca: podría
    // haber un cobro en vuelo que todavía no aparece en la búsqueda.
    await call('POST', '/api/v1/payments/reconcile', {
      body: { olderThanMs: 0, releaseAfterMs: 300_000 },
    });

    const sigue = await prisma.spikeOrder.findUniqueOrThrow({ where: { id: orden.id } });
    expect(sigue.status).toBe('PROCESSING');
  });

  it('⛔ libera la orden cuando el cobro nunca llegó a existir', async () => {
    /**
     * Encontrado en campo el 13/08/2026: con un timeout de 1 s, la petición se
     * cortó antes de llegar a Mercado Pago. Cero pagos registrados allá, y la
     * orden en PROCESSING para siempre — `canAttemptPayment` no deja
     * reintentar, así que nadie podía pagarla nunca más.
     */
    const orden = await crearOrden();
    mp.proximoTimeout = true;
    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 },
    });

    // Pasada la ventana, con Mercado Pago confirmando que no hay ningún pago.
    const r = await call('POST', '/api/v1/payments/reconcile', {
      body: { olderThanMs: 0, releaseAfterMs: 0 },
    });
    expect(r.body.changed.some((c: { orderId: string }) => c.orderId === orden.id)).toBe(true);

    const liberada = await prisma.spikeOrder.findUniqueOrThrow({ where: { id: orden.id } });
    expect(liberada.status).toBe('FAILED');

    // Y lo que importa: ahora sí se puede volver a intentar.
    mp.proximoEstado = 'approved';
    const reintento = await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'otro-token-distinto', paymentMethodId: 'visa', installments: 1 },
    });
    expect(reintento.body.order.status).toBe('PAID');
  });

  it('liberar es seguro: un webhook tardío corrige la orden a PAID', async () => {
    /**
     * Es lo que hace aceptable liberar la orden.
     *
     * Si nos equivocáramos —si el pago sí existía y la búsqueda todavía no lo
     * mostraba— la orden queda en FAILED, no en un estado terminal. La guarda
     * de monotonía permite FAILED → PAID, así que la notificación que llegue
     * después corrige el estado sola.
     */
    const orden = await crearOrden();
    mp.proximoTimeout = true;
    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 },
    });
    await call('POST', '/api/v1/payments/reconcile', {
      body: { olderThanMs: 0, releaseAfterMs: 0 },
    });
    expect((await prisma.spikeOrder.findUniqueOrThrow({ where: { id: orden.id } })).status).toBe(
      'FAILED',
    );

    // El pago existía después de todo, y Mercado Pago avisa tarde.
    const mpPaymentId = '900000777';
    mp.referencias.set(mpPaymentId, orden.id);
    mp.estados.set(mpPaymentId, 'approved');
    await enviarWebhook(webhookFirmado({ mpPaymentId }));

    expect((await prisma.spikeOrder.findUniqueOrThrow({ where: { id: orden.id } })).status).toBe(
      'PAID',
    );
  });
});

describe('⛔ Datos de tarjeta', () => {
  it('no queda NADA sensible en la base', async () => {
    const orden = await crearOrden();
    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: {
        token: 'tok-de-prueba-12345',
        paymentMethodId: 'visa',
        installments: 1,
        saveCard: true,
      },
    });

    const pago = await prisma.spikePayment.findFirstOrThrow({ where: { orderId: orden.id } });
    const serializado = JSON.stringify(pago);

    expect(serializado).not.toContain('token-de-un-solo-uso-secreto');
    expect(serializado).not.toContain('450995'); // BIN
    expect(serializado).not.toContain('JUAN PEREZ');
    expect(serializado).not.toContain('30111222'); // DNI

    // Lo que SÍ se guarda, porque la interfaz lo necesita.
    expect(pago.cardLastFour).toBe('4242');
  });

  it('tampoco en la bitácora de auditoría', async () => {
    const orden = await crearOrden();
    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 },
    });

    const eventos = await prisma.spikePaymentEvent.findMany({ where: { orderId: orden.id } });
    const serializado = JSON.stringify(eventos);
    expect(serializado).not.toContain('token-de-un-solo-uso-secreto');
    expect(serializado).not.toContain('30111222');
  });
});

describe('Auditoría', () => {
  it('deja el rastro completo de por qué la orden figura paga', async () => {
    const orden = await crearOrden();
    await call('POST', `/api/v1/payments/orders/${orden.id}/pay`, {
      body: { token: 'tok-de-prueba-12345', paymentMethodId: 'visa', installments: 1 },
    });

    const r = await call('GET', `/api/v1/payments/orders/${orden.id}`);
    const kinds = (r.body.events as Array<{ kind: string }>).map((e) => e.kind);

    expect(kinds).toContain('order.created');
    expect(kinds).toContain('payment.attempt');
    expect(kinds).toContain('payment.status_changed');
  });
});

describe('Autenticación', () => {
  it('la API de pagos exige la clave', async () => {
    const r = await call('GET', '/api/v1/payments/config', { key: null });
    expect(r.status).toBe(401);
  });

  it('el webhook NO la exige: su credencial es la firma', async () => {
    const r = await enviarWebhook(webhookFirmado({ mpPaymentId: '555444333' }));
    expect(r.status).toBe(200);
  });

  it('archiva una notificación sobre un pago inexistente sin pedir reintento', async () => {
    // Es lo que manda el simulador del panel de Mercado Pago: un id de
    // ejemplo. Si respondiéramos 500, Mercado Pago reintentaría para siempre
    // algo que nunca va a existir.
    mp.noExiste.add('404404404');
    const r = await enviarWebhook(webhookFirmado({ mpPaymentId: '404404404' }));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('UNKNOWN_PAYMENT');

    const registro = await prisma.mpWebhookEvent.findFirstOrThrow({
      where: { resourceId: '404404404' },
    });
    expect(registro.processedAt).not.toBeNull();
  });

  it('archiva una notificación huérfana en vez de reventar', async () => {
    // El pago existe en Mercado Pago pero apunta a una orden que no es
    // nuestra. Si respondiéramos 500, Mercado Pago reintentaría para siempre.
    const r = await enviarWebhook(webhookFirmado({ mpPaymentId: '666555444' }));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ORPHAN');

    const registro = await prisma.mpWebhookEvent.findFirstOrThrow({
      where: { resourceId: '666555444' },
    });
    expect(registro.processedAt).not.toBeNull();
    expect(registro.error).toContain('no corresponde a ninguna orden');
  });

  it('config no filtra el access token', async () => {
    const r = await call('GET', '/api/v1/payments/config');
    expect(JSON.stringify(r.body)).not.toContain(TEST_ENV.MP_ACCESS_TOKEN);
    expect(r.body.publicKey).toBe(TEST_ENV.MP_PUBLIC_KEY);
  });
});
