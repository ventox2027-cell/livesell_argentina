import { createHash } from 'node:crypto';

/**
 * Reglas puras del inventario.
 *
 * Sin Prisma, sin Nest, sin red. Todo lo que se pueda decidir mirando números
 * vive acá y se prueba en milisegundos. Lo que necesita la base —que es la
 * parte que de verdad importa— vive en `inventory.service.ts`.
 */

export type ReservationStatus = 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'CANCELLED';

/**
 * ─── Máquina de estados ───
 *
 *                    ┌──────────────┐
 *                    │    ACTIVE    │  ← el único estado que ocupa `reserved`
 *                    └───┬───┬───┬──┘
 *          consume  ┌────┘   │   └────┐  cancela el comprador
 *                   ▼        ▼        ▼
 *              CONSUMED   EXPIRED  CANCELLED
 *
 * Los tres finales son definitivos. No hay vuelta atrás desde ninguno, y esa
 * es la propiedad que hace que liberar stock dos veces sea imposible: la
 * liberación va pegada a la transición, y la transición sólo ocurre una vez.
 */
const TRANSICIONES: Readonly<Record<ReservationStatus, readonly ReservationStatus[]>> = {
  ACTIVE: ['CONSUMED', 'EXPIRED', 'CANCELLED'],
  CONSUMED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function transicionValida(desde: ReservationStatus, hacia: ReservationStatus): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

/** Estados finales: ya no ocupan stock y no cambian más. */
export function esFinal(status: ReservationStatus): boolean {
  return TRANSICIONES[status].length === 0;
}

/**
 * ─── Disponibilidad ───
 *
 * `available` no se guarda: se calcula. Persistirlo significaría mantener
 * sincronizadas tres columnas en vez de dos, y la tercera se desincronizaría
 * el día que alguien escriba un UPDATE que se olvide de ella. Restar dos
 * enteros no cuesta nada.
 */
export function disponibles(onHand: number, reserved: number): number {
  return onHand - reserved;
}

export type Availability = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

/**
 * Etiqueta pública de disponibilidad.
 *
 * Lo que se muestra afuera es la etiqueta, no el número. Publicar el stock
 * exacto de cada variante le regala a la competencia el ritmo de ventas de un
 * vendedor: consultando dos veces por día se saca cuánto vendió.
 *
 * La excepción intencional está en `LOW_STOCK`, donde "quedan 3" es
 * información que ayuda a decidir y no revela volumen. Ver `vistaPublica`.
 */
export function etiquetaDisponibilidad(
  disponible: number,
  umbral: number,
): Availability {
  if (disponible <= 0) return 'OUT_OF_STOCK';
  if (disponible <= umbral) return 'LOW_STOCK';
  return 'IN_STOCK';
}

/**
 * Lo que ve un comprador.
 *
 * `remaining` sale SÓLO cuando quedan pocas. Es una decisión de producto, no
 * una limitación: "Últimas 3" apura una compra y es verdad; "quedan 847" no le
 * sirve a nadie salvo a quien quiera medir el negocio ajeno.
 */
export function vistaPublica(
  onHand: number,
  reserved: number,
  umbral: number,
): { availability: Availability; remaining: number | null } {
  const disponible = disponibles(onHand, reserved);
  const availability = etiquetaDisponibilidad(disponible, umbral);
  return {
    availability,
    remaining: availability === 'LOW_STOCK' ? disponible : null,
  };
}

/**
 * ¿Cruzó hacia abajo el umbral de "quedan pocas"?
 *
 * Se compara el antes y el después para emitir el evento UNA vez, en el
 * cruce. Emitirlo en cada venta mientras siga bajo el umbral llenaría de ruido
 * a cualquier suscriptor futuro —notificaciones, por ejemplo— y haría que el
 * vendedor reciba diez avisos de "poco stock" seguidos.
 */
export function cruzoUmbral(
  disponibleAntes: number,
  disponibleDespues: number,
  umbral: number,
): 'low' | 'out' | 'back' | null {
  if (disponibleAntes > 0 && disponibleDespues <= 0) return 'out';
  if (disponibleAntes <= 0 && disponibleDespues > 0) return 'back';
  if (disponibleAntes > umbral && disponibleDespues <= umbral && disponibleDespues > 0) {
    return 'low';
  }
  return null;
}

/**
 * Huella del cuerpo de la petición, para detectar reuso de clave.
 *
 * SHA-256 sobre los campos que definen QUÉ se reservó. Si vuelve la misma
 * clave de idempotencia con otra variante u otra cantidad, es un error del
 * cliente y hay que decírselo, no devolverle la reserva anterior como si nada.
 */
export function huellaDePeticion(productVariantId: string, quantity: number): string {
  return createHash('sha256').update(`${productVariantId}:${quantity}`).digest('hex');
}

/**
 * Orden de bloqueo cuando una operación toca varias filas de inventario.
 *
 * ─── Por qué existe esto ahora, si hoy se reserva una sola variante ───
 *
 * Cuando llegue Orders con varios ítems, una orden va a tener que descontar
 * stock de A, B y C. Si dos órdenes hacen eso en distinto orden —una A→B, otra
 * B→A— PostgreSQL detecta el ciclo y mata una de las dos con un deadlock. No
 * es un error hipotético: es EL error clásico de este patrón, y aparece recién
 * con concurrencia real, que es cuando peor viene.
 *
 * La solución es trivial pero hay que acordarse: tomar siempre los bloqueos en
 * el mismo orden global. Se ordena por id y listo — dos transacciones que
 * pidan las mismas filas las piden en la misma secuencia, y la segunda espera
 * en vez de morir.
 *
 * Queda escrito y probado ahora, con un solo ítem, para que el día que se
 * agregue el segundo nadie tenga que redescubrirlo.
 */
export function ordenDeBloqueo(inventoryIds: readonly string[]): string[] {
  return [...new Set(inventoryIds)].sort();
}
