import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/ajustes_acumulados.dart';
import 'inventory_repository.dart';

/// Cuánto se espera antes de mandar los toques acumulados.
///
/// Suficiente para que una ráfaga de dedo entre en una sola petición, y poco
/// como para que soltar el dedo y ver el número guardado se sienta inmediato.
const esperaAntesDeGuardar = Duration(milliseconds: 450);

/// Identifica una variante concreta de un producto concreto.
String claveDe(String productId, String variantId) => '$productId:$variantId';

/// Los ajustes de stock que todavía no confirmó el servidor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BUG: SUBIR 10, SALIR, VOLVER, Y VER EL NÚMERO VIEJO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Medido en un teléfono real: subir 10 unidades y salir enseguida tardaba
/// ~15 segundos en verse; una baja posterior, ~35. A veces nunca.
///
/// La causa eran dos cosas que se sumaban, y ninguna era la red:
///
///   1. **`stockDeProductoProvider` no es `autoDispose`.** Un `FutureProvider`
///      común cachea su valor para toda la sesión de la app. Al volver a
///      entrar, la pantalla recibía el valor de la primera visita **sin pedir
///      nada**.
///
///   2. **El estado pendiente vivía en el widget.** Al salir, `dispose()`
///      mandaba el delta… y ahí moría todo. No quedaba nadie para invalidar el
///      provider cuando la respuesta llegara, así que el caché del punto 1 se
///      quedaba viejo hasta que algo ajeno lo tirara. De ahí que a veces fueran
///      15 segundos y a veces 35: dependía de qué otra cosa hubiera invalidado.
///
/// Este objeto vive en el contenedor de Riverpod, no en una pantalla. Sobrevive
/// a salir del stock, a entrar a Mi tienda y a volver. Termina lo que empezó, e
/// invalida el provider cuando corresponde.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE ESTO **NO** ES
/// ═══════════════════════════════════════════════════════════════════════════
///
/// No es una autoridad de stock. PostgreSQL sigue siendo el único que decide
/// cuánto hay: acá sólo se guarda «el vendedor pidió +4 y todavía no volvió la
/// respuesta». La operación que se manda sigue siendo un DELTA relativo, nunca
/// un `set` calculado sobre un valor que podría estar viejo — que es lo que
/// rompería las reservas de los compradores.
class AjustesEnVuelo extends Notifier<Map<String, int>> {
  final Map<String, AjustesAcumulados> _acumulados = {};
  final Map<String, Timer> _temporizadores = {};

  /// `clave → onHand que se está mostrando`. Es el estado que exponen los
  /// widgets, y por eso es el estado del `Notifier`.
  @override
  Map<String, int> build() => const {};

  AjustesAcumulados _acumuladoDe(String clave) =>
      _acumulados.putIfAbsent(clave, AjustesAcumulados.new);

  /// Si esta variante tiene algo sin resolver.
  ///
  /// Lo usa la pantalla para no dejar que un refresco del servidor pise el
  /// número que la persona está viendo mientras toca.
  bool sigueEnCurso(String productId, String variantId) =>
      _acumulados[claveDe(productId, variantId)]?.hayTrabajo ?? false;

  /// El valor optimista de una variante, si hay.
  int? optimistaDe(String productId, String variantId) => state[claveDe(productId, variantId)];

  /// Registra un toque y programa el envío.
  ///
  /// `destino` es el `onHand` que la persona tiene que ver AHORA. Se guarda
  /// aparte del delta porque son dos cosas distintas: el delta es lo que hay
  /// que mandar, el destino es lo que hay que dibujar.
  void tocar({
    required String productId,
    required String variantId,
    required int delta,
    required int destino,
  }) {
    final clave = claveDe(productId, variantId);
    _acumuladoDe(clave).sumar(delta);
    state = {...state, clave: destino};
    _programar(productId, variantId);
  }

  /// Escribe una cantidad exacta.
  ///
  /// No se consolida con los pasos: es un valor absoluto, y mezclarlo daría un
  /// resultado que depende de qué petición llegue antes. Se descarta lo
  /// acumulado porque el vendedor acaba de decir cuánto hay.
  Future<void> fijar({
    required String productId,
    required String variantId,
    required int cantidad,
  }) async {
    final clave = claveDe(productId, variantId);
    _temporizadores.remove(clave)?.cancel();
    _acumuladoDe(clave).fallar();
    state = {...state, clave: cantidad};

    try {
      await ref
          .read(inventoryRepositoryProvider)
          .fijarStock(productId: productId, variantId: variantId, onHand: cantidad);
      _limpiar(clave);
      ref.invalidate(stockDeProductoProvider(productId));
    } catch (_) {
      _limpiar(clave);
      ref.invalidate(stockDeProductoProvider(productId));
      rethrow;
    }
  }

  void _programar(String productId, String variantId) {
    final clave = claveDe(productId, variantId);
    _temporizadores[clave]?.cancel();
    _temporizadores[clave] = Timer(
      esperaAntesDeGuardar,
      () => _enviar(productId, variantId),
    );
  }

  /// Manda lo acumulado de una variante, en una sola petición.
  ///
  /// ⚠️ Nada de esto depende de que la pantalla siga abierta. Ése era el bug:
  /// con el temporizador dentro del widget, salir antes de que disparara
  /// dejaba el cambio sin mandar o sin reconciliar.
  Future<void> _enviar(String productId, String variantId) async {
    final clave = claveDe(productId, variantId);
    final acumulado = _acumuladoDe(clave);
    final delta = acumulado.tomar();
    if (delta == null) return;

    try {
      await ref
          .read(inventoryRepositoryProvider)
          .ajustarStock(productId: productId, variantId: variantId, delta: delta);
      acumulado.confirmar();
    } catch (_) {
      /**
       * El servidor rechazó el ajuste.
       *
       * Se descarta también lo que hubiera quedado pendiente —ver
       * `AjustesAcumulados.fallar()`— y se borra el valor optimista, así que
       * la pantalla vuelve a lo que dice el servidor.
       *
       * El error no se relanza: puede no haber ninguna pantalla abierta para
       * mostrarlo. Lo que sí ocurre siempre es la reconciliación de abajo, que
       * es lo que evita que la app quede mostrando un número inventado.
       */
      acumulado.fallar();
      _limpiar(clave);
      ref.invalidate(stockDeProductoProvider(productId));
      return;
    }

    /**
     * Llegaron más toques mientras esto viajaba: van en la próxima tanda, y el
     * valor optimista se conserva hasta entonces.
     */
    if (acumulado.pendiente != 0) {
      _programar(productId, variantId);
      return;
    }

    /**
     * Terminó todo lo de esta variante. Recién ACÁ se suelta el optimista y se
     * pide el dato real.
     *
     * El orden importa: si se invalidara antes de limpiar, la respuesta podría
     * llegar mientras el optimista sigue puesto y el número saltaría dos veces.
     */
    _limpiar(clave);
    ref.invalidate(stockDeProductoProvider(productId));
  }

  void _limpiar(String clave) {
    _temporizadores.remove(clave)?.cancel();
    final resto = {...state}..remove(clave);
    state = resto;
  }
}

/// ⚠️ NO es `autoDispose`. A propósito.
///
/// Todo el sentido de esto es sobrevivir a que la pantalla de stock se cierre:
/// si se descartara al salir, volveríamos al bug que vino a arreglar.
final ajustesEnVueloProvider =
    NotifierProvider<AjustesEnVuelo, Map<String, int>>(AjustesEnVuelo.new);
