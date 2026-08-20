import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vendox/core/auth/token_store.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/network/api_client.dart';
import 'package:vendox/features/lives/data/live_api.dart';
import 'package:vendox/features/lives/domain/live_models.dart';
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

  /**
   * La tienda vive ahora en `tienda_desde_el_vivo_test.dart`.
   *
   * Dejo de ser una hoja para ser una pantalla completa —ver `TiendaScreen`— y
   * el centinela de aquel archivo cubre lo mismo que cubria este grupo, mas el
   * aviso de EN VIVO y la vuelta al vivo.
   */

  group('El selector de variantes', () {
    // La forma que arma `detalleParaComprar` en `stores.service.ts`, que es la
    // que devuelve `GET /catalog/products/:id`.
    final producto = DetalleDeProducto.fromJson({
      'id': 'prd_x',
      'nombre': 'Remera lisa',
      'precioCentavos': 1500000,
      'moneda': 'ARS',
      'imagenes': <dynamic>[],
      'ejes': [
        {
          'id': 'opt_talle',
          'nombre': 'Talle',
          'valores': [
            {'id': 'ov_s', 'valor': 'S'},
            {'id': 'ov_m', 'valor': 'M'},
          ],
        },
      ],
      'variantes': [
        {
          'id': 'var_s',
          'titulo': 'S',
          'precioCentavos': 1500000,
          'disponible': 4,
          'valoresDeOpcion': ['ov_s'],
        },
        {
          'id': 'var_m',
          'titulo': 'M',
          'precioCentavos': 1500000,
          // Agotada a propósito: es la que tiene que verse tachada.
          'disponible': 0,
          'valoresDeOpcion': ['ov_m'],
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
