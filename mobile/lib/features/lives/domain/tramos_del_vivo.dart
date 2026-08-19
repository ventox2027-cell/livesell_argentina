import 'package:flutter/foundation.dart';

/// Cuánto tarda cada tramo de salir al aire.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// «INICIAR LIVE ES LENTO» NO SE PUEDE ARREGLAR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// No dice cuál de los seis tramos se lleva el tiempo, y son muy distintos
/// entre sí: tres son peticiones a Railway, uno es abrir un WebSocket contra
/// LiveKit, otro es el hardware de la cámara del teléfono.
///
/// Arreglar el equivocado cuesta un día y no cambia nada.
///
/// Se lee con `adb logcat -s flutter`:
///
///     ⏱ salir al aire — 2840 ms
///        preparar (backend)      880 ms   ·  t+880
///        guardar bandeja         610 ms   ·  t+1490
///        conectar a LiveKit      720 ms   ·  t+2210
///        iniciar (backend)       430 ms   ·  t+2640
///        publicar cámara         200 ms   ·  t+2840
///
/// ⚠️ Acá no va nada que no sea un nombre de tramo y un número. Ni el token de
/// LiveKit, ni la URL del servidor, ni el id del vivo: esto sale por el log del
/// sistema.
class TramosDelVivo {
  final _reloj = Stopwatch();
  final _marcas = <({String nombre, int desde, int hasta})>[];
  int _ultimo = 0;

  List<({String nombre, int desde, int hasta})> get marcas => List.unmodifiable(_marcas);

  void empezar() {
    _reloj
      ..reset()
      ..start();
    _marcas.clear();
    _ultimo = 0;
  }

  int get ahora => _reloj.elapsedMilliseconds;

  void paso(String nombre) {
    if (!_reloj.isRunning) return;
    final ahora = _reloj.elapsedMilliseconds;
    _marcas.add((nombre: nombre, desde: _ultimo, hasta: ahora));
    _ultimo = ahora;
  }

  /// Un tramo que corrió en paralelo con otro.
  ///
  /// ⚠️ Hace falta desde que `guardar bandeja` y `conectar a LiveKit` salen
  /// juntos: sin esto, el que termina segundo se lleva el crédito del tiempo
  /// del primero y parece el doble de lento de lo que es.
  void tramo(String nombre, {required int desdeMs}) {
    if (!_reloj.isRunning) return;
    _marcas.add((nombre: nombre, desde: desdeMs, hasta: _reloj.elapsedMilliseconds));
  }

  void informar() {
    if (_marcas.isEmpty) return;

    final fin = _marcas.fold<int>(0, (a, m) => m.hasta > a ? m.hasta : a);
    debugPrint('⏱ salir al aire — $fin ms');
    for (final m in _marcas) {
      final dur = (m.hasta - m.desde).toString().padLeft(5);
      debugPrint('   ${m.nombre.padRight(24)} $dur ms   ·  t+${m.hasta}');
    }
    _marcas.clear();
    _reloj.stop();
  }
}
