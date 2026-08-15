import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../../core/network/spike_api.dart';
import '../../../core/time/clock_sync.dart';
import '../data/spike_session_controller.dart';
import '../domain/models.dart';
import 'widgets/stats_panel.dart';

/// Teléfono B. Recibe el video y **muestra el reloj de referencia superpuesto**.
///
/// Ese overlay es lo que hace posible medir glass-to-glass con una sola foto:
///
///   · El teléfono A apunta a una notebook que muestra `glass-timer.html`
///     (sincronizada con el MISMO reloj de servidor).
///   · Esta pantalla superpone su propio reloj de servidor.
///   · Se fotografía SOLO esta pantalla: dentro del video se ve la hora del
///     momento en que la cámara capturó, y en el overlay la hora actual.
///
///       glass-to-glass = overlay − hora dentro del video
///
/// Sin el overlay harían falta dos dispositivos en la misma foto y sincronizar
/// dos lecturas, que es donde se cuela la mayor parte del error de medición.
class ViewerScreen extends StatefulWidget {
  const ViewerScreen({
    super.key,
    required this.api,
    required this.clock,
    required this.sessionId,
    required this.token,
    required this.networkType,
    this.carrier,
  });

  final SpikeApi api;
  final ClockSync clock;
  final String sessionId;
  final IssuedToken token;
  final NetworkType networkType;
  final String? carrier;

  @override
  State<ViewerScreen> createState() => _ViewerScreenState();
}

class _ViewerScreenState extends State<ViewerScreen> with SingleTickerProviderStateMixin {
  late final SpikeSessionController _controller;
  late final Ticker _ticker;

  /// Reloj del overlay. En un ValueNotifier propio para que repintar 60 veces
  /// por segundo NO reconstruya el reproductor ni el panel de métricas.
  final _overlayClock = ValueNotifier<int>(0);

  bool _starting = true;
  bool _showOverlayClock = true;
  String? _fatalError;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable();

    _controller = SpikeSessionController(
      api: widget.api,
      clock: widget.clock,
      sessionId: widget.sessionId,
      role: SpikeRole.VIEWER,
      networkType: widget.networkType,
      carrier: widget.carrier,
    )..addListener(_onUpdate);

    _ticker = createTicker((_) => _overlayClock.value = widget.clock.nowMs())..start();
    _start();
  }

  Future<void> _start() async {
    try {
      await _controller.start(token: widget.token);
    } catch (e) {
      if (mounted) setState(() => _fatalError = e.toString());
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  void _onUpdate() => setState(() {});

  @override
  void dispose() {
    WakelockPlus.disable();
    _ticker.dispose();
    _overlayClock.dispose();
    _controller.removeListener(_onUpdate);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final track = _controller.remoteVideoTrack;

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          if (track != null)
            // contain y no cover: recortar el video escondería justo el reloj
            // de la notebook, que es lo que hay que leer en la foto.
            VideoTrackRenderer(track, fit: VideoViewFit.contain)
          else if (_controller.broadcasterLost)
            // Distinto de "todavía no empezó": el emisor perdió la red.
            // Antes los dos casos se veían igual y parecía que la sesión
            // nunca había arrancado.
            _BroadcasterLostView(clockTicks: _overlayClock, controller: _controller)
          else
            const Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  CircularProgressIndicator(),
                  SizedBox(height: 16),
                  Text('Esperando el video del teléfono A…',
                      style: TextStyle(color: Colors.white54)),
                ],
              ),
            ),

          // ══ EL RELOJ DE REFERENCIA ══════════════════════════════════════
          if (_showOverlayClock)
            Positioned(
              top: 60,
              left: 0,
              right: 0,
              child: Center(child: _OverlayClock(millis: _overlayClock)),
            ),

          Positioned(
            left: 12,
            bottom: 150,
            child: StatsPanel(
              role: 'VIEWER',
              status: _controller.status,
              stats: _controller.stats,
              probeLatencyMs: _controller.lastProbeLatencyMs,
              uploadedSamples: _controller.uploadedSamples,
              reconnectCount: _controller.reconnectCount,
              connectMs: _controller.lastConnectMs,
              reconnectMs: _controller.lastReconnectMs,
              firstFrameMs: _controller.lastFirstFrameMs,
              clockOffsetMs: widget.clock.offsetMs,
            ),
          ),

          if (_controller.status == 'reconnecting' || _controller.broadcasterLost)
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 8),
                color: Colors.orange,
                child: Text(
                  _controller.broadcasterLost
                      // Se distinguen porque son dos fallas distintas:
                      // acá el espectador está bien y el que se cayó es el emisor.
                      ? 'EL EMISOR PERDIÓ LA CONEXIÓN — esperando que vuelva'
                      : 'RECONECTANDO — tu conexión se cayó',
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12),
                ),
              ),
            ),

          if (_controller.lastVideoOutageMs != null)
            Positioned(
              top: 130,
              left: 0,
              right: 0,
              child: Center(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.7),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: Colors.amberAccent.withValues(alpha: 0.5)),
                  ),
                  child: Text(
                    'último corte: ${_controller.lastVideoOutageMs} ms',
                    style: const TextStyle(
                      color: Colors.amberAccent,
                      fontFamily: 'monospace',
                      fontSize: 12,
                    ),
                  ),
                ),
              ),
            ),

          Positioned(
            left: 16,
            right: 16,
            bottom: 24,
            child: Column(
              children: [
                FilledButton.icon(
                  onPressed: _openMeasurementSheet,
                  icon: const Icon(Icons.camera_alt),
                  label: const Text('CARGAR MEDICIÓN DE LA FOTO'),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: () => setState(() => _showOverlayClock = !_showOverlayClock),
                        icon: Icon(_showOverlayClock ? Icons.timer_off : Icons.timer),
                        label: Text(_showOverlayClock ? 'Ocultar reloj' : 'Mostrar reloj'),
                        style: FilledButton.styleFrom(backgroundColor: Colors.white24),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _finish,
                        icon: const Icon(Icons.close),
                        label: const Text('SALIR'),
                        style: FilledButton.styleFrom(backgroundColor: Colors.red),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),

          if (_starting)
            Container(
                color: Colors.black87, child: const Center(child: CircularProgressIndicator())),

          if (_fatalError != null)
            Container(
              color: Colors.black.withValues(alpha: 0.9),
              padding: const EdgeInsets.all(24),
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline, color: Colors.redAccent, size: 48),
                    const SizedBox(height: 16),
                    Text(_fatalError!, textAlign: TextAlign.center),
                    const SizedBox(height: 24),
                    FilledButton(onPressed: _finish, child: const Text('Volver')),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _finish() async {
    await _controller.stop();
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _openMeasurementSheet() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFF1A1A1A),
      builder: (_) => _MeasurementSheet(
        api: widget.api,
        sessionId: widget.sessionId,
        networkType: widget.networkType,
        carrier: widget.carrier,
        currentEstimate: _controller.lastProbeLatencyMs,
      ),
    );
  }
}

