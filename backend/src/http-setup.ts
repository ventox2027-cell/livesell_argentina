import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RequestMethod, VersioningType } from '@nestjs/common';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';

import { env } from '@/config/env.schema';
import { paginasDelSitio, raizDelSitio } from '@/config/sitio-publico';
import {
  RUTA_OAUTH_MERCADOPAGO,
  RUTA_WEBHOOK_LIVEKIT,
  RUTA_WEBHOOK_MERCADOPAGO,
  RUTA_WEBHOOK_SPIKE,
} from '@/shared/http/rutas-webhook';

/**
 * Configuración del servidor HTTP, en un solo lugar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE ARCHIVO EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Los tests no ejecutan `main.ts`: arman la aplicación con
 * `Test.createTestingModule`. Cada vez que algo se registraba sólo en
 * `main.ts`, **la suite terminaba probando un servidor distinto del que corre
 * en producción**.
 *
 * Ya pasó dos veces:
 *
 *   · `@fastify/multipart` no estaba en el arranque de los tests, así que toda
 *     la subida de imágenes devolvía 415 y nadie lo notaba. No había ni un
 *     test de imágenes porque cualquiera habría fallado.
 *   · El parser de JSON rechazaba los DELETE sin cuerpo. Los tests usan
 *     `inject()`, que sólo manda `content-type` cuando hay cuerpo, así que
 *     jamás reprodujeron lo que hace la app de verdad. Los cuatro DELETE
 *     estaban rotos en producción con la suite entera en verde.
 *
 * La conclusión no es "acordarse de copiar": es que no haya dos lugares. Todo
 * lo que cambie el comportamiento del servidor va acá, y tanto `main.ts` como
 * los tests lo llaman.
 */

/**
 * El adaptador de Fastify, ya construido y configurado.
 *
 * ─── Por qué las OPCIONES también viven acá ───
 *
 * Estaban en `main.ts`, y el helper de tests hacía `new FastifyAdapter()` a
 * secas. O sea: la tercera repetición del mismo error que este archivo existe
 * para no volver a cometer, y la más silenciosa de las tres, porque `trustProxy`
 * no rompe nada — cambia de dónde sale `request.ip`.
 *
 * El efecto concreto: cualquier test sobre el límite de peticiones por IP
 * pasaba en un servidor donde `X-Forwarded-For` no se lee, mientras en
 * producción sí se leía. Un test verde sobre exactamente lo contrario de lo que
 * corre.
 */
export function crearAdaptador(): FastifyAdapter {
  const adapter = new FastifyAdapter({
    /**
     * ⚠️ El NÚMERO de proxies nuestros. Nunca `true`.
     *
     * Con `true`, Fastify toma la entrada más a la izquierda de
     * `X-Forwarded-For`, que la escribe quien llama. Mandando
     * `X-Forwarded-For: 1.2.3.4` cualquiera elegía su propia IP, y el límite de
     * peticiones de los endpoints de autenticación —los únicos que se limitan
     * por IP, porque todavía no hay usuario— dejaba de existir.
     *
     * Con un número, Fastify cuenta saltos desde la derecha y se queda con la
     * entrada que escribió nuestro proxy. Ver `shared/http/client-ip.ts`.
     */
    trustProxy: env.TRUSTED_PROXY_HOPS,
    bodyLimit: 2 * 1024 * 1024,
    // Fastify genera su propio requestId; el logger lo sustituye por el
    // x-request-id entrante si viene de la app.
    genReqId: () => crypto.randomUUID(),
  });

  configurarAdaptador(adapter);
  return adapter;
}

/**
 * Se aplica ANTES de `NestFactory.create`, sobre la instancia de Fastify.
 *
 * Va antes porque los parsers de tipo de contenido y los hooks de `onRequest`
 * tienen que existir cuando llegue la primera petición.
 */
