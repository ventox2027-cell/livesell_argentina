import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/state/auth_providers.dart';

/// Guardados y vistos recientemente.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// DOS LISTAS QUE PARECEN LA MISMA Y NO LO SON
/// ═══════════════════════════════════════════════════════════════════════════
///
/// **Guardados** la arma la persona a propósito. **Vistos recientemente** la
/// arma el sistema mirando.
///
/// La diferencia que importa no es de interfaz: sobre un guardado se puede
/// avisar —«volvió al stock» es un favor— y sobre un visto no. El mismo aviso
/// sobre algo que alguien apenas miró es perseguirlo por la app, y es lo que
/// hace que la gente apague las notificaciones para siempre.
///
/// ⚠️ Guardados **no es un sistema nuevo**: es el mismo corazón de siempre
/// (`POST /products/:id/like`). Lo único distinto es el nombre en la interfaz —
/// «Guardados» dice qué se puede hacer con la lista, «Me gusta» no dice nada.

class ProductoGuardado {
  const ProductoGuardado({
    required this.id,
    required this.nombre,
    required this.precioCentavos,
    required this.hayStock,
    this.portada,
    this.tiendaNombre,
  });

  factory ProductoGuardado.fromJson(Map<String, dynamic> j) => ProductoGuardado(
        id: j['id'] as String,
        nombre: j['nombre'] as String? ?? '',
        precioCentavos: (j['precioCentavos'] as num?)?.toInt() ?? 0,
        // Por omisión `true`: un producto que no sabemos si tiene stock no se
        // muestra como agotado. Decirle a alguien que algo no está cuando sí
        // está es peor que al revés.
        hayStock: j['hayStock'] as bool? ?? true,
        portada: j['portada'] as String?,
        tiendaNombre: (j['tienda'] as Map<String, dynamic>?)?['name'] as String? ??
            (j['tienda'] as Map<String, dynamic>?)?['nombre'] as String?,
      );

  final String id;
  final String nombre;
  final int precioCentavos;

  /// Stock REAL del inventario. Es lo que hace útil la lista: sin esto,
  /// «guardados» es una lista de nombres.
  final bool hayStock;

  final String? portada;
  final String? tiendaNombre;
}

class GuardadosApi {
  const GuardadosApi(this._ref);
  final Ref _ref;

  Future<List<ProductoGuardado>> guardados() async {
    final r = await _ref.read(apiClientProvider).get<Map<String, dynamic>>('/me/saved');
    final items = r.data?['items'] as List<dynamic>? ?? const [];
    return items
        .map((e) => ProductoGuardado.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  Future<List<ProductoGuardado>> vistosRecientes() async {
    final r =
        await _ref.read(apiClientProvider).get<Map<String, dynamic>>('/me/recently-viewed');
    final items = r.data?['items'] as List<dynamic>? ?? const [];
    return items
        .map((e) => ProductoGuardado.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  /// Avisa que la persona abrió un producto.
  ///
  /// ⚠️ No se espera y no se maneja el error, a propósito.
  ///
  /// Registrar la visita es una comodidad, no parte de abrir el producto. Si
  /// fallara —sin red, servidor caído, lo que sea— la pantalla tiene que
  /// abrirse igual. Y esperar la respuesta le sumaría un viaje de red a la
  /// acción más frecuente de toda la app.
  void marcarVisto(String productId) {
    _ref.read(apiClientProvider).post<void>('/products/$productId/viewed').ignore();
  }

  Future<void> borrarVistos() async {
    await _ref.read(apiClientProvider).delete<void>('/me/recently-viewed');
  }
}

final guardadosApiProvider = Provider<GuardadosApi>(GuardadosApi.new);

/// Lo guardado. Se invalida al tocar un corazón.
final guardadosProvider = FutureProvider<List<ProductoGuardado>>(
  (ref) => ref.watch(guardadosApiProvider).guardados(),
);

final vistosRecientesProvider = FutureProvider<List<ProductoGuardado>>(
  (ref) => ref.watch(guardadosApiProvider).vistosRecientes(),
);
