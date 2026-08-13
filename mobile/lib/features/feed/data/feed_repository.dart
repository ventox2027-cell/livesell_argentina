import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/state/auth_providers.dart';
import '../domain/feed_models.dart';

/// Fuente del feed.
///
/// Va **sin autenticación**: alguien que todavía no se registró tiene que
/// poder ver qué se vende. La sesión se pide recién al comprar.
class FeedRepository {
  FeedRepository(this._ref);
  final Ref _ref;

  Future<({List<PublicacionFeed> items, String? nextCursor})> descubrir({
    String? cursor,
    int limit = 20,
  }) async {
    final res = await _ref.read(apiClientProvider).get<Map<String, dynamic>>(
      '/discover/products',
      query: {'limit': limit, if (cursor != null) 'cursor': cursor},
      sinAuth: true,
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

  @override
  Future<List<PublicacionFeed>> build() async {
    // Al iniciar o cerrar sesión se recarga: el catálogo visible puede cambiar
    // y, sobre todo, así el vendedor ve su propio producto recién publicado.
    ref.watch(sesionProvider);
    final pagina = await ref.read(feedRepositoryProvider).descubrir();
    _cursor = pagina.nextCursor;
    return pagina.items;
  }

  /// Carga la siguiente página. Silenciosa: un error acá no puede vaciar lo
  /// que la persona ya está mirando.
  Future<void> cargarMas() async {
    if (_cargandoMas || _cursor == null) return;
    _cargandoMas = true;
    try {
      final pagina = await ref.read(feedRepositoryProvider).descubrir(cursor: _cursor);
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
      final pagina = await ref.read(feedRepositoryProvider).descubrir();
      _cursor = pagina.nextCursor;
      return pagina.items;
    });
  }
}

final feedProvider =
    AsyncNotifierProvider<FeedNotifier, List<PublicacionFeed>>(FeedNotifier.new);
