import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { urlPublicaDe } from './url-publica';
import { StorageMetrics } from '@/shared/storage/storage.metrics';
import {
  StorageProvider,
  StorageUnavailableError,
  type ArchivoGuardado,
} from '@/shared/storage/storage.provider';

/**
 * Cloudflare R2, por la API S3.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL BUCKET ES PRIVADO Y ASÍ SE QUEDA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No hay "Public Development URL" habilitada y no se va a habilitar. Un bucket
 * público es un bucket enumerable: quien tenga la URL base puede listar y
 * descargar todo lo que haya adentro, hoy y en el futuro, incluido lo que
 * alguien suba por error.
 *
 * Entonces, ¿cómo ve una imagen el teléfono?
 *
 * ─── Con dominio propio (el estado final) ───
 *
 * Se configura `R2_PUBLIC_BASE_URL` y las URLs son directas al CDN. Ese
 * dominio todavía no existe, así que hoy este camino está preparado pero
 * apagado.
 *
 * ─── Sin dominio (hoy) ───
 *
 * La URL que se guarda apunta a NUESTRO backend: `/media/<clave>`. Cuando el
 * teléfono la pide, el backend firma una URL temporal de R2 y responde con una
 * redirección. El teléfono la sigue y baja la imagen **directo de Cloudflare**.
 *
 * Tres propiedades que importan:
 *
 *   1. **El bucket sigue cerrado.** Sin firma no se baja nada, y las firmas
 *      duran minutos.
 *   2. **Los bytes no pasan por la API.** Sólo la redirección, que son unos
 *      cientos de bytes. Servir imágenes desde el proceso de Node ocuparía una
 *      conexión del servidor por cada foto de cada producto de cada scroll.
 *   3. **Lo que se persiste no caduca.** Y esto es lo importante de verdad:
 *      `ProductImage.url` y `OrderItem.imageUrlSnapshot` se guardan en la base.
 *      Guardar ahí una URL firmada sería sembrar imágenes rotas a plazo fijo —
 *      el historial de pedidos de un comprador se vaciaría solo a los cinco
 *      minutos. La URL estable resuelve eso sin migración.
 *
 * Cuando aparezca el dominio, `R2_PUBLIC_BASE_URL` hace que las nuevas URLs
 * sean directas, y las viejas siguen funcionando por la redirección.
 */
@Injectable()
export class R2StorageProvider extends StorageProvider implements OnModuleDestroy {
  private readonly logger = new Logger(R2StorageProvider.name);
  private readonly cliente: S3Client;
  private readonly bucket: string;

