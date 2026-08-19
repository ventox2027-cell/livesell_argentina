import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/borrado_optimista.dart';
import 'seller_repository.dart';

/// Borra un producto sin hacer esperar a nadie.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ESTO NO VIVE EN EL EDITOR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Porque el editor se cierra en el mismo frame en que se confirma. Un `Future`
/// lanzado desde su `State` se queda sin nadie que lo espere: el `catch` no
/// puede mostrar un `SnackBar` sobre un `context` desmontado, y si el borrado
/// falla, el producto vuelve a aparecer sin ninguna explicación.
///
/// Acá el trabajo vive en el contenedor de Riverpod, que sobrevive a la
/// pantalla. Es el mismo motivo por el que los ajustes de stock se mudaron a
/// `AjustesEnVuelo`.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL ORDEN IMPORTA MÁS DE LO QUE PARECE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Cuando el `DELETE` sale bien hay que hacer dos cosas: refrescar el listado y
/// soltar la marca de «se está borrando». En ese orden, y no al revés.
///
/// Al revés, entre soltar la marca y que llegue el listado nuevo, lo que se ve
/// es la copia vieja en caché — **con el producto adentro**. El producto
/// reaparece medio segundo y se vuelve a ir. Peor que no haberlo escondido.
class BorradoDeProductos extends Notifier<BorradosEnCurso> {
  @override
  BorradosEnCurso build() => const BorradosEnCurso();

  /// Esconde el producto ya, y lo borra de verdad por atrás.
  ///
  /// Nadie tiene que esperar este `Future`: la pantalla que llama ya cambió.
  /// Si algo sale mal, el producto vuelve a la lista y queda un [FalloDeBorrado]
  /// para que Mi tienda —que sigue montada— lo cuente.
  Future<void> borrar({required String id, required String nombre}) async {
    if (state.contiene(id)) return;

    state = state.empezando(id);

    try {
      await ref.read(sellerRepositoryProvider).borrarProducto(id);

      // Primero el listado real, después soltar la marca. Ver arriba.
      await ref.read(misProductosProvider.notifier).reconciliar();

      /**
       * El perfil también, porque de él cuelga el cupo del plan.
       *
       * No se espera: el contador puede llegar un instante después sin que se
       * note. Lo que no puede pasar es que el vendedor siga viendo la fila.
       */
      ref.read(miPerfilVendedorProvider.notifier).reconciliar().ignore();

      state = state.terminando(id);
    } catch (e) {
      // Vuelve a verse, y alguien lo explica.
      state = state.terminando(id).conFallo(
            FalloDeBorrado(productId: id, nombre: nombre, error: e),
          );
    }
  }

  /// Marca el fallo como ya contado.
  ///
  /// Lo llama la pantalla después de mostrarlo. Sin esto, el aviso volvería a
  /// aparecer en cada reconstrucción.
  void reconocerFallo() {
    if (state.fallo == null) return;
    state = state.sinFallo();
  }
}

final borradosEnCursoProvider =
    NotifierProvider<BorradoDeProductos, BorradosEnCurso>(BorradoDeProductos.new);
