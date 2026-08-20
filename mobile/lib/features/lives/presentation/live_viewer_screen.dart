import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/design/tokens.dart';
import '../../../core/network/reintentar_al_volver_la_red.dart';
import '../../moderation/presentation/reportar_sheet.dart';
import '../../social/data/social_api.dart';
import '../../auth/state/auth_providers.dart';
import '../data/live_api.dart';
import '../data/live_realtime.dart';
import '../domain/live_models.dart';
import 'widgets/chat_overlay.dart';
import 'widgets/composer.dart';
import 'widgets/producto_destacado_card.dart';
import 'widgets/rail_de_acciones.dart';
import 'layout_del_vivo.dart';
import '../../auth/domain/session.dart';
import 'widgets/acciones_de_mensaje.dart';
import 'widgets/video_live.dart';
import 'seller_profile_screen.dart';
import '../../../core/network/errores_de_red.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../seller/data/seller_repository.dart';
import '../../social/data/perfil_de_vendedor.dart';
import 'tienda_screen.dart';
import 'variant_sheet.dart';

/// El vivo, a pantalla completa.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL ORDEN DE LA ZONA INFERIOR NO ES ESTÉTICO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// De arriba hacia abajo:
///
///     comentarios
///     PRODUCTO DESTACADO      ← lo que se está vendiendo AHORA
///     escribí un comentario
///     vendedor · seguir
///
/// El producto va **arriba** del vendedor, y no al revés. Lo que decide una
/// compra es el producto con su precio y su stock; el nombre de la tienda es
/// contexto. Poner el producto más abajo lo deja pegado al borde, donde compite
/// con la barra de navegación y donde el pulgar lo tapa al hacer scroll.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL TECLADO: LO MÁS DELICADO DE ESTA PANTALLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// `resizeToAvoidBottomInset: false`.
///
/// Con el valor por omisión, Flutter encoge todo el `Scaffold` cuando aparece
/// el teclado: **se desplaza la interfaz entera**, video incluido. Apagándolo,
/// el video, el encabezado, el velo y la columna de acciones ni se enteran de
/// que hay un teclado, y sólo se acomodan los dos bloques que tienen que estar
/// por encima de él.
///
/// Las posiciones se calculan en [medirZonaInferior] —módulo puro, con tests—.
/// Ahí también está explicado por qué el producto destacado no puede quedarse
/// literalmente clavado: con el orden acordado quedaría **detrás** del teclado,
/// que es justo lo que había que evitar. La regla que sí se cumple es que nunca
/// baja y nunca queda tapado.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL VIDEO NO SE TOCA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Abrir el teclado, la tienda, el selector de variantes o el checkout **no**
/// desconecta LiveKit. Todo eso son capas encima: bottom sheets y overlays
/// sobre esta pantalla, que sigue montada. Reconectar el stream por abrir un
/// panel se ve como un parpadeo negro de dos segundos justo cuando alguien
/// estaba por comprar.
class LiveViewerScreen extends ConsumerStatefulWidget {
  const LiveViewerScreen({super.key, required this.liveId});

  final String liveId;

  @override
  ConsumerState<LiveViewerScreen> createState() => _LiveViewerScreenState();
}

class _LiveViewerScreenState extends ConsumerState<LiveViewerScreen> {
  DetalleDeLive? _live;
  Object? _error;
  bool _cargando = true;

  LiveRealtime? _realtime;
  final List<MensajeDeChat> _mensajes = [];
  int _espectadores = 0;

  final _controladorComposer = TextEditingController();
  final _focoComposer = FocusNode();

  final List<StreamSubscription<dynamic>> _suscripciones = [];

  @override
  void initState() {
    super.initState();
    unawaited(_cargar());
  }

