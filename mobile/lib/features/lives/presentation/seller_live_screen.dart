import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../auth/state/auth_providers.dart';
import '../data/broadcaster_api.dart';
import '../data/broadcaster_room.dart';
import '../data/live_realtime.dart';
import '../domain/broadcaster_models.dart';
import 'widgets/chat_overlay.dart';
import 'widgets/composer.dart';

/// La pantalla de quien transmite.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// NO ES UN TABLERO DE CONTROL
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Quien está acá está hablando frente a una cámara, sosteniendo un producto
/// con la otra mano. Cada control que se agrega es atención que se le saca a
/// eso.
///
/// Por eso hay exactamente lo necesario para **vender mientras habla**: qué
/// producto está mostrando, qué le están preguntando, cuánta gente hay, y un
/// gesto para cambiar de producto. Las métricas finas van en el resumen, al
/// terminar, cuando hay tiempo de mirarlas.
///
/// ─── La sala viene de afuera ───
///
/// La conexión se abrió en la pantalla de preparación y se pasa entera. Si se
/// creara acá, ir de la vista previa a esta pantalla cortaría el video justo
/// cuando el vendedor acaba de decir "¡arrancamos!".
class SellerLiveScreen extends ConsumerStatefulWidget {
  const SellerLiveScreen({super.key, required this.liveId, required this.sala});

  final String liveId;
  final BroadcasterRoom sala;

  @override
  ConsumerState<SellerLiveScreen> createState() => _SellerLiveScreenState();
}

class _SellerLiveScreenState extends ConsumerState<SellerLiveScreen> {
  PanelDelVivo? _panel;
  Timer? _refresco;
  Timer? _reloj;
  int _segundos = 0;

  LiveRealtime? _realtime;
  final List<MensajeDeChat> _mensajes = [];
  final List<StreamSubscription<dynamic>> _suscripciones = [];

  final _composer = TextEditingController();
  final _foco = FocusNode();

  bool _terminando = false;
  bool _bandejaAbierta = false;

  /// El estado que ya le informamos al backend, para no repetir la llamada.
  EstadoDeTransmision? _ultimoEstadoInformado;

