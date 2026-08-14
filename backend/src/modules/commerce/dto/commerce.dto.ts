import { z } from 'zod';

import { MAX_PRICE_CENTS, MIN_PRICE_CENTS } from '@/shared/utils/money';
import { SLUG_MAX, SLUG_MIN, esSlugReservado, esSlugValido } from '@/shared/utils/slug';

/**
 * Contratos de entrada del bloque comercial.
 *
 * ─── Lo que NO se acepta, nunca ───
 *
 * `sellerId`, `storeId` de dueño, `userId`. Ninguno de esos llega del cliente.
 * La pertenencia se deriva SIEMPRE del usuario autenticado — ver
 * `OwnershipService`. Si un DTO recibiera `sellerId`, alguien podría mandar el
 * de otro y editarle el catálogo.
 *
 * Es la clase de campo que parece inofensiva al agregarla ("total, el frontend
 * lo tiene") y que abre un agujero.
 */

/** Slug propuesto por el vendedor. Opcional: si no viene, se genera del nombre. */
const SlugSchema = z
  .string()
  .min(SLUG_MIN)
  .max(SLUG_MAX)
  .transform((s) => s.trim().toLowerCase())
  .refine(esSlugValido, {
    message: 'Sólo minúsculas, números y guiones. Tiene que empezar y terminar en letra o número',
  })
  .refine((s) => !esSlugReservado(s), { message: 'Ese nombre está reservado' });

const PrecioSchema = z
  .number()
  .int({ message: 'El precio va en centavos, sin decimales' })
  .min(MIN_PRICE_CENTS, { message: 'El precio mínimo es $1' })
  .max(MAX_PRICE_CENTS, { message: 'El precio máximo es $10.000.000' });

// ─── Sellers ────────────────────────────────────────────────────────────────

export const CreateSellerSchema = z.object({
  displayName: z.string().trim().min(2).max(60),
  slug: SlugSchema.optional(),
  bio: z.string().trim().max(500).optional(),
  /** Nombre de la tienda. Si no viene, se usa el del vendedor. */
  storeName: z.string().trim().min(2).max(60).optional(),
});
export type CreateSellerDto = z.infer<typeof CreateSellerSchema>;