  @override
  void dispose() {
    for (final s in _suscripciones) {
      unawaited(s.cancel());
    }
    _realtime?.dispose();
    _controladorComposer.dispose();
    _focoComposer.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    try {
      final live = await ref.read(liveApiProvider).ver(widget.liveId);
      if (!mounted) return;

      setState(() {
        _live = live;
        _cargando = false;
      });

      _conectarRealtime();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _cargando = false;
      });
    }
  }

  void _conectarRealtime() {
    /**
     * El realtime se conecta aunque el vivo haya terminado.
     *
     * Suena innecesario y no lo es: alguien puede estar mirando un vivo
     * terminado mientras el vendedor arranca otro, y el chat de despedida sigue
     * teniendo sentido. Lo que no se conecta es el video, que no existe.
     */
    // El token vive en el almacén seguro y se lee de forma asíncrona.
    unawaited(_conectarConToken());
  }

  Future<void> _conectarConToken() async {
    final token = await ref.read(tokenStoreProvider).accessToken();
    if (token == null || !mounted) return;

    final rt = LiveRealtime(token: token);
    rt.conectar();
    rt.entrarA(widget.liveId);

    _suscripciones.addAll([
      rt.chat.listen((m) {
        if (!mounted) return;
        setState(() {
          _mensajes.add(m);
          // Se guardan los últimos 50. El chat de un vivo con mil personas
          // acumularía miles de widgets en memoria y nadie sube a leerlos.
          if (_mensajes.length > 50) _mensajes.removeAt(0);
        });
      }),
      rt.espectadores.listen((n) {
        if (mounted) setState(() => _espectadores = n);
      }),
      rt.stock.listen((e) {
        final actual = _live?.destacado;
        if (actual == null || actual.variantId != e.variantId) return;
        if (mounted) {
          setState(() {
            _live = _conDestacado(actual.conDisponible(e.disponible));
          });
        }
      }),
      rt.productoDestacado.listen((j) {
        if (!mounted) return;
        final variantId = j['variantId'] as String?;
        setState(() {
          _live = _conDestacado(
            variantId == null ? null : ProductoDestacado.fromJson(j),
          );
        });
      }),
      rt.estado.listen((estado) {
        if (mounted) setState(() => _live = _conEstado(estado));
      }),
    ]);

    _realtime = rt;
  }

  DetalleDeLive? _conDestacado(ProductoDestacado? p) {
    final l = _live;
    if (l == null) return null;
    return DetalleDeLive(
      id: l.id,
      titulo: l.titulo,
      estado: l.estado,
      portada: l.portada,
      vendedorId: l.vendedorId,
      vendedorNombre: l.vendedorNombre,
      identidadVerificada: l.identidadVerificada,
      storeId: l.storeId,
      tiendaNombre: l.tiendaNombre,
      destacado: p,
      video: l.video,
      terminadoEl: l.terminadoEl,
      // Se arrastra: sin esto, el primer evento de stock le sacaba al vendedor
      // las opciones de moderación de su propio chat.
      soyElVendedor: l.soyElVendedor,
    );
  }

  DetalleDeLive? _conEstado(String estado) {
    final l = _live;
    if (l == null) return null;
    return DetalleDeLive(
      id: l.id,
      titulo: l.titulo,
      estado: estado,
      portada: l.portada,
      vendedorId: l.vendedorId,
      vendedorNombre: l.vendedorNombre,
      identidadVerificada: l.identidadVerificada,
      storeId: l.storeId,
      tiendaNombre: l.tiendaNombre,
      destacado: l.destacado,
      // Un vivo que terminó pierde el video pero conserva TODO lo demás.
      video: estado == 'ENDED' || estado == 'FAILED' ? null : l.video,
      terminadoEl: l.terminadoEl,
      soyElVendedor: l.soyElVendedor,
    );
  }

  void _enviarMensaje() {
    final texto = _controladorComposer.text.trim();
    if (texto.isEmpty) return;
    _realtime?.enviarMensaje(texto);
    _controladorComposer.clear();
    // El foco NO se suelta: quien comentó en un vivo suele comentar otra vez, y
    // cerrar el teclado en cada mensaje obliga a volver a abrirlo.
  }

  Future<void> _comprar(String productId) async {
    /**
     * El checkout NO saca a nadie del vivo.
     *
     * Todo lo que sigue son bottom sheets sobre esta pantalla, que se queda
     * montada con su video corriendo. No hay `Navigator.push` a otra ruta.
     */
    final pedido = await VariantSheet.mostrar(
      context,
      productId: productId,
      storeId: _live?.storeId,
      liveSessionId: widget.liveId,
    );

    if (pedido != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('✓ Compra realizada · pedido ${pedido.referencia}'),
          backgroundColor: AppColor.exito,
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  /// Abre la tienda del vendedor, encima del vivo.
  ///
  /// ⚠️ `push`, no una hoja, y el vivo NO se desmonta: Flutter conserva las
  /// rutas de abajo. Está medido en `tienda_desde_el_vivo_test.dart` con un
  /// centinela que cuenta sus propios `initState`/`dispose` — si algún día eso
  /// dejara de ser cierto, LiveKit se desconectaría al abrir la tienda y ese
  /// test lo dice.
  ///
  /// Volver es el botón de atrás: devuelve al vivo tal como estaba, sin
  /// reconectar y sin perder los mensajes del chat.
  Future<void> _abrirTienda() async {
    final live = _live;
    if (live == null) return;

    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TiendaScreen(
          storeId: live.storeId,
          nombreTienda: live.tiendaNombre,
          // Con esto la tienda muestra «EN VIVO» y ofrece volver. Y es lo que
          // habilita el precio exclusivo del vivo al comprar desde el catálogo.
          liveDetras: live.video == null ? null : live.id,
        ),
      ),
    );
  }

  /// Comparte el vivo por la hoja nativa del sistema.
  ///
  /// El texto y la URL los arma el BACKEND. Acá sólo se muestran: un enlace
  /// compartido sobrevive a la versión de la app que lo generó, y si cada
  /// versión tuviera su propia idea del formato, cambiarlo rompería los que ya
  /// están dando vueltas en los chats.
  /// Mantener apretado un mensaje del chat.
  ///
  /// Reportar lo puede hacer cualquiera; borrar y silenciar, sólo el vendedor
  /// en su propio vivo. Quién es quién lo decide el backend igual —404 si el
  /// vivo no es suyo— así que esto es interfaz, no seguridad.
  Future<void> _accionesDeMensaje(MensajeDeChat mensaje) async {
    final live = _live;
    if (live == null) return;

    final sesion = ref.read(sesionProvider);
    final miUserId = sesion is ConSesion ? sesion.usuario.id : null;
    if (miUserId == null) return;

    // Los mensajes propios no se reportan ni se moderan a uno mismo.
    if (mensaje.userId == miUserId) return;

    final borrado = await AccionesDeMensaje.mostrar(
      context,
      mensaje: mensaje,
      liveSessionId: live.id,
      soyElVendedor: live.soyElVendedor,
    );

    // Se saca de la lista en el acto: esperar al próximo evento dejaría el
    // mensaje visible después de que el vendedor lo borró.
    if (borrado && mounted) {
      setState(() => _mensajes.removeWhere((m) => m.id == mensaje.id));
    }
  }

  Future<void> _compartir(String liveId) async {
    try {
      final m = await ref.read(socialApiProvider).compartir('live', liveId, origen: 'live');
      if (!mounted || m.texto.isEmpty) return;
      await Share.share(m.texto);
    } catch (_) {
      // Sin cartel: compartir es opcional y el vivo sigue andando. Un error
      // acá interrumpiría lo que la persona vino a mirar.
    }
  }

  @override
  Widget build(BuildContext context) {
    final teclado = MediaQuery.viewInsetsOf(context).bottom;
    final abajo = MediaQuery.paddingOf(context).bottom;

    final live = _live;

    // Toda la aritmética del teclado vive en `layout_del_vivo.dart`, y está
    // cubierta por tests. Acá sólo se dibuja donde diga.
    final medidas = medirZonaInferior(
      teclado: teclado,
      abajo: abajo,
      hayProducto: live?.destacado != null,
      // Para que el chat no trepe por encima del encabezado en pantallas
      // chicas: su alto es un tope, recortado por lo que quede libre.
      altoPantalla: MediaQuery.sizeOf(context).height,
      arriba: MediaQuery.paddingOf(context).top,
    );

    return Scaffold(
      backgroundColor: Colors.black,
      // ⚠️ La línea que hace que el producto no salte. Ver la nota de arriba.
      resizeToAvoidBottomInset: false,
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : live == null
              ? ReintentarAlVolverLaRed(
                  error: _error,
                  onReintentar: () => unawaited(_cargar()),
                  child: _Error(error: _error, onReintentar: _cargar),
                )
              : Stack(
                  fit: StackFit.expand,
                  children: [
                    // ─── 1. El video, siempre el fondo ───
                    VideoLive(live: live),

                    // Velo para que el texto se lea sobre cualquier imagen.
                    const IgnorePointer(
                      child: DecoratedBox(decoration: BoxDecoration(gradient: AppColor.velo)),
                    ),

                    // ─── 2. Encabezado ───
                    Positioned(
                      top: MediaQuery.paddingOf(context).top + Gap.sm,
                      left: Gap.md,
                      right: Gap.md,
                      child: _Encabezado(
                        live: live,
                        espectadores: _espectadores,
                        onCerrar: () => Navigator.of(context).maybePop(),
                      ),
                    ),

                    // ─── 3. Acciones laterales ───
                    Positioned(
                      right: Gap.sm,
                      bottom: abajo + 200,
                      child: RailDeAcciones(
                        liveSessionId: live.id,
                        onTienda: _abrirTienda,
                        onCompartir: () => _compartir(live.id),
                        onReportar: () => ReportarSheet.mostrar(
                          context,
                          targetType: 'LIVE',
                          targetId: live.id,
                        ),
                        onComentar: () => _focoComposer.requestFocus(),
                        onPerfil: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => SellerProfileScreen(sellerId: live.vendedorId),
                          ),
                        ),
                      ),
                    ),

                    // ─── 4. Chat ───
                    //
                    // Se achica cuando el teclado está abierto: es lo único que
                    // puede ceder espacio sin perder función.
                    Positioned(
                      left: Gap.md,
                      right: 84,
                      bottom: medidas.chat,
                      height: medidas.altoDelChat,
                      child: ChatOverlay(
                        mensajes: _mensajes,
                        onMantenerApretado: _accionesDeMensaje,
                      ),
                    ),

                    // ─── 5. Producto destacado ───
                    //
                    // ⚠️ Nunca baja y nunca queda tapado por el teclado. La
                    // cuenta —y por qué no puede quedarse literalmente clavado—
                    // está en `layout_del_vivo.dart`.
                    if (live.destacado != null && medidas.producto != null)
                      Positioned(
                        key: const Key('producto-destacado'),
                        left: Gap.md,
                        right: Gap.md,
                        bottom: medidas.producto!,
                        child: ProductoDestacadoCard(
                          producto: live.destacado!,
                          puedeComprar: live.alAire,
                          onComprar: () => _comprar(live.destacado!.productId),
                        ),
                      ),

                    // ─── 6. Composer ───
                    //
                    // Se ancla justo arriba del teclado.
                    Positioned(
                      key: const Key('composer'),
                      left: Gap.md,
                      right: Gap.md,
                      bottom: medidas.composer,
                      child: Composer(
                        controlador: _controladorComposer,
                        foco: _focoComposer,
                        habilitado: !live.terminado,
                        onEnviar: _enviarMensaje,
                      ),
                    ),

                    // ─── 7. Vendedor ───
                    //
                    // Se oculta con el teclado abierto: mientras se escribe es
                    // lo menos importante de la pantalla.
                    if (medidas.mostrarVendedor)
                      Positioned(
                        left: Gap.md,
                        right: Gap.md,
                        bottom: medidas.vendedor,
                        child: _FilaDeVendedor(live: live),
                      ),

                    // ─── 8. El vivo terminó ───
                    if (live.terminado)
                      Positioned(
                        left: 0,
                        right: 0,
                        top: 0,
                        bottom: 0,
                        child: IgnorePointer(
                          ignoring: true,
                          child: Container(color: Colors.black.withValues(alpha: 0.35)),
                        ),
                      ),
                    if (live.terminado)
                      Positioned(
                        left: Gap.md,
                        right: Gap.md,
                        top: MediaQuery.sizeOf(context).height * 0.32,
                        child: _LiveTerminado(
                          live: live,
                          onVerTienda: _abrirTienda,
                        ),
                      ),
                  ],
                ),
    );
  }
}

