import { Body, Controller, Delete, Get, Headers, Param, Patch, Post } from '@nestjs/common';

import { CurrentUser, Public, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { OwnershipService } from '@/modules/commerce/ownership.service';
import { DomainError } from '@/shared/errors/domain.error';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import {
  CreateReservationSchema,
  IdempotencyKeySchema,
  UpdateInventorySchema,
  type CreateReservationDto,
  type UpdateInventoryDto,
} from './dto/inventory.dto';
import { ExpirationQueue } from './expiration.queue';
import { InventoryService } from './inventory.service';

/**
 * API de inventario.
 *
 * ─── Dos audiencias, dos vistas ───
 *
 * El **vendedor** ve sus números crudos: cuánto tiene, cuánto hay apartado,
 * cuánto queda libre. Es su negocio.
 *
 * El **comprador** ve una etiqueta: disponible, quedan pocas, agotado. Publicar
 * el stock exacto de cada variante le regala a la competencia el ritmo de
 * ventas del vendedor — consultando dos veces por día se saca cuánto vendió.
 *
 * ─── Ningún endpoint acepta `reserved` ───
 *
 * Ver la nota en los DTOs. No hay forma de escribir esa columna desde afuera.
 */
@Controller({ version: '1' })
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly ownership: OwnershipService,
    private readonly expiration: ExpirationQueue,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // COMPRADOR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Aparta stock.
   *
   * ─── Por qué la clave de idempotencia es obligatoria ───
   *
   * El caso que la justifica no es teórico, es el caso NORMAL en una red móvil
   * argentina: la persona toca "Comprar", la petición llega, el backend aparta
   * la unidad, y la respuesta se pierde en el camino de vuelta. La app cree que
   * falló. La persona toca otra vez.
   *
   * Sin clave, ese segundo toque aparta una segunda unidad. Con la MISMA clave
   * —y la app tiene que reusarla mientras no sepa el resultado— el backend
   * reconoce el reintento y devuelve la reserva que ya había hecho.
   *
   * Por eso es obligatoria y no opcional: si fuera opcional, el día que alguien
   * escriba un cliente nuevo se la olvidaría, y el síntoma —stock que se
   * evapora en zonas con mala señal— es casi imposible de diagnosticar.
   *
   * ─── El límite es por persona ───
   *
   * 30 por minuto alcanza de sobra para alguien comprando en un vivo y frena
   * un script. Va por usuario autenticado, no por IP: detrás del CGNAT de una
   * operadora móvil hay un barrio entero, y limitarlos como si fueran una sola
   * persona dejaría a la mayoría sin poder comprar.
   */
  @RateLimit({ limit: 30, windowSec: 60, bucket: 'inventory:reserve' })
  @Post('inventory/reservations')
  async reserve(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateReservationSchema)) dto: CreateReservationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const clave = IdempotencyKeySchema.safeParse(idempotencyKey ?? '');
    if (!clave.success) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Falta la cabecera Idempotency-Key',
        { reason: clave.error.issues[0]?.message },
      );
    }

    const reserva = await this.inventory.reserve({
      userId: user.id,
      productVariantId: dto.productVariantId,
      quantity: dto.quantity,
      idempotencyKey: clave.data,
    });

    // Después de cometer, y sin await bloqueante en el camino crítico: si la
    // cola está caída, la reserva ya existe igual y el reconciliador la vence.
    void this.expiration.programar(reserva.reservationId, reserva.expiresAt);

    return reserva;
  }

  /** Mis reservas vivas. La app las relee al volver del segundo plano. */
  @Get('inventory/reservations/mine')
  myReservations(@CurrentUser() user: AuthenticatedUser) {
    return this.inventory.myActiveReservations(user.id);
  }

  /** Una reserva propia. Una ajena responde 404, no 403. */
  @Get('inventory/reservations/:id')
  reservation(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.inventory.myReservation(id, user.id);
  }

  /**
   * Suelta la reserva.
   *
   * `userId` viaja al WHERE de la sentencia, no a un `if`: la reserva de otra
   * persona no es una operación prohibida, es una operación que no encuentra
   * nada que cancelar.
   */
  @Delete('inventory/reservations/:id')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.inventory.cancel(id, user.id);
  }

  /** Disponibilidad pública. Etiqueta, no números. */
  @Public()
  @Get('variants/:variantId/availability')
  availability(@Param('variantId') variantId: string) {
    return this.inventory.availability(variantId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VENDEDOR
  // ═══════════════════════════════════════════════════════════════════════

  /** Stock de todas las variantes de un producto propio. */
  @Get('products/:productId/inventory')
  async productInventory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
  ) {
    // La pertenencia se resuelve ANTES de tocar inventario. Un producto ajeno
    // no llega hasta acá: `productOf` lo filtra en el WHERE.
    const { product } = await this.ownership.productOf(user.id, productId);

    const variantes = await this.ownership.variantsOf(product.id);
    const inventario = await this.inventory.forVariants(variantes.map((v) => v.id));
    const porVariante = new Map(inventario.map((i) => [i.productVariantId, i]));

    return {
      productId: product.id,
      variants: variantes.map((v) => ({
        variantId: v.id,
        title: v.title,
        status: v.status,
        isDefault: v.isDefault,
        // Una variante sin fila de inventario se muestra en cero, no se
        // omite: si desapareciera de la lista, el vendedor no tendría forma de
        // cargarle stock.
        ...(porVariante.get(v.id) ?? {
          inventoryId: null,
          onHand: 0,
          reserved: 0,
          available: 0,
          lowStockThreshold: null,
        }),
      })),
    };
  }

  /**
   * Cambia el stock de una variante propia.
   *
   * Acepta valor absoluto (`onHand`) o incremental (`adjust`). El incremental
   * existe porque "me entraron 10 más" es la operación real de un vendedor, y
   * obligarlo a calcular 47 + 10 y escribir 57 introduce errores de tipeo
   * sobre datos que después se venden.
   */
  @Patch('products/:productId/variants/:variantId/inventory')
  async updateInventory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body(new ZodValidationPipe(UpdateInventorySchema)) dto: UpdateInventoryDto,
  ) {
    const { variant } = await this.ownership.variantOf(user.id, productId, variantId, {
      requireActive: true,
    });

    const inventoryId = await this.inventory.idDeVariante(variant.id);

    if (dto.lowStockThreshold !== undefined) {
      await this.inventory.setLowStockThreshold(inventoryId, dto.lowStockThreshold, user.id);
    }

    if (dto.onHand !== undefined) {
      return this.inventory.setOnHand({
        inventoryId,
        onHand: dto.onHand,
        actorId: user.id,
        productVariantId: variant.id,
        motivo: dto.motivo,
      });
    }

    if (dto.adjust !== undefined) {
      return this.inventory.adjust({
        inventoryId,
        delta: dto.adjust,
        actorId: user.id,
        productVariantId: variant.id,
        motivo: dto.motivo,
      });
    }

    const [actual] = await this.inventory.forVariants([variant.id]);
    return actual;
  }
}
