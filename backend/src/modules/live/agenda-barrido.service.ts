import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { corresTareasPeriodicas } from '@/shared/app-role';

import { AgendaService } from './agenda.service';

/**
 * El barrido que avisa de los vivos que están por empezar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ UN BARRIDO Y NO UN TEMPORIZADOR POR VIVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo obvio sería un `setTimeout` al programar el vivo. No funciona: los
 * temporizadores viven en la memoria del proceso, y un despliegue a las 19:55
 * haría que nadie se entere del vivo de las 20:00. Tampoco sobreviven a un
 * reinicio, a un crash ni a escalar a dos instancias — donde además cada una
 * mandaría su propio aviso.
 *
 * El barrido le pregunta a la base, que es lo único que sobrevive a todo eso.
 *
 * ─── Cada dos minutos ───
 *
 * El aviso sale diez minutos antes del vivo. Con un barrido cada dos, el peor
 * caso es que llegue con ocho minutos de anticipación en vez de diez, y eso no
 * le cambia el día a nadie. Cada treinta segundos serían quince veces más
 * consultas para ganar un minuto y medio.
 */
@Injectable()
export class AgendaBarridoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgendaBarridoService.name);

  private timer?: NodeJS.Timeout;
  private corriendo = false;

  constructor(private readonly agenda: AgendaService) {}

  onModuleInit(): void {
    if (!corresTareasPeriodicas()) {
      this.logger.log('rol web: los avisos de vivos próximos los manda el worker');
      return;
    }

    this.timer = setInterval(() => void this.barrer(), 2 * 60_000);
    // `unref` para que un proceso que sólo tiene esto pendiente pueda terminar.
    this.timer.unref();
    this.logger.log('avisos de vivos próximos: barrido cada 2 minutos');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un barrido. Público para que los tests no dependan del reloj. */
  async barrer(): Promise<number> {
    // Si el anterior todavía corre, este se saltea. Dos barridos superpuestos
    // leerían los mismos vivos y competirían por marcarlos.
    if (this.corriendo) return 0;
    this.corriendo = true;

    try {
      const { avisos } = await this.agenda.avisarLosQueEmpiezanPronto();
      return avisos;
    } catch (err) {
      /**
       * Un fallo acá no puede tumbar nada.
       *
       * Lo peor que pasa es que unos avisos lleguen tarde o no lleguen.
       * Propagar la excepción mataría el proceso del worker, que además corre
       * las reservas, los pagos y la conciliación.
       */
      this.logger.error({
        msg: 'falló el barrido de vivos próximos',
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      this.corriendo = false;
    }
  }
}
