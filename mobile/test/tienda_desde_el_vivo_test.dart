import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vendox/core/auth/token_store.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/network/api_client.dart';
import 'package:vendox/features/lives/data/live_api.dart';
import 'package:vendox/features/lives/domain/live_models.dart';
import 'package:vendox/features/lives/presentation/tienda_screen.dart';

/// La tienda del vendedor, abierta desde el vivo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE ESTOS TESTS PROTEGEN
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Que abrir la tienda **no saque a nadie del vivo**. La tienda pasó de ser una
/// hoja a ser una pantalla completa, y la razón por la que antes era una hoja
/// estaba escrita así: «con un `Navigator.push` el vivo se desmontaría».
///
/// Se midió con el centinela de abajo —un widget que cuenta sus propios
/// `initState` y `dispose`— y es falso: un `push` da `montajes=1,
/// desmontajes=0`. Flutter deja de PINTAR las rutas de abajo, no las destruye.
///
/// Ese centinela es también la forma de comprobarlo sin LiveKit: si los números
/// no se movieron, el vivo nunca se desmontó — y con LiveKit eso significa que
/// la conexión no se cortó y que el chat no perdió mensajes.
void main() {
  /**
   * Una pantalla grande, no la de un teléfono.
   *
   * En los tests cada letra se dibuja como un cuadrado del alto de la
   * tipografía, así que el nombre de la tienda y el buscador ocupan mucho más
   * que en un teléfono real. Lo que se prueba acá es el comportamiento —qué se
   * monta, qué se desmonta— no el diseño.
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

  setUp(() {
    _Centinela.reiniciar();
    _ApiFalsa.ultimoProductoPedido = null;
  });

  /// El vivo, con un botón que abre la tienda como lo hace la pantalla real.
  Widget montarVivo(_ApiFalsa api, {String? liveEnCurso}) {
    return ProviderScope(
      overrides: [liveApiProvider.overrideWithValue(api)],
      child: MaterialApp(
        home: Scaffold(
          body: Stack(
            children: [
              const _Centinela(),
              Center(
                child: Builder(
                  builder: (context) => ElevatedButton(
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => TiendaScreen(
                          storeId: 'sto_x',
                          nombreTienda: 'Aroma Deco',
                          liveDetras: liveEnCurso,
                        ),
                      ),
                    ),
                    child: const Text('Tienda'),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  group('El vivo sobrevive a abrir la tienda', () {
    /**
     * ⛔ EL TEST QUE JUSTIFICA EL CAMBIO DE HOJA A PANTALLA.
     *
     * Si esto fallara, abrir la tienda cortaría LiveKit: al volver habría que
     * reconectar, esperar el primer cuadro otra vez y perder los mensajes de
     * ese rato.
     */
    testWidgets('⛔ abrir la tienda no desmonta el vivo', (tester) async {
      await tester.pumpWidget(montarVivo(_ApiFalsa(_conUnProducto)));

      expect(_Centinela.montajes, 1);

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();

      expect(find.text('Vela lavanda'), findsOneWidget);
      expect(_Centinela.desmontajes, 0, reason: 'El vivo se desmontó al abrir la tienda');
      expect(_Centinela.montajes, 1, reason: 'El vivo se volvió a montar');
    });

    /// ⛔ Y volver devuelve al vivo, sin reconstruirlo.
    testWidgets('⛔ volver atrás devuelve al vivo donde estaba', (tester) async {
      await tester.pumpWidget(montarVivo(_ApiFalsa(_conUnProducto)));

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();
      await tester.pageBack();
      await tester.pumpAndSettle();

      expect(find.text('Vela lavanda'), findsNothing);
      expect(find.text('Tienda'), findsOneWidget, reason: 'No volvimos al vivo');
      expect(_Centinela.montajes, 1, reason: 'El vivo se reconstruyó al volver');
      expect(_Centinela.desmontajes, 0);
    });
  });

  group('Qué muestra la tienda', () {
    testWidgets('el nombre del vendedor y sus productos', (tester) async {
      await tester.pumpWidget(montarVivo(_ApiFalsa(_conUnProducto)));

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();

      expect(find.text('Aroma Deco'), findsOneWidget);
      expect(find.text('Vela lavanda'), findsOneWidget);
    });

    /// ⛔ Y pide el catálogo de ESA tienda, no de otra.
    testWidgets('⛔ pide el catálogo de la tienda del vivo', (tester) async {
      final api = _ApiFalsa(_conUnProducto);
      await tester.pumpWidget(montarVivo(api));

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();

      expect(api.tiendasPedidas, ['sto_x']);
    });

    /**
     * ⛔ SIN PRODUCTOS, UN ESTADO VACÍO AMIGABLE.
     *
     * Una tienda recién abierta no tiene nada publicado, y eso es normal, no un
     * error. Lo que no puede pasar es una pantalla en blanco ni un mensaje
     * técnico.
     */
    testWidgets('⛔ una tienda sin productos no se ve rota', (tester) async {
      await tester.pumpWidget(montarVivo(_ApiFalsa(const PaginaDeCatalogo(items: []))));

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();

      expect(find.text('La tienda todavía no tiene productos'), findsOneWidget);
      expect(find.textContaining('Exception'), findsNothing);
    });

    /**
     * ⛔ Y SI FALLA LA RED, TAMPOCO SE VE UN ERROR TÉCNICO.
     *
     * «No pudimos abrir la tienda» y un botón para reintentar. Nunca el texto
     * de la excepción.
     */
    testWidgets('⛔ un fallo de red muestra algo entendible y deja reintentar', (tester) async {
      await tester.pumpWidget(montarVivo(_ApiFalsa.queFalla()));

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();

      expect(find.text('No pudimos abrir la tienda'), findsOneWidget);
      expect(find.text('Reintentar'), findsOneWidget);
      expect(find.textContaining('Exception'), findsNothing);
    });
  });

  group('El aviso de que está transmitiendo', () {
    /// Viniendo de un vivo al aire, la tienda lo dice y ofrece volver.
    testWidgets('con el vendedor al aire, se ve «EN VIVO»', (tester) async {
      await tester.pumpWidget(montarVivo(_ApiFalsa(_conUnProducto), liveEnCurso: 'liv_1'));

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();

      expect(find.text('EN VIVO'), findsOneWidget);
    });

    /**
     * ⛔ Y SIN VIVO, NO SE INVENTA UNO.
     *
     * Mostrar «EN VIVO» sobre un vendedor que no está transmitiendo es
     * exactamente la clase de dato inventado que no puede aparecer nunca: la
     * persona toca esperando una transmisión y no hay ninguna.
     */
    testWidgets('⛔ sin vivo en curso, no dice «EN VIVO»', (tester) async {
      await tester.pumpWidget(montarVivo(_ApiFalsa(_conUnProducto)));

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();

      expect(find.text('EN VIVO'), findsNothing);
    });

    /**
     * ⛔ Y VOLVER AL VIVO ES `pop`, NO UN `push` NUEVO.
     *
     * El vivo está abajo en la pila. Abrirlo otra vez con un push dejaría DOS
     * visores del mismo vivo montados, con dos conexiones de LiveKit y dos
     * chats — y el centinela contaría un montaje más.
     */
    testWidgets('⛔ tocar «EN VIVO» vuelve al vivo que ya estaba', (tester) async {
      await tester.pumpWidget(montarVivo(_ApiFalsa(_conUnProducto), liveEnCurso: 'liv_1'));

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('EN VIVO'));
      await tester.pumpAndSettle();

      expect(find.text('Tienda'), findsOneWidget, reason: 'No volvimos al vivo');
      expect(_Centinela.montajes, 1, reason: 'Se abrió un segundo visor del mismo vivo');
      expect(_Centinela.desmontajes, 0);
    });
  });

  group('Elegir un producto', () {
    /**
     * ⛔ Y ELEGIR NO SACA DEL VIVO TAMPOCO.
     *
     * El selector de variantes es una hoja sobre la tienda, que a su vez está
     * sobre el vivo. Los tres niveles conviven: el video sigue corriendo abajo
     * mientras alguien elige un talle.
     */
    testWidgets('⛔ tocar un producto abre el selector, con el vivo intacto', (tester) async {
      await tester.pumpWidget(montarVivo(_ApiFalsa(_conUnProducto)));

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Vela lavanda'));
      await tester.pumpAndSettle();

      // El selector pidió el detalle del producto que se tocó.
      expect(_ApiFalsa.ultimoProductoPedido, 'prd_x');
      expect(_Centinela.desmontajes, 0);
    });

    /**
     * ⛔ UN AGOTADO SE VE PERO NO SE PUEDE ELEGIR.
     *
     * Se muestra igual —el catálogo es la tienda, no sólo lo que hay hoy— y
     * tocarlo no hace nada. Abrir el selector de algo sin stock termina en un
     * «no hay» después de dos toques.
     */
    testWidgets('⛔ un producto agotado no abre nada', (tester) async {
      await tester.pumpWidget(
        montarVivo(
          _ApiFalsa(
            const PaginaDeCatalogo(
              items: [
                ItemDeCatalogo(
                  id: 'prd_agotado',
                  nombre: 'Vela agotada',
                  precioCentavos: 990000,
                  disponible: 0,
                  variantes: 1,
                ),
              ],
            ),
          ),
        ),
      );

      await tester.tap(find.text('Tienda'));
      await tester.pumpAndSettle();

      expect(find.text('AGOTADO'), findsOneWidget);

      await tester.tap(find.text('Vela agotada'));
      await tester.pumpAndSettle();

      expect(_ApiFalsa.ultimoProductoPedido, isNull);
      expect(find.text('Vela agotada'), findsOneWidget, reason: 'La tienda se cerró sola');
    });
  });
}

