import 'package:flutter/foundation.dart';

/// Cuánto tarda cada tramo del arranque.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// MEDIR, NO SUPONER
/// ═══════════════════════════════════════════════════════════════════════════
///
/// «La app tarda tres segundos en abrir» no se puede arreglar: no dice cuál de
/// los pasos se los lleva. Esto imprime el reparto real en el teléfono de quien
/// lo esté probando, que es el único lugar donde el número vale.
///
/// Se lee con `adb logcat -s flutter`. Sale así:
///
///     ⏱ arranque — 1840 ms
///        config local              12 ms   ·  t+12
///        orientación                8 ms   ·  t+20
///        → primer frame            21 ms   ·  t+41
///        sesión: token local       95 ms   ·  t+136
///        sesión: usuario guardado   3 ms   ·  t+139
///        → Inicio pintado          18 ms   ·  t+157
///        feed visible             690 ms   ·  t+847
///        auth/me (en 2º plano)    460 ms   ·  t+1307
///        push (Firebase)          533 ms   ·  t+1840
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ AHORA TAMBIÉN MIDE EN RELEASE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Antes `kReleaseMode` apagaba todo. Sonaba prudente y hacía inútil la
/// herramienta: las pruebas en teléfono se hacen sobre el APK de release, que
/// es justamente donde los números son distintos —sin JIT, sin observatorio, con
/// otro perfil de arranque—. Medir en depuración y arreglar para release es
/// medir otra app.
///
/// Lo que costaba de verdad era imprimir, no medir: un `Stopwatch` y una lista
/// de doce entradas no se notan al lado de una petición de red. Así que ahora
/// se mide siempre y se imprime una vez por arranque.
///
/// ⚠️ Acá NO va nada que no sea un nombre de tramo y un número de milisegundos.
/// Ni tokens, ni correo, ni identificadores: esto sale por el log del sistema,
/// que lo lee cualquiera con el teléfono en la mano.
class TrazaDeArranque {
  TrazaDeArranque._();
  static final TrazaDeArranque instancia = TrazaDeArranque._();

  final _reloj = Stopwatch();
  final _marcas = <({String nombre, int desde, int hasta})>[];
  int _ultimo = 0;

  /// Los tramos anotados, para que un test pueda mirarlos.
  ///
  /// Se expone la lista y no un texto: un test que compare texto formateado se
  /// rompe cuando alguien cambia el ancho de una columna.
  List<({String nombre, int desde, int hasta})> get marcas => List.unmodifiable(_marcas);

  bool get corriendo => _reloj.isRunning;

  void empezar() {
    _reloj
      ..reset()
      ..start();
    _marcas.clear();
    _ultimo = 0;
  }

  /// Anota que terminó un tramo.
  ///
  /// ⚠️ Se guarda el instante ABSOLUTO además de la duración.
  ///
  /// El arranque no es una fila de pasos: mientras la sesión se restaura, el
  /// feed ya está pidiendo y Firebase también. Con sólo la diferencia contra la
  /// marca anterior, dos cosas que corren en paralelo se leen como si una
  /// hubiera esperado a la otra — y lleva a «optimizar» un tramo que no estaba
  /// bloqueando nada.
  void paso(String nombre) {
    if (!_reloj.isRunning) return;
    final ahora = _reloj.elapsedMilliseconds;
    _marcas.add((nombre: nombre, desde: _ultimo, hasta: ahora));
    _ultimo = ahora;
  }

  /// Anota un tramo que empezó en un momento conocido.
  ///
  /// Para lo que corre en paralelo: `feed visible` no dura «desde la marca
  /// anterior», dura desde que se pidió. Sin esto, el feed se llevaría el
  /// crédito del tiempo de Firebase por haber terminado después.
  void tramo(String nombre, {required int desdeMs}) {
    if (!_reloj.isRunning) return;
    _marcas.add((nombre: nombre, desde: desdeMs, hasta: _reloj.elapsedMilliseconds));
  }

  /// Los milisegundos desde que arrancó. Para armar un `tramo` después.
  int get ahora => _reloj.elapsedMilliseconds;

  /// Imprime lo anotado hasta acá y lo limpia.
  void informar(String titulo) {
    if (_marcas.isEmpty) return;

    final fin = _marcas.fold<int>(0, (a, m) => m.hasta > a ? m.hasta : a);
    debugPrint('⏱ $titulo — $fin ms');
    for (final m in _marcas) {
      final dur = (m.hasta - m.desde).toString().padLeft(5);
      debugPrint('   ${m.nombre.padRight(24)} $dur ms   ·  t+${m.hasta}');
    }
    _marcas.clear();
  }
}
