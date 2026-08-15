import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { DURACIONES_EN_HORAS, costoDe } from './promociones';
import { PromocionesService } from './promociones.service';

/**
 * Promociones del vendedor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO HAY ENDPOINT PARA COMPRAR CRÉDITOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Y no es un olvido, es lo mismo que con VendoX Pro: el cobro está desacoplado
 * a propósito. Los créditos se otorgan desde el panel de administración.
 *
 * Un `POST /creditos` que devuelva «próximamente» sería peor que no tenerlo: la
 * app lo llamaría, y el día que exista cobro habría que romper una ruta que ya
 * está en producción.
 */

const ComprarPromocionSchema = z.object({
  tipo: z.enum(['PRODUCTO_EN_FEED', 'VIVO_PROGRAMADO']),
  targetId: z.string().min(1).max(40),
  /**
   * Las opciones, no un número libre.
   *
   * Un vendedor que puede escribir «1» paga por algo que no le sirve, y uno
   * que puede escribir «720» compra un mes de feed sin darse cuenta.
   */
  horas: z.union([z.literal(24), z.literal(72), z.literal(168)]),
});
type ComprarPromocionDto = z.infer<typeof ComprarPromocionSchema>;

@Controller({ path: 'seller/promotions', version: '1' })
export class PromocionesController {
  constructor(private readonly promociones: PromocionesService) {}

  /**
   * Saldo, promociones y cuánto sale cada opción.
   *
   * ⚠️ Los costos viajan en CRÉDITOS, no en pesos. Ver `promociones.ts`.
   */
  @Get()
  panel(@CurrentUser() user: AuthenticatedUser) {
    return this.promociones.panel(user.id);
  }

  /** Las duraciones y su costo, para que la app no las tenga hardcodeadas. */
  @Get('options')
  opciones() {
    return {
      duracionesEnHoras: DURACIONES_EN_HORAS,
      costos: {
        PRODUCTO_EN_FEED: Object.fromEntries(
          DURACIONES_EN_HORAS.map((h) => [h, costoDe('PRODUCTO_EN_FEED', h)]),
        ),
        VIVO_PROGRAMADO: Object.fromEntries(
          DURACIONES_EN_HORAS.map((h) => [h, costoDe('VIVO_PROGRAMADO', h)]),
        ),
      },
    };
  }

  @Post()
  comprar(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ComprarPromocionSchema)) dto: ComprarPromocionDto,
  ) {
    return this.promociones.comprar(user.id, dto);
  }

  /** La saca del feed. NO devuelve créditos: ya se mostró. */
  @Delete(':id')
  cancelar(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.promociones.cancelar(user.id, id);
  }
}
