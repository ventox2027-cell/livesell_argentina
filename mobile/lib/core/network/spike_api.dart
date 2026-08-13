import 'package:dio/dio.dart';

import '../config/runtime_config.dart';
import '../../features/spike/domain/models.dart';

/// Cliente HTTP del módulo de spike.
///
/// Toda la comunicación con el backend pasa por acá. La app **nunca** habla
/// directamente con LiveKit Cloud para obtener credenciales: pide un token
/// firmado y punto.
class SpikeApi {
  SpikeApi({Dio? dio})
      : _dio = dio ??
            Dio(
              BaseOptions(
                baseUrl: '${RuntimeConfig.instance.apiBaseUrl}/api/v1',
                // Timeouts cortos a propósito: en campo, esperar 30 s a un
                // backend inalcanzable es peor que fallar rápido y avisar.
                connectTimeout: const Duration(seconds: 8),
                receiveTimeout: const Duration(seconds: 12),
                headers: {
                  'content-type': 'application/json',
                  'x-spike-key': RuntimeConfig.instance.spikeApiKey,
                },
              ),
            ) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onError: (e, handler) {
          // Los errores de red durante una prueba de campo son ESPERADOS
          // (justamente estamos cortando el WiFi a propósito). No se propaga
          // ruido: quien llama decide qué hacer.
          handler.next(e);
        },
      ),
    );
  }

  final Dio _dio;

  /// Reapunta el cliente sin recrearlo. Se usa al cambiar la URL del backend
  /// desde la pantalla de inicio, por ejemplo al pasar de la IP local a un
  /// túnel público para poder medir en 4G.
  void applyConfig() {
    _dio.options.baseUrl = '${RuntimeConfig.instance.apiBaseUrl}/api/v1';
    _dio.options.headers['x-spike-key'] = RuntimeConfig.instance.spikeApiKey;
  }

  String get baseUrl => _dio.options.baseUrl;

  /// Reloj del servidor. Base de toda la medición cruzada entre dispositivos.
  Future<int> serverTime({required int clientSentAtMs}) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '/spike/time',
      queryParameters: {'clientSentAtMs': clientSentAtMs},
    );
    return res.data!['serverTimeMs'] as int;
  }

  Future<CreatedSession> createSession({
    required String label,
    String? carrier,
    required NetworkType networkType,
    String? locationNote,
    DeviceInfo? device,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/spike/sessions',
      data: {
        'label': label,
        if (carrier != null && carrier.isNotEmpty) 'carrier': carrier,
        'networkType': networkType.name,
        if (locationNote != null && locationNote.isNotEmpty) 'locationNote': locationNote,
        if (device != null) 'device': device.toJson(),
      },
    );
    return CreatedSession.fromJson(res.data!);
  }

  Future<IssuedToken> issueToken({
    required String sessionId,
    required SpikeRole role,
    required String identity,
    String? displayName,
    DeviceInfo? device,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/spike/token',
      data: {
        'sessionId': sessionId,
        'role': role.name,
        'identity': identity,
        if (displayName != null) 'displayName': displayName,
        if (device != null) 'device': device.toJson(),
      },
    );
    return IssuedToken.fromJson(res.data!);
  }

  Future<int> uploadSamples({
    required String sessionId,
    required SpikeRole role,
    required List<QualitySample> samples,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/spike/samples',
      data: {
        'sessionId': sessionId,
        'role': role.name,
        'samples': samples.map((s) => s.toJson()).toList(),
      },
    );
    return res.data!['accepted'] as int;
  }

  Future<int> uploadEvents({
    required String sessionId,
    required SpikeRole role,
    required List<SpikeEventRecord> events,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/spike/events',
      data: {
        'sessionId': sessionId,
        'role': role.name,
        'events': events.map((e) => e.toJson()).toList(),
      },
    );
    return res.data!['accepted'] as int;
  }

  /// Carga la medición manual leída de la foto. Es la referencia de verdad.
  Future<void> recordGlassToGlass({
    required String sessionId,
    required int latencyMs,
    required NetworkType networkType,
    String? carrier,
    String? note,
  }) async {
    await _dio.post<Map<String, dynamic>>(
      '/spike/glass-to-glass',
      data: {
        'sessionId': sessionId,
        'latencyMs': latencyMs,
        'networkType': networkType.name,
        if (carrier != null && carrier.isNotEmpty) 'carrier': carrier,
        if (note != null && note.isNotEmpty) 'note': note,
      },
    );
  }

  Future<Map<String, dynamic>> report(String sessionId) async {
    final res = await _dio.get<Map<String, dynamic>>('/spike/sessions/$sessionId/report');
    return res.data!;
  }

  Future<Map<String, dynamic>> endSession(String sessionId, {String? notes}) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/spike/sessions/$sessionId/end',
      data: {if (notes != null) 'notes': notes},
    );
    return res.data!;
  }
}
