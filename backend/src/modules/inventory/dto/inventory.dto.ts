import { z } from 'zod';

import { env } from '@/config/env.schema';

/**
 * Contratos de entrada del inventario.
 *
 * ─── Lo que ningún endpoint acepta ───
 *
 * **`reserved`.** No hay un solo camino por el que el cliente pueda escribir
 * esa columna. Es consecuencia de las reservas vivas, no un dato editable:
 * dejar que el vendedor la ponga en cero le permitiría "liberar" unidades que
 * alguien ya tiene apartadas y venderlas dos veces.
 *
 * Tampoco `userId`, `sellerId` ni `expiresAt`. El dueño sale del token y el
 * vencimiento lo calcula el backend.
 */

/**
 * Cantidad de una reserva.
 *
 * Los cuatro límites cubren cosas distintas:
 *   · `int` rechaza 1.5, que en unidades no significa nada.
 *   · `positive` rechaza 0 y negativos — un `-5` con un UPDATE mal escrito
 *     sería una forma de fabricar stock.
 *   · `finite` rechaza Infinity y NaN, que JSON.parse produce sin queja.
 *   · el máximo evita que una sola petición aparte el catálogo entero durante
 *     el TTL, que es una denegación de servicio comercial gratis.
 */
const CantidadSchema = z.coerce
  .number()
  .finite({ message: 'Cantidad inválida' })
  .int({ message: 'La cantidad va en unidades enteras' })
  .positive({ message: 'La cantidad tiene que ser al menos 1' })
  .max(env.INVENTORY_MAX_QUANTITY_PER_RESERVATION, {
    message: `Máximo ${env.INVENTORY_MAX_QUANTITY_PER_RESERVATION} unidades por compra`,
  });

/**
 * Unidades en depósito.
 *
 * El tope de un millón no es un límite de negocio: es un cortafuegos contra un
 * dedo pesado. Nadie carga 999.999.999 remeras a mano, pero sí puede escribir
 * un cero de más — y el número inflado se refleja en el feed como disponible.
 */
const StockSchema = z.coerce
  .number()
  .finite({ message: 'Stock inválido' })
  .int({ message: 'El stock va en unidades enteras' })
  .min(0, { message: 'El stock no puede ser negativo' })
  .max(1_000_000, { message: 'El máximo es 1.000.000 de unidades' });

export const CreateReservationSchema = z.object({
  productVariantId: z.string().min(1),
  quantity: CantidadSchema.default(1),
});
export type CreateReservationDto = z.infer<typeof CreateReservationSchema>;

/**
 * Cambio de stock del vendedor: valor absoluto **o** delta, nunca los dos.
 *
 * Los dos juntos son ambiguos —¿se aplica primero cuál?— y cualquier respuesta
 * que elijamos va a sorprender a alguien. Se rechaza y listo.
 */
export const UpdateInventorySchema = z
  .object({
    onHand: StockSchema.optional(),
    /** Suma o resta. `+10` porque entró mercadería, `-2` porque se rompió. */
    adjust: z.coerce
      .number()
      .finite()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((n) => n !== 0, { message: 'El ajuste no puede ser cero' })
      .optional(),
    /** Queda en la bitácora. "Rotura", "devolución", "recuento". */
    motivo: z.string().trim().max(140).optional(),
    lowStockThreshold: z.coerce.number().int().min(0).max(10_000).nullable().optional(),
  })
  .refine((d) => d.onHand === undefined || d.adjust === undefined, {
    message: 'Mandá onHand o adjust, no los dos',
  })
  .refine(
    (d) => d.onHand !== undefined || d.adjust !== undefined || d.lowStockThreshold !== undefined,
    { message: 'No hay nada que cambiar' },
  );
export type UpdateInventoryDto = z.infer<typeof UpdateInventorySchema>;

/**
 * Clave de idempotencia.
 *
 * Se valida el formato para que un cliente que mande una constante —`"1"`, o
 * peor, `"undefined"`— falle en voz alta en vez de compartir la misma clave
 * entre todas sus peticiones y recibir siempre la primera reserva.
 */
export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(8, { message: 'La clave de idempotencia es demasiado corta' })
  .max(120)
  .regex(/^[A-Za-z0-9_:.-]+$/, { message: 'Caracteres no permitidos en la clave' });
