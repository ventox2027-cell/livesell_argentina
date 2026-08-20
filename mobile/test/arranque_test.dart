import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendox/app/app_shell.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/config/traza_de_arranque.dart';
import 'package:vendox/core/design/theme.dart';
import 'package:vendox/features/auth/data/auth_repository.dart';
import 'package:vendox/features/auth/domain/session.dart';
import 'package:vendox/features/auth/presentation/welcome_screen.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';
import 'package:vendox/features/feed/data/feed_repository.dart';
import 'package:vendox/features/feed/domain/feed_models.dart';
import 'package:vendox/features/notifications/data/notifications_api.dart';
import 'package:vendox/features/lives/presentation/lives_screen.dart';
import 'package:vendox/features/orders/data/orders_repository.dart';
import 'package:vendox/features/orders/domain/order_models.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';

/// El arranque.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE SE MIDIÓ EN UN TELÉFONO
/// ═══════════════════════════════════════════════════════════════════════════
///
///   · ~3 segundos desde el logo hasta poder entrar.
///   · ~5 segundos hasta que Inicio se puede usar.
///
/// Y tres causas, ninguna evidente leyendo el código:
///
///   1. `restaurar()` esperaba un `GET /auth/me` ANTES de dibujar nada, con el
///      usuario ya guardado en el disco desde la sesión anterior.
///   2. `IndexedStack` construye todos sus hijos: al abrir la app salían cinco
///      peticiones y sólo una era la que se estaba mirando.
///   3. Los providers observaban el objeto de sesión entero, que no define
///      igualdad — así que cada arranque los recalculaba de más.
///
/// ⚠️ La 3 es consecuencia de arreglar la 1: al restaurar en dos tiempos, el
/// estado cambia dos veces. Sin la 3, el arreglo del arranque habría duplicado
/// todas las peticiones.
void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({});
    await RuntimeConfig.load();
  });

  late _RepoDeAuth auth;
  late _RepoDeFeed feed;
  late _Contadores contadores;

  Widget app({
    bool hayEnDisco = true,
    bool cuelgaElServidor = false,
    EstadoSesion? servidorDice,
    Duration tardaElServidor = Duration.zero,
  }) {
    auth = _RepoDeAuth(
      hayEnDisco: hayEnDisco,
      cuelgaElServidor: cuelgaElServidor,
      servidorDice: servidorDice,
      tarda: tardaElServidor,
    );
    feed = _RepoDeFeed();
    contadores = _Contadores();

    return ProviderScope(
      overrides: [
        authRepositoryProvider.overrideWithValue(auth),
        feedRepositoryProvider.overrideWithValue(feed),
        // Cada uno cuenta si alguien lo despertó. Ninguno sale a la red.
        livesActivosProvider.overrideWith((ref) async {
          contadores.lives += 1;
          return const [];
        }),
        misPedidosProvider.overrideWith((ref) async {
          contadores.pedidos += 1;
          return (items: <Pedido>[], nextCursor: null);
        }),
        avisosSinLeerProvider.overrideWith((ref) async {
          contadores.avisos += 1;
          return 0;
        }),
        miPerfilVendedorProvider.overrideWith(_PerfilQueCuenta.new),
        contadoresProvider.overrideWithValue(contadores),
      ],
      child: MaterialApp(theme: buildAppTheme(), home: const AppShell()),
    );
  }

  group('La sesión se restaura en dos tiempos', () {
    /// ⛔ EL TEST DEL BUG: la app dibuja sin esperar a la red.
    ///
    /// `/auth/me` no contesta NUNCA. Antes eso dejaba el spinner de arranque
    /// para siempre; en el teléfono terminaba contestando a los ~3 segundos,
    /// que es exactamente lo que se sentía.
    testWidgets('⛔ la app entra aunque /auth/me no conteste', (tester) async {
      await tester.pumpWidget(app(cuelgaElServidor: true));

      // Sin `pumpAndSettle`: con un futuro colgado no hay nada que asentar.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.text('Inicio'), findsOneWidget);
    });

    /// ⛔ Y el servidor SIEMPRE pisa al disco.
    ///
    /// Es lo que impide que una cuenta suspendida se quede con la pantalla
    /// abierta. Sin esto, adelantar el disco sería debilitar la sesión.
    testWidgets('⛔ si el servidor dice que no hay sesión, se cierra', (tester) async {
      await tester.pumpWidget(
        app(servidorDice: const SinSesion(motivo: 'Tu cuenta está suspendida.')),
      );

      // `pump` explícitos y no `pumpAndSettle`: la bienvenida tiene un fondo
      // animado que no termina nunca, y asentar espera para siempre.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('Inicio'), findsNothing);
      expect(find.byType(WelcomeScreen), findsOneWidget);
    });

    /// Sin nada guardado, se espera al servidor como siempre.
    testWidgets('sin usuario en disco, espera al servidor', (tester) async {
      await tester.pumpWidget(app(hayEnDisco: false, cuelgaElServidor: true));

      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });
  });

  group('Al abrir la app se pide UNA sola cosa', () {
    /// ⛔ EL TEST DE LAS CINCO PANTALLAS.
    ///
    /// `IndexedStack` construye todos sus hijos. Al arrancar salían cinco
    /// peticiones —vivos, pedidos, avisos, perfil de vendedor y el feed—
    /// compitiendo por la misma conexión contra un backend que está en otro
    /// continente.
    testWidgets('⛔ las otras pestañas no piden nada hasta que se abren', (tester) async {
      await tester.pumpWidget(app());
      await tester.pumpAndSettle();

      expect(feed.veces, 1, reason: 'el feed sí: es lo que se está mirando');
      expect(contadores.lives, 0);
      expect(contadores.pedidos, 0);
      expect(contadores.avisos, 0);
      expect(contadores.perfilVendedor, 0);
    });

    /// Y cuando se abre una, pide lo suyo.
    testWidgets('al tocar Pedidos, recién ahí pide', (tester) async {
      await tester.pumpWidget(app());
      await tester.pumpAndSettle();

      await tester.tap(find.text('Pedidos'));
      await tester.pumpAndSettle();

      expect(contadores.pedidos, 1);
    });

    /// ⛔ Y una pestaña ya abierta NO vuelve a pedir al volver.
    ///
    /// Es lo que se perdería cambiando el `IndexedStack` por un `switch`: sería
    /// un arranque más rápido a cambio de recargar todo en cada ida y vuelta.
    testWidgets('⛔ volver a una pestaña ya abierta no pide de nuevo', (tester) async {
      await tester.pumpWidget(app());
      await tester.pumpAndSettle();

      await tester.tap(find.text('Pedidos'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Inicio'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Pedidos'));
      await tester.pumpAndSettle();

      expect(contadores.pedidos, 1);
    });
  });

  group('Nada se pide dos veces por el cambio de estado de sesión', () {
    /// ⛔ EL EFECTO SECUNDARIO DE RESTAURAR EN DOS TIEMPOS.
    ///
    /// El estado pasa de `SesionDesconocida` a `ConSesion(disco)` y después a
    /// `ConSesion(servidor)`. `ConSesion` no define igualdad, así que para
    /// Riverpod son dos valores distintos: todo lo que observaba
    /// `sesionProvider` entero se recalculaba, y el feed salía DOS veces por
    /// arranque.
    ///
    /// El arreglo del arranque se habría comido a sí mismo.
    /// ⚠️ El servidor TIENE que tardar, o este test no prueba nada.
    ///
    /// Con una respuesta instantánea los dos cambios de estado caen en el mismo
    /// microtask y Riverpod los junta en un solo recálculo: el feed sale una
    /// vez aunque el provider observe la sesión entera. Fue así al principio, y
    /// el sabotaje —volver a `ref.watch(sesionProvider)`— pasaba en verde.
    ///
    /// En un teléfono `/auth/me` tarda cientos de milisegundos: hay frames de
    /// por medio, Riverpod ya recalculó, y el segundo cambio dispara un segundo
    /// pedido. Los 400 ms de acá son eso.
    testWidgets('⛔ el feed se pide una sola vez', (tester) async {
      await tester.pumpWidget(app(tardaElServidor: const Duration(milliseconds: 400)));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      // Acá ya se pintó con lo del disco y el feed salió. Ahora llega el
      // servidor y cambia el estado por segunda vez.
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();

      expect(feed.veces, 1);
    });

    /// Pero cambiar de persona SÍ tiene que recargar.
    testWidgets('cambiar de cuenta recarga el feed', (tester) async {
      await tester.pumpWidget(app());
      await tester.pumpAndSettle();
      expect(feed.veces, 1);

      auth.idDelUsuario = 'usr_otra';
      final contenedor = ProviderScope.containerOf(
        tester.element(find.byType(AppShell)),
      );
      await contenedor.read(sesionProvider.notifier).restaurar();
      await tester.pumpAndSettle();

      expect(feed.veces, 2);
    });
  });

  group('La traza', () {
    /// ⛔ Mide también en release.
    ///
    /// Antes `kReleaseMode` la apagaba entera, y las pruebas en teléfono se
    /// hacen sobre el APK de release. O sea: la herramienta no funcionaba
    /// justo donde estaba el problema.
    test('⛔ anota los tramos sin depender del modo de compilación', () {
      final t = TrazaDeArranque.instancia..empezar();
      t.paso('uno');
      t.paso('dos');

      expect(t.marcas.map((m) => m.nombre), ['uno', 'dos']);
    });

    /// ⛔ Un tramo en paralelo no se lleva el tiempo del anterior.
    ///
    /// El arranque no es una fila de pasos: mientras la sesión se restaura, el
    /// feed ya está pidiendo. Con sólo la diferencia contra la marca anterior,
    /// dos cosas simultáneas se leen como si una hubiera esperado a la otra.
    test('⛔ un tramo paralelo se mide desde donde empezó', () {
      final t = TrazaDeArranque.instancia..empezar();
      t.paso('algo');
      t.tramo('en paralelo', desdeMs: 0);

      final paralelo = t.marcas.last;
      expect(paralelo.desde, 0);
    });

    /// No informa dos veces lo mismo.
    test('informar vacía lo anotado', () {
      final t = TrazaDeArranque.instancia..empezar();
      t.paso('uno');
      t.informar('prueba');

      expect(t.marcas, isEmpty);
    });
  });
}

