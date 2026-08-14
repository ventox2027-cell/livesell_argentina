import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vendox/core/auth/token_store.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/network/api_client.dart';
import 'package:vendox/features/lives/data/live_api.dart';
import 'package:vendox/features/lives/domain/live_models.dart';
import 'package:vendox/features/lives/presentation/shop_sheet.dart';
import 'package:vendox/features/lives/presentation/variant_sheet.dart';

/// El recorrido de compra desde un vivo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE ESTOS TESTS PROTEGEN
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Que comprar **no saque a nadie del vivo**. La tienda y el selector de
/// variantes son hojas encima de la pantalla, no rutas nuevas: mientras estén
/// abiertas, el video de abajo tiene que seguir montado y corriendo.
///
/// La forma de comprobarlo sin LiveKit es un widget centinela que cuenta sus
/// propios `initState` y `dispose`. Si al abrir y cerrar la tienda esos números
/// no se movieron, el vivo nunca se desmontó — y con LiveKit eso significa que
/// la conexión no se cortó.
void main() {
  /**
   * Una pantalla de teléfono, no la de 800×600 del test.
   *
   * No es cosmético. Con 800 de ancho, las dos columnas del catálogo miden 384
   * cada una y —con la proporción vertical de la tarjeta— quedan de casi 600 px
   * de alto: el nombre del producto cae fuera de la pantalla y el test falla por
   * un tamaño que ningún teléfono tiene.
   *
   * 390×844 es un iPhone 14 / Pixel 7. Probar contra la geometría real es todo
   * el punto de estos tests.
   */
  const tamanoDeTelefono = Size(390, 844);

  setUp(() async {
    // `ApiClient` lee la URL base al construirse.
    SharedPreferences.setMockInitialValues({});
    await RuntimeConfig.load();
  });

  setUpAll(() {
    final vista = TestWidgetsFlutterBinding.ensureInitialized().platformDispatcher.views.first;
    vista.physicalSize = tamanoDeTelefono;
    vista.devicePixelRatio = 1;
    addTearDown(vista.resetPhysicalSize);
    addTearDown(vista.resetDevicePixelRatio);
  });

  Widget montar(Widget hijo, {LiveApi? api}) {
    return ProviderScope(
      overrides: [if (api != null) liveApiProvider.overrideWithValue(api)],
      child: MaterialApp(home: hijo),
    );
  }

  group('La tienda se abre encima del vivo', () {
    testWidgets('abrir y cerrar no desmonta lo que hay debajo', (tester) async {
      _Centinela.reiniciar();

      await tester.pumpWidget(
        montar(
          const _Anfitrion(),
          api: _ApiFalsa(
            catalogo: const PaginaDeCatalogo(
              items: [
                ItemDeCatalogo(
                  id: 'prd_x',
                  nombre: 'Vela lavanda',
                  precioCentavos: 990000,
                  disponible: 4,
                  variantes: 2,
                ),
              ],
            ),
          ),
        ),
      );

      expect(_Centinela.montajes, 1);
      expect(_Centinela.desmontajes, 0);

      await tester.tap(find.text('Abrir tienda'));
      await tester.pumpAndSettle();

      expect(find.text('Vela lavanda'), findsOneWidget);

      // ⚠️ Lo que importa: el vivo sigue vivo con la tienda abierta.
      expect(_Centinela.montajes, 1, reason: 'El vivo se volvió a montar');
      expect(_Centinela.desmontajes, 0, reason: 'El vivo se desmontó al abrir la tienda');

      await tester.tap(find.byIcon(Icons.close_rounded));
      await tester.pumpAndSettle();

      expect(find.text('Vela lavanda'), findsNothing);
      expect(_Centinela.montajes, 1, reason: 'El vivo se reconstruyó al cerrar la tienda');
      expect(_Centinela.desmontajes, 0);
    });

    testWidgets('elegir un producto devuelve su id', (tester) async {
      _Centinela.reiniciar();

      await tester.pumpWidget(
        montar(
          const _Anfitrion(),
          api: _ApiFalsa(
            catalogo: const PaginaDeCatalogo(
              items: [
                ItemDeCatalogo(
                  id: 'prd_elegido',
                  nombre: 'Vela lavanda',
                  precioCentavos: 990000,
                  disponible: 4,
                  variantes: 2,
                ),
              ],
            ),
          ),
        ),
      );

      await tester.tap(find.text('Abrir tienda'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Vela lavanda'));
      await tester.pumpAndSettle();

      expect(find.text('elegido: prd_elegido'), findsOneWidget);
      expect(_Centinela.desmontajes, 0);
    });

    testWidgets('un producto agotado no se puede elegir', (tester) async {
      _Centinela.reiniciar();

      await tester.pumpWidget(
        montar(
          const _Anfitrion(),
          api: _ApiFalsa(
            catalogo: const PaginaDeCatalogo(
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

      await tester.tap(find.text('Abrir tienda'));
      await tester.pumpAndSettle();

      // Se sigue viendo —el catálogo es la tienda, no sólo lo que hay hoy—
      // pero tocarlo no hace nada.
      expect(find.text('AGOTADO'), findsOneWidget);

      await tester.tap(find.text('Vela agotada'));
      await tester.pumpAndSettle();

      expect(find.text('Vela agotada'), findsOneWidget, reason: 'La hoja se cerró');
      expect(find.textContaining('elegido:'), findsNothing);
    });
  });

  group('El selector de variantes', () {
    final producto = DetalleDeProducto.fromJson({
      'id': 'prd_x',
      'name': 'Remera lisa',
      'basePriceCents': 1500000,
      'images': <dynamic>[],
      'options': [
        {
          'id': 'opt_talle',
          'name': 'Talle',
          'values': [
            {'id': 'ov_s', 'value': 'S'},
            {'id': 'ov_m', 'value': 'M'},
          ],
        },
      ],
      'variants': [
        {
          'id': 'var_s',
          'title': 'S',
          'inventory': {'onHand': 4, 'reserved': 0},
          'options': [
            {'optionValueId': 'ov_s'},
          ],
        },
        {
          'id': 'var_m',
          'title': 'M',
          'inventory': {'onHand': 2, 'reserved': 2},
          'options': [
            {'optionValueId': 'ov_m'},
          ],
        },
      ],
    });

    testWidgets('hasta elegir, el botón no deja avanzar', (tester) async {
      await tester.pumpWidget(
        montar(
          const _AnfitrionDeVariantes(),
          api: _ApiFalsa(producto: producto),
        ),
      );

      await tester.tap(find.text('Comprar destacado'));
      await tester.pumpAndSettle();

      expect(find.text('Elegí una opción'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.ancestor(
          of: find.text('Elegí una opción'),
          matching: find.byType(FilledButton),
        )).onPressed,
        isNull,
      );
    });

    testWidgets('el talle agotado se muestra tachado y no responde', (tester) async {
      await tester.pumpWidget(
        montar(
          const _AnfitrionDeVariantes(),
          api: _ApiFalsa(producto: producto),
        ),
      );

      await tester.tap(find.text('Comprar destacado'));
      await tester.pumpAndSettle();

      // No se oculta: ver el talle tachado explica que existe y se agotó.
      expect(find.text('M'), findsOneWidget);

      final estiloM = tester.widget<Text>(find.text('M')).style!;
      expect(estiloM.decoration, TextDecoration.lineThrough);

      final estiloS = tester.widget<Text>(find.text('S')).style!;
      expect(estiloS.decoration, isNot(TextDecoration.lineThrough));

      // Tocar M no lo selecciona: el botón sigue pidiendo elegir.
      await tester.tap(find.text('M'));
      await tester.pumpAndSettle();
      expect(find.text('Elegí una opción'), findsOneWidget);
    });

    testWidgets('elegir un talle con stock habilita comprar', (tester) async {
      await tester.pumpWidget(
        montar(
          const _AnfitrionDeVariantes(),
          api: _ApiFalsa(producto: producto),
        ),
      );

      await tester.tap(find.text('Comprar destacado'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('S'));
      await tester.pumpAndSettle();

      expect(find.text('Comprar'), findsOneWidget);
      expect(find.text('Cantidad'), findsOneWidget);
    });

    testWidgets('con la tienda cerrada ofrece aviso, NO reserva', (tester) async {
      await tester.pumpWidget(
        montar(
          const _AnfitrionDeVariantes(),
          api: _ApiFalsa(
            producto: producto,
            estado: const EstadoDeTienda(
              abierta: false,
              motivo: 'Abre el lunes a las 09:00',
            ),
          ),
        ),
      );

      await tester.tap(find.text('Comprar destacado'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('S'));
      await tester.pumpAndSettle();

      /**
       * ⚠️ La regla comercial más importante de esta hoja.
       *
       * Con la tienda cerrada NO se aparta stock: se deja una intención. Una
       * reserva real por una tienda cerrada bloquearía una unidad cinco minutos
       * para alguien que no puede pagar, y se la sacaría a quien sí puede.
       */
      expect(find.text('Avisame cuando abra'), findsOneWidget);
      expect(find.text('Comprar'), findsNothing);
      expect(find.textContaining('No se aparta stock'), findsOneWidget);
      expect(find.text('Abre el lunes a las 09:00'), findsOneWidget);
    });

    testWidgets('si falla la consulta de horario, igual se puede comprar', (tester) async {
      await tester.pumpWidget(
        montar(
          const _AnfitrionDeVariantes(),
          // El horario revienta; el producto llega bien.
          api: _ApiFalsa(producto: producto, estadoFalla: true),
        ),
      );

      await tester.tap(find.text('Comprar destacado'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('S'));
      await tester.pumpAndSettle();

      // Una consulta secundaria caída no puede frenar una venta que el backend
      // habría aceptado. Y si de verdad está cerrada, el backend rechaza.
      expect(find.text('Comprar'), findsOneWidget);
    });
  });
}

// ─── Andamiaje ───────────────────────────────────────────────────────────────

/// Hace de vivo: cuenta sus montajes y desmontajes.
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
    _Centinela.montajes++;
  }

  @override
  void dispose() {
    _Centinela.desmontajes++;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => const SizedBox.expand();
}

/// Una pantalla mínima con el centinela y el botón de la tienda.
class _Anfitrion extends StatefulWidget {
  const _Anfitrion();

  @override
  State<_Anfitrion> createState() => _AnfitrionState();
}

class _AnfitrionState extends State<_Anfitrion> {
  String? _elegido;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          const _Centinela(),
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_elegido != null) Text('elegido: $_elegido'),
                ElevatedButton(
                  onPressed: () async {
                    final id = await ShopSheet.mostrar(
                      context,
                      storeId: 'sto_x',
                      nombreTienda: 'Aroma Deco',
                    );
                    if (mounted) setState(() => _elegido = id);
                  },
                  child: const Text('Abrir tienda'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AnfitrionDeVariantes extends StatelessWidget {
  const _AnfitrionDeVariantes();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ElevatedButton(
          onPressed: () => VariantSheet.mostrar(context, productId: 'prd_x', storeId: 'sto_x'),
          child: const Text('Comprar destacado'),
        ),
      ),
    );
  }
}

/// Un `LiveApi` que no toca la red.
///
/// Hereda del real en vez de esconderlo detrás de una interfaz: así, el día que
/// `LiveApi` gane un método, este archivo sigue compilando y el test que lo
/// necesite falla con un error claro en vez de con un `null`.
class _ApiFalsa extends LiveApi {
  _ApiFalsa({
    PaginaDeCatalogo? catalogo,
    DetalleDeProducto? producto,
    EstadoDeTienda? estado,
    this.estadoFalla = false,
  })  : _catalogo = catalogo,
        _producto = producto,
        _estado = estado,
        super(ApiClient(tokens: TokenStore()));

  final PaginaDeCatalogo? _catalogo;
  final DetalleDeProducto? _producto;
  final EstadoDeTienda? _estado;
  final bool estadoFalla;

  @override
  Future<PaginaDeCatalogo> catalogo(String storeId, {String? cursor, String? q}) async =>
      _catalogo ?? const PaginaDeCatalogo(items: []);

  @override
  Future<DetalleDeProducto> producto(String productId) async =>
      _producto ?? (throw StateError('el test no cargó un producto'));

  @override
  Future<EstadoDeTienda> estadoDeTienda(String storeId) async {
    if (estadoFalla) throw StateError('horario caído');
    return _estado ?? const EstadoDeTienda(abierta: true, motivo: '');
  }
}
