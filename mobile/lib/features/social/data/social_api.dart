import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../auth/state/auth_providers.dart';

/// El corazón y los enlaces para compartir.
///
/// ─── Un solo endpoint para el corazón ───
///
/// El backend alterna y devuelve el estado nuevo. La app no elige entre "dar" y
/// "quitar": manda el toque y pinta lo que le contestan.
///
/// Si la app decidiera, tendría que saber el estado actual — y cuando el que
/// tiene en pantalla es viejo, el resultado es al revés de lo que la persona
/// quiso.
class SocialApi {
  SocialApi(this._api);
  final ApiClient _api;

  Future<EstadoDeMeGusta> alternarProducto(String productId) =>
      _alternar('/products/$productId/like');

  Future<EstadoDeMeGusta> alternarLive(String liveId) => _alternar('/lives/$liveId/like');

  Future<EstadoDeMeGusta> estadoDeProducto(String productId) => _leer('/products/$productId/like');

  Future<EstadoDeMeGusta> estadoDeLive(String liveId) => _leer('/lives/$liveId/like');

  /// El mensaje listo para compartir, armado por el backend.
  ///
  /// No se arma acá: un enlace compartido sobrevive a la versión de la app que
  /// lo generó, y si cada versión tuviera su propia idea del formato, cambiarlo
  /// rompería los que ya están dando vueltas en los chats.
  Future<({String url, String texto})> compartir(
    String cosa,
    String identificador, {
    String? origen,
  }) async {
    final r = await _api.get<Map<String, dynamic>>(
      '/share/$cosa/$identificador',
      query: {if (origen != null) 'src': origen},
    );
    return (
      url: r.data?['url'] as String? ?? '',
      texto: r.data?['texto'] as String? ?? '',
    );
  }

  Future<EstadoDeMeGusta> _alternar(String ruta) async {
    final r = await _api.post<Map<String, dynamic>>(ruta);
    return EstadoDeMeGusta.fromJson(r.data);
  }

  Future<EstadoDeMeGusta> _leer(String ruta) async {
    final r = await _api.get<Map<String, dynamic>>(ruta);
    return EstadoDeMeGusta.fromJson(r.data);
  }
}

class EstadoDeMeGusta {
  const EstadoDeMeGusta({required this.meGusta, required this.total});

  /// Lectura defensiva: si el cuerpo viene raro, se asume "no le gusta y no
  /// sabemos cuántos". Es el estado que menos miente.
  factory EstadoDeMeGusta.fromJson(Map<String, dynamic>? j) => EstadoDeMeGusta(
        meGusta: j?['meGusta'] as bool? ?? false,
        total: (j?['total'] as num?)?.toInt() ?? 0,
      );

  const EstadoDeMeGusta.vacio()
      : meGusta = false,
        total = 0;

  final bool meGusta;
  final int total;

  /// "1,2 mil" en vez de "1200".
  ///
  /// Un número exacto de cuatro cifras al lado de un corazón no aporta nada y
  /// ocupa el ancho de la columna de acciones, que es angosta a propósito para
  /// no tapar el video.
  String get comoTexto {
    if (total < 1000) return total.toString();
    if (total < 1000000) {
      final miles = total / 1000;
      return '${miles.toStringAsFixed(miles < 10 ? 1 : 0).replaceAll('.', ',')} mil';
    }
    return '${(total / 1000000).toStringAsFixed(1).replaceAll('.', ',')} M';
  }
}

final socialApiProvider = Provider<SocialApi>((ref) => SocialApi(ref.watch(apiClientProvider)));
