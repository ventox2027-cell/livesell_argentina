import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/seller/presentation/widgets/estado_de_cobros.dart';

/// La tarjeta de Mercado Pago en "Mi tienda".
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BUG QUE ESTE ARCHIVO EXISTE PARA IMPEDIR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La pantalla de conectar Mercado Pago estaba en Ajustes → Cobros: a dos
/// toques y sin ninguna señal de que hiciera falta. Alguien podía cargar veinte
/// productos, tocar "publicar" y recibir un error sobre algo que nunca vio.
///
/// Lo que se verifica es que el estado esté a la vista en la primera pantalla,
/// que diga QUÉ no puede hacer sin conectar, y que cuando ya está conectado no
/// grite.
void main() {
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    final vista = TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    vista.physicalSize = const Size(390, 844);
    vista.devicePixelRatio = 1;
  });

  Widget app(EstadoDeCobrosDatos datos) => ProviderScope(
        overrides: [
          estadoDeCobrosProvider.overrideWith((ref) async => datos),
        ],
        child: const MaterialApp(
          home: Scaffold(body: SingleChildScrollView(child: EstadoDeCobros())),
        ),
      );

  testWidgets('sin conectar y obligatorio: dice QUÉ no puede hacer', (tester) async {
    /**
     * "Es obligatorio conectar Mercado Pago" suena a trámite nuestro. "Sin esto
     * no podés publicar ni hacer vivos" es información que le sirve para
     * decidir si hacerlo ahora.
     */
    await tester.pumpWidget(
      app(const EstadoDeCobrosDatos(conectada: false, disponible: true, obligatoria: true)),
    );
    await tester.pump();

    expect(find.text('Conectar Mercado Pago'), findsOneWidget);
    expect(find.text('No conectado'), findsOneWidget);
    expect(find.textContaining('no podés publicar'), findsOneWidget);
    expect(find.textContaining('vivos'), findsOneWidget);
  });

  testWidgets('sin conectar pero no obligatorio: invita, no amenaza', (tester) async {
    // Con la regla apagada —el interruptor de incidente— el texto no puede
    // seguir diciendo que no puede vender, porque sí puede.
    await tester.pumpWidget(
      app(const EstadoDeCobrosDatos(conectada: false, disponible: true, obligatoria: false)),
    );
    await tester.pump();

    expect(find.text('Conectar Mercado Pago'), findsOneWidget);
    expect(find.textContaining('no podés publicar'), findsNothing);
    expect(find.textContaining('entra directo a tu cuenta'), findsOneWidget);
  });

  testWidgets('conectado: una línea y el número de cuenta', (tester) async {
    /**
     * Un cartel grande permanente sobre algo ya resuelto es ruido, y el ruido
     * enseña a ignorar la pantalla entera. El id de cuenta no es secreto y le
     * sirve para confirmar que conectó la que quería.
     */
    await tester.pumpWidget(
      app(
        const EstadoDeCobrosDatos(
          conectada: true,
          disponible: true,
          obligatoria: false,
          cuenta: '987654321',
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Mercado Pago conectado'), findsOneWidget);
    expect(find.text('Cuenta 987654321'), findsOneWidget);
    // Y NO el botón grande.
    expect(find.text('Conectar Mercado Pago'), findsNothing);
  });

  testWidgets('⛔ si el servidor no lo tiene habilitado, no se muestra nada', (tester) async {
    // Ofrecer conectar algo que este servidor no puede conectar sería mandar a
    // la persona a una pantalla que termina en error.
    await tester.pumpWidget(
      app(const EstadoDeCobrosDatos(conectada: false, disponible: false, obligatoria: false)),
    );
    await tester.pump();

    expect(find.text('Conectar Mercado Pago'), findsNothing);
    expect(find.text('Mercado Pago conectado'), findsNothing);
  });

  testWidgets('⛔ un cuerpo raro no dice que no puede vender', (tester) async {
    /**
     * Lectura defensiva. Un fallo de red no puede hacer que la app le diga a un
     * vendedor que no puede vender: el backend lo va a frenar igual si
     * corresponde, con un mensaje que explica por qué.
     */
    final datos = EstadoDeCobrosDatos.fromJson(null);

    expect(datos.obligatoria, isFalse);
    expect(datos.conectada, isFalse);
    expect(datos.disponible, isFalse);
  });

  testWidgets('lee la respuesta real del servidor', (tester) async {
    // Los nombres de los campos salen de `GET /sellers/me/payment-account`.
    final datos = EstadoDeCobrosDatos.fromJson(const {
      'disponible': true,
      'conectada': true,
      'estado': 'CONNECTED',
      'cuentaDeMercadoPago': '987654321',
      'comisionBps': 600,
      'obligatoriaParaVender': false,
      'tokenTerminaEn': '····a3f9',
    });

    expect(datos.conectada, isTrue);
    expect(datos.disponible, isTrue);
    expect(datos.cuenta, '987654321');
    expect(datos.obligatoria, isFalse);
  });
}
