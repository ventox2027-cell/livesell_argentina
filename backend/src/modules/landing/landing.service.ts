import { Injectable } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { PRODUCTO_COMPRABLE } from '@/modules/commerce/visibilidad';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { portadaDe } from '@/shared/storage/url-publica';

import { paginaDeLanding, paginaNoEncontrada } from './pagina';

/**
 * Los datos que van en una página compartida.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SÓLO LO QUE YA ES PÚBLICO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Estas páginas no piden sesión: cualquiera con el enlace las ve, y el enlace
 * está pensado para circular. Así que la regla es estricta — se muestra lo
 * mismo que muestra el feed a alguien que no se registró, y nada más.
 *
 * ⛔ En concreto: **no** se muestra el stock exacto, **no** el volumen de
 * ventas, **no** los datos del vendedor más allá de su nombre público. Un
 * enlace compartido no puede ser una forma de sacar información que la app no
 * da.
 *
 * Y se reutiliza `PRODUCTO_COMPRABLE`, el mismo filtro del feed. Un producto
 * despublicado, borrado u oculto por moderación no aparece acá tampoco: si la
 * página tuviera su propio criterio, una sanción se podría esquivar
 * compartiendo el enlace.
 */
@Injectable()
export class LandingService {
  constructor(private readonly prisma: PrismaService) {}

  private url(ruta: string): string {
    return `${env.PUBLIC_WEB_URL.replace(/\/+$/, '')}${ruta}`;
  }

