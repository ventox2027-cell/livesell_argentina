import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { corresTareasPeriodicas } from '@/shared/app-role';

import { InventoryService } from './inventory.service';

/**
 * Red de seguridad de las expiraciones.
 *
 * ─── Por qué no alcanza con los jobs diferidos ───
 *
 * Un job de BullMQ vive en Redis. Redis se reinicia, se queda sin memoria, se
 * migra de proveedor, o alguien ejecuta un `FLUSHALL` en la consola
 * equivocada. Cualquiera de esas cosas se lleva puestos los jobs pendientes.
 *
 * Si esa fuera la única forma de vencer una reserva, el stock apartado quedaría
 * bloqueado **para siempre**. El vendedor vería "agotado" con unidades en el
 * depósito y no habría forma de darse cuenta desde la aplicación: los números
 * de la base serían internamente consistentes, sólo que congelados.
 *
 * Este barrido lo hace imposible. La condición de vencimiento vive en
 * PostgreSQL (`expires_at`), así que basta con preguntar cada tanto.
 *
 *   · La cola da precisión al segundo.
 *   · Esto da la garantía de que siempre pasa.
 *
 * ─── Por qué un intervalo y no un cron ───
 *
 * `@nestjs/schedule` traería un decorador y una dependencia más para hacer lo
 * que hace `setInterval`. Con una sola tarea periódica no compra nada.
 *
 * ─── Por qué no se solapa consigo mismo ───
 *
 * Si un barrido tarda más que el intervalo, el siguiente NO arranca. Sin ese
 * candado, una base lenta acumularía barridos en paralelo peleando por las
 * mismas filas, lo que la haría más lenta todavía.
 */
@Injectable()
export class InventoryReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InventoryReconciler.name);

  private timer?: NodeJS.Timeout;
  private corriendo = false;

  constructor(private readonly inventory: InventoryService) {}

  onModuleInit(): void {
    if (!env.INVENTORY_RECONCILER_ENABLED) {
      this.logger.warn('reconciliador de inventario apagado');
      return;
    }

    /**
     * En un proceso `web` no se arranca el temporizador: lo corre el worker.
     *
     * Con escalado a cero, un `setInterval` acá deja de ejecutarse justo cuando
     * más falta hace —de madrugada, sin tráfico, con reservas venciendo— y sin
     * dar ningún error. Ver `shared/app-role.ts`.
     */
    if (!corresTareasPeriodicas()) {
      this.logger.log('rol web: el barrido de reservas lo corre el worker');
      return;
    }

    this.timer = setInterval(() => {
      void this.barrer();
    }, env.INVENTORY_RECONCILER_INTERVAL_MS);

    // `unref` para que un proceso que sólo tiene este temporizador pendiente
    // pueda terminar. Sin esto, los tests y los scripts quedan colgados.
    this.timer.unref();

    this.logger.log(
      `reconciliador de inventario cada ${env.INVENTORY_RECONCILER_INTERVAL_MS / 1000}s`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un barrido. Público para que los tests no dependan del reloj. */
  async barrer(): Promise<{ revisadas: number; vencidas: number }> {
    if (this.corriendo) return { revisadas: 0, vencidas: 0 };
    this.corriendo = true;

    try {
      const resultado = await this.inventory.expireDue();

      // Sólo se registra cuando hubo algo que hacer: un log cada 30 segundos
      // diciendo "no había nada" entierra los que sí importan.
      if (resultado.vencidas > 0) {
        this.logger.log({
          msg: 'reservas vencidas liberadas',
          vencidas: resultado.vencidas,
          revisadas: resultado.revisadas,
        });
      }
      return resultado;
    } catch (err) {
      // Nunca propaga: una excepción dentro de `setInterval` sin capturar
      // tumba el proceso de Node.
      this.logger.error({
        msg: 'falló el barrido de reservas vencidas',
        error: err instanceof Error ? err.message : String(err),
      });
      return { revisadas: 0, vencidas: 0 };
    } finally {
      this.corriendo = false;
    }
  }
}
