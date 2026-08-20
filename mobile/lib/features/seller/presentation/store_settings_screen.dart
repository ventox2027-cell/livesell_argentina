import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../core/network/errores_de_red.dart';
import '../../../shared/widgets/app_snack.dart';
import '../data/seller_repository.dart';
import '../domain/seller_models.dart';
import 'mercadopago_screen.dart';
import 'politicas_screen.dart';
import 'schedule_screen.dart';

/// Ajustes de la tienda.
///
/// Dos bloques y nada más: cómo te ven (nombre, descripción) y si estás
/// abierto. Todo lo demás —comisiones, envíos, facturación— llega cuando
/// exista, no como campo vacío que hoy no hace nada.
class StoreSettingsScreen extends ConsumerStatefulWidget {
  const StoreSettingsScreen({super.key});

  @override
  ConsumerState<StoreSettingsScreen> createState() => _StoreSettingsScreenState();
}

class _StoreSettingsScreenState extends ConsumerState<StoreSettingsScreen> {
  final _nombre = TextEditingController();
  final _descripcion = TextEditingController();
  final _bio = TextEditingController();

  bool _cargado = false;
  bool _guardando = false;

  @override
  void dispose() {
    _nombre.dispose();
    _descripcion.dispose();
    _bio.dispose();
    super.dispose();
  }

  /// Rellena los campos la primera vez que llegan los datos.
  ///
  /// Sólo una vez: si se hiciera en cada rebuild, escribir sería imposible —
  /// cada carácter dispararía un rebuild que restauraría el texto anterior.
  void _sembrar(PerfilVendedor perfil) {
    if (_cargado) return;
    _cargado = true;
    _nombre.text = perfil.store?.name ?? perfil.seller.displayName;
    _descripcion.text = perfil.store?.description ?? '';
    _bio.text = perfil.seller.bio ?? '';
  }

