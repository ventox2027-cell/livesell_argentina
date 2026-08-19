import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/core/design/theme.dart';
import 'package:vendox/features/auth/domain/session.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';
import 'package:vendox/features/inventory/data/inventory_repository.dart';
import 'package:vendox/features/inventory/domain/inventory_models.dart';
import 'package:vendox/features/seller/data/borrados_en_curso.dart';
import 'package:vendox/features/seller/data/categorias_api.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';
import 'package:vendox/features/seller/data/tasas_api.dart';
import 'package:vendox/features/seller/domain/borrado_optimista.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';
import 'package:vendox/features/seller/presentation/seller_home_screen.dart';

/// Borrar un producto se ve al instante.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE SE MIDIÓ EN UN TELÉFONO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Tocar «Borrar», confirmar, y esperar unos cuatro segundos con el editor
/// abierto y el producto a la vista. Dos viajes a Railway en fila: el `DELETE`,
/// que el editor esperaba antes de cerrarse, y el `GET /products/mine` que Mi
/// tienda disparaba al volver, con su spinner de cuerpo entero.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ CASI TODOS ESTOS TESTS DEJAN EL `DELETE` COLGADO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Porque si el `DELETE` contesta rápido —como contesta un doble falso— el
/// código viejo y el nuevo se ven exactamente igual. La diferencia entre
/// esperar la respuesta y no esperarla sólo existe mientras la respuesta no
/// llegó.
///
/// Con `cuelgaAlBorrar`, el servidor nunca contesta. Ahí, o el producto
/// desapareció solo, o no desapareció nunca.
void main() {
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    /// Una superficie más ancha que un teléfono, a propósito.
    ///
    /// La fuente de los tests dibuja cada carácter como un cuadrado del alto de
    /// la letra, o sea casi el doble de ancho que una tipografía real. El
    /// desglose de precio del editor —«Comisión de VendoX», «Recibís»— se pasa
    /// del ancho por eso y por nada más, y el framework lo cuenta como una
    /// excepción de layout que hace fallar el test.
    ///
    /// Acá no se está probando cómo entra el texto, sino qué pasa cuando se
    /// borra. Lo que se mide —qué producto está y cuál no— no depende del
    /// ancho. Las pantallas que SÍ prueban disposición usan 390x844.
    final vista = TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    vista.physicalSize = const Size(900, 1600);
    vista.devicePixelRatio = 1;
  });

  group('El listado visible', () {
    /// Sólo se van los marcados.
    test('esconde los que se están borrando y deja el resto', () {
      final pagina = _pagina(['p1', 'p2', 'p3']);
      final borrados = const BorradosEnCurso().empezando('p2');

      final visible = sinLosQueSeBorran(pagina, borrados);

      expect(visible.items.map((p) => p.id), ['p1', 'p3']);
    });

    /// ⛔ EL CONTADOR DEL PLAN NO SE TOCA.
    ///
    /// Restarle uno a «3 de 3 productos publicados» acá sería inventar un cupo.
    /// Ese número lo dice el servidor —ver `EstadoDelCatalogo`— y la
    /// reconciliación lo trae apenas confirma el borrado.
    ///
    /// Si esto se «arreglara», el vendedor vería un lugar libre que puede no
    /// existir, y el error aparecería recién al intentar publicar.
    test('⛔ no le resta uno al cupo del plan por su cuenta', () {
      final pagina = _pagina(['p1', 'p2', 'p3'], publicados: 3, limite: 3);
      final visible = sinLosQueSeBorran(pagina, const BorradosEnCurso().empezando('p2'));

      expect(visible.items.length, 2);
      expect(visible.catalogo!.publicados, 3, reason: 'el conteo lo dice el servidor');
      expect(visible.catalogo!.puedePublicar, isFalse);
    });

    /// La paginación no se mueve por esconder una fila.
    test('conserva el cursor', () {
      final pagina = _pagina(['p1', 'p2'], cursor: 'cur_123');
      expect(sinLosQueSeBorran(pagina, const BorradosEnCurso().empezando('p1')).nextCursor,
          'cur_123');
    });

    /// Sin borrados, devuelve exactamente lo mismo.
    test('sin borrados no toca nada', () {
      final pagina = _pagina(['p1']);
      expect(identical(sinLosQueSeBorran(pagina, const BorradosEnCurso()), pagina), isTrue);
    });
  });

  group('Borrar desde Mi tienda', () {
    late _RepoDeProductos repo;

    Widget pantalla() {
      repo = _RepoDeProductos(['Campera de jean', 'Zapatillas']);
      return ProviderScope(
        overrides: [
          sellerRepositoryProvider.overrideWithValue(repo),
          sesionProvider.overrideWith(_SesionDePrueba.new),
          categoriasProvider.overrideWith((ref) async => <Categoria>[]),
          tasasProvider.overrideWith((ref) async => TasasDeVendox.porOmision),
          stockDeProductoProvider
              .overrideWith((ref, id) => Completer<StockProducto>().future),
        ],
        child: MaterialApp(theme: buildAppTheme(), home: const SellerHomeScreen()),
      );
    }

    /// Confirma el borrado desde el editor, entrando por donde entra la gente.
    Future<void> borrarDesdeElEditor(WidgetTester tester, String nombre) async {
      await tester.tap(find.text(nombre));
      await tester.pumpAndSettle();

      await tester.tap(find.byIcon(Icons.delete_outline_rounded));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(TextButton, 'Borrar'));
      await tester.pumpAndSettle();
    }

    /// ⛔ EL TEST DEL BUG.
    ///
    /// El servidor no contesta nunca. Si la pantalla esperara el `DELETE`, el
    /// producto seguiría ahí — que es exactamente lo que se sentía, sólo que en
    /// el teléfono terminaba contestando a los cuatro segundos.
    testWidgets('⛔ el producto desaparece aunque el servidor no conteste', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      repo.cuelgaAlBorrar = true;

      expect(find.text('Campera de jean'), findsOneWidget);

      await borrarDesdeElEditor(tester, 'Campera de jean');

      expect(find.text('Campera de jean'), findsNothing);
      expect(find.text('Zapatillas'), findsOneWidget, reason: 'el otro no se toca');
    });

    /// ⛔ Y el editor tampoco se queda esperando.
    testWidgets('⛔ el editor se cierra sin esperar al servidor', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      repo.cuelgaAlBorrar = true;

      await borrarDesdeElEditor(tester, 'Campera de jean');

      expect(find.text('MIS PRODUCTOS'), findsOneWidget, reason: 'volvió a Mi tienda');
    });

    /// ⛔ NO SE PUEDE ENTRAR A UN PRODUCTO QUE SE ESTÁ BORRANDO.
    ///
    /// No hace falta un guardia especial: la fila no existe, así que no hay
    /// nada que tocar. Se comprueba igual porque es un requisito, y porque un
    /// cambio futuro podría dejar la fila visible «en gris» y romperlo.
    testWidgets('⛔ no queda ninguna fila que abra el producto borrado', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      repo.cuelgaAlBorrar = true;

      await borrarDesdeElEditor(tester, 'Campera de jean');

      expect(find.text('Campera de jean'), findsNothing);
    });

    /// ⛔ SI FALLA, VUELVE. Y SE EXPLICA.
    ///
    /// Un producto que desaparece y reaparece sin decir nada es peor que uno
    /// que nunca desapareció: nadie sabe si se borró.
    testWidgets('⛔ si el borrado falla, el producto vuelve y se avisa', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      repo.fallaAlBorrar = ComercioException('No se puede borrar un producto con ventas abiertas.');

      await borrarDesdeElEditor(tester, 'Campera de jean');

      expect(find.text('Campera de jean'), findsOneWidget, reason: 'volvió a la lista');
      expect(find.textContaining('No pudimos borrar'), findsOneWidget);
      expect(find.textContaining('Campera de jean'), findsWidgets, reason: 'lo nombra');
    });

    /// ⛔ El aviso no filtra detalles técnicos.
    testWidgets('⛔ el aviso de fallo no muestra el error crudo', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      repo.fallaAlBorrar = StateError('Connection closed before full header was received');

      await borrarDesdeElEditor(tester, 'Campera de jean');

      expect(find.textContaining('StateError'), findsNothing);
      expect(find.textContaining('Connection closed'), findsNothing);
      expect(find.textContaining('No pudimos borrar'), findsOneWidget);
    });

    /// ⛔ EL PRODUCTO NO REAPARECE UN INSTANTE ANTES DE IRSE.
    ///
    /// Este es el orden que hay que respetar: cuando el `DELETE` sale bien, se
    /// refresca el listado ANTES de soltar la marca de «se está borrando».
    ///
    /// Al revés, entre soltar la marca y que llegue el listado nuevo se ve la
    /// copia vieja en caché, con el producto adentro. Parpadea y se va. Acá el
    /// `GET` posterior se deja colgado, que es la versión extrema del mismo
    /// hueco: si el orden estuviera mal, el producto volvería para siempre.
    testWidgets('⛔ no parpadea de vuelta entre el borrado y el listado nuevo', (tester) async {
      await tester.pumpWidget(pantalla());
      await tester.pumpAndSettle();
      repo.cuelgaAlListar = true;

      await borrarDesdeElEditor(tester, 'Campera de jean');
      await tester.pump(const Duration(seconds: 2));

      expect(find.text('Campera de jean'), findsNothing);
    });

    /// Un borrado repetido no manda dos `DELETE`.
    test('⛔ borrar dos veces el mismo id manda un solo DELETE', () async {
      final r = _RepoDeProductos(['Campera de jean']);
      final c = ProviderContainer(overrides: [sellerRepositoryProvider.overrideWithValue(r)]);
      addTearDown(c.dispose);
      r.cuelgaAlBorrar = true;

      final notifier = c.read(borradosEnCursoProvider.notifier);
      notifier.borrar(id: 'p0', nombre: 'Campera de jean').ignore();
      notifier.borrar(id: 'p0', nombre: 'Campera de jean').ignore();
      await Future<void>.delayed(Duration.zero);

      expect(r.vecesQueBorro, 1);
    });
  });
}

