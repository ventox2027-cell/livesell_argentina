import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../core/network/errores_de_red.dart';
import '../../../core/network/reintentar_al_volver_la_red.dart';
import '../data/live_api.dart';
import '../domain/como_llegar_al_vivo.dart';
import '../domain/live_models.dart';
import 'live_viewer_screen.dart';
import 'variant_sheet.dart';
import 'widgets/catalogo_de_tienda.dart';

/// La tienda de un vendedor: su vidriera permanente.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// PERMANENTE QUIERE DECIR QUE NO DEPENDE DEL VIVO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Es la misma tienda que existe cuando el vendedor está offline, y sigue
/// existiendo cuando la transmisión termina. Alguien que llegó desde un vivo,
/// alguien que llegó desde el perfil y alguien que abrió un enlace de WhatsApp
/// ven exactamente lo mismo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ES UNA PANTALLA Y ANTES ERA UNA HOJA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La tienda se abría como `showModalBottomSheet` al 78% de la pantalla, y el
/// comentario que lo justificaba decía que con un `Navigator.push` el vivo se
/// desmontaría —LiveKit desconectado, chat perdido, primer cuadro otra vez—.
///
/// ⚠️ Eso es falso, y se midió: con el mismo centinela que usa
/// `live_compra_test.dart`, un `push` sobre una pantalla da `montajes=1,
/// desmontajes=0`. Flutter conserva las rutas de abajo; deja de pintarlas, no
/// las destruye. Volver con el botón de atrás devuelve la pantalla anterior tal
/// como estaba.
///
/// Con eso resuelto, la pantalla completa gana lo que la hoja no podía dar: el
/// catálogo entero a la vista en vez de una franja, un lugar propio al que
/// volver, y una ruta a la que un enlace puede llevar.
class TiendaScreen extends ConsumerStatefulWidget {
  /// La tienda, cuando ya sabemos cuál es.
  ///
  /// Es el caso de adentro de la app: el vivo y el perfil del vendedor ya
  /// tienen el id y el nombre en la mano, así que no hace falta preguntar nada.
  const TiendaScreen({
    super.key,
    required String this.storeId,
    required String this.nombreTienda,
    this.liveDetras,
  }) : slug = null;

  /// La tienda de un enlace: `vendox.com.ar/t/<slug>`.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// POR QUÉ EL SLUG SE RESUELVE ACÁ ADENTRO Y NO ANTES DE NAVEGAR
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Porque un enlace puede llegar con la app cerrada. `pantallaDeDestino` es
  /// una función pura y sincrónica que devuelve un `Widget`: no puede esperar
  /// una respuesta del servidor sin volverse `async`, y eso obligaría a que
  /// TODOS los destinos —producto, vivo, pedido— pasaran por un camino
  /// asincrónico que ninguno necesita.
  ///
  /// Resolviendo adentro, el enlace abre la pantalla en el mismo frame y la
  /// pantalla muestra su propio cargando. Es también lo que se ve mejor: algo
  /// pasa apenas se toca el enlace, en vez de unos segundos de nada.
  ///
  /// ⚠️ Quien traduce el slug es el BACKEND, siempre. Ahí viven las reglas de
  /// qué tienda se puede mostrar —tienda y vendedor activos—, y una copia en
  /// Dart dejaría la vidriera de un vendedor suspendido abierta para cualquiera
  /// que tenga el enlace guardado.
  const TiendaScreen.porSlug(String this.slug, {super.key})
      : storeId = null,
        nombreTienda = null,
        liveDetras = null;

  final String? storeId;
  final String? nombreTienda;

  /// El slug del enlace, cuando se llegó por uno.
  final String? slug;

  /// El vivo del que se vino, si se vino de uno.
  ///
  /// ⚠️ Es «el vivo que está ABAJO en la pila», no «el vivo del vendedor». La
  /// diferencia decide qué hace «EN VIVO»: con esto, `pop`; sin esto, abrir el
  /// visor. Ver [_VolverAlVivo].
  final String? liveDetras;

  @override
  ConsumerState<TiendaScreen> createState() => _TiendaScreenState();
}

class _TiendaScreenState extends ConsumerState<TiendaScreen> {
  /// Lo que resolvió el backend, cuando se llegó por un slug.
  TiendaPublica? _tienda;

  bool _resolviendo = false;
  Object? _error;

  @override
  void initState() {
    super.initState();
    if (widget.slug != null) unawaited(_resolverElSlug());
  }

  Future<void> _resolverElSlug() async {
    setState(() {
      _resolviendo = true;
      _error = null;
    });

    try {
      final tienda = await ref.read(liveApiProvider).tiendaPorSlug(widget.slug!);
      if (!mounted) return;
      setState(() {
        _tienda = tienda;
        _resolviendo = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _resolviendo = false;
      });
    }
  }

  /// El id de la tienda: el que vino, o el que resolvió el backend.
  String? get _storeId => widget.storeId ?? _tienda?.id;

