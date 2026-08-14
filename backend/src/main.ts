import 'reflect-metadata';

import { RequestMethod, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import fastifyStatic from '@fastify/static';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { env, isLocalEnv } from './config/env.schema';
import { crearAdaptador, registrarMultipart } from './http-setup';
import { resolverDeIp } from './shared/http/client-ip';
import { registrarApagadoOrdenado } from './shutdown';

async function bootstrap(): Promise<void> {
  // Opciones, hooks y parsers viven en http-setup.ts, que también usan los
  // tests. Ver ahí por qué no puede haber dos lugares.
  const adapter = crearAdaptador();

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
    // Expone req.rawBody (Buffer) para verificar firmas de webhooks.
    rawBody: true,
  });

  app.useLogger(app.get(Logger));

  await registrarMultipart(app);

  /**
   * Imágenes de producto desde disco. Sólo con `STORAGE_DRIVER=local`.
   *
   * ─── Por qué la condición es el driver y no el entorno ───
   *
   * Antes miraba `NODE_ENV`. Eso era una suposición: que en desarrollo el
   * almacenamiento siempre es disco. Desde que existe `STORAGE_DRIVER`, un
   * desarrollador puede apuntar su entorno local a R2 para reproducir un
   * problema — y en ese caso registrar esto acá capturaría `/media/*` antes que
   * `MediaController`, que es quien tiene que responder. Las imágenes darían
   * 404 sin ninguna pista de por qué.
   *
   * La regla correcta: sirve el disco quien esté usando el disco.
   *
   * Servir archivos desde el proceso de la API es aceptable en local y no en
   * producción: cada imagen ocupa una conexión del servidor de aplicación en
   * vez de salir por un CDN. Con `r2` esta ruta la atiende `MediaController`,
   * que redirige en vez de transferir.
   */
  if (env.STORAGE_DRIVER === 'local') {
    await app.register(fastifyStatic, {
      root: `${process.cwd()}/storage`,
      prefix: '/media/',
      // Sin listado de directorios: expondría los ids de todos los productos.
      index: false,
      list: false,
    });
  }

  // /api/v1/... desde el día 1.
  //
  // Quedan fuera del prefijo Y del versionado:
  //   · health/ready/metrics → los consumen el balanceador y Prometheus, que
  //     no negocian versiones. Su URL no puede cambiar nunca.
  //   · webhooks → la URL se configura en el panel del proveedor. Si un día
  //     saliera /api/v2/, nadie va a ir a actualizarla a mano.
  //
  // Excluir del prefijo NO excluye del versionado: los controladores llevan
  // además VERSION_NEUTRAL. Sin eso, /health responde en /v1/health.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'ready', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
      { path: 'webhooks/livekit', method: RequestMethod.POST },
      { path: 'webhooks/mercadopago', method: RequestMethod.POST },
      // Las URLs de las imágenes se PERSISTEN en la base, incluidas las de los
      // snapshots históricos de pedidos. Si algún día saliera /api/v2/, esas
      // filas seguirían apuntando acá. Fuera del prefijo y del versionado.
      { path: 'media/*', method: RequestMethod.GET },
      // La carga un WebView desde una URL que arma la app. Fuera del prefijo
      // para que no dependa de la versión de la API.
      { path: 'checkout', method: RequestMethod.GET },
    ],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // La app móvil no usa CORS. Solo el futuro Admin Lite.
  app.enableCors({
    origin: isLocalEnv(env.NODE_ENV) ? true : [/\.livesell\.ar$/],
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-spike-key', 'x-request-id'],
  });

  /**
   * ⚠️ SIN `app.enableShutdownHooks()`. A propósito.
   *
   * Ese método hace dos cosas y sólo una es la que se quiere: registra
   * manejadores propios de SIGTERM/SIGINT, y esos llaman a `app.close()`
   * **inmediatamente**.
   *
   * Con nuestro manejador puesto además, pasaba esto en cada despliegue:
   *
   *     t=0.00s  SIGTERM. Nest cierra TODO: Prisma, Redis, los temporizadores.
   *     t=0.00s  nuestro manejador empieza a drenar 5 segundos.
   *     t=0-5s   llegan peticiones del balanceador contra una app ya cerrada.
   *     t=5.00s  nuestro `app.close()` corre sobre lo que ya estaba cerrado
   *              y revienta: `Error: Connection is closed` desde ioredis.
   *
   * O sea: el drenaje no drenaba nada —su único efecto era retrasar cinco
   * segundos un cierre que ya había ocurrido— y encima el proceso terminaba
   * con código 1, que la plataforma registra como apagado fallido.
   *
   * Se descubrió midiendo el apagado del contenedor, no leyendo el código:
   * los dos manejadores son correctos por separado.
   *
   * `app.close()` dispara `onModuleDestroy` igual, sin necesidad de esto. Lo
   * único que se pierde es que `onApplicationShutdown` reciba el nombre de la
   * señal, que no usamos en ningún lado.
   */
  const logger = app.get(Logger);

  registrarApagadoOrdenado(app, logger, {
    drenajeMs: env.SHUTDOWN_DRAIN_MS,
    topeMs: env.SHUTDOWN_TIMEOUT_MS,
  });

  /**
   * `0.0.0.0` y no `localhost`.
   *
   * Dentro de un contenedor, escuchar en `localhost` ata el socket a la interfaz
   * de loopback del contenedor: el proceso arranca, el puerto figura abierto
   * desde adentro, y ninguna petición de afuera llega nunca. La plataforma
   * sondea, no obtiene respuesta y reinicia en bucle sin decir por qué.
   *
   * El puerto lo elige la plataforma, no nosotros. Ver `PORT` en la
   * configuración.
   */
  await app.listen(env.PORT, '0.0.0.0');

  logger.log(
    {
      rol: env.APP_ROLE,
      proveedor: env.DEPLOYMENT_PROVIDER,
      ipDelCliente: resolverDeIp().descripcion,
      port: env.PORT,
      env: env.NODE_ENV,
      version: env.GIT_SHA,
      spikeEnabled: env.SPIKE_ENABLED,
    },
    'API escuchando',
  );
}

void bootstrap();
