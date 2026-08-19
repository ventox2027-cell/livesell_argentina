import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../inventory/data/inventory_repository.dart';
import '../../inventory/presentation/stock_screen.dart';
import '../data/categorias_api.dart';
import '../data/tasas_api.dart';
import '../data/seller_repository.dart';
import 'widgets/conectar_mp_sheet.dart';
import '../domain/desglose_de_precio.dart';
import '../domain/seller_models.dart';

/// Crear y editar un producto.
///
/// ─── El flujo, en el orden en que piensa un vendedor ───
///
///   1. Qué vendo        → nombre
///   2. Cuánto sale      → precio
///   3. En qué rubro     → categoría
///   4. Cómo se ve       → fotos
///   5. ¿Viene en varios? → variantes
///
/// Ese orden no es casual: es el orden en que alguien describe lo que tiene en
/// la mano. El rubro va TERCERO y no primero por la misma razón: "categoría"
/// como primera pregunta de un formulario suena a trámite, y quien abandona lo
/// hace antes de llegar al precio.
///
/// Que igual esté arriba de las fotos es a propósito: hace falta para publicar,
/// y un requisito escondido al final de una pantalla larga se descubre cuando
/// ya se cargó todo.
///
/// ─── Las variantes son opcionales y lo parecen ───
///
/// La mayoría de los productos no tienen. Un interruptor las esconde por
/// completo, y quien no las necesita ni se entera de que existen. Internamente
/// el backend crea igual una variante DEFAULT, pero eso no se le explica a
/// nadie: es nuestro problema, no del vendedor.
class ProductEditorScreen extends ConsumerStatefulWidget {
  const ProductEditorScreen({super.key, this.productoId});

  /// `null` = producto nuevo.
  final String? productoId;

  @override
  ConsumerState<ProductEditorScreen> createState() => _ProductEditorScreenState();
}

class _ProductEditorScreenState extends ConsumerState<ProductEditorScreen> {
  final _nombre = TextEditingController();
  final _precio = TextEditingController();
  final _descripcion = TextEditingController();

  /// Ejes de variación: `{ "Color": ["Negro","Blanco"] }`.
  final Map<String, List<String>> _opciones = {};
  bool _tieneVariantes = false;

  /// El rubro elegido. `null` mientras no eligió ninguno.
  ///
  /// Sin esto no se puede publicar: un producto activo sin categoría no sale en
  /// ninguna navegación por rubro, así que está publicado y no lo encuentra
  /// nadie — que para quien vende es peor que no haberlo publicado, porque cree
  /// que está a la venta.
  String? _categoriaId;

  Producto? _producto;
  bool _cargando = false;
  bool _guardando = false;
  bool _huboCambios = false;

  /// El id del producto que este editor está editando, si ya existe.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// EL ID QUE VALE ES EL DE AHORA, NO EL DE CUANDO SE ABRIÓ LA PANTALLA
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Acá decía `_esNuevo => widget.productoId == null`, y `widget.productoId` no
  /// cambia nunca: es el parámetro con el que se abrió el editor.
  ///
  /// Eso creaba productos duplicados por el camino más normal que hay. Después
  /// de crear, la pantalla NO se cierra —hay que poder subirle las fotos—, así
  /// que `_producto` ya tiene un id pero `widget.productoId` sigue en `null`.
  /// El botón miraba `_producto` y decía «Guardar cambios»; `_guardar()` miraba
  /// `widget.productoId` y llamaba a `crearProducto`.
  ///
  /// O sea: **el botón decía una cosa y hacía otra.** Cargar un producto,
  /// subirle fotos y volver a tocar Guardar dejaba dos filas. Publicar después
  /// una de las dos dejaba exactamente lo reportado: un publicado y un borrador
  /// duplicado del mismo producto.
  ///
  /// Con `_idActual`, en cuanto el producto existe el editor pasa a actualizar
  /// ESE id, para siempre.
  String? get _idActual => widget.productoId ?? _producto?.id;

  bool get _esNuevo => _idActual == null;

  /// La clave que identifica ESTA alta.
  ///
  /// Se genera una sola vez por sesión de editor y viaja en cada intento de
  /// creación. Si la respuesta se pierde y se reintenta, el servidor reconoce la
  /// clave y devuelve el producto que ya creó en vez de crear otro.
  ///
  /// Es la mitad que `_idActual` no cubre: aquello evita la segunda alta cuando
  /// la primera respondió. Cuando la primera **no** respondió, el teléfono no
  /// tiene forma de saber si llegó, y sólo el servidor puede decidirlo.
  late final String _claveDeAlta = 'prd-${DateTime.now().microsecondsSinceEpoch}-'
      '${Random().nextInt(1 << 32).toRadixString(36)}';

  @override
  void initState() {
    super.initState();
    if (!_esNuevo) _cargar();
  }

