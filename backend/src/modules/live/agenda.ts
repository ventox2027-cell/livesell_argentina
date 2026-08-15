import { DomainError } from '@/shared/errors/domain.error';

/**
 * Programar un vivo, y avisar cuando está por empezar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PARA QUÉ SIRVE ANUNCIAR CON ANTICIPACIÓN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un vivo sin anuncio arranca con las personas que justo estaban en la app. Un
 * vivo anunciado arranca con las que decidieron estar. Para quien vende, es la
 * diferencia entre transmitirle a tres personas y transmitirle a treinta.
 *
 * Y para quien compra resuelve algo concreto: los vivos duran veinte minutos y
 * pasan. Enterarse tres horas después de que hubo una venta de lo que uno
 * estaba buscando es la queja más previsible de este producto.
 *
 * Archivo puro: son reglas de tiempo y tienen que poder probarse con un reloj
 * inventado, sin base y sin esperar.
 */

/**
 * Con cuánta anticipación mínima se puede programar.
 *
 * Quince minutos. Por debajo de eso el aviso previo no llega a servir —se
 * manda casi junto con el vivo— y la gente que lo recibe no tiene tiempo de
 * acomodarse para mirarlo.
 */
export const MINIMO_DE_ANTICIPACION_MINUTOS = 15;

/**
 * Con cuánta anticipación máxima.
 *
 * Treinta días. Más allá, la mitad de los que pusieron «recordarme» ya no se
 * van a acordar de por qué lo hicieron, y un vendedor que programa para dentro
 * de tres meses casi seguro se equivocó de año al elegir la fecha.
 */
export const MAXIMO_DE_ANTICIPACION_DIAS = 30;

/**
 * Cuánto antes se manda el aviso de «está por empezar».
 *
 * Diez minutos. Es el tiempo de terminar lo que uno está haciendo y agarrar el
 * teléfono. Con una hora, para cuando empieza ya se olvidó; con dos minutos,
 * no llega.
 */
export const AVISO_ANTES_MINUTOS = 10;

/**
 * La ventana del barrido.
 *
 * ⚠️ El barrido corre cada pocos minutos y busca vivos que empiezan dentro de
 * los próximos [AVISO_ANTES_MINUTOS]. Sin un piso inferior, un vivo que ya
 * pasó su hora seguiría entrando en «está por empezar» para siempre.
 *
 * El piso son cinco minutos DESPUÉS de la hora: alcanza para cubrir un barrido
 * que se demoró, y no tanto como para avisar de algo que ya arrancó hace rato.
 */
export const TOLERANCIA_DEL_BARRIDO_MINUTOS = 5;

export class FechaDemasiadoCercaError extends DomainError {
  constructor() {
    super(
      'SCHEDULE_TOO_SOON',
      `Programá el vivo con al menos ${MINIMO_DE_ANTICIPACION_MINUTOS} minutos de anticipación. ` +
        'Si querés empezar ahora, tocá Iniciar LIVE.',
    );
  }
}

export class FechaDemasiadoLejosError extends DomainError {
  constructor() {
    super(
      'SCHEDULE_TOO_FAR',
      `Se puede programar hasta ${MAXIMO_DE_ANTICIPACION_DIAS} días adelante.`,
    );
  }
}

/**
 * Valida la fecha elegida.
 *
 * Devuelve la fecha si sirve; lanza si no. Se separa del servicio porque es la
 * única parte que depende del reloj, y así el test le puede pasar el suyo en
 * vez de dormir quince minutos.
 */
export function exigirFechaValida(cuando: Date, ahora: Date = new Date()): Date {
  const minutos = (cuando.getTime() - ahora.getTime()) / 60_000;

  if (minutos < MINIMO_DE_ANTICIPACION_MINUTOS) throw new FechaDemasiadoCercaError();
  if (minutos > MAXIMO_DE_ANTICIPACION_DIAS * 24 * 60) throw new FechaDemasiadoLejosError();

  return cuando;
}

/**
 * ¿A este vivo hay que avisarle ahora?
 *
 * Verdadero cuando la hora de inicio cae dentro de la ventana: desde
 * [AVISO_ANTES_MINUTOS] antes hasta [TOLERANCIA_DEL_BARRIDO_MINUTOS] después.
 */
export function toca_avisar(programadoPara: Date, ahora: Date = new Date()): boolean {
  const minutosFaltantes = (programadoPara.getTime() - ahora.getTime()) / 60_000;
  return (
    minutosFaltantes <= AVISO_ANTES_MINUTOS &&
    minutosFaltantes >= -TOLERANCIA_DEL_BARRIDO_MINUTOS
  );
}

/**
 * Cómo se le cuenta a alguien cuándo es.
 *
 * ⚠️ Relativo y no una fecha absoluta, y es una decisión de producto: «en 2
 * horas» se entiende sin pensar, «20:30» obliga a mirar el reloj y restar — y
 * si además cae mañana, a mirar el calendario.
 *
 * A partir de 24 horas se usa el día, porque «en 38 horas» tampoco se entiende.
 */
export function cuandoEnCastellano(programadoPara: Date, ahora: Date = new Date()): string {
  const minutos = Math.round((programadoPara.getTime() - ahora.getTime()) / 60_000);

  if (minutos <= 0) return 'Empieza ahora';
  if (minutos < 60) return `En ${minutos} min`;

  const horas = Math.round(minutos / 60);
  if (horas < 24) return `En ${horas} ${horas === 1 ? 'hora' : 'horas'}`;

  const dias = Math.round(horas / 24);
  if (dias === 1) return 'Mañana';
  return `En ${dias} días`;
}
