import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:livekit_client/livekit_client.dart';

import '../../../../core/design/tokens.dart';
import '../../domain/live_models.dart';

/// El video del vivo, a pantalla completa.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL PERRO GUARDIÁN DE CUADROS
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Ya tenemos evidencia de campo: **LiveKit puede tardar mucho en avisar que el
/// que transmite se desconectó**. Durante ese rato la app cree que todo está
/// bien y muestra una pantalla negra en silencio, que es la peor forma de
/// fallar — nadie sabe si es la app, la conexión o que el vivo terminó.
///
/// Por eso no se confía sólo en el estado de la conexión. Se mira si los
/// cuadros decodificados **avanzan**: si `framesDecoded` no se mueve durante
/// dos segundos, no hay video aunque LiveKit diga que sí.
///
/// Cuando eso pasa:
///
///   · se conserva el último cuadro en vez de pasar a negro,
///   · se muestra "el vendedor está recuperando la conexión",
///   · el chat y la compra siguen funcionando.
///
/// ─── El primer cuadro tarda ───
///
/// La medición real dio un tiempo hasta el primer cuadro cercano a 4 segundos.
/// Mientras tanto se muestra la portada del vivo: cuatro segundos de negro se
/// sienten como que la app se colgó; cuatro segundos con la portada del
/// vendedor se sienten como que está cargando.
class VideoLive extends StatefulWidget {
  const VideoLive({super.key, required this.live});

  final DetalleDeLive live;

  @override
  State<VideoLive> createState() => _VideoLiveState();
}

class _VideoLiveState extends State<VideoLive> {
  Room? _sala;
  VideoTrack? _pista;
  bool _conectando = false;

  /// Cuándo se vio avanzar un cuadro por última vez.
  DateTime _ultimoAvance = DateTime.now();
  int _ultimosCuadros = 0;
  Timer? _guardian;
  bool _congelado = false;

  @override
  void initState() {
    super.initState();
    unawaited(_conectar());
  }

  @override
  void didUpdateWidget(VideoLive viejo) {
    super.didUpdateWidget(viejo);

    /**
     * ⚠️ Sólo se reconecta si cambió la SALA.
     *
     * Cualquier otro cambio del vivo —producto destacado, stock, cantidad de
     * espectadores— redibuja este widget varias veces por minuto. Reconectar en
     * cada uno cortaría el video constantemente: dos segundos de negro cada vez
     * que el vendedor cambia de producto, que es justo cuando más importa ver.
     */
    if (viejo.live.video?.sala != widget.live.video?.sala) {
      unawaited(_reconectar());
    }
  }

  @override
  void dispose() {
    _guardian?.cancel();
    unawaited(_sala?.disconnect());
    _sala?.dispose();
    super.dispose();
  }

  Future<void> _reconectar() async {
    _guardian?.cancel();
    await _sala?.disconnect();
    await _sala?.dispose();
    _sala = null;
    _pista = null;
    await _conectar();
  }

  Future<void> _conectar() async {
    final video = widget.live.video;
    if (video == null || video.token.isEmpty || _conectando) return;

    setState(() => _conectando = true);

    try {
      final sala = Room();

      sala.addListener(() {
        if (!mounted) return;
        // La pista del que transmite: el primer video remoto que llegue. En
        // esta sala sólo publica el vendedor — el token de espectador no
        // permite publicar, y eso lo garantiza el servidor de LiveKit.
        final pista = sala.remoteParticipants.values
            .expand((p) => p.videoTrackPublications)
            .map((pub) => pub.track)
            .whereType<VideoTrack>()
            .firstOrNull;

        if (pista != _pista) setState(() => _pista = pista);
      });

      await sala.connect(video.wsUrl, video.token);

      if (!mounted) {
        await sala.disconnect();
        await sala.dispose();
        return;
      }

      _sala = sala;
      _arrancarGuardian();
    } catch (_) {
      // Sin video, la pantalla sigue mostrando la portada y todo lo comercial.
      // Un vivo sin imagen se puede seguir comprando.
    } finally {
      if (mounted) setState(() => _conectando = false);
    }
  }

