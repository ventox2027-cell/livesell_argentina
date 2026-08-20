import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vendox/core/auth/token_store.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/design/theme.dart';
import 'package:vendox/core/network/api_client.dart';
import 'package:vendox/features/auth/domain/session.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';
import 'package:vendox/features/feed/data/feed_repository.dart';
import 'package:vendox/features/feed/domain/feed_models.dart';
import 'package:vendox/features/feed/presentation/feed_screen.dart';
import 'package:vendox/features/inventory/data/inventory_repository.dart';
import 'package:vendox/features/inventory/domain/inventory_models.dart';
import 'package:vendox/features/lives/data/live_api.dart';
import 'package:vendox/features/lives/domain/live_models.dart';
import 'package:vendox/features/lives/presentation/variant_sheet.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';

/// Tocar «Comprar» arranca con el producto de AHORA, no con el del feed.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BUG
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El feed abría la hoja de reserva directamente con lo que tenía en memoria:
/// `datos.precio` y `datos.variantePorDefectoId`. Con el feed cargado hace un
/// rato, alguien apartaba un producto de $150.000 que el vendedor ya había
/// bajado a $10 — y lo apartaba mirando el precio viejo.
///
/// El feed puede estar momentáneamente viejo: es una lista cacheada y está bien
/// que lo sea. Lo que no puede es que una operación comercial arranque de ese
/// snapshot.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA UNIFICACIÓN
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El vivo, la tienda y la búsqueda ya entraban por `VariantSheet`, que pide el
/// producto al backend antes de mostrar nada. Ahora el feed también: cuatro
/// caminos, una sola fuente de verdad al iniciar la compra.
void main() {
  const tamanoDePrueba = Size(1400, 2600);

  late _ApiFalsa api;
  late _InventarioFalso inventario;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({});
    await RuntimeConfig.load();

    final vista = TestWidgetsFlutterBinding.ensureInitialized().platformDispatcher.views.first;
    vista.physicalSize = tamanoDePrueba;
    vista.devicePixelRatio = 1;
    addTearDown(vista.resetPhysicalSize);
    addTearDown(vista.resetDevicePixelRatio);
  });

  setUp(() {
    api = _ApiFalsa();
    inventario = _InventarioFalso();
  });

  /// Una publicación del feed, con el precio que el feed cree que tiene.
  PublicacionFeed publicacionDelFeed({required int precioCentavos}) => PublicacionFeed(
        id: 'prd_1',
        nombre: 'Ropa prueba',
        precioCentavos: precioCentavos,
        vendedor: 'Ana',
        vendedorId: 'sel_a',
        storeId: 'sto_1',
        tiendaSlug: 'tienda-ana',
        tiendaNombre: 'Tienda de Ana',
        // El feed también trae la variante, y también puede estar vieja.
        variantePorDefectoId: 'var_vieja',
        // Con stock: es lo que habilita el botón «Comprar» de la tarjeta.
        disponibilidad: const Disponibilidad(availability: 'IN_STOCK', remaining: 5),
      );

  Future<void> montarFeed(WidgetTester tester, PublicacionFeed publicacion) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveApiProvider.overrideWithValue(api),
          inventoryRepositoryProvider.overrideWithValue(inventario),
          sellerRepositoryProvider.overrideWithValue(_SinTienda()),
          sesionProvider.overrideWith(_ConSesion.new),
          feedRepositoryProvider.overrideWithValue(_FeedFalso([publicacion])),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          home: const Scaffold(body: FeedScreen()),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// El «Comprar» de la tarjeta del feed: abre la hoja de variantes.
  Future<void> comprarDesdeElFeed(WidgetTester tester) async {
    await tester.tap(find.text('Comprar'));
    await tester.pumpAndSettle();
  }

  /// El «Comprar» de la hoja de variantes: abre la hoja de la reserva.
  ///
  /// ⚠️ `.last` porque el del feed sigue montado detrás de la hoja y dice lo
  /// mismo. Sin eso, el test tocaría el de atrás y no pasaría nada.
  Future<void> comprarEnLaHoja(WidgetTester tester) async {
    await tester.tap(find.text('Comprar').last);
    await tester.pumpAndSettle();
  }

  /// El botón de la hoja de variantes, para mirar qué dice y si está activo.
  Finder botonDeLaHoja(String texto) => find.text(texto).last;

  group('El precio con el que arranca la compra', () {
    /**
     * ⛔ EL CASO REPORTADO.
     *
     * El feed dice $150.000 porque se cargó antes del cambio. El backend ya
     * tiene $10. Tocar «Comprar» tiene que mostrar $10.
     */
    testWidgets('⛔ con el feed viejo, Comprar muestra el precio actual', (tester) async {
      api.precioCentavos = 1000; // $10
      await montarFeed(tester, publicacionDelFeed(precioCentavos: 15000000)); // $150.000

      // El feed muestra lo viejo, y está bien: es una lista cacheada.
      expect(find.textContaining('150.000'), findsWidgets);

      await comprarDesdeElFeed(tester);

      expect(api.productosPedidos, ['prd_1'], reason: 'no se pidió el producto');

      /**
       * ⚠️ Se mira DENTRO de la hoja.
       *
       * La tarjeta del feed sigue montada detrás y sigue diciendo $150.000 —es
       * correcto: es la lista cacheada, y se va a refrescar al cerrar—. Lo que
       * importa es con qué precio arranca la compra.
       */
      final enLaHoja = find.descendant(
        of: find.byType(VariantSheet),
        matching: find.textContaining(r'$ 10,00'),
      );
      expect(enLaHoja, findsWidgets, reason: 'la hoja arrancó con el precio viejo');
      expect(
        find.descendant(
          of: find.byType(VariantSheet),
          matching: find.textContaining('150.000'),
        ),
        findsNothing,
      );
    });

    /**
     * ⛔ Y LA VARIANTE TAMBIÉN SALE DE LO FRESCO.
     *
     * El feed traía `variantePorDefectoId` y se usaba tal cual para apartar. Si
     * el vendedor rehízo las variantes, ese id ya no existe y la reserva
     * apuntaría a algo que no está.
     */
    testWidgets('⛔ aparta la variante de ahora, no la que traía el feed', (tester) async {
      await montarFeed(tester, publicacionDelFeed(precioCentavos: 15000000));
      await comprarDesdeElFeed(tester);

      await comprarEnLaHoja(tester);
      await tester.tap(find.text('Apartar'));
      await tester.pumpAndSettle();

      expect(inventario.reservadas, ['var_fresca'], reason: 'apartó la variante vieja del feed');
    });
  });

  group('Productos con y sin opciones', () {
    /**
     * Con una sola variante no se agrega ningún paso: queda elegida sola y el
     * botón de apartar está a un toque, como antes.
     */
    testWidgets('un producto sin opciones queda listo para apartar', (tester) async {
      await montarFeed(tester, publicacionDelFeed(precioCentavos: 1000));
      await comprarDesdeElFeed(tester);

      expect(botonDeLaHoja('Comprar'), findsOneWidget);
      expect(find.text('Elegí una opción'), findsNothing);

      // Y a un toque queda la reserva, sin pasos de más.
      await comprarEnLaHoja(tester);
      expect(find.text('Apartar'), findsOneWidget);
    });

    /**
     * Con talle o color, en cambio, hay que elegir antes de poder apartar. Es
     * justo lo que el camino viejo se salteaba: apartaba la variante por
     * defecto sin preguntar.
     */
    testWidgets('un producto con talle pide elegir antes de apartar', (tester) async {
      api.conTalles = true;
      await montarFeed(tester, publicacionDelFeed(precioCentavos: 1000));
      await comprarDesdeElFeed(tester);

      expect(find.text('Elegí una opción'), findsOneWidget);

      await tester.tap(find.text('L'));
      await tester.pumpAndSettle();

      expect(find.text('Elegí una opción'), findsNothing);
      await comprarEnLaHoja(tester);
      expect(find.text('Apartar'), findsOneWidget);
    });
  });

  group('Cuando ya no se puede comprar', () {
    /**
     * ⛔ AGOTADO DE VERDAD, AUNQUE EL FEED DIGA QUE HAY.
     *
     * El feed puede mostrar disponible algo que se agotó hace un minuto. Al
     * pedir el producto fresco, el botón queda apagado y nadie aparta contra
     * un stock que no existe.
     */
    testWidgets('⛔ si se agotó, no se puede apartar con los datos viejos', (tester) async {
      api.agotado = true;
      await montarFeed(tester, publicacionDelFeed(precioCentavos: 1000));
      await comprarDesdeElFeed(tester);

      expect(botonDeLaHoja('Agotado'), findsOneWidget);
      expect(find.text('Apartar'), findsNothing);
      expect(inventario.reservadas, isEmpty);
    });

    /// Y si el producto ya no se puede leer, se dice, sin apartar nada.
    testWidgets('⛔ si el producto no carga, no se aparta nada', (tester) async {
      api.falla = true;
      await montarFeed(tester, publicacionDelFeed(precioCentavos: 1000));
      await comprarDesdeElFeed(tester);

      expect(find.text('No pudimos cargar el producto'), findsOneWidget);
      expect(inventario.reservadas, isEmpty);
    });
  });
}

