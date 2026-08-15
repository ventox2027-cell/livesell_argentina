import { DomainError } from '@/shared/errors/domain.error';

/**
 * Cupones de descuento.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL DESCUENTO LO PONE EL VENDEDOR, NO VENDOX
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un cupón sale del bolsillo de la tienda que lo creó. VendoX no lo financia:
 * la comisión se cobra sobre lo que se pagó de verdad —ver `baseDeComision` en
 * `pricing.ts`—, así que un descuento del vendedor le cuesta al vendedor y a
 * VendoX le cuesta su 6 % de esa diferencia.
 *
 * Que sea así importa para lo que sigue: cada regla de acá existe para que un
 * cupón no pueda costarle al vendedor más de lo que él decidió.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL CÓDIGO ES PÚBLICO, EL DESCUENTO NO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un código de cupón se comparte por WhatsApp, se lee en un vivo, se pega en un
 * comentario. Es público por diseño. Lo que **nunca** viaja desde la app es
 * cuánto descuenta: eso lo resuelve el servidor mirando su propia base.
 *
 * Si el cuerpo de la petición pudiera decir «descuento: $9.900», cualquiera
 * compraría a un peso. Es la misma disciplina que el precio de vivo.
 */

/** Los dos tipos que existen. */
export type TipoDeCupon = 'PORCENTAJE' | 'MONTO_FIJO';

/** Un descuento del 100 % es «gratis», y eso no es un cupón: es un regalo. */
export const PORCENTAJE_MAXIMO = 80;

/** Menos de un peso no es un descuento, es ruido en el resumen de compra. */
export const DESCUENTO_MINIMO_CENTAVOS = 100;

/**
 * Cuánto tiene que quedar por pagar después del descuento.
 *
 * Una orden de $0 no se puede cobrar: Mercado Pago la rechaza, y aunque no lo
 * hiciera, no habría pago que conciliar ni comisión que cobrar. El cupón se
 * recorta para que siempre quede algo.
 */
export const RESTO_MINIMO_CENTAVOS = 100;

/** Largo del código. Corto para dictarlo en un vivo, largo para no chocar. */
export const LARGO_MINIMO_DEL_CODIGO = 4;
export const LARGO_MAXIMO_DEL_CODIGO = 20;

/**
 * Alfabeto del código.
 *
 * Mayúsculas y dígitos, sin espacios ni símbolos. Alguien va a tipearlo de
 * memoria después de escucharlo, y cada carácter que no está en esta lista es
 * una forma de escribirlo mal.
 */
const CODIGO_VALIDO = /^[A-Z0-9]+$/;

/**
 * Normaliza lo que escribió la persona.
 *
 * « verano25 » y «VERANO25» son el mismo cupón. Quien lo tipea en el teclado
 * del teléfono va a mandar minúsculas y algún espacio de más, y rechazarlo por
 * eso sería perder la venta por un detalle de tipeo.
 */
export function normalizarCodigo(codigo: string): string {
  return codigo.trim().toUpperCase();
}

export class CuponInvalidoError extends DomainError {
  constructor(mensaje: string, detalles?: Record<string, unknown>) {
    super('COUPON_INVALID', mensaje, detalles);
  }
}

/** Lo que el vendedor carga. */
export interface DatosDelCupon {
  codigo: string;
  tipo: TipoDeCupon;
  /** Porcentaje entero (1–80) o centavos, según el tipo. */
  valor: number;
  /** Compra mínima para que aplique. `null` = sin mínimo. */
  minimoCentavos?: number | null;
  /**
   * Tope del descuento, sólo para porcentaje.
   *
   * Es lo que evita que «20 % de descuento» le cueste $40.000 en la única venta
   * de $200.000 del mes. `null` = sin tope, que es una decisión válida pero
   * conviene que sea explícita.
   */
  topeCentavos?: number | null;
  desde?: Date | null;
  hasta?: Date | null;
  /** Cuántas veces puede usarse en total. `null` = ilimitado. */
  usosMaximos?: number | null;
}

/**
 * Valida lo que el vendedor quiere crear.
 *
 * Todo lo de acá protege al vendedor de sí mismo. Un cupón mal cargado no se
 * descubre revisando la pantalla: se descubre cuando llegan las ventas.
 */
