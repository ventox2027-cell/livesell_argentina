import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'inventory_repository.dart';

/// Cómo terminó el paso por la pantalla de la reserva.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// «SE FUE A PAGAR» Y «SE FUE» NO SON LO MISMO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Los dos cierran la hoja, y desde el `dispose` se ven idénticos. Por eso la
/// salida se declara ANTES de cerrar y no se deduce después: un
/// `dispose() => liberar()` soltaría la unidad justo cuando la persona se fue a
/// poner los datos de la tarjeta, y el pago fallaría con «se agotó» sobre algo
/// que ella misma tenía apartado.
enum SalidaDeLaReserva {
  /// Empezó a pagar. La reserva se mantiene: la va a consumir el pedido.
  pagando,

  /// Tocó «Soltar reserva». Ya se liberó ahí mismo.
  liberada,

  /// Cerró, volvió atrás, arrastró la hoja o tocó afuera sin ir a pagar.
  abandonada,
}

/// La reserva que la persona tiene apartada mientras decide.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ VIVE ACÁ Y NO EN EL `State` DE LA HOJA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Porque hay que soltarla **cuando la hoja ya se cerró**, y para entonces el
/// `State` está desmontado: su `ref` no se puede usar y cualquier `setState`
/// revienta. Es el mismo motivo por el que subir una foto o borrar un producto
/// viven en su propio notifier — la operación tiene que sobrevivir a la
/// pantalla que la disparó.
///
/// Guarda sólo el id de lo que hay apartado. El contador, la cantidad y el
/// precio siguen siendo de la hoja: son de lo que se está mirando, no de lo que
/// hay que soltar.
class ReservaEnCurso extends Notifier<String?> {
  @override
  String? build() => null;

  /// Hay algo apartado, y hay que acordarse por si la hoja se cierra.
  void tomada(String reservationId) => state = reservationId;

  /// Ya no hay nada que soltar: se pagó, se soltó o se venció.
  void olvidar() => state = null;

  /// Suelta lo apartado si la persona se fue sin ir a pagar.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// LOS TRES DESENLACES, EXPLÍCITOS
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Sólo [SalidaDeLaReserva.abandonada] suelta. `pagando` no —la reserva es
  /// justo lo que el pedido va a consumir— y `liberada` tampoco, porque el
  /// botón ya la soltó y pedirlo de nuevo sería un `DELETE` sobre algo que ya
  /// no está.
  ///
  /// ⚠️ Es IDEMPOTENTE: limpia el id antes de salir a la red. Dos toques
  /// rápidos del botón de atrás, o un cierre que dispare el aviso dos veces,
  /// mandan un solo `DELETE`.
  ///
  /// ⚠️ Y NO LANZA. Si el `DELETE` falla —se cortó la señal justo al cerrar— la
  /// pantalla ya no existe y no hay a quién avisarle. La unidad no queda
  /// tomada para siempre: el TTL del backend la vence igual. Tragarse el error
  /// acá es correcto **porque hay una segunda defensa**, no porque el error no
  /// importe.
  Future<void> alSalir(SalidaDeLaReserva salida) async {
    if (salida != SalidaDeLaReserva.abandonada) {
      if (salida == SalidaDeLaReserva.liberada) state = null;
      return;
    }

    final id = state;
    if (id == null) return;
    state = null;

    try {
      await ref.read(inventoryRepositoryProvider).cancelar(id);
    } catch (_) {
      // El TTL del backend es la última defensa. Ver el comentario de arriba.
    }
  }
}

/// Lo que esta persona tiene apartado ahora mismo, o `null`.
final reservaEnCursoProvider = NotifierProvider<ReservaEnCurso, String?>(ReservaEnCurso.new);
