import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, Roles, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { SupportService } from './support.service';

const CATEGORIAS = [
  'ENVIO',
  'CAMBIOS',
  'PAGOS',
  'DISPUTA',
  'CUENTA',
  'VENDEDOR',
  'PROBLEMA_TECNICO',
  'OTRO',
] as const;

const AbrirSchema = z.object({
  /**
   * El mensaje. Hasta 4000 caracteres.
   *
   * Generoso a propósito: alguien con un problema real escribe largo, y
   * cortarle el texto lo obliga a resumir justo cuando está frustrado. El
   * mínimo de 5 evita los tickets con "hola" que después nadie sabe qué eran.
   */
  mensaje: z.string().trim().min(5).max(4000),
  /** La puede elegir la persona. Si no viene, se sugiere mirando el texto. */
  categoria: z.enum(CATEGORIAS).optional(),
  orderId: z.string().min(1).max(64).optional(),
});
type AbrirDto = z.infer<typeof AbrirSchema>;

const MensajeSchema = z.object({ mensaje: z.string().trim().min(1).max(4000) });
type MensajeDto = z.infer<typeof MensajeSchema>;

/**
 * Soporte, del lado de quien tiene el problema.
 *
 * ─── Ningún endpoint recibe `userId` ───
 *
 * Sale del usuario autenticado, siempre. El id del ticket viaja en la URL y se
 * resuelve filtrando por dueño dentro del WHERE, así que uno ajeno responde lo
 * mismo que uno inexistente.
 */
@Controller({ version: '1' })
export class SupportController {
  constructor(private readonly support: SupportService) {}

  /**
   * Abre una conversación.
   *
   * Con límite: abrir tickets en serie es una forma barata de llenar la bandeja
   * del equipo, y también de gastar llamadas al asistente el día que sea un
   * modelo que se paga por consulta.
   */
  @RateLimit({ limit: 5, windowSec: 3600, bucket: 'support:open' })
  @Post('support/tickets')
  abrir(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(AbrirSchema)) dto: AbrirDto,
  ) {
    return this.support.abrir(user.id, dto);
  }

  @Get('support/tickets')
  listar(@CurrentUser() user: AuthenticatedUser) {
    return this.support.listar(user.id);
  }

  @Get('support/tickets/:id')
  detalle(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.support.detalle(user.id, id);
  }

  @RateLimit({ limit: 30, windowSec: 600, bucket: 'support:reply' })
  @Post('support/tickets/:id/messages')
  responder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(MensajeSchema)) dto: MensajeDto,
  ) {
    return this.support.responder(user.id, id, dto.mensaje);
  }

  @Patch('support/tickets/:id/resolve')
  resolver(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.support.marcarResuelto(user.id, id);
  }
}

/**
 * La bandeja del equipo.
 *
 * ─── `@Roles('admin')` a nivel de CLASE ───
 *
 * Es la misma decisión que en el módulo de administración: a nivel de método,
 * agregar un endpoint nuevo y olvidarse del decorador deja una ruta sin
 * protección que nadie nota hasta que alguien la encuentra. A nivel de clase,
 * lo que se olvida es lo contrario —dejar algo protegido de más— y eso se
 * descubre enseguida porque no funciona.
 */
@Roles('admin')
@Controller({ path: 'admin/support', version: '1' })
export class SupportAdminController {
  constructor(private readonly support: SupportService) {}

  @Get('tickets')
  bandeja(@Query('status') status?: string) {
    // Sin `status`, lo escalado: es lo único que de verdad espera a una persona.
    const valido = (['ABIERTO', 'ESPERANDO_RESPUESTA', 'ESCALADO', 'RESUELTO', 'CERRADO'] as const)
      .find((s) => s === status);
    return this.support.bandeja({ status: valido });
  }

  @Post('tickets/:id/messages')
  responder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(MensajeSchema)) dto: MensajeDto,
  ) {
    return this.support.responderComoEquipo(user.id, id, dto.mensaje);
  }
}
