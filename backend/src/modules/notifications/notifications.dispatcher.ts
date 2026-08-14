import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { corresTareasPeriodicas } from '@/shared/app-role';

import { NotificationsService } from './notifications.service';

/**
 * El barrido que manda los avisos pendientes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ES UN BARRIDO Y NO UNA COLA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ya hay BullMQ en el proyecto y sería el lugar obvio. No se usa acá por la
 * misma razón que en el resto del sistema: **Redis es precisión, no una
 * dependencia**.
 *
 * Con una cola, un Redis caído significa avisos que nunca se encolan y que
 * nadie sabe que faltan. Con filas en PostgreSQL, un Redis caído no cambia
 * nada: los avisos están escritos, y el barrido los encuentra igual cuando le
 * toca. La única diferencia es que salen unos segundos más tarde.
 *
 * Lo que se pierde es latencia — un aviso puede tardar hasta un intervalo en
 * salir. Para "tu pedido está listo" eso es irrelevante. Para el chat del vivo
 * sí importaría, y por eso el chat NO pasa por acá: va por el socket.
 *
 * ─── En un proceso web no arranca ───
 *
 * Lo corre el worker. Con escalado a cero, un `setInterval` en el proceso web
 * se apaga de madrugada, que es cuando nadie va a notar que los avisos dejaron
 * de salir. Ver `shared/app-role.ts`.
 */
@Injectable()
export class NotificationsDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsDispatcher.name);

  private timer?: NodeJS.Timeout;
  private corriendo = false;

  constructor(private readonly notifications: NotificationsService) {}

  onModuleInit(): void {
    if (!env.NOTIFICATIONS_DISPATCHER_ENABLED) {
      this.logger.warn('despachador de avisos apagado');
      return;
    }
    if (!corresTareasPeriodicas()) {
      this.logger.log('rol web: los avisos los manda el worker');
      return;
    }

    this.timer = setInterval(() => {
      void this.barrer();
    }, env.NOTIFICATIONS_DISPATCHER_INTERVAL_MS);

    // `unref` para que un proceso que sólo tiene esto pendiente pueda terminar.
    this.timer.unref();
    this.logger.log(
      `despachador de avisos cada ${env.NOTIFICATIONS_DISPATCHER_INTERVAL_MS / 1000}s`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Un barrido. Público para que los tests no dependan del reloj.
   *
   * El candado `corriendo` es contra el solapamiento DENTRO de este proceso: si
   * un barrido tarda más que el intervalo, el siguiente no arranca encima.
   *
   * ⚠️ No protege contra dos procesos worker a la vez. Hoy hay uno solo; el día
   * que haya más, hace falta un candado en la base. La consecuencia de no
   * tenerlo es un aviso duplicado, no un aviso perdido — es el lado correcto
   * del error, pero está anotado.
   */
  async barrer(): Promise<{ procesados: number; enviados: number; omitidos: number; fallidos: number }> {
    if (this.corriendo) return { procesados: 0, enviados: 0, omitidos: 0, fallidos: 0 };
    this.corriendo = true;

    try {
      const resumen = await this.notifications.despachar(env.NOTIFICATIONS_DISPATCH_BATCH);
      if (resumen.procesados > 0) {
        this.logger.log({ msg: 'avisos despachados', ...resumen });
      }
      return resumen;
    } catch (err) {
      this.logger.error({
        msg: 'el barrido de avisos falló entero',
        error: err instanceof Error ? err.message : String(err),
      });
      return { procesados: 0, enviados: 0, omitidos: 0, fallidos: 0 };
    } finally {
      this.corriendo = false;
    }
  }
}
