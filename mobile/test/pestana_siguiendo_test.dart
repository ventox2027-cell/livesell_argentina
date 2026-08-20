import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vendox/core/auth/token_store.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/network/api_client.dart';
import 'package:vendox/features/auth/domain/session.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';
import 'package:vendox/features/feed/data/feed_repository.dart';
import 'package:vendox/features/feed/domain/pestana_del_feed.dart';
import 'package:vendox/features/social/data/seguimientos.dart';

/// La pestaña «Siguiendo» del feed.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE PASABA ANTES
/// ═══════════════════════════════════════════════════════════════════════════
///
/// «Siguiendo» estaba dibujada al lado de «Para vos» con el subrayado apagado y
/// **nada que la escuchara**: sin `onTap`, sin estado, sin provider, sin
/// endpoint. Tocarla no hacía nada porque no había nada que hacer.
///
/// Estos tests fijan las tres piezas que faltaban: que la elección de pestaña
/// exista y no recargue nada, que el pedido lleve el filtro **y el token**, y
/// que seguir a alguien se note sin reiniciar la app.
void main() {
  late _BackendFalso backend;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    await RuntimeConfig.load();
  });

  setUp(() {
    backend = _BackendFalso();

    /**
     * Un token en el llavero.
     *
     * El interceptor de `ApiClient` sólo adjunta `authorization` si hay uno
     * guardado. Sin esto, «Siguiendo» viajaría sin token en el test por un
     * motivo que no tiene nada que ver con lo que se prueba — y el test pasaría
     * a comprobar el llavero vacío en vez del filtro.
     */
    FlutterSecureStorage.setMockInitialValues({
      'auth.access': 'token-de-prueba',
      'auth.expiraEn': DateTime.now().add(const Duration(hours: 1)).toIso8601String(),
    });
  });

  /// Sólo los pedidos del feed.
  ///
  /// El `POST /follow` también pasa por este adaptador, y contarlo haría que
  /// «seguir no recarga Para vos» fallara por la petición que el propio test
  /// acaba de hacer.
  List<_Pedido> feedPedidos() =>
      backend.pedidos.where((p) => p.ruta.startsWith('/discover')).toList();

  ProviderContainer contenedor({bool conSesion = true}) {
    final dio = Dio()..httpClientAdapter = backend;
    final api = ApiClient(tokens: TokenStore(storage: const FlutterSecureStorage()), dio: dio);

    final c = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        if (conSesion) sesionProvider.overrideWith(_ConSesion.new),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  group('La elección de pestaña', () {
    test('arranca en «Para vos»', () {
      final c = contenedor();
      expect(c.read(pestanaDelFeedProvider), PestanaDelFeed.paraVos);
      expect(c.read(pestanaDelFeedProvider).esSiguiendo, isFalse);
    });

    /// ⛔ LA PESTAÑA CAMBIA. Es lo que no pasaba.
    test('⛔ elegir «Siguiendo» cambia el estado', () {
      final c = contenedor();

      c.read(pestanaDelFeedProvider.notifier).elegir(PestanaDelFeed.siguiendo);

      expect(c.read(pestanaDelFeedProvider).esSiguiendo, isTrue);
    });

    /**
     * ⛔ Y VOLVER NO CUESTA UNA PETICIÓN.
     *
     * Cada pestaña guarda su lista. Ir a «Siguiendo», volver a «Para vos» y
     * volver otra vez no puede pedir el feed cuatro veces ni perder el lugar
     * donde alguien estaba mirando.
     */
    test('⛔ ir y volver entre pestañas no pide nada de nuevo', () async {
      final c = contenedor();
      await c.read(feedProvider.future);
      await c.read(feedDeSeguidosProvider.future);
      final pedidosIniciales = feedPedidos().length;

      final notifier = c.read(pestanaDelFeedProvider.notifier);
      notifier.elegir(PestanaDelFeed.siguiendo);
      notifier.elegir(PestanaDelFeed.paraVos);
      notifier.elegir(PestanaDelFeed.siguiendo);
      await Future<void>.delayed(Duration.zero);

      expect(feedPedidos().length, pedidosIniciales);
    });
  });

  group('Qué se le pide al backend', () {
    /// «Para vos» sigue siendo el feed de siempre: sin filtro.
    test('«Para vos» no manda el filtro', () async {
      final c = contenedor();
      await c.read(feedProvider.future);

      expect(feedPedidos().single.siguiendo, isNull);
    });

    /// ⛔ «Siguiendo» manda el filtro.
    test('⛔ «Siguiendo» pide sólo lo de los seguidos', () async {
      final c = contenedor();
      await c.read(feedDeSeguidosProvider.future);

      expect(feedPedidos().single.siguiendo, 'true');
    });

    /**
     * ⛔ Y VIAJA CON TOKEN.
     *
     * «Para vos» va sin autenticación a propósito —quien no se registró tiene
     * que poder mirar—, y `descubrir` heredaba ese `sinAuth` para las dos
     * pestañas. Sin el token, el backend no sabe quién pregunta: contesta una
     * lista vacía y «Siguiendo» se ve rota para alguien que sí sigue gente.
     */
    test('⛔ «Siguiendo» viaja autenticado y «Para vos» no', () async {
      final c = contenedor();

      await c.read(feedDeSeguidosProvider.future);
      expect(feedPedidos().single.conToken, isTrue);

      backend.pedidos.clear();
      await c.read(feedProvider.future);
      expect(feedPedidos().single.conToken, isFalse);
    });

    /// Las dos pestañas leen la misma respuesta con el mismo parseo.
    test('lo que vuelve se parsea igual en las dos', () async {
      final c = contenedor();

      expect((await c.read(feedProvider.future)).single.nombre, 'Buzo de lana');
      expect((await c.read(feedDeSeguidosProvider.future)).single.nombre, 'Buzo de lana');
    });
  });

  group('Cuando no sigo a nadie', () {
    /**
     * ⛔ VACÍO, NO ERROR.
     *
     * El backend contesta 200 con una lista vacía. La pantalla dibuja el estado
     * amigable con eso; si acá llegara una excepción, mostraría la pantalla de
     * error técnico.
     */
    test('⛔ una lista vacía no es un error', () async {
      backend.vacio = true;
      final c = contenedor();

      expect(await c.read(feedDeSeguidosProvider.future), isEmpty);
    });
  });

  group('Seguir y dejar de seguir', () {
    /**
     * ⛔ EL BUG DE «HAY QUE REINICIAR LA APP».
     *
     * Se sigue a alguien desde el vivo o desde su perfil, y ninguno de los dos
     * sabe que la pestaña «Siguiendo» existe. Con la llamada suelta en cada
     * pantalla, el feed de seguidos se quedaba con la lista vieja hasta la
     * próxima apertura.
     */
    test('⛔ seguir a alguien rearma el feed de seguidos', () async {
      final c = contenedor();
      await c.read(feedDeSeguidosProvider.future);
      final antes = feedPedidos().length;

      await c.read(seguimientosProvider.notifier).seguir('sel_1');
      await c.read(feedDeSeguidosProvider.future);

      expect(feedPedidos().length, greaterThan(antes));
    });

    test('⛔ dejar de seguir también', () async {
      final c = contenedor();
      await c.read(feedDeSeguidosProvider.future);
      final antes = feedPedidos().length;

      await c.read(seguimientosProvider.notifier).dejarDeSeguir('sel_1');
      await c.read(feedDeSeguidosProvider.future);

      expect(feedPedidos().length, greaterThan(antes));
    });

    /**
     * ⛔ Y «PARA VOS» NO SE MUEVE.
     *
     * Seguir a alguien no cambia lo que muestra el feed general. Recargarlo
     * igual tiraría a la basura la posición de scroll de la persona por un
     * toque que no tiene nada que ver.
     */
    test('⛔ seguir a alguien NO recarga «Para vos»', () async {
      final c = contenedor();
      await c.read(feedProvider.future);
      final antes = feedPedidos().length;

      await c.read(seguimientosProvider.notifier).seguir('sel_1');
      await c.read(feedProvider.future);

      expect(feedPedidos().length, antes);
    });

    /**
     * ⛔ UN FOLLOW QUE FALLÓ NO AVISA NADA.
     *
     * No cambió a quién sigo, así que rearmar la pestaña sería una petición de
     * más por cada toque fallido — justo cuando la red anda mal.
     */
    test('⛔ si el follow falla, la versión no se mueve', () async {
      final c = contenedor();
      final antes = c.read(seguimientosProvider);
      backend.followFalla = true;

      await expectLater(
        c.read(seguimientosProvider.notifier).seguir('sel_1'),
        throwsA(anything),
      );

      expect(c.read(seguimientosProvider), antes);
    });
  });
}

