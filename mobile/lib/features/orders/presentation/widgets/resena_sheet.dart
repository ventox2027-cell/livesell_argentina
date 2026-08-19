import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens.dart';
import '../../../../core/network/errores_de_red.dart';
import '../../../../shared/widgets/app_snack.dart';
import '../../data/orders_repository.dart';

/// Calificar una compra.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL COMENTARIO ES OPCIONAL Y SE NOTA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Con las estrellas alcanza. Obligar a escribir algo hace que la mayoría
/// abandone, y las pocas reseñas que quedan son las de quien estaba muy
/// enojado o muy contento — que es exactamente el sesgo que hace inútil una
/// reputación.
///
/// Las estrellas se tocan y ya se puede enviar.
class ResenaSheet extends ConsumerStatefulWidget {
  const ResenaSheet({
    super.key,
    required this.orderId,
    required this.tienda,
  });

  final String orderId;
  final String tienda;

  /// Devuelve `true` si quedó calificada.
  static Future<bool?> mostrar(
    BuildContext context, {
    required String orderId,
    required String tienda,
  }) {
    return showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColor.superficie,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
        child: ResenaSheet(orderId: orderId, tienda: tienda),
      ),
    );
  }

  @override
  ConsumerState<ResenaSheet> createState() => _ResenaSheetState();
}

class _ResenaSheetState extends ConsumerState<ResenaSheet> {
  final _comentario = TextEditingController();
  int _estrellas = 0;
  bool _enviando = false;

  @override
  void dispose() {
    _comentario.dispose();
    super.dispose();
  }

  Future<void> _enviar() async {
    if (_estrellas == 0) return;

    setState(() => _enviando = true);
    try {
      await ref.read(ordersRepositoryProvider).resenar(
            widget.orderId,
            rating: _estrellas,
            comentario: _comentario.text.trim(),
          );
      unawaited(HapticFeedback.mediumImpact());
      ref.invalidate(misPedidosProvider);
      if (!mounted) return;
      Navigator.of(context).pop(true);
      AppSnack.exito(context, 'Gracias por calificar');
    } catch (e) {
      if (!mounted) return;
      setState(() => _enviando = false);
      AppSnack.error(context, mensajeDeError(e));
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
          Text('¿Cómo fue tu compra?', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 2),
          Text(
            widget.tienda,
            style: const TextStyle(fontSize: 13.5, color: AppColor.textoSuave),
          ),
          const SizedBox(height: Gap.xl),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (var i = 1; i <= 5; i++)
                Semantics(
                  button: true,
                  label: '$i ${i == 1 ? "estrella" : "estrellas"}',
                  selected: _estrellas == i,
                  child: IconButton(
                    onPressed: () {
                      unawaited(HapticFeedback.selectionClick());
                      setState(() => _estrellas = i);
                    },
                    iconSize: 40,
                    // Objetivo táctil grande: cinco estrellas juntas en un
                    // teléfono son cinco blancos chicos y uno se equivoca.
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    constraints: const BoxConstraints(minWidth: 52, minHeight: 52),
                    icon: Icon(
                      i <= _estrellas ? Icons.star_rounded : Icons.star_outline_rounded,
                      color: i <= _estrellas ? AppColor.alerta : AppColor.textoDebil,
                    ),
                  ),
                ),
            ],
          ),
          if (_estrellas > 0) ...[
            const SizedBox(height: Gap.xs),
            Center(
              child: Text(
                _leyenda(_estrellas),
                style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
              ),
            ),
          ],
          const SizedBox(height: Gap.xl),
          TextField(
            controller: _comentario,
            maxLines: 3,
            maxLength: 1000,
            textCapitalization: TextCapitalization.sentences,
            decoration: const InputDecoration(
              labelText: 'Contá algo (opcional)',
              hintText: 'Llegó rápido y tal cual la foto.',
              alignLabelWithHint: true,
              counterText: '',
            ),
          ),
          const SizedBox(height: Gap.lg),
          FilledButton(
            onPressed: _estrellas == 0 || _enviando ? null : () => unawaited(_enviar()),
            style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
            child: _enviando
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Text(
                    'Calificar',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                  ),
          ),
          const SizedBox(height: Gap.sm),
          const Text(
            'Se publica con tu nombre y queda marcada como compra verificada.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: AppColor.textoDebil),
          ),
        ],
      ),
    );
  }
}

/// Qué significa cada cantidad de estrellas.
///
/// Sin esto, tres estrellas quiere decir cosas distintas para cada persona y
/// el promedio termina midiendo criterios, no experiencias.
String _leyenda(int estrellas) => switch (estrellas) {
      1 => 'Muy mala',
      2 => 'Mala',
      3 => 'Más o menos',
      4 => 'Buena',
      _ => 'Excelente',
    };
