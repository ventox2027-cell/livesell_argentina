import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens.dart';
import '../../../moderation/presentation/reportar_sheet.dart';
import '../../data/live_api.dart';
import '../../domain/live_models.dart';

/// El catálogo de una tienda: buscador, grilla y scroll infinito.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// UNA SOLA VIDRIERA PARA TODA LA APP
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La tienda se abre desde el vivo y desde el perfil del vendedor, y antes cada
/// camino tenía su propia copia. Dos catálogos con la misma pinta es cómo se
/// llega a que uno filtre agotados y el otro no, sin que nadie se entere hasta
/// que un comprador lo cuenta.
///
/// Este widget sólo muestra y avisa qué se eligió. No sabe de reservas, ni de
/// variantes, ni de pagos: quien lo usa decide qué hacer con el `productId`.
class CatalogoDeTienda extends ConsumerStatefulWidget {
  const CatalogoDeTienda({
    super.key,
    required this.storeId,
    required this.onElegir,
    this.padding = const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.xxl),
  });

  final String storeId;

  /// Se tocó un producto que se puede comprar.
  final void Function(String productId) onElegir;

  final EdgeInsets padding;

  @override
  ConsumerState<CatalogoDeTienda> createState() => _CatalogoDeTiendaState();
}

class _CatalogoDeTiendaState extends ConsumerState<CatalogoDeTienda> {
  final _scroll = ScrollController();
  final _buscador = TextEditingController();

  final List<ItemDeCatalogo> _items = [];
  String? _cursor;
  bool _cargando = true;
  bool _cargandoMas = false;
  bool _hayMas = true;
  Object? _error;

