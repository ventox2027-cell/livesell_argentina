import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, Public, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { StoresService } from './stores.service';

const MINUTO_DEL_DIA = z.coerce.number().int().min(0).max(1439);

const HorarioSchema = z.object({
  modo: z.enum(['ALWAYS_OPEN', 'SCHEDULED', 'LIVE_ONLY']),
  zona: z.string().max(64).optional(),
  franjas: z
    .array(
      z
        .object({
          dia: z.coerce.number().int().min(0).max(6),
          abreMinutos: MINUTO_DEL_DIA,
          cierraMinutos: MINUTO_DEL_DIA,
        })
        // Una franja de duración cero no es una franja. Que el cierre sea MENOR
        // sí se permite: significa que cruza la medianoche.
        .refine((f) => f.abreMinutos !== f.cierraMinutos, {
          message: 'La franja no puede abrir y cerrar en el mismo minuto',
        }),
    )
    // 7 días × 4 franjas es más de lo que cualquier tienda real necesita.
    .max(28)
    .default([]),
});
type HorarioDto = z.infer<typeof HorarioSchema>;

const ResenaSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});
type ResenaDto = z.infer<typeof ResenaSchema>;

const PaginaSchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  q: z.string().trim().max(80).optional(),
});
type PaginaDto = z.infer<typeof PaginaSchema>;

const IntencionSchema = z.object({
  quantity: z.coerce.number().int().min(1).max(20).default(1),
});
type IntencionDto = z.infer<typeof IntencionSchema>;

@Controller({ version: '1' })
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  // ─── Perfil público ────────────────────────────────────────────────────────

  /**
   * El perfil de un vendedor.
   *
   * Público, pero identifica si hay sesión: `loSigo` sólo tiene sentido para
   * alguien logueado, y el resto del perfil tiene que poder verse sin cuenta.
   * Pedir registro para mirar una tienda es la forma más rápida de no tener
   * usuarios.
   */
  @Public()
  @Get('sellers/:id/profile')
  perfil(@CurrentUser() user: AuthenticatedUser | undefined, @Param('id') id: string) {
    return this.stores.perfilPublico(id, user?.id);
  }

  @Public()
  @Get('sellers/:id/reviews')
  resenas(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(PaginaSchema)) q: PaginaDto,
  ) {
    return this.stores.resenasDe(id, q);
  }

  @Public()
  @Get('stores/:id/catalog')
  catalogo(@Param('id') id: string, @Query(new ZodValidationPipe(PaginaSchema)) q: PaginaDto) {
    return this.stores.catalogo(id, q);
  }

  /**
   * El detalle de un producto para quien compra.
   *
   * ⚠️ No confundir con `GET /products/:id`, que es del VENDEDOR y resuelve por
   * dueño. La app usaba aquél para el selector de talles y a un comprador real
   * le contestaba `SELLER_NOT_FOUND`.
   *
   * Público, como el catálogo: se puede mirar un producto sin cuenta. La cuenta
   * se pide al reservar.
   */
  @Public()
  @Get('catalog/products/:id')
  producto(@Param('id') id: string) {
    return this.stores.detalleParaComprar(id);
  }

  @Public()
  @Get('stores/:id/status')
  estado(@Param('id') id: string) {
    return this.stores.estadoDeTienda(id);
  }

  // ─── Seguir ────────────────────────────────────────────────────────────────

  /**
   * Seguir. Idempotente: tocar dos veces deja el mismo resultado.
   *
   * Con límite por usuario y no por IP: seguir es barato de hacer y caro de
   * abusar —inflar seguidores es la forma más simple de aparentar reputación—
   * y todo el equipo de una oficina comparte salida a internet.
   */
  @RateLimit({ limit: 60, windowSec: 3600, bucket: 'follow' })
  @Post('sellers/:id/follow')
  seguir(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.stores.seguir(user.id, id);
  }

  @Delete('sellers/:id/follow')
  dejarDeSeguir(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.stores.dejarDeSeguir(user.id, id);
  }

  // ─── Reseñas ───────────────────────────────────────────────────────────────

  /**
   * Reseñar una compra.
   *
   * La reseña va sobre la ORDEN y no sobre el vendedor: es lo que hace
   * imposible reseñar sin haber comprado, y lo que limita a una por compra sin
   * necesidad de moderación.
   */
  @RateLimit({ limit: 20, windowSec: 3600, bucket: 'review' })
  @Post('orders/:id/review')
  resenar(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ResenaSchema)) dto: ResenaDto,
  ) {
    return this.stores.resenar(user.id, id, dto);
  }

  // ─── Horarios del vendedor ─────────────────────────────────────────────────

  @Get('stores/me/schedule')
  miHorario(@CurrentUser() user: AuthenticatedUser) {
    return this.stores.miHorario(user.id);
  }

  @Put('stores/me/schedule')
  guardarHorario(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(HorarioSchema)) dto: HorarioDto,
  ) {
    return this.stores.guardarHorario(user.id, dto);
  }

  /**
   * Quién está esperando para comprar.
   *
   * ⚠️ Sin datos de contacto: nombre de pila y números, nada más. Quien dejó
   * una intención pidió que le AVISEN, no le dio su teléfono a un vendedor.
   * El aviso lo manda VendoX. Ver `interesados` en el servicio.
   */
  @Get('stores/me/intents')
  interesados(@CurrentUser() user: AuthenticatedUser) {
    return this.stores.interesados(user.id);
  }

  // ─── Intención de compra ───────────────────────────────────────────────────

  /**
   * "Avisame cuando abran."
   *
   * ⚠️ No descuenta stock. Ver `dejarIntencion` en el servicio.
   */
  @RateLimit({ limit: 30, windowSec: 3600, bucket: 'intent' })
  @Post('variants/:id/intent')
  dejarIntencion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(IntencionSchema)) dto: IntencionDto,
  ) {
    return this.stores.dejarIntencion(user.id, id, dto.quantity);
  }

  @Delete('variants/:id/intent')
  quitarIntencion(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.stores.quitarIntencion(user.id, id);
  }
}
