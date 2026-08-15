/**
 * El filtro del chat del vivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ES UNA LISTA DE PALABRAS. NO ES INTELIGENTE Y NO PRETENDE SERLO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un clasificador —de los que hay— tendría mejor recall y un problema peor: no
 * se puede explicar. Cuando alguien reclama "¿por qué no me dejó escribir
 * esto?", la respuesta tiene que ser una línea que se puede leer, no "el modelo
 * lo puntuó alto".
 *
 * Y en un chat de compraventa argentino, un clasificador entrenado en otro
 * lado marca como agresivo medio vocabulario normal.
 *
 * ⛔ **Este filtro no sanciona a nadie.** Frena el mensaje y lo registra. Callar
 * a una persona, expulsarla o suspenderla lo decide el vendedor o moderación.
 * La distinción importa: un filtro automático que sanciona convierte cualquier
 * falso positivo en un castigo, y los falsos positivos son inevitables.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ FRENA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tres cosas, y ninguna es "malas palabras":
 *
 *   1. **Datos de contacto** — teléfonos, correos, usuarios de redes. Es lo que
 *      más daño hace en una plataforma de venta: sacar la operación afuera deja
 *      a quien compra sin ninguna protección, sin comprobante y sin forma de
 *      reclamar. Es también la forma más común de estafa;
 *   2. **Enlaces** — mismo motivo, más el phishing;
 *   3. **Una lista corta de insultos y ataques**, configurable por entorno.
 *
 * ⚠️ Putear NO está prohibido en VendoX. Un "qué caro la puta madre" es un
 * comentario de alguien mirando un precio, no acoso. La lista tiene ataques
 * dirigidos y discriminación, no palabrotas.
 *
 * ─── Módulo puro ───
 *
 * Sin base de datos y sin configuración global: la lista entra por parámetro.
 * Es la parte que más se va a ajustar —cada falso positivo es una queja— y
 * tiene que poder probarse con una tabla de casos.
 */

export type MotivoDelFiltro = 'CONTACTO' | 'ENLACE' | 'PALABRA_PROHIBIDA';

export interface ResultadoDelFiltro {
  permitido: boolean;
  motivo?: MotivoDelFiltro;
}

/**
 * Normaliza para comparar: sin acentos, sin mayúsculas, sin repeticiones.
 *
 * `HOOOOLA` y `hola` son la misma palabra, y `Ñ` y `ñ` también. Sin esto, el
 * filtro se saltea estirando una vocal, que es lo primero que prueba
 * cualquiera.
 */
export function normalizarParaFiltro(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    // Marcas diacríticas: le saca el acento a las vocales y la tilde a la ñ.
    .replace(/[̀-ͯ]/g, '')
    /**
     * Tres o más letras iguales seguidas se colapsan a UNA: `negrooo` → `negro`.
     *
     * Colapsar a dos parecía más conservador y no servía: la lista tiene
     * `negro de mierda` con una sola `o`, y `negroo de mierdaa` no la contiene.
     * El filtro se salteaba estirando una vocal, que es exactamente lo que esto
     * existe para impedir.
     *
     * Las dobles legítimas del castellano son exactamente dos —`carro`,
     * `llave`, `perro`— así que el umbral de tres no las toca.
     */
    .replace(/(.)\1{2,}/g, '$1');
}

/**
 * Un teléfono argentino, escrito como sea.
 *
 * La gente los escribe con espacios, guiones, puntos y paréntesis, y a veces
 * separa los dígitos para saltear filtros: `1 1 2 3 4 5 6 7 8 9`.
 *
 * Se cuentan los dígitos ignorando todo lo demás. Ocho o más seguidos, con a lo
 * sumo un separador entre medio, es un número de teléfono.
 */
const TELEFONO = /(?:\d[\s.\-()]{0,2}){8,}/;

/**
 * Un correo. Deliberadamente laxo.
 *
 * No se busca validar direcciones sino detectar la intención: `juan arroba
 * gmail punto com` también cuenta, y por eso hay una segunda expresión.
 */
const CORREO = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const CORREO_DISFRAZADO = /\b\w+\s*(?:arroba|@)\s*\w+\s*(?:punto|\.)\s*(?:com|ar|net|org)\b/i;

/** Un enlace, con o sin esquema. */
const ENLACE = /(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|ar|net|org|io|me|link|shop)\b/i;

/** Un usuario de red social. `@juan`, `ig: juan`, `wsp 1123456789`. */
const RED_SOCIAL = /\b(?:ig|insta|instagram|face|fb|wsp|whatsapp|telegram|tg)\b\s*[:@]\s*\S+/i;

