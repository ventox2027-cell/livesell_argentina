import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../lives/data/live_api.dart';

/// Seguir y dejar de seguir vendedores.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ NO SE LLAMA A `LiveApi` DIRECTO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Porque seguir a alguien cambia **otra pantalla**: la pestaña «Siguiendo».
///
/// Se sigue desde tres lugares —el feed, el vivo y el perfil del vendedor— y
/// ninguno de los tres sabe que esa pestaña existe. Con la llamada suelta en
/// cada pantalla, seguir a alguien no se notaba hasta reiniciar la app, que es
/// exactamente el bug que esto arregla.
///
/// Acá pasa una sola vez y se avisa una sola vez. `test/seguir_avisa_test.dart`
/// comprueba que nadie vuelva a llamar a `LiveApi.seguir` por su cuenta.
class Seguimientos extends Notifier<int> {
  /// La versión de «a quién sigo». Cambia con cada follow o unfollow.
  ///
  /// No es la lista: es un número que sube. Quien depende de a quién sigo
  /// —hoy, el feed de seguidos— lo observa y se rearma solo. Guardar la lista
  /// acá sería una segunda copia de algo que ya tiene el servidor, y que
  /// además el mismo usuario puede cambiar desde otro teléfono.
  @override
  int build() => 0;

  Future<({bool siguiendo, int seguidores})> seguir(String sellerId) =>
      _cambiar(() => ref.read(liveApiProvider).seguir(sellerId));

  Future<({bool siguiendo, int seguidores})> dejarDeSeguir(String sellerId) =>
      _cambiar(() => ref.read(liveApiProvider).dejarDeSeguir(sellerId));

  /// ⚠️ Se avisa DESPUÉS de que el servidor confirmó, no antes.
  ///
  /// Un follow que falló no cambió a quién sigo. Avisar igual haría que la
  /// pestaña se rearmara para traer exactamente lo mismo — una petición de más
  /// por cada toque fallido, justo cuando la red anda mal.
  Future<({bool siguiendo, int seguidores})> _cambiar(
    Future<({bool siguiendo, int seguidores})> Function() operacion,
  ) async {
    final r = await operacion();
    state = state + 1;
    return r;
  }
}

/// Cuántas veces cambió a quién sigo, en esta sesión de la app.
final seguimientosProvider = NotifierProvider<Seguimientos, int>(Seguimientos.new);
