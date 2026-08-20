import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/design/theme.dart';
import 'package:vendox/core/enlaces/destino.dart';
import 'package:vendox/features/auth/domain/session.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';
import 'package:vendox/features/feed/data/feed_repository.dart';
import 'package:vendox/features/feed/domain/feed_models.dart';
import 'package:vendox/features/feed/presentation/feed_screen.dart';
import 'package:vendox/features/inventory/domain/inventory_models.dart';
import 'package:vendox/features/lives/data/live_api.dart';
import 'package:vendox/features/lives/domain/live_models.dart';
import 'package:vendox/features/lives/presentation/tienda_screen.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';
import 'package:vendox/features/social/data/social_api.dart';

/// Compartir una publicación, y entrar a la tienda desde ella.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE HABÍA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// «Enviar» mostraba un aviso con el texto `vendox.com/<slug de la tienda>`.
/// Dos cosas mal a la vez: el destino —la tienda, no el producto que se está
/// mirando— y el mecanismo —un cartel, no la hoja de compartir del sistema—.
/// Ese texto tampoco era una URL real: el dominio es `vendox.com.ar`.
///
/// Y «Tienda» decía que la tienda «llega con la vidriera pública», que ya
/// existe.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL ENLACE LO ARMA EL BACKEND
/// ═══════════════════════════════════════════════════════════════════════════
///
/// `GET /share/product/:id` ya existía y lo usaba el vivo. Se reutiliza tal
/// cual: un enlace compartido sobrevive a la versión de la app que lo generó, y
/// si cada versión tuviera su propia idea del formato, cambiarlo rompería los
/// que ya están dando vueltas en los chats.
void main() {
  const tamanoDePrueba = Size(1400, 2600);

  late _SocialFalso social;
  late _ApiFalsa api;

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
    social = _SocialFalso();
    api = _ApiFalsa();
  });

  PublicacionFeed publicacion({
    String id = 'prd_1',
    String sellerId = 'sel_a',
    String storeId = 'sto_1',
  }) =>
      PublicacionFeed(
        id: id,
        nombre: 'Ropa prueba',
        precioCentavos: 1000,
        vendedor: 'Ana',
        vendedorId: sellerId,
        storeId: storeId,
        tiendaSlug: 'tienda-de-ana',
        tiendaNombre: 'Tienda de Ana',
        variantePorDefectoId: 'var_1',
        disponibilidad: const Disponibilidad(availability: 'IN_STOCK', remaining: 5),
      );

  Future<void> montarFeed(WidgetTester tester, List<PublicacionFeed> items) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          socialApiProvider.overrideWithValue(social),
          liveApiProvider.overrideWithValue(api),
          sellerRepositoryProvider.overrideWithValue(_SinTienda()),
          sesionProvider.overrideWith(_ConSesion.new),
          feedRepositoryProvider.overrideWithValue(_FeedFalso(items)),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          home: const Scaffold(body: FeedScreen()),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  group('El botón Enviar', () {
    /**
     * ⛔ COMPARTE EL PRODUCTO, NO LA TIENDA.
     *
     * Es lo que la persona está mirando. Compartir la tienda manda a quien
     * recibe el mensaje a un catálogo entero a buscar cuál era.
     */
    testWidgets('⛔ pide el enlace del producto que se está mirando', (tester) async {
      await montarFeed(tester, [publicacion()]);

      await tester.tap(find.text('Enviar'));
      await tester.pumpAndSettle();

      expect(social.pedidos, [(cosa: 'product', id: 'prd_1', origen: 'feed')]);
    });

    /**
     * ⛔ Y CADA PRODUCTO TIENE EL SUYO.
     *
     * Con el enlace de la tienda, dos productos distintos del mismo vendedor
     * generaban exactamente el mismo texto.
     */
    testWidgets('⛔ dos productos generan enlaces distintos', (tester) async {
      social.url = 'https://vendox.com.ar/p/prd_1';
      await montarFeed(tester, [publicacion(), publicacion(id: 'prd_2')]);

      await tester.tap(find.text('Enviar'));
      await tester.pumpAndSettle();

      await tester.fling(find.byType(PageView), const Offset(0, -600), 2000);
      await tester.pumpAndSettle();

      social.url = 'https://vendox.com.ar/p/prd_2';
      await tester.tap(find.text('Enviar'));
      await tester.pumpAndSettle();

      expect(social.pedidos.map((p) => p.id).toList(), ['prd_1', 'prd_2']);
    });

    /**
     * ⛔ Y EL ENLACE ES EL QUE ABRE LA APP.
     *
     * La URL canónica que arma el backend tiene que resolver al producto en el
     * mismo resolutor que atiende los App Links. Sin esto, alguien con la app
     * instalada tocaría el enlace y caería en el navegador.
     */
    test('⛔ el enlace canónico del producto abre la app', () {
      final destino = resolverEnlace(Uri.parse('https://vendox.com.ar/p/prd_1'));

      expect(destino, const DestinoEnApp(TipoDeDestino.producto, 'prd_1'));
    });

    /**
     * Un fallo al pedir el enlace no rompe el feed.
     *
     * Compartir es opcional: quien está mirando un video no puede quedarse con
     * una pantalla de error porque una petición secundaria falló.
     */
    testWidgets('un fallo al compartir no rompe la pantalla', (tester) async {
      social.falla = true;
      await montarFeed(tester, [publicacion()]);

      await tester.tap(find.text('Enviar'));
      await tester.pumpAndSettle();

      expect(find.text('Enviar'), findsOneWidget, reason: 'el feed se rompió');
    });
  });

  group('El botón Tienda', () {
    /**
     * ⛔ ABRE LA TIENDA, NO UN CARTEL.
     *
     * Y es la misma pantalla que se abre desde el vivo y desde el perfil del
     * vendedor: una sola vidriera en toda la app.
     */
    testWidgets('⛔ abre la vidriera del vendedor', (tester) async {
      await montarFeed(tester, [publicacion()]);

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();

      expect(find.byType(TiendaScreen), findsOneWidget);
      expect(api.tiendasPedidas, ['sto_1'], reason: 'abrió otra tienda');
    });

    /// Y vuelve al feed sin perder nada.
    testWidgets('volver atrás devuelve al feed', (tester) async {
      await montarFeed(tester, [publicacion()]);

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      expect(find.byType(TiendaScreen), findsNothing);
      expect(find.text('Tienda'), findsOneWidget);
    });
  });
}

typedef _Pedido = ({String cosa, String id, String? origen});

class _SocialFalso extends Fake implements SocialApi {
  final List<_Pedido> pedidos = [];

  String url = 'https://vendox.com.ar/p/prd_1';
  bool falla = false;

  @override
  Future<({String url, String texto})> compartir(
    String cosa,
    String identificador, {
    String? origen,
  }) async {
    pedidos.add((cosa: cosa, id: identificador, origen: origen));
    if (falla) throw StateError('sin red');
    return (url: url, texto: 'Ropa prueba — \$ 10,00 en VendoX\n$url');
  }
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

class _ApiFalsa extends Fake implements LiveApi {
  final List<String> tiendasPedidas = [];

  @override
  Future<PaginaDeCatalogo> catalogo(String storeId, {String? cursor, String? q}) async {
    tiendasPedidas.add(storeId);
    return const PaginaDeCatalogo(items: []);
  }
}

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
        }),
      );

  @override
  Future<void> restaurar() async {}
}
