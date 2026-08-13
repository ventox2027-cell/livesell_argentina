/**
 * Dinero.
 *
 * ─── La convención, en una línea ───
 *
 * **Enteros en centavos.** Siempre. En la base, en la API y en la app.
 *
 * `$12.500,50` es `1250050`. Nada de Float, nada de String, nada de "a veces
 * pesos y a veces centavos según el endpoint".
 *
 * El motivo es viejo y conocido: `0.1 + 0.2` no es `0.3` en punto flotante.
 * Con dinero eso no es una curiosidad, es un descuadre de caja que aparece
 * después de mil transacciones y que nadie puede explicar.
 *
 * ─── El techo ───
 *
 * `Int` de PostgreSQL llega a 2.147.483.647 centavos = **$21.474.836,47**.
 * Está muy por encima del catálogo de esta app. `MAX_PRICE_CENTS` deja margen
 * y hace que el rechazo ocurra en la validación, con un mensaje claro, y no
 * como un desborde silencioso en la base.
 */

/** $10.000.000. Un producto por encima de esto es casi seguro un error de tipeo. */
export const MAX_PRICE_CENTS = 1_000_000_000;

/** $1. Por debajo, es un error o una prueba. */
export const MIN_PRICE_CENTS = 100;

export function esPrecioValido(centavos: number): boolean {
  return (
    Number.isInteger(centavos) && centavos >= MIN_PRICE_CENTS && centavos <= MAX_PRICE_CENTS
  );
}

/**
 * Formato argentino: punto para miles, coma para decimales.
 *
 *   1250050  →  "$ 12.500,50"
 *
 * Vive en el backend porque los mensajes de error y las notificaciones se
 * arman acá. La app tiene su propia versión para lo que muestra en pantalla.
 */
export function formatearArs(centavos: number): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 2,
  }).format(centavos / 100);
}

/**
 * Precio efectivo de una variante.
 *
 * La variante manda si tiene precio propio; si no, hereda el del producto.
 * Está en una función y no repetido en cada consulta porque es la clase de
 * regla que, duplicada, termina divergiendo entre el listado y el detalle — y
 * ahí el comprador ve un precio y paga otro.
 */
export function precioEfectivo(params: {
  basePriceCents: number;
  priceOverrideCents?: number | null;
}): number {
  return params.priceOverrideCents ?? params.basePriceCents;
}

/**
 * ¿El precio tachado es legítimo?
 *
 * Un "antes" que no es mayor que el "ahora" es publicidad engañosa, y en
 * Argentina está regulado por la ley de defensa del consumidor. Se rechaza al
 * guardar y no al mostrar: un dato mal guardado reaparece en cualquier
 * pantalla que alguien agregue después.
 */
export function esComparativoValido(
  precioCents: number,
  comparativoCents: number | null | undefined,
): boolean {
  if (comparativoCents == null) return true;
  return Number.isInteger(comparativoCents) && comparativoCents > precioCents;
}
