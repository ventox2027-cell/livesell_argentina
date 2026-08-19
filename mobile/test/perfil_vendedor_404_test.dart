import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/core/network/api_client.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';

/// Qué significa un 404 al preguntar por el perfil de vendedor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA DIFERENCIA ENTRE «NO SOS VENDEDOR» Y «ALGO SALIÓ MAL»
/// ═══════════════════════════════════════════════════════════════════════════
///
/// `miPerfil()` devuelve `null` para decirle a la pantalla «ofrecele crear su
/// tienda». Ese `null` tiene que salir de UNA sola respuesta: el código de
/// dominio `SELLER_NOT_FOUND`.
///
/// Cualquier otro 404 —una ruta que el servidor no sirve, una función apagada,
/// un 404 del borde antes de llegar a la aplicación— no dice nada sobre si la
/// persona tiene tienda. Traducirlo a `null` le ofrece crear una que ya existe.
class _ApiDeUnaRespuesta extends Fake implements ApiClient {
  _ApiDeUnaRespuesta(this.status, this.cuerpo);

  final int status;
  final Map<String, dynamic>? cuerpo;

  @override
  Future<Response<T>> get<T>(String path, {Map<String, dynamic>? query, bool sinAuth = false}) async {
    return Response<T>(
      requestOptions: RequestOptions(path: path),
      statusCode: status,
      data: cuerpo as T?,
    );
  }
}

void main() {
  SellerRepository conRespuesta(int status, Map<String, dynamic>? cuerpo) =>
      SellerRepository(_ApiDeUnaRespuesta(status, cuerpo));

  group('miPerfil y el 404', () {
    test('el 404 del dominio significa «todavía no sos vendedor»', () async {
      final repo = conRespuesta(404, {
        'error': {'code': 'SELLER_NOT_FOUND', 'message': 'Todavía no tenés un perfil de vendedor'},
      });

      expect(await repo.miPerfil(), isNull);
    });

    /// ⛔ EL BUG.
    ///
    /// Un 404 que no habla de vendedores no puede leerse como «no tenés
    /// tienda». Si la app lo tradujera a `null`, le ofrecería crear una tienda
    /// que quizá ya existe — sin error, sin log, y con la persona convencida
    /// de que la suya se perdió.
    test('⛔ un 404 de ruta NO significa que no tenga tienda', () async {
      final repo = conRespuesta(404, {
        'error': {'code': 'NOT_FOUND', 'message': 'No disponible'},
      });

      await expectLater(repo.miPerfil(), throwsA(isA<ComercioException>()));
    });

    test('⛔ un 404 sin cuerpo tampoco', () async {
      final repo = conRespuesta(404, null);

      await expectLater(repo.miPerfil(), throwsA(isA<ComercioException>()));
    });

    test('⛔ un 500 sigue siendo un error', () async {
      final repo = conRespuesta(500, {
        'error': {'code': 'INTERNAL_ERROR', 'message': 'Error interno'},
      });

      await expectLater(repo.miPerfil(), throwsA(isA<ComercioException>()));
    });

    test('un 200 devuelve el perfil', () async {
      final repo = conRespuesta(200, {
        'seller': {
          'id': 'sel_1',
          'displayName': 'Tejidos del Sur',
          'slug': 'tejidos-del-sur',
          'status': 'ACTIVE',
          'verificationStatus': 'NONE',
          'followersCount': 0,
          'ratingCount': 0,
        },
        'store': {
          'id': 'sto_1',
          'sellerId': 'sel_1',
          'name': 'Tejidos del Sur',
          'slug': 'tejidos-del-sur',
          'status': 'ACTIVE',
          'isPrimary': true,
        },
        'stats': {'productos': 0},
      });

      final perfil = await repo.miPerfil();

      expect(perfil, isNotNull);
      expect(perfil!.store!.name, 'Tejidos del Sur');
    });
  });
}