export const UpdateSellerSchema = z
  .object({
    displayName: z.string().trim().min(2).max(60).optional(),
    bio: z.string().trim().max(500).nullable().optional(),
    avatarUrl: z.string().url().max(500).nullable().optional(),
    coverUrl: z.string().url().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No hay nada que actualizar' });
export type UpdateSellerDto = z.infer<typeof UpdateSellerSchema>;

// ─── Stores ─────────────────────────────────────────────────────────────────

export const UpdateStoreSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    logoUrl: z.string().url().max(500).nullable().optional(),
    coverUrl: z.string().url().max(500).nullable().optional(),
    /**
     * El slug se puede cambiar pero NO se acepta en el mismo endpoint que el
     * resto: cambiarlo rompe los enlaces que la gente ya compartió, y merece
     * una confirmación explícita en la interfaz.
     */
    status: z.enum(['ACTIVE', 'PAUSED', 'CLOSED']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No hay nada que actualizar' });
export type UpdateStoreDto = z.infer<typeof UpdateStoreSchema>;

export const ChangeStoreSlugSchema = z.object({ slug: SlugSchema });
export type ChangeStoreSlugDto = z.infer<typeof ChangeStoreSlugSchema>;

/**
 * Política de envío y de quién paga el medio de pago.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ENDPOINT APARTE, IGUAL QUE EL SLUG
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No va dentro de `PATCH /stores/:id` a propósito. Esto define **plata que se
 * le va a cobrar a compradores reales** en todos los pedidos que vengan
 * después. Un campo suelto en el formulario de "editar tienda" se toca sin
 * pensar; una pantalla propia obliga a que la interfaz lo muestre entero, con
 * el ejemplo del total que va a ver quien compre.
 *
 * Las validaciones duplican los CHECK de la base a propósito: acá se puede
 * decir QUÉ está mal en castellano, y la base es la última línea de defensa
 * para cualquier camino que no pase por este esquema.
 */
export const UpdateShippingPolicySchema = z
  .object({
    shippingMode: z.enum(['FREE', 'FIXED_PRICE', 'PICKUP_ONLY', 'FIXED_OR_PICKUP']),
    /**
     * En centavos, como todo el dinero del proyecto. El tope de un millón de
     * pesos no es un límite de negocio: es que un cero de más en un formulario
     * no termine en un pedido imposible de explicar.
     */
    shippingFlatAmount: z.coerce.number().int().min(0).max(100_000_000).default(0),
    /** Texto libre del vendedor: zonas, demoras, días de entrega. */
    shippingNote: z.string().trim().max(500).nullable().optional(),
    processorFeeMode: z.enum(['ABSORBED', 'PASSED_TO_BUYER']),
  })
  .refine(
    (v) =>
      (v.shippingMode === 'FIXED_PRICE' || v.shippingMode === 'FIXED_OR_PICKUP') === (v.shippingFlatAmount > 0),
    {
      path: ['shippingFlatAmount'],
      message: 'Si cobrás el envío tenés que poner un monto, y si no lo cobrás tiene que ser cero',
    },
  );
export type UpdateShippingPolicyDto = z.infer<typeof UpdateShippingPolicySchema>;

// ─── Productos ──────────────────────────────────────────────────────────────

/**
 * Opción con sus valores, tal como la carga el vendedor.
 *
 *   { name: "Color", values: ["Negro", "Blanco"] }
 */
export const ProductOptionInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  values: z
    .array(z.string().trim().min(1).max(60))
    .min(1)
    .max(30)
    // Dos valores iguales generarían dos variantes idénticas. Se rechaza acá
    // con un mensaje claro en vez de que choque contra el índice.
    .refine((v) => new Set(v.map((x) => x.toLowerCase())).size === v.length, {
      message: 'Hay valores repetidos',
    }),
});
export type ProductOptionInput = z.infer<typeof ProductOptionInputSchema>;

export const CreateProductSchema = z
  .object({
    name: z.string().trim().min(2).max(140),
    slug: SlugSchema.optional(),
    description: z.string().trim().max(5000).optional(),
    basePriceCents: PrecioSchema,
    compareAtPriceCents: PrecioSchema.nullable().optional(),
    categoryId: z.string().max(40).nullable().optional(),
    /**
     * Ejes de variación. Si viene vacío, el producto recibe UNA variante
     * `DEFAULT` automática — ver `ProductsService`. Nunca hay un producto sin
     * variantes.
     */
    options: z.array(ProductOptionInputSchema).max(3).default([]),
    status: z.enum(['DRAFT', 'ACTIVE']).default('DRAFT'),
  })
  /**
   * Un precio tachado que no es mayor que el real es publicidad engañosa, y
   * está regulado por la ley de defensa del consumidor.
   */
  .refine((v) => v.compareAtPriceCents == null || v.compareAtPriceCents > v.basePriceCents, {
    message: 'El precio tachado tiene que ser mayor que el precio de venta',
    path: ['compareAtPriceCents'],
  })
  /**
   * Tres ejes con muchos valores explotan combinatoriamente: 30 × 30 × 30 son
   * 27.000 variantes de un solo producto. El tope evita que un error de carga
   * llene la base.
   */
  .refine(
    (v) => v.options.reduce((acc, o) => acc * o.values.length, 1) <= 200,
    { message: 'Esa combinación genera demasiadas variantes (máximo 200)', path: ['options'] },
  );
export type CreateProductDto = z.infer<typeof CreateProductSchema>;

export const UpdateProductSchema = z
  .object({
    name: z.string().trim().min(2).max(140).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    basePriceCents: PrecioSchema.optional(),
    compareAtPriceCents: PrecioSchema.nullable().optional(),
    categoryId: z.string().max(40).nullable().optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No hay nada que actualizar' });
export type UpdateProductDto = z.infer<typeof UpdateProductSchema>;

// ─── Variantes ──────────────────────────────────────────────────────────────

/**
 * Los ejes de variación del producto, completos.
 *
 * Se manda la definición entera y el backend genera las combinaciones. Editar
 * de a un eje dejaría estados intermedios donde el producto tiene talles pero
 * todavía no colores, y las variantes generadas en el medio serían basura.
 *
 * Los topes existen para que el producto cartesiano no explote: 4 ejes de 12
 * valores son 20.736 variantes.
 */
export const DefinirOpcionesSchema = z.object({
  opciones: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(40),
        values: z
          .array(z.string().trim().min(1).max(40))
          .min(1)
          .max(24)
          // Dos valores iguales generarían dos variantes idénticas que el
          // índice UNIQUE va a rechazar con un error opaco. Mejor acá.
          .refine((v) => new Set(v.map((x) => x.toLowerCase())).size === v.length, {
            message: 'Hay valores repetidos',
          }),
      }),
    )
    .max(4)
    .refine((o) => new Set(o.map((x) => x.name.toLowerCase())).size === o.length, {
      message: 'Hay ejes repetidos',
    }),
});
export type DefinirOpcionesDto = z.infer<typeof DefinirOpcionesSchema>;

export const CreateVariantSchema = z.object({
  /** Ids de los valores de opción que definen la combinación. */
  optionValueIds: z.array(z.string().max(40)).max(3).default([]),
  sku: z.string().trim().min(1).max(60).nullable().optional(),
  priceOverrideCents: PrecioSchema.nullable().optional(),
  compareAtPriceOverrideCents: PrecioSchema.nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});
export type CreateVariantDto = z.infer<typeof CreateVariantSchema>;

export const UpdateVariantSchema = z
  .object({
    sku: z.string().trim().min(1).max(60).nullable().optional(),
    priceOverrideCents: PrecioSchema.nullable().optional(),
    compareAtPriceOverrideCents: PrecioSchema.nullable().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No hay nada que actualizar' });
export type UpdateVariantDto = z.infer<typeof UpdateVariantSchema>;

// ─── Imágenes ───────────────────────────────────────────────────────────────

export const ReorderImagesSchema = z.object({
  /** Ids en el orden deseado. El primero pasa a ser la imagen principal. */
  imageIds: z.array(z.string().max(40)).min(1).max(10),
});
export type ReorderImagesDto = z.infer<typeof ReorderImagesSchema>;

// ─── Paginación ─────────────────────────────────────────────────────────────

/**
 * Paginación por cursor, no por página.
 *
 * `OFFSET 5000` obliga a PostgreSQL a leer y descartar 5000 filas, y el costo
 * crece con la profundidad. Peor: si alguien carga un producto mientras se
 * pagina, la página siguiente repite o saltea filas.
 *
 * El cursor es el id de la última fila. Como los ids son ULID —ordenables por
 * tiempo— `WHERE id < cursor ORDER BY id DESC` usa el índice primario y cuesta
 * lo mismo en la página 1 que en la 500.
 */
export const PageQuerySchema = z.object({
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PageQueryDto = z.infer<typeof PageQuerySchema>;
