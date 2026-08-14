import 'package:flutter/material.dart';

import '../../../../core/design/tokens.dart';
import '../../data/live_realtime.dart';

/// El chat del vivo, como capa encima del video.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// NO ES UN PANEL DE CHAT
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Ocupa una franja angosta, sin fondo propio, y **no tapa el producto**. Un
/// panel de chat que ocupa media pantalla convierte un vivo de compras en una
/// sala de mensajes: el producto —que es lo que se está vendiendo— queda de
/// costado.
///
/// Los mensajes suben y se van. Los de arriba se desvanecen para que la
/// transición no sea un corte seco, y porque un texto a medio salir de pantalla
/// se lee peor que uno que se está yendo.
///
/// ─── Sin scroll hacia arriba, a propósito ───
///
/// No se puede subir a leer lo que pasó. Es deliberado: en un vivo el chat es
/// presente puro, y una lista con historial invita a leer hacia atrás
/// exactamente cuando hay que estar mirando lo que el vendedor muestra ahora.
class ChatOverlay extends StatefulWidget {
  const ChatOverlay({super.key, required this.mensajes});

  final List<MensajeDeChat> mensajes;

  @override
  State<ChatOverlay> createState() => _ChatOverlayState();
}

class _ChatOverlayState extends State<ChatOverlay> {
  final _scroll = ScrollController();

  @override
  void didUpdateWidget(ChatOverlay viejo) {
    super.didUpdateWidget(viejo);

    if (widget.mensajes.length != viejo.mensajes.length) {
      /**
       * Se baja al final después de que el cuadro se dibujó.
       *
       * Hacerlo dentro de `didUpdateWidget` a secas mueve el scroll con la
       * lista todavía en su tamaño anterior, y el mensaje nuevo queda medio
       * cortado abajo.
       */
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_scroll.hasClients) return;
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: Duraciones.rapida,
          curve: Curves.easeOut,
        );
      });
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.mensajes.isEmpty) return const SizedBox.shrink();

    return ShaderMask(
      // Desvanece los mensajes de arriba. Sin esto, el que sale queda cortado
      // por la mitad y se lee peor que uno que se está yendo.
      shaderCallback: (rect) => const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [Colors.transparent, Colors.black, Colors.black],
        stops: [0, 0.25, 1],
      ).createShader(rect),
      blendMode: BlendMode.dstIn,
      child: ListView.builder(
        controller: _scroll,
        // El chat no compite por el gesto de deslizar entre vivos.
        physics: const NeverScrollableScrollPhysics(),
        padding: EdgeInsets.zero,
        itemCount: widget.mensajes.length,
        itemBuilder: (_, i) => _Mensaje(mensaje: widget.mensajes[i]),
      ),
    );
  }
}

class _Mensaje extends StatelessWidget {
  const _Mensaje({required this.mensaje});
  final MensajeDeChat mensaje;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: RichText(
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        text: TextSpan(
          style: const TextStyle(
            fontSize: 13.5,
            height: 1.25,
            // Sombra en vez de fondo: un fondo sólido taparía el video, que es
            // lo que la gente vino a ver.
            shadows: [Shadow(color: Colors.black, blurRadius: 6)],
          ),
          children: [
            TextSpan(
              text: '${mensaje.nombre} ',
              style: TextStyle(
                fontWeight: FontWeight.w700,
                // El vendedor se distingue por color Y por la etiqueta de
                // abajo: el color solo no le llega a todo el mundo.
                color: mensaje.esVendedor ? AppColor.acento : AppColor.textoSuave,
              ),
            ),
            if (mensaje.esVendedor)
              const TextSpan(
                text: '· vendedor ',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: AppColor.acento,
                ),
              ),
            TextSpan(
              text: mensaje.texto,
              style: const TextStyle(color: AppColor.texto),
            ),
          ],
        ),
      ),
    );
  }
}
