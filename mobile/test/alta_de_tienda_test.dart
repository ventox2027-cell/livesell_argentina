import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/core/design/theme.dart';
import 'package:vendox/features/auth/domain/session.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';
import 'package:vendox/features/seller/presentation/seller_home_screen.dart';

/// Crear la tienda y ver la tienda.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BUG QUE ESTOS TESTS EXISTEN PARA EVITAR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El backend crea la tienda perfectamente —está probado de punta a punta en
/// `tienda-flow.spec.ts`— y aun así la pantalla puede volver a mostrar «Empezá
/// a vender», como si nada hubiera pasado.
///
/// Es el peor modo de falla posible para esta pantalla: no hay error, no hay
/// log, no hay nada que investigar. La persona toca el botón, la app dice que
/// salió bien, y sigue viendo el mismo formulario. La conclusión razonable es
/// que la app no funciona.
///
/// Por eso lo que se prueba acá no es el llamado HTTP —eso ya está— sino que
/// **después de crear, la pantalla cambie**.
class _RepoDeAlta extends Fake implements SellerRepository {
  _RepoDeAlta();

  bool creada = false;
  int vecesQuePreguntoElPerfil = 0;
  int vecesQueCreo = 0;

  /// Si el alta tiene que fallar, y con qué.
  Object? fallaAlCrear;

  @override
  Future<PerfilVendedor> crearVendedor({
    required String displayName,
    String? storeName,
    String? bio,
  }) async {
    vecesQueCreo += 1;
    final falla = fallaAlCrear;
    if (falla != null) throw falla;
    creada = true;
    return _perfil(displayName);
  }

  /// Si el `GET /sellers/me` posterior tiene que fallar.
  ///
  /// Sirve para probar lo importante: que la tienda recién creada NO dependa de
  /// que ese viaje salga bien.
  bool fallaAlPreguntar = false;

  /// Si el `GET` no tiene que contestar nunca.
  ///
  /// Es la forma de demostrar que la pantalla cambia con lo que devolvió el
  /// `POST` y no esperando un segundo viaje.
  bool cuelgaAlPreguntar = false;

  @override
  Future<PerfilVendedor?> miPerfil() async {
    vecesQuePreguntoElPerfil += 1;
    if (cuelgaAlPreguntar) return Completer<PerfilVendedor?>().future;
    if (fallaAlPreguntar) throw ComercioException('sin red');
    return creada ? _perfil('Tejidos del Sur') : null;
  }

  @override
  Future<Pagina<Producto>> misProductos({String? cursor, int limit = 20}) async =>
      const Pagina(items: []);
}

PerfilVendedor _perfil(String nombre) => PerfilVendedor.fromJson({
      'seller': {
        'id': 'sel_prueba',
        'displayName': nombre,
        'slug': 'tejidos-del-sur',
        'bio': null,
        'avatarUrl': null,
        'coverUrl': null,
        'status': 'ACTIVE',
        'verificationStatus': 'NONE',
        'followersCount': 0,
        'ratingAvg': null,
        'ratingCount': 0,
      },
      'store': {
        'id': 'sto_prueba',
        'sellerId': 'sel_prueba',
        'name': nombre,
        'slug': 'tejidos-del-sur',
        'description': null,
        'logoUrl': null,
        'coverUrl': null,
        'status': 'ACTIVE',
        'isPrimary': true,
      },
      'stats': {'productos': 0},
    });

/// Una sesión que no toca la red.
///
/// `_crear()` llama a `restaurar()` para que el rol pase a `seller`. Contra el
/// notifier de verdad eso saldría a internet; acá sólo se registra que se
/// llamó, que es lo que importa comprobar.
class _SesionDePrueba extends SesionNotifier {
  int vecesQueRestauro = 0;

  /// Simula que refrescar la sesion falla: es un segundo viaje a la red.
  bool falla = false;

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
  Future<void> restaurar() async {
    vecesQueRestauro += 1;
    if (falla) throw Exception('sin red al refrescar la sesion');
  }
}