export function exigirCuponValido(d: DatosDelCupon, ahora: Date = new Date()): void {
  const codigo = normalizarCodigo(d.codigo);

  if (codigo.length < LARGO_MINIMO_DEL_CODIGO || codigo.length > LARGO_MAXIMO_DEL_CODIGO) {
    throw new CuponInvalidoError(
      `El código tiene que tener entre ${LARGO_MINIMO_DEL_CODIGO} y ${LARGO_MAXIMO_DEL_CODIGO} caracteres`,
    );
  }

  if (!CODIGO_VALIDO.test(codigo)) {
    throw new CuponInvalidoError('El código sólo puede tener letras y números, sin espacios');
  }

  if (!Number.isInteger(d.valor) || d.valor <= 0) {
    throw new CuponInvalidoError('El descuento tiene que ser un número entero mayor que cero');
  }

  if (d.tipo === 'PORCENTAJE') {
    if (d.valor > PORCENTAJE_MAXIMO) {
      throw new CuponInvalidoError(
        `El descuento máximo es ${PORCENTAJE_MAXIMO} %. Más que eso no es un cupón: es regalar el producto`,
      );
    }
  } else {
    if (d.valor < DESCUENTO_MINIMO_CENTAVOS) {
      throw new CuponInvalidoError('El descuento mínimo es de un peso');
    }
    /**
     * Un monto fijo sin mínimo de compra es una trampa esperando.
     *
     * «$5.000 de descuento» en un producto de $4.000 deja la orden en cero. Se
     * recorta al vender —ver `calcularDescuento`— pero el vendedor tiene que
     * enterarse ahora, no cuando vea las ventas.
     */
    if (d.minimoCentavos != null && d.minimoCentavos <= d.valor) {
      throw new CuponInvalidoError(
        'La compra mínima tiene que ser mayor que el descuento, o el producto sale gratis',
      );
    }
  }

  if (d.topeCentavos != null) {
    if (d.tipo !== 'PORCENTAJE') {
      throw new CuponInvalidoError('El tope sólo tiene sentido en un descuento por porcentaje');
    }
    if (d.topeCentavos < DESCUENTO_MINIMO_CENTAVOS) {
      throw new CuponInvalidoError('El tope mínimo es de un peso');
    }
  }

  if (d.minimoCentavos != null && d.minimoCentavos < 0) {
    throw new CuponInvalidoError('La compra mínima no puede ser negativa');
  }

  if (d.usosMaximos != null && (!Number.isInteger(d.usosMaximos) || d.usosMaximos < 1)) {
    throw new CuponInvalidoError('El límite de usos tiene que ser al menos uno');
  }

  if (d.desde && d.hasta && d.hasta.getTime() <= d.desde.getTime()) {
    throw new CuponInvalidoError('El cupón tiene que terminar después de empezar');
  }

  if (d.hasta && d.hasta.getTime() <= ahora.getTime()) {
    // Crear algo ya vencido siempre es un error de tipeo en la fecha.
    throw new CuponInvalidoError('Ese cupón ya estaría vencido');
  }
}

/** El estado guardado de un cupón, para decidir si se puede usar. */
export interface CuponGuardado {
  readonly tipo: TipoDeCupon;
  readonly valor: number;
  readonly minimoCentavos: number | null;
  readonly topeCentavos: number | null;
  readonly desde: Date | null;
  readonly hasta: Date | null;
  readonly usosMaximos: number | null;
  readonly usos: number;
  readonly activo: boolean;
}

/** Por qué no se puede usar. Cada motivo tiene su mensaje para el comprador. */
export type MotivoDeRechazo =
  | 'NO_EXISTE'
  | 'PAUSADO'
  | 'TODAVIA_NO_EMPEZO'
  | 'VENCIDO'
  | 'AGOTADO'
  | 'YA_LO_USASTE'
  | 'NO_LLEGA_AL_MINIMO';

export const MENSAJE_DE_RECHAZO: Record<MotivoDeRechazo, string> = {
  // ⚠️ El mismo mensaje que PAUSADO, a propósito: responder distinto le diría a
  // quien prueba códigos al azar cuáles existen en esta tienda.
  NO_EXISTE: 'Ese cupón no está disponible',
  PAUSADO: 'Ese cupón no está disponible',
  TODAVIA_NO_EMPEZO: 'Ese cupón todavía no empezó',
  VENCIDO: 'Ese cupón venció',
  AGOTADO: 'Ese cupón ya se agotó',
  YA_LO_USASTE: 'Ya usaste este cupón',
  NO_LLEGA_AL_MINIMO: 'Tu compra no llega al mínimo de este cupón',
};

/**
 * Si el cupón se puede usar en esta compra.
 *
 * ⚠️ Devuelve el motivo y no un booleano. «Ese cupón no se puede usar» hace que
 * la persona lo intente tres veces más; «venció el 10 de agosto» hace que deje
 * de intentar y compre igual.
 *
 * El límite de usos se comprueba acá **y** con un UPDATE condicional al
 * canjear. Esta comprobación es para el mensaje; la que decide es la otra. Ver
 * `cupones.service.ts`.
 */
export function motivoDeRechazo(
  c: CuponGuardado,
  subtotalCentavos: number,
  ahora: Date = new Date(),
): MotivoDeRechazo | null {
  if (!c.activo) return 'PAUSADO';
  if (c.desde && ahora.getTime() < c.desde.getTime()) return 'TODAVIA_NO_EMPEZO';
  if (c.hasta && ahora.getTime() > c.hasta.getTime()) return 'VENCIDO';
  if (c.usosMaximos != null && c.usos >= c.usosMaximos) return 'AGOTADO';
  if (c.minimoCentavos != null && subtotalCentavos < c.minimoCentavos) return 'NO_LLEGA_AL_MINIMO';
  return null;
}

/**
 * Cuánto descuenta, en centavos.
 *
 * ─── Los dos recortes ───
 *
 * 1. El **tope** del cupón, si tiene. Es lo que el vendedor decidió arriesgar.
 * 2. El **resto mínimo**: siempre tiene que quedar algo por pagar. Una orden de
 *    $0 no se puede cobrar, y una negativa no significa nada.
 *
 * El segundo recorte no es una condición de borde rara: un cupón de monto fijo
 * sin mínimo de compra lo activa en cuanto alguien lo usa en un producto barato.
 *
 * ⚠️ El porcentaje redondea **hacia abajo**. Sobre un 10 % de $1.995 la
 * diferencia es un centavo, y ese centavo es del vendedor: el descuento lo paga
 * él, y no se le puede sacar más de lo que ofreció.
 */
export function calcularDescuento(c: CuponGuardado, subtotalCentavos: number): number {
  const bruto =
    c.tipo === 'PORCENTAJE'
      ? Math.floor((subtotalCentavos * c.valor) / 100)
      : c.valor;

  const conTope = c.topeCentavos != null ? Math.min(bruto, c.topeCentavos) : bruto;

  // Nunca más que el subtotal menos lo que tiene que quedar por pagar.
  const maximoPosible = Math.max(0, subtotalCentavos - RESTO_MINIMO_CENTAVOS);

  return Math.min(conTope, maximoPosible);
}
