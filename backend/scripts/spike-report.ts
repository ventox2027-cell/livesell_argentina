 
/**
 * Informe consolidado de TODAS las sesiones del spike.
 *
 *   pnpm spike:report                    # tabla en consola
 *   pnpm spike:report -- --json > out.json
 *
 * Es lo que se pega en docs/sprint-0/RESULTS.md para tomar la decisión GO/NO-GO.
 */
import { PrismaClient } from '@prisma/client';

import { detectFreezes } from '../src/modules/spike/freeze';
import { summarize } from '../src/shared/utils/stats';

const prisma = new PrismaClient();

const IDEAL_P95_MS = 800;
const ACCEPTABLE_P95_MS = 1_500;

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');

  const sessions = await prisma.spikeSession.findMany({
    orderBy: { startedAt: 'asc' },
    include: { measurements: true, _count: { select: { samples: true, events: true } } },
  });

  if (sessions.length === 0) {
    console.log('No hay sesiones de spike registradas todavía.');
    return;
  }

  // Resiliencia: se calcula desde las muestras del espectador, no desde los
  // eventos de la sala. Ver la explicación en src/modules/spike/freeze.ts.
  const viewerSamples = await prisma.spikeSample.findMany({
    where: { role: 'VIEWER' },
    orderBy: { at: 'asc' },
    select: { sessionId: true, at: true, framesDecoded: true, bitrateKbps: true },
  });
  const samplesBySession = new Map<string, typeof viewerSamples>();
  for (const s of viewerSamples) {
    samplesBySession.set(s.sessionId, [...(samplesBySession.get(s.sessionId) ?? []), s]);
  }

  const analyses = sessions.map((s) => ({ s, a: detectFreezes(samplesBySession.get(s.id) ?? []) }));
  const freezeRows = analyses.flatMap(({ s, a }) =>
    a.closed.map((f) => ({
      sesion: s.label,
      red: s.networkType,
      desde: f.from.toISOString().slice(11, 19),
      congelado_s: Math.round(f.durationMs / 100) / 10,
      veredicto: freezeVerdict(f.durationMs),
    })),
  );
  const resolutionMs = Math.max(...analyses.map(({ a }) => a.thresholdMs));

  const rows = sessions.map((s) => {
    const g2g = summarize(s.measurements.map((m) => m.latencyMs));
    return {
      id: s.id,
      label: s.label,
      carrier: s.carrier ?? '—',
      network: s.networkType,
      manual: g2g?.count ?? 0,
      p50: g2g?.p50 ?? null,
      p95: g2g?.p95 ?? null,
      max: g2g?.max ?? null,
      samples: s._count.samples,
      verdict: verdictOf(g2g?.count ?? 0, g2g?.p95 ?? null),
    };
  });

  // Agregado global: es el número que decide, no cada sesión por separado.
  const allManual = sessions.flatMap((s) => s.measurements.map((m) => m.latencyMs));
  const global = summarize(allManual);

  // Por operadora: en Argentina la mitad de los problemas de red son de una
  // operadora concreta, y sin este corte se investiga a ciegas.
  const byCarrier = new Map<string, number[]>();
  for (const s of sessions) {
    for (const m of s.measurements) {
      const key = m.carrier ?? s.carrier ?? 'desconocida';
      byCarrier.set(key, [...(byCarrier.get(key) ?? []), m.latencyMs]);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sessions: rows,
    resilience: {
      freezes: freezeRows,
      freezeDurationMs: summarize(
        freezeRows.map((f) => f.congelado_s * 1_000),
      ),
    },
    global: {
      manualMeasurements: allManual.length,
      glassToGlassMs: global,
      verdict: verdictOf(allManual.length, global?.p95 ?? null),
    },
    byCarrier: Object.fromEntries(
      [...byCarrier.entries()].map(([carrier, values]) => [carrier, summarize(values)]),
    ),
    criteria: {
      idealP95Ms: IDEAL_P95_MS,
      acceptableP95Ms: ACCEPTABLE_P95_MS,
      minToDecide: 5,
      solidSample: 10,
    },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n═══ SPRINT 0A · SPIKE DE LIVEKIT ═══\n');
  console.table(rows);

  console.log('\n─── Glass-to-glass global (mediciones manuales) ───');
  console.table(global ? [global] : [{ nota: 'sin mediciones manuales' }]);

  console.log('\n─── Por operadora ───');
  console.table(
    Object.entries(report.byCarrier).map(([carrier, s]) => ({
      carrier,
      n: s?.count ?? 0,
      p50: s?.p50 ?? null,
      p95: s?.p95 ?? null,
      max: s?.max ?? null,
    })),
  );

  console.log('\n─── Resiliencia · cortes de imagen que vio el espectador ───');
  if (freezeRows.length === 0) {
    console.log('  Sin cortes registrados. Faltan las pruebas R1–R8 del RUNBOOK.');
  } else {
    console.table(freezeRows);
    console.log(
      '  Medido con los cuadros decodificados, no con los eventos de track:\n' +
        '  el SFU tarda ~15 s en retirar el track de un emisor caído, así que\n' +
        '  los eventos subestiman el corte hasta 12×. Ver src/modules/spike/freeze.ts.',
    );
  }
  console.log(
    `  Resolución del instrumento: ${resolutionMs} ms. ` +
      'Cortes más breves no se pueden afirmar.',
  );

  console.log(`\n═══ VEREDICTO: ${report.global.verdict} ═══`);
  console.log(`Criterio: ideal p95 ≤ ${IDEAL_P95_MS} ms · tolerable ≤ ${ACCEPTABLE_P95_MS} ms`);
  console.log(
    `Mediciones manuales: ${allManual.length}  ` +
      `(5 = alcanza para decidir una condición · 10 = confianza sólida)`,
  );

  // Lo que más informa a esta altura no es el volumen de muestras sino la
  // variedad de condiciones. Se avisa explícitamente para no medir de más
  // en el caso fácil y de menos en el difícil.
  const conditions = new Set(sessions.filter((s) => s.measurements.length > 0).map((s) => s.networkType));
  const missing = ['WIFI', 'CELLULAR_4G'].filter((c) => !conditions.has(c as never));
  if (missing.length > 0) {
    console.log(`\n⚠ Faltan condiciones sin medir: ${missing.join(', ')}`);
    console.log('  Más muestras del caso fácil no cambian el veredicto; otra condición sí.');
  }
  console.log('');
}

/**
 * Un corte se juzga por lo que hace la persona que está mirando, no por el
 * transporte. Los umbrales salen de cómo se comporta la audiencia en vivo:
 * hasta ~3 s se lee como "se trabó un segundo"; pasados ~10 s la mayoría se va.
 */
function freezeVerdict(ms: number): string {
  if (ms <= 3_000) return 'ok · imperceptible';
  if (ms <= 10_000) return 'molesto · se banca';
  if (ms <= 30_000) return 'se va la audiencia';
  return 'live perdido';
}

/**
 * Ver la explicación en spike.service.ts: el tamaño de muestra es un nivel de
 * confianza, no un umbral binario. 5 mediciones consistentes deciden una
 * condición; lo que falta después son más CONDICIONES, no más muestras.
 */
function verdictOf(manualCount: number, p95: number | null): string {
  if (manualCount < 5 || p95 == null) return 'INSUFFICIENT_DATA';
  const suffix = manualCount < 10 ? ' (prelim.)' : '';
  if (p95 <= IDEAL_P95_MS) return `GO${suffix}`;
  if (p95 <= ACCEPTABLE_P95_MS) return `GO_WITH_CAVEAT${suffix}`;
  return `NO_GO${suffix}`;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
