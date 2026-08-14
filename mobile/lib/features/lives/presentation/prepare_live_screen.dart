import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../seller/data/seller_repository.dart';
import '../data/broadcaster_api.dart';
import '../data/broadcaster_room.dart';
import 'seller_live_screen.dart';

/// Preparar la transmisión antes de que la vea nadie.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// TOCAR "INICIAR LIVE" NO PUEDE ENCENDER LA CÁMARA EN PÚBLICO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Quien transmite necesita ver su encuadre, elegir los productos y probar el
/// micrófono antes de que alguien lo vea. Un vendedor que aparece en pantalla
/// acomodándose el pelo con veinte personas mirando no vuelve a transmitir.
///
/// Acá la cámara está encendida **localmente**: la sala de LiveKit ya existe,
/// pero mientras nadie publique no hay nada que ver. Salir al aire es un botón
/// más abajo, y es instantáneo porque ya está todo conectado.
class PrepareLiveScreen extends ConsumerStatefulWidget {
  const PrepareLiveScreen({super.key});

  @override
  ConsumerState<PrepareLiveScreen> createState() => _PrepareLiveScreenState();
}

class _PrepareLiveScreenState extends ConsumerState<PrepareLiveScreen> {
  final _titulo = TextEditingController();
  final _sala = BroadcasterRoom();

  /// Los productos elegidos, EN ORDEN. La posición importa: es el orden de la
  /// bandeja durante el vivo.
  final List<String> _elegidos = [];

  bool _preparando = false;
  bool _saliendo = false;

  @override
  void initState() {
    super.initState();
    _sala.addListener(_alCambiarLaSala);
    unawaited(_arrancarCamara());
  }

  @override
  void dispose() {
    _sala.removeListener(_alCambiarLaSala);
    _titulo.dispose();
    // ⚠️ La sala NO se libera acá si ya salimos al aire: la pantalla del vivo
    // se queda con ella. Ver `_salirAlAire`.
    if (!_saliendo) _sala.dispose();
    super.dispose();
  }

  void _alCambiarLaSala() {
    if (mounted) setState(() {});
  }

  Future<void> _arrancarCamara() async {
    if (!await _sala.pedirPermisos()) return;
    await _sala.abrirPreview();
  }

