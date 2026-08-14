import 'package:flutter/material.dart';

import '../../../../core/design/tokens.dart';
import '../../../seller/domain/seller_models.dart' show formatearPesos;
import '../../domain/order_models.dart';

/// El desglose del total, línea por línea.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// UNA LÍNEA POR CONCEPTO, SIEMPRE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El total que paga alguien tiene hasta cuatro partes: el producto, el envío,
/// el recargo del medio de pago y el descuento. Mostrar sólo el total —o peor,
/// meter el recargo adentro del envío— hace que la persona vea un número que no
/// puede explicarse, y un número que no se entiende es un reclamo.
///
/// El caso concreto que esto evita: con el recargo sumado al envío, alguien
/// vería "Envío $4.200" cuando el vendedor cobra $3.500 de envío. El reclamo no
/// sería por los $700: sería por sentir que le cobraron algo escondido.
///
/// ─── Las líneas en cero no se muestran ───
///
/// "Envío: $0" no informa nada y ocupa una línea. La excepción es el envío
/// gratis, que sí se muestra porque es una ventaja que el vendedor está
/// ofreciendo y sirve que se vea.
class DesgloseDePrecio extends StatelessWidget {
  const DesgloseDePrecio({super.key, required this.pedido, this.compacto = false});

  final Pedido pedido;

  /// En el detalle del pedido el total ya está arriba, así que va más chico.
  final bool compacto;

  @override
  Widget build(BuildContext context) {
    final lineas = <Widget>[];

    lineas.add(_Linea(etiqueta: _etiquetaDeProductos, valor: formatearPesos(pedido.itemsSubtotal)));

    if (pedido.retiraEnPersona) {
      lineas.add(
        const _Linea(etiqueta: 'Retiro en persona', valor: 'Sin envío', suave: true),
      );
    } else if (pedido.shippingAmount > 0) {
      lineas.add(_Linea(etiqueta: 'Envío', valor: formatearPesos(pedido.shippingAmount)));
    } else {
      // El único cero que sí se muestra: es una ventaja, no un dato vacío.
      lineas.add(const _Linea(etiqueta: 'Envío', valor: 'Gratis', destacado: true));
    }

    if (pedido.recargoProcesador > 0) {
      lineas.add(
        _Linea(
          etiqueta: 'Costo del medio de pago',
          valor: formatearPesos(pedido.recargoProcesador),
          // Es lo que más se pregunta, así que lleva la explicación al lado.
          aclaracion: 'Lo cobra Mercado Pago por procesar el cobro.',
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ...lineas,
        const Padding(
          padding: EdgeInsets.symmetric(vertical: Gap.md),
          child: Divider(height: 1, color: AppColor.borde),
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              'Total',
              style: TextStyle(
                fontSize: compacto ? 14 : 15,
                color: AppColor.textoSuave,
                fontWeight: FontWeight.w600,
              ),
            ),
            Text(
              pedido.total,
              style: TextStyle(
                fontSize: compacto ? 20 : 26,
                fontWeight: FontWeight.w800,
                letterSpacing: -0.8,
              ),
            ),
          ],
        ),
      ],
    );
  }

  /// "Producto" o "3 productos", según lo que haya.
  ///
  /// El singular importa: "1 productos" es la clase de detalle que hace que una
  /// app se sienta hecha a las apuradas.
  String get _etiquetaDeProductos {
    final unidades = pedido.lineas.fold<int>(0, (suma, l) => suma + l.cantidad);
    if (unidades <= 1) return 'Producto';
    return '$unidades productos';
  }
}

class _Linea extends StatelessWidget {
  const _Linea({
    required this.etiqueta,
    required this.valor,
    this.aclaracion,
    this.destacado = false,
    this.suave = false,
  });

  final String etiqueta;
  final String valor;
  final String? aclaracion;

  /// Verde: es algo bueno para quien compra (envío gratis).
  final bool destacado;

  /// Gris: es informativo, no un monto (retiro en persona).
  final bool suave;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Text(
                  etiqueta,
                  style: const TextStyle(fontSize: 13.5, color: AppColor.textoSuave),
                ),
              ),
              const SizedBox(width: Gap.md),
              Text(
                valor,
                style: TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                  color: destacado
                      ? AppColor.exito
                      : suave
                          ? AppColor.textoSuave
                          : AppColor.texto,
                ),
              ),
            ],
          ),
          if (aclaracion != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                aclaracion!,
                style: const TextStyle(fontSize: 11.5, color: AppColor.textoDebil, height: 1.3),
              ),
            ),
        ],
      ),
    );
  }
}
