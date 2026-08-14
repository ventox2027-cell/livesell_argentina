import { Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';

import { MetricsService } from '@/shared/observability/metrics.service';

/**
 * Contadores del almacenamiento.
 *
 * ─── Qué preguntas responden ───
 *
 * Pocos y concretos. No es analítica del negocio: son las cuatro cosas que hay
 * que poder ver cuando algo de imágenes anda mal.
 *
 *   · ¿Están fallando las subidas? Un vendedor que no puede subir la foto de
 *     su producto no puede vender, y va a abandonar antes de escribirnos.
 *   · ¿Están quedando objetos huérfanos? Cada borrado fallido deja un archivo
 *     que ya nadie referencia. No rompe nada, pero se acumula y se paga.
 *   · ¿Cuántos bytes estamos subiendo? Es lo que anticipa la factura de R2
 *     antes de que llegue.
 *
 * ⚠️ Ninguna etiqueta lleva el `storageKey`, el id del producto ni nada
 * variable. Prometheus crea una serie temporal por combinación de etiquetas:
 * una etiqueta con un identificador único hace explotar la memoria del
 * servidor de métricas. Eso va en los logs, que sí pueden ser de cardinalidad
 * alta.
 */
@Injectable()
export class StorageMetrics {
  private readonly subidas: Counter;
  private readonly subidasFallidas: Counter;
  private readonly borrados: Counter;
  private readonly borradosFallidos: Counter;
  private readonly bytes: Counter;

  constructor(metrics: MetricsService) {
    const registry = metrics.registry;

    this.subidas = new Counter({
      name: 'storage_upload_total',
      help: 'Imágenes subidas correctamente',
      registers: [registry],
    });
    this.subidasFallidas = new Counter({
      name: 'storage_upload_failed_total',
      help: 'Subidas que fallaron contra el proveedor de almacenamiento',
      registers: [registry],
    });
    this.borrados = new Counter({
      name: 'storage_delete_total',
      help: 'Objetos borrados correctamente',
      registers: [registry],
    });
    this.borradosFallidos = new Counter({
      name: 'storage_delete_failed_total',
      help: 'Borrados fallidos: cada uno deja un objeto huérfano ocupando lugar',
      registers: [registry],
    });
    this.bytes = new Counter({
      name: 'storage_bytes_uploaded_total',
      help: 'Bytes subidos al almacenamiento',
      registers: [registry],
    });
  }

  subida(bytes: number): void {
    this.subidas.inc();
    this.bytes.inc(bytes);
  }

  subidaFallida(): void {
    this.subidasFallidas.inc();
  }

  borrado(): void {
    this.borrados.inc();
  }

  borradoFallido(): void {
    this.borradosFallidos.inc();
  }
}
