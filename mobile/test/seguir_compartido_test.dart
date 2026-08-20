import 'dart:async';

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
import 'package:vendox/features/lives/data/live_api.dart';
import 'package:vendox/features/lives/domain/live_models.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';
import 'package:vendox/features/social/data/perfil_de_vendedor.dart';
import 'package:vendox/features/social/data/seguimientos.dart';

/// Seguir a un vendedor, desde donde sea.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BUG: UNA VERDAD POR TARJETA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Cada publicación del feed tenía su propio `bool? _siguiendo` adentro del
/// `State` del widget, y su propia consulta del perfil. Con tres productos del
/// mismo vendedor, seguirlo en uno y pasar al siguiente mostraba «Seguir» otra
/// vez: tres respuestas distintas a la misma pregunta, sobre el mismo
/// `sellerId`. Y recorrer treinta productos de cuatro vendedores eran treinta
/// peticiones para responder cuatro preguntas.
///
/// El otro lado del mismo bug: el botón se dibujaba también sobre la tienda
/// propia. El backend rechaza correctamente que alguien se siga a sí mismo, y
/// la app se tragaba ese error — desde afuera, un botón que no hace nada.
///
/// ⚠️ Nada de esto sale a la red: `LiveApi` y `SellerRepository` están doblados.
void main() {
  /**
   * Una pantalla grande, no la de un teléfono.
   *
   * En los tests cada letra se dibuja como un cuadrado del alto de la
   * tipografía, así que el feed —que ya es denso— se desborda por todos lados.
   * Lo que se prueba acá es qué dice cada botón y cuántas peticiones salen, no
   * el diseño.
   */
  const tamanoDePrueba = Size(1400, 2600);

  late _ApiFalsa api;
  late _VendedorPropioFalso propio;

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
    propio = _VendedorPropioFalso();
  });

  List<Override> losDobles(List<PublicacionFeed> items) => [
        liveApiProvider.overrideWithValue(api),
        sellerRepositoryProvider.overrideWithValue(propio),
        sesionProvider.overrideWith(_ConSesion.new),
        feedRepositoryProvider.overrideWithValue(_FeedFalso(items)),
      ];

  /// Monta el feed con las publicaciones que se le pasen, con sesión abierta.
  Future<void> montarFeed(WidgetTester tester, List<PublicacionFeed> items) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: losDobles(items),
        child: MaterialApp(theme: buildAppTheme(), home: const Scaffold(body: FeedScreen())),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// Pasa a la publicación siguiente, como se hace con el pulgar.
  ///
  /// ⚠️ El feed es un `PageView` vertical: hay UNA publicación montada por vez.
  /// Por eso el bug se veía deslizando —seguir en una, pasar a otra del mismo
  /// vendedor, y encontrarla diciendo «Seguir»— y por eso estos tests deslizan
  /// en vez de contar botones en pantalla.
  Future<void> siguiente(WidgetTester tester, String productoEsperado) async {
    await tester.fling(find.byType(PageView), const Offset(0, -600), 2000);
    await tester.pumpAndSettle();

    /**
     * ⚠️ Se comprueba que REALMENTE se pasó de publicación.
     *
     * La primera versión de este ayudante arrastraba 800 píxeles sobre una
     * pantalla de prueba de 2600 de alto: no llegaba al umbral y el `PageView`
     * volvía a su lugar. Los tests pasaban igual, porque la publicación que
     * seguía en pantalla era la misma que ya decía «Siguiendo».
     *
     * Un test que no se movió y cree que sí es peor que uno que falla.
     */
    expect(
      find.text(productoEsperado),
      findsOneWidget,
      reason: 'no se pasó a la publicación siguiente',
    );
  }

  /// El texto de un botón de la publicación, no el de la barra de arriba.
  ///
  /// ⚠️ La pestaña «Siguiendo» del encabezado dice exactamente lo mismo que el
  /// botón cuando ya se sigue al vendedor. Buscar el texto a secas encuentra
  /// las dos, y el test falla por algo que no tiene nada que ver con lo que
  /// prueba.
  ///
  /// La barra vive en el `Stack`, al lado del `PageView`; las publicaciones,
  /// adentro.
  Finder enLaPublicacion(String texto) =>
      find.descendant(of: find.byType(PageView), matching: find.text(texto));

  PublicacionFeed publicacion(String id, String sellerId) => PublicacionFeed(
        id: id,
        nombre: 'Producto $id',
        precioCentavos: 990000,
        vendedor: 'Ana',
        vendedorId: sellerId,
        storeId: 'sto_$sellerId',
        tiendaSlug: 'tienda-$sellerId',
        tiendaNombre: 'Tienda de $sellerId',
      );

  group('Varias publicaciones del mismo vendedor', () {
    /**
     * ⛔ TEST 1 — SEGUIR EN UNA SE VE EN LAS DEMÁS.
     *
     * Es el bug tal cual se reportó: con el estado adentro de cada tarjeta,
     * seguir en la primera y pasar a la segunda del MISMO vendedor mostraba
     * «Seguir» de nuevo.
     */
    testWidgets('⛔ seguir en una publicación se ve en la siguiente', (tester) async {
      await montarFeed(tester, [
        publicacion('p1', 'sel_a'),
        publicacion('p2', 'sel_a'),
        publicacion('p3', 'sel_a'),
      ]);

      expect(enLaPublicacion('Seguir'), findsOneWidget);

      await tester.tap(enLaPublicacion('Seguir'));
      await tester.pumpAndSettle();
      expect(enLaPublicacion('Siguiendo'), findsOneWidget);

      await siguiente(tester, 'Producto p2');
      expect(enLaPublicacion('Siguiendo'), findsOneWidget, reason: 'la segunda dice «Seguir»');
      expect(enLaPublicacion('Seguir'), findsNothing);

      await siguiente(tester, 'Producto p3');
      expect(enLaPublicacion('Siguiendo'), findsOneWidget, reason: 'y la tercera también');
    });

    /**
     * ⛔ TEST 2 — Y DEJAR DE SEGUIR, IGUAL.
     *
     * La otra mitad. Sin esto, un unfollow en una publicación dejaría a las
     * otras diciendo «Siguiendo» sobre alguien a quien ya no se sigue.
     */
    testWidgets('⛔ dejar de seguir en una se ve en la siguiente', (tester) async {
      api.yaSeguidos.add('sel_a');
      await montarFeed(tester, [
        publicacion('p1', 'sel_a'),
        publicacion('p2', 'sel_a'),
      ]);

      expect(enLaPublicacion('Siguiendo'), findsOneWidget);

      await tester.tap(enLaPublicacion('Siguiendo'));
      await tester.pumpAndSettle();
      expect(enLaPublicacion('Seguir'), findsOneWidget);

      await siguiente(tester, 'Producto p2');
      expect(enLaPublicacion('Seguir'), findsOneWidget);
      expect(enLaPublicacion('Siguiendo'), findsNothing);
    });

    /**
     * ⛔ TEST 5 — UNA SOLA CONSULTA POR VENDEDOR, NO POR PUBLICACIÓN.
     *
     * Con el estado adentro de cada tarjeta, cada una preguntaba el perfil por
     * su cuenta: recorrer cuatro publicaciones de dos vendedores eran cuatro
     * peticiones para responder dos preguntas. Y volver hacia atrás, otras
     * tantas.
     */
    testWidgets('⛔ recorrer cuatro publicaciones de dos vendedores pide dos perfiles',
        (tester) async {
      await montarFeed(tester, [
        publicacion('p1', 'sel_a'),
        publicacion('p2', 'sel_a'),
        publicacion('p3', 'sel_b'),
        publicacion('p4', 'sel_b'),
      ]);

      await siguiente(tester, 'Producto p2');
      await siguiente(tester, 'Producto p3');
      await siguiente(tester, 'Producto p4');

      expect(api.perfilesPedidos, hasLength(2));
      expect(api.perfilesPedidos.toSet(), {'sel_a', 'sel_b'});
    });
  });

  group('Vendedores distintos', () {
    /**
     * ⛔ TEST 3 — SEGUIR A UNO NO TOCA AL OTRO.
     *
     * La clave del estado es el `sellerId`. Con un booleano global, seguir a
     * alguien marcaría el feed entero.
     */
    testWidgets('⛔ seguir a A no cambia el botón de B', (tester) async {
      await montarFeed(tester, [
        publicacion('p1', 'sel_a'),
        publicacion('p2', 'sel_b'),
      ]);

      await tester.tap(enLaPublicacion('Seguir'));
      await tester.pumpAndSettle();
      expect(enLaPublicacion('Siguiendo'), findsOneWidget);

      await siguiente(tester, 'Producto p2');

      expect(enLaPublicacion('Seguir'), findsOneWidget, reason: 'B quedó como estaba');
      expect(enLaPublicacion('Siguiendo'), findsNothing);
      expect(api.seguidos, ['sel_a']);
    });
  });

  group('La tienda propia', () {
    /**
     * ⛔ TEST 4 — SOBRE LO PROPIO NO HAY BOTÓN.
     *
     * Ni «Seguir» ni «Siguiendo»: no existe. El backend rechaza que alguien se
     * siga a sí mismo y la app se tragaba ese error en silencio.
     *
     * ⚠️ Se reconoce por ID de vendedor, nunca por nombre de tienda: dos
     * personas pueden llamar igual a la suya, y quien se cambie el nombre
     * dejaría de reconocer la propia.
     */
    testWidgets('⛔ no se dibuja el botón sobre la tienda propia', (tester) async {
      propio.miSellerId = 'sel_a';

      await montarFeed(tester, [
        publicacion('p1', 'sel_a'),
        publicacion('p2', 'sel_b'),
      ]);

      expect(enLaPublicacion('Seguir'), findsNothing, reason: 'es mi propia tienda');
      expect(enLaPublicacion('Siguiendo'), findsNothing);

      // Y sobre la de otro sí aparece.
      await siguiente(tester, 'Producto p2');
      expect(enLaPublicacion('Seguir'), findsOneWidget);
    });

    /**
     * ⛔ Y NI SIQUIERA SE LE PREGUNTA AL SERVIDOR POR LO PROPIO.
     *
     * El perfil se pide para saber si lo sigo, y sobre la tienda propia esa
     * pregunta no tiene sentido.
     */
    testWidgets('⛔ tampoco se pide el perfil de la tienda propia', (tester) async {
      propio.miSellerId = 'sel_a';

      await montarFeed(tester, [publicacion('p1', 'sel_a')]);

      expect(api.perfilesPedidos, isEmpty);
    });

    /// Y quien no tiene tienda ve el botón igual.
    testWidgets('sin tienda propia, el botón se ve', (tester) async {
      propio.miSellerId = null;

      await montarFeed(tester, [publicacion('p1', 'sel_a')]);

      expect(enLaPublicacion('Seguir'), findsOneWidget);
    });
  });

  group('Cuando el backend rechaza', () {
    /**
     * ⛔ TEST 6 — UN FALLO NO MARCA «SIGUIENDO».
     *
     * Se espera la confirmación del servidor antes de cambiar lo que se ve, así
     * que un fallo deja todo como estaba. Y se avisa: antes el error se tragaba
     * con un `catch (_) {}` y el botón quedaba sin hacer nada ni explicar por
     * qué.
     */
    testWidgets('⛔ si seguir falla, el botón no miente y se avisa', (tester) async {
      api.falla = true;
      await montarFeed(tester, [
        publicacion('p1', 'sel_a'),
        publicacion('p2', 'sel_a'),
      ]);

      await tester.tap(enLaPublicacion('Seguir'));
      await tester.pumpAndSettle();

      expect(enLaPublicacion('Siguiendo'), findsNothing, reason: 'no se sigue a nadie');
      expect(enLaPublicacion('Seguir'), findsOneWidget);
      expect(find.byType(SnackBar), findsOneWidget, reason: 'el error no se traga');

      // Y la publicación siguiente del mismo vendedor tampoco quedó marcada.
      await siguiente(tester, 'Producto p2');
      expect(enLaPublicacion('Seguir'), findsOneWidget);
      expect(enLaPublicacion('Siguiendo'), findsNothing);
    });

    /**
     * ⛔ Y NO SE LE AVISA A LA PESTAÑA «SIGUIENDO» COMO SI HUBIERA ANDADO.
     *
     * Rearmar esa pestaña por un follow que falló es una petición de más por
     * cada toque fallido, justo cuando la red anda mal. Y peor: haría creer que
     * el cambio se aplicó.
     */
    testWidgets('⛔ un fallo no notifica a la pestaña «Siguiendo»', (tester) async {
      api.falla = true;
      final contenedor = ProviderContainer(overrides: losDobles([publicacion('p1', 'sel_a')]));
      addTearDown(contenedor.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: contenedor,
          child: MaterialApp(theme: buildAppTheme(), home: const Scaffold(body: FeedScreen())),
        ),
      );
      await tester.pumpAndSettle();

      final antes = contenedor.read(seguimientosProvider);
      await tester.tap(enLaPublicacion('Seguir'));
      await tester.pumpAndSettle();

      expect(contenedor.read(seguimientosProvider), antes);
    });
  });

  group('La pestaña «Siguiendo» sigue enterándose', () {
    /**
     * ⛔ TEST 7 — UN FOLLOW EXITOSO AVISA.
     *
     * Es lo que hace que la pestaña «Siguiendo» se rearme y muestre los
     * productos de quien se acaba de seguir, sin reiniciar la app. El mecanismo
     * es `Seguimientos`, que ya existía: centralizar el estado no puede
     * romperlo.
     */
    testWidgets('⛔ seguir desde el feed sube la versión de seguidos', (tester) async {
      final contenedor = ProviderContainer(overrides: losDobles([publicacion('p1', 'sel_a')]));
      addTearDown(contenedor.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: contenedor,
          child: MaterialApp(theme: buildAppTheme(), home: const Scaffold(body: FeedScreen())),
        ),
      );
      await tester.pumpAndSettle();

      final antes = contenedor.read(seguimientosProvider);
      await tester.tap(enLaPublicacion('Seguir'));
      await tester.pumpAndSettle();

      expect(contenedor.read(seguimientosProvider), greaterThan(antes));
    });
  });

  group('El contador de seguidores', () {
    ProviderContainer contenedorPelado() {
      final c = ProviderContainer(
        overrides: [
          liveApiProvider.overrideWithValue(api),
          sellerRepositoryProvider.overrideWithValue(propio),
          sesionProvider.overrideWith(_ConSesion.new),
        ],
      );
      addTearDown(c.dispose);
      return c;
    }

    /**
     * ⛔ EL NÚMERO ES EL DEL SERVIDOR, NO UNO SUMADO ACÁ.
     *
     * Marcar «Siguiendo» por un lado y sumar uno al contador por otro es cómo
     * se llega a un perfil que dice «Siguiendo» con 0 seguidores. Los dos
     * valores salen juntos de la misma respuesta.
     */
    test('⛔ se toma el que devolvió el backend', () async {
      api.seguidoresTrasSeguir = 42;
      final c = contenedorPelado();

      await c.read(perfilDeVendedorProvider('sel_a').future);
      await c.read(perfilDeVendedorProvider('sel_a').notifier).alternar();

      final vista = c.read(perfilDeVendedorProvider('sel_a')).value!;
      expect(vista.perfil.seguidores, 42);
      expect(vista.loSigo, isTrue);
    });

    /**
     * ⛔ Y UN SEGUNDO TOQUE MIENTRAS EL PRIMERO VIAJA NO HACE NADA.
     *
     * Sin esto, dos toques rápidos mandan un follow y un unfollow, y el estado
     * final lo decide el orden en que contesten — que no es el orden en que se
     * tocó.
     */
    test('⛔ dos toques seguidos mandan una sola operación', () async {
      api.cuelga = true;
      final c = contenedorPelado();

      await c.read(perfilDeVendedorProvider('sel_a').future);
      final notifier = c.read(perfilDeVendedorProvider('sel_a').notifier);

      unawaited(notifier.alternar());
      await Future<void>.delayed(Duration.zero);
      unawaited(notifier.alternar());
      await Future<void>.delayed(Duration.zero);

      expect(api.operaciones, 1);
    });

    /**
     * ⛔ Y UN FALLO CONSERVA EL ESTADO ANTERIOR.
     *
     * No queda a medias ni marcado: exactamente como estaba antes del toque, y
     * el error se relanza para que la pantalla lo muestre.
     */
    test('⛔ si falla, el estado queda como estaba y el error sale', () async {
      api.falla = true;
      final c = contenedorPelado();

      await c.read(perfilDeVendedorProvider('sel_a').future);

      await expectLater(
        c.read(perfilDeVendedorProvider('sel_a').notifier).alternar(),
        throwsA(anything),
      );

      final vista = c.read(perfilDeVendedorProvider('sel_a')).value!;
      expect(vista.loSigo, isFalse);
      expect(vista.alternando, isFalse, reason: 'el botón quedaría trabado');
    });
  });
}

