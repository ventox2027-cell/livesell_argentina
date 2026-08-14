import 'package:flutter/material.dart';

import '../../../../core/design/tokens.dart';
import '../../../seller/domain/seller_models.dart' show formatearPesos;
import '../../domain/politicas_de_tienda.dart';

/// El envío y las devoluciones, antes de comprar.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ACÁ Y NO EN EL CHECKOUT
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Enterarse de que el envío sale $3.500 con la tarjeta ya en la mano es la
/// razón número uno por la que alguien abandona una compra. Y no es sólo una
/// venta perdida: es alguien que se sintió engañado y no vuelve.
///
/// El derecho de arrepentimiento va acá por otro motivo: la Resolución 424/2020
/// pide que sea visible y fácil de encontrar. "Fácil de encontrar" no es un pie
/// de página en los términos y condiciones.
class EnvioYPoliticas extends StatelessWidget {
  const EnvioYPoliticas({
    super.key,
    required this.envio,
    required this.cambios,
    this.retira,
    this.onCambiarRetiro,
  });

  final PoliticaDeEnvio envio;
  final PoliticaDeCambios cambios;

  /// Si eligió retirar. `null` cuando no hay nada que elegir.
  final bool? retira;

  /// Sólo se pasa cuando la tienda ofrece las dos opciones.
  final ValueChanged<bool>? onCambiarRetiro;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (envio.hayQueElegir && onCambiarRetiro != null)
          _Eleccion(envio: envio, retira: retira ?? false, onCambiar: onCambiarRetiro!)
        else
          _EnvioFijo(envio: envio),
        if (envio.nota != null && envio.nota!.isNotEmpty) ...[
          const SizedBox(height: Gap.sm),
          Text(
            envio.nota!,
            style: const TextStyle(fontSize: 12, color: AppColor.textoDebil, height: 1.35),
          ),
        ],
        if (envio.trasladaCostoDelProcesador) ...[
          const SizedBox(height: Gap.sm),
          const Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.info_outline_rounded, size: 13, color: AppColor.textoDebil),
              SizedBox(width: 6),
              Expanded(
                child: Text(
                  // Se avisa acá y no en el checkout: un recargo que aparece
                  // recién al pagar se siente escondido aunque esté explicado.
                  'Al total se le suma el costo del medio de pago.',
                  style: TextStyle(fontSize: 12, color: AppColor.textoDebil, height: 1.35),
                ),
              ),
            ],
          ),
        ],
        const SizedBox(height: Gap.md),
        _Cambios(cambios: cambios),
      ],
    );
  }
}

/// Cuando no hay nada que elegir: una línea con lo que hay.
class _EnvioFijo extends StatelessWidget {
  const _EnvioFijo({required this.envio});

  final PoliticaDeEnvio envio;

  @override
  Widget build(BuildContext context) {
    final gratis = envio.esGratis;
    final soloRetiro = !envio.permiteEnvio;

    return Row(
      children: [
        Icon(
          soloRetiro ? Icons.storefront_outlined : Icons.local_shipping_outlined,
          size: 17,
          color: gratis ? AppColor.exito : AppColor.textoSuave,
        ),
        const SizedBox(width: Gap.sm),
        Expanded(
          child: Text(
            // La etiqueta la escribe el backend: "Envío gratis" y "Retiro en
            // persona" son cosas distintas y confundirlas hace que alguien
            // espere un paquete que nunca sale.
            envio.etiqueta,
            style: TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.w600,
              color: gratis ? AppColor.exito : AppColor.texto,
            ),
          ),
        ),
        if (!gratis && !soloRetiro)
          Text(
            formatearPesos(envio.costo),
            style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
          ),
      ],
    );
  }
}

/// Cuando la tienda ofrece envío y retiro: dos opciones tocables.
///
/// Se muestran las dos con su precio al lado, en vez de un interruptor. Un
/// interruptor con la etiqueta "retiro en persona" obliga a tocarlo para ver
/// cuánto se ahorra; así el precio de cada opción está a la vista desde el
/// principio y la decisión se toma de una.
class _Eleccion extends StatelessWidget {
  const _Eleccion({required this.envio, required this.retira, required this.onCambiar});

