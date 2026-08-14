import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../data/live_api.dart';
import '../domain/live_models.dart';

/// La tienda completa, como hoja sobre el vivo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ES UNA HOJA Y NO UNA PANTALLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// `showModalBottomSheet` deja la pantalla del vivo **montada abajo**. El video
/// sigue corriendo, LiveKit no se desconecta, el chat sigue llegando. Con un
/// `Navigator.push` a una ruta de catálogo el vivo se desmontaría: al volver
/// habría que reconectar, esperar el primer cuadro otra vez, y perder los
/// mensajes de ese rato.
///
/// La hoja arranca al 75% de la pantalla, no al 100%: la franja de video que
/// queda arriba es el recordatorio de que el vivo sigue ahí. Ocupar todo se
/// siente como haberse ido.
///
/// ─── Devuelve un id, no un producto ───
///
/// Al elegir, esta hoja se cierra devolviendo el `productId` y quien la abrió
/// sigue con el flujo de compra. Así el catálogo no conoce nada de reservas,
/// variantes ni pagos: sólo muestra y elige.
class ShopSheet extends ConsumerStatefulWidget {
  const ShopSheet({super.key, required this.storeId, required this.nombreTienda});

  final String storeId;
  final String nombreTienda;

  /// Devuelve el `productId` elegido, o `null` si se cerró sin elegir.
  static Future<String?> mostrar(
    BuildContext context, {
    required String storeId,
    required String nombreTienda,
  }) {
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      // Un velo tenue: el vivo se sigue viendo detrás. Con el velo por omisión
      // —negro al 60%— la franja de arriba queda casi opaca y la hoja se siente
      // como haber salido del vivo.
      barrierColor: Colors.black38,
      /**
       * Alto fijo, no `DraggableScrollableSheet`.
       *
       * El arrastrable exige que la lista de adentro use SU `ScrollController`,
       * y esta hoja necesita el propio para el scroll infinito. Compartir uno
       * solo mezcla dos responsabilidades —expandir la hoja y pedir la página
       * siguiente— sobre el mismo gesto, y el catálogo termina pidiendo páginas
       * cuando alguien sólo quería agrandar el panel.
       */
      builder: (ctx) => SizedBox(
        height: MediaQuery.sizeOf(ctx).height * 0.78,
        child: ShopSheet(storeId: storeId, nombreTienda: nombreTienda),
      ),
    );
  }

  @override
  ConsumerState<ShopSheet> createState() => _ShopSheetState();
}

class _ShopSheetState extends ConsumerState<ShopSheet> {
  final _scroll = ScrollController();
  final _buscador = TextEditingController();

  final List<ItemDeCatalogo> _items = [];
  String? _cursor;
  bool _cargando = true;
  bool _cargandoMas = false;
  bool _hayMas = true;
  Object? _error;

  /// La búsqueda vigente. Ver `_buscar()`.
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
    return Container(
      decoration: const BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.vertical(top: Radius.circular(Redondeo.xl)),
      ),
      child: Column(
        children: [
          const SizedBox(height: Gap.sm),
          Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: AppColor.borde,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.md, Gap.sm, Gap.sm),
            child: Row(
              children: [
                const Icon(Icons.storefront_rounded, size: 19, color: AppColor.acento),
                const SizedBox(width: Gap.sm),
                Expanded(
                  child: Text(
                    widget.nombreTienda.isEmpty ? 'Tienda' : widget.nombreTienda,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w800),
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close_rounded, size: 20),
                  color: AppColor.textoSuave,
                ),
              ],
            ),
          ),

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
      ),
    );
  }

  Widget _cuerpo() {
    if (_cargando) return const Center(child: CircularProgressIndicator());

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
      padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.xxl),
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
          onTap: item.agotado ? null : () => Navigator.of(context).pop(item.id),
        );
      },
    );
  }
}

class _Tarjeta extends StatelessWidget {
  const _Tarjeta({required this.item, this.onTap});

  final ItemDeCatalogo item;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
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
