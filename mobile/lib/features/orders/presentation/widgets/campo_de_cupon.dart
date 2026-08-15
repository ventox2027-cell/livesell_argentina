import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../core/design/tokens.dart';
import '../../domain/order_models.dart';

/// «¿Tenés un cupón?», en el resumen de la compra.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ARRANCA CERRADO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Un campo de cupón abierto en medio del checkout le dice a quien no tiene
/// ninguno que se está perdiendo algo, y lo manda a buscar códigos a Google en
/// vez de terminar la compra. Es un abandono conocido y medido en comercio
/// electrónico.
///
/// Cerrado, ocupa una línea. Quien tiene un código lo busca y lo encuentra;
/// quien no, sigue de largo.
///
/// ─── El descuento lo calcula el servidor ───
///
/// Acá sólo viaja el texto que la persona escribió. Cuánto descuenta —y si
/// descuenta— sale del backend, que lo busca en la base del vendedor de esta
/// compra. Ver `cupones.ts`.
class CampoDeCupon extends StatefulWidget {
  const CampoDeCupon({
    super.key,
    required this.pedido,
    required this.onAplicar,
    required this.onQuitar,
  });

  final Pedido pedido;

  /// Devuelve el mensaje de error, o `null` si salió bien.
  final Future<String?> Function(String codigo) onAplicar;
  final Future<void> Function() onQuitar;

  @override
  State<CampoDeCupon> createState() => _CampoDeCuponState();
}

class _CampoDeCuponState extends State<CampoDeCupon> {
  final _controlador = TextEditingController();
  bool _abierto = false;
  bool _trabajando = false;
  String? _error;

  @override
  void dispose() {
    _controlador.dispose();
    super.dispose();
  }

  Future<void> _aplicar() async {
    final codigo = _controlador.text.trim();
    if (codigo.isEmpty || _trabajando) return;

    setState(() {
      _trabajando = true;
      _error = null;
    });

    final error = await widget.onAplicar(codigo);

    if (!mounted) return;
    setState(() {
      _trabajando = false;
      _error = error;
      if (error == null) {
        _abierto = false;
        _controlador.clear();
      }
    });
  }

  Future<void> _quitar() async {
    if (_trabajando) return;
    setState(() => _trabajando = true);
    await widget.onQuitar();
    if (!mounted) return;
    setState(() {
      _trabajando = false;
      _error = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    // Ya hay uno aplicado: se muestra puesto, con la forma de sacarlo.
    if (widget.pedido.tieneCupon) return _aplicado();
    if (!_abierto) return _cerrado();
    return _formulario();
  }

  Widget _cerrado() {
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton.icon(
        onPressed: () => setState(() => _abierto = true),
        icon: const Icon(Icons.local_offer_outlined, size: 17),
        label: const Text('¿Tenés un cupón?'),
        style: TextButton.styleFrom(
          foregroundColor: AppColor.textoSuave,
          padding: const EdgeInsets.symmetric(horizontal: Gap.sm, vertical: Gap.xs),
          minimumSize: Size.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      ),
    );
  }

  Widget _formulario() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _controlador,
                enabled: !_trabajando,
                autofocus: true,
                textCapitalization: TextCapitalization.characters,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _aplicar(),
                /**
                 * Se fuerza a mayúsculas mientras escribe.
                 *
                 * El servidor normaliza igual, así que esto no es validación:
                 * es que el código se vea como el que la persona leyó en el
                 * vivo. Ver `normalizarCodigo`.
                 */
                inputFormatters: [
                  LengthLimitingTextInputFormatter(30),
                  TextInputFormatter.withFunction(
                    (_, nuevo) => nuevo.copyWith(text: nuevo.text.toUpperCase()),
                  ),
                ],
                decoration: InputDecoration(
                  hintText: 'Código del cupón',
                  isDense: true,
                  errorText: _error,
                  prefixIcon: const Icon(Icons.local_offer_outlined, size: 18),
                  prefixIconConstraints: const BoxConstraints(minWidth: 38),
                ),
                style: const TextStyle(fontWeight: FontWeight.w700, letterSpacing: 0.5),
              ),
            ),
            const SizedBox(width: Gap.sm),
            FilledButton(
              onPressed: _trabajando ? null : _aplicar,
              style: FilledButton.styleFrom(
                minimumSize: const Size(0, 44),
                padding: const EdgeInsets.symmetric(horizontal: Gap.lg),
              ),
              child: _trabajando
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Aplicar'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _aplicado() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: Gap.sm),
      decoration: BoxDecoration(
        color: AppColor.exito.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(color: AppColor.exito.withValues(alpha: 0.35)),
      ),
      child: Row(
        children: [
          const Icon(Icons.check_circle_rounded, size: 18, color: AppColor.exito),
          const SizedBox(width: Gap.sm),
          const Expanded(
            child: Text(
              'Cupón aplicado',
              style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
            ),
          ),
          TextButton(
            onPressed: _trabajando ? null : _quitar,
            style: TextButton.styleFrom(
              foregroundColor: AppColor.textoSuave,
              padding: const EdgeInsets.symmetric(horizontal: Gap.sm),
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: const Text('Quitar'),
          ),
        ],
      ),
    );
  }
}