  final PoliticaDeEnvio envio;
  final bool retira;
  final ValueChanged<bool> onCambiar;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        _OpcionDeEntrega(
          icono: Icons.local_shipping_outlined,
          titulo: 'Envío a domicilio',
          precio: envio.costo == 0 ? 'Gratis' : formatearPesos(envio.costo),
          elegida: !retira,
          onTap: () => onCambiar(false),
        ),
        const SizedBox(height: Gap.sm),
        _OpcionDeEntrega(
          icono: Icons.storefront_outlined,
          titulo: 'Retiro en persona',
          precio: 'Gratis',
          elegida: retira,
          onTap: () => onCambiar(true),
        ),
      ],
    );
  }
}

class _OpcionDeEntrega extends StatelessWidget {
  const _OpcionDeEntrega({
    required this.icono,
    required this.titulo,
    required this.precio,
    required this.elegida,
    required this.onTap,
  });

  final IconData icono;
  final String titulo;
  final String precio;
  final bool elegida;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      selected: elegida,
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Redondeo.md),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: 11),
          decoration: BoxDecoration(
            color: elegida ? AppColor.superficieAlta : Colors.transparent,
            borderRadius: BorderRadius.circular(Redondeo.md),
            border: Border.all(
              color: elegida ? AppColor.acento : AppColor.borde,
              width: elegida ? 1.4 : 1,
            ),
          ),
          child: Row(
            children: [
              Icon(icono, size: 17, color: elegida ? AppColor.acento : AppColor.textoSuave),
              const SizedBox(width: Gap.sm),
              Expanded(
                child: Text(
                  titulo,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: elegida ? FontWeight.w700 : FontWeight.w500,
                  ),
                ),
              ),
              Text(
                precio,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: precio == 'Gratis' ? AppColor.exito : AppColor.texto,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Cambios y devoluciones, plegado.
///
/// Plegado porque no es lo que la persona vino a leer: vino a comprar. Pero
/// tiene que poder abrirlo sin salir de la hoja, y el derecho de
/// arrepentimiento se ve apenas lo abre — no enterrado al final.
class _Cambios extends StatelessWidget {
  const _Cambios({required this.cambios});

  final PoliticaDeCambios cambios;

  @override
  Widget build(BuildContext context) {
    return Material(
      /**
       * `Material` transparente, y no es decoración.
       *
       * `ExpansionTile` usa un `ListTile` adentro, y un `ListTile` pinta su
       * fondo y su onda al tocar sobre el `Material` más cercano hacia arriba.
       * Dentro de la hoja de variantes, lo que hay arriba es un `Container` con
       * color: la onda queda tapada y tocar "Cambios y devoluciones" no produce
       * ninguna respuesta visible.
       *
       * En un test aislado no se nota —el `Scaffold` ya trae su `Material`— y
       * en el teléfono se siente como que la app se colgó. Flutter lo detecta
       * en modo depuración y lanza una aserción; así lo encontramos.
       */
      type: MaterialType.transparency,
      child: Theme(
        // Sin las líneas divisorias que Flutter pone por omisión: acá el bloque
        // ya está adentro de una hoja con su propia separación.
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          tilePadding: EdgeInsets.zero,
          childrenPadding: const EdgeInsets.only(bottom: Gap.sm),
          expandedCrossAxisAlignment: CrossAxisAlignment.start,
          leading:
              const Icon(Icons.assignment_return_outlined, size: 17, color: AppColor.textoSuave),
          title: Text(
            cambios.titulo,
            style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
          ),
          subtitle: cambios.ofreceMasQueElMinimo
              ? Text(
                  '${cambios.dias} días',
                  style: const TextStyle(fontSize: 12, color: AppColor.exito),
                )
              : null,
          children: [
            for (final linea in cambios.lineas)
              Padding(
                padding: const EdgeInsets.only(bottom: 5),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('· ', style: TextStyle(color: AppColor.textoSuave)),
                    Expanded(
                      child: Text(
                        linea,
                        style: const TextStyle(
                          fontSize: 12.5,
                          color: AppColor.textoSuave,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: Gap.sm),
            Container(
              padding: const EdgeInsets.all(Gap.md),
              decoration: BoxDecoration(
                color: AppColor.superficieAlta,
                borderRadius: BorderRadius.circular(Redondeo.md),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.gavel_rounded, size: 15, color: AppColor.textoSuave),
                  const SizedBox(width: Gap.sm),
                  Expanded(
                    child: Text(
                      // Va SIEMPRE, elija lo que elija el vendedor. El texto lo
                      // escribe el backend para que diga lo mismo acá, en el
                      // detalle del pedido y en el mail.
                      cambios.derechoDeArrepentimiento,
                      style: const TextStyle(
                        fontSize: 12,
                        color: AppColor.textoSuave,
                        height: 1.45,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
