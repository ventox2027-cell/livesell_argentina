/**
 * Cuánto sale el envío, y quién paga el costo del procesador.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * V1 MANUAL, A PROPÓSITO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El vendedor define su costo a mano. No hay cotización contra transportista:
 * eso necesita peso, volumen y origen, y pedírselo a alguien que vende tejidos
 * por Instagram es pedirle que abandone antes de publicar su primer producto.
 *
 * Cuando exista la integración automática, esto pasa a ser el respaldo para
 * quien no la use. La forma de los datos ya lo contempla.
 *
 * Archivo puro, sin Prisma: es aritmética sobre dinero que alguien va a pagar
 * de verdad, y tiene que poder probarse sin base de datos.
 */

export type ModoDeEnvio = 'FREE' | 'FIXED_PRICE' | 'PICKUP_ONLY' | 'FIXED_OR_PICKUP';
export type ModoDeCostoDeProcesador = 'ABSORBED' | 'PASSED_TO_BUYER';

export interface PoliticaDeEnvio {
  modo: ModoDeEnvio;
  /** El monto fijo. Sólo se usa en los modos que cobran. */
  montoFijo: number;
}

/**
 * Cuánto se le cobra al comprador por el envío.
 *
 * `retira` es la elección del comprador cuando la tienda ofrece las dos
 * opciones. En los demás modos se ignora: si la tienda no ofrece retiro, decir
 * que se retira no puede saltear el costo.
 */
export function costoDeEnvio(politica: PoliticaDeEnvio, retira = false): number {
  switch (politica.modo) {
    case 'FREE':
      return 0;

    // No hay envío que cobrar: se busca en persona.
    case 'PICKUP_ONLY':
      return 0;

    case 'FIXED_PRICE':
      return politica.montoFijo;

    case 'FIXED_OR_PICKUP':
      return retira ? 0 : politica.montoFijo;
  }
}

/** ¿Este modo le deja al comprador elegir retirar? */
export function permiteRetiro(modo: ModoDeEnvio): boolean {
  return modo === 'PICKUP_ONLY' || modo === 'FIXED_OR_PICKUP';
}

/** ¿Y le deja elegir envío a domicilio? */
export function permiteEnvio(modo: ModoDeEnvio): boolean {
  return modo !== 'PICKUP_ONLY';
}

/**
 * Lo que se le muestra al comprador antes de pagar.
 *
 * Nunca "gratis" cuando en realidad no hay envío: son cosas distintas y
 * confundirlas hace que alguien espere un paquete que nunca sale.
 */
export function etiquetaDeEnvio(politica: PoliticaDeEnvio, retira = false): string {
  if (politica.modo === 'PICKUP_ONLY') return 'Retiro en persona';
  if (politica.modo === 'FIXED_OR_PICKUP' && retira) return 'Retiro en persona';
  return costoDeEnvio(politica, retira) === 0 ? 'Envío gratis' : 'Envío';
}

// ═══════════════════════════════════════════════════════════════════════════
// COSTO DEL PROCESADOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Estimación del costo de Mercado Pago, en puntos básicos.
 *
 * ⚠️ **Es una estimación y así se muestra.** La tasa real depende del plazo de
 * acreditación, del medio de pago y del rubro, y Mercado Pago la informa
 * DESPUÉS de cobrar. Guardar un porcentaje fijo como si fuera cierto sería
 * mostrarle a un vendedor un neto que después no le llega.
 *
 * Se usa sólo para dos cosas, las dos declaradas como aproximadas:
 *
 *   · el recargo al comprador cuando el vendedor decide trasladarlo, que tiene
 *     que ser un número CERRADO antes de pagar — no se puede recalcular después
 *     de que alguien pagó;
 *   · el "neto estimado" del panel del vendedor.
 *
 * Cuando llega el costo real se guarda aparte y el neto se recalcula con ese.
 *
 * Configurable por entorno: el día que se negocie otra tasa, no se toca código.
 */
export const COSTO_PROCESADOR_ESTIMADO_BPS_POR_OMISION = 619;

/**
 * Base del costo del procesador: **producto + envío**.
 *
 * Es sobre lo que el procesador efectivamente cobra, porque es la plata que
 * pasa por él. Calcularlo sólo sobre el producto dejaría al vendedor pagando de
 * su bolsillo la parte del envío.
 */
export function baseDelCostoDeProcesador(itemsSubtotal: number, envio: number): number {
  return itemsSubtotal + envio;
}

/**
 * Cuánto se le suma al comprador por el medio de pago.
 *
 * Cero si el vendedor lo absorbe, que es lo predeterminado.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ APAGADO PARA LA BETA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `habilitado` viene de `BUYER_PROCESSOR_SURCHARGE_ENABLED`, que arranca en
 * `false`. Con eso, el comprador paga **producto + envío** y nada más: el costo
 * de Mercado Pago lo absorbe el vendedor.
 *
 * ─── Por qué se apaga y no se borra ───
 *
 * El número que se trasladaba era una ESTIMACIÓN —`PROCESSOR_FEE_ESTIMATE_BPS`,
 * 6,19 %— calculada antes de que Mercado Pago dijera cuánto va a cobrar de
 * verdad. Cobrarle a alguien un costo estimado de un tercero, y quedarse con la
 * diferencia cuando el real resulta menor, es exactamente el tipo de recargo
 * que la ley de defensa del consumidor mira con lupa.
 *
 * Hacerlo bien requiere conocer el costo real ANTES de cerrar el total, y eso
 * depende del medio de pago que la persona elija en el checkout, que todavía no
 * sabemos en ese momento. Es un problema resoluble, pero no para la beta.
 *
 * Se deja el modelo entero —la columna, el modo por tienda, el snapshot en cada
 * orden— porque borrarlo significaría una migración destructiva y volver a
 * escribirlo todo el día que se decida implementarlo bien. Y porque las órdenes
 * históricas ya tienen su `processorSurchargeAmount` guardado: si el cálculo
 * desapareciera, esos pedidos dejarían de cuadrar.
 *
 * ⚠️ El recargo queda CERRADO antes de pagar. Si el costo real resulta mayor,
 * la diferencia la absorbe el vendedor: cambiar el total después de que alguien
 * aceptó pagarlo no es una opción.
 */
export function recargoAlComprador(params: {
  modo: ModoDeCostoDeProcesador;
  itemsSubtotal: number;
  envio: number;
  bps: number;
  /** `BUYER_PROCESSOR_SURCHARGE_ENABLED`. Apagado en la beta. */
  habilitado: boolean;
}): number {
  if (!params.habilitado) return 0;
  if (params.modo === 'ABSORBED') return 0;

  const base = baseDelCostoDeProcesador(params.itemsSubtotal, params.envio);
  const mitad = Math.floor(10_000 / 2);
  return Math.floor((base * params.bps + mitad) / 10_000);
}
