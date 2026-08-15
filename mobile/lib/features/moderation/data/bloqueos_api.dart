import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/state/auth_providers.dart';

/// Bloquear personas.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// NO ES LO MISMO QUE REPORTAR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// **Bloquear** es una decisión personal: inmediata, reversible, sin revisión y
/// sin consecuencias para la otra persona. Deja de verla y corta el chat.
///
/// **Reportar** es pedirle a VendoX que revise algo. Tiene umbrales, revisión
/// humana y consecuencias.
///
/// La interfaz los ofrece juntos porque llegan del mismo lugar —el menú de una
/// tienda que molesta— pero los textos tienen que dejar clarísima la
/// diferencia: quien quiere que alguien desaparezca de su vista no debería
/// tener que denunciarlo, y quien denuncia algo grave no debería creer que
/// bloqueando ya avisó.
class BloqueosApi {
  BloqueosApi(this._ref);
  final Ref _ref;

  /// ¿Bloqueé a este vendedor?
  ///
  /// Se consulta por `sellerId` y no por el id de la persona: el perfil público
  /// de un vendedor no devuelve el id de la cuenta detrás, a propósito.
  Future<bool> bloqueeAlVendedor(String sellerId) async {
    final r = await _ref
        .read(apiClientProvider)
        .get<Map<String, dynamic>>('/blocks/seller/$sellerId');
    return r.data?['bloqueado'] as bool? ?? false;
  }

  Future<void> bloquearVendedor(String sellerId, {String? motivo}) async {
    await _ref.read(apiClientProvider).post<Map<String, dynamic>>(
          '/blocks/seller/$sellerId',
          data: {if (motivo != null && motivo.trim().isNotEmpty) 'reason': motivo.trim()},
        );
  }

  Future<void> desbloquearVendedor(String sellerId) async {
    await _ref
        .read(apiClientProvider)
        .delete<Map<String, dynamic>>('/blocks/seller/$sellerId');
  }

  /// A quiénes bloqueé. Para la pantalla del perfil.
  Future<List<PersonaBloqueada>> lista() async {
    final r = await _ref.read(apiClientProvider).get<List<dynamic>>('/blocks');
    return (r.data ?? [])
        .whereType<Map<String, dynamic>>()
        .map(PersonaBloqueada.fromJson)
        .toList();
  }

  /// Desbloquear desde la lista, donde sí se conoce el id de la persona.
  Future<void> desbloquear(String userId) async {
    await _ref.read(apiClientProvider).delete<Map<String, dynamic>>('/blocks/$userId');
  }
}

class PersonaBloqueada {
  const PersonaBloqueada({
    required this.userId,
    required this.nombre,
    this.tienda,
    this.avatarUrl,
    this.motivo,
    this.desde,
  });

  /// Lectura defensiva: un cuerpo raro no puede romper la pantalla de bloqueos,
  /// que es justamente a la que va alguien que está pasando un mal momento.
  factory PersonaBloqueada.fromJson(Map<String, dynamic> j) => PersonaBloqueada(
        userId: j['userId'] as String? ?? '',
        nombre: j['nombre'] as String? ?? 'Alguien',
        tienda: j['tienda'] as String?,
        avatarUrl: j['avatarUrl'] as String?,
        motivo: j['motivo'] as String?,
        desde: DateTime.tryParse(j['desde'] as String? ?? ''),
      );

  final String userId;

  /// Nombre y la inicial del apellido. El backend no manda más que eso.
  final String nombre;
  final String? tienda;
  final String? avatarUrl;
  final String? motivo;
  final DateTime? desde;
}

final bloqueosApiProvider = Provider<BloqueosApi>(BloqueosApi.new);

/// Los bloqueos de esta persona.
///
/// `autoDispose` porque al salir de la pantalla el dato deja de importar, y
/// mantenerlo vivo haría que al volver se vea el de hace una hora.
final misBloqueosProvider = FutureProvider.autoDispose<List<PersonaBloqueada>>(
  (ref) => ref.read(bloqueosApiProvider).lista(),
);
