import { describe, expect, it } from 'vitest';

import { detectFreezes, type FreezeSampleLike } from '../../src/modules/spike/freeze';

const T0 = new Date('2026-08-11T22:14:00.000Z').getTime();

/** Azúcar: `s(0, 100)` = muestra en t=0 s con 100 cuadros decodificados. */
function s(sec: number, framesDecoded: number | null, bitrateKbps = 500): FreezeSampleLike {
  return { at: new Date(T0 + sec * 1_000), framesDecoded, bitrateKbps };
}

describe('detectFreezes', () => {
  it('no marca nada cuando la imagen avanza sin parar', () => {
    const out = detectFreezes([s(0, 10), s(1, 40), s(2, 70), s(3, 100)]);
    expect(out.closed).toHaveLength(0);
    expect(out.frozenPct).toBe(0);
  });

  it('ignora las muestras duplicadas del muestreo a 2 Hz', () => {
    // El cliente manda 2 muestras por segundo pero las stats se refrescan a 1 Hz:
    // los pares idénticos son un artefacto, no un congelamiento.
    const out = detectFreezes([
      s(0, 10),
      s(0.5, 10),
      s(1, 40),
      s(1.5, 40),
      s(2, 70),
      s(2.5, 70),
    ]);
    expect(out.closed).toHaveLength(0);
  });

  it('mide el corte desde el último avance hasta que vuelven los cuadros', () => {
    // Reproduce la prueba R3 de campo: red caída 13 s, cuadros clavados 20 s.
    const samples = [s(0, 100), s(1, 130)];
    for (let t = 2; t <= 20; t += 1) samples.push(s(t, 130, 0));
    samples.push(s(21, 30, 1180)); // track nuevo: el contador reinicia

    const out = detectFreezes(samples);
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0]!.durationMs).toBe(20_000);
  });

  it('trata el contador que reinicia como video nuevo, no como congelamiento', () => {
    // Si el reinicio se leyera como "delta 0", el corte se estiraría hasta el
    // final de la sesión y el p95 quedaría inventado.
    const out = detectFreezes([s(0, 900), s(1, 950), s(2, 5), s(3, 40)]);
    expect(out.closed).toHaveLength(0);
  });

  it('separa el congelamiento final para no contar el cierre de la app', () => {
    const out = detectFreezes([s(0, 10), s(1, 40), s(2, 40), s(3, 40), s(10, 40)]);
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]!.truncated).toBe(true);
    expect(out.closed).toHaveLength(0);
  });

  it('cae al bitrate cuando no hay contador de cuadros', () => {
    const out = detectFreezes([
      s(0, null, 500),
      s(1, null, 0),
      s(2, null, 0),
      s(3, null, 0),
      s(4, null, 600),
    ]);
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0]!.durationMs).toBe(4_000);
  });

  it('calcula el porcentaje de tiempo congelado', () => {
    const samples = [s(0, 10)];
    for (let t = 1; t <= 5; t += 1) samples.push(s(t, 10, 0));
    for (let t = 6; t <= 10; t += 1) samples.push(s(t, 10 + t, 500));

    const out = detectFreezes(samples);
    expect(out.closed).toHaveLength(1);
    expect(out.frozenPct).toBe(60); // 6 s de 10 s
  });

  it('no explota con menos de dos muestras', () => {
    expect(detectFreezes([]).runs).toHaveLength(0);
    expect(detectFreezes([s(0, 1)]).runs).toHaveLength(0);
  });

  it('adapta el umbral a la cadencia real de la sesión', () => {
    // Caso real: las stats se refrescaban cada 2 s. Con un umbral fijo de
    // 1,5 s toda la sesión se leía como una sucesión de cortes de 2 s.
    const samples: FreezeSampleLike[] = [];
    for (let t = 0; t <= 60; t += 1) {
      samples.push(s(t, 100 + Math.floor(t / 2) * 30)); // avanza cada 2 s
    }
    const out = detectFreezes(samples);
    expect(out.thresholdMs).toBe(4_000);
    expect(out.closed).toHaveLength(0);
  });

  it('con cadencia de 2 s sigue viendo un corte largo', () => {
    const samples: FreezeSampleLike[] = [];
    for (let t = 0; t <= 20; t += 1) samples.push(s(t, 100 + Math.floor(t / 2) * 30));
    for (let t = 21; t <= 40; t += 1) samples.push(s(t, 400, 0)); // 20 s clavado
    samples.push(s(41, 12, 900));

    const out = detectFreezes(samples);
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0]!.durationMs).toBe(21_000);
  });

  it('no cuenta el arranque como corte cuando la sesión empieza sin video', () => {
    // Las primeras muestras llegan antes del primer cuadro: eso ya lo mide
    // FIRST_FRAME y contarlo acá lo duplicaba.
    const samples: FreezeSampleLike[] = [
      { at: new Date(T0), framesDecoded: null, bitrateKbps: null },
      { at: new Date(T0 + 1_000), framesDecoded: null, bitrateKbps: null },
      s(5, 40),
      s(6, 80),
      s(7, 120),
    ];
    expect(detectFreezes(samples).closed).toHaveLength(0);
  });
});