const _conUnProducto = PaginaDeCatalogo(
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

/// El vivo, representado por algo que sabe si lo montaron y lo desmontaron.
class _Centinela extends StatefulWidget {
  const _Centinela();

  static int montajes = 0;
  static int desmontajes = 0;

  static void reiniciar() {
    montajes = 0;
    desmontajes = 0;
  }

  @override
  State<_Centinela> createState() => _CentinelaState();
}

class _CentinelaState extends State<_Centinela> {
  @override
  void initState() {
    super.initState();
    _Centinela.montajes += 1;
  }

  @override
  void dispose() {
    _Centinela.desmontajes += 1;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => const ColoredBox(color: Colors.black);
}

class _ApiFalsa extends LiveApi {
  _ApiFalsa(this._catalogo) : super(ApiClient(tokens: TokenStore()));
  _ApiFalsa.queFalla()
      : _catalogo = null,
        super(ApiClient(tokens: TokenStore()));

  final PaginaDeCatalogo? _catalogo;

  /// A qué tiendas se les pidió el catálogo, en orden.
  final List<String> tiendasPedidas = [];

  /// El último producto cuyo detalle se pidió, o `null` si no se pidió ninguno.
  ///
  /// Es estático porque lo mira el test después de que el selector de
  /// variantes ya lo consumió, y `setUp` lo limpia.
  static String? ultimoProductoPedido;

  @override
  Future<DetalleDeProducto> producto(String productId) async {
    ultimoProductoPedido = productId;
    return DetalleDeProducto.fromJson(const {
      'id': 'prd_x',
      'nombre': 'Vela lavanda',
      'precioCentavos': 990000,
      'opciones': <dynamic>[],
      'variantes': <dynamic>[],
    });
  }

  @override
  Future<EstadoDeTienda> estadoDeTienda(String storeId) async =>
      const EstadoDeTienda(abierta: true, motivo: '');

  @override
  Future<PaginaDeCatalogo> catalogo(String storeId, {String? cursor, String? q}) async {
    tiendasPedidas.add(storeId);
    final pagina = _catalogo;
    if (pagina == null) throw Exception('sin red');
    return pagina;
  }
}
