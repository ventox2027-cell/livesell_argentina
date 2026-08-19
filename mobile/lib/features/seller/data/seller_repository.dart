import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http_parser/http_parser.dart';

import '../../../core/network/api_client.dart';
import '../../auth/domain/session.dart';
import '../../auth/state/auth_providers.dart';
import '../domain/borrado_optimista.dart';
import '../domain/seller_models.dart';
import 'borrados_en_curso.dart';

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

  /// El perfil de vendedor, o `null` si esta persona todavía no lo es.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// `null` SIGNIFICA UNA SOLA COSA, Y NO ES «CUALQUIER 404»
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Acá decía `if (res.statusCode == 404) return null;` y eso metía en la
  /// misma bolsa dos respuestas muy distintas:
  ///
  ///   · `SELLER_NOT_FOUND` — «todavía no tenés perfil de vendedor». Es la
  ///     respuesta correcta y la que hace que la app ofrezca crear la tienda.
  ///   · Cualquier otro 404 — una ruta que el servidor no sirve, una función
  ///     apagada, un 404 del borde antes de llegar a la aplicación.
  ///
  /// El segundo caso quedaba traducido a «no tenés tienda», y la pantalla le
  /// ofrecía crear una que ya existe. Es el peor modo de falla posible: sin
  /// error, sin log, y con la persona convencida de que su tienda se perdió.
  ///
  /// Ahora sólo el código del dominio significa «no sos vendedor». Todo lo
  /// demás es un error de verdad y se muestra como tal, con su botón de
  /// reintentar.
  Future<PerfilVendedor?> miPerfil() async {
    final res = await _api.get<Map<String, dynamic>>('/sellers/me');

    if (res.statusCode == 404) {
      final e = _error(res);
      if (e.codigo == 'SELLER_NOT_FOUND') return null;
      throw e;
    }

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
      catalogo: EstadoDelCatalogo.desdeJson(res.data!['catalogo']),
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
  ///
  /// ⚠️ `claveDeAlta` es lo que evita el producto duplicado cuando la respuesta
  /// se pierde. El editor la genera una vez por sesión y la manda en cada
  /// intento; el servidor reconoce la repetición y devuelve el producto que ya
  /// creó. Ver `Idempotency-Key` en `commerce.controller.ts`.
  ///
  /// Es opcional en la firma sólo para no romper a quien llame sin ella —los
  /// tests, sobre todo—. El editor la manda siempre.
  Future<Producto> crearProducto({
    required String name,
    required int basePriceCents,
    String? description,
    int? compareAtPriceCents,
    Map<String, List<String>> opciones = const {},
    String status = 'DRAFT',
    String? categoryId,
    String? claveDeAlta,
  }) async {
    final res =
        await _api.post<Map<String, dynamic>>('/products', idempotencyKey: claveDeAlta, data: {
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
        return ComercioException(
          msg,
          codigo: codigo,
          // Los detalles viajan sólo cuando son un objeto: cuando son una
          // lista, son errores de validación campo por campo y ya se
          // resolvieron arriba.
          detalles: detalles is Map<String, dynamic> ? detalles : null,
        );
      }
    }
    return ComercioException('No se pudo completar la operación.');
  }
}

class ComercioException implements Exception {
  ComercioException(this.mensaje, {this.codigo, this.detalles});

  final String mensaje;

  /// El código estable del backend. Por ejemplo MP_ACCOUNT_REQUIRED.
  ///
  /// La app decide con esto, nunca con el texto: el mensaje puede cambiar de
  /// redacción en cualquier momento y el código no.
  final String? codigo;

  /// Lo que el backend adjunto al error.
  ///
  /// Un mapa suelto y no un tipo por cada error: cada codigo trae lo suyo y
  /// modelarlos todos seria mantener veinte clases para leer un numero.
  /// Quien lo use tiene que comprobar el tipo, que es lo que hace
  /// .
  final Map<String, dynamic>? detalles;

  /// Llegó al tope de productos publicados de su plan.
  ///
  /// ⚠️ NO es un error, aunque llegue por el mismo camino que los errores.
  ///
  /// El producto se guardó perfecto: quedó como borrador. Lo único que pasó es
  /// que el catálogo Free está completo. Mostrarlo como un cartel rojo le dice
  /// al vendedor que su trabajo falló, que es lo contrario de lo que pasó.
  ///
  /// Quien lo reciba tiene que ofrecer la salida —ver Pro, o pausar uno— en vez
  /// de mostrar el texto crudo. Ver `LimiteDelPlanSheet`.
  bool get llegoAlLimiteDelPlan => codigo == 'PLAN_LIMIT_REACHED';