/// Pantalla de "el emisor perdió la conexión".
///
/// El contador en segundos es lo importante: permite ver si el emisor vuelve y
/// cuánto tardó, sin depender de leer los logs después.
///
/// 📌 **Deuda de producto detectada acá.** En la app real, esta pantalla NO
/// debería ser negra: tiene que quedar el **último frame congelado** y el chat
/// vivo (blueprint/01 §5.6 y 06 §11). Una pantalla en negro hace que la sala se
/// vacíe; un frame congelado con gente escribiendo hace que esperen.
class _BroadcasterLostView extends StatelessWidget {
  const _BroadcasterLostView({required this.clockTicks, required this.controller});

  final ValueNotifier<int> clockTicks;
  final SpikeSessionController controller;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: clockTicks,
      builder: (_, __, ___) {
        final sec = controller.currentOutageSec;
        return Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.wifi_off, size: 56, color: Colors.orangeAccent),
              const SizedBox(height: 16),
              const Text(
                'El emisor perdió la conexión',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 8),
              Text(
                '${sec}s sin video',
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 32,
                  color: Colors.orangeAccent,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                'Tu conexión está bien.\nSe reanuda solo cuando el emisor vuelva.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white54, fontSize: 13),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Reloj de referencia. Monoespaciado, grande y con fondo opaco: tiene que ser
/// legible en una foto sacada con otro teléfono, a veces con reflejo.
class _OverlayClock extends StatelessWidget {
  const _OverlayClock({required this.millis});
  final ValueNotifier<int> millis;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: millis,
      builder: (_, value, __) {
        final t = DateTime.fromMillisecondsSinceEpoch(value);
        final text = '${_two(t.minute)}:${_two(t.second)}.${_three(t.millisecond)}';
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
          decoration: BoxDecoration(
            color: Colors.black,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: Colors.greenAccent, width: 2),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('AHORA (servidor)',
                  style: TextStyle(color: Colors.greenAccent, fontSize: 10, letterSpacing: 2)),
              Text(
                text,
                style: const TextStyle(
                  color: Colors.greenAccent,
                  fontFamily: 'monospace',
                  fontSize: 38,
                  fontWeight: FontWeight.bold,
                  height: 1.1,
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  static String _two(int n) => n.toString().padLeft(2, '0');
  static String _three(int n) => n.toString().padLeft(3, '0');
}

/// Carga de la medición manual: se restan los dos relojes leídos en la foto.
class _MeasurementSheet extends StatefulWidget {
  const _MeasurementSheet({
    required this.api,
    required this.sessionId,
    required this.networkType,
    required this.carrier,
    required this.currentEstimate,
  });

  final SpikeApi api;
  final String sessionId;
  final NetworkType networkType;
  final String? carrier;
  final int? currentEstimate;

  @override
  State<_MeasurementSheet> createState() => _MeasurementSheetState();
}

class _MeasurementSheetState extends State<_MeasurementSheet> {
  final _overlayCtrl = TextEditingController();
  final _videoCtrl = TextEditingController();
  final _noteCtrl = TextEditingController();
  bool _busy = false;
  String? _error;

  /// Acepta "12:34.567", "34.567" o "34567". En la calle, con una mano y sin
  /// luz, tolerar formatos evita que se pierdan mediciones por un tipeo.
  int? _parseMs(String raw) {
    final s = raw.trim();
    if (s.isEmpty) return null;

    final withColon = RegExp(r'^(\d{1,2}):(\d{1,2})[.,](\d{1,3})$').firstMatch(s);
    if (withColon != null) {
      final m = int.parse(withColon.group(1)!);
      final sec = int.parse(withColon.group(2)!);
      final ms = int.parse(withColon.group(3)!.padRight(3, '0'));
      return (m * 60 + sec) * 1000 + ms;
    }

    final secMs = RegExp(r'^(\d{1,2})[.,](\d{1,3})$').firstMatch(s);
    if (secMs != null) {
      final sec = int.parse(secMs.group(1)!);
      final ms = int.parse(secMs.group(2)!.padRight(3, '0'));
      return sec * 1000 + ms;
    }

    return int.tryParse(s.replaceAll(RegExp(r'\D'), ''));
  }

  Future<void> _submit() async {
    final overlay = _parseMs(_overlayCtrl.text);
    final video = _parseMs(_videoCtrl.text);

    if (overlay == null || video == null) {
      setState(() => _error = 'Formato inválido. Usá mm:ss.mmm — por ejemplo 12:34.567');
      return;
    }

    var diff = overlay - video;
    // Si el minuto cambió entre una lectura y la otra, la resta sale negativa.
    if (diff < 0) diff += 60 * 1000;

    if (diff <= 0 || diff > 30000) {
      setState(() => _error = 'La diferencia ($diff ms) no es plausible. Revisá las lecturas.');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      await widget.api.recordGlassToGlass(
        sessionId: widget.sessionId,
        latencyMs: diff,
        networkType: widget.networkType,
        carrier: widget.carrier,
        note: _noteCtrl.text.trim(),
      );
      if (mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Medición cargada: $diff ms'), backgroundColor: Colors.green),
        );
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'No se pudo guardar: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 20, 20, MediaQuery.of(context).viewInsets.bottom + 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Medición glass-to-glass',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
          const SizedBox(height: 6),
          const Text(
            'Sacale una foto a ESTA pantalla y leé los dos relojes: el verde de arriba '
            '(overlay) y el que se ve DENTRO del video (la notebook).',
            style: TextStyle(color: Colors.white60, fontSize: 13),
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _overlayCtrl,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(
              labelText: 'Reloj VERDE del overlay (mm:ss.mmm)',
              hintText: '12:34.567',
              border: OutlineInputBorder(),
              prefixIcon: Icon(Icons.timer, color: Colors.greenAccent),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _videoCtrl,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(
              labelText: 'Reloj DENTRO del video (mm:ss.mmm)',
              hintText: '12:34.012',
              border: OutlineInputBorder(),
              prefixIcon: Icon(Icons.videocam),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _noteCtrl,
            decoration: const InputDecoration(
              labelText: 'Nota (opcional)',
              hintText: 'Justo después de cambiar de WiFi a 4G',
              border: OutlineInputBorder(),
            ),
          ),
          if (widget.currentEstimate != null) ...[
            const SizedBox(height: 14),
            Text(
              'Referencia: la sonda de datos marca ${widget.currentEstimate} ms '
              '(es transporte, la real siempre es mayor)',
              style: const TextStyle(color: Colors.white38, fontSize: 12),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.redAccent, fontSize: 13)),
          ],
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _busy ? null : _submit,
            child: _busy
                ? const SizedBox(
                    height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('GUARDAR MEDICIÓN'),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _overlayCtrl.dispose();
    _videoCtrl.dispose();
    _noteCtrl.dispose();
    super.dispose();
  }
}
