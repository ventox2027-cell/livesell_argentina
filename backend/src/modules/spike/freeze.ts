/**
 * Detección de congelamientos de video a partir de las muestras del espectador.
 *
 * ─── Por qué esto existe y no alcanza con los eventos de la sala ───
 *
 * La intuición es que el corte que sufre el espectador se mide con los eventos
 * `TRACK_UNSUBSCRIBED` → `TRACK_SUBSCRIBED`. Es falso, y la medición de campo
 * del 11/08/2026 lo demostró con números:
 *
 *   emisor pierde la red         22:14:26
 *   últimos cuadros decodificados 22:14:26   ← acá se congela la pantalla
 *   TRACK_UNSUBSCRIBED            22:14:40   ← recién acá el SFU retira el track
 *   TRACK_SUBSCRIBED              22:14:41
 *   vuelven a llegar cuadros      22:14:46
 *
 * El evento reportó un corte de 1601 ms. El espectador estuvo 20 segundos
 * mirando un cuadro congelado. El error es de 12×, y siempre hacia abajo.
 *
 * La causa es el timeout de participante del SFU: LiveKit espera ~15 s sin
 * paquetes antes de dar por caído al emisor. Durante esa ventana el track
 * sigue "vivo" desde el punto de vista de la señalización, pero no llega
 * un solo cuadro. Ninguna capa de señalización nos va a avisar de eso.
 *
 * La única señal confiable es el contador de cuadros decodificados. Si no
 * avanza, la imagen no cambia; punto. Esa es la definición operativa que usa
 * este módulo.
 *
 * ─── Consecuencia de producto (no es sólo instrumentación) ───
 *
 * La app real NO puede basar su UI de reconexión en los eventos de track. Si
 * lo hace, el espectador ve 15 segundos de imagen congelada sin ninguna
 * explicación y se va. Hay que correr este mismo watchdog EN EL CLIENTE y
 * avisar a los ~2 s. Ver blueprint/02 §reconexión.
 */

/** Lo mínimo que este módulo necesita de una muestra. */
export interface FreezeSampleLike {
  at: Date;
  framesDecoded: number | null;
  bitrateKbps: number | null;
}

export interface FreezeRun {
  /** Última vez que se vio avanzar la imagen. */
  from: Date;
  /** Primera vez que volvió a avanzar. */
  to: Date;
  durationMs: number;
  /**
   * `true` si la sesión terminó congelada. Suele ser el usuario cerrando la
   * app, no un corte de red, así que no entra en las estadísticas.
   */
  truncated: boolean;
}

export interface FreezeAnalysis {
  runs: FreezeRun[];
  /** Sólo los cortes cerrados: los que empezaron y terminaron dentro de la sesión. */
  closed: FreezeRun[];
  /** Segundos totales de imagen congelada sobre el total observado. */
  frozenPct: number | null;
  /**
   * Umbral efectivo que se usó, en ms. Es la RESOLUCIÓN del instrumento: por
   * debajo de este valor no se puede afirmar que hubo un corte. Se publica en
   * el informe para no presentar como "sin cortes" lo que en realidad es
   * "cortes más cortos que lo que sabemos medir".
   */
  thresholdMs: number;
}

/**
 * Piso del umbral.
 *
 * El cliente manda ~2 muestras por segundo, pero las estadísticas de WebRTC se
 * refrescan cada 1–2 s según la sesión: hay pares de muestras idénticas por
 * diseño del muestreo, no porque la imagen esté quieta. Un umbral por debajo
 * de esa cadencia marca congelamientos que nunca ocurrieron — la primera
 * versión de este módulo reportó 400 cortes falsos de 2 s en una sesión sin
 * un solo problema de red.
 */
export const DEFAULT_MIN_FREEZE_MS = 3_000;

