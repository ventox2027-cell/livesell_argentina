import { Controller, Get, Header, Param, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Public } from '@/modules/auth/auth.guard';
import { RateLimit } from '@/shared/http/rate-limit.guard';

import { LandingService } from './landing.service';

/**
 * Las páginas que ve alguien que abre un enlace compartido.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ANTES ESTOS ENLACES DABAN 404
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `compartir.ts` viene generando `vendox.com.ar/p/…` desde hace meses, y su
 * propio comentario avisaba que la página no existía. Cada producto compartido
 * por WhatsApp llevaba a una pantalla de error — y compartir es justamente cómo
 * llega gente que todavía no tiene la app.
 *
 * ─── Las rutas son cortas a propósito ───
 *
 * `/p/`, `/v/`, `/t/`, `/u/`. Un enlace se pega en un chat y se lee: cuanto más
 * corto, menos ocupa y menos se corta. El formato ya estaba definido en
 * `compartir.ts` y **no se toca**: hay enlaces dando vueltas con ese formato.
 *
 * ─── Fuera del prefijo `/api` ───
 *
 * Estas URLs las abre un navegador, no la app. Ver la lista de exclusiones en
 * `http-setup.ts`.
 */
@Public()
@Controller({ path: '', version: VERSION_NEUTRAL })
export class LandingController {
  constructor(private readonly landing: LandingService) {}

  /**
   * Un producto.
   *
   * ⚠️ El límite es alto y por IP: un enlace que se vuelve popular genera
   * cientos de visitas legítimas en minutos, y frenarlas sería frenar
   * exactamente lo que queremos que pase.
   */
  @RateLimit({ limit: 300, windowSec: 60, bucket: 'landing' })
  @Get('p/:id')
  async producto(@Param('id') id: string, @Res() res: FastifyReply) {
    return this.responder(res, await this.landing.deProducto(id));
  }

  /** Un vivo. */
  @RateLimit({ limit: 300, windowSec: 60, bucket: 'landing' })
  @Get('v/:id')
  async vivo(@Param('id') id: string, @Res() res: FastifyReply) {
    return this.responder(res, await this.landing.deVivo(id));
  }

  /** Una tienda, por slug. */
  @RateLimit({ limit: 300, windowSec: 60, bucket: 'landing' })
  @Get('t/:slug')
  async tienda(@Param('slug') slug: string, @Res() res: FastifyReply) {
    return this.responder(res, await this.landing.deTienda(slug));
  }

  /** Un vendedor, por slug. */
  @RateLimit({ limit: 300, windowSec: 60, bucket: 'landing' })
  @Get('u/:slug')
  async vendedor(@Param('slug') slug: string, @Res() res: FastifyReply) {
    return this.responder(res, await this.landing.deVendedor(slug));
  }

  /**
   * Manda el HTML.
   *
   * ⚠️ El caché es corto —cinco minutos— y por un motivo concreto.
   *
   * Sin caché, cada previsualización de WhatsApp golpea la base: un enlace que
   * circula en un grupo de doscientas personas son doscientas consultas en un
   * minuto. Con caché largo, un producto que cambia de precio sigue
   * mostrándose con el viejo en cada chat donde se compartió.
   *
   * Cinco minutos es lo que tarda un enlace en repartirse por un grupo, y es
   * poco como para que un precio viejo importe.
   */
  private responder(res: FastifyReply, resultado: { html: string; encontrado: boolean }) {
    return res
      .status(resultado.encontrado ? 200 : 404)
      .header('content-type', 'text/html; charset=utf-8')
      .header(
        'cache-control',
        resultado.encontrado ? 'public, max-age=300' : 'public, max-age=60',
      )
      /**
       * ⛔ Sin indexar.
       *
       * Estas páginas existen para que un enlace compartido se abra, no para
       * posicionar en Google. Dejarlas indexar llenaría el buscador de
       * productos agotados y vivos terminados con el nombre de VendoX al lado.
       *
       * El día que haya un catálogo web pensado para eso, se decide aparte.
       */
      .header('x-robots-tag', 'noindex, nofollow')
      .send(resultado.html);
  }

  /**
   * Endpoint de un solo propósito: que Android acepte abrir la app.
   *
   * ⚠️ Sin este archivo, tocar `vendox.com.ar/p/…` abre el navegador aunque la
   * app esté instalada. Android lo pide en esta ruta exacta y con este
   * `content-type`; no hay alternativa ni negociación.
   *
   * ⛔ La huella SHA-256 **no está**: es la de la clave de firma, que todavía
   * no existe. Hasta que se genere, este archivo devuelve una lista vacía y
   * los enlaces siguen abriendo el navegador — que es el comportamiento
   * correcto mientras tanto, y no uno roto.
   *
   * Ver `docs/MIGRACION-PACKAGE.md`.
   */
  @Get('.well-known/assetlinks.json')
  @Header('content-type', 'application/json')
  @Header('cache-control', 'public, max-age=3600')
  assetLinks() {
    return this.landing.assetLinks();
  }
}