export function configurarAdaptador(adapter: FastifyAdapter): void {
  /**
   * Una petición sin cuerpo no tiene tipo de contenido que declarar.
   *
   * ─── El problema real que esto resuelve ───
   *
   * Muchos clientes HTTP —Dio entre ellos— dejan `content-type` puesto como
   * cabecera por defecto de TODAS sus peticiones. Un DELETE sale entonces
   * anunciando `application/json` y mandando cero bytes, y Fastify contesta:
   *
   *     400 · Body cannot be empty when content-type is set to
   *           'application/json'
   *
   * Técnicamente Fastify tiene razón. Prácticamente, eso rompió de golpe los
   * cuatro DELETE de la aplicación —cancelar una reserva, borrar un producto,
   * borrar una foto, eliminar la cuenta— por una cabecera que no describía
   * nada.
   *
   * Se arregló también en el cliente, que es donde nace. Esto queda igual
   * porque el servidor no puede depender de que todos los clientes que existan
   * de acá en adelante se porten bien.
   *
   * `transfer-encoding` se comprueba para no tocar los cuerpos por fragmentos,
   * que llegan legítimamente sin `content-length`.
   */
  adapter.getInstance().addHook('onRequest', (req, _reply, done) => {
    const largo = req.headers['content-length'];
    const sinCuerpo = (largo === undefined || largo === '0') && !req.headers['transfer-encoding'];
    if (sinCuerpo && req.headers['content-type']) {
      delete req.headers['content-type'];
    }
    done();
  });

  /**
   * LiveKit envía sus webhooks con `application/webhook+json`.
   *
   * Fastify no conoce ese tipo y devolvería 415. Además se conserva el cuerpo
   * CRUDO: la firma se calcula sobre los bytes exactos, y un JSON.parse +
   * JSON.stringify de por medio la invalidaría.
   *
   * Para `application/json` NO se registra nada: lo hace Nest con la opción
   * `rawBody: true`. Registrarlo a mano choca con el suyo.
   */
  adapter
    .getInstance()
    .addContentTypeParser(
      'application/webhook+json',
      { parseAs: 'string' },
      (req, body: string, done) => {
        (req as typeof req & { rawBody: Buffer }).rawBody = Buffer.from(body, 'utf8');
        try {
          done(null, JSON.parse(body));
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );
}

/**
 * Prefijo global y versionado.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTA FUNCIÓN EXISTE POR LA CUARTA REPETICIÓN DEL MISMO ERROR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Las tres primeras están contadas arriba. La cuarta fue ésta, y fue peor
 * porque el archivo que la evita ya existía:
 *
 * `main.ts` enumeraba las exclusiones una por una; el helper de tests usaba el
 * comodín `'webhooks/(.*)'`. O sea: **en los tests TODOS los webhooks quedaban
 * fuera del prefijo, y en producción sólo los dos enumerados.**
 *
 * El resultado concreto: `orders-flow.spec.ts` probaba
 * `POST /webhooks/orders/mercadopago` y pasaba en verde, mientras el servidor
 * real servía esa ruta en `/api/webhooks/orders/mercadopago`. La URL que
 * habríamos cargado en el panel de Mercado Pago era la probada, y habría
 * devuelto 404 en cada notificación — con la suite entera en verde y sin un
 * solo pago acreditado.
 *
 * Por eso la lista es una sola, vive acá, y la llaman los dos.
 *
 * ─── Qué queda fuera, y por qué ───
 *
 *   · health/ready/metrics — los consumen el balanceador y Prometheus, que no
 *     negocian versiones. Su URL no puede cambiar nunca.
 *   · webhooks — la URL se carga a mano en el panel del proveedor. Si mañana
 *     saliera /api/v2/, nadie va a ir a actualizarla.
 *   · media — las URLs se PERSISTEN en la base, incluidos los snapshots
 *     históricos de pedidos. Esas filas seguirían apuntando acá.
 *   · checkout — la carga un WebView desde una URL que arma la app.
 *
 * Excluir del prefijo NO excluye del versionado: los controladores llevan
 * además `VERSION_NEUTRAL`. Sin eso, `/health` respondería en `/v1/health`.
 */
export function configurarPrefijoYVersionado(app: NestFastifyApplication): void {
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'ready', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
      { path: RUTA_WEBHOOK_LIVEKIT, method: RequestMethod.POST },
      { path: RUTA_WEBHOOK_MERCADOPAGO, method: RequestMethod.POST },
      { path: RUTA_WEBHOOK_SPIKE, method: RequestMethod.POST },
      // El callback del OAuth: lo abre el navegador del vendedor siguiendo
      // una redirección de Mercado Pago, y la URL está cargada a mano en su
      // panel.
      { path: `${RUTA_OAUTH_MERCADOPAGO}/callback`, method: RequestMethod.GET },
      { path: 'media/*', method: RequestMethod.GET },
      { path: 'checkout', method: RequestMethod.GET },
      /**
       * Las páginas de los enlaces compartidos.
       *
       * Las abre un navegador siguiendo un enlace pegado en un chat, no la
       * app. El formato corto lo genera `social/compartir.ts` desde hace meses
       * y hay enlaces dando vueltas con él: no se puede cambiar.
       */
      { path: 'p/:id', method: RequestMethod.GET },
      { path: 'v/:id', method: RequestMethod.GET },
      { path: 't/:slug', method: RequestMethod.GET },
      { path: 'u/:slug', method: RequestMethod.GET },
      { path: '.well-known/assetlinks.json', method: RequestMethod.GET },
      /**
       * La descarga del APK y su ficha.
       *
       * Van sin prefijo porque son URLs para pegar en un mensaje o poner en un
       * botón: `vendox.com.ar/descargar/android` se lee y se dicta;
       * `vendox.com.ar/api/v1/descargar/android` no.
       *
       * Y sobre todo, tiene que poder no cambiar nunca. Una URL de descarga que
       * lleva la versión de la API adentro queda atada a que esa versión exista
       * para siempre.
       */
      { path: 'descargar/android', method: RequestMethod.GET },
      { path: 'descargar/android.json', method: RequestMethod.GET },
    ],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}

/**
 * Se aplica DESPUÉS de crear la aplicación.
 *
 * El límite de tamaño se aplica acá, antes de que el archivo llegue al
 * controlador. Validarlo después obligaría a alojar en memoria lo que se va a
 * rechazar: alguien manda 500 MB y el servidor los recibe enteros para
 * decirle que no.
 *
 * `files: 1` porque cada petición sube una sola imagen. Permitir varias
 * abriría la puerta a mandar diez de 10 MB en un solo pedido.
 */
export async function registrarMultipart(app: NestFastifyApplication): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
      fields: 10,
      // Sin este tope, un nombre de campo de 1 MB es un vector de agotamiento
      // de memoria antes de que nada lo valide.
      fieldSize: 4 * 1024,
    },
  });
}

