import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/design/theme.dart';
import 'package:vendox/features/auth/domain/session.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';
import 'package:vendox/features/seller/presentation/seller_home_screen.dart';

/// Entrar a Mi tienda.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE SE MIDIÓ EN UN TELÉFONO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// A veces instantáneo, a veces 3 a 5 segundos. La diferencia no era la red:
/// era si alguien había invalidado los providers en el camino.
///
/// `ref.invalidate` **descarta** el estado. El provider vuelve a `loading` sin
/// valor anterior y la pantalla muestra su spinner de cuerpo entero, o sea que
/// la tienda que la persona miraba hace dos segundos desaparece para volver a
/// aparecer igual. Y se invalidaba en todos lados: al volver del editor, al
/// crear un producto, al guardar los ajustes, al tirar para refrescar.
///
/// Peor: `misProductos` observa a `miPerfil`, así que invalidar el perfil
/// invalidaba también el listado. Un `invalidate` costaba dos peticiones.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ CASI TODOS ESTOS TESTS DEJAN EL SERVIDOR COLGADO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Porque con un doble que contesta al instante, invalidar y reconciliar se ven
/// exactamente igual. La diferencia sólo existe mientras la respuesta no llegó
/// — que en un teléfono contra Railway son cientos de milisegundos, y es todo
/// el bug.
void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({});
    await RuntimeConfig.load();
    final vista = TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    vista.physicalSize = const Size(900, 1600);
    vista.devicePixelRatio = 1;
  });

  late _RepoDeTienda repo;

  Widget pantalla({bool cuelga = false}) {
    repo = _RepoDeTienda()..cuelga = cuelga;
    return ProviderScope(
      overrides: [
        sellerRepositoryProvider.overrideWithValue(repo),
        sesionProvider.overrideWith(_Sesion.new),
      ],
      child: MaterialApp(theme: buildAppTheme(), home: const SellerHomeScreen()),
    );
  }

  /// Deja la pantalla cargada, como cuando ya se entró una vez.
  Future<ProviderContainer> entrada(WidgetTester tester) async {
    await tester.pumpWidget(pantalla());
    await tester.pumpAndSettle();
    return ProviderScope.containerOf(tester.element(find.byType(SellerHomeScreen)));
  }

  group('Entrada fría', () {
    /// La primera vez no hay nada guardado: el spinner es correcto.
    testWidgets('sin datos todavía, muestra el spinner', (tester) async {
      await tester.pumpWidget(pantalla(cuelga: true));
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsWidgets);
    });

    testWidgets('cuando llega, muestra la tienda', (tester) async {
      await entrada(tester);

      expect(find.text('MIS PRODUCTOS'), findsOneWidget);
    });
  });

  group('Entrada caliente', () {
    /// ⛔ EL TEST DEL BUG.
    ///
    /// La tienda ya se conoce y se está refrescando. Con el servidor colgado,
    /// o la pantalla siguió mostrando lo que sabía, o se vació — que es lo que
    /// se sentía como «a veces tarda 3 a 5 segundos».
    testWidgets('⛔ al refrescar, la tienda NO desaparece', (tester) async {
      final c = await entrada(tester);
      repo.cuelga = true;

      unawaited(recargarLaTienda(c.read));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.text('MIS PRODUCTOS'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    /// ⛔ Y si el refresco FALLA, tampoco.
    ///
    /// Un refresco de cortesía que no llegó no puede vaciarle la tienda a
    /// alguien. Era el otro modo de falla: entrar, ver la tienda, y que se
    /// convirtiera en un error por un corte de un segundo.
    testWidgets('⛔ si el refresco falla, la tienda sigue visible', (tester) async {
      final c = await entrada(tester);
      repo.falla = true;

      await recargarLaTienda(c.read);
      await tester.pumpAndSettle();

      expect(find.text('MIS PRODUCTOS'), findsOneWidget);
    });

    /// ⛔ El refresco pide una vez cada cosa, no dos.
    ///
    /// Invalidar el perfil invalidaba también el listado, porque el listado lo
    /// observa. Reconciliar los dos a mano es lo que corta esa cascada.
    testWidgets('⛔ un refresco son dos peticiones, no cuatro', (tester) async {
      final c = await entrada(tester);
      final perfilAntes = repo.vecesPerfil;
      final productosAntes = repo.vecesProductos;

      await recargarLaTienda(c.read);
      await tester.pumpAndSettle();

      expect(repo.vecesPerfil - perfilAntes, 1);
      expect(repo.vecesProductos - productosAntes, 1);
    });

    /// Y los datos nuevos sí se ven cuando llegan.
    testWidgets('el refresco trae los cambios', (tester) async {
      final c = await entrada(tester);
      repo.nombreDeLaTienda = 'Tejidos del Norte';

      await recargarLaTienda(c.read);
      await tester.pumpAndSettle();

      expect(find.text('Tejidos del Norte'), findsWidgets);
    });
  });
}



class _RepoDeTienda extends Fake implements SellerRepository {
  int vecesPerfil = 0;
  int vecesProductos = 0;
  bool cuelga = false;
  bool falla = false;
  String nombreDeLaTienda = 'Tejidos del Sur';

  @override
  Future<PerfilVendedor?> miPerfil() async {
    vecesPerfil += 1;
    if (cuelga) return Completer<PerfilVendedor?>().future;
    if (falla) throw ComercioException('sin red');
    return PerfilVendedor.fromJson({
      'seller': {
        'id': 'sel_prueba',
        'displayName': nombreDeLaTienda,
        'slug': 'tejidos',
        'status': 'ACTIVE',
        'verificationStatus': 'NONE',
        'followersCount': 0,
        'ratingCount': 0,
      },
      'store': {
        'id': 'sto_prueba',
        'sellerId': 'sel_prueba',
        'name': nombreDeLaTienda,
        'slug': 'tejidos',
        'status': 'ACTIVE',
        'isPrimary': true,
      },
      'stats': {'productos': 0},
    });
  }

  @override
  Future<Pagina<Producto>> misProductos({String? cursor, int limit = 20}) async {
    vecesProductos += 1;
    if (cuelga) return Completer<Pagina<Producto>>().future;
    if (falla) throw ComercioException('sin red');
    return const Pagina(items: []);
  }
}

class _Sesion extends SesionNotifier {
  @override
  EstadoSesion build() => ConSesion(
        usuario: Usuario.fromJson(const {
          'id': 'usr_prueba',
          'firstName': 'Ana',
          'lastName': 'Prueba',
          'email': 'ana@test.com',
          'role': 'seller',
        }),
      );

  @override
  Future<void> restaurar() async {}
}
