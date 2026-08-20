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
import 'package:vendox/features/lives/data/live_api.dart';
import 'package:vendox/features/lives/domain/live_models.dart';
import 'package:vendox/features/lives/presentation/seller_profile_screen.dart';
import 'package:vendox/features/moderation/data/bloqueos_api.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';

/// El perfil público del vendedor y su vidriera.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO SOCIAL Y LO COMERCIAL SON DOS COSAS
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Arriba, seguidores y seguidos: responden «a cuánta gente le interesa». Abajo,
/// ventas y reseñas: responden «puedo comprarle tranquilo». Los números salen
/// del backend, ninguno se calcula ni se estima acá.
///
/// Y la vidriera es un tercer eje, independiente de los dos: apagarla esconde el
/// catálogo y deja el perfil, los seguidores y la reputación intactos.
void main() {
  const tamanoDePrueba = Size(1200, 2400);

  late _ApiFalsa api;

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

  setUp(() => api = _ApiFalsa());

  Future<void> abrirPerfil(WidgetTester tester, {String? miSellerId}) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveApiProvider.overrideWithValue(api),
          bloqueosApiProvider.overrideWithValue(_BloqueosFalso()),
          sellerRepositoryProvider.overrideWithValue(_VendedorPropio(miSellerId)),
          sesionProvider.overrideWith(_ConSesion.new),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          home: const SellerProfileScreen(sellerId: 'sel_a'),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  group('Seguidores y seguidos', () {
    /**
     * ⛔ SON DOS NÚMEROS DISTINTOS, NO EL MISMO DOS VECES.
     *
     * Seguidores es cuánta gente sigue a este vendedor; seguidos, a cuántos
     * sigue la persona detrás del perfil. El backend los cuenta por separado y
     * la pantalla los muestra por separado.
     */
    testWidgets('⛔ se ven los dos, con sus valores propios', (tester) async {
      api.seguidores = 12;
      api.seguidos = 5;
      await abrirPerfil(tester);

      expect(find.text('12'), findsOneWidget);
      expect(find.text('seguidores'), findsOneWidget);
      expect(find.text('5'), findsOneWidget);
      expect(find.text('seguidos'), findsOneWidget);
    });

    /// En cero también se muestran: un perfil nuevo con 0 es honesto.
    testWidgets('en cero se siguen mostrando', (tester) async {
      await abrirPerfil(tester);

      expect(find.text('seguidores'), findsOneWidget);
      expect(find.text('seguidos'), findsOneWidget);
    });

    /// Y el singular cuando hay uno solo.
    testWidgets('un seguidor va en singular', (tester) async {
      api.seguidores = 1;
      await abrirPerfil(tester);

      expect(find.text('seguidor'), findsOneWidget);
    });
  });

  group('La vidriera', () {
    /// Encendida, se puede entrar a la tienda.
    testWidgets('encendida, se ofrece ver la tienda', (tester) async {
      await abrirPerfil(tester);

      expect(find.text('Ver la tienda'), findsOneWidget);
    });

    /**
     * ⛔ APAGADA, NO SE ABRE EL CATÁLOGO — Y SE DICE POR QUÉ.
     *
     * No se esconde el botón sin más: quien llegó buscando la tienda de alguien
     * merece saber que existe pero no está abierta al público, en vez de
     * quedarse mirando una pantalla donde el botón desapareció.
     */
    testWidgets('⛔ apagada, no se puede entrar a la tienda', (tester) async {
      api.vidriera = false;
      await abrirPerfil(tester);

      expect(find.text('Ver la tienda'), findsNothing);
      expect(find.text('Su vidriera no está disponible por ahora'), findsOneWidget);
    });

    /**
     * ⛔ Y EL RESTO DEL PERFIL SIGUE ENTERO.
     *
     * Apagar la vidriera no es darse de baja: los seguidores, la reputación y
     * el botón de seguir siguen ahí.
     */
    testWidgets('⛔ apagada, el perfil sigue completo', (tester) async {
      api.vidriera = false;
      api.seguidores = 7;
      api.ventas = 20;
      await abrirPerfil(tester);

      expect(find.text('7'), findsOneWidget);
      expect(find.text('seguidores'), findsOneWidget);
      expect(find.text('Seguir'), findsOneWidget);
      expect(find.text('20'), findsOneWidget, reason: 'las ventas desaparecieron');
    });
  });

  group('La reputación, con datos reales', () {
    /**
     * Un vendedor sin historial dice que recién empieza, en vez de mostrar
     * ceros. «0,0 ★» y «0 ventas» hunden a quien todavía no hizo nada.
     */
    testWidgets('sin historial dice que recién empieza', (tester) async {
      await abrirPerfil(tester);

      expect(find.text('Recién empieza'), findsOneWidget);
    });

    /**
     * ⛔ PERO CON ACTIVIDAD, LAS MÉTRICAS REEMPLAZAN A ESE CARTEL.
     *
     * «Recién empieza» es un estado de un vendedor nuevo, no una tapa
     * permanente sobre las métricas de alguien que ya vendió.
     */
    testWidgets('⛔ con ventas y reseñas se muestran los números', (tester) async {
      api.ventas = 34;
      api.resenas = 12;
      api.rating = 4.8;
      await abrirPerfil(tester);

      expect(find.text('Recién empieza'), findsNothing);
      expect(find.text('34'), findsOneWidget);
      expect(find.text('4,8'), findsOneWidget);
      expect(find.text('12 reseñas'), findsOneWidget);
    });

    /**
     * ⛔ Y SIN RESEÑAS NO SE INVENTA UN PROMEDIO.
     *
     * Hay ventas pero nadie calificó: es un estado real y distinto de «recién
     * empieza». Se dice, no se rellena con un número.
     */
    testWidgets('⛔ con ventas pero sin reseñas, no hay estrella', (tester) async {
      api.ventas = 9;
      await abrirPerfil(tester);

      expect(find.text('sin reseñas'), findsOneWidget);
      expect(find.textContaining(','), findsNothing, reason: 'se inventó un promedio');
    });
  });

  group('La tienda propia', () {
    /**
     * ⛔ SOBRE EL PROPIO PERFIL NO HAY BOTÓN DE SEGUIR.
     *
     * Es la corrección de Follow, que tiene que seguir valiendo acá: nadie se
     * sigue a sí mismo y el backend lo rechaza.
     */
    testWidgets('⛔ en el perfil propio no aparece Seguir', (tester) async {
      await abrirPerfil(tester, miSellerId: 'sel_a');

      expect(find.text('Seguir'), findsNothing);
      expect(find.text('Siguiendo'), findsNothing);
    });

    /// Y los contadores sociales se siguen viendo en el perfil propio.
    testWidgets('el perfil propio sí muestra seguidores y seguidos', (tester) async {
      api.seguidores = 3;
      await abrirPerfil(tester, miSellerId: 'sel_a');

      expect(find.text('seguidores'), findsOneWidget);
      expect(find.text('seguidos'), findsOneWidget);
    });
  });
}