  /// Prepara en el backend y sale al aire, en un solo gesto para el vendedor.
  ///
  /// Son dos llamadas porque son dos cosas distintas —crear la sesión y
  /// publicar— pero para quien transmite es un botón: ya vio su encuadre y ya
  /// eligió sus productos, no hay nada más que confirmar.
  Future<void> _salirAlAire() async {
    final titulo = _titulo.text.trim();
    if (titulo.length < 3) {
      AppSnack.info(context, 'Poné un título para que sepan de qué se trata.');
      return;
    }

    setState(() => _preparando = true);

    try {
      final api = ref.read(broadcasterApiProvider);
      final vivo = await api.preparar(titulo: titulo, productIds: _elegidos);

      if (!vivo.puedeConectar) {
        if (mounted) AppSnack.error(context, 'No pudimos preparar la transmisión.');
        return;
      }

      // La bandeja se guarda aparte: `preparar` es idempotente y devuelve el
      // vivo que ya existía si había uno, con SU bandeja vieja.
      if (_elegidos.isNotEmpty) {
        await api.guardarBandeja(vivo.id, _elegidos);
      }

      final conectado = await _sala.conectar(wsUrl: vivo.wsUrl, token: vivo.token);
      if (!conectado) {
        if (mounted) AppSnack.error(context, _sala.error ?? 'No pudimos conectar.');
        return;
      }

      await api.iniciar(vivo.id);
      final publicando = await _sala.salirAlAire();
      if (!publicando) {
        if (mounted) AppSnack.error(context, _sala.error ?? 'No pudimos publicar tu cámara.');
        return;
      }

      if (!mounted) return;

      // La sala pasa a ser de la pantalla del vivo. Sin esto, `dispose` de
      // acá cortaría la transmisión que se acaba de encender.
      _saliendo = true;

      await Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => SellerLiveScreen(liveId: vivo.id, sala: _sala),
        ),
      );
    } catch (e) {
      if (mounted) AppSnack.error(context, 'No pudimos iniciar la transmisión.');
    } finally {
      if (mounted) setState(() => _preparando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final productos = ref.watch(misProductosProvider);

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: const Text('Preparar tu vivo'),
      ),
      extendBodyBehindAppBar: true,
      body: Stack(
        fit: StackFit.expand,
        children: [
          _VistaPrevia(sala: _sala, onReintentar: _arrancarCamara),

          // Velo para que los controles se lean sobre cualquier encuadre.
          const IgnorePointer(
            child: DecoratedBox(decoration: BoxDecoration(gradient: AppColor.velo)),
          ),

          SafeArea(
            child: Column(
              children: [
                const Spacer(),
                _ControlesDeCamara(sala: _sala),
                const SizedBox(height: Gap.md),
                Expanded(
                  flex: 3,
                  child: Container(
                    decoration: const BoxDecoration(
                      color: Color(0xF2000000),
                      borderRadius: BorderRadius.vertical(top: Radius.circular(Redondeo.xl)),
                    ),
                    child: ListView(
                      padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, Gap.lg),
                      children: [
                        TextField(
                          controller: _titulo,
                          maxLength: 120,
                          textCapitalization: TextCapitalization.sentences,
                          decoration: const InputDecoration(
                            labelText: '¿De qué se trata?',
                            hintText: 'Camperas de lana · liquidación',
                            counterText: '',
                          ),
                          onChanged: (_) => setState(() {}),
                        ),
                        const SizedBox(height: Gap.lg),

                        Row(
                          children: [
                            const Text(
                              'Productos del vivo',
                              style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700),
                            ),
                            const Spacer(),
                            Text(
                              _elegidos.isEmpty ? 'ninguno' : '${_elegidos.length} elegidos',
                              style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                            ),
                          ],
                        ),
                        const SizedBox(height: Gap.xs),
                        const Text(
                          'Los vas a poder destacar de un toque mientras hablás. '
                          'Buscar en el catálogo entero con la cámara encendida es imposible.',
                          style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave, height: 1.4),
                        ),
                        const SizedBox(height: Gap.md),

                        productos.when(
                          loading: () => const Center(child: CircularProgressIndicator()),
                          error: (_, __) => const Text(
                            'No pudimos cargar tus productos.',
                            style: TextStyle(color: AppColor.textoSuave),
                          ),
                          data: (lista) {
                            final vendibles = lista.items.where((p) => p.publicado).toList();
                            if (vendibles.isEmpty) return const _SinProductos();

                            return Column(
                              children: [
                                for (final p in vendibles)
                                  _FilaDeProducto(
                                    nombre: p.name,
                                    imagenUrl: p.portada,
                                    orden: _elegidos.indexOf(p.id),
                                    onTap: () => setState(() {
                                      if (_elegidos.contains(p.id)) {
                                        _elegidos.remove(p.id);
                                      } else {
                                        _elegidos.add(p.id);
                                      }
                                    }),
                                  ),
                              ],
                            );
                          },
                        ),

                        const SizedBox(height: Gap.xl),
                        SizedBox(
                          width: double.infinity,
                          child: FilledButton(
                            onPressed: _preparando || !_sala.hayPreview
                                ? null
                                : () => unawaited(_salirAlAire()),
                            style: FilledButton.styleFrom(minimumSize: const Size(0, 54)),
                            child: _preparando
                                ? const SizedBox(
                                    width: 22,
                                    height: 22,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      color: Colors.white,
                                    ),
                                  )
                                : const Text(
                                    'Iniciar en vivo',
                                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                                  ),
                          ),
                        ),
                        const SizedBox(height: Gap.sm),
                        Text(
                          _sala.hayPreview
                              ? 'Al tocar acá te van a poder ver.'
                              : 'Necesitamos la cámara para poder transmitir.',
                          textAlign: TextAlign.center,
                          style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// El encuadre, o el motivo por el que no se ve.
class _VistaPrevia extends StatelessWidget {
  const _VistaPrevia({required this.sala, required this.onReintentar});

  final BroadcasterRoom sala;
  final Future<void> Function() onReintentar;

  @override
  Widget build(BuildContext context) {
    final video = sala.video;

    if (video != null) {
      return VideoTrackRenderer(
        video,
        fit: VideoViewFit.cover,
        // Espejada, como cualquier cámara frontal: verse al revés desorienta.
        mirrorMode: VideoViewMirrorMode.auto,
      );
    }

    if (sala.estado == EstadoDeTransmision.sinPermisos) {
      return _Aviso(
        icono: Icons.videocam_off_rounded,
        titulo: 'Falta un permiso',
        detalle: sala.error ?? 'Necesitamos cámara y micrófono.',
        accion: 'Abrir ajustes',
        // El permiso denegado no se puede volver a pedir desde la app: hay que
        // ir a los ajustes del sistema. Decir sólo "permiso denegado" deja a la
        // persona sin saber qué tocar.
        onAccion: () => unawaited(openAppSettings()),
      );
    }

    if (sala.estado == EstadoDeTransmision.fallo) {
      return _Aviso(
        icono: Icons.error_outline_rounded,
        titulo: 'No pudimos abrir la cámara',
        detalle: sala.error ?? '',
        accion: 'Reintentar',
        onAccion: () => unawaited(onReintentar()),
      );
    }

    return const ColoredBox(
      color: Color(0xFF0B0B0D),
      child: Center(child: CircularProgressIndicator()),
    );
  }
}

class _ControlesDeCamara extends StatelessWidget {
  const _ControlesDeCamara({required this.sala});
  final BroadcasterRoom sala;

  @override
  Widget build(BuildContext context) {
    if (!sala.hayPreview) return const SizedBox.shrink();

    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        _BotonRedondo(
          icono: sala.camaraFrontal ? Icons.cameraswitch_rounded : Icons.cameraswitch_outlined,
          etiqueta: 'Dar vuelta',
          onTap: () => unawaited(sala.darVueltaCamara()),
        ),
        const SizedBox(width: Gap.xl),
        _BotonRedondo(
          icono: sala.micApagado ? Icons.mic_off_rounded : Icons.mic_rounded,
          etiqueta: sala.micApagado ? 'Sin audio' : 'Micrófono',
          alerta: sala.micApagado,
          onTap: () => unawaited(sala.alternarMicrofono()),
        ),
      ],
    );
  }
}

class _BotonRedondo extends StatelessWidget {
  const _BotonRedondo({
    required this.icono,
    required this.etiqueta,
    required this.onTap,
    this.alerta = false,
  });

  final IconData icono;
  final String etiqueta;
  final VoidCallback onTap;
  final bool alerta;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: etiqueta,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                color: alerta ? AppColor.alerta : Colors.black45,
                shape: BoxShape.circle,
                border: Border.all(color: Colors.white24),
              ),
              child: Icon(icono, color: Colors.white, size: 24),
            ),
            const SizedBox(height: 4),
            Text(
              etiqueta,
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                shadows: [Shadow(color: Colors.black87, blurRadius: 6)],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _FilaDeProducto extends StatelessWidget {
  const _FilaDeProducto({
    required this.nombre,
    required this.imagenUrl,
    required this.orden,
    required this.onTap,
  });

  final String nombre;
  final String? imagenUrl;

  /// Posición en la bandeja, o `-1` si no está elegido.
  final int orden;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final elegido = orden >= 0;

    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.sm),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Redondeo.md),
        child: Container(
          padding: const EdgeInsets.all(Gap.sm),
          decoration: BoxDecoration(
            color: elegido ? AppColor.acento.withValues(alpha: 0.12) : AppColor.superficie,
            borderRadius: BorderRadius.circular(Redondeo.md),
            border: Border.all(color: elegido ? AppColor.acento : AppColor.borde),
          ),
          child: Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(Redondeo.sm),
                child: SizedBox(
                  width: 44,
                  height: 44,
                  child: imagenUrl == null
                      ? const ColoredBox(
                          color: AppColor.superficieAlta,
                          child: Icon(Icons.image_rounded, size: 18, color: AppColor.textoDebil),
                        )
                      : CachedNetworkImage(
                          imageUrl: imagenUrl!,
                          fit: BoxFit.cover,
                          errorWidget: (_, __, ___) => const ColoredBox(
                            color: AppColor.superficieAlta,
                            child: Icon(Icons.image_rounded, size: 18, color: AppColor.textoDebil),
                          ),
                        ),
                ),
              ),
              const SizedBox(width: Gap.md),
              Expanded(
                child: Text(
                  nombre,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                ),
              ),
              if (elegido)
                Container(
                  width: 24,
                  height: 24,
                  alignment: Alignment.center,
                  decoration: const BoxDecoration(color: AppColor.acento, shape: BoxShape.circle),
                  // El número y no un tilde: el orden de la bandeja es el orden
                  // en que los va a mostrar, y conviene que se vea.
                  child: Text(
                    '${orden + 1}',
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800),
                  ),
                )
              else
                const Icon(Icons.add_circle_outline_rounded, color: AppColor.textoDebil, size: 24),
            ],
          ),
        ),
      ),
    );
  }
}