  @override
  void dispose() {
    _nombre.dispose();
    _precio.dispose();
    _descripcion.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    setState(() => _cargando = true);
    try {
      final p = await ref.read(sellerRepositoryProvider).producto(widget.productoId!);
      if (!mounted) return;
      setState(() {
        _producto = p;
        _nombre.text = p.name;
        _precio.text = formatearPesos(p.basePriceCents).replaceAll('\$ ', '');
        _descripcion.text = p.description ?? '';
        _categoriaId = p.categoryId;
        _tieneVariantes = p.tieneVariantes;
        for (final o in p.options) {
          _opciones[o.name] = o.values.map((v) => v.value).toList();
        }
      });
    } catch (e) {
      if (mounted) await _mostrarError(e);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _guardar() async {
    final nombre = _nombre.text.trim();
    if (nombre.length < 2) {
      AppSnack.error(context, 'Poné un nombre al producto');
      return;
    }

    final centavos = parsearPesos(_precio.text);
    if (centavos == null || centavos < 100) {
      AppSnack.error(context, 'Poné un precio válido. Ejemplo: 12.500');
      return;
    }

    if (_tieneVariantes && _opciones.values.any((v) => v.isEmpty)) {
      AppSnack.error(context, 'Un eje sin valores no genera nada. Cargale al menos uno.');
      return;
    }

    setState(() => _guardando = true);
    try {
      final repo = ref.read(sellerRepositoryProvider);

      // ⚠️ Se lee UNA vez y se usa en todo el guardado. Leerlo de nuevo después
      // de un `await` haría que un mismo guardado empezara como alta y
      // terminara como edición, o al revés.
      final id = _idActual;

      if (id == null) {
        final creado = await repo.crearProducto(
          name: nombre,
          basePriceCents: centavos,
          description: _descripcion.text.trim(),
          opciones: _tieneVariantes ? _opciones : const {},
          categoryId: _categoriaId,
          claveDeAlta: _claveDeAlta,
        );
        if (!mounted) return;
        setState(() {
          _producto = creado;
          _huboCambios = true;
        });
        AppSnack.exito(context, 'Producto creado. Ahora agregale fotos.');
      } else {
        var actualizado = await repo.actualizarProducto(
          id,
          name: nombre,
          basePriceCents: centavos,
          description: _descripcion.text.trim(),
          categoryId: _categoriaId,
        );

        /**
         * Los ejes se guardan aparte, y ANTES no se guardaban.
         *
         * El editor mostraba "¿Viene en varios talles o colores?" también al
         * editar y dejaba cargar ejes que nunca llegaban al backend: sólo el
         * alta los mandaba. El vendedor tocaba Guardar, leía "Guardado", y su
         * producto seguía con una sola variante.
         *
         * Se manda sólo si cambió algo: reenviar la misma definición no rompe
         * nada —el backend conserva el stock de las combinaciones que siguen—
         * pero es una escritura al pedo en cada guardado.
         */
        final ejes = _tieneVariantes ? _opciones : <String, List<String>>{};
        if (!_mismosEjes(ejes, actualizado)) {
          actualizado = await repo.definirOpciones(id, ejes);
        }

        if (!mounted) return;
        setState(() {
          _producto = actualizado;
          _huboCambios = true;
        });
        AppSnack.exito(context, 'Guardado');
      }
    } catch (e) {
      if (mounted) await _mostrarError(e, reintentar: _guardar);
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  /// Muestra el error, salvo que sea el de Mercado Pago.
  ///
  /// Ese no se resuelve leyendo un cartel: se resuelve conectando la cuenta.
  /// Mostrarlo como un error rojo cualquiera dejaría al vendedor buscando
  /// dónde se arregla, con el producto ya cargado y sin poder publicarlo.
  Future<void> _mostrarError(Object e, {Future<void> Function()? reintentar}) async {
    if (e is ComercioException && e.requiereMercadoPago) {
      final fueAConectar = await ConectarMpSheet.mostrar(context, AccionBloqueada.publicar);
      /**
       * El reintento se pasa sólo donde tiene sentido.
       *
       * Reintentar automáticamente lo que sea sería peligroso: sólo guardar es
       * idempotente acá. Volver a disparar un borrado porque la persona fue a
       * conectar su cuenta sería sorprendente en el peor sentido.
       */
      if (fueAConectar && mounted && reintentar != null) await reintentar();
      return;
    }
    if (mounted) AppSnack.error(context, e.toString());
  }

  /// ¿Los ejes en pantalla son los mismos que ya tiene el producto?
  ///
  /// Compara nombres y valores, no ids: es lo que el vendedor escribió. Sirve
  /// sólo para no reenviar una definición idéntica en cada guardado — mandarla
  /// no rompería nada, porque el backend conserva el stock de las
  /// combinaciones que sobreviven.
  bool _mismosEjes(Map<String, List<String>> ejes, Producto producto) {
    if (ejes.length != producto.options.length) return false;

    for (final opcion in producto.options) {
      final valores = ejes[opcion.name];
      if (valores == null) return false;

      final actuales = opcion.values.map((v) => v.value).toList();
      if (valores.length != actuales.length) return false;
      for (var i = 0; i < valores.length; i++) {
        if (valores[i] != actuales[i]) return false;
      }
    }

    return true;
  }

  Future<void> _cambiarEstado(String nuevo) async {
    final p = _producto;
    if (p == null) return;

    /**
     * Publicar sin rubro se frena acá antes de viajar.
     *
     * El backend lo rechaza igual —es donde vive la regla de verdad— pero
     * hacerlo viajar para volver con un error es un segundo de espera para
     * decirle algo que la app ya sabe. Y el mensaje de acá puede señalar el
     * campo, que es lo que hace falta para resolverlo.
     */
    if (nuevo == 'ACTIVE' && (_categoriaId ?? '').isEmpty) {
      AppSnack.error(context, 'Elegí un rubro antes de publicar. Es como te encuentran.');
      return;
    }

    setState(() => _guardando = true);
    try {
      final r = await ref
          .read(sellerRepositoryProvider)
          .actualizarProducto(p.id, status: nuevo, categoryId: _categoriaId);
      if (!mounted) return;
      setState(() {
        _producto = r;
        _huboCambios = true;
      });
      AppSnack.exito(
        context,
        nuevo == 'ACTIVE'
            ? 'Publicado. Ya lo pueden comprar.'
            : 'Producto ${r.etiquetaEstado.toLowerCase()}',
      );
    } catch (e) {
      if (mounted) await _mostrarError(e);
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  Future<void> _agregarFoto() async {
    final p = _producto;
    if (p == null) {
      AppSnack.info(context, 'Guardá el producto antes de agregar fotos');
      return;
    }

    final picker = ImagePicker();
    final elegida = await picker.pickImage(
      source: ImageSource.gallery,
      // Se reduce en el teléfono antes de subir. Una foto de 12 MP pesa varios
      // MB y en 4G argentino puede tardar un minuto; a 1600px se ve igual en
      // una pantalla de 6" y sube en segundos.
      maxWidth: 1600,
      maxHeight: 1600,
      imageQuality: 85,
    );
    if (elegida == null || !mounted) return;

    setState(() => _guardando = true);
    try {
      await ref.read(sellerRepositoryProvider).subirImagen(p.id, File(elegida.path));
      final actualizado = await ref.read(sellerRepositoryProvider).producto(p.id);
      if (!mounted) return;
      setState(() {
        _producto = actualizado;
        _huboCambios = true;
      });
    } catch (e) {
      if (mounted) await _mostrarError(e);
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  Future<void> _borrarFoto(String imageId) async {
    final p = _producto;
    if (p == null) return;

    setState(() => _guardando = true);
    try {
      await ref.read(sellerRepositoryProvider).borrarImagen(p.id, imageId);
      final actualizado = await ref.read(sellerRepositoryProvider).producto(p.id);
      if (!mounted) return;
      setState(() {
        _producto = actualizado;
        _huboCambios = true;
      });
    } catch (e) {
      if (mounted) await _mostrarError(e);
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  Future<void> _alternarVariante(Variante v) async {
    final p = _producto;
    if (p == null) return;

    setState(() => _guardando = true);
    try {
      final r = await ref.read(sellerRepositoryProvider).actualizarVariante(
            p.id,
            v.id,
            status: v.activa ? 'INACTIVE' : 'ACTIVE',
          );
      if (!mounted) return;
      setState(() {
        _producto = r;
        _huboCambios = true;
      });
    } catch (e) {
      if (mounted) await _mostrarError(e);
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _producto;

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_huboCambios);
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(_esNuevo ? 'Nuevo producto' : 'Editar producto'),
          leading: IconButton(
            icon: const Icon(Icons.close_rounded),
            onPressed: () => Navigator.of(context).pop(_huboCambios),
          ),
          actions: [
            if (p != null)
              IconButton(
                icon: const Icon(Icons.delete_outline_rounded),
                onPressed: _guardando ? null : _confirmarBorrado,
              ),
          ],
        ),
        body: _cargando
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, 120),
                children: [
                  // ── 1. Qué vendo ──
                  TextField(
                    controller: _nombre,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: const InputDecoration(
                      labelText: '¿Qué vendés?',
                      hintText: 'Sweater de lana',
                    ),
                  ),
                  const SizedBox(height: Gap.lg),

                  // ── 2. Cuánto sale ──
                  TextField(
                    controller: _precio,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                      labelText: 'Precio',
                      prefixText: '\$ ',
                      hintText: '12.500',
                    ),
                    // Se redibuja el desglose mientras escribe. Enterarse de lo
                    // que se lleva la plataforma DESPUÉS de vender es la razón
                    // por la que un costo publicado se siente escondido.
                    onChanged: (_) => setState(() {}),
                  ),
                  _DesgloseDelPrecio(
                    centavos: parsearPesos(_precio.text) ?? 0,
                    onUsarPrecio: (sugerido) {
                      _precio.text = formatearPesos(sugerido).replaceAll('\$ ', '');
                      setState(() {});
                    },
                  ),
                  const SizedBox(height: Gap.lg),

                  // ── 2b. En qué rubro entra ──
                  _SelectorDeCategoria(
                    elegida: _categoriaId,
                    onElegir: (id) => setState(() => _categoriaId = id),
                  ),
                  const SizedBox(height: Gap.lg),

                  TextField(
                    controller: _descripcion,
                    maxLines: 3,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: const InputDecoration(
                      labelText: 'Descripción (opcional)',
                      alignLabelWithHint: true,
                    ),
                  ),

                  // ── 3. Fotos ──
                  if (p != null) ...[
                    const SizedBox(height: Gap.xl),
                    _SeccionFotos(
                      producto: p,
                      onAgregar: _guardando ? null : _agregarFoto,
                      onBorrar: _guardando ? null : _borrarFoto,
                    ),
                  ],

                  // ── 4. Variantes ──
                  const SizedBox(height: Gap.xl),
                  if (_esNuevo && p == null)
                    _EditorOpciones(
                      tieneVariantes: _tieneVariantes,
                      opciones: _opciones,
                      onCambio: (tiene) => setState(() => _tieneVariantes = tiene),
                      onActualizar: () => setState(() {}),
                    )
                  else if (p != null && p.variants.length > 1)
                    _ListaVariantes(
                      producto: p,
                      onAlternar: _guardando ? null : _alternarVariante,
                    ),

                  if (p != null) ...[
                    const SizedBox(height: Gap.xl),
                    _AccesoStock(producto: p),
                    const SizedBox(height: Gap.xl),
                    _EstadoPublicacion(
                      producto: p,
                      onCambiar: _guardando ? null : _cambiarEstado,
                    ),
                  ],
                ],
              ),
        bottomNavigationBar: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(Gap.lg),
            child: FilledButton(
              onPressed: _guardando ? null : _guardar,
              child: _guardando
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                    )
                  : Text(_esNuevo && p == null ? 'Crear producto' : 'Guardar cambios'),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _confirmarBorrado() async {
    final p = _producto;
    if (p == null) return;

    final confirma = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColor.superficie,
        title: const Text('¿Borrar el producto?'),
        content: const Text(
          'Deja de estar publicado. Si ya te lo compraron, esas ventas se '
          'conservan en tu historial.',
          style: TextStyle(color: AppColor.textoSuave, height: 1.45),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancelar')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColor.error),
            child: const Text('Borrar'),
          ),
        ],
      ),
    );
    if (confirma != true || !mounted) return;

    try {
      await ref.read(sellerRepositoryProvider).borrarProducto(p.id);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) await _mostrarError(e);
    }
  }
}

// ─── Secciones ──────────────────────────────────────────────────────────────

class _SeccionFotos extends StatelessWidget {
  const _SeccionFotos({required this.producto, this.onAgregar, this.onBorrar});

  final Producto producto;
  final VoidCallback? onAgregar;
  final void Function(String imageId)? onBorrar;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _TituloSeccion('Fotos'),
        const SizedBox(height: 4),
        const Text(
          'La primera es la que se ve en el feed.',
          style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
        ),
        const SizedBox(height: Gap.md),
        SizedBox(
          height: 96,
          child: ListView(
            scrollDirection: Axis.horizontal,
            children: [
              for (final img in producto.images)
                Padding(
                  padding: const EdgeInsets.only(right: Gap.sm),
                  child: _Miniatura(
                    imagen: img,
                    esPortada: img.position == 0,
                    onBorrar: onBorrar == null ? null : () => onBorrar!(img.id),
                  ),
                ),
              if (producto.images.length < 10)
                InkWell(
                  onTap: onAgregar,
                  borderRadius: BorderRadius.circular(Redondeo.md),
                  child: Container(
                    width: 96,
                    height: 96,
                    decoration: BoxDecoration(
                      color: AppColor.superficie,
                      borderRadius: BorderRadius.circular(Redondeo.md),
                      border: Border.all(color: AppColor.borde),
                    ),
                    child: const Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.add_a_photo_outlined, color: AppColor.textoSuave),
                        SizedBox(height: 4),
                        Text('Agregar', style: TextStyle(fontSize: 11, color: AppColor.textoSuave)),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Miniatura extends StatelessWidget {
  const _Miniatura({required this.imagen, required this.esPortada, this.onBorrar});

  final ImagenProducto imagen;
  final bool esPortada;
  final VoidCallback? onBorrar;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(Redondeo.md),
          child: Image.network(
            imagen.url,
            width: 96,
            height: 96,
            fit: BoxFit.cover,
            errorBuilder: (_, __, ___) => Container(
              width: 96,
              height: 96,
              color: AppColor.superficieAlta,
              child: const Icon(Icons.broken_image_outlined, color: AppColor.textoDebil),
            ),
          ),
        ),
        if (esPortada)
          Positioned(
            left: 4,
            bottom: 4,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: AppColor.acento,
                borderRadius: BorderRadius.circular(4),
              ),
              child: const Text(
                'Portada',
                style: TextStyle(fontSize: 9, fontWeight: FontWeight.w700),
              ),
            ),
          ),
        Positioned(
          right: 2,
          top: 2,
          child: GestureDetector(
            onTap: onBorrar,
            child: Container(
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.6),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.close_rounded, size: 14, color: Colors.white),
            ),
          ),
        ),
      ],
    );
  }
}

