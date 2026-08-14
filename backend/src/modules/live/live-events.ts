/**
 * Contratos de los eventos en tiempo real.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NUNCA SE MANDA UNA ENTIDAD DE PRISMA POR EL SOCKET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dos razones, y la segunda es la que muerde.
 *
 * **Filtración.** Un `product` entero lleva costos, estados internos y campos
 * que se agreguen mañana. Nadie va a acordarse de revisar qué se está enviando
 * cuando agregue una columna, y estos mensajes van a **todos** los espectadores
 * de la sala, incluido quien abrió las herramientas del navegador.
 *
 * **Contrato.** Un modelo de Prisma cambia cuando cambia la base. Si eso es lo
 * que viaja, cada migración es un cambio de contrato con miles de aplicaciones
 * instaladas que no se pueden actualizar de golpe. Los eventos de acá son
 * explícitos y versionados: se agregan campos, no se sacan.
 *
 * ─── La versión va en el nombre del evento ───
 *
 * `live.product.featured.v1`. Cuando haga falta un cambio incompatible, sale
 * `.v2` y el servidor emite los dos mientras haya aplicaciones viejas dando
 * vueltas. Una app que no conoce `.v2` lo ignora en vez de romperse.
 *
 * ─── Lo que estos eventos NO son ───
 *
 * **No son la fuente de verdad.** Avisan que algo cambió; la app confirma
 * contra la API antes de cobrar cualquier cosa. Un evento se puede perder, se
 * puede duplicar y puede llegar tarde: si el stock que muestra la pantalla
 * fuera lo que decide una venta, un mensaje perdido sería una sobreventa.
 */

export const EVENTOS = {
  /** Un mensaje de chat. */
  chat: 'live.chat.message.v1',
  /** El vendedor cambió el producto que está mostrando. */
  productoDestacado: 'live.product.featured.v1',
  /** Cambió el stock de algo que se está mostrando. */
  stock: 'live.product.stock_changed.v1',
  /** Cambió el estado del vivo. */
  estado: 'live.state_changed.v1',
  /** El vivo terminó. */
  fin: 'live.ended.v1',
  /** Cuánta gente está mirando. */
  espectadores: 'live.viewer_count.v1',
  /** Alguien compró. Sirve para la prueba social del "3 personas compraron". */
  compra: 'live.order.created.v1',
} as const;

// ─── Los cuerpos ─────────────────────────────────────────────────────────────

export interface EventoChat {
  id: string;
  /** Quién lo escribió. El id, no el email. */
  userId: string;
  /** Nombre para mostrar. Nunca el apellido completo ni el mail. */
  nombre: string;
  texto: string;
  /** Si lo escribió el vendedor del vivo: se muestra distinto. */
  esVendedor: boolean;
  fecha: string;
}

export interface EventoProductoDestacado {
  /**
   * `null` significa "dejó de destacar" y no "no hay producto". La app tiene
   * que poder ocultar el panel de compra sin adivinar.
   */
  variantId: string | null;
  productId: string | null;
  nombre: string | null;
  variante: string | null;
  imagenUrl: string | null;
  precioCentavos: number | null;
  /**
   * Cuánto queda. Es un dato **de presentación**: sirve para el "últimas 3" y
   * para deshabilitar el botón. No autoriza ninguna venta — eso lo decide el
   * UPDATE condicional del inventario cuando alguien reserva.
   */
  disponible: number | null;
  fecha: string;
}

export interface EventoStock {
  variantId: string;
  disponible: number;
  fecha: string;
}

export interface EventoEstado {
  estado: string;
  /** Para que la app muestre "el vendedor está recuperando la conexión". */
  motivo?: string | null;
  fecha: string;
}

export interface EventoFin {
  /** Si la tienda sigue abierta, el comprador puede seguir comprando. */
  tiendaAbierta: boolean;
  resumen: {
    duracionSegundos: number | null;
    espectadoresPico: number | null;
    ordenes: number | null;
  } | null;
  fecha: string;
}

export interface EventoEspectadores {
  cantidad: number;
  fecha: string;
}

export interface EventoCompra {
  /**
   * Sin id de orden ni de comprador.
   *
   * Esto va a todos los espectadores. Lo único que aporta es la prueba social
   * —"alguien acaba de comprar"— y para eso no hace falta decir quién ni qué
   * pedido. Mandar el id de la orden dejaría que cualquiera de la sala
   * enumerara las compras ajenas.
   */
  productoNombre: string;
  fecha: string;
}

/** El nombre de la sala de Socket.IO de un vivo. */
export function salaDe(liveSessionId: string): string {
  return `live:${liveSessionId}`;
}