/// El feed, devolviendo lo que el test le pide.
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

  /// A qué vendedores se les pidió el perfil, en orden.
  final List<String> perfilesPedidos = [];

  /// A quiénes se siguió, en orden.
  final List<String> seguidos = [];

  /// Vendedores que esta persona ya sigue antes de empezar.
  final Set<String> yaSeguidos = {};

  /// Cuántas operaciones de follow/unfollow se mandaron.
  int operaciones = 0;

  bool falla = false;
  bool cuelga = false;
  int seguidoresTrasSeguir = 1;

  @override
  Future<PerfilDeVendedor> perfil(String sellerId) async {
    perfilesPedidos.add(sellerId);
    return PerfilDeVendedor.fromJson({
      'id': sellerId,
      'nombre': 'Ana',
      'seguidores': yaSeguidos.contains(sellerId) ? 1 : 0,
      'resenas': 0,
      'ventas': 0,
      'loSigo': yaSeguidos.contains(sellerId),
    });
  }

  @override
  Future<({bool siguiendo, int seguidores})> seguir(String sellerId) async {
    operaciones += 1;
    if (cuelga) return Completer<({bool siguiendo, int seguidores})>().future;
    if (falla) throw StateError('sin red');
    seguidos.add(sellerId);
    yaSeguidos.add(sellerId);
    return (siguiendo: true, seguidores: seguidoresTrasSeguir);
  }

  @override
  Future<({bool siguiendo, int seguidores})> dejarDeSeguir(String sellerId) async {
    operaciones += 1;
    if (cuelga) return Completer<({bool siguiendo, int seguidores})>().future;
    if (falla) throw StateError('sin red');
    yaSeguidos.remove(sellerId);
    return (siguiendo: false, seguidores: 0);
  }
}

/// El vendedor de esta persona, si tiene uno.
class _VendedorPropioFalso extends Fake implements SellerRepository {
  String? miSellerId;

  @override
  Future<PerfilVendedor?> miPerfil() async {
    final id = miSellerId;
    if (id == null) return null;
    return PerfilVendedor.fromJson({
      'seller': {'id': id, 'displayName': 'Yo', 'slug': 'yo', 'status': 'ACTIVE'},
    });
  }
}

/// Una sesión abierta que no toca el llavero.
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