/**
 * Monta el sitio público de `vendox.com.ar`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SE SIRVE DESDE LA API, Y NO DESDE UN HOSTING APARTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `vendox.com.ar` y `api.vendox.com.ar` apuntan al mismo servicio. Parece
 * mezclar dos cosas, y es al revés: separarlas obligaría a mantener un proxy,
 * porque hay rutas del dominio público que **sólo** puede contestar el backend.
 *
 *   · `/.well-known/assetlinks.json` — las huellas salen de la configuración
 *     del entorno, no de un archivo del repositorio.
 *   · `/p/:id`, `/v/:id`, `/t/:slug`, `/u/:slug` — la previsualización de
 *     WhatsApp la arma un robot que no ejecuta JavaScript: las etiquetas `og:`
 *     tienen que venir escritas en el HTML que responde el servidor.
 *   · `/descargar/android` — la descarga del APK es una redirección firmada a
 *     R2. El bucket es privado y tiene que seguir siéndolo.
 *
 * Con un hosting estático aparte, esas rutas necesitan reglas de proxy que hay
 * que mantener sincronizadas a mano con el código. Con un solo origen, no
 * existe la pregunta de quién sirve qué.
 *
 * El costo es que el proceso de la API entrega cuatro archivos HTML. Son 40 kB
 * y se cachean; el proceso ya venía sirviendo HTML en `/p/:id`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO ESTÁ ACÁ Y NO EN `main.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque estaba en `main.ts` y por eso ningún test lo vio.
 *
 * Es la quinta vez que pasa lo mismo —ver la lista en `test/helpers/app.ts`— y
 * esta vez el resultado fue que `https://api.vendox.com.ar/eliminar-cuenta`
 * devolvía **404** mientras `/eliminar-cuenta/index.html` devolvía 200. Los
 * tests del sitio leían los archivos del disco y confirmaban que estaban ahí,
 * que es cierto y no era la pregunta.
 *
 * Es una URL que Google Play abre para revisar la app.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE LE FALTA AL PLUGIN, Y POR QUÉ NO SE ARREGLA CON EL COMODÍN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Con `wildcard: false`, `@fastify/static` registra una ruta por archivo real.
 * Para `web/privacidad/index.html` eso da `/privacidad/index.html` y, por la
 * opción `index`, también `/privacidad/`. La forma **sin** barra final no queda
 * registrada por nadie, y es la que la gente escribe.
 *
 * ─── Lo que se midió antes de elegir el arreglo ───
 *
 * El comentario que había acá decía que encender el comodín rompería `/p/:id`,
 * `/v/:id`, `/t/:slug` y `/u/:slug`. Se probó con las versiones instaladas
 * —Fastify 5, `@fastify/static` 10— y no es cierto: el enrutador prefiere una
 * ruta con parámetro antes que el comodín, sin importar el orden de registro, y
 * lo que no existe sigue cayendo en el manejador de 404 de la aplicación.
 *
 * O sea que `wildcard: true` también habría arreglado esto. Se dejó en `false`
 * igual, por dos razones: es lo que se pidió conservar, y una ruta explícita es
 * una garantía nuestra en vez de un detalle de resolución de un plugin que
 * puede cambiar en la próxima versión menor.
 *
 * Sin redirección: un 301 a la barra final funcionaría, pero cuesta un viaje de
 * ida y vuelta más en un teléfono con mala señal para no ganar nada.
 */
