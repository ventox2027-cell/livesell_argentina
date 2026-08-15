import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/seller/presentation/widgets/conectar_mp_sheet.dart';

/// El texto de la pantalla de cobros.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ UN TEST SOBRE UN TEXTO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La versión anterior decía "Mercado Pago nos descuenta 6 % de comisión", como
/// si el 6 % fuera de ellos. No lo es: **VendoX cobra 6 % sobre el producto** y
/// Mercado Pago cobra lo suyo aparte, según la cuenta y el medio de pago.
///
/// Un vendedor que lee eso calcula mal su ganancia y después reclama con razón.
/// No es un detalle de redacción: es el número con el que decide si le conviene
/// vender acá.
void main() {
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    final vista = TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    vista.physicalSize = const Size(390, 844);
    vista.devicePixelRatio = 1;
  });

  Widget app(Widget hijo) => MaterialApp(home: Scaffold(body: hijo));

  testWidgets('la hoja de bloqueo explica por qué, no que es obligatorio', (tester) async {
    await tester.pumpWidget(
      app(const ConectarMpSheet(accion: AccionBloqueada.publicar)),
    );

    expect(find.textContaining('Para publicar'), findsOneWidget);
    // La razón, no el trámite.
    expect(find.textContaining('donde va a entrar el dinero de tus ventas'), findsOneWidget);
    expect(find.textContaining('una sola vez'), findsOneWidget);
    expect(find.text('Conectar Mercado Pago'), findsOneWidget);
  });

  testWidgets('el título cambia según qué se estaba intentando', (tester) async {
    // Un mensaje genérico deja a la persona sin saber qué la frenó, sobre todo
    // si tocó publicar en una lista de veinte productos.
    expect(AccionBloqueada.publicar.titulo, contains('publicar'));
    expect(AccionBloqueada.transmitir.titulo, contains('vivo'));
  });

  testWidgets('⛔ no dice que Mercado Pago cobra el 6 %', (tester) async {
    /**
     * El 6 % es de VendoX. Mercado Pago cobra lo suyo por separado, y su tasa
     * depende del plazo de acreditación y del medio de pago — la informan
     * DESPUÉS de cobrar. Escribir un número nuestro al lado de su nombre es
     * prometer algo que no controlamos.
     */
    await tester.pumpWidget(
      app(const ConectarMpSheet(accion: AccionBloqueada.transmitir)),
    );

    expect(find.textContaining('Mercado Pago nos descuenta'), findsNothing);
    expect(find.textContaining('6 % de comisión'), findsNothing);
  });

  testWidgets('"Ahora no" y no "Cancelar"', (tester) async {
    // Cancelar sugiere que se deshace algo. Acá simplemente se pospone.
    await tester.pumpWidget(
      app(const ConectarMpSheet(accion: AccionBloqueada.publicar)),
    );

    expect(find.text('Ahora no'), findsOneWidget);
    expect(find.text('Cancelar'), findsNothing);
  });
}
