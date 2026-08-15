import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http_parser/http_parser.dart';

import '../../../core/network/api_client.dart';
import '../../auth/state/auth_providers.dart';
import '../domain/seller_models.dart';

/// Cliente del bloque comercial.
///
/// ─── Nunca manda ids de pertenencia ───
///
/// No hay `sellerId` ni `storeId` de dueño en ningún cuerpo. El backend los
/// deriva del token. Si esta clase los enviara, el backend los ignoraría — y
/// alguien podría creer que sirven para algo.
class SellerRepository {
  SellerRepository(this._api);
  final ApiClient _api;

  // ─── Vendedor ─────────────────────────────────────────────────────────────

  /// Perfil propio. `null` si el usuario todavía no es vendedor.
  Future<PerfilVendedor?> miPerfil() async {
    final res = await _api.get<Map<String, dynamic>>('/sellers/me');
    if (res.statusCode == 404) return null;
    if (res.statusCode != 200 || res.data == null) throw _error(res);
    return PerfilVendedor.fromJson(res.data!);
  }

  Future<PerfilVendedor> crearVendedor({
    required String displayName,
    String? storeName,
    String? bio,
  }) async {
    final res = await _api.post<Map<String, dynamic>>('/sellers', data: {
      'displayName': displayName,
      if (storeName != null && storeName.isNotEmpty) 'storeName': storeName,
      if (bio != null && bio.isNotEmpty) 'bio': bio,
    });
    if (res.statusCode != 201 && res.statusCode != 200) throw _error(res);
    // Devuelve { seller, store }: se rearma con la forma del perfil.
    return PerfilVendedor.fromJson({
      ...res.data!,
      'stats': {'productos': 0}
    });
  }

  Future<Seller> actualizarVendedor({String? displayName, String? bio}) async {
    final res = await _api.patch<Map<String, dynamic>>('/sellers/me', data: {
      if (displayName != null) 'displayName': displayName,
      if (bio != null) 'bio': bio,
    });
    if (res.statusCode != 200) throw _error(res);
    return Seller.fromJson(res.data!);
  }

  Future<Store> actualizarTienda(
    String storeId, {
    String? name,
    String? description,
    String? status,
  }) async {
    final res = await _api.patch<Map<String, dynamic>>('/stores/$storeId', data: {
      if (name != null) 'name': name,
      if (description != null) 'description': description,
      if (status != null) 'status': status,
    });
    if (res.statusCode != 200) throw _error(res);
    return Store.fromJson(res.data!);
  }

  // ─── Productos ────────────────────────────────────────────────────────────

  Future<Pagina<Producto>> misProductos({String? cursor, int limit = 20}) async {
    final res = await _api.get<Map<String, dynamic>>('/products/mine', query: {
      'limit': limit,
      if (cursor != null) 'cursor': cursor,
    });
    if (res.statusCode != 200 || res.data == null) throw _error(res);

    return Pagina(
      items: (res.data!['items'] as List<dynamic>)
          .map((e) => Producto.fromJson(e as Map<String, dynamic>))
          .toList(),
      nextCursor: res.data!['nextCursor'] as String?,
    );
  }

  Future<Producto> producto(String id) async {
    final res = await _api.get<Map<String, dynamic>>('/products/$id');
    if (res.statusCode != 200 || res.data == null) throw _error(res);
    return Producto.fromJson(res.data!);
  }

  /// Crea un producto.
  ///
  /// `opciones` es `{ "Color": ["Negro","Blanco"] }`. Si viene vacío, el
  /// backend genera una variante DEFAULT: la app no tiene que saber nada de eso.
  Future<Producto> crearProducto({
    required String name,
    required int basePriceCents,
    String? description,
    int? compareAtPriceCents,
    Map<String, List<String>> opciones = const {},
    String status = 'DRAFT',
    String? categoryId,
  }) async {
    final res = await _api.post<Map<String, dynamic>>('/products', data: {
      'name': name,
      'basePriceCents': basePriceCents,
      if (description != null && description.isNotEmpty) 'description': description,
      if (compareAtPriceCents != null) 'compareAtPriceCents': compareAtPriceCents,
      if (categoryId != null) 'categoryId': categoryId,
      'status': status,
      'options': opciones.entries
          .where((e) => e.value.isNotEmpty)
          .map((e) => {'name': e.key, 'values': e.value})
          .toList(),
    });
    if (res.statusCode != 201 && res.statusCode != 200) throw _error(res);
    return Producto.fromJson(res.data!);
  }

