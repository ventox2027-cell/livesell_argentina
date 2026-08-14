/**
 * Cómo se ordena el feed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL PROBLEMA QUE ESTE ARCHIVO EXISTE PARA EVITAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un feed ordenado por popularidad se convierte en una máquina de hacer ricos a
 * los ricos: lo que tiene más "me gusta" se muestra más, y mostrarse más le da
 * más "me gusta". A las dos semanas hay cinco vendedores en la pantalla y el
 * resto no existe.
 *
 * Para VendoX eso no es un detalle de producto: es la muerte del producto. La
 * gente que vende acá vende tejidos, ropa usada, cosas hechas a mano. Si el
 * feed sólo muestra a quien ya vende, nadie más publica un segundo producto.
 *
 * Por eso el orden es **frescura con un empujón por interés**, y no al revés.
 * La antigüedad manda; el interés mueve dentro de una ventana.
 *
 * ─── Módulo puro ───
 *
 * El ranking se va a discutir mucho. Tiene que poder leerse entero de un
 * vistazo y probarse sin base de datos, para que la conversación sea sobre los
 * pesos y no sobre una consulta SQL de cuarenta líneas.
 */

/**
 * Cuánto pesa el interés frente a la frescura.
 *
 * Con 0 el feed es cronológico puro. Con 1, un producto con muchos "me gusta"
 * puede adelantar a otro de hasta un día más nuevo.
 *
 * Está en 0,35: el interés reordena dentro del día, no entre semanas.
 */
export const PESO_DEL_INTERES = 0.35;

/**
 * A partir de acá, más "me gusta" casi no suman.
 *
 * La curva es logarítmica: la diferencia entre 0 y 10 importa mucho más que la
 * diferencia entre 500 y 510. Sin eso, un producto viral se queda arriba para
 * siempre y el feed deja de ser un feed.
 */
const SATURACION = 200;

/**
 * Ventana en la que un producto se considera nuevo.
 *
 * Siete días. Es lo que tarda un vendedor chico en enterarse de si algo
 * funcionó, y darle esa ventana es la diferencia entre que publique otra cosa o
 * que abandone.
 */
export const DIAS_DE_GRACIA = 7;

/** Cuánto se le suma a algo publicado hace muy poco. */
const EMPUJON_DE_ESTRENO = 0.5;

export interface SenalesDeRanking {
  /** Cuándo se publicó. */
  creadoEl: Date;
  likes: number;
  /** Si el vendedor está transmitiendo AHORA. */
  enVivo: boolean;
  /** Si al vendedor le verificaron la identidad. */
  verificado: boolean;
}

/**
 * El puntaje de un producto. Más alto va primero.
 *
 * ─── Por qué el tiempo entra en días y no en milisegundos ───
 *
 * Con milisegundos, dos productos publicados con un segundo de diferencia
 * tienen puntajes muy distintos y ninguna señal de interés los puede reordenar.
 * En días, el interés tiene margen para trabajar dentro de la jornada, que es
 * exactamente lo que se quiere.
 */
export function puntaje(s: SenalesDeRanking, ahora: Date): number {
  const diasDeVida = Math.max(0, (ahora.getTime() - s.creadoEl.getTime()) / 86_400_000);

  /**
   * La base es negativa y crece hacia cero con la antigüedad invertida: lo
   * nuevo puntúa alto. Se usa el negativo de los días para que ordenar de mayor
   * a menor deje lo reciente arriba sin invertir nada después.
   */
  const frescura = -diasDeVida;

  // Logarítmico y acotado. Ver `SATURACION`.
  const interes = Math.log1p(Math.min(s.likes, SATURACION)) / Math.log1p(SATURACION);

  /**
   * Un vivo en curso empuja fuerte, y es el único empujón grande.
   *
   * No es favoritismo: un producto que se está mostrando en vivo AHORA se puede
   * comprar con el vendedor explicándolo, y eso es literalmente el producto que
   * estamos construyendo. Cuando el vivo termina, el empujón desaparece solo.
   */
  const empujonDeVivo = s.enVivo ? 3 : 0;

  const empujonDeEstreno = diasDeVida <= DIAS_DE_GRACIA ? EMPUJON_DE_ESTRENO : 0;

  /**
   * La verificación suma poco, a propósito.
   *
   * Es una señal de confianza, no de calidad. Si pesara mucho, un vendedor sin
   * verificar quedaría invisible — y verificarse lleva días. Alcanza con que
   * desempate.
   */
  const empujonDeVerificado = s.verificado ? 0.15 : 0;

  return (
    frescura +
    interes * PESO_DEL_INTERES +
    empujonDeVivo +
    empujonDeEstreno +
    empujonDeVerificado
  );
}

/** Ordena una lista de productos por puntaje, del mayor al menor. */
export function ordenarPorPuntaje<T>(
  items: T[],
  senalesDe: (item: T) => SenalesDeRanking,
  ahora = new Date(),
): T[] {
  return [...items]
    .map((item) => ({ item, p: puntaje(senalesDe(item), ahora) }))
    .sort((a, b) => b.p - a.p)
    .map((x) => x.item);
}

// ═══════════════════════════════════════════════════════════════════════════
// BÚSQUEDA
// ═══════════════════════════════════════════════════════════════════════════


/**
 * ¿Este caracter es de control?
 *
 * ─── Por qué una función y no un rango en una expresión regular ───
 *
 * Un rango escrito con los caracteres de verdad adentro es **invisible en el
 * editor**: los de control no se dibujan, así que el rango se ve como dos
 * símbolos cualesquiera y quien lo lea después va a creer que dice otra cosa.
 * El linter lo rechaza, y con razón.
 *
 * Comparar códigos se lee tal como suena y no tiene forma de mentir.
 */
function esDeControl(caracter: string): boolean {
  const codigo = caracter.codePointAt(0) ?? 0;
  return codigo < 0x20 || codigo === 0x7f;
}

/**
 * Prepara lo que escribió la persona para PostgreSQL.
 *
 * ─── Por qué no se manda tal cual ───
 *
 * `to_tsquery` tiene sintaxis propia: `&`, `|`, `!`, `<->`. Alguien que busca
 * "remera & short" no está escribiendo una consulta booleana, está escribiendo
 * mal — y `to_tsquery` respondería con un error de sintaxis en vez de con
 * productos.
 *
 * `websearch_to_tsquery` acepta texto natural y trata las comillas como frase
 * exacta, que es lo que la gente espera de un buscador. Esta función sólo
 * limpia lo que ni siquiera eso tolera.
 */
export function prepararBusqueda(texto: string): string | null {
  const limpio = [...texto.trim()]
    // Los caracteres de control rompen la consulta y nadie los escribe a
    // propósito.
    .map((c) => (esDeControl(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  // Menos de dos caracteres devuelve medio catálogo y no ayuda a nadie.
  if (limpio.length < 2) return null;

  // Tope: una búsqueda de mil caracteres es un intento de hacer trabajar a la
  // base, no una persona buscando una remera.
  return limpio.slice(0, 100);
}

/**
 * ¿Esta búsqueda parece un intento de abuso?
 *
 * No bloquea: sólo lo marca para que el límite por IP lo trate distinto. Una
 * persona buscando escribe palabras; un script prueba patrones.
 */
export function pareceAbuso(texto: string): boolean {
  // Muchos caracteres no alfabéticos: casi siempre es una inyección probando
  // suerte o un generador de basura.
  const raros = (texto.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;
  return raros > texto.length / 3;
}
