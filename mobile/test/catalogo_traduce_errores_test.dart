import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vendox/core/auth/token_store.dart';
import 'package:vendox/core/config/runtime_config.dart';
import 'package:vendox/core/network/api_client.dart';
import 'package:vendox/features/lives/data/live_api.dart';

/// Qué hace la app con lo que contesta el catálogo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BUG ESTABA EN NO MIRAR EL ESTADO DE LA RESPUESTA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// `ApiClient` NO lanza con 4xx: usa `validateStatus: (s) => s < 500` para poder
/// reintentar después de refrescar el token. `catalogo()` no miraba el estado y
/// le pasaba el cuerpo directo a `PaginaDeCatalogo.fromJson`, que lee a la
/// defensiva y devuelve una página **vacía**.
///
/// Resultado: una tienda con la vidriera apagada se veía exactamente igual que
/// una tienda sin productos. «Todavía no tiene productos publicados» sobre un
/// catálogo lleno que simplemente no se podía mostrar.
///
/// ⚠️ Estos tests ejercitan la TRADUCCIÓN de la respuesta HTTP a excepción, que
/// es donde vivía el error. Los de la pantalla usan dobles que ya lanzan la
/// excepción hecha: prueban qué se dibuja, no cómo se decide.
void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    await RuntimeConfig.load();
  });

  LiveApi apiQueContesta({required int status, required Object cuerpo}) {
    final dio = Dio()..httpClientAdapter = _AdaptadorFijo(status: status, cuerpo: cuerpo);
    return LiveApi(ApiClient(tokens: TokenStore(storage: const FlutterSecureStorage()), dio: dio));
  }

  /**
   * ⛔ LA VIDRIERA APAGADA LLEGA COMO LO QUE ES.
   *
   * El backend la distingue con un código propio, `STOREFRONT_DISABLED`, y la
   * app decide con ese código y nunca con el texto: el mensaje puede cambiar de
   * redacción en cualquier momento y el código no.
   */
  test('⛔ un 404 con STOREFRONT_DISABLED es vidriera apagada', () async {
    final api = apiQueContesta(
      status: 404,
      cuerpo: {
        'error': {
          'code': 'STOREFRONT_DISABLED',
          'message': 'La vidriera de esta tienda no está disponible',
        },
      },
    );

    await expectLater(api.catalogo('sto_1'), throwsA(isA<VidrieraApagada>()));
  });

  /**
   * ⛔ Y UNA TIENDA QUE NO EXISTE, TAMBIÉN.
   *
   * No todos los 404 son vidrieras apagadas. Un enlace viejo apunta a algo que
   * ya no está, y decir «no disponible por el momento» sugeriría que vuelve.
   */
  test('⛔ un 404 sin ese código es tienda no encontrada', () async {
    final api = apiQueContesta(
      status: 404,
      cuerpo: {
        'error': {'code': 'NOT_FOUND', 'message': 'No se encontró la tienda'},
      },
    );

    await expectLater(api.catalogo('sto_1'), throwsA(isA<TiendaNoEncontrada>()));
  });

  /**
   * ⛔ Y NINGUNO DE LOS DOS SE LEE COMO UNA TIENDA VACÍA.
   *
   * Éste es el test que fija el bug original: antes las dos respuestas
   * devolvían una `PaginaDeCatalogo` con la lista vacía, sin lanzar nada.
   */
  test('⛔ un 404 NO devuelve una página vacía', () async {
    for (final codigo in ['STOREFRONT_DISABLED', 'NOT_FOUND']) {
      final api = apiQueContesta(
        status: 404,
        cuerpo: {
          'error': {'code': codigo, 'message': 'no'},
        },
      );

      await expectLater(
        api.catalogo('sto_1'),
        throwsA(anything),
        reason: '$codigo se leyó como catálogo vacío',
      );
    }
  });

  /// Un error del servidor no es ninguna de las dos cosas.
  test('un 500 no se confunde con vidriera apagada', () async {
    final api = apiQueContesta(status: 500, cuerpo: {'error': 'interno'});

    await expectLater(
      api.catalogo('sto_1'),
      throwsA(isNot(isA<VidrieraApagada>())),
    );
  });

  /// Y una respuesta buena sigue siendo una página, con sus productos.
  test('un 200 se lee como el catálogo que es', () async {
    final api = apiQueContesta(
      status: 200,
      cuerpo: {
        'items': [
          {
            'id': 'prd_1',
            'nombre': 'Vela',
            'precioCentavos': 990000,
            'disponible': 3,
            'variantes': 1,
          },
        ],
        'siguienteCursor': null,
      },
    );

    final pagina = await api.catalogo('sto_1');

    expect(pagina.items, hasLength(1));
    expect(pagina.items.first.nombre, 'Vela');
  });
}

/// Un adaptador que contesta siempre lo mismo, sin red.
class _AdaptadorFijo implements HttpClientAdapter {
  _AdaptadorFijo({required this.status, required this.cuerpo});

  final int status;
  final Object cuerpo;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async =>
      ResponseBody.fromString(
        jsonEncode(cuerpo),
        status,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );

  @override
  void close({bool force = false}) {}
}
