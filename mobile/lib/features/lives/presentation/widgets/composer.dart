import 'package:flutter/material.dart';

import '../../../../core/design/tokens.dart';

/// La barra para escribir un comentario.
///
/// ─── Lo único de la pantalla que se mueve con el teclado ───
///
/// Su posición la decide `live_viewer_screen.dart` contra `viewInsets.bottom`.
/// Este widget sólo se dibuja donde le digan.
///
/// El producto destacado **no** se mueve, y esa es la razón de todo el manejo
/// manual: quien está escribiendo "¿tenés en negro?" necesita seguir viendo qué
/// está mirando.
class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.controlador,
    required this.foco,
    required this.onEnviar,
    this.habilitado = true,
  });

  final TextEditingController controlador;
  final FocusNode foco;
  final VoidCallback onEnviar;
  final bool habilitado;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  bool _hayTexto = false;

  @override
  void initState() {
    super.initState();
    widget.controlador.addListener(_alEscribir);
  }

  @override
  void dispose() {
    widget.controlador.removeListener(_alEscribir);
    super.dispose();
  }

  void _alEscribir() {
    final hay = widget.controlador.text.trim().isNotEmpty;
    if (hay != _hayTexto) setState(() => _hayTexto = hay);
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.habilitado) {
      return Container(
        height: 44,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: Colors.black38,
          borderRadius: BorderRadius.circular(Redondeo.pill),
          border: Border.all(color: AppColor.borde),
        ),
        child: const Text(
          'El vivo terminó',
          style: TextStyle(color: AppColor.textoSuave, fontSize: 13),
        ),
      );
    }

    return Container(
      height: 44,
      padding: const EdgeInsets.only(left: Gap.lg, right: 4),
      decoration: BoxDecoration(
        // Semitransparente: el video sigue viéndose detrás.
        color: Colors.black.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(Redondeo.pill),
        border: Border.all(color: Colors.white24),
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: widget.controlador,
              focusNode: widget.foco,
              maxLength: 200,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => widget.onEnviar(),
              style: const TextStyle(fontSize: 14),
              decoration: const InputDecoration(
                hintText: 'Escribí un comentario…',
                hintStyle: TextStyle(color: AppColor.textoSuave, fontSize: 14),
                border: InputBorder.none,
                isDense: true,
                // El contador de 200 caracteres no aporta nada y roba altura
                // justo donde el espacio es escaso.
                counterText: '',
              ),
            ),
          ),
          // El botón sólo aparece cuando hay algo que mandar: un ícono
          // permanentemente deshabilitado es ruido.
          AnimatedOpacity(
            opacity: _hayTexto ? 1 : 0.35,
            duration: Duraciones.instantanea,
            child: IconButton(
              onPressed: _hayTexto ? widget.onEnviar : null,
              icon: const Icon(Icons.send_rounded, size: 20),
              color: AppColor.acento,
              visualDensity: VisualDensity.compact,
            ),
          ),
        ],
      ),
    );
  }
}
