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
class ChatOverlay extends StatefulWidget {
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
  State<ChatOverlay> createState() => _ChatOverlayState();
}

/// Con estado sólo por el indicador de mensajes nuevos.
///
/// ⚠️ El `ScrollController` NO se usa para desplazar automáticamente. Eso lo
/// sigue resolviendo `reverse: true` sin código, y volver a un `animateTo`
/// sería reintroducir exactamente el bug que se arregló.
///
/// El controlador existe para dos cosas y nada más: saber si la persona subió a
/// leer, y poder bajarla de un toque cuando lo pide.
///
/// ─── Por qué hace falta el indicador ───
///
/// Con la lista invertida, alguien que subió a leer se queda donde está y los
/// mensajes nuevos entran abajo, fuera de su vista. Eso es lo correcto —no se lo
/// arrastra— pero sin ningún aviso la conversación parece haberse detenido, y en
/// un vivo eso es justo cuando el vendedor está contestando algo.
class _ChatOverlayState extends State<ChatOverlay> {
  final _scroll = ScrollController();

  /// Cuántos mensajes entraron desde que la persona subió a leer.
  int _nuevosDesdeQueSubio = 0;

  /// Cuántos había la última vez que estuvo abajo.
  int _vistosAlPieDeLaLista = 0;

  bool _estaArriba = false;

  @override
  void initState() {
    super.initState();
    _vistosAlPieDeLaLista = widget.mensajes.length;
  }

  @override
  void didUpdateWidget(ChatOverlay viejo) {
    super.didUpdateWidget(viejo);

    /**
     * ⚠️ Se compara contra el contador propio, no contra `viejo.mensajes`.
     *
     * La pantalla muta la MISMA lista (`_mensajes.add(...)`), así que acá
     * `viejo.mensajes` y `widget.mensajes` son el mismo objeto y comparar sus
     * longitudes es comparar algo consigo mismo. Es el bug original que
     * congelaba el chat, y volvería a aparecer si el indicador lo repitiera.
     */
    if (!_estaArriba) {
      _vistosAlPieDeLaLista = widget.mensajes.length;
      return;
    }

    final nuevos = widget.mensajes.length - _vistosAlPieDeLaLista;
    if (nuevos != _nuevosDesdeQueSubio) {
      setState(() => _nuevosDesdeQueSubio = nuevos < 0 ? 0 : nuevos);
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  /// En una lista invertida, `pixels` crece al SUBIR. Cero es el último
  /// mensaje.
  ///
  /// El umbral de 60 píxeles evita que un rebote de un dedo torpe cuente como
  /// «se fue a leer».
  bool _lejosDelPie() => _scroll.hasClients && _scroll.position.pixels > 60;

  void _volverAlPie() {
    _scroll.animateTo(0, duration: Duraciones.rapida, curve: Curves.easeOut);
    setState(() {
      _estaArriba = false;
      _nuevosDesdeQueSubio = 0;
      _vistosAlPieDeLaLista = widget.mensajes.length;
    });
  }

  @override
  Widget build(BuildContext context) {
    final mensajes = widget.mensajes;
    if (mensajes.isEmpty) return const SizedBox.shrink();

    return Stack(
      alignment: Alignment.bottomCenter,
      children: [
        NotificationListener<ScrollNotification>(
          onNotification: (_) {
            final arriba = _lejosDelPie();
            if (arriba == _estaArriba) return false;

            setState(() {
              _estaArriba = arriba;
              if (!arriba) {
                _nuevosDesdeQueSubio = 0;
                _vistosAlPieDeLaLista = mensajes.length;
              } else {
                _vistosAlPieDeLaLista = mensajes.length;
              }
            });
            return false;
          },
          child: _lista(mensajes),
        ),

        if (_nuevosDesdeQueSubio > 0)
          Padding(
            padding: const EdgeInsets.only(bottom: Gap.sm),
            child: _BotonNuevos(cuantos: _nuevosDesdeQueSubio, onTap: _volverAlPie),
          ),
      ],
    );
  }

  Widget _lista(List<MensajeDeChat> mensajes) {
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
        controller: _scroll,
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
          final alMantener = widget.onMantenerApretado;
          return _Mensaje(
            mensaje: mensaje,
            onMantenerApretado: alMantener == null ? null : () => alMantener(mensaje),
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

/// «3 mensajes nuevos», flotando sobre el chat.
///
/// ⚠️ Chico y discreto a propósito. Vive encima del video y la mitad de la
/// pantalla es del producto: un cartel grande tapa justo lo que la persona vino
/// a ver.
///
/// Y no aparece nunca mientras se está al pie de la lista, que es el 95 % del
/// tiempo. Sólo cuando alguien subió a leer algo y la conversación siguió sin
/// él.
class _BotonNuevos extends StatelessWidget {
  const _BotonNuevos({required this.cuantos, required this.onTap});

  final int cuantos;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: Gap.xs + 2),
        decoration: BoxDecoration(
          // Cyan: es información —«pasó algo abajo»—, no una acción de compra.
          color: AppColor.info,
          borderRadius: BorderRadius.circular(Redondeo.pill),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.arrow_downward_rounded, size: 14, color: AppColor.sobreCyan),
            const SizedBox(width: Gap.xs + 1),
            Text(
              cuantos == 1 ? '1 mensaje nuevo' : '$cuantos mensajes nuevos',
              style: const TextStyle(
                color: AppColor.sobreCyan,
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
