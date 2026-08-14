import type { ReportReason } from '@prisma/client';

/**
 * Cuándo un reporte deja de ser una opinión y pasa a ser una señal.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL EQUILIBRIO QUE ESTE ARCHIVO RESUELVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dos errores posibles, y no cuestan lo mismo:
 *
 *   · **Ocultar de más.** Un vendedor legítimo pierde su publicación por una
 *     campaña de un competidor. Cuesta una venta y mucha confianza.
 *   · **Ocultar de menos.** Algo que no se puede vender —o un intento de
 *     estafa— sigue publicado hasta que alguien lo mire a mano. Cuesta la
 *     credibilidad de la plataforma entera, y en algunos casos, plata de
 *     alguien.
 *
 * La respuesta no es un número único: **depende del motivo**. Tres reportes de
 * "spam" no justifican bajar nada; uno solo de "contenido sexual" sí, porque el
 * daño de dejarlo cinco minutos más es mayor que el de ocultarlo mal.
 *
 * ─── Ocultar NO es sancionar ───
 *
 * El ocultamiento automático es preventivo y reversible: el producto deja de
 * verse, el vendedor se entera con el motivo, y una persona lo revisa. Nadie
 * queda suspendido por un umbral.
 *
 * Módulo puro: son las reglas que se van a discutir cuando alguien reclame, y
 * tienen que poder leerse enteras y probarse sin base de datos.
 */

/**
 * Cuántos reportes DISTINTOS hacen falta para ocultar preventivamente.
 *
 * "Distintos" es literal: el índice único de `Report` impide que la misma
 * persona cuente dos veces. Sin eso, una cuenta reportando veinte veces
 * dispararía cualquier umbral sola.
 *
 * `1` significa "el primero ya alcanza".
 */
const UMBRAL_POR_MOTIVO: Record<ReportReason, number> = {
  /**
   * Uno solo alcanza. Vender lo que no se puede vender —armas, drogas,
   * animales, documentos— no admite "esperemos a ver si llegan más".
   */
  PROHIBIDO: 1,
  CONTENIDO_SEXUAL: 1,

  /**
   * Dos. Una amenaza en un chat la puede reportar quien la recibió, y esperar a
   * un tercero sería pedirle que aguante.
   */
  VIOLENCIA: 2,

  /**
   * Tres. Acá el reporte suele venir de un competidor, y una falsificación no
   * siempre es evidente en una foto.
   */
  FALSIFICADO: 3,
  CONTENIDO_AJENO: 3,

  /**
   * Tres. La estafa es grave, pero "me pareció sospechoso" es de las cosas que
   * más se reportan mal — y bajar la publicación de alguien acusándolo de
   * estafa es de lo peor que le podés hacer a un vendedor honesto.
   */
  ESTAFA: 3,

  /**
   * Cinco. "No era lo que decía la foto" es una diferencia de expectativa tanto
   * como un engaño, y para eso está el sistema de reseñas.
   */
  ENGANOSO: 5,

  /**
   * Cinco. Molesta, no daña.
   */
  SPAM: 5,

  /**
   * Nunca automático. Si nadie supo en qué categoría ponerlo, una máquina
   * tampoco.
   */
  OTRO: Number.POSITIVE_INFINITY,
};

export interface ReportePorMotivo {
  reason: ReportReason;
  /** Cuántas personas distintas reportaron por este motivo. */
  cantidad: number;
}

/**
 * ¿Hay que ocultar esto ya, sin esperar a una persona?
 *
 * Devuelve el motivo que disparó, o `null`.
 *
 * Se evalúa por motivo y no sobre el total: cinco reportes repartidos entre
 * cinco motivos distintos no significan lo mismo que cinco por el mismo. El
 * primer caso es ruido; el segundo es una señal.
 */
export function motivoQueOculta(reportes: ReportePorMotivo[]): ReportReason | null {
  for (const r of reportes) {
    if (r.cantidad >= UMBRAL_POR_MOTIVO[r.reason]) return r.reason;
  }
  return null;
}

/** El umbral de un motivo. Público para poder mostrarlo en el panel. */
export function umbralDe(reason: ReportReason): number {
  return UMBRAL_POR_MOTIVO[reason];
}

/**
 * Lo que se le dice al vendedor cuando se le oculta algo.
 *
 * ─── Por qué se le dice ───
 *
 * Enterarse de que una publicación desapareció sin explicación es peor que la
 * sanción: el vendedor no sabe qué corregir, asume que fue un error del sistema
 * y vuelve a publicar lo mismo. Y si de verdad fue un error nuestro, no tiene
 * cómo reclamarlo.
 *
 * ─── Y por qué NO se le dice quién lo reportó ───
 *
 * Un vendedor que sabe quién lo reportó puede represaliar: dejarle una reseña
 * negativa, escribirle, cancelarle un pedido. Nadie reportaría dos veces.
 */
export function avisoDeOcultamiento(reason: ReportReason): string {
  switch (reason) {
    case 'PROHIBIDO':
      return 'Ocultamos tu publicación porque parece incluir algo que no se puede vender en VendoX. Una persona del equipo la está revisando.';
    case 'CONTENIDO_SEXUAL':
      return 'Ocultamos tu publicación por el contenido de las imágenes. Una persona del equipo la está revisando.';
    case 'VIOLENCIA':
      return 'Ocultamos tu publicación por reportes sobre su contenido. Una persona del equipo la está revisando.';
    case 'FALSIFICADO':
      return 'Ocultamos tu publicación por reportes de falsificación de marca. Una persona del equipo la está revisando.';
    case 'CONTENIDO_AJENO':
      return 'Ocultamos tu publicación por reportes de uso de fotos o textos de terceros. Una persona del equipo la está revisando.';
    case 'ESTAFA':
      return 'Ocultamos tu publicación mientras revisamos unos reportes. Una persona del equipo la está mirando.';
    case 'ENGANOSO':
    case 'SPAM':
    case 'OTRO':
      return 'Ocultamos tu publicación mientras la revisamos. Una persona del equipo la está mirando.';
  }
}
