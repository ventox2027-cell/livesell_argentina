import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { corresTareasPeriodicas } from '@/shared/app-role';

import { StoresService } from './stores.service';

/**
 * El barrido que detecta tiendas que reabren.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ HACE FALTA UN BARRIDO PARA ESTO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Que una tienda esté abierta se calcula: horario, zona y hora actual. No hay
 * ningún momento en el que alguien apriete un botón a las nueve de la mañana,
 * así que sin algo que mire el reloj, la gente que dejó "avisame cuando abran"
 * no se entera nunca.
 *
 * La alternativa sería programar una tarea por cada franja horaria de cada
 * tienda. Con mil tiendas y dos franjas por día son catorce mil tareas
 * programadas que hay que rehacer cada vez que un vendedor edita su horario, y
 * que se pierden si el proceso se reinicia. Un barrido de una consulta cada
 * minuto hace lo mismo sin estado que mantener.
 *
 * ─── El desfase es aceptable, y es el correcto ───
 *
 * Un aviso puede salir hasta un minuto después de la apertura real. Para "la
 * tienda abrió, andá a comprar" eso no le cambia el resultado a nadie. El error
 * está del lado bueno: tarde, nunca antes.
 */
@Injectable()
export class ReaperturasService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReaperturasService.name);

  private timer?: NodeJS.Timeout;
  private corriendo = false;

  constructor(private readonly stores: StoresService) {}

  onModuleInit(): void {
    if (!env.STORE_REOPEN_SWEEP_ENABLED) {
      this.logger.warn('barrido de reaperturas apagado');
      return;
    }
    if (!corresTareasPeriodicas()) {
      this.logger.log('rol web: las reaperturas las detecta el worker');
      return;
    }

    this.timer = setInterval(() => {
      void this.barrer();
    }, env.STORE_REOPEN_SWEEP_INTERVAL_MS);

    this.timer.unref();
    this.logger.log(`barrido de reaperturas cada ${env.STORE_REOPEN_SWEEP_INTERVAL_MS / 1000}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un barrido. Público para que los tests no dependan del reloj. */
  async barrer(): Promise<{ reabiertas: number; avisos: number }> {
    if (this.corriendo) return { reabiertas: 0, avisos: 0 };
    this.corriendo = true;

    try {
      const resumen = await this.stores.barrerReaperturas();
      if (resumen.reabiertas > 0) {
        this.logger.log({ msg: 'tiendas que reabrieron', ...resumen });
      }
      return resumen;
    } catch (err) {
      this.logger.error({
        msg: 'el barrido de reaperturas falló entero',
        error: err instanceof Error ? err.message : String(err),
      });
      return { reabiertas: 0, avisos: 0 };
    } finally {
      this.corriendo = false;
    }
  }
}
