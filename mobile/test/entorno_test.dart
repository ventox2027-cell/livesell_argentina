import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendox/core/config/entorno.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/features/auth/data/auth_config.dart';
import 'package:vendox/features/auth/presentation/welcome_screen.dart';

/// Lo que NO puede viajar en la APK de Google Play.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ HAY TESTS QUE LEEN EL CÓDIGO FUENTE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// `Entorno.herramientas` es una constante de compilación —tiene que serlo,
/// porque de eso depende que el compilador elimine el código y no quede en el
/// binario— y por lo tanto no se puede cambiar desde un test: en la compilación
/// de test siempre vale `true`.
///
/// O sea que un test de widget no puede verificar la APK de producción. Lo
/// único que puede fallar de verdad si alguien saca la condición es mirar el
/// código, así que eso es lo que se hace.
///
/// Es crudo. La alternativa era no tener nada verificando el requisito más
/// concreto de esta parte: que un revisor de Google no encuentre una pantalla
/// de medición de latencia de LiveKit adentro de una app de compras.
void main() {
  group('La UI de desarrollo está detrás de la bandera', () {
    String fuente(String ruta) => File(ruta).readAsStringSync();

    test('⛔ las herramientas del Sprint 0 no se muestran sin la bandera', () {
      final codigo = fuente('lib/features/profile/presentation/profile_screen.dart');

      final gate = codigo.indexOf('if (Entorno.herramientas)');
      final spike = codigo.indexOf('SpikeHomeScreen()');

      expect(gate, isNot(-1), reason: 'Desapareció la condición que esconde la sección.');
      expect(
        spike,
        greaterThan(gate),
        reason: 'SpikeHomeScreen quedó fuera del bloque de herramientas: viaja en la APK pública.',
      );
    });

    test('⛔ la URL del backend tampoco', () {
      // Le regala a cualquiera el objetivo a atacar sin tener que abrir la APK.
      final codigo = fuente('lib/features/profile/presentation/profile_screen.dart');

      expect(
        codigo.indexOf('RuntimeConfig.instance.apiBaseUrl'),
        greaterThan(codigo.indexOf('if (Entorno.herramientas)')),
      );
    });

    test('⛔ "Configurar servidor" tampoco', () {
      /**
       * Es el más grave de los tres: un botón que apunta la app al servidor que
       * uno quiera. En el teléfono de otra persona, eso es redirigirla a un
       * servidor propio y ver pasar todo lo que la app manda.
       */
      final codigo = fuente('lib/features/auth/presentation/welcome_screen.dart');

      final gate = codigo.indexOf('if (Entorno.herramientas)');
      final boton = codigo.indexOf("etiqueta: 'Configurar servidor'");

      expect(gate, isNot(-1));
      expect(boton, greaterThan(gate));
      expect(boton - gate, lessThan(120), reason: 'La condición ya no es la que envuelve al botón.');
    });

    test('en la compilación de test las herramientas están encendidas', () {
      // Es la premisa de los tres tests de arriba: si esto fuera false, mirarían
      // un código que no es el que corre.
      expect(Entorno.herramientas, isTrue);
      expect(Entorno.esParaLaGente, isFalse);
    });
  });

  group('Los accesos de servicio', () {
    // La pantalla lee la URL guardada al construir el cliente HTTP, y sin esto
    // `RuntimeConfig.instance` tira `Bad state`. Con el almacenamiento vacío
    // toma el valor por defecto de compilación, que es lo que corresponde.
    setUpAll(() async {
      SharedPreferences.setMockInitialValues({});
      await RuntimeConfig.load();
    });

    // Dos `pump` y no `pumpAndSettle`.
    //
    // El fondo de la bienvenida es una animación que no termina nunca, así que
    // `pumpAndSettle` espera para siempre y se cae por timeout. Dos cuadros
    // alcanzan: uno pinta, el otro resuelve el `FutureProvider` de la config.
    //
    // La pantalla ancha es porque los tres accesos en una fila desbordan el
    // viewport de 800x600 por defecto, y un overflow rojo hace fallar el test
    // por un motivo que no es el que se está probando.
    Future<void> abrir(WidgetTester tester, Widget w) async {
      tester.view.physicalSize = const Size(1400, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(w);
      await tester.pump();
    }

    Widget pantalla(AuthConfig config) => ProviderScope(
          overrides: [authConfigProvider.overrideWith((ref) async => config)],
          child: const MaterialApp(home: WelcomeScreen()),
        );

    testWidgets('⛔ con un solo acceso no queda un separador colgando', (tester) async {
      /**
       * El bug: cada acceso opcional agregaba su botón Y un `·` detrás. Con los
       * tres visibles se leía bien; con uno solo quedaba «Configurar servidor ·».
       *
       * Y ese iba a ser el caso normal en la APK pública — justamente el que
       * nadie mira mientras desarrolla, porque en debug están los tres.
       */
      await abrir(tester, pantalla(const AuthConfig()));

      expect(find.text('Configurar servidor'), findsOneWidget);
      expect(find.text('Entrar en modo prueba'), findsNothing);
      expect(find.text('·'), findsNothing);
    });

    testWidgets('con dos, un separador entre medio', (tester) async {
      await abrir(tester, pantalla(const AuthConfig(demoLoginEnabled: true)));

      expect(find.text('Acceso de revisión'), findsOneWidget);
      expect(find.text('Configurar servidor'), findsOneWidget);
      expect(find.text('·'), findsOneWidget);
    });

    testWidgets('con los tres, dos separadores', (tester) async {
      await abrir(tester, pantalla(const AuthConfig(devLoginEnabled: true, demoLoginEnabled: true)));

      expect(find.text('·'), findsNWidgets(2));
    });
  });
}