  /// La búsqueda vigente. Ver [_buscar].
  String _consulta = '';
  Timer? _rebote;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_alDesplazar);
    unawaited(_cargarPrimera());
  }

  @override
  void dispose() {
    _rebote?.cancel();
    _scroll.dispose();
    _buscador.dispose();
    super.dispose();
  }

  void _alDesplazar() {
    // Se pide la página siguiente 400 píxeles antes del final: si se esperara a
    // tocar fondo, siempre habría un hueco visible mientras llega.
    if (!_scroll.hasClients || _cargandoMas || !_hayMas) return;
    final falta = _scroll.position.maxScrollExtent - _scroll.position.pixels;
    if (falta < 400) unawaited(_cargarMas());
  }

  Future<void> _cargarPrimera() async {
    setState(() {
      _cargando = true;
      _error = null;
    });

    try {
      final pagina = await ref.read(liveApiProvider).catalogo(
            widget.storeId,
            q: _consulta.isEmpty ? null : _consulta,
          );
      if (!mounted) return;

      setState(() {
        _items
          ..clear()
          ..addAll(pagina.items);
        _cursor = pagina.siguienteCursor;
        _hayMas = pagina.siguienteCursor != null;
        _cargando = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _cargando = false;
      });
    }
  }

  Future<void> _cargarMas() async {
    final cursor = _cursor;
    if (cursor == null) return;

    setState(() => _cargandoMas = true);

    /**
     * La consulta se captura ANTES de pedir.
     *
     * Sin esto: alguien escribe "vela", empieza a bajar, y mientras la página
     * dos viaja borra el texto. Al llegar, la respuesta —que son velas— se
     * agregaría a una lista que ya muestra el catálogo entero. Quedarían velas
     * repetidas en el medio de la nada.
     */
    final consultaDelPedido = _consulta;

    try {
      final pagina = await ref.read(liveApiProvider).catalogo(
            widget.storeId,
            cursor: cursor,
            q: consultaDelPedido.isEmpty ? null : consultaDelPedido,
          );
      if (!mounted || consultaDelPedido != _consulta) return;

      setState(() {
        _items.addAll(pagina.items);
        _cursor = pagina.siguienteCursor;
        _hayMas = pagina.siguienteCursor != null;
      });
    } catch (_) {
      // Una página que falla no rompe lo que ya se ve. Se corta la paginación
      // para no reintentar en bucle contra un backend caído.
      if (mounted) setState(() => _hayMas = false);
    } finally {
      if (mounted) setState(() => _cargandoMas = false);
    }
  }

  /// Busca con un respiro de 350 ms.
  ///
  /// Sin el rebote, "campera" son siete peticiones y las respuestas pueden
  /// llegar desordenadas: la de "camp" después de la de "campera" dejaría en
  /// pantalla resultados que no corresponden a lo escrito.
  void _buscar(String texto) {
    _rebote?.cancel();
    _rebote = Timer(const Duration(milliseconds: 350), () {
      if (!mounted || texto.trim() == _consulta) return;
      _consulta = texto.trim();
      unawaited(_cargarPrimera());
    });
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Gap.lg),
          child: TextField(
            controller: _buscador,
            onChanged: _buscar,
            textInputAction: TextInputAction.search,
            style: const TextStyle(fontSize: 14.5),
            decoration: InputDecoration(
              hintText: 'Buscar en la tienda…',
              prefixIcon: const Icon(Icons.search_rounded, size: 20),
              isDense: true,
              filled: true,
              fillColor: AppColor.superficieAlta,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Redondeo.md),
                borderSide: BorderSide.none,
              ),
            ),
          ),
        ),
        const SizedBox(height: Gap.md),
        Expanded(child: _cuerpo()),
      ],
    );
  }

  Widget _cuerpo() {
    if (_cargando) return const Center(child: CircularProgressIndicator());

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TRES SITUACIONES DISTINTAS, TRES PANTALLAS DISTINTAS
     * ═══════════════════════════════════════════════════════════════════════
     *
     *   · **vidriera apagada** — la tienda existe y el vendedor la cerró al
     *     público. No se ofrece reintentar: no se arregla reintentando, y un
     *     botón que nunca va a funcionar es peor que ninguno.
     *   · **no se pudo cargar** — red o servidor. Ahí sí se reintenta.
     *   · **sin productos** — la vidriera está abierta y no hay nada adentro.
     *
     * Antes las tres se veían igual de mal: como `ApiClient` no lanza con 4xx,
     * el cuerpo del 404 entraba al parseo y salía una página vacía, así que una
     * vidriera apagada decía «todavía no tiene productos».
     */
    if (_error is VidrieraApagada) {
      return const _Vacio(
        icono: Icons.storefront_outlined,
        titulo: 'Vidriera no disponible',
        detalle: 'Esta tienda no tiene su vidriera disponible por el momento.',
      );
    }

    if (_error is TiendaNoEncontrada) {
      return const _Vacio(
        icono: Icons.storefront_outlined,
        titulo: 'No encontramos esta tienda',
        detalle: 'El enlace puede ser viejo, o la tienda ya no está disponible.',
      );
    }

    if (_error != null) {
      return _Vacio(
        icono: Icons.wifi_off_rounded,
        titulo: 'No pudimos abrir la tienda',
        detalle: 'Revisá tu conexión y probá de nuevo.',
        accion: ('Reintentar', () => unawaited(_cargarPrimera())),
      );
    }

    if (_items.isEmpty) {
      return _Vacio(
        icono: _consulta.isEmpty ? Icons.inventory_2_outlined : Icons.search_off_rounded,
        titulo: _consulta.isEmpty ? 'La tienda todavía no tiene productos' : 'Sin resultados',
        detalle: _consulta.isEmpty
            ? 'Cuando el vendedor cargue su catálogo, va a aparecer acá.'
            : 'No encontramos nada para "$_consulta".',
      );
    }

    return GridView.builder(
      controller: _scroll,
      padding: widget.padding,
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        crossAxisSpacing: Gap.md,
        mainAxisSpacing: Gap.md,
        // Alto que da lugar a foto cuadrada + nombre de dos líneas + precio.
        childAspectRatio: 0.66,
      ),
      // Un elemento extra para el indicador del final.
      itemCount: _items.length + (_cargandoMas ? 2 : 0),
      itemBuilder: (_, i) {
        if (i >= _items.length) {
          return const Center(
            child: SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          );
        }

        final item = _items[i];
        return _Tarjeta(
          item: item,
          // Un producto agotado se muestra igual —el catálogo es la tienda, no
          // sólo lo que hay hoy— pero no se puede elegir.
          onTap: item.agotado ? null : () => widget.onElegir(item.id),
          /**
           * Mantener apretado un producto lo reporta.
           *
           * Toque largo y no un ícono en la tarjeta: la grilla tiene dos
           * columnas y cada elemento que se agrega le come lugar a la foto,
           * que es lo que hace que alguien lo mire. El gesto ya se usa en el
           * chat, así que es consistente dentro de la app.
           */
          onMantenerApretado: () => ReportarSheet.mostrar(
            context,
            targetType: 'PRODUCT',
            targetId: item.id,
          ),
        );
      },
    );
  }
}

