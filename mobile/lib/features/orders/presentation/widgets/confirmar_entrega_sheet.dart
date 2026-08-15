import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens.dart';
import '../../../../shared/widgets/app_snack.dart';
import '../../data/orders_repository.dart';

/// El vendedor confirma la entrega con el código del comprador.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ACÁ NO SE MUESTRA NINGÚN CÓDIGO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Esta pantalla sólo tiene un campo vacío. El vendedor **no puede consultar**
/// el código: no viene en ninguna de sus respuestas del backend, y si pudiera
/// verlo todo el mecanismo no serviría para nada — podría marcar entregado sin
/// haber entregado.
///
/// Lo pide, lo escribe, y el backend compara.
class ConfirmarEntregaSheet extends ConsumerStatefulWidget {
  const ConfirmarEntregaSheet({
    super.key,
    required this.orderId,
    required this.referencia,
  });

  final String orderId;
  final String referencia;

  /// Devuelve `true` si la entrega quedó confirmada.
  static Future<bool?> mostrar(
    BuildContext context, {
    required String orderId,
    required String referencia,
  }) {
    return showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColor.superficie,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
        child: ConfirmarEntregaSheet(orderId: orderId, referencia: referencia),
      ),
    );
  }

  @override
  ConsumerState<ConfirmarEntregaSheet> createState() => _ConfirmarEntregaSheetState();
}

class _ConfirmarEntregaSheetState extends ConsumerState<ConfirmarEntregaSheet> {
  /// El largo exacto del código. El mismo número que valida el backend.
  static const _largo = 6;

  final _codigo = TextEditingController();
  bool _enviando = false;
  String? _error;

  bool get _completo => _codigo.text.trim().length == _largo;

  @override
  void dispose() {
    _codigo.dispose();
    super.dispose();
  }

  Future<void> _confirmar() async {
    final codigo = _codigo.text.trim();
    if (codigo.length != _largo) {
      setState(() => _error = 'Son seis números.');
      return;
    }

    setState(() {
      _enviando = true;
      _error = null;
    });

    try {
      await ref.read(ordersRepositoryProvider).confirmarEntrega(widget.orderId, codigo);
      unawaited(HapticFeedback.mediumImpact());
      ref.invalidate(misVentasProvider);
      if (!mounted) return;
      Navigator.of(context).pop(true);
      AppSnack.exito(context, 'Entrega confirmada');
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _enviando = false;
        // El backend ya manda el motivo en castellano: "El código no coincide"
        // o "Demasiados intentos". Repetirlo acá con otras palabras haría que
        // la misma falla se cuente de dos formas.
        _error = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.md, Gap.xl, Gap.xl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 36,
              height: 4,
              decoration: BoxDecoration(
                color: AppColor.borde,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: Gap.lg),
          Text(
            'Confirmar entrega',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 2),
          Text(
            'Pedido ${widget.referencia}',
            style: const TextStyle(fontSize: 13, color: AppColor.textoSuave),
          ),
          const SizedBox(height: Gap.lg),
          const Text(
            'Pedile a quien recibe el pedido los seis números que ve en su app.',
            style: TextStyle(fontSize: 14, color: AppColor.textoSuave, height: 1.45),
          ),
          const SizedBox(height: Gap.lg),
          TextField(
            controller: _codigo,
            autofocus: true,
            keyboardType: TextInputType.number,
            textAlign: TextAlign.center,
            maxLength: _largo,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            style: const TextStyle(
              fontSize: 30,
              fontWeight: FontWeight.w800,
              letterSpacing: 8,
              fontFeatures: [FontFeature.tabularFigures()],
            ),
            decoration: InputDecoration(
              hintText: '––––––',
              counterText: '',
              errorText: _error,
              filled: true,
              fillColor: AppColor.superficieAlta,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Redondeo.md),
                borderSide: BorderSide.none,
              ),
            ),
            onChanged: (v) {
              // El `setState` es incondicional porque el botón depende del
              // largo: sin esto queda deshabilitado con el campo completo.
              setState(() => _error = null);
              // Seis dígitos es el largo exacto: confirmar solo al completarlo
              // ahorra un toque en la puerta, con el repartidor esperando.
              if (v.length == _largo && !_enviando) unawaited(_confirmar());
            },
          ),
          const SizedBox(height: Gap.lg),
          FilledButton(
            // Deshabilitado hasta tener los seis dígitos. Dejarlo activo para
            // después responder "son seis números" es hacer que la persona
            // descubra la regla equivocándose, con el repartidor en la puerta.
            onPressed: _enviando || !_completo ? null : () => unawaited(_confirmar()),
            style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
            child: _enviando
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Text(
                    'Confirmar entrega',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                  ),
          ),
          const SizedBox(height: Gap.sm),
          const Text(
            'Después de cinco intentos fallidos hay que esperar un rato.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: AppColor.textoDebil),
          ),
        ],
      ),
    );
  }
}
