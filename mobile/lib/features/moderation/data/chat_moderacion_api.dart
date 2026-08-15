import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/state/auth_providers.dart';

/// Moderar el chat de un vivo propio.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SÓLO EL VENDEDOR, Y SÓLO EN SU VIVO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El backend lo comprueba en cada llamada —404 si el vivo no es de quien
/// llama— así que esto no es un control de seguridad sino de interfaz: no
/// ofrecerle a alguien un botón que le va a devolver un error.
///
/// Y lo que puede hacer está acotado a propósito: borrar un mensaje de su sala
/// y callar a alguien un rato. Silenciar para siempre, en otros vivos o
/// suspender una cuenta son sanciones de plataforma y las decide VendoX.
class ChatModeracionApi {
  ChatModeracionApi(this._ref);
  final Ref _ref;

  /// Borra un mensaje. Deja de verse para todos.
  ///
  /// Del lado del servidor es un borrado lógico: el mensaje queda como
  /// evidencia de por qué se sancionó a alguien.
  Future<void> borrarMensaje({
    required String liveSessionId,
    required String mensajeId,
  }) async {
    await _ref.read(apiClientProvider).delete<Map<String, dynamic>>(
          '/live/$liveSessionId/chat/messages/$mensajeId',
        );
  }

  /// Calla a alguien durante este vivo.
  ///
  /// El motivo es obligatorio: un silencio sin motivo no se puede revisar ni
  /// defender, ni ante quien reclama ni ante el propio vendedor dentro de una
  /// semana.
  Future<void> silenciar({
    required String liveSessionId,
    required String userId,
    required String motivo,
    int minutos = 30,
  }) async {
    await _ref.read(apiClientProvider).post<Map<String, dynamic>>(
      '/live/$liveSessionId/chat/mutes',
      data: {'userId': userId, 'reason': motivo, 'minutos': minutos},
    );
  }

  Future<void> devolverLaVoz({
    required String liveSessionId,
    required String userId,
  }) async {
    await _ref.read(apiClientProvider).delete<Map<String, dynamic>>(
          '/live/$liveSessionId/chat/mutes/$userId',
        );
  }
}

final chatModeracionApiProvider = Provider<ChatModeracionApi>(ChatModeracionApi.new);
