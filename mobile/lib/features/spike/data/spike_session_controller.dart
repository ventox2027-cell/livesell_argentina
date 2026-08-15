import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';

import '../../../core/config/app_config.dart';
import '../../../core/network/spike_api.dart';
import '../../../core/time/clock_sync.dart';
import '../domain/models.dart';
import 'stats_adapter.dart';

/// Motor de una corrida del spike.
///
/// Hace tres cosas y nada más:
///   1. Conecta a LiveKit con el rol correspondiente.
///   2. Mide (sonda de latencia + estadísticas de WebRTC + eventos del ciclo de vida).
///   3. Sube los datos al backend en lotes.
///
/// La UI solo observa. Toda la instrumentación vive acá para que agregar una
/// pantalla nueva no implique duplicar la medición.
class SpikeSessionController extends ChangeNotifier {
  SpikeSessionController({
    required this.api,
    required this.clock,
    required this.sessionId,
    required this.role,
    required this.networkType,
    this.carrier,
  });

  final SpikeApi api;
  final ClockSync clock;
  final String sessionId;
  final SpikeRole role;
  final NetworkType networkType;
  final String? carrier;

  Room? _room;
  Room? get room => _room;

  final _statsAdapter = StatsAdapter();
  final List<QualitySample> _sampleBuffer = [];
  final List<SpikeEventRecord> _eventBuffer = [];
  final List<StreamSubscription<dynamic>> _subscriptions = [];

  /// `track.events.listen()` NO devuelve un StreamSubscription sino un
  /// `CancelListenFunc` (una función que hay que invocar). Se guardan aparte.
  final List<CancelListenFunc> _trackListenerCancels = [];

  EventsListener<RoomEvent>? _roomListener;
  Timer? _sampleTimer;
  Timer? _probeTimer;
  Timer? _flushTimer;
  Timer? _resyncTimer;

  int _sampleSeq = 0;
  int _probeSeq = 0;
  StatsSnapshot _latestStats = StatsSnapshot.empty;
  int? _latestProbeLatencyMs;

  int? _connectStartedAtMs;
  int? _reconnectStartedAtMs;
  int? _subscribedAtMs;
  bool _firstFrameReported = false;

  /// Instante en que se perdió el video del emisor.
  ///
  /// Distinto de la reconexión de NUESTRA sala: cuando al emisor se le cae la
  /// red, el espectador sigue conectado al SFU perfectamente — lo único que
  /// pasa es que el track desaparece. El corte que sufre la persona que está
  /// mirando es este, y es el número que importa para el producto.
  int? _videoLostAtMs;
  bool _hadVideoOnce = false;

  // ── Estado observable por la UI ────────────────────────────────────────────
  String status = 'idle';
  String? errorMessage;
  int uploadedSamples = 0;
  int reconnectCount = 0;
  int? lastProbeLatencyMs;
  int? lastConnectMs;
  int? lastReconnectMs;
  int? lastFirstFrameMs;
  int? lastVideoOutageMs;
  StatsSnapshot get stats => _latestStats;

  /// True cuando ya hubo video y ahora no hay. Permite distinguir en la UI
  /// "el emisor se cayó" de "todavía no empezó a transmitir", que se veían
  /// exactamente igual y hacían pensar que la sesión nunca había arrancado.
  bool get broadcasterLost => _hadVideoOnce && remoteVideoTrack == null;

  /// Segundos que lleva el corte actual, para mostrarlo en pantalla.
  int get currentOutageSec =>
      _videoLostAtMs == null ? 0 : ((clock.nowMs() - _videoLostAtMs!) / 1000).round();

  /// Track remoto que la UI debe renderizar (solo en el rol VIEWER).
  VideoTrack? remoteVideoTrack;

  // ═══════════════════════════════════════════════════════════════════════════
  // Ciclo de vida
  // ═══════════════════════════════════════════════════════════════════════════

