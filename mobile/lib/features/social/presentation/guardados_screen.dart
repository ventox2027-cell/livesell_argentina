import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/componentes.dart';
import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../lives/presentation/widgets/catalogo_de_tienda.dart' show plata;
import '../data/guardados_api.dart';

/// Guardados y vistos recientemente, en una pantalla con dos pestañas.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// JUNTAS, PERO SEPARADAS
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Las dos responden la misma pregunta —«¿dónde estaba eso que vi?»— y por eso
/// están en el mismo lugar. Pero son dos listas con dueños distintos: una la
/// armó la persona a propósito, la otra la armó el sistema mirando.
///
/// Mezclarlas en una sola lista habría sido más simple y peor: quien busca algo
/// que guardó tendría que revolver entre veinte cosas que apenas miró.
class GuardadosScreen extends ConsumerWidget {
  const GuardadosScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Guardados'),
          bottom: const TabBar(
            tabs: [
              Tab(text: 'Guardados'),
              Tab(text: 'Vistos'),
            ],
          ),
        ),
        body: const TabBarView(
          children: [_Guardados(), _Vistos()],
        ),
      ),
    );
  }
}

class _Guardados extends ConsumerWidget {
  const _Guardados();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _Lista(
      valor: ref.watch(guardadosProvider),
      onRefrescar: () => ref.invalidate(guardadosProvider),
      vacio: const _Vacio(
        icono: Icons.bookmark_border_rounded,
        titulo: 'Todavía no guardaste nada',
        detalle: 'Tocá el corazón de un producto para tenerlo a mano.',
      ),
      // El stock sólo se muestra acá: en «vistos» la lista es para volver a
      // algo, no para decidir una compra.
      conStock: true,
    );
  }
}

class _Vistos extends ConsumerWidget {
  const _Vistos();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lista = ref.watch(vistosRecientesProvider);

    return Column(
      children: [
        Expanded(
          child: _Lista(
            valor: lista,
            onRefrescar: () => ref.invalidate(vistosRecientesProvider),
            vacio: const _Vacio(
              icono: Icons.history_rounded,
              titulo: 'Nada por acá todavía',
              detalle: 'Los productos que mires van a aparecer acá por 30 días.',
            ),
            conStock: false,
          ),
        ),

        /**
         * Borrar el historial, a la vista.
         *
         * No escondido en ajustes: es una lista de lo que la persona miró, y
         * poder borrarla desde donde se la ve es la diferencia entre una
         * comodidad y algo que no controla.
         */
        if ((lista.valueOrNull ?? const []).isNotEmpty)
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(Gap.md),
              child: TextButton.icon(
                onPressed: () async {
                  await ref.read(guardadosApiProvider).borrarVistos();
                  ref.invalidate(vistosRecientesProvider);
                  if (context.mounted) AppSnack.exito(context, 'Historial borrado');
                },
                icon: const Icon(Icons.delete_outline_rounded, size: 18),
                label: const Text('Borrar historial'),
              ),
            ),
          ),
      ],
    );
  }
}

class _Lista extends StatelessWidget {
  const _Lista({
    required this.valor,
    required this.onRefrescar,
    required this.vacio,
    required this.conStock,
  });

  final AsyncValue<List<ProductoGuardado>> valor;
  final VoidCallback onRefrescar;
  final Widget vacio;
  final bool conStock;

  @override
  Widget build(BuildContext context) {
    return valor.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(
        child: Padding(
          padding: const EdgeInsets.all(Gap.xl),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('No pudimos cargar la lista.'),
              const SizedBox(height: Gap.md),
              OutlinedButton(onPressed: onRefrescar, child: const Text('Reintentar')),
            ],
          ),
        ),
      ),
      data: (items) {
        if (items.isEmpty) return vacio;

        return RefreshIndicator(
          onRefresh: () async => onRefrescar(),
          child: ListView.separated(
            padding: const EdgeInsets.all(Gap.lg),
            itemCount: items.length,
            separatorBuilder: (_, __) => const SizedBox(height: Gap.md),
            itemBuilder: (_, i) => _Fila(producto: items[i], conStock: conStock),
          ),
        );
      },
    );
  }
}

class _Fila extends StatelessWidget {
  const _Fila({required this.producto, required this.conStock});

  final ProductoGuardado producto;
  final bool conStock;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(Redondeo.md),
          child: SizedBox(
            width: 72,
            height: 72,
            child: producto.portada == null
                ? const ColoredBox(
                    color: AppColor.superficieAlta,
                    child: Icon(Icons.image_outlined, color: AppColor.textoDebil),
                  )
                : CachedNetworkImage(
                    imageUrl: producto.portada!,
                    fit: BoxFit.cover,
                    placeholder: (_, __) => const ColoredBox(color: AppColor.superficieAlta),
                    errorWidget: (_, __, ___) =>
                        const ColoredBox(color: AppColor.superficieAlta),
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
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
              ),
              if (producto.tiendaNombre != null)
                Text(
                  producto.tiendaNombre!,
                  style: const TextStyle(color: AppColor.textoDebil, fontSize: 12.5),
                ),
              const SizedBox(height: Gap.xs),
              Row(
                children: [
                  Text(
                    plata(producto.precioCentavos),
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5),
                  ),
                  if (conStock) ...[
                    const SizedBox(width: Gap.sm),
                    // Dato real del inventario, no una etiqueta decorativa.
                    Etiqueta(
                      texto: producto.hayStock ? 'Disponible' : 'Sin stock',
                      tono: producto.hayStock ? TonoDeEstado.exito : TonoDeEstado.neutro,
                    ),
                  ],
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Vacio extends StatelessWidget {
  const _Vacio({required this.icono, required this.titulo, required this.detalle});

  final IconData icono;
  final String titulo;
  final String detalle;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xxl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icono, size: 44, color: AppColor.textoDebil),
            const SizedBox(height: Gap.lg),
            Text(titulo, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: Gap.sm),
            Text(
              detalle,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColor.textoSuave, height: 1.45),
            ),
          ],
        ),
      ),
    );
  }
}
