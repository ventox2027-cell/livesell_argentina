/**
 * Qué estados de un pedido merecen un aviso, y qué dicen.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO TODO CAMBIO DE ESTADO ES UNA NOVEDAD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La máquina de estados tiene once. Avisar los once convierte una compra en
 * once vibraciones del teléfono, y a la tercera la persona apaga la categoría
 * — con lo cual se pierden también las que sí importaban.
 *
 * El criterio es uno solo: **¿esto cambia algo para quien está esperando?**
 *
 *   · «Se está preparando»  → sí. Empezó a moverse.
 *   · «Listo para despachar» → sí. Falta poco.
 *   · «En camino»            → sí. Es la que todos esperan.
 *   · «Entregado»            → sí, y además habilita dejar una reseña.
 *
 * Los que quedan afuera y por qué:
 *
 *   · `PAID` y `CONFIRMED` — ya los cubre `PAYMENT_APPROVED`. Dos avisos por
 *     lo mismo, con treinta segundos de diferencia.
 *   · `PENDING_PAYMENT`, `PROCESSING_PAYMENT` — la persona está mirando la
 *     pantalla mientras pasan.
 *   · `PAYMENT_FAILED` — lo cubre `PAYMENT_REJECTED`, con el motivo adentro.
 *   · `CANCELLED`, `EXPIRED`, `REFUNDED` — merecen aviso, pero con un texto
 *     que depende de QUIÉN canceló y por qué. Hacerlos acá con un mensaje
 *     genérico sería peor que no mandarlos: «tu pedido fue cancelado» sin
 *     motivo es la clase de aviso que genera un ticket de soporte.
 *
 * Módulo puro: se prueba sin base y se lee de un vistazo, que es lo que hace
 * falta para discutir si un estado va o no va.
 */

export interface TextoDelAviso {
  readonly title: string;
  readonly body: string;
}

/**
 * Los cuatro que se avisan.
 *
 * Escritos desde el punto de vista de quien espera, no desde el del sistema:
 * el estado interno se llama `READY_TO_SHIP` y lo que la persona necesita
 * leer es «está listo».
 */
const AVISOS: Record<string, TextoDelAviso> = {
  PREPARING: {
    title: 'Están preparando tu pedido',
    body: 'El vendedor ya lo está armando.',
  },
  READY_TO_SHIP: {
    title: 'Tu pedido está listo',
    body: 'Sale para tu dirección en breve.',
  },
  SHIPPED: {
    title: '¡Tu pedido va en camino!',
    body: 'El vendedor ya lo despachó.',
  },
  DELIVERED: {
    title: 'Tu pedido llegó',
    // Se invita a reseñar acá y no en un aviso aparte: es el momento en que la
    // compra está fresca, y un segundo aviso al día siguiente es acoso.
    body: 'Si todo salió bien, contale a los demás cómo fue.',
  },
};

export function esEstadoQueSeAvisa(estado: string): boolean {
  return estado in AVISOS;
}

export function avisoDeEstado(estado: string): TextoDelAviso | null {
  return AVISOS[estado] ?? null;
}

/** Los estados que avisan, para los tests y para poder listarlos. */
export const ESTADOS_QUE_AVISAN = Object.keys(AVISOS);