  Future<void> start({required IssuedToken token}) async {
    _setStatus('connecting');
    _connectStartedAtMs = clock.nowMs();
    _record(SpikeEventType.ROOM_CONNECTING);

    final room = Room(
      roomOptions: const RoomOptions(
        // adaptiveStream + dynacast son el ABR de LiveKit: el SFU entrega a
        // cada espectador la capa de simulcast que su red aguanta. Validar que
        // esto funcione es uno de los objetivos del spike.
        adaptiveStream: true,
        dynacast: true,
        defaultVideoPublishOptions: VideoPublishOptions(
          simulcast: true,
          videoEncoding: VideoEncoding(maxBitrate: 3 * 1000 * 1000, maxFramerate: 30),
        ),
        defaultCameraCaptureOptions: CameraCaptureOptions(
          // Vertical 9:16, que es el formato del producto.
          params: VideoParametersPresets.h1080_169,
          cameraPosition: CameraPosition.back,
        ),
      ),
    );
    _room = room;

    _attachRoomListeners(room);

    try {
      await room.connect(
        token.wsUrl,
        token.token,
        connectOptions: const ConnectOptions(autoSubscribe: true),
      );
    } catch (e) {
      _setStatus('error');
      errorMessage = e.toString();
      _record(SpikeEventType.ERROR, detail: {'phase': 'connect', 'error': e.toString()});
      await _flush();
      rethrow;
    }

    if (role == SpikeRole.BROADCASTER) {
      await room.localParticipant?.setCameraEnabled(true);
      await room.localParticipant?.setMicrophoneEnabled(true);
      _record(SpikeEventType.TRACK_PUBLISHED);
      _startProbe();
    }

    _startSampling();
    _startFlushing();
    _watchConnectivity();
    _resyncTimer = clock.startPeriodicResync();
  }

  Future<void> stop() async {
    _record(SpikeEventType.SESSION_END);
    _sampleTimer?.cancel();
    _probeTimer?.cancel();
    _flushTimer?.cancel();
    _resyncTimer?.cancel();
    for (final s in _subscriptions) {
      await s.cancel();
    }
    _subscriptions.clear();
    for (final cancel in _trackListenerCancels) {
      await cancel();
    }
    _trackListenerCancels.clear();
    await _roomListener?.dispose();
    await _flush(); // último envío antes de cortar
    await _room?.disconnect();
    await _room?.dispose();
    _room = null;
    _setStatus('stopped');
  }

