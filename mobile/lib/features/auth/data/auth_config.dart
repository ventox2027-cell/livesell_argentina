import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/auth_providers.dart';

/// Configuración de acceso, servida por el backend.
///
/// No va compilada dentro del APK a propósito: cambiar un client ID de Google
/// no puede obligar a publicar una versión nueva en las tiendas y esperar a
/// que la gente actualice.
class AuthConfig {
  const AuthConfig({
    this.googleServerClientId,
    this.appleBundleId,
    this.devLoginEnabled = false,
    this.demoLoginEnabled = false,
    this.alcanzable = true,
  });

  /// La configuración que se usa cuando **no se pudo hablar con el backend**.
  const AuthConfig.sinConexion() : this(alcanzable: false);

  /// ⚠️ Es el client ID **WEB**, no el de Android. Ver `GoogleSignInService`.
  final String? googleServerClientId;
  final String? appleBundleId;
  final bool devLoginEnabled;

  /// Si este servidor acepta el login de la cuenta de revisión de Google Play.
  ///
  /// No es una medida de seguridad: el endpoint se puede llamar igual. Sirve
  /// para no ofrecer un camino que va a fallar.
  final bool demoLoginEnabled;

  /// ¿Contestó el servidor?
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// SIN ESTE CAMPO, LA APP MENTÍA
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Antes, un fallo de red devolvía una `AuthConfig` vacía —la misma que
  /// devuelve un servidor que de verdad no tiene Google configurado— y la
  /// pantalla de bienvenida decía:
  ///
  ///     "Google no está configurado en este servidor."
  ///
  /// Con el backend andando y el client ID correctamente cargado. El mensaje
  /// mandaba a revisar la configuración del servidor cuando el problema era que
  /// el teléfono no llegaba a él.
  ///
  /// Pasó en una prueba real y costó una vuelta entera de diagnóstico. Son dos
  /// problemas distintos, con arreglos distintos, y tienen que decirse distinto.
  final bool alcanzable;

  bool get googleDisponible => (googleServerClientId ?? '').isNotEmpty;
  bool get appleDisponible => (appleBundleId ?? '').isNotEmpty;
}

/// Se resuelve una vez por arranque, **y se puede volver a pedir**.
///
/// ─── Por qué importa que se pueda reintentar ───
///
/// Es un `FutureProvider`: su resultado queda cacheado para toda la sesión. Si
/// el backend estaba caído cuando arrancó la app —o el teléfono todavía no se
/// había conectado a la WiFi— la configuración vacía se quedaba pegada aunque
/// el servidor volviera un segundo después. La única salida era cerrar la app
/// por completo, y nada en la pantalla lo sugería.
///
/// Ahora la pantalla de bienvenida invalida este provider al reintentar.
final authConfigProvider = FutureProvider<AuthConfig>((ref) async {
  try {
    final res =
        await ref.watch(apiClientProvider).get<Map<String, dynamic>>('/auth/config', sinAuth: true);

    final d = res.data;

    // Un 4xx/5xx tampoco es "Google está apagado": es un servidor que no
    // contestó lo que se le pidió. `ApiClient` no lanza con 4xx —usa
    // `validateStatus: s < 500` para poder reintentar tras refrescar el token—
    // así que este caso llega hasta acá como respuesta normal.
    if (res.statusCode != 200 || d == null) return const AuthConfig.sinConexion();

    return AuthConfig(
      googleServerClientId: d['googleServerClientId'] as String?,
      appleBundleId: d['appleBundleId'] as String?,
      devLoginEnabled: d['devLoginEnabled'] as bool? ?? false,
      demoLoginEnabled: d['demoLoginEnabled'] as bool? ?? false,
    );
  } on DioException {
    return const AuthConfig.sinConexion();
  }
});
