import { Controller, Get, Param, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Public } from '@/modules/auth/auth.guard';
import { env } from '@/config/env.schema';
import { DomainError } from '@/shared/errors/domain.error';
import { R2StorageProvider } from '@/shared/storage/r2.provider';

/**
 * Sirve las imágenes de producto sin abrir el bucket.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REDIRECCIÓN, NO PROXY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Este endpoint **no descarga la imagen y la reenvía**. Firma una URL temporal
 * de R2 y responde `302`. El teléfono la sigue y baja los bytes directo de
 * Cloudflare.
 *
 * La diferencia es enorme y es la razón de que esté escrito así:
 *
 *   · **Como proxy**, cada foto de cada producto de cada scroll ocuparía una
 *     conexión del proceso de Node mientras se transfiere. Un feed con veinte
 *     productos son veinte transferencias en paralelo por usuario. El servidor
 *     de aplicación se convierte en un servidor de archivos, que es
 *     exactamente lo que no queremos que sea.
 *   · **Como redirección**, lo que sale de acá son unos cientos de bytes de
 *     cabecera. Los megabytes viajan entre Cloudflare y el teléfono, que es
 *     donde tienen que viajar.
 *
 * ─── Por qué existe, si igual hay una redirección de por medio ───
 *
 * Porque la URL que se guarda en la base tiene que ser estable para siempre.
 * `OrderItem.imageUrlSnapshot` es un registro histórico: lo que el comprador
 * vio cuando compró. Una URL firmada guardada ahí se vence, y el historial de
 * pedidos se llena de imágenes rotas sin que nada lo avise.
 *
 * Con esto, lo persistido nunca caduca y la firma se genera al momento de
 * pedirla.
 *
 * ─── Y cuando haya dominio propio ───
 *
 * Se configura `R2_PUBLIC_BASE_URL` y las URLs nuevas apuntan directo al CDN,
 * sin pasar por acá. Las viejas siguen funcionando por este camino. Ninguna
 * fila de la base necesita migrarse.
 *
 * ─── En desarrollo ───
 *
 * Con `STORAGE_DRIVER=local` las imágenes las sirve `@fastify/static` desde
 * `/media`, registrado en `main.ts`. Este controlador ni se registra, para no
 * competir por la misma ruta.
 */
@Public()
@Controller({ version: VERSION_NEUTRAL })
export class MediaController {
  constructor(private readonly r2: R2StorageProvider) {}

  /**
   * `GET /media/products/prd_01ABC/uuid.webp`
   *
   * El comodín es necesario: las claves llevan barras. Un `:key` simple sólo
   * capturaría hasta la primera.
   */
  @Get('media/*')
  async servir(@Param('*') clave: string, @Res() reply: FastifyReply): Promise<void> {
    if (env.STORAGE_DRIVER !== 'r2') {
      // Con disco local esta ruta la atiende @fastify/static. Llegar acá
      // significa que la configuración cambió a mitad de camino.
      throw new DomainError('NOT_FOUND', 'No encontrado');
    }

    const storageKey = validarClave(clave);
    const firmada = await this.r2.urlFirmada(storageKey);

    /**
     * `302` y no `301`.
     *
     * Un 301 es permanente y los navegadores lo cachean para siempre: se
     * quedarían con la URL firmada de la primera vez y, cuando esa firma
     * venciera, la imagen dejaría de cargar sin forma de arreglarlo del lado
     * del servidor.
     *
     * El `Cache-Control` es más corto que la vida de la firma a propósito: la
     * respuesta que se cachea es la REDIRECCIÓN, y una redirección cacheada
     * más allá del vencimiento de su firma es una imagen rota.
     */
    const cacheSegura = Math.max(30, Math.floor(env.R2_SIGNED_URL_TTL_S / 2));

    await reply
      .status(302)
      .header('Location', firmada)
      .header('Cache-Control', `private, max-age=${cacheSegura}`)
      // La URL firmada es una llave temporal. Que no quede en el Referer de
      // la página siguiente ni en los registros de nadie más.
      .header('Referrer-Policy', 'no-referrer')
      .send();
  }
}

/**
 * Valida la clave antes de firmarla.
 *
 * ─── Qué se está previniendo ───
 *
 * La clave viene de la URL, o sea de quien pida. Sin validar, alguien podría
 * pedir `/media/../../otro-bucket/algo` y conseguir una firma para un objeto
 * que no le corresponde — el equivalente en S3 del salto de directorio.
 *
 * La forma de las claves que genera el backend es conocida y estrecha:
 * `products/<id>/<uuid>.<ext>`. Todo lo que no encaje se rechaza sin firmar
 * nada. No se intenta "limpiar" la entrada: sanear una ruta es un juego que se
 * pierde, y acá alcanza con exigir la forma correcta.
 *
 * El 404 es deliberado. Un mensaje distinto para "clave mal formada" y para
 * "no existe" le confirmaría a quien prueba cuándo acertó la forma.
 */
const CLAVE_VALIDA = /^products\/[A-Za-z0-9_-]{1,64}\/[a-f0-9-]{36}\.(jpg|png|webp)$/;

export function validarClave(clave: string): string {
  const limpia = clave.replace(/^\/+/, '');
  if (!CLAVE_VALIDA.test(limpia)) {
    throw new DomainError('NOT_FOUND', 'No encontrado');
  }
  return limpia;
}
