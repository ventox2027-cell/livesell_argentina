import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../auth/state/auth_providers.dart';

/// Feed vertical.
///
/// ─── Qué es esto hoy ───
///
/// La estructura completa de la pantalla con contenido de ejemplo. El video
/// real llega con el módulo Live Sessions; lo que está armado acá es todo lo
/// que lo rodea, que es donde vive la decisión de compra: quién vende, qué
/// vende, cuánto sale y el botón.
///
/// Se construye antes que el video a propósito. La parte difícil de un feed de
/// venta no es reproducir: es que en los dos segundos que alguien mira una
/// pantalla entienda qué le están ofreciendo y cuánto cuesta.
class FeedScreen extends ConsumerStatefulWidget {
  const FeedScreen({super.key});

  @override
  ConsumerState<FeedScreen> createState() => _FeedScreenState();
}

class _FeedScreenState extends ConsumerState<FeedScreen> {
  final _pageController = PageController();
  int _indice = 0;

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        PageView.builder(
          controller: _pageController,
          scrollDirection: Axis.vertical,
          itemCount: _ejemplos.length,
          onPageChanged: (i) => setState(() => _indice = i),
          itemBuilder: (_, i) => _Publicacion(datos: _ejemplos[i]),
        ),
        // La barra superior va encima del video, no arriba de él: robarle alto
        // al video en una pantalla de 6" se nota.
        const _BarraSuperior(),
        Positioned(
          right: Gap.md,
          bottom: 120,
          child: _AccionesLaterales(publicacion: _ejemplos[_indice]),
        ),
      ],
    );
  }
}

class _BarraSuperior extends StatelessWidget {
  const _BarraSuperior();

  @override
  Widget build(BuildContext context) {
    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      child: Container(
        decoration: const BoxDecoration(gradient: AppColor.veloSuperior),
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: Gap.sm),
            child: Row(
              children: [
                const _Pestana('Siguiendo', activa: false),
                const SizedBox(width: Gap.xl),
                const _Pestana('Para vos', activa: true),
                const Spacer(),
                IconButton(
                  onPressed: () {},
                  icon: const Icon(Icons.notifications_none_rounded),
                  color: AppColor.texto,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Pestana extends StatelessWidget {
  const _Pestana(this.texto, {required this.activa});
  final String texto;
  final bool activa;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          texto,
          style: TextStyle(
            fontSize: 16,
            fontWeight: activa ? FontWeight.w700 : FontWeight.w500,
            color: activa ? AppColor.texto : AppColor.textoSuave,
          ),
        ),
        const SizedBox(height: 4),
        Container(
          width: activa ? 22 : 0,
          height: 2.5,
          decoration: BoxDecoration(
            color: AppColor.texto,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ],
    );
  }
}

class _Publicacion extends StatelessWidget {
  const _Publicacion({required this.datos});
  final _Ejemplo datos;

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        // Marcador de posición del video. Cuando llegue Live Sessions, acá va
        // el reproductor y nada más de esta pantalla cambia.
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: datos.colores,
            ),
          ),
          child: Center(
            child: Icon(
              datos.icono,
              size: 96,
              color: Colors.white.withValues(alpha: 0.12),
            ),
          ),
        ),
        const DecoratedBox(decoration: BoxDecoration(gradient: AppColor.velo)),

        if (datos.enVivo)
          const Positioned(top: 100, left: Gap.lg, child: _ChipEnVivo(espectadores: 1247)),

        Positioned(
          left: Gap.lg,
          right: 88, // deja libre la columna de acciones
          bottom: 96,
          child: _InfoPublicacion(datos: datos),
        ),
      ],
    );
  }
}

