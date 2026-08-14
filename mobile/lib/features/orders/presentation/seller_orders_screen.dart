import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../seller/domain/seller_models.dart';
import '../data/orders_repository.dart';
import '../domain/order_models.dart';

/// Las ventas del vendedor.
///
/// ─── Qué necesita ver, y en qué orden ───
///
/// Un vendedor abre esto para responder una pregunta: **¿qué tengo que
/// preparar hoy?** Por eso lo primero de cada tarjeta es qué se vendió y a
/// dónde va, y el botón de avanzar el estado está a un toque.
///
/// El neto va abajo y en gris. Importa, pero no es lo que se mira para
/// despachar: si estuviera arriba y en grande, la pantalla contestaría
/// "cuánto gané" en vez de "qué empaco".
///
/// ─── Lo que NO ve ───
///
/// Con qué tarjeta le pagaron ni el id del pago en Mercado Pago. No le sirven
/// para nada y son datos de otra persona. El backend directamente no los manda.
class SellerOrdersScreen extends ConsumerWidget {
  const SellerOrdersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ventas = ref.watch(misVentasProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Mis ventas')),
      body: ventas.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(Gap.xl),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.cloud_off_rounded, size: 32, color: AppColor.textoDebil),
                const SizedBox(height: Gap.md),
                Text(
                  e.toString(),
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: AppColor.textoSuave, fontSize: 14),
                ),
                const SizedBox(height: Gap.lg),
                OutlinedButton(
                  onPressed: () => ref.invalidate(misVentasProvider),
                  child: const Text('Reintentar'),
                ),
              ],
            ),
          ),
        ),
        data: (pagina) {
          if (pagina.items.isEmpty) return const _SinVentas();

          final total = pagina.items.fold<int>(0, (s, v) => s + v.neto);

          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(misVentasProvider),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, 100),
              children: [
                _Resumen(cantidad: pagina.items.length, neto: total),
                const SizedBox(height: Gap.xl),
                for (final venta in pagina.items)
                  Padding(
                    padding: const EdgeInsets.only(bottom: Gap.md),
                    child: _TarjetaDeVenta(venta: venta),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _Resumen extends StatelessWidget {
  const _Resumen({required this.cantidad, required this.neto});
  final int cantidad;
  final int neto;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: AppColor.borde),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '$cantidad',
                  style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
                ),
                const Text(
                  'ventas',
                  style: TextStyle(fontSize: 11.5, color: AppColor.textoDebil),
                ),
              ],
            ),
          ),
          Container(width: 1, height: 34, color: AppColor.borde),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  formatearPesos(neto),
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w700,
                    color: AppColor.exito,
                  ),
                ),
                const Text(
                  'te queda',
                  style: TextStyle(fontSize: 11.5, color: AppColor.textoDebil),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TarjetaDeVenta extends ConsumerStatefulWidget {
  const _TarjetaDeVenta({required this.venta});
  final Venta venta;

  @override
  ConsumerState<_TarjetaDeVenta> createState() => _TarjetaDeVentaState();
}

class _TarjetaDeVentaState extends ConsumerState<_TarjetaDeVenta> {
  bool _guardando = false;

  Future<void> _avanzar() async {
    final siguiente = widget.venta.siguienteEstado;
    if (siguiente == null) return;

    setState(() => _guardando = true);
    try {
      await ref.read(ordersRepositoryProvider).avanzarVenta(widget.venta.id, siguiente);
      unawaited(HapticFeedback.selectionClick());
      ref.invalidate(misVentasProvider);
    } catch (e) {
      if (mounted) AppSnack.error(context, e.toString());
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.venta;
    final linea = v.lineas.firstOrNull;

    return Container(
      padding: const EdgeInsets.all(Gap.md),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: AppColor.borde),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  linea?.nombre ?? 'Venta',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                ),
              ),
              _Etiqueta(v.etiquetaEstado),
            ],
          ),
          if (linea != null) ...[
            const SizedBox(height: 2),
            Text(
              [
                if (linea.varianteRelevante) linea.variante,
                if (linea.cantidad > 1) '${linea.cantidad} unidades',
                if (linea.sku != null) 'SKU ${linea.sku}',
              ].join(' · '),
              style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
            ),
          ],

          const SizedBox(height: Gap.md),

          // A dónde va. Es lo que el vendedor necesita para despachar.
          if (v.direccion != null)
            Container(
              padding: const EdgeInsets.all(Gap.md),
              decoration: BoxDecoration(
                color: AppColor.superficieAlta,
                borderRadius: BorderRadius.circular(Redondeo.md),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.local_shipping_outlined, size: 16, color: AppColor.textoSuave),
                  const SizedBox(width: Gap.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          v.direccion!.destinatario,
                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                        ),
                        Text(
                          v.direccion!.resumen,
                          style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                        ),
                        if (v.direccion!.referencias != null)
                          Text(
                            v.direccion!.referencias!,
                            style: const TextStyle(fontSize: 12, color: AppColor.textoDebil),
                          ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.copy_rounded, size: 16),
                    tooltip: 'Copiar dirección',
                    visualDensity: VisualDensity.compact,
                    onPressed: () async {
                      await Clipboard.setData(
                        ClipboardData(
                          text: '${v.direccion!.destinatario}\n${v.direccion!.resumen}',
                        ),
                      );
                      if (context.mounted) AppSnack.exito(context, 'Copiada');
                    },
                  ),
                ],
              ),
            ),

          const SizedBox(height: Gap.md),

          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Te queda ${formatearPesos(v.neto)}',
                      style: const TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                        color: AppColor.exito,
                      ),
                    ),
                    Text(
                      'Cobrado ${formatearPesos(v.total)} · comisión ${formatearPesos(v.comision)}',
                      style: const TextStyle(fontSize: 11.5, color: AppColor.textoDebil),
                    ),
                  ],
                ),
              ),
            ],
          ),

          if (v.etiquetaSiguiente != null) ...[
            const SizedBox(height: Gap.md),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: _guardando ? null : _avanzar,
                style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
                child: _guardando
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : Text(v.etiquetaSiguiente!),
              ),
            ),
          ],

          const SizedBox(height: Gap.sm),
          Text(
            'Pedido ${v.referencia}',
            style: const TextStyle(fontSize: 11, color: AppColor.textoDebil),
          ),
        ],
      ),
    );
  }
}

class _Etiqueta extends StatelessWidget {
  const _Etiqueta(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    final color = switch (texto) {
      'Nueva' => AppColor.acento,
      'Preparando' || 'Lista' => AppColor.alerta,
      'Despachada' || 'Entregada' => AppColor.exito,
      'A devolver' || 'Devolviendo' || 'Devuelta' => AppColor.error,
      _ => AppColor.textoDebil,
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(Redondeo.sm),
      ),
      child: Text(
        texto,
        style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: color),
      ),
    );
  }
}

class _SinVentas extends StatelessWidget {
  const _SinVentas();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.storefront_outlined, size: 40, color: AppColor.textoDebil),
            const SizedBox(height: Gap.lg),
            Text('Todavía no vendiste nada', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: Gap.sm),
            const Text(
              'Cuando alguien te compre, acá vas a ver qué preparar y a dónde mandarlo.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColor.textoSuave, fontSize: 14, height: 1.45),
            ),
          ],
        ),
      ),
    );
  }
}