/// El inventario: acá se ve qué variante se mandó a apartar de verdad.
class _InventarioFalso extends Fake implements InventoryRepository {
  final List<String> reservadas = [];

  @override
  Future<Reserva> reservar({
    required String productVariantId,
    required String idempotencyKey,
    int quantity = 1,
  }) async {
    reservadas.add(productVariantId);
    return Reserva.fromJson({
      'reservationId': 'rsv_1',
      'status': 'ACTIVE',
      'productVariantId': productVariantId,
      'quantity': quantity,
      'expiresAt': DateTime.now().add(const Duration(minutes: 3)).toIso8601String(),
      'remainingSeconds': 180,
    });
  }

  @override
  Future<void> cancelar(String reservationId) async {}

  @override
  Future<Disponibilidad> disponibilidad(String productVariantId) async =>
      const Disponibilidad(availability: 'IN_STOCK', remaining: 5);
}

class _FeedFalso extends Fake implements FeedRepository {

  _FeedFalso(this._items);
  final List<PublicacionFeed> _items;

  @override
  Future<({List<PublicacionFeed> items, String? nextCursor})> descubrir({
    String? cursor,
    int limit = 20,
    String? q,
    bool soloSeguidos = false,
  }) async =>
      (items: _items, nextCursor: null);
}

