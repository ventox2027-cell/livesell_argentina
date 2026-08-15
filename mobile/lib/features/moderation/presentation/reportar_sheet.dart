import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../auth/state/auth_providers.dart';

/// Reportar contenido.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA RESPUESTA ES SIEMPRE LA MISMA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// "Gracias, lo revisamos." Nunca "esto ya tenía cuatro reportes y con el tuyo
/// lo bajamos".
///
/// Decirlo convertiría el umbral en un juego: quien quiera bajarle la
/// publicación a un competidor sabría exactamente cuántas cuentas necesita. Y
/// para quien reporta de buena fe, saberlo no le cambia nada.
///
/// ─── Y el motivo se elige de una lista ───
///
/// No un campo libre. La categoría es lo que decide el umbral, y "me parece que
/// esto está mal" no se puede clasificar. El texto libre está igual, al lado,
/// porque suele ser lo más útil para quien modera: "vende réplicas de una marca"
/// dice mucho más que la categoría sola.
class ReportarSheet extends ConsumerStatefulWidget {
  const ReportarSheet({super.key, required this.targetType, required this.targetId});

  /// `PRODUCT`, `LIVE`, `SELLER`, `REVIEW` o `CHAT_MESSAGE`.
  final String targetType;
  final String targetId;

  static Future<void> mostrar(
    BuildContext context, {
    required String targetType,
    required String targetId,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColor.superficie,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Redondeo.lg)),
      ),
      builder: (_) => ReportarSheet(targetType: targetType, targetId: targetId),
    );
  }

  @override
  ConsumerState<ReportarSheet> createState() => _ReportarSheetState();
}

/// Los motivos, con el texto que entiende una persona.
///
/// El orden importa: lo grave arriba. Quien reporta algo serio no debería tener
/// que bajar hasta el final de una lista que empieza con "spam".
const _motivos = <({String codigo, String titulo, String detalle})>[
  (
    codigo: 'PROHIBIDO',
    titulo: 'No se puede vender',
    detalle: 'Armas, drogas, animales, documentos',
  ),
  (
    codigo: 'CONTENIDO_SEXUAL',
    titulo: 'Contenido sexual',
    detalle: 'Desnudez o contenido explícito',
  ),
  (
    codigo: 'VIOLENCIA',
    titulo: 'Violencia o discriminación',
    detalle: 'Insultos, amenazas, agresión',
  ),
  (codigo: 'ESTAFA', titulo: 'Parece una estafa', detalle: 'Pide pagar por afuera de la app'),
  (codigo: 'FALSIFICADO', titulo: 'Producto falsificado', detalle: 'Réplica de una marca'),
  (
    codigo: 'CONTENIDO_AJENO',
    titulo: 'Fotos o textos de otro',
    detalle: 'El contenido no es de quien publica',
  ),
  (codigo: 'ENGANOSO', titulo: 'No es lo que dice', detalle: 'La descripción no coincide'),
  (codigo: 'SPAM', titulo: 'Spam', detalle: 'Publicaciones repetidas o irrelevantes'),
  (codigo: 'OTRO', titulo: 'Otra cosa', detalle: 'Contanos qué pasa'),
];

class _ReportarSheetState extends ConsumerState<ReportarSheet> {
  String? _motivo;
  final _detalle = TextEditingController();
  bool _enviando = false;

  @override
  void dispose() {
    _detalle.dispose();
    super.dispose();
  }

  Future<void> _enviar() async {
    final motivo = _motivo;
    if (motivo == null || _enviando) return;

    setState(() => _enviando = true);

    try {
      await ref.read(apiClientProvider).post<Map<String, dynamic>>(
        '/reports',
        data: {
          'targetType': widget.targetType,
          'targetId': widget.targetId,
          'reason': motivo,
          if (_detalle.text.trim().isNotEmpty) 'detail': _detalle.text.trim(),
        },
      );

      if (!mounted) return;
      Navigator.of(context).pop();
      // El mismo mensaje pase lo que pase del otro lado. Ver el comentario de
      // la clase.
      AppSnack.info(context, 'Gracias. Lo vamos a revisar.');
    } catch (_) {
      if (!mounted) return;
      setState(() => _enviando = false);
      AppSnack.error(context, 'No pudimos enviar el reporte. Probá de nuevo.');
    }
  }

  @override
  Widget build(BuildContext context) {
    // El teclado no puede tapar el botón: la hoja sube con él.
    final teclado = MediaQuery.of(context).viewInsets.bottom;

    return Padding(
      padding: EdgeInsets.only(bottom: teclado),
      child: SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: Gap.sm),
            Container(
              width: 36,
              height: 4,
              decoration: BoxDecoration(
                color: AppColor.borde,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(height: Gap.lg),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: Gap.xl),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '¿Qué pasa con esto?',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                ),
              ),
            ),
            const SizedBox(height: Gap.md),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(horizontal: Gap.xl),
                child: Column(
                  children: [
                    for (final m in _motivos) ...[
                      _Motivo(
                        titulo: m.titulo,
                        detalle: m.detalle,
                        elegido: _motivo == m.codigo,
                        onTap: () => setState(() => _motivo = m.codigo),
                      ),
                      const SizedBox(height: 6),
                    ],
                    const SizedBox(height: Gap.md),
                    TextField(
                      controller: _detalle,
                      maxLength: 1000,
                      maxLines: 3,
                      decoration: const InputDecoration(
                        labelText: 'Contanos más (opcional)',
                        // Es lo más útil para quien modera.
                        hintText: 'Lo que nos cuentes nos ayuda a resolverlo más rápido.',
                      ),
                    ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.md, Gap.xl, Gap.lg),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _motivo == null || _enviando ? null : _enviar,
                  style: FilledButton.styleFrom(minimumSize: const Size(0, 50)),
                  child: _enviando
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                        )
                      : const Text('Enviar reporte'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Motivo extends StatelessWidget {
  const _Motivo({
    required this.titulo,
    required this.detalle,
    required this.elegido,
    required this.onTap,
  });

  final String titulo;
  final String detalle;
  final bool elegido;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      selected: elegido,
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Redondeo.md),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: 10),
          decoration: BoxDecoration(
            color: elegido ? AppColor.superficieAlta : Colors.transparent,
            borderRadius: BorderRadius.circular(Redondeo.md),
            border: Border.all(
              color: elegido ? AppColor.acento : AppColor.borde,
              width: elegido ? 1.4 : 1,
            ),
          ),
          child: Row(
            children: [
              Icon(
                elegido ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                size: 18,
                color: elegido ? AppColor.acento : AppColor.textoDebil,
              ),
              const SizedBox(width: Gap.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      titulo,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: elegido ? FontWeight.w700 : FontWeight.w500,
                      ),
                    ),
                    Text(
                      detalle,
                      style: const TextStyle(fontSize: 11.5, color: AppColor.textoSuave),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