/**
 * El umbral real se adapta a cada sesión: un corte es cuando la imagen se
 * queda quieta MUCHO más de lo que esa misma sesión tarda normalmente en
 * refrescarse. Con menos muestras que `MIN_GAPS_FOR_ADAPTIVE` no hay cadencia
 * que estimar y se usa el piso fijo.
 */
const GAP_MULTIPLIER = 2;
const MIN_GAPS_FOR_ADAPTIVE = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * ¿Avanzó la imagen entre dos muestras consecutivas?
 *
 * El caso raro es el contador que BAJA: pasa cuando el track se re-suscribe y
 * el contador arranca de cero. Eso no es un congelamiento, es exactamente lo
 * contrario — hay video nuevo. Tratarlo como delta 0 alargaba los cortes
 * hasta el final de la sesión.
 */
function advanced(prev: FreezeSampleLike, curr: FreezeSampleLike): boolean {
  if (prev.framesDecoded != null && curr.framesDecoded != null) {
    return curr.framesDecoded !== prev.framesDecoded;
  }
  // Sin contador de cuadros, el bitrate es el mejor sustituto disponible.
  return (curr.bitrateKbps ?? 0) > 0;
}

export function detectFreezes(
  samples: readonly FreezeSampleLike[],
  minFreezeMs: number = DEFAULT_MIN_FREEZE_MS,
): FreezeAnalysis {
  const ordered = [...samples].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (ordered.length < 2) {
    return { runs: [], closed: [], frozenPct: null, thresholdMs: minFreezeMs };
  }

  // Primera pasada: dónde avanzó la imagen y cada cuánto lo hace normalmente.
  const advanceIdx: number[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    if (advanced(ordered[i - 1]!, ordered[i]!)) advanceIdx.push(i);
  }

  const gaps: number[] = [];
  let prevIdx = 0;
  for (const i of advanceIdx) {
    gaps.push(ordered[i]!.at.getTime() - ordered[prevIdx]!.at.getTime());
    prevIdx = i;
  }

  const thresholdMs =
    gaps.length >= MIN_GAPS_FOR_ADAPTIVE
      ? Math.max(minFreezeMs, GAP_MULTIPLIER * median(gaps))
      : minFreezeMs;

  /**
   * Si la sesión arrancó SIN video (nada decodificado y sin bitrate), el primer
   * hueco es el arranque, no un corte. Ese tiempo ya lo mide `FIRST_FRAME`;
   * contarlo dos veces inflaba el p95 de cortes con un dato que no es una
   * interrupción sino una espera inicial.
   */
  const first = ordered[0]!;
  const startedDark = first.framesDecoded == null && (first.bitrateKbps ?? 0) === 0;

  const runs: FreezeRun[] = [];
  let lastAdvance = first;

  for (const [n, i] of advanceIdx.entries()) {
    const curr = ordered[i]!;
    const durationMs = curr.at.getTime() - lastAdvance.at.getTime();
    const isStartup = n === 0 && startedDark;

    if (durationMs >= thresholdMs && !isStartup) {
      runs.push({ from: lastAdvance.at, to: curr.at, durationMs, truncated: false });
    }
    lastAdvance = curr;
  }

  // Cola: la sesión terminó sin que la imagen volviera a moverse.
  const last = ordered[ordered.length - 1]!;
  const tailMs = last.at.getTime() - lastAdvance.at.getTime();
  if (tailMs >= thresholdMs && !(advanceIdx.length === 0 && startedDark)) {
    runs.push({ from: lastAdvance.at, to: last.at, durationMs: tailMs, truncated: true });
  }

  const closed = runs.filter((r) => !r.truncated);
  const observedMs = last.at.getTime() - first.at.getTime();
  const frozenMs = closed.reduce((acc, r) => acc + r.durationMs, 0);

  return {
    runs,
    closed,
    frozenPct: observedMs > 0 ? Math.round((frozenMs / observedMs) * 1000) / 10 : null,
    thresholdMs,
  };
}
