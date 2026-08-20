import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher_platform_interface/link.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

import 'package:vendox/core/auth/token_store.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/network/api_client.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';
import 'package:vendox/features/orders/domain/order_models.dart';
import 'package:vendox/features/orders/presentation/checkout_sheet.dart';

/// «Pagar con Mercado Pago», la segunda forma de pagar.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE ESTOS TESTS PROTEGEN
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Que el botón abra **el checkout que armó nuestro backend para esta orden**,
/// y no un enlace a Mercado Pago inventado del lado de la app.
///
/// La diferencia no se ve en la pantalla y lo cambia todo: el `init_point` que
/// devuelve el backend nace de una preferencia creada con la cuenta del
/// vendedor, con nuestra comisión sobre el producto y con `external_reference`
/// apuntando a la orden. Un enlace armado acá no tendría nada de eso — cobraría
/// sin comisión, o en la cuenta equivocada, y el webhook no sabría qué orden
/// confirmar.
///
/// Por eso el test central compara la URL **carácter por carácter** con la que
/// contestó el servidor. Es la única forma de que un `'https://mercadopago...'`
/// escrito a mano en el futuro haga fallar algo.
///
/// ⚠️ Nada de esto toca Mercado Pago ni cobra nada: el backend es un adaptador
/// de Dio que contesta JSON fijo, y el lanzador de enlaces es un doble que
/// anota lo que le piden abrir.
void main() {
  /**
   * Una pantalla mucho más grande que cualquier teléfono. Es a propósito.
   *
   * En los tests, Flutter dibuja cada letra como un cuadrado del alto de la
   * tipografía: «Pagar con Mercado Pago» ocupa casi el triple de ancho que en
   * un teléfono real, y la hoja —una `Column` sin scroll— se desborda por los
   * cuatro costados.
   *
   * Probar contra 400×844 acá no sería «probar la geometría real»: sería
   * probar una tipografía que no existe. Lo que estos tests miran es el
   * comportamiento —qué se abre, con qué se cierra—, no el diseño.
   */
  const tamanoDePrueba = Size(1200, 2400);

  late _BackendFalso backend;
  late _LanzadorFalso lanzador;

  setUpAll(() {
    final vista = TestWidgetsFlutterBinding.ensureInitialized().platformDispatcher.views.first;
    vista.physicalSize = tamanoDePrueba;
    vista.devicePixelRatio = 1;
    addTearDown(vista.resetPhysicalSize);
    addTearDown(vista.resetDevicePixelRatio);
  });

  setUp(() async {
    // `ApiClient` arma su URL base al construirse y `TokenStore` toca el
    // almacenamiento seguro: los dos son plugins.
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    await RuntimeConfig.load();

    backend = _BackendFalso();
    lanzador = _LanzadorFalso();
    UrlLauncherPlatform.instance = lanzador;
  });

  /// Monta la hoja como lo que es: una hoja encima de otra pantalla.
  ///
  /// Se abre con `mostrar` —y no montando el widget pelado— porque parte de lo
  /// que hay que comprobar es **con qué se cierra**: si vuelve el pedido, la
  /// pantalla de atrás puede seguir sola.
  Future<_Apertura> abrirLaHoja(WidgetTester tester) async {
    final dio = Dio()..httpClientAdapter = backend;
    final api = ApiClient(tokens: TokenStore(storage: const FlutterSecureStorage()), dio: dio);
    final apertura = _Apertura();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(api)],
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => Center(
                child: TextButton(
                  onPressed: () async {
                    apertura.devuelto = await CheckoutSheet.mostrar(
                      context,
                      reservationId: 'rsv_1',
                      nombreProducto: 'Buzo de lana',
                      precio: r'$32.000',
                    );
                    apertura.cerro = true;
                  },
                  child: const Text('abrir'),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('abrir'));
    await tester.pumpAndSettle();

    return apertura;
  }

  group('Las dos formas de pagar', () {
    testWidgets('las dos están a la vista, sin abrir menús', (tester) async {
      await abrirLaHoja(tester);

      expect(find.text('Pagar con tarjeta'), findsOneWidget);
      expect(find.text('Pagar con Mercado Pago'), findsOneWidget);
    });

    /// El subtítulo existe porque «Pagar con Mercado Pago» solo no dice qué
    /// gana quien lo toca. Lo que gana es no tipear la tarjeta.
    testWidgets('el botón explica para qué sirve', (tester) async {
      await abrirLaHoja(tester);

      expect(
        find.text('Con tu cuenta, saldo o cualquier medio de Mercado Pago.'),
        findsOneWidget,
      );
    });
  });

  group('Qué se abre al tocarlo', () {
    /**
     * ⛔ EL TEST CENTRAL DEL ARCHIVO.
     *
     * La URL que se abre tiene que ser **exactamente** la que contestó el
     * backend. Ver la nota de la cabecera: un enlace armado en la app cobraría
     * sin comisión o en la cuenta equivocada, y se vería idéntico en pantalla.
     */
    testWidgets('⛔ se abre el checkout que armó el backend, tal cual', (tester) async {
      await abrirLaHoja(tester);

      await tester.tap(find.text('Pagar con Mercado Pago'));
      await tester.pumpAndSettle();

      expect(lanzador.abiertos, hasLength(1));
      expect(lanzador.abiertos.single.url, backend.checkoutUrl);
    });

    /**
     * ⛔ Y SE ABRE FUERA DE LA APP.
     *
     * `externalApplication` es lo que deja que Android derive a la app de
     * Mercado Pago, que declara ese enlace como App Link verificado. Dentro de
     * un WebView no puede: quien tiene saldo tendría que volver a escribir su
     * usuario y su contraseña para pagar con él.
     */
    testWidgets('⛔ se abre fuera de la app, no en un WebView', (tester) async {
      await abrirLaHoja(tester);

      await tester.tap(find.text('Pagar con Mercado Pago'));
      await tester.pumpAndSettle();

      expect(lanzador.abiertos.single.modo, PreferredLaunchMode.externalApplication);
    });

    /**
     * ⛔ LA ORDEN EXISTE ANTES DE MANDAR A NADIE A PAGAR.
     *
     * Es lo que ata el pago a la reserva. Si se abriera Mercado Pago sin orden,
     * el webhook recibiría un pago que no corresponde a nada nuestro y lo
     * marcaría huérfano: plata cobrada y ninguna compra confirmada.
     */
    testWidgets('⛔ primero se crea la orden, después se pide el checkout', (tester) async {
      await abrirLaHoja(tester);

      await tester.tap(find.text('Pagar con Mercado Pago'));
      await tester.pumpAndSettle();

      expect(backend.pedidos, ['POST /orders', 'POST /orders/ord_1/checkout']);
    });

    /**
     * La hoja se cierra devolviendo el pedido.
     *
     * Quien compra desde un vivo se fue a otra app y puede tardar minutos.
     * Dejar el checkout abierto encima de la transmisión sería taparle el video
     * sin que esté haciendo nada acá. La reserva no se rompe: el pedido ya
     * existe y la sostiene.
     */
    testWidgets('la hoja se cierra con el pedido en la mano', (tester) async {
      final apertura = await abrirLaHoja(tester);

      await tester.tap(find.text('Pagar con Mercado Pago'));
      await tester.pumpAndSettle();

      expect(apertura.cerro, isTrue);
      expect(apertura.devuelto, isA<Pedido>());
      expect(apertura.devuelto!.id, 'ord_1');
    });
  });

  group('Cuando algo sale mal', () {
    /**
     * ⛔ SI NO SE PUDO ABRIR, NO SE CIERRA NI SE DA POR PAGADO.
     *
     * `launchUrl` devuelve `false` cuando Android no encontró con qué abrir el
     * enlace. Cerrar la hoja ahí dejaría a la persona mirando el vivo, creyendo
     * que compró.
     */
    testWidgets('⛔ si no se puede abrir, se avisa y la hoja sigue abierta', (tester) async {
      lanzador.exito = false;
      final apertura = await abrirLaHoja(tester);

      await tester.tap(find.text('Pagar con Mercado Pago'));
      await tester.pumpAndSettle();

      expect(apertura.cerro, isFalse);
      expect(find.text('No pudimos abrir Mercado Pago. Probá con tarjeta.'), findsOneWidget);
    });

    /**
     * ⛔ Y SI EL BACKEND RECHAZA, NO SE CREA OTRA ORDEN.
     *
     * El 409 llega cuando ya hay un cobro con tarjeta en curso para esta misma
     * orden. Volver a crear el pedido duplicaría la compra; lo correcto es
     * mostrar lo que dijo el servidor sobre la orden que ya existe.
     */
    testWidgets('⛔ un rechazo del backend no duplica el pedido', (tester) async {
      backend.checkoutFalla = true;
      final apertura = await abrirLaHoja(tester);

      await tester.tap(find.text('Pagar con Mercado Pago'));
      await tester.pumpAndSettle();

      expect(apertura.cerro, isFalse);
      expect(lanzador.abiertos, isEmpty);
      expect(backend.pedidos.where((p) => p == 'POST /orders'), hasLength(1));
      expect(find.text('Ya hay un pago en curso para este pedido.'), findsOneWidget);
    });
  });
}