  @override
  void dispose() {
    unawaited(stop());
    super.dispose();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Eventos de la sala
  // ═══════════════════════════════════════════════════════════════════════════

  void _attachRoomListeners(Room room) {
    final listener = room.createListener();
    _roomListener = listener;

    listener
      ..on<RoomConnectedEvent>((_) {
        final now = clock.nowMs();
        lastConnectMs = _connectStartedAtMs != null ? now - _connectStartedAtMs! : null;
        _record(SpikeEventType.ROOM_CONNECTED, durationMs: lastConnectMs);
        _setStatus('connected');
      })
      ..on<RoomReconnectingEvent>((_) {
        // No se destruye nada: el live sobrevive a un corte breve.
        // Este es exactamente el comportamiento que el spike tiene que validar.
        _reconnectStartedAtMs = clock.nowMs();
        reconnectCount++;
        _record(SpikeEventType.ROOM_RECONNECTING);
        _setStatus('reconnecting');
      })
      ..on<RoomReconnectedEvent>((_) {
        final now = clock.nowMs();
        lastReconnectMs = _reconnectStartedAtMs != null ? now - _reconnectStartedAtMs! : null;
        _record(SpikeEventType.ROOM_RECONNECTED, durationMs: lastReconnectMs);
        _setStatus('connected');
      })
      ..on<RoomDisconnectedEvent>((e) {
        _record(SpikeEventType.ROOM_DISCONNECTED, detail: {'reason': e.reason?.name});
        _setStatus('disconnected');
      })
      ..on<TrackSubscribedEvent>((e) {
        _subscribedAtMs = clock.nowMs();

        // Si veníamos de un corte, la duración de este evento ES el tiempo que
        // el espectador estuvo sin ver nada. Ese es el número que mide si un
        // vendedor puede transmitir caminando por la calle.
        final outage = _videoLostAtMs == null ? null : clock.nowMs() - _videoLostAtMs!;
        if (outage != null) lastVideoOutageMs = outage;
        _videoLostAtMs = null;

        _record(SpikeEventType.TRACK_SUBSCRIBED, durationMs: outage);

        if (e.track is VideoTrack) {
          _hadVideoOnce = true;
          remoteVideoTrack = e.track as VideoTrack;
          _listenReceiverStats(e.track as VideoTrack);
          notifyListeners();
        }
      })
      ..on<TrackUnsubscribedEvent>((_) {
        // El emisor perdió la red. NUESTRA sala sigue conectada: por eso el
        // estado no pasa a 'reconnecting' y hace falta este marcador aparte.
        if (_hadVideoOnce) _videoLostAtMs = clock.nowMs();
        remoteVideoTrack = null;
        _record(SpikeEventType.TRACK_UNSUBSCRIBED);
        notifyListeners();
      })
      ..on<ParticipantDisconnectedEvent>((e) {
        _record(
          SpikeEventType.ROOM_DISCONNECTED,
          detail: {'remoteParticipantLeft': e.participant.identity},
        );
        notifyListeners();
      })
      ..on<LocalTrackPublishedEvent>((e) {
        if (e.publication.track is VideoTrack) {
          _listenSenderStats(e.publication.track as VideoTrack);
        }
      })
      ..on<DataReceivedEvent>((e) {
        _onProbeReceived(e.data);
      })
      ..on<ParticipantConnectedEvent>((e) {
        _record(SpikeEventType.QUALITY_CHANGED,
            detail: {'participantJoined': e.participant.identity});
      });
  }

  void _listenReceiverStats(VideoTrack track) {
    _trackListenerCancels.add(
      track.events.listen((event) {
        if (event is VideoReceiverStatsEvent) {
          _latestStats = _statsAdapter.fromReceiver(event);

          // Primer frame decodificado: es el "time to first frame" que percibe
          // el usuario al entrar a un live. Uno de los dos números de UX que
          // más importan, junto con el tiempo de reconexión.
          if (!_firstFrameReported && (_latestStats.framesDecoded ?? 0) > 0) {
            _firstFrameReported = true;
            lastFirstFrameMs = _subscribedAtMs != null ? clock.nowMs() - _subscribedAtMs! : null;
            _record(SpikeEventType.FIRST_FRAME, durationMs: lastFirstFrameMs);
          }
          notifyListeners();
        }
      }),
    );
  }

  void _listenSenderStats(VideoTrack track) {
    _trackListenerCancels.add(
      track.events.listen((event) {
        if (event is VideoSenderStatsEvent) {
          _latestStats = _statsAdapter.fromSender(event);
          notifyListeners();
        }
      }),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sonda de latencia por el canal de datos
  // ═══════════════════════════════════════════════════════════════════════════

  /// El broadcaster publica un paquete con su reloj **corregido al del
  /// servidor**. El viewer resta y obtiene latencia one-way de transporte.
  ///
  /// ⚠️ Esto NO es glass-to-glass: el canal de datos se saltea encode, jitter
  /// buffer, decode y render. Es un **piso** de la latencia real y se usa para
  /// tener volumen de muestras; la verdad la da la medición manual con foto.
  void _startProbe() {
    _probeTimer = Timer.periodic(
      const Duration(milliseconds: AppConfig.probeIntervalMs),
      (_) async {
        final lp = _room?.localParticipant;
        if (lp == null) return;
        final packet = ProbePacket(seq: _probeSeq++, sentAtServerMs: clock.nowMs());
        try {
          await lp.publishData(
            utf8.encode(packet.encode()),
            reliable: false, // sin retransmisión: mide la ruta rápida, como el video
            topic: 'probe',
          );
        } catch (_) {
          // Durante una reconexión el canal no existe. No es un error de la prueba.
        }
      },
    );
  }

  void _onProbeReceived(List<int> data) {
    final packet = ProbePacket.decode(utf8.decode(data));
    if (packet == null) return;

    final latency = clock.nowMs() - packet.sentAtServerMs;

    // Descarta valores imposibles: si el reloj todavía no sincronizó, salen
    // negativos o absurdos y contaminarían los percentiles.
    if (latency < -2000 || latency > 30000) return;

    _latestProbeLatencyMs = latency;
    lastProbeLatencyMs = latency;
    notifyListeners();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Muestreo y subida
  // ═══════════════════════════════════════════════════════════════════════════

  void _startSampling() {
    _sampleTimer = Timer.periodic(
      const Duration(milliseconds: AppConfig.sampleIntervalMs),
      (_) => _takeSample(),
    );
  }

  void _takeSample() {
    final s = _latestStats;
    _sampleBuffer.add(
      QualitySample(
        seq: _sampleSeq++,
        atMs: clock.nowMs(),
        networkType: networkType,
        carrier: carrier,
        clockOffsetMs: clock.offsetMs,
        probeLatencyMs: _latestProbeLatencyMs,
        rttMs: s.rttMs,
        jitterMs: s.jitterMs,
        packetsLost: s.packetsLost,
        packetLossPct: s.packetLossPct,
        jitterBufferDelayMs: s.jitterBufferDelayMs,
        framesDecoded: s.framesDecoded,
        framesDropped: s.framesDropped,
        freezeCount: s.freezeCount,
        bitrateKbps: s.bitrateKbps,
        fps: s.fps,
        frameWidth: s.frameWidth,
        frameHeight: s.frameHeight,
        videoLayer: StatsAdapter.layerFromHeight(s.frameHeight),
        connectionQuality: _room?.localParticipant?.connectionQuality.name,
      ),
    );

    if (_sampleBuffer.length >= AppConfig.sampleBatchSize) unawaited(_flush());
  }

  void _startFlushing() {
    // Red de seguridad: si el buffer no se llena (por ejemplo, tras una
    // desconexión), igual se sube lo que haya.
    _flushTimer = Timer.periodic(const Duration(seconds: 15), (_) => unawaited(_flush()));
  }

  Future<void> _flush() async {
    if (_sampleBuffer.isEmpty && _eventBuffer.isEmpty) return;

    final samples = List<QualitySample>.from(_sampleBuffer);
    final events = List<SpikeEventRecord>.from(_eventBuffer);
    _sampleBuffer.clear();
    _eventBuffer.clear();

    try {
      if (samples.isNotEmpty) {
        final accepted =
            await api.uploadSamples(sessionId: sessionId, role: role, samples: samples);
        uploadedSamples += accepted;
      }
      if (events.isNotEmpty) {
        await api.uploadEvents(sessionId: sessionId, role: role, events: events);
      }
      notifyListeners();
    } catch (_) {
      // Estamos cortando la red a propósito: perder una subida es lo esperado.
      // Se reinserta al principio para no perder datos, con un tope para no
      // agotar la memoria si la caída se prolonga.
      _sampleBuffer.insertAll(0, samples.take(200));
      _eventBuffer.insertAll(0, events.take(100));
    }
  }

  void _record(SpikeEventType type, {int? durationMs, Map<String, dynamic>? detail}) {
    _eventBuffer.add(
      SpikeEventRecord(type: type, atMs: clock.nowMs(), durationMs: durationMs, detail: detail),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Conectividad
  // ═══════════════════════════════════════════════════════════════════════════

  void _watchConnectivity() {
    _subscriptions.add(
      Connectivity().onConnectivityChanged.listen((results) {
        // WiFi ⇄ 4G es el evento que más rompe un live en la calle.
        // Se registra para poder correlacionar una reconexión con su causa.
        _record(
          SpikeEventType.NETWORK_CHANGED,
          detail: {'connectivity': results.map((r) => r.name).toList()},
        );
      }),
    );
  }

  void _setStatus(String value) {
    status = value;
    notifyListeners();
  }
}
