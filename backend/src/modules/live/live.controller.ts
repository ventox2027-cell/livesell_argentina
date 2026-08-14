import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, Public, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { LiveService } from './live.service';

const PrepararSchema = z.object({
  title: z.string().trim().min(3).max(120),
  coverUrl: z.string().url().max(500).optional(),
  /** La bandeja del vivo. Se puede empezar vacía y agregar después. */
  productIds: z.array(z.string().max(64)).max(50).default([]),
});
type PrepararDto = z.infer<typeof PrepararSchema>;

const DestacarSchema = z.object({
  /** `null` deja de destacar. */
  variantId: z.string().max(64).nullable(),
});
type DestacarDto = z.infer<typeof DestacarSchema>;

const BandejaSchema = z.object({
  /** La bandeja completa, en orden. Se reemplaza entera, no se edita de a uno. */
  productIds: z.array(z.string().max(64)).max(50),
});
type BandejaDto = z.infer<typeof BandejaSchema>;

@Controller({ path: 'live', version: '1' })
export class LiveController {
  constructor(private readonly live: LiveService) {}

  // ─── Espectador ────────────────────────────────────────────────────────────

  /**
   * Los vivos activos.
   *
   * Público: alguien que todavía no se registró tiene que poder ver qué hay en
   * vivo. La cuenta se pide cuando quiere comprar o comentar, no antes.
   */
  @Public()
  @Get()
  activos(@Query('limit') limit?: string) {
    return this.live.activos(Math.min(Number(limit) || 20, 50));
  }

  /**
   * Entrar a un vivo.
   *
   * Requiere sesión porque devuelve un token de LiveKit, que es una credencial
   * con nombre y apellido: se emite para una identidad concreta y con permisos
   * de sólo suscripción.
   */
  @Get(':id')
  ver(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.live.paraEspectador(id, user.id);
  }

  // ─── Vendedor ──────────────────────────────────────────────────────────────

  /**
   * Prepara una transmisión. **No enciende la cámara en público.**
   *
   * Devuelve el token de broadcaster para que la app pueda conectarse y mostrar
   * la vista previa. Salir al aire es el paso siguiente.
   */
  @RateLimit({ limit: 20, windowSec: 3600, bucket: 'live:prepare' })
  @Post()
  preparar(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(PrepararSchema)) dto: PrepararDto,
  ) {
    return this.live.preparar(user.id, dto);
  }

  /**
   * ¿Tengo un vivo abierto?
   *
   * Va ANTES de `:id` a propósito: Nest resuelve por orden de declaración, y
   * declarada después, `GET /live/mine` entraría por `GET /live/:id` con
   * `id = 'mine'` y devolvería 404 siempre.
   */
  @Get('mine')
  mio(@CurrentUser() user: AuthenticatedUser) {
    return this.live.miVivoAbierto(user.id);
  }

  /** Todo lo que la pantalla del vendedor necesita mientras transmite. */
  @Get(':id/panel')
  panel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.live.panelDelVendedor(user.id, id);
  }

  /** Cambia qué productos están en la bandeja y en qué orden. */
  @Put(':id/products')
  bandeja(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(BandejaSchema)) dto: BandejaDto,
  ) {
    return this.live.actualizarBandeja(user.id, id, dto.productIds);
  }

  @Post(':id/start')
  iniciar(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.live.iniciar(user.id, id);
  }

  /**
   * Volví después de un corte.
   *
   * Sin límite apretado: quien está transmitiendo con mala señal puede
   * reconectar varias veces seguidas, y frenarlo ahí lo dejaría marcado como
   * "reconectando" con el video ya funcionando.
   */
  @RateLimit({ limit: 60, windowSec: 60, bucket: 'live:resume' })
  @Post(':id/resume')
  reanudar(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.live.reanudar(user.id, id);
  }

  @Post(':id/end')
  terminar(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.live.terminar(user.id, id);
  }

  /**
   * Destaca un producto.
   *
   * Sin límite de peticiones apretado: durante un vivo el vendedor cambia de
   * producto seguido, y es la interacción más frecuente que tiene. Un límite
   * bajo acá se sentiría como que la app no responde.
   */
  @RateLimit({ limit: 120, windowSec: 60, bucket: 'live:feature' })
  @Post(':id/feature')
  destacar(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DestacarSchema)) dto: DestacarDto,
  ) {
    return this.live.destacar(user.id, id, dto.variantId);
  }
}
