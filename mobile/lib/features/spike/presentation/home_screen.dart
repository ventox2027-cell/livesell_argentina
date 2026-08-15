import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/config/app_config.dart';
import '../../../core/config/runtime_config.dart';
import '../../../core/device/device_info.dart';
import '../../../core/network/spike_api.dart';
import '../../../core/time/clock_sync.dart';
import '../../payments/presentation/checkout_screen.dart';
import '../domain/models.dart';
import 'broadcaster_screen.dart';
import 'viewer_screen.dart';

/// Pantalla de arranque del spike.
///
/// Flujo: el teléfono A crea la sesión y transmite; el teléfono B se une
/// pegando el sessionId. Es la forma más simple de coordinar dos dispositivos
/// en la calle sin construir un sistema de emparejamiento.
class SpikeHomeScreen extends StatefulWidget {
  const SpikeHomeScreen({super.key});

  @override
  State<SpikeHomeScreen> createState() => _SpikeHomeScreenState();
}

class _SpikeHomeScreenState extends State<SpikeHomeScreen> {
  final _api = SpikeApi();
  late final _clock = ClockSync(_api);

  final _labelCtrl = TextEditingController();
  final _carrierCtrl = TextEditingController();
  final _locationCtrl = TextEditingController();
  final _joinCtrl = TextEditingController();
  final _baseUrlCtrl = TextEditingController();
  final _apiKeyCtrl = TextEditingController();

