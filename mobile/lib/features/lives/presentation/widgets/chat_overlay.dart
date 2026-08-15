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
/// El alto lo decide `layout_del_vivo.dart` y es un tope recortado por el
/// espacio libre. Esta lista **nunca crece**: vive dentro de esa caja, y los
/// mensajes viejos salen por arriba.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ LA LISTA VA INVERTIDA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El defecto que esto arregla, encontrado en un teléfono real: los mensajes se
/// apilaban hacia abajo y, al pasar del alto disponible, **los nuevos dejaban
/// de verse**. El chat se congelaba en los primeros cinco mensajes.
///
/// La causa no estaba en el scroll sino en cómo se detectaba el mensaje nuevo.
/// La pantalla muta la misma lista (`_mensajes.add(...)`), así que en
/// `didUpdateWidget` la lista vieja y la nueva **son el mismo objeto**:
///
///     widget.mensajes.length != viejo.mensajes.length   // siempre false
///
/// El auto-scroll no corría nunca. Comparar longitudes de una lista mutada en
/// el lugar es comparar algo consigo mismo.
///
/// Se podía arreglar guardando la longitud anterior en el estado, pero eso deja
/// el comportamiento correcto dependiendo de que alguien se acuerde de
/// mantenerlo. Con `reverse: true` el problema desaparece de raíz:
///
///   · el desplazamiento 0 es **abajo**, y ahí es donde nace cada mensaje;
///   · un mensaje nuevo empuja los viejos hacia arriba sin tocar el scroll;
///   · al pasarse del alto, los viejos salen por arriba solos;
///   · en reposo la vista ya está pegada al último: no hay que seguir nada.
///
/// No hay `ScrollController`, no hay `animateTo`, no hay estado que sincronizar.
///
/// ─── Y si alguien sube a leer ───
///
/// Con la lista invertida eso también sale gratis. Los mensajes nuevos se
/// agregan en el extremo donde está el desplazamiento 0; si la persona subió,
/// su posición no se mueve y **no se la arrastra** de vuelta abajo. Cuando
/// suelta y vuelve al fondo, sigue el hilo otra vez.
class ChatOverlay extends StatelessWidget {
  const ChatOverlay({super.key, required this.mensajes, this.onMantenerApretado});

  final List<MensajeDeChat> mensajes;

  /// Mantener apretado un mensaje abre reportar / borrar / silenciar.
  ///
  /// ─── Por qué toque LARGO y no un botón ───
  ///
  /// El chat vive encima del video, en una franja angosta. Un ícono por mensaje
  /// se come el ancho, tapa la imagen y se toca sin querer mientras se
  /// desplaza. El toque largo es el gesto que la gente ya conoce de cualquier
  /// app de mensajería.
  ///
  /// `null` cuando no hay sesión: sin cuenta no se reporta ni se modera.
  final void Function(MensajeDeChat)? onMantenerApretado;

  @override
  Widget build(BuildContext context) {
    if (mensajes.isEmpty) return const SizedBox.shrink();

    return ShaderMask(
      // Desvanece los mensajes que se están yendo por arriba. Sin esto, el que
      // sale queda cortado por la mitad y se lee peor que uno que se desvanece.
      shaderCallback: (rect) => const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [Colors.transparent, Colors.black, Colors.black],
        stops: [0, 0.28, 1],
      ).createShader(rect),
      blendMode: BlendMode.dstIn,
      child: ListView.builder(
        // ⚠️ La línea que sostiene todo el comportamiento. Ver la nota de arriba.
        reverse: true,
        padding: EdgeInsets.zero,
        // Rebote y nada más: sin `alwaysScrollable`, con pocos mensajes la lista
        // no se puede arrastrar y el gesto queda libre para lo que haya debajo.
        physics: const ClampingScrollPhysics(),
        itemCount: mensajes.length,
        itemBuilder: (_, i) {
          // Invertido: el índice 0 es el último mensaje, y va abajo de todo.
          final mensaje = mensajes[mensajes.length - 1 - i];
          return _Mensaje(
            mensaje: mensaje,
            onMantenerApretado:
                onMantenerApretado == null ? null : () => onMantenerApretado!(mensaje),
          );
        },
      ),
    );
  }
}

class _Mensaje extends StatelessWidget {
  const _Mensaje({required this.mensaje, this.onMantenerApretado});
  final MensajeDeChat mensaje;
  final VoidCallback? onMantenerApretado;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 5),
      child: GestureDetector(
        onLongPress: onMantenerApretado,
        // `translucent` y no `opaque`: el gesto se toma sobre el recuadro del
        // mensaje sin robarle el desplazamiento a la lista.
        behavior: HitTestBehavior.translucent,
        child: Align(
          // El recuadro se ajusta al texto en vez de ocupar el ancho entero.
          //
          // `Align` afloja las restricciones, así que el `Container` mide lo que
          // mide el párrafo: un "sí" queda en una pastilla chiquita y un mensaje
          // largo ocupa el ancho disponible y envuelve. Un rectángulo de ancho
          // fijo por mensaje sería la "caja grande" que no queremos sobre el
          // video.
          alignment: Alignment.centerLeft,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2.5),
            decoration: BoxDecoration(
              // Muy tenue: alcanza para despegar el texto de un fondo claro sin
              // tapar el video. Sobre fondo oscuro casi no se nota.
              color: Colors.black.withValues(alpha: 0.32),
              borderRadius: BorderRadius.circular(7),
            ),
            child: RichText(
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              text: TextSpan(
                style: const TextStyle(
                  fontSize: 13.5,
                  height: 1.25,
                  // La sombra se queda además del fondo: juntos resuelven el caso
                  // peor, que es una pared blanca detrás del vendedor.
                  shadows: [Shadow(color: Colors.black87, blurRadius: 4)],
                ),
                children: [
                  TextSpan(
                    text: '${mensaje.nombre} ',
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      // El vendedor se distingue por color Y por la etiqueta de
                      // al lado: el color solo no le llega a todo el mundo.
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
          ),
        ),
      ),
    );
  }
}