  /// Mira si los cuadros avanzan. Ver la nota de arriba.
  void _arrancarGuardian() {
    _guardian?.cancel();
    _ultimoAvance = DateTime.now();

    _guardian = Timer.periodic(const Duration(milliseconds: 500), (_) async {
      final sala = _sala;
      if (sala == null || !mounted) return;

      try {
        final pubs = sala.remoteParticipants.values
            .expand((p) => p.videoTrackPublications)
            .toList();

        var cuadros = 0;
        for (final pub in pubs) {
          final track = pub.track;
          if (track is RemoteVideoTrack) {
            final stats = await track.getReceiverStats();
            cuadros += stats?.framesDecoded?.toInt() ?? 0;
          }
        }

        if (cuadros > _ultimosCuadros) {
          _ultimosCuadros = cuadros;
          _ultimoAvance = DateTime.now();
          if (_congelado && mounted) setState(() => _congelado = false);
          return;
        }

        // Dos segundos sin un cuadro nuevo: hay video "conectado" pero no está
        // llegando nada.
        final quieto = DateTime.now().difference(_ultimoAvance).inMilliseconds > 2000;
        if (quieto && !_congelado && mounted) setState(() => _congelado = true);
      } catch (_) {
        // Si las estadísticas no están disponibles, no se concluye nada: es
        // mejor no avisar que avisar de una congelación que no existe.
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final live = widget.live;
    final pista = _pista;
    final hayVideo = pista != null && !live.terminado;

    return Stack(
      fit: StackFit.expand,
      children: [
        // La portada, siempre debajo. Se ve mientras carga el primer cuadro y
        // queda de fondo si el video nunca llega.
        if (live.portada != null)
          CachedNetworkImage(
            imageUrl: live.portada!,
            fit: BoxFit.cover,
            placeholder: (_, __) => const ColoredBox(color: Colors.black),
            errorWidget: (_, __, ___) => const _FondoVacio(),
          )
        else
          const _FondoVacio(),

        if (hayVideo)
          VideoTrackRenderer(
            pista,
            // Recorta para llenar la pantalla, como corresponde a un vivo
            // vertical. `contain` —que es el valor por defecto— dejaría barras
            // negras a los costados con cualquier cámara que no sea 9:16.
            fit: VideoViewFit.cover,
          ),

        // El aviso de reconexión, sobre el último cuadro congelado.
        if ((live.reconectando || _congelado) && !live.terminado)
          const Positioned(
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            child: _AvisoDeReconexion(),
          ),
      ],
    );
  }
}

class _FondoVacio extends StatelessWidget {
  const _FondoVacio();

  @override
  Widget build(BuildContext context) {
    return const DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF1A1015), Color(0xFF000000)],
        ),
      ),
      child: Center(
        child: Icon(Icons.storefront_rounded, size: 84, color: Colors.white10),
      ),
    );
  }
}

/// "El vendedor está recuperando la conexión."
///
/// Sobre el último cuadro, no sobre negro: conservar la imagen congelada le
/// dice a quien mira que había algo y va a volver. Una pantalla negra se lee
/// como que el vivo terminó.
class _AvisoDeReconexion extends StatelessWidget {
  const _AvisoDeReconexion();

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Colors.black.withValues(alpha: 0.45),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: Gap.md),
          decoration: BoxDecoration(
            color: Colors.black54,
            borderRadius: BorderRadius.circular(Redondeo.md),
          ),
          child: const Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2, color: AppColor.alerta),
              ),
              SizedBox(height: Gap.md),
              Text(
                'El vendedor está recuperando\nla conexión…',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
              ),
              SizedBox(height: 4),
              Text(
                'Podés seguir comprando',
                style: TextStyle(fontSize: 12, color: AppColor.textoSuave),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
