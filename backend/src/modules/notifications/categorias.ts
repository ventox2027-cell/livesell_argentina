import type { NotificationType } from '@prisma/client';

/**
 * Qué avisos se pueden apagar, y cuáles no.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DOS CLASES DE AVISO, Y LA DIFERENCIA NO ES DE VOLUMEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un aviso de «el vendedor que seguís está en vivo» es una invitación: si
 * molesta, se apaga y no pasa nada.
 *
 * Un aviso de «tu pago se rechazó» es otra cosa. Es plata de una persona
 * moviéndose, y una app que deja apagarlo deja a alguien sin enterarse de que
 * su compra se cayó, con el producto sin reservar y sin saber por qué.
 *
 * Por eso los que no se pueden apagar están enumerados y no se consultan. La
 * alternativa —dejar apagar todo y confiar en que nadie apague lo importante—
 * traslada a la persona una decisión cuyas consecuencias no puede ver en el
 * momento de tomarla.
 */

/**
 * ⛔ Estos no se apagan. Nunca.
 *
 * Todos tienen la misma forma: **algo que ya pasó y afecta una operación de
 * esta persona**. No son novedades ni invitaciones; son el estado de algo que
 * la persona empezó.
 */
export const AVISOS_QUE_NO_SE_APAGAN: ReadonlySet<NotificationType> = new Set([
  // Su pedido cambió de estado: se prepara, sale, llega.
  'ORDER_STATUS',
  // Al vendedor: le entró una venta. Si no se entera, no la prepara.
  'ORDER_RECEIVED',
  'PAYMENT_APPROVED',
  // El más importante de todos: sin este, la persona cree que compró.
  'PAYMENT_REJECTED',
  // Respuesta a algo que la persona escribió pidiendo ayuda.
  'SUPPORT_REPLY',
  // Verificación, suspensión, cambios de cuenta.
  'ACCOUNT',
]);

/**
 * Las categorías que la persona puede apagar, agrupadas como se muestran.
 *
 * ⚠️ Agrupadas, y no una por tipo. Una pantalla con ocho interruptores
 * técnicos —«REVIEW_ANSWERED», «SAVED_BACK_IN_STOCK»— es una pantalla que
 * nadie configura: hay que leer los ocho para entender cuál apagar.
 *
 * Cuatro grupos con nombres de persona. Cada uno apaga los tipos que están
 * adentro.
 */
export interface CategoriaDeAviso {
  readonly clave: string;
  readonly nombre: string;
  readonly detalle: string;
  readonly tipos: readonly NotificationType[];
}

export const CATEGORIAS: readonly CategoriaDeAviso[] = [
  {
    clave: 'vivos',
    nombre: 'Vivos',
    detalle: 'Cuando alguien que seguís empieza a transmitir, y los que marcaste para recordar.',
    tipos: ['LIVE_STARTED', 'LIVE_SOON'],
  },
  {
    clave: 'guardados',
    nombre: 'Lo que guardaste',
    detalle: 'Cuando un producto que guardaste vuelve a tener stock.',
    tipos: ['SAVED_BACK_IN_STOCK'],
  },
  {
    clave: 'opiniones',
    nombre: 'Opiniones',
    detalle: 'Cuando alguien opina de tu tienda, o cuando responden la tuya.',
    tipos: ['REVIEW_RECEIVED', 'REVIEW_ANSWERED'],
  },
  {
    clave: 'tiendas',
    nombre: 'Tiendas que seguís',
    detalle: 'Cuando una tienda que te interesaba vuelve a abrir.',
    tipos: ['STORE_REOPENED'],
  },
] as const;

/** Los tipos que caen bajo una clave de categoría. */
export function tiposDe(clave: string): readonly NotificationType[] {
  return CATEGORIAS.find((c) => c.clave === clave)?.tipos ?? [];
}

/**
 * El estado de cada categoría para una persona.
 *
 * Una categoría está apagada cuando **todos** sus tipos lo están. Si alguien
 * quedó con la mitad apagada —porque agregamos un tipo a un grupo existente—
 * se muestra encendida, y volver a apagarla apaga todo. Es el comportamiento
 * menos sorprendente: lo nuevo llega encendido y se apaga con un toque.
 */
export function estadoDeCategorias(
  apagados: readonly string[],
): Array<CategoriaDeAviso & { activa: boolean }> {
  const set = new Set(apagados);
  return CATEGORIAS.map((c) => ({
    ...c,
    activa: !c.tipos.every((t) => set.has(t)),
  }));
}