  Future<Producto> actualizarProducto(
    String id, {
    String? name,
    String? description,
    int? basePriceCents,
    int? compareAtPriceCents,
    String? status,
    String? categoryId,
  }) async {
    final res = await _api.patch<Map<String, dynamic>>('/products/$id', data: {
      if (name != null) 'name': name,
      if (description != null) 'description': description,
      if (basePriceCents != null) 'basePriceCents': basePriceCents,
      if (compareAtPriceCents != null) 'compareAtPriceCents': compareAtPriceCents,
      if (categoryId != null) 'categoryId': categoryId,
      if (status != null) 'status': status,
    });
    if (res.statusCode != 200) throw _error(res);
    return Producto.fromJson(res.data!);
  }

  Future<void> borrarProducto(String id) async {
    final res = await _api.delete<Map<String, dynamic>>('/products/$id');
    if (res.statusCode != 200) throw _error(res);
  }

  // ─── Variantes ────────────────────────────────────────────────────────────

  /// Define los ejes de variación de un producto que ya existe.
  ///
  /// ─── El hueco que esto cierra ───
  ///
  /// El editor mostraba "¿Viene en varios talles o colores?" también al editar,
  /// y dejaba agregar ejes... que después no se guardaban: sólo `crearProducto`
  /// los mandaba. El vendedor cargaba Color y Talle en un producto existente,
  /// tocaba Guardar, veía "Guardado" y no pasaba nada.
  ///
  /// Se manda la definición **completa** y el backend genera las combinaciones.
  /// Las que ya existían conservan su stock: se reconocen por la combinación,
  /// no por su posición.
  Future<Producto> definirOpciones(
    String productId,
    Map<String, List<String>> opciones,
  ) async {
    final res = await _api.put<Map<String, dynamic>>(
      '/products/$productId/options',
      data: {
        'opciones': [
          for (final e in opciones.entries)
            if (e.value.isNotEmpty) {'name': e.key, 'values': e.value},
        ],
      },
    );
    if (res.statusCode != 200) throw _error(res);
    return Producto.fromJson(res.data!);
  }

  Future<Producto> actualizarVariante(
    String productId,
    String variantId, {
    String? sku,
    int? priceOverrideCents,
    String? status,
  }) async {
    final res = await _api.patch<Map<String, dynamic>>(
      '/products/$productId/variants/$variantId',
      data: {
        if (sku != null) 'sku': sku,
        if (priceOverrideCents != null) 'priceOverrideCents': priceOverrideCents,
        if (status != null) 'status': status,
      },
    );
    if (res.statusCode != 200) throw _error(res);
    return Producto.fromJson(res.data!);
  }

  // ─── Imágenes ─────────────────────────────────────────────────────────────

  /// Sube una foto.
  ///
  /// Se manda como multipart. El nombre del archivo viaja pero **el backend no
  /// lo usa como ruta**: genera el suyo y detecta el tipo por los bytes.
  Future<ImagenProducto> subirImagen(String productId, File archivo) async {
    final form = FormData.fromMap({
      'file': await MultipartFile.fromFile(
        archivo.path,
        filename: archivo.path.split(Platform.pathSeparator).last,
        contentType: MediaType('image', 'jpeg'),
      ),
    });

    final res = await _api.raw.post<Map<String, dynamic>>(
      '/products/$productId/images',
      data: form,
      // Subir una foto por una red móvil argentina puede tardar. Un timeout
      // corto acá se traduce en "no pude publicar mi producto".
      options: Options(
          sendTimeout: const Duration(seconds: 90), receiveTimeout: const Duration(seconds: 90)),
    );
    if (res.statusCode != 201 && res.statusCode != 200) throw _error(res);
    return ImagenProducto.fromJson(res.data!);
  }

  Future<void> borrarImagen(String productId, String imageId) async {
    final res = await _api.delete<Map<String, dynamic>>(
      '/products/$productId/images/$imageId',
    );
    if (res.statusCode != 200) throw _error(res);
  }