  Future<void> _guardar(PerfilVendedor perfil) async {
    final nombre = _nombre.text.trim();
    if (nombre.length < 2) {
      AppSnack.error(context, 'El nombre no puede quedar vacío');
      return;
    }

    setState(() => _guardando = true);
    try {
      final repo = ref.read(sellerRepositoryProvider);

      final store = perfil.store;
      if (store != null) {
        await repo.actualizarTienda(
          store.id,
          name: nombre,
          description: _descripcion.text.trim(),
        );
      }
      await repo.actualizarVendedor(displayName: nombre, bio: _bio.text.trim());

      unawaited(ref.read(miPerfilVendedorProvider.notifier).reconciliar());
      if (mounted) {
        AppSnack.exito(context, 'Guardado');
        Navigator.of(context).pop();
      }
    } catch (e) {
      if (mounted) AppSnack.error(context, mensajeDeError(e));
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  /// Enciende o apaga la vidriera pública.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// NO ES PAUSAR LA TIENDA
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Pausar frena las compras. Apagar la vidriera esconde el catálogo y deja
  /// todo lo demás igual: los productos siguen publicados, siguen apareciendo
  /// en el feed y se siguen vendiendo desde ahí. Su perfil también sigue
  /// entero, con seguidores y reputación.
  ///
  /// Son dos interruptores distintos porque responden dos preguntas distintas,
  /// y fundirlos haría que esconder la vidriera frene las ventas.
  Future<void> _alternarVidriera(PerfilVendedor perfil) async {
    final store = perfil.store;
    if (store == null) return;

    final encender = !store.vidrieraActiva;
    setState(() => _guardando = true);
    try {
      await ref.read(sellerRepositoryProvider).actualizarTienda(
            store.id,
            vidrieraActiva: encender,
          );
      unawaited(ref.read(miPerfilVendedorProvider.notifier).reconciliar());
      if (mounted) {
        AppSnack.exito(
          context,
          encender
              ? 'Tu vidriera ya se puede visitar'
              : 'Vidriera apagada. Tus productos siguen publicados.',
        );
      }
    } catch (e) {
      if (mounted) AppSnack.error(context, mensajeDeError(e));
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  Future<void> _alternarApertura(PerfilVendedor perfil) async {
    final store = perfil.store;
    if (store == null) return;

    setState(() => _guardando = true);
    try {
      await ref.read(sellerRepositoryProvider).actualizarTienda(
            store.id,
            status: store.pausada ? 'ACTIVE' : 'PAUSED',
          );
      unawaited(ref.read(miPerfilVendedorProvider.notifier).reconciliar());
      if (mounted) {
        AppSnack.exito(
          context,
          store.pausada ? 'Tu tienda volvió a estar abierta' : 'Tienda pausada',
        );
      }
    } catch (e) {
      if (mounted) AppSnack.error(context, mensajeDeError(e));
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final perfil = ref.watch(miPerfilVendedorProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Ajustes de tienda')),
      body: perfil.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(Gap.xl),
            child: Text(
              mensajeDeError(e),
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColor.textoSuave),
            ),
          ),
        ),
        data: (p) {
          if (p == null) {
            return const Center(
              child: Text(
                'Todavía no tenés tienda.',
                style: TextStyle(color: AppColor.textoSuave),
              ),
            );
          }
          _sembrar(p);

          final store = p.store;
          return ListView(
            padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, Gap.xxl),
            children: [
              if (store != null) _Direccion(slug: store.slug),
              const SizedBox(height: Gap.xl),
              TextField(
                controller: _nombre,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(
                  labelText: 'Nombre de la tienda',
                  helperText: 'Es lo que ven los compradores en el feed',
                ),
              ),
              const SizedBox(height: Gap.xl),
              TextField(
                controller: _descripcion,
                maxLines: 3,
                maxLength: 300,
                textCapitalization: TextCapitalization.sentences,
                decoration: const InputDecoration(
                  labelText: 'Qué vendés',
                  hintText: 'Ropa tejida a mano, hecha en Bariloche.',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: Gap.md),
              TextField(
                controller: _bio,
                maxLines: 2,
                maxLength: 200,
                textCapitalization: TextCapitalization.sentences,
                decoration: const InputDecoration(
                  labelText: 'Sobre vos (opcional)',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: Gap.lg),
              FilledButton(
                onPressed: _guardando ? null : () => _guardar(p),
                child: _guardando
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Text('Guardar'),
              ),
              if (store != null) ...[
                const SizedBox(height: Gap.xxl),
                // Horarios y pausa son cosas distintas y van separadas:
                // "pausada" es una decisión de hoy, el horario es la regla de
                // todas las semanas. Fundirlas en un interruptor haría que
                // reabrir después de pausar borrara el horario cargado.
                _FilaDeAjuste(
                  icono: Icons.schedule_rounded,
                  titulo: 'Horarios',
                  detalle: 'Cuándo se puede comprar en tu tienda',
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(builder: (_) => const ScheduleScreen()),
                  ),
                ),
                const SizedBox(height: Gap.lg),
                // Envío y devoluciones aparte del resto: define plata que se
                // le cobra a compradores reales y obligaciones legales que el
                // vendedor asume. No son dos campos más de este formulario.
                _FilaDeAjuste(
                  icono: Icons.local_shipping_outlined,
                  titulo: 'Envío y devoluciones',
                  detalle: 'Cuánto cobrás de envío y qué pasa si lo devuelven',
                  onTap: () async {
                    final cambio = await Navigator.of(context).push<bool>(
                      MaterialPageRoute<bool>(
                        builder: (_) => PoliticasScreen(
                          storeId: store.id,
                          inicial: (envio: store.envio, cambios: store.cambios),
                        ),
                      ),
                    );
                    // Al volver con cambios hay que releer: la tienda que
                    // tenemos en memoria quedó vieja.
                    if (cambio ?? false) {
                      unawaited(ref.read(miPerfilVendedorProvider.notifier).reconciliar());
                    }
                  },
                ),
                const SizedBox(height: Gap.md),
                /**
                 * La vidriera, al lado de lo demás que define qué ve la gente.
                 *
                 * Con un interruptor y no navegando a otra pantalla: es un
                 * sí/no, y esconderlo detrás de un toque más lo volvería una
                 * preferencia que nadie encuentra.
                 */
                _FilaDeVidriera(
                  activa: store.vidrieraActiva,
                  onAlternar: _guardando ? null : () => unawaited(_alternarVidriera(p)),
                ),
                // Los cobros van con el resto de lo que define plata: quién
                // recibe el dinero es tan importante como cuánto se cobra.
                _FilaDeAjuste(
                  icono: Icons.account_balance_wallet_outlined,
                  titulo: 'Cobros',
                  detalle: 'Dónde entra el dinero de tus ventas',
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(builder: (_) => const MercadoPagoScreen()),
                  ),
                ),
                const SizedBox(height: Gap.lg),
                _Apertura(
                  pausada: store.pausada,
                  onAlternar: _guardando ? null : () => _alternarApertura(p),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _FilaDeAjuste extends StatelessWidget {
  const _FilaDeAjuste({
    required this.icono,
    required this.titulo,
    required this.detalle,
    required this.onTap,
  });

  final IconData icono;
  final String titulo;
  final String detalle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Redondeo.lg),
      child: Container(
        padding: const EdgeInsets.all(Gap.lg),
        decoration: BoxDecoration(
          color: AppColor.superficie,
          borderRadius: BorderRadius.circular(Redondeo.lg),
          border: Border.all(color: AppColor.borde),
        ),
        child: Row(
          children: [
            Icon(icono, size: 19, color: AppColor.textoSuave),
            const SizedBox(width: Gap.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(titulo, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text(
                    detalle,
                    style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded, color: AppColor.textoDebil),
          ],
        ),
      ),
    );
  }
}

/// La dirección pública de la tienda, copiable de un toque.
///
/// Es lo primero que un vendedor quiere de esta pantalla: el enlace para
/// mandar por WhatsApp. Tenerlo arriba y con un botón de copiar evita que
/// tenga que transcribirlo a mano.
class _Direccion extends StatelessWidget {
  const _Direccion({required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context) {
    final url = 'vendox.com/$slug';

    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: AppColor.borde),
      ),
      child: Row(
        children: [
          const Icon(Icons.link_rounded, size: 18, color: AppColor.textoSuave),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Tu dirección',
                  style: TextStyle(fontSize: 11.5, color: AppColor.textoDebil),
                ),
                const SizedBox(height: 2),
                Text(
                  url,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.copy_rounded, size: 18),
            tooltip: 'Copiar',
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: 'https://$url'));
              if (context.mounted) AppSnack.exito(context, 'Copiado');
            },
          ),
        ],
      ),
    );
  }
}

/// El interruptor de la vidriera pública.
///
/// Dice qué pasa al apagarla, no sólo que se apaga: sin esa frase, «vidriera
/// off» se puede leer como «cierro la tienda» o «despublico todo», que es
/// exactamente lo que NO hace.
class _FilaDeVidriera extends StatelessWidget {
  const _FilaDeVidriera({required this.activa, this.onAlternar});

