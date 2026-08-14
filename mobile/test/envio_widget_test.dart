import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/lives/domain/politicas_de_tienda.dart';
import 'package:vendox/features/lives/presentation/widgets/envio_y_politicas.dart';
import 'package:vendox/features/orders/domain/order_models.dart';
import 'package:vendox/features/orders/presentation/widgets/desglose_de_precio.dart';

/// Lo que la persona VE del envío y del total.
///
/// El contrato ya prueba que los números llegan bien. Esto prueba lo otro: que
/// lleguen a la pantalla y que no digan una cosa por otra. Los dos errores que
/// importan acá no son excepciones, son textos:
///
///   · decir "envío gratis" cuando en realidad no hay envío porque se retira;
///   · mostrar un total que no se puede explicar sumando lo que está arriba.
///
/// Ninguno de los dos rompe nada. Los dos terminan en un reclamo.
void main() {
  Map<String, dynamic> leerContrato(String nombre) =>
      jsonDecode(File('test/contratos/$nombre.json').readAsStringSync()) as Map<String, dynamic>;

  /// 390×844 y no el 800×600 por omisión.
  ///
  /// El tamaño por omisión de `flutter_test` no es el de ningún teléfono. Con
  /// él, contenido que en un celular real entra sobrado desborda y los tests
  /// fallan por una razón que no tiene nada que ver con lo que se está
  /// probando.
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    final vista = TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    vista.physicalSize = const Size(390, 844);
    vista.devicePixelRatio = 1;
  });

  Widget envolver(Widget hijo) => MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(child: Padding(padding: const EdgeInsets.all(16), child: hijo)),
        ),
      );

  group('Desglose del precio', () {
    testWidgets('muestra una línea por concepto y el total', (tester) async {
      final pedido = Pedido.fromJson(leerContrato('orden-con-envio'));
      await tester.pumpWidget(envolver(DesgloseDePrecio(pedido: pedido)));

      expect(find.text('Envío'), findsOneWidget);
      expect(find.text('Costo del medio de pago'), findsOneWidget);
      expect(find.text('Total'), findsOneWidget);

      // Los montos formateados, no los centavos crudos.
      expect(find.textContaining('3.500'), findsOneWidget);
      expect(find.textContaining('13.167'), findsOneWidget);
    });

    testWidgets('⛔ con retiro NO dice "gratis": dice que no hay envío', (tester) async {
      /**
       * "Envío gratis" y "retiro en persona" son cosas distintas. Confundirlas
       * hace que alguien se quede esperando en su casa un paquete que tiene que
       * ir a buscar.
       */
      final pedido = Pedido.fromJson(leerContrato('orden-con-retiro'));
      await tester.pumpWidget(envolver(DesgloseDePrecio(pedido: pedido)));

      expect(find.text('Retiro en persona'), findsOneWidget);
      expect(find.text('Gratis'), findsNothing);
      expect(find.text('Envío'), findsNothing);
    });

    testWidgets('el envío en cero SÍ se muestra, porque es una ventaja', (tester) async {
      final base = leerContrato('orden-con-envio');
      final pedido = Pedido.fromJson({
        ...base,
        'shippingAmount': 0,
        'processorSurchargeAmount': 0,
        'grossAmount': base['itemsSubtotal'],
        'pickupSelected': false,
      });

      await tester.pumpWidget(envolver(DesgloseDePrecio(pedido: pedido)));

      expect(find.text('Envío'), findsOneWidget);
      expect(find.text('Gratis'), findsOneWidget);
      // El recargo en cero NO se muestra: una línea de $0 no informa nada.
      expect(find.text('Costo del medio de pago'), findsNothing);
    });
  });

  group('Elegir cómo recibirlo', () {
    late PoliticaDeEnvio envio;
    late PoliticaDeCambios cambios;

    setUp(() {
      final j = leerContrato('catalogo-producto');
      envio = PoliticaDeEnvio.fromJson(j['envio'] as Map<String, dynamic>?);
      cambios = PoliticaDeCambios.fromJson(j['cambios'] as Map<String, dynamic>?);
    });

    testWidgets('con las dos opciones muestra las dos, con su precio', (tester) async {
      // Dos opciones a la vista y no un interruptor: así el precio de cada una
      // se ve sin tener que tocar nada.
      await tester.pumpWidget(
        envolver(
          EnvioYPoliticas(
            envio: envio,
            cambios: cambios,
            retira: false,
            onCambiarRetiro: (_) {},
          ),
        ),
      );

      expect(find.text('Envío a domicilio'), findsOneWidget);
      expect(find.text('Retiro en persona'), findsOneWidget);
      expect(find.textContaining('3.500'), findsOneWidget);
      expect(find.text('Gratis'), findsOneWidget);
    });

    testWidgets('tocar retiro avisa al padre', (tester) async {
      bool? elegido;
      await tester.pumpWidget(
        envolver(
          EnvioYPoliticas(
            envio: envio,
            cambios: cambios,
            retira: false,
            onCambiarRetiro: (v) => elegido = v,
          ),
        ),
      );

      await tester.tap(find.text('Retiro en persona'));
      await tester.pump();

      expect(elegido, isTrue);
    });

    testWidgets('sin retiro disponible no ofrece elegir', (tester) async {
      const soloEnvio = PoliticaDeEnvio(
        modo: 'FIXED_PRICE',
        costo: 350000,
        etiqueta: 'Envío',
        permiteEnvio: true,
        permiteRetiro: false,
        trasladaCostoDelProcesador: false,
      );

      await tester.pumpWidget(envolver(EnvioYPoliticas(envio: soloEnvio, cambios: cambios)));

      expect(find.text('Envío a domicilio'), findsNothing);
      expect(find.text('Retiro en persona'), findsNothing);
      expect(find.text('Envío'), findsOneWidget);
    });

    testWidgets('avisa del recargo del medio de pago antes de pagar', (tester) async {
      await tester.pumpWidget(envolver(EnvioYPoliticas(envio: envio, cambios: cambios)));

      expect(find.textContaining('costo del medio de pago'), findsOneWidget);
    });

    testWidgets('⛔ el derecho de arrepentimiento está a un toque', (tester) async {
      /**
       * La Resolución 424/2020 pide que sea visible y fácil de encontrar.
       * "Fácil de encontrar" no es un pie de página en los términos: es esto,
       * un desplegable en la misma hoja donde se decide la compra.
       */
      await tester.pumpWidget(envolver(EnvioYPoliticas(envio: envio, cambios: cambios)));

      expect(find.textContaining('10 días corridos'), findsNothing);

      await tester.tap(find.text('Cambios y devoluciones'));
      await tester.pumpAndSettle();

      expect(find.textContaining('10 días corridos'), findsOneWidget);
      expect(find.textContaining('no depende del vendedor'), findsOneWidget);
    });
  });
}
