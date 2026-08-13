import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { LiveKitService, type IssuedToken } from '@/modules/livekit/livekit.service';
import { detectFreezes } from '@/modules/spike/freeze';
import { DomainError, SessionNotFoundError } from '@/shared/errors/domain.error';
import { MetricsService } from '@/shared/observability/metrics.service';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';
import { summarize, type Summary } from '@/shared/utils/stats';

import type {
  CreateSessionDto,
  GlassToGlassDto,
  IngestEventsDto,
  IngestSamplesDto,
  IssueTokenDto,
} from './dto/spike.dto';

/**
 * Presupuestos usados para estimar glass-to-glass a partir de la sonda de datos.
 *
 * ⚠️ Son valores INICIALES, no verdad revelada. La sonda del canal de datos
 * mide transporte y se saltea encode, jitter buffer, decode y render. Estas
 * constantes rellenan ese hueco hasta que las mediciones manuales permitan
 * calibrar (ver `buildReport().calibration`).
 */
const ENCODE_BUDGET_MS = 40; // captura + encode en el emisor
const RENDER_BUDGET_MS = 33; // decode + composición + un frame a 30 fps

@Injectable()
export class SpikeService {
  private readonly logger = new Logger(SpikeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly livekit: LiveKitService,
    private readonly metrics: MetricsService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Sesiones
  // ───────────────────────────────────────────────────────────────────────────

  async createSession(dto: CreateSessionDto) {
    const id = newId('spk');
    // Nombre de sala derivado del id: único, legible en el panel de LiveKit y
    // trazable de vuelta a la sesión sin consultar la base.
    const roomName = `spike_${id}`;

    await this.livekit.ensureRoom(roomName, { emptyTimeoutS: 600, maxParticipants: 20 });

    const session = await this.prisma.spikeSession.create({
      data: {
        id,
        label: dto.label,
        roomName,
        carrier: dto.carrier ?? null,
        networkType: dto.networkType,
        locationNote: dto.locationNote ?? null,
        broadcasterDevice: dto.device ?? undefined,
        notes: dto.notes ?? null,
      },
    });

    this.logger.log({ sessionId: id, roomName, label: dto.label }, 'sesión de spike creada');
    return { sessionId: session.id, roomName, wsUrl: this.livekit.wsUrl };
  }

  async endSession(sessionId: string, notes?: string) {
    const session = await this.requireSession(sessionId);
    if (session.endedAt) throw new DomainError('SESSION_ALREADY_ENDED', 'La sesión ya terminó');

    await this.prisma.spikeSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), notes: notes ?? session.notes },
    });

    // Se libera la sala para no seguir pagando minutos por una prueba terminada.
    await this.livekit.deleteRoom(session.roomName);
    return this.buildReport(sessionId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tokens
  // ───────────────────────────────────────────────────────────────────────────

  async issueToken(dto: IssueTokenDto): Promise<IssuedToken & { sessionId: string }> {
    const session = await this.requireSession(dto.sessionId);
    if (session.endedAt) throw new DomainError('SESSION_ALREADY_ENDED', 'La sesión ya terminó');

    if (dto.device) {
      await this.prisma.spikeSession.update({
        where: { id: session.id },
        data:
          dto.role === 'BROADCASTER'
            ? { broadcasterDevice: dto.device }
            : { viewerDevice: dto.device },
      });
    }

    const issued = await this.livekit.issueToken({
      roomName: session.roomName,
      identity: `${dto.role.toLowerCase()}_${dto.identity}`,
      role: dto.role === 'BROADCASTER' ? 'broadcaster' : 'viewer',
      displayName: dto.displayName,
      metadata: { sessionId: session.id, spike: true },
    });

    return { ...issued, sessionId: session.id };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Ingesta
  // ───────────────────────────────────────────────────────────────────────────

  async ingestSamples(dto: IngestSamplesDto): Promise<{ accepted: number }> {
    const session = await this.requireSession(dto.sessionId);

    const rows = dto.samples.map((s) => {
      const estimatedE2eMs = this.estimateE2e(s.probeLatencyMs, s.jitterBufferDelayMs);

      // Alimenta el histograma que después responde el GO/NO-GO.
      const labels = {
        network: s.networkType,
        carrier: s.carrier ?? session.carrier ?? 'unknown',
      };
      if (s.probeLatencyMs != null) {
        this.metrics.spikeObservedLatency.observe({ kind: 'probe', ...labels }, s.probeLatencyMs);
      }
      if (estimatedE2eMs != null) {
        this.metrics.spikeObservedLatency.observe({ kind: 'estimated_e2e', ...labels }, estimatedE2eMs);
      }

      return {
        id: newId('smp'),
        sessionId: session.id,
        role: dto.role,
        seq: s.seq,
        at: new Date(s.atMs),
        probeLatencyMs: s.probeLatencyMs ?? null,
        estimatedE2eMs,
        rttMs: s.rttMs ?? null,
        jitterMs: s.jitterMs ?? null,
        packetsLost: s.packetsLost ?? null,
        packetLossPct: s.packetLossPct ?? null,
        jitterBufferDelayMs: s.jitterBufferDelayMs ?? null,
        framesDecoded: s.framesDecoded ?? null,
        framesDropped: s.framesDropped ?? null,
        freezeCount: s.freezeCount ?? null,
        bitrateKbps: s.bitrateKbps ?? null,
        fps: s.fps ?? null,
        frameWidth: s.frameWidth ?? null,
        frameHeight: s.frameHeight ?? null,
        videoLayer: s.videoLayer ?? null,
        connectionQuality: s.connectionQuality ?? null,
        networkType: s.networkType,
        carrier: s.carrier ?? session.carrier ?? null,
        clockOffsetMs: s.clockOffsetMs ?? null,
      };
    });

    // skipDuplicates: si el teléfono pierde la respuesta y reenvía el lote,
    // no se duplican muestras y las estadísticas no se distorsionan.
    const result = await this.prisma.spikeSample.createMany({ data: rows, skipDuplicates: true });
    this.metrics.spikeSamplesIngested.inc({ role: dto.role }, result.count);

    return { accepted: result.count };
  }

  async ingestEvents(dto: IngestEventsDto): Promise<{ accepted: number }> {
    const session = await this.requireSession(dto.sessionId);

    for (const e of dto.events) {
      if (e.type === 'ROOM_RECONNECTED' && e.durationMs != null) {
        this.metrics.spikeReconnectDuration.observe(
          { role: dto.role, network: session.networkType },
          e.durationMs,
        );
      }
    }

    const result = await this.prisma.spikeEvent.createMany({
      data: dto.events.map((e) => ({
        id: newId('evt'),
        sessionId: session.id,
        role: dto.role,
        type: e.type,
        at: new Date(e.atMs),
        durationMs: e.durationMs ?? null,
        // Zod entrega Record<string, unknown>; Prisma exige InputJsonValue,
        // que no acepta `unknown` como valor. El cast es seguro porque el
        // esquema ya validó que sea un objeto serializable a JSON.
        detail: (e.detail ?? undefined) as Prisma.InputJsonValue | undefined,
      })),
      skipDuplicates: true,
    });

    return { accepted: result.count };
  }

  async recordGlassToGlass(dto: GlassToGlassDto) {
    const session = await this.requireSession(dto.sessionId);

    // Se empareja con la estimación automática más cercana en el tiempo.
    // Ese par (real, estimado) es lo que permite calibrar la fórmula.
    const nearest = await this.prisma.spikeSample.findFirst({
      where: { sessionId: session.id, role: 'VIEWER', estimatedE2eMs: { not: null } },
      orderBy: { at: 'desc' },
      select: { estimatedE2eMs: true },
    });

    const created = await this.prisma.glassToGlassMeasurement.create({
      data: {
        id: newId('g2g'),
        sessionId: session.id,
        latencyMs: dto.latencyMs,
        pairedEstimatedE2eMs: nearest?.estimatedE2eMs ?? null,
        method: dto.method,
        networkType: dto.networkType,
        carrier: dto.carrier ?? session.carrier ?? null,
        photoRef: dto.photoRef ?? null,
        note: dto.note ?? null,
      },
    });

    this.metrics.spikeObservedLatency.observe(
      {
        kind: 'glass_to_glass',
        network: dto.networkType,
        carrier: dto.carrier ?? session.carrier ?? 'unknown',
      },
      dto.latencyMs,
    );

    return created;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Informes
  // ───────────────────────────────────────────────────────────────────────────

  async buildReport(sessionId: string) {
    const session = await this.requireSession(sessionId);

    const [samples, events, measurements] = await Promise.all([
      this.prisma.spikeSample.findMany({
        where: { sessionId },
        orderBy: { at: 'asc' },
        select: {
          role: true,
          at: true,
          probeLatencyMs: true,
          estimatedE2eMs: true,
          rttMs: true,
          jitterMs: true,
          packetLossPct: true,
          jitterBufferDelayMs: true,
          framesDecoded: true,
          bitrateKbps: true,
          fps: true,
          frameHeight: true,
          videoLayer: true,
          freezeCount: true,
          connectionQuality: true,
        },
      }),
      this.prisma.spikeEvent.findMany({
        where: { sessionId },
        orderBy: { at: 'asc' },
        select: { type: true, durationMs: true, role: true, at: true },
      }),
      this.prisma.glassToGlassMeasurement.findMany({ where: { sessionId } }),
    ]);

    const viewer = samples.filter((s) => s.role === 'VIEWER');
    const broadcaster = samples.filter((s) => s.role === 'BROADCASTER');

    const num = <T>(rows: T[], pick: (r: T) => number | null | undefined): number[] =>
      rows.map(pick).filter((v): v is number => v != null);

    const g2gValues = measurements.map((m) => m.latencyMs);
    const g2g = summarize(g2gValues);
    const estimated = summarize(num(viewer, (s) => s.estimatedE2eMs));

    // Congelamientos reales, reconstruidos desde los cuadros decodificados.
    const freezes = detectFreezes(viewer);

    /**
     * Retardo de detección: desde que la imagen se congela hasta que la
     * señalización lo admite retirando el track. Se empareja cada corte con el
     * primer `TRACK_UNSUBSCRIBED` que cae dentro de su ventana.
     */
    const unsubs = events
      .filter((e) => e.role === 'VIEWER' && e.type === 'TRACK_UNSUBSCRIBED')
      .map((e) => e.at.getTime());
    const detectionLags = freezes.closed
      .map((f) => {
        const hit = unsubs.find((t) => t >= f.from.getTime() && t <= f.to.getTime());
        return hit == null ? Number.NaN : hit - f.from.getTime();
      })
      .filter((v) => Number.isFinite(v));

    /**
     * Primera ocurrencia por rol. `ROOM_CONNECTED` y `FIRST_FRAME` se emiten de
     * nuevo en cada reconexión con el cronómetro corriendo desde el inicio de
     * la sesión, así que sólo la primera es una medición válida.
     */
    const firstPerRole = (type: (typeof events)[number]['type']): number[] => {
      const seen = new Set<string>();
      const out: number[] = [];
      for (const e of events) {
        if (e.type !== type || e.durationMs == null || seen.has(e.role)) continue;
        seen.add(e.role);
        out.push(e.durationMs);
      }
      return out;
    };

    return {
      session: {
        id: session.id,
        label: session.label,
        roomName: session.roomName,
        carrier: session.carrier,
        networkType: session.networkType,
        locationNote: session.locationNote,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationSec: session.endedAt
          ? Math.round((session.endedAt.getTime() - session.startedAt.getTime()) / 1000)
          : null,
        broadcasterDevice: session.broadcasterDevice,
        viewerDevice: session.viewerDevice,
      },

      counts: {
        samples: samples.length,
        viewerSamples: viewer.length,
        broadcasterSamples: broadcaster.length,
        events: events.length,
        manualMeasurements: measurements.length,
      },

      latency: {
        // La referencia de verdad. Es la que decide el GO/NO-GO.
        glassToGlassManualMs: g2g,
        // La estimación automática, útil por su volumen de muestras.
        estimatedE2eMs: estimated,
        probeOneWayMs: summarize(num(viewer, (s) => s.probeLatencyMs)),
        rttMs: summarize(num(viewer, (s) => s.rttMs)),
        jitterMs: summarize(num(viewer, (s) => s.jitterMs)),
        jitterBufferDelayMs: summarize(num(viewer, (s) => s.jitterBufferDelayMs)),
      },

      // Cuánto se aparta la estimación de la medición real. Con 10+ pares,
      // el sesgo permite corregir la fórmula y confiar en el número automático.
      calibration: this.buildCalibration(measurements),

      quality: {
        packetLossPct: summarize(num(viewer, (s) => s.packetLossPct)),
        bitrateKbps: summarize(num(viewer, (s) => s.bitrateKbps)),
        fps: summarize(num(viewer, (s) => s.fps)),
        totalFreezes: num(viewer, (s) => s.freezeCount).reduce((a, b) => a + b, 0),
        // Validación del ABR: si aparece más de una altura, la capa cambió sola.
        heightsSeen: [...new Set(num(viewer, (s) => s.frameHeight))].sort((a, b) => a - b),
        layersSeen: [...new Set(viewer.map((s) => s.videoLayer).filter(Boolean))],
        connectionQualityCounts: countBy(viewer.map((s) => s.connectionQuality ?? 'unknown')),
      },

      resilience: {
        /**
         * Sólo la PRIMERA conexión de cada rol. Las reconexiones vuelven a
         * emitir `ROOM_CONNECTED`, pero el cliente mide desde el arranque de la
         * sesión, así que reportaban valores como 183.207 ms. Promediarlos con
         * los 700 ms reales inventaba un "tiempo de conexión" de tres minutos.
         */
        connectMs: summarize(firstPerRole('ROOM_CONNECTED')),
        firstFrameMs: summarize(firstPerRole('FIRST_FRAME')),
        reconnectMs: summarize(
          events.filter((e) => e.type === 'ROOM_RECONNECTED').map((e) => e.durationMs ?? Number.NaN),
        ),

        /**
         * EL NÚMERO QUE IMPORTA: cuánto tiempo el espectador estuvo mirando
         * una imagen quieta.
         *
         * No sale de los eventos de track sino de los cuadros decodificados.
         * El porqué está documentado en `freeze.ts`: el SFU tarda ~15 s en
         * retirar el track de un emisor caído, así que los eventos subestiman
         * el corte hasta 12×.
         */
        viewerFreezes: {
          count: freezes.closed.length,
          durationMs: summarize(freezes.closed.map((f) => f.durationMs)),
          frozenPct: freezes.frozenPct,
          runs: freezes.runs.map((f) => ({
            from: f.from,
            to: f.to,
            durationMs: f.durationMs,
            truncated: f.truncated,
          })),
        },

        /**
         * Cuánto tarda la señalización en enterarse de que ya no hay video.
         * Es la ventana en la que la app NO SABE que está mostrando una imagen
         * muerta, y por lo tanto no puede avisarle a nadie. Mide el tamaño del
         * problema de producto, no una falla del transporte.
         */
        detectionLagMs: summarize(detectionLags),

        reconnectCount: events.filter((e) => e.type === 'ROOM_RECONNECTING').length,
        disconnectCount: events.filter((e) => e.type === 'ROOM_DISCONNECTED').length,
        errorCount: events.filter((e) => e.type === 'ERROR').length,
      },

      verdict: this.verdict(g2g, estimated),
    };
  }

  /**
   * Criterio GO/NO-GO del Sprint 0A.
   *
   * Prioriza SIEMPRE la medición manual sobre la estimación: la estimación es
   * un proxy, la foto es la realidad.
   *
   * El tamaño de muestra no es un umbral binario sino un nivel de CONFIANZA.
   * Con 5 mediciones muy consistentes (desvío bajo) ya se puede decidir sobre
   * una condición concreta; con 5 dispersas, no. Un corte rígido en 10 obliga a
   * repetir mediciones que no agregan información y, peor, desincentiva probar
   * MÁS CONDICIONES, que es donde está el valor real:
   *
   *   6 mediciones en WiFi + 6 en 4G  >>>  20 mediciones en WiFi
   *
   * El riesgo que este spike tiene que despejar es "¿anda en las redes móviles
   * argentinas?". Veinte muestras del WiFi de casa no lo responden.
   */
  private verdict(g2g: Summary | null, estimated: Summary | null) {
    const MIN_TO_DECIDE = 5;
    const SOLID_SAMPLE = 10;
    const IDEAL_P95 = 800;
    const ACCEPTABLE_P95 = 1_500;

    if (!g2g || g2g.count < MIN_TO_DECIDE) {
      return {
        status: 'INSUFFICIENT_DATA' as const,
        confidence: 'none' as const,
        reason: `Se necesitan al menos ${MIN_TO_DECIDE} mediciones manuales; hay ${g2g?.count ?? 0}.`,
        p95Ms: g2g?.p95 ?? estimated?.p95 ?? null,
      };
    }

    // Con pocas muestras, mucha dispersión significa que el p95 todavía no es
    // estable: la próxima medición podría moverlo mucho.
    const dispersion = g2g.mean > 0 ? g2g.stdDev / g2g.mean : 0;
    const confidence =
      g2g.count >= SOLID_SAMPLE ? 'solid' : dispersion <= 0.25 ? 'preliminary' : 'low';

    const note =
      confidence === 'solid'
        ? ''
        : confidence === 'preliminary'
          ? ` (preliminar: ${g2g.count} mediciones muy consistentes, desvío ${Math.round(dispersion * 100)}%)`
          : ` (baja confianza: solo ${g2g.count} mediciones y muy dispersas, desvío ${Math.round(dispersion * 100)}% — conviene medir más)`;

    if (g2g.p95 <= IDEAL_P95) {
      return {
        status: 'GO' as const,
        confidence,
        reason: `p95 ${g2g.p95} ms ≤ ${IDEAL_P95} ms${note}`,
        p95Ms: g2g.p95,
      };
    }
    if (g2g.p95 <= ACCEPTABLE_P95) {
      return {
        status: 'GO_WITH_CAVEAT' as const,
        confidence,
        reason:
          `p95 ${g2g.p95} ms está entre el ideal (${IDEAL_P95}) y el máximo tolerable (${ACCEPTABLE_P95}). ` +
          `Requiere validación cualitativa: ¿la interacción se siente en tiempo real?${note}`,
        p95Ms: g2g.p95,
      };
    }
    return {
      status: 'NO_GO' as const,
      confidence,
      reason: `p95 ${g2g.p95} ms supera el máximo tolerable de ${ACCEPTABLE_P95} ms.${note}`,
      p95Ms: g2g.p95,
    };
  }

  private buildCalibration(
    measurements: { latencyMs: number; pairedEstimatedE2eMs: number | null }[],
  ) {
    const pairs = measurements.filter(
      (m): m is { latencyMs: number; pairedEstimatedE2eMs: number } => m.pairedEstimatedE2eMs != null,
    );
    if (pairs.length < 3) {
      return { pairs: pairs.length, biasMs: null, note: 'Se necesitan al menos 3 pares para calibrar.' };
    }

    const deltas = pairs.map((p) => p.latencyMs - p.pairedEstimatedE2eMs);
    const bias = Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length);

    return {
      pairs: pairs.length,
      biasMs: bias,
      delta: summarize(deltas),
      note:
        bias > 0
          ? `La estimación SUBESTIMA en ~${bias} ms. Sumar este sesgo a estimatedE2eMs.`
          : `La estimación SOBREESTIMA en ~${Math.abs(bias)} ms.`,
      suggestedBudgets: {
        encodeBudgetMs: ENCODE_BUDGET_MS + Math.round(bias / 2),
        renderBudgetMs: RENDER_BUDGET_MS + Math.round(bias / 2),
      },
    };
  }

  private estimateE2e(probeMs?: number | null, jitterBufferMs?: number | null): number | null {
    if (probeMs == null) return null;
    return Math.round(probeMs + (jitterBufferMs ?? 0) + ENCODE_BUDGET_MS + RENDER_BUDGET_MS);
  }

  private async requireSession(sessionId: string) {
    const session = await this.prisma.spikeSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
}
