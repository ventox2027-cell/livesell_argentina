import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/core/design/theme.dart';
import 'package:vendox/features/lives/domain/live_models.dart';
import 'package:vendox/features/lives/presentation/widgets/producto_destacado_card.dart';

/// El precio exclusivo del vivo, en la tarjeta.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// UN DESCUENTO QUE NO EXISTE NO SE DIBUJA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// «$6.200 ~~$8.900~~ -30 %» le dice a alguien que si compra ahora paga menos
/// que mañana. La regla de veracidad del proyecto dice que toda cifra mostrada
/// tiene que venir de datos reales; acá eso se traduce en una sola cosa:
///
///   **el tachado sale si y sólo si el servidor dijo `hayDescuento: true`.**
///
/// La app no compara los dos precios por su cuenta. Una oferta vencida, o una
/// programada para las nueve, tiene los dos números cargados y no es un
/// descuento — sólo el servidor sabe si la ventana está abierta, y es el mismo
/// que después cobra.

ProductoDestacado _producto({
  required bool hayDescuento,
  int? precio = 620000,
  int? lista = 890000,
  int? porcentaje = 30,
}) =>
    ProductoDestacado(
      variantId: 'var_1',
      productId: 'prod_1',
      nombre: 'Campera de lana',
      precioCentavos: precio,
      disponible: 10,
      hayDescuento: hayDescuento,
      precioDeListaCentavos: lista,
      porcentajeDescuento: porcentaje,
    );

Future<void> _montar(WidgetTester tester, ProductoDestacado p) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: Center(
          child: ProductoDestacadoCard(producto: p, onComprar: () {}),
        ),
      ),
    ),
  );
}

/// Busca un `Text` cuyo estilo tenga el tachado puesto.
Finder _tachados() => find.byWidgetPredicate(
      (w) => w is Text && w.style?.decoration == TextDecoration.lineThrough,
    );

void main() {
  group('La tarjeta del producto destacado', () {
    testWidgets('con descuento muestra el precio pagado, el tachado y el porcentaje',
        (tester) async {
      await _montar(tester, _producto(hayDescuento: true));

      expect(find.text(r'$ 6.200,00'), findsOneWidget);
      expect(find.text(r'$ 8.900,00'), findsOneWidget);
      expect(find.text('-30%'), findsOneWidget);
      expect(_tachados(), findsOneWidget);
    });

    testWidgets('⛔ sin descuento NO tacha nada', (tester) async {
      /**
       * El caso normal: la enorme mayoría de los productos de un vivo no tienen
       * precio exclusivo.
       */
      await _montar(
        tester,
        _producto(hayDescuento: false, precio: 890000, lista: null, porcentaje: null),
      );

      expect(find.text(r'$ 8.900,00'), findsOneWidget);
      expect(_tachados(), findsNothing);
      expect(find.textContaining('%'), findsNothing);
    });

    testWidgets('⛔ con una oferta vencida no se tacha el mismo número', (tester) async {
      /**
       * ⚠️ EL TEST QUE IMPORTA.
       *
       * Es el payload exacto de una oferta vencida o todavía no empezada:
       * `resolverPrecio` devuelve `precioDeListaCentavos` **igual** a
       * `precioCentavos` y la bandera en `false` (ver el `sinDescuento` de
       * `precio-de-vivo.ts`).
       *
       * Una tarjeta que dibujara el tachado con sólo tener el precio de lista
       * mostraría acá «$8.900 ~~$8.900~~»: el mismo número tachado al lado de
       * sí mismo. Es el bug que menciona el comentario del backend.
       */
      await _montar(
        tester,
        _producto(hayDescuento: false, precio: 890000, lista: 890000, porcentaje: null),
      );

      expect(_tachados(), findsNothing);
      expect(find.textContaining('%'), findsNothing);
      // Y el precio se muestra una sola vez, no dos.
      expect(find.text(r'$ 8.900,00'), findsOneWidget);
    });

    testWidgets('⛔ sin precio de lista no se inventa un tachado', (tester) async {
      // Defensa contra un backend viejo que mande `hayDescuento` sin el número.
      await _montar(tester, _producto(hayDescuento: true, lista: null));

      expect(_tachados(), findsNothing);
    });
  });

  group('El modelo', () {
    test('sin los campos nuevos, no hay descuento', () {
      // Un backend que todavía no los manda no puede hacer que la app tache.
      final p = ProductoDestacado.fromJson({
        'variantId': 'v',
        'productId': 'p',
        'nombre': 'Algo',
        'precioCentavos': 100000,
      });

      expect(p.hayDescuento, isFalse);
      expect(p.precioDeListaCentavos, isNull);
      expect(p.porcentajeDescuento, isNull);
    });

    test('conDisponible conserva el descuento', () {
      /**
       * `conDisponible` se aplica en cada evento de stock del vivo. Si perdiera
       * los campos del precio, el tachado desaparecería sólo porque alguien
       * compró una unidad.
       */
      final p = _producto(hayDescuento: true).conDisponible(3);

      expect(p.disponible, 3);
      expect(p.hayDescuento, isTrue);
      expect(p.precioDeListaCentavos, 890000);
      expect(p.porcentajeDescuento, 30);
    });
  });
}
