import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../seller/domain/seller_models.dart';
import '../data/orders_repository.dart';
import '../domain/order_models.dart';
import 'widgets/codigo_de_entrega.dart';

/// Mis pedidos.
///
/// ─── Qué tiene que resolver ───
///
/// Una sola pregunta: **¿dónde está mi compra?** Todo lo demás es secundario.
/// Por eso el estado va primero, en palabras, y con el color como refuerzo —no
/// como único canal, porque un daltónico también tiene que poder leerlo.
///
/// ─── Ningún código técnico llega acá ───
///
/// Nadie entiende `PAYMENT_REQUIRES_REFUND` ni `cc_rejected_other_reason`. La
/// traducción está en `order_models.dart` y es la única fuente.
class OrdersScreen extends ConsumerWidget {
  const OrdersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pedidos = ref.watch(misPedidosProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Mis pedidos')),
      body: pedidos.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _Error(
          mensaje: e.toString(),
          onReintentar: () => ref.invalidate(misPedidosProvider),
        ),
        data: (pagina) {
          if (pagina.items.isEmpty) return const _SinPedidos();

          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(misPedidosProvider),
            child: ListView.builder(
              padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, 100),
              itemCount: pagina.items.length,
              itemBuilder: (_, i) => Padding(
                padding: const EdgeInsets.only(bottom: Gap.md),
                child: _TarjetaDePedido(pedido: pagina.items[i]),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _TarjetaDePedido extends ConsumerWidget {
  const _TarjetaDePedido({required this.pedido});
  final Pedido pedido;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final linea = pedido.lineas.firstOrNull;
    final estado = pedido.estado;

    return InkWell(
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => OrderDetailScreen(orderId: pedido.id)),
      ),
      borderRadius: BorderRadius.circular(Redondeo.lg),
      child: Container(
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
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Miniatura(url: linea?.imagenUrl),
                const SizedBox(width: Gap.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        linea?.nombre ?? 'Pedido',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                      ),
                      if (linea != null && linea.varianteRelevante)
                        Text(
                          linea.variante,
                          style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                        ),
                      const SizedBox(height: 4),
                      Text(
                        pedido.total,
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: Gap.md),
            _ChipEstado(estado: estado),
            if (estado.detalle.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                estado.detalle,
                style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave, height: 1.35),
              ),
            ],

            if (pedido.sePuedePagar) ...[
              const SizedBox(height: Gap.md),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () => AppSnack.info(
                    context,
                    'Abrí el pedido para completar el pago.',
                  ),
                  style: FilledButton.styleFrom(minimumSize: const Size(0, 42)),
                  child: const Text('Completar el pago'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Detalle de un pedido.
class OrderDetailScreen extends ConsumerWidget {
  const OrderDetailScreen({super.key, required this.orderId});
  final String orderId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pedido = ref.watch(pedidoProvider(orderId));

    return Scaffold(
      appBar: AppBar(title: const Text('Pedido')),
      body: pedido.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _Error(
          mensaje: e.toString(),
          onReintentar: () => ref.invalidate(pedidoProvider(orderId)),
        ),
        data: (p) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(pedidoProvider(orderId)),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, Gap.xxl),
            children: [
              _ChipEstado(estado: p.estado, grande: true),
              if (p.estado.detalle.isNotEmpty) ...[
                const SizedBox(height: Gap.sm),
                Text(
                  p.motivo ?? p.estado.detalle,
                  style: const TextStyle(fontSize: 14, color: AppColor.textoSuave, height: 1.45),
                ),
              ],
              const SizedBox(height: Gap.xl),

              const _Titulo('Qué compraste'),
              const SizedBox(height: Gap.sm),
              for (final linea in p.lineas)
                Padding(
                  padding: const EdgeInsets.only(bottom: Gap.md),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _Miniatura(url: linea.imagenUrl),
                      const SizedBox(width: Gap.md),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              linea.nombre,
                              style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                            ),
                            if (linea.varianteRelevante)
                              Text(
                                linea.variante,
                                style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                              ),
                            Text(
                              '${linea.cantidad} × ${formatearPesos(linea.precioUnitario)}',
                              style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),

              // El codigo va ANTES del total: cuando el pedido esta en la puerta,
              // es lo unico que la persona necesita de esta pantalla.
              if (p.esperaEntrega) ...[
                const SizedBox(height: Gap.md),
                CodigoDeEntrega(codigo: p.codigoDeEntrega!),
              ],

              const Divider(color: AppColor.borde, height: Gap.xl),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Total', style: TextStyle(fontSize: 15)),
                  Text(
                    p.total,
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
                  ),
                ],
              ),

              if (p.direccion != null) ...[
                const SizedBox(height: Gap.xl),
                const _Titulo('Se envía a'),
                const SizedBox(height: Gap.sm),
                Text(
                  p.direccion!.destinatario,
                  style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                ),
                Text(
                  p.direccion!.resumen,
                  style: const TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.4),
                ),
                if (p.direccion!.referencias != null)
                  Text(
                    p.direccion!.referencias!,
                    style: const TextStyle(fontSize: 12.5, color: AppColor.textoDebil),
                  ),
              ],

              if (p.intentos.isNotEmpty) ...[
                const SizedBox(height: Gap.xl),
                const _Titulo('Pago'),
                const SizedBox(height: Gap.sm),
                for (final intento in p.intentos)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Row(
                      children: [
                        Icon(
                          intento.aprobado
                              ? Icons.check_circle_outline_rounded
                              : intento.incierto
                                  ? Icons.schedule_rounded
                                  : Icons.cancel_outlined,
                          size: 16,
                          color: intento.aprobado
                              ? AppColor.exito
                              : intento.incierto
                                  ? AppColor.alerta
                                  : AppColor.textoDebil,
                        ),
                        const SizedBox(width: Gap.sm),
                        Expanded(
                          child: Text(
                            intento.tarjeta ?? 'Intento de pago',
                            style: const TextStyle(fontSize: 13, color: AppColor.textoSuave),
                          ),
                        ),
                        if (intento.mensaje != null)
                          Flexible(
                            child: Text(
                              intento.mensaje!,
                              textAlign: TextAlign.right,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 11.5, color: AppColor.textoDebil),
                            ),
                          ),
                      ],
                    ),
                  ),
              ],

              const SizedBox(height: Gap.xl),
              Center(
                child: Text(
                  'Pedido ${p.referencia}',
                  style: const TextStyle(fontSize: 12, color: AppColor.textoDebil),
                ),
              ),

              if (p.sePuedeCancelar) ...[
                const SizedBox(height: Gap.xl),
                TextButton(
                  onPressed: () => _cancelar(context, ref, p),
                  style: TextButton.styleFrom(foregroundColor: AppColor.error),
                  child: const Text('Cancelar pedido'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _cancelar(BuildContext context, WidgetRef ref, Pedido pedido) async {
    final confirma = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColor.superficie,
        title: const Text('¿Cancelar el pedido?'),
        content: const Text(
          'Se libera el stock para otros compradores.',
          style: TextStyle(color: AppColor.textoSuave, height: 1.45),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('No')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColor.error),
            child: const Text('Cancelar pedido'),
          ),
        ],
      ),
    );
    if (confirma != true || !context.mounted) return;

    try {
      await ref.read(ordersRepositoryProvider).cancelar(pedido.id);
      ref.invalidate(pedidoProvider(pedido.id));
      ref.invalidate(misPedidosProvider);
      if (context.mounted) AppSnack.info(context, 'Pedido cancelado');
    } catch (e) {
      if (context.mounted) AppSnack.error(context, e.toString());
    }
  }
}

