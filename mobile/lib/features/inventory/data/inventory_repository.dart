import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../auth/state/auth_providers.dart';
import '../domain/inventory_models.dart';
import '../domain/stock_optimista.dart';
import 'ajustes_en_vuelo.dart';

/// Cliente de inventario y reservas.
class InventoryRepository {
  InventoryRepository(this._api);
  final ApiClient _api;

  // ─── Vendedor ─────────────────────────────────────────────────────────────

  Future<StockProducto> stockDeProducto(String productId) async {
    final res = await _api.get<Map<String, dynamic>>('/products/$productId/inventory');
    if (res.statusCode != 200 || res.data == null) throw _error(res);
    return StockProducto.fromJson(res.data!);
  }

  /// Fija el stock físico de una variante.
  ///
  /// Nunca manda `reserved`: el backend lo ignoraría, y tener el campo acá
  /// haría creer que sirve para algo.
  Future<StockVariante> fijarStock({
    required String productId,
    required String variantId,
    required int onHand,
    String? motivo,
  }) async {
    final res = await _api.patch<Map<String, dynamic>>(
      '/products/$productId/variants/$variantId/inventory',
      data: {'onHand': onHand, if (motivo != null && motivo.isNotEmpty) 'motivo': motivo},
    );
    if (res.statusCode != 200 || res.data == null) throw _error(res);
    return StockVariante.fromJson({
      ...res.data!,
      'variantId': variantId,
      'title': '',
    });
  }

  /// Suma o resta unidades. `+10` porque entró mercadería, `-2` por rotura.
  Future<StockVariante> ajustarStock({
    required String productId,
    required String variantId,
    required int delta,
    String? motivo,
  }) async {
    final res = await _api.patch<Map<String, dynamic>>(
      '/products/$productId/variants/$variantId/inventory',
      data: {'adjust': delta, if (motivo != null && motivo.isNotEmpty) 'motivo': motivo},
    );
    if (res.statusCode != 200 || res.data == null) throw _error(res);
    return StockVariante.fromJson({
      ...res.data!,
      'variantId': variantId,
      'title': '',
    });
  }

  // ─── Comprador ────────────────────────────────────────────────────────────

  Future<Disponibilidad> disponibilidad(String variantId) async {
    final res = await _api.get<Map<String, dynamic>>(
      '/variants/$variantId/availability',
      sinAuth: true,
    );
    if (res.statusCode != 200 || res.data == null) throw _error(res);
    return Disponibilidad.fromJson(res.data!);
  }

  /// Aparta stock.
  ///
  /// ─── La clave de idempotencia la elige QUIEN LLAMA, no este método ───
  ///
  /// Es la parte que hace que funcione. El caso real: la persona toca
  /// "Comprar" en el subte, la petición llega, el backend aparta la unidad y
  /// la respuesta se pierde. La app cree que falló y reintenta.
  ///
  /// Si la clave se generara acá adentro, cada reintento traería una clave
  /// nueva y el backend lo leería como una compra distinta. Generándola una
  /// vez en la pantalla —y reusándola en todos los reintentos de ESE intento—
  /// el backend reconoce el reintento y devuelve la reserva que ya hizo.
  ///
  /// Por eso es un parámetro obligatorio y no un valor por defecto: obliga a
  /// decidir dónde nace, que es el punto del asunto.
  Future<Reserva> reservar({
    required String productVariantId,
    required String idempotencyKey,
    int quantity = 1,
  }) async {
    final res = await _api.raw.post<Map<String, dynamic>>(
      '/inventory/reservations',
      data: {'productVariantId': productVariantId, 'quantity': quantity},
      options: Options(headers: {'idempotency-key': idempotencyKey}),
    );
    if (res.statusCode != 201 && res.statusCode != 200) throw _error(res);
    return Reserva.fromJson(res.data!);
  }

