/// Modelos del spike. Dart puro: sin Flutter, sin dio, testeables con `dart test`.
library;

// ignore_for_file: constant_identifier_names
//
// Los nombres en MAYÚSCULAS son deliberados: `.name` se serializa directo al
// backend, donde los enums de Prisma son BROADCASTER, CELLULAR_4G, etc.
// Pasarlos a lowerCamelCase obligaría a una tabla de traducción en ambos
// sentidos, que es justo la capa que se desincroniza al agregar un valor nuevo
// y que el compilador no puede verificar. Peor que un lint de estilo.

enum SpikeRole { BROADCASTER, VIEWER }

enum NetworkType {
  WIFI,
  CELLULAR_5G,
  CELLULAR_4G,
  CELLULAR_3G,
  UNKNOWN;

  String get label => switch (this) {
        NetworkType.WIFI => 'WiFi',
        NetworkType.CELLULAR_5G => '5G',
        NetworkType.CELLULAR_4G => '4G',
        NetworkType.CELLULAR_3G => '3G',
        NetworkType.UNKNOWN => 'Desconocida',
      };
}

enum SpikeEventType {
  SESSION_START,
  ROOM_CONNECTING,
  ROOM_CONNECTED,
  ROOM_RECONNECTING,
  ROOM_RECONNECTED,
  ROOM_DISCONNECTED,
  TRACK_PUBLISHED,
  TRACK_SUBSCRIBED,
  TRACK_UNSUBSCRIBED,
  FIRST_FRAME,
  NETWORK_CHANGED,
  QUALITY_CHANGED,
  ERROR,
  SESSION_END,
}

class DeviceInfo {
  const DeviceInfo({
    required this.model,
    required this.os,
    required this.osVersion,
    required this.appVersion,
    this.isPhysicalDevice = true,
  });

  final String model;
  final String os;
  final String osVersion;
  final String appVersion;

  /// Un emulador codifica por software y da números que no representan nada.
  /// Se registra para poder descartar esas corridas del informe.
  final bool isPhysicalDevice;

  Map<String, dynamic> toJson() => {
        'model': model,
        'os': os,
        'osVersion': osVersion,
        'appVersion': appVersion,
        'isPhysicalDevice': isPhysicalDevice,
      };
}

class CreatedSession {
  const CreatedSession({required this.sessionId, required this.roomName, required this.wsUrl});

  final String sessionId;
  final String roomName;
  final String wsUrl;

  factory CreatedSession.fromJson(Map<String, dynamic> json) => CreatedSession(
        sessionId: json['sessionId'] as String,
        roomName: json['roomName'] as String,
        wsUrl: json['wsUrl'] as String,
      );
}

class IssuedToken {
  const IssuedToken({
    required this.token,
    required this.wsUrl,
    required this.roomName,
    required this.identity,
    required this.expiresAt,
  });

  final String token;
  final String wsUrl;
  final String roomName;
  final String identity;
  final String expiresAt;

  factory IssuedToken.fromJson(Map<String, dynamic> json) => IssuedToken(
        token: json['token'] as String,
        wsUrl: json['wsUrl'] as String,
        roomName: json['roomName'] as String,
        identity: json['identity'] as String,
        expiresAt: json['expiresAt'] as String,
      );
}

/// Muestra periódica de calidad. Los `null` son legítimos: no todas las
/// estadísticas están disponibles en todos los momentos ni en todas las
/// plataformas, y forzar un 0 falsearía los percentiles.
class QualitySample {
  const QualitySample({
    required this.seq,
    required this.atMs,
    required this.networkType,
    this.probeLatencyMs,
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
    this.videoLayer,
    this.connectionQuality,
    this.carrier,
    this.clockOffsetMs,
  });

  final int seq;

  /// Instante en el reloj DEL SERVIDOR, ya corregido con el offset de ClockSync.
  final int atMs;

  final NetworkType networkType;
  final int? probeLatencyMs;
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
  final String? videoLayer;
  final String? connectionQuality;
  final String? carrier;
  final int? clockOffsetMs;

  Map<String, dynamic> toJson() => {
        'seq': seq,
        'atMs': atMs,
        'networkType': networkType.name,
        if (probeLatencyMs != null) 'probeLatencyMs': probeLatencyMs,
        if (rttMs != null) 'rttMs': rttMs,
        if (jitterMs != null) 'jitterMs': jitterMs,
        if (packetsLost != null) 'packetsLost': packetsLost,
        if (packetLossPct != null) 'packetLossPct': packetLossPct,
        if (jitterBufferDelayMs != null) 'jitterBufferDelayMs': jitterBufferDelayMs,
        if (framesDecoded != null) 'framesDecoded': framesDecoded,
        if (framesDropped != null) 'framesDropped': framesDropped,
        if (freezeCount != null) 'freezeCount': freezeCount,
        if (bitrateKbps != null) 'bitrateKbps': bitrateKbps,
        if (fps != null) 'fps': fps,
        if (frameWidth != null) 'frameWidth': frameWidth,
        if (frameHeight != null) 'frameHeight': frameHeight,
        if (videoLayer != null) 'videoLayer': videoLayer,
        if (connectionQuality != null) 'connectionQuality': connectionQuality,
        if (carrier != null) 'carrier': carrier,
        if (clockOffsetMs != null) 'clockOffsetMs': clockOffsetMs,
      };
}

class SpikeEventRecord {
  const SpikeEventRecord({
    required this.type,
    required this.atMs,
    this.durationMs,
    this.detail,
  });

  final SpikeEventType type;
  final int atMs;
  final int? durationMs;
  final Map<String, dynamic>? detail;

  Map<String, dynamic> toJson() => {
        'type': type.name,
        'atMs': atMs,
        if (durationMs != null) 'durationMs': durationMs,
        if (detail != null) 'detail': detail,
      };
}

/// Paquete que viaja por el canal de datos de LiveKit para medir latencia de
/// transporte. Formato mínimo a propósito: se envía dos veces por segundo.
class ProbePacket {
  const ProbePacket({required this.seq, required this.sentAtServerMs});

  final int seq;
  final int sentAtServerMs;

  String encode() => '$seq:$sentAtServerMs';

  static ProbePacket? decode(String raw) {
    final parts = raw.split(':');
    if (parts.length != 2) return null;
    final seq = int.tryParse(parts[0]);
    final sentAt = int.tryParse(parts[1]);
    if (seq == null || sentAt == null) return null;
    return ProbePacket(seq: seq, sentAtServerMs: sentAt);
  }
}
