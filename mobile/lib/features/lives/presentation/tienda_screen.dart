import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import 'variant_sheet.dart';
import 'widgets/catalogo_de_tienda.dart';

/// La tienda de un vendedor: su vidriera permanente.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// PERMANENTE QUIERE DECIR QUE NO DEPENDE DEL VIVO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Es la misma tienda que existe cuando el vendedor está offline, y sigue
/// existiendo cuando la transmisión termina. Alguien que llegó desde un vivo y
/// alguien que llegó desde el perfil ven exactamente lo mismo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ES UNA PANTALLA Y ANTES ERA UNA HOJA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La tienda se abría como `showModalBottomSheet` al 78% de la pantalla, y el
/// comentario que lo justificaba decía que con un `Navigator.push` el vivo se
/// desmontaría —LiveKit desconectado, chat perdido, primer cuadro otra vez—.
///
/// ⚠️ Eso es falso, y se midió: con el mismo centinela que usa
/// `live_compra_test.dart`, un `push` sobre una pantalla da `montajes=1,
/// desmontajes=0`. Flutter conserva las rutas de abajo; deja de pintarlas, no
/// las destruye. Volver con el botón de atrás devuelve la pantalla anterior tal
/// como estaba.
///
/// Con eso resuelto, la pantalla completa gana lo que la hoja no podía dar: el
/// catálogo entero a la vista en vez de una franja, un lugar propio al que
/// volver, y el nombre del vendedor arriba en vez de un título apretado entre
/// el buscador y el borde.
///
/// El vivo sigue corriendo atrás y el botón de atrás devuelve a él, en el mismo
/// punto. `tienda_desde_el_vivo_test.dart` lo fija con el centinela.
class TiendaScreen extends ConsumerWidget {
  const TiendaScreen({
    super.key,
    required this.storeId,
    required this.nombreTienda,
    this.liveEnCurso,
  });

  final String storeId;
  final String nombreTienda;

  /// El vivo del que se vino, si se vino de uno.
  ///
  /// Sólo se usa para el aviso «EN VIVO». ⚠️ No se pasa para «volver al vivo»
  /// con un `push` nuevo: el vivo está **abajo en la pila**, y volver es
  /// `Navigator.pop`. Un push abriría un SEGUNDO visor del mismo vivo, con dos
  /// conexiones de LiveKit y dos chats.
  final String? liveEnCurso;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(
        titleSpacing: 0,
        title: Row(
          children: [
            const Icon(Icons.storefront_rounded, size: 19, color: AppColor.acento),
            const SizedBox(width: Gap.sm),
            Expanded(
              child: Text(
                nombreTienda.isEmpty ? 'Tienda' : nombreTienda,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w800),
              ),
            ),
          ],
        ),
        actions: [
          if (liveEnCurso != null)
            Padding(
              padding: const EdgeInsets.only(right: Gap.md),
              child: _VolverAlVivo(onTap: () => Navigator.of(context).pop()),
            ),
        ],
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.only(top: Gap.md),
          child: CatalogoDeTienda(
            storeId: storeId,
            onElegir: (productId) => VariantSheet.mostrar(
              context,
              productId: productId,
              storeId: storeId,
              // El precio exclusivo del vivo, si se vino de uno. Va como id:
              // cuánto descuenta lo resuelve el backend.
              liveSessionId: liveEnCurso,
            ),
          ),
        ),
      ),
    );
  }
}

/// «EN VIVO», y la forma de volver a la transmisión.
///
/// Es un botón y no sólo una etiqueta: quien entró a mirar el catálogo mientras
/// alguien transmite tiene que poder volver sin buscar el botón de atrás del
/// sistema, que en Android está del otro lado de la pantalla.
class _VolverAlVivo extends StatelessWidget {
  const _VolverAlVivo({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: AppColor.error,
          borderRadius: BorderRadius.circular(Redondeo.sm),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.sensors_rounded, size: 14, color: Colors.white),
            SizedBox(width: 5),
            Text(
              'EN VIVO',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.5,
                color: Colors.white,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
