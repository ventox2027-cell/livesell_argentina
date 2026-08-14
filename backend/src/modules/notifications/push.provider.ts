import { Injectable, Logger } from '@nestjs/common';

/**
 * Cómo se manda un push. La interfaz, no la implementación.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ HAY UNA INTERFAZ PARA UNA SOLA IMPLEMENTACIÓN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Hoy hay dos: Firebase y una que escribe en el log. La del log no es un
 * "mock de tests": es la que corre en desarrollo y en cualquier entorno sin
 * credenciales de Firebase, y hace que todo el sistema de avisos —las filas,
 * el centro de notificaciones, los reintentos, la deduplicación— se pueda
 * construir y probar entero antes de que exista un proyecto de Firebase.
 *
 * El día que las credenciales lleguen, se cambia una variable de entorno.
 *
 * ⚠️ El backend **nunca** loguea el token de push completo. Es lo que hace
 * falta para mandarle notificaciones a un teléfono concreto: en un log
 * agregado, es la diferencia entre una traza y un canal directo al usuario.
 */

export interface MensajePush {
  /** Los tokens de todos los dispositivos de la persona. */
  tokens: string[];
  title: string;
  body: string;
  /** Payload que la app usa para saber a dónde llevar al tocar. */
  data: Record<string, string>;
}

export interface ResultadoPush {
  /** Cuántos aceptó el proveedor. */
  entregados: number;
  /**
   * Tokens que el proveedor declaró inválidos.
   *
   * Se distinguen de un fallo de red a propósito: estos hay que BORRARLOS,
   * porque reintentarlos falla para siempre. Un fallo de red hay que
   * reintentarlo. Tratarlos igual significa o borrar dispositivos buenos por
   * un corte de dos minutos, o reintentar eternamente tokens de apps
   * desinstaladas.
   */
  tokensMuertos: string[];
}

export abstract class PushProvider {
  /** Si esto es `false`, el sistema no intenta enviar y marca `SKIPPED`. */
  abstract get disponible(): boolean;
  abstract enviar(mensaje: MensajePush): Promise<ResultadoPush>;
}

/**
 * La de desarrollo: escribe en el log y no manda nada.
 *
 * Deja ver el título, el cuerpo y a cuántos dispositivos habría ido, que es lo
 * que hace falta para trabajar en los avisos sin Firebase.
 *
 * `disponible` es `false` a propósito: las filas quedan en `SKIPPED`, no en
 * `SENT`. Marcarlas como enviadas sería mentirle a la base — y después, al
 * conectar Firebase de verdad, nadie sabría cuáles se mandaron y cuáles no.
 */
@Injectable()
export class PushDeConsola extends PushProvider {
  private readonly logger = new Logger('PushDeConsola');

  get disponible(): boolean {
    return false;
  }

  // Sin `async`: no hay nada que esperar. Devuelve una promesa igual porque la
  // implementación real sí va a hacer una llamada de red.
  enviar(mensaje: MensajePush): Promise<ResultadoPush> {
    this.logger.log({
      msg: '[push simulado] no se envió nada: falta configurar Firebase',
      title: mensaje.title,
      body: mensaje.body,
      // ⚠️ La cantidad, nunca los tokens.
      dispositivos: mensaje.tokens.length,
      data: mensaje.data,
    });
    return Promise.resolve({ entregados: 0, tokensMuertos: [] });
  }
}
