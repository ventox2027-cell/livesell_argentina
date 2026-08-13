import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Guarda los tokens de sesión.
///
/// ─── Por qué almacenamiento seguro y no SharedPreferences ───
///
/// SharedPreferences escribe un XML en claro. En un teléfono con root, o con
/// una copia de seguridad sin cifrar, cualquiera lo lee — y ahí está la sesión
/// completa de la persona, con su tarjeta guardada del otro lado.
///
/// `flutter_secure_storage` usa el Keystore de Android y el Keychain de iOS:
/// las claves las administra el sistema operativo y no salen del dispositivo.
///
/// ─── Lo que NO se guarda acá ───
///
/// Nada de la tarjeta. Ni el token de Mercado Pago, ni los últimos cuatro
/// dígitos, ni el nombre del titular. Si algún día alguien necesita mostrar
/// "termina en 4242", eso viene del backend en cada consulta.
class TokenStore {
  TokenStore({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              // `encryptedSharedPreferences` quedó obsoleto: la librería ya usa
              // cifrado propio por defecto y migra sola lo que hubiera guardado.
              //
              // `first_unlock` en iOS y no `always`: los tokens sólo son
              // accesibles después de que la persona desbloqueó el teléfono al
              // menos una vez desde que arrancó. Un dispositivo apagado y
              // robado no entrega la sesión.
              iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
            );

  final FlutterSecureStorage _storage;

  static const _kAccess = 'auth.access';
  static const _kRefresh = 'auth.refresh';
  static const _kExpira = 'auth.expiraEn';
  static const _kUsuario = 'auth.usuario';

  /// Caché en memoria del access token.
  ///
  /// Leer del Keychain en cada petición HTTP cuesta unos milisegundos y se
  /// hace decenas de veces por pantalla. La caché evita ese costo; el token
  /// vive en memoria del proceso, que es donde de todas formas termina.
  String? _accessEnMemoria;
  DateTime? _expiraEnMemoria;

  Future<void> guardar({
    required String accessToken,
    required String refreshToken,
    required DateTime expiraEn,
    required Map<String, dynamic> usuario,
  }) async {
    _accessEnMemoria = accessToken;
    _expiraEnMemoria = expiraEn;
    await Future.wait([
      _storage.write(key: _kAccess, value: accessToken),
      _storage.write(key: _kRefresh, value: refreshToken),
      _storage.write(key: _kExpira, value: expiraEn.toIso8601String()),
      _storage.write(key: _kUsuario, value: jsonEncode(usuario)),
    ]);
  }

  /// Sólo el access token: se llama en cada rotación.
  Future<void> actualizarAcceso({
    required String accessToken,
    required String refreshToken,
    required DateTime expiraEn,
  }) async {
    _accessEnMemoria = accessToken;
    _expiraEnMemoria = expiraEn;
    await Future.wait([
      _storage.write(key: _kAccess, value: accessToken),
      _storage.write(key: _kRefresh, value: refreshToken),
      _storage.write(key: _kExpira, value: expiraEn.toIso8601String()),
    ]);
  }

  Future<String?> accessToken() async {
    if (_accessEnMemoria != null) return _accessEnMemoria;
    _accessEnMemoria = await _storage.read(key: _kAccess);
    return _accessEnMemoria;
  }

  Future<String?> refreshToken() => _storage.read(key: _kRefresh);

  Future<Map<String, dynamic>?> usuario() async {
    final crudo = await _storage.read(key: _kUsuario);
    if (crudo == null) return null;
    try {
      return jsonDecode(crudo) as Map<String, dynamic>;
    } catch (_) {
      // Un JSON corrupto no puede dejar a la persona sin poder abrir la app.
      return null;
    }
  }

  Future<void> guardarUsuario(Map<String, dynamic> usuario) =>
      _storage.write(key: _kUsuario, value: jsonEncode(usuario));

  /// ¿El access token está por vencer?
  ///
  /// El margen de 60 segundos evita la carrera obvia: un token que era válido
  /// al empezar la petición y ya no lo es cuando llega al servidor. Sin él,
  /// una de cada tantas peticiones falla sin motivo aparente.
  Future<bool> aPuntoDeVencer() async {
    _expiraEnMemoria ??= DateTime.tryParse(await _storage.read(key: _kExpira) ?? '');
    final expira = _expiraEnMemoria;
    if (expira == null) return true;
    return DateTime.now().isAfter(expira.subtract(const Duration(seconds: 60)));
  }

  Future<void> limpiar() async {
    _accessEnMemoria = null;
    _expiraEnMemoria = null;
    await Future.wait([
      _storage.delete(key: _kAccess),
      _storage.delete(key: _kRefresh),
      _storage.delete(key: _kExpira),
      _storage.delete(key: _kUsuario),
    ]);
  }
}
