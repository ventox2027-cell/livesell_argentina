import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../core/network/reintentar_al_volver_la_red.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../moderation/data/bloqueos_api.dart';
import '../../moderation/presentation/reportar_sheet.dart';
import '../domain/live_models.dart';
import '../../../core/network/errores_de_red.dart';
import '../../seller/data/seller_repository.dart';
import '../../social/data/perfil_de_vendedor.dart';
import 'tienda_screen.dart';

/// El perfil del vendedor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LAS TRES INSIGNIAS NO SON LA MISMA COSA — Y NINGUNA SE COMPRA
/// ═══════════════════════════════════════════════════════════════════════════
///
///   **Identidad verificada** — sabemos quién es. Presentó un documento y lo
///   validamos. Es un hecho comprobable, y no dice absolutamente nada sobre si
///   vende bien.
///
///   **Vendedor confiable** — tiene historial: ventas concretadas, reseñas,
///   tiempo en la plataforma. Es reputación, y se puede perder.
///
///   **Vendedor destacado** — cumple reglas objetivas y públicas sobre muchas
///   ventas. Las define `reputacion.ts` y se recalculan solas.
///
/// Se muestran **separadas y con texto propio**. Fundirlas en un solo tilde
/// azul sería el error clásico: alguien con el DNI validado que nunca vendió
/// nada parecería tan confiable como quien lleva doscientas ventas limpias, y
/// esa confusión es exactamente la que aprovecha el que estafa.
///
/// ⚠️ **VendoX Pro no va acá.** Es una cuarta cosa —una membresía paga— y
/// dibujarla junto a estas tres haría que un sello comprado se lea como uno
/// ganado. Es la misma regla que sostiene todo lo anterior.
///
/// ─── Un vendedor nuevo no es un vendedor malo ───
///
/// Sin reseñas no se muestra "0,0 ⭐" ni "0 ventas" en rojo: se dice que recién
/// empieza. Un promedio de cero sobre cero reseñas es matemáticamente falso y
/// hunde a todo el que arranca.
class SellerProfileScreen extends ConsumerStatefulWidget {
  const SellerProfileScreen({super.key, required this.sellerId});

  final String sellerId;

  @override
  ConsumerState<SellerProfileScreen> createState() => _SellerProfileScreenState();
}

class _SellerProfileScreenState extends ConsumerState<SellerProfileScreen> {
  /// `null` mientras no se sabe: evita pintar "Bloquear" y que al abrir el
  /// menú diga "Desbloquear".
  bool? _loBloquee;

  @override
  void initState() {
    super.initState();
    unawaited(_cargarBloqueo());
  }

  /// Pide si esta persona bloqueó al vendedor.
  ///
  /// ⚠️ El perfil ya NO se carga acá: vive en `perfilDeVendedorProvider`, con
  /// clave `sellerId`, junto con el estado de seguimiento. Antes esta pantalla
  /// tenía su propia copia y su propio `_alternandoFollow`, así que seguir
  /// desde acá y volver al feed mostraba «Seguir» sobre alguien recién seguido.
  ///
  /// El bloqueo sí es de esta pantalla y de ningún otro lado.
  Future<void> _cargarBloqueo() async {
    /**
     * Va aparte y sin bloquear la pantalla porque es información secundaria:
     * si esa consulta falla, el perfil tiene que verse igual. Lo único que pasa
     * es que el menú va a ofrecer "Bloquear" cuando quizás ya está bloqueado, y
     * tocarlo es idempotente del lado del servidor.
     */
    try {
      final bloqueado = await ref.read(bloqueosApiProvider).bloqueeAlVendedor(widget.sellerId);
      if (mounted) setState(() => _loBloquee = bloqueado);
    } catch (_) {
      // Sin cartel: no es algo que la persona pidió.
    }
  }

  /// Vuelve a pedir el perfil y el bloqueo, sin vaciar lo que se ve.
  Future<void> _refrescar() async {
    await Future.wait([
      ref.read(perfilDeVendedorProvider(widget.sellerId).notifier).reconciliar(),
      _cargarBloqueo(),
    ]);
  }

  /// Seguir / dejar de seguir, con el contador del servidor.
  ///
  /// El número que se muestra es el que devuelve el backend, no uno sumado del
  /// lado de la app. Con dos dispositivos, o con un toque que falla a mitad de
  /// camino, un contador local queda desfasado para siempre y sólo se arregla
  /// reinstalando.
  ///
  /// ⚠️ El error se muestra. Antes se tragaba con un `catch (_) {}` y el botón
  /// quedaba sin hacer nada ni explicar por qué.
  Future<void> _alternarFollow() async {
    try {
      await ref.read(perfilDeVendedorProvider(widget.sellerId).notifier).alternar();
    } catch (e) {
      if (mounted) AppSnack.error(context, mensajeDeError(e));
    }
  }

