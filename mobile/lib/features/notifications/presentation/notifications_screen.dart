import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../core/network/reintentar_al_volver_la_red.dart';
import '../../../shared/widgets/app_snack.dart';
import '../data/notifications_api.dart';
import '../domain/notification_models.dart';

/// El centro de notificaciones.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// NO DEPENDE DE LOS PUSH
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La mayoría de la gente tiene las notificaciones del sistema apagadas. Si el
/// único canal fuera el push, a la mayoría de nuestros usuarios no le avisamos
/// nada nunca.
///
/// Acá está todo lo que pasó, haya llegado el push o no. Es la fuente, y el
/// push es el atajo.
class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key, this.onAbrir});

  /// Qué hacer al tocar un aviso.
  ///
  /// Lo decide quien la muestra y no esta pantalla: la navegación depende de
  /// dónde esté montada, y una pantalla de lista que sepa armar rutas a pedidos,
  /// productos y vivos termina importando media app.
  final void Function(Aviso aviso)? onAbrir;

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  final _scroll = ScrollController();

  List<Aviso> _items = const [];
  String? _cursor;
  bool _cargando = true;
  bool _cargandoMas = false;
  bool _hayMas = true;
  String? _error;

  /// El error tal como vino, sÃ³lo para decidir si se reintenta solo.
  ///
  /// â ï¸ Nunca se muestra: lo que lee la persona es , que es una frase
  /// escrita a mano. Esto existe porque un fallo de red se reintenta cuando
  /// vuelve la seÃ±al y un 409 no.
  Object? _errorCrudo;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_alDesplazar);
    unawaited(_cargar());
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _alDesplazar() {
    // 400 px antes del final: da tiempo a que la página llegue sin que la lista
    // se corte, que es lo que hace que un scroll se sienta trabado.
    if (_scroll.position.pixels >= _scroll.position.maxScrollExtent - 400) {
      unawaited(_cargarMas());
    }
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });

    try {
      final pagina = await ref.read(notificationsApiProvider).listar();
      if (!mounted) return;
      setState(() {
        _items = pagina.items;
        _cursor = pagina.nextCursor;
        _hayMas = pagina.nextCursor != null;
        _cargando = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _cargando = false;
        _error = 'No pudimos traer tus avisos.';
        // El error crudo NO se muestra: se guarda para saber si conviene
        // reintentar solo cuando vuelva la red. Ver ReintentarAlVolverLaRed.
        _errorCrudo = e;
      });
    }
  }

  Future<void> _cargarMas() async {
    if (_cargandoMas || !_hayMas || _cursor == null) return;
    setState(() => _cargandoMas = true);

    try {
      final pagina = await ref.read(notificationsApiProvider).listar(cursor: _cursor);
      if (!mounted) return;
      setState(() {
        _items = [..._items, ...pagina.items];
        _cursor = pagina.nextCursor;
        _hayMas = pagina.nextCursor != null;
        _cargandoMas = false;
      });
    } catch (_) {
      if (!mounted) return;
      // Sin cartel: la lista que ya está sigue sirviendo. Se reintenta solo al
      // volver a desplazar.
      setState(() => _cargandoMas = false);
    }
  }

  /// Marca uno como leído y navega.
  ///
  /// ─── El número baja antes de que el servidor conteste ───
  ///
  /// Es una operación que no puede fallar de una forma que le importe a nadie:
  /// lo peor que pasa es que el aviso siga sin leer del otro lado y vuelva a
  /// aparecer en negrita la próxima vez. Esperar la respuesta para pintar la
  /// fila haría que tocar un aviso se sienta lento por nada.
  Future<void> _abrir(Aviso aviso) async {
    if (aviso.sinLeer) {
      setState(() {
        _items = [
          for (final a in _items) a.id == aviso.id ? a.comoLeido(DateTime.now()) : a,
        ];
      });
      unawaited(
        ref
            .read(notificationsApiProvider)
            .marcarLeida(aviso.id)
            .then((_) => ref.invalidate(avisosSinLeerProvider))
            .catchError((_) {}),
      );
    }

    widget.onAbrir?.call(aviso);
  }

  Future<void> _marcarTodas() async {
    final antes = _items;
    final ahora = DateTime.now();
    setState(() => _items = [for (final a in _items) a.comoLeido(ahora)]);

    try {
      await ref.read(notificationsApiProvider).marcarTodasLeidas();
      ref.invalidate(avisosSinLeerProvider);
    } catch (_) {
      if (!mounted) return;
      // Acá sí se deshace: la persona apretó un botón a propósito y tiene que
      // saber que no pasó. Al revés, la próxima vez que abra vería todo en
      // negrita otra vez sin entender por qué.
      setState(() => _items = antes);
      AppSnack.error(context, 'No pudimos marcarlos como leídos.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final sinLeer = _items.where((a) => a.sinLeer).length;

    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(
        title: const Text('Avisos'),
        actions: [
          if (sinLeer > 0)
            TextButton(
              onPressed: _marcarTodas,
              child: const Text('Marcar leídos'),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _cuerpo(),
      ),
    );
  }

  Widget _cuerpo() {
    if (_cargando) return const Center(child: CircularProgressIndicator());

    if (_error != null) {
      return ReintentarAlVolverLaRed(
        error: _errorCrudo,
        onReintentar: () => unawaited(_cargar()),
        child: _Centrado(
          icono: Icons.wifi_off_rounded,
          titulo: _error!,
          accion: TextButton(onPressed: _cargar, child: const Text('Reintentar')),
        ),
      );
    }

    if (_items.isEmpty) {
      // Una lista vacía en una app nueva es lo NORMAL, no un error. El texto lo
      // dice sin dramatismo y explica qué va a aparecer acá.
      return const _Centrado(
        icono: Icons.notifications_none_rounded,
        titulo: 'Todavía no hay avisos',
        detalle: 'Acá te vamos a contar cuando una tienda abra, cuando avance '
            'un pedido tuyo y cuando alguien que seguís empiece un vivo.',
      );
    }

    return ListView.separated(
      controller: _scroll,
      // `always` para que se pueda tirar a refrescar aunque la lista sea corta.
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(vertical: Gap.sm),
      itemCount: _items.length + (_cargandoMas ? 1 : 0),
      separatorBuilder: (_, __) => const Divider(height: 1, color: AppColor.borde),
      itemBuilder: (_, i) {
        if (i >= _items.length) {
          return const Padding(
            padding: EdgeInsets.all(Gap.lg),
            child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
          );
        }
        return _Fila(aviso: _items[i], onTap: () => _abrir(_items[i]));
      },
    );
  }
}

class _Fila extends StatelessWidget {
  const _Fila({required this.aviso, required this.onTap});

  final Aviso aviso;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        // El fondo apenas distinto es lo que hace que un no leído se distinga
        // de un vistazo, sin recurrir a un punto de color que hay que buscar.
        color: aviso.sinLeer ? AppColor.superficieAlta : Colors.transparent,
        padding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: Gap.md),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                color: AppColor.superficie,
                shape: BoxShape.circle,
                border: Border.all(color: AppColor.borde),
              ),
              child: Icon(_icono(aviso.tipo), size: 17, color: AppColor.textoSuave),
            ),
            const SizedBox(width: Gap.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    aviso.titulo,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: aviso.sinLeer ? FontWeight.w700 : FontWeight.w500,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    aviso.cuerpo,
                    style: const TextStyle(
                      fontSize: 13,
                      color: AppColor.textoSuave,
                      height: 1.35,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    _cuando(aviso.fecha),
                    style: const TextStyle(fontSize: 11.5, color: AppColor.textoDebil),
                  ),
                ],
              ),
            ),
            if (aviso.sinLeer)
              Container(
                margin: const EdgeInsets.only(left: Gap.sm, top: 6),
                width: 7,
                height: 7,
                decoration: const BoxDecoration(color: AppColor.acento, shape: BoxShape.circle),
              ),
          ],
        ),
      ),
    );
  }

  /// Un ícono por tipo, y uno genérico para los que la app no conoce.
  ///
  /// El `default` importa: un tipo nuevo del backend no puede hacer que la fila
  /// no se dibuje. El título y el cuerpo ya vienen escritos, así que el aviso se
  /// entiende igual aunque la app no sepa qué es.
  IconData _icono(String tipo) {
    switch (tipo) {
      case 'STORE_REOPENED':
        return Icons.storefront_outlined;
      case 'LIVE_STARTED':
        return Icons.videocam_outlined;
      case 'ORDER_STATUS':
      case 'ORDER_RECEIVED':
        return Icons.local_shipping_outlined;
      case 'PAYMENT_APPROVED':
        return Icons.check_circle_outline_rounded;
      case 'PAYMENT_REJECTED':
        return Icons.error_outline_rounded;
      case 'SUPPORT_REPLY':
        return Icons.support_agent_rounded;
      default:
        return Icons.notifications_none_rounded;
    }
  }

  /// "Hace 5 min", "Ayer", "14/8".
  ///
  /// Relativo cerca y absoluto lejos: "hace 47 días" no le dice nada a nadie, y
  /// "14/8" a las dos horas obliga a calcular.
  String _cuando(DateTime fecha) {
    final diferencia = DateTime.now().difference(fecha);

    if (diferencia.inMinutes < 1) return 'Recién';
    if (diferencia.inMinutes < 60) return 'Hace ${diferencia.inMinutes} min';
    if (diferencia.inHours < 24) return 'Hace ${diferencia.inHours} h';
    if (diferencia.inDays == 1) return 'Ayer';
    if (diferencia.inDays < 7) return 'Hace ${diferencia.inDays} días';
    return '${fecha.day}/${fecha.month}';
  }
}

class _Centrado extends StatelessWidget {
  const _Centrado({required this.icono, required this.titulo, this.detalle, this.accion});

  final IconData icono;
  final String titulo;
  final String? detalle;
  final Widget? accion;

  @override
  Widget build(BuildContext context) {
    // `ListView` y no `Center`: hace falta que se pueda tirar hacia abajo para
    // refrescar incluso cuando no hay nada que mostrar.
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(horizontal: Gap.xl, vertical: 120),
      children: [
        Icon(icono, size: 44, color: AppColor.textoDebil),
        const SizedBox(height: Gap.lg),
        Text(
          titulo,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
        if (detalle != null) ...[
          const SizedBox(height: Gap.sm),
          Text(
            detalle!,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.45),
          ),
        ],
        if (accion != null) ...[
          const SizedBox(height: Gap.lg),
          Center(child: accion),
        ],
      ],
    );
  }
}