  final bool activa;
  final VoidCallback? onAlternar;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: AppColor.borde),
      ),
      child: Row(
        children: [
          Icon(
            activa ? Icons.storefront_rounded : Icons.visibility_off_outlined,
            size: 18,
            color: activa ? AppColor.exito : AppColor.textoSuave,
          ),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Vidriera pública',
                  style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                ),
                const SizedBox(height: 2),
                Text(
                  activa
                      ? 'Cualquiera puede visitar tu tienda y ver tu catálogo.'
                      : 'Tu catálogo no se puede visitar. Tus productos siguen '
                          'publicados y se siguen vendiendo desde el feed.',
                  style: const TextStyle(
                    fontSize: 12.5,
                    color: AppColor.textoSuave,
                    height: 1.35,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: Gap.sm),
          Switch(
            value: activa,
            onChanged: onAlternar == null ? null : (_) => onAlternar!(),
          ),
        ],
      ),
    );
  }
}

class _Apertura extends StatelessWidget {
  const _Apertura({required this.pausada, this.onAlternar});

  final bool pausada;
  final VoidCallback? onAlternar;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(
          color: pausada ? AppColor.alerta.withValues(alpha: 0.35) : AppColor.borde,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(
                pausada ? Icons.pause_circle_outline_rounded : Icons.storefront_rounded,
                size: 18,
                color: pausada ? AppColor.alerta : AppColor.exito,
              ),
              const SizedBox(width: Gap.sm),
              Text(
                pausada ? 'Tienda pausada' : 'Tienda abierta',
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            pausada
                ? 'Nadie ve tus productos. Tus datos y tu catálogo quedan intactos.'
                : 'Si te vas de viaje o te quedás sin stock, podés pausarla y '
                    'volver cuando quieras.',
            style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave, height: 1.4),
          ),
          const SizedBox(height: Gap.md),
          OutlinedButton(
            onPressed: onAlternar,
            child: Text(pausada ? 'Reabrir tienda' : 'Pausar tienda'),
          ),
        ],
      ),
    );
  }
}