class _ApiFalsa extends LiveApi {
  _ApiFalsa() : super(ApiClient(tokens: TokenStore()));

  int seguidores = 0;
  int seguidos = 0;
  int ventas = 0;
  int resenas = 0;
  double? rating;
  bool vidriera = true;

  @override
  Future<PerfilDeVendedor> perfil(String sellerId) async => PerfilDeVendedor.fromJson({
        'id': sellerId,
        'nombre': 'Ana Tejidos',
        'seguidores': seguidores,
        'seguidos': seguidos,
        'ventas': ventas,
        'resenas': resenas,
        if (rating != null) 'rating': rating,
        'loSigo': false,
        'esNuevo': ventas == 0 && resenas == 0,
        'tienda': {
          'id': 'sto_1',
          'nombre': 'Tienda de Ana',
          'slug': 'ana',
          'estado': 'ACTIVE',
          'vidriera': vidriera,
        },
      });
}

class _BloqueosFalso extends Fake implements BloqueosApi {
  @override
  Future<bool> bloqueeAlVendedor(String sellerId) async => false;
}

/// Quien mira: con tienda propia o sin ella, según el test.
class _VendedorPropio extends Fake implements SellerRepository {
  _VendedorPropio(this._miSellerId);
  final String? _miSellerId;

  @override
  Future<PerfilVendedor?> miPerfil() async {
    final id = _miSellerId;
    if (id == null) return null;
    return PerfilVendedor.fromJson({
      'seller': {'id': id, 'displayName': 'Yo', 'slug': 'yo', 'status': 'ACTIVE'},
    });
  }
}

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
