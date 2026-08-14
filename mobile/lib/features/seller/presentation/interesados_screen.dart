import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../auth/state/auth_providers.dart';

/// Quién está esperando para comprar.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// NÚMEROS, NO CONTACTOS
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El backend manda nombre de pila y cantidades. No manda teléfono, email ni
/// apellido, y no es una limitación técnica: es la decisión.
///
/// Quien dejó una intención pidió que le AVISEN cuando la tienda abra. No le
/// dio su teléfono a un vendedor para que lo contacte por WhatsApp — y si
/// estuviera acá, eso es lo que pasaría el primer día, sin forma de volver
/// atrás. El aviso lo manda VendoX.
///
/// Lo que el vendedor necesita para decidir es el número: "once personas
/// esperando el talle M". Eso sí está, y es lo que le sirve para reponer.
class InteresadosScreen extends ConsumerStatefulWidget {
  const InteresadosScreen({super.key});

  @override
  ConsumerState<InteresadosScreen> createState() => _InteresadosScreenState();
}

class _InteresadosScreenState extends ConsumerState<InteresadosScreen> {
  Map<String, dynamic>? _datos;
  bool _cargando = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_cargar());
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });

    try {
      final r = await ref
          .read(apiClientProvider)
          .get<Map<String, dynamic>>('/stores/me/intents');
      if (!mounted) return;
      setState(() {
        _datos = r.data;
        _cargando = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _cargando = false;
        _error = 'No pudimos traer la lista.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(title: const Text('Interesados')),
      body: RefreshIndicator(onRefresh: _cargar, child: _cuerpo()),
    );
  }

  Widget _cuerpo() {
    if (_cargando) return const Center(child: CircularProgressIndicator());

    if (_error != null) {
      return _Vacio(
        icono: Icons.wifi_off_rounded,
        titulo: _error!,
        accion: TextButton(onPressed: _cargar, child: const Text('Reintentar')),
      );
    }

    final items = (_datos?['items'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>();

    if (items.isEmpty) {
      return const _Vacio(
        icono: Icons.people_outline_rounded,
        titulo: 'Nadie esperando todavía',
        detalle: 'Cuando alguien quiera comprar con la tienda cerrada, o cuando '
            'un producto se agote, va a aparecer acá.',
      );
    }

    final personas = (_datos?['totalPersonas'] as num?)?.toInt() ?? 0;
    final unidades = (_datos?['totalUnidades'] as num?)?.toInt() ?? 0;
    final sinStock = (_datos?['sinStock'] as num?)?.toInt() ?? 0;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, Gap.xxl),
      children: [
        _Resumen(personas: personas, unidades: unidades, sinStock: sinStock),
        const SizedBox(height: Gap.lg),
        for (final p in items) ...[
          _Producto(producto: p),
          const SizedBox(height: Gap.md),
        ],
      ],
    );
  }
}

class _Resumen extends StatelessWidget {
  const _Resumen({required this.personas, required this.unidades, required this.sinStock});

  final int personas;
  final int unidades;
  final int sinStock;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: AppColor.borde),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            personas == 1 ? '1 persona esperando' : '$personas personas esperando',
            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 2),
          Text(
            unidades == 1 ? 'Por 1 unidad en total' : 'Por $unidades unidades en total',
            style: const TextStyle(fontSize: 13, color: AppColor.textoSuave),
          ),
          if (sinStock > 0) ...[
            const SizedBox(height: Gap.md),
            Row(
              children: [
                const Icon(Icons.warning_amber_rounded, size: 16, color: AppColor.alerta),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    // Es el número que hace útil esta pantalla: no "hay
                    // interesados" sino "hay interesados y no tenés qué
                    // venderles".
                    sinStock == 1
                        ? 'En 1 producto no te alcanza el stock'
                        : 'En $sinStock productos no te alcanza el stock',
                    style: const TextStyle(fontSize: 13, color: AppColor.alerta),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _Producto extends StatelessWidget {
  const _Producto({required this.producto});

  final Map<String, dynamic> producto;

  @override
  Widget build(BuildContext context) {
    final variantes = (producto['variantes'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>();
    final personas = (producto['personas'] as num?)?.toInt() ?? 0;
    final publicado = producto['publicado'] as bool? ?? true;

    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: AppColor.borde),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  producto['nombre'] as String? ?? '',
                  style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700),
                ),
              ),
              Text(
                personas == 1 ? '1 persona' : '$personas personas',
                style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
              ),
            ],
          ),

          if (!publicado) ...[
            const SizedBox(height: Gap.sm),
            const Row(
              children: [
                Icon(Icons.visibility_off_outlined, size: 14, color: AppColor.alerta),
                SizedBox(width: 5),
                Expanded(
                  child: Text(
                    // Sin esto, el vendedor no entiende por qué la gente que
                    // espera no recibe el aviso cuando abre.
                    'Está pausado. No se avisa por productos pausados.',
                    style: TextStyle(fontSize: 12, color: AppColor.alerta),
                  ),
                ),
              ],
            ),
          ],

          const SizedBox(height: Gap.md),
          for (final v in variantes) _Variante(variante: v),
        ],
      ),
    );
  }
}

class _Variante extends StatelessWidget {
  const _Variante({required this.variante});

  final Map<String, dynamic> variante;

  @override
  Widget build(BuildContext context) {
    final etiqueta = variante['etiqueta'] as String?;
    final unidades = (variante['unidades'] as num?)?.toInt() ?? 0;
    final disponible = (variante['disponible'] as num?)?.toInt() ?? 0;
    final falta = disponible < unidades;

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          Expanded(
            child: Text(
              // `null` cuando es la variante interna del producto: sin opciones
              // no hay nada que nombrar, y "Default" no le dice nada a nadie.
              etiqueta ?? 'Producto',
              style: const TextStyle(fontSize: 13, color: AppColor.textoSuave),
            ),
          ),
          Text(
            'Piden $unidades',
            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
          ),
          const SizedBox(width: Gap.sm),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
            decoration: BoxDecoration(
              color: falta ? AppColor.alerta.withValues(alpha: 0.15) : AppColor.superficieAlta,
              borderRadius: BorderRadius.circular(Redondeo.sm),
            ),
            child: Text(
              'Tenés $disponible',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: falta ? AppColor.alerta : AppColor.textoSuave,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Vacio extends StatelessWidget {
  const _Vacio({required this.icono, required this.titulo, this.detalle, this.accion});

  final IconData icono;
  final String titulo;
  final String? detalle;
  final Widget? accion;

  @override
  Widget build(BuildContext context) {
    // `ListView` y no `Center`: hace falta poder tirar hacia abajo para
    // refrescar incluso cuando no hay nada que mostrar.
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(horizontal: Gap.xl, vertical: 120),
      children: [
        Icon(icono, size: 44, color: AppColor.textoDebil),
        const SizedBox(height: Gap.lg),
        Text(
          titulo,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
        if (detalle != null) ...[
          const SizedBox(height: Gap.sm),
          Text(
            detalle!,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.45),
          ),
        ],
        if (accion != null) ...[
          const SizedBox(height: Gap.lg),
          Center(child: accion),
        ],
      ],
    );
  }
}
