import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../moderation/data/bloqueos_api.dart';
import '../../moderation/presentation/reportar_sheet.dart';
import '../data/live_api.dart';
import '../domain/live_models.dart';
import 'shop_sheet.dart';
import 'variant_sheet.dart';

/// El perfil del vendedor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LAS DOS INSIGNIAS NO SON LA MISMA COSA
/// ═══════════════════════════════════════════════════════════════════════════
///
///   **Identidad verificada** — sabemos quién es. Presentó un documento y lo
///   validamos. Es un hecho comprobable, y no dice absolutamente nada sobre si
///   vende bien.
///
///   **Vendedor confiable** — tiene historial: ventas concretadas, reseñas,
///   tiempo en la plataforma. Es reputación, y se puede perder.
///
/// Se muestran **separadas y con texto propio**. Fundirlas en un solo tilde
/// azul sería el error clásico: alguien con el DNI validado que nunca vendió
/// nada parecería tan confiable como quien lleva doscientas ventas limpias, y
/// esa confusión es exactamente la que aprovecha el que estafa.
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
  PerfilDeVendedor? _perfil;

  /// `null` mientras no se sabe: evita pintar "Bloquear" y que al abrir el
  /// menú diga "Desbloquear".
  bool? _loBloquee;
  bool _cargando = true;
  bool _alternandoFollow = false;

  @override
  void initState() {
    super.initState();
    unawaited(_cargar());
  }

  Future<void> _cargar() async {
    setState(() => _cargando = true);
    try {
      final perfil = await ref.read(liveApiProvider).perfil(widget.sellerId);
      if (mounted) {
        setState(() {
          _perfil = perfil;
          _cargando = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _cargando = false);
    }

    /**
     * El estado del bloqueo se pide APARTE y sin bloquear la pantalla.
     *
     * Va después y en su propio `try` porque es información secundaria: si esa
     * consulta falla, el perfil tiene que verse igual. Lo único que pasa es que
     * el menú va a ofrecer "Bloquear" cuando quizás ya está bloqueado, y tocarlo
     * es idempotente del lado del servidor.
     */
    try {
      final bloqueado = await ref.read(bloqueosApiProvider).bloqueeAlVendedor(widget.sellerId);
      if (mounted) setState(() => _loBloquee = bloqueado);
    } catch (_) {
      // Sin cartel: no es algo que la persona pidió.
    }
  }

  /// Seguir / dejar de seguir, con el contador del servidor.
  ///
  /// El número que se muestra es el que devuelve el backend, no uno sumado del
  /// lado de la app. Con dos dispositivos, o con un toque que falla a mitad de
  /// camino, un contador local queda desfasado para siempre y sólo se arregla
  /// reinstalando.
  Future<void> _alternarFollow() async {
    final perfil = _perfil;
    if (perfil == null || _alternandoFollow) return;

    setState(() => _alternandoFollow = true);
    final api = ref.read(liveApiProvider);

    try {
      final r = perfil.loSigo == true
          ? await api.dejarDeSeguir(widget.sellerId)
          : await api.seguir(widget.sellerId);

      if (mounted) {
        setState(() => _perfil = perfil.conFollow(r.siguiendo, r.seguidores));
      }
    } catch (_) {
      // Nada cambia. Mostrar "Siguiendo" sobre una petición que falló haría
      // que la persona crea que va a recibir avisos que nunca van a llegar.
    } finally {
      if (mounted) setState(() => _alternandoFollow = false);
    }
  }

  Future<void> _abrirTienda() async {
    final perfil = _perfil;
    final storeId = perfil?.storeId;
    if (storeId == null) return;

    final productId = await ShopSheet.mostrar(
      context,
      storeId: storeId,
      nombreTienda: perfil?.tiendaNombre ?? perfil?.nombre ?? '',
    );

    if (productId == null || !mounted) return;

    await VariantSheet.mostrar(
      context,
      productId: productId,
      storeId: storeId,
    );
  }

  @override
  Widget build(BuildContext context) {
    final perfil = _perfil;

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
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : perfil == null
              ? _ErrorDePerfil(onReintentar: () => unawaited(_cargar()))
              : RefreshIndicator(
                  onRefresh: _cargar,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.sm, Gap.xl, Gap.xxxl),
                    children: [
                      _Encabezado(perfil: perfil),
                      const SizedBox(height: Gap.lg),
                      if (perfil.loSigo != null)
                        _BotonSeguir(
                          siguiendo: perfil.loSigo!,
                          trabajando: _alternandoFollow,
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
                        SizedBox(
                          width: double.infinity,
                          child: FilledButton.icon(
                            onPressed: () => unawaited(_abrirTienda()),
                            icon: const Icon(Icons.storefront_rounded, size: 19),
                            label: const Text('Ver la tienda'),
                            style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
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

    return Row(
      children: [
        Expanded(
          child: _Dato(
            valor: _numero(perfil.seguidores),
            etiqueta: perfil.seguidores == 1 ? 'seguidor' : 'seguidores',
          ),
        ),
        const _Separador(),
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
      ],
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

/// Las dos insignias, con su explicación. Ver la nota de la clase.
class _Insignias extends StatelessWidget {
  const _Insignias({required this.perfil});
  final PerfilDeVendedor perfil;

  @override
  Widget build(BuildContext context) {
    if (!perfil.identidadVerificada && !perfil.vendedorConfiable) {
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
