import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../data/inventory_repository.dart';
import '../domain/inventory_models.dart';

/// Stock de un producto.
///
/// ─── Qué puede tocar el vendedor, y qué no ───
///
/// Edita **una sola cosa**: cuántas unidades tiene. Todo lo demás —cuántas hay
/// apartadas, cuántas quedan libres— se muestra pero no se toca, porque son
/// consecuencia de lo que están haciendo los compradores en este momento.
///
/// Dejar editar "reservadas" permitiría poner cero y vender de nuevo algo que
/// otro ya tiene apartado. Por eso el campo no existe: no está deshabilitado,
/// no está.
///
/// ─── Por qué el número se edita con + y − ───
///
/// Un vendedor con el celular en una mano cuenta lo que tiene y ajusta. Un
/// campo de texto obliga a abrir el teclado numérico, borrar, escribir y
/// cerrar, y encima admite escribir 100 donde iban 10. Para los saltos grandes
/// está el campo directo, un toque más adentro.
class StockScreen extends ConsumerWidget {
  const StockScreen({super.key, required this.productId, required this.nombreProducto});

  final String productId;
  final String nombreProducto;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final stock = ref.watch(stockDeProductoProvider(productId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Stock'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(22),
          child: Padding(
            padding: const EdgeInsets.only(left: Gap.lg, right: Gap.lg, bottom: Gap.sm),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                nombreProducto,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13, color: AppColor.textoSuave),
              ),
            ),
          ),
        ),
      ),
      body: stock.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _Error(
          mensaje: e.toString(),
          onReintentar: () => ref.invalidate(stockDeProductoProvider(productId)),
        ),
        data: (s) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(stockDeProductoProvider(productId)),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, Gap.xxl),
            children: [
              _Resumen(stock: s),
              const SizedBox(height: Gap.xl),
              if (!s.esSimple) ...[
                const _Titulo('Por variante'),
                const SizedBox(height: Gap.sm),
              ],
              for (final v in s.variants)
                Padding(
                  padding: const EdgeInsets.only(bottom: Gap.md),
                  child: _FilaStock(
                    productId: productId,
                    variante: v,
                    mostrarTitulo: !s.esSimple,
                  ),
                ),
              const SizedBox(height: Gap.lg),
              const _NotaReservas(),
            ],
          ),
        ),
      ),
    );
  }
}

class _Resumen extends StatelessWidget {
  const _Resumen({required this.stock});
  final StockProducto stock;

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
          _Dato(etiqueta: 'Total', valor: stock.totalOnHand, destacado: true),
          _Separador(),
          _Dato(
            etiqueta: 'Reservadas',
            valor: stock.totalReservado,
            color: stock.totalReservado > 0 ? AppColor.alerta : null,
          ),
          _Separador(),
          _Dato(
            etiqueta: 'Disponibles',
            valor: stock.totalDisponible,
            color: stock.totalDisponible <= 0 ? AppColor.error : AppColor.exito,
          ),
        ],
      ),
    );
  }
}

class _Dato extends StatelessWidget {
  const _Dato({
    required this.etiqueta,
    required this.valor,
    this.color,
    this.destacado = false,
  });

  final String etiqueta;
  final int valor;
  final Color? color;
  final bool destacado;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        children: [
          Text(
            '$valor',
            style: TextStyle(
              fontSize: destacado ? 26 : 22,
              fontWeight: FontWeight.w700,
              color: color ?? AppColor.texto,
              letterSpacing: -0.5,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            etiqueta,
            style: const TextStyle(fontSize: 11.5, color: AppColor.textoDebil),
          ),
        ],
      ),
    );
  }
}

class _Separador extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(width: 1, height: 34, color: AppColor.borde);
  }
}

/// Una variante con su control de stock.
class _FilaStock extends ConsumerStatefulWidget {
  const _FilaStock({
    required this.productId,
    required this.variante,
    required this.mostrarTitulo,
  });

  final String productId;
  final StockVariante variante;
  final bool mostrarTitulo;

  @override
  ConsumerState<_FilaStock> createState() => _FilaStockState();
}

class _FilaStockState extends ConsumerState<_FilaStock> {
  bool _guardando = false;

  /// Valor que se ve mientras la petición viaja.
  ///
  /// Sin esto, tocar `+` no hace nada visible hasta que responde el servidor, y
  /// la persona toca otra vez. Se muestra el valor optimista y se corrige si el
  /// backend dice otra cosa.
  int? _optimista;

  int get _mostrado => _optimista ?? widget.variante.onHand;

  @override
  void didUpdateWidget(_FilaStock anterior) {
    super.didUpdateWidget(anterior);
    // Llegó dato nuevo del servidor: manda ese.
    if (anterior.variante.onHand != widget.variante.onHand) _optimista = null;
  }