  @override
  void initState() {
    super.initState();

    // La pantalla no se puede apagar en mitad de una transmisión.
    unawaited(WakelockPlus.enable());

    widget.sala.addListener(_alCambiarLaSala);
    unawaited(_cargarPanel());
    unawaited(_conectarChat());

    // El panel se refresca cada 5 s: espectadores y ventas cambian solos.
    _refresco = Timer.periodic(const Duration(seconds: 5), (_) => unawaited(_cargarPanel()));

    // El reloj corre local para que el contador no salte de 5 en 5.
    _reloj = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _segundos += 1);
    });
  }

  @override
  void dispose() {
    unawaited(WakelockPlus.disable());
    _refresco?.cancel();
    _reloj?.cancel();
    widget.sala.removeListener(_alCambiarLaSala);
    for (final s in _suscripciones) {
      unawaited(s.cancel());
    }
    _realtime?.dispose();
    _composer.dispose();
    _foco.dispose();
    widget.sala.dispose();
    super.dispose();
  }

  /// El estado del video del teléfono se refleja en el backend.
  ///
  /// Es lo que hace que quien mira vea "el vendedor está recuperando la
  /// conexión" en vez de una imagen congelada sin explicación. Se manda una
  /// sola vez por cambio: reportar en cada notificación del controlador serían
  /// decenas de llamadas por corte.
  void _alCambiarLaSala() {
    if (!mounted) return;
    setState(() {});

    final estado = widget.sala.estado;
    if (estado == _ultimoEstadoInformado) return;
    _ultimoEstadoInformado = estado;

    if (estado == EstadoDeTransmision.alAire) {
      unawaited(ref.read(broadcasterApiProvider).reanudar(widget.liveId).catchError((_) {}));
    }
  }

  Future<void> _cargarPanel() async {
    try {
      final panel = await ref.read(broadcasterApiProvider).panel(widget.liveId);
      if (!mounted) return;
      setState(() {
        _panel = panel;
        // El reloj se sincroniza con el servidor, que es el que sabe cuándo
        // arrancó de verdad.
        _segundos = panel.duracionSegundos;
      });
    } catch (_) {
      // Un refresco que falla no puede cortar la transmisión. El siguiente
      // vuelve a intentar.
    }
  }

  Future<void> _conectarChat() async {
    final token = await ref.read(tokenStoreProvider).accessToken();
    if (token == null || !mounted) return;

    final rt = LiveRealtime(token: token);
    rt.conectar();
    rt.entrarA(widget.liveId);

    _suscripciones.add(
      rt.chat.listen((m) {
        if (!mounted) return;
        setState(() {
          _mensajes.add(m);
          if (_mensajes.length > 50) _mensajes.removeAt(0);
        });
      }),
    );

    _realtime = rt;
  }

  void _enviar() {
    final texto = _composer.text.trim();
    if (texto.isEmpty) return;
    _realtime?.enviarMensaje(texto);
    _composer.clear();
  }

  Future<void> _destacar(ProductoEnBandeja producto) async {
    final variante = producto.variantePorDefecto;
    if (variante == null) return;

    setState(() => _bandejaAbierta = false);

    try {
      await ref.read(broadcasterApiProvider).destacar(widget.liveId, variante.id);
      await _cargarPanel();
      if (mounted) AppSnack.exito(context, 'Mostrando ${producto.nombre}');
    } catch (_) {
      if (mounted) {
        AppSnack.error(context, 'No pudimos destacarlo. ¿Sigue publicado?');
      }
    }
  }

  /// Terminar pide confirmación, siempre.
  ///
  /// Un toque accidental en el borde de la pantalla no puede cortar una
  /// transmisión con gente comprando. Es la única acción de esta pantalla que
  /// pregunta.
  Future<void> _terminar() async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColor.superficie,
        title: const Text('¿Terminar el vivo?'),
        content: const Text(
          'Se corta la transmisión para todos. Tu tienda sigue abierta y van a '
          'poder seguir comprando.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Seguir transmitiendo'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: FilledButton.styleFrom(backgroundColor: AppColor.error),
            child: const Text('Terminar'),
          ),
        ],
      ),
    );

    if (confirmado != true || !mounted) return;

    setState(() => _terminando = true);

    try {
      final resumen = await ref.read(broadcasterApiProvider).terminar(widget.liveId);
      await widget.sala.cortar();
      if (!mounted) return;

      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) => _ResumenFinal(resumen: resumen),
      );

      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (mounted) {
        setState(() => _terminando = false);
        AppSnack.error(context, 'No pudimos terminar el vivo. Probá de nuevo.');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final panel = _panel;
    final video = widget.sala.video;
    final teclado = MediaQuery.viewInsetsOf(context).bottom;
    final tecladoAbierto = teclado > 0;
    final abajo = MediaQuery.paddingOf(context).bottom;

    return PopScope(
      // Volver atrás no puede cortar la transmisión sin preguntar.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && !_terminando) unawaited(_terminar());
      },
      child: Scaffold(
        backgroundColor: Colors.black,
        resizeToAvoidBottomInset: false,
        body: Stack(
          fit: StackFit.expand,
          children: [
            if (video != null)
              VideoTrackRenderer(video, fit: VideoViewFit.cover)
            else
              const ColoredBox(color: Color(0xFF0B0B0D)),

            const IgnorePointer(
              child: DecoratedBox(decoration: BoxDecoration(gradient: AppColor.velo)),
            ),

            if (widget.sala.estado == EstadoDeTransmision.reconectando) const _Reconectando(),

            SafeArea(
              child: Column(
                children: [
                  _Encabezado(
                    segundos: _segundos,
                    espectadores: panel?.espectadores ?? 0,
                    ventas: panel?.ventas,
                    onTerminar: _terminando ? null : _terminar,
                  ),
                  const Spacer(),

                  // ─── Chat ───
                  if (_mensajes.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(Gap.md, 0, 84, Gap.sm),
                      child: SizedBox(
                        height: tecladoAbierto ? 110 : 150,
                        child: ChatOverlay(mensajes: _mensajes),
                      ),
                    ),

                  // ─── Lo que se está mostrando ───
                  if (panel != null && !tecladoAbierto)
                    _DestacadoAhora(
                      panel: panel,
                      onCambiar: () => setState(() => _bandejaAbierta = true),
                    ),

                  // ─── Escribir ───
                  Padding(
                    padding: EdgeInsets.fromLTRB(
                      Gap.md,
                      Gap.sm,
                      Gap.md,
                      tecladoAbierto ? teclado + Gap.sm : abajo + Gap.sm,
                    ),
                    child: Composer(
                      controlador: _composer,
                      foco: _foco,
                      onEnviar: _enviar,
                    ),
                  ),
                ],
              ),
            ),

            // ─── Controles laterales ───
            if (!tecladoAbierto)
              Positioned(
                right: Gap.sm,
                bottom: abajo + 210,
                child: _ControlesLaterales(
                  sala: widget.sala,
                  productos: panel?.bandeja.length ?? 0,
                  onBandeja: () => setState(() => _bandejaAbierta = true),
                ),
              ),

            if (_bandejaAbierta && panel != null)
              _Bandeja(
                panel: panel,
                onElegir: _destacar,
                onCerrar: () => setState(() => _bandejaAbierta = false),
              ),
          ],
        ),
      ),
    );
  }
}

