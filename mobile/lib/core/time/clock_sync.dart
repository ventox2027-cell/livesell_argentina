import 'dart:async';

import '../network/spike_api.dart';

/// Sincronización de reloj entre dispositivos (algoritmo de Cristian).
///
/// Es la pieza más fácil de subestimar de todo el spike: sin ella, restar el
/// timestamp del teléfono A del timestamp del teléfono B no significa **nada**.
/// Dos Android pueden tener segundos de diferencia entre sí, y la medición de
/// latencia que buscamos está en el orden de los cientos de milisegundos.
///
/// Método: se consulta el servidor N veces y se conserva **la muestra de menor
/// RTT**, no el promedio. La de menor RTT es la que menos asimetría de red
/// arrastra, y por lo tanto la que da el offset más confiable.
///
///     offset = serverTime + rtt/2 − clientReceiveTime
///     serverNow() = DateTime.now() + offset
class ClockSync {
  ClockSync(this._api);

  final SpikeApi _api;

  int _offsetMs = 0;
  int _bestRttMs = 1 << 30;
  bool _synced = false;

  int get offsetMs => _offsetMs;
  int get bestRttMs => _bestRttMs;
  bool get isSynced => _synced;

  /// Reloj del servidor estimado, en milisegundos desde epoch.
  int nowMs() => DateTime.now().millisecondsSinceEpoch + _offsetMs;

  DateTime now() => DateTime.fromMillisecondsSinceEpoch(nowMs());

  /// Descarta la sincronización actual.
  ///
  /// Obligatorio al cambiar de backend: el offset es relativo a UN servidor.
  /// Conservarlo apuntando a otro daría mediciones falsas sin ningún síntoma
  /// visible, que es la peor clase de error en un instrumento de medición.
  void reset() {
    _offsetMs = 0;
    _bestRttMs = 1 << 30;
    _synced = false;
  }

  Future<void> sync({int samples = 7}) async {
    for (var i = 0; i < samples; i++) {
      try {
        final t0 = DateTime.now().millisecondsSinceEpoch;
        final serverTimeMs = await _api.serverTime(clientSentAtMs: t0);
        final t1 = DateTime.now().millisecondsSinceEpoch;

        final rtt = t1 - t0;
        if (rtt < _bestRttMs) {
          _bestRttMs = rtt;
          // El servidor respondió en algún punto del viaje; asumir la mitad del
          // RTT es la mejor estimación sin información adicional.
          _offsetMs = serverTimeMs + (rtt ~/ 2) - t1;
          _synced = true;
        }
      } catch (_) {
        // Una muestra perdida no invalida la sincronización: seguimos con el resto.
      }
      // Espaciar evita que las N peticiones compartan la misma congestión
      // momentánea y sesguen todas hacia el mismo error.
      await Future<void>.delayed(const Duration(milliseconds: 120));
    }
  }

  /// Resincroniza periódicamente: los relojes de los teléfonos derivan, y una
  /// sesión de medición puede durar media hora.
  Timer startPeriodicResync({Duration every = const Duration(minutes: 5)}) {
    return Timer.periodic(every, (_) => sync(samples: 3));
  }
}