class _Encabezado extends StatelessWidget {
  const _Encabezado({
    required this.live,
    required this.espectadores,
    required this.onCerrar,
  });

  final DetalleDeLive live;
  final int espectadores;
  final VoidCallback onCerrar;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        // El estado, con texto además del color: "en vivo" en rojo no le dice
        // nada a quien no distingue el rojo.
        _Pastilla(
          color: live.terminado
              ? AppColor.textoSuave
              : live.reconectando
                  ? AppColor.alerta
                  : AppColor.acento,
          texto: live.terminado
              ? 'FINALIZÓ'
              : live.reconectando
                  ? 'RECONECTANDO'
                  : 'EN VIVO',
        ),
        if (espectadores > 0) ...[
          const SizedBox(width: Gap.sm),
          _Pastilla(
            color: Colors.black54,
            texto: '$espectadores',
            icono: Icons.visibility_rounded,
          ),
        ],
        const Spacer(),
        IconButton(
          onPressed: onCerrar,
          icon: const Icon(Icons.close_rounded),
          color: Colors.white,
          style: IconButton.styleFrom(backgroundColor: Colors.black38),
        ),
      ],
    );
  }
}

class _Pastilla extends StatelessWidget {
  const _Pastilla({required this.color, required this.texto, this.icono});