  /// La tienda de este vendedor, en su propia pantalla.
  ///
  /// La misma que se abre desde el vivo: una sola vidriera en toda la app.
  Future<void> _abrirTienda() async {
    final perfil = _perfil;
    final storeId = perfil?.storeId;
    if (storeId == null) return;

    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TiendaScreen(
          storeId: storeId,
          nombreTienda: perfil?.tiendaNombre ?? perfil?.nombre ?? '',
          // Si está transmitiendo, la tienda lo dice. Volver desde acá lleva al
          // perfil, que es de donde se vino.
          liveDetras: perfil?.liveEnCursoId,
        ),
      ),
    );
  }

  /// El perfil que se está mostrando, o `null` mientras carga o si falló.
  PerfilDeVendedor? get _perfil =>
      ref.read(perfilDeVendedorProvider(widget.sellerId)).valueOrNull?.perfil;

  @override
  Widget build(BuildContext context) {
    final vista = ref.watch(perfilDeVendedorProvider(widget.sellerId));
    final perfil = vista.valueOrNull?.perfil;

    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(
        backgroundColor: AppColor.fondo,
        title: Text(perfil?.tiendaNombre ?? perfil?.nombre ?? 'Vendedor'),
        actions: [
          if (perfil != null)
            IconButton(
              icon: const Icon(Icons.more_vert_rounded),
              tooltip: 'Más opciones',
              onPressed: () => unawaited(_menu()),
            ),
        ],
      ),
      body: vista.isLoading && perfil == null
          ? const Center(child: CircularProgressIndicator())
          : perfil == null
              ? ReintentarAlVolverLaRed(
                  // El error crudo decide si se reintenta solo al volver la
                  // señal. Lo que se MUESTRA es la frase de `_ErrorDePerfil`.
                  error: vista.error,
                  onReintentar: () => unawaited(_refrescar()),
                  child: _ErrorDePerfil(onReintentar: () => unawaited(_refrescar())),
                )
              : RefreshIndicator(
                  onRefresh: _refrescar,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.sm, Gap.xl, Gap.xxxl),
                    children: [
                      _Encabezado(perfil: perfil),
                      const SizedBox(height: Gap.lg),
                      _Social(perfil: perfil),
                      const SizedBox(height: Gap.lg),
                      /**
                       * ⚠️ Sobre la tienda propia no se dibuja.
                       *
                       * Nadie se sigue a sí mismo —el backend lo rechaza— y
                       * antes la app se tragaba ese error: quedaba un botón
                       * que no hacía nada. Ver `esMiTiendaProvider`.
                       */
                      if (perfil.loSigo != null &&
                          ref.watch(esMiTiendaProvider(widget.sellerId)) == false)
                        _BotonSeguir(
                          siguiendo: perfil.loSigo!,
                          trabajando: vista.valueOrNull?.alternando ?? false,
                          onTap: _alternarFollow,
                        ),
                      const SizedBox(height: Gap.xl),
                      _Numeros(perfil: perfil),
                      const SizedBox(height: Gap.xl),
                      _Insignias(perfil: perfil),
                      if (perfil.bio != null && perfil.bio!.trim().isNotEmpty) ...[
                        const SizedBox(height: Gap.xl),
                        Text(
                          perfil.bio!,
                          style: const TextStyle(
                            fontSize: 14,
                            height: 1.5,
                            color: AppColor.textoSuave,
                          ),
                        ),
                      ],
                      if (perfil.horario != null) ...[
                        const SizedBox(height: Gap.xl),
                        _Horario(estado: perfil.horario!),
                      ],
                      if (perfil.storeId != null) ...[
                        const SizedBox(height: Gap.xl),
                        /**
                         * ⚠️ Con la vidriera apagada NO se abre el catálogo.
                         *
                         * Y se dice por qué, en vez de esconder el botón: quien
                         * llegó buscando la tienda de alguien merece saber que
                         * existe pero no está abierta al público, no quedarse
                         * mirando una pantalla donde el botón desapareció sin
                         * explicación.
                         *
                         * El resto del perfil sigue igual: seguirlo, ver su
                         * reputación y sus seguidores funciona lo mismo.
                         */
                        if (perfil.vidrieraActiva)
                          SizedBox(
                            width: double.infinity,
                            child: FilledButton.icon(
                              onPressed: () => unawaited(_abrirTienda()),
                              icon: const Icon(Icons.storefront_rounded, size: 19),
                              label: const Text('Ver la tienda'),
                              style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
                            ),
                          )
                        else
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.symmetric(
                              vertical: Gap.md,
                              horizontal: Gap.lg,
                            ),
                            decoration: BoxDecoration(
                              color: AppColor.superficie,
                              borderRadius: BorderRadius.circular(Redondeo.lg),
                              border: Border.all(color: AppColor.borde),
                            ),
                            child: const Row(
                              children: [
                                Icon(
                                  Icons.storefront_outlined,
                                  size: 18,
                                  color: AppColor.textoDebil,
                                ),
                                SizedBox(width: Gap.md),
                                Expanded(
                                  child: Text(
                                    'Su vidriera no está disponible por ahora',
                                    style: TextStyle(
                                      fontSize: 13.5,
                                      color: AppColor.textoSuave,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ],
                  ),
                ),
    );
  }

  /// El menú de "…" del perfil de un vendedor.
  ///
  /// ═══════════════════════════════════════════════════════════════════════
  /// BLOQUEAR Y REPORTAR SON COSAS DISTINTAS
  /// ═══════════════════════════════════════════════════════════════════════
  ///
  /// Llegan del mismo lugar y los textos tienen que dejar clarísima la
  /// diferencia:
  ///
  ///   · **bloquear** es para uno mismo. Inmediato, reversible, la otra persona
  ///     no se entera;
  ///   · **reportar** es pedirle a VendoX que lo revise. Lo mira una persona.
  ///
  /// Quien quiere que alguien desaparezca de su vista no debería tener que
  /// denunciarlo; y quien vio algo grave no debería creer que bloqueando ya
  /// avisó.
  Future<void> _menu() async {
    final bloqueado = _loBloquee ?? false;

    final opcion = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColor.superficie,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(
                bloqueado ? Icons.lock_open_rounded : Icons.block_rounded,
                color: bloqueado ? AppColor.textoSuave : AppColor.error,
              ),
              title: Text(bloqueado ? 'Desbloquear' : 'Bloquear'),
              subtitle: Text(
                bloqueado
                    ? 'Vas a volver a ver su tienda y sus vivos.'
                    : 'No vas a ver más su tienda ni sus vivos, y no van a poder '
                        'escribirse en el chat. No se entera.',
                style: const TextStyle(fontSize: 12.5, height: 1.35),
              ),
              onTap: () => Navigator.pop(ctx, bloqueado ? 'desbloquear' : 'bloquear'),
            ),
            ListTile(
              leading: const Icon(Icons.flag_outlined, color: AppColor.alerta),
              title: const Text('Reportar'),
              subtitle: const Text(
                'Lo revisa una persona de VendoX.',
                style: TextStyle(fontSize: 12.5),
              ),
              onTap: () => Navigator.pop(ctx, 'reportar'),
            ),
          ],
        ),
      ),
    );
    if (opcion == null || !mounted) return;

    switch (opcion) {
      case 'bloquear':
        await _confirmarBloqueo();
      case 'desbloquear':
        await _desbloquear();
      case 'reportar':
        await ReportarSheet.mostrar(
          context,
          targetType: 'SELLER',
          targetId: widget.sellerId,
        );
    }
  }

  /// Se confirma antes de bloquear.
  ///
  /// No por burocracia: bloquear a un vendedor le esconde su tienda a quien lo
  /// hace, y si tiene un pedido en curso conviene que sepa que eso NO se
  /// cancela — es lo primero que la gente asume.
  Future<void> _confirmarBloqueo() async {
    final confirma = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColor.superficie,
        title: const Text('¿Bloquear a esta tienda?'),
        content: const Text(
          'Dejás de ver sus productos y sus vivos, y no van a poder escribirse '
          'en el chat. No se entera y lo podés deshacer cuando quieras.\n\n'
          'Tus pedidos en curso con esta tienda siguen igual.',
          style: TextStyle(color: AppColor.textoSuave, height: 1.45),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancelar')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColor.error),
            child: const Text('Bloquear'),
          ),
        ],
      ),
    );
    if (confirma != true || !mounted) return;

    try {
      await ref.read(bloqueosApiProvider).bloquearVendedor(widget.sellerId);
      if (!mounted) return;
      setState(() => _loBloquee = true);
      AppSnack.info(context, 'Bloqueada. No va a aparecer más en tu feed.');
    } catch (_) {
      if (mounted) AppSnack.error(context, 'No pudimos bloquear. Probá de nuevo.');
    }
  }

  Future<void> _desbloquear() async {
    try {
      await ref.read(bloqueosApiProvider).desbloquearVendedor(widget.sellerId);
      if (!mounted) return;
      setState(() => _loBloquee = false);
      AppSnack.info(context, 'Desbloqueada.');
    } catch (_) {
      if (mounted) AppSnack.error(context, 'No pudimos desbloquear. Probá de nuevo.');
    }
  }
}

