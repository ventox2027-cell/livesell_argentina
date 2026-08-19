import 'package:flutter/foundation.dart';

/// Cuánto tarda cada paso del arranque.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// MEDIR, NO SUPONER
/// ═══════════════════════════════════════════════════════════════════════════
///
/// «La app tarda tres segundos en abrir» no se puede arreglar: no dice cuál de
/// los pasos se los lleva. Esto imprime el reparto real en el teléfono de
/// quien lo esté probando, que es el único lugar donde el número vale.
///
/// Se lee con `flutter run` o con `adb logcat -s flutter`. Sale así:
///
///     ⏱ arranque
///        config local          12 ms
///        orientación            8 ms
///        → primer frame        41 ms
///        (en segundo plano)
///        enlaces              180 ms
///        push (Firebase)      940 ms
///
/// ⚠️ Sólo en depuración. `kReleaseMode` lo apaga entero: medir en release
/// costaría llamadas al reloj en el camino más sensible que tiene la app, y el
/// número que importa ya se sacó.
class TrazaDeArranque {
  TrazaDeArranque._();
  static final TrazaDeArranque instancia = TrazaDeArranque._();

  final _reloj = Stopwatch();
  final _pasos = <({String nombre, int ms})>[];
  int _ultimo = 0;

  void empezar() {
    if (kReleaseMode) return;
    _reloj.start();
  }

  /// Anota cuánto tardó el paso que acaba de terminar.
  void paso(String nombre) {
    if (kReleaseMode || !_reloj.isRunning) return;
    final ahora = _reloj.elapsedMilliseconds;
    _pasos.add((nombre: nombre, ms: ahora - _ultimo));
    _ultimo = ahora;
  }

  /// Imprime lo anotado hasta acá.
  ///
  /// Se llama dos veces: al llegar al primer frame y cuando termina lo que
  /// quedó en segundo plano. Así se ve qué bloqueaba y qué no.
  void informar(String titulo) {
    if (kReleaseMode || _pasos.isEmpty) return;

    final total = _pasos.fold<int>(0, (a, p) => a + p.ms);
    debugPrint('⏱ $titulo — $total ms');
    for (final p in _pasos) {
      debugPrint('   ${p.nombre.padRight(22)} ${p.ms.toString().padLeft(5)} ms');
    }
    _pasos.clear();
  }
}
