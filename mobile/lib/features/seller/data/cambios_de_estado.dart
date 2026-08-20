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
    required String nuevo,
    String? categoryId,
  }) async {
    if (state.enCurso(productId)) return null;

    state = state.con(productId, nuevo);

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
    } catch (_) {
      // Vuelve a como estaba. Quien llamó muestra el error.
      state = state.sin(productId);
      rethrow;
    }
  }
}

final cambiosDeEstadoProvider =
    NotifierProvider<CambiosDeEstadoDeProducto, CambiosDeEstado>(
  CambiosDeEstadoDeProducto.new,
);
