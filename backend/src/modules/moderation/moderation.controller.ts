import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, Roles, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

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