// ─── Dobles ─────────────────────────────────────────────────────────────────

class _RepoDeProductos extends Fake implements SellerRepository {
  _RepoDeProductos(List<String> nombres)
      : _nombres = [...nombres],
        borrados = {};

  final List<String> _nombres;
  final Set<String> borrados;

  int vecesQueBorro = 0;

  /// El `DELETE` no contesta nunca.
  bool cuelgaAlBorrar = false;

  /// El `GET /products/mine` posterior no contesta nunca.
  bool cuelgaAlListar = false;

  /// Con qué falla el `DELETE`, si tiene que fallar.
  Object? fallaAlBorrar;

  bool _yaListoUnaVez = false;

  @override
  Future<PerfilVendedor?> miPerfil() async => _perfil();

  @override
  Future<Pagina<Producto>> misProductos({String? cursor, int limit = 20}) async {
    // Sólo cuelga a partir del segundo listado: el primero tiene que llegar
    // para que la pantalla muestre algo que borrar.
    if (cuelgaAlListar && _yaListoUnaVez) return Completer<Pagina<Producto>>().future;
    _yaListoUnaVez = true;

    final vivos = <String>[];
    for (var i = 0; i < _nombres.length; i++) {
      if (!borrados.contains('p$i')) vivos.add('p$i');
    }
    return Pagina(
      items: [for (final id in vivos) _producto(id, _nombres[int.parse(id.substring(1))])],
      catalogo: EstadoDelCatalogo(publicados: vivos.length, limite: 3, puedePublicar: true),
    );
  }

  @override
  Future<Producto> producto(String id) async =>
      _producto(id, _nombres[int.parse(id.substring(1))]);

  @override
  Future<void> borrarProducto(String id) async {
    vecesQueBorro += 1;
    if (cuelgaAlBorrar) return Completer<void>().future;
    final falla = fallaAlBorrar;
    if (falla != null) throw falla;
    borrados.add(id);
  }
}

Producto _producto(String id, String nombre) => Producto.fromJson({
      'id': id,
      'name': nombre,
      'slug': nombre.toLowerCase().replaceAll(' ', '-'),
      'status': 'ACTIVE',
      'basePriceCents': 150000,
    });

Pagina<Producto> _pagina(
  List<String> ids, {
  String? cursor,
  int? publicados,
  int? limite,
}) =>
    Pagina(
      items: [for (final id in ids) _producto(id, 'Producto $id')],
      nextCursor: cursor,
      catalogo: publicados == null
          ? null
          : EstadoDelCatalogo(
              publicados: publicados,
              limite: limite,
              puedePublicar: limite == null || publicados < limite,
            ),
    );

PerfilVendedor _perfil() => PerfilVendedor.fromJson({
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
      'stats': {'productos': 2},
    });

class _SesionDePrueba extends SesionNotifier {
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
