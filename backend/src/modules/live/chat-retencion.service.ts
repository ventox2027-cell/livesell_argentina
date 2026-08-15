import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { corresTareasPeriodicas } from '@/shared/app-role';

import { ChatModeracionService } from './chat-moderacion.service';

/**
 * Borra los mensajes de chat viejos.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Los mensajes se guardan para poder moderar: sin el mensaje, un reporte de
 * chat es la palabra de quien reporta contra la de quien escribió.
 *
 * Pero guardarlos para siempre es otra cosa. El chat de un vivo es efímero por
 * naturaleza —nadie vuelve a leerlo— y una base de conversaciones creciendo sin
 * límite es un riesgo que no compra nada: más superficie en una filtración, más
 * datos que exportar cuando alguien ejerce su derecho de acceso, y más que
 * borrar cuando pide que lo borren.
 *
 * **Treinta días.** Es el tiempo en que un reporte se abre, se revisa y se
 * resuelve. Configurable con `CHAT_RETENCION_DIAS`.
 *
 * ─── Una vez por día alcanza ───
 *
 * No hay ninguna urgencia en borrar un mensaje del día 31 exactamente a la
 * medianoche. Correrlo cada hora sería gastar consultas para nada.
 *
 * ─── En un proceso web no arranca ───
 *
 * Lo corre el worker. Con escalado a cero, un `setInterval` en el proceso web
 * se apaga de madrugada, que es justo cuando conviene barrer. Ver
 * `shared/app-role.ts`.
 */
@Injectable()
export class ChatRetencionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatRetencionService.name);

  private timer?: NodeJS.Timeout;
  private corriendo = false;

  constructor(private readonly moderacion: ChatModeracionService) {}

  onModuleInit(): void {
    if (!corresTareasPeriodicas()) {
      this.logger.log('rol web: la retención del chat la corre el worker');
      return;
    }

    const cadaDia = 24 * 60 * 60_000;
    this.timer = setInterval(() => {
      void this.barrer();
    }, cadaDia);

    // `unref` para que un proceso que sólo tiene esto pendiente pueda terminar.
    this.timer.unref();
    this.logger.log(`retención del chat: ${env.CHAT_RETENCION_DIAS} días, barrido diario`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un barrido. Público para que los tests no dependan del reloj. */
  async barrer(): Promise<number> {
    if (this.corriendo) return 0;
    this.corriendo = true;

    try {
      return await this.moderacion.borrarLosViejos();
    } catch (err) {
      /**
       * Un fallo acá no puede tumbar nada.
       *
       * Lo peor que pasa si el barrido falla una noche es que los mensajes se
       * borren mañana. Propagar la excepción mataría el proceso del worker, que
       * además corre las reservas y los pagos.
       */
      this.logger.error({
        msg: 'falló el barrido de retención del chat',
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      this.corriendo = false;
    }
  }
}
