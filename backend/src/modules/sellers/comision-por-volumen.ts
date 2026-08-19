import type { Plan } from './membresias';
import { superaElUmbral, type MedicionDeVolumen } from './volumen';

/**
 * La comisión de VendoX según el plan y el volumen.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MÓDULO PURO, A PROPÓSITO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No consulta la base ni conoce Prisma. Recibe un plan y un promedio semanal, y
 * devuelve la tasa. Así el tramo se puede probar con una tabla de valores en vez
 * de montar órdenes, y la decisión queda separada de cómo se junta el dato —que
 * es lo que hace que este archivo se pueda leer entero para auditar cuánto se
 * le cobra a quién.
 *
 * Ver `volumen.ts` para qué cuenta como venta.
 */

/** Un tramo de volumen con su comisión. */
interface Tramo {
  /** Promedio semanal a partir del cual aplica, en centavos. */
  readonly desde: number;
  readonly bps: number;
}

/**
 * Los tramos de Business, de mayor a menor exigencia.
 *
 * ─── Por qué sólo Business ───
 *
 * Free y Pro pagan la tasa base siempre. Bajar la comisión por volumen es el
 * argumento comercial de Business: «cuanto más vendés, menos pagás». Si
 * aplicara a todos los planes, Business perdería esa razón de existir.
 *
 * ─── El orden importa ───
 *
 * Se recorre de mayor a menor y se toma el primero que alcanza. Escribirlos al
 * revés daría siempre el primer tramo.
 */
const TRAMOS_BUSINESS: readonly Tramo[] = [
  /** Desde $5.000.000 por semana: 3 %. */
  { desde: 500_000_000, bps: 300 },
  /** Desde $3.000.000 por semana: 3,5 %. */
  { desde: 300_000_000, bps: 350 },
];

/**
 * Por qué se aplicó esta tasa. Se guarda en la orden para poder auditarla.
 *
 * Sin esto, dentro de seis meses una orden al 3 % es un número sin explicación:
 * no se sabe si fue por volumen, por una cortesía, o por un error. El motivo
 * hace la diferencia entre un registro contable y una anécdota.
 */
export type MotivoDeLaTasa =
  /** No es Business. Free y Pro pagan siempre la tasa base. */
  | 'PLAN_SIN_TRAMOS'
  /** Es Business, pero su volumen no alcanza el primer tramo. */
  | 'VOLUMEN_INSUFICIENTE'
  /** Business que alcanzó un tramo de volumen. */
  | 'VOLUMEN_BUSINESS'
  /**
   * Business con volumen suficiente, pero con demasiadas devoluciones.
   *
   * Es el único motivo que le SACA un descuento que ya había alcanzado, y por
   * eso tiene nombre propio: cuando el vendedor pregunte por qué no le bajó la
   * comisión, la respuesta tiene que estar guardada.
   */
  | 'DEVOLUCIONES_ALTAS';

export interface TasaAplicable {
  readonly bps: number;
  readonly motivo: MotivoDeLaTasa;
  /** El promedio semanal con el que se decidió, en centavos. */
  readonly promedioSemanal: number;
  /** La tasa de devolución medida, en puntos básicos. */
  readonly tasaDeDevolucionBps: number;
  /**
   * A qué tramo habría llegado si las devoluciones no lo hubieran frenado.
   *
   * `null` salvo en `DEVOLUCIONES_ALTAS`. Existe para que el registro diga
   * cuánto se perdió y no sólo que se perdió algo: «tenías 3 % y quedaste en
   * 4 %» es accionable, «no accediste al descuento» no.
   */
  readonly bpsQueHabriaTenido: number | null;
}

/**
 * Qué comisión le corresponde a este vendedor, ahora.
 *
 * `bpsBase` entra por parámetro y no se lee de la configuración acá adentro:
 * este módulo decide TRAMOS, no cuál es la tasa base. Esa sigue viviendo en
 * `VENDOX_PLATFORM_FEE_BPS`, en un solo lugar.
 *
 * ⚠️ Un tramo nunca sube la comisión. Si por configuración la base quedara por
 * debajo de un tramo, se respeta la base: bajarle la comisión a alguien es una
 * decisión comercial, subírsela sin avisar es otra cosa.
 */
export function tasaPara(params: {
  plan: Plan;
  bpsBase: number;
  medicion: MedicionDeVolumen;
  umbralDeDevolucionesBps: number;
}): TasaAplicable {
  const { plan, bpsBase, medicion, umbralDeDevolucionesBps } = params;
  const { promedioSemanal, tasaDeDevolucionBps } = medicion;

  const comun = { promedioSemanal, tasaDeDevolucionBps, bpsQueHabriaTenido: null };

  if (plan !== 'BUSINESS') {
    return { bps: bpsBase, motivo: 'PLAN_SIN_TRAMOS', ...comun };
  }

  const tramo = TRAMOS_BUSINESS.find((t) => promedioSemanal >= t.desde);

  if (!tramo || tramo.bps >= bpsBase) {
    return { bps: bpsBase, motivo: 'VOLUMEN_INSUFICIENTE', ...comun };
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LA SALVAGUARDA, DESPUÉS DE ELEGIR EL TRAMO Y NO ANTES
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * El orden importa para el registro, no para el resultado. Elegir primero el
   * tramo permite guardar `bpsQueHabriaTenido`: sin eso, el vendedor con
   * devoluciones altas y el que simplemente no vende lo suficiente quedarían
   * indistinguibles en la auditoría, y son dos conversaciones muy distintas.
   *
   * El descuento por volumen premia vender de verdad. Un vendedor que devuelve
   * más de lo razonable puede estar inflando la ventana con órdenes que después
   * cancela: la orden inflada se devuelve, pero el descuento que consiguió
   * queda congelado en las órdenes reales de esa misma ventana.
   *
   * No es una sanción permanente ni requiere que nadie intervenga: en cuanto la
   * tasa vuelve por debajo del umbral, el tramo vuelve solo.
   */
  if (superaElUmbral(medicion, umbralDeDevolucionesBps)) {
    return {
      bps: bpsBase,
      motivo: 'DEVOLUCIONES_ALTAS',
      promedioSemanal,
      tasaDeDevolucionBps,
      bpsQueHabriaTenido: tramo.bps,
    };
  }

  return { bps: tramo.bps, motivo: 'VOLUMEN_BUSINESS', ...comun };
}

/**
 * Los tramos, para mostrárselos al vendedor.
 *
 * Un descuento que nadie ve no motiva a nadie. Business tiene que poder ver en
 * qué tramo está y cuánto le falta para el siguiente.
 */
export function tramosDeBusiness(): readonly Tramo[] {
  return TRAMOS_BUSINESS;
}
