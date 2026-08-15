import 'package:dio/dio.dart';
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
    /**
     * ⚠️ Se comprueba el ESTADO antes de parsear.
     *
     * `ApiClient` usa `validateStatus: s < 500` para poder reintentar tras
     * refrescar el token, así que un 4xx no lanza: llega como respuesta normal
     * con el cuerpo del error adentro. Y como el parseo es defensivo, ese
     * cuerpo se convierte en un objeto vacío en vez de en un error.
     *
     * Es exactamente el bug que dejó la hoja de variantes mostrando $0,00
     * durante días. Acá el síntoma sería "no pudimos preparar la transmisión"
     * en vez de "conectá Mercado Pago", que es lo que la persona necesita leer.
     */
    if (r.statusCode != 200 && r.statusCode != 201) throw _error(r);
    return VivoPreparado.fromJson(r.data!);
  }

  /// El error del backend, con su código.
  ///
  /// El mensaje sale del servidor —es el único lugar donde están traducidos— y
  /// el código permite que la app decida sin mirar el texto.
  VivoException _error(Response<dynamic> r) {
    final d = r.data;
    if (d is Map && d['error'] is Map) {
      final e = d['error'] as Map;
      final msg = e['message'];
      if (msg is String && msg.isNotEmpty) {
        return VivoException(msg, codigo: e['code'] as String?);
      }
    }
    return VivoException('No pudimos preparar la transmisión.');
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

class VivoException implements Exception {
  VivoException(this.mensaje, {this.codigo});

  final String mensaje;
  final String? codigo;

  /// Falta conectar Mercado Pago. No se resuelve mostrando el error: se
  /// resuelve ofreciendo la pantalla de conectar.
  bool get requiereMercadoPago => codigo == 'MP_ACCOUNT_REQUIRED';

  @override
  String toString() => mensaje;
}
