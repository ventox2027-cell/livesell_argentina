import { z } from 'zod';

/**
 * Contratos de entrada de órdenes y pagos.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE NINGÚN ENDPOINT ACEPTA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **Nada que tenga que ver con plata.** Ni `unitPrice`, ni `itemsSubtotal`, ni
 * `grossAmount`, ni `platformFee`, ni `sellerNetAmount`, ni `currency`.
 *
 * Todo eso lo deriva el backend del producto real. Un DTO que aceptara
 * `unitPrice` sería un endpoint donde alguien compra un televisor por un peso,
 * y el campo parecería inofensivo al agregarlo: "total, el frontend ya lo
 * tiene calculado".
 *
 * Tampoco `sellerId`, `storeId`, `buyerId` ni `status`. El dueño sale del
 * token y el estado lo mueve la máquina de estados, nunca el cliente.
 *
 * El cuerpo de crear una orden tiene exactamente DOS campos.
 */

export const CreateOrderSchema = z.object({
  reservationId: z.string().min(1),
  /** Cuál de sus direcciones. Sin esto, la principal. */
  addressId: z.string().min(1).optional(),
  /**
   * Si la persona retira en vez de recibir.
   *
   * ⚠️ Es lo ÚNICO del envío que aporta quien compra, y el backend sólo lo
   * respeta si la tienda ofrece retiro. Si el modo es `FIXED_PRICE`, mandar
   * `true` no evita el costo: sería un campo del cuerpo que hace despachar un
   * paquete que nadie pagó.
   */
  retiraEnPersona: z.boolean().optional(),

  /**
   * Desde qué vivo se está comprando.
   *
   * ⚠️ Es el ÚNICO campo nuevo relacionado con el precio, y **no es un
   * precio**: es de dónde viene la compra. El servidor busca si ese producto
   * tiene precio exclusivo en ese vivo, verifica que el vivo sea del mismo
   * vendedor y esté al aire, y evalúa la ventana con su propio reloj.
   *
   * Un campo que dijera cuánto sale algo sería un endpoint donde alguien
   * compra un televisor por un peso.
   */
  liveSessionId: z.string().max(40).optional(),
});
export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;

/**
 * Datos del cobro.
 *
 * `cardToken` es de un solo uso, lo genera el CardForm de Mercado Pago dentro
 * de un iframe suyo, y **no es el número de tarjeta**. El PAN nunca pasa por
 * acá: es lo que mantiene el alcance PCI en SAQ-A en vez de SAQ-D.
 */
export const CreatePaymentAttemptSchema = z.object({
  cardToken: z.string().min(8).max(200),
  /**
   * Cuotas. Hasta 24: más que eso no lo ofrece ningún emisor argentino para
   * montos de marketplace, y un número absurdo haría que Mercado Pago rechace
   * el cobro con un error que el comprador no entiende.
   */
  installments: z.coerce.number().int().min(1).max(24).default(1),
  /** `visa`, `master`, `amex`. Lo determina el CardForm, no la persona. */
  paymentMethodId: z.string().min(2).max(40),
});
export type CreatePaymentAttemptDto = z.infer<typeof CreatePaymentAttemptSchema>;

/**
 * Dirección de entrega.
 *
 * Campos separados porque el correo argentino los necesita separados. Una
 * cadena libre obliga a adivinar dónde termina la calle y empieza la altura, y
 * eso hace que un paquete vuelva al depósito.
 */
export const UpsertAddressSchema = z.object({
  recipientFullName: z.string().trim().min(3).max(80),
  documentType: z.enum(['DNI', 'CUIL', 'CUIT', 'PASAPORTE']).default('DNI'),
  /**
   * Sólo dígitos, entre 7 y 11.
   *
   * Cubre DNI (7–8) y CUIL/CUIT (11). No se valida el dígito verificador del
   * CUIL: hoy no lo exige ni Mercado Pago ni el correo, y una validación
   * fiscal mal implementada rechaza documentos válidos — que es peor que
   * aceptar uno mal tipeado.
   */
  documentNumber: z
    .string()
    .trim()
    .transform((s) => s.replace(/[.\s-]/g, ''))
    .pipe(z.string().regex(/^\d{7,11}$/, { message: 'Documento inválido' })),
  /** Formato internacional. Argentina: +549 y diez dígitos. */
  phoneE164: z
    .string()
    .trim()
    .regex(/^\+\d{8,15}$/, { message: 'El teléfono va con código de país: +5491122334455' }),

  street: z.string().trim().min(2).max(120),
  number: z.string().trim().min(1).max(12),
  floor: z.string().trim().max(10).optional(),
  apartment: z.string().trim().max(10).optional(),
  city: z.string().trim().min(2).max(80),
  province: z.string().trim().min(2).max(60),
  /** Cuatro dígitos, u ocho del formato CPA (`C1425DKE`). */
  postalCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z]?\d{4}[A-Z]{0,3})$/, { message: 'Código postal inválido' }),
  references: z.string().trim().max(200).optional(),
  isDefault: z.boolean().default(true),
});
export type UpsertAddressDto = z.infer<typeof UpsertAddressSchema>;

/**
 * Cambio de estado de preparación, que hace el VENDEDOR.
 *
 * Sólo estos tres. `DELIVERED` no está: hoy no hay forma de saber que algo se
 * entregó salvo que lo diga el vendedor, y dejarle marcar "entregado" a quien
 * cobra por entregar no es una comprobación de nada. Llega con logística.
 */
export const FulfillmentSchema = z.object({
  status: z.enum(['PREPARING', 'READY_TO_SHIP', 'SHIPPED']),
});
export type FulfillmentDto = z.infer<typeof FulfillmentSchema>;

/**
 * El codigo que el comprador le dice al repartidor.
 *
 * Seis digitos exactos. Se valida el formato antes de comparar para que un
 * cuerpo raro no consuma uno de los cinco intentos: gastar intentos de un
 * vendedor legitimo por un espacio de mas seria castigarlo por nada.
 */
export const ConfirmarEntregaSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, { message: 'El codigo tiene seis numeros' }),
});
export type ConfirmarEntregaDto = z.infer<typeof ConfirmarEntregaSchema>;

export const OrderPageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z
    .enum([
      'PENDING_PAYMENT',
      'PAID',
      'CONFIRMED',
      'PREPARING',
      'READY_TO_SHIP',
      'SHIPPED',
      'DELIVERED',
      'CANCELLED',
      'EXPIRED',
      'REFUNDED',
    ])
    .optional(),
});
export type OrderPageQueryDto = z.infer<typeof OrderPageQuerySchema>;