class _SinProductos extends StatelessWidget {
  const _SinProductos();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(color: AppColor.borde),
      ),
      child: const Row(
        children: [
          Icon(Icons.inventory_2_outlined, color: AppColor.textoSuave, size: 20),
          SizedBox(width: Gap.md),
          Expanded(
            child: Text(
              // No se bloquea la transmisión: se puede transmitir sin productos.
              // Pero conviene decir qué se pierde.
              'Todavía no tenés productos publicados. Podés transmitir igual, '
              'pero no vas a poder destacar nada para vender.',
              style: TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }
}

class _Aviso extends StatelessWidget {
  const _Aviso({
    required this.icono,
    required this.titulo,
    required this.detalle,
    required this.accion,
    required this.onAccion,
  });

  final IconData icono;
  final String titulo;
  final String detalle;
  final String accion;
  final VoidCallback onAccion;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: const Color(0xFF0B0B0D),
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(Gap.xl),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icono, size: 40, color: AppColor.textoSuave),
              const SizedBox(height: Gap.md),
              Text(titulo, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              const SizedBox(height: Gap.xs),
              Text(
                detalle,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 13.5, color: AppColor.textoSuave, height: 1.4),
              ),
              const SizedBox(height: Gap.lg),
              FilledButton(onPressed: onAccion, child: Text(accion)),
            ],
          ),
        ),
      ),
    );
  }
}
