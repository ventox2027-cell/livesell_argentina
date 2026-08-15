import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/core/design/theme.dart';
import 'package:vendox/features/orders/domain/order_models.dart';
import 'package:vendox/features/orders/presentation/widgets/campo_de_cupon.dart';
import 'package:vendox/features/orders/presentation/widgets/desglose_de_precio.dart';

/// El cupón en el checkout.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL CAMPO ARRANCA CERRADO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Un campo de cupón abierto en medio del pago le dice a quien no tiene ninguno
/// que se está perdiendo algo, y lo manda a buscar códigos a Google en vez de
/// terminar la compra.
///
/// Y el descuento que se muestra sale del pedido que devolvió el servidor. La
/// app no lo calcula: el número que se ve es el que se va a cobrar.

Pedido _pedido({int descuento = 0}) => Pedido(
      id: 'ord_1',
      referencia: 'ABC123',
      status: 'PENDING_PAYMENT',
      grossAmount: 1000000 - descuento,
      fecha: DateTime(2026, 8, 15),
      itemsSubtotal: 1000000,
      descuento: descuento,
      lineas: const [],
    );

Future<void> _montarCampo(
  WidgetTester tester,
  Pedido pedido, {
  Future<String?> Function(String)? onAplicar,
  Future<void> Function()? onQuitar,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: CampoDeCupon(
          pedido: pedido,
          onAplicar: onAplicar ?? (_) async => null,
          onQuitar: onQuitar ?? () async {},
        ),
      ),
    ),
  );
}

void main() {
  group('El campo de cupón', () {
    testWidgets('arranca cerrado', (tester) async {
      await _montarCampo(tester, _pedido());

      expect(find.text('¿Tenés un cupón?'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
    });

    testWidgets('se abre al tocarlo', (tester) async {
      await _montarCampo(tester, _pedido());

      await tester.tap(find.text('¿Tenés un cupón?'));
      await tester.pumpAndSettle();

      expect(find.byType(TextField), findsOneWidget);
    });

    testWidgets('manda el código en mayúsculas', (tester) async {
      /**
       * El servidor normaliza igual, así que esto no es validación: es que el
       * código se vea como el que la persona leyó en el vivo.
       */
      String? mandado;
      await _montarCampo(
        tester,
        _pedido(),
        onAplicar: (c) async {
          mandado = c;
          return null;
        },
      );

      await tester.tap(find.text('¿Tenés un cupón?'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'verano25');
      await tester.tap(find.text('Aplicar'));
      await tester.pumpAndSettle();

      expect(mandado, 'VERANO25');
    });

    testWidgets('⛔ el error del servidor se muestra al lado del campo', (tester) async {
      /**
       * Y no como aviso flotante: uno que tapa el formulario y desaparece solo
       * deja a la persona sin saber qué código escribió mal.
       *
       * El mensaje viene del backend porque es el único que sabe si venció, si
       * se agotó o si ya lo usó. Ver `MENSAJE_DE_RECHAZO`.
       */
      await _montarCampo(tester, _pedido(), onAplicar: (_) async => 'Ese cupón venció');

      await tester.tap(find.text('¿Tenés un cupón?'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'VIEJO');
      await tester.tap(find.text('Aplicar'));
      await tester.pumpAndSettle();

      expect(find.text('Ese cupón venció'), findsOneWidget);
      // Y el campo sigue abierto, con lo que escribió.
      expect(find.byType(TextField), findsOneWidget);
    });

    testWidgets('con un cupón puesto muestra el estado y la forma de sacarlo', (tester) async {
      await _montarCampo(tester, _pedido(descuento: 250000));

      expect(find.text('Cupón aplicado'), findsOneWidget);
      expect(find.text('Quitar'), findsOneWidget);
      // Ya no ofrece escribir otro.
      expect(find.text('¿Tenés un cupón?'), findsNothing);
    });

    testWidgets('quitar avisa hacia arriba', (tester) async {
      var quitado = false;
      await _montarCampo(
        tester,
        _pedido(descuento: 250000),
        onQuitar: () async => quitado = true,
      );

      await tester.tap(find.text('Quitar'));
      await tester.pumpAndSettle();

      expect(quitado, isTrue);
    });
  });

  group('El desglose', () {
    Future<void> montar(WidgetTester tester, Pedido pedido) => tester.pumpWidget(
          MaterialApp(
            theme: buildAppTheme(),
            home: Scaffold(body: DesgloseDePrecio(pedido: pedido)),
          ),
        );

    testWidgets('⛔ sin cupón NO muestra la línea de descuento', (tester) async {
      // «Descuento: $0» no informa nada y ocupa una línea.
      await montar(tester, _pedido());
      expect(find.text('Cupón de descuento'), findsNothing);
    });

    testWidgets('con cupón muestra el descuento restando', (tester) async {
      /**
       * Con el signo menos y en verde: es la única línea de la lista que baja
       * el total, y tiene que leerse distinto de las que lo suben.
       */
      await montar(tester, _pedido(descuento: 250000));

      expect(find.text('Cupón de descuento'), findsOneWidget);
      expect(find.textContaining('−'), findsOneWidget);
    });
  });
}