void main() {
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    final vista = TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    vista.physicalSize = const Size(390, 844);
    vista.devicePixelRatio = 1;
  });

  late _RepoDeAlta repo;
  late _SesionDePrueba sesion;

  Widget pantalla() {
    repo = _RepoDeAlta();
    sesion = _SesionDePrueba();
    return ProviderScope(
      overrides: [
        sellerRepositoryProvider.overrideWithValue(repo),
        sesionProvider.overrideWith(() => sesion),
      ],
      child: MaterialApp(theme: buildAppTheme(), home: const SellerHomeScreen()),
    );
  }

  Future<void> crearTienda(WidgetTester tester) async {
    await tester.enterText(find.byType(TextField), 'Tejidos del Sur');
    await tester.tap(find.text('Crear mi tienda'));
    await tester.pumpAndSettle();
  }

  group('Alta de tienda', () {
    testWidgets('al principio se ofrece crear la tienda', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();

      expect(find.text('Empezá a vender'), findsOneWidget);
      expect(find.text('Crear mi tienda'), findsOneWidget);
    });

    /// ═══════════════════════════════════════════════════════════════════════
    /// EL TEST DEL BUG
    /// ═══════════════════════════════════════════════════════════════════════
    ///
    /// Después de crear, la pantalla tiene que mostrar la tienda. Sin cerrar
    /// sesión, sin reiniciar la app, sin volver atrás y entrar de nuevo.
    testWidgets('⛔ después de crear, la pantalla pasa a Mi tienda', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();

      await crearTienda(tester);

      expect(repo.vecesQueCreo, 1);
      // Y lo que importa: el formulario ya no está.
      expect(find.text('Empezá a vender'), findsNothing);
      expect(find.text('Crear mi tienda'), findsNothing);
      // El panel del vendedor. El titulo se dibuja en mayusculas.
      expect(find.text('MIS PRODUCTOS'), findsOneWidget);
      expect(find.text('Tejidos del Sur'), findsWidgets);
    });

    /// Volver a preguntarle al servidor es lo que hace que la pantalla cambie.
    /// Si nadie refresca, la pantalla se queda con el `null` de antes para
    /// siempre.
    testWidgets('⛔ después de crear se vuelve a pedir el perfil', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      final antes = repo.vecesQuePreguntoElPerfil;

      await crearTienda(tester);

      expect(repo.vecesQuePreguntoElPerfil, greaterThan(antes));
    });

    /// El rol del usuario pasó a `seller` en la base y la app lo lee de ahí
    /// para habilitar pantallas. Sin refrescar la sesión, seguiría creyendo
    /// que es comprador hasta la próxima vez que abra la app.
    testWidgets('la sesión se refresca para que el rol llegue a la app', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();

      await crearTienda(tester);

      expect(sesion.vecesQueRestauro, greaterThanOrEqualTo(1));
    });

    testWidgets('avisa que salió bien', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'Tejidos del Sur');
      await tester.tap(find.text('Crear mi tienda'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.textContaining('Ya podés cargar productos'), findsOneWidget);
    });
  });

  group('Cuando el alta falla', () {
    /// ⛔ Un fallo NO puede parecerse a un éxito.
    ///
    /// Es la otra mitad del bug: si la pantalla cambiara igual, la persona
    /// creería que tiene una tienda que no existe, y el error aparecería
    /// después, en cualquier otro lado.
    testWidgets('⛔ con un error, la pantalla NO pasa a Mi tienda', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      repo.fallaAlCrear = ComercioException('No se pudo', codigo: 'INTERNAL_ERROR');

      await crearTienda(tester);

      expect(find.text('Empezá a vender'), findsOneWidget);
      expect(find.text('MIS PRODUCTOS'), findsNothing);
    });

    testWidgets('el error se le muestra a la persona', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      repo.fallaAlCrear = ComercioException('El nombre ya está en uso', codigo: 'SLUG_TAKEN');

      await tester.enterText(find.byType(TextField), 'Tejidos del Sur');
      await tester.tap(find.text('Crear mi tienda'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.textContaining('ya está en uso'), findsOneWidget);
    });

    /// Sin nombre no se sale a la red siquiera: es un error que se puede
    /// contestar sin molestar al servidor.
    testWidgets('⛔ sin nombre no se intenta crear', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();

      await tester.tap(find.text('Crear mi tienda'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(repo.vecesQueCreo, 0);
      expect(find.text('Empezá a vender'), findsOneWidget);
    });
  });

  group('Cuando el alta sale bien pero algo posterior falla', () {
    /// ═══════════════════════════════════════════════════════════════════════
    /// LA TIENDA SE CREÓ. LA PANTALLA TIENE QUE MOSTRARLA IGUAL
    /// ═══════════════════════════════════════════════════════════════════════
    ///
    /// Después de crear, la app refresca la sesión para que el rol `seller`
    /// llegue al resto de las pantallas. Es un segundo viaje a la red, y puede
    /// fallar por su cuenta: un arranque en frío, una latencia alta, un corte
    /// de un segundo.
    ///
    /// Si ese fallo impidiera refrescar el perfil, el resultado sería el peor
    /// posible: la tienda EXISTE en la base, pero la persona sigue viendo
    /// «Empezá a vender». Toca el botón otra vez y ahora sí recibe un error de
    /// que ya tiene una tienda — que no puede ver.
    ///
    /// El refresco del perfil es lo que hace cambiar la pantalla, así que no
    /// puede depender de que otra cosa salga bien.
    testWidgets('⛔ si refrescar la sesión falla, la pantalla igual muestra la tienda',
        (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      sesion.falla = true;

      await crearTienda(tester);

      expect(repo.vecesQueCreo, 1, reason: 'la tienda se creó');
      expect(find.text('Empezá a vender'), findsNothing);
      expect(find.text('MIS PRODUCTOS'), findsOneWidget);
    });

    testWidgets('⛔ y el perfil se vuelve a pedir aunque la sesión falle', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      sesion.falla = true;
      final antes = repo.vecesQuePreguntoElPerfil;

      await crearTienda(tester);

      expect(repo.vecesQuePreguntoElPerfil, greaterThan(antes));
    });
  });

  /// La tienda aparece SIN esperar un segundo viaje.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// EL RETRASO QUE QUEDABA, Y POR QUÉ NO SE VEÍA EN LOS TESTS
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// El arreglo anterior movió `ref.invalidate` antes del refresco de sesión, y
  /// resolvió el caso en que la sesión fallaba. Pero seguía habiendo un viaje de
  /// más: invalidar deja el provider en `loading` y dispara un `GET /sellers/me`
  /// para traer el vendedor y la tienda que la respuesta del `POST` **ya tenía**.
  ///
  /// En un test ese GET contesta al instante y no se nota. En un teléfono contra
  /// Railway, con 650 ms de latencia a la base, son varios segundos con la
  /// pantalla en el spinner después de tocar «Crear mi tienda» — suficiente para
  /// pensar que no funcionó y cerrar la app.
  ///
  /// Estos tests hacen que el GET **no conteste** o **falle**. Ahí la diferencia
  /// entre usar la respuesta del POST y volver a preguntar deja de ser
  /// invisible.
  group('La tienda se ve sin esperar el GET', () {
    /// ⛔ EL TEST DEL RETRASO.
    ///
    /// El `GET /sellers/me` no contesta NUNCA. Si la pantalla dependiera de él,
    /// se quedaría en el spinner para siempre — que es exactamente lo que se
    /// sentía en el teléfono, sólo que ahí terminaba contestando.
    testWidgets('⛔ aunque el GET no conteste nunca, la tienda se ve', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      repo.cuelgaAlPreguntar = true;

      await tester.enterText(find.byType(TextField), 'Tejidos del Sur');
      await tester.tap(find.text('Crear mi tienda'));
      // Sin `pumpAndSettle`: con un futuro colgado no habría nada que asentar.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.text('Empezá a vender'), findsNothing);
      expect(find.text('MIS PRODUCTOS'), findsOneWidget);
      expect(find.text('Tejidos del Sur'), findsWidgets);
    });

    /// ⛔ Y si el GET falla, la tienda TAMPOCO puede desaparecer.
    ///
    /// El `POST` devolvió 201: la tienda existe. Que un refresco de cortesía no
    /// llegue no puede borrarla de la pantalla y devolver a la persona al
    /// formulario que acaba de completar.
    testWidgets('⛔ si la reconciliación falla, la tienda sigue visible', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      repo.fallaAlPreguntar = true;

      await crearTienda(tester);

      expect(find.text('Empezá a vender'), findsNothing);
      expect(find.text('MIS PRODUCTOS'), findsOneWidget);
    });

    /// El alta es UNA sola, pase lo que pase con el refresco.
    ///
    /// Es lo que evita la segunda tienda por reintento: si la pantalla volviera
    /// al formulario, la persona tocaría el botón otra vez.
    testWidgets('⛔ no se crea una segunda tienda por el reintento del usuario', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      repo.fallaAlPreguntar = true;

      await crearTienda(tester);

      // El formulario ya no existe, así que no hay botón que volver a tocar.
      expect(find.text('Crear mi tienda'), findsNothing);
      expect(repo.vecesQueCreo, 1);
    });
  });
}
