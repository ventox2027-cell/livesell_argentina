import { DomainError } from '@/shared/errors/domain.error';

/**
 * El catálogo de categorías y la única regla que lo rodea.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ UNA LISTA PLANA Y NO UN ÁRBOL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La tabla `categories` tiene `parent_id` y soporta un árbol. No lo usamos.
 *
 * Un árbol obliga a quien publica a navegar «Indumentaria → Mujer → Calzado →
 * Zapatillas» para cargar un producto, y a quien busca a adivinar en qué rama
 * lo dejaron. Con catorce opciones planas, elegir es un toque y encontrar
 * también.
 *
 * Cuando una categoría tenga tantos productos que haya que partirla, la columna
 * está ahí. Partirla antes de que el problema exista es agregar navegación para
 * un catálogo vacío.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ LOS IDENTIFICADORES SON LEGIBLES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El resto del sistema usa `prefijo_<ulid>` porque son filas que crea la gente
 * y necesitan un id impredecible. Esto es lo contrario: un catálogo fijo que
 * tiene que existir igual en desarrollo, en staging y en producción.
 *
 * Con ids deterministas, la semilla es idempotente sin consultar nada, un dump
 * de una base se puede comparar con otra, y `cat_indumentaria` en un log dice
 * lo que es. Con ULIDs habría que resolver el slug en cada entorno para saber
 * de qué categoría habla un error.
 */

export interface CategoriaSemilla {
  readonly id: string;
  readonly slug: string;
  readonly nombre: string;
}

/**
 * Las categorías, en el orden en que se muestran.
 *
 * El orden no es alfabético: arriba va lo que más se vende en vivo en
 * Argentina. Quien publica encuentra la suya sin recorrer la lista entera, y
 * ese es el único criterio que importa en un selector de catorce opciones.
 *
 * «Otros» va último y existe para que nadie abandone la publicación por no
 * encontrar dónde entra lo suyo. Que se llene es una señal útil: dice qué
 * categoría falta.
 */
export const CATALOGO: readonly CategoriaSemilla[] = [
  { id: 'cat_indumentaria', slug: 'indumentaria', nombre: 'Indumentaria' },
  { id: 'cat_calzado', slug: 'calzado', nombre: 'Calzado' },
  { id: 'cat_belleza', slug: 'belleza', nombre: 'Belleza y cuidado personal' },
  { id: 'cat_accesorios', slug: 'accesorios', nombre: 'Accesorios y joyería' },
  { id: 'cat_hogar', slug: 'hogar', nombre: 'Hogar y decoración' },
  { id: 'cat_electronica', slug: 'electronica', nombre: 'Electrónica y tecnología' },
  { id: 'cat_deportes', slug: 'deportes', nombre: 'Deportes y aire libre' },
  { id: 'cat_infantil', slug: 'infantil', nombre: 'Bebés y niños' },
  { id: 'cat_mascotas', slug: 'mascotas', nombre: 'Mascotas' },
  { id: 'cat_libreria', slug: 'libreria', nombre: 'Librería y papelería' },
  { id: 'cat_coleccion', slug: 'coleccion', nombre: 'Coleccionables y usados' },
  { id: 'cat_alimentos', slug: 'alimentos', nombre: 'Alimentos y bebidas' },
  { id: 'cat_herramientas', slug: 'herramientas', nombre: 'Herramientas y repuestos' },
  { id: 'cat_otros', slug: 'otros', nombre: 'Otros' },
] as const;

/** Errores ────────────────────────────────────────────────────────────────── */

export class CategoriaInexistenteError extends DomainError {
  constructor() {
    super('CATEGORY_NOT_FOUND', 'Esa categoría no existe.');
  }
}

export class FaltaLaCategoriaError extends DomainError {
  constructor() {
    super(
      'CATEGORY_REQUIRED',
      'Elegí una categoría antes de publicar. Sin categoría el producto no aparece en las búsquedas.',
    );
  }
}

/** La regla ───────────────────────────────────────────────────────────────── */

/**
 * ¿Este producto puede estar publicado?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SE EXIGE AL PUBLICAR, NO AL CREAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El borrador se guarda sin categoría a propósito. Es el mismo criterio que ya
 * usa la conexión con Mercado Pago: alguien que se sienta a cargar cuarenta
 * productos los carga, y recién al publicar completa lo que falta. Exigirlo al
 * primero convierte «probemos esta app» en un formulario.
 *
 * Publicar es otra cosa: un producto activo sin categoría no sale en ninguna
 * navegación por rubro. Está publicado y no lo encuentra nadie, que para quien
 * vende es peor que no haberlo publicado, porque cree que está a la venta.
 *
 * Es una función y no un `if` suelto en el servicio porque hay dos caminos a
 * publicado —crear con `status: ACTIVE` y actualizar de borrador a activo— y la
 * regla tiene que ser la misma en los dos. La primera versión sólo la tenía en
 * uno.
 */
export function exigirCategoriaParaPublicar(params: {
  estadoDestino: string;
  categoriaId: string | null | undefined;
}): void {
  if (params.estadoDestino !== 'ACTIVE') return;
  if (!params.categoriaId) throw new FaltaLaCategoriaError();
}

/**
 * Cuál va a ser la categoría del producto después de aplicar el cambio.
 *
 * `undefined` significa «no lo tocan» y `null` significa «sacale la que tiene».
 * Distinguirlos importa: sin esto, un `PATCH` que sólo cambia el precio de un
 * producto publicado se leería como «se quedó sin categoría» y fallaría.
 */
export function categoriaResultante(
  actual: string | null,
  entrante: string | null | undefined,
): string | null {
  return entrante === undefined ? actual : entrante;
}