  final Color color;
  final String texto;
  final IconData? icono;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(20)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icono != null) ...[
            Icon(icono, size: 13, color: Colors.white),
            const SizedBox(width: 4),
          ],
          Text(
            texto,
            style: const TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.4,
              color: Colors.white,
            ),
          ),
        ],
      ),
    );
  }
}

/// El vendedor arriba del vivo, con su botón de seguir.
///
/// ⚠️ El estado de seguimiento NO vive acá. Sale de `perfilDeVendedorProvider`,
/// el mismo que miran el feed y el perfil: seguir desde el vivo se ve en las
/// tres al instante, y ninguna vuelve a preguntarle al servidor lo que otra ya
/// preguntó.
class _FilaDeVendedor extends ConsumerWidget {
  const _FilaDeVendedor({required this.live});
  final DetalleDeLive live;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Row(
      children: [
        GestureDetector(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => SellerProfileScreen(sellerId: live.vendedorId),
            ),
          ),
          child: Row(
            children: [
              CircleAvatar(
                radius: 15,
                backgroundColor: AppColor.superficieAlta,
                child: Text(
                  live.vendedorNombre.isEmpty
                      ? '?'
                      : live.vendedorNombre.substring(0, 1).toUpperCase(),
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: Gap.sm),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 150),
                child: Text(
                  live.tiendaNombre.isEmpty ? live.vendedorNombre : live.tiendaNombre,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    shadows: [Shadow(color: Colors.black87, blurRadius: 8)],
                  ),
                ),
              ),
              if (live.identidadVerificada) ...[
                const SizedBox(width: 4),
                // La insignia de IDENTIDAD. No dice nada sobre reputación:
                // eso se ve en el perfil.
                const Icon(Icons.verified_rounded, size: 15, color: AppColor.acento),
              ],
            ],
          ),
        ),
        const SizedBox(width: Gap.sm),
        _SeguirAlDelVivo(sellerId: live.vendedorId),
      ],
    );
  }
}