  NetworkType _network = NetworkType.UNKNOWN;
  bool _busy = false;
  bool _showConfig = false;
  String? _error;
  String? _syncInfo;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await _detectNetwork();
    await _restorePrefs();
    await _syncClock();
  }

  Future<void> _restorePrefs() async {
    final prefs = await SharedPreferences.getInstance();
    // Recordar la operadora ahorra tipeo en la décima corrida del día.
    _carrierCtrl.text = prefs.getString('carrier') ?? '';
    _joinCtrl.text = prefs.getString('lastSessionId') ?? '';
    _baseUrlCtrl.text = RuntimeConfig.instance.apiBaseUrl;
    _apiKeyCtrl.text = RuntimeConfig.instance.spikeApiKey;
    if (mounted) setState(() {});
  }

  /// Aplica la URL nueva y vuelve a sincronizar contra ese backend.
  /// Resincronizar es obligatorio: el offset del reloj es relativo al servidor,
  /// así que apuntar a otro backend sin resincronizar daría mediciones falsas.
  Future<void> _saveConfig() async {
    setState(() {
      _busy = true;
      _error = null;
    });

    await RuntimeConfig.instance.setApiBaseUrl(_baseUrlCtrl.text);
    await RuntimeConfig.instance.setSpikeApiKey(_apiKeyCtrl.text);
    _api.applyConfig();
    _clock.reset();

    if (mounted) setState(() => _busy = false);
    await _syncClock();
  }

  Future<void> _detectNetwork() async {
    final results = await Connectivity().checkConnectivity();
    // connectivity_plus distingue wifi de mobile, pero NO la generación (4G/5G).
    // Se detecta lo que se puede y la generación la confirma la persona:
    // un dato que la persona verifica es más confiable que uno inventado.
    final detected = results.contains(ConnectivityResult.wifi)
        ? NetworkType.WIFI
        : results.contains(ConnectivityResult.mobile)
            ? NetworkType.CELLULAR_4G
            : NetworkType.UNKNOWN;
    if (mounted) setState(() => _network = detected);
  }

  Future<void> _syncClock() async {
    setState(() => _syncInfo = 'sincronizando reloj…');
    await _clock.sync(samples: AppConfig.clockSyncSamples);
    if (!mounted) return;
    setState(() {
      _syncInfo = _clock.isSynced
          ? 'reloj sincronizado · offset ${_clock.offsetMs} ms · mejor RTT ${_clock.bestRttMs} ms'
          : 'NO se pudo sincronizar el reloj — revisá la conexión con el backend';
    });
  }

  Future<bool> _ensurePermissions({required bool needsCamera}) async {
    final requested = <Permission>[Permission.microphone, if (needsCamera) Permission.camera];
    final statuses = await requested.request();
    final granted = statuses.values.every((s) => s.isGranted);
    if (!granted && mounted) {
      setState(() => _error = 'Faltan permisos de cámara o micrófono');
    }
    return granted;
  }

  Future<void> _startAsBroadcaster() async {
    if (_labelCtrl.text.trim().length < 3) {
      setState(() => _error = 'Poné una etiqueta descriptiva (ej.: "Personal 4G · Palermo")');
      return;
    }
    if (!_clock.isSynced) {
      setState(() => _error = 'El reloj no está sincronizado: la medición no sería válida');
      return;
    }
    if (!await _ensurePermissions(needsCamera: true)) return;

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final device = await readDeviceInfo(appVersion: '0.1.0');
      final session = await _api.createSession(
        label: _labelCtrl.text.trim(),
        carrier: _carrierCtrl.text.trim(),
        networkType: _network,
        locationNote: _locationCtrl.text.trim(),
        device: device,
      );

      final token = await _api.issueToken(
        sessionId: session.sessionId,
        role: SpikeRole.BROADCASTER,
        identity: 'a${DateTime.now().millisecondsSinceEpoch % 100000}',
        device: device,
      );

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('carrier', _carrierCtrl.text.trim());
      await prefs.setString('lastSessionId', session.sessionId);

      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => BroadcasterScreen(
            api: _api,
            clock: _clock,
            sessionId: session.sessionId,
            token: token,
            networkType: _network,
            carrier: _carrierCtrl.text.trim(),
          ),
        ),
      );
    } catch (e) {
      if (mounted) setState(() => _error = 'No se pudo crear la sesión: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _joinAsViewer() async {
    final sessionId = _joinCtrl.text.trim();
    if (!sessionId.startsWith('spk_')) {
      setState(() => _error = 'El sessionId tiene que empezar con "spk_"');
      return;
    }
    if (!_clock.isSynced) {
      setState(() => _error = 'El reloj no está sincronizado: la medición no sería válida');
      return;
    }
    if (!await _ensurePermissions(needsCamera: false)) return;

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final device = await readDeviceInfo(appVersion: '0.1.0');
      final token = await _api.issueToken(
        sessionId: sessionId,
        role: SpikeRole.VIEWER,
        identity: 'b${DateTime.now().millisecondsSinceEpoch % 100000}',
        device: device,
      );

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('lastSessionId', sessionId);

      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ViewerScreen(
            api: _api,
            clock: _clock,
            sessionId: sessionId,
            token: token,
            networkType: _network,
            carrier: _carrierCtrl.text.trim(),
          ),
        ),
      );
    } catch (e) {
      if (mounted) setState(() => _error = 'No se pudo unir: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Sprint 0 · Spike LiveKit'),
        actions: [IconButton(onPressed: _syncClock, icon: const Icon(Icons.schedule))],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _ClockBanner(info: _syncInfo, synced: _clock.isSynced),
            const SizedBox(height: 8),

            // ── Configuración del backend ──────────────────────────────────
            // Plegada por defecto: en el 90 % de las corridas no se toca.
            // Existe porque al pasar el emisor a datos móviles la IP local
            // deja de alcanzarse y hay que apuntar a un backend público, sin
            // recompilar el APK ni reinstalarlo en los dos teléfonos.
            Card(
              margin: EdgeInsets.zero,
              color: Colors.white10,
              child: Column(
                children: [
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.dns, size: 20),
                    title: Text(
                      RuntimeConfig.instance.apiBaseUrl,
                      style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: const Text('backend', style: TextStyle(fontSize: 11)),
                    trailing: Icon(_showConfig ? Icons.expand_less : Icons.expand_more),
                    onTap: () => setState(() => _showConfig = !_showConfig),
                  ),
                  if (_showConfig)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                      child: Column(
                        children: [
                          TextField(
                            controller: _baseUrlCtrl,
                            keyboardType: TextInputType.url,
                            autocorrect: false,
                            style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
                            decoration: const InputDecoration(
                              labelText: 'URL del backend',
                              hintText: 'https://xxx.trycloudflare.com',
                              helperText: 'Sin barra al final. Para 4G hace falta una URL pública.',
                              border: OutlineInputBorder(),
                              isDense: true,
                            ),
                          ),
                          const SizedBox(height: 10),
                          TextField(
                            controller: _apiKeyCtrl,
                            autocorrect: false,
                            obscureText: true,
                            style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
                            decoration: const InputDecoration(
                              labelText: 'SPIKE_API_KEY',
                              border: OutlineInputBorder(),
                              isDense: true,
                            ),
                          ),
                          const SizedBox(height: 10),
                          FilledButton.icon(
                            onPressed: _busy ? null : _saveConfig,
                            icon: const Icon(Icons.save),
                            label: const Text('GUARDAR Y RESINCRONIZAR'),
                            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(44)),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            if (_error != null) ...[
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.red.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.red.withValues(alpha: 0.4)),
                ),
                child: Text(_error!, style: const TextStyle(color: Colors.redAccent)),
              ),
              const SizedBox(height: 16),
            ],

            // ── A. Transmitir ────────────────────────────────────────────────
            const _SectionTitle('📡 Teléfono A — transmitir'),
            const SizedBox(height: 8),
            TextField(
              controller: _labelCtrl,
              decoration: const InputDecoration(
                labelText: 'Etiqueta de la corrida *',
                hintText: 'Personal 4G · Palermo · 19 h',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _carrierCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Operadora',
                      hintText: 'Personal / Movistar / Claro',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: DropdownButtonFormField<NetworkType>(
                    initialValue: _network,
                    decoration:
                        const InputDecoration(labelText: 'Red', border: OutlineInputBorder()),
                    items: NetworkType.values
                        .map((n) => DropdownMenuItem(value: n, child: Text(n.label)))
                        .toList(),
                    onChanged: (v) => setState(() => _network = v ?? NetworkType.UNKNOWN),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _locationCtrl,
              decoration: const InputDecoration(
                labelText: 'Ubicación / nota',
                hintText: 'Subte línea D, hora pico',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _busy ? null : _startAsBroadcaster,
              icon: const Icon(Icons.videocam),
              label: const Text('CREAR SESIÓN Y TRANSMITIR'),
            ),

            const SizedBox(height: 32),
            const Divider(),
            const SizedBox(height: 16),

            // ── B. Recibir ───────────────────────────────────────────────────
            const _SectionTitle('📱 Teléfono B — recibir'),
            const SizedBox(height: 8),
            const Text(
              'Copiá el sessionId que muestra el teléfono A.',
              style: TextStyle(color: Colors.white60),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _joinCtrl,
              decoration: InputDecoration(
                labelText: 'sessionId',
                hintText: 'spk_01JBQ…',
                border: const OutlineInputBorder(),
                suffixIcon: IconButton(
                  icon: const Icon(Icons.paste),
                  onPressed: () async {
                    final data = await Clipboard.getData(Clipboard.kTextPlain);
                    if (data?.text != null) _joinCtrl.text = data!.text!.trim();
                  },
                ),
              ),
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _busy ? null : _joinAsViewer,
              icon: const Icon(Icons.play_circle),
              label: const Text('UNIRSE COMO ESPECTADOR'),
              style: FilledButton.styleFrom(backgroundColor: Colors.teal),
            ),

            const SizedBox(height: 32),
            const Divider(),
            const SizedBox(height: 16),

            // ── C. Sprint 0B ─────────────────────────────────────────────────
            const _SectionTitle('💳 Sprint 0B — cobrar'),
            const SizedBox(height: 8),
            const Text(
              'Prueba de tokenización y cobro con Mercado Pago. '
              'Independiente del spike de video.',
              style: TextStyle(color: Colors.white60),
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _busy
                  ? null
                  : () => Navigator.of(context).push(
                        MaterialPageRoute<void>(builder: (_) => const CheckoutScreen()),
                      ),
              icon: const Icon(Icons.credit_card),
              label: const Text('PROBAR UN PAGO'),
              style: FilledButton.styleFrom(backgroundColor: Colors.indigo),
            ),

            const SizedBox(height: 24),
            Text(
              'v${AppConfig.defaultApiBaseUrl == RuntimeConfig.instance.apiBaseUrl ? "compilado" : "config. manual"}'
              ' · lote ${AppConfig.sampleBatchSize} muestras',
              style: const TextStyle(fontSize: 11, color: Colors.white38),
            ),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    _labelCtrl.dispose();
    _carrierCtrl.dispose();
    _locationCtrl.dispose();
    _joinCtrl.dispose();
    _baseUrlCtrl.dispose();
    _apiKeyCtrl.dispose();
    super.dispose();
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) =>
      Text(text, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold));
}

class _ClockBanner extends StatelessWidget {
  const _ClockBanner({required this.info, required this.synced});
  final String? info;
  final bool synced;

  @override
  Widget build(BuildContext context) {
    final color = synced ? Colors.green : Colors.orange;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Row(
        children: [
          Icon(synced ? Icons.check_circle : Icons.sync_problem, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(child: Text(info ?? '…', style: TextStyle(color: color, fontSize: 13))),
        ],
      ),
    );
  }
}
