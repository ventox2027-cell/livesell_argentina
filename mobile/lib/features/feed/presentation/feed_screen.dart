import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../auth/state/auth_providers.dart';
import '../../inventory/presentation/reserve_sheet.dart';
import '../../lives/data/live_api.dart';
import '../../lives/presentation/seller_profile_screen.dart';
import '../../seller/presentation/seller_home_screen.dart';
import '../data/feed_repository.dart';
import '../domain/feed_models.dart';

/// Feed vertical.
///
/// ─── Qué es esto hoy ───
///
/// Productos **reales**, traídos de `/discover/products`. Lo único que sigue
/// siendo un marcador es el video: llega con el módulo Live Sessions y ocupa
/// exactamente el lugar del degradado, sin que el resto de la pantalla cambie.
///
/// Se construyó en este orden a propósito. La parte difícil de un feed de venta
/// no es reproducir video: es que en los dos segundos que alguien mira una
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
    final feed = ref.watch(feedProvider);

    return feed.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => _ErrorDeFeed(
        mensaje: e.toString(),
        onReintentar: () => ref.read(feedProvider.notifier).recargar(),
      ),
      data: (publicaciones) {
        if (publicaciones.isEmpty) return const _FeedVacio();

        // El índice puede quedar fuera de rango si el feed se recarga con menos
        // publicaciones de las que había.
        final indice = _indice.clamp(0, publicaciones.length - 1);

        return Stack(
          children: [
            PageView.builder(
              controller: _pageController,
              scrollDirection: Axis.vertical,
              itemCount: publicaciones.length,
              onPageChanged: (i) {
                setState(() => _indice = i);
                // Se pide la página siguiente tres publicaciones antes del
                // final. Esperar a la última deja un hueco visible mientras
                // llega la respuesta.
                if (i >= publicaciones.length - 3) {
                  ref.read(feedProvider.notifier).cargarMas();
                }
              },
              itemBuilder: (_, i) => _Publicacion(datos: publicaciones[i]),
            ),
            // La barra superior va ENCIMA del video, no arriba de él: robarle
            // alto al video en una pantalla de 6" se nota.
            const _BarraSuperior(),
            Positioned(
              right: Gap.md,
              bottom: 120,
              child: _AccionesLaterales(publicacion: publicaciones[indice]),
            ),
          ],
        );
      },
    );
  }
}

class _BarraSuperior extends ConsumerWidget {
  const _BarraSuperior();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
                  onPressed: () => ref.read(feedProvider.notifier).recargar(),
                  icon: const Icon(Icons.refresh_rounded),
                  tooltip: 'Actualizar',
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
  final PublicacionFeed datos;

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        // Marcador de posición del video. Si el producto tiene foto, se usa la
        // foto: es contenido real del vendedor y da una idea mucho más fiel de
        // cómo se va a ver el feed que un degradado.
        if (datos.portada != null)
          CachedNetworkImage(
            imageUrl: datos.portada!,
            fit: BoxFit.cover,
            fadeInDuration: Duraciones.rapida,
            placeholder: (_, __) => _Fondo(colores: datos.coloresDeFondo),
            errorWidget: (_, __, ___) => _Fondo(colores: datos.coloresDeFondo),
          )
        else
          _Fondo(colores: datos.coloresDeFondo),

        const DecoratedBox(decoration: BoxDecoration(gradient: AppColor.velo)),

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

class _Fondo extends StatelessWidget {
  const _Fondo({required this.colores});
  final List<Color> colores;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: colores,
        ),
      ),
      child: Center(
        child: Icon(
          Icons.storefront_rounded,
          size: 96,
          color: Colors.white.withValues(alpha: 0.10),
        ),
      ),
    );
  }
}