  constructor(private readonly metrics: StorageMetrics) {
    super();

    // El esquema de configuración ya garantizó que existen cuando el driver es
    // `r2`; los `??` son para el compilador, no una degradación silenciosa.
    this.bucket = env.R2_BUCKET ?? '';

    this.cliente = new S3Client({
      /**
       * R2 no tiene regiones al estilo de AWS, pero el SDK exige una y falla al
       * construirse si no la encuentra. `auto` es lo que documenta Cloudflare.
       */
      region: 'auto',
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
      },
      /**
       * Rutas `endpoint/bucket/clave` en vez de `bucket.endpoint/clave`.
       *
       * R2 no soporta el estilo por subdominio, que es el que el SDK usa por
       * omisión para AWS. Sin esto, todas las peticiones van a un host que no
       * resuelve y el error habla de DNS, no de configuración.
       */
      forcePathStyle: true,
      // Tres intentos ante fallos transitorios. Subir una foto es idempotente
      // —la clave la generamos nosotros y es única—, así que reintentar no
      // puede duplicar nada.
      maxAttempts: 3,
    });
  }

  onModuleDestroy(): void {
    // Cierra los sockets que el SDK mantiene abiertos. Sin esto, el apagado
    // ordenado espera a que venzan solos.
    this.cliente.destroy();
  }

  async guardar(params: {
    buffer: Buffer;
    mimeType: string;
    prefijo: string;
  }): Promise<ArchivoGuardado> {
    const storageKey = this.generarKey(params.prefijo, params.mimeType);

    try {
      await this.cliente.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
          Body: params.buffer,
          /**
           * El tipo REAL, detectado por los bytes del archivo — no el que
           * declaró quien subió.
           *
           * Importa más de lo que parece: R2 devuelve este valor como
           * `Content-Type` al servir el objeto. Un archivo guardado como
           * `text/html` y servido desde nuestro dominio sería XSS almacenado.
           * Acá sólo llegan tres valores posibles, todos `image/*`.
           */
          ContentType: params.mimeType,
          /**
           * Un año de caché. Es seguro porque la clave lleva un UUID: una
           * imagen distinta es una clave distinta, así que nada que se cachee
           * puede quedar desactualizado.
           */
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    } catch (err) {
      this.metrics.subidaFallida();
      this.logger.error({
        msg: 'no se pudo subir la imagen a R2',
        storageKey,
        // El mensaje del SDK, sin el objeto entero: los errores de AWS traen la
        // configuración del cliente adentro, credenciales incluidas.
        error: err instanceof Error ? err.message : 'error desconocido',
      });
      throw new StorageUnavailableError();
    }

    this.metrics.subida(params.buffer.length);

    return {
      storageKey,
      url: this.urlPublica(storageKey),
      mimeType: params.mimeType,
      sizeBytes: params.buffer.length,
    };
  }

  /**
   * Borra el objeto.
   *
   * ─── Por qué esto NO lanza ───
   *
   * Lo llama `ImagesService` DESPUÉS de cometer la transacción que borró la
   * fila. Para ese momento la imagen ya no existe para nadie: no está en la
   * app, no está en el feed, no está en el panel del vendedor.
   *
   * Si además fallara la petición a Cloudflare y eso propagara un error, el
   * vendedor vería "no se pudo borrar la imagen" cuando en realidad SÍ se
   * borró. Volvería a intentarlo, no encontraría la imagen, y no entendería
   * nada.
   *
   * Lo que queda es un objeto huérfano ocupando lugar. Cuesta storage, no
   * corrección — y no queda en silencio: se registra con nivel error y se
   * cuenta en `storage_delete_failed_total`, que es lo que permite montar una
   * alerta y limpiarlos.
   */
  async borrar(storageKey: string): Promise<void> {
    try {
      await this.cliente.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
      this.metrics.borrado();
    } catch (err) {
      this.metrics.borradoFallido();
      this.logger.error({
        msg: '⚠️ objeto huérfano en R2: la fila se borró pero el archivo no',
        storageKey,
        error: err instanceof Error ? err.message : 'error desconocido',
      });
    }
  }

  /**
   * La URL con la que se muestra el objeto. Se calcula, no se guarda.
   *
   * Con dominio configurado va directa al CDN; sin él, a nuestra redirección.
   *
   * ⚠️ Decía «la URL que se guarda en la base, estable, no caduca». Era falso
   * en cuanto cambia el host: fotos subidas contra un túnel de desarrollo
   * quedaron apuntando a un dominio muerto y las tarjetas salían en gris. La
   * lógica ahora vive en `url-publica.ts` y las respuestas la derivan del
   * `storageKey` al leer. Ver el comentario de ese archivo.
   */
  urlPublica(storageKey: string): string {
    return urlPublicaDe(storageKey);
  }

  /**
   * URL firmada, temporal. La genera la redirección de `/media`.
   *
   * No se persiste en ningún lado ni se devuelve en ninguna respuesta JSON:
   * vive lo que dura un `302`.
   */
  /**
   * Lee un objeto pequeño como texto.
   *
   * ⚠️ Para archivos CHICOS y nuestros. Trae el contenido entero a memoria, así
   * que no sirve para las imágenes ni para el APK — esos se entregan con
   * `urlFirmada` y una redirección, sin pasar por este proceso.
   *
   * Existe para un caso concreto: la ficha del último release
   * (`releases/android/latest.json`, unos 200 bytes). Servirla desde acá evita
   * abrir el bucket y evita poner una URL firmada dentro del HTML, que
   * vencería antes de que alguien termine de leer la página.
   */
  async leerTexto(storageKey: string): Promise<string> {
    try {
      const salida = await this.cliente.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
      return (await salida.Body?.transformToString()) ?? '';
    } catch (err) {
      /**
       * Se registra como aviso y no como error.
       *
       * Que el archivo no esté es un estado NORMAL: pasa entre que se crea el
       * bucket y se publica el primer release. Marcarlo como error llenaría de
       * ruido rojo un tablero por algo que todavía no ocurrió.
       */
      this.logger.warn({
        msg: 'no se pudo leer el objeto',
        storageKey,
        error: err instanceof Error ? err.message : 'error desconocido',
      });
      throw new StorageUnavailableError();
    }
  }

  async urlFirmada(storageKey: string): Promise<string> {
    try {
      return await getSignedUrl(
        this.cliente,
        new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
        { expiresIn: env.R2_SIGNED_URL_TTL_S },
      );
    } catch (err) {
      this.logger.error({
        msg: 'no se pudo firmar la URL',
        storageKey,
        error: err instanceof Error ? err.message : 'error desconocido',
      });
      throw new StorageUnavailableError();
    }
  }
}
