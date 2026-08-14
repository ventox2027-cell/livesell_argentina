import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../auth/state/auth_providers.dart';
import '../domain/schedule_models.dart';

/// El horario de la tienda propia.
///
/// Nunca recibe un `storeId`: el backend resuelve la tienda desde la sesión.
/// Aceptarlo por parámetro sería dejar que la app diga de qué tienda habla, y
/// con eso cualquiera podría editar el horario de otro cambiando un id.
class ScheduleApi {
  ScheduleApi(this._api);
  final ApiClient _api;

  Future<HorarioDeTienda> mio() async {
    final r = await _api.get<Map<String, dynamic>>('/stores/me/schedule');
    return HorarioDeTienda.fromJson(r.data!);
  }

  /// Guarda el horario **completo**.
  ///
  /// El backend reemplaza todo en una transacción. No hay endpoint por franja a
  /// propósito: editar de a una dejaría estados intermedios donde la tienda
  /// figura abierta un día que su dueño ya borró.
  Future<HorarioDeTienda> guardar(HorarioDeTienda horario) async {
    final r = await _api.put<Map<String, dynamic>>(
      '/stores/me/schedule',
      data: {
        'modo': horario.modo.name,
        'zona': horario.zona,
        'franjas': [
          for (final f in horario.franjas)
            {'dia': f.dia, 'abreMinutos': f.abreMinutos, 'cierraMinutos': f.cierraMinutos},
        ],
      },
    );
    return HorarioDeTienda.fromJson(r.data!);
  }
}

final scheduleApiProvider =
    Provider<ScheduleApi>((ref) => ScheduleApi(ref.watch(apiClientProvider)));

final miHorarioProvider =
    FutureProvider<HorarioDeTienda>((ref) => ref.watch(scheduleApiProvider).mio());
