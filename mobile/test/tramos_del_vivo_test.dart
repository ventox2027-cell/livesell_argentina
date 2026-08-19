import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/lives/domain/tramos_del_vivo.dart';

/// La medición de salir al aire.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ HAY UN TIPO PARA ESTO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// «Iniciar live es lento» no se puede arreglar. Son cinco tramos de
/// naturaleza muy distinta —tres peticiones a Railway, un WebSocket contra
/// LiveKit, y el hardware de la cámara del teléfono— y arreglar el equivocado
/// cuesta un día sin cambiar nada.
///
/// Lo único que se prueba acá es que la medición no mienta. Los números salen
/// del teléfono.
void main() {
  test('anota los tramos en orden', () {
    final t = TramosDelVivo()..empezar();
    t.paso('preparar');
    t.paso('conectar');

    expect(t.marcas.map((m) => m.nombre), ['preparar', 'conectar']);
  });

  /// ⛔ UN TRAMO EN PARALELO NO SE LLEVA EL TIEMPO DEL ANTERIOR.
  ///
  /// Desde que `guardar bandeja` y `conectar a LiveKit` salen juntos, medir por
  /// diferencia contra la marca previa haría que el que termina segundo
  /// pareciera el doble de lento de lo que es — y llevaría a «optimizar» un
  /// tramo que no estaba esperando a nadie.
  test('⛔ un tramo paralelo se mide desde donde empezó, no desde la marca previa', () {
    final t = TramosDelVivo()..empezar();
    t.paso('preparar');
    final desde = t.ahora;
    t.tramo('bandeja + LiveKit', desdeMs: desde);

    expect(t.marcas.last.desde, desde);
  });

  test('informar vacía lo anotado', () {
    final t = TramosDelVivo()..empezar();
    t.paso('preparar');
    t.informar();

    expect(t.marcas, isEmpty);
  });

  /// Sin arrancar no anota nada. Evita medir un intento que nunca ocurrió.
  test('sin empezar, no anota', () {
    final t = TramosDelVivo();
    t.paso('preparar');

    expect(t.marcas, isEmpty);
  });
}
