import 'reflect-metadata';

import { RequestMethod, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import fastifyStatic from '@fastify/static';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { env, isLocalEnv } from './config/env.schema';
import { configurarAdaptador, registrarMultipart } from './http-setup';

const SHUTDOWN_LB_DRAIN_MS = 5_000;

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    trustProxy: true, // detrás de Cloudflare y del proxy de Fly
    bodyLimit: 2 * 1024 * 1024,
    // Fastify genera su propio requestId; el logger lo sustituye por el
    // x-request-id entrante si viene de la app.
    genReqId: () => crypto.randomUUID(),
  });

  // Hooks, parsers de contenido y todo lo que cambie el comportamiento del
  // servidor viven en http-setup.ts, que también usan los tests. Ver ahí por
  // qué no puede haber dos lugares.
  configurarAdaptador(adapter);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
    // Expone req.rawBody (Buffer) para verificar firmas de webhooks.
    rawBody: true,
  });

  app.useLogger(app.get(Logger));

  await registrarMultipart(app);

  /**
   * Imágenes de producto en desarrollo.
   *
   * Servir archivos desde el proceso de la API es aceptable en local y NO en
   * producción: cada imagen ocupa una conexión del servidor de aplicación en
   * vez de salir por un CDN. En producción las sirve Cloudflare R2 y esta ruta
   * no existe.
   */
  if (isLocalEnv(env.NODE_ENV)) {
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

  app.enableShutdownHooks();

  const logger = app.get(Logger);

  // Apagado ordenado. Sin esto, cada deploy corta peticiones a la mitad.
  // Fly.io concede 30 s antes del SIGKILL; el presupuesto entra con margen.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${signal} recibido — apagado ordenado`);

    // 1) Dar tiempo a que el balanceador nos saque de rotación tras el 503 de /ready.
    await new Promise((r) => setTimeout(r, SHUTDOWN_LB_DRAIN_MS));
    // 2) Cerrar: Nest dispara onModuleDestroy (Prisma y Redis se desconectan).
    await app.close();
    logger.log('apagado completo');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(env.PORT, '0.0.0.0');

  logger.log(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      version: env.GIT_SHA,
      spikeEnabled: env.SPIKE_ENABLED,
      livekitWsUrl: env.LIVEKIT_WS_URL,
    },
    'API escuchando',
  );
}

void bootstrap();
