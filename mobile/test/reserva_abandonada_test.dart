import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/design/theme.dart';
import 'package:vendox/features/inventory/data/inventory_repository.dart';
import 'package:vendox/features/inventory/data/reserva_en_curso.dart';
import 'package:vendox/features/inventory/domain/inventory_models.dart';
import 'package:vendox/features/inventory/presentation/reserve_sheet.dart';
import 'package:vendox/features/orders/data/orders_repository.dart';
import 'package:vendox/features/orders/domain/order_models.dart';

/// Soltar lo apartado cuando la persona se va sin pagar.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BUG
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Apartar una unidad, cerrar la hoja del contador sin tocar «Ir a pagar» ni
/// «Soltar la reserva», y la unidad quedaba tomada hasta que venciera el TTL.
/// La hoja no tenía `PopScope` ni nada equivalente: cerrar por atrás, por
/// arrastre o tocando afuera no avisaba a nadie.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE NO PUEDE PASAR AL ARREGLARLO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Soltar la reserva cuando la persona se fue **a pagar**. El checkout puede
/// mandar a la app de Mercado Pago, y desde ahí la hoja se cierra por caminos
/// que no controlamos. Un `dispose() => liberar()` haría que el pago falle con
/// «se agotó» sobre la unidad que ella misma tenía apartada.
///
/// Por eso la salida se DECLARA antes de cerrar en vez de deducirse después.
void main() {
  const tamanoDePrueba = Size(1200, 2400);

  late _RepoFalso repo;
  late _PedidosFalso pedidos;

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
    repo = _RepoFalso();
    pedidos = _PedidosFalso();
  });

  ProviderContainer contenedor() {
    final c = ProviderContainer(
      overrides: [
        inventoryRepositoryProvider.overrideWithValue(repo),
        ordersRepositoryProvider.overrideWithValue(pedidos),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  group('Los tres desenlaces', () {
    /**
     * ⛔ ABANDONAR SUELTA.
     *
     * Es el bug: la persona se fue sin decidir y la unidad tiene que volver al
     * stock enseguida, no dentro de tres minutos.
     */
    test('⛔ abandonar suelta lo apartado', () async {
      final c = contenedor();
      c.read(reservaEnCursoProvider.notifier).tomada('rsv_1');

      await c.read(reservaEnCursoProvider.notifier).alSalir(SalidaDeLaReserva.abandonada);

      expect(repo.canceladas, ['rsv_1']);
      expect(c.read(reservaEnCursoProvider), isNull);
    });

    /**
     * ⛔ IRSE A PAGAR NO SUELTA.
     *
     * La reserva es justo lo que el pedido va a consumir. Soltarla acá haría
     * fallar el pago con «se agotó» sobre algo apartado por quien está pagando.
     */
    test('⛔ irse a pagar NO suelta', () async {
      final c = contenedor();
      c.read(reservaEnCursoProvider.notifier).tomada('rsv_1');

      await c.read(reservaEnCursoProvider.notifier).alSalir(SalidaDeLaReserva.pagando);

      expect(repo.canceladas, isEmpty);
    });

    /**
     * ⛔ Y SOLTARLA A MANO NO LA SUELTA DOS VECES.
     *
     * El botón ya mandó su `DELETE`. Cerrar la hoja después no puede mandar
     * otro sobre una reserva que ya no está activa.
     */
    test('⛔ soltar con el botón y después cerrar manda un solo DELETE', () async {
      final c = contenedor();
      c.read(reservaEnCursoProvider.notifier).tomada('rsv_1');

      // Lo que hace el botón: cancela y avisa que ya no hay nada.
      await repo.cancelar('rsv_1');
      c.read(reservaEnCursoProvider.notifier).olvidar();

      await c.read(reservaEnCursoProvider.notifier).alSalir(SalidaDeLaReserva.liberada);

      expect(repo.canceladas, ['rsv_1'], reason: 'se soltó dos veces');
    });
  });

  group('Cierres repetidos y fallos', () {
    /**
     * ⛔ DOS AVISOS DE SALIDA MANDAN UN SOLO `DELETE`.
     *
     * Pasa con dos toques rápidos del botón de atrás, o si el cierre dispara el
     * aviso más de una vez. El id se limpia ANTES de salir a la red.
     */
    test('⛔ abandonar dos veces suelta una sola', () async {
      final c = contenedor();
      final notifier = c.read(reservaEnCursoProvider.notifier);
      notifier.tomada('rsv_1');

      await Future.wait([
        notifier.alSalir(SalidaDeLaReserva.abandonada),
        notifier.alSalir(SalidaDeLaReserva.abandonada),
      ]);

      expect(repo.canceladas, ['rsv_1']);
    });

    /// Sin nada apartado no se llama a nadie.
    test('sin reserva, salir no llama al backend', () async {
      final c = contenedor();

      await c.read(reservaEnCursoProvider.notifier).alSalir(SalidaDeLaReserva.abandonada);

      expect(repo.canceladas, isEmpty);
    });

    /**
     * ⛔ SI EL `DELETE` FALLA, NO SE ROMPE NADA.
     *
     * Para cuando esto corre la pantalla ya no existe: no hay a quién avisarle
     * y una excepción sólo rompería la navegación. La unidad no queda tomada
     * para siempre — el TTL del backend la vence igual. El error se traga
     * **porque hay una segunda defensa**, no porque no importe.
     */
    test('⛔ un fallo del DELETE no lanza', () async {
      final c = contenedor();
      repo.falla = true;
      c.read(reservaEnCursoProvider.notifier).tomada('rsv_1');

      await expectLater(
        c.read(reservaEnCursoProvider.notifier).alSalir(SalidaDeLaReserva.abandonada),
        completes,
      );
      expect(repo.intentos, 1, reason: 'se intentó soltar');
    });
  });

  group('La hoja, de punta a punta', () {
    /// Abre la hoja como la abre el feed, sobre una pantalla cualquiera.
    Future<void> abrirLaHoja(WidgetTester tester, ProviderContainer c) async {
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: c,
          child: MaterialApp(
            theme: buildAppTheme(),
            home: Scaffold(
              body: Builder(
                builder: (context) => Center(
                  child: ElevatedButton(
                    onPressed: () => ReserveSheet.mostrar(
                      context,
                      productVariantId: 'var_1',
                      nombreProducto: 'Campera de lana',
                      precio: r'$150.000',
                    ),
                    child: const Text('Comprar'),
                  ),
                ),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Comprar'));
      await tester.pumpAndSettle();
    }

    /// El botón de atrás DEL SISTEMA.
    ///
    /// ⚠️ No `tester.pageBack()`: ése busca la flecha de una `AppBar`, y una
    /// hoja modal no tiene ninguna. `handlePopRoute` es lo que Android manda de
    /// verdad al apretar atrás, que es el gesto del caso reportado.
    Future<void> volverAtras(WidgetTester tester) async {
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
    }

    /// Aparta una unidad: deja la hoja con el contador y los dos botones.
    Future<void> apartar(WidgetTester tester) async {
      await tester.tap(find.text('Apartar'));
      await tester.pumpAndSettle();

      expect(find.text('Ir a pagar'), findsOneWidget, reason: 'no se apartó');
    }

    /**
     * ⛔ EL CASO REPORTADO: SE VA CON EL BOTÓN DE ATRÁS.
     *
     * Apartó, no tocó ninguno de los dos botones, y volvió atrás. La unidad
     * tiene que volver al stock enseguida.
     */
    testWidgets('⛔ volver atrás suelta lo apartado', (tester) async {
      final c = contenedor();
      await abrirLaHoja(tester, c);
      await apartar(tester);

      expect(repo.canceladas, isEmpty, reason: 'todavía no se fue');

      await volverAtras(tester);

      expect(repo.canceladas, ['rsv_1']);
    });

    /**
     * ⛔ Y TOCANDO AFUERA DE LA HOJA, TAMBIÉN.
     *
     * Es la forma más común de cerrar una hoja modal, y la que un `dispose`
     * mal puesto o un `WillPopScope` sobre la pantalla de atrás no cubrirían.
     */
    testWidgets('⛔ tocar afuera de la hoja suelta lo apartado', (tester) async {
      final c = contenedor();
      await abrirLaHoja(tester, c);
      await apartar(tester);

      // Arriba de todo: fuera de la hoja, sobre el velo.
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();

      expect(repo.canceladas, ['rsv_1']);
    });

    /**
     * ⛔ «SOLTAR LA RESERVA» SUELTA UNA VEZ, NO DOS.
     *
     * El botón manda su `DELETE`, y cerrar la hoja después no puede mandar
     * otro.
     */
    testWidgets('⛔ soltar a mano y cerrar manda un solo DELETE', (tester) async {
      final c = contenedor();
      await abrirLaHoja(tester, c);
      await apartar(tester);

      await tester.tap(find.text('Soltar la reserva'));
      await tester.pumpAndSettle();
      expect(repo.canceladas, ['rsv_1']);

      await volverAtras(tester);

      expect(repo.canceladas, ['rsv_1'], reason: 'el cierre soltó de nuevo');
    });

    /**
     * ⛔ EL SEGUNDO PLANO NO SUELTA NADA.
     *
     * Es exactamente lo que pasa al abrir Mercado Pago, o cuando entra una
     * llamada. La hoja sigue viva y la persona vuelve: soltar acá sería el peor
     * momento posible.
     */
    testWidgets('⛔ pasar a segundo plano NO suelta', (tester) async {
      final c = contenedor();
      await abrirLaHoja(tester, c);
      await apartar(tester);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pumpAndSettle();

      expect(repo.canceladas, isEmpty, reason: 'se soltó al ir al fondo');

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();

      expect(repo.canceladas, isEmpty, reason: 'se soltó al volver');
      expect(find.text('Ir a pagar'), findsOneWidget, reason: 'la reserva sigue en pantalla');
    });

    /**
     * ⛔ IRSE A PAGAR NO SUELTA — EL CASO QUE SE ROMPE MÁS FÁCIL.
     *
     * Este test existe por un sabotaje que ningún otro detectó: forzar
     * «abandonada» al cerrar la hoja dejaba los doce tests en verde y rompía el
     * pago de verdad. La unidad se soltaba justo cuando la persona estaba
     * poniendo los datos de la tarjeta, y el cobro fallaba con «se agotó» sobre
     * algo que ella misma tenía apartado.
     *
     * Los tests del notifier prueban que `pagando` no suelta; éste prueba que
     * la hoja DECLARE `pagando` antes de abrir el checkout, que es otra cosa.
     */
    testWidgets('⛔ mientras se paga NO se suelta, y al volver sin pagar sí', (tester) async {
      final c = contenedor();
      await abrirLaHoja(tester, c);
      await apartar(tester);

      await tester.tap(find.text('Ir a pagar'));
      await tester.pumpAndSettle();
      expect(pedidos.creados, 1, reason: 'no se abrió el checkout');

      // Con el checkout arriba, lo apartado sigue apartado.
      expect(repo.canceladas, isEmpty, reason: 'se soltó la reserva que se está pagando');
      expect(c.read(reservaEnCursoProvider), 'rsv_1');

      /**
       * Y volver del checkout SIN pagar deja la hoja como estaba: si ahora
       * cierra, abandonó.
       *
       * Sin esa vuelta a «abandonada», entrar al checkout una vez blindaría la
       * reserva para el resto de la sesión de la hoja y la unidad quedaría
       * tomada hasta que venza el TTL.
       */
      await volverAtras(tester);
      await tester.pumpAndSettle();
      expect(find.text('Ir a pagar'), findsOneWidget, reason: 'no volvimos a la reserva');

      await volverAtras(tester);
      expect(repo.canceladas, ['rsv_1']);
    });

    /**
     * ⛔ Y APARTAR DE NUEVO DESPUÉS DE SOLTAR VUELVE A CONTAR.
     *
     * Soltar deja la salida marcada como «ya se liberó». Si esa marca quedara
     * pegada, abandonar el segundo intento no soltaría nada y la unidad
     * quedaría tomada — el bug original, sólo que más difícil de encontrar.
     */
    testWidgets('⛔ soltar, apartar otra vez y abandonar vuelve a soltar', (tester) async {
      final c = contenedor();
      await abrirLaHoja(tester, c);
      await apartar(tester);

      await tester.tap(find.text('Soltar la reserva'));
      await tester.pumpAndSettle();

      await apartar(tester);
      await volverAtras(tester);

      expect(repo.canceladas, ['rsv_1', 'rsv_2']);
    });

    /**
     * ⛔ UNA RESERVA VENCIDA NO SE SUELTA AL CERRAR.
     *
     * El TTL del backend ya la liberó. Mandar un `DELETE` sobre algo que no
     * está activo es ruido, y el camino del vencimiento no cambia: lo sigue
     * manejando el servidor, que es el único con la hora buena.
     *
     * ⚠️ La reserva nace vencida en vez de adelantar el reloj: el contador se
     * calcula contra `expiresAt` con la hora REAL —a propósito, para que
     * volver del segundo plano no muestre un tiempo que ya no existe— y el
     * reloj falso de los tests no la mueve.
     */
    testWidgets('⛔ si venció, cerrar no manda DELETE', (tester) async {
      final c = contenedor();
      repo.segundos = -1;
      await abrirLaHoja(tester, c);

      await tester.tap(find.text('Apartar'));
      await tester.pump();

      // Un tic del contador: ve que ya no queda tiempo y se olvida de ella.
      await tester.pump(const Duration(seconds: 1));
      expect(c.read(reservaEnCursoProvider), isNull, reason: 'quedó algo que soltar');

      await volverAtras(tester);

      expect(repo.canceladas, isEmpty);
    });
  });
}

/// El checkout crea un pedido apenas se abre. Acá se cuenta y nada más.
class _PedidosFalso extends Fake implements OrdersRepository {
  int creados = 0;

  @override
  Future<Pedido> crearPedido({
    required String reservationId,
    required String idempotencyKey,
    String? addressId,
    bool retiraEnPersona = false,
    String? liveSessionId,
  }) async {
    creados += 1;
    return Pedido.fromJson({
      'id': 'ord_1',
      'reference': 'VX-1',
      'status': 'PENDING_PAYMENT',
      'createdAt': DateTime.now().toIso8601String(),
      'grossAmount': 15000000,
      'itemsSubtotal': 15000000,
      'pickupSelected': true,
      'items': <dynamic>[],
    });
  }
}

class _RepoFalso extends Fake implements InventoryRepository {
  /// Qué reservas se mandaron a cancelar, en orden.
  final List<String> canceladas = [];

  /// Cuántas veces se INTENTÓ cancelar, incluso si falló.
  int intentos = 0;

  bool falla = false;

  /// Cuánto dura la reserva que devuelve el doble.
  int segundos = 180;

  int _n = 0;

  @override
  Future<Reserva> reservar({
    required String productVariantId,
    required String idempotencyKey,
    int quantity = 1,
  }) async {
    _n += 1;
    return Reserva.fromJson({
      'reservationId': 'rsv_$_n',
      'status': 'ACTIVE',
      'productVariantId': productVariantId,
      'quantity': quantity,
      'expiresAt': DateTime.now().add(Duration(seconds: segundos)).toIso8601String(),
      'remainingSeconds': segundos,
    });
  }

  @override
  Future<void> cancelar(String reservationId) async {
    intentos += 1;
    if (falla) throw Exception('sin red');
    canceladas.add(reservationId);
  }

  @override
  Future<Disponibilidad> disponibilidad(String productVariantId) async =>
      Disponibilidad.fromJson({'productVariantId': productVariantId, 'estado': 'DISPONIBLE'});
}
