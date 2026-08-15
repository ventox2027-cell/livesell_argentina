import { Controller, Get } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '@/modules/auth/auth.guard';

import { MembresiasService } from './membresias.service';

/**
 * Qué plan tiene el vendedor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO HAY ENDPOINT PARA CONTRATAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Y no es un olvido. No hay cobro todavía —ver el comentario de cabecera de
 * `membresias.ts`—, así que Pro se otorga desde el panel de administración.
 *
 * Un `POST /suscribirme` que devuelva «próximamente» sería peor que no tenerlo:
 * la app lo llamaría, alguien lo cachearía, y el día que exista cobro habría
 * que romper una ruta que ya está en producción.
 */
@Controller({ path: 'seller/membership', version: '1' })
export class MembresiasController {
  constructor(private readonly membresias: MembresiasService) {}

  @Get()
  mia(@CurrentUser() user: AuthenticatedUser) {
    return this.membresias.miMembresiaDeUsuario(user.id);
  }
}