class _InfoPublicacion extends StatelessWidget {
  const _InfoPublicacion({required this.datos});
  final PublicacionFeed datos;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            // Toda la identidad del vendedor abre su perfil. El objetivo de
            // toque va sobre el avatar y el nombre juntos, no sobre el nombre
            // solo: un texto de 15 px es un blanco chico para un pulgar.
            Flexible(
              child: GestureDetector(
                onTap: datos.vendedorId.isEmpty
                    ? null
                    : () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => SellerProfileScreen(sellerId: datos.vendedorId),
                          ),
                        ),
                behavior: HitTestBehavior.opaque,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    CircleAvatar(
                      radius: 16,
                      backgroundColor: AppColor.superficieAlta,
                      backgroundImage: datos.avatarUrl == null
                          ? null
                          : CachedNetworkImageProvider(datos.avatarUrl!),
                      child: datos.avatarUrl != null
                          ? null
                          : Text(
                              datos.vendedor.characters.first.toUpperCase(),
                              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
                            ),
                    ),
                    const SizedBox(width: Gap.sm),
                    Flexible(
                      child: Text(
                        datos.vendedor,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                          shadows: [Shadow(color: Colors.black54, blurRadius: 8)],
                        ),
                      ),
                    ),
                    if (datos.verificado) ...[
                      const SizedBox(width: 4),
                      // Identidad verificada. NO dice nada de reputación: eso
                      // se ve en el perfil, con su propia insignia.
                      const Icon(Icons.verified_rounded, size: 15, color: AppColor.acento),
                    ],
                    if (datos.promocionado) ...[
                      const SizedBox(width: Gap.sm),
                      const _EtiquetaPromocionado(),
                    ],
                  ],
                ),
              ),
            ),
            const SizedBox(width: Gap.sm),
            if (datos.vendedorId.isNotEmpty) _BotonSeguir(sellerId: datos.vendedorId),
          ],
        ),
        if (datos.descripcion != null && datos.descripcion!.isNotEmpty) ...[
          const SizedBox(height: Gap.md),
          Text(
            datos.descripcion!,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 14,
              height: 1.35,
              shadows: [Shadow(color: Colors.black54, blurRadius: 8)],
            ),
          ),
        ],
        const SizedBox(height: Gap.md),
        _TarjetaProducto(datos: datos),
      ],
    );
  }
}

/// Seguir a un vendedor desde el feed.
///
/// ─── Antes era un booleano local, y eso era una mentira ───
///
/// El botón alternaba un `bool` en memoria: se ponía en "Siguiendo", no
/// mandaba nada al servidor, y al volver a abrir la app decía "Seguir" otra
/// vez. La persona creía que iba a recibir avisos de los vivos de ese vendedor
/// y no iba a recibir ninguno.
///
/// Ahora el estado sale del backend y el contador lo devuelve él. Ver
/// `stores.service.ts`: el follow es idempotente —un P2002 se trata como éxito—
/// así que tocar dos veces no rompe nada.
/// «Promocionado».
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ESTA ETIQUETA NO ES OPCIONAL
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La ley argentina de defensa del consumidor exige que la publicidad se
/// distinga de un resultado. Sin la etiqueta, alguien lee una recomendación
/// donde hay un aviso pagado.
///
/// ─── Por qué es discreta y no llamativa ───
///
/// Tiene que **leerse**, no gritar. Una etiqueta enorme castiga al vendedor que
/// pagó —la gente saltea lo que parece publicidad— y una escondida no cumple.
/// Gris sobre el video, del mismo tamaño que el resto de los metadatos:
/// presente para quien mira, sin robarle la atención al producto.
///
/// Y no lleva el violeta de marca: el acento significa «esto es de VendoX», y
/// una promoción es del vendedor.
class _EtiquetaPromocionado extends StatelessWidget {
  const _EtiquetaPromocionado();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(Redondeo.sm),
        border: Border.all(color: Colors.white24),
      ),
      child: const Text(
        'Promocionado',
        style: TextStyle(
          fontSize: 10.5,
          fontWeight: FontWeight.w600,
          color: Colors.white70,
          letterSpacing: 0.2,
        ),
      ),
    );
  }
}

class _BotonSeguir extends ConsumerStatefulWidget {
  const _BotonSeguir({required this.sellerId});

  final String sellerId;

  @override
  ConsumerState<_BotonSeguir> createState() => _BotonSeguirState();
}

class _BotonSeguirState extends ConsumerState<_BotonSeguir> {
  /// `null` mientras no se sabe. El botón no se dibuja hasta saberlo: mostrar
  /// "Seguir" y que dos segundos después cambie solo a "Siguiendo" se ve como
  /// que la app hizo algo que nadie pidió.
  bool? _siguiendo;
  bool _enviando = false;

  @override
  void initState() {
    super.initState();
    unawaited(_cargar());
  }

