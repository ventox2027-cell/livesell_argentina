import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/design/theme.dart';
import 'package:vendox/features/auth/domain/session.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';
import 'package:vendox/features/notifications/data/notifications_api.dart';
import 'package:vendox/features/profile/presentation/profile_screen.dart';
import 'package:vendox/features/profile/presentation/widgets/acceso_a_mi_tienda.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';

/// El acceso a Mi tienda.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// QUÉ SE MIDIÓ ANTES DE CAMBIAR NADA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// «Mi tienda» era la fila trece de Perfil, bajo el título «Vender», debajo de
/// Cuenta, Ayuda, Seguridad, Personas bloqueadas, Guardados, Descargar mis
/// datos y Política de privacidad. En un teléfono de 844 px de alto con filas
/// de ~56, eso cae fuera de la pantalla.
///
/// | | Antes | Ahora |
/// |---|---|---|
/// | Toques desde Inicio | 2 | 2 |
/// | Scroll para llegar | ~1 pantalla | ninguno |
/// | Posición en Perfil | 13 | 1 |
/// | Pantalla de quien compra | — | sin cambios |
///
/// Los toques no bajan. El problema no era la cantidad: era que el segundo
/// toque estaba escondido.
void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();

    /// Perfil arma su cliente HTTP al construirse y eso lee la URL guardada.
    /// Con el almacenamiento vacío toma el valor de compilación, que es lo que
    /// corresponde acá: no se llama a la red en ninguno de estos tests.
    SharedPreferences.setMockInitialValues({});
    await RuntimeConfig.load();

    /// El tamaño importa en este archivo: lo que se mide es si la tarjeta entra
    /// en la pantalla de un teléfono, que es exactamente el bug.
    final vista = TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    vista.physicalSize = const Size(390, 844);
    vista.devicePixelRatio = 1;
  });

  late _RepoDeVendedor repo;

  Widget perfil({required bool esVendedor, bool cuelga = false}) {
    repo = _RepoDeVendedor(esVendedor: esVendedor, cuelga: cuelga);
    return ProviderScope(
      overrides: [
        sellerRepositoryProvider.overrideWithValue(repo),
        sesionProvider.overrideWith(() => _Sesion(esVendedor: esVendedor)),
        // Los avisos salen a la red desde su propio provider; acá no interesan.
        avisosSinLeerProvider.overrideWith((ref) async => 0),
      ],
      child: MaterialApp(theme: buildAppTheme(), home: const ProfileScreen()),
    );
  }

  group('Para quien vende', () {
    /// ⛔ EL CAMBIO, MEDIDO COMO SE SIENTE: sin scrollear.
    ///
    /// `findsOneWidget` no alcanzaría —la fila vieja también existía en el
    /// árbol—. Lo que se comprueba es que esté DENTRO de la pantalla, que es
    /// justamente lo que antes no pasaba.
    testWidgets('⛔ Mi tienda se ve sin scrollear', (tester) async {
      await tester.pumpWidget(perfil(esVendedor: true));
      await tester.pump();

      final tarjeta = find.byType(AccesoAMiTienda);
      expect(tarjeta, findsOneWidget);

      final alto = tester.view.physicalSize.height / tester.view.devicePixelRatio;
      expect(
        tester.getBottomLeft(tarjeta).dy,
        lessThan(alto),
        reason: 'quedó abajo del borde de la pantalla, que es el bug original',
      );
    });

    /// ⛔ Y es lo primero que hay después de la cabecera.
    testWidgets('⛔ está arriba de la sección Cuenta', (tester) async {
      await tester.pumpWidget(perfil(esVendedor: true));
      await tester.pump();

      expect(
        tester.getTopLeft(find.byType(AccesoAMiTienda)).dy,
        lessThan(tester.getTopLeft(find.text('CUENTA')).dy),
      );
    });

    /// ⛔ No quedan dos entradas a lo mismo.
    ///
    /// La fila vieja bajo «Vender» tenía que irse. Dos filas idénticas en una
    /// pantalla no dan más acceso: hacen dudar de si llevan al mismo lado.
    testWidgets('⛔ la fila vieja de «Vender» ya no está', (tester) async {
      await tester.pumpWidget(perfil(esVendedor: true));
      await tester.pump();

      expect(find.text('Mi tienda'), findsOneWidget);
      expect(find.text('VENDER'), findsNothing);
      expect(find.text('Quiero vender'), findsNothing);
    });

    /// El nombre de la tienda aparece cuando el servidor lo devolvió.
    testWidgets('muestra el nombre de la tienda', (tester) async {
      await tester.pumpWidget(perfil(esVendedor: true));
      await tester.pumpAndSettle();

      expect(find.text('Tejidos del Sur'), findsOneWidget);
    });

    /// ⛔ Y NO inventa un nombre mientras carga.
    ///
    /// Un texto de relleno arriba de todo es un dato falso en la pantalla. Se
    /// muestra qué hay adentro, que es cierto siempre.
    testWidgets('⛔ mientras carga no inventa un nombre', (tester) async {
      await tester.pumpWidget(perfil(esVendedor: true, cuelga: true));
      await tester.pump();

      expect(find.text('Tus productos, ventas y ajustes'), findsOneWidget);
    });

    /// ⛔ Precalienta el perfil del vendedor.
    ///
    /// Es la mitad invisible del arreglo: el `GET /sellers/me` que el panel
    /// haría un toque después sale mientras la persona todavía está mirando
    /// Perfil. Cuando entra, ya está.
    testWidgets('⛔ pide el perfil del vendedor al abrir Perfil', (tester) async {
      await tester.pumpWidget(perfil(esVendedor: true));
      await tester.pumpAndSettle();

      expect(repo.vecesQuePreguntoElPerfil, 1);
    });
  });

  group('Para quien compra', () {
    /// ⛔ LA OTRA MITAD DEL REQUISITO: no romper la navegación de quien compra.
    testWidgets('⛔ no ve la tarjeta de Mi tienda', (tester) async {
      await tester.pumpWidget(perfil(esVendedor: false));
      await tester.pump();

      expect(find.byType(AccesoAMiTienda), findsNothing);
      expect(find.text('Mi tienda'), findsNothing);
    });

    /// ⛔ Y NO se le pide el perfil de vendedor, que no tiene.
    ///
    /// Sería una petición garantizada a fallar en cada apertura de Perfil, para
    /// todas las personas que sólo compran.
    testWidgets('⛔ no dispara ningún pedido de vendedor', (tester) async {
      await tester.pumpWidget(perfil(esVendedor: false));
      await tester.pumpAndSettle();

      expect(repo.vecesQuePreguntoElPerfil, 0);
    });

    /// La invitación a vender sigue donde estaba.
    testWidgets('sigue viendo «Quiero vender»', (tester) async {
      await tester.pumpWidget(perfil(esVendedor: false));
      await tester.pump();

      await tester.scrollUntilVisible(find.text('Quiero vender'), 200);
      expect(find.text('Quiero vender'), findsOneWidget);
    });
  });
}

