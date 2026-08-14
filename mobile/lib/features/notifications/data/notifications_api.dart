import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../auth/state/auth_providers.dart';
import '../domain/notification_models.dart';

/// El centro de notificaciones.
///
/// Nunca recibe un `userId`: el backend resuelve la persona desde la sesión.
/// Y no hay forma de CREAR un aviso desde acá — los origina el backend cuando
/// pasa algo. Un endpoint para crearlos sería una forma de mandarle
/// notificaciones a cualquier usuario desde la app.
class NotificationsApi {
  NotificationsApi(this._api);
  final ApiClient _api;

  Future<PaginaDeAvisos> listar({String? cursor}) async {
    final r = await _api.get<Map<String, dynamic>>('/notifications', query: {
      'limit': 20,
      if (cursor != null) 'cursor': cursor,
    });
    return PaginaDeAvisos.fromJson(r.data ?? const {});
  }

  /// Sólo el número del globito.
  ///
  /// Endpoint propio porque la app lo pide al abrir y cada vez que vuelve del
  /// fondo, y no necesita la lista entera para pintar un número.
  Future<int> sinLeer() async {
    final r = await _api.get<Map<String, dynamic>>('/notifications/unread-count');
    return (r.data?['sinLeer'] as num?)?.toInt() ?? 0;
  }

  Future<void> marcarLeida(String id) async {
    await _api.patch<Map<String, dynamic>>('/notifications/$id/read');
  }

  Future<void> marcarTodasLeidas() async {
    await _api.patch<Map<String, dynamic>>('/notifications/read-all');
  }
}

final notificationsApiProvider =
    Provider<NotificationsApi>((ref) => NotificationsApi(ref.watch(apiClientProvider)));

/// El contador del globito.
///
/// ─── Por qué es un `FutureProvider` y no algo vivo ───
///
/// No hay socket para esto. Se refresca al abrir la app, al volver del fondo y
/// después de leer un aviso, que es cuando el número puede haber cambiado de
/// una forma que a la persona le importe. Un socket dedicado a un número sería
/// una conexión permanente para ahorrar tres peticiones por sesión.
final avisosSinLeerProvider = FutureProvider.autoDispose<int>((ref) async {
  /**
   * Si falla, cero. No se muestra un error.
   *
   * Un globito es información secundaria: que la petición se caiga no puede
   * ensuciar la pantalla con un cartel rojo. La persona entra al centro de
   * notificaciones y ahí sí se le dice si algo no anduvo.
   */
  try {
    return await ref.watch(notificationsApiProvider).sinLeer();
  } catch (_) {
    return 0;
  }
});
