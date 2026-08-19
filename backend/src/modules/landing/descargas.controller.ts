import { Controller, Get, Header, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { env } from '@/config/env.schema';
import { Public } from '@/modules/auth/auth.guard';
import { DomainError } from '@/shared/errors/domain.error';
import { R2StorageProvider } from '@/shared/storage/r2.provider';

/**
 * La descarga del APK, desde una URL que no cambia nunca.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ NO SE PUBLICA EL BUCKET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `vendox-media` guarda las fotos de todos los productos, y varias son de
 * borradores que sus vendedores todavía no publicaron. Abrirlo entero para
 * poder repartir un APK sería regalar el catálogo completo de la plataforma
 * —incluido lo que nadie decidió mostrar— a cambio de una comodidad.
 *
 * Así que el bucket sigue privado y la descarga sale por acá: se pide una URL
 * firmada, temporal, y se redirige. Es exactamente lo que ya hace `/media/*`
 * con las imágenes; esto no inventa un mecanismo nuevo, usa el que hay.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Y POR QUÉ NO SE USA EL ARTEFACTO DE GITHUB
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Los artefactos de Actions vencen a los catorce días y viven detrás de una
 * URL que cambia en cada corrida. Un botón «Descargar» que apunta ahí funciona
 * dos semanas y después devuelve 404 — y el que lo toca no tiene forma de
 * saber que el problema es nuestro.
 */
@Public()
@Controller({ path: 'descargar', version: VERSION_NEUTRAL })
export class DescargasController {
  constructor(private readonly r2: R2StorageProvider) {}

  /** Dónde vive el APK más reciente. Lo escribe el workflow de release. */
  private static readonly CLAVE_ULTIMO = 'releases/android/vendox-latest.apk';

  /** Y su ficha: versión, commit, fecha y tamaño. */
  private static readonly CLAVE_METADATA = 'releases/android/latest.json';

  /**
   * El botón «Descargar VendoX para Android».
   *
   * `/descargar/android` es la URL que va en la web, en los mensajes y en
   * cualquier lado. No lleva versión a propósito: una URL con la versión
   * adentro obliga a editar la página en cada release, y tarde o temprano
   * alguien se olvida y el botón reparte una versión vieja.
   */
  @Get('android')
  async android(@Res() reply: FastifyReply): Promise<void> {
    const firmada = await this.urlFirmadaDe(DescargasController.CLAVE_ULTIMO);

    /**
     * `302`, igual que las imágenes.
     *
     * Con un `301` el navegador se queda con la URL firmada de la primera vez
     * y, cuando esa firma vence, la descarga rompe sin que se pueda arreglar
     * desde el servidor. Y peor: un `301` cacheado seguiría entregando la
     * versión de hace tres releases.
     */
    await reply
      .status(302)
      .header('Location', firmada)
      // Corto a propósito: lo que se cachea es la REDIRECCIÓN, y una
      // redirección que sobreviva a su firma es una descarga rota.
      .header('Cache-Control', 'public, max-age=60')
      // La URL firmada es una llave temporal. Que no viaje en el Referer.
      .header('Referrer-Policy', 'no-referrer')
      .send();
  }

  /**
   * Qué versión hay disponible.
   *
   * La lee la página de descarga para poder decir «versión 0.1.0 · 47 MB» sin
   * que nadie edite el HTML. Se sirve desde acá y no directo desde R2 para no
   * tener que abrir el bucket ni exponer una URL firmada en el HTML —que
   * vencería antes de que alguien termine de leer la página—.
   */
  @Get('android.json')
  @Header('content-type', 'application/json; charset=utf-8')
  @Header('cache-control', 'public, max-age=300')
  async metadata(): Promise<unknown> {
    const crudo = await this.r2.leerTexto(DescargasController.CLAVE_METADATA).catch(() => null);

    /**
     * Sin metadata no se rompe la página: se devuelve `disponible: false`.
     *
     * Pasa entre que se crea el bucket y se publica el primer release, y
     * también si alguien borra el archivo. La página tiene que poder decir
     * «todavía no hay versión publicada» en vez de mostrar un error, porque lo
     * segundo parece que la app no existe.
     */
    if (!crudo) return { disponible: false };

    try {
      const ficha = JSON.parse(crudo) as Record<string, unknown>;
      return { disponible: true, ...ficha };
    } catch {
      // Un JSON roto es un problema nuestro, no de quien entra a la página.
      return { disponible: false };
    }
  }

  private async urlFirmadaDe(clave: string): Promise<string> {
    if (env.STORAGE_DRIVER !== 'r2') {
      /**
       * En local no hay APK publicado y no tiene sentido inventarlo.
       *
       * El mensaje dice qué falta en vez de devolver un 404 pelado: quien esté
       * levantando el proyecto por primera vez tiene que poder distinguir «esto
       * no está configurado» de «esto está roto».
       */
      throw new DomainError(
        'NOT_FOUND',
        'Las descargas salen de R2 y este entorno usa disco local.',
      );
    }
    return this.r2.urlFirmada(clave);
  }
}
