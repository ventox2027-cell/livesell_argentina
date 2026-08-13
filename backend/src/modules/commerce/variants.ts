/**
 * Combinatoria de variantes.
 *
 * Archivo puro, sin Prisma ni Nest, por el mismo motivo que `order-state.ts`:
 * es la lógica donde un error genera stock fantasma o combinaciones duplicadas,
 * y tiene que poder probarse sin base de datos.
 */

export interface OpcionConValores {
  /** Id de la opción ("Color"). */
  optionId: string;
  name: string;
  position: number;
  /** Valores en orden: `[{ id, value }]`. */
  values: Array<{ id: string; value: string; position: number }>;
}

export interface CombinacionVariante {
  /** Ids de valor, uno por opción, en orden de opción. */
  optionValueIds: string[];
  /** "Negro / M". */
  title: string;
  /** Huella canónica para el índice UNIQUE. */
  optionsKey: string;
}

/**
 * Nombre de la variante sin opciones.
 *
 * Todo producto tiene al menos una variante. La que no varía en nada se llama
 * así, y `isDefault` la marca.
 */
export const TITULO_DEFAULT = 'Default';
export const KEY_DEFAULT = '__default__';

/**
 * Huella canónica de una combinación.
 *
 * ─── Por qué se ordena ───
 *
 * `["negro", "talle-m"]` y `["talle-m", "negro"]` son la MISMA variante. Sin
 * ordenar, el índice UNIQUE las dejaría entrar a las dos y el producto
 * quedaría con dos "Negro / M" — cada una con su propio stock. El comprador
 * vería dos veces la misma opción y el inventario nunca cerraría.
 *
 * Se ordena por id y no por nombre: los ids son estables, los nombres los
 * puede renombrar el vendedor.
 */
export function calcularOptionsKey(optionValueIds: readonly string[]): string {
  if (optionValueIds.length === 0) return KEY_DEFAULT;
  return [...optionValueIds].sort().join('|');
}

/**
 * Genera el producto cartesiano de las opciones.
 *
 *   Color: [Negro, Blanco]
 *   Talle: [S, M, L]
 *
 *   →  Negro / S, Negro / M, Negro / L, Blanco / S, Blanco / M, Blanco / L
 *
 * El orden importa para la interfaz: el vendedor espera ver las combinaciones
 * agrupadas por el primer eje, no salteadas.
 */
export function generarCombinaciones(
  opciones: readonly OpcionConValores[],
): CombinacionVariante[] {
  if (opciones.length === 0) {
    return [{ optionValueIds: [], title: TITULO_DEFAULT, optionsKey: KEY_DEFAULT }];
  }

  // Se ordenan las opciones por posición para que el título salga
  // "Negro / M" y no "M / Negro" — el vendedor definió ese orden al cargarlas.
  const ordenadas = [...opciones].sort((a, b) => a.position - b.position);

  let acumulado: Array<Array<{ id: string; value: string }>> = [[]];

  for (const opcion of ordenadas) {
    const valores = [...opcion.values].sort((a, b) => a.position - b.position);
    const siguiente: Array<Array<{ id: string; value: string }>> = [];
    for (const parcial of acumulado) {
      for (const v of valores) {
        siguiente.push([...parcial, { id: v.id, value: v.value }]);
      }
    }
    acumulado = siguiente;
  }

  return acumulado.map((combo) => ({
    optionValueIds: combo.map((c) => c.id),
    title: combo.map((c) => c.value).join(' / '),
    optionsKey: calcularOptionsKey(combo.map((c) => c.id)),
  }));
}

/**
 * Arma el título de una variante a partir de valores sueltos.
 *
 * Se usa al crear una variante a mano, donde llegan ids sin el orden de las
 * opciones. El título tiene que salir igual que el de una generada
 * automáticamente, o el mismo producto mostraría "Negro / M" en unas y
 * "M / Negro" en otras.
 */
export function tituloDeVariante(
  optionValueIds: readonly string[],
  opciones: readonly OpcionConValores[],
): string {
  if (optionValueIds.length === 0) return TITULO_DEFAULT;

  const ordenadas = [...opciones].sort((a, b) => a.position - b.position);
  const partes: string[] = [];

  for (const opcion of ordenadas) {
    const valor = opcion.values.find((v) => optionValueIds.includes(v.id));
    if (valor) partes.push(valor.value);
  }

  return partes.length > 0 ? partes.join(' / ') : TITULO_DEFAULT;
}

/**
 * ¿La combinación es coherente con las opciones del producto?
 *
 * Tiene que traer **exactamente un valor por cada opción**. Ni de más —dos
 * colores en la misma variante no significa nada— ni de menos: una variante
 * sin talle en un producto que tiene talles no se puede vender ni contar.
 */
export function validarCombinacion(
  optionValueIds: readonly string[],
  opciones: readonly OpcionConValores[],
): { ok: true } | { ok: false; motivo: string } {
  if (opciones.length === 0) {
    return optionValueIds.length === 0
      ? { ok: true }
      : { ok: false, motivo: 'El producto no tiene opciones' };
  }

  const idsValidos = new Set(opciones.flatMap((o) => o.values.map((v) => v.id)));
  for (const id of optionValueIds) {
    if (!idsValidos.has(id)) return { ok: false, motivo: `El valor ${id} no es de este producto` };
  }

  for (const opcion of opciones) {
    const delEje = optionValueIds.filter((id) => opcion.values.some((v) => v.id === id));
    if (delEje.length === 0) return { ok: false, motivo: `Falta elegir ${opcion.name}` };
    if (delEje.length > 1) return { ok: false, motivo: `Hay más de un valor de ${opcion.name}` };
  }

  return { ok: true };
}
