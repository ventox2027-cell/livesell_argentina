import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/estado_optimista.dart';
import '../domain/seller_models.dart';
import 'seller_repository.dart';

/// Publicar y pausar, sin hacer esperar a nadie.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ VIVE ACÁ Y NO EN EL EDITOR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Porque el interruptor está en DOS lados —el editor y la fila de Mi tienda—
/// y los dos tienen que mostrar lo mismo mientras el cambio viaja. Si el
/// estado pendiente viviera en el `State` de una pantalla, la otra seguiría
/// mostrando lo de antes.
///
/// Y porque salir de la pantalla no puede cancelar la operación: la persona ya
/// tocó publicar.
class CambiosDeEstadoDeProducto extends Notifier<CambiosDeEstado> {
  @override
  CambiosDeEstado build() => const CambiosDeEstado();

  /// El cupo tal como lo ve la app: el del servidor, más lo que está en vuelo.
  ///
  /// ⚠️ Lee `misProductosProvider` y NO `cupoVisibleProvider`, aunque los dos
  /// den lo mismo. `cupoVisibleProvider` observa a este notifier: leerlo desde
  /// acá sería una dependencia circular. El estado en vuelo ya lo tenemos en
  /// `state`, que es justo lo que aporta el otro provider.
  EstadoDelCatalogo? get cupoVisible => catalogoVisible(
        delServidor: ref.read(misProductosProvider).valueOrNull?.catalogo,
        cambios: state,
      );

  /// Por qué no se puede publicar este producto ahora, o `null` si se puede.
  ///
  /// Lo consulta el editor **antes** de avisar «Publicado» para no afirmar algo
  /// que el servidor va a deshacer. Y lo vuelve a consultar [cambiar], para que
  /// la regla no dependa de que cada pantalla se acuerde de preguntar.
  MotivoDeBloqueo? porQueNoSePuedePublicar({required String actual, required String nuevo}) =>
      motivoParaNoPublicar(catalogo: cupoVisible, actual: actual, nuevo: nuevo);

  /// Cambia el estado: en la pantalla ahora, en el servidor después.
  ///
  /// Devuelve el producto actualizado si el servidor lo aceptó, o `null` si
  /// falló —y en ese caso el estado local ya volvió a lo que era—.
  ///
  /// ⚠️ Un segundo toque mientras el primero viaja NO hace nada. Sin eso, dos
  /// toques rápidos mandan dos `PATCH` y el estado final lo decide el orden en
  /// que contesten, que no es el orden en que se tocó.
  Future<Producto?> cambiar({
    required String productId,
    required String actual,
    required String nuevo,
    String? categoryId,
  }) async {
    if (state.enCurso(productId)) return null;

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL CUPO SE MIRA ANTES DE MOVER EL INTERRUPTOR
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Acá estaba el bug: el optimismo se aplicaba siempre. Publicar el cuarto
     * producto de un plan Free se veía publicado, la persona leía «Ya lo
     * pueden comprar», y dos segundos más tarde el rechazo del backend lo
     * deshacía todo.
     *
     * El estado intermedio era el problema. No es que faltara una validación
     * —el backend rechazaba bien—: es que durante esos segundos la app
     * afirmaba algo falso sobre si su producto estaba a la venta.
     *
     * ⚠️ Lanza ANTES de tocar `state` y antes de mandar nada. No hay rollback
     * porque no hubo cambio.
     */
    final bloqueo = porQueNoSePuedePublicar(actual: actual, nuevo: nuevo);
    if (bloqueo != null) {
      throw ComercioException(
        mensajeDeBloqueo(bloqueo, cupoVisible),
        codigo: codigoDeCupoLleno,
      );
    }

    state = state.con(productId, antes: actual, despues: nuevo);

    try {
      final r = await ref.read(sellerRepositoryProvider).actualizarProducto(
            productId,
            status: nuevo,
            categoryId: categoryId,
          );

      /**
       * ⚠️ Primero se refresca la tienda y DESPUÉS se suelta el pendiente.
       *
       * Al revés, entre soltar y que llegue el listado nuevo se ve el estado
       * anterior: el botón vuelve a decir «Publicar» un instante después de
       * haber publicado. Es el mismo orden que en el borrado de productos.
       *
       * La reconciliación no se espera para nada más: ya tenemos el producto
       * que devolvió el `PATCH`.
       */
      await recargarLaTienda(ref.read);
      state = state.sin(productId);
      return r;
    } catch (e) {
      // Vuelve a como estaba. Quien llamó muestra el error.
      state = state.sin(productId);

      /**
       * Si el rechazo fue por el tope, lo que sabíamos del cupo estaba viejo.
       *
       * Pasa cuando el catálogo cambió desde otro lado —otra sesión, otro
       * teléfono— y la app todavía creía que le entraba uno más. El contador
       * quedaría diciendo «2 de 3» al lado de un mensaje que dice que está
       * lleno.
       *
       * ⚠️ No se espera el refresco: el mensaje de error tiene que salir ya, y
       * el número se corrige solo un segundo después. Esperarlo sería un
       * segundo de pantalla muda justo después de un rechazo.
       */
      if (e is ComercioException && e.codigo == codigoDeCupoLleno) {
        unawaited(recargarLaTienda(ref.read));
      }
      rethrow;
    }
  }
}

/// El código con el que el backend rechaza por tope de plan.
///
/// La app decide con esto y nunca con el texto: el mensaje puede cambiar de
/// redacción en cualquier momento y el código no.
const codigoDeCupoLleno = 'PLAN_LIMIT_REACHED';

final cambiosDeEstadoProvider =
    NotifierProvider<CambiosDeEstadoDeProducto, CambiosDeEstado>(
  CambiosDeEstadoDeProducto.new,
);

/// El cupo del plan como se muestra en pantalla.
///
/// Una sola fuente para las dos pantallas que lo miran: el contador de Mi
/// tienda y la decisión de si el editor deja publicar. Con dos cuentas
/// separadas, el día que difieran el contador diría una cosa y el botón haría
/// otra.
final cupoVisibleProvider = Provider<EstadoDelCatalogo?>((ref) {
  return catalogoVisible(
    delServidor: ref.watch(misProductosProvider).valueOrNull?.catalogo,
    cambios: ref.watch(cambiosDeEstadoProvider),
  );
});