  /// Cuántos productos permite el plan, según el backend.
  ///
  /// `null` si no vino. Quien lo use decide qué hacer — pero el número no se
  /// escribe en Dart: tenerlo en dos lugares hace que el de la app quede viejo
  /// el día que el plan cambie.
  int? get limiteDelPlan {
    final valor = detalles?['limite'];
    return valor is int ? valor : null;
  }

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
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ NO ES UN `FutureProvider`
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Porque hace falta poder DECIRLE el perfil, no sólo pedírselo.
///
/// Cuando alguien crea su tienda, `POST /sellers` ya devuelve el vendedor y la
/// tienda completos. Con un `FutureProvider` eso no se puede aprovechar: la
/// única forma de actualizar la pantalla era invalidar y esperar un `GET
/// /sellers/me` — un viaje entero a Railway para traer lo que la app ya tenía
/// en la mano.
///
/// Con 650 ms de latencia a la base, ese viaje son varios segundos de pantalla
/// en blanco después de tocar «Crear mi tienda», y es lo que hacía que
/// pareciera que la tienda no se había creado.
///
/// Ahora `adoptar()` la pone al instante y la reconciliación va después, sin
/// que nadie la espere.
class PerfilVendedorNotifier extends AsyncNotifier<PerfilVendedor?> {
  @override
  Future<PerfilVendedor?> build() async {
    /**
     * ⚠️ Se observa el ID de la persona, NO el objeto de sesión entero.
     *
     * Antes era `ref.watch(sesionProvider)`. `ConSesion` no define igualdad, así
     * que **cada** refresco de sesión creaba una instancia nueva y este provider
     * se recalculaba de cero — tirando lo que ya tenía y pidiendo todo otra vez.
     *
     * Y justo después de crear la tienda la app refresca la sesión, para que el
     * rol `seller` llegue al resto de las pantallas. O sea que el peor momento
     * para un recálculo completo era exactamente ése: el perfil recién adoptado
     * se descartaba y volvía la espera.
     *
     * Con el id, cambiar de cuenta sigue recalculando —que es lo que esta línea
     * vino a garantizar— y un refresco de la misma sesión no.
     */
    ref.watch(sesionProvider.select((s) => s is ConSesion ? s.usuario.id : null));
    return ref.watch(sellerRepositoryProvider).miPerfil();
  }

  /// Pone un perfil que ya se tiene, sin ir a buscarlo.
  ///
  /// Lo usa el alta de tienda con la respuesta del `POST`. La pantalla cambia
  /// en el mismo frame.
  void adoptar(PerfilVendedor perfil) => state = AsyncData(perfil);

  /// Vuelve a pedirlo al servidor **sin borrar lo que ya se ve**.
  ///
  /// ⚠️ La diferencia con `ref.invalidate` es todo el punto: invalidar deja el
  /// provider en `loading`, y la pantalla que lo observa muestra su spinner de
  /// cuerpo entero. Para una reconciliación de fondo eso es un parpadeo que
  /// borra la tienda que la persona acaba de crear.
  ///
  /// Si falla, se conserva lo anterior. Una tienda que existe no puede
  /// desaparecer de la pantalla porque un refresco de cortesía no llegó.
  Future<void> reconciliar() async {
    final anterior = state.valueOrNull;
    final nuevo = await AsyncValue.guard(
      () => ref.read(sellerRepositoryProvider).miPerfil(),
    );

    if (nuevo.hasError && anterior != null) return;
    state = nuevo;
  }
}

final miPerfilVendedorProvider =
    AsyncNotifierProvider<PerfilVendedorNotifier, PerfilVendedor?>(
  PerfilVendedorNotifier.new,
);

/// El listado de productos tal como lo devolvió el servidor.
///
/// ⚠️ Las pantallas NO observan esto: observan [misProductosVisiblesProvider],
/// que además esconde lo que se está borrando. Acá vive la verdad del servidor,
/// sin retoques.
///
/// Es un `AsyncNotifier` y no un `FutureProvider` por [reconciliar]: hace falta
/// poder volver a pedir el listado **sin** dejarlo en `loading`. Con
/// `ref.invalidate` la pantalla muestra su spinner de cuerpo entero, y para un
/// refresco de fondo eso es un parpadeo que borra lo que la persona está
/// mirando.
class MisProductosNotifier extends AsyncNotifier<Pagina<Producto>> {
  @override
  Future<Pagina<Producto>> build() async {
    /**
     * ⚠️ Se observa el ID del vendedor, NO el perfil entero.
     *
     * El listado depende del perfil para una sola cosa: que exista. Cuando
     * alguien crea su tienda, el id pasa de `null` a un valor y hay que ir a
     * buscar los productos — eso sigue igual.
     *
     * Observando el `AsyncValue` completo, en cambio, CUALQUIER cambio del
     * perfil recargaba el listado. Y como `reconciliar()` construye un
     * `PerfilVendedor` nuevo en cada refresco, refrescar el perfil pedía
     * también los productos: un refresco costaba cuatro peticiones en vez de
     * dos, con las dos de más pisando a las buenas.
     *
     * Lo encontró un test que contaba peticiones, no leyendo el código.
     */
    ref.watch(miPerfilVendedorProvider.select((p) => p.valueOrNull?.seller.id));
    return ref.watch(sellerRepositoryProvider).misProductos();
  }