class _Encabezado extends StatelessWidget {
  const _Encabezado({
    required this.segundos,
    required this.espectadores,
    required this.ventas,
    required this.onTerminar,
  });

  final int segundos;
  final int espectadores;
  final VentasDelVivo? ventas;
  final VoidCallback? onTerminar;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(Gap.md, Gap.sm, Gap.sm, 0),
      child: Row(
        children: [
          const _Chip(color: AppColor.vivo, texto: 'EN VIVO'),
          const SizedBox(width: Gap.sm),
          _Chip(color: Colors.black54, texto: comoDuracion(segundos)),
          const SizedBox(width: Gap.sm),
          _Chip(
            color: Colors.black54,
            texto: '$espectadores',
            icono: Icons.visibility_rounded,
          ),
          if (ventas != null && ventas!.hubo) ...[
            const SizedBox(width: Gap.sm),
            // Sólo órdenes confirmadas: mostrar pendientes daría un número que
            // después baja, y eso se lee como que algo se rompió.
            _Chip(
              color: AppColor.exito,
              texto: '${ventas!.ordenes}',
              icono: Icons.shopping_bag_rounded,
            ),
          ],
          const Spacer(),
          TextButton(
            onPressed: onTerminar,
            style: TextButton.styleFrom(
              backgroundColor: Colors.black45,
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: 6),
            ),
            child: const Text('Terminar', style: TextStyle(fontWeight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.color, required this.texto, this.icono});

  final Color color;
  final String texto;
  final IconData? icono;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(20)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icono != null) ...[
            Icon(icono, size: 13, color: Colors.white),
            const SizedBox(width: 4),
          ],
          Text(
            texto,
            style: const TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.3,
              color: Colors.white,
              fontFeatures: [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}

/// Qué producto están viendo ahora los compradores.
class _DestacadoAhora extends StatelessWidget {
  const _DestacadoAhora({required this.panel, required this.onCambiar});

  final PanelDelVivo panel;
  final VoidCallback onCambiar;

  @override
  Widget build(BuildContext context) {
    final destacado = panel.bandeja
        .where((p) => p.variantes.any((v) => v.id == panel.destacadoVariantId))
        .firstOrNull;

    return Padding(
      padding: const EdgeInsets.fromLTRB(Gap.md, 0, Gap.md, 0),
      child: GestureDetector(
        onTap: onCambiar,
        child: Container(
          padding: const EdgeInsets.all(Gap.sm),
          decoration: BoxDecoration(
            color: Colors.black.withValues(alpha: 0.62),
            borderRadius: BorderRadius.circular(Redondeo.md),
            border: Border.all(
              color: destacado == null ? AppColor.alerta : AppColor.acento,
            ),
          ),
          child: Row(
            children: [
              Icon(
                destacado == null ? Icons.add_circle_outline_rounded : Icons.sell_rounded,
                size: 18,
                color: destacado == null ? AppColor.alerta : AppColor.acento,
              ),
              const SizedBox(width: Gap.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      destacado == null ? 'No estás mostrando nada' : 'Mostrando ahora',
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.4,
                        color: destacado == null ? AppColor.alerta : AppColor.acento,
                      ),
                    ),
                    Text(
                      destacado?.nombre ?? 'Tocá para elegir un producto',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.swap_horiz_rounded, color: AppColor.textoSuave),
            ],
          ),
        ),
      ),
    );
  }
}

class _ControlesLaterales extends StatelessWidget {
  const _ControlesLaterales({
    required this.sala,
    required this.productos,
    required this.onBandeja,
  });

  final BroadcasterRoom sala;
  final int productos;
  final VoidCallback onBandeja;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _BotonLateral(
          icono: Icons.sell_rounded,
          etiqueta: 'Productos',
          insignia: productos > 0 ? '$productos' : null,
          destacado: true,
          onTap: onBandeja,
        ),
        _BotonLateral(
          icono: Icons.cameraswitch_rounded,
          etiqueta: 'Cámara',
          onTap: () => unawaited(sala.darVueltaCamara()),
        ),
        _BotonLateral(
          icono: sala.micApagado ? Icons.mic_off_rounded : Icons.mic_rounded,
          etiqueta: sala.micApagado ? 'Sin audio' : 'Micrófono',
          alerta: sala.micApagado,
          onTap: () => unawaited(sala.alternarMicrofono()),
        ),
      ],
    );
  }
}