  String get _nombre => widget.nombreTienda ?? _tienda?.nombre ?? '';

  /// Qué hace «EN VIVO», o si no se dibuja. Ver `comoLlegarAlVivo`.
  ComoLlegarAlVivo get _comoLlegar => comoLlegarAlVivo(
        liveDetras: widget.liveDetras,
        liveDelVendedor: _tienda?.liveEnCursoId,
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(
        titleSpacing: 0,
        title: Row(
          children: [
            const Icon(Icons.storefront_rounded, size: 19, color: AppColor.acento),
            const SizedBox(width: Gap.sm),
            Expanded(
              child: Text(
                _nombre.isEmpty ? 'Tienda' : _nombre,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w800),
              ),
            ),
          ],
        ),
        actions: [
          if (_comoLlegar != ComoLlegarAlVivo.nada)
            Padding(
              padding: const EdgeInsets.only(right: Gap.md),
              child: _VolverAlVivo(onTap: _irAlVivo),
            ),
        ],
      ),
      body: SafeArea(child: _cuerpo()),
    );
  }

  void _irAlVivo() {
    switch (_comoLlegar) {
      case ComoLlegarAlVivo.volverAtras:
        Navigator.of(context).pop();
      case ComoLlegarAlVivo.abrirElVisor:
        unawaited(
          Navigator.of(context).push(
            MaterialPageRoute<void>(
              // El nombre deja que un test vea a dónde se fue sin montar el
              // visor entero, que necesitaría LiveKit.
              settings: RouteSettings(name: 'vivo/${_tienda!.liveEnCursoId}'),
              builder: (_) => LiveViewerScreen(liveId: _tienda!.liveEnCursoId!),
            ),
          ),
        );
      case ComoLlegarAlVivo.nada:
        break;
    }
  }

  Widget _cuerpo() {
    if (_resolviendo) return const Center(child: CircularProgressIndicator());

    final error = _error;
    if (error != null) return _ErrorDeTienda(error: error, onReintentar: _resolverElSlug);

    final storeId = _storeId;
    if (storeId == null) return const Center(child: CircularProgressIndicator());

    return Padding(
      padding: const EdgeInsets.only(top: Gap.md),
      child: CatalogoDeTienda(
        storeId: storeId,
        onElegir: (productId) => VariantSheet.mostrar(
          context,
          productId: productId,
          storeId: storeId,
          /**
           * El precio exclusivo del vivo, sólo si se está mirando ese vivo.
           *
           * ⚠️ `liveDetras`, no `_vivoAlQueVolver`. Que el vendedor esté
           * transmitiendo no alcanza: el precio de vivo es para quien está
           * en la transmisión. Mandar el id igual se lo daría a cualquiera que
           * abra el enlace de la tienda mientras hay un vivo prendido.
           *
           * Va como id, nunca como precio: cuánto descuenta lo resuelve el
           * backend contra su propia base.
           */
          liveSessionId: widget.liveDetras,
        ),
      ),
    );
  }
}

/// No se pudo abrir la tienda del enlace.
///
/// ⚠️ Son dos casos distintos y se ven distinto. Un slug que no existe no se
/// arregla reintentando —el enlace está roto o la tienda ya no se muestra— así
/// que ofrecer un botón de reintentar ahí es hacer tocar algo que nunca va a
/// funcionar. Un fallo de red sí se reintenta, y encima solo cuando vuelve la
/// señal.
class _ErrorDeTienda extends StatelessWidget {
  const _ErrorDeTienda({required this.error, required this.onReintentar});

  final Object error;
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    if (error is TiendaNoEncontrada) {
      return const _Aviso(
        icono: Icons.storefront_outlined,
        titulo: 'No encontramos esta tienda',
        detalle: 'El enlace puede ser viejo, o la tienda ya no está disponible.',
      );
    }

    return ReintentarAlVolverLaRed(
      error: error,
      onReintentar: onReintentar,
      child: _Aviso(
        icono: Icons.wifi_off_rounded,
        titulo: 'No pudimos abrir la tienda',
        detalle: mensajeDeError(error),
        accion: ('Reintentar', onReintentar),
      ),
    );
  }
}

class _Aviso extends StatelessWidget {
  const _Aviso({
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

/// «EN VIVO», y la forma de llegar a la transmisión.
///
/// Es un botón y no sólo una etiqueta: quien está mirando el catálogo mientras
/// alguien transmite tiene que poder ir sin buscar el botón de atrás del
/// sistema, que en Android está del otro lado de la pantalla.
class _VolverAlVivo extends StatelessWidget {
  const _VolverAlVivo({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: AppColor.error,
          borderRadius: BorderRadius.circular(Redondeo.sm),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.sensors_rounded, size: 14, color: Colors.white),
            SizedBox(width: 5),
            Text(
              'EN VIVO',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.5,
                color: Colors.white,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
