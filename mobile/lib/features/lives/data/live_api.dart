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
    return (r.data ?? []).map((j) => ResumenDeLive.fromJson(j as Map<String, dynamic>)).toList();
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
  /// El catálogo de una tienda.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// EL ESTADO DE LA RESPUESTA SE MIRA, Y ANTES NO
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// ⚠️ `ApiClient` NO lanza con 4xx: usa `validateStatus: (s) => s < 500` para
  /// poder reintentar después de refrescar el token. Así que el cuerpo de un
  /// 404 —un objeto de error— entraba derecho a `PaginaDeCatalogo.fromJson`, que
  /// lo lee a la defensiva y devuelve una página **vacía**.
  ///
  /// El resultado era que una tienda con la vidriera apagada se veía como una
  /// tienda sin productos: «todavía no tiene productos publicados» sobre un
  /// catálogo lleno que simplemente no se puede mostrar.
  ///
  /// Ahora los dos casos que el backend distingue por código llegan como
  /// excepciones distintas, y la pantalla dice lo que corresponde.
  Future<PaginaDeCatalogo> catalogo(String storeId, {String? cursor, String? q}) async {
    final r = await _api.get<Map<String, dynamic>>(
      '/stores/$storeId/catalog',
      query: {
        'limit': 20,
        if (cursor != null) 'cursor': cursor,
        if (q != null && q.isNotEmpty) 'q': q,
      },
    );

    if (r.statusCode != 200 || r.data == null) {
      final error = r.data?['error'];
      final codigo = error is Map ? error['code'] as String? : null;

      // La app decide con el CÓDIGO, nunca con el texto: el mensaje puede
      // cambiar de redacción en cualquier momento y el código no.
      if (codigo == 'STOREFRONT_DISABLED') throw const VidrieraApagada();
      if (r.statusCode == 404) throw const TiendaNoEncontrada();
      throw StateError('No se pudo abrir el catálogo de $storeId');
    }

    return PaginaDeCatalogo.fromJson(r.data!);
  }

  /// Resuelve el slug de un enlace compartido a la tienda.
  ///
  /// ⚠️ Un slug que no existe —o de un vendedor suspendido— vuelve como 404 y
  /// se traduce a [TiendaNoEncontrada]. Es un caso normal, no un fallo: pasa
  /// con cualquier enlace viejo.
  Future<TiendaPublica> tiendaPorSlug(String slug) async {
    final r = await _api.get<Map<String, dynamic>>('/stores/by-slug/$slug', sinAuth: true);

    if (r.statusCode == 404) throw const TiendaNoEncontrada();
    if (r.statusCode != 200 || r.data == null) {
      throw StateError('No se pudo resolver la tienda $slug');
    }

    return TiendaPublica.fromJson(r.data!);
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
  ///
  /// ⚠️ `/catalog/products/:id`, **no** `/products/:id`. El segundo es del
  /// vendedor: resuelve por dueño y le contesta `SELLER_NOT_FOUND` a quien
  /// compra. Ver la nota de `DetalleDeProducto.fromJson`.
  Future<DetalleDeProducto> producto(String productId) async {
    final r = await _api.get<Map<String, dynamic>>('/catalog/products/$productId');
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

/// El enlace lleva a una tienda que no existe, o que ya no se puede mostrar.
///
/// Se distingue de un fallo de red a propósito: son dos pantallas distintas.
/// «No encontramos esta tienda» con un enlace roto, y «revisá tu conexión»
/// cuando el problema es la red — ofrecer reintentar sobre un slug inexistente
/// es hacer tocar un botón que nunca va a funcionar.
class TiendaNoEncontrada implements Exception {
  const TiendaNoEncontrada();

  @override
  String toString() => 'No encontramos esta tienda.';
}

/// La tienda existe, pero su vidriera está apagada.
///
/// Se distingue de [TiendaNoEncontrada] a propósito: son dos cosas distintas
/// para quien la está buscando, y sólo una se arregla reintentando. El vendedor
/// la apagó y puede volver a encenderla; sus productos siguen publicados y se
/// siguen vendiendo desde el feed.
class VidrieraApagada implements Exception {
  const VidrieraApagada();

  @override
  String toString() => 'La vidriera de esta tienda no está disponible.';
}