/// Editor de ejes de variación, para productos nuevos.
class _EditorOpciones extends StatelessWidget {
  const _EditorOpciones({
    required this.tieneVariantes,
    required this.opciones,
    required this.onCambio,
    required this.onActualizar,
  });

  final bool tieneVariantes;
  final Map<String, List<String>> opciones;
  final ValueChanged<bool> onCambio;
  final VoidCallback onActualizar;

  @override
  Widget build(BuildContext context) {
    // Cuántas variantes van a salir. Mostrarlo evita la sorpresa de crear 60
    // combinaciones sin querer.
    final total =
        opciones.values.where((v) => v.isNotEmpty).fold<int>(1, (acc, v) => acc * v.length);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SwitchListTile.adaptive(
          value: tieneVariantes,
          onChanged: onCambio,
          contentPadding: EdgeInsets.zero,
          activeThumbColor: AppColor.acento,
          title: const Text('¿Viene en varios talles o colores?',
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500)),
          subtitle: const Text(
            'Si no, dejalo apagado',
            style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
          ),
        ),
        if (tieneVariantes) ...[
          const SizedBox(height: Gap.md),
          for (final entrada in opciones.entries)
            Padding(
              padding: const EdgeInsets.only(bottom: Gap.md),
              child: _FilaOpcion(
                nombre: entrada.key,
                valores: entrada.value,
                onBorrar: () {
                  opciones.remove(entrada.key);
                  onActualizar();
                },
              ),
            ),
          if (opciones.length < 3)
            OutlinedButton.icon(
              onPressed: () => _agregarOpcion(context),
              icon: const Icon(Icons.add_rounded, size: 18),
              label: const Text('Agregar Color, Talle, etc.'),
            ),
          if (opciones.isNotEmpty) ...[
            const SizedBox(height: Gap.md),
            Container(
              padding: const EdgeInsets.all(Gap.md),
              decoration: BoxDecoration(
                color: AppColor.superficie,
                borderRadius: BorderRadius.circular(Redondeo.md),
              ),
              child: Row(
                children: [
                  const Icon(Icons.grid_view_rounded, size: 16, color: AppColor.textoSuave),
                  const SizedBox(width: Gap.sm),
                  Text(
                    'Se van a crear $total ${total == 1 ? "variante" : "variantes"}',
                    style: const TextStyle(fontSize: 13, color: AppColor.textoSuave),
                  ),
                ],
              ),
            ),
          ],
        ],
      ],
    );
  }

  Future<void> _agregarOpcion(BuildContext context) async {
    final resultado = await showModalBottomSheet<(String, List<String>)>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _HojaNuevaOpcion(),
    );
    if (resultado == null) return;
    opciones[resultado.$1] = resultado.$2;
    onActualizar();
  }
}