class _BotonLateral extends StatelessWidget {
  const _BotonLateral({
    required this.icono,
    required this.etiqueta,
    required this.onTap,
    this.insignia,
    this.destacado = false,
    this.alerta = false,
  });

  final IconData icono;
  final String etiqueta;
  final VoidCallback onTap;
  final String? insignia;
  final bool destacado;
  final bool alerta;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.lg),
      child: Semantics(
        button: true,
        label: etiqueta,
        child: GestureDetector(
          onTap: onTap,
          behavior: HitTestBehavior.opaque,
          child: Column(
            children: [
              Stack(
                clipBehavior: Clip.none,
                children: [
                  Container(
                    width: 46,
                    height: 46,
                    decoration: BoxDecoration(
                      color: alerta
                          ? AppColor.alerta
                          : destacado
                              ? AppColor.acento
                              : Colors.black38,
                      shape: BoxShape.circle,
                      border: destacado || alerta ? null : Border.all(color: Colors.white24),
                    ),
                    child: Icon(icono, size: 22, color: Colors.white),
                  ),
                  if (insignia != null)
                    Positioned(
                      right: -2,
                      top: -2,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                        decoration: BoxDecoration(
                          color: AppColor.superficieAlta,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: Colors.white24),
                        ),
                        child: Text(
                          insignia!,
                          style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                etiqueta,
                style: const TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w600,
                  shadows: [Shadow(color: Colors.black87, blurRadius: 6)],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// La bandeja: un toque para cambiar de producto.
class _Bandeja extends StatelessWidget {
  const _Bandeja({required this.panel, required this.onElegir, required this.onCerrar});

  final PanelDelVivo panel;
  final void Function(ProductoEnBandeja) onElegir;
  final VoidCallback onCerrar;

  @override
  Widget build(BuildContext context) {
    return Positioned.fill(
      child: GestureDetector(
        onTap: onCerrar,
        child: ColoredBox(
          color: Colors.black54,
          child: Align(
            alignment: Alignment.bottomCenter,
            child: GestureDetector(
              onTap: () {},
              child: Container(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * 0.55,
                ),
                decoration: const BoxDecoration(
                  color: AppColor.superficie,
                  borderRadius: BorderRadius.vertical(top: Radius.circular(Redondeo.xl)),
                ),
                child: SafeArea(
                  top: false,
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
                      const Padding(
                        padding: EdgeInsets.fromLTRB(Gap.lg, Gap.md, Gap.lg, Gap.sm),
                        child: Row(
                          children: [
                            Text(
                              'Tocá para mostrar',
                              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                            ),
                          ],
                        ),
                      ),
                      Flexible(
                        child: ListView.builder(
                          shrinkWrap: true,
                          padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.lg),
                          itemCount: panel.bandeja.length,
                          itemBuilder: (_, i) {
                            final p = panel.bandeja[i];
                            final activo = p.variantes.any((v) => v.id == panel.destacadoVariantId);
                            return _FilaBandeja(
                              producto: p,
                              activo: activo,
                              onTap: p.vendible ? () => onElegir(p) : null,
                            );
                          },
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FilaBandeja extends StatelessWidget {
  const _FilaBandeja({required this.producto, required this.activo, required this.onTap});

  final ProductoEnBandeja producto;
  final bool activo;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final apagado = onTap == null;

    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.sm),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Redondeo.md),
        child: Container(
          padding: const EdgeInsets.all(Gap.sm),
          decoration: BoxDecoration(
            color: activo ? AppColor.acento.withValues(alpha: 0.14) : AppColor.superficieAlta,
            borderRadius: BorderRadius.circular(Redondeo.md),
            border: Border.all(color: activo ? AppColor.acento : AppColor.borde),
          ),
          child: Row(
            children: [
              Opacity(
                opacity: apagado ? 0.4 : 1,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(Redondeo.sm),
                  child: SizedBox(
                    width: 48,
                    height: 48,
                    child: producto.imagenUrl == null
                        ? const ColoredBox(
                            color: AppColor.superficie,
                            child: Icon(Icons.image_rounded, size: 18, color: AppColor.textoDebil),
                          )
                        : CachedNetworkImage(
                            imageUrl: producto.imagenUrl!,
                            fit: BoxFit.cover,
                            errorWidget: (_, __, ___) => const ColoredBox(
                              color: AppColor.superficie,
                              child:
                                  Icon(Icons.image_rounded, size: 18, color: AppColor.textoDebil),
                            ),
                          ),
                  ),
                ),
              ),
              const SizedBox(width: Gap.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      producto.nombre,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: apagado ? AppColor.textoDebil : AppColor.texto,
                      ),
                    ),
                    const SizedBox(height: 1),
                    Text(
                      apagado
                          ? 'Pausado: no se puede mostrar'
                          : producto.agotado
                              ? 'Sin stock'
                              : 'Quedan ${producto.disponibleTotal}',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: apagado
                            ? AppColor.textoDebil
                            : producto.agotado
                                ? AppColor.error
                                : AppColor.textoSuave,
                      ),
                    ),
                  ],
                ),
              ),
              if (activo)
                const Padding(
                  padding: EdgeInsets.only(left: Gap.sm),
                  child: Text(
                    'EN PANTALLA',
                    style: TextStyle(
                      fontSize: 9.5,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.4,
                      color: AppColor.acento,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Reconectando extends StatelessWidget {
  const _Reconectando();

  @override
  Widget build(BuildContext context) {
    return Positioned.fill(
      child: ColoredBox(
        color: Colors.black.withValues(alpha: 0.55),
        child: const Center(
          child: Padding(
            padding: EdgeInsets.all(Gap.xl),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: 26,
                  height: 26,
                  child: CircularProgressIndicator(strokeWidth: 2.5, color: AppColor.alerta),
                ),
                SizedBox(height: Gap.lg),
                Text(
                  'Reconectando…',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                ),
                SizedBox(height: Gap.xs),
                Text(
                  // Lo más importante de este cartel: que no cierre la app.
                  // Cerrarla es lo que convierte un corte de treinta segundos
                  // en una transmisión perdida.
                  'No cierres VendoX. Tu vivo sigue abierto y la gente sigue ahí.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13.5, color: AppColor.textoSuave, height: 1.45),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Lo que pasó durante el vivo. Sólo números que existen.
class _ResumenFinal extends StatelessWidget {
  const _ResumenFinal({required this.resumen});
  final ResumenDelVivo resumen;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColor.superficie,
      title: const Text('Terminó tu vivo'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (resumen.duracionSegundos != null)
            _Linea(que: 'Duración', valor: comoDuracion(resumen.duracionSegundos!)),
          // `null` es "no se midió" y se omite. La regla es no inventar
          // métricas: un cero acá diría que no miró nadie, que es distinto.
          if (resumen.espectadoresPico != null)
            _Linea(que: 'Pico de espectadores', valor: '${resumen.espectadoresPico}'),
          _Linea(que: 'Ventas', valor: '${resumen.ordenes}'),
          if (resumen.huboVentas) ...[
            _Linea(que: 'Unidades', valor: '${resumen.unidades}'),
            _Linea(que: 'Total', valor: _plata(resumen.brutoCentavos)),
          ],
          const SizedBox(height: Gap.md),
          const Text(
            'Tu tienda sigue abierta: pueden seguir comprando lo que mostraste.',
            style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave, height: 1.4),
          ),
        ],
      ),
      actions: [
        FilledButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Listo'),
        ),
      ],
    );
  }
}

class _Linea extends StatelessWidget {
  const _Linea({required this.que, required this.valor});
  final String que;
  final String valor;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(que, style: const TextStyle(fontSize: 14, color: AppColor.textoSuave)),
          Text(
            valor,
            style: const TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w700,
              fontFeatures: [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}

String _plata(int centavos) {
  final entero = centavos ~/ 100;
  final dec = (centavos % 100).toString().padLeft(2, '0');
  final miles = entero.toString().replaceAllMapped(
        RegExp(r'(\d)(?=(\d{3})+$)'),
        (m) => '${m[1]}.',
      );
  return '\$ $miles,$dec';
}
