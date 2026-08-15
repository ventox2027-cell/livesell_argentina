import { Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, Public, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { DomainError } from '@/shared/errors/domain.error';
import { RateLimit } from '@/shared/http/rate-limit.guard';

import type { CosaCompartible, OrigenDeCompartido } from './compartir';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { SocialService } from './social.service';

const PaginaSchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
type PaginaDto = z.infer<typeof PaginaSchema>;

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

  // ─── Guardados ─────────────────────────────────────────────────────────────

  /**
   * Lo que la persona guardó.
   *
   * ⚠️ Es la misma tabla que los «me gusta»: el corazón de un producto y esta
   * lista son el mismo gesto con dos nombres. No hay un sistema paralelo de
   * favoritos. Lo que cambia es el nombre en la interfaz: «Guardados» dice qué
   * se puede hacer con la lista, «Me gusta» no dice nada.
   */
  @Get('me/saved')
  misGuardados(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(PaginaSchema)) query: PaginaDto,
  ) {
    return this.social.misGuardados(user.id, query);
  }

  // ─── Vistos recientemente ──────────────────────────────────────────────────

  /**
   * Registra que vio un producto.
   *
   * Lo llama la app al abrir el detalle. Devuelve 204 y nunca falla: es una
   * comodidad, no parte de la operación, y un error acá no puede impedir que
   * alguien vea un producto.
   */
  @HttpCode(204)
  @RateLimit({ limit: 300, windowSec: 60, bucket: 'viewed' })
  @Post('products/:id/viewed')
  async marcarVisto(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    await this.social.registrarVista(user.id, 'PRODUCT', id);
  }

  @Get('me/recently-viewed')
  misVistos(@CurrentUser() user: AuthenticatedUser) {
    return this.social.misVistosRecientes(user.id);
  }

  /**
   * Borrar el historial.
   *
   * Tiene que existir: es una lista de lo que alguien miró, y aunque no salga
   * de la app, poder borrarla es la diferencia entre una comodidad y algo que
   * la persona no controla.
   */
  @Delete('me/recently-viewed')
  borrarVistos(@CurrentUser() user: AuthenticatedUser) {
    return this.social.borrarVistos(user.id);
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