class _FilaOpcion extends StatelessWidget {
  const _FilaOpcion({required this.nombre, required this.valores, required this.onBorrar});

  final String nombre;
  final List<String> valores;
  final VoidCallback onBorrar;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.md),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(color: AppColor.borde),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(nombre, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14.5)),
              const Spacer(),
              GestureDetector(
                onTap: onBorrar,
                child: const Icon(Icons.close_rounded, size: 18, color: AppColor.textoDebil),
              ),
            ],
          ),
          const SizedBox(height: Gap.sm),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final v in valores)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: AppColor.superficieAlta,
                    borderRadius: BorderRadius.circular(Redondeo.sm),
                  ),
                  child: Text(v, style: const TextStyle(fontSize: 12.5)),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _HojaNuevaOpcion extends StatefulWidget {
  const _HojaNuevaOpcion();

  @override
  State<_HojaNuevaOpcion> createState() => _HojaNuevaOpcionState();
}

class _HojaNuevaOpcionState extends State<_HojaNuevaOpcion> {
  final _nombre = TextEditingController();
  final _valores = TextEditingController();

  @override
  void dispose() {
    _nombre.dispose();
    _valores.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: Gap.xl,
        right: Gap.xl,
        top: Gap.sm,
        bottom: MediaQuery.viewInsetsOf(context).bottom + Gap.xl,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Nueva opción', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: Gap.lg),
          Wrap(
            spacing: 8,
            children: [
              for (final sugerencia in ['Color', 'Talle', 'Capacidad', 'Sabor'])
                ActionChip(
                  label: Text(sugerencia),
                  onPressed: () => _nombre.text = sugerencia,
                  backgroundColor: AppColor.superficieAlta,
                  side: BorderSide.none,
                ),
            ],
          ),
          const SizedBox(height: Gap.md),
          TextField(
            controller: _nombre,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Nombre', hintText: 'Color'),
          ),
          const SizedBox(height: Gap.md),
          TextField(
            controller: _valores,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(
              labelText: 'Valores, separados por coma',
              hintText: 'Negro, Blanco, Rojo',
            ),
          ),
          const SizedBox(height: Gap.lg),
          FilledButton(
            onPressed: () {
              final nombre = _nombre.text.trim();
              final valores =
                  _valores.text.split(',').map((v) => v.trim()).where((v) => v.isNotEmpty).toList();
              if (nombre.isEmpty || valores.isEmpty) {
                AppSnack.error(context, 'Completá el nombre y al menos un valor');
                return;
              }
              Navigator.of(context).pop((nombre, valores));
            },
            child: const Text('Agregar'),
          ),
        ],
      ),
    );
  }
}

