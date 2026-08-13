import { describe, expect, it } from 'vitest';

import { percentile, summarize } from '@/shared/utils/stats';

describe('percentile', () => {
  it('interpola linealmente (método R-7)', () => {
    const v = [10, 20, 30, 40, 50];
    expect(percentile(v, 0)).toBe(10);
    expect(percentile(v, 50)).toBe(30);
    expect(percentile(v, 100)).toBe(50);
    expect(percentile(v, 25)).toBe(20);
    expect(percentile(v, 75)).toBe(40);
  });

  it('devuelve el único valor cuando hay un solo dato', () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it('devuelve NaN con una lista vacía en lugar de romper', () => {
    expect(Number.isNaN(percentile([], 95))).toBe(true);
  });
});

describe('summarize', () => {
  it('calcula el resumen completo', () => {
    const s = summarize([100, 200, 300, 400, 500])!;
    expect(s.count).toBe(5);
    expect(s.min).toBe(100);
    expect(s.max).toBe(500);
    expect(s.p50).toBe(300);
    expect(s.mean).toBe(300);
  });

  it('descarta valores no finitos en lugar de contaminar el resultado', () => {
    // Es el caso real: el SDK devuelve NaN cuando una estadística no está
    // disponible todavía. Sin este filtro, un solo NaN arruina toda la corrida.
    const s = summarize([100, Number.NaN, 200, Infinity, 300])!;
    expect(s.count).toBe(3);
    expect(s.mean).toBe(200);
  });

  it('devuelve null si no queda ningún valor válido', () => {
    expect(summarize([])).toBeNull();
    expect(summarize([Number.NaN, Infinity])).toBeNull();
  });

  it('el p95 delata una cola que la mediana esconde', () => {
    // 90 muestras buenas y 10 malas. Es exactamente el caso que nos importa:
    // "el vivo anda bien" (mediana 300 ms) mientras 1 de cada 10 espectadores
    // sufre 3 segundos de retraso. La mediana miente; el p95 no.
    const values = [...Array(90).fill(300), ...Array(10).fill(3_000)];
    const s = summarize(values)!;

    expect(s.p50).toBe(300); // se ve perfecto
    expect(s.p95).toBe(3_000); // y sin embargo hay un problema real
  });

  it('con exactamente 5% de outliers, el p95 cae en el borde', () => {
    // Detalle del método R-7 que conviene tener presente al leer los informes:
    // con 95 buenas y 5 malas, el p95 interpola en el límite y da un valor
    // intermedio, no el de la cola. No es un bug: es dónde cae el percentil.
    const values = [...Array(95).fill(300), ...Array(5).fill(3_000)];
    const s = summarize(values)!;

    expect(s.p50).toBe(300);
    expect(s.p95).toBeCloseTo(435, 0);
    expect(s.p99).toBeGreaterThan(2_000); // el p99 sí ve la cola
  });
});