  Future<List<ImagenProducto>> reordenarImagenes(String productId, List<String> ids) async {
    final res = await _api.patch<List<dynamic>>(
      '/products/$productId/images/reorder',
      data: {'imageIds': ids},
    );
    if (res.statusCode != 200) throw _error(res);
    return (res.data ?? []).map((e) => ImagenProducto.fromJson(e as Map<String, dynamic>)).toList();
  }

  // ─── Vidriera pública ─────────────────────────────────────────────────────

  Future<Pagina<Producto>> productosDeTienda(String storeSlug, {String? cursor}) async {
    final res = await _api.get<Map<String, dynamic>>(
      '/stores/by-slug/$storeSlug/products',
      query: {if (cursor != null) 'cursor': cursor},
      sinAuth: true,
    );
    if (res.statusCode != 200 || res.data == null) throw _error(res);
    return Pagina(
      items: (res.data!['items'] as List<dynamic>)
          .map((e) => Producto.fromJson(e as Map<String, dynamic>))
          .toList(),
      nextCursor: res.data!['nextCursor'] as String?,
    );
  }

  /// Mensaje del backend, siempre.
  ///
  /// Es el único lugar donde los errores están traducidos. Duplicar esos
  /// textos acá garantizaría que un día digan cosas distintas.
  ComercioException _error(Response<dynamic> res) {
    final d = res.data;
    if (d is Map && d['error'] is Map) {
      final error = d['error'] as Map;
      final codigo = error['codigo'] as String? ?? error['code'] as String?;
      final msg = error['message'];
      final detalles = error['details'];
      if (detalles is List && detalles.isNotEmpty) {
        final primero = detalles.first;
        if (primero is Map && primero['message'] is String) {
          return ComercioException(primero['message'] as String, codigo: codigo);
        }
      }
      if (msg is String && msg.isNotEmpty) {
        return ComercioException(msg, codigo: codigo);
      }
    }
    return ComercioException('No se pudo completar la operación.');
  }
}

class ComercioException implements Exception {
  ComercioException(this.mensaje, {this.codigo});

  final String mensaje;

  /// El código estable del backend. Por ejemplo MP_ACCOUNT_REQUIRED.
  ///
  /// La app decide con esto, nunca con el texto: el mensaje puede cambiar de
  /// redacción en cualquier momento y el código no.
  final String? codigo;

  /// Falta conectar Mercado Pago para poder publicar o transmitir.
  ///
  /// Merece un getter propio porque no se resuelve mostrando el error: se
  /// resuelve ofreciendo la pantalla de conectar. Ver ConectarMpSheet.
  bool get requiereMercadoPago => codigo == 'MP_ACCOUNT_REQUIRED';

  /// Vender en VendoX es 18+ y todavía no declaró su fecha de nacimiento.
  ///
  /// Como el anterior: no se resuelve mostrando el error sino abriendo la hoja
  /// donde la persona la carga. Ver FechaDeNacimientoSheet.
  bool get faltaFechaDeNacimiento => codigo == 'BIRTH_DATE_REQUIRED';

  /// Declaró ser menor de 18.
  ///
  /// ⚠️ Esto NO se resuelve completando nada, a diferencia de los dos de
  /// arriba. La app explica y cierra.
  bool get esMenorDeEdad => codigo == 'UNDERAGE';

  /// Quiere publicar y no eligió categoría.
  ///
  /// Getter propio por lo mismo que los de arriba: la app tiene que llevar al
  /// selector, no mostrar un cartel rojo que no dice dónde se arregla.
  bool get faltaCategoria => codigo == 'CATEGORY_REQUIRED';

  @override
  String toString() => mensaje;
}

final sellerRepositoryProvider = Provider<SellerRepository>(
  (ref) => SellerRepository(ref.watch(apiClientProvider)),
);

/// Perfil de vendedor del usuario actual. `null` si todavía no lo es.
final miPerfilVendedorProvider = FutureProvider<PerfilVendedor?>((ref) async {
  // Se recalcula al cambiar la sesión: si alguien cierra sesión y entra con
  // otra cuenta, no puede seguir viendo la tienda de la anterior.
  ref.watch(sesionProvider);
  return ref.watch(sellerRepositoryProvider).miPerfil();
});

final misProductosProvider = FutureProvider<Pagina<Producto>>((ref) async {
  ref.watch(miPerfilVendedorProvider);
  return ref.watch(sellerRepositoryProvider).misProductos();
});