/// Lo que quedó de abrir la hoja: si se cerró, y con qué.
class _Apertura {
  bool cerro = false;
  Pedido? devuelto;
}

/// El backend, contestando JSON fijo sin salir a la red.
class _BackendFalso implements HttpClientAdapter {
  /// El `init_point` de la preferencia. Es un valor cualquiera **con una parte
  /// impredecible**: si la app armara la URL por su cuenta, no podría acertarlo.
  final String checkoutUrl =
      'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1234567890-abcd-ef01';

  /// Si el pedido de checkout tiene que fallar, como cuando ya hay un cobro
  /// con tarjeta en curso.
  bool checkoutFalla = false;

  /// Qué se le pidió, en orden.
  final List<String> pedidos = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final ruta = options.path.replaceFirst(RegExp(r'^.*/api/v\d+'), '');
    pedidos.add('${options.method} $ruta');

    if (ruta == '/orders') return _json(201, _pedido);

    if (ruta == '/orders/ord_1/checkout') {
      if (checkoutFalla) {
        return _json(409, {
          'error': {
            'code': 'PAYMENT_IN_FLIGHT',
            'message': 'Ya hay un pago en curso para este pedido.',
          },
        });
      }
      return _json(201, {'attemptId': 'pat_1', 'checkoutUrl': checkoutUrl});
    }

