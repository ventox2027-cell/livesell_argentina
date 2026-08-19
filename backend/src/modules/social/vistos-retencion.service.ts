import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { corresTareasPeriodicas } from '@/shared/app-role';

import { SocialService } from './social.service';
import { VISTOS_RETENCION_DIAS } from './vistos';

/**
 * Borra el historial de «vistos recientemente» que pasó los 30 días.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO NO EXISTÍA Y TENÍA QUE EXISTIR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La política de privacidad publicada dice que los vistos «se borran solos» a
 * los 30 días. El código los ESCONDÍA a los 30 días: `misVistosRecientes`
 * filtra por fecha y la fila se queda en la base indefinidamente.
 *
 * Para quien mira menos de cincuenta productos —el tope por persona era la
 * única poda— eso significaba su historial de navegación completo, guardado sin
 * vencimiento, con una promesa pública que decía lo contrario.
 *
 * ─── Por qué un barrido global y no uno por persona ───
 *
 * Porque el dato vence por antigüedad, no por dueño. Un barrido por persona
 * requeriría recorrer usuarios, y quien dejó de abrir la app hace un año es
 * justamente de quien más conviene borrar.
 *
 * ─── Una vez por día alcanza ───
 *
 * Nadie se perjudica porque una fila del día 31 se borre a la tarde. Correrlo
 * cada hora sería gastar consultas para nada.
 *
 * ─── En el proceso web no arranca ───
 *
 * Lo corre el worker, igual que la retención del chat. Con escalado a cero, un
 * `setInterval` en el proceso web se apaga de madrugada, que es cuando conviene
 * barrer.
 */
@Injectable()
export class VistosRetencionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VistosRetencionService.name);

  private timer?: NodeJS.Timeout;
  private corriendo = false;

  constructor(private readonly social: SocialService) {}

  onModuleInit(): void {
    if (!corresTareasPeriodicas()) {
      this.logger.log('rol web: la retención de vistos la corre el worker');
      return;
    }

    const cadaDia = 24 * 60 * 60_000;
    this.timer = setInterval(() => {
      void this.barrer();
    }, cadaDia);

    // `unref` para que un proceso que sólo tiene esto pendiente pueda terminar.
    this.timer.unref();
    this.logger.log(`retención de vistos: ${VISTOS_RETENCION_DIAS} días, barrido diario`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un barrido. Público para que los tests no dependan del reloj. */
  async barrer(): Promise<number> {
    if (this.corriendo) return 0;
    this.corriendo = true;

    try {
      const borrados = await this.social.borrarVistosViejos();
      if (borrados > 0) {
        this.logger.log({ msg: 'vistos borrados por retención', cantidad: borrados });
      }
      return borrados;
    } catch (err) {
      /**
       * Un fallo acá no puede tumbar nada.
       *
       * Lo peor que pasa si el barrido falla una noche es que las filas se
       * borren mañana. Propagar la excepción mataría el worker, que además
       * corre las reservas y los pagos.
       */
      this.logger.error({
        msg: 'falló el barrido de retención de vistos',
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      this.corriendo = false;
    }
  }
}
