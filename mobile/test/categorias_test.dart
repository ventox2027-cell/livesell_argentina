import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendox/core/auth/token_store.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/network/api_client.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';
import 'package:vendox/features/seller/data/categorias_api.dart';
import 'package:vendox/features/seller/presentation/product_editor_screen.dart';

/// El selector de rubro del editor de producto.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// QUÉ PROTEGE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El rubro es obligatorio para publicar. Si el selector no aparece, o aparece
/// roto, el vendedor carga el producto y descubre el requisito recién cuando
/// toca Publicar y el backend lo rechaza — con todo el trabajo ya hecho.
void main() {
  const catalogo = [
    Categoria(id: 'cat_indumentaria', slug: 'indumentaria', nombre: 'Indumentaria'),
    Categoria(id: 'cat_calzado', slug: 'calzado', nombre: 'Calzado'),
    Categoria(id: 'cat_otros', slug: 'otros', nombre: 'Otros'),
  ];

  Widget editor({AsyncValue<List<Categoria>>? estado}) => ProviderScope(
        overrides: [
          categoriasProvider.overrideWith(
            (ref) async => switch (estado) {
              AsyncError(:final error) => throw error,
              _ => catalogo,
            },
          ),
        ],
        child: const MaterialApp(home: ProductEditorScreen()),
      );

  testWidgets('el rubro aparece en el formulario de un producto nuevo', (tester) async {
    await tester.pumpWidget(editor());
    await tester.pumpAndSettle();

    expect(find.text('Rubro'), findsOneWidget);
    // Y dice para qué sirve: sin esto es un campo más que se saltea.
    expect(find.textContaining('Hace falta para publicar'), findsOneWidget);
  });

  testWidgets('se puede elegir una categoría de la lista', (tester) async {
    await tester.pumpWidget(editor());
    await tester.pumpAndSettle();

    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();

    // Las tres del catálogo, en el desplegable abierto.
    expect(find.text('Calzado').hitTestable(), findsOneWidget);

    await tester.tap(find.text('Calzado').hitTestable());
    await tester.pumpAndSettle();

    expect(find.text('Calzado'), findsOneWidget);
  });

  testWidgets('⛔ si el catálogo no carga, el formulario sigue usable', (tester) async {
    /**
     * El caso de la mala señal. Un vendedor en un sótano tiene que poder
     * guardar el borrador igual: lo único que no va a poder es publicar, y eso
     * ya se lo dice el botón de publicar.
     *
     * Sin esto, un `throw` dentro de un `when` sin rama de error tumba la
     * pantalla entera del editor.
     */
    await tester.pumpWidget(editor(estado: AsyncError(Exception('sin red'), StackTrace.empty)));
    await tester.pumpAndSettle();

    expect(find.textContaining('No se pudo cargar'), findsOneWidget);
    expect(find.text('Reintentar'), findsOneWidget);

    // El resto del formulario está entero.
    expect(find.text('¿Qué vendés?'), findsOneWidget);
    expect(find.text('Precio'), findsOneWidget);
    expect(find.text('Crear producto'), findsOneWidget);
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * EL CARTEL TIENE QUE DECIR LA VERDAD
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Pasó de verdad, probando en un celular: el rubro mostraba «Sin conexión
   * con el servidor». El servidor estaba arriba, contestaba `/health` con 200
   * y respondía 404 en `/categories` porque el proceso era viejo y no tenía la
   * ruta.
   *
   * El cartel mandó a revisar WiFi, IP y firewall durante un buen rato. El
   * problema estaba del otro lado y el servidor lo estaba diciendo — con un
   * número que la pantalla tiraba a la basura.
   */
  group('El motivo del fallo', () {
    test('un 404 no se reporta como falta de conexión', () {
      const fallo = FalloDeCategorias(MotivoDeFallo.servidor, statusCode: 404);
      final msg = mensajeDeFalloDeCategorias(fallo);

      expect(msg, contains('404'));
      expect(msg, isNot(contains('Sin conexión')));
    });

    test('un 500 tampoco, y también muestra su número', () {
      final fallo = DioException(
        requestOptions: RequestOptions(path: '/categories'),
        type: DioExceptionType.badResponse,
        response: Response(
          requestOptions: RequestOptions(path: '/categories'),
          statusCode: 500,
        ),
      );
      final msg = mensajeDeFalloDeCategorias(fallo);

      expect(msg, contains('500'));
      expect(msg, isNot(contains('Sin conexión')));
    });

    test('la falta de conexión REAL sí lo dice', () {
      // La contraparte. Sin esto, un mensaje que nunca dijera «sin conexión»
      // pasaría los tests de arriba igual.
      final fallo = DioException(
        requestOptions: RequestOptions(path: '/categories'),
        type: DioExceptionType.connectionError,
      );

      expect(mensajeDeFalloDeCategorias(fallo), 'Sin conexión con el servidor');
    });

    test('un servidor que no contesta a tiempo se distingue de uno caído', () {
      // Son cosas distintas y llevan a revisar cosas distintas: una es la red,
      // la otra es el servidor tardando.
      final fallo = DioException(
        requestOptions: RequestOptions(path: '/categories'),
        type: DioExceptionType.receiveTimeout,
      );

      expect(mensajeDeFalloDeCategorias(fallo), contains('tardó demasiado'));
    });

    test('una respuesta con forma inesperada no miente sobre la red', () {
      const fallo = FalloDeCategorias(MotivoDeFallo.respuestaInesperada);
      final msg = mensajeDeFalloDeCategorias(fallo);

      expect(msg, 'No pudimos leer la lista');
      expect(msg, isNot(contains('Sin conexión')));
    });
  });

  group('Lo que ve el vendedor en el campo', () {
    testWidgets('⛔ con un 404 no dice «Sin conexión»', (tester) async {
      await tester.pumpWidget(
        editor(
          estado: const AsyncError(
            FalloDeCategorias(MotivoDeFallo.servidor, statusCode: 404),
            StackTrace.empty,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('404'), findsOneWidget);
      expect(find.text('Sin conexión con el servidor'), findsNothing);
      // Y sigue pudiendo reintentar y guardar el borrador.
      expect(find.text('Reintentar'), findsOneWidget);
    });

    testWidgets('sin red, sí dice «Sin conexión»', (tester) async {
      await tester.pumpWidget(
        editor(
          estado: AsyncError(
            DioException(
              requestOptions: RequestOptions(path: '/categories'),
              type: DioExceptionType.connectionError,
            ),
            StackTrace.empty,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Sin conexión con el servidor'), findsOneWidget);
    });
  });

  group('Lo que el provider hace con la respuesta', () {
    /// El 404 llega como respuesta NORMAL, no como excepción.
    ///
    /// `ApiClient` usa `validateStatus: (s) => s < 500`, así que Dio no lanza.
    /// Y el cuerpo de un 404 es un objeto de error, no una lista — pedirlo
    /// tipado como `List<dynamic>` hacía que reventara con un `TypeError`
    /// antes de poder mirar el código de estado.
    ProviderContainer contenedorCon({required int status, required Object cuerpo}) {
      final dio = Dio()..httpClientAdapter = _AdaptadorFijo(status: status, cuerpo: cuerpo);
      final api = ApiClient(tokens: TokenStore(storage: const FlutterSecureStorage()), dio: dio);

      return ProviderContainer(overrides: [apiClientProvider.overrideWithValue(api)]);
    }

    setUp(() async {
      // `ApiClient` arma su `baseUrl` desde `RuntimeConfig` al construirse, y
      // `TokenStore` toca el almacenamiento seguro. Los dos son plugins: sin
      // los mocks, el constructor revienta antes de llegar a la petición.
      TestWidgetsFlutterBinding.ensureInitialized();
      FlutterSecureStorage.setMockInitialValues({});
      SharedPreferences.setMockInitialValues({});
      await RuntimeConfig.load();
    });

    test('⛔ un 404 conserva el código en vez de reventar', () async {
      final c = contenedorCon(
        status: 404,
        cuerpo: {
          'error': {'code': 'HTTP_ERROR', 'message': 'Cannot GET /api/v1/categories'},
        },
      );
      addTearDown(c.dispose);

      await expectLater(
        c.read(categoriasProvider.future),
        throwsA(
          isA<FalloDeCategorias>()
              .having((e) => e.motivo, 'motivo', MotivoDeFallo.servidor)
              .having((e) => e.statusCode, 'statusCode', 404),
        ),
      );
    });

    test('un 200 con la lista se parsea', () async {
      // La contraparte: sin esto, un provider que fallara siempre pasaría el
      // test de arriba.
      final c = contenedorCon(
        status: 200,
        cuerpo: [
          {'id': 'cat_indumentaria', 'slug': 'indumentaria', 'nombre': 'Indumentaria'},
        ],
      );
      addTearDown(c.dispose);

      final lista = await c.read(categoriasProvider.future);
      expect(lista, hasLength(1));
      expect(lista.first.id, 'cat_indumentaria');
      expect(lista.first.nombre, 'Indumentaria');
    });

    test('un 200 con algo que no es lista no se toma por bueno', () async {
      final c = contenedorCon(status: 200, cuerpo: {'items': []});
      addTearDown(c.dispose);

      await expectLater(
        c.read(categoriasProvider.future),
        throwsA(
          isA<FalloDeCategorias>()
              .having((e) => e.motivo, 'motivo', MotivoDeFallo.respuestaInesperada),
        ),
      );
    });
  });
}

/// Un adaptador que contesta siempre lo mismo, sin red.
class _AdaptadorFijo implements HttpClientAdapter {
  _AdaptadorFijo({required this.status, required this.cuerpo});

  final int status;
  final Object cuerpo;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async =>
      ResponseBody.fromString(
        jsonEncode(cuerpo),
        status,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );

  @override
  void close({bool force = false}) {}
}
