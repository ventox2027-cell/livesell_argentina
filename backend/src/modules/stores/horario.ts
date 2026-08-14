/**
 * ¿La tienda está abierta ahora?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURO A PROPÓSITO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No consulta la base y no lee el reloj: recibe las franjas y el instante. Eso
 * permite probar la medianoche, el domingo a las 23:59 y el cruce de día sin
 * montar un vendedor en PostgreSQL ni manipular el reloj del sistema.
 *
 * Los horarios son de esas cosas donde todos los errores están en los bordes, y
 * los bordes sólo se prueban si probarlos es barato.
 */

export type ModoDeApertura = 'ALWAYS_OPEN' | 'SCHEDULED' | 'LIVE_ONLY';

export interface Franja {
  /** 0 = domingo, 6 = sábado. */
  weekday: number;
  opensAtMinutes: number;
  /** Si es menor que el de apertura, cruza la medianoche. */
  closesAtMinutes: number;
}

export interface EstadoDeTienda {
  abierta: boolean;
  /** Por qué. La app lo muestra tal cual. */
  motivo: string;
  /** Cuándo vuelve a abrir, si se puede saber. */
  abreEl: Date | null;
}

/**
 * Minutos desde la medianoche **en la zona de la tienda**.
 *
 * ─── Por qué no `fecha.getHours()` ───
 *
 * Porque devuelve la hora del servidor. Con el backend en São Paulo y la tienda
 * en Buenos Aires hay una hora de diferencia: una tienda que cierra a las 20:00
 * cerraría a las 19:00 para sus clientes, todos los días, sin que nada falle
 * visiblemente.
 *
 * `Intl.DateTimeFormat` con `timeZone` hace la conversión correcta, incluidos
 * los cambios de horario de verano si el país los tiene.
 */
export function minutosLocales(instante: Date, zona: string): { dia: number; minutos: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instante);

  const buscar = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '0';

  const DIAS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dia = DIAS[buscar('weekday')] ?? 0;

  /**
   * `hour12: false` puede devolver "24" para la medianoche en algunos motores.
   * Es un detalle conocido de `Intl` y produce 1440 minutos, que se sale del
   * rango — se normaliza a 0.
   */
  const hora = Number(buscar('hour')) % 24;
  const minuto = Number(buscar('minute'));

  return { dia, minutos: hora * 60 + minuto };
}

/** ¿El instante cae dentro de la franja? */
function dentroDe(franja: Franja, dia: number, minutos: number): boolean {
  const cruzaMedianoche = franja.closesAtMinutes < franja.opensAtMinutes;

  if (!cruzaMedianoche) {
    return franja.weekday === dia && minutos >= franja.opensAtMinutes && minutos < franja.closesAtMinutes;
  }

  /**
   * Una franja que cruza la medianoche cubre dos días.
   *
   * "Sábado de 22:00 a 02:00" está abierta el sábado desde las 22, y el
   * domingo hasta las 2. Tratarla como un solo día dejaría a quien vende de
   * noche cerrado justo en su mejor horario.
   */
  if (franja.weekday === dia && minutos >= franja.opensAtMinutes) return true;

  const diaAnterior = (dia + 6) % 7;
  return franja.weekday === diaAnterior && minutos < franja.closesAtMinutes;
}

export function estaAbierta(params: {
  modo: ModoDeApertura;
  zona: string;
  franjas: Franja[];
  /** Si hay una transmisión al aire. Sólo importa en modo `LIVE_ONLY`. */
  hayLive: boolean;
  ahora: Date;
}): EstadoDeTienda {
  const { modo, zona, franjas, hayLive, ahora } = params;

  if (modo === 'ALWAYS_OPEN') {
    return { abierta: true, motivo: 'Siempre abierta', abreEl: null };
  }

  if (modo === 'LIVE_ONLY') {
    return hayLive
      ? { abierta: true, motivo: 'Abierta durante la transmisión', abreEl: null }
      : {
          abierta: false,
          motivo: 'Esta tienda vende sólo en vivo',
          // No se puede saber cuándo va a transmitir. Decir una hora
          // inventada sería peor que no decir nada.
          abreEl: null,
        };
  }

  const { dia, minutos } = minutosLocales(ahora, zona);

  /**
   * Sin franjas cargadas en modo `SCHEDULED`, la tienda está cerrada.
   *
   * Es la interpretación segura: quien eligió "por horarios" y no cargó
   * ninguno no dijo "abierta siempre", dijo que quiere horarios. Abrirla por
   * omisión la dejaría vendiendo a las cuatro de la mañana sin que nadie lo
   * decidiera.
   */
  if (franjas.length === 0) {
    return {
      abierta: false,
      motivo: 'La tienda todavía no configuró sus horarios',
      abreEl: null,
    };
  }

  if (franjas.some((f) => dentroDe(f, dia, minutos))) {
    return { abierta: true, motivo: 'Abierta ahora', abreEl: null };
  }

  return {
    abierta: false,
    motivo: 'Cerrada por horario',
    abreEl: proximaApertura(franjas, dia, minutos, ahora, zona),
  };
}

/**
 * Cuándo abre la próxima vez.
 *
 * Recorre los siete días desde hoy y devuelve la primera apertura futura.
 * Siete y no infinitos: si en una semana no abre nunca, el horario está mal
 * cargado y decir "abre en tres meses" sería peor que no decir nada.
 */
function proximaApertura(
  franjas: Franja[],
  diaActual: number,
  minutosActuales: number,
  ahora: Date,
  zona: string,
): Date | null {
  for (let adelanto = 0; adelanto < 7; adelanto++) {
    const dia = (diaActual + adelanto) % 7;

    const candidatas = franjas
      .filter((f) => f.weekday === dia)
      .map((f) => f.opensAtMinutes)
      // Hoy sólo cuentan las que todavía no pasaron.
      .filter((m) => adelanto > 0 || m > minutosActuales)
      .sort((a, b) => a - b);

    const apertura = candidatas[0];
    if (apertura === undefined) continue;

    return instanteDe(ahora, zona, adelanto, apertura);
  }

  return null;
}

/**
 * Convierte "dentro de N días, a los M minutos de la medianoche local" en un
 * instante real.
 *
 * ─── Por qué se calcula por diferencia y no armando una fecha ───
 *
 * Construir un `Date` a partir de componentes locales y una zona horaria
 * requiere resolver ambigüedades que no tienen solución única: en el cambio de
 * horario de verano hay una hora que ocurre dos veces y otra que no ocurre
 * nunca.
 *
 * Partiendo de un instante que sí existe y sumando la diferencia en minutos, el
 * resultado siempre es un instante válido. Puede desviarse una hora en el día
 * exacto del cambio de horario — y es un texto informativo de "abre a las…",
 * no una decisión.
 */
function instanteDe(ahora: Date, zona: string, diasAdelante: number, minutoDelDia: number): Date {
  const { minutos: minutosAhora } = minutosLocales(ahora, zona);
  const diferencia = diasAdelante * 1440 + (minutoDelDia - minutosAhora);
  return new Date(ahora.getTime() + diferencia * 60_000);
}

/** "09:00". Para mostrar. */
export function comoHora(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
