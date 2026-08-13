import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../../core/network/spike_api.dart';
import '../../../core/time/clock_sync.dart';
import '../data/spike_session_controller.dart';
import '../domain/models.dart';
import 'widgets/stats_panel.dart';

/// Teléfono A. Transmite y publica la sonda de latencia.
///
/// Muestra el `sessionId` en grande porque es el dato que hay que dictar o
/// copiar al teléfono B en el medio de la calle.
class BroadcasterScreen extends StatefulWidget {
  const BroadcasterScreen({
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
  State<BroadcasterScreen> createState() => _BroadcasterScreenState();
}

class _BroadcasterScreenState extends State<BroadcasterScreen> {
  late final SpikeSessionController _controller;
  bool _starting = true;
  String? _fatalError;

  @override
  void initState() {
    super.initState();
    // Sin esto la pantalla se apaga a los 30 s y la transmisión se degrada
    // en medio de la medición.
    WakelockPlus.enable();

    _controller = SpikeSessionController(
      api: widget.api,
      clock: widget.clock,
      sessionId: widget.sessionId,
      role: SpikeRole.BROADCASTER,
      networkType: widget.networkType,
      carrier: widget.carrier,
    )..addListener(_onUpdate);

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

  Future<void> _finish() async {
    await _controller.stop();
    try {
      await widget.api.endSession(widget.sessionId);
    } catch (_) {
      // Cerrar la sesión en el backend es deseable pero no bloqueante:
      // los datos ya están subidos.
    }
    if (mounted) Navigator.of(context).pop();
  }

  @override
  void dispose() {
    WakelockPlus.disable();
    _controller.removeListener(_onUpdate);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final localVideo = _controller.room?.localParticipant?.videoTrackPublications
        .where((p) => p.track != null)
        .firstOrNull
        ?.track as VideoTrack?;

    return PopScope(
      canPop: false, // salir sin cerrar dejaría la sala abierta consumiendo minutos
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _confirmExit();
      },
      child: Scaffold(
        backgroundColor: Colors.black,
        body: Stack(
          fit: StackFit.expand,
          children: [
            if (localVideo != null)
              VideoTrackRenderer(localVideo, fit: VideoViewFit.cover)
            else
              const Center(child: CircularProgressIndicator()),

            // ── Cabecera: el sessionId que hay que pasar al teléfono B ───────
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Container(
                padding: const EdgeInsets.fromLTRB(16, 48, 16, 16),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [Colors.black.withValues(alpha: 0.85), Colors.transparent],
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        _StatusPill(status: _controller.status),
                        const Spacer(),
                        Text(
                          widget.networkType.label +
                              (widget.carrier?.isNotEmpty == true ? ' · ${widget.carrier}' : ''),
                          style: const TextStyle(color: Colors.white70, fontSize: 13),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    const Text('PASÁ ESTE ID AL TELÉFONO B',
                        style: TextStyle(color: Colors.white54, fontSize: 11, letterSpacing: 1.2)),
                    const SizedBox(height: 4),
                    GestureDetector(
                      onTap: () {
                        Clipboard.setData(ClipboardData(text: widget.sessionId));
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('sessionId copiado'), duration: Duration(seconds: 1)),
                        );
                      },
                      child: Row(
                        children: [
                          Expanded(
                            child: SelectableText(
                              widget.sessionId,
                              style: const TextStyle(
                                color: Colors.white,
                                fontFamily: 'monospace',
                                fontSize: 15,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          const Icon(Icons.copy, color: Colors.white70, size: 18),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),

            // ── Métricas en vivo ─────────────────────────────────────────────
            Positioned(
              left: 12,
              bottom: 110,
              child: StatsPanel(
                role: 'BROADCASTER',
                status: _controller.status,
                stats: _controller.stats,
                probeLatencyMs: null, // el emisor no mide su propia sonda
                uploadedSamples: _controller.uploadedSamples,
                reconnectCount: _controller.reconnectCount,
                connectMs: _controller.lastConnectMs,
                reconnectMs: _controller.lastReconnectMs,
                firstFrameMs: null,
                clockOffsetMs: widget.clock.offsetMs,
              ),
            ),

            // ── Controles ────────────────────────────────────────────────────
            Positioned(
              left: 16,
              right: 16,
              bottom: 24,
              child: Row(
                children: [
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: () => _controller.room?.localParticipant?.setCameraEnabled(true),
                      icon: const Icon(Icons.cameraswitch),
                      label: const Text('Cámara'),
                      style: FilledButton.styleFrom(backgroundColor: Colors.white24),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: _confirmExit,
                      icon: const Icon(Icons.stop_circle),
                      label: const Text('TERMINAR'),
                      style: FilledButton.styleFrom(backgroundColor: Colors.red),
                    ),
                  ),
                ],
              ),
            ),

            if (_starting)
              Container(
                color: Colors.black87,
                child: const Center(child: CircularProgressIndicator()),
              ),

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
                      const Text('No se pudo conectar a LiveKit',
                          style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 8),
                      Text(_fatalError!, textAlign: TextAlign.center,
                          style: const TextStyle(color: Colors.white70, fontSize: 12)),
                      const SizedBox(height: 24),
                      FilledButton(onPressed: _finish, child: const Text('Volver')),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmExit() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('¿Terminar la transmisión?'),
        content: const Text('Se suben las muestras pendientes y se cierra la sala.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Seguir')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Terminar')),
        ],
      ),
    );
    if (ok == true) await _finish();
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final (color, label) = switch (status) {
      'connected' => (Colors.red, 'EN VIVO'),
      'connecting' => (Colors.orange, 'CONECTANDO'),
      'reconnecting' => (Colors.orange, 'RECONECTANDO'),
      'disconnected' => (Colors.grey, 'DESCONECTADO'),
      'error' => (Colors.redAccent, 'ERROR'),
      _ => (Colors.grey, status.toUpperCase()),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(4)),
      child: Text(
        label,
        style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 0.8),
      ),
    );
  }
}