  Future<void> _cargar() async {
    try {
      final perfil = await ref.read(liveApiProvider).perfil(widget.sellerId);
      if (mounted) setState(() => _siguiendo = perfil.loSigo ?? false);
    } catch (_) {
      // Sin dato no se dibuja el botón. Es preferible a mostrar uno que
      // miente sobre un estado que no pudimos leer.
    }
  }

  Future<void> _alternar() async {
    if (_enviando) return;
    setState(() => _enviando = true);

    final api = ref.read(liveApiProvider);
    try {
      final r = _siguiendo == true
          ? await api.dejarDeSeguir(widget.sellerId)
          : await api.seguir(widget.sellerId);
      if (mounted) setState(() => _siguiendo = r.siguiendo);
    } catch (_) {
      // El estado no cambia: mejor que mostrar "Siguiendo" sobre algo que falló.
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final siguiendo = _siguiendo;
    if (siguiendo == null) return const SizedBox.shrink();

    return GestureDetector(
      onTap: _enviando ? null : () => unawaited(_alternar()),
      child: AnimatedContainer(
        duration: Duraciones.rapida,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        decoration: BoxDecoration(
          color: siguiendo ? Colors.transparent : AppColor.acento,
          border: Border.all(color: siguiendo ? AppColor.textoSuave : AppColor.acento),
          borderRadius: BorderRadius.circular(Redondeo.sm),
        ),
        child: Text(
          siguiendo ? 'Siguiendo' : 'Seguir',
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            color: siguiendo ? AppColor.textoSuave : Colors.white,
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
  final PublicacionFeed datos;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final puedeComprar = ref.watch(puedeComprarProvider);
    // "Agotado" lo decide el backend, no la app. Acá sólo se dibuja.
    final agotado = !datos.sePuedeComprar;

    return Container(
      padding: const EdgeInsets.all(Gap.sm),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: Colors.white.withValues(alpha: 0.12)),
      ),
      child: Row(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(Redondeo.sm),
            child: SizedBox(
              width: 46,
              height: 46,
              child: datos.portada != null
                  ? CachedNetworkImage(
                      imageUrl: datos.portada!,
                      fit: BoxFit.cover,
                      errorWidget: (_, __, ___) => const _SinFoto(),
                    )
                  : const _SinFoto(),
            ),
          ),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  datos.nombre,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        datos.precio,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w800,
                          letterSpacing: -0.5,
                        ),
                      ),
                    ),
                    if (datos.descuento != null) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                        decoration: BoxDecoration(
                          color: AppColor.exito,
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          '-${datos.descuento}%',
                          style: const TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w800,
                            color: Colors.white,
                          ),
                        ),
                      ),
                    ],
                    // "Últimas 3" cuando de verdad quedan pocas. La escasez es
                    // real —en un vivo el stock se agota— y avisarla evita la
                    // peor experiencia posible: comprar algo que ya no está.
                    if (datos.disponibilidad?.quedanPocas ?? false) ...[
                      const SizedBox(width: Gap.sm),
                      Text(
                        datos.disponibilidad!.etiqueta,
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
            onPressed: agotado ? null : () => _comprar(context, ref, puedeComprar),
            style: FilledButton.styleFrom(
              minimumSize: const Size(0, 40),
              padding: const EdgeInsets.symmetric(horizontal: Gap.lg),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Redondeo.sm)),
              disabledBackgroundColor: AppColor.superficieAlta,
              disabledForegroundColor: AppColor.textoDebil,
            ),
            child: Text(
              agotado ? 'Agotado' : 'Comprar',
              style: const TextStyle(fontSize: 14),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _comprar(BuildContext context, WidgetRef ref, bool puedeComprar) async {
    /**
     * Acá se hace visible el onboarding progresivo: si falta el teléfono se
     * pide AHORA, con la compra ya decidida y un motivo claro para darlo. No
     * antes: pedirlo al registrarse es gente que se va sin ver un solo video.
     */
    if (!puedeComprar) {
      AppSnack.info(context, 'Antes de comprar vamos a pedirte un teléfono de contacto.');
      return;
    }

    final variantId = datos.variantePorDefectoId;
    if (variantId == null) {
      AppSnack.info(context, 'Este producto todavía no tiene variantes para comprar.');
      return;
    }

    await ReserveSheet.mostrar(
      context,
      productVariantId: variantId,
      nombreProducto: datos.nombre,
      precio: datos.precio,
    );

    // Al cerrar la hoja se recarga el feed: si se apartó una unidad, la
    // disponibilidad que se muestra cambió.
    ref.invalidate(feedProvider);
  }
}

