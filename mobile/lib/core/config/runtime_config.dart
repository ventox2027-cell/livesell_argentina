import 'package:shared_preferences/shared_preferences.dart';

import 'app_config.dart';

/// Configuración editable desde la app, sin recompilar.
///
/// Existe por una lección de campo: la URL del backend estaba fijada en tiempo
/// de compilación con `--dart-define`. Al pasar el emisor a datos móviles dejó
/// de alcanzar la IP local, y cambiarla implicaba recompilar el APK y
/// reinstalarlo en los dos teléfonos — 10 minutos por cada cambio de red.
///
/// Ahora se pega la URL nueva en la pantalla de inicio y listo. El valor de
/// `--dart-define` sigue siendo el default, así que un teléfono recién
/// instalado funciona sin tocar nada.
class RuntimeConfig {
  RuntimeConfig._(this._prefs);

  static const _kBaseUrl = 'cfg.apiBaseUrl';
  static const _kApiKey = 'cfg.spikeApiKey';

  final SharedPreferences _prefs;

  static RuntimeConfig? _instance;
  static RuntimeConfig get instance {
    final i = _instance;
    if (i == null) throw StateError('RuntimeConfig.load() no fue llamado');
    return i;
  }

  static Future<RuntimeConfig> load() async {
    _instance = RuntimeConfig._(await SharedPreferences.getInstance());
    return _instance!;
  }

  String get apiBaseUrl {
    final saved = _prefs.getString(_kBaseUrl);
    return (saved == null || saved.isEmpty) ? AppConfig.defaultApiBaseUrl : saved;
  }

  String get spikeApiKey {
    final saved = _prefs.getString(_kApiKey);
    return (saved == null || saved.isEmpty) ? AppConfig.defaultSpikeApiKey : saved;
  }

  /// Normaliza al guardar: sin barra final y sin espacios. Pegar una URL con
  /// una barra de más produce `//api/v1/...` y un 404 difícil de leer.
  Future<void> setApiBaseUrl(String value) async {
    final clean = value.trim().replaceAll(RegExp(r'/+$'), '');
    await _prefs.setString(_kBaseUrl, clean);
  }

  Future<void> setSpikeApiKey(String value) => _prefs.setString(_kApiKey, value.trim());

  bool get isConfigured => apiBaseUrl.isNotEmpty && spikeApiKey.isNotEmpty;
}
