import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/features/auth/domain/session.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';
import 'package:vendox/features/seller/data/cambios_de_estado.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';
import 'package:vendox/features/seller/domain/estado_optimista.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';

/// Publicar y pausar un producto.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO MEDIDO EN EL TELÉFONO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Pausar un producto publicado: ~5 s. Volver a publicarlo: ~8 s. Y todo ese
/// rato el botón seguía diciendo lo de antes.
///
/// Publicar o pausar es un interruptor: la persona ya decidió, lo único que
/// falta es que el servidor lo anote.
void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    // recargarLaTienda despierta el perfil del vendedor, y eso construye el
    // cliente HTTP, que lee la URL guardada. No sale a la red: el repositorio
    // esta doblado.
    SharedPreferences.setMockInitialValues({});
    await RuntimeConfig.load();
  });

  group('El estado que se ve', () {
    test('sin cambios pendientes, manda el servidor', () {
      const c = CambiosDeEstado();
      expect(c.estadoDe(_producto('prd_1', 'DRAFT')), 'DRAFT');
    });

    /// ⛔ EL EFECTO INMEDIATO.
    test('⛔ apenas cambia, se ve el estado nuevo', () {
      final c = const CambiosDeEstado().con('prd_1', 'ACTIVE');
      expect(c.estadoDe(_producto('prd_1', 'DRAFT')), 'ACTIVE');
    });

    /// Un cambio de otro producto no toca a éste.
    test('el pendiente es por producto', () {
      final c = const CambiosDeEstado().con('prd_2', 'ACTIVE');
      expect(c.estadoDe(_producto('prd_1', 'DRAFT')), 'DRAFT');
    });
  });

  group('El contador del plan', () {
    /// ⛔ PUBLICAR SUMA UNO, Y SE VE AL INSTANTE.
    ///
    /// Sin esto el chip cambiaba en el mismo frame y «2 de 3» seguía diciendo
    /// lo mismo unos segundos: dos partes de la misma pantalla contando cosas
    /// distintas.
    test('⛔ publicar suma uno al conteo visible', () {
      final visible = catalogoVisible(
        delServidor: const EstadoDelCatalogo(publicados: 2, limite: 3, puedePublicar: true),
        productos: [_producto('prd_1', 'DRAFT')],
        cambios: const CambiosDeEstado().con('prd_1', 'ACTIVE'),
      );

      expect(visible!.publicados, 3);
      expect(visible.puedePublicar, isFalse, reason: 'con 3 de 3 ya no entra otro');
    });

    /// ⛔ Y pausar resta uno, que es lo que libera el cupo.
    test('⛔ pausar resta uno y libera el cupo', () {
      final visible = catalogoVisible(
        delServidor: const EstadoDelCatalogo(publicados: 3, limite: 3, puedePublicar: false),
        productos: [_producto('prd_1', 'ACTIVE')],
        cambios: const CambiosDeEstado().con('prd_1', 'PAUSED'),
      );

      expect(visible!.publicados, 2);
      expect(visible.puedePublicar, isTrue);
    });

    /// ⛔ Un cambio que NO altera el estado publicado no mueve el contador.
    ///
    /// Pasar de `DRAFT` a `PAUSED` no publica nada. Sumar por cualquier cambio
    /// sería exactamente el número inventado que no se quiere.
    test('⛔ de borrador a pausado no cambia el conteo', () {
      final visible = catalogoVisible(
        delServidor: const EstadoDelCatalogo(publicados: 2, limite: 3, puedePublicar: true),
        productos: [_producto('prd_1', 'DRAFT')],
        cambios: const CambiosDeEstado().con('prd_1', 'PAUSED'),
      );

      expect(visible!.publicados, 2);
    });

    /// Sin tope, no hay nada que mostrar y no se inventa.
    test('sin catálogo del servidor devuelve null', () {
      expect(
        catalogoVisible(
          delServidor: null,
          productos: [_producto('prd_1', 'DRAFT')],
          cambios: const CambiosDeEstado().con('prd_1', 'ACTIVE'),
        ),
        isNull,
      );
    });

    /// ⛔ Y NO se recuenta desde cero sobre la página que se está viendo.
    ///
    /// La lista de la pantalla es UNA página; el conteo del servidor abarca el
    /// catálogo entero. Contar acá daría un número más chico apenas alguien
    /// tenga más productos que los que entran en una página.
    test('⛔ parte del número del servidor, no de la página visible', () {
      final visible = catalogoVisible(
        // El servidor dice 20 publicados; la página trae uno solo.
        delServidor: const EstadoDelCatalogo(publicados: 20, limite: null, puedePublicar: true),
        productos: [_producto('prd_1', 'ACTIVE')],
        cambios: const CambiosDeEstado().con('prd_1', 'PAUSED'),
      );

      expect(visible!.publicados, 19);
    });
  });

  group('Cambiar de verdad', () {
    late _RepoDeEstado repo;

    ProviderContainer contenedor() {
      repo = _RepoDeEstado();
      final c = ProviderContainer(
        overrides: [
          sellerRepositoryProvider.overrideWithValue(repo),
          // El perfil del vendedor observa la sesion, y esa sale al llavero.
          // Aca no interesa: lo que se prueba es el estado del producto.
          sesionProvider.overrideWith(_Sesion.new),
        ],
      );
      addTearDown(c.dispose);
      return c;
    }

    /// ⛔ El pendiente se ve antes de que el servidor conteste.
    test('⛔ el estado nuevo se ve sin esperar al servidor', () async {
      final c = contenedor();
      repo.cuelga = true;

      unawaited(c.read(cambiosDeEstadoProvider.notifier).cambiar(
            productId: 'prd_1',
            nuevo: 'ACTIVE',
          ));
      await Future<void>.delayed(Duration.zero);

      expect(c.read(cambiosDeEstadoProvider).estadoDe(_producto('prd_1', 'DRAFT')), 'ACTIVE');
    });

    /// ⛔ Un segundo toque mientras el primero viaja NO manda otro `PATCH`.
    ///
    /// Sin esto, dos toques rápidos mandan dos peticiones y el estado final lo
    /// decide el orden en que contesten, que no es el orden en que se tocó.
    test('⛔ dos toques seguidos mandan un solo PATCH', () async {
      final c = contenedor();
      repo.cuelga = true;
      final n = c.read(cambiosDeEstadoProvider.notifier);

      unawaited(n.cambiar(productId: 'prd_1', nuevo: 'ACTIVE'));
      unawaited(n.cambiar(productId: 'prd_1', nuevo: 'PAUSED'));
      await Future<void>.delayed(Duration.zero);

      expect(repo.veces, 1);
    });

    /// ⛔ EL ROLLBACK: si el servidor rechaza, vuelve a como estaba.
    ///
    /// Es el caso del tope del plan Free: publicar el cuarto producto lo
    /// rechaza el backend, y el interruptor tiene que volver.
    test('⛔ si el servidor rechaza, el estado vuelve', () async {
      final c = contenedor();
      repo.falla = true;

      await expectLater(
        c.read(cambiosDeEstadoProvider.notifier).cambiar(productId: 'prd_1', nuevo: 'ACTIVE'),
        throwsA(anything),
      );

      expect(c.read(cambiosDeEstadoProvider).estadoDe(_producto('prd_1', 'DRAFT')), 'DRAFT');
      expect(c.read(cambiosDeEstadoProvider).enCurso('prd_1'), isFalse);
    });

    /// Y después de fallar se puede volver a intentar.
    test('después de fallar, el siguiente intento sale', () async {
      final c = contenedor();
      final n = c.read(cambiosDeEstadoProvider.notifier);
      repo.falla = true;

      await n.cambiar(productId: 'prd_1', nuevo: 'ACTIVE').catchError((_) => null);
      repo.falla = false;
      await n.cambiar(productId: 'prd_1', nuevo: 'ACTIVE');

      expect(repo.veces, 2);
    });
  });
}

Producto _producto(String id, String status) => Producto.fromJson({
      'id': id,
      'name': 'Campera',
      'slug': 'campera',
      'status': status,
      'basePriceCents': 150000,
    });

class _RepoDeEstado extends Fake implements SellerRepository {
  int veces = 0;
  bool cuelga = false;
  bool falla = false;

  @override
  Future<Producto> actualizarProducto(
    String id, {
    String? name,
    String? description,
    int? basePriceCents,
    int? compareAtPriceCents,
    String? status,
    String? categoryId,
  }) async {
    veces += 1;
    if (cuelga) return Completer<Producto>().future;
    if (falla) throw ComercioException('Llegaste al tope de tu plan.');
    return _producto(id, status ?? 'DRAFT');
  }

  @override
  Future<PerfilVendedor?> miPerfil() async => null;

  @override
  Future<Pagina<Producto>> misProductos({String? cursor, int limit = 20}) async =>
      const Pagina(items: []);
}

/// Una sesión abierta que no toca el llavero.
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
