import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../auth/state/auth_providers.dart';
import '../../orders/presentation/seller_orders_screen.dart';
import '../data/seller_repository.dart';
import '../domain/seller_models.dart';
import 'product_editor_screen.dart';
import 'store_settings_screen.dart';

/// Panel del vendedor.
///
/// ─── Qué tiene que resolver esta pantalla ───
///
/// Un vendedor abre la app entre una venta y otra, con una mano, muchas veces
/// mientras atiende. Lo único que necesita ver de un vistazo es: qué tengo
/// publicado, qué está en borrador, y cómo agrego algo nuevo.
///
/// Por eso el botón de crear producto es lo más grande de la pantalla y está
/// donde llega el pulgar.
class SellerHomeScreen extends ConsumerWidget {
  const SellerHomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final perfil = ref.watch(miPerfilVendedorProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Mi tienda'),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const StoreSettingsScreen()),
            ),
          ),
        ],
      ),
      body: perfil.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _Error(mensaje: e.toString(), onReintentar: () {
          ref.invalidate(miPerfilVendedorProvider);
        }),
        data: (p) {
          if (p == null) return const _SinVendedor();
          return _Panel(perfil: p);
        },
      ),
      floatingActionButton: perfil.valueOrNull == null
          ? null
          : FloatingActionButton.extended(
              onPressed: () async {
                final creado = await Navigator.of(context).push<bool>(
                  MaterialPageRoute(builder: (_) => const ProductEditorScreen()),
                );
                if (creado == true) {
                  ref.invalidate(misProductosProvider);
                  ref.invalidate(miPerfilVendedorProvider);
                }
              },
              backgroundColor: AppColor.acento,
              icon: const Icon(Icons.add_rounded),
              label: const Text('Nuevo producto', style: TextStyle(fontWeight: FontWeight.w600)),
            ),
    );
  }
}

/// El usuario todavía no es vendedor.
class _SinVendedor extends ConsumerStatefulWidget {
  const _SinVendedor();

  @override
  ConsumerState<_SinVendedor> createState() => _SinVendedorState();
}

class _SinVendedorState extends ConsumerState<_SinVendedor> {
  final _nombre = TextEditingController();
  bool _creando = false;

  @override
  void dispose() {
    _nombre.dispose();
    super.dispose();
  }

  Future<void> _crear() async {
    final nombre = _nombre.text.trim();
    if (nombre.length < 2) {
      AppSnack.error(context, 'Poné el nombre de tu tienda');
      return;
    }

    setState(() => _creando = true);
    try {
      await ref.read(sellerRepositoryProvider).crearVendedor(displayName: nombre);
      // La sesión se refresca también: el rol del usuario pasó a `seller` en la
      // base y la app lo lee de ahí para habilitar pantallas. Sin esto, el
      // vendedor recién creado seguiría viendo "Quiero vender" hasta reabrir.
      await ref.read(sesionProvider.notifier).restaurar();
      ref.invalidate(miPerfilVendedorProvider);
      if (mounted) AppSnack.exito(context, '¡Listo! Ya podés cargar productos.');
    } catch (e) {
      if (mounted) AppSnack.error(context, e.toString());
    } finally {
      if (mounted) setState(() => _creando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.xxl, Gap.xl, Gap.xxl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
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
          Text('Empezá a vender', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: Gap.sm),
          const Text(
            'Creás tu tienda en un paso y ya podés cargar productos. '
            'Sin papeles, sin esperar aprobación.',
            style: TextStyle(color: AppColor.textoSuave, fontSize: 15, height: 1.5),
          ),
          const SizedBox(height: Gap.xxl),

          TextField(
            controller: _nombre,
            textCapitalization: TextCapitalization.words,
            enabled: !_creando,
            decoration: const InputDecoration(
              labelText: 'Nombre de tu tienda',
              hintText: 'Tejidos del Sur',
              helperText: 'Es lo que van a ver los compradores',
            ),
          ),
          const SizedBox(height: Gap.xl),

          FilledButton(
            onPressed: _creando ? null : _crear,
            child: _creando
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Text('Crear mi tienda'),
          ),
        ],
      ),
    );
  }
}

