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
      app(const EstadoDeCobrosDatos(
        conectada: false,
        disponible: true,
        obligatoria: true,
        puedeVender: false,
      )),
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
      app(const EstadoDeCobrosDatos(
        conectada: false,
        disponible: true,
        obligatoria: false,
        puedeVender: true,
      )),
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
          obligatoria: true,
          puedeVender: true,
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
      app(const EstadoDeCobrosDatos(
        conectada: false,
        disponible: false,
        obligatoria: false,
        puedeVender: true,
      )),
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
    expect(datos.puedeVender, isTrue);
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * CONTRATO — JSON COPIADO DEL SERVIDOR, NO ESCRITO A MANO
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Los dos cuerpos de acá abajo salen de `backend/test/contratos/`, que los
   * escribe el test de integración `oauth-flow.spec.ts` con la respuesta real
   * de `GET /sellers/me/payment-account` — el caso conectado recorre el
   * callback de OAuth entero.
   *
   * Ya pasó una vez y costó caro: un test de contrato escrito con un JSON
   * inventado pasaba en verde mientras la app mostraba `$0,00`. El JSON
   * inventado se parecía al real, pero no lo era.
   *
   * Si estos tests fallan después de tocar el backend, el que está mal es el
   * JSON de acá: hay que volver a correr la captura, no editarlo a mano.
   */

  /// `test/contratos/cobros-sin-conectar.json`
  const sinConectar = <String, dynamic>{
    'disponible': true,
    'conectada': false,
    'estado': 'NOT_CONNECTED',
    'cuentaDeMercadoPago': null,
    'conectadaEl': null,
    'desconectadaEl': null,
    'venceEl': null,
    'ultimaRenovacion': null,
    'tokenTerminaEn': null,
    'comisionBps': 600,
    'mercadoPagoObligatorio': true,
    'puedeVender': false,
    'faltaConectar': true,
  };

  /// `test/contratos/cobros-conectada.json`
  const conectada = <String, dynamic>{
    'disponible': true,
    'conectada': true,
    'estado': 'CONNECTED',
    'cuentaDeMercadoPago': '987654321',
    'conectadaEl': '2026-08-15T02:09:36.418Z',
    'desconectadaEl': null,
    'venceEl': '2027-02-11T02:09:36.416Z',
    'ultimaRenovacion': null,
    'tokenTerminaEn': '····tado',
    'comisionBps': 600,
    'mercadoPagoObligatorio': true,
    'puedeVender': true,
    'faltaConectar': false,
  };

  testWidgets('contrato: sin conectar, con la regla activa', (tester) async {
    final datos = EstadoDeCobrosDatos.fromJson(sinConectar);

    expect(datos.disponible, isTrue);
    expect(datos.conectada, isFalse);
    expect(datos.obligatoria, isTrue);
    expect(datos.puedeVender, isFalse);
    expect(datos.cuenta, isNull);
  });

  testWidgets('contrato: conectada — obligatoria SIGUE siendo true', (tester) async {
    /**
     * Este es el test que existe por el bug de nombres.
     *
     * El campo se llamaba `obligatoriaParaVender` y para un vendedor YA
     * conectado valía `false`. Leído desde afuera parecía decir que Mercado
     * Pago no era obligatorio — cuando sí lo es. La regla y la falta son dos
     * preguntas distintas y ahora son dos campos distintos.
     */
    final datos = EstadoDeCobrosDatos.fromJson(conectada);

    expect(datos.conectada, isTrue);
    expect(datos.cuenta, '987654321');
    // La REGLA no se apaga porque este vendedor se haya conectado.
    expect(datos.obligatoria, isTrue);
    expect(datos.puedeVender, isTrue);
  });

  testWidgets('⛔ el contrato no trae ningún token', (tester) async {
    /**
     * Lo único que sale del servidor sobre el token es una pista de cuatro
     * caracteres. Un access token de Mercado Pago empieza con `APP_USR-` y el
     * de refresco con `TG-`.
     */
    for (final cuerpo in [sinConectar, conectada]) {
      final texto = cuerpo.toString();
      expect(texto.contains('APP_USR-'), isFalse);
      expect(texto.contains('TG-'), isFalse);
    }
  });
}
