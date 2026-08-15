import 'package:flutter/material.dart';

import 'tokens.dart';

/// Los componentes que llevan la marca encima.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ESTÁN ACÁ Y NO EN CADA PANTALLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El tema de Material resuelve el 95 % de la interfaz sin que ninguna pantalla
/// nombre un color. Lo que no puede resolver es lo que no existe en Material:
/// un botón con gradiente, un badge que late, un contador que sube animado.
///
/// Sin un lugar común, cada pantalla los reinventa y terminan cuatro botones
/// de marca con cuatro gradientes distintos — que es exactamente cómo una
/// identidad se deshace sin que nadie tome la decisión de deshacerla.

/// El botón de la acción que genera plata.
///
/// ⚠️ El gradiente es violeta → magenta, **no** el de tres colores de la marca.
/// Sobre el cyan el texto blanco da 1,9:1 y es ilegible. Ver la nota grande en
/// `tokens.dart`.
///
/// Se usa con avaricia: comprar, publicar, salir en vivo, confirmar entrega.
/// Si hay dos de estos en una pantalla, uno de los dos no era la acción
/// principal.
class BotonVendoX extends StatefulWidget {
  const BotonVendoX({
    super.key,
    required this.etiqueta,
    required this.onTap,
    this.icono,
    this.cargando = false,
    this.alto = 54,
  });

  final String etiqueta;
  final IconData? icono;

  /// `null` lo deja apagado. Un botón principal apagado se ve gris plano, sin
  /// gradiente ni glow: tiene que quedar claro que no se puede tocar.
  final VoidCallback? onTap;

  final bool cargando;
  final double alto;

  @override
  State<BotonVendoX> createState() => _BotonVendoXState();
}

class _BotonVendoXState extends State<BotonVendoX> {
  bool _apretado = false;