class _Panel extends ConsumerWidget {
  const _Panel({required this.perfil});
  final PerfilVendedor perfil;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final productos = ref.watch(misProductosProvider);
    final aviso = perfil.seller.avisoDeEstado;

    return RefreshIndicator(
      onRefresh: () async {
        ref.invalidate(misProductosProvider);
        ref.invalidate(miPerfilVendedorProvider);
      },
      child: ListView(
        padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, 100),
        children: [
          if (aviso != null) ...[
            _Aviso(aviso),
            const SizedBox(height: Gap.lg),
          ],

          _Encabezado(perfil: perfil),
          const SizedBox(height: Gap.lg),

          // Las ventas primero: es lo que un vendedor abre a mirar cuando algo
          // se vendió, y esperar a que baje hasta el final sería absurdo.
          InkWell(
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const SellerOrdersScreen()),
            ),
            borderRadius: BorderRadius.circular(Redondeo.lg),
            child: Container(
              padding: const EdgeInsets.all(Gap.lg),
              decoration: BoxDecoration(
                color: AppColor.superficie,
                borderRadius: BorderRadius.circular(Redondeo.lg),
                border: Border.all(color: AppColor.borde),
              ),
              child: const Row(
                children: [
                  Icon(Icons.point_of_sale_rounded, size: 20, color: AppColor.exito),
                  SizedBox(width: Gap.md),
                  Expanded(
                    child: Text(
                      'Mis ventas',
                      style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                    ),
                  ),
                  Icon(Icons.chevron_right_rounded, color: AppColor.textoDebil),
                ],
              ),
            ),
          ),
          const SizedBox(height: Gap.xl),

          const _Titulo('Mis productos'),
          const SizedBox(height: Gap.sm),

