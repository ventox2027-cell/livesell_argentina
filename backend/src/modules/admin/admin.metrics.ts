import { Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';

import { MetricsService } from '@/shared/observability/metrics.service';

/**
 * Contadores del panel de administración.
 *
 * Tres, no treinta. No es analítica del panel: son las señales que importan
 * cuando algo anda mal.
 *
 * `admin_actions_total` con la acción como etiqueta responde la pregunta que
 * vale: **¿por qué de golpe se están suspendiendo veinte vendedores por hora?**
 * Eso puede ser una campaña legítima contra spam o una cuenta de admin
 * comprometida, y en los dos casos hay que enterarse mientras pasa.
 *
 * La etiqueta `accion` tiene cardinalidad acotada —son los nombres de acción
 * que existen en el código, no datos de entrada—, así que es segura para
 * Prometheus. Nunca lleva ids.
 */
@Injectable()
export class AdminMetrics {
  private readonly acciones: Counter<'accion'>;
  private readonly reintentos: Counter;
  private readonly conciliaciones: Counter;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];

    this.acciones = new Counter({
      name: 'admin_actions_total',
      help: 'Acciones administrativas ejecutadas, por tipo',
      labelNames: ['accion'] as const,
      registers,
    });
    this.reintentos = new Counter({
      name: 'admin_refund_retries_total',
      help: 'Devoluciones reintentadas manualmente desde el panel',
      registers,
    });
    this.conciliaciones = new Counter({
      name: 'admin_manual_reconciliations_total',
      help: 'Pagos conciliados manualmente desde el panel',
      registers,
    });
  }

  accion(nombre: string): void {
    this.acciones.inc({ accion: nombre });
  }

  reintentoDevolucion(): void {
    this.reintentos.inc();
  }

  conciliacionManual(): void {
    this.conciliaciones.inc();
  }
}
