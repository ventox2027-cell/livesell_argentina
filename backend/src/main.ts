import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';


import { NestFactory } from '@nestjs/core';
import fastifyStatic from '@fastify/static';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { env, isLocalEnv } from './config/env.schema';
import { configurarPrefijoYVersionado, crearAdaptador, registrarMultipart } from './http-setup';
import { resolverDeIp } from './shared/http/client-ip';
import { registrarApagadoOrdenado } from './shutdown';

/**
 * Dónde están los archivos del sitio público.
 *
 * Dos ubicaciones posibles, y las dos son legítimas:
 *
 *   · `../web` — corriendo desde `backend/` en una máquina de desarrollo, con
 *     el repositorio completo alrededor.
 *   · `./web`  — dentro del contenedor, donde el Dockerfile copia sólo esa
 *     carpeta al lado de `dist`.
 *
 * Se devuelve `null` si no está ninguna, en vez de inventar una ruta. Un
 * `root` que no existe hace fallar el registro del plugin y con él todo el
 * arranque: la API entera caída porque falta una landing es un intercambio que
 * nadie haría.
 */
function raizDelSitio(): string | null {
  const candidatas = [resolve(process.cwd(), '..', 'web'), resolve(process.cwd(), 'web')];
  return candidatas.find((ruta) => existsSync(join(ruta, 'index.html'))) ?? null;
}

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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EL SITIO PÚBLICO SE SIRVE DESDE ACÁ, Y NO DESDE UN HOSTING APARTE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `vendox.com.ar` y `api.vendox.com.ar` apuntan al mismo servicio. Parece
   * mezclar dos cosas, y es al revés: separarlas obligaría a mantener un
   * proxy, porque hay rutas del dominio público que **sólo** puede contestar el
   * backend.
   *
   *   · `/.well-known/assetlinks.json` — las huellas salen de la configuración
   *     del entorno, no de un archivo del repositorio.
   *   · `/p/:id`, `/v/:id`, `/t/:slug`, `/u/:slug` — la previsualización de
   *     WhatsApp la arma un robot que no ejecuta JavaScript: las etiquetas
   *     `og:` tienen que venir escritas en el HTML que responde el servidor.
   *   · `/descargar/android` — la descarga del APK es una redirección firmada
   *     a R2. El bucket es privado y tiene que seguir siéndolo.
   *
   * Con un hosting estático aparte, esas seis rutas necesitan reglas de proxy
   * que hay que mantener sincronizadas a mano con el código. Con un solo
   * origen, no existe la pregunta de quién sirve qué.
   *
   * El costo es que el proceso de la API entrega cuatro archivos HTML. Son 40
   * kB y se cachean; el proceso ya venía sirviendo HTML en `/p/:id`.
   *
   * ⚠️ `wildcard: false` es lo que hace que esto sea seguro: un pedido que no
   * corresponde a un archivo real NO lo contesta este plugin, sigue de largo y
   * lo resuelven las rutas de Nest. Con el comodín encendido, `/p/abc123` se
   * comería el 404 del estático y la previsualización de WhatsApp mostraría una
   * página en blanco.
   */
  const raizWeb = raizDelSitio();
  if (raizWeb) {
    await app.register(fastifyStatic, {
      root: raizWeb,
      prefix: '/',
      // `/privacidad` tiene que servir `/privacidad/index.html`.
      index: ['index.html'],
      // Ya lo decoró el registro de `/media/`. Sólo uno puede.
      decorateReply: false,
      list: false,
      wildcard: false,
      // Un año para lo que lleva huella en el nombre; el HTML se revalida.
      maxAge: '10m',
    });
  }
  // Si `raizWeb` es null la API funciona igual, pero el dominio público
  // devuelve 404 y nada más lo explica. Por eso viaja en el log de arranque
  // —`sitio`— junto al resto de lo que hay que poder ver de un vistazo.

  // /api/v1/... desde el día 1, con las exclusiones que define `http-setup.ts`.
  //
  // ⚠️ La lista NO se escribe acá. Estuvo duplicada entre este archivo y el
  // helper de tests, las dos copias se separaron, y la suite terminó probando
  // una URL de webhook que en producción no existía. Ver la nota de
  // `configurarPrefijoYVersionado`.
  configurarPrefijoYVersionado(app);

  /**
   * La app móvil NO usa CORS: es un cliente nativo y el navegador no está en el
   * medio. Esto es sólo para el Admin, que sí corre en un navegador.
   *
   * ⚠️ El dominio decía `livesell.ar`, heredado de cuando el proyecto se
   * llamaba así. No rompía nada todavía —el APK no pasa por CORS y las páginas
   * de `web/` son estáticas y no llaman a la API— pero es una lista de permitidos
   * apuntando a un dominio que no es nuestro, y habría bloqueado al Admin el
   * día que se despliegue, con un error que en el navegador no dice «CORS».
   */
  app.enableCors({
    origin: isLocalEnv(env.NODE_ENV) ? true : [/\.vendox\.com\.ar$/],
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
      sitio: raizWeb ?? 'no encontrado',
      spikeEnabled: env.SPIKE_ENABLED,
    },
    'API escuchando',
  );
}

void bootstrap();
