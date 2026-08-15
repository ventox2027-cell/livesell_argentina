/**
 * Texto que escriben personas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DOS PROBLEMAS DISTINTOS QUE SE VEN IGUAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **1. Texto ya roto.** Apareció en la base un producto llamado
 * `Vela arom�tica`: los bytes guardados son `…61 72 6f 6d EF BF BD 74…`, y
 * `EF BF BD` es U+FFFD, el carácter de reemplazo. No es un problema de cómo se
 * muestra: **está roto en el disco**.
 *
 * Lo escribió un script desde una consola de Windows con página de códigos
 * 1252: el `á` viajó como el byte suelto `0xE1`, que no es UTF-8 válido, y Node
 * lo reemplazó por U+FFFD al decodificar. Para cuando llegó a PostgreSQL ya era
 * texto perdido — el byte original no se puede recuperar.
 *
 * Un U+FFFD en algo que escribió una persona **siempre** es el resultado de una
 * decodificación fallida más arriba. Nadie lo escribe a propósito: no está en
 * ningún teclado. Así que se rechaza en la entrada, que es el único momento en
 * que todavía se puede pedir el texto de nuevo.
 *
 * **2. Texto correcto pero en dos formas.** "á" se puede escribir de dos
 * maneras en Unicode:
 *
 *   · U+00E1                    — un solo carácter (NFC)
 *   · U+0061 U+0301  = a + ´    — dos caracteres (NFD)
 *
 * Se ven idénticos y no son iguales. El teclado de iOS produce NFD en algunos
 * casos; el de Android, NFC. Sin normalizar, "Vela aromática" cargada desde un
 * iPhone no se encuentra buscando desde un Android, `to_tsvector` las indexa
 * distinto, y dos productos con el mismo nombre pasan el índice único.
 *
 * Nada de esto se ve en una pantalla. Se ve en un buscador que no encuentra.
 */

/** El carácter de reemplazo. Ver el comentario de arriba. */
const REEMPLAZO = '�';

export class TextoIlegibleError extends Error {
  constructor() {
    super(
      'El texto llegó con caracteres ilegibles. Suele pasar al copiar y pegar ' +
        'desde otro programa: volvé a escribirlo.',
    );
    this.name = 'TextoIlegibleError';
  }
}

/** ¿Este texto trae una decodificación fallida de más arriba? */
export function tieneCaracteresRotos(texto: string): boolean {
  return texto.includes(REEMPLAZO);
}

/**
 * Deja el texto en una sola forma canónica.
 *
 * NFC y no NFD: es la forma más compacta, la que produce la mayoría de los
 * teclados, y la que PostgreSQL indexa como esperaría cualquiera. Convertir a
 * NFD haría que "á" ocupe dos caracteres y que un `length` de 60 aceptara la
 * mitad de las palabras acentuadas.
 *
 * También se recortan los espacios repetidos: alguien que escribe desde el
 * teléfono pega dos espacios sin darse cuenta, y "Vela  aromática" es un
 * producto distinto de "Vela aromática" para cualquier índice único.
 */
export function normalizarTexto(texto: string): string {
  return texto.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Normaliza, o lanza si el texto ya venía roto.
 *
 * Se usa en el borde: los esquemas de entrada. Es el único lugar donde
 * rechazarlo sirve de algo — más adentro, lo único que se puede hacer es
 * guardarlo o perderlo en silencio.
 */
export function textoLimpio(texto: string): string {
  if (tieneCaracteresRotos(texto)) throw new TextoIlegibleError();
  return normalizarTexto(texto);
}
