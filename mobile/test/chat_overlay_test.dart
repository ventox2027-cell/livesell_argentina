import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/lives/data/live_realtime.dart';
import 'package:vendox/features/lives/presentation/layout_del_vivo.dart';
import 'package:vendox/features/lives/presentation/widgets/chat_overlay.dart';

/// El chat del vivo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL DEFECTO QUE ESTOS TESTS CLAVAN
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Encontrado en un teléfono real: los mensajes se apilaban hacia abajo y, al
/// pasar del alto disponible, **los nuevos dejaban de verse**. El chat quedaba
/// congelado en los primeros mensajes mientras la conversación seguía.
///
/// La causa no estaba en el scroll. La pantalla muta la misma lista
/// (`_mensajes.add(...)`), así que en `didUpdateWidget` la lista vieja y la
/// nueva eran el mismo objeto y `viejo.mensajes.length != widget.mensajes.length`
/// daba `false` siempre. El auto-scroll no corría nunca.
///
/// El arreglo es `reverse: true`, que hace que el comportamiento sea correcto
/// por construcción en vez de depender de detectar el cambio. Estos tests
/// afirman el comportamiento observable, no la implementación: si mañana
/// alguien vuelve a una lista normal con controlador, tienen que seguir
/// pasando o el arreglo se perdió.
void main() {
  const telefono = Size(390, 844);

  setUpAll(() {
    final vista = TestWidgetsFlutterBinding.ensureInitialized().platformDispatcher.views.first;
    vista.physicalSize = telefono;
    vista.devicePixelRatio = 1;
    addTearDown(vista.resetPhysicalSize);
    addTearDown(vista.resetDevicePixelRatio);
  });

  var n = 0;
  MensajeDeChat msj(String texto, {bool vendedor = false}) => MensajeDeChat(
        id: 'msg_${n++}',
        nombre: vendedor ? 'Taller Aroma' : 'Ana',
        texto: texto,
        esVendedor: vendedor,
      );

  /// El chat dentro de una caja del alto que le da el layout, como en la
  /// pantalla real. Es la única forma de reproducir el desbordamiento.
  Widget enCaja(List<MensajeDeChat> mensajes, {double alto = 160}) {
    return MaterialApp(
      home: Scaffold(
        backgroundColor: Colors.black,
        body: Stack(
          children: [
            Positioned(
              left: 12,
              right: 84,
              bottom: 200,
              height: alto,
              child: ChatOverlay(mensajes: mensajes),
            ),
          ],
        ),
      ),
    );
  }

  group('El mensaje más nuevo', () {
    testWidgets('se ve aunque haya muchos más de los que entran', (tester) async {
      // Cincuenta mensajes en una caja de 160 px: entran cinco o seis.
      final muchos = [for (var i = 1; i <= 50; i++) msj('m$i.')];

      await tester.pumpWidget(enCaja(muchos));
      await tester.pump();

      /**
       * El corazón del defecto.
       *
       * Antes, "mensaje 50" no estaba en el árbol: la lista se había dibujado
       * desde el primero y el resto quedaba fuera de la ventana sin que nada
       * desplazara.
       */
      expect(find.textContaining('m50.', findRichText: true), findsOneWidget,
          reason: 'El último mensaje no se está mostrando');
    });

    testWidgets('sigue visible después de que llegan más', (tester) async {
      final mensajes = [for (var i = 1; i <= 10; i++) msj('m$i.')];
      await tester.pumpWidget(enCaja(mensajes));
      await tester.pump();

      // Se muta la MISMA lista, igual que hace la pantalla. Es exactamente la
      // condición en la que el arreglo anterior fallaba.
      for (var i = 11; i <= 40; i++) {
        mensajes.add(msj('m$i.'));
      }
      await tester.pumpWidget(enCaja(mensajes));
      await tester.pump();

      expect(find.textContaining('m40.', findRichText: true), findsOneWidget);
    });

    testWidgets('queda más abajo que los anteriores', (tester) async {
      await tester.pumpWidget(enCaja([msj('viejo'), msj('nuevo')]));
      await tester.pump();

      final yViejo = tester.getTopLeft(find.textContaining('viejo', findRichText: true)).dy;
      final yNuevo = tester.getTopLeft(find.textContaining('nuevo', findRichText: true)).dy;

      expect(yNuevo, greaterThan(yViejo),
          reason: 'El mensaje nuevo tiene que ir abajo del anterior');
    });
  });

  group('Los mensajes viejos', () {
    testWidgets('salen por arriba en vez de empujar la caja', (tester) async {
      final muchos = [for (var i = 1; i <= 50; i++) msj('m$i.')];
      await tester.pumpWidget(enCaja(muchos));
      await tester.pump();

      // El primero ya no está en el árbol: se fue por arriba.
      expect(find.textContaining('m1.', findRichText: true), findsNothing);
    });

    testWidgets('el chat NO crece: respeta el alto que le dan', (tester) async {
      final muchos = [for (var i = 1; i <= 50; i++) msj('m$i.')];
      await tester.pumpWidget(enCaja(muchos, alto: 160));
      await tester.pump();

      // Si creciera, taparía el producto y el composer, que viven abajo.
      expect(tester.getSize(find.byType(ChatOverlay)).height, 160);
    });

    testWidgets('con un solo mensaje tampoco ocupa de más', (tester) async {
      await tester.pumpWidget(enCaja([msj('hola')]));
      await tester.pump();

      expect(tester.getSize(find.byType(ChatOverlay)).height, 160);
      expect(find.textContaining('hola', findRichText: true), findsOneWidget);
    });
  });

  group('Casos de borde', () {
    testWidgets('sin mensajes no dibuja nada', (tester) async {
      await tester.pumpWidget(enCaja([]));
      await tester.pump();

      expect(find.byType(ListView), findsNothing);
    });

    testWidgets('un mensaje larguísimo se corta en dos líneas', (tester) async {
      // Sin el tope, un solo mensaje se comería el chat entero.
      await tester.pumpWidget(enCaja([msj('a' * 400)]));
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.byType(ChatOverlay)).height, 160);
    });

    testWidgets('el del vendedor se distingue con etiqueta, no sólo color', (tester) async {
      await tester.pumpWidget(enCaja([msj('quedan tres', vendedor: true)]));
      await tester.pump();

      // El color solo no le llega a todo el mundo.
      expect(find.textContaining('· vendedor', findRichText: true), findsOneWidget);
    });
  });

  group('El alto que decide el layout', () {
    test('en una pantalla chica el chat se recorta en vez de treparse', () {
      // Un teléfono bajo, con teclado abierto y producto destacado: la zona de
      // abajo se come casi todo y el chat tiene que ceder.
      final apretado = medirZonaInferior(
        teclado: 320,
        abajo: 0,
        hayProducto: true,
        altoPantalla: 640,
        arriba: 24,
      );

      expect(apretado.altoDelChat, lessThan(altoChatEscribiendo));
      expect(apretado.altoDelChat, greaterThanOrEqualTo(0));
    });

    test('nunca devuelve un alto negativo', () {
      // Una pantalla imposible no puede producir una altura al revés: eso
      // revienta el layout en vez de mostrar menos mensajes.
      final imposible = medirZonaInferior(
        teclado: 500,
        abajo: 40,
        hayProducto: true,
        altoPantalla: 300,
        arriba: 40,
      );

      expect(imposible.altoDelChat, greaterThanOrEqualTo(0));
    });

    test('en un teléfono normal usa el tope de siempre', () {
      final holgado = medirZonaInferior(
        teclado: 0,
        abajo: 34,
        hayProducto: true,
        altoPantalla: 844,
        arriba: 47,
      );

      expect(holgado.altoDelChat, altoChatEnReposo);
    });

    test('sin decirle el alto de pantalla, se comporta como antes', () {
      // Compatibilidad: quien no pase la medida obtiene el tope fijo.
      expect(
        medirZonaInferior(teclado: 0, abajo: 34, hayProducto: true).altoDelChat,
        altoChatEnReposo,
      );
    });
  });

  group('Cuando alguien sube a leer', () {
    testWidgets('⛔ un mensaje nuevo NO lo arrastra de vuelta abajo', (tester) async {
      /**
       * El comportamiento que el comentario de `ChatOverlay` promete y que no
       * estaba verificado.
       *
       * Alguien sube a releer algo. Si cada mensaje nuevo lo devolviera al
       * fondo, leer durante un vivo activo sería imposible: la lista se le
       * escapa de las manos cada dos segundos.
       *
       * Con la lista invertida sale gratis —los mensajes nacen en el extremo
       * del desplazamiento 0, y si la persona se movió de ahí su posición no se
       * toca— pero "sale gratis" es exactamente el tipo de propiedad que alguien
       * rompe sin darse cuenta el día que agregue un `ScrollController`.
       */
      final mensajes = [for (var i = 1; i <= 40; i++) msj('m$i.')];
      await tester.pumpWidget(enCaja(mensajes));
      await tester.pump();

      /**
       * Se sube a leer arrastrando con el dedo, no moviendo un controlador.
       *
       * `ChatOverlay` no crea un `ScrollController` propio: la posición la
       * maneja el gesto. En una lista invertida, subir es desplazarse hacia
       * valores POSITIVOS de `pixels`.
       */
      await tester.drag(find.byType(ListView), const Offset(0, 200));
      await tester.pump();

      final posicionTrasSubir = tester
          .state<ScrollableState>(find.byType(Scrollable))
          .position
          .pixels;
      expect(posicionTrasSubir, greaterThan(0), reason: 'no se llegó a subir');

      // Llegan mensajes nuevos mientras está leyendo.
      for (var i = 41; i <= 50; i++) {
        mensajes.add(msj('m$i.'));
      }
      await tester.pumpWidget(enCaja(mensajes));
      await tester.pump();

      final posicionDespues = tester
          .state<ScrollableState>(find.byType(Scrollable))
          .position
          .pixels;

      // Sigue donde estaba. Un `animateTo(0)` acá la habría devuelto al fondo.
      expect(posicionDespues, posicionTrasSubir);
    });

    testWidgets('al volver al fondo vuelve a seguir el hilo', (tester) async {
      final mensajes = [for (var i = 1; i <= 40; i++) msj('m$i.')];
      await tester.pumpWidget(enCaja(mensajes));
      await tester.pump();

      await tester.drag(find.byType(ListView), const Offset(0, 200));
      await tester.pump();

      // Vuelve abajo.
      await tester.drag(find.byType(ListView), const Offset(0, -400));
      await tester.pumpAndSettle();

      mensajes.add(msj('recien llegado.'));
      await tester.pumpWidget(enCaja(mensajes));
      await tester.pump();

      expect(
        find.textContaining('recien llegado.', findRichText: true),
        findsOneWidget,
      );
    });
  });
}
