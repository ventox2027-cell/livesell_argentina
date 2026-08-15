import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/auth/domain/session.dart';
import 'package:vendox/features/auth/presentation/widgets/fecha_de_nacimiento_sheet.dart';

/// VendoX es 18+.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE ESTOS TESTS PROTEGEN
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Dos cosas distintas, y la segunda importa más de lo que parece:
///
///   · que el dato viaje bien: `AAAA-MM-DD`, con los ceros a la izquierda. Un
///     `2008-3-5` se interpreta distinto según el servidor;
///   · que la pantalla no MIENTA. La edad es declarada, no verificada, y en
///     ningún lado puede decir lo contrario.
void main() {
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    final vista = TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    vista.physicalSize = const Size(390, 844);
    vista.devicePixelRatio = 1;
  });

  group('El dato que llega del servidor', () {
    test('la fecha se lee del perfil', () {
      final u = Usuario.fromJson(const {
        'id': 'usr_1',
        'firstName': 'Ana',
        'lastName': 'Pérez',
        'email': 'a@b.com',
        'role': 'buyer',
        'birthDate': '1990-05-20',
      });

      expect(u.fechaDeNacimiento, '1990-05-20');
    });

    test('sin fecha declarada es null, no cadena vacía', () {
      // `''` se leería como "hay una fecha" en cualquier `if` descuidado.
      final u = Usuario.fromJson(const {
        'id': 'usr_1',
        'firstName': 'Ana',
        'lastName': 'Pérez',
        'email': 'a@b.com',
        'role': 'buyer',
      });

      expect(u.fechaDeNacimiento, isNull);
    });

    test('el faltante birthDate se reconoce', () {
      /**
       * Es lo que permite pedirla en el momento oportuno en vez de esperar al
       * error en medio de la compra. Un valor desconocido devuelve `null` y se
       * descarta: un servidor más nuevo que la app no puede romperla.
       */
      expect(DatoFaltante.desde('birthDate'), DatoFaltante.fechaDeNacimiento);
      expect(DatoFaltante.desde('algoQueNoExisteTodavia'), isNull);
    });
  });

  group('La hoja donde se declara', () {
    Widget hoja(AccionConEdad accion) => ProviderScope(
          child: MaterialApp(
            home: Scaffold(body: FechaDeNacimientoSheet(accion: accion)),
          ),
        );

    testWidgets('dice por qué se pide, no que es obligatorio', (tester) async {
      /**
       * "Es obligatorio" suena a trámite nuestro. Que hay una edad mínima legal
       * es una razón que se entiende sola, y no deja a la persona pensando que
       * la app le está poniendo trabas.
       */
      await tester.pumpWidget(hoja(AccionConEdad.comprar));
      await tester.pump();

      expect(find.textContaining('mayores de 18'), findsOneWidget);
      expect(find.textContaining('la ley'), findsOneWidget);
    });

    testWidgets('avisa ANTES que se carga una sola vez', (tester) async {
      /**
       * El backend rechaza el cambio, y con razón. Pero una regla así,
       * descubierta recién en el error, es una trampa: quien tipeó mal el año
       * se entera cuando ya no puede arreglarlo.
       */
      await tester.pumpWidget(hoja(AccionConEdad.comprar));
      await tester.pump();

      expect(find.textContaining('una sola vez'), findsOneWidget);
      // Y dice a dónde ir si se equivocó.
      expect(find.textContaining('Ayuda'), findsOneWidget);
    });

    testWidgets('⛔ en ningún lado dice que la edad queda verificada', (tester) async {
      /**
       * El test más importante del archivo.
       *
       * No hay integración con RENAPER ni con ningún registro: la fecha la
       * escribe la persona y nadie la comprueba. Decir "verificada" en la
       * interfaz sería una afirmación falsa sobre una garantía que no damos, y
       * es exactamente el tipo de texto que alguien agrega de buena fe.
       */
      for (final accion in AccionConEdad.values) {
        await tester.pumpWidget(hoja(accion));
        await tester.pump();

        final textos = tester
            .widgetList<Text>(find.byType(Text))
            .map((t) => (t.data ?? '').toLowerCase())
            .join(' | ');

        expect(textos.contains('verific'), isFalse, reason: textos);
        expect(textos.contains('comprobad'), isFalse, reason: textos);
      }
    });

    testWidgets('el título dice qué se estaba intentando hacer', (tester) async {
      // Un título genérico deja a la persona sin saber por qué apareció esto
      // justo ahora.
      await tester.pumpWidget(hoja(AccionConEdad.comprar));
      await tester.pump();
      expect(find.text('Antes de tu primera compra'), findsOneWidget);

      await tester.pumpWidget(hoja(AccionConEdad.vender));
      await tester.pump();
      expect(find.text('Antes de abrir tu tienda'), findsOneWidget);
    });

    testWidgets('⛔ no se puede continuar con la fecha incompleta', (tester) async {
      await tester.pumpWidget(hoja(AccionConEdad.comprar));
      await tester.pump();

      final boton = find.widgetWithText(FilledButton, 'Continuar');
      expect(tester.widget<FilledButton>(boton).onPressed, isNull);

      // Con día y mes pero sin año tampoco: un año de dos dígitos es la forma
      // más fácil de mandar 0020 en vez de 2020.
      await tester.enterText(find.byType(TextField).at(0), '15');
      await tester.enterText(find.byType(TextField).at(1), '3');
      await tester.pump();
      expect(tester.widget<FilledButton>(boton).onPressed, isNull);

      await tester.enterText(find.byType(TextField).at(2), '1990');
      await tester.pump();
      expect(tester.widget<FilledButton>(boton).onPressed, isNotNull);
    });

    testWidgets('son tres campos numéricos, no un calendario', (tester) async {
      /**
       * Para llegar a 1990 en un `showDatePicker` hay que retroceder treinta y
       * seis años a mano. Escribir la fecha es más rápido y es lo que la gente
       * espera de un formulario de este tipo.
       */
      await tester.pumpWidget(hoja(AccionConEdad.comprar));
      await tester.pump();

      final campos = tester.widgetList<TextField>(find.byType(TextField)).toList();
      expect(campos, hasLength(3));
      for (final c in campos) {
        expect(c.keyboardType, TextInputType.number);
      }
      expect(campos[0].maxLength, 2);
      expect(campos[1].maxLength, 2);
      expect(campos[2].maxLength, 4);
    });
  });
}
