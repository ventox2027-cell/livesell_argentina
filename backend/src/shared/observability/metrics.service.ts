import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Métricas Prometheus expuestas en /metrics.
 *
 * Las de Sprint 0 apuntan a lo único que importa ahora: cuánto tarda emitir un
 * token de LiveKit, cuánto tarda la ingesta de muestras y qué latencias
 * estamos observando en campo. Las de negocio (órdenes, pagos, stock) entran
 * con sus módulos.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  /**
   * Registro propio, y cada métrica declara `registers: []`.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * POR QUÉ NO ALCANZA CON `registry.registerMetric`
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `new Histogram({...})` sin `registers` se anota **también** en el registro
   * global de `prom-client`. O sea que cada métrica vivía en dos lados: en el
   * global, que nadie sirve, y en éste, que sí.
   *
   * Dos consecuencias, y la segunda es la que lo hizo visible:
   *
   *   · el registro global acumula métricas que ningún endpoint expone;
   *   · **el servicio no se puede instanciar dos veces en un proceso**. El
   *     registro global rechaza un nombre repetido con
   *     `A metric with the name ... has already been registered`, y eso
   *     revienta cualquier test que levante dos instancias de la aplicación —
   *     que es justo lo que hace falta para probar el realtime con varias
   *     máquinas.
   *
   * Con `registers: []` la métrica no se anota en ningún lado sola, y las
   * `registerMetric` de abajo son las únicas que la ponen donde va.
   */
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'http_request_duration_seconds',
    help: 'Duración de las peticiones HTTP',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
  });

  readonly livekitTokenIssued = new Counter({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'livekit_tokens_issued_total',
    help: 'Tokens de LiveKit emitidos',
    labelNames: ['role', 'result'] as const,
  });

  readonly livekitApiDuration = new Histogram({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'livekit_api_duration_seconds',
    help: 'Duración de las llamadas a la API de LiveKit',
    labelNames: ['operation', 'result'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  });

  readonly spikeSamplesIngested = new Counter({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'spike_samples_ingested_total',
    help: 'Muestras del spike ingeridas',
    labelNames: ['role'] as const,
  });

  /**
   * Latencia observada en campo. Es LA métrica del Sprint 0A: el criterio
   * GO/NO-GO de LiveKit se lee de este histograma.
   */
  readonly spikeObservedLatency = new Histogram({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'spike_observed_latency_ms',
    help: 'Latencia observada en el spike, en milisegundos',
    labelNames: ['kind', 'network', 'carrier'] as const, // kind: probe | estimated_e2e | glass_to_glass
    buckets: [100, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 5000],
  });

  readonly spikeReconnectDuration = new Histogram({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'spike_reconnect_duration_ms',
    help: 'Tiempo de reconexión tras una caída de red',
    labelNames: ['role', 'network'] as const,
    buckets: [250, 500, 1000, 2000, 3000, 5000, 8000, 15_000, 30_000],
  });

  readonly webhookReceived = new Counter({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'webhook_received_total',
    help: 'Webhooks recibidos',
    labelNames: ['provider', 'event', 'result'] as const,
  });

  /**
   * Reservas de stock, por desenlace.
   *
   * Un solo contador con etiqueta `result` en vez de seis contadores: así
   * `sum by (result)` da la foto completa y la proporción
   * `out_of_stock / (created + out_of_stock)` sale de una división. Con
   * contadores separados, cada panel nuevo obliga a acordarse de todos.
   *
   * `out_of_stock` es LA métrica de negocio del módulo: si sube durante un
   * vivo, el vendedor está perdiendo ventas por falta de stock, no por
   * problemas técnicos. Son dos conversaciones muy distintas.
   */
  readonly inventoryReservation = new Counter({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'inventory_reservation_total',
    help: 'Reservas de inventario por desenlace',
    // created | out_of_stock | idempotent_replay | reused | expired | cancelled | consumed
    labelNames: ['result'] as const,
  });

  /**
   * Cuánto tarda apartar stock.
   *
   * Es el camino más caliente del sistema durante un vivo y el que se
   * serializa sobre una fila. Los cubos bajos están apretados a propósito: la
   * diferencia entre 20 ms y 150 ms decide cuántos compradores por segundo
   * pasan por la última unidad.
   */
  readonly inventoryReservationLatency = new Histogram({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'inventory_reservation_duration_seconds',
    help: 'Duración de la operación de reserva',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
  });

  /**
   * Choques de índice único al reservar que NO se pudieron resolver.
   *
   * Distinto de `out_of_stock`: esto no es "no había stock", es "dos
   * escrituras se pisaron y no encontramos la ganadora". Debería ser siempre
   * cero. Si sube, hay una carrera que el diseño no contempló.
   */
  readonly inventoryConcurrencyConflicts = new Counter({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'inventory_concurrency_conflicts_total',
    help: 'Conflictos de concurrencia no resueltos al reservar',
  });

  /**
   * Pagos que se acreditaron después de que venciera su reserva.
   *
   * `out_of_stock` es la métrica a vigilar: cada uno es una devolución, un
   * comprador frustrado y plata que se movió dos veces. Si sube, hay que
   * mirar el TTL de las reservas o la latencia de confirmación de Mercado
   * Pago — son las dos causas posibles.
   */
  readonly latePaymentStock = new Counter({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'late_payment_stock_total',
    help: 'Recuperación de stock tras un pago tardío',
    labelNames: ['result'] as const, // reacquired | out_of_stock
  });

  // ─── Órdenes ───

  readonly orders = new Counter({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'orders_total',
    help: 'Órdenes por desenlace',
    // created | confirmed | expired | cancelled | refund_required | refunded
    labelNames: ['result'] as const,
  });

  readonly paymentAttempts = new Counter({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'payment_attempts_total',
    help: 'Intentos de cobro por desenlace',
    // created | approved | rejected | unknown | reconciled
    labelNames: ['result'] as const,
  });

  /**
   * Cuánto tarda un cobro de punta a punta.
   *
   * Los cubos llegan hasta 30 s porque incluyen la llamada a Mercado Pago, que
   * es una red externa: la referencia medida en el spike fue 1,8 s de tocar
   * "Pagar" a orden acreditada.
   */
  readonly paymentConfirmation = new Histogram({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'payment_confirmation_seconds',
    help: 'Duración del cobro, de la petición a la respuesta definitiva',
    labelNames: ['result'] as const,
    buckets: [0.25, 0.5, 1, 2, 3, 5, 8, 15, 30],
  });

  readonly refunds = new Counter({
    // Ver el comentario de `registry`: sin esto se registran en el registro
    // global de prom-client, que no es el que servimos.
    registers: [],
    name: 'refunds_total',
    help: 'Devoluciones por desenlace',
    labelNames: ['result'] as const, // started | completed | failed
  });

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry, prefix: 'nodejs_' });
    this.registry.registerMetric(this.httpDuration);
    this.registry.registerMetric(this.livekitTokenIssued);
    this.registry.registerMetric(this.livekitApiDuration);
    this.registry.registerMetric(this.spikeSamplesIngested);
    this.registry.registerMetric(this.spikeObservedLatency);
    this.registry.registerMetric(this.spikeReconnectDuration);
    this.registry.registerMetric(this.webhookReceived);
    this.registry.registerMetric(this.inventoryReservation);
    this.registry.registerMetric(this.inventoryReservationLatency);
    this.registry.registerMetric(this.inventoryConcurrencyConflicts);
    this.registry.registerMetric(this.latePaymentStock);
    this.registry.registerMetric(this.orders);
    this.registry.registerMetric(this.paymentAttempts);
    this.registry.registerMetric(this.paymentConfirmation);
    this.registry.registerMetric(this.refunds);
  }

  async scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
