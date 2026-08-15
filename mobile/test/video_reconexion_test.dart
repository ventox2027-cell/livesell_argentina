import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/lives/domain/estado_del_video.dart';
import 'package:vendox/features/lives/domain/live_models.dart';
import 'package:vendox/features/lives/presentation/widgets/video_live.dart';

/// Qué ve quien mira cuando el video se corta.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA PANTALLA NEGRA ERA EL PEOR RESULTADO POSIBLE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// LiveKit puede tardar mucho en avisar que quien transmite se desconectó.
/// Durante ese rato la app creía que todo estaba bien y mostraba negro en
/// silencio: nadie sabe si es la app, la conexión, o que el vivo terminó. La
/// gente se va de un vivo que sigue.
///
/// Estos tests fijan que:
///
///   · el fondo NUNCA es negro liso — está la portada o el degradé;
///   · el cartel dice cosas distintas según qué esté pasando;
///   · el spinner sólo aparece cuando algo puede volver.
///
/// ⚠️ No se prueba el guardián de cuadros en sí: necesita una sala de LiveKit
/// real con estadísticas de recepción, y eso no se simula sin mentir. Lo que se
/// prueba acá es la decisión de qué mostrar, que es donde estaban los errores.
void main() {
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    final vista = TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    vista.physicalSize = const Size(390, 844);
    vista.devicePixelRatio = 1;
  });

  DetalleDeLive live({required String estado}) => DetalleDeLive(
        id: 'liv_1',
        titulo: 'Vivo de prueba',
        estado: estado,
        vendedorId: 'sel_1',
        vendedorNombre: 'Marta',
        storeId: 'sto_1',
        tiendaNombre: 'Tejidos Marta',
      );

  Widget enPantalla(DetalleDeLive l) => MaterialApp(
        home: Scaffold(body: VideoLive(live: l)),
      );

  testWidgets('mientras carga no dice nada', (tester) async {
    /**
     * El primer cuadro tarda unos cuatro segundos. Antes del arreglo, a los dos
     * segundos aparecía "el vendedor está recuperando la conexión" sobre un
     * vendedor perfectamente conectado, en CADA vivo que alguien abría.
     *
     * Después desaparecía solo, que es lo que lo hacía imposible de reportar:
     * "a veces tarda y dice algo raro".
     */
    await tester.pumpWidget(enPantalla(live(estado: 'LIVE')));
    await tester.pump();

    expect(find.textContaining('recuperando'), findsNothing);
    expect(find.textContaining('interrumpida'), findsNothing);
    expect(find.textContaining('terminó'), findsNothing);
  });

  testWidgets('reconectando: lo dice y promete que sigue el negocio', (tester) async {
    await tester.pumpWidget(enPantalla(live(estado: 'RECONNECTING')));
    await tester.pump();

    expect(find.textContaining('recuperando'), findsOneWidget);
    // Lo importante para quien estaba por comprar.
    expect(find.text('Podés seguir comprando'), findsOneWidget);
    // Y hay spinner: esto puede volver.
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('terminado: lo dice y NO gira nada', (tester) async {
    /**
     * Un indicador que gira mientras el mensaje dice que terminó es una
     * contradicción: la animación promete lo que el texto niega, y quien mira
     * se queda esperando.
     */
    await tester.pumpWidget(enPantalla(live(estado: 'ENDED')));
    await tester.pump();

    expect(find.text('Este vivo terminó'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    // Y no sigue diciendo que puede comprar: no hay dónde.
    expect(find.textContaining('seguir comprando'), findsNothing);
  });

  testWidgets('un vivo fallido se cuenta igual que uno terminado', (tester) async {
    // `FAILED` es un vivo que se cayó del lado del servidor. Para quien mira es
    // lo mismo que si hubiera terminado: no va a volver.
    await tester.pumpWidget(enPantalla(live(estado: 'FAILED')));
    await tester.pump();

    expect(find.text('Este vivo terminó'), findsOneWidget);
  });

  testWidgets('⛔ el fondo nunca es negro liso', (tester) async {
    /**
     * El defecto original. Sin portada tampoco se cae a negro: hay un degradé
     * con el ícono de la tienda, que se lee como "acá había algo" y no como
     * "se rompió".
     */
    for (final estado in ['LIVE', 'RECONNECTING', 'ENDED']) {
      await tester.pumpWidget(enPantalla(live(estado: estado)));
      await tester.pump();

      final fondos = tester.widgetList<DecoratedBox>(find.byType(DecoratedBox));
      final hayDegrade = fondos.any(
        (d) => d.decoration is BoxDecoration && (d.decoration as BoxDecoration).gradient != null,
      );
      expect(hayDegrade, isTrue, reason: 'en estado $estado el fondo quedó liso');
    }
  });

  group('La decisión, sin LiveKit de por medio', () {
    /**
     * Acá vive el test que importa. El widget necesita una sala real con
     * estadísticas de recepción para ejercitar el guardián; esto no.
     */

    test('⛔ antes del primer cuadro NUNCA se avisa congelado', () {
      /**
       * EL BUG. El primer cuadro tarda unos cuatro segundos —medido en campo— y
       * el umbral son dos. Sin esta condición, en cada vivo que alguien abría
       * aparecía "el vendedor está recuperando la conexión" sobre un vendedor
       * perfectamente conectado, y después desaparecía solo.
       */
      for (final segundos in [0, 1, 2, 3, 5, 30, 300]) {
        expect(
          videoCongelado(vioAlgunCuadro: false, sinAvance: Duration(seconds: segundos)),
          isFalse,
          reason: 'a los $segundos s sin haber visto un cuadro',
        );
      }
    });

    test('con cuadros vistos, dos segundos sin avance sí es congelado', () {
      expect(
        videoCongelado(vioAlgunCuadro: true, sinAvance: const Duration(seconds: 1)),
        isFalse,
      );
      expect(
        videoCongelado(vioAlgunCuadro: true, sinAvance: const Duration(seconds: 3)),
        isTrue,
      );
    });

    test('justo en el umbral todavía no', () {
      // Un vivo a 30 cuadros por segundo tiene hipos de decenas de
      // milisegundos. El umbral es estricto para no avisar por uno.
      expect(videoCongelado(vioAlgunCuadro: true, sinAvance: umbralDeCongelado), isFalse);
    });

    EstadoDelVideo estado({
      bool terminado = false,
      bool reconectando = false,
      bool vioCuadro = true,
      Duration sinAvance = Duration.zero,
      Duration? desdeElCorte,
    }) =>
        estadoDelVideo(
          terminado: terminado,
          reconectandoSegunBackend: reconectando,
          vioAlgunCuadro: vioCuadro,
          sinAvance: sinAvance,
          desdeElCorte: desdeElCorte,
        );

    test('sin cuadros todavía es CARGANDO, no un fallo', () {
      expect(estado(vioCuadro: false), EstadoDelVideo.cargando);
    });

    test('con cuadros llegando es EN VIVO', () {
      expect(estado(), EstadoDelVideo.enVivo);
    });

    test('congelado hace poco es RECONECTANDO', () {
      expect(
        estado(sinAvance: const Duration(seconds: 5), desdeElCorte: const Duration(seconds: 3)),
        EstadoDelVideo.reconectando,
      );
    });

    test('pasado el umbral largo es INTERRUMPIDO', () {
      expect(
        estado(sinAvance: const Duration(minutes: 1), desdeElCorte: const Duration(seconds: 31)),
        EstadoDelVideo.interrumpido,
      );
    });

    test('lo que dice el backend gana sobre cualquier medición', () {
      /**
       * Si el vivo terminó, ofrecer esperar una reconexión es prometer algo
       * imposible. El orden de las comprobaciones no es casual.
       */
      expect(
        estado(terminado: true, sinAvance: const Duration(seconds: 1)),
        EstadoDelVideo.terminado,
      );
      expect(
        estado(terminado: true, reconectando: true, desdeElCorte: const Duration(seconds: 2)),
        EstadoDelVideo.terminado,
      );
    });

    test('el backend también puede declarar la reconexión solo', () {
      // Llega por el canal de tiempo real y suele adelantarse al guardián.
      expect(estado(reconectando: true), EstadoDelVideo.reconectando);
    });

    test('⛔ un vivo que arranca no se declara reconectando por el backend', () {
      /**
       * El caso combinado que hay que mirar con cuidado: todavía no hay
       * cuadros, pero el backend no dijo nada. Es carga, no fallo.
       */
      expect(estado(vioCuadro: false, reconectando: false), EstadoDelVideo.cargando);
    });
  });
}