    return _json(404, {
      'error': {'code': 'NOT_FOUND', 'message': 'No existe.'},
    });
  }

  static ResponseBody _json(int status, Object cuerpo) => ResponseBody.fromString(
        jsonEncode(cuerpo),
        status,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );

  static final Map<String, dynamic> _pedido = {
    'id': 'ord_1',
    'reference': 'VX-0001',
    'status': 'PENDING_PAYMENT',
    'createdAt': '2026-08-20T12:00:00.000Z',
    'itemsSubtotal': 3200000,
    'shippingAmount': 0,
    'processorSurchargeAmount': 0,
    'discountAmount': 0,
    'grossAmount': 3200000,
    'platformFeeAmount': 128000,
    'sellerNetAmount': 3072000,
    'pickupSelected': true,
    'store': {'name': 'Lanas del Sur'},
    'items': [
      {
        'productNameSnapshot': 'Buzo de lana',
        'variantLabelSnapshot': 'Default',
        'quantity': 1,
        'unitPrice': 3200000,
      },
    ],
  };

  @override
  void close({bool force = false}) {}
}

/// El lanzador de enlaces del sistema, reemplazado por uno que anota.
///
/// Extiende la clase real —no la implementa— para que el chequeo de token de
/// `PlatformInterface` lo acepte.
class _LanzadorFalso extends UrlLauncherPlatform {
  /// Qué contesta Android: `false` es «no encontré con qué abrir esto».
  bool exito = true;

  final List<({String url, PreferredLaunchMode modo})> abiertos = [];

  @override
  LinkDelegate? get linkDelegate => null;

  @override
  Future<bool> launchUrl(String url, LaunchOptions options) async {
    abiertos.add((url: url, modo: options.mode));
    return exito;
  }
}
