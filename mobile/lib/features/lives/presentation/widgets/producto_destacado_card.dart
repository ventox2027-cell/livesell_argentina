import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../../../../core/design/tokens.dart';
import '../../domain/live_models.dart';

/// Lo que el vendedor está mostrando ahora.
///
/// ─── Compacto a propósito ───
///
/// Imagen chica, nombre, precio, stock y comprar. Nada más. Es una tarjeta que
/// vive encima de un video: cada píxel que ocupa es video que tapa, y lo que la
/// gente vino a ver es el video.
///
/// La descripción, las fotos y el detalle están a un toque de distancia, en el
/// panel de compra.
class ProductoDestacadoCard extends StatelessWidget {
  const ProductoDestacadoCard({
    super.key,
    required this.producto,
    required this.onComprar,
    this.puedeComprar = true,
  });

  final ProductoDestacado producto;
  final VoidCallback onComprar;

  /// `false` cuando el vivo terminó. La tarjeta sigue visible —el contexto
  /// comercial no se pierde— pero el botón cambia.
  final bool puedeComprar;

  @override
  Widget build(BuildContext context) {
    final agotado = producto.agotado;

    return Container(
      height: 76,
      padding: const EdgeInsets.all(Gap.sm),
      decoration: BoxDecoration(
        color: AppColor.superficie.withValues(alpha: 0.92),
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(color: AppColor.borde),
      ),
      child: Row(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(Redondeo.sm),
            child: SizedBox(
              width: 60,
              height: 60,
              child: producto.imagenUrl == null
                  ? const ColoredBox(
                      color: AppColor.superficieAlta,
                      child: Icon(Icons.image_rounded, color: AppColor.textoDebil, size: 22),
                    )
                  : CachedNetworkImage(
                      imageUrl: producto.imagenUrl!,
                      fit: BoxFit.cover,
                      // Un producto sin foto no puede romper la tarjeta: ya nos
                      // pasó con un `as String` sobre un campo nulo.
                      errorWidget: (_, __, ___) => const ColoredBox(
                        color: AppColor.superficieAlta,
                        child: Icon(Icons.image_rounded, color: AppColor.textoDebil, size: 22),
                      ),
                      placeholder: (_, __) => const ColoredBox(color: AppColor.superficieAlta),
                    ),
            ),
          ),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  producto.nombre,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    Text(
                      _plata(producto.precioCentavos),
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w800,
                        color: AppColor.texto,
                      ),
                    ),
                    if (producto.variante != null) ...[
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          producto.variante!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12, color: AppColor.textoSuave),
                        ),
                      ),
                    ],
                  ],
                ),
                if (_avisoDeStock(producto) != null)
                  Text(
                    _avisoDeStock(producto)!,
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w700,
                      color: agotado ? AppColor.error : AppColor.alerta,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: Gap.sm),
          FilledButton(
            onPressed: agotado || !puedeComprar ? null : onComprar,
            style: FilledButton.styleFrom(
              backgroundColor: AppColor.acento,
              padding: const EdgeInsets.symmetric(horizontal: Gap.lg),
              minimumSize: const Size(0, 40),
            ),
            child: Text(
              agotado ? 'Agotado' : 'Comprar',
              style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w800),
            ),
          ),
        ],
      ),
    );
  }
}

/// El aviso de stock bajo.
///
/// Sólo se muestra cuando queda poco: "quedan 47" no genera ninguna urgencia y
/// ocupa una línea. Y con stock desconocido —`null`— no se muestra nada, en vez
/// de inventar un número.
String? _avisoDeStock(ProductoDestacado p) {
  final d = p.disponible;
  if (d == null) return null;
  if (d <= 0) return 'Sin stock';
  if (d == 1) return 'Última unidad';
  if (d <= 5) return 'Últimas $d unidades';
  return null;
}

String _plata(int? centavos) {
  if (centavos == null) return '';
  final entero = centavos ~/ 100;
  final decimales = (centavos % 100).toString().padLeft(2, '0');
  final miles = entero.toString().replaceAllMapped(
        RegExp(r'(\d)(?=(\d{3})+$)'),
        (m) => '${m[1]}.',
      );
  return '\$ $miles,$decimales';
}
