import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../core/network/reintentar_al_volver_la_red.dart';
import '../../../shared/widgets/app_snack.dart';
import '../data/bloqueos_api.dart';

/// A quiénes bloqueé.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// TIENE QUE SER FÁCIL DE ENCONTRAR Y FÁCIL DE DESHACER
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Bloquear es reversible y a veces se hace en caliente. Una lista escondida
/// —o sin forma de desbloquear— convierte una decisión de un segundo en algo
/// permanente por accidente.
///
/// Y no muestra el apellido completo de nadie: el backend manda "Juan P." y
/// alcanza para reconocer a quien uno bloqueó.
class BloqueadosScreen extends ConsumerWidget {
  const BloqueadosScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bloqueos = ref.watch(misBloqueosProvider);

    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(title: const Text('Personas bloqueadas')),
      body: bloqueos.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, __) => ReintentarAlVolverLaRed(
          error: e,
          onReintentar: () => ref.invalidate(misBloqueosProvider),
          child: _Error(onReintentar: () => ref.invalidate(misBloqueosProvider)),
        ),
        data: (lista) => lista.isEmpty
            ? const _Vacio()
            : RefreshIndicator(
                onRefresh: () async => ref.invalidate(misBloqueosProvider),
                child: ListView.separated(
                  padding: const EdgeInsets.symmetric(vertical: Gap.md),
                  itemCount: lista.length,
                  separatorBuilder: (_, __) =>
                      const Divider(height: 1, color: AppColor.borde, indent: 72),
                  itemBuilder: (_, i) => _Fila(persona: lista[i]),
                ),
              ),
      ),
    );
  }
}

class _Fila extends ConsumerStatefulWidget {
  const _Fila({required this.persona});
  final PersonaBloqueada persona;

  @override
  ConsumerState<_Fila> createState() => _FilaState();
}

class _FilaState extends ConsumerState<_Fila> {
  bool _quitando = false;

  Future<void> _desbloquear() async {
    setState(() => _quitando = true);
    try {
      await ref.read(bloqueosApiProvider).desbloquear(widget.persona.userId);
      ref.invalidate(misBloqueosProvider);
      if (mounted) AppSnack.info(context, 'Desbloqueaste a ${widget.persona.nombre}');
    } catch (_) {
      if (!mounted) return;
      setState(() => _quitando = false);
      AppSnack.error(context, 'No pudimos desbloquear. Probá de nuevo.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.persona;

    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: 4),
      leading: CircleAvatar(
        radius: 22,
        backgroundColor: AppColor.superficieAlta,
        backgroundImage: p.avatarUrl != null ? CachedNetworkImageProvider(p.avatarUrl!) : null,
        child: p.avatarUrl == null
            ? const Icon(Icons.person_outline_rounded, color: AppColor.textoDebil)
            : null,
      ),
      title: Text(
        // Si vende, se muestra el nombre de la tienda: es como lo conoce quien
        // lo bloqueó, no por su nombre de pila.
        p.tienda ?? p.nombre,
        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
      ),
      subtitle: p.motivo != null
          ? Text(
              p.motivo!,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
            )
          : null,
      trailing: _quitando
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : TextButton(
              onPressed: () => unawaited(_desbloquear()),
              child: const Text('Desbloquear'),
            ),
    );
  }
}

class _Vacio extends StatelessWidget {
  const _Vacio();

  @override
  Widget build(BuildContext context) {
    return ListView(
      // `ListView` y no `Center`: así se puede tirar para refrescar aunque esté
      // vacío, que es lo que hace la gente cuando cree que falta algo.
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(horizontal: Gap.xxl, vertical: 120),
      children: const [
        Icon(Icons.block_outlined, size: 44, color: AppColor.textoDebil),
        SizedBox(height: Gap.lg),
        Text(
          'No bloqueaste a nadie',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        SizedBox(height: Gap.sm),
        Text(
          'Si alguien te molesta, podés bloquearlo desde su tienda. '
          'No se entera y lo podés deshacer cuando quieras.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13.5, color: AppColor.textoSuave, height: 1.45),
        ),
      ],
    );
  }
}

class _Error extends StatelessWidget {
  const _Error({required this.onReintentar});
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.wifi_off_rounded, size: 40, color: AppColor.textoDebil),
          const SizedBox(height: Gap.md),
          const Text('No pudimos cargar la lista'),
          const SizedBox(height: Gap.md),
          TextButton(onPressed: onReintentar, child: const Text('Reintentar')),
        ],
      ),
    );
  }
}