  Future<void> _ajustar(int delta) async {
    final destino = _mostrado + delta;
    if (destino < 0) return;

    // No se deja bajar por debajo de lo reservado desde la interfaz: el backend
    // lo rechazaría igual, pero avisarlo acá explica POR QUÉ en vez de mostrar
    // un error después de tocar.
    if (destino < widget.variante.reserved) {
      AppSnack.info(
        context,
        'Hay ${widget.variante.reserved} apartadas por compradores. No podés bajar de ahí.',
      );
      return;
    }

    // El toque háptico no se espera: es una respuesta al dedo, no parte del
    // guardado. Esperarlo retrasaría la petición sin motivo.
    unawaited(HapticFeedback.selectionClick());
    setState(() {
      _optimista = destino;
      _guardando = true;
    });

    try {
      await ref.read(inventoryRepositoryProvider).ajustarStock(
            productId: widget.productId,
            variantId: widget.variante.variantId,
            delta: delta,
          );
      ref.invalidate(stockDeProductoProvider(widget.productId));
    } catch (e) {
      if (mounted) {
        setState(() => _optimista = null);
        AppSnack.error(context, e.toString());
      }
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  Future<void> _escribirCantidad() async {
    final nuevo = await showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _HojaCantidad(
        titulo: widget.mostrarTitulo ? widget.variante.title : 'Stock',
        actual: _mostrado,
        minimo: widget.variante.reserved,
      ),
    );
    if (nuevo == null || !mounted || nuevo == widget.variante.onHand) return;

    setState(() {
      _optimista = nuevo;
      _guardando = true;
    });

    try {
      await ref.read(inventoryRepositoryProvider).fijarStock(
            productId: widget.productId,
            variantId: widget.variante.variantId,
            onHand: nuevo,
          );
      ref.invalidate(stockDeProductoProvider(widget.productId));
    } catch (e) {
      if (mounted) {
        setState(() => _optimista = null);
        AppSnack.error(context, e.toString());
      }
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.variante;
    final disponible = _mostrado - v.reserved;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: Gap.md),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(
          color: disponible <= 0 ? AppColor.error.withValues(alpha: 0.35) : AppColor.borde,
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (widget.mostrarTitulo)
                  Text(
                    v.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: v.activa ? AppColor.texto : AppColor.textoDebil,
                    ),
                  )
                else
                  const Text(
                    'Unidades',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                  ),
                const SizedBox(height: 3),
                // Sólo se menciona lo apartado cuando existe: en el 95 % de los
                // casos es cero y el dato sería ruido.
                Text(
                  v.reserved > 0
                      ? '$disponible disponibles · ${v.reserved} apartadas'
                      : (disponible <= 0 ? 'Sin stock' : '$disponible disponibles'),
                  style: TextStyle(
                    fontSize: 12.5,
                    color: v.reserved > 0
                        ? AppColor.alerta
                        : (disponible <= 0 ? AppColor.error : AppColor.textoSuave),
                  ),
                ),
              ],
            ),
          ),
          _BotonPaso(
            icono: Icons.remove_rounded,
            onTap: _guardando || _mostrado <= 0 ? null : () => _ajustar(-1),
          ),
          GestureDetector(
            onTap: _guardando ? null : _escribirCantidad,
            child: Container(
              width: 56,
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Text(
                '$_mostrado',
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w700,
                  color: _guardando ? AppColor.textoDebil : AppColor.texto,
                ),
              ),
            ),
          ),
          _BotonPaso(
            icono: Icons.add_rounded,
            onTap: _guardando ? null : () => _ajustar(1),
          ),
        ],
      ),
    );
  }
}

class _BotonPaso extends StatelessWidget {
  const _BotonPaso({required this.icono, this.onTap});
  final IconData icono;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final activo = onTap != null;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Redondeo.sm),
      child: Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          color: AppColor.superficieAlta,
          borderRadius: BorderRadius.circular(Redondeo.sm),
        ),
        child: Icon(
          icono,
          size: 20,
          color: activo ? AppColor.texto : AppColor.textoDebil,
        ),
      ),
    );
  }
}

class _HojaCantidad extends StatefulWidget {
  const _HojaCantidad({
    required this.titulo,
    required this.actual,
    required this.minimo,
  });

  final String titulo;
  final int actual;
  final int minimo;

  @override
  State<_HojaCantidad> createState() => _HojaCantidadState();
}

class _HojaCantidadState extends State<_HojaCantidad> {
  late final _ctrl = TextEditingController(text: '${widget.actual}');

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: Gap.xl,
        right: Gap.xl,
        top: Gap.sm,
        bottom: MediaQuery.viewInsetsOf(context).bottom + Gap.xl,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(widget.titulo, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: Gap.lg),
          TextField(
            controller: _ctrl,
            autofocus: true,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: InputDecoration(
              labelText: 'Unidades',
              helperText: widget.minimo > 0
                  ? 'Mínimo ${widget.minimo}: hay compradores con unidades apartadas'
                  : null,
            ),
            onSubmitted: (_) => _guardar(),
          ),
          const SizedBox(height: Gap.lg),
          FilledButton(onPressed: _guardar, child: const Text('Guardar')),
        ],
      ),
    );
  }

  void _guardar() {
    final valor = int.tryParse(_ctrl.text.trim());
    if (valor == null || valor < 0) {
      AppSnack.error(context, 'Poné un número válido');
      return;
    }
    if (valor < widget.minimo) {
      AppSnack.error(
        context,
        'No podés bajar de ${widget.minimo}: hay unidades apartadas por compradores',
      );
      return;
    }
    Navigator.of(context).pop(valor);
  }
}

/// Explica qué son las reservadas, una sola vez y al final.
class _NotaReservas extends StatelessWidget {
  const _NotaReservas();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.md),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.md),
      ),
      child: const Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline_rounded, size: 16, color: AppColor.textoDebil),
          SizedBox(width: Gap.sm),
          Expanded(
            child: Text(
              'Las unidades apartadas son de compradores que están terminando la '
              'compra. Si no la completan, vuelven solas a estar disponibles.',
              style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave, height: 1.4),
            ),
          ),
        ],
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
