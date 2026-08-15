import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, Roles, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { BloqueosService } from './bloqueos.service';
import { ModerationService } from './moderation.service';

const DESTINOS = ['PRODUCT', 'LIVE', 'SELLER', 'REVIEW', 'CHAT_MESSAGE'] as const;
const MOTIVOS = [
  'PROHIBIDO',
  'FALSIFICADO',
  'CONTENIDO_AJENO',
  'CONTENIDO_SEXUAL',
  'VIOLENCIA',
  'ESTAFA',
  'ENGANOSO',
  'SPAM',
  'OTRO',
] as const;

const ReportarSchema = z.object({
  targetType: z.enum(DESTINOS),
  targetId: z.string().min(1).max(64),
  reason: z.enum(MOTIVOS),
  /**
   * Lo que escribió quien reporta. Opcional, pero es lo más útil para decidir:
   * "vende réplicas" dice mucho más que la categoría sola.
   */
  detail: z.string().trim().max(1000).optional(),
});
type ReportarDto = z.infer<typeof ReportarSchema>;

const ResolverSchema = z.object({
  targetType: z.enum(DESTINOS),
  targetId: z.string().min(1).max(64),
  decision: z.enum(['CONFIRMADO', 'DESESTIMADO']),
  /**
   * Obligatorio y con mínimo real.
   *
   * Una decisión de moderación sin motivo no se puede defender ni revisar, y
   * "ok" no es un motivo. Cuando el vendedor reclame, esto es lo único que hay
   * para mirar.
   */
  resolution: z.string().trim().min(10).max(1000),
  accion: z.enum(['HIDE', 'UNHIDE', 'NADA']).default('NADA'),
});
type ResolverDto = z.infer<typeof ResolverSchema>;

/**
 * Reportar contenido.
 *
 * ─── Un solo endpoint para todo ───
 *
 * Productos, vivos, vendedores, reseñas y mensajes del chat pasan por acá. Un
 * endpoint por tipo serían cinco caminos con la misma lógica de umbral, y el
 * día que se agregue un tipo nuevo alguien se olvidaría de uno.
 */
@Controller({ version: '1' })
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  /**
   * Con límite: reportar en serie es la forma barata de bajar la publicación de
   * un competidor. El índice único ya impide repetir sobre lo mismo; esto
   * frena a quien reporte veinte cosas distintas en un minuto.
   */
  @RateLimit({ limit: 20, windowSec: 3600, bucket: 'report' })
  @Post('reports')
  reportar(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ReportarSchema)) dto: ReportarDto,
  ) {
    return this.moderation.reportar(user.id, dto);
  }
}

/**
 * La cola de moderación.
 *
 * `@Roles('admin')` a nivel de CLASE: a nivel de método, agregar un endpoint y
 * olvidarse del decorador deja una ruta sin protección que nadie nota.
 */
@Roles('admin')
@Controller({ path: 'admin/moderation', version: '1' })
export class ModerationAdminController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('queue')
  cola(@Query('limit') limit?: string) {
    return this.moderation.cola({ limit: limit ? Number(limit) : undefined });
  }

  @Post('resolve')
  resolver(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ResolverSchema)) dto: ResolverDto,
  ) {
    return this.moderation.resolver(user.id, dto);
  }

  /** La historia de moderación de algo. Es lo que se mira ante un reclamo. */
  @Get('history/:targetType/:targetId')
  historial(
    @Param('targetType') targetType: string,
    @Param('targetId') targetId: string,
  ) {
    const valido = DESTINOS.find((d) => d === targetType) ?? 'PRODUCT';
    return this.moderation.historial(valido, targetId);
  }
}

const BloquearSchema = z.object({
  /**
   * Por qué, si lo quiere decir. Opcional a propósito.
   *
   * Obligar a explicar es una fricción que hace que alguien no bloquee a quien
   * lo está molestando, que es exactamente lo contrario de lo que se busca.
   */
  reason: z.string().trim().max(500).optional(),
})
  /**
   * Sin cuerpo también vale.
   *
   * Bloquear sin explicar es el caso NORMAL: el motivo es opcional. Sin este
   * `default`, un POST sin cuerpo lo rechaza Zod con "Required" y el botón de
   * bloquear no funciona nunca.
   */
  .default({});
