import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/state/auth_providers.dart';
import '../../../core/network/api_client.dart';
import '../domain/live_models.dart';

/// Lo que la app le pide al backend sobre vivos, tiendas y vendedores.
///
/// ─── Nada se decide acá ───
///
/// El stock, el precio y si la tienda está abierta los dice el backend. La app
/// los muestra. Cualquier cálculo de este lado sería una segunda versión de las
/// reglas, y el día que difiera va a ofrecer lo que no hay.
class LiveApi {
  LiveApi(this._api);
  final ApiClient _api;

  /// Los vivos al aire.
  Future<List<ResumenDeLive>> activos() async {
    final r = await _api.get<List<dynamic>>('/live');
    return (r.data ?? [])
        .map((j) => ResumenDeLive.fromJson(j as Map<String, dynamic>))
        .toList();
  }

  /// Entrar a un vivo: trae el contexto comercial y, si está al aire, el token
  /// de video.
  Future<DetalleDeLive> ver(String liveId) async {
    final r = await _api.get<Map<String, dynamic>>('/live/$liveId');
    return DetalleDeLive.fromJson(r.data!);
  }

  Future<PerfilDeVendedor> perfil(String sellerId) async {
    final r = await _api.get<Map<String, dynamic>>('/sellers/$sellerId/profile');
    return PerfilDeVendedor.fromJson(r.data!);
  }

  Future<({bool siguiendo, int seguidores})> seguir(String sellerId) async {
    final r = await _api.post<Map<String, dynamic>>('/sellers/$sellerId/follow');
    return (
      siguiendo: r.data?['siguiendo'] as bool? ?? true,
      seguidores: (r.data?['seguidores'] as num?)?.toInt() ?? 0,
    );
  }

  Future<({bool siguiendo, int seguidores})> dejarDeSeguir(String sellerId) async {
    final r = await _api.delete<Map<String, dynamic>>('/sellers/$sellerId/follow');
    return (
      siguiendo: r.data?['siguiendo'] as bool? ?? false,
      seguidores: (r.data?['seguidores'] as num?)?.toInt() ?? 0,
    );
  }

  /// El catálogo de una tienda, paginado.
  ///
  /// Paginado desde el principio: un vendedor con trescientos productos no
  /// puede mandarlos todos mientras el video sigue corriendo atrás.
  Future<PaginaDeCatalogo> catalogo(String storeId, {String? cursor, String? q}) async {
    final r = await _api.get<Map<String, dynamic>>(
      '/stores/$storeId/catalog',
      query: {
        'limit': 20,
        if (cursor != null) 'cursor': cursor,
        if (q != null && q.isNotEmpty) 'q': q,
      },
    );
    return PaginaDeCatalogo.fromJson(r.data!);
  }

  Future<EstadoDeTienda> estadoDeTienda(String storeId) async {
    final r = await _api.get<Map<String, dynamic>>('/stores/$storeId/status');
    return EstadoDeTienda.fromJson(r.data!);
  }

  /// El detalle de un producto, con sus variantes y stock.
  ///
  /// Se pide al abrir el panel de compra y no antes: el catálogo trae el
  /// disponible total para poder mostrar "agotado", pero elegir talle necesita
  /// el stock de cada variante, y traer eso para trescientos productos sería
  /// mandar datos que casi nadie va a mirar.
  Future<DetalleDeProducto> producto(String productId) async {
    final r = await _api.get<Map<String, dynamic>>('/products/$productId');
    return DetalleDeProducto.fromJson(r.data!);
  }

  /// "Avisame cuando abran." **No descuenta stock.**
  Future<void> dejarIntencion(String variantId, int cantidad) async {
    await _api.post<Map<String, dynamic>>(
      '/variants/$variantId/intent',
      data: {'quantity': cantidad},
    );
  }
}

final liveApiProvider = Provider<LiveApi>((ref) => LiveApi(ref.watch(apiClientProvider)));