  /** Pesos argentinos, como los escribe la gente. */
  private plata(centavos: number): string {
    return `$ ${(centavos / 100).toLocaleString('es-AR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  }

  async deProducto(id: string): Promise<{ html: string; encontrado: boolean }> {
    const url = this.url(`/p/${id}`);

    const producto = await this.prisma.product.findFirst({
      where: { id, ...PRODUCTO_COMPRABLE },
      select: {
        id: true,
        name: true,
        description: true,
        basePriceCents: true,
        images: { where: { position: 0 }, take: 1, select: { storageKey: true } },
        store: {
          select: {
            name: true,
            seller: { select: { displayName: true } },
          },
        },
        variants: {
          where: { deletedAt: null, status: 'ACTIVE' },
          select: { inventory: { select: { onHand: true, reserved: true } } },
        },
      },
    });

    if (!producto) return { html: paginaNoEncontrada(url), encontrado: false };

    /**
     * Hay stock o no hay. **El número exacto no.**
     *
     * Es la misma regla que el feed: publicar el stock de cada variante le
     * regala a la competencia el ritmo de ventas de un vendedor, y en una
     * página pública sin sesión sería todavía más fácil de raspar.
     */
    const hayStock = producto.variants.some(
      (v) => (v.inventory?.onHand ?? 0) - (v.inventory?.reserved ?? 0) > 0,
    );

    return {
      encontrado: true,
      html: paginaDeLanding({
        titulo: producto.name,
        descripcion:
          producto.description?.trim() ||
          `${producto.name}, de ${producto.store.seller.displayName}. Comprá en vivo por VendoX.`,
        imagen: portadaDe(producto.images),
        url,
        rutaEnLaApp: `/producto/${producto.id}`,
        precio: this.plata(producto.basePriceCents),
        tienda: producto.store.name,
        estado: hayStock
          ? { texto: 'Disponible', tono: 'exito' }
          : { texto: 'Sin stock', tono: 'neutro' },
      }),
    };
  }

  async deVivo(id: string): Promise<{ html: string; encontrado: boolean }> {
    const url = this.url(`/v/${id}`);

    const vivo = await this.prisma.liveSession.findFirst({
      where: {
        id,
        // Un vivo terminado hace tres meses no tiene página. El enlace sigue
        // siendo válido, pero muestra «ya no está disponible».
        state: { in: ['SCHEDULED', 'STARTING', 'LIVE', 'RECONNECTING'] },
        seller: { status: 'ACTIVE' },
      },
      select: {
        id: true,
        title: true,
        coverUrl: true,
        state: true,
        scheduledFor: true,
        seller: { select: { displayName: true } },
      },
    });

    if (!vivo) return { html: paginaNoEncontrada(url), encontrado: false };

    const alAire = vivo.state === 'LIVE' || vivo.state === 'RECONNECTING';

    return {
      encontrado: true,
      html: paginaDeLanding({
        titulo: vivo.title,
        descripcion: alAire
          ? `${vivo.seller.displayName} está transmitiendo ahora en VendoX. Entrá y comprá mientras lo ves.`
          : `${vivo.seller.displayName} va a transmitir en VendoX. Entrá para que te avisemos cuando empiece.`,
        imagen: vivo.coverUrl,
        url,
        rutaEnLaApp: `/live/${vivo.id}`,
        tienda: vivo.seller.displayName,
        estado: alAire
          ? { texto: 'EN VIVO AHORA', tono: 'vivo' }
          : { texto: 'Próximamente', tono: 'neutro' },
      }),
    };
  }

  async deTienda(slug: string): Promise<{ html: string; encontrado: boolean }> {
    const url = this.url(`/t/${slug}`);

    const tienda = await this.prisma.store.findFirst({
      where: { slug, status: 'ACTIVE', seller: { status: 'ACTIVE' } },
      select: {
        name: true,
        slug: true,
        description: true,
        coverUrl: true,
        logoUrl: true,
        seller: { select: { displayName: true } },
      },
    });

    if (!tienda) return { html: paginaNoEncontrada(url), encontrado: false };

    return {
      encontrado: true,
      html: paginaDeLanding({
        titulo: tienda.name,
        descripcion:
          tienda.description?.trim() ||
          `Mirá lo que vende ${tienda.name} en VendoX. Comprá mientras lo estás viendo.`,
        imagen: tienda.coverUrl ?? tienda.logoUrl,
        url,
        rutaEnLaApp: `/tienda/${tienda.slug}`,
      }),
    };
  }

  async deVendedor(slug: string): Promise<{ html: string; encontrado: boolean }> {
    const url = this.url(`/u/${slug}`);

    const vendedor = await this.prisma.seller.findFirst({
      where: { slug, status: 'ACTIVE' },
      select: {
        displayName: true,
        slug: true,
        bio: true,
        avatarUrl: true,
        coverUrl: true,
      },
    });

    if (!vendedor) return { html: paginaNoEncontrada(url), encontrado: false };

    return {
      encontrado: true,
      html: paginaDeLanding({
        titulo: vendedor.displayName,
        descripcion:
          vendedor.bio?.trim() ||
          `Mirá lo que vende ${vendedor.displayName} en VendoX. Comprá mientras lo estás viendo.`,
        imagen: vendedor.coverUrl ?? vendedor.avatarUrl,
        url,
        rutaEnLaApp: `/vendedor/${vendedor.slug}`,
      }),
    };
  }

  /**
   * El archivo que Android lee para permitir que la app abra nuestros enlaces.
   *
   * ⛔ Devuelve una lista VACÍA hasta que exista la clave de firma.
   *
   * La huella SHA-256 que va acá es la de la clave con la que se firma la APK,
   * y esa clave todavía no se generó — es una decisión irreversible que necesita
   * a una persona presente. Ver `docs/MIGRACION-PACKAGE.md`.
   *
   * Mientras esté vacío, tocar un enlace de VendoX abre el navegador y se ve la
   * página de esta misma carpeta. Eso funciona: no está roto, está incompleto.
   *
   * ⚠️ Devolver una huella inventada sería peor que no devolver nada: Android
   * la compara con la real y falla en silencio, y quien depure eso va a mirar
   * el manifiesto y la configuración de la app durante horas antes de sospechar
   * de un archivo JSON.
   *
   * Cuando exista la clave, va acá:
   *
   *     [{ "relation": ["delegate_permission/common.handle_all_urls"],
   *        "target": { "namespace": "android_app",
   *                    "package_name": "com.vendox.app",
   *                    "sha256_cert_fingerprints": ["…"] } }]
   *
   * Y hacen falta DOS huellas: la de la clave de subida y la de la clave de
   * firma que genera Google Play. Con una sola, los enlaces abren la app en el
   * teléfono de quien compiló y no en el de nadie más.
   */
  assetLinks(): unknown[] {
    const huellas = (env.ANDROID_CERT_SHA256 ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);

    if (huellas.length === 0) return [];

    return [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.vendox.app',
          sha256_cert_fingerprints: huellas,
        },
      },
    ];
  }
}
