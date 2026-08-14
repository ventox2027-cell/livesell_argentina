import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/feed/data/feed_repository.dart';
import 'package:vendox/features/feed/domain/feed_models.dart';
import 'package:vendox/features/search/presentation/search_screen.dart';

/// La pantalla de búsqueda.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE SE PRUEBA ES QUE NO PIDA UNA VEZ POR TECLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Escribir "zapatillas" son diez teclas. Diez peticiones para mostrar el
/// resultado de una es desperdicio, pero lo grave es otra cosa: llegan
/// desordenadas, y la pantalla puede terminar mostrando el resultado de "zapa"
/// después del de "zapatillas".
///
/// Se cuentan las consultas que llegan al repositorio, que es lo único que
/// verifica de verdad que el retardo funciona.
void main() {
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    final vista = TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    vista.physicalSize = const Size(390, 844);
    vista.devicePixelRatio = 1;
  });

  late List<String> consultas;

  ProviderContainer contenedor({List<PublicacionFeed> resultados = const []}) {
    consultas = [];
    return ProviderContainer(
      overrides: [
        feedRepositoryProvider.overrideWith(
          (ref) => _RepoFalso(ref, consultas, resultados),
        ),
      ],
    );
  }

  Widget app(ProviderContainer c) => UncontrolledProviderScope(
        container: c,
        child: const MaterialApp(home: SearchScreen()),
      );

  testWidgets('sin escribir no pide nada', (tester) async {
    await tester.pumpWidget(app(contenedor()));

    expect(find.text('Buscá lo que necesitás'), findsOneWidget);
    expect(consultas, isEmpty);
  });

  testWidgets('⛔ una letra no dispara una búsqueda', (tester) async {
    // Devolvería medio catálogo y no ayuda a nadie.
    await tester.pumpWidget(app(contenedor()));

    await tester.enterText(find.byType(TextField), 'z');
    await tester.pump(const Duration(milliseconds: 600));

    expect(consultas, isEmpty);
  });

  testWidgets('⛔ escribir diez letras hace UNA sola petición', (tester) async {
    /**
     * El test central. Si esto falla, cada tecla es un viaje a la base y las
     * respuestas pueden llegar desordenadas: la pantalla terminaría mostrando
     * el resultado de "zapa" después del de "zapatillas".
     */
    await tester.pumpWidget(app(contenedor()));

    const palabra = 'zapatillas';
    for (var i = 1; i <= palabra.length; i += 1) {
      await tester.enterText(find.byType(TextField), palabra.substring(0, i));
      // Más rápido que el retardo: simula a alguien escribiendo de corrido.
      await tester.pump(const Duration(milliseconds: 60));
    }

    // Y ahora se queda quieto.
    await tester.pump(const Duration(milliseconds: 500));

    expect(consultas, ['zapatillas']);
  });

  testWidgets('dos búsquedas separadas sí hacen dos peticiones', (tester) async {
    // El retardo agrupa una ráfaga, no silencia a quien busca dos cosas.
    await tester.pumpWidget(app(contenedor()));

    await tester.enterText(find.byType(TextField), 'buzo');
    await tester.pump(const Duration(milliseconds: 500));

    await tester.enterText(find.byType(TextField), 'campera');
    await tester.pump(const Duration(milliseconds: 500));

    expect(consultas, ['buzo', 'campera']);
  });

  testWidgets('borrar el texto limpia los resultados sin pedir nada', (tester) async {
    await tester.pumpWidget(
      app(contenedor(resultados: [_producto('Zapatilla urbana', 500000)])),
    );

    await tester.enterText(find.byType(TextField), 'zapatilla');
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump();

    expect(find.text('Zapatilla urbana'), findsOneWidget);

    final antes = consultas.length;
    await tester.enterText(find.byType(TextField), '');
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('Buscá lo que necesitás'), findsOneWidget);
    expect(consultas.length, antes);
  });

  testWidgets('sin resultados sugiere qué hacer, no se lamenta', (tester) async {
    // "No se encontraron resultados" es información que la persona ya tiene
    // mirando la pantalla vacía.
    await tester.pumpWidget(app(contenedor()));

    await tester.enterText(find.byType(TextField), 'xilofono');
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump();

    expect(find.textContaining('Nada por'), findsOneWidget);
    expect(find.textContaining('Probá con menos palabras'), findsOneWidget);
  });

  testWidgets('muestra los resultados con su precio', (tester) async {
    await tester.pumpWidget(
      app(
        contenedor(
          resultados: [
            _producto('Buzo oversize', 890000),
            _producto('Buzo de lana', 750000),
          ],
        ),
      ),
    );

    await tester.enterText(find.byType(TextField), 'buzo');
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump();

    expect(find.text('Buzo oversize'), findsOneWidget);
    expect(find.text('Buzo de lana'), findsOneWidget);
    expect(find.textContaining('8.900'), findsOneWidget);
  });
}

/// Un producto con la forma que devuelve `GET /discover/products`.
///
/// ⚠️ Los nombres de los campos salen de la respuesta real del servidor, no de
/// mi memoria: `store.seller.verificationStatus`, `basePriceCents`, `_count`.
/// Un contrato inventado a mano ya nos costó una hoja de variantes en `$0,00`.
PublicacionFeed _producto(String nombre, int centavos) => PublicacionFeed.fromJson({
      'id': 'prd_${nombre.hashCode}',
      'name': nombre,
      'slug': nombre.toLowerCase().replaceAll(' ', '-'),
      'basePriceCents': centavos,
      'currency': 'ARS',
      'status': 'ACTIVE',
      'images': <dynamic>[],
      'variants': <dynamic>[],
      'store': {
        'id': 'sto_1',
        'name': 'Tienda',
        'slug': 'tienda',
        'seller': {
          'id': 'sel_1',
          'displayName': 'Vendedor',
          'slug': 'vendedor',
          'verificationStatus': 'UNVERIFIED',
        },
      },
      '_count': {'variants': 0},
    });

/// Hereda del real en vez de esconderlo detrás de una interfaz.
///
/// El día que `FeedRepository` gane un método, este archivo sigue compilando y
/// el test que lo necesite falla con un error claro en vez de con un `null`.
class _RepoFalso extends FeedRepository {
  _RepoFalso(super.ref, this._consultas, this._resultados);

  final List<String> _consultas;
  final List<PublicacionFeed> _resultados;

  @override
  Future<({List<PublicacionFeed> items, String? nextCursor})> descubrir({
    String? cursor,
    int limit = 20,
    String? q,
  }) async {
    _consultas.add(q ?? '');
    return (items: _resultados, nextCursor: null);
  }
}
