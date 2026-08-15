import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/orders/presentation/widgets/codigo_de_entrega.dart';
import 'package:vendox/features/orders/presentation/widgets/confirmar_entrega_sheet.dart';

/// Las dos pantallas del código de entrega.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SON DOS PANTALLAS ASIMÉTRICAS Y ESE ES EL PUNTO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El comprador **lee** el código; el vendedor lo **escribe**. Si el vendedor
/// pudiera leerlo en cualquier parte de su app, podría marcar entregado sin
/// haber entregado y todo el mecanismo dejaría de significar algo.
///
/// Del lado del backend eso está resuelto —el código no viaja en ninguna
/// respuesta del vendedor— y hay tests de integración que lo comprueban. Acá se
/// prueba lo otro: que la interfaz no lo filtre ni lo sugiera, y que quien lo
/// lee entienda cuándo darlo.
void main() {
  Widget conScaffold(Widget hijo) => ProviderScope(
        child: MaterialApp(
          home: Scaffold(body: SingleChildScrollView(child: hijo)),
        ),
      );

  group('Lo que ve el comprador', () {
    testWidgets('el código arranca oculto', (tester) async {
      /**
       * Una pantalla de pedido se abre en el colectivo, en la cola del banco y
       * con gente al lado. El código no tiene por qué estar a la vista desde el
       * momento en que se abre: se muestra cuando hace falta, en la puerta.
       */
      await tester.pumpWidget(conScaffold(const CodigoDeEntrega(codigo: '482913')));

      expect(find.text('Tu código de entrega'), findsOneWidget);
      expect(find.textContaining('482'), findsNothing);
      expect(find.textContaining('913'), findsNothing);
    });

    testWidgets('se muestra al tocarlo, en dos grupos de tres', (tester) async {
      await tester.pumpWidget(conScaffold(const CodigoDeEntrega(codigo: '482913')));

      await tester.tap(find.byType(GestureDetector).first);
      await tester.pump();

      // `482 913` y no `482913`: seis dígitos seguidos se leen mal en voz alta.
      expect(find.text('482 913'), findsOneWidget);
    });

    testWidgets('preserva los ceros a la izquierda', (tester) async {
      // `004821` es un código válido. Mostrarlo como `4821` haría imposible
      // confirmar la entrega.
      await tester.pumpWidget(conScaffold(const CodigoDeEntrega(codigo: '004821')));

      await tester.tap(find.byType(GestureDetector).first);
      await tester.pump();

      expect(find.text('004 821'), findsOneWidget);
    });

    testWidgets('dice cuándo darlo, y a quién', (tester) async {
      /**
       * Es el único texto que importa de toda la tarjeta. Y nombra al
       * repartidor además del vendedor porque muchas veces no es el vendedor
       * quien toca el timbre, y alguien que lee sólo "vendedor" duda de si
       * dárselo a la persona que tiene enfrente.
       */
      await tester.pumpWidget(conScaffold(const CodigoDeEntrega(codigo: '482913')));

      expect(find.textContaining('repartidor'), findsOneWidget);
      expect(find.textContaining('en tus manos'), findsOneWidget);
    });
  });

  group('Lo que ve el vendedor', () {
    Widget hoja() => conScaffold(
          const ConfirmarEntregaSheet(orderId: 'ord_1', referencia: 'VX-0001'),
        );

    testWidgets('⛔ la hoja no muestra ni sugiere ningún código', (tester) async {
      /**
       * El test que justifica el archivo. Cualquier número de seis dígitos en
       * esta pantalla sería el código, o algo que se puede confundir con él.
       *
       * Se busca sobre el árbol entero y no sobre una lista de textos
       * esperados: así también falla si mañana alguien agrega un "último código
       * usado" pensando que ayuda.
       */
      await tester.pumpWidget(hoja());
      await tester.pump();

      final textos = tester
          .widgetList<Text>(find.byType(Text))
          .map((t) => t.data ?? '')
          .join(' | ');

      expect(RegExp(r'\d{6}').hasMatch(textos), isFalse, reason: textos);
    });

    testWidgets('el campo es numérico y de seis dígitos', (tester) async {
      await tester.pumpWidget(hoja());
      await tester.pump();

      final campo = tester.widget<TextField>(find.byType(TextField));

      expect(campo.keyboardType, TextInputType.number);
      expect(campo.maxLength, 6);
      // Sin esto, un teclado que ofrezca letras las deja entrar y el backend
      // rechaza con un 400 que la persona no entiende.
      expect(campo.inputFormatters, contains(isA<FilteringTextInputFormatter>()));
    });

    testWidgets('⛔ no se puede confirmar con menos de seis dígitos', (tester) async {
      /**
       * Dejar el botón activo para después responder "son seis números" es
       * hacer que la persona descubra la regla equivocándose, con el repartidor
       * esperando en la puerta.
       */
      await tester.pumpWidget(hoja());
      await tester.pump();

      final boton = find.widgetWithText(FilledButton, 'Confirmar entrega');
      expect(tester.widget<FilledButton>(boton).onPressed, isNull);

      await tester.enterText(find.byType(TextField), '48291');
      await tester.pump();

      expect(tester.widget<FilledButton>(boton).onPressed, isNull);
    });

    testWidgets('le dice al vendedor que lo pida, no dónde verlo', (tester) async {
      await tester.pumpWidget(hoja());
      await tester.pump();

      expect(find.textContaining('Pedile a quien recibe'), findsOneWidget);
      // Y avisa del bloqueo antes de que lo choque.
      expect(find.textContaining('cinco intentos'), findsOneWidget);
    });
  });
}
