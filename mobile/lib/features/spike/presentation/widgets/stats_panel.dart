import 'package:flutter/material.dart';

import '../../data/stats_adapter.dart';

/// Panel de métricas en vivo. Se mira de reojo durante la prueba de campo:
/// si algo se ve mal acá, se corrige la corrida en el momento en vez de
/// descubrirlo al analizar los datos en la oficina.
///
/// **Se toca para plegarlo.** En la primera medición de campo el panel tapaba
/// justo el reloj que hay que leer dentro del video. Plegado deja una sola
/// línea con lo esencial y libera la pantalla para la captura.
class StatsPanel extends StatefulWidget {
  const StatsPanel({
    super.key,
    required this.role,
    required this.status,
    required this.stats,
    required this.uploadedSamples,
    required this.reconnectCount,
    required this.clockOffsetMs,
    this.probeLatencyMs,
    this.connectMs,
    this.reconnectMs,
    this.firstFrameMs,
  });

  final String role;
  final String status;
  final StatsSnapshot stats;
  final int uploadedSamples;
  final int reconnectCount;
  final int clockOffsetMs;
  final int? probeLatencyMs;
  final int? connectMs;
  final int? reconnectMs;
  final int? firstFrameMs;

  @override
  State<StatsPanel> createState() => _StatsPanelState();
}

class _StatsPanelState extends State<StatsPanel> {
  bool _collapsed = false;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => setState(() => _collapsed = !_collapsed),
      child: _collapsed ? _buildCollapsed() : _buildExpanded(),
    );
  }

  /// Plegado: una sola línea. Deja libre el centro de la pantalla, que es donde
  /// aparece el reloj dentro del video y hay que poder leerlo en la captura.
  Widget _buildCollapsed() {
    final probe = widget.probeLatencyMs;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.72),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.white12),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.bar_chart, size: 14, color: Colors.white38),
          const SizedBox(width: 6),
          Text(
            probe != null ? '$probe ms' : '—',
            style: TextStyle(
              fontFamily: 'monospace',
              fontSize: 13,
              fontWeight: FontWeight.bold,
              color: probe != null ? _colorFor(probe, good: 300, warn: 600) : Colors.white54,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            '${widget.stats.fps?.toStringAsFixed(0) ?? '—'} fps',
            style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: Colors.white54),
          ),
        ],
      ),
    );
  }

  Widget _buildExpanded() {
    final stats = widget.stats;
    final probeLatencyMs = widget.probeLatencyMs;
    final connectMs = widget.connectMs;
    final reconnectMs = widget.reconnectMs;
    final firstFrameMs = widget.firstFrameMs;
    final role = widget.role;
    final uploadedSamples = widget.uploadedSamples;
    final reconnectCount = widget.reconnectCount;
    final clockOffsetMs = widget.clockOffsetMs;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.72),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.white12),
      ),
      child: DefaultTextStyle(
        style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: Colors.white),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(role, style: const TextStyle(fontSize: 10, color: Colors.white54, letterSpacing: 1)),
            const SizedBox(height: 6),

            if (probeLatencyMs != null)
              // El número que se mira todo el tiempo. Es transporte, no
              // glass-to-glass: el color usa umbrales más exigentes a propósito.
              _Row(
                label: 'sonda',
                value: '$probeLatencyMs ms',
                color: _colorFor(probeLatencyMs, good: 300, warn: 600),
                emphasized: true,
              ),

            _Row(label: 'bitrate', value: _fmt(stats.bitrateKbps, 'kbps')),
            _Row(label: 'fps', value: stats.fps?.toStringAsFixed(1) ?? '—'),
            _Row(
              label: 'capa',
              value: StatsAdapter.layerFromHeight(stats.frameHeight) ?? '—',
              suffix: stats.frameHeight != null ? '${stats.frameWidth}×${stats.frameHeight}' : null,
            ),
            _Row(
              label: 'pérdida',
              value: stats.packetLossPct != null ? '${stats.packetLossPct!.toStringAsFixed(1)}%' : '—',
              color: stats.packetLossPct != null
                  ? _colorFor(stats.packetLossPct!.round(), good: 1, warn: 5)
                  : null,
            ),
            _Row(label: 'jitter', value: _fmt(stats.jitterMs, 'ms')),
            _Row(label: 'buffer', value: _fmt(stats.jitterBufferDelayMs, 'ms')),
            if (stats.rttMs != null) _Row(label: 'rtt', value: '${stats.rttMs} ms'),
            if (stats.freezeCount != null && stats.freezeCount! > 0)
              _Row(label: 'freezes', value: '${stats.freezeCount}', color: Colors.orangeAccent),

            const Divider(height: 12, color: Colors.white12),

            if (connectMs != null) _Row(label: 'conexión', value: '$connectMs ms'),
            if (firstFrameMs != null)
              _Row(
                label: '1er frame',
                value: '$firstFrameMs ms',
                color: _colorFor(firstFrameMs, good: 1500, warn: 3000),
              ),
            if (reconnectMs != null) _Row(label: 'reconexión', value: '$reconnectMs ms'),
            _Row(label: 'reconex.', value: '$reconnectCount'),
            _Row(label: 'subidas', value: '$uploadedSamples'),
            _Row(label: 'offset', value: '$clockOffsetMs ms', color: Colors.white38),
          ],
        ),
      ),
    );
  }

}

String _fmt(num? v, String unit) => v == null ? '—' : '$v $unit';

Color _colorFor(int value, {required int good, required int warn}) {
  if (value <= good) return Colors.greenAccent;
  if (value <= warn) return Colors.amberAccent;
  return Colors.redAccent;
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value, this.color, this.suffix, this.emphasized = false});

  final String label;
  final String value;
  final Color? color;
  final String? suffix;
  final bool emphasized;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(width: 66, child: Text(label, style: const TextStyle(color: Colors.white54))),
          Text(
            value,
            style: TextStyle(
              color: color ?? Colors.white,
              fontWeight: emphasized ? FontWeight.bold : FontWeight.normal,
              fontSize: emphasized ? 14 : 11,
            ),
          ),
          if (suffix != null) ...[
            const SizedBox(width: 6),
            Text(suffix!, style: const TextStyle(color: Colors.white38, fontSize: 10)),
          ],
        ],
      ),
    );
  }
}