class _SeguirAlDelVivo extends ConsumerWidget {
  const _SeguirAlDelVivo({required this.sellerId});
  final String sellerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Sobre el vivo propio no se dibuja: nadie se sigue a sí mismo, y el
    // backend lo rechaza. Ver `esMiTiendaProvider`.
    if (ref.watch(esMiTiendaProvider(sellerId)) != false) return const SizedBox.shrink();

    final vista = ref.watch(perfilDeVendedorProvider(sellerId)).valueOrNull;
    final siguiendo = vista?.loSigo;
    if (siguiendo == null) return const SizedBox.shrink();

    return _BotonSeguir(
      siguiendo: siguiendo,
      cargando: vista!.alternando,
      onTap: () => unawaited(_alternar(context, ref)),
    );
  }

  /// El error se muestra. El estado ya volvió solo a lo que era.
  Future<void> _alternar(BuildContext context, WidgetRef ref) async {
    try {
      await ref.read(perfilDeVendedorProvider(sellerId).notifier).alternar();
    } catch (e) {
      if (context.mounted) AppSnack.error(context, mensajeDeError(e));
    }
  }
}

class _BotonSeguir extends StatelessWidget {
  const _BotonSeguir({
    required this.siguiendo,
    required this.cargando,
    required this.onTap,
  });

