import 'package:livekit_client/livekit_client.dart';

/// Instantánea normalizada de las estadísticas de WebRTC.
class StatsSnapshot {
  const StatsSnapshot({
    this.rttMs,
    this.jitterMs,
    this.packetsLost,
    this.packetLossPct,
    this.jitterBufferDelayMs,
    this.framesDecoded,
    this.framesDropped,
    this.freezeCount,
    this.bitrateKbps,
    this.fps,
    this.frameWidth,
    this.frameHeight,
  });

  final int? rttMs;
  final int? jitterMs;
  final int? packetsLost;
  final double? packetLossPct;
  final int? jitterBufferDelayMs;
  final int? framesDecoded;
  final int? framesDropped;
  final int? freezeCount;
  final int? bitrateKbps;
  final double? fps;
  final int? frameWidth;
  final int? frameHeight;

  static const empty = StatsSnapshot();
}

/// ⚠️ ÚNICO archivo del proyecto que toca los tipos de estadísticas del SDK.
///
/// Verificado contra **livekit_client 2.5.4**. Los nombres y tipos de estas
/// clases cambian entre versiones: si al actualizar el SDK deja de compilar,
/// se arregla acá y nada más se entera. Esa fue exactamente la razón de
/// aislarlo, y ya se pagó — la primera versión, escrita contra la API
/// documentada, no compiló.
///
/// Notas de la API real (`lib/src/stats/stats.dart` del paquete):
///   · TODOS los campos numéricos son `num?`, no `int?`.
///   · `VideoReceiverStats` NO expone `jitterBufferEmittedCount` ni
///     `freezeCount`. Se derivan o se dejan en null (ver abajo).
///   · `VideoSenderStatsEvent.stats` es un **Map por capa de simulcast**
///     (clave = `rid`), no un objeto único.
class StatsAdapter {
  StatsAdapter();

  // WebRTC entrega contadores ACUMULADOS desde el inicio de la sesión.
  // Guardamos el valor anterior para trabajar con deltas: un mal arranque no
  // puede contaminar el resto de la medición.
  num? _lastPacketsLost;
  num? _lastPacketsReceived;
  num? _lastJitterBufferDelay;
  num? _lastFramesDecoded;
  num? _lastFramesDropped;

  StatsSnapshot fromReceiver(VideoReceiverStatsEvent event) {
    try {
      final s = event.stats;

      // ── Retardo del jitter buffer ──
      // `jitterBufferDelay` es la SUMA acumulada en segundos. Lo correcto sería
      // dividir por `jitterBufferEmittedCount`, que este SDK no expone, así que
      // usamos el delta de frames decodificados como aproximación del delta de
      // frames emitidos. Para video son prácticamente lo mismo.
      //
      // Trabajar con deltas es además MÁS correcto que el cociente acumulado:
      // refleja las condiciones del momento, no el promedio de toda la sesión.
      int? jitterBufferMs;
      final delay = s.jitterBufferDelay;
      final decoded = s.framesDecoded;
      if (delay != null && decoded != null) {
        final dDelay = delay - (_lastJitterBufferDelay ?? delay);
        final dFrames = decoded - (_lastFramesDecoded ?? decoded);
        if (dFrames > 0) jitterBufferMs = ((dDelay / dFrames) * 1000).round();
        _lastJitterBufferDelay = delay;
      }

      // ── Pérdida de paquetes en la ventana ──
      double? lossPct;
      final lost = s.packetsLost;
      final received = s.packetsReceived;
      if (lost != null && received != null) {
        final dLost = lost - (_lastPacketsLost ?? lost);
        final dRecv = received - (_lastPacketsReceived ?? received);
        final total = dLost + dRecv;
        if (total > 0) lossPct = (dLost / total) * 100;
        _lastPacketsLost = lost;
        _lastPacketsReceived = received;
      }

      // ── Congelamientos ──
      // El SDK no expone `freezeCount`. Se aproxima contando los intervalos en
      // los que se descartaron frames: no es la definición de la W3C, pero
      // sirve para comparar corridas entre sí, que es lo que necesita el spike.
      int? freezes;
      final dropped = s.framesDropped;
      if (dropped != null) {
        final dDropped = dropped - (_lastFramesDropped ?? dropped);
        freezes = dDropped > 0 ? dDropped.round() : 0;
        _lastFramesDropped = dropped;
      }

      _lastFramesDecoded = decoded;

      return StatsSnapshot(
        jitterMs: _msFromSeconds(s.jitter),
        packetsLost: lost?.round(),
        packetLossPct: lossPct,
        jitterBufferDelayMs: jitterBufferMs,
        framesDecoded: decoded?.round(),
        framesDropped: dropped?.round(),
        freezeCount: freezes,
        // currentBitrate YA viene en kbps, no en bps.
        // `computeBitrateForReceiverStats` hace bytes*8*1000/Δµs, que da kbps
        // en nativo, y bytes*8/Δms en web, que también da kbps.
        // Dividir por 1000 mostraba "3 kbps" donde había 3 Mbps.
        bitrateKbps: event.currentBitrate.round(),
        fps: s.framesPerSecond?.toDouble(),
        frameWidth: s.frameWidth?.round(),
        frameHeight: s.frameHeight?.round(),
      );
    } catch (_) {
      // Se pierde una muestra, no la sesión.
      return StatsSnapshot.empty;
    }
  }

  StatsSnapshot fromSender(VideoSenderStatsEvent event) {
    try {
      if (event.stats.isEmpty) return StatsSnapshot.empty;

      // El emisor publica VARIAS capas de simulcast a la vez. Nos quedamos con
      // la de mayor resolución: es la que refleja el esfuerzo real de
      // codificación del teléfono, que es lo que queremos medir.
      final layers = event.stats.values.toList()
        ..sort((a, b) => ((b.frameWidth ?? 0) * (b.frameHeight ?? 0))
            .compareTo((a.frameWidth ?? 0) * (a.frameHeight ?? 0)));
      final top = layers.first;

      return StatsSnapshot(
        rttMs: _msFromSeconds(top.roundTripTime),
        jitterMs: _msFromSeconds(top.jitter),
        packetsLost: top.packetsLost?.round(),
        bitrateKbps: event.currentBitrate.round(), // ya en kbps, ver fromReceiver
        fps: top.framesPerSecond?.toDouble(),
        frameWidth: top.frameWidth?.round(),
        frameHeight: top.frameHeight?.round(),
      );
    } catch (_) {
      return StatsSnapshot.empty;
    }
  }

  /// WebRTC reporta los tiempos en segundos con decimales.
  static int? _msFromSeconds(num? seconds) =>
      seconds == null ? null : (seconds * 1000).round();

  /// Etiqueta de la capa de simulcast según la altura.
  ///
  /// Es la validación directa del adaptive bitrate: si a lo largo de una sesión
  /// se observa más de una altura, el ABR cambió de capa por su cuenta.
  static String? layerFromHeight(int? height) {
    if (height == null || height == 0) return null;
    if (height >= 900) return 'high';
    if (height >= 480) return 'medium';
    return 'low';
  }
}
