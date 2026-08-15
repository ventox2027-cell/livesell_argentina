import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/social_api.dart';

/// El corazón.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SE PINTA ANTES DE QUE EL SERVIDOR CONTESTE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// En un vivo se toca mientras pasa algo. Esperar la respuesta para llenar el
/// corazón lo hace sentir roto: la persona toca, no pasa nada durante 300 ms, y
/// vuelve a tocar — que en un interruptor significa deshacer.
///
/// Así que se pinta enseguida y se corrige si el servidor dice otra cosa. Lo
/// peor que puede pasar es que el corazón parpadee una vez, y eso sólo si la
/// petición falla.
///
/// ─── Y no se manda una petición por toque ───
///
/// Alguien que toca cinco veces seguidas quiere terminar donde empezó. Cinco
/// peticiones en cadena hacen cinco viajes para nada, y si llegan desordenadas
/// el estado final es aleatorio.
///
/// Se espera a que se quede quieto y recién ahí se manda **una sola** con el
/// estado final. Ver `_esperarYMandar`.
class BotonMeGusta extends ConsumerStatefulWidget {
  const BotonMeGusta({
    super.key,
    required this.tipo,
    required this.id,
    this.inicial,
    this.compacto = false,
  });

  /// `'live'` o `'product'`.
  final String tipo;
  final String id;

  /// Lo que ya sabe quien lo muestra, para no parpadear al aparecer.
  final EstadoDeMeGusta? inicial;

  /// En una tarjeta del feed va más chico que en el vivo.
  final bool compacto;

  @override
  ConsumerState<BotonMeGusta> createState() => _BotonMeGustaState();
}

class _BotonMeGustaState extends ConsumerState<BotonMeGusta> with SingleTickerProviderStateMixin {
  late EstadoDeMeGusta _estado = widget.inicial ?? const EstadoDeMeGusta.vacio();

  /// Lo que había antes de que la persona empezara a tocar, para poder volver.
  late EstadoDeMeGusta _confirmado = _estado;

  Timer? _espera;
  bool _mandando = false;

  late final AnimationController _latido = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 220),
    lowerBound: 1,
    upperBound: 1.35,
  );

  @override
  void initState() {
    super.initState();
    if (widget.inicial == null) unawaited(_leer());
  }

  @override
  void dispose() {
    _espera?.cancel();
    _latido.dispose();
    super.dispose();
  }

  Future<void> _leer() async {
    try {
      final api = ref.read(socialApiProvider);
      final e = widget.tipo == 'live'
          ? await api.estadoDeLive(widget.id)
          : await api.estadoDeProducto(widget.id);
      if (!mounted) return;
      setState(() {
        _estado = e;
        _confirmado = e;
      });
    } catch (_) {
      // Sin corazón no se rompe nada: queda en cero y se puede tocar igual.
    }
  }

  void _tocar() {
    // El latido va primero de todo: es la respuesta inmediata al dedo.
    _latido.forward(from: 1).then((_) => _latido.reverse());

    setState(() {
      _estado = EstadoDeMeGusta(
        meGusta: !_estado.meGusta,
        // El total se mueve con el corazón para que el número no contradiga al
        // ícono mientras se espera la respuesta.
        total: _estado.meGusta ? (_estado.total - 1).clamp(0, 1 << 30) : _estado.total + 1,
      );
    });

    _esperarYMandar();
  }

  /// Espera a que la persona deje de tocar y manda UNA petición.
  ///
  /// 400 ms: suficiente para agrupar una ráfaga de toques, poco como para que
  /// alguien que toca y bloquea el teléfono pierda su "me gusta".
  void _esperarYMandar() {
    _espera?.cancel();
    _espera = Timer(const Duration(milliseconds: 400), () => unawaited(_mandar()));
  }

  Future<void> _mandar() async {
    // Si el estado ya coincide con lo confirmado, no hay nada que mandar:
    // la persona tocó un número par de veces y volvió al principio.
    if (_mandando || _estado.meGusta == _confirmado.meGusta) return;
    _mandando = true;

    try {
      final api = ref.read(socialApiProvider);
      final real = widget.tipo == 'live'
          ? await api.alternarLive(widget.id)
          : await api.alternarProducto(widget.id);

      if (!mounted) return;
      setState(() {
        _estado = real;
        _confirmado = real;
      });
    } catch (_) {
      /**
       * Falló: se vuelve a lo último confirmado.
       *
       * Sin cartel. Un "no pudimos guardar tu me gusta" es ruido por algo que a
       * nadie le cambia el día, y encima interrumpe el vivo que está mirando.
       * El corazón vuelve como estaba y se puede tocar de nuevo.
       */
      if (!mounted) return;
      setState(() => _estado = _confirmado);
    } finally {
      _mandando = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final tamano = widget.compacto ? 20.0 : 22.0;

    return GestureDetector(
      onTap: _tocar,
      behavior: HitTestBehavior.opaque,
      child: Semantics(
        button: true,
        label: _estado.meGusta ? 'Quitar me gusta' : 'Me gusta',
        value: '${_estado.total}',
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ScaleTransition(
              scale: _latido,
              child: Icon(
                _estado.meGusta ? Icons.favorite_rounded : Icons.favorite_border_rounded,
                size: tamano,
                // Rojo sólo cuando está puesto. Un corazón siempre rojo no
                // distingue el estado y obliga a mirar si está relleno.
                color: _estado.meGusta ? const Color(0xFFFF3B5C) : Colors.white,
                shadows: const [Shadow(color: Colors.black54, blurRadius: 6)],
              ),
            ),
            if (_estado.total > 0) ...[
              const SizedBox(height: 3),
              Text(
                _estado.comoTexto,
                style: TextStyle(
                  fontSize: widget.compacto ? 10 : 10.5,
                  fontWeight: FontWeight.w700,
                  color: Colors.white,
                  shadows: const [Shadow(color: Colors.black87, blurRadius: 6)],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
