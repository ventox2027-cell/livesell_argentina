import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendox/core/auth/token_store.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/network/api_client.dart';

/// La conexión con el backend.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE SE MIDIÓ DESDE ARGENTINA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Contra `api.vendox.com.ar`, separando cada tramo:
///
///     DNS  178 ms (la primera vez; después 0)
///     TCP  135 ms  ← un viaje de ida y vuelta. Es la distancia.
///     TLS  143 ms  ← otro viaje.
///     ────────────
///     ≈ 280 ms sólo para poder EMPEZAR a pedir algo.
///
/// `/health` responde en 166 ms sobre una conexión abierta y en ~500 con una
/// nueva. O sea que **la mitad larga de una petición rápida es abrir la
/// conexión**.
///
/// `HttpClient` de Dart las cierra a los 15 segundos de quietud. Un vendedor
/// que mira su tienda, piensa, y toca un producto, ya pasó ese tiempo.
void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({});
    await RuntimeConfig.load();
  });

  /// ⛔ NO SE PISA EL ADAPTADOR QUE VIENE DE AFUERA.
  ///
  /// Este test existe por un error cometido al escribir el arreglo de arriba:
  /// la configuración de la conexión se aplicaba SIEMPRE, incluso cuando quien
  /// construye el cliente ya había elegido su adaptador.
  ///
  /// El efecto fue inmediato: tres tests de categorías que usan un doble
  /// pasaron a salir a Internet de verdad —esperaban un 404 del doble y
  /// recibían un 400 del mundo real—. Cualquier test que inyecte un `Dio`
  /// dejaba de probar lo que cree probar.
  test('⛔ un Dio inyectado conserva su adaptador', () {
    final dio = Dio();
    final propio = _AdaptadorDePrueba();
    dio.httpClientAdapter = propio;

    ApiClient(tokens: TokenStore(), dio: dio);

    expect(identical(dio.httpClientAdapter, propio), isTrue);
  });

  /// ⛔ Y CONSERVA LOS INTERCEPTORES.
  ///
  /// El otro lado del mismo error: al mover la configuración a un método
  /// aparte, los interceptores se fueron adentro del `if` y un `Dio` inyectado
  /// quedaba sin autenticación ni refresco de token. Los tests habrían pasado
  /// probando un cliente que no es el que corre.
  test('⛔ un Dio inyectado igual recibe los interceptores', () {
    final dio = Dio();
    final antes = dio.interceptors.length;

    ApiClient(tokens: TokenStore(), dio: dio);

    expect(dio.interceptors.length, greaterThan(antes));
  });

  /// Los timeouts NO se tocaron.
  ///
  /// ⚠️ El pedido fue explícito: nada de esconder el problema subiendo esperas.
  /// El arreglo es reusar la conexión, que es otra cosa.
  test('⛔ los timeouts siguen donde estaban', () {
    final dio = Dio();
    ApiClient(tokens: TokenStore(), dio: dio);

    expect(dio.options.connectTimeout, const Duration(seconds: 10));
    expect(dio.options.receiveTimeout, const Duration(seconds: 20));
  });
}

class _AdaptadorDePrueba implements HttpClientAdapter {
  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    throw UnimplementedError('no se usa: sólo se comprueba que sobreviva');
  }
}