class _Encabezado extends StatelessWidget {
  const _Encabezado({required this.perfil});
  final PerfilDeVendedor perfil;

  @override
  Widget build(BuildContext context) {
    final nombre = perfil.tiendaNombre?.isNotEmpty ?? false ? perfil.tiendaNombre! : perfil.nombre;

    return Row(
      children: [
        ClipOval(
          child: SizedBox(
            width: 68,
            height: 68,
            child: perfil.avatarUrl == null
                ? ColoredBox(
                    color: AppColor.superficieAlta,
                    child: Center(
                      child: Text(
                        nombre.isEmpty ? '?' : nombre.substring(0, 1).toUpperCase(),
                        style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
                      ),
                    ),
                  )
                : CachedNetworkImage(
                    imageUrl: perfil.avatarUrl!,
                    fit: BoxFit.cover,
                    placeholder: (_, __) => const ColoredBox(color: AppColor.superficieAlta),
                    errorWidget: (_, __, ___) => const ColoredBox(
                      color: AppColor.superficieAlta,
                      child: Icon(Icons.person_rounded, color: AppColor.textoDebil),
                    ),
                  ),
          ),
        ),
        const SizedBox(width: Gap.lg),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                nombre,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800, height: 1.2),
              ),
              if (perfil.tiendaNombre != null && perfil.nombre.isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  perfil.nombre,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5, color: AppColor.textoSuave),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// Seguidores y seguidos, arriba de todo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO SOCIAL VA ANTES QUE LO COMERCIAL, Y SON COSAS DISTINTAS
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Es la jerarquía que la gente ya conoce de cualquier app social: quién es,
/// a cuánta gente le interesa, y recién ahí el botón de seguir. La reputación
/// comercial —ventas, reseñas, cumplimiento— va debajo, porque responde otra
/// pregunta: no «vale la pena seguirlo» sino «puedo comprarle tranquilo».
///
/// ⚠️ Los dos números NO son el mismo dato en dos lugares. **Seguidores** es
/// cuánta gente sigue a este vendedor; **seguidos**, a cuántos vendedores sigue
/// la persona que está detrás del perfil. El backend los cuenta por separado.
///
/// Se muestran siempre, incluso en cero: un perfil nuevo con «0 seguidores» es
/// honesto, y esconder el bloque hasta tener seguidores haría que la pantalla
/// cambie de forma justo cuando alguien la está mirando por primera vez.
class _Social extends StatelessWidget {
  const _Social({required this.perfil});

  final PerfilDeVendedor perfil;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        _Contador(
          valor: perfil.seguidores,
          etiqueta: perfil.seguidores == 1 ? 'seguidor' : 'seguidores',
        ),
        const SizedBox(width: Gap.xxl),
        _Contador(valor: perfil.seguidos, etiqueta: 'seguidos'),
      ],
    );
  }
}

