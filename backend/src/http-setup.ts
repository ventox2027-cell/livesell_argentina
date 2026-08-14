import multipart from '@fastify/multipart';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { env } from '@/config/env.schema';

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