  @override
  Widget build(BuildContext context) {
    final habilitado = widget.onTap != null && !widget.cargando;

    return GestureDetector(
      onTapDown: habilitado ? (_) => setState(() => _apretado = true) : null,
      onTapUp: habilitado ? (_) => setState(() => _apretado = false) : null,
      onTapCancel: habilitado ? () => setState(() => _apretado = false) : null,
      onTap: habilitado ? widget.onTap : null,
      child: AnimatedScale(
        /**
         * Se hunde un 2 % al apretar.
         *
         * Es la microanimación más barata que existe y la que más cambia la
         * sensación: sin ella, un botón con gradiente se siente como una
         * imagen pegada. 120 ms porque por encima de eso el dedo ya se levantó
         * y la animación llega tarde.
         */
        scale: _apretado ? 0.98 : 1,
        duration: Duraciones.instantanea,
        curve: Curves.easeOut,
        child: AnimatedContainer(
          duration: Duraciones.rapida,
          height: widget.alto,
          decoration: BoxDecoration(
            gradient: habilitado ? AppColor.gradienteAccion : null,
            color: habilitado ? null : AppColor.superficieAlta,
            borderRadius: BorderRadius.circular(Redondeo.md),
            // El glow se apaga al apretar: refuerza la sensación de que el
            // botón se hundió contra la pantalla.
            boxShadow: habilitado && !_apretado ? Glow.accion : null,
          ),
          child: Center(
            child: widget.cargando
                ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(strokeWidth: 2.2, color: Colors.white),
                  )
                : Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      if (widget.icono != null) ...[
                        Icon(widget.icono, size: 20, color: Colors.white),
                        const SizedBox(width: Gap.sm),
                      ],
                      Text(
                        widget.etiqueta,
                        style: TextStyle(
                          color: habilitado ? Colors.white : AppColor.textoDebil,
                          fontSize: 16.5,
                          fontWeight: FontWeight.w700,
                          letterSpacing: -0.2,
                        ),
                      ),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}

/// El badge de EN VIVO.
///
/// El punto late. Es la única animación en bucle de toda la app y está acá por
/// un motivo concreto: en una grilla de tarjetas, la diferencia entre un vivo
/// que está al aire y una tarjeta cualquiera tiene que verse **sin leer**.
///
/// 1,1 segundos por ciclo. Más rápido parpadea y molesta; más lento no se
/// registra como movimiento.
class BadgeEnVivo extends StatefulWidget {
  const BadgeEnVivo({super.key, this.espectadores, this.compacto = false});

  /// Cuánta gente está mirando **de verdad**. `null` lo esconde.
  ///
  /// ⛔ Nunca un número inventado ni redondeado hacia arriba. Si no se sabe,
  /// no se muestra.
  final int? espectadores;
  final bool compacto;

  @override
  State<BadgeEnVivo> createState() => _BadgeEnVivoState();
}

class _BadgeEnVivoState extends State<BadgeEnVivo> with SingleTickerProviderStateMixin {
  late final AnimationController _pulso = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _pulso.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final horizontal = widget.compacto ? Gap.sm : Gap.md;

    return Container(
      padding: EdgeInsets.symmetric(horizontal: horizontal, vertical: Gap.xs + 1),
      decoration: BoxDecoration(
        color: AppColor.vivo,
        borderRadius: BorderRadius.circular(Redondeo.pill),
        boxShadow: Glow.vivo,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          FadeTransition(
            opacity: Tween<double>(begin: 1, end: 0.35).animate(
              CurvedAnimation(parent: _pulso, curve: Curves.easeInOut),
            ),
            child: Container(
              width: 7,
              height: 7,
              decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
            ),
          ),
          const SizedBox(width: Gap.xs + 2),
          const Text(
            'EN VIVO',
            style: TextStyle(
              color: Colors.white,
              fontSize: 11,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.6,
            ),
          ),
          if (widget.espectadores != null) ...[
            const SizedBox(width: Gap.sm),
            Container(width: 1, height: 10, color: Colors.white24),
            const SizedBox(width: Gap.sm),
            Text(
              '${widget.espectadores}',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 11.5,
                fontWeight: FontWeight.w700,
                // Los dígitos alineados: sin esto el badge cambia de ancho al
                // pasar de 9 a 10 espectadores y la tarjeta salta.
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// El color de cada tono, en un solo lugar.
///
/// ⚠️ Existe como función suelta y no sólo adentro de [Etiqueta] porque hay
/// pantallas que necesitan el color sin la caja: un ícono al lado de un título,
/// el borde de una tarjeta, el punto de una lista.
///
/// Antes cada una elegía el suyo con un `switch` propio, y el mismo estado
/// salía ámbar en el listado de pedidos y violeta en el detalle.
(Color, Color) coloresDelTono(TonoDeEstado tono) => switch (tono) {
      TonoDeEstado.exito => (AppColor.exito, AppColor.exitoSuave),
      TonoDeEstado.info => (AppColor.info, AppColor.infoSuave),
      TonoDeEstado.enCurso => (AppColor.alerta, AppColor.alertaSuave),
      TonoDeEstado.alerta => (AppColor.alerta, AppColor.alertaSuave),
      TonoDeEstado.error => (AppColor.error, AppColor.errorSuave),
      TonoDeEstado.vivo => (AppColor.magentaNeon, AppColor.vivoSuave),
      TonoDeEstado.pendiente => (AppColor.acento, AppColor.acentoSuave),
      TonoDeEstado.neutro => (AppColor.textoDebil, const Color(0x14FFFFFF)),
    };

/// Una etiqueta de estado. Es el widget más repetido de la app.
///
/// Los cinco colores de la paleta, cada uno con su significado, en una sola
/// forma. Antes cada pantalla armaba su propio `Container` con su propio
/// `withOpacity`, y el mismo estado se veía distinto en la lista de pedidos y
/// en el detalle.
enum TonoDeEstado {
  /// Todavía no pasó nada y depende de la persona. Violeta: hay algo que hacer.
  pendiente,

  /// Está pasando y no hay nada que hacer. Ámbar.
  enCurso,

  /// Salió bien: pagado, conectado, publicado, entregado. Lima.
  exito,

  /// Requiere atención pero no está roto. Ámbar.
  alerta,

  /// Algo falló. Rojo.
  error,

  /// En vivo ahora. Magenta.
  vivo,

  /// Información sin carga: seleccionado, en curso neutro. Cyan.
  info,

  /// Apagado, archivado, no disponible. Gris.
  neutro,
}

class Etiqueta extends StatelessWidget {
  const Etiqueta({super.key, required this.texto, required this.tono, this.icono});

  final String texto;
  final TonoDeEstado tono;
  final IconData? icono;

  (Color, Color) get _colores => coloresDelTono(tono);

  @override
  Widget build(BuildContext context) {
    final (color, fondo) = _colores;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Gap.sm + 2, vertical: Gap.xs + 1),
      decoration: BoxDecoration(
        color: fondo,
        borderRadius: BorderRadius.circular(Redondeo.sm),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icono != null) ...[
            Icon(icono, size: 13, color: color),
            const SizedBox(width: Gap.xs + 1),
          ],
          Text(
            texto,
            style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

/// El isotipo. Es el único lugar donde el gradiente de tres colores va entero.
///
/// `ShaderMask` y no tres `Text` de colores: el gradiente tiene que ser
/// continuo sobre las letras, no un color por letra.
class MarcaVendoX extends StatelessWidget {
  const MarcaVendoX({super.key, this.tamano = 28});

  final double tamano;

  @override
  Widget build(BuildContext context) {
    return ShaderMask(
      shaderCallback: (rect) => AppColor.gradienteMarca.createShader(rect),
      blendMode: BlendMode.srcIn,
      child: Text(
        'VendoX',
        style: TextStyle(
          fontSize: tamano,
          fontWeight: FontWeight.w800,
          letterSpacing: -1.2,
          // Blanco a propósito: `srcIn` reemplaza el color por el gradiente,
          // pero necesita que el texto tenga alfa completo para hacerlo.
          color: Colors.white,
        ),
      ),
    );
  }
}

/// Un número que sube contando en vez de saltar.
///
/// Se usa donde el cambio importa y hay tiempo de mirarlo: espectadores de un
/// vivo, ventas del día, seguidores. No en una lista que scrollea.
///
/// ⚠️ Anima el número **que le dan**. No inventa ni redondea: si el valor real
/// pasó de 3 a 47, cuenta de 3 a 47.
class NumeroQueSube extends StatelessWidget {
  const NumeroQueSube({super.key, required this.valor, this.estilo});

  final int valor;
  final TextStyle? estilo;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<int>(
      tween: IntTween(begin: valor, end: valor),
      duration: Duraciones.normal,
      curve: Curves.easeOutCubic,
      builder: (context, v, _) => Text(
        '$v',
        style: (estilo ?? const TextStyle()).copyWith(
          fontFeatures: const [FontFeature.tabularFigures()],
        ),
      ),
    );
  }
}