type BloquearDto = z.infer<typeof BloquearSchema>;

/**
 * Bloquear personas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SEPARADO DE LOS REPORTES A PROPÓSITO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Bloquear es una decisión personal: inmediata, reversible, sin revisión y sin
 * consecuencias para la otra persona. Reportar es pedirle a VendoX que revise
 * algo, con umbrales y revisión humana.
 *
 * Mezclarlos sería peligroso en las dos direcciones: si bloquear tuviera
 * consecuencias, bloqueos coordinados podrían bajar a un vendedor; si reportar
 * sólo ocultara contenido para quien reporta, nadie moderaría nada.
 */
@Controller({ path: 'blocks', version: '1' })
export class BloqueosController {
  constructor(private readonly bloqueos: BloqueosService) {}

  /** A quiénes bloqueé. */
  @Get()
  lista(@CurrentUser() user: AuthenticatedUser) {
    return this.bloqueos.lista(user.id);
  }

  /**
   * Lo mismo, pero por vendedor.
   *
   * ⚠️ Las tres rutas de `seller/...` van ANTES que las de `:userId`. Nest
   * resuelve por orden de declaración, y declaradas después, `/blocks/seller/x`
   * entraría por `/blocks/:userId` con `userId = 'seller'`.
   *
   * Existen porque la app no conoce el `userId` de un vendedor: su perfil
   * público devuelve el `sellerId` y nada más. Ver `userIdDeVendedor`.
   */
  @Get('seller/:sellerId')
  async estadoDeVendedor(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sellerId') sellerId: string,
  ) {
    const userId = await this.bloqueos.userIdDeVendedor(sellerId);
    return { bloqueado: await this.bloqueos.estaBloqueado(user.id, userId) };
  }

  @RateLimit({ limit: 60, windowSec: 3600, bucket: 'blocks:create' })
  @Post('seller/:sellerId')
  async bloquearVendedor(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sellerId') sellerId: string,
    @Body(new ZodValidationPipe(BloquearSchema)) dto: BloquearDto,
  ) {
    const userId = await this.bloqueos.userIdDeVendedor(sellerId);
    return this.bloqueos.bloquear(user.id, userId, dto.reason);
  }

  @Delete('seller/:sellerId')
  async desbloquearVendedor(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sellerId') sellerId: string,
  ) {
    const userId = await this.bloqueos.userIdDeVendedor(sellerId);
    return this.bloqueos.desbloquear(user.id, userId);
  }

  /**
   * ¿Bloqueé a esta persona?
   *
   * Lo consulta el perfil de un vendedor para pintar el botón. Va aparte de la
   * lista porque cargar doscientos bloqueos para saber si uno está adentro es
   * absurdo.
   */
  @Get(':userId')
  estado(@CurrentUser() user: AuthenticatedUser, @Param('userId') userId: string) {
    return this.bloqueos
      .estaBloqueado(user.id, userId)
      .then((bloqueado) => ({ bloqueado }));
  }

  /**
   * Bloquear.
   *
   * El límite es generoso —sesenta por hora— porque bloquear es defensivo:
   * alguien que está recibiendo acoso coordinado puede necesitar bloquear a
   * varias personas seguidas, y frenarlo ahí sería dejarlo indefenso.
   *
   * Pero hay límite igual: sin él, un script puede crear millones de filas.
   */
  @RateLimit({ limit: 60, windowSec: 3600, bucket: 'blocks:create' })
  @Post(':userId')
  bloquear(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(BloquearSchema)) dto: BloquearDto,
  ) {
    return this.bloqueos.bloquear(user.id, userId, dto.reason);
  }

  @Delete(':userId')
  desbloquear(@CurrentUser() user: AuthenticatedUser, @Param('userId') userId: string) {
    return this.bloqueos.desbloquear(user.id, userId);
  }
}
