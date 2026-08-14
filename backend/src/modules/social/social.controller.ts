import { Controller, Get, Param, Post, Query } from '@nestjs/common';

import { CurrentUser, Public, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { DomainError } from '@/shared/errors/domain.error';
import { RateLimit } from '@/shared/http/rate-limit.guard';

import type { CosaCompartible, OrigenDeCompartido } from './compartir';
import { SocialService } from './social.service';

const COSAS: readonly CosaCompartible[] = ['live', 'product', 'store', 'seller'];
const ORIGENES: readonly OrigenDeCompartido[] = ['app', 'live', 'perfil', 'producto'];

/**
 * "Me gusta" y compartir.
 *
 * ─── Un solo endpoint para el corazón ───
 *
 * `POST` que alterna, no `POST` y `DELETE`. Con dos, la app tiene que saber el
 * estado actual para elegir cuál llamar, y si el estado que tenía era viejo el
 * resultado es al revés de lo que la persona quiso. Ver el servicio.
 */
@Controller({ version: '1' })
export class SocialController {
  constructor(private readonly social: SocialService) {}

  /**
   * Con límite alto: en un vivo, tocar el corazón es parte de mirar.
   *
   * Cien por minuto es generoso para una persona y sigue frenando un script.
   */
  @RateLimit({ limit: 100, windowSec: 60, bucket: 'like' })
  @Post('lives/:id/like')
  gustarLive(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.social.alternarMeGusta(user.id, 'LIVE', id);
  }

  @RateLimit({ limit: 100, windowSec: 60, bucket: 'like' })
  @Post('products/:id/like')
  gustarProducto(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.social.alternarMeGusta(user.id, 'PRODUCT', id);
  }

  /**
   * El estado del corazón.
   *
   * `@Public()` y no un endpoint autenticado: alguien que todavía no se
   * registró tiene que poder ver cuántos "me gusta" tiene un producto — es
   * parte de decidir si comprar.
   *
   * Y `@Public()` acá no significa anónimo: el guardia identifica igual a quien
   * mande un token, así que con sesión devuelve además si le gusta a esa
   * persona. Un token vencido no rompe nada, sólo hace que `meGusta` sea
   * `false`.
   */
  @Public()
  @Get('products/:id/like')
  estadoProducto(@CurrentUser() user: AuthenticatedUser | null, @Param('id') id: string) {
    return this.social.estadoDeMeGusta(user?.id ?? null, 'PRODUCT', id);
  }

  @Public()
  @Get('lives/:id/like')
  estadoLive(@CurrentUser() user: AuthenticatedUser | null, @Param('id') id: string) {
    return this.social.estadoDeMeGusta(user?.id ?? null, 'LIVE', id);
  }

  /**
   * El enlace para compartir algo.
   *
   * Público: compartir es cómo llega gente que todavía no tiene la app, y pedir
   * sesión para generar un enlace sería cerrarle la puerta justo a eso.
   */
  @Public()
  @Get('share/:cosa/:id')
  compartir(
    @Param('cosa') cosa: string,
    @Param('id') id: string,
    @Query('src') src?: string,
  ) {
    const valida = COSAS.find((c) => c === cosa);
    if (!valida) {
      throw new DomainError('VALIDATION_FAILED', 'No se puede compartir eso', { cosa });
    }

    return this.social.enlaceDeCompartido(valida, id, ORIGENES.find((o) => o === src));
  }
}