class _Contador extends StatelessWidget {
  const _Contador({required this.valor, required this.etiqueta});

  final int valor;
  final String etiqueta;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          _numero(valor),
          style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 1),
        Text(
          etiqueta,
          style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
        ),
      ],
    );
  }
}

class _BotonSeguir extends StatelessWidget {
  const _BotonSeguir({
    required this.siguiendo,
    required this.trabajando,
    required this.onTap,
  });

  final bool siguiendo;
  final bool trabajando;
  final Future<void> Function() onTap;

  @override
  Widget build(BuildContext context) {
    final hijo = trabajando
        ? const SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2),
          )
        : Text(
            siguiendo ? 'Siguiendo' : 'Seguir',
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
          );

    return SizedBox(
      width: double.infinity,
      child: siguiendo
          // Ya sigue: botón secundario. El acento se reserva para lo que la
          // persona todavía no hizo.
          ? OutlinedButton(
              onPressed: trabajando ? null : () => unawaited(onTap()),
              style: OutlinedButton.styleFrom(minimumSize: const Size(0, 46)),
              child: hijo,
            )
          : FilledButton(
              onPressed: trabajando ? null : () => unawaited(onTap()),
              style: FilledButton.styleFrom(minimumSize: const Size(0, 46)),
              child: hijo,
            ),
    );
  }
}