  final bool siguiendo;
  final bool cargando;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: cargando ? null : onTap,
      child: AnimatedContainer(
        duration: Duraciones.rapida,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(
          color: siguiendo ? Colors.transparent : AppColor.acento,
          border: Border.all(color: siguiendo ? Colors.white54 : AppColor.acento),
          borderRadius: BorderRadius.circular(20),
        ),
        child: Text(
          siguiendo ? 'Siguiendo' : 'Seguir',
          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: Colors.white),
        ),
      ),
    );
  }
}

/// Lo que se ve cuando el vivo terminó.
///
/// ⚠️ **No es una pantalla negra ni una vuelta al feed.**
///
/// El momento de más intención de compra suele ser justo cuando el vivo
/// termina: alguien que estuvo veinte minutos mirando un producto no deja de
/// quererlo porque se cortó el video. Perder el contexto ahí es perder la
/// venta.
class _LiveTerminado extends ConsumerWidget {
  const _LiveTerminado({required this.live, required this.onVerTienda});

  final DetalleDeLive live;
  final VoidCallback onVerTienda;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FutureBuilder<EstadoDeTienda>(
      future: ref.read(liveApiProvider).estadoDeTienda(live.storeId),
      builder: (context, snap) {
        // Mientras no se sabe, se asume abierta: mostrar "cerrada" y que no lo
        // esté frena una venta; al revés, el backend rechaza y no pasa nada.
        final tienda = snap.data;
        final abierta = tienda?.abierta ?? true;

        return Container(
          padding: const EdgeInsets.all(Gap.lg),
          decoration: BoxDecoration(
            color: AppColor.superficie.withValues(alpha: 0.96),
            borderRadius: BorderRadius.circular(Redondeo.lg),
            border: Border.all(color: AppColor.borde),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.videocam_off_rounded, size: 34, color: AppColor.textoSuave),
              const SizedBox(height: Gap.sm),
              const Text(
                'Este LIVE finalizó',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 4),
              Text(
                abierta ? 'La tienda sigue abierta' : tienda?.motivo ?? 'La tienda está cerrada',
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColor.textoSuave, fontSize: 14),
              ),
              const SizedBox(height: Gap.lg),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: onVerTienda,
                  child: Text(abierta ? 'Ver la tienda' : 'Ver productos'),
                ),
              ),
              if (!abierta) ...[
                const SizedBox(height: Gap.xs),
                const Text(
                  'Podés dejar tu interés y te avisamos al abrir.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppColor.textoSuave, fontSize: 12),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _Error extends StatelessWidget {
  const _Error({required this.error, required this.onReintentar});

  final Object? error;
  final Future<void> Function() onReintentar;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.wifi_off_rounded, size: 40, color: AppColor.textoSuave),
            const SizedBox(height: Gap.md),
            const Text('No pudimos abrir la transmisión'),
            const SizedBox(height: Gap.lg),
            FilledButton(
              onPressed: () => unawaited(onReintentar()),
              child: const Text('Reintentar'),
            ),
          ],
        ),
      ),
    );
  }
}
