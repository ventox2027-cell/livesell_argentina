import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vendox/core/auth/token_store.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/enlaces/destino.dart';
import 'package:vendox/core/enlaces/navegador_de_enlaces.dart';
import 'package:vendox/core/enlaces/pantallas_de_destino.dart';
import 'package:vendox/core/network/api_client.dart';
import 'package:vendox/features/lives/data/live_api.dart';
import 'package:vendox/features/lives/domain/como_llegar_al_vivo.dart';
import 'package:vendox/features/lives/domain/live_models.dart';
import 'package:vendox/features/lives/presentation/tienda_screen.dart';

/// `vendox.com.ar/t/<slug>` — la tienda desde un enlace compartido.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL SLUG LO TRADUCE EL BACKEND, SIEMPRE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El enlace lleva el slug porque un slug se lee y un id no. Pero el catálogo
/// resuelve por id, así que alguien tiene que traducir — y ahí no hay sólo una
/// traducción: están las reglas de qué tienda se puede mostrar. Tienda activa,
/// vendedor activo.
///
/// Con esa resolución en la app, bastaría con tener un enlace guardado para
/// seguir viendo —y comprando— lo de un vendedor suspendido. Por eso estos
/// tests comprueban que la app **pregunta** y no deduce.
///
/// ⚠️ Ninguno de estos tests sale a la red: `LiveApi` está doblado.
void main() {
  /**
   * Una pantalla grande, no la de un teléfono.
   *
   * En los tests cada letra se dibuja como un cuadrado del alto de la
   * tipografía. Lo que se prueba acá es el comportamiento —qué se pide, a dónde
   * se va— no el diseño.
   */
  const tamanoDePrueba = Size(1000, 1800);

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

  Widget montar(Widget pantalla, _ApiFalsa api) {
    return ProviderScope(
      overrides: [liveApiProvider.overrideWithValue(api)],
      child: MaterialApp(home: pantalla),
    );
  }

  group('El enlace lleva a la pantalla de tienda', () {
    /**
     * ⛔ ANTES DEVOLVÍA `null` Y EL ENLACE NO HACÍA NADA.
     *
     * `/t/<slug>` se resolvía bien —el resolutor sabía que era una tienda— y
     * después no había pantalla a la que llevar: el enlace abría la app y ahí
     * quedaba.
     */
    test('⛔ /t/<slug> ahora abre la tienda', () {
      final destino = resolverEnlace(Uri.parse('https://vendox.com.ar/t/lanas-del-sur'));

      expect(destino, const DestinoEnApp(TipoDeDestino.tienda, 'lanas-del-sur'));
      expect(pantallaDeDestino(destino! as DestinoEnApp), isA<TiendaScreen>());
    });

    /// Y lleva el slug del enlace, no otro.
    test('⛔ la pantalla recibe el slug que venía en el enlace', () {
      final destino =
          resolverEnlace(Uri.parse('https://vendox.com.ar/t/aroma-deco'))! as DestinoEnApp;

      final pantalla = pantallaDeDestino(destino)! as TiendaScreen;

      expect(pantalla.slug, 'aroma-deco');
      expect(pantalla.storeId, isNull, reason: 'el id lo resuelve el backend');
    });

    /**
     * ⛔ CON LA APP CERRADA, EL DESTINO ESPERA.
     *
     * Un enlace tocado desde WhatsApp con la app cerrada llega antes de que
     * exista el Navigator. Si se descartara ahí, el enlace abriría la app en el
     * feed y la tienda no se vería nunca.
     */
    testWidgets('⛔ en frío, el enlace queda esperando y después navega', (tester) async {
      final nav = NavegadorDeEnlaces.instance..reiniciar();

      // Todavía no hay Navigator: la app está arrancando.
      nav.manejar(const DestinoEnApp(TipoDeDestino.tienda, 'lanas-del-sur'));

      expect(
        nav.pendiente,
        const DestinoEnApp(TipoDeDestino.tienda, 'lanas-del-sur'),
        reason: 'el enlace se perdió mientras la app arrancaba',
      );
    });
  });

  group('Con la app abierta', () {
    /**
     * ⛔ SE PREGUNTA POR EL SLUG, Y EL CATÁLOGO SE PIDE CON EL ID QUE VOLVIÓ.
     *
     * Es el recorrido entero en dos pedidos. Si la app dedujera el id del slug,
     * el segundo pedido iría a una tienda que no existe.
     */
    testWidgets('⛔ resuelve el slug y abre el catálogo de esa tienda', (tester) async {
      final api = _ApiFalsa();
      await tester.pumpWidget(montar(const TiendaScreen.porSlug('lanas-del-sur'), api));
      await tester.pumpAndSettle();

      expect(api.slugsPedidos, ['lanas-del-sur']);
      expect(api.tiendasPedidas, ['sto_resuelta']);
      expect(find.text('Lanas del Sur'), findsOneWidget);
      expect(find.text('Vela lavanda'), findsOneWidget);
    });

    /// Mientras resuelve, se ve que algo está pasando.
    testWidgets('mientras resuelve muestra que está cargando', (tester) async {
      final api = _ApiFalsa()..demorar = Completer<TiendaPublica>();
      // El Completer queda pendiente a propósito. Se cierra al final para que
      // el test no termine con trabajo colgado.
      addTearDown(() => api.demorar?.complete(_tiendaResuelta()));

      await tester.pumpWidget(montar(const TiendaScreen.porSlug('lanas-del-sur'), api));
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Vela lavanda'), findsNothing);
    });

    /**
     * ⛔ UN SLUG QUE NO EXISTE NO SE VE ROTO.
     *
     * Pasa con un enlace viejo, uno mal copiado, o una tienda que dejó de
     * mostrarse. Y NO se ofrece reintentar: el enlace no se arregla tocando un
     * botón, y ponerlo sería hacer tocar algo que nunca va a funcionar.
     */
    testWidgets('⛔ un slug inexistente muestra un aviso claro, sin reintentar',
        (tester) async {
      final api = _ApiFalsa()..noExiste = true;
      await tester.pumpWidget(montar(const TiendaScreen.porSlug('no-existe'), api));
      await tester.pumpAndSettle();

      expect(find.text('No encontramos esta tienda'), findsOneWidget);
      expect(find.text('Reintentar'), findsNothing);
      expect(find.textContaining('Exception'), findsNothing);
      expect(api.tiendasPedidas, isEmpty, reason: 'no se pidió el catálogo de nada');
    });

    /**
     * ⛔ Y UN FALLO DE RED SÍ SE REINTENTA.
     *
     * Es la otra mitad: son dos pantallas distintas a propósito. Confundirlas
     * deja a alguien tocando «reintentar» sobre un enlace roto, o sin forma de
     * reintentar cuando lo único que pasó fue que se cortó la señal.
     */
    testWidgets('⛔ un fallo de red sí ofrece reintentar', (tester) async {
      final api = _ApiFalsa()..falla = true;
      await tester.pumpWidget(montar(const TiendaScreen.porSlug('lanas-del-sur'), api));
      await tester.pumpAndSettle();

      expect(find.text('No pudimos abrir la tienda'), findsOneWidget);
      expect(find.text('Reintentar'), findsOneWidget);
      expect(find.textContaining('Exception'), findsNothing);

      api.falla = false;
      await tester.tap(find.text('Reintentar'));
      await tester.pumpAndSettle();

      expect(find.text('Vela lavanda'), findsOneWidget);
    });
  });

  group('El vendedor, en vivo y offline', () {
    /// Llegando por enlace mientras transmite, la tienda lo dice.
    testWidgets('con el vendedor al aire, se ve «EN VIVO»', (tester) async {
      final api = _ApiFalsa()..vivoEnCurso = 'liv_1';
      await tester.pumpWidget(montar(const TiendaScreen.porSlug('lanas-del-sur'), api));
      await tester.pumpAndSettle();

      expect(find.text('EN VIVO'), findsOneWidget);
    });

    /**
     * ⛔ Y OFFLINE NO SE INVENTA UNA TRANSMISIÓN.
     *
     * Es el caso normal: la mayoría de las veces que alguien abre un enlace de
     * tienda, el vendedor no está transmitiendo.
     */
    testWidgets('⛔ con el vendedor offline, no dice «EN VIVO»', (tester) async {
      final api = _ApiFalsa();
      await tester.pumpWidget(montar(const TiendaScreen.porSlug('lanas-del-sur'), api));
      await tester.pumpAndSettle();

      expect(find.text('EN VIVO'), findsNothing);
    });

  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * VOLVER AL VIVO Y ABRIRLO NO SON LO MISMO
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * El botón «EN VIVO» se ve igual en los dos casos y hace cosas distintas. Se
   * prueba sobre la función pura y no montando pantallas porque abrir el visor
   * de verdad necesita LiveKit: montarlo probaría el visor, no esta decisión.
   */
  group('Qué hace «EN VIVO» según de dónde se llegó', () {
    /**
     * ⛔ VINIENDO DEL VIVO SE VUELVE, NO SE ABRE OTRO.
     *
     * El visor está abajo en la pila, montado y conectado. Un `push` dejaría
     * DOS visores del mismo vivo, con dos conexiones de LiveKit y dos chats —
     * el tipo de error que no se ve en pantalla y se paga en datos y batería.
     */
    test('⛔ desde el vivo, se vuelve atrás', () {
      expect(
        comoLlegarAlVivo(liveDetras: 'liv_1', liveDelVendedor: 'liv_1'),
        ComoLlegarAlVivo.volverAtras,
      );
    });

    /**
     * ⛔ Y DESDE UN ENLACE SE ABRE, PORQUE NO HAY NADA ABAJO.
     *
     * Un `pop` acá cerraría la tienda y dejaría a la persona donde estaba
     * antes, que no es a donde pidió ir.
     */
    test('⛔ desde un enlace, se abre el visor', () {
      expect(
        comoLlegarAlVivo(liveDelVendedor: 'liv_1'),
        ComoLlegarAlVivo.abrirElVisor,
      );
    });

    /// Sin vivo al aire, el botón ni se dibuja.
    test('sin vivo, no se hace nada', () {
      expect(comoLlegarAlVivo(), ComoLlegarAlVivo.nada);
    });

    /**
     * ⛔ Y EL VIVO DE ABAJO GANA, AUNQUE EL BACKEND INFORME OTRO.
     *
     * Pasa si el vendedor termina una transmisión y empieza otra mientras la
     * tienda está abierta. Volver al que está abajo es lo correcto: es el que
     * la persona estaba mirando, y el que sigue conectado.
     */
    test('⛔ con los dos, manda el que está abajo en la pila', () {
      expect(
        comoLlegarAlVivo(liveDetras: 'liv_viejo', liveDelVendedor: 'liv_nuevo'),
        ComoLlegarAlVivo.volverAtras,
      );
    });
  });

  group('Volver atrás', () {
    /**
     * ⛔ SE VUELVE A LO QUE HABÍA ANTES, SIN REABRIR NADA.
     *
     * Con la app ya abierta, el enlace apila la tienda sobre lo que se estaba
     * mirando. El botón de atrás tiene que devolver ahí.
     */
    testWidgets('⛔ el botón de atrás devuelve a la pantalla anterior', (tester) async {
      final api = _ApiFalsa();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [liveApiProvider.overrideWithValue(api)],
          child: MaterialApp(
            home: Builder(
              builder: (context) => Scaffold(
                body: Center(
                  child: ElevatedButton(
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const TiendaScreen.porSlug('lanas-del-sur'),
                      ),
                    ),
                    child: const Text('lo que estaba mirando'),
                  ),
                ),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('lo que estaba mirando'));
      await tester.pumpAndSettle();
      expect(find.text('Vela lavanda'), findsOneWidget);

      await tester.pageBack();
      await tester.pumpAndSettle();

      expect(find.text('lo que estaba mirando'), findsOneWidget);
      expect(find.text('Vela lavanda'), findsNothing);
      expect(api.slugsPedidos, hasLength(1), reason: 'volver no re-resolvió el slug');
    });
  });
}

TiendaPublica _tiendaResuelta({String? liveEnCursoId}) => TiendaPublica(
  id: 'sto_resuelta',
  nombre: 'Lanas del Sur',
  slug: 'lanas-del-sur',
  sellerId: 'sel_1',
  liveEnCursoId: liveEnCursoId,
);

class _ApiFalsa extends LiveApi {
  _ApiFalsa() : super(ApiClient(tokens: TokenStore()));

  /// Qué slugs se mandaron a resolver, en orden.
  final List<String> slugsPedidos = [];

  /// A qué tiendas se les pidió el catálogo, en orden.
  final List<String> tiendasPedidas = [];

  bool noExiste = false;
  bool falla = false;
  /// Cuando está, la resolución espera a que el test lo complete.
  Completer<TiendaPublica>? demorar;
  String? vivoEnCurso;

  @override
  Future<TiendaPublica> tiendaPorSlug(String slug) async {
    slugsPedidos.add(slug);
    final espera = demorar;
    if (espera != null) return espera.future;
    if (noExiste) throw const TiendaNoEncontrada();
    if (falla) throw StateError('sin red');

    return _tiendaResuelta(liveEnCursoId: vivoEnCurso);
  }

  @override
  Future<PaginaDeCatalogo> catalogo(String storeId, {String? cursor, String? q}) async {
    tiendasPedidas.add(storeId);
    return const PaginaDeCatalogo(
      items: [
        ItemDeCatalogo(
          id: 'prd_x',
          nombre: 'Vela lavanda',
          precioCentavos: 990000,
          disponible: 4,
          variantes: 2,
        ),
      ],
    );
  }
}
