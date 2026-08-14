import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { InventoryReconciler } from './modules/inventory/reconciler.service';
import { OrdersReconciler } from './modules/orders/reconciler.service';

/**
 * Un barrido y salir.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PARA QUÉ SIRVE ESTO SI YA EXISTE EL WORKER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es la variante más barata y la más portable de correr las tareas periódicas:
 * el proveedor dispara un contenedor cada N minutos, hace un barrido y termina.
 * Entre barrido y barrido no hay nada corriendo ni nada que pagar.
 *
 * Encaja con:
 *
 *   · **IBM Code Engine** — tareas programadas nativas, que es el modelo que
 *     esa plataforma espera.
 *   · **Render** — cron jobs.
 *   · Cualquier cron externo, incluido uno en una máquina cualquiera.
 *
 * ─── Por qué es seguro ejecutar esto en paralelo con el worker ───
 *
 * Se puede correr mientras el proceso web está vivo, mientras hay un worker
 * corriendo, o dos veces al mismo tiempo por un error de configuración. No pasa
 * nada, y no por suerte:
 *
 *   · **La condición vive en PostgreSQL.** Vencer una reserva es un UPDATE
 *     condicional sobre `expires_at`; si otro barrido llegó primero, el
 *     segundo afecta cero filas. La condición y la escritura son la misma
 *     operación.
 *   · **Los reconciliadores no deciden nada.** Le preguntan al proveedor de
 *     pagos y aplican lo que responda, por el mismo camino que la respuesta
 *     directa. Preguntar dos veces da la misma respuesta.
 *   · **Cada barrido tiene su candado en memoria** contra solaparse consigo
 *     mismo, y entre procesos distintos el candado real son las invariantes de
 *     la base.
 *
 * Esa es exactamente la propiedad que hace que el sistema se pueda desplegar de
 * tres formas distintas sin cambiar una línea de lógica.
 *
 * ─── El código de salida importa ───
 *
 * Los planificadores marcan la ejecución como fallida por el código de salida.
 * Si esto saliera siempre con 0, una tarea programada que lleva días fallando
 * se vería idéntica a una que anda bien.
 *
 * ─── Sobre `APP_ROLE` acá ───
 *
 * Con `APP_ROLE=all`, los reconciliadores además arrancan su `setInterval` al
 * instanciarse. Es inofensivo —los temporizadores están `unref`eados y el
 * proceso sale apenas termina el barrido— pero lo prolijo en una tarea
 * programada es `APP_ROLE=web`: los barridos se invocan directo desde acá y no
 * hace falta ningún temporizador.
 */
async function main(): Promise<void> {
  const comenzado = Date.now();
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });

  const logger = app.get(Logger);
  app.useLogger(logger);

  let salida = 0;

  try {
    /**
     * Los dos barridos, cada uno con su error acotado.
     *
     * Secuencial y no en paralelo: comparten el mismo pool de conexiones, que
     * en el plan de Neon es chico. Y no hay apuro — esto corre cada varios
     * minutos, no dentro de una petición.
     *
     * Si el de inventario falla, el de órdenes se ejecuta igual: son
     * independientes y uno roto no puede impedir que el otro libere plata
     * trabada.
     */
    const inventario = await ejecutar(logger, 'inventario', () =>
      app.get(InventoryReconciler).barrer(),
    );
    const ordenes = await ejecutar(logger, 'órdenes', () => app.get(OrdersReconciler).barrer());

    if (!inventario.ok || !ordenes.ok) salida = 1;

    logger.log(
      {
        duracionMs: Date.now() - comenzado,
        inventario: inventario.resultado,
        ordenes: ordenes.resultado,
      },
      salida === 0 ? 'barrido completo' : 'barrido con fallos',
    );
  } finally {
    await app.close();
  }

  process.exit(salida);
}

async function ejecutar<T>(
  logger: Logger,
  nombre: string,
  fn: () => Promise<T>,
): Promise<{ ok: boolean; resultado: T | string }> {
  try {
    return { ok: true, resultado: await fn() };
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    logger.error({ barrido: nombre, error: mensaje }, `falló el barrido de ${nombre}`);
    return { ok: false, resultado: mensaje };
  }
}

void main().catch((err: unknown) => {
  // Un fallo al construir el contexto —base inalcanzable, configuración
  // inválida— no llega al try de arriba. Sin esto, el proceso saldría con 0 y
  // el planificador registraría un éxito.
  console.error('el barrido no pudo arrancar:', err);
  process.exit(1);
});
