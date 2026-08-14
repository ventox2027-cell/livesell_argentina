import { env } from '@/config/env.schema';

/**
 * Qué hace este proceso: atender peticiones, correr tareas periódicas, o ambas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE ESTA DIVISIÓN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Las plataformas modernas de contenedores **apagan el proceso cuando no hay
 * tráfico**. Code Engine lo hace por omisión, Render lo hace en el plan
 * gratuito, Fly lo hace si `auto_stop_machines` está encendido.
 *
 * Eso convierte un `setInterval` dentro del proceso web en una trampa: deja de
 * ejecutarse exactamente cuando más falta hace. De madrugada, sin visitas, es
 * cuando quedan reservas venciendo sin liberar y pagos en estado desconocido
 * sin resolver. El sistema no da error: simplemente deja de reconciliar, y se
 * descubre a la mañana con stock trabado y plata de alguien en el limbo.
 *
 * ─── Qué NO es esto ───
 *
 * No es partir el sistema en microservicios. Es el mismo repositorio, el mismo
 * código y **la misma imagen de contenedor**, arrancada por otro punto de
 * entrada. No hay red entre las partes, no hay contrato que versionar, no hay
 * despliegue que coordinar. Lo único que cambia es qué se enciende al arrancar.
 *
 * ─── Las tres formas de desplegarlo ───
 *
 *   1. **Un contenedor** (`all`) — local, y cualquier plataforma donde el
 *      proceso esté siempre vivo.
 *   2. **Dos contenedores** (`web` + `worker`) — el web escala a cero sin
 *      consecuencias porque las tareas periódicas viven en el otro.
 *   3. **Web + tarea programada** (`web` + `jobs:una-vez`) — el proveedor
 *      dispara un contenedor cada N minutos, hace un barrido y termina. Es lo
 *      más barato: no hay nada corriendo entre barridos.
 *
 * La (3) es la que encaja con Code Engine, que tiene tareas programadas nativas.
 *
 * ─── La verdad sigue en PostgreSQL ───
 *
 * Nada de esto cambia quién manda. Las condiciones de vencimiento viven en la
 * base (`expires_at`, estados de las órdenes) y los barridos son consultas.
 * Que el barrido lo dispare un `setInterval`, un cron del proveedor o alguien a
 * mano da igual: el resultado es el mismo porque la decisión no está en el
 * disparador. Por eso se puede cambiar de forma de despliegue sin tocar lógica.
 */

/** ¿Este proceso atiende peticiones HTTP? */
export function corresPeticiones(): boolean {
  return env.APP_ROLE === 'all' || env.APP_ROLE === 'web';
}

/**
 * ¿Este proceso corre las tareas periódicas?
 *
 * Los reconciliadores y el consumidor de la cola preguntan esto antes de
 * arrancar su temporizador. Con `web`, no se encienden — y no pasa nada malo,
 * porque otro proceso los está corriendo.
 */
export function corresTareasPeriodicas(): boolean {
  return env.APP_ROLE === 'all' || env.APP_ROLE === 'worker';
}
