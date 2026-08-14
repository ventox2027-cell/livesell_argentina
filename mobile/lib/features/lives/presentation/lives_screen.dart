import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../data/live_api.dart';
import '../domain/live_models.dart';
import 'live_viewer_screen.dart';

/// Los vivos que están ocurriendo ahora.
///
/// ─── Por qué se recarga al entrar a la pestaña ───
///
/// Esta pantalla vive dentro de un `IndexedStack`: se construye una vez al
/// arrancar la app y **nunca se desmonta**. Sin una recarga explícita mostraría
/// la lista de cuando se abrió la app, que a los diez minutos ya es mentira: un
/// vivo dura media hora y la grilla se renueva todo el tiempo.
///
/// El disparo lo hace el shell al seleccionar la pestaña (`app_shell.dart`), no
/// un temporizador: un `Timer.periodic` acá seguiría pidiendo la lista mientras
/// alguien mira el feed, gastando batería y datos por una pantalla que no está
/// en cámara.
final livesActivosProvider = FutureProvider<List<ResumenDeLive>>(
  (ref) => ref.watch(liveApiProvider).activos(),
);

class LivesScreen extends ConsumerWidget {
  const LivesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lives = ref.watch(livesActivosProvider);

    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(
        backgroundColor: AppColor.fondo,
        title: const Text('En vivo'),
        actions: [
          IconButton(
            onPressed: () => ref.invalidate(livesActivosProvider),
            icon: const Icon(Icons.refresh_rounded),
            tooltip: 'Actualizar',
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => ref.invalidate(livesActivosProvider),
        child: lives.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, __) => const _Mensaje(
            icono: Icons.wifi_off_rounded,
            titulo: 'No pudimos traer los vivos',
            detalle: 'Revisá tu conexión y deslizá para reintentar.',
          ),
          data: (items) => items.isEmpty
              ? const _Mensaje(
                  icono: Icons.sensors_off_rounded,
                  titulo: 'No hay nadie transmitiendo',
                  detalle: 'Cuando un vendedor salga al aire, va a aparecer acá.',
                )
              : GridView.builder(
                  padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.sm, Gap.lg, 96),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 2,
                    crossAxisSpacing: Gap.md,
                    mainAxisSpacing: Gap.md,
                    // Vertical, como el video que va adentro.
                    childAspectRatio: 0.62,
                  ),
                  itemCount: items.length,
                  itemBuilder: (_, i) => _TarjetaDeLive(
                    live: items[i],
                    onTap: () => unawaited(_entrar(context, ref, items[i].id)),
                  ),
                ),
        ),
      ),
    );
  }

  Future<void> _entrar(BuildContext context, WidgetRef ref, String liveId) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => LiveViewerScreen(liveId: liveId)),
    );
    // Al volver, la lista puede haber cambiado: el vivo del que se sale suele
    // ser justo el que terminó.
    ref.invalidate(livesActivosProvider);
  }
}

class _TarjetaDeLive extends StatelessWidget {
  const _TarjetaDeLive({required this.live, required this.onTap});

  final ResumenDeLive live;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(Redondeo.md),
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (live.portada == null)
              const DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [Color(0xFF1A1015), Color(0xFF000000)],
                  ),
                ),
                child: Icon(Icons.sensors_rounded, size: 34, color: Colors.white12),
              )
            else
              CachedNetworkImage(
                imageUrl: live.portada!,
                fit: BoxFit.cover,
                placeholder: (_, __) => const ColoredBox(color: AppColor.superficieAlta),
                errorWidget: (_, __, ___) => const ColoredBox(color: AppColor.superficieAlta),
              ),

            const DecoratedBox(decoration: BoxDecoration(gradient: AppColor.velo)),

            // El estado, arriba a la izquierda. Con texto, no sólo color.
            Positioned(
              top: Gap.sm,
              left: Gap.sm,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: live.estado == 'RECONNECTING' ? AppColor.alerta : AppColor.vivo,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  live.estado == 'RECONNECTING' ? 'RECONECTANDO' : 'EN VIVO',
                  style: const TextStyle(
                    fontSize: 9.5,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.5,
                    color: Colors.white,
                  ),
                ),
              ),
            ),

            Positioned(
              left: Gap.sm,
              right: Gap.sm,
              bottom: Gap.sm,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    live.titulo,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      height: 1.25,
                      shadows: [Shadow(color: Colors.black87, blurRadius: 6)],
                    ),
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          live.tiendaNombre.isEmpty ? live.vendedorNombre : live.tiendaNombre,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 11.5,
                            color: AppColor.textoSuave,
                            shadows: [Shadow(color: Colors.black87, blurRadius: 6)],
                          ),
                        ),
                      ),
                      if (live.identidadVerificada) ...[
                        const SizedBox(width: 3),
                        const Icon(Icons.verified_rounded, size: 12, color: AppColor.acento),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Mensaje extends StatelessWidget {
  const _Mensaje({required this.icono, required this.titulo, required this.detalle});

  final IconData icono;
  final String titulo;
  final String detalle;

  @override
  Widget build(BuildContext context) {
    // Una lista y no un Center: `RefreshIndicator` necesita algo desplazable
    // para que el gesto de tirar hacia abajo exista. Sin esto, la pantalla
    // vacía es justo la única desde la que no se puede reintentar.
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: Gap.xl, vertical: 120),
      children: [
        Icon(icono, size: 40, color: AppColor.textoDebil),
        const SizedBox(height: Gap.md),
        Text(
          titulo,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: Gap.xs),
        Text(
          detalle,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 13.5, color: AppColor.textoSuave, height: 1.4),
        ),
      ],
    );
  }
}