// ─── Dobles ─────────────────────────────────────────────────────────────────

class _Contadores {
  int lives = 0;
  int pedidos = 0;
  int avisos = 0;
  int perfilVendedor = 0;
}

final contadoresProvider = Provider<_Contadores>((ref) => _Contadores());

/// Cuenta si alguien despertó el perfil del vendedor, sin salir a la red.
class _PerfilQueCuenta extends PerfilVendedorNotifier {
  @override
  Future<PerfilVendedor?> build() async {
    ref.read(contadoresProvider).perfilVendedor += 1;
    return null;
  }
}

class _RepoDeAuth extends Fake implements AuthRepository {
  _RepoDeAuth({
    this.hayEnDisco = true,
    this.cuelgaElServidor = false,
    this.servidorDice,
    this.tarda = Duration.zero,
  });

  final bool hayEnDisco;
  final bool cuelgaElServidor;
  final EstadoSesion? servidorDice;
  final Duration tarda;
  String idDelUsuario = 'usr_prueba';

  @override
  Future<EstadoSesion?> sesionGuardada() async {
    if (!hayEnDisco) return null;
    return ConSesion(usuario: _usuario(idDelUsuario));
  }

  @override
  Future<EstadoSesion> restaurar() async {
    if (cuelgaElServidor) return Completer<EstadoSesion>().future;
    if (tarda > Duration.zero) await Future<void>.delayed(tarda);
    return servidorDice ?? ConSesion(usuario: _usuario(idDelUsuario));
  }

  @override
  Future<void> actualizarPushToken(String? token) async {}
}

Usuario _usuario(String id) => Usuario.fromJson({
      'id': id,
      'firstName': 'Ana',
      'lastName': 'Prueba',
      'email': 'ana@test.com',
      'role': 'buyer',
    });

class _RepoDeFeed extends Fake implements FeedRepository {
  int veces = 0;

  @override
  Future<({List<PublicacionFeed> items, String? nextCursor})> descubrir({
    String? cursor,
    int limit = 20,
    String? q,
    bool soloSeguidos = false,
  }) async {
    veces += 1;
    return (items: <PublicacionFeed>[], nextCursor: null);
  }
}
