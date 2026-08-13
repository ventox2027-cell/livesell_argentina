import { z } from 'zod';

/**
 * Contratos de entrada del spike de pagos.
 *
 * Todo lo que entra se valida acá. La regla que gobierna estos esquemas:
 * **ningún campo de tarjeta puede aparecer**. Si mañana alguien agrega
 * `cardNumber` a un DTO, el backend entra en alcance PCI completo. El único
 * dato de tarjeta que se acepta es el `token`, que ya es opaco.
 */

export const CreateOrderSchema = z.object({
  /**
   * La genera el cliente y la repite si reintenta. Es lo que impide que dos
   * toques del botón creen dos órdenes.
   */
  idempotencyKey: z.string().min(8).max(128),
  buyerEmail: z.string().email(),
  description: z.string().min(1).max(200),
  /**
   * Centavos, entero. Rechazar decimales acá evita la clase entera de errores
   * de redondeo: si el cliente manda 1500.5 centavos, es un bug del cliente.
   */
  amountCents: z.number().int().positive().max(100_000_000),
});
export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;

export const PayOrderSchema = z.object({
  /** Token de un solo uso de Mercado Pago. Nunca se persiste. */
  token: z.string().min(10).max(256),
  paymentMethodId: z.string().min(2).max(40),
  installments: z.number().int().min(1).max(24),
  issuerId: z.string().max(40).optional(),
  saveCard: z.boolean().default(false),
});
export type PayOrderDto = z.infer<typeof PayOrderSchema>;

export const ReconcileSchema = z.object({
  /**
   * Antigüedad mínima para considerar atascada una orden. En la prueba de
   * campo se baja a 0 para no esperar; en producción el valor por defecto
   * evita perseguir cobros que todavía están en vuelo.
   */
  olderThanMs: z.number().int().min(0).max(86_400_000).default(60_000),
});
export type ReconcileDto = z.infer<typeof ReconcileSchema>;

export const SavedCardsQuerySchema = z.object({
  email: z.string().email(),
});
export type SavedCardsQueryDto = z.infer<typeof SavedCardsQuerySchema>;