/**
 * "Pasame tu wsp", "mandame whatsapp", "seguime en insta".
 *
 * La mención sola de una red NO alcanza: "no tengo whatsapp" es una respuesta
 * legítima y frenarla es un falso positivo gratuito. Lo que se frena es la
 * **invitación a moverse afuera**, que es la que lleva un verbo adelante.
 */
const INVITACION_A_SALIR = new RegExp(
  [
    // El verbo, en las formas que usa la gente.
    '\\b(?:',
    'pasa?me|te\\s+paso|',
    'manda?me|te\\s+mando|',
    'escribi?me|agrega?me|habla?me|contacta?me|segui?me',
    ')\\b',
    // Hasta veinte caracteres en el medio: "pasame tu", "te paso por el".
    // Acotado para no cruzar oraciones enteras.
    '[^.!?]{0,20}?',
    '\\b(?:ig|insta|instagram|face|fb|wsp|whatsapp|telegram|tg)\\b',
  ].join(''),
  'i',
);

/**
 * La lista por defecto de palabras que se frenan.
 *
 * ⚠️ Corta y con criterio: **ataques dirigidos y discriminación**, no
 * palabrotas. Putear no está prohibido en VendoX.
 *
 * Está pensada para ampliarse por configuración, no editando el código: cada
 * agregado es una decisión de moderación y tiene que poder hacerse sin
 * desplegar. Ver `CHAT_PALABRAS_PROHIBIDAS`.
 */
export const PALABRAS_PROHIBIDAS_POR_OMISION: readonly string[] = [
  // Discriminación. Escritas ya normalizadas —sin acentos, en minúscula—
  // porque así es como se comparan.
  'negro de mierda',
  'negra de mierda',
  'sudaca',
  'puto de mierda',
  'puta de mierda',
  'travesti de mierda',
  'judio de mierda',
  'judia de mierda',
  'bolita de mierda',
  'paragua de mierda',
  // Amenazas explícitas.
  'te voy a matar',
  'te voy a cagar a palos',
  'se donde vivis',
  'te voy a prender fuego',
];

/**
 * ¿Se puede publicar este mensaje?
 *
 * @param permitirContacto Los vivos son públicos y el chat también, así que el
 *   contacto se frena siempre. El parámetro existe para el día que haya un
 *   canal privado comprador–vendedor, donde intercambiar un teléfono para
 *   coordinar una entrega es legítimo.
 */
export function filtrarMensaje(
  texto: string,
  opciones: {
    palabrasProhibidas?: readonly string[];
    permitirContacto?: boolean;
  } = {},
): ResultadoDelFiltro {
  const normalizado = normalizarParaFiltro(texto);

  if (!opciones.permitirContacto) {
    /**
     * El contacto va primero porque es lo que más daño hace.
     *
     * Sacar la operación afuera de VendoX deja a quien compra sin comprobante,
     * sin protección y sin forma de reclamar — y es la forma más común de
     * estafa en una plataforma de venta.
     */
    if (TELEFONO.test(texto) || CORREO.test(texto) || CORREO_DISFRAZADO.test(normalizado)) {
      return { permitido: false, motivo: 'CONTACTO' };
    }
    if (RED_SOCIAL.test(normalizado) || INVITACION_A_SALIR.test(normalizado)) {
      return { permitido: false, motivo: 'CONTACTO' };
    }
    if (ENLACE.test(texto)) {
      return { permitido: false, motivo: 'ENLACE' };
    }
  }

  const lista = opciones.palabrasProhibidas ?? PALABRAS_PROHIBIDAS_POR_OMISION;
  for (const palabra of lista) {
    if (normalizado.includes(normalizarParaFiltro(palabra))) {
      return { permitido: false, motivo: 'PALABRA_PROHIBIDA' };
    }
  }

  return { permitido: true };
}

/**
 * Qué se le dice a quien escribió el mensaje.
 *
 * ─── Se le dice la verdad ───
 *
 * "No se pudo enviar" a secas hace que la persona lo reintente cinco veces
 * pensando que es la conexión. Decirle qué pasó le permite reescribirlo.
 *
 * ─── Pero no se le enseña a esquivarlo ───
 *
 * "Detectamos un número de teléfono" y no "los números de más de 8 dígitos
 * están prohibidos". Lo primero explica; lo segundo es un manual.
 */
export function explicacionDelFiltro(motivo: MotivoDelFiltro): string {
  switch (motivo) {
    case 'CONTACTO':
      return (
        'No se puede compartir datos de contacto en el chat. ' +
        'Comprá por la app: así tenés comprobante y podés reclamar si algo sale mal.'
      );
    case 'ENLACE':
      return 'No se pueden compartir enlaces en el chat.';
    case 'PALABRA_PROHIBIDA':
      return 'Ese mensaje no se puede enviar.';
  }
}
