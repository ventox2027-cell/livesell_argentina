import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { NotificationsService } from './notifications.service';

const ListarSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
type ListarDto = z.infer<typeof ListarSchema>;

const PreferenciaSchema = z.object({ activa: z.boolean() });
type PreferenciaDto = z.infer<typeof PreferenciaSchema>;

/**
 * El centro de notificaciones.
 *
 * ─── Sólo lectura y marcar leído ───
 *
 * No hay endpoint para crear un aviso. Los avisos los origina el backend
 * cuando pasa algo —un pedido que cambia de estado, una tienda que reabre—, y
 * un endpoint para crearlos sería una forma de mandarle notificaciones a
 * cualquier usuario desde la app.
 *
 * ─── Sin `userId` en ningún lado ───
 *
 * Todo sale del usuario autenticado. El id de la notificación viaja en la URL
 * y se resuelve filtrando por dueño dentro del WHERE, así que uno ajeno no
 * actualiza nada.
 */
@Controller({ version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  listar(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(ListarSchema)) query: ListarDto,
  ) {
    return this.notifications.listar(user.id, query);
  }

  /**
   * Sólo el contador, para el globito.
   *
   * Endpoint propio porque la app lo pide al abrir y cada vez que vuelve del
   * fondo, y no necesita la lista entera para pintar un número.
   */
  // ─── Preferencias ──────────────────────────────────────────────────────────

  /**
   * Qué categorías de aviso están encendidas.
   *
   * Cuatro grupos con nombres de persona, no ocho interruptores técnicos. Una
   * pantalla con «REVIEW_ANSWERED» y «SAVED_BACK_IN_STOCK» es una pantalla que
   * nadie configura: hay que leer los ocho para entender cuál apagar.
   */
  @Get('notifications/preferences')
  misCategorias(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.misCategorias(user.id);
  }

  @Patch('notifications/preferences/:clave')
  cambiarCategoria(
    @CurrentUser() user: AuthenticatedUser,
    @Param('clave') clave: string,
    @Body(new ZodValidationPipe(PreferenciaSchema)) dto: PreferenciaDto,
  ) {
    return this.notifications.cambiarCategoria(user.id, clave, dto.activa);
  }

  @Get('notifications/unread-count')
  async sinLeer(@CurrentUser() user: AuthenticatedUser) {
    return { sinLeer: await this.notifications.contarSinLeer(user.id) };
  }

  @Patch('notifications/read-all')
  marcarTodas(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.marcarTodasLeidas(user.id);
  }

  @Patch('notifications/:id/read')
  marcarLeida(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.marcarLeida(user.id, id);
  }
}
