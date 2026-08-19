import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../core/network/errores_de_red.dart';
import '../../../core/network/reintentar_al_volver_la_red.dart';
import '../../../shared/widgets/app_snack.dart';
import '../data/ajustes_en_vuelo.dart';
import '../data/inventory_repository.dart';
import '../domain/inventory_models.dart';
import '../domain/stock_optimista.dart';

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
class StockScreen extends ConsumerStatefulWidget {
  const StockScreen({super.key, required this.productId, required this.nombreProducto});

  final String productId;
  final String nombreProducto;

  @override
  ConsumerState<StockScreen> createState() => _StockScreenState();
}

class _StockScreenState extends ConsumerState<StockScreen> {
  /// ═══════════════════════════════════════════════════════════════════════════
  /// ESTA PANTALLA YA NO GUARDA NADA
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Los toques pendientes viven en `ajustesEnVueloProvider`, que está en el
  /// contenedor de Riverpod y sobrevive a salir del stock, entrar a Mi tienda y
  /// volver.
  ///
  /// Antes vivían acá, y eso producía el bug medido en un teléfono real: subir
  /// 10 unidades y salir enseguida tardaba ~15 segundos en verse, y una baja
  /// posterior ~35. Al salir, el `dispose()` mandaba el delta y ahí moría todo:
  /// no quedaba nadie para invalidar el provider cuando llegara la respuesta, y
  /// `stockDeProductoProvider` —que no es `autoDispose`— seguía devolviendo el
  /// valor cacheado de la primera visita.
  ///
  /// Lo único que queda acá es qué variante está bloqueada mientras se escribe
  /// una cantidad exacta, que es puramente visual.
  String? _fijando;

  void _ajustar(StockVariante variante, int delta) {
    final destino = variante.onHand + delta;
    if (destino < 0) return;

    // No se deja bajar por debajo de lo reservado desde la interfaz: el backend
    // lo rechazaría igual, pero avisarlo acá explica POR QUÉ en vez de mostrar
    // un error después de tocar.
    if (destino < variante.reserved) {
      AppSnack.info(
        context,
        'Hay ${variante.reserved} apartadas por compradores. No podés bajar de ahí.',
      );
      return;
    }

    // El toque háptico no se espera: es una respuesta al dedo, no parte del
    // guardado. Esperarlo retrasaría la petición sin motivo.
    unawaited(HapticFeedback.selectionClick());

    ref.read(ajustesEnVueloProvider.notifier).tocar(
          productId: widget.productId,
          variantId: variante.variantId,
          delta: delta,
          destino: destino,
        );
  }

