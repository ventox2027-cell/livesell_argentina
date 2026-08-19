import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/push/push_service.dart';

import '../../../core/config/traza_de_arranque.dart';
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

  /// Restaura la sesión en dos tiempos: primero el disco, después el servidor.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// EL ORDEN ES DONDE ESTABA EL PROBLEMA
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Antes esto era una sola línea que esperaba `restaurar()` entero, y
  /// `restaurar()` incluye un `GET /auth/me`. O sea: la app no dibujaba nada
  /// hasta terminar un viaje de ida y vuelta a Railway. Medido en un teléfono,
  /// ~3 segundos de spinner con el usuario ya guardado en el disco.
  ///
  /// Ahora la pantalla sale con lo guardado y la comprobación va detrás, sin que
  /// nadie la espere. Si el servidor dice que la cuenta ya no está —401, 403, o
  /// simplemente otro perfil— el estado se corrige solo unos cientos de
  /// milisegundos después.
  ///
  /// ⚠️ El resultado del servidor SIEMPRE pisa al del disco, incluso si tardó.
  /// Es lo que evita que una cuenta suspendida se quede con la pantalla abierta.
  Future<void> restaurar() async {
    final guardada = await _repo.sesionGuardada();

    /**
     * `null` significa «hay token pero no hay usuario guardado».
     *
     * Pasa una sola vez por instalación, entre que se guardan los tokens y se
     * guarda el perfil. Ahí no hay nada que adelantar y se espera al servidor,
     * que es lo que hacía siempre.
     */
    if (guardada != null) {
      state = guardada;
      TrazaDeArranque.instancia.paso('sesión: disco');
    }

    final desde = TrazaDeArranque.instancia.ahora;
    state = await _repo.restaurar();
    TrazaDeArranque.instancia.tramo('auth/me (2º plano)', desdeMs: desde);

    _sincronizarAvisos();
  }

  /// Engancha o desengancha los avisos según haya sesión.
  ///
  /// ⚠️ NO pide permiso: sólo vuelve a subir el token si la persona YA lo
  /// autorizó antes. El token puede haber cambiado mientras la sesión estaba
  /// cerrada —una reinstalación, un backup restaurado— y quien ya dijo que sí
  /// no tiene por qué volver a decidirlo.
  ///
  /// Cuándo se PIDE el permiso está en `permiso_de_avisos.dart`: después de
  /// la primera compra, no en el arranque.
  void _sincronizarAvisos() {
    final push = PushService.instance;
    push.registrarToken = _repo.actualizarPushToken;
    if (state is ConSesion) unawaited(push.reengancharSiYaAutorizo());
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

  /// Cerrar sesión.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// ERAN TRES OPERACIONES DE RED, UNA DETRÁS DE OTRA
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Medido en un teléfono: ~5 segundos mirando la pantalla después de tocar
  /// «Cerrar sesión». El orden era éste, y todo se esperaba antes de que la UI
  /// se moviera:
  ///
  ///   1. `PATCH /auth/push-token` — desvincular el teléfono. A Railway.
  ///   2. `FirebaseMessaging.deleteToken()` — a los servidores de Google.
  ///   3. `POST /auth/logout` — a Railway otra vez.
  ///   4. Borrar el llavero.
  ///   5. Recién ahí, salir.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// QUÉ SE PUEDE MOVER Y QUÉ NO
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// El paso 2 no lo espera nadie más: borrar el token de Firebase es higiene,
  /// no seguridad. Nuestro backend ya sabe que este teléfono se desvinculó por
  /// el paso 1, así que aunque falle no se manda ningún aviso. Se va al fondo.
  ///
  /// Los pasos 1 y 3 son independientes entre sí. Estaban en fila por costumbre
  /// y ahora salen juntos.
  ///
  /// ⚠️ Lo que NO se mueve: el paso 1 tiene que correr con la sesión viva —el
  /// `PATCH` necesita el token—, y el paso 4 tiene que correr ANTES de que la
  /// pantalla cambie. Si la app muere entre salir y borrar el llavero, el
  /// próximo arranque restaura la sesión que la persona acaba de cerrar.
  ///
  /// Por eso esto sigue esperando un viaje de red y no cero. Lo que se saca son
  /// los otros dos.
  Future<void> cerrarSesion() async {
    unawaited(PushService.instance.olvidarEnFirebase());

    /**
     * ⚠️ Nada de lo de arriba puede impedir salir.
     *
     * `avisarDelCierre` sólo atrapa errores de Dio; cualquier otra cosa —un
     * fallo al leer el llavero, un timeout raro— subiría por `Future.wait` y
     * dejaría `limpiarLocal()` sin ejecutar. O sea: la persona toca «Cerrar
     * sesión», ve un error, y sigue adentro con los tokens intactos.
     *
     * Cerrar sesión es una orden, no una operación que pueda negociar.
     */
    await Future.wait([
      PushService.instance.desvincularEnElServidor(),
      _repo.avisarDelCierre().catchError((_) {}),
    ]);

    await _repo.limpiarLocal();
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
