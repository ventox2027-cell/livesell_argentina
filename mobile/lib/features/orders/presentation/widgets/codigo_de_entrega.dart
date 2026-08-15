import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../core/design/tokens.dart';
import '../../../../shared/widgets/app_snack.dart';

/// El código que el comprador le dice a quien trae el pedido.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SE MUESTRA TAPADO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El código es lo único que impide que el vendedor marque entregado un pedido
/// que no entregó. Mostrarlo siempre visible lo pone en cualquier captura de
/// pantalla que alguien haga de su lista de pedidos — y esas capturas se
/// mandan por chat todo el tiempo, para preguntar por una compra.
///
/// Un toque lo revela. Es la fricción mínima que evita el accidente más común,
/// sin convertirlo en una molestia: cuando llega el repartidor, se toca y se
/// lee.
class CodigoDeEntrega extends StatefulWidget {
  const CodigoDeEntrega({super.key, required this.codigo});

  final String codigo;

  @override
  State<CodigoDeEntrega> createState() => _CodigoDeEntregaState();
}

class _CodigoDeEntregaState extends State<CodigoDeEntrega> {
  bool _visible = false;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.acento.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: AppColor.acento.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.lock_outline_rounded, size: 18, color: AppColor.acento),
              SizedBox(width: Gap.sm),
              Text(
                'Tu código de entrega',
                style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700),
              ),
            ],
          ),
          const SizedBox(height: Gap.md),
          Semantics(
            // Sin esto, quien usa lector de pantalla escucha los seis dígitos
            // sueltos y sin contexto.
            label: _visible
                ? 'Código de entrega ${widget.codigo.split('').join(' ')}'
                : 'Código de entrega oculto. Tocá para mostrarlo.',
            button: !_visible,
            child: GestureDetector(
              onTap: () => setState(() => _visible = !_visible),
              behavior: HitTestBehavior.opaque,
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      _visible ? _conEspacios(widget.codigo) : '• • •   • • •',
                      style: TextStyle(
                        fontSize: 30,
                        fontWeight: FontWeight.w800,
                        letterSpacing: _visible ? 4 : 2,
                        fontFeatures: const [FontFeature.tabularFigures()],
                        color: _visible ? AppColor.texto : AppColor.textoDebil,
                      ),
                    ),
                  ),
                  Icon(
                    _visible ? Icons.visibility_off_rounded : Icons.visibility_rounded,
                    color: AppColor.textoSuave,
                  ),
                ],
              ),
            ),
          ),
          if (_visible) ...[
            const SizedBox(height: Gap.sm),
            TextButton.icon(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: widget.codigo));
                if (context.mounted) AppSnack.info(context, 'Código copiado');
              },
              icon: const Icon(Icons.copy_rounded, size: 16),
              label: const Text('Copiar'),
              style: TextButton.styleFrom(
                foregroundColor: AppColor.textoSuave,
                padding: EdgeInsets.zero,
                visualDensity: VisualDensity.compact,
              ),
            ),
          ],
          const SizedBox(height: Gap.sm),
          const Text(
            // El único texto que importa de toda la tarjeta.
            //
            // Dice "o repartidor" porque muchas veces no es el vendedor quien
            // toca el timbre, y alguien que lee sólo "vendedor" duda de si
            // dárselo a la persona que tiene enfrente.
            'Decíselo al vendedor o al repartidor únicamente cuando tengas el '
            'producto en tus manos. Con ese número queda marcada la entrega.',
            style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave, height: 1.45),
          ),
        ],
      ),
    );
  }
}

/// `123456` → `123 456`. Tres y tres se lee en voz alta sin perderse.
String _conEspacios(String codigo) {
  if (codigo.length != 6) return codigo;
  return '${codigo.substring(0, 3)} ${codigo.substring(3)}';
}
