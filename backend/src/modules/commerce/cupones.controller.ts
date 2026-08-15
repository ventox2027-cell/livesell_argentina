import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { CuponesService } from './cupones.service';

/**
 * Cupones.
 *
 * Dos públicos distintos y por eso dos controladores en el mismo archivo:
 *
 *   · el **vendedor** los crea y los administra. Es función de VendoX Pro;
 *   · el **comprador** sólo puede probar un código contra una tienda.
 */

const CrearCuponSchema = z
  .object({
    codigo: z.string().trim().min(1).max(30),
    tipo: z.enum(['PORCENTAJE', 'MONTO_FIJO']),
    /** Porcentaje entero o CENTAVOS, según el tipo. Ver `cupones.ts`. */
    valor: z.number().int().positive(),
    minimoCentavos: z.number().int().nonnegative().nullable().optional(),
    topeCentavos: z.number().int().positive().nullable().optional(),
    desde: z.coerce.date().nullable().optional(),
    hasta: z.coerce.date().nullable().optional(),
    usosMaximos: z.number().int().positive().nullable().optional(),
  })
  // El resto de las reglas —el máximo, el tope sobre monto fijo, la ventana
  // invertida— viven en `exigirCuponValido`, para que valgan también cuando
  // quien crea el cupón no sea este endpoint.
  .strict();
type CrearCuponDto = z.infer<typeof CrearCuponSchema>;

const AlternarSchema = z.object({ activo: z.boolean() });
type AlternarDto = z.infer<typeof AlternarSchema>;

@Controller({ path: 'seller/coupons', version: '1' })
export class CuponesDelVendedorController {
  constructor(private readonly cupones: CuponesService) {}

  @Get()
  mios(@CurrentUser() user: AuthenticatedUser) {
    return this.cupones.mios(user.id);
  }

  @Post()
  crear(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CrearCuponSchema)) dto: CrearCuponDto,
  ) {
    return this.cupones.crear(user.id, dto);
  }

  @Post(':id/toggle')
  alternar(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AlternarSchema)) dto: AlternarDto,
  ) {
    return this.cupones.alternar(user.id, id, dto.activo);
  }

  @Delete(':id')
  borrar(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.cupones.borrar(user.id, id);
  }
}

const ProbarSchema = z.object({
  sellerId: z.string().min(1).max(40),
  codigo: z.string().trim().min(1).max(30),
  /** El subtotal de lo que va a comprar, en CENTAVOS. */
  subtotalCentavos: z.coerce.number().int().positive(),
});
type ProbarDto = z.infer<typeof ProbarSchema>;

@Controller({ path: 'coupons', version: '1' })
export class CuponesDelCompradorController {
  constructor(private readonly cupones: CuponesService) {}

  /**
   * ¿Este código sirve para esta compra?
   *
   * ⚠️ **No reserva nada.** Entre esta respuesta y el pedido, el último uso se
   * lo puede llevar otro. Es información, no una promesa — igual que el stock
   * disponible. Quien decide es el canje, dentro de la transacción del pedido.
   *
   * ─── Por qué tiene límite de peticiones ───
   *
   * Sin límite, esto es un oráculo para descubrir los códigos de una tienda
   * probando palabras. El límite no lo hace imposible, pero convierte «probar
   * diez mil combinaciones» en algo que tarda días.
   *
   * Además responde el mismo mensaje para «no existe» y «está pausado», así que
   * ni siquiera un intento exitoso de adivinar distingue los dos casos.
   */
  @RateLimit({ limit: 20, windowSec: 60, bucket: 'coupon:probar' })
  @Get('check')
  probar(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(ProbarSchema)) q: ProbarDto,
  ) {
    return this.cupones.probar(user.id, q.sellerId, q.codigo, q.subtotalCentavos);
  }
}
