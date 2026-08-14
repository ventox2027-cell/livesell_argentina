import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type JobsOptions } from 'bullmq';

import { env } from '@/config/env.schema';
import { corresTareasPeriodicas } from '@/shared/app-role';

import { InventoryService } from './inventory.service';

/**
 * Expiración puntual de reservas, con BullMQ.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REDIS ES PRECISIÓN, NUNCA UNA DEPENDENCIA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La pregunta que ordena este archivo: **¿se puede vender con Redis caído?**
 *
 * Sí. Y no es una concesión, es el diseño.
 *
 * Todo lo que hace falta para que una reserva venza ya está en PostgreSQL:
 * `expires_at`. El job diferido no guarda nada que no esté ahí — sólo sirve
 * para que alguien se acuerde de mirar en el momento exacto.
 *
 * Por eso `programar()` **nunca lanza**. Si Redis está caído, se registra el
 * problema y la reserva se crea igual. El reconciliador la va a vencer unos
 * segundos más tarde, y unos segundos de stock apartado de más es
 * infinitamente preferible a no poder vender.
 *
 * La regla, escrita para que no se erosione: **si perder Redis puede impedir
 * una venta, el diseño está mal.**
 *
 * ─── Por qué entonces existe la cola ───
 *
 * Por precisión. El reconciliador barre cada 30 segundos, así que una reserva
 * puede quedar apartada hasta medio minuto de más. Durante un vivo con la
 * última unidad en juego, esos 30 segundos son la diferencia entre que otro
 * comprador la vea disponible o no.
 *
 *   · La cola da el momento exacto.
 *   · El reconciliador da la garantía.
 *
 * Ninguno de los dos alcanza solo: la cola pierde jobs si Redis se reinicia, y
 * el reconciliador es impreciso por definición.
 */

// Con guion y no con dos puntos: BullMQ 6 usa `:` como separador interno de
// sus claves de Redis y rechaza el nombre en el constructor.
const COLA = 'inventory-expiration';

interface DatosDeJob {
  reservationId: string;
}

@Injectable()
export class ExpirationQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpirationQueue.name);

  private queue?: Queue<DatosDeJob>;
  private worker?: Worker<DatosDeJob>;

  constructor(private readonly inventory: InventoryService) {}

  onModuleInit(): void {
    if (!env.INVENTORY_EXPIRATION_QUEUE_ENABLED) {
      this.logger.warn('cola de expiración apagada: sólo vence el reconciliador');
      return;
    }

    // Conexión propia y no la de `RedisService`: BullMQ necesita
    // `maxRetriesPerRequest: null` para sus conexiones bloqueantes, y forzar
    // eso en la conexión compartida cambiaría el comportamiento del rate limit
    // y de todo lo demás que use Redis.
    const conexion = { url: env.REDIS_URL, maxRetriesPerRequest: null };

    this.queue = new Queue<DatosDeJob>(COLA, {
      connection: conexion,
      defaultJobOptions: {
        // Se limpian solos. Sin esto, Redis acumula un registro por cada
        // reserva creada desde el día uno.
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
        // Tres intentos: la operación es idempotente, así que reintentar es
        // gratis y cubre un corte breve de la base.
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
      },
    });

    this.queue.on('error', (err) => this.logger.error({ err }, 'error de la cola de expiración'));

    /**
     * El CONSUMIDOR sólo se enciende donde corren las tareas periódicas.
     *
     * ─── Por qué el productor sí y el consumidor no ───
     *
     * La cola tiene dos mitades con necesidades opuestas:
     *
     *   · **Producir** es parte de reservar. Ocurre dentro de la petición del
     *     comprador, así que el proceso web la necesita siempre.
     *   · **Consumir** es una espera bloqueante contra Redis. En un proceso
     *     que escala a cero eso no tiene sentido: mientras hay tráfico, el
     *     worker impide que el contenedor se duerma; cuando no lo hay, se
     *     apaga con los jobs pendientes sin procesar.
     *
     * Con los roles separados, el web produce y el worker consume. Y si nadie
     * consume —porque se desplegó sólo el web, o el worker está caído— **no se
     * pierde ninguna reserva**: el reconciliador barre por `expires_at` en
     * PostgreSQL. La cola da precisión al segundo; la garantía la da la base.
     */
    if (corresTareasPeriodicas()) {
      this.worker = new Worker<DatosDeJob>(
        COLA,
        async (job) => {
          // La verdad está en PostgreSQL. El job sólo dice "andá a fijarte": si
          // la reserva ya se consumió, se canceló o alguien la venció antes,
          // `expireIfDue` no hace nada y devuelve false.
          const vencida = await this.inventory.expireIfDue(job.data.reservationId);
          return { vencida };
        },
        { connection: conexion, concurrency: 8 },
      );

      // Un fallo de la cola no puede tumbar el proceso. Se registra y se sigue:
      // el reconciliador cubre lo que la cola no pudo.
      this.worker.on('error', (err) =>
        this.logger.error({ err }, 'error del worker de expiración'),
      );

      this.logger.log('cola de expiración: productor y consumidor listos');
    } else {
      this.logger.log('cola de expiración: sólo productor (el consumidor corre en el worker)');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  /**
   * Programa el vencimiento de una reserva.
   *
   * **Nunca lanza.** Es deliberado y es la propiedad más importante de esta
   * clase: se la llama después de que la reserva ya está cometida en
   * PostgreSQL, y un fallo acá no puede deshacer una venta que ya ocurrió.
   */
  async programar(reservationId: string, expiresAt: Date): Promise<void> {
    if (!this.queue) return;

    try {
      // Un segundo de margen. Sin él, el job puede dispararse un instante
      // antes de que `now()` de PostgreSQL alcance `expires_at`, el UPDATE no
      // encuentra nada y la expiración queda esperando al reconciliador — que
      // es justo la latencia que la cola venía a evitar.
      const retraso = Math.max(0, expiresAt.getTime() - Date.now() + 1_000);

      const opciones: JobsOptions = {
        delay: retraso,
        // El id del job ES el de la reserva. BullMQ descarta duplicados por
        // id, así que programar dos veces la misma reserva deja un solo job.
        // Guion y no `:` por la misma razón que el nombre de la cola.
        jobId: `exp-${reservationId}`,
      };

      await this.queue.add('expire', { reservationId }, opciones);
    } catch (err) {
      this.logger.error({
        msg: 'no se pudo programar la expiración: la cubre el reconciliador',
        reservationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
