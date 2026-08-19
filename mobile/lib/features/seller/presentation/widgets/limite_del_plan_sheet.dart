import 'package:flutter/material.dart';

import '../../../../core/design/tokens.dart';

/// Llegaste al tope de productos publicados de tu plan.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ESTO NO ES UN ERROR, Y NO PUEDE PARECERLO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Antes salía como un cartel rojo debajo del producto, con el texto crudo del
/// backend. Rojo significa «algo se rompió»: el vendedor leía que su producto
/// había fallado, cuando en realidad **se guardó perfecto como borrador** y lo
/// único que pasó es que su plan llegó al tope.
///
/// Un límite comercial anunciado como error técnico logra lo peor de los dos
/// mundos: asusta y encima no vende nada.
///
/// Acá se dice lo que pasó —el producto está a salvo—, lo que se puede hacer, y
/// se ofrece el camino. Sin rojo, sin ícono de alerta.
///
/// ⚠️ NO promete una compra. Hoy VendoX Pro se otorga desde el panel de
/// administración y no hay cobro: el botón lleva a la pantalla de Pro, que
/// explica los beneficios y no tiene botón de contratar. Ofrecer «Comprar Pro»
/// sería vender algo que todavía no se puede entregar.
class LimiteDelPlanSheet extends StatelessWidget {
  const LimiteDelPlanSheet._({required this.limite, required this.onVerPro});

  final int limite;
  final VoidCallback onVerPro;

  /// Muestra la hoja. Devuelve `true` si la persona quiso ver Pro.
  static Future<bool> mostrar(BuildContext context, {required int limite}) async {
    final resultado = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColor.superficieAlta,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Redondeo.lg)),
      ),
      builder: (ctx) => LimiteDelPlanSheet._(
        limite: limite,
        onVerPro: () => Navigator.pop(ctx, true),
      ),
    );
    return resultado ?? false;
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.lg, Gap.xl, Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // El tirador de la hoja. Dice «esto se arrastra» sin escribirlo.
            Center(
              child: Container(
                width: 36,
                height: 4,
                margin: const EdgeInsets.only(bottom: Gap.xl),
                decoration: BoxDecoration(
                  color: AppColor.borde,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),

            Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    color: AppColor.acentoSuave,
                    borderRadius: BorderRadius.circular(Redondeo.md),
                  ),
                  // Un ícono de CATÁLOGO, no de alerta. Lo que pasó es que el
                  // catálogo está lleno, no que algo se rompió.
                  child: const Icon(Icons.inventory_2_outlined, color: AppColor.acento, size: 22),
                ),
                const SizedBox(width: Gap.md),
                const Expanded(
                  child: Text(
                    'Tu catálogo Free está completo',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, height: 1.2),
                  ),
                ),
              ],
            ),

            const SizedBox(height: Gap.lg),

            Text(
              'Tu catálogo Free ya tiene $limite productos publicados.',
              style: const TextStyle(fontSize: 14.5, color: AppColor.textoSuave, height: 1.5),
            ),
            const SizedBox(height: Gap.sm),

            /**
             * Lo primero que hay que despejar: el trabajo no se perdió.
             *
             * Es la pregunta que se hace cualquiera al ver un cartel después de
             * cargar un producto con sus fotos. Va destacado y no mezclado con
             * el resto del texto.
             */
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(Gap.md),
              decoration: BoxDecoration(
                color: AppColor.superficie,
                borderRadius: BorderRadius.circular(Redondeo.md),
                border: Border.all(color: AppColor.borde),
              ),
              child: const Row(
                children: [
                  Icon(Icons.check_circle_outline_rounded, size: 18, color: AppColor.exito),
                  SizedBox(width: Gap.sm),
                  Expanded(
                    child: Text(
                      'Este producto quedó guardado como borrador.',
                      style: TextStyle(fontSize: 13.5, height: 1.4),
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: Gap.lg),
            const Text(
              'Con VendoX Pro podés publicar más productos.',
              style: TextStyle(fontSize: 14.5, color: AppColor.textoSuave, height: 1.5),
            ),

            const SizedBox(height: Gap.xl),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: onVerPro,
                child: const Text('Ver VendoX Pro'),
              ),
            ),
            const SizedBox(height: Gap.sm),
            SizedBox(
              width: double.infinity,
              child: TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Seguir editando'),
              ),
            ),

            const SizedBox(height: Gap.sm),
            /**
             * Y la salida que no cuesta plata, dicha explícitamente.
             *
             * Pausar uno libera lugar. Omitirlo dejaría la hoja como un muro
             * con una sola puerta paga, y hay una gratis que funciona.
             */
            const Text(
              'También podés pausar un producto publicado para hacerle lugar a éste.',
              style: TextStyle(fontSize: 12.5, color: AppColor.textoDebil, height: 1.45),
            ),
          ],
        ),
      ),
    );
  }
}
