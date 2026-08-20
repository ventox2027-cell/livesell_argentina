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
///
/// ═══════════════════════════════════════════════════════════════════════════
/// Y EL CUARTO PRODUCTO DEL PLAN FREE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La primera versión del optimismo aplicaba el cambio SIEMPRE. Publicar el
/// cuarto se veía publicado, con su «Ya lo pueden comprar», y dos segundos más
/// tarde el rechazo del backend lo deshacía.
///
/// El estado intermedio era el problema: durante esos segundos la app afirmaba
/// algo falso sobre si el producto de alguien estaba a la venta.
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
      final c = const CambiosDeEstado().con('prd_1', antes: 'DRAFT', despues: 'ACTIVE');
      expect(c.estadoDe(_producto('prd_1', 'DRAFT')), 'ACTIVE');
    });

    /// Un cambio de otro producto no toca a éste.
    test('el pendiente es por producto', () {
      final c = const CambiosDeEstado().con('prd_2', antes: 'DRAFT', despues: 'ACTIVE');
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
        cambios: const CambiosDeEstado().con('prd_1', antes: 'DRAFT', despues: 'ACTIVE'),
      );

      expect(visible!.publicados, 3);
      expect(visible.puedePublicar, isFalse, reason: 'con 3 de 3 ya no entra otro');
    });

    /// ⛔ Y pausar resta uno, que es lo que libera el cupo.
    test('⛔ pausar resta uno y libera el cupo', () {
      final visible = catalogoVisible(
        delServidor: const EstadoDelCatalogo(publicados: 3, limite: 3, puedePublicar: false),
        cambios: const CambiosDeEstado().con('prd_1', antes: 'ACTIVE', despues: 'PAUSED'),
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
        cambios: const CambiosDeEstado().con('prd_1', antes: 'DRAFT', despues: 'PAUSED'),
      );

      expect(visible!.publicados, 2);
    });

    /// Sin tope, no hay nada que mostrar y no se inventa.
    test('sin catálogo del servidor devuelve null', () {
      expect(
        catalogoVisible(
          delServidor: null,
          cambios: const CambiosDeEstado().con('prd_1', antes: 'DRAFT', despues: 'ACTIVE'),
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
        cambios: const CambiosDeEstado().con('prd_1', antes: 'ACTIVE', despues: 'PAUSED'),
      );

      expect(visible!.publicados, 19);
    });

    /**
     * ⛔ Y CUENTA UN PRODUCTO QUE NO ESTÁ EN LA PÁGINA CARGADA.
     *
     * Antes la diferencia se deducía comparando contra la lista en pantalla:
     * si el producto no estaba ahí, el cambio no sumaba ni restaba nada y el
     * cupo quedaba corrido. Con el «antes» guardado en el cambio, la cuenta
     * sale del cambio mismo.
     */
    test('⛔ el cupo no depende de que el producto esté en la lista visible', () {
      final visible = catalogoVisible(
        delServidor: const EstadoDelCatalogo(publicados: 2, limite: 3, puedePublicar: true),
        // Ninguna lista de por medio: sólo el cambio.
        cambios: const CambiosDeEstado().con('prd_fuera_de_pagina',
            antes: 'PAUSED', despues: 'ACTIVE'),
      );

      expect(visible!.publicados, 3);
      expect(visible.puedePublicar, isFalse);
    });

    /// Dos cambios a la vez se suman entre sí.
    test('dos cambios en vuelo se compensan', () {
      final visible = catalogoVisible(
        delServidor: const EstadoDelCatalogo(publicados: 3, limite: 3, puedePublicar: false),
        cambios: const CambiosDeEstado()
            .con('prd_1', antes: 'ACTIVE', despues: 'PAUSED')
            .con('prd_2', antes: 'DRAFT', despues: 'ACTIVE'),
      );

      expect(visible!.publicados, 3);
    });
  });

  group('Cuándo se deja publicar', () {
    const lleno = EstadoDelCatalogo(publicados: 3, limite: 3, puedePublicar: false);
    const conLugar = EstadoDelCatalogo(publicados: 2, limite: 3, puedePublicar: true);

    test('con lugar, se puede', () {
      expect(
        motivoParaNoPublicar(catalogo: conLugar, actual: 'DRAFT', nuevo: 'ACTIVE'),
        isNull,
      );
    });

    /// ⛔ EL CUARTO NO.
    test('⛔ sin lugar, publicar se bloquea', () {
      expect(
        motivoParaNoPublicar(catalogo: lleno, actual: 'DRAFT', nuevo: 'ACTIVE'),
        MotivoDeBloqueo.cupoDelPlanLleno,
      );
    });

    /// Pausar nunca se bloquea: es justo lo que libera un lugar.
    test('⛔ estando lleno, pausar sigue permitido', () {
      expect(motivoParaNoPublicar(catalogo: lleno, actual: 'ACTIVE', nuevo: 'PAUSED'), isNull);
    });

    /**
     * ⛔ Y GUARDAR ALGO YA PUBLICADO TAMPOCO.
     *
     * Republicar lo que ya está publicado no ocupa un lugar nuevo. Sin esta
     * excepción, con el catálogo lleno no se podría corregir un precio mal
     * puesto: el vendedor Free quedaría con su catálogo congelado.
     */
    test('⛔ estando lleno, se puede seguir editando lo ya publicado', () {
      expect(motivoParaNoPublicar(catalogo: lleno, actual: 'ACTIVE', nuevo: 'ACTIVE'), isNull);
    });

    /**
     * ⛔ SI NO SABEMOS EL CUPO, NO SE BLOQUEA.
     *
     * Pasa cuando el listado todavía no llegó o falló. Bloquear por un dato
     * que no tenemos le impediría publicar a alguien que sí puede, y sin forma
     * de entender por qué. Dejar pasar termina en el rechazo del backend, que
     * es molesto pero no rompe nada.
     */
    test('⛔ sin saber el cupo, se deja pasar y decide el servidor', () {
      expect(motivoParaNoPublicar(catalogo: null, actual: 'DRAFT', nuevo: 'ACTIVE'), isNull);
    });

    /// El mensaje dice el número del plan, y no lo tiene escrito adentro.
    test('el mensaje usa el límite que mandó el servidor', () {
      final texto = mensajeDeBloqueo(MotivoDeBloqueo.cupoDelPlanLleno, lleno);

      expect(texto, contains('límite de 3 productos publicados'));
      expect(texto, contains('Free'));
      expect(
        mensajeDeBloqueo(
          MotivoDeBloqueo.cupoDelPlanLleno,
          const EstadoDelCatalogo(publicados: 10, limite: 10, puedePublicar: false),
        ),
        contains('límite de 10 productos publicados'),
      );
    });
  });

  group('Cambiar de verdad', () {
    late _RepoDeEstado repo;

    ProviderContainer contenedor({EstadoDelCatalogo? catalogo}) {
      repo = _RepoDeEstado(catalogo: catalogo);
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
            actual: 'DRAFT',
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

      unawaited(n.cambiar(productId: 'prd_1', actual: 'DRAFT', nuevo: 'ACTIVE'));
      unawaited(n.cambiar(productId: 'prd_1', actual: 'DRAFT', nuevo: 'PAUSED'));
      await Future<void>.delayed(Duration.zero);

      expect(repo.veces, 1);
    });

    /// ⛔ EL ROLLBACK: si el servidor rechaza, vuelve a como estaba.
    test('⛔ si el servidor rechaza, el estado vuelve', () async {
      final c = contenedor();
      repo.falla = true;

      await expectLater(
        c.read(cambiosDeEstadoProvider.notifier).cambiar(
              productId: 'prd_1',
              actual: 'DRAFT',
              nuevo: 'ACTIVE',
            ),
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

      await n
          .cambiar(productId: 'prd_1', actual: 'DRAFT', nuevo: 'ACTIVE')
          .catchError((_) => null);
      repo.falla = false;
      await n.cambiar(productId: 'prd_1', actual: 'DRAFT', nuevo: 'ACTIVE');

      expect(repo.veces, 2);
    });
  });

  group('El tope del plan Free, de punta a punta', () {
    late _RepoDeEstado repo;

    ProviderContainer contenedorCon(EstadoDelCatalogo catalogo) {
      repo = _RepoDeEstado(catalogo: catalogo);
      final c = ProviderContainer(
        overrides: [
          sellerRepositoryProvider.overrideWithValue(repo),
          sesionProvider.overrideWith(_Sesion.new),
        ],
      );
      addTearDown(c.dispose);
      return c;
    }

    Future<ProviderContainer> conCatalogo(EstadoDelCatalogo catalogo) async {
      final c = contenedorCon(catalogo);
      await c.read(misProductosProvider.future);
      return c;
    }

    /// Los tres que sí entran. Publicar tiene que seguir siendo instantáneo.
    for (final (publicados, cual) in [(0, 'primero'), (1, 'segundo'), (2, 'tercero')]) {
      test('con $publicados publicados, el $cual sale sin trabas', () async {
        final c = await conCatalogo(
          EstadoDelCatalogo(publicados: publicados, limite: 3, puedePublicar: true),
        );
        final n = c.read(cambiosDeEstadoProvider.notifier);

        await n.cambiar(productId: 'prd_x', actual: 'DRAFT', nuevo: 'ACTIVE');

        expect(repo.veces, 1);
      });
    }

    /**
     * ⛔ EL BUG QUE SE ESTÁ ARREGLANDO.
     *
     * Con 3 de 3, tocar «Publicar» en el cuarto NO puede verse publicado ni un
     * frame. Antes se veía publicado, se anunciaba «Ya lo pueden comprar», y
     * dos segundos después el backend lo deshacía.
     */
    test('⛔ el cuarto se frena en el cliente, sin viajar y sin verse publicado', () async {
      final c = await conCatalogo(
        const EstadoDelCatalogo(publicados: 3, limite: 3, puedePublicar: false),
      );
      final n = c.read(cambiosDeEstadoProvider.notifier);

      await expectLater(
        n.cambiar(productId: 'prd_4', actual: 'DRAFT', nuevo: 'ACTIVE'),
        throwsA(
          isA<ComercioException>()
              .having((e) => e.codigo, 'codigo', codigoDeCupoLleno)
              .having((e) => e.mensaje, 'mensaje', contains('límite de 3 productos')),
        ),
      );

      expect(repo.veces, 0, reason: 'no se manda un PATCH que ya sabemos que va a fallar');
      expect(
        c.read(cambiosDeEstadoProvider).estadoDe(_producto('prd_4', 'DRAFT')),
        'DRAFT',
        reason: 'ni un frame publicado',
      );
      expect(c.read(cambiosDeEstadoProvider).enCurso('prd_4'), isFalse);
    });

    /**
     * ⛔ PAUSAR LIBERA EL LUGAR AL INSTANTE.
     *
     * Sin esperar ningún refetch: mientras la pausa viaja, el contador ya dice
     * 2 de 3 y el siguiente producto se puede publicar.
     */
    test('⛔ pausar uno deja publicar otro sin esperar al servidor', () async {
      final c = await conCatalogo(
        const EstadoDelCatalogo(publicados: 3, limite: 3, puedePublicar: false),
      );
      final n = c.read(cambiosDeEstadoProvider.notifier);
      repo.cuelga = true;

      unawaited(n.cambiar(productId: 'prd_1', actual: 'ACTIVE', nuevo: 'PAUSED'));
      await Future<void>.delayed(Duration.zero);

      expect(c.read(cupoVisibleProvider)!.publicados, 2);
      expect(c.read(cupoVisibleProvider)!.puedePublicar, isTrue);
      expect(
        n.porQueNoSePuedePublicar(actual: 'DRAFT', nuevo: 'ACTIVE'),
        isNull,
        reason: 'el lugar ya está libre, aunque la pausa todavía viaje',
      );
    });

    /**
     * ⛔ Y NO SE LIBERAN DOS LUGARES POR UNA SOLA PAUSA.
     *
     * Con 3 de 3, pausar uno deja lugar para UNO. Si el segundo también
     * pasara, el optimismo permitiría llegar a 4 publicados.
     */
    test('⛔ una pausa libera un lugar, no dos', () async {
      final c = await conCatalogo(
        const EstadoDelCatalogo(publicados: 3, limite: 3, puedePublicar: false),
      );
      final n = c.read(cambiosDeEstadoProvider.notifier);
      repo.cuelga = true;

      unawaited(n.cambiar(productId: 'prd_1', actual: 'ACTIVE', nuevo: 'PAUSED'));
      unawaited(n.cambiar(productId: 'prd_2', actual: 'DRAFT', nuevo: 'ACTIVE'));
      await Future<void>.delayed(Duration.zero);

      expect(c.read(cupoVisibleProvider)!.publicados, 3);
      expect(
        n.porQueNoSePuedePublicar(actual: 'DRAFT', nuevo: 'ACTIVE'),
        MotivoDeBloqueo.cupoDelPlanLleno,
      );
    });

    /**
     * ⛔ DOS PUBLICACIONES CASI SIMULTÁNEAS NO PASAN DE TRES.
     *
     * Son dos productos distintos, así que el freno del doble toque —que es por
     * producto— no las alcanza. Lo que las frena es que el cupo en vuelo ya
     * cuenta la primera cuando se evalúa la segunda.
     *
     * ⚠️ Esto NO es lo que hace cumplir la regla: el backend serializa con su
     * cerrojo por vendedor y rechaza igual. Es que la pantalla no muestre un
     * estado que el servidor va a deshacer.
     */
    test('⛔ dos publicaciones a la vez no llegan a cuatro', () async {
      final c = await conCatalogo(
        const EstadoDelCatalogo(publicados: 2, limite: 3, puedePublicar: true),
      );
      final n = c.read(cambiosDeEstadoProvider.notifier);
      repo.cuelga = true;

      unawaited(n.cambiar(productId: 'prd_3', actual: 'DRAFT', nuevo: 'ACTIVE'));
      await Future<void>.delayed(Duration.zero);

      await expectLater(
        n.cambiar(productId: 'prd_4', actual: 'DRAFT', nuevo: 'ACTIVE'),
        throwsA(isA<ComercioException>()),
      );

      expect(repo.veces, 1, reason: 'sólo la primera viajó');
      expect(c.read(cupoVisibleProvider)!.publicados, 3);
    });

    /**
     * ⛔ ESTADO LOCAL VIEJO: EL BACKEND MANDA, Y EL CONTADOR SE CORRIGE.
     *
     * La app cree que tiene 2 de 3 —el catálogo cambió desde otro teléfono— y
     * el backend rechaza. Tiene que quedar: el producto como estaba, el mensaje
     * del límite, y el contador diciendo la verdad nueva.
     */
    test('⛔ con el cupo desactualizado, el rechazo deja todo coherente', () async {
      final c = await conCatalogo(
        const EstadoDelCatalogo(publicados: 2, limite: 3, puedePublicar: true),
      );
      final n = c.read(cambiosDeEstadoProvider.notifier);

      // El servidor rechaza, y a partir de ahora informa el número real.
      repo.rechazaPorCupo = true;
      repo.catalogo = const EstadoDelCatalogo(publicados: 3, limite: 3, puedePublicar: false);

      await expectLater(
        n.cambiar(productId: 'prd_4', actual: 'DRAFT', nuevo: 'ACTIVE'),
        throwsA(
          isA<ComercioException>().having((e) => e.codigo, 'codigo', codigoDeCupoLleno),
        ),
      );

      expect(repo.veces, 1, reason: 'este sí viajó: la app no tenía cómo saberlo');
      expect(c.read(cambiosDeEstadoProvider).estadoDe(_producto('prd_4', 'DRAFT')), 'DRAFT');

      // El refresco del contador va por atrás, para que el error se vea ya.
      await pumpEventQueue();
      expect(c.read(cupoVisibleProvider)!.publicados, 3);
      expect(c.read(cupoVisibleProvider)!.puedePublicar, isFalse);
      expect(
        n.porQueNoSePuedePublicar(actual: 'DRAFT', nuevo: 'ACTIVE'),
        MotivoDeBloqueo.cupoDelPlanLleno,
        reason: 'el siguiente intento ya se frena en el cliente',
      );
    });

    /**
     * Un fallo que NO es del cupo no dispara ningún refresco.
     *
     * Se cortó la red: pedir el listado otra vez sólo agrega una petición que
     * también va a fallar.
     */
    test('un fallo de red no dispara refrescos', () async {
      final c = await conCatalogo(
        const EstadoDelCatalogo(publicados: 1, limite: 3, puedePublicar: true),
      );
      final pedidosDeListado = repo.listados;
      repo.falla = true;

      await expectLater(
        c.read(cambiosDeEstadoProvider.notifier).cambiar(
              productId: 'prd_2',
              actual: 'DRAFT',
              nuevo: 'ACTIVE',
            ),
        throwsA(anything),
      );
      await pumpEventQueue();

      expect(repo.listados, pedidosDeListado);
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
  _RepoDeEstado({this.catalogo});

  int veces = 0;

  /// Cuántas veces se pidió el listado. Sirve para ver si algo lo refrescó.
  int listados = 0;

  bool cuelga = false;
  bool falla = false;

  /// Rechaza como lo hace el backend cuando el vendedor llegó al tope.
  bool rechazaPorCupo = false;

  /// Lo que el servidor dice del cupo. Se puede cambiar entre llamadas para
  /// simular que el catálogo se movió desde otro lado.
  EstadoDelCatalogo? catalogo;

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
    if (rechazaPorCupo) {
      throw ComercioException(
        'Llegaste al límite de 3 productos publicados del plan Free.',
        codigo: codigoDeCupoLleno,
      );
    }
    if (falla) throw ComercioException('Llegaste al tope de tu plan.');
    return _producto(id, status ?? 'DRAFT');
  }

  @override
  Future<PerfilVendedor?> miPerfil() async => null;

  @override
  Future<Pagina<Producto>> misProductos({String? cursor, int limit = 20}) async {
    listados += 1;
    return Pagina(items: const [], catalogo: catalogo);
  }
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