class _Numeros extends StatelessWidget {
  const _Numeros({required this.perfil});
  final PerfilDeVendedor perfil;

  @override
  Widget build(BuildContext context) {
    if (perfil.sinReputacion) {
      // Ni "0,0 ⭐" ni "0 ventas". Ver la nota de la clase.
      return Container(
        padding: const EdgeInsets.all(Gap.lg),
        decoration: BoxDecoration(
          color: AppColor.superficie,
          borderRadius: BorderRadius.circular(Redondeo.lg),
          border: Border.all(color: AppColor.borde),
        ),
        child: Row(
          children: [
            const Icon(Icons.eco_outlined, size: 20, color: AppColor.textoSuave),
            const SizedBox(width: Gap.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Recién empieza',
                    style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${_numero(perfil.seguidores)} '
                    '${perfil.seguidores == 1 ? "seguidor" : "seguidores"} · '
                    'todavía no tiene ventas ni reseñas',
                    style:
                        const TextStyle(fontSize: 12.5, color: AppColor.textoSuave, height: 1.35),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    /**
     * ⚠️ Los seguidores NO van acá.
     *
     * Están arriba, en `_Social`, junto a los seguidos. Este bloque responde
     * otra pregunta —«puedo comprarle tranquilo»— y mezclar el número social
     * con el comercial lo mostraba dos veces en la misma pantalla.
     */
    return Row(
      children: [
        Expanded(
          child: _Dato(
            valor: _numero(perfil.ventas),
            etiqueta: perfil.ventas == 1 ? 'venta' : 'ventas',
          ),
        ),
        const _Separador(),
        Expanded(
          child: perfil.rating == null
              // Hay ventas pero nadie dejó reseña. Es un estado real y distinto
              // de "recién empieza".
              ? const _Dato(valor: '—', etiqueta: 'sin reseñas')
              : _Dato(
                  valor: perfil.rating!.toStringAsFixed(1).replaceAll('.', ','),
                  etiqueta: '${_numero(perfil.resenas)} '
                      '${perfil.resenas == 1 ? "reseña" : "reseñas"}',
                  icono: Icons.star_rounded,
                ),
        ),

        /**
         * El cumplimiento sólo aparece cuando el servidor lo mandó.
         *
         * Viene `null` hasta que hay operaciones suficientes: un «100 %» sobre
         * una sola venta no es información, y un «0 %» sobre un vendedor que
         * todavía no despachó nada es una acusación.
         *
         * Con `null` no se muestra la columna. No se dibuja un «—» tercero:
         * tres guiones en fila se leen como que el vendedor está roto.
         */
        if (perfil.cumplimiento != null) ...[
          const _Separador(),
          Expanded(
            child: _Dato(
              valor: '${perfil.cumplimiento}%',
              etiqueta: 'cumplimiento',
            ),
          ),
        ],
      ],
    );
  }
}

/// «Vendedor destacado».
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SE GANA, NO SE COMPRA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Lo otorga el servidor por reglas objetivas y públicas —ventas cumplidas,
/// promedio, cantidad de reseñas, porcentaje de cumplimiento— que están en
/// `reputacion.ts`. Ninguna se puede pagar.
///
/// Por eso NO usa el violeta de marca ni la forma del sello de identidad: son
/// tres insignias distintas, y que se parezcan haría que una se lea como la
/// otra. Ésta es lima, la de identidad es violeta con tilde.
///
/// VendoX Pro será una cuarta cosa y tampoco puede parecerse a ninguna.
class InsigniaDestacado extends StatelessWidget {
  const InsigniaDestacado({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Gap.sm, vertical: 3),
      decoration: BoxDecoration(
        color: AppColor.exito.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(Redondeo.pill),
        border: Border.all(color: AppColor.exito.withValues(alpha: 0.4)),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.workspace_premium_rounded, size: 13, color: AppColor.exito),
          SizedBox(width: 4),
          Text(
            'Destacado',
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w800,
              color: AppColor.exito,
            ),
          ),
        ],
      ),
    );
  }
}

class _Dato extends StatelessWidget {
  const _Dato({required this.valor, required this.etiqueta, this.icono});

