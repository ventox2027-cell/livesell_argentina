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
  });

  /// ⚠️ Es el client ID **WEB**, no el de Android. Ver `GoogleSignInService`.
  final String? googleServerClientId;
  final String? appleBundleId;
  final bool devLoginEnabled;

  bool get googleDisponible => (googleServerClientId ?? '').isNotEmpty;
  bool get appleDisponible => (appleBundleId ?? '').isNotEmpty;
}

/// Se resuelve una vez por arranque.
///
/// Si el backend no responde, se devuelve una configuración vacía en lugar de
/// romper: la pantalla de bienvenida tiene que poder mostrarse igual, aunque
/// sea para decir que no hay conexión y ofrecer cambiar el servidor.
final authConfigProvider = FutureProvider<AuthConfig>((ref) async {
  try {
    final res = await ref
        .watch(apiClientProvider)
        .get<Map<String, dynamic>>('/auth/config', sinAuth: true);

    final d = res.data;
    if (res.statusCode != 200 || d == null) return const AuthConfig();

    return AuthConfig(
      googleServerClientId: d['googleServerClientId'] as String?,
      appleBundleId: d['appleBundleId'] as String?,
      devLoginEnabled: d['devLoginEnabled'] as bool? ?? false,
    );
  } on DioException {
    return const AuthConfig();
  }
});