/// Un pedido al backend, tal como salió.
typedef _Pedido = ({String ruta, String? siguiendo, bool conToken});

class _BackendFalso implements HttpClientAdapter {
  final List<_Pedido> pedidos = [];

  bool vacio = false;
  bool followFalla = false;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final ruta = options.path.replaceFirst(RegExp(r'^.*/api/v\d+'), '');
    pedidos.add((
      ruta: ruta,
      siguiendo: options.queryParameters['siguiendo']?.toString(),
      conToken: options.headers.containsKey('authorization'),
    ));

    if (ruta.contains('/follow')) {
      if (followFalla) return _json(500, {'error': 'no'});
      return _json(200, {'siguiendo': options.method == 'POST', 'seguidores': 1});
    }

    return _json(200, {
      'items': vacio ? <dynamic>[] : [_producto],
      'nextCursor': null,
    });
  }

  static ResponseBody _json(int status, Object cuerpo) => ResponseBody.fromString(
        jsonEncode(cuerpo),
        status,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );

  static final Map<String, dynamic> _producto = {
    'id': 'prd_1',
    'name': 'Buzo de lana',
    'slug': 'buzo-de-lana',
    'basePriceCents': 3200000,
    'currency': 'ARS',
    'store': {'id': 'sto_1', 'name': 'Lanas del Sur', 'slug': 'lanas'},
    'seller': {'id': 'sel_1', 'displayName': 'Ana'},
    'images': <dynamic>[],
    'variants': <dynamic>[],
  };

  @override
  void close({bool force = false}) {}
}

/// Una sesión abierta que no toca el llavero.
class _ConSesion extends SesionNotifier {
  @override
  EstadoSesion build() => ConSesion(
        usuario: Usuario.fromJson(const {
          'id': 'usr_prueba',
          'firstName': 'Ana',
          'lastName': 'Prueba',
          'email': 'ana@test.com',
          'role': 'user',
        }),
      );

  @override
  Future<void> restaurar() async {}
}
