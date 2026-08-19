import { Prisma, type OrderStatus } from '@prisma/client';

/**
 * Qué cuenta como venta, para la plata.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HABÍA TRES LISTAS Y NADIE SABÍA CUÁL ERA LA BUENA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `admin.service.ts` sumaba volumen con una lista, `risk.service.ts` contaba
 * órdenes con otra —idéntica, pero escrita aparte— y `analitica.service.ts`
 * usaba una tercera. Ninguna tenía nombre, así que agregar un estado nuevo al
 * ciclo de vida significaba acordarse de tres lugares.
 *
 * Este archivo es el único que decide qué es una venta cuando se trata de
 * dinero.
 *
 * ─── Por qué analítica sigue con la suya ───
 *
 * `analitica.service.ts` incluye `PAID` y esta lista no. **No es un descuido y
 * no se unificó a propósito.**
 *
 * Ahí se cuenta un escalón de embudo —«cuántas de las que miraron llegaron a
 * cobrarse»— y para esa pregunta una orden recién pagada YA cuenta. Acá se
 * suma plata sobre la que se van a tomar decisiones de comisión, y una orden
 * pagada que todavía no confirmó inventario puede terminar devuelta.
 *
 * Son dos preguntas distintas con dos respuestas correctas distintas.
 * Forzarlas a ser una sola habría cambiado los números que el vendedor ya ve
 * en su embudo, en silencio, para arreglar algo que no estaba roto.
 */
export const ESTADOS_CON_VENTA_CONFIRMADA = [
  'CONFIRMED',
  'PREPARING',
  'READY_TO_SHIP',
  'SHIPPED',
  'DELIVERED',
] as const satisfies readonly OrderStatus[];

/**
 * Lo que NO cuenta, dicho explícito para que se lea sin deducirlo:
 *
 *   · `PENDING_PAYMENT`, `PROCESSING_PAYMENT` — todavía no hay plata.
 *   · `PAID` — hay plata pero el inventario no se confirmó. Puede terminar en
 *     devolución.
 *   · `PAYMENT_FAILED`, `EXPIRED`, `CANCELLED` — no hubo venta.
 *   · `PAYMENT_REQUIRES_REFUND`, `REFUND_PENDING`, `REFUNDED` — la plata se
 *     está devolviendo o ya se devolvió. Una venta devuelta no es una venta.
 *
 * Esa última línea es la que implementa «las devoluciones se descuentan del
 * volumen»: no hace falta restar nada, porque la orden deja de estar en la
 * lista en cuanto su estado cambia. El descuento es automático y se ve en la
 * misma consulta.
 */

/**
 * El filtro de Prisma para todas las ventas confirmadas de un vendedor.
 *
 * Se devuelve armado y no suelto para que no haya dos maneras de escribirlo.
 */
export function ventasConfirmadasDe(sellerId: string): Prisma.OrderWhereInput {
  return { sellerId, status: { in: [...ESTADOS_CON_VENTA_CONFIRMADA] } };
}

/**
 * Lo mismo, acotado a una ventana de tiempo.
 *
 * Se corta por `createdAt` y no por `confirmedAt`, aunque `confirmedAt` parezca
 * lo natural: una orden creada dentro de la ventana pero confirmada un día
 * después entraría y saldría del cálculo según cuánto tardó el vendedor en
 * preparar el pedido, que no es una medida de volumen. `createdAt` no se mueve
 * nunca, así que la misma ventana da siempre el mismo conjunto.
 */
export function ventasDe(sellerId: string, desde: Date): Prisma.OrderWhereInput {
  return { ...ventasConfirmadasDe(sellerId), createdAt: { gte: desde } };
}

/** Cuántos días entran en la ventana móvil. Cuatro semanas. */
export const DIAS_DE_LA_VENTANA = 28;

/** Cuántas semanas representa la ventana, para sacar el promedio. */
export const SEMANAS_DE_LA_VENTANA = 4;

/**
 * El promedio semanal, a partir del total de la ventana.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ UN PROMEDIO Y NO LA ÚLTIMA SEMANA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una semana aislada se manipula: basta concentrar ventas en siete días para
 * saltar de tramo, y volver al anterior la semana siguiente.
 *
 * Y castiga la estacionalidad, que es el problema real y más frecuente: quien
 * factura fuerte en diciembre y flojo en febrero saltaría de nivel cada quince
 * días, y su comisión sería impredecible justo cuando más necesita planificar.
 *
 * Veintiocho días partidos en cuatro suavizan las dos cosas sin volverse
 * lentos: un vendedor que crece de verdad llega al tramo siguiente en un mes.
 */
export function promedioSemanal(totalDeLaVentana: number): number {
  return Math.floor(totalDeLaVentana / SEMANAS_DE_LA_VENTANA);
}

/** El inicio de la ventana, contado desde un momento dado. */
export function inicioDeLaVentana(ahora: Date): Date {
  return new Date(ahora.getTime() - DIAS_DE_LA_VENTANA * 24 * 60 * 60 * 1000);
}

/** Lo mínimo que hace falta para consultar. Evita acoplar esto a `PrismaService`. */
interface ClienteConsultable {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

/**
 * El volumen elegible de un vendedor en la ventana móvil, en centavos.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ SQL CRUDO Y NO `aggregate`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La base de comisión es `max(0, itemsSubtotal - discountAmount)` — clampeada
 * **por orden**, como en `pricing.ts`. `aggregate` sólo sabe sumar columnas
 * enteras, así que con Prisma habría que sumar las dos por separado y restarlas
 * después: `Σsubtotal − Σdescuento`.
 *
 * Y eso no da lo mismo. La restricción de la base es
 *
 *     CHECK (discount_amount <= items_subtotal + shipping_amount)
 *
 * o sea que un descuento PUEDE superar el subtotal de productos, comiéndose
 * parte del envío. En esa orden `itemsSubtotal - discountAmount` es negativo, y
 * al sumar todo junto ese negativo le restaría volumen a las demás órdenes —
 * volumen que sí se vendió.
 *
 * `GREATEST(…, 0)` por fila hace exactamente lo que hace `baseDeComision`, y
 * hace que esta consulta y la comisión de cada orden hablen de lo mismo. La
 * diferencia sería chica y siempre a la baja, así que nunca regalaría un tramo
 * que no corresponde; pero castigaría al vendedor por haber dado un cupón de
 * envío gratis, que no es lo que nadie decidió.
 *
 * Los estados salen de `ESTADOS_CON_VENTA_CONFIRMADA` interpolados como
 * parámetros, no concatenados: es la misma lista de arriba, sin una segunda
 * copia escrita a mano dentro del SQL.
 */
export async function volumenElegibleDe(
  prisma: ClienteConsultable,
  sellerId: string,
  ahora: Date,
): Promise<number> {
  const desde = inicioDeLaVentana(ahora);
  const estados = Prisma.join([...ESTADOS_CON_VENTA_CONFIRMADA]);

  const filas = await prisma.$queryRaw<Array<{ total: bigint | null }>>(Prisma.sql`
    SELECT COALESCE(SUM(GREATEST("items_subtotal" - "discount_amount", 0)), 0)::bigint AS total
    FROM "orders"
    WHERE "seller_id" = ${sellerId}
      AND "status"::text IN (${estados})
      AND "created_at" >= ${desde}
  `);

  return Number(filas[0]?.total ?? 0);
}