          productos.when(
            loading: () => const Padding(
              padding: EdgeInsets.symmetric(vertical: Gap.xxl),
              child: Center(child: CircularProgressIndicator()),
            ),
            error: (e, _) => _Error(
              mensaje: e.toString(),
              onReintentar: () => ref.invalidate(misProductosProvider),
            ),
            data: (pagina) {
              if (pagina.items.isEmpty) return const _SinProductos();
              return Column(
                children: [
                  for (final p in pagina.items)
                    Padding(
                      padding: const EdgeInsets.only(bottom: Gap.md),
                      child: _FilaProducto(producto: p),
                    ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _Encabezado extends StatelessWidget {
  const _Encabezado({required this.perfil});
  final PerfilVendedor perfil;

  @override
  Widget build(BuildContext context) {
    final store = perfil.store;
    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: AppColor.borde),
      ),
      child: Row(
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              gradient: const LinearGradient(colors: [AppColor.acento, AppColor.acentoOscuro]),
              borderRadius: BorderRadius.circular(Redondeo.md),
            ),
            alignment: Alignment.center,
            child: Text(
              (store?.name ?? perfil.seller.displayName).characters.first.toUpperCase(),
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
            ),
          ),
          const SizedBox(width: Gap.lg),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        store?.name ?? perfil.seller.displayName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                      ),
                    ),
                    if (perfil.seller.verificado) ...[
                      const SizedBox(width: 6),
                      const Icon(Icons.verified_rounded, size: 16, color: AppColor.acento),
                    ],
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  'vendox.com/${store?.slug ?? perfil.seller.slug}',
                  style: const TextStyle(fontSize: 12.5, color: AppColor.textoDebil),
                ),
              ],
            ),
          ),
          Column(
            children: [
              Text(
                '${perfil.productos}',
                style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
              ),
              const Text(
                'productos',
                style: TextStyle(fontSize: 11, color: AppColor.textoDebil),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _FilaProducto extends ConsumerWidget {
  const _FilaProducto({required this.producto});
  final Producto producto;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return InkWell(
      onTap: () async {
        final cambio = await Navigator.of(context).push<bool>(
          MaterialPageRoute(builder: (_) => ProductEditorScreen(productoId: producto.id)),
        );
        if (cambio == true) {
          ref.invalidate(misProductosProvider);
          ref.invalidate(miPerfilVendedorProvider);
        }
      },
      borderRadius: BorderRadius.circular(Redondeo.md),
      child: Container(
        padding: const EdgeInsets.all(Gap.md),
        decoration: BoxDecoration(
          color: AppColor.superficie,
          borderRadius: BorderRadius.circular(Redondeo.md),
          border: Border.all(color: AppColor.borde),
        ),
        child: Row(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(Redondeo.sm),
              child: SizedBox(
                width: 52,
                height: 52,
                child: producto.portada != null
                    ? Image.network(
                        producto.portada!,
                        fit: BoxFit.cover,
                        // Si la imagen no carga —red caída, servidor cambiado—
                        // se muestra el marcador en vez del ícono roto de
                        // Flutter, que parece un error de la app.
                        errorBuilder: (_, __, ___) => const _SinFoto(),
                      )
                    : const _SinFoto(),
              ),
            ),
            const SizedBox(width: Gap.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    producto.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 3),
                  Row(
                    children: [
                      Text(
                        formatearPesos(producto.basePriceCents),
                        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
                      ),
                      if (producto.cantidadVariantes > 1) ...[
                        const SizedBox(width: Gap.sm),
                        Text(
                          '${producto.cantidadVariantes} variantes',
                          style: const TextStyle(fontSize: 11.5, color: AppColor.textoDebil),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            _ChipEstado(producto.status),
          ],
        ),
      ),
    );
  }
}

class _ChipEstado extends StatelessWidget {
  const _ChipEstado(this.status);
  final String status;

  @override
  Widget build(BuildContext context) {
    final (color, texto) = switch (status) {
      'ACTIVE' => (AppColor.exito, 'Publicado'),
      'DRAFT' => (AppColor.textoDebil, 'Borrador'),
      'PAUSED' => (AppColor.alerta, 'Pausado'),
      _ => (AppColor.textoDebil, 'Archivado'),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(Redondeo.sm),
      ),
      child: Text(
        texto,
        style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: color),
      ),
    );
  }
}

class _SinFoto extends StatelessWidget {
  const _SinFoto();

  @override
  Widget build(BuildContext context) {
    return const ColoredBox(
      color: AppColor.superficieAlta,
      child: Icon(Icons.image_outlined, size: 22, color: AppColor.textoDebil),
    );
  }
}

class _SinProductos extends StatelessWidget {
  const _SinProductos();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: Gap.xxl, horizontal: Gap.lg),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: AppColor.borde, style: BorderStyle.solid),
      ),
      child: const Column(
        children: [
          Icon(Icons.inventory_2_outlined, size: 32, color: AppColor.textoDebil),
          SizedBox(height: Gap.md),
          Text(
            'Todavía no cargaste ningún producto',
            style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w500),
          ),
          SizedBox(height: 4),
          Text(
            'Tocá "Nuevo producto" para empezar',
            style: TextStyle(fontSize: 13, color: AppColor.textoSuave),
          ),
        ],
      ),
    );
  }
}

class _Titulo extends StatelessWidget {
  const _Titulo(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Text(
      texto.toUpperCase(),
      style: const TextStyle(
        fontSize: 11.5,
        fontWeight: FontWeight.w700,
        color: AppColor.textoDebil,
        letterSpacing: 0.8,
      ),
    );
  }
}

class _Aviso extends StatelessWidget {
  const _Aviso(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.md),
      decoration: BoxDecoration(
        color: AppColor.alerta.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(color: AppColor.alerta.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.warning_amber_rounded, color: AppColor.alerta, size: 18),
          const SizedBox(width: Gap.sm),
          Expanded(
            child: Text(texto, style: const TextStyle(color: AppColor.alerta, fontSize: 13)),
          ),
        ],
      ),
    );
  }
}

class _Error extends StatelessWidget {
  const _Error({required this.mensaje, required this.onReintentar});
  final String mensaje;
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(Gap.xl),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.cloud_off_rounded, size: 32, color: AppColor.textoDebil),
          const SizedBox(height: Gap.md),
          Text(
            mensaje,
            textAlign: TextAlign.center,
            style: const TextStyle(color: AppColor.textoSuave, fontSize: 14),
          ),
          const SizedBox(height: Gap.lg),
          OutlinedButton(onPressed: onReintentar, child: const Text('Reintentar')),
        ],
      ),
    );
  }
}