class _ChipEnVivo extends StatelessWidget {
  const _ChipEnVivo({required this.espectadores});
  final int espectadores;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(
            color: AppColor.vivo,
            borderRadius: BorderRadius.circular(Redondeo.sm),
          ),
          child: const Text(
            'EN VIVO',
            style: TextStyle(
              color: Colors.white,
              fontSize: 11,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.5,
            ),
          ),
        ),
        const SizedBox(width: Gap.sm),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(
            color: Colors.black.withValues(alpha: 0.45),
            borderRadius: BorderRadius.circular(Redondeo.sm),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.visibility_rounded, size: 13, color: Colors.white),
              const SizedBox(width: 4),
              Text(
                _miles(espectadores),
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _InfoPublicacion extends ConsumerWidget {
  const _InfoPublicacion({required this.datos});
  final _Ejemplo datos;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            CircleAvatar(
              radius: 16,
              backgroundColor: AppColor.superficieAlta,
              child: Text(
                datos.vendedor[0],
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
              ),
            ),
            const SizedBox(width: Gap.sm),
            Text(
              datos.vendedor,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
            ),
            const SizedBox(width: Gap.sm),
            _BotonSeguir(),
          ],
        ),
        const SizedBox(height: Gap.md),
        Text(
          datos.descripcion,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 14, height: 1.35),
        ),
        const SizedBox(height: Gap.md),
        _TarjetaProducto(datos: datos),
      ],
    );
  }
}

class _BotonSeguir extends StatefulWidget {
  @override
  State<_BotonSeguir> createState() => _BotonSeguirState();
}

class _BotonSeguirState extends State<_BotonSeguir> {
  bool _siguiendo = false;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => setState(() => _siguiendo = !_siguiendo),
      child: AnimatedContainer(
        duration: Duraciones.rapida,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        decoration: BoxDecoration(
          color: _siguiendo ? Colors.transparent : AppColor.acento,
          border: Border.all(color: _siguiendo ? AppColor.textoSuave : AppColor.acento),
          borderRadius: BorderRadius.circular(Redondeo.sm),
        ),
        child: Text(
          _siguiendo ? 'Siguiendo' : 'Seguir',
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            color: _siguiendo ? AppColor.textoSuave : Colors.white,
          ),
        ),
      ),
    );
  }
}

/// La tarjeta del producto.
///
/// Es lo más importante de la pantalla después del video. Tiene que decir qué
/// es y cuánto sale sin que nadie tenga que tocar nada: si hay que abrir algo
/// para ver el precio, la mitad sigue de largo.
class _TarjetaProducto extends ConsumerWidget {
  const _TarjetaProducto({required this.datos});
  final _Ejemplo datos;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final puedeComprar = ref.watch(puedeComprarProvider);

    return Container(
      padding: const EdgeInsets.all(Gap.sm),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: Colors.white.withValues(alpha: 0.12)),
      ),
      child: Row(
        children: [
          Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              color: AppColor.superficieAlta,
              borderRadius: BorderRadius.circular(Redondeo.sm),
            ),
            child: Icon(datos.icono, size: 22, color: AppColor.textoSuave),
          ),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  datos.producto,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    Text(
                      datos.precio,
                      style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w800,
                        letterSpacing: -0.5,
                      ),
                    ),
                    if (datos.stock <= 5) ...[
                      const SizedBox(width: Gap.sm),
                      // La escasez es real, no un truco: en un vivo el stock se
                      // agota de verdad y avisar evita la peor experiencia
                      // posible, que es comprar algo que ya no está.
                      Text(
                        'Quedan ${datos.stock}',
                        style: const TextStyle(
                          fontSize: 11,
                          color: AppColor.alerta,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: Gap.sm),
          FilledButton(
            onPressed: () => _comprar(context, puedeComprar),
            style: FilledButton.styleFrom(
              minimumSize: const Size(0, 40),
              padding: const EdgeInsets.symmetric(horizontal: Gap.lg),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Redondeo.sm)),
            ),
            child: const Text('Comprar', style: TextStyle(fontSize: 14)),
          ),
        ],
      ),
    );
  }

  void _comprar(BuildContext context, bool puedeComprar) {
    // Acá es donde el onboarding progresivo se hace visible: si falta el
    // teléfono, se pide AHORA, con la compra ya decidida y un motivo claro
    // para darlo.
    AppSnack.info(
      context,
      puedeComprar
          ? 'La compra desde el feed llega con el módulo de Órdenes.'
          : 'Antes de comprar vamos a pedirte un teléfono de contacto.',
    );
  }
}

class _AccionesLaterales extends StatefulWidget {
  const _AccionesLaterales({required this.publicacion});
  final _Ejemplo publicacion;

  @override
  State<_AccionesLaterales> createState() => _AccionesLateralesState();
}