  /// Vuelve a pedir el listado sin borrar lo que ya se ve.
  ///
  /// Si falla, se conserva lo anterior: un refresco de cortesía que no llegó no
  /// puede vaciar la pantalla.
  Future<void> reconciliar() async {
    final anterior = state.valueOrNull;
    final nuevo = await AsyncValue.guard(
      () => ref.read(sellerRepositoryProvider).misProductos(),
    );

    if (nuevo.hasError && anterior != null) return;
    state = nuevo;
  }
}

final misProductosProvider =
    AsyncNotifierProvider<MisProductosNotifier, Pagina<Producto>>(
  MisProductosNotifier.new,
);

/// Vuelve a pedir la tienda entera sin vaciar la pantalla.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ NO ES `ref.invalidate`
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Medido en un teléfono: entrar a Mi tienda a veces era instantáneo y a veces
/// tardaba entre 3 y 5 segundos. La diferencia no era la red: era si alguien
/// había invalidado los providers en el camino.
///
/// `ref.invalidate` **descarta** el estado. El provider vuelve a `loading` sin
/// valor anterior, y `SellerHomeScreen` muestra su spinner de cuerpo entero —o
/// sea que la tienda que la persona estaba mirando hace dos segundos desaparece
/// para volver a aparecer igual.
///
/// Y se invalidaba en todos lados: al volver del editor, al crear un producto,
/// al guardar los ajustes, al tirar para refrescar. Cada una de esas vueltas
/// era una pantalla en blanco esperando dos peticiones a otro continente.
///
/// Peor: `misProductos` observa a `miPerfil`, así que invalidar el perfil
/// invalidaba también el listado. Un `invalidate` costaba dos.
///
/// `reconciliar()` pide lo mismo y deja lo anterior a la vista hasta que llega
/// la respuesta. Si falla, no borra nada: un refresco de cortesía que no llegó
/// no puede vaciar la tienda de alguien.
/// Cómo leer un provider, sin importar desde dónde.
///
/// `WidgetRef` y `ProviderContainer` tienen los dos un `read` con esta forma
/// pero ningún tipo en común. Recibirlo como función deja que la pantalla pase
/// `ref.read` y que un test pase `contenedor.read` — y que el test ejecute ESTA
/// función y no una copia suya.
///
/// ⚠️ No es un detalle: la primera versión de los tests reimplementaba el
/// cuerpo de acá, así que sabotear esta función no rompía ningún test. Un test
/// que prueba una copia de la lógica no prueba la lógica.
typedef Leer = T Function<T>(ProviderListenable<T> provider);

Future<void> recargarLaTienda(Leer leer) async {
  await Future.wait([
    leer(miPerfilVendedorProvider.notifier).reconciliar(),
    leer(misProductosProvider.notifier).reconciliar(),
  ]);
}

/// El listado como lo ve el vendedor.
///
/// Es lo que observan las pantallas. La resta de los que se están borrando es
/// pura —ver `sinLosQueSeBorran`— así que esconder una fila no cuesta ninguna
/// petición: es el mismo dato del servidor, filtrado.
final misProductosVisiblesProvider = Provider<AsyncValue<Pagina<Producto>>>((ref) {
  final pagina = ref.watch(misProductosProvider);
  final borrados = ref.watch(borradosEnCursoProvider);
  return pagina.whenData((p) => sinLosQueSeBorran(p, borrados));
});
