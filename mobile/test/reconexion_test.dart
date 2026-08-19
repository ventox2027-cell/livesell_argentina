import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/core/network/errores_de_red.dart';
import 'package:vendox/core/network/reconexion.dart';
import 'package:vendox/core/network/reintentar_al_volver_la_red.dart';

/// La app se recupera sola cuando vuelve internet.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BUG QUE ESTO CIERRA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Probado en un teléfono: se corta el wifi, vuelve, pasan más de 30 segundos y
/// la pantalla sigue en el error. Sólo revive tocando «Reintentar».
///
/// Y mientras tanto mostraba esto, que es lo que leía la persona:
///
///     DioException [connection error]: The connection errored:
///     Failed host lookup: 'api.vendox.com.ar' (OS Error: No address
///     associated with hostname, errno = 7)
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE NO SE PUEDE ROMPER AL ARREGLARLO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Reintentar solo es fácil. Lo difícil es reintentar POCO: no veinte peticiones
/// de golpe, no pantallas que ya estaban bien, no mutaciones. Buena parte de
/// estos tests están para eso.
void main() {
  /// La red, a mano.
  ///
  /// Cortar el wifi de verdad no es algo que un test pueda hacer, así que el
  /// flujo del sistema operativo se reemplaza por esto.
  late StreamController<List<ConnectivityResult>> red;

  setUp(() => red = StreamController<List<ConnectivityResult>>.broadcast());
  tearDown(() => red.close());

  void seCae() => red.add([ConnectivityResult.none]);
  void vuelve() => red.add([ConnectivityResult.wifi]);

  ProviderContainer contenedor() {
    final c = ProviderContainer(
      overrides: [flujoDeConectividadProvider.overrideWithValue(red.stream)],
    );
    addTearDown(c.dispose);
    // Sin esto el notifier no existe y no escucha nada. Es lo mismo que hace
    // `AppShell` al arrancar.
    c.listen<int>(reconexionProvider, (_, __) {});
    return c;
  }

  /// El error real que devuelve Dio cuando no resuelve el DNS.
  DioException sinDns() => DioException(
        requestOptions: RequestOptions(path: '/discover/products'),
        type: DioExceptionType.connectionError,
        error: const SocketException(
          "Failed host lookup: 'api.vendox.com.ar'",
          osError: OSError('No address associated with hostname', 7),
        ),
      );

  group('El aviso de que volvió la red', () {
    /// ⛔ EL TEST DEL BUG.
    ///
    /// Sin el arreglo, nadie se entera nunca de que la red volvió.
    test('⛔ la red se cae y vuelve: se avisa', () async {
      final c = contenedor();
      final antes = c.read(reconexionProvider);

      seCae();
      vuelve();
      await Future<void>.delayed(const Duration(seconds: 2));

      expect(c.read(reconexionProvider), greaterThan(antes));
    });

    /// ⛔ EL QUE ATRAPA LA VERSIÓN «OBVIA» DEL ARREGLO.
    ///
    /// La implementación natural guarda un `bool habiaRed` y sólo avisa en la
    /// transición. Como este notifier nace DESPUÉS de que la pantalla falló, ese
    /// `bool` arranca en `true` y la vuelta de la red le parece «nada cambió».
    ///
    /// Este test reproduce eso exactamente: la caída ocurre ANTES de que exista
    /// el notifier. Con la versión del `bool`, falla.
    test('⛔ avisa aunque la caída haya sido antes de que nadie escuchara', () async {
      // La red ya está caída. Nadie está mirando todavía.
      seCae();

      final c = contenedor();
      final antes = c.read(reconexionProvider);

      vuelve();
      await Future<void>.delayed(const Duration(seconds: 2));

      expect(c.read(reconexionProvider), greaterThan(antes));
    });

    /// Una caída no avisa: no hay nada que recuperar todavía.
    test('cortarse la red no dispara ningún aviso', () async {
      final c = contenedor();
      final antes = c.read(reconexionProvider);

      seCae();
      await Future<void>.delayed(const Duration(seconds: 2));

      expect(c.read(reconexionProvider), antes);
    });

    /// El parpadeo de una red mala no dispara una ráfaga de avisos.
    ///
    /// Un wifi al límite de la señal emite eventos a repetición. Cada uno
    /// reprograma el aviso en vez de sumar otro.
    test('la red que parpadea produce UN aviso, no cinco', () async {
      final c = contenedor();
      final antes = c.read(reconexionProvider);

      for (var i = 0; i < 5; i++) {
        seCae();
        vuelve();
      }
      await Future<void>.delayed(const Duration(seconds: 2));

      expect(c.read(reconexionProvider), antes + 1);
    });

    /// ⛔ Cambiar de wifi a datos tampoco produce dos avisos.
    ///
    /// Acá no hay ninguna caída de por medio: el sistema emite varios eventos
    /// seguidos con red presente. Sin cancelar el aviso anterior antes de
    /// programar el nuevo, quedan varios temporizadores vivos y la pantalla se
    /// recarga una vez por evento.
    ///
    /// Es el caso que el test del parpadeo NO cubre: ahí cada corte cancelaba el
    /// temporizador por otro camino y tapaba el problema.
    test('⛔ varios eventos seguidos con red presente producen UN aviso', () async {
      final c = contenedor();
      final antes = c.read(reconexionProvider);

      red.add([ConnectivityResult.wifi]);
      red.add([ConnectivityResult.mobile]);
      red.add([ConnectivityResult.wifi, ConnectivityResult.mobile]);
      await Future<void>.delayed(const Duration(seconds: 2));

      expect(c.read(reconexionProvider), antes + 1);
    });
  });

  group('La espera entre reintentos', () {
    /// El primer aviso va casi enseguida. Los siguientes, más espaciados.
    test('crece con cada intento', () {
      var anterior = Duration.zero;
      for (var i = 0; i < maximoDeIntentos; i++) {
        final espera = esperaParaElIntento(i);
        expect(espera, greaterThan(anterior), reason: 'el intento $i no esperó más que el anterior');
        anterior = espera;
      }
    });

    /// ⛔ Sin techo, un portal cautivo —el wifi del hotel que dice «conectado» y
    /// no deja pasar nada— haría reintentar para siempre.
    test('⛔ tiene techo: nunca crece sin límite', () {
      expect(esperaParaElIntento(50), esperaParaElIntento(maximoDeIntentos - 1));
      expect(esperaParaElIntento(50), lessThanOrEqualTo(const Duration(seconds: 30)));
    });

    /// El primero tiene que ser rápido: casi siempre la red volvió de verdad.
    test('el primero es de menos de un segundo', () {
      expect(esperaParaElIntento(0), lessThan(const Duration(seconds: 1)));
    });

    /// ⛔ Cada caída arranca su propia serie.
    ///
    /// Si no se reiniciara, una tarde con varios cortes terminaría con esperas
    /// de 30 segundos en un corte que se resolvió al instante.
    test('⛔ una caída nueva reinicia la serie', () async {
      final c = contenedor();

      seCae();
      vuelve();
      await Future<void>.delayed(const Duration(milliseconds: 900));
      final trasElPrimero = c.read(reconexionProvider);

      // Segunda caída: el próximo aviso tiene que volver a ser el rápido.
      seCae();
      vuelve();
      await Future<void>.delayed(const Duration(milliseconds: 900));

      expect(c.read(reconexionProvider), trasElPrimero + 1);
    });
  });

  group('Qué se reintenta solo y qué no', () {
    /// Un widget de error de mentira, con su contador de recargas.
    Widget pantalla(
      ProviderContainer c, {
      required Object? error,
      required VoidCallback onReintentar,
    }) {
      return UncontrolledProviderScope(
        container: c,
        child: MaterialApp(
          home: ReintentarAlVolverLaRed(
            error: error,
            onReintentar: onReintentar,
            child: const Text('No pudimos cargar'),
          ),
        ),
      );
    }

    /// ⛔ EL COMPORTAMIENTO QUE SE PEDÍA: la pantalla se recarga sola.
    testWidgets('⛔ la pantalla en error se recarga sin que nadie la toque', (tester) async {
      final c = contenedor();
      var recargas = 0;

      await tester.pumpWidget(pantalla(c, error: sinDns(), onReintentar: () => recargas++));
      expect(recargas, 0);

      seCae();
      vuelve();
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();

      expect(recargas, 1);

      // El temporizador de gracia queda vivo; se deja vencer para no arrastrar
      // un timer pendiente al final del test.
      await desmontar(tester);
    });

    /// ⛔ Un error que NO es de red no se reintenta.
    ///
    /// Un 409 no se arregla porque vuelva el wifi. Reintentarlo es ruido, y en
    /// una pantalla con paginación puede ser ruido caro.
    testWidgets('⛔ un error del servidor no se reintenta al volver la red', (tester) async {
      final c = contenedor();
      var recargas = 0;

      final conflicto = DioException(
        requestOptions: RequestOptions(path: '/products'),
        response: Response<dynamic>(
          requestOptions: RequestOptions(path: '/products'),
          statusCode: 409,
        ),
        type: DioExceptionType.badResponse,
      );

      await tester.pumpWidget(pantalla(c, error: conflicto, onReintentar: () => recargas++));

      seCae();
      vuelve();
      await tester.pump(const Duration(seconds: 2));

      expect(recargas, 0);
    });

    /// ⛔ EL TEST DE LAS VEINTE PETICIONES.
    ///
    /// Tres pantallas cacheadas y sólo una rota. Al volver la red se pide UNA
    /// cosa: la que falló. Las otras dos ni se enteran.
    ///
    /// Es la razón de que el reintento viva en el widget de error y no en un
    /// servicio central que invalide todo.
    testWidgets('⛔ con varias pantallas cacheadas sólo recarga la que falló', (tester) async {
      final c = contenedor();
      var recargasDeLaRota = 0;
      var recargasDeLasSanas = 0;

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: c,
          child: MaterialApp(
            home: Column(
              children: [
                // Las dos que cargaron bien no montan el widget: no hay error.
                const Text('feed cargado'),
                const Text('perfil cargado'),
                ReintentarAlVolverLaRed(
                  error: sinDns(),
                  onReintentar: () => recargasDeLaRota++,
                  child: const Text('mi tienda falló'),
                ),
                // Un cuarto widget que representa una pantalla sana que, por
                // error, se hubiera suscrito igual: no debe existir. Se modela
                // como error nulo.
                ReintentarAlVolverLaRed(
                  error: null,
                  onReintentar: () => recargasDeLasSanas++,
                  child: const Text('pedidos cargado'),
                ),
              ],
            ),
          ),
        ),
      );

      seCae();
      vuelve();
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();

      expect(recargasDeLaRota, 1);
      expect(recargasDeLasSanas, 0);

      await desmontar(tester);
    });

    /// ⛔ No se duplica la petición.
    ///
    /// La red parpadea varias veces mientras la pantalla está rota. Se recarga
    /// una sola vez, no una por parpadeo.
    testWidgets('⛔ el parpadeo de la red no dispara recargas repetidas', (tester) async {
      final c = contenedor();
      var recargas = 0;

      await tester.pumpWidget(pantalla(c, error: sinDns(), onReintentar: () => recargas++));

      for (var i = 0; i < 4; i++) {
        seCae();
        vuelve();
      }
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();

      expect(recargas, 1);

      await desmontar(tester);
    });

    /// ⛔ Si el primer reintento falla, se vuelve a intentar más tarde.
    ///
    /// Es el caso real: Android avisa «wifi» en cuanto se asocia al router, un
    /// buen rato antes de que el DNS resuelva. El primer reintento se come ese
    /// hueco. Sin un segundo intento, la pantalla queda rota igual que antes.
    testWidgets('⛔ si el reintento falla porque la red todavía no está, insiste', (tester) async {
      final c = contenedor();
      var recargas = 0;

      // La pantalla sigue en error después de recargar: el widget nunca se
      // desmonta, que es justo la señal de que no funcionó.
      await tester.pumpWidget(pantalla(c, error: sinDns(), onReintentar: () => recargas++));

      seCae();
      vuelve();
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(recargas, 1, reason: 'el primer reintento no salió');

      // Vence la gracia sin que la pantalla se recupere, y llega el segundo.
      await tester.pump(graciaDelReintento);
      await tester.pump(esperaParaElIntento(1));
      await tester.pump();
      expect(recargas, 2, reason: 'no insistió después de que el primero fallara');

      await desmontar(tester);
    });

    /// ⛔ Y si nunca funciona, para.
    ///
    /// Un portal cautivo no se arregla insistiendo. Después del tope queda el
    /// botón, que es una decisión de la persona y no un bucle.
    testWidgets('⛔ deja de insistir después del tope', (tester) async {
      final c = contenedor();
      var recargas = 0;

      await tester.pumpWidget(pantalla(c, error: sinDns(), onReintentar: () => recargas++));

      seCae();
      vuelve();
      // Se deja correr mucho más de lo que suman todas las esperas.
      for (var i = 0; i < maximoDeIntentos + 5; i++) {
        await tester.pump(const Duration(seconds: 35));
        await tester.pump();
      }

      // El número es absoluto y NO `maximoDeIntentos` a propósito: si la cota se
      // escribe en función de la constante, subir la constante hace subir la
      // cota y el test deja de comprobar nada. Acá, un tope de mil reintentos
      // rompe este test, que es lo que se quiere.
      expect(recargas, lessThanOrEqualTo(6));
      expect(recargas, greaterThan(1), reason: 'tiene que haber insistido al menos una vez');
    });

    /// ⛔ Una pantalla que se recupera deja de pedir.
    ///
    /// Cubre la fuga obvia: un temporizador que sigue vivo después de que el
    /// widget se fue y sigue reintentando sobre una pantalla que ya no existe.
    testWidgets('⛔ al recuperarse, no sigue recargando', (tester) async {
      final c = contenedor();
      var recargas = 0;

      await tester.pumpWidget(pantalla(c, error: sinDns(), onReintentar: () => recargas++));

      seCae();
      vuelve();
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(recargas, 1);

      // La pantalla cargó: el widget de error desaparece.
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: c,
          child: const MaterialApp(home: Text('ya cargó')),
        ),
      );
      await tester.pump(const Duration(seconds: 60));
      await tester.pump();

      expect(recargas, 1, reason: 'siguió recargando una pantalla que ya no estaba');
    });
  });

  group('Lo que lee la persona', () {
    /// ⛔ EL TEXTO QUE NO PUEDE APARECER NUNCA.
    test('⛔ un fallo de DNS no muestra el hostname ni el errno', () {
      final mensaje = mensajeDeError(sinDns());

      expect(mensaje, isNot(contains('api.vendox.com.ar')));
      expect(mensaje, isNot(contains('errno')));
      expect(mensaje, isNot(contains('DioException')));
      expect(mensaje, isNot(contains('SocketException')));
      expect(mensaje, isNot(contains('OS Error')));
      expect(mensaje, contains('conexión'));
    });

    /// El mensaje además explica que se arregla solo. Es la mitad del arreglo:
    /// si dice «error», la persona cierra la app en vez de esperar diez
    /// segundos.
    test('avisa que se reintenta solo', () {
      expect(mensajeDeError(sinDns()).toLowerCase(), contains('reintentamos'));
    });

    /// Lo que el backend escribió para leerse, se muestra tal cual.
    test('el mensaje del backend se respeta', () {
      final e = DioException(
        requestOptions: RequestOptions(path: '/products'),
        type: DioExceptionType.badResponse,
        response: Response<dynamic>(
          requestOptions: RequestOptions(path: '/products'),
          statusCode: 409,
          data: {
            'error': {'message': 'Llegaste al tope de 3 productos publicados.'}
          },
        ),
      );

      expect(mensajeDeError(e), 'Llegaste al tope de 3 productos publicados.');
    });

    /// ⛔ El agujero por donde volvería el bug: un `DioException` sin cuerpo ni
    /// código reconocible. Devolver `toString()` acá reintroduce todo.
    test('⛔ un error sin cuerpo tampoco filtra detalles técnicos', () {
      final e = DioException(
        requestOptions: RequestOptions(path: '/x'),
        type: DioExceptionType.badResponse,
        response: Response<dynamic>(requestOptions: RequestOptions(path: '/x'), statusCode: 418),
      );

      expect(mensajeDeError(e), isNot(contains('DioException')));
      expect(mensajeDeError(e), isNot(contains('/x')));
    });

    /// ⛔ Y una excepción cualquiera del sistema, tampoco.
    test('⛔ una excepción del sistema no llega a la pantalla', () {
      const e = SocketException('Connection refused', osError: OSError('ECONNREFUSED', 111));
      expect(mensajeDeError(e), isNot(contains('111')));
      expect(mensajeDeError(e), isNot(contains('Connection refused')));
    });

    /// Un mensaje escrito para leerse pasa entero.
    test('un mensaje de dominio se muestra tal cual', () {
      expect(mensajeDeError(_ErrorDeDominio()), 'No te alcanza el stock.');
    });
  });

  group('Qué cuenta como fallo de red', () {
    test('los timeouts y los cortes de conexión, sí', () {
      for (final tipo in [
        DioExceptionType.connectionError,
        DioExceptionType.connectionTimeout,
        DioExceptionType.sendTimeout,
        DioExceptionType.receiveTimeout,
      ]) {
        final e = DioException(requestOptions: RequestOptions(path: '/'), type: tipo);
        expect(esFalloDeRed(e), isTrue, reason: '$tipo debería contar como red');
      }
    });

    /// ⛔ Un 500 NO es un fallo de red.
    ///
    /// Importa porque decide qué se reintenta solo: si el backend está caído,
    /// reintentar cuando vuelve el wifi no lo levanta, y encima suma carga sobre
    /// algo que ya está mal.
    test('⛔ una respuesta del servidor, no', () {
      final e = DioException(
        requestOptions: RequestOptions(path: '/'),
        type: DioExceptionType.badResponse,
        response: Response<dynamic>(requestOptions: RequestOptions(path: '/'), statusCode: 500),
      );
      expect(esFalloDeRed(e), isFalse);
    });

    /// ⛔ Un error de parseo tampoco, aunque Dio lo clasifique como `unknown`.
    ///
    /// Reintentarlo cuando vuelve el wifi no lo va a arreglar: el JSON va a
    /// venir igual de mal la segunda vez.
    test('⛔ un fallo de parseo no cuenta como red', () {
      final e = DioException(
        requestOptions: RequestOptions(path: '/'),
        type: DioExceptionType.unknown,
        error: const FormatException('campo inesperado'),
      );
      expect(esFalloDeRed(e), isFalse);
    });
  });
}

/// Cierra la pantalla, como cuando la persona se va.
///
/// Al final de cada test hace falta: si el widget queda montado con un
/// temporizador de gracia corriendo, el framework de tests lo denuncia. Y con
/// razón — un temporizador que sobrevive al widget es una fuga, y este mismo
/// aviso es el que atrapa el test «al recuperarse, no sigue recargando».
Future<void> desmontar(WidgetTester tester) => tester.pumpWidget(const SizedBox());

class _ErrorDeDominio implements Exception {
  @override
  String toString() => 'No te alcanza el stock.';
}