export async function registrarSitioPublico(
  fastify: FastifyInstance,
): Promise<string | null> {
  const raiz = raizDelSitio();
  if (!raiz) return null;

  await fastify.register(fastifyStatic, {
    root: raiz,
    prefix: '/',
    // `/privacidad/` tiene que servir `/privacidad/index.html`.
    index: ['index.html'],
    /**
     * ⚠️ No se decora `reply.sendFile`.
     *
     * Con `STORAGE_DRIVER=local` ya lo decoró el registro de `/media/`, y sólo
     * uno puede. Pero en producción ese registro NO ocurre, así que
     * `reply.sendFile` no existiría — y un handler que lo use andaría en
     * desarrollo y explotaría en Railway. Por eso las páginas de abajo leen el
     * archivo y lo mandan, sin depender de la decoración.
     */
    decorateReply: false,
    list: false,
    wildcard: false,
    // Un año para lo que lleva huella en el nombre; el HTML se revalida.
    maxAge: '10m',
  });

  for (const pagina of paginasDelSitio(raiz)) {
    const archivo = join(raiz, pagina, 'index.html');

    fastify.get(pagina, async (_peticion, respuesta) => {
      const html = await readFile(archivo, 'utf8');
      return respuesta
        .type('text/html; charset=utf-8')
        .header('cache-control', 'public, max-age=600')
        .send(html);
    });
  }

  return raiz;
}
