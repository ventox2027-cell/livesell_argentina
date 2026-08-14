/**
 * La máquina de estados de un vivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO ES UN ARCHIVO APARTE Y NO UN `if` EN EL SERVICIO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque las transiciones que **no** existen importan tanto como las que sí, y
 * escritas como una tabla se pueden leer de un vistazo. Desperdigadas en
 * condicionales, nadie puede responder "¿se puede volver a LIVE desde ENDED?"
 * sin leer el servicio entero.
 *
 * Es el mismo patrón que `order-state.ts`, por la misma razón.
 */

export type EstadoDeVivo =
  | 'SCHEDULED'
  | 'STARTING'
  | 'LIVE'
  | 'RECONNECTING'
  | 'ENDING'
  | 'ENDED'
  | 'FAILED';

/**
 * Qué transiciones existen.
 *
 * ─── Las ausencias deliberadas ───
 *
 * **`ENDED → LIVE` no existe.** Un vivo terminado no se reabre. Si el vendedor
 * quiere seguir, arranca uno nuevo. Reabrir uno cerrado dejaría el resumen
 * —espectadores, ventas, duración— describiendo dos transmisiones distintas
 * como si fueran una, y las órdenes de la segunda quedarían atribuidas a la
 * primera.
 *
 * **`ENDED → ENDING` tampoco.** Terminar es terminal, y no idempotente por
 * accidente: el servicio trata el reintento explícitamente.
 *
 * **`RECONNECTING → ENDING` sí existe.** Un vendedor cuya conexión se cayó
 * puede decidir cerrar desde otro dispositivo, o el sistema puede cerrarlo tras
 * un tiempo. Sin esa transición, una sesión con la conexión perdida quedaría
 * abierta para siempre.
 *
 * **`SCHEDULED → ENDED` existe.** Preparar un vivo y arrepentirse antes de
 * salir al aire es normal, y no es un fallo.
 */
const TRANSICIONES: Record<EstadoDeVivo, EstadoDeVivo[]> = {
  SCHEDULED: ['STARTING', 'ENDED', 'FAILED'],
  STARTING: ['LIVE', 'FAILED', 'ENDING'],
  LIVE: ['RECONNECTING', 'ENDING'],
  RECONNECTING: ['LIVE', 'ENDING', 'FAILED'],
  ENDING: ['ENDED'],
  ENDED: [],
  FAILED: [],
};

export function puedeTransicionar(desde: EstadoDeVivo, hacia: EstadoDeVivo): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

export function esTerminal(estado: EstadoDeVivo): boolean {
  return TRANSICIONES[estado].length === 0;
}

/**
 * ¿Se puede comprar en este momento?
 *
 * ⚠️ **`RECONNECTING` sí permite comprar**, y es deliberado.
 *
 * Que al vendedor se le haya caído el wifi no invalida el stock ni la orden que
 * alguien está por confirmar. Bloquear la compra ahí convertiría un problema de
 * red de una persona en ventas perdidas para todos los que estaban mirando —
 * justo en el momento de más intención de compra, que es cuando el producto
 * está en pantalla.
 *
 * `ENDING` también: alguien que ya tocó comprar merece terminar.
 *
 * Lo que decide de verdad si hay stock es el UPDATE condicional del inventario.
 * Esto sólo evita ofrecer un botón que no lleva a ningún lado.
 */
export function admiteCompra(estado: EstadoDeVivo): boolean {
  return estado === 'LIVE' || estado === 'RECONNECTING' || estado === 'ENDING';
}

/** ¿El espectador debería estar viendo video? */
export function tieneVideo(estado: EstadoDeVivo): boolean {
  return estado === 'LIVE' || estado === 'RECONNECTING';
}