/// Variantes ya creadas, con interruptor por combinación.
class _ListaVariantes extends StatelessWidget {
  const _ListaVariantes({required this.producto, this.onAlternar});

  final Producto producto;
  final void Function(Variante)? onAlternar;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _TituloSeccion('Variantes'),
        const SizedBox(height: 4),
        const Text(
          'Apagá las que no vendas. Después vas a poder cargarles stock.',
          style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
        ),
        const SizedBox(height: Gap.md),
        for (final v in producto.variants)
          Container(
            margin: const EdgeInsets.only(bottom: Gap.sm),
            padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: Gap.sm),
            decoration: BoxDecoration(
              color: AppColor.superficie,
              borderRadius: BorderRadius.circular(Redondeo.md),
              border: Border.all(color: AppColor.borde),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        v.title,
                        style: TextStyle(
                          fontSize: 14.5,
                          fontWeight: FontWeight.w500,
                          color: v.activa ? AppColor.texto : AppColor.textoDebil,
                        ),
                      ),
                      Text(
                        formatearPesos(v.priceCents),
                        style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                      ),
                    ],
                  ),
                ),
                Switch.adaptive(
                  value: v.activa,
                  onChanged: onAlternar == null ? null : (_) => onAlternar!(v),
                  activeThumbColor: AppColor.acento,
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// Acceso al stock, con el resumen a la vista.
///
/// Se muestra el número acá y no sólo detrás del toque porque "¿cuántas me
/// quedan?" es la pregunta que un vendedor se hace cada vez que abre un
/// producto. Que haya que entrar para verla sería una pantalla de más por algo
/// que entra en una línea.
class _AccesoStock extends ConsumerWidget {
  const _AccesoStock({required this.producto});
  final Producto producto;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final stock = ref.watch(stockDeProductoProvider(producto.id));

    return InkWell(
      onTap: () async {
        await Navigator.of(context).push<void>(
          MaterialPageRoute(
            builder: (_) => StockScreen(productId: producto.id, nombreProducto: producto.name),
          ),
        );
        ref.invalidate(stockDeProductoProvider(producto.id));
      },
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
            const Icon(Icons.inventory_2_outlined, size: 20, color: AppColor.textoSuave),
            const SizedBox(width: Gap.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Stock', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text(
                    stock.when(
                      loading: () => 'Cargando…',
                      error: (_, __) => 'No se pudo cargar',
                      data: (s) => s.totalReservado > 0
                          ? '${s.totalDisponible} disponibles · ${s.totalReservado} apartadas'
                          : (s.totalOnHand == 0
                              ? 'Sin stock cargado'
                              : '${s.totalOnHand} unidades'),
                    ),
                    style: TextStyle(
                      fontSize: 12.5,
                      color: stock.valueOrNull?.totalDisponible == 0
                          ? AppColor.alerta
                          : AppColor.textoSuave,
                    ),
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

/// El selector de rubro.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// UN DESPLEGABLE Y NO UNA PANTALLA APARTE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Catorce opciones entran en una lista que se lee de un vistazo. Mandarlo a
/// otra pantalla para elegir una de catorce agrega dos toques y una navegación
/// a un formulario que ya tiene cuatro campos.
///
/// ─── Si la lista no carga, no se traba el formulario ───
///
/// El catálogo viene del servidor y puede fallar. Cuando falla, el campo
/// muestra el motivo y un botón para reintentar, y el resto del editor sigue
/// funcionando: alguien con mala señal tiene que poder guardar el borrador
/// igual. Lo único que no va a poder es publicar, y eso ya se lo dice el botón
/// de publicar.
/// Cuánto se lleva cada uno, mientras el vendedor escribe el precio.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL ARGUMENTO COMERCIAL DE VENDOX, HECHO PANTALLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// «Antes de publicar te mostramos cuánto vas a pagar y cuánto estimamos que
/// vas a recibir. Sin costos escondidos.»
///
/// Un costo publicado en algún lado pero descubierto DESPUÉS de vender se
/// siente escondido igual. Por eso va acá, al lado del campo, y no en una
/// pantalla de ayuda.
///
/// ⚠️ El costo de Mercado Pago es una ESTIMACIÓN y la pantalla lo dice. La tasa
/// real la informan ellos después de cobrar y depende del medio de pago, las
/// cuotas y las condiciones de la cuenta. Presentarlo como exacto sería la
/// misma clase de promesa incumplible que un aviso que nadie puede satisfacer.
class _DesgloseDelPrecio extends ConsumerWidget {
  const _DesgloseDelPrecio({required this.centavos, required this.onUsarPrecio});

  final int centavos;
  final ValueChanged<int> onUsarPrecio;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Sin precio todavía no hay nada que mostrar. Un desglose en cero ocupa
    // lugar y no dice nada.
    if (centavos <= 0) return const SizedBox.shrink();

    final tasas = ref.watch(tasasProvider).valueOrNull ?? TasasDeVendox.porOmision;
    final d = desglosarPrecio(
      precio: centavos,
      comisionBps: tasas.comisionBps,
      costoDelProcesadorBps: tasas.costoDelProcesadorBps,
    );

    return Padding(
      padding: const EdgeInsets.only(top: Gap.md),
      child: Container(
        padding: const EdgeInsets.all(Gap.md),
        decoration: BoxDecoration(
          color: AppColor.superficie,
          borderRadius: BorderRadius.circular(Redondeo.md),
          border: Border.all(color: AppColor.borde),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Linea('Lo que ve quien compra', formatearPesos(d.precio)),
            // La etiqueta viene del servidor cuando está: «Comisión VendoX
            // Business (3,5%)» dice el plan y el porcentaje reales de este
            // vendedor. El respaldo se arma con `tasas.comisionBps`, que
            // también viene del servidor: no hay ningún porcentaje escrito acá.
            _Linea(
              tasas.comision?.etiqueta ??
                  'Comisión de VendoX (${porcentajeLegible(tasas.comisionBps)} %)',
              '-${formatearPesos(d.comision)}',
            ),
            _Linea(
              'Mercado Pago (aprox.)',
              '-${formatearPesos(d.costoDelProcesador)}',
            ),
            const Padding(
              padding: EdgeInsets.symmetric(vertical: Gap.sm),
              child: Divider(height: 1, color: AppColor.borde),
            ),
            _Linea('Estimado que recibís', formatearPesos(d.netoEstimado), fuerte: true),
            if (tasas.comision?.aviso != null) ...[
              const SizedBox(height: Gap.sm),
              _AvisoDeComision(detalle: tasas.comision!),
            ],
            const SizedBox(height: Gap.sm),
            const Text(
              'El costo de Mercado Pago lo informan ellos después de cobrar, así que '
              'esto es aproximado.',
              style: TextStyle(fontSize: 11, color: AppColor.textoDebil, height: 1.35),
            ),
            const SizedBox(height: Gap.sm),
            _CuantoQuerasRecibir(tasas: tasas, onUsarPrecio: onUsarPrecio),
          ],
        ),
      ),
    );
  }
}

/// Lo que hay que contarle al vendedor sobre su comisión.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SÓLO APARECE CUANDO HAY ALGO QUE DECIR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Dos casos, y los dos son novedades reales:
///
///   · «Tu comisión bajó por volumen de ventas.» — el descuento se ganó y el
///     vendedor tiene que enterarse, porque si no el beneficio de Business es
///     invisible.
///   · Devoluciones por encima del límite — tiene el volumen pero no accede.
///     Callarlo sería lo peor de los dos mundos: paga más y no sabe que hay
///     algo que puede corregir.
///
/// El texto lo escribe el servidor. Acá no se decide nada: si esta pantalla
/// tuviera su propio `if` sobre el motivo, habría dos reglas y la del teléfono
/// quedaría vieja hasta la próxima versión publicada.
class _AvisoDeComision extends StatelessWidget {
  const _AvisoDeComision({required this.detalle});

  final DetalleDeComision detalle;

  @override
  Widget build(BuildContext context) {
    final bueno = detalle.bajoPorVolumen;

    return Container(
      padding: const EdgeInsets.symmetric(vertical: Gap.sm, horizontal: Gap.md),
      decoration: BoxDecoration(
        color: bueno ? AppColor.acentoSuave : AppColor.superficieAlta,
        borderRadius: BorderRadius.circular(Redondeo.sm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            bueno ? Icons.trending_down : Icons.info_outline,
            size: 15,
            color: bueno ? AppColor.acento : AppColor.textoSuave,
          ),
          const SizedBox(width: Gap.sm),
          Expanded(
            child: Text(
              detalle.aviso!,
              style: TextStyle(
                fontSize: 12,
                height: 1.35,
                color: bueno ? AppColor.texto : AppColor.textoSuave,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Linea extends StatelessWidget {
  const _Linea(this.etiqueta, this.valor, {this.fuerte = false});

  final String etiqueta;
  final String valor;
  final bool fuerte;

  @override
  Widget build(BuildContext context) {
    final estilo = TextStyle(
      fontSize: fuerte ? 14 : 13,
      fontWeight: fuerte ? FontWeight.w700 : FontWeight.w400,
      color: fuerte ? AppColor.texto : AppColor.textoSuave,
    );

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(etiqueta, style: estilo),
          Text(valor, style: estilo),
        ],
      ),
    );
  }
}

/// La cuenta al revés: cuánto publicar para recibir lo que la persona quiere.
///
/// Es la pregunta que el vendedor se hace de verdad. «Yo quiero que me queden
/// $100.000» es más natural que «quiero publicar a $111.350».
class _CuantoQuerasRecibir extends StatefulWidget {
  const _CuantoQuerasRecibir({required this.tasas, required this.onUsarPrecio});

  final TasasDeVendox tasas;
  final ValueChanged<int> onUsarPrecio;

  @override
  State<_CuantoQuerasRecibir> createState() => _CuantoQuerasRecibirState();
}

class _CuantoQuerasRecibirState extends State<_CuantoQuerasRecibir> {
  final _neto = TextEditingController();
  bool _abierto = false;

  @override
  void dispose() {
    _neto.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_abierto) {
      return Align(
        alignment: Alignment.centerLeft,
        child: TextButton(
          onPressed: () => setState(() => _abierto = true),
          style: TextButton.styleFrom(padding: EdgeInsets.zero),
          child: const Text('¿Cuánto querés recibir?', style: TextStyle(fontSize: 13)),
        ),
      );
    }

    final pedido = parsearPesos(_neto.text) ?? 0;
    final sugerido = pedido > 0
        ? precioParaRecibir(
            neto: pedido,
            comisionBps: widget.tasas.comisionBps,
            costoDelProcesadorBps: widget.tasas.costoDelProcesadorBps,
          )
        : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          controller: _neto,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          onChanged: (_) => setState(() {}),
          decoration: const InputDecoration(
            labelText: 'Quiero recibir',
            prefixText: '\$ ',
            isDense: true,
          ),
        ),
        if (sugerido != null) ...[
          const SizedBox(height: Gap.sm),
          Row(
            children: [
              Expanded(
                child: Text(
                  'Publicá a ${formatearPesos(sugerido)} aprox.',
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                ),
              ),
              TextButton(
                onPressed: () => widget.onUsarPrecio(sugerido),
                child: const Text('Usar'),
              ),
            ],
          ),
        ],
      ],
    );
  }
}

class _SelectorDeCategoria extends ConsumerWidget {
  const _SelectorDeCategoria({required this.elegida, required this.onElegir});

  final String? elegida;
  final ValueChanged<String?> onElegir;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final categorias = ref.watch(categoriasProvider);

    return categorias.when(
      loading: () => const InputDecorator(
        decoration: InputDecoration(labelText: 'Rubro'),
        child: Text('Cargando…'),
      ),
      /**
       * El motivo REAL, no siempre «sin conexión».
       *
       * Antes este handler descartaba el error y mostraba ese texto pasara lo
       * que pasara. Con el servidor arriba contestando 404, el cartel mandaba
       * a revisar la WiFi — y el problema estaba del otro lado.
       */
      error: (error, __) => InputDecorator(
        decoration: const InputDecoration(
          labelText: 'Rubro',
          helperText: 'No se pudo cargar la lista. Podés guardar el borrador igual.',
        ),
        child: Row(
          children: [
            Expanded(child: Text(mensajeDeFalloDeCategorias(error))),
            TextButton(
              onPressed: () => ref.invalidate(categoriasProvider),
              child: const Text('Reintentar'),
            ),
          ],
        ),
      ),
      data: (lista) {
        /**
         * ⚠️ El valor sólo se pasa si está en la lista.
         *
         * `DropdownButtonFormField` revienta con una excepción si el `value` no
         * corresponde a ninguno de sus items. Pasa de verdad: un producto viejo
         * con una categoría que después se apagó abriría el editor en rojo.
         *
         * Mostrarlo vacío es lo correcto además de lo seguro — esa categoría ya
         * no se puede elegir, y quien edite el producto tiene que elegir otra.
         */
        final valor = lista.any((c) => c.id == elegida) ? elegida : null;

        return DropdownButtonFormField<String>(
          initialValue: valor,
          isExpanded: true,
          decoration: const InputDecoration(
            labelText: 'Rubro',
            helperText: 'Hace falta para publicar. Es como te encuentran.',
          ),
          items: [
            for (final c in lista)
              DropdownMenuItem(
                value: c.id,
                child: Text(c.nombre, overflow: TextOverflow.ellipsis),
              ),
          ],
          onChanged: onElegir,
        );
      },
    );
  }
}

class _EstadoPublicacion extends StatelessWidget {
  const _EstadoPublicacion({required this.producto, this.onCambiar});

  final Producto producto;
  final void Function(String)? onCambiar;

  @override
  Widget build(BuildContext context) {
    final publicado = producto.publicado;

    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: AppColor.borde),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(
                publicado ? Icons.visibility_rounded : Icons.visibility_off_outlined,
                size: 18,
                color: publicado ? AppColor.exito : AppColor.textoSuave,
              ),
              const SizedBox(width: Gap.sm),
              Text(
                publicado ? 'Publicado' : producto.etiquetaEstado,
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            publicado
                ? 'Cualquiera puede verlo y comprarlo.'
                : 'Sólo lo ves vos. Publicalo cuando esté listo.',
            style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
          ),
          const SizedBox(height: Gap.md),
          if (publicado)
            OutlinedButton(
              onPressed: onCambiar == null ? null : () => onCambiar!('PAUSED'),
              child: const Text('Pausar'),
            )
          else
            FilledButton(
              onPressed: onCambiar == null ? null : () => onCambiar!('ACTIVE'),
              child: const Text('Publicar'),
            ),
        ],
      ),
    );
  }
}

class _TituloSeccion extends StatelessWidget {
  const _TituloSeccion(this.texto);
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
