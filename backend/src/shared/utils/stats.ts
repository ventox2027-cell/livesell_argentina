/**
 * Estadística descriptiva para los informes del spike.
 *
 * Se calcula en TypeScript y no en SQL a propósito: el volumen de una corrida
 * es de miles de muestras, no millones, y tener la lógica acá la hace testeable
 * sin base de datos.
 */
export interface Summary {
  count: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  stdDev: number;
}

/** Percentil por interpolación lineal (método R-7, el de Excel y NumPy). */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  if (sortedAsc.length === 1) return sortedAsc[0]!;

  const rank = (p / 100) * (sortedAsc.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAsc[lower]!;

  const weight = rank - lower;
  return sortedAsc[lower]! * (1 - weight) + sortedAsc[upper]! * weight;
}

export function summarize(values: readonly number[]): Summary | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;

  const sorted = [...clean].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;

  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: sorted[sorted.length - 1]!,
    mean: round(mean),
    stdDev: round(Math.sqrt(variance)),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