class _ApiFalsa extends LiveApi {
  _ApiFalsa() : super(ApiClient(tokens: TokenStore()));

  /// Qué productos se pidieron frescos, en orden.
  final List<String> productosPedidos = [];

  /// Qué variantes se mandaron a apartar.
  final List<String> reservadas = [];

  /// El precio que tiene el producto EN EL BACKEND ahora mismo.
  int precioCentavos = 1000;

  bool conTalles = false;
  bool agotado = false;
  bool falla = false;

  @override
  Future<DetalleDeProducto> producto(String productId) async {
    productosPedidos.add(productId);
    if (falla) throw StateError('sin red');

    return DetalleDeProducto.fromJson({
      'id': productId,
      'nombre': 'Ropa prueba',
      'precioCentavos': precioCentavos,
      'imagenes': <dynamic>[],
      'ejes': conTalles
          ? [
              {
                'nombre': 'Talle',
                'valores': [
                  {'id': 'ov_m', 'valor': 'M'},
                  {'id': 'ov_l', 'valor': 'L'},
                ],
              },
            ]
          : <dynamic>[],
      'variantes': conTalles
          ? [
              {
                'id': 'var_m',
                'precioCentavos': precioCentavos,
                'disponible': agotado ? 0 : 5,
                'valoresDeOpcion': ['ov_m'],
              },
              {
                'id': 'var_fresca',
                'precioCentavos': precioCentavos,
                'disponible': agotado ? 0 : 5,
                'valoresDeOpcion': ['ov_l'],
              },
            ]
          : [
              {
                'id': 'var_fresca',
                'precioCentavos': precioCentavos,
                'disponible': agotado ? 0 : 5,
                'valoresDeOpcion': <dynamic>[],
              },
            ],
    });
  }

  @override
  Future<EstadoDeTienda> estadoDeTienda(String storeId) async =>
      const EstadoDeTienda(abierta: true, motivo: '');
}

/// Quien mira el feed no tiene tienda propia: el botón de seguir se dibuja.
class _SinTienda extends Fake implements SellerRepository {
  @override
  Future<PerfilVendedor?> miPerfil() async => null;
}

class _ConSesion extends SesionNotifier {
  @override
  EstadoSesion build() => ConSesion(
        usuario: Usuario.fromJson(const {
          'id': 'usr_prueba',
          'firstName': 'Ana',
          'lastName': 'Prueba',
          'email': 'ana@test.com',
          'role': 'buyer',
          'phone': '+541100000000',
          'phoneVerified': true,
        }),
      );

  @override
  Future<void> restaurar() async {}
}
