import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/domain/session.dart';
import '../../auth/state/auth_providers.dart';
import '../../social/data/seguimientos.dart';
import '../domain/feed_models.dart';

/// Fuente del feed.
///
/// Va **sin autenticación**: alguien que todavía no se registró tiene que
/// poder ver qué se vende. La sesión se pide recién al comprar.
class FeedRepository {
  FeedRepository(this._ref);
  final Ref _ref;

  /// El feed, con búsqueda opcional.
  ///
  /// El mismo endpoint sirve para las dos cosas: con `q` el orden lo da la
  /// relevancia del texto, sin `q` lo da la frescura con un empujón por
  /// interés. Un endpoint aparte para buscar duplicaría el armado de la tarjeta
  /// del producto, que es lo más complejo de la respuesta.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// `soloSeguidos` ES LA PESTAÑA «SIGUIENDO»
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Mismo endpoint, un filtro más. El backend resuelve a quién sigue esta
  /// persona y restringe el feed a esos vendedores.
  ///
  /// ⚠️ Y ES EL ÚNICO CASO QUE VIAJA CON TOKEN.
  ///
  /// «Para vos» va sin autenticación a propósito: quien todavía no se registró
  /// tiene que poder ver qué se vende. Pero «a quién sigo» no se puede resolver
  /// sin saber quién pregunta — sin el token, el backend contesta una lista
  /// vacía y la pestaña se ve rota para alguien que sí sigue gente.
  Future<({List<PublicacionFeed> items, String? nextCursor})> descubrir({
    String? cursor,
    int limit = 20,
    String? q,
    bool soloSeguidos = false,
  }) async {
    final res = await _ref.read(apiClientProvider).get<Map<String, dynamic>>(
          '/discover/products',
          query: {
            'limit': limit,
            if (cursor != null) 'cursor': cursor,
            if (q != null && q.trim().length >= 2) 'q': q.trim(),
            if (soloSeguidos) 'siguiendo': true,
          },
          sinAuth: !soloSeguidos,
        );

    if (res.statusCode != 200 || res.data == null) {
      throw FeedException('No se pudo cargar el feed.');
    }

    return (
      items: (res.data!['items'] as List<dynamic>)
          .map((e) => PublicacionFeed.fromJson(e as Map<String, dynamic>))
          .toList(),
      nextCursor: res.data!['nextCursor'] as String?,
    );
  }
}

class FeedException implements Exception {
  FeedException(this.mensaje);
  final String mensaje;
  @override
  String toString() => mensaje;
}

final feedRepositoryProvider = Provider<FeedRepository>(FeedRepository.new);

/// Estado del feed con scroll infinito.
///
/// Vive en un notifier y no en un `FutureProvider` porque acumula páginas: un
/// FutureProvider reemplazaría la lista entera en cada carga y el feed saltaría
/// al principio justo cuando la persona está desplazándose.
class FeedNotifier extends AsyncNotifier<List<PublicacionFeed>> {
  String? _cursor;
  bool _cargandoMas = false;

  bool get hayMas => _cursor != null;

  /// Si este feed muestra sólo a quienes la persona sigue.
  ///
  /// `false` acá y `true` en [FeedDeSeguidosNotifier]. Todo lo demás —paginar,
  /// recargar, tragarse los errores de una página siguiente— es idéntico en las
  /// dos pestañas, y duplicarlo sería tener dos feeds que se van separando.
  bool get soloSeguidos => false;

  @override
  Future<List<PublicacionFeed>> build() async {
    /**
     * ⚠️ Se observa el ID de la persona, NO el objeto de sesión entero.
     *
     * Al iniciar o cerrar sesión el feed tiene que recargarse: el catálogo
     * visible cambia y, sobre todo, así el vendedor ve su propio producto
     * recién publicado. Eso sigue igual — el id pasa de `null` a un valor y al
     * revés.
     *
     * Lo que cambia es que un refresco de la MISMA sesión ya no recarga nada.
     * `ConSesion` no define igualdad, así que cada instancia nueva es distinta
     * para Riverpod, y desde que la restauración es en dos tiempos —disco
     * primero, servidor después— el estado cambia dos veces en cada arranque.
     *
     * Con `ref.watch(sesionProvider)` a secas, eso significaba pedir el feed
     * DOS veces en cada apertura de la app: la segunda pisando a la primera,
     * con la persona ya mirando la pantalla. El arreglo del arranque habría
     * traído su propia lentitud de vuelta.
     */
    ref.watch(sesionProvider.select((s) => s is ConSesion ? s.usuario.id : null));

    if (soloSeguidos) {
      /**
       * Y acá, además, a quién sigo.
       *
       * Seguir a alguien desde el vivo o desde su perfil tiene que verse en
       * esta pestaña al volver, sin reiniciar la app. `Seguimientos` sube un
       * número con cada follow y esto se rearma solo.
       *
       * ⚠️ Va sólo en esta rama: en «Para vos» seguir a alguien no cambia lo
       * que se muestra, y recargar el feed entero por un follow sería tirar a
       * la basura la posición de scroll de la persona sin motivo.
       */
      ref.watch(seguimientosProvider);
    }

    final pagina = await ref
        .read(feedRepositoryProvider)
        .descubrir(soloSeguidos: soloSeguidos);
    _cursor = pagina.nextCursor;
    return pagina.items;
  }

  /// Carga la siguiente página. Silenciosa: un error acá no puede vaciar lo
  /// que la persona ya está mirando.
  Future<void> cargarMas() async {
    if (_cargandoMas || _cursor == null) return;
    _cargandoMas = true;
    try {
      final pagina = await ref
          .read(feedRepositoryProvider)
          .descubrir(cursor: _cursor, soloSeguidos: soloSeguidos);
      _cursor = pagina.nextCursor;
      state = AsyncData([...(state.valueOrNull ?? []), ...pagina.items]);
    } on DioException {
      // Sin señal. Se reintenta solo cuando vuelva a llegar al final.
    } on FeedException {
      // Ídem: el feed ya cargado sigue siendo válido.
    } finally {
      _cargandoMas = false;
    }
  }

  Future<void> recargar() async {
    _cursor = null;
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final pagina = await ref
          .read(feedRepositoryProvider)
          .descubrir(soloSeguidos: soloSeguidos);
      _cursor = pagina.nextCursor;
      return pagina.items;
    });
  }
}

final feedProvider = AsyncNotifierProvider<FeedNotifier, List<PublicacionFeed>>(FeedNotifier.new);

/// La pestaña «Siguiendo»: el mismo feed, sólo de quienes la persona sigue.
///
/// Es un provider aparte y no el mismo con un parámetro, para que las dos
/// pestañas conserven **cada una su lista y su posición**. Alternar entre ellas
/// no puede costar una petición ni perder el lugar donde alguien estaba
/// mirando.
class FeedDeSeguidosNotifier extends FeedNotifier {
  @override
  bool get soloSeguidos => true;
}

final feedDeSeguidosProvider =
    AsyncNotifierProvider<FeedDeSeguidosNotifier, List<PublicacionFeed>>(
  FeedDeSeguidosNotifier.new,
);
