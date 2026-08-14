import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../feed/data/feed_repository.dart';
import '../../feed/domain/feed_models.dart';
import '../../lives/presentation/variant_sheet.dart';

/// Buscar en el catálogo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SE BUSCA MIENTRAS SE ESCRIBE, PERO NO EN CADA TECLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Una petición por tecla en "zapatillas" son once viajes a la base para
/// mostrar el resultado de uno. Y peor: llegan desordenados, así que la
/// pantalla puede terminar mostrando el resultado de "zapa" después del de
/// "zapatillas".
///
/// Se espera a que la persona deje de escribir 350 ms. Es el tiempo que tarda
/// alguien en pasar de una tecla a la siguiente cuando duda, y suficientemente
/// corto como para que se sienta inmediato.
///
/// ─── Y las respuestas viejas se descartan ───
///
/// Aunque se espere, dos búsquedas pueden estar en vuelo a la vez —una lenta y
/// una rápida— y la lenta llegar última. Cada búsqueda lleva un número de
/// secuencia y sólo se pinta la más nueva. Sin eso, escribir rápido deja la
/// pantalla mostrando resultados de algo que ya no está escrito.
class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key});

  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  final _texto = TextEditingController();
  final _foco = FocusNode();

  Timer? _espera;
  int _secuencia = 0;

  List<PublicacionFeed> _resultados = const [];
  bool _buscando = false;
  String _ultimaBusqueda = '';

  @override
  void dispose() {
    _espera?.cancel();
    _texto.dispose();
    _foco.dispose();
    super.dispose();
  }

  void _alEscribir(String v) {
    _espera?.cancel();

    final consulta = v.trim();

    // Menos de dos caracteres devuelve medio catálogo: se limpia y se espera.
    if (consulta.length < 2) {
      setState(() {
        _resultados = const [];
        _buscando = false;
        _ultimaBusqueda = '';
      });
      return;
    }

    setState(() => _buscando = true);
    _espera = Timer(const Duration(milliseconds: 350), () => unawaited(_buscar(consulta)));
  }

  Future<void> _buscar(String consulta) async {
    _secuencia += 1;
    final mio = _secuencia;

    try {
      final r = await ref.read(feedRepositoryProvider).descubrir(q: consulta, limit: 30);

      // Llegó una respuesta vieja: se descarta. Ver el comentario de la clase.
      if (!mounted || mio != _secuencia) return;

      setState(() {
        _resultados = r.items;
        _buscando = false;
        _ultimaBusqueda = consulta;
      });
    } catch (_) {
      if (!mounted || mio != _secuencia) return;
      setState(() {
        _buscando = false;
        _ultimaBusqueda = consulta;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(
        titleSpacing: Gap.md,
        title: TextField(
          controller: _texto,
          focusNode: _foco,
          autofocus: false,
          textInputAction: TextInputAction.search,
          onChanged: _alEscribir,
          decoration: InputDecoration(
            hintText: 'Buscar productos',
            prefixIcon: const Icon(Icons.search_rounded, size: 20),
            // Sólo cuando hay algo que borrar: un ícono permanente que no hace
            // nada la mitad del tiempo enseña a ignorarlo.
            suffixIcon: _texto.text.isEmpty
                ? null
                : IconButton(
                    icon: const Icon(Icons.close_rounded, size: 18),
                    onPressed: () {
                      _texto.clear();
                      _alEscribir('');
                    },
                  ),
            isDense: true,
            filled: true,
            fillColor: AppColor.superficie,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(Redondeo.md),
              borderSide: BorderSide.none,
            ),
          ),
        ),
      ),
      body: _cuerpo(),
    );
  }

  Widget _cuerpo() {
    if (_texto.text.trim().length < 2) {
      return const _Vacio(
        icono: Icons.search_rounded,
        titulo: 'Buscá lo que necesitás',
        detalle: 'Escribí el nombre de un producto. Funciona en plural y sin acentos.',
      );
    }

    if (_buscando && _resultados.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_resultados.isEmpty) {
      return _Vacio(
        icono: Icons.sentiment_dissatisfied_rounded,
        titulo: 'Nada por "$_ultimaBusqueda"',
        // Sugerir qué hacer, no lamentarse. "No se encontraron resultados" es
        // información que la persona ya tiene mirando la pantalla vacía.
        detalle: 'Probá con menos palabras, o con el nombre de la prenda sola.',
      );
    }

    return GridView.builder(
      padding: const EdgeInsets.all(Gap.md),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        crossAxisSpacing: Gap.md,
        mainAxisSpacing: Gap.md,
        // Alto pensado para imagen cuadrada + dos líneas de texto + precio.
        childAspectRatio: 0.66,
      ),
      itemCount: _resultados.length,
      itemBuilder: (_, i) => _Tarjeta(
        publicacion: _resultados[i],
        onTap: () => _abrir(_resultados[i]),
      ),
    );
  }

  Future<void> _abrir(PublicacionFeed p) async {
    // La misma hoja que el vivo: una sola forma de elegir talle y comprar en
    // toda la app. Dos caminos distintos hacia la misma compra se despegan.
    await VariantSheet.mostrar(
      context,
      productId: p.id,
      storeId: p.storeId,
    );
  }
}

class _Tarjeta extends StatelessWidget {
  const _Tarjeta({required this.publicacion, required this.onTap});

  final PublicacionFeed publicacion;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Redondeo.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(Redondeo.md),
              child: publicacion.portada == null
                  ? Container(
                      color: AppColor.superficie,
                      child: const Center(
                        child: Icon(
                          Icons.image_outlined,
                          color: AppColor.textoDebil,
                          size: 28,
                        ),
                      ),
                    )
                  : CachedNetworkImage(
                      imageUrl: publicacion.portada!,
                      fit: BoxFit.cover,
                      width: double.infinity,
                      // Sin parpadeo blanco mientras carga: el color de fondo
                      // de la app es oscuro y un flash blanco en una grilla se
                      // ve como un error.
                      placeholder: (_, __) => Container(color: AppColor.superficie),
                      errorWidget: (_, __, ___) => Container(
                        color: AppColor.superficie,
                        child: const Icon(
                          Icons.broken_image_outlined,
                          color: AppColor.textoDebil,
                        ),
                      ),
                    ),
            ),
          ),
          const SizedBox(height: Gap.sm),
          Text(
            publicacion.nombre,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 13, height: 1.25),
          ),
          const SizedBox(height: 2),
          Text(
            publicacion.precio,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800),
          ),
        ],
      ),
    );
  }
}

class _Vacio extends StatelessWidget {
  const _Vacio({required this.icono, required this.titulo, required this.detalle});

  final IconData icono;
  final String titulo;
  final String detalle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: Gap.xl),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icono, size: 44, color: AppColor.textoDebil),
          const SizedBox(height: Gap.lg),
          Text(
            titulo,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: Gap.sm),
          Text(
            detalle,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.45),
          ),
        ],
      ),
    );
  }
}
