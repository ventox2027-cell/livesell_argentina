import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/config/traza_de_arranque.dart';
import '../../../core/design/tokens.dart';
import '../../../core/network/errores_de_red.dart';
import '../../../core/network/reintentar_al_volver_la_red.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../auth/domain/session.dart';
import '../../auth/state/auth_providers.dart';
import '../../lives/presentation/variant_sheet.dart';
import '../../lives/presentation/seller_profile_screen.dart';
import '../../seller/data/seller_repository.dart';
import '../../seller/presentation/seller_home_screen.dart';
import '../../lives/presentation/tienda_screen.dart';
import '../../social/data/perfil_de_vendedor.dart';
import '../../social/data/social_api.dart';
import '../data/feed_repository.dart';
import '../domain/feed_models.dart';
import '../domain/pestana_del_feed.dart';

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
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * DOS PESTAÑAS, DOS PROVIDERS — Y SE OBSERVA UNO SOLO
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Cada pestaña tiene su provider, con su lista y su cursor. Ir y volver no
     * pierde el lugar donde alguien estaba mirando: ninguno de los dos es
     * `autoDispose`, así que el que ya cargó se conserva mientras la app viva.
     *
     * ⚠️ Y SE OBSERVA SÓLO EL DE LA PESTAÑA ACTIVA.
     *
     * La primera versión observaba los dos —para que el inactivo no se
     * desechara— y eso pedía el feed DOS VECES al abrir la app: la segunda, de
     * una pestaña que nadie está mirando, compitiendo por la misma conexión.
     * Lo encontró `arranque_test.dart`, que cuenta peticiones.
     *
     * «Siguiendo» se pide la primera vez que alguien la toca, y no antes.
     */
    final pestana = ref.watch(pestanaDelFeedProvider);
    final cual = pestana.esSiguiendo ? feedDeSeguidosProvider : feedProvider;
    final feed = ref.watch(cual);

    return feed.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) {
        void recargar() => ref.read(cual.notifier).recargar();
        return ReintentarAlVolverLaRed(
          error: e,
          onReintentar: recargar,
          child: _ErrorDeFeed(mensaje: mensajeDeError(e), onReintentar: recargar),
        );
      },
      data: (publicaciones) {
        /**
         * El final del arranque, medido donde se siente.
         *
         * «La app abrió» no es cuando `runApp` devuelve: es cuando hay algo que
         * mirar. Todo lo anterior —el primer frame, la sesión, el pedido del
         * feed— sólo importa por cuánto retrasa este momento.
         *
         * Se informa una sola vez: `informar` vacía las marcas, y en las
         * recargas posteriores no queda ninguna.
         */
        if (TrazaDeArranque.instancia.corriendo) {
          TrazaDeArranque.instancia.paso('→ feed visible');
          TrazaDeArranque.instancia.informar('arranque');
        }

        /**
         * Vacío no es lo mismo en las dos pestañas.
         *
         * En «Para vos», que no haya nada significa que todavía no hay
         * catálogo: lo que corresponde es invitar a publicar. En «Siguiendo»
         * significa que esta persona no sigue a nadie —o que a quienes sigue no
         * les queda nada publicado—, y decirle «sé el primero en publicar» ahí
         * no tiene ningún sentido.
         */
        if (publicaciones.isEmpty) {
          return pestana.esSiguiendo ? const _SinSeguidos() : const _FeedVacio();
        }

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
                  // La pestaña que se está mirando, no siempre «Para vos».
                  ref.read(cual.notifier).cargarMas();
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
    final pestana = ref.watch(pestanaDelFeedProvider);

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
                _Pestana(
                  'Siguiendo',
                  activa: pestana.esSiguiendo,
                  onTap: () => ref
                      .read(pestanaDelFeedProvider.notifier)
                      .elegir(PestanaDelFeed.siguiendo),
                ),
                const SizedBox(width: Gap.xl),
                _Pestana(
                  'Para vos',
                  activa: !pestana.esSiguiendo,
                  onTap: () =>
                      ref.read(pestanaDelFeedProvider.notifier).elegir(PestanaDelFeed.paraVos),
                ),
                const Spacer(),
                IconButton(
                  // Recarga la pestaña que se está mirando.
                  onPressed: () => ref
                      .read(
                        pestana.esSiguiendo
                            ? feedDeSeguidosProvider.notifier
                            : feedProvider.notifier,
                      )
                      .recargar(),
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

/// Una de las dos pestañas del feed.
///
/// ⚠️ Tiene `onTap`. Parece obvio y es justo lo que faltaba: «Siguiendo» estaba
/// dibujada al lado de «Para vos», con su subrayado apagado, y no la escuchaba
/// nadie. Tocarla no hacía nada porque no había nada que hacer.
///
/// El área táctil se agranda con `padding` y `HitTestBehavior.opaque`: el texto
/// solo mide unos 14 píxeles de alto, que es la mitad de lo que un dedo puede
/// apuntar con confianza.
class _Pestana extends StatelessWidget {
  const _Pestana(this.texto, {required this.activa, required this.onTap});
  final String texto;
  final bool activa;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: Gap.sm, vertical: Gap.sm),
        child: Column(
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
        ),
      ),
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

/// Seguir a un vendedor desde el feed.
///
/// ─── Antes era un booleano local, y eso era una mentira ───
///
/// El botón alternaba un `bool` en memoria: se ponía en "Siguiendo", no
/// mandaba nada al servidor, y al volver a abrir la app decía "Seguir" otra
/// vez. La persona creía que iba a recibir avisos de los vivos de ese vendedor
/// y no iba a recibir ninguno.
///
/// ─── Y después fue un booleano local POR TARJETA, que también era una ───
///
/// Cada publicación tenía su propio `bool? _siguiendo` y su propia consulta del
/// perfil. Con tres productos del mismo vendedor en pantalla, seguirlo desde
/// uno dejaba ese en «Siguiendo» y los otros dos en «Seguir»: tres respuestas
/// distintas a la misma pregunta. Y treinta productos de cuatro vendedores eran
/// treinta peticiones para responder cuatro preguntas.
///
/// Ahora el estado vive en `perfilDeVendedorProvider`, con clave `sellerId`, y
/// todas las superficies —feed, vivo y perfil— observan el mismo.
class _BotonSeguir extends ConsumerWidget {
  const _BotonSeguir({required this.sellerId});

  final String sellerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    /**
     * ⚠️ SOBRE LA TIENDA PROPIA NO SE DIBUJA NADA.
     *
     * El backend rechaza que alguien se siga a sí mismo —el número de
     * seguidores es una señal de confianza y auto-incrementarlo la degrada— y
     * la app se tragaba ese error en silencio. Desde afuera se veía un botón
     * que no hacía nada.
     *
     * Se compara por id de vendedor, nunca por nombre de tienda: ver
     * `esMiTiendaProvider`. Y sólo se dibuja cuando SABEMOS que no es propia
     * —`false`, no `null`— para que no aparezca un instante y desaparezca.
     */
    if (ref.watch(esMiTiendaProvider(sellerId)) != false) return const SizedBox.shrink();

    final vista = ref.watch(perfilDeVendedorProvider(sellerId)).valueOrNull;

    // Sin dato no se dibuja: mostrar «Seguir» sobre un estado que no pudimos
    // leer es afirmar algo que quizá no es cierto. Y `loSigo` es `null` cuando
    // no hay sesión, donde el botón tampoco tiene sentido.
    final siguiendo = vista?.loSigo;
    if (siguiendo == null) return const SizedBox.shrink();

    return GestureDetector(
      // El doble toque lo frena el notifier, que es quien sabe si hay algo
      // viajando. Acá sólo se apaga el gesto para que se note.
      onTap: vista!.alternando ? null : () => unawaited(_alternar(context, ref)),
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

  /// ⚠️ El error NO se traga.
  ///
  /// El estado ya volvió a lo que era —lo hace el notifier— y acá se dice por
  /// qué. Un botón que no hace nada y no explica nada es indistinguible de uno
  /// roto.
  Future<void> _alternar(BuildContext context, WidgetRef ref) async {
    try {
      await ref.read(perfilDeVendedorProvider(sellerId).notifier).alternar();
    } catch (e) {
      if (context.mounted) AppSnack.error(context, mensajeDeError(e));
    }
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

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * COMPRAR PIDE EL PRODUCTO DE NUEVO. NO USA LO QUE MUESTRA EL FEED
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Acá estaba el bug: se abría `ReserveSheet` directo con `datos.precio` y
     * `datos.variantePorDefectoId`, o sea con lo que el feed tenía en memoria.
     * Un feed cargado hace un rato mostraba $150.000 sobre un producto que el
     * vendedor ya había bajado a $10, y la persona apartaba mirando el precio
     * viejo.
     *
     * El feed puede estar momentáneamente viejo —es una lista cacheada y está
     * bien que lo sea—, pero **iniciar una compra es una operación comercial**
     * y no puede confiar en ese snapshot.
     *
     * `VariantSheet` es el camino que ya usaban el vivo, la tienda y la
     * búsqueda: pide el producto al backend, muestra el precio actual, el
     * stock actual y las variantes que existen hoy, y recién después encadena
     * con `ReserveSheet`. Ahora los cuatro caminos entran por el mismo lugar.
     *
     * ⚠️ No agrega un paso: con una sola variante, `VariantSheet` la elige
     * sola y queda a un toque de «Apartar», igual que antes.
     */
    await VariantSheet.mostrar(
      context,
      productId: datos.id,
      storeId: datos.storeId.isEmpty ? null : datos.storeId,
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

class _AccionesLaterales extends ConsumerStatefulWidget {
  const _AccionesLaterales({required this.publicacion});
  final PublicacionFeed publicacion;

  @override
  ConsumerState<_AccionesLaterales> createState() => _AccionesLateralesState();
}

class _AccionesLateralesState extends ConsumerState<_AccionesLaterales> {
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
          onTap: () => AppSnack.info(context, 'Los comentarios llegan pronto.'),
        ),
        const SizedBox(height: Gap.lg),
        _Accion(
          icono: Icons.share_outlined,
          etiqueta: 'Enviar',
          onTap: () => unawaited(_compartir()),
        ),
        const SizedBox(height: Gap.lg),
        _Accion(
          icono: Icons.storefront_outlined,
          etiqueta: 'Tienda',
          onTap: () => unawaited(_abrirTienda()),
        ),
      ],
    );
  }

  /// Comparte el PRODUCTO, con el enlace que arma el backend.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// EL ENLACE NO SE ARMA ACÁ
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Antes esto mostraba un aviso con `vendox.com/<slug de la tienda>`: no era
  /// un enlace real, no llevaba al producto y no abría ninguna hoja de
  /// compartir. Dos cosas mal — el destino y el mecanismo.
  ///
  /// El destino ahora es el producto, que es lo que la persona está mirando:
  /// `vendox.com.ar/p/<id>`, la URL canónica que ya usan el vivo y la tienda, y
  /// que `destino.dart` resuelve como App Link para abrir la app si está
  /// instalada.
  ///
  /// Y lo arma el BACKEND (`GET /share/product/:id`), igual que en el vivo: un
  /// enlace compartido sobrevive a la versión de la app que lo generó, y si
  /// cada versión tuviera su propia idea del formato, cambiarlo rompería los
  /// que ya están dando vueltas en los chats.
  Future<void> _compartir() async {
    try {
      final mensaje = await ref
          .read(socialApiProvider)
          .compartir('product', widget.publicacion.id, origen: 'feed');

      if (!mounted || mensaje.texto.isEmpty) return;
      await Share.share(mensaje.texto);
    } catch (_) {
      /**
       * Sin cartel, igual que en el vivo.
       *
       * Compartir es opcional y el feed sigue andando. Una pantalla de error
       * encima de lo que la persona vino a mirar, porque una petición
       * secundaria no llegó, molesta más de lo que informa.
       */
    }
  }

  /// La tienda del vendedor de esta publicación.
  ///
  /// Es la misma pantalla que se abre desde el vivo y desde el perfil: una sola
  /// vidriera en toda la app. Antes acá había un aviso que decía que la tienda
  /// «llega con la vidriera pública» — y la vidriera ya existe.
  Future<void> _abrirTienda() async {
    final storeId = widget.publicacion.storeId;
    if (storeId.isEmpty) return;

    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TiendaScreen(
          storeId: storeId,
          nombreTienda: widget.publicacion.tiendaNombre,
        ),
      ),
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
/// «Siguiendo» sin nada que mostrar.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// UNA PANTALLA VACÍA NO ES UNA PANTALLA ROTA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Quien entra acá el primer día no sigue a nadie, y eso es lo normal, no un
/// error. Lo que hace falta es decir qué se gana siguiendo a alguien y cómo se
/// hace — el botón «Seguir» está en el perfil del vendedor y en cada
/// publicación, y desde acá no se ve ninguno.
///
/// ⚠️ Sin sesión el mensaje es otro. No es que no siga a nadie: es que todavía
/// no hay cuenta a la que atarle nada. Decirle «seguí vendedores» a alguien que
/// no puede seguir a nadie es mandarlo a buscar un botón que no va a encontrar.
class _SinSeguidos extends ConsumerWidget {
  const _SinSeguidos();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final haySesion = ref.watch(sesionProvider) is ConSesion;

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
                color: AppColor.superficieAlta,
                borderRadius: BorderRadius.circular(Redondeo.lg),
              ),
              child: const Icon(
                Icons.person_add_alt_1_outlined,
                size: 32,
                color: AppColor.textoSuave,
              ),
            ),
            const SizedBox(height: Gap.xl),
            Text(
              haySesion ? 'Todavía no seguís a nadie' : 'Seguí a tus vendedores',
              style: Theme.of(context).textTheme.headlineSmall,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: Gap.sm),
            Text(
              haySesion
                  ? 'Cuando sigas a un vendedor, sus productos y sus vivos '
                      'aparecen acá. Tocá «Seguir» en su perfil o en cualquier '
                      'publicación.'
                  : 'Entrá a tu cuenta para seguir vendedores y tener acá lo '
                      'que publican.',
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColor.textoSuave, fontSize: 15, height: 1.5),
            ),
            const SizedBox(height: Gap.xl),
            FilledButton(
              onPressed: () =>
                  ref.read(pestanaDelFeedProvider.notifier).elegir(PestanaDelFeed.paraVos),
              child: const Text('Descubrir vendedores'),
            ),
            const SizedBox(height: Gap.sm),
            TextButton(
              onPressed: () => ref.read(feedDeSeguidosProvider.notifier).recargar(),
              child: const Text('Actualizar'),
            ),
          ],
        ),
      ),
    );
  }
}

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
