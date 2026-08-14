import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { env } from './config/env.schema';
import { InventoryReconciler } from './modules/inventory/reconciler.service';
import { OrdersReconciler } from './modules/orders/reconciler.service';
import { registrarApagadoOrdenado } from './shutdown';

/**
 * El proceso worker: tareas periódicas, sin servidor HTTP.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Las plataformas de contenedores apagan el proceso cuando no hay tráfico. Eso
 * convierte un `setInterval` dentro del proceso web en una trampa: deja de
 * correr exactamente cuando más falta hace. De madrugada, sin visitas, es
 * cuando quedan reservas venciendo sin liberar y pagos en estado desconocido
 * sin resolver — y no da ningún error, simplemente deja de reconciliar.
 *
 * ─── Es la MISMA imagen ───
 *
 * Mismo repositorio, mismo código, mismo contenedor. Lo único que cambia es el
 * comando. No hay red entre las partes, ni contrato que versionar, ni
 * despliegue que coordinar. Los reconciliadores son los mismos objetos que en
 * el proceso `all`, con la misma lógica: `APP_ROLE` sólo decide quién enciende
 * el temporizador.
 *
 * ─── Sin HTTP a propósito ───
 *
 * `createApplicationContext` levanta el contenedor de dependencias sin abrir un
 * socket. Un worker que escucha un puerto que nadie va a usar es superficie de
 * ataque gratis, y en plataformas que cobran por instancia con puerto abierto,
 * plata.
 *
 * La contrapartida: no hay `/health` que sondear. Si la plataforma exige un
 * chequeo HTTP para mantener vivo el contenedor, la forma correcta no es
 * agregarle un servidor a esto, sino usar `jobs:una-vez` con una tarea
 * programada. Ver `docs/RUNBOOK-staging-ibm-code-engine.md`.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });

  const logger = app.get(Logger);
  app.useLogger(logger);

  // Sin `enableShutdownHooks()`: registra manejadores de señal propios que
  // cierran de inmediato y pelean con el nuestro. Ver la nota en `main.ts`.
  // `app.close()` dispara `onModuleDestroy` igual.
  registrarApagadoOrdenado(app, logger, {
    // Sin balanceador del que salir de rotación: no hay nada que drenar. Lo que
    // sí importa es que un barrido en curso pueda terminar, y de eso se ocupa
    // `app.close()` esperando a `onModuleDestroy`.
    drenajeMs: 0,
    topeMs: env.SHUTDOWN_TIMEOUT_MS,
  });

  /**
   * Se piden los reconciliadores para que Nest los instancie.
   *
   * Sin esto no hay error visible: Nest crea los proveedores de forma perezosa
   * en un contexto de aplicación, así que el worker arrancaría, no fallaría, y
   * no barrería nada. Un proceso vivo que no hace su trabajo es peor que uno
   * que se cae.
   */
  const inventario = app.get(InventoryReconciler);
  const ordenes = app.get(OrdersReconciler);

  logger.log(
    {
      rol: env.APP_ROLE,
      version: env.GIT_SHA,
      env: env.NODE_ENV,
      inventario: env.INVENTORY_RECONCILER_ENABLED
        ? `cada ${env.INVENTORY_RECONCILER_INTERVAL_MS / 1000}s`
        : 'apagado',
      ordenes: env.ORDERS_RECONCILER_ENABLED
        ? `cada ${env.ORDERS_RECONCILER_INTERVAL_MS / 1000}s`
        : 'apagado',
    },
    'worker arrancado',
  );

  if (env.APP_ROLE === 'web') {
    logger.error(
      'APP_ROLE=web en el proceso worker: no se va a barrer nada. Poner APP_ROLE=worker.',
    );
  }

  // Las referencias existen para forzar la instanciación de arriba; esto le
  // dice al compilador que no son código muerto.
  void inventario;
  void ordenes;
}

void bootstrap();
