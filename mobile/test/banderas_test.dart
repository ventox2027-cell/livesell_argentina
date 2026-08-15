import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/auth/data/auth_config.dart';
import 'package:vendox/features/auth/data/banderas.dart';
import 'package:vendox/shared/widgets/aviso_de_pausa.dart';

/// Los interruptores de emergencia, del lado de la app.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA APP NO APLICA LA REGLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El backend rechaza con un 503 sin importar lo que la app crea. Esto sirve
/// para no dejar que alguien elija la variante, cargue la dirección, elija el
/// envío y recién en el último toque se entere de que las compras están
/// pausadas.
void main() {
  group('Leer las banderas', () {
    test('⛔ un backend que no las manda deja todo encendido', () {
      /**
       * Una app nueva contra un servidor viejo.
       *
       * La falta de información no es una emergencia: la emergencia la declara
       * el servidor diciéndolo. Si el valor por defecto fuera `false`, la
       * primera versión del backend sin este campo dejaría a todo el mundo con
       * la app apagada.
       */
      final b = Banderas.fromJson(null);

      expect(b.vivos, isTrue);
      expect(b.checkout, isTrue);
      expect(b.altaDeVendedores, isTrue);
      expect(b.cargaDeProductos, isTrue);
      expect(b.algoPausado, isFalse);
    });

    test('un campo que falta también queda encendido', () {
      // Mismo motivo, un nivel más abajo: agregar una quinta bandera al backend
      // no puede apagar nada en las apps que todavía no la conocen.
      final b = Banderas.fromJson({'CHECKOUT_ENABLED': false});

      expect(b.checkout, isFalse);
      expect(b.vivos, isTrue);
      expect(b.algoPausado, isTrue);
    });

    test('se leen las cuatro', () {
      final b = Banderas.fromJson({
        'LIVE_ENABLED': false,
        'CHECKOUT_ENABLED': false,
        'SELLER_SIGNUP_ENABLED': false,
        'PRODUCT_UPLOAD_ENABLED': false,
      });

      expect([b.vivos, b.checkout, b.altaDeVendedores, b.cargaDeProductos],
          everyElement(isFalse));
    });

    test('llegan desde /auth/config sin romper el resto', () {
      // El campo es nuevo: un backend que lo manda no puede alterar cómo se
      // leen los que ya estaban.
      const config = AuthConfig(
        googleServerClientId: 'abc.apps.googleusercontent.com',
        banderas: Banderas(checkout: false),
      );

      expect(config.googleDisponible, isTrue);
      expect(config.banderas.checkout, isFalse);
      expect(config.banderas.vivos, isTrue);
    });
  });

  group('El aviso de pausa', () {
    Widget conConfig(AuthConfig config, Widget hijo) => ProviderScope(
          overrides: [authConfigProvider.overrideWith((ref) async => config)],
          child: MaterialApp(home: Scaffold(body: hijo)),
        );

    testWidgets('con la bandera encendida no ocupa lugar', (tester) async {
      await tester.pumpWidget(
        conConfig(
          const AuthConfig(),
          AvisoDePausa(mostrarSi: (b) => !b.checkout, texto: Banderas.avisoDeCheckout),
        ),
      );
      await tester.pump();

      expect(find.textContaining('pausadas'), findsNothing);
    });

    testWidgets('⛔ apagada, explica qué pasa y que es temporal', (tester) async {
      await tester.pumpWidget(
        conConfig(
          const AuthConfig(banderas: Banderas(checkout: false)),
          AvisoDePausa(mostrarSi: (b) => !b.checkout, texto: Banderas.avisoDeCheckout),
        ),
      );
      await tester.pump();

      expect(find.textContaining('pausadas por unos minutos'), findsOneWidget);
      // Y le dice que no perdió nada: sin eso, lo primero que hace es volver a
      // intentar y duplicar la reserva.
      expect(find.textContaining('carrito no se pierde'), findsOneWidget);
    });

    testWidgets('mientras la config no llegó, no muestra nada', (tester) async {
      /**
       * Un cartel de "pausado" que aparece por un instante mientras carga
       * asusta más de lo que informa — y aparecería en cada arranque, que es
       * cuando todo está bien.
       */
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authConfigProvider.overrideWith((ref) => Future<AuthConfig>.value(const AuthConfig())),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: AvisoDePausa(
                mostrarSi: (b) => !b.checkout,
                texto: Banderas.avisoDeCheckout,
              ),
            ),
          ),
        ),
      );
      // Sin `pump` extra: el futuro todavía no resolvió.
      expect(find.textContaining('pausadas'), findsNothing);
    });
  });
}
