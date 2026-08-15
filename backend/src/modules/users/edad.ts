import { DomainError } from '@/shared/errors/domain.error';

/**
 * La mayoría de edad.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ VENDOX ES 18+
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No es una preferencia de producto: en Argentina la capacidad para contratar
 * se adquiere a los 18 (Código Civil y Comercial, art. 25 y 26). Una compra es
 * un contrato, y una venta con emisión de comprobantes lo es todavía más.
 *
 * Un menor comprando en la plataforma deja a VendoX con operaciones anulables y
 * al vendedor con una venta que puede deshacerse. Un menor **vendiendo** es
 * peor: hay una cuenta bancaria, retenciones y responsabilidad fiscal detrás.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ES DECLARADA, Y ESO SE DICE EN VOZ ALTA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La fecha la escribe la persona. No hay verificación contra RENAPER todavía
 * —no hay integración, y montarla es contratar un servicio— así que alguien
 * decidido puede mentir.
 *
 * Lo que esto sí hace, y no es poco:
 *
 *   · deja constancia de que se preguntó y de qué se respondió, que es lo que
 *     mueve la responsabilidad de la plataforma a quien declaró en falso;
 *   · frena al que no está mintiendo, que es la mayoría: alguien de 16 que pone
 *     su fecha real no entra;
 *   · deja el dato listo para el día que exista el proveedor real, sin
 *     migración ni volver a preguntarle a nadie.
 *
 * ⛔ Lo que NO hay que hacer es escribir en la interfaz que la edad está
 * "verificada". No lo está. Ver el copy de la app.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CUÁNDO SE PREGUNTA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No al registrarse. El alta con Google o Apple es de dos toques y meterle un
 * formulario en el medio es la forma más cara de perder gente que todavía no
 * sabe si la app le sirve.
 *
 * Se pregunta **antes de comprar** y **antes de crear la tienda**, que es el
 * mismo criterio con el que se pide el teléfono. Mirar un vivo no requiere
 * nada.
 *
 * ─── Módulo puro ───
 *
 * Todo lo que sigue es aritmética de fechas sin base de datos. La aritmética de
 * fechas es donde viven los errores de borde —el 29 de febrero, el que cumple
 * hoy, el huso horario— y tiene que poder probarse con una tabla de casos.
 */

/** Los 18 del Código Civil y Comercial argentino. */
export const MAYORIA_DE_EDAD = 18;

/**
 * La persona más vieja documentada vivió 122 años. 130 deja margen y descarta
 * un `1899` tipeado de más.
 */
export const EDAD_MAXIMA_RAZONABLE = 130;

/**
 * Los años cumplidos.
 *
 * ─── El día del cumpleaños ya cuenta ───
 *
 * Quien cumple 18 hoy es mayor hoy, no mañana. Comparar sólo el año daría 18 a
 * alguien que los cumple en diciembre desde el 1 de enero; comparar timestamps
 * con `365.25` días le daría la edad un día tarde a la mitad de la gente.
 *
 * Se comparan mes y día, que es como se cuenta la edad en castellano y en el
 * artículo que la regula.
 *
 * ─── El 29 de febrero ───
 *
 * Alguien nacido el 29/2/2008 cumple 18 en 2026, que no es bisiesto. Con esta
 * comparación los cumple el 1 de marzo: en febrero el mes es igual y el día
 * (29) es mayor que cualquier día de ese febrero, así que todavía no. Es la
 * lectura conservadora y coincide con la práctica registral argentina.
 */
export function edadEn(nacimiento: Date, ahora: Date): number {
  let anios = ahora.getUTCFullYear() - nacimiento.getUTCFullYear();

  const mes = ahora.getUTCMonth() - nacimiento.getUTCMonth();
  const dia = ahora.getUTCDate() - nacimiento.getUTCDate();
  if (mes < 0 || (mes === 0 && dia < 0)) anios -= 1;

  return anios;
}

export function esMayorDeEdad(nacimiento: Date, ahora: Date = new Date()): boolean {
  return edadEn(nacimiento, ahora) >= MAYORIA_DE_EDAD;
}

export type FechaInvalida = 'FUTURO' | 'DEMASIADO_VIEJA' | 'NO_ES_FECHA';

/**
 * ¿Esta fecha puede ser la de nacimiento de alguien?
 *
 * Separado de la mayoría de edad a propósito: son dos rechazos distintos y la
 * persona necesita mensajes distintos. "Revisá la fecha" y "tenés que ser mayor
 * de 18" no son lo mismo, y confundirlos hace que alguien que se equivocó de
 * año crea que la app lo está acusando de menor.
 */
export function fechaDeNacimientoInvalida(
  nacimiento: Date,
  ahora: Date = new Date(),
): FechaInvalida | null {
  if (Number.isNaN(nacimiento.getTime())) return 'NO_ES_FECHA';
  if (nacimiento.getTime() > ahora.getTime()) return 'FUTURO';
  if (edadEn(nacimiento, ahora) > EDAD_MAXIMA_RAZONABLE) return 'DEMASIADO_VIEJA';
  return null;
}

