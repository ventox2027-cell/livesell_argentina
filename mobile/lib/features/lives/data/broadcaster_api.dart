import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../auth/state/auth_providers.dart';
import '../domain/broadcaster_models.dart';

/// Lo que la app le pide al backend para transmitir.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA CREDENCIAL DE VIDEO SIEMPRE VIENE DE ACÁ
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El token de LiveKit lo firma el backend con su API secret, para esta persona
/// y esta sala, con permiso de publicar y con vencimiento. **La app nunca arma
/// un token ni conoce el secreto de LiveKit.** Si algún día aparece un
/// `LIVEKIT_API_SECRET` en el código de Flutter, cualquiera que descompile el
/// APK puede transmitir en la sala de cualquier vendedor.
class BroadcasterApi {
  BroadcasterApi(this._api);
  final ApiClient _api;

  /// ¿Hay un vivo abierto? Decide si el botón dice "Iniciar" o "Volver".
  Future<MiVivoAbierto?> miVivoAbierto() async {
    final r = await _api.get<Map<String, dynamic>>('/live/mine');
    return MiVivoAbierto.fromJson(r.data ?? const {});
  }

  /// Prepara la transmisión. **No sale al aire.**
  ///
  /// Devuelve el token de broadcaster para conectarse y mostrar la vista
  /// previa. El backend es idempotente: si ya había un vivo abierto devuelve
  /// ese, que es lo que quiere alguien que cerró la app y volvió.
  Future<VivoPreparado> preparar({
    required String titulo,
    required List<String> productIds,
    String? portadaUrl,
  }) async {
    final r = await _api.post<Map<String, dynamic>>(
      '/live',
      data: {
        'title': titulo,
        'productIds': productIds,
        if (portadaUrl != null && portadaUrl.isNotEmpty) 'coverUrl': portadaUrl,
      },
    );
    return VivoPreparado.fromJson(r.data!);
  }

  /// Sale al aire.
  Future<void> iniciar(String liveId) async {
    await _api.post<Map<String, dynamic>>('/live/$liveId/start');
  }

  /// Volví después de un corte. Idempotente: si ya está al aire, no hace nada.
  Future<void> reanudar(String liveId) async {
    await _api.post<Map<String, dynamic>>('/live/$liveId/resume');
  }

  /// Todo lo que la pantalla necesita, en una sola llamada.
  ///
  /// Una sola petición y no cinco: con red móvil variable, cinco son cinco
  /// oportunidades de que una llegue tarde y el panel mezcle datos de momentos
  /// distintos.
  Future<PanelDelVivo> panel(String liveId) async {
    final r = await _api.get<Map<String, dynamic>>('/live/$liveId/panel');
    return PanelDelVivo.fromJson(r.data!);
  }

  /// Cambia qué productos están en la bandeja y en qué orden.
  Future<void> guardarBandeja(String liveId, List<String> productIds) async {
    await _api.put<Map<String, dynamic>>(
      '/live/$liveId/products',
      data: {'productIds': productIds},
    );
  }

  /// Destaca una variante. `null` deja de destacar.
  Future<void> destacar(String liveId, String? variantId) async {
    await _api.post<Map<String, dynamic>>(
      '/live/$liveId/feature',
      data: {'variantId': variantId},
    );
  }

  Future<ResumenDelVivo> terminar(String liveId) async {
    final r = await _api.post<Map<String, dynamic>>('/live/$liveId/end');
    return ResumenDelVivo.fromJson(r.data ?? const {});
  }
}

final broadcasterApiProvider =
    Provider<BroadcasterApi>((ref) => BroadcasterApi(ref.watch(apiClientProvider)));

/// ¿El vendedor tiene un vivo abierto?
///
/// Lo consulta "Mi tienda" para decidir si el botón dice "Iniciar LIVE" o
/// "Volver a tu vivo".
final miVivoAbiertoProvider = FutureProvider<MiVivoAbierto?>(
  (ref) => ref.watch(broadcasterApiProvider).miVivoAbierto(),
);