  final String valor;
  final String etiqueta;
  final IconData? icono;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (icono != null) ...[
              Icon(icono, size: 18, color: AppColor.alerta),
              const SizedBox(width: 3),
            ],
            Text(
              valor,
              style: const TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.w800,
                letterSpacing: -0.5,
              ),
            ),
          ],
        ),
        const SizedBox(height: 2),
        Text(
          etiqueta,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 11.5, color: AppColor.textoSuave),
        ),
      ],
    );
  }
}

class _Separador extends StatelessWidget {
  const _Separador();

  @override
  Widget build(BuildContext context) {
    return Container(width: 1, height: 30, color: AppColor.borde);
  }
}

/// Las TRES insignias, con su explicación.
///
/// Ninguna se compra: identidad se comprueba, confiable se gana con historial,
/// destacado sale de reglas objetivas y públicas. Ver `reputacion.ts`.
///
/// VendoX Pro va a ser una cuarta cosa —una membresía paga— y **no puede
/// dibujarse acá adentro**: un sello comprado al lado de estos tres se lee
/// como si también se hubiera ganado.
class _Insignias extends StatelessWidget {
  const _Insignias({required this.perfil});
  final PerfilDeVendedor perfil;

  @override
  Widget build(BuildContext context) {
    if (!perfil.identidadVerificada && !perfil.vendedorConfiable && !perfil.destacado) {
      return const SizedBox.shrink();
    }

    return Column(
      children: [
        if (perfil.identidadVerificada)
          const _Insignia(
            icono: Icons.badge_outlined,
            color: AppColor.acento,
            titulo: 'Identidad verificada',
            detalle: 'Validamos su documento. Sabemos quién es.',
          ),
        if (perfil.identidadVerificada && perfil.vendedorConfiable) const SizedBox(height: Gap.sm),
        if (perfil.vendedorConfiable)
          const _Insignia(
            icono: Icons.workspace_premium_outlined,
            color: AppColor.exito,
            titulo: 'Vendedor confiable',
            detalle: 'Tiene historial de ventas concretadas y buenas reseñas.',
          ),
        if (perfil.destacado) ...[
          const SizedBox(height: Gap.sm),
          const _Insignia(
            icono: Icons.verified_user_outlined,
            color: AppColor.info,
            titulo: 'Vendedor destacado',
            detalle:
                'Cumple todas las entregas y mantiene buenas reseñas sobre '
                'muchas ventas. Es un reconocimiento que se gana, no se compra.',
          ),
        ],
      ],
    );
  }
}

class _Insignia extends StatelessWidget {
  const _Insignia({
    required this.icono,
    required this.color,
    required this.titulo,
    required this.detalle,
  });

  final IconData icono;
  final Color color;
  final String titulo;
  final String detalle;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.md),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Row(
        children: [
          Icon(icono, size: 20, color: color),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  titulo,
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: color),
                ),
                const SizedBox(height: 1),
                // La explicación no es decoración: sin ella las dos insignias
                // se leen como "está aprobado", que es justo lo que no hay que
                // dejar creer.
                Text(
                  detalle,
                  style: const TextStyle(fontSize: 12, color: AppColor.textoSuave, height: 1.35),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Horario extends StatelessWidget {
  const _Horario({required this.estado});
  final EstadoDeTienda estado;

  @override
  Widget build(BuildContext context) {
    final color = estado.abierta ? AppColor.exito : AppColor.textoSuave;

    return Container(
      padding: const EdgeInsets.all(Gap.md),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(color: AppColor.borde),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  estado.abierta ? 'Abierta ahora' : 'Cerrada',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: color),
                ),
                if (estado.motivo.isNotEmpty) ...[
                  const SizedBox(height: 1),
                  Text(
                    estado.motivo,
                    style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorDePerfil extends StatelessWidget {
  const _ErrorDePerfil({required this.onReintentar});
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.person_off_outlined, size: 38, color: AppColor.textoDebil),
            const SizedBox(height: Gap.md),
            const Text('No pudimos cargar el perfil'),
            const SizedBox(height: Gap.lg),
            FilledButton(onPressed: onReintentar, child: const Text('Reintentar')),
          ],
        ),
      ),
    );
  }
}

/// Separador de miles. 1.240 seguidores se lee; 1240 hay que contarlo.
String _numero(int n) => n.toString().replaceAllMapped(
      RegExp(r'(\d)(?=(\d{3})+$)'),
      (m) => '${m[1]}.',
    );