// ─── Piezas ─────────────────────────────────────────────────────────────────

class _ChipEstado extends StatelessWidget {
  const _ChipEstado({required this.estado, this.grande = false});
  final EstadoDePedido estado;
  final bool grande;

  @override
  Widget build(BuildContext context) {
    final (color, icono) = switch (estado.tono) {
      TonoDeEstado.exito => (AppColor.exito, Icons.check_circle_rounded),
      TonoDeEstado.error => (AppColor.error, Icons.error_outline_rounded),
      TonoDeEstado.alerta => (AppColor.alerta, Icons.info_outline_rounded),
      TonoDeEstado.enCurso => (AppColor.alerta, Icons.schedule_rounded),
      TonoDeEstado.pendiente => (AppColor.acento, Icons.payments_outlined),
      TonoDeEstado.neutro => (AppColor.textoDebil, Icons.inventory_2_outlined),
    };

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: EdgeInsets.symmetric(
            horizontal: grande ? 12 : 8,
            vertical: grande ? 7 : 4,
          ),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.14),
            borderRadius: BorderRadius.circular(Redondeo.sm),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icono, size: grande ? 16 : 13, color: color),
              const SizedBox(width: 5),
              // El texto, no sólo el color: quien no distingue verde de rojo
              // también tiene que poder leer en qué anda su compra.
              Text(
                estado.titulo,
                style: TextStyle(
                  fontSize: grande ? 14 : 11.5,
                  fontWeight: FontWeight.w700,
                  color: color,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Miniatura extends StatelessWidget {
  const _Miniatura({this.url});
  final String? url;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(Redondeo.sm),
      child: SizedBox(
        width: 52,
        height: 52,
        child: url == null
            ? const ColoredBox(
                color: AppColor.superficieAlta,
                child: Icon(Icons.image_outlined, size: 20, color: AppColor.textoDebil),
              )
            : CachedNetworkImage(
                imageUrl: url!,
                fit: BoxFit.cover,
                errorWidget: (_, __, ___) => const ColoredBox(
                  color: AppColor.superficieAlta,
                  child: Icon(Icons.image_outlined, size: 20, color: AppColor.textoDebil),
                ),
              ),
      ),
    );
  }
}

class _SinPedidos extends StatelessWidget {
  const _SinPedidos();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.receipt_long_outlined, size: 40, color: AppColor.textoDebil),
            const SizedBox(height: Gap.lg),
            Text('Todavía no compraste nada', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: Gap.sm),
            const Text(
              'Cuando compres algo, acá vas a poder seguir tu pedido.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColor.textoSuave, fontSize: 14, height: 1.45),
            ),
          ],
        ),
      ),
    );
  }
}

class _Titulo extends StatelessWidget {
  const _Titulo(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Text(
      texto.toUpperCase(),
      style: const TextStyle(
        fontSize: 11.5,
        fontWeight: FontWeight.w700,
        color: AppColor.textoDebil,
        letterSpacing: 0.8,
      ),
    );
  }
}

class _Error extends StatelessWidget {
  const _Error({required this.mensaje, required this.onReintentar});
  final String mensaje;
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_rounded, size: 32, color: AppColor.textoDebil),
            const SizedBox(height: Gap.md),
            Text(
              mensaje,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColor.textoSuave, fontSize: 14),
            ),
            const SizedBox(height: Gap.lg),
            OutlinedButton(onPressed: onReintentar, child: const Text('Reintentar')),
          ],
        ),
      ),
    );
  }
}
