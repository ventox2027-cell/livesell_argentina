import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/token_store.dart';
import '../../../core/network/api_client.dart';
import '../data/auth_repository.dart';
import '../domain/session.dart';

/// Estado de autenticación de la aplicación.
///
/// Es la raíz de la que cuelga todo lo demás: la navegación decide qué mostrar
/// mirando esto, y cualquier pantalla que necesite saber quién está adentro lo
/// lee de acá en vez de arrastrar el usuario por los constructores.

final tokenStoreProvider = Provider<TokenStore>((ref) => TokenStore());

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(
    tokens: ref.watch(tokenStoreProvider),
    // Cuando el backend invalida la sesión —vencida, cerrada desde otro
    // dispositivo, o detección de robo— la app tiene que reaccionar sola. Sin
    // este puente, seguiría mostrando la interfaz de alguien logueado mientras
    // cada petición devuelve 401.
    onSesionCerrada: () async {
      ref.read(sesionProvider.notifier).forzarCierre('Tu sesión se cerró. Entrá de nuevo.');
    },
  );
});

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  return AuthRepository(
    api: ref.watch(apiClientProvider),
    tokens: ref.watch(tokenStoreProvider),
  );
});

final sesionProvider = NotifierProvider<SesionNotifier, EstadoSesion>(SesionNotifier.new);

class SesionNotifier extends Notifier<EstadoSesion> {
  @override
  EstadoSesion build() {
    // Arranca en desconocido y resuelve en segundo plano. Ese tercer estado es
    // lo que evita el parpadeo del login al abrir la app con sesión válida.
    Future.microtask(restaurar);
    return const SesionDesconocida();
  }

  AuthRepository get _repo => ref.read(authRepositoryProvider);

  Future<void> restaurar() async {
    state = await _repo.restaurar();
  }

  Future<void> conGoogle(String idToken) async {
    state = await _repo.loginConGoogle(idToken);
  }

  Future<void> conApple(String idToken, {String? firstName, String? lastName}) async {
    state = await _repo.loginConApple(idToken, firstName: firstName, lastName: lastName);
  }

  Future<void> deDesarrollo({
    required String email,
    String firstName = 'Prueba',
    String lastName = 'Local',
    String role = 'buyer',
  }) async {
    state = await _repo.loginDeDesarrollo(
      email: email,
      firstName: firstName,
      lastName: lastName,
      role: role,
    );
  }

  /// Login de la cuenta de revisión de Google Play.
  ///
  /// Del otro lado sólo autentica cuentas marcadas como demostración. Ver
  /// `AuthRepository.loginDeRevision`.
  Future<void> deRevision({required String email, required String password}) async {
    state = await _repo.loginDeRevision(email: email, password: password);
  }

  Future<void> completarPerfil({
    String? firstName,
    String? lastName,
    String? phone,
    bool? whatsappOptIn,
  }) async {
    state = await _repo.completarPerfil(
      firstName: firstName,
      lastName: lastName,
      phone: phone,
      whatsappOptIn: whatsappOptIn,
    );
  }

  Future<void> cerrarSesion() async {
    await _repo.cerrarSesion();
    state = const SinSesion();
  }

  Future<void> cerrarTodas() async {
    await _repo.cerrarTodasLasSesiones();
    state = const SinSesion(motivo: 'Cerraste todas las sesiones.');
  }

  Future<void> cerrarCuenta() async {
    await _repo.cerrarCuenta();
    state = const SinSesion(motivo: 'Tu cuenta fue eliminada.');
  }

  /// Cierre forzado desde el interceptor. No llama al backend: la sesión ya no
  /// existe del otro lado.
  void forzarCierre(String motivo) {
    if (state is SinSesion) return;
    state = SinSesion(motivo: motivo);
  }
}

/// Usuario actual, o null. Atajo para las pantallas que sólo necesitan eso.
final usuarioProvider = Provider<Usuario?>((ref) {
  final s = ref.watch(sesionProvider);
  return s is ConSesion ? s.usuario : null;
});

/// ¿Puede comprar? Requiere teléfono cargado.
final puedeComprarProvider = Provider<bool>((ref) {
  final s = ref.watch(sesionProvider);
  return s is ConSesion && s.puedeComprar;
});