class _SinFoto extends StatelessWidget {
  const _SinFoto();

  @override
  Widget build(BuildContext context) {
    return const ColoredBox(
      color: AppColor.superficieAlta,
      child: Icon(Icons.image_outlined, size: 20, color: AppColor.textoSuave),
    );
  }
}

class _AccionesLaterales extends StatefulWidget {
  const _AccionesLaterales({required this.publicacion});
  final PublicacionFeed publicacion;

  @override
  State<_AccionesLaterales> createState() => _AccionesLateralesState();
}

class _AccionesLateralesState extends State<_AccionesLaterales> {
  bool _meGusta = false;

  @override
  void didUpdateWidget(_AccionesLaterales anterior) {
    super.didUpdateWidget(anterior);
    // Al cambiar de publicación el "me gusta" se reinicia. Sin esto, el corazón
    // quedaría marcado en la siguiente sin que nadie lo haya tocado.
    if (anterior.publicacion.id != widget.publicacion.id) _meGusta = false;
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _Accion(
          icono: _meGusta ? Icons.favorite_rounded : Icons.favorite_border_rounded,
          color: _meGusta ? AppColor.acento : Colors.white,
          etiqueta: 'Me gusta',
          onTap: () => setState(() => _meGusta = !_meGusta),
        ),
        const SizedBox(height: Gap.lg),
        _Accion(
          icono: Icons.mode_comment_outlined,
          etiqueta: 'Comentar',
          onTap: () => AppSnack.info(context, 'Los comentarios llegan con el chat del vivo.'),
        ),
        const SizedBox(height: Gap.lg),
        _Accion(
          icono: Icons.share_outlined,
          etiqueta: 'Enviar',
          onTap: () => AppSnack.info(
            context,
            'vendox.com/${widget.publicacion.tiendaSlug}',
          ),
        ),
        const SizedBox(height: Gap.lg),
        _Accion(
          icono: Icons.storefront_outlined,
          etiqueta: 'Tienda',
          onTap: () => AppSnack.info(
            context,
            'La tienda de ${widget.publicacion.tiendaNombre} llega con la vidriera pública.',
          ),
        ),
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

/// Todavía no hay nada publicado.
///
/// No se rellena con productos de ejemplo. Un catálogo falso hace que el
/// vendedor crea que la app ya tiene contenido y no publique el suyo — que es
/// justamente lo único que puede llenar este feed hoy.
class _FeedVacio extends ConsumerWidget {
  const _FeedVacio();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                gradient: const LinearGradient(colors: [AppColor.acento, AppColor.acentoOscuro]),
                borderRadius: BorderRadius.circular(Redondeo.lg),
              ),
              child: const Icon(Icons.storefront_rounded, size: 34, color: Colors.white),
            ),
            const SizedBox(height: Gap.xl),
            Text('Todavía no hay nada acá', style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: Gap.sm),
            const Text(
              'Sé el primero en publicar. Creás tu tienda en un paso y tu '
              'producto aparece en este feed.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColor.textoSuave, fontSize: 15, height: 1.5),
            ),
            const SizedBox(height: Gap.xl),
            FilledButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const SellerHomeScreen()),
              ),
              child: const Text('Empezar a vender'),
            ),
            const SizedBox(height: Gap.sm),
            TextButton(
              onPressed: () => ref.read(feedProvider.notifier).recargar(),
              child: const Text('Actualizar'),
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorDeFeed extends StatelessWidget {
  const _ErrorDeFeed({required this.mensaje, required this.onReintentar});
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
            const Icon(Icons.cloud_off_rounded, size: 40, color: AppColor.textoDebil),
            const SizedBox(height: Gap.lg),
            const Text(
              'No pudimos cargar el feed',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: Gap.sm),
            Text(
              mensaje,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColor.textoSuave, fontSize: 13.5),
            ),
            const SizedBox(height: Gap.xl),
            OutlinedButton(onPressed: onReintentar, child: const Text('Reintentar')),
          ],
        ),
      ),
    );
  }
}
