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
 * Lo que se midió en la ventana. Todo en centavos.
 *
 * Se devuelven las tres cifras y no sólo el volumen porque la decisión de tramo
 * necesita las tres, y porque son las que hay que poder auditar después: con
 * sólo el resultado, un vendedor que pregunta «¿por qué no me bajó la comisión?»
 * no tiene respuesta.
 */
export interface MedicionDeVolumen {
  /** Lo que se vendió y llegó a confirmarse, ANTES de descontar devoluciones. */
  readonly brutoConfirmado: number;
  /** La parte de PRODUCTO efectivamente devuelta. Ver la nota de prorrateo. */
  readonly devuelto: number;
  /** `brutoConfirmado − devuelto`. Es lo que decide el tramo. */
  readonly volumenElegible: number;
  /** El promedio semanal del volumen elegible. */
  readonly promedioSemanal: number;
  /** `devuelto / brutoConfirmado`, en puntos básicos. 0 si no vendió nada. */
  readonly tasaDeDevolucionBps: number;
}

/**
 * Mide el volumen y las devoluciones de un vendedor en la ventana móvil.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA BASE ES `confirmed_at`, NO LA LISTA DE ESTADOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Y es una diferencia con `ESTADOS_CON_VENTA_CONFIRMADA` de arriba, a
 * propósito. Aquélla responde «¿qué ventas de este vendedor siguen en pie hoy?»
 * —lo que necesitan el panel de admin y el riesgo—. Ésta responde «¿qué llegó a
 * ser una venta alguna vez en esta ventana?».
 *
 * La tasa de devolución necesita la segunda, porque necesita un denominador.
 * Con la lista de estados, un vendedor que devuelve TODO tendría cero ventas en
 * pie: la tasa sería `0 / 0` y saldría 0 %. El que más devuelve mediría mejor
 * que nadie.
 *
 * `confirmed_at` sirve para eso porque se escribe en un solo lugar
 * —`payments.service.ts`, al confirmar— y **no se borra nunca**. Una orden
 * confirmada y después devuelta lo conserva, así que sigue contando como venta
 * que existió aunque su estado ya sea `REFUNDED`.
 *
 * Y no cambia el volumen: esa orden entra en `brutoConfirmado` y sale entera
 * por `devuelto`. El neto es el mismo que antes; lo que se gana es poder verla.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL PRORRATEO DE LA DEVOLUCIÓN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Refund.amount` se devuelve sobre el BRUTO, que incluye envío y recargo del
 * procesador. El volumen habla sólo de producto. Así que la parte de una
 * devolución que corresponde descontar es
 *
 *     devuelto_producto = monto_devuelto × base / bruto
 *
 * Con una devolución total da la base entera, que es lo correcto. Con una
 * parcial da la fracción — que es lo que pedía «una devolución parcial tiene
 * que afectar proporcionalmente».
 *
 * ⚠️ **Hoy toda devolución es total.** `payments.service.ts` crea la devolución
 * con `amount: intento.amount`, el cobro completo, y no hay ningún camino que
 * devuelva de a partes. El prorrateo está escrito igual porque el día que
 * exista la devolución parcial, este cálculo tiene que estar bien de entrada:
 * si sumara el monto sin prorratear, una devolución de $1.000 sobre una orden
 * con $800 de envío descontaría $1.000 de volumen de producto que nunca se
 * vendió.
 *
 * `LEAST(base, …)` es el techo: una devolución nunca puede sacar más valor de
 * producto del que la orden tenía. Sin él, una orden con mucho envío y varias
 * devoluciones podría restar más de lo que aportó.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SÓLO LAS DEVOLUCIONES `COMPLETED`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PENDING` y `PROCESSING` todavía no devolvieron plata, y `FAILED` no la
 * devolvió nunca. Contarlas castigaría al vendedor por una devolución que
 * quizá falle y se revierta — y la comisión ya estaría congelada en las órdenes
 * que se hicieron mientras tanto.
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
 * hace que esta consulta y la comisión de cada orden hablen de lo mismo.
 */
export async function medirVolumenDe(
  prisma: ClienteConsultable,
  sellerId: string,
  ahora: Date,
): Promise<MedicionDeVolumen> {
  const desde = inicioDeLaVentana(ahora);

  const filas = await prisma.$queryRaw<Array<{ bruto: bigint | null; devuelto: bigint | null }>>(
    Prisma.sql`
      WITH ordenes AS (
        SELECT
          "id",
          GREATEST("items_subtotal" - "discount_amount", 0) AS base,
          "gross_amount" AS bruto
        FROM "orders"
        WHERE "seller_id" = ${sellerId}
          AND "confirmed_at" IS NOT NULL
          AND "created_at" >= ${desde}
      ),
      devoluciones AS (
        SELECT r."order_id", SUM(r."amount") AS monto
        FROM "refunds" r
        JOIN ordenes o ON o."id" = r."order_id"
        WHERE r."status" = 'COMPLETED'
        GROUP BY r."order_id"
      )
      SELECT
        COALESCE(SUM(o.base), 0)::bigint AS bruto,
        COALESCE(SUM(
          LEAST(
            o.base,
            COALESCE(FLOOR(d.monto::numeric * o.base / NULLIF(o.bruto, 0)), 0)
          )
        ), 0)::bigint AS devuelto
      FROM ordenes o
      LEFT JOIN devoluciones d ON d."order_id" = o."id"
    `,
  );

  const brutoConfirmado = Number(filas[0]?.bruto ?? 0);
  const devuelto = Number(filas[0]?.devuelto ?? 0);
  const volumenElegible = Math.max(0, brutoConfirmado - devuelto);

  return {
    brutoConfirmado,
    devuelto,
    volumenElegible,
    promedioSemanal: promedioSemanal(volumenElegible),
    /**
     * Se trunca. Un vendedor con 10,004 % mide 1000 bps y queda justo en el
     * umbral en vez de pasarlo: ante la duda, la medición no lo perjudica.
     *
     * ⚠️ Este número es para MOSTRAR y AUDITAR. La comparación contra el umbral
     * se hace con enteros y sin redondear —ver `superaElUmbral`—, para que un
     * centavo no decida un tramo por un artefacto de división.
     */
    tasaDeDevolucionBps:
      brutoConfirmado === 0 ? 0 : Math.floor((devuelto * 10_000) / brutoConfirmado),
  };
}

/**
 * Si la tasa de devolución supera el umbral.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SE COMPARA CON ENTEROS, SIN DIVIDIR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     devuelto / bruto > umbral / 10000    ⟺    devuelto × 10000 > bruto × umbral
 *
 * La forma de la derecha no divide, así que no redondea, así que no hay ningún
 * caso en que un centavo caiga del lado equivocado por un artefacto de coma
 * flotante. Con dinero eso no es una sutileza: la diferencia entre 4 % y 3,5 %
 * sobre tres millones semanales son quince mil pesos por semana.
 *
 * **Estrictamente mayor.** Justo en el 10 % el vendedor conserva el descuento:
 * la regla dice «si supera», y el borde exacto no supera nada.
 *
 * Sin ventas, no supera: `0 > 0` es falso. Un vendedor sin historial no puede
 * quedar castigado por una tasa que no se pudo medir.
 */
export function superaElUmbral(
  medicion: Pick<MedicionDeVolumen, 'brutoConfirmado' | 'devuelto'>,
  umbralBps: number,
): boolean {
  return medicion.devuelto * 10_000 > medicion.brutoConfirmado * umbralBps;
}
