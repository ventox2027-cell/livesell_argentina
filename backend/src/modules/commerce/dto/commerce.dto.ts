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