class _RepoDeVendedor extends Fake implements SellerRepository {
  _RepoDeVendedor({required this.esVendedor, this.cuelga = false});

  final bool esVendedor;
  final bool cuelga;
  int vecesQuePreguntoElPerfil = 0;

  @override
  Future<PerfilVendedor?> miPerfil() async {
    vecesQuePreguntoElPerfil += 1;
    if (cuelga) return Completer<PerfilVendedor?>().future;
    if (!esVendedor) return null;
    return PerfilVendedor.fromJson(const {
      'seller': {
        'id': 'sel_prueba',
        'displayName': 'Tejidos del Sur',
        'slug': 'tejidos-del-sur',
        'status': 'ACTIVE',
        'verificationStatus': 'NONE',
        'followersCount': 0,
        'ratingCount': 0,
      },
      'store': {
        'id': 'sto_prueba',
        'sellerId': 'sel_prueba',
        'name': 'Tejidos del Sur',
        'slug': 'tejidos-del-sur',
        'status': 'ACTIVE',
        'isPrimary': true,
      },
      'stats': {'productos': 0},
    });
  }
}

class _Sesion extends SesionNotifier {
  _Sesion({required this.esVendedor});
  final bool esVendedor;

  @override
  EstadoSesion build() => ConSesion(
        usuario: Usuario.fromJson({
          'id': 'usr_prueba',
          'firstName': 'Ana',
          'lastName': 'Prueba',
          'email': 'ana@test.com',
          'role': esVendedor ? 'seller' : 'buyer',
        }),
      );

  @override
  Future<void> restaurar() async {}
}