class _AccionesLateralesState extends State<_AccionesLaterales> {
  bool _meGusta = false;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _Accion(
          icono: _meGusta ? Icons.favorite_rounded : Icons.favorite_border_rounded,
          color: _meGusta ? AppColor.acento : Colors.white,
          etiqueta: _miles(widget.publicacion.likes + (_meGusta ? 1 : 0)),
          onTap: () => setState(() => _meGusta = !_meGusta),
        ),
        const SizedBox(height: Gap.lg),
        _Accion(
          icono: Icons.mode_comment_outlined,
          etiqueta: _miles(widget.publicacion.comentarios),
          onTap: () {},
        ),
        const SizedBox(height: Gap.lg),
        _Accion(icono: Icons.share_outlined, etiqueta: 'Enviar', onTap: () {}),
        const SizedBox(height: Gap.lg),
        _Accion(icono: Icons.storefront_outlined, etiqueta: 'Tienda', onTap: () {}),
      ],
    );
  }
}

class _Accion extends StatelessWidget {
  const _Accion({
    required this.icono,
    required this.etiqueta,
    required this.onTap,
    this.color = Colors.white,
  });

  final IconData icono;
  final String etiqueta;
  final VoidCallback onTap;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Column(
        children: [
          // La sombra es lo que mantiene los iconos legibles sobre un video
          // claro. Sin ella desaparecen contra una pared blanca.
          Icon(icono, color: color, size: 30, shadows: const [
            Shadow(color: Colors.black54, blurRadius: 8),
          ]),
          const SizedBox(height: 3),
          Text(
            etiqueta,
            style: const TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
              shadows: [Shadow(color: Colors.black54, blurRadius: 8)],
            ),
          ),
        ],
      ),
    );
  }
}

String _miles(int n) {
  if (n < 1000) return '$n';
  final v = (n / 1000).toStringAsFixed(n % 1000 >= 100 ? 1 : 0);
  return '${v.replaceAll('.', ',')} mil';
}

// ─── Contenido de ejemplo ───────────────────────────────────────────────────
//
// Se marca claramente como ejemplo. Un feed vacío no permite evaluar el diseño,
// y una pantalla en blanco esconde exactamente los problemas de legibilidad y
// jerarquía que hay que resolver ahora.

class _Ejemplo {
  const _Ejemplo({
    required this.vendedor,
    required this.descripcion,
    required this.producto,
    required this.precio,
    required this.stock,
    required this.likes,
    required this.comentarios,
    required this.enVivo,
    required this.icono,
    required this.colores,
  });

  final String vendedor;
  final String descripcion;
  final String producto;
  final String precio;
  final int stock;
  final int likes;
  final int comentarios;
  final bool enVivo;
  final IconData icono;
  final List<Color> colores;
}

const _ejemplos = <_Ejemplo>[
  _Ejemplo(
    vendedor: 'Tejidos del Sur',
    descripcion: 'Últimos sweaters de lana patagónica 🧶 Envío a todo el país',
    producto: 'Sweater lana merino · Talle M',
    precio: '\$ 42.900',
    stock: 3,
    likes: 1284,
    comentarios: 96,
    enVivo: true,
    icono: Icons.checkroom_rounded,
    colores: [Color(0xFF3A1C2E), Color(0xFF0D0508)],
  ),
  _Ejemplo(
    vendedor: 'Cuero Argentino',
    descripcion: 'Mochilas hechas a mano en San Telmo. Mirá el interior 👜',
    producto: 'Mochila cuero vacuno',
    precio: '\$ 89.500',
    stock: 12,
    likes: 3410,
    comentarios: 218,
    enVivo: false,
    icono: Icons.backpack_rounded,
    colores: [Color(0xFF2B2013), Color(0xFF0A0705)],
  ),
  _Ejemplo(
    vendedor: 'Verde Vivero',
    descripcion: 'Suculentas y macetas de cerámica esmaltada 🌵',
    producto: 'Kit 3 suculentas + maceta',
    precio: '\$ 18.700',
    stock: 2,
    likes: 842,
    comentarios: 51,
    enVivo: true,
    icono: Icons.local_florist_rounded,
    colores: [Color(0xFF13291C), Color(0xFF040A07)],
  ),
];
