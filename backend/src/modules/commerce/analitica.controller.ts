import { Controller, Get, Param } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '@/modules/auth/auth.guard';

import { AnaliticaService } from './analitica.service';

/**
 * Las métricas del vendedor.
 *
 * ⚠️ Toda cifra que sale de acá se contó de una tabla. Cuando un dato no
 * alcanza para decir algo, viaja `null` y la app muestra «todavía no sabemos»
 * — nunca un cero que se lee como «te fue mal». Ver `analitica.ts`.
 */
@Controller({ path: 'seller/analytics', version: '1' })
export class AnaliticaController {
  constructor(private readonly analitica: AnaliticaService) {}

  @Get('funnel')
  embudo(@CurrentUser() user: AuthenticatedUser) {
    return this.analitica.embudoDeLaTienda(user.id);
  }

  @Get('funnel/:productId')
  embudoDeProducto(@CurrentUser() user: AuthenticatedUser, @Param('productId') id: string) {
    return this.analitica.embudoDeProducto(user.id, id);
  }
}