  Future<void> _fijarCantidad(StockVariante variante, int nuevo) async {
    setState(() => _fijando = variante.variantId);
    try {
      await ref.read(ajustesEnVueloProvider.notifier).fijar(
            productId: widget.productId,
            variantId: variante.variantId,
            cantidad: nuevo,
          );
    } catch (e) {
      if (mounted) AppSnack.error(context, mensajeDeError(e));
    } finally {
      if (mounted) setState(() => _fijando = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final productId = widget.productId;
    final nombreProducto = widget.nombreProducto;
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
        error: (e, _) {
          void recargar() => ref.invalidate(stockDeProductoProvider(productId));
          return ReintentarAlVolverLaRed(
            error: e,
            onReintentar: recargar,
            child: _Error(mensaje: mensajeDeError(e), onReintentar: recargar),
          );
        },
        data: (s) {
          /**
           * ⚠️ ACÁ SE ARMA LA ÚNICA VERDAD DE LA PANTALLA.
           *
           * El resumen y las filas leen de `vista`. No pueden discrepar aunque
           * alguien mañana se olvide de refrescar uno de los dos: no hay dos
           * lugares de donde leer.
           *
           * Los ajustes de las variantes que ya no tienen trabajo pendiente se
           * descartan —manda el servidor— pero los de las que SÍ lo tienen se
           * conservan: si no, la respuesta de una petición anterior pisaría los
           * toques que la persona dio mientras esa petición viajaba, y el
           * número saltaría hacia atrás bajo el dedo.
           */
          final enVuelo = ref.watch(ajustesEnVueloProvider);
          final notifier = ref.read(ajustesEnVueloProvider.notifier);

          // Las claves del servicio llevan el productId adelante; acá sólo
          // interesan las de este producto.
          final ajustes = {
            for (final v in s.variants)
              if (enVuelo[claveDe(productId, v.variantId)] != null)
                v.variantId: enVuelo[claveDe(productId, v.variantId)]!,
          };

          final vista = StockOptimista(delServidor: s, ajustes: ajustes).conDatosDelServidor(
            s,
            (variantId) => notifier.sigueEnCurso(productId, variantId),
          );

          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(stockDeProductoProvider(productId)),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, Gap.xxl),
              children: [
                _Resumen(vista: vista),
                const SizedBox(height: Gap.xl),
                if (!vista.esSimple) ...[
                  const _Titulo('Por variante'),
                  const SizedBox(height: Gap.sm),
                ],
                for (final v in vista.variantes)
                  Padding(
                    padding: const EdgeInsets.only(bottom: Gap.md),
                    child: _FilaStock(
                      variante: v,
                      mostrarTitulo: !vista.esSimple,
                      bloqueada: _fijando == v.variantId,
                      onAjustar: (delta) => _ajustar(v, delta),
                      onFijar: (cantidad) => _fijarCantidad(v, cantidad),
                    ),
                  ),
                const SizedBox(height: Gap.lg),
                const _NotaReservas(),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _Resumen extends StatelessWidget {
  const _Resumen({required this.vista});
  final StockOptimista vista;

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
          _Dato(etiqueta: 'Total', valor: vista.totalOnHand, destacado: true),
          _Separador(),
          _Dato(
            etiqueta: 'Reservadas',
            valor: vista.totalReservado,
            color: vista.totalReservado > 0 ? AppColor.alerta : null,
          ),
          _Separador(),
          _Dato(
            etiqueta: 'Disponibles',
            valor: vista.totalDisponible,
            color: vista.totalDisponible <= 0 ? AppColor.error : AppColor.exito,
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
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SIN ESTADO PROPIO, Y ESA ES LA CORRECCIÓN
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Antes esta fila guardaba su propio valor optimista y disparaba sus propias
/// peticiones. Como el resumen de arriba leía los datos del servidor, la
/// pantalla se contradecía a sí misma: la fila mostraba 14 mientras el resumen
/// insistía con «Total 9».
///
/// Ahora sólo dibuja lo que recibe y avisa lo que el dedo hizo. El estado vive
/// en `_StockScreenState`, que es lo que hace imposible que las dos partes de
/// la misma pantalla muestren números distintos.
class _FilaStock extends StatelessWidget {
  const _FilaStock({
    required this.variante,
    required this.mostrarTitulo,
    required this.bloqueada,
    required this.onAjustar,
    required this.onFijar,
  });

  /// Ya viene con el valor optimista aplicado. Ver `StockOptimista`.
  final StockVariante variante;
  final bool mostrarTitulo;

  /// Mientras se escribe una cantidad exacta, los pasos no se pueden tocar:
  /// mezclarlos daría un resultado que depende de qué petición llegue antes.
  final bool bloqueada;

  final void Function(int delta) onAjustar;
  final void Function(int cantidad) onFijar;

  @override
  Widget build(BuildContext context) {
    final disponible = variante.available;

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
              mainAxisSize: MainAxisSize.min,
              children: [
                if (mostrarTitulo)
                  Text(
                    variante.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                  )
                else
                  const Text(
                    'Unidades',
                    style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                  ),
                const SizedBox(height: 2),
                Text(
                  variante.reserved > 0
                      ? '$disponible disponibles · ${variante.reserved} apartadas'
                      : '$disponible disponibles',
                  style: TextStyle(
                    fontSize: 12.5,
                    color: disponible <= 0 ? AppColor.error : AppColor.textoSuave,
                  ),
                ),
              ],
            ),
          ),
          _BotonPaso(
            icono: Icons.remove_rounded,
            onTap: bloqueada || variante.onHand <= 0 ? null : () => onAjustar(-1),
          ),
          GestureDetector(
            onTap: bloqueada ? null : () => _pedirCantidad(context),
            child: Container(
              width: 56,
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Text(
                '${variante.onHand}',
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w700,
                  color: bloqueada ? AppColor.textoDebil : AppColor.texto,
                ),
              ),
            ),
          ),
          _BotonPaso(
            icono: Icons.add_rounded,
            // ⚠️ NO se apaga mientras una petición viaja. Ése era el problema
            // original: para pasar de 1 a 5 había que tocar, esperar la red,
            // tocar. Los toques se acumulan y salen consolidados.
            onTap: bloqueada ? null : () => onAjustar(1),
          ),
        ],
      ),
    );
  }

  Future<void> _pedirCantidad(BuildContext context) async {
    final nuevo = await showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColor.superficieAlta,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Redondeo.lg)),
      ),
      builder: (_) => _HojaCantidad(
        titulo: mostrarTitulo ? variante.title : 'Unidades',
        actual: variante.onHand,
        // No se puede fijar por debajo de lo apartado: el backend lo rechaza
        // igual, y decirlo antes evita un error despues de escribir.
        minimo: variante.reserved,
      ),
    );

    if (nuevo == null || nuevo == variante.onHand) return;
    onFijar(nuevo);
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