  Future<List<Reserva>> misReservas() async {
    final res = await _api.get<List<dynamic>>('/inventory/reservations/mine');
    if (res.statusCode != 200) throw _error(res);
    return (res.data ?? []).map((e) => Reserva.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<void> cancelar(String reservationId) async {
    final res = await _api.delete<Map<String, dynamic>>(
      '/inventory/reservations/$reservationId',
    );
    if (res.statusCode != 200) throw _error(res);
  }

  /// Mensaje del backend, siempre. Es el único lugar donde están traducidos.
  InventarioException _error(Response<dynamic> res) {
    final d = res.data;
    if (d is Map && d['error'] is Map) {
      final error = d['error'] as Map;
      final codigo = error['code'] as String?;
      final msg = error['message'];

      final detalles = error['details'];
      if (detalles is List && detalles.isNotEmpty) {
        final primero = detalles.first;
        if (primero is Map && primero['message'] is String) {
          return InventarioException(primero['message'] as String, codigo: codigo);
        }
      }
      if (msg is String && msg.isNotEmpty) {
        return InventarioException(msg, codigo: codigo);
      }
    }
    return InventarioException('No se pudo completar la operación.');
  }
}

class InventarioException implements Exception {
  InventarioException(this.mensaje, {this.codigo});
  final String mensaje;
  final String? codigo;

  /// Se agotó mientras la persona miraba. No es un error de la app.
  bool get sinStock => codigo == 'OUT_OF_STOCK';

  @override
  String toString() => mensaje;
}

final inventoryRepositoryProvider = Provider<InventoryRepository>(
  (ref) => InventoryRepository(ref.watch(apiClientProvider)),
);

/// Stock de un producto del vendedor.
final stockDeProductoProvider =
    FutureProvider.family<StockProducto, String>((ref, productId) async {
  return ref.watch(inventoryRepositoryProvider).stockDeProducto(productId);
});

/// Disponibilidad pública de una variante, para el feed.
final disponibilidadProvider =
    FutureProvider.family<Disponibilidad, String>((ref, variantId) async {
  return ref.watch(inventoryRepositoryProvider).disponibilidad(variantId);
});

/// El stock TAL COMO SE VE, con los toques que todavía no llegaron al servidor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// DOS PANTALLAS MOSTRABAN NÚMEROS DISTINTOS DEL MISMO PRODUCTO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Medido en un teléfono: sumar unidades adentro de Stock funcionaba, pero al
/// volver atrás el resumen del editor seguía con el número viejo entre dos y
/// cinco segundos.
///
/// La causa no era la red: era que había dos fuentes. `StockScreen` armaba el
/// `StockOptimista` —servidor + toques pendientes— y `_AccesoStock` leía
/// `stockDeProductoProvider` pelado. Al volver, el editor invalidaba y pedía de
/// nuevo... y el servidor devolvía el número VIEJO, porque el ajuste todavía
/// estaba esperando los 450 ms del rebote antes de salir.
///
/// O sea: un viaje de red entero para traer un dato desactualizado, y después
/// otro cuando el ajuste por fin llegaba.
///
/// Acá se arma una sola vez y las dos pantallas leen de acá. La coherencia deja
/// de depender de que alguien se acuerde de mezclar lo mismo en los dos lados.
///
/// ⚠️ NO cuesta ninguna petición: es la respuesta que ya está en caché más un
/// mapa en memoria.
final stockVisibleProvider =
    Provider.family<AsyncValue<StockOptimista>, String>((ref, productId) {
  final delServidor = ref.watch(stockDeProductoProvider(productId));
  final enVuelo = ref.watch(ajustesEnVueloProvider);
  final notifier = ref.read(ajustesEnVueloProvider.notifier);

  return delServidor.whenData((s) {
    // Las claves del servicio llevan el productId adelante; acá sólo interesan
    // las de este producto.
    final ajustes = {
      for (final v in s.variants)
        if (enVuelo[claveDe(productId, v.variantId)] != null)
          v.variantId: enVuelo[claveDe(productId, v.variantId)]!,
    };

    return StockOptimista(delServidor: s, ajustes: ajustes).conDatosDelServidor(
      s,
      (variantId) => notifier.sigueEnCurso(productId, variantId),
    );
  });
});