class _Tarjeta extends StatelessWidget {
  const _Tarjeta({required this.item, this.onTap, this.onMantenerApretado});

  final ItemDeCatalogo item;
  final VoidCallback? onTap;
  final VoidCallback? onMantenerApretado;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      onLongPress: onMantenerApretado,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(Redondeo.md),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  if (item.imagenUrl == null)
                    const ColoredBox(
                      color: AppColor.superficieAlta,
                      child: Icon(Icons.image_rounded, color: AppColor.textoDebil),
                    )
                  else
                    CachedNetworkImage(
                      imageUrl: item.imagenUrl!,
                      fit: BoxFit.cover,
                      placeholder: (_, __) => const ColoredBox(color: AppColor.superficieAlta),
                      // Ya nos tumbó una pantalla un producto con foto rota.
                      errorWidget: (_, __, ___) => const ColoredBox(
                        color: AppColor.superficieAlta,
                        child: Icon(Icons.image_rounded, color: AppColor.textoDebil),
                      ),
                    ),
                  if (item.agotado)
                    ColoredBox(
                      color: Colors.black.withValues(alpha: 0.6),
                      child: const Center(
                        child: Text(
                          'AGOTADO',
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.6,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: Gap.sm),
          Text(
            item.nombre,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 13,
              height: 1.25,
              color: item.agotado ? AppColor.textoSuave : AppColor.texto,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            plata(item.precioCentavos),
            style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800),
          ),
          // "3 opciones" avisa que hay talles o colores antes de tocar. Sin
          // esto, quien abre el panel esperando comprar directo se encuentra
          // con un paso que no anticipaba.
          if (item.variantes > 1)
            Text(
              '${item.variantes} opciones',
              style: const TextStyle(fontSize: 11.5, color: AppColor.textoSuave),
            ),
        ],
      ),
    );
  }
}

class _Vacio extends StatelessWidget {
  const _Vacio({
    required this.icono,
    required this.titulo,
    required this.detalle,
    this.accion,
  });

  final IconData icono;
  final String titulo;
  final String detalle;
  final (String, VoidCallback)? accion;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icono, size: 38, color: AppColor.textoDebil),
            const SizedBox(height: Gap.md),
            Text(titulo, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
            const SizedBox(height: Gap.xs),
            Text(
              detalle,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.4),
            ),
            if (accion != null) ...[
              const SizedBox(height: Gap.lg),
              FilledButton(onPressed: accion!.$2, child: Text(accion!.$1)),
            ],
          ],
        ),
      ),
    );
  }
}

/// Centavos a pesos, con separador de miles.
///
/// La plata viaja y se guarda en centavos enteros de punta a punta; el formato
/// es lo último que pasa, justo antes de dibujar. Un `double` en el medio
/// convierte 1999 en 19,989999999999998.
String plata(int centavos) {
  final entero = centavos ~/ 100;
  final decimales = (centavos % 100).toString().padLeft(2, '0');
  final miles = entero.toString().replaceAllMapped(
        RegExp(r'(\d)(?=(\d{3})+$)'),
        (m) => '${m[1]}.',
      );
  return '\$ $miles,$decimales';
}
