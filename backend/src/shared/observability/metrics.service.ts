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
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duración de las peticiones HTTP',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
  });

  readonly livekitTokenIssued = new Counter({
    name: 'livekit_tokens_issued_total',
    help: 'Tokens de LiveKit emitidos',
    labelNames: ['role', 'result'] as const,
  });

  readonly livekitApiDuration = new Histogram({
    name: 'livekit_api_duration_seconds',
    help: 'Duración de las llamadas a la API de LiveKit',
    labelNames: ['operation', 'result'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  });

  readonly spikeSamplesIngested = new Counter({
    name: 'spike_samples_ingested_total',
    help: 'Muestras del spike ingeridas',
    labelNames: ['role'] as const,
  });

  /**
   * Latencia observada en campo. Es LA métrica del Sprint 0A: el criterio
   * GO/NO-GO de LiveKit se lee de este histograma.
   */
  readonly spikeObservedLatency = new Histogram({
    name: 'spike_observed_latency_ms',
    help: 'Latencia observada en el spike, en milisegundos',
    labelNames: ['kind', 'network', 'carrier'] as const, // kind: probe | estimated_e2e | glass_to_glass
    buckets: [100, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 5000],
  });

  readonly spikeReconnectDuration = new Histogram({
    name: 'spike_reconnect_duration_ms',
    help: 'Tiempo de reconexión tras una caída de red',
    labelNames: ['role', 'network'] as const,
    buckets: [250, 500, 1000, 2000, 3000, 5000, 8000, 15_000, 30_000],
  });

  readonly webhookReceived = new Counter({
    name: 'webhook_received_total',
    help: 'Webhooks recibidos',
    labelNames: ['provider', 'event', 'result'] as const,
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
  }

  async scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