/**
 * Convierte `AAAA-MM-DD` en una fecha, sin que el huso horario opine.
 *
 * ─── Por qué no `new Date('2008-03-15')` ───
 *
 * Eso funciona, pero `new Date('2008-3-15')` —sin el cero— se interpreta en
 * hora LOCAL en vez de UTC, y las dos cadenas conviven en cualquier sistema que
 * haya tenido más de un cliente. La diferencia son tres horas, que es
 * exactamente lo que hace falta para que alguien cumpla años un día antes.
 *
 * Construir desde los números elimina la interpretación: `Date.UTC` no tiene
 * ambigüedad posible.
 *
 * Devuelve una fecha inválida si la cadena no tiene la forma esperada. No
 * lanza: quien llama decide qué error corresponde, y `fechaDeNacimientoInvalida`
 * ya sabe reconocer `Invalid Date`.
 */
export function parsearFechaDeNacimiento(texto: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!m) return new Date(NaN);

  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));

  /**
   * `Date.UTC(2008, 1, 31)` no falla: devuelve el 2 de marzo.
   *
   * Sin esta comprobación, un 31 de febrero se guardaría como marzo y la
   * persona vería una fecha que no escribió. Se compara lo que salió con lo que
   * entró.
   */
  if (
    fecha.getUTCFullYear() !== anio ||
    fecha.getUTCMonth() !== mes - 1 ||
    fecha.getUTCDate() !== dia
  ) {
    return new Date(NaN);
  }

  return fecha;
}

/** Mismo día, ignorando la hora. Para comparar lo declarado con lo guardado. */
export function mismaFecha(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LOS ERRORES
// ═══════════════════════════════════════════════════════════════════════════

/** Qué se estaba intentando. Cambia el mensaje, no la regla. */
export type AccionQueRequiereEdad = 'comprar' | 'vender';

export class FaltaLaFechaDeNacimientoError extends DomainError {
  constructor(accion: AccionQueRequiereEdad) {
    super('BIRTH_DATE_REQUIRED', mensajeDeFalta(accion), { accion });
  }
}

function mensajeDeFalta(accion: AccionQueRequiereEdad): string {
  return accion === 'comprar'
    ? 'Antes de tu primera compra necesitamos tu fecha de nacimiento. VendoX es para mayores de 18.'
    : 'Para abrir tu tienda necesitamos tu fecha de nacimiento. Vender en VendoX es para mayores de 18.';
}

export class MenorDeEdadError extends DomainError {
  constructor(accion: AccionQueRequiereEdad) {
    /**
     * El mensaje no reta ni sermonea.
     *
     * Lo lee alguien de dieciséis años que no hizo nada malo. Decirle "no
     * cumplís con nuestros términos" lo trata de infractor; decirle que hay una
     * edad mínima y por qué, no.
     */
    super(
      'UNDERAGE',
      accion === 'comprar'
        ? 'Para comprar en VendoX hay que tener 18 años. Es un requisito legal, no una decisión nuestra.'
        : 'Para vender en VendoX hay que tener 18 años. Es un requisito legal, no una decisión nuestra.',
      { accion },
    );
  }
}

export class FechaDeNacimientoInvalidaError extends DomainError {
  constructor(motivo: FechaInvalida) {
    super('BIRTH_DATE_INVALID', mensajeDeInvalida(motivo), { motivo });
  }
}

function mensajeDeInvalida(motivo: FechaInvalida): string {
  switch (motivo) {
    case 'FUTURO':
      return 'Esa fecha todavía no llegó. Revisá el año.';
    case 'DEMASIADO_VIEJA':
      return 'Revisá el año: esa fecha no parece correcta.';
    case 'NO_ES_FECHA':
      return 'No pudimos leer esa fecha. Probá de nuevo.';
  }
}

export class FechaDeNacimientoYaDeclaradaError extends DomainError {
  constructor() {
    /**
     * Se dice a dónde ir, no sólo que no se puede.
     *
     * Quien lee esto es, casi siempre, alguien que tipeó mal el año y lo está
     * corrigiendo. Un "no se puede cambiar" a secas lo deja sin salida.
     */
    super(
      'BIRTH_DATE_ALREADY_SET',
      'Tu fecha de nacimiento ya está cargada y no se puede cambiar desde acá. ' +
        'Si te equivocaste, escribinos desde Ayuda y lo corregimos.',
    );
  }
}

/**
 * La comprobación completa, para los puntos donde hay que frenar.
 *
 * Se separa de `esMayorDeEdad` porque la app también necesita PREGUNTAR sin que
 * eso sea un error: la pantalla de perfil muestra si falta cargar la fecha, y
 * para eso hace falta la respuesta, no una excepción.
 */
export function exigirMayoriaDeEdad(
  nacimiento: Date | null | undefined,
  accion: AccionQueRequiereEdad,
  ahora: Date = new Date(),
): void {
  if (!nacimiento) throw new FaltaLaFechaDeNacimientoError(accion);

  const invalida = fechaDeNacimientoInvalida(nacimiento, ahora);
  if (invalida) throw new FechaDeNacimientoInvalidaError(invalida);

  if (!esMayorDeEdad(nacimiento, ahora)) throw new MenorDeEdadError(accion);
}
