import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../auth/state/auth_providers.dart';
import '../domain/order_models.dart';

/// Cliente de pedidos, pagos y direcciones.
class OrdersRepository {
  OrdersRepository(this._api);
  final ApiClient _api;

  // ─── Direcciones ──────────────────────────────────────────────────────────

  Future<List<Direccion>> direcciones() async {
    final res = await _api.get<List<dynamic>>('/addresses');
    if (res.statusCode != 200) throw _error(res);
    return (res.data ?? []).map((e) => Direccion.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<Direccion> guardarDireccion(Map<String, dynamic> datos, {String? id}) async {
    final res = id == null
        ? await _api.post<Map<String, dynamic>>('/addresses', data: datos)
        : await _api.patch<Map<String, dynamic>>('/addresses/$id', data: datos);
    if (res.statusCode != 201 && res.statusCode != 200) throw _error(res);
    return Direccion.fromJson(res.data!);
  }

  // ─── Pedidos ──────────────────────────────────────────────────────────────

  /// Convierte una reserva en pedido.
  ///
  /// La clave de idempotencia la elige quien llama, por el mismo motivo que en
  /// la reserva: un reintento por red tiene que reusar la misma o el backend
  /// lo lee como un pedido distinto.
  Future<Pedido> crearPedido({
    required String reservationId,
    required String idempotencyKey,
    String? addressId,
    bool retiraEnPersona = false,
    String? liveSessionId,
  }) async {
    final res = await _api.raw.post<Map<String, dynamic>>(
      '/orders',
      data: {
        'reservationId': reservationId,
        if (addressId != null) 'addressId': addressId,
        /// Desde qué vivo se está comprando.
        ///
        /// ⚠️ Se manda el **id del vivo**, nunca el precio. El backend busca el
        /// descuento en su propia base y valida que el vivo sea del mismo
        /// vendedor y esté al aire. Si el cuerpo pudiera decir cuánto sale
        /// algo, cualquiera compraría a un peso.
        if (liveSessionId != null) 'liveSessionId': liveSessionId,
        // Lo único del envío que aporta quien compra. El backend sólo lo
        // respeta si la tienda ofrece retiro: mandarlo en una tienda que no lo
        // ofrece NO evita el costo.
        if (retiraEnPersona) 'retiraEnPersona': true,
      },
      options: Options(headers: {'idempotency-key': idempotencyKey}),
    );
    if (res.statusCode != 201 && res.statusCode != 200) throw _error(res);
    return Pedido.fromJson(res.data!);
  }

  /// Aplica un cupón a un pedido que todavía no se pagó.
  ///
  /// ⚠️ Manda el **código**, nunca el descuento. Cuánto descuenta lo resuelve
  /// el backend contra la base del vendedor de esta compra.
  Future<Pedido> aplicarCupon(String orderId, String codigo) async {
    final res = await _api.raw.post<Map<String, dynamic>>(
      '/orders/$orderId/coupon',
      data: {'codigo': codigo},
    );
    if (res.statusCode != 201 && res.statusCode != 200) throw _error(res);
    return Pedido.fromJson(res.data!);
  }

  Future<Pedido> quitarCupon(String orderId) async {
    final res = await _api.delete<Map<String, dynamic>>('/orders/$orderId/coupon');
    if (res.statusCode != 200) throw _error(res);
    return Pedido.fromJson(res.data!);
  }

  Future<Pedido> pedido(String id) async {
    final res = await _api.get<Map<String, dynamic>>('/orders/$id');
    if (res.statusCode != 200 || res.data == null) throw _error(res);
    return Pedido.fromJson(res.data!);
  }

  Future<({List<Pedido> items, String? nextCursor})> misPedidos({String? cursor}) async {
    final res = await _api.get<Map<String, dynamic>>('/orders', query: {
      'limit': 20,
      if (cursor != null) 'cursor': cursor,
    });
    if (res.statusCode != 200 || res.data == null) throw _error(res);
    return (
      items: (res.data!['items'] as List<dynamic>)
          .map((e) => Pedido.fromJson(e as Map<String, dynamic>))
          .toList(),
      nextCursor: res.data!['nextCursor'] as String?,
    );
  }

  Future<void> cancelar(String orderId) async {
    final res = await _api.delete<Map<String, dynamic>>('/orders/$orderId');
    if (res.statusCode != 200) throw _error(res);
  }

  // ─── Cobro ────────────────────────────────────────────────────────────────

  /// Manda el token de tarjeta al backend para que cobre.
  ///
  /// ─── Lo que NO viaja acá ───
  ///
  /// El número de tarjeta. `cardToken` es un identificador de un solo uso que
  /// generó el CardForm de Mercado Pago dentro de un iframe suyo. El PAN nunca
  /// pasa por Dart, y eso es lo que mantiene el alcance PCI en SAQ-A.
  ///
  /// Tampoco viaja el monto: lo pone el backend desde la orden. Si la app lo
  /// mandara, sería un endpoint donde alguien compra por un peso.
  Future<ResultadoDeCobro> cobrar({
    required String orderId,
    required String cardToken,
    required String paymentMethodId,
    int installments = 1,
  }) async {
    final res = await _api.post<Map<String, dynamic>>(
      '/orders/$orderId/payment-attempts',
      data: {
        'cardToken': cardToken,
        'installments': installments,
        'paymentMethodId': paymentMethodId,
      },
    );

    // 202 = no sabemos todavía. NO es un fallo, y la app no puede tratarlo
    // como tal: el cobro pudo haberse procesado.
    if (res.statusCode == 202) {
      return const ResultadoDeCobro.incierto();
    }
    if (res.statusCode == 201 || res.statusCode == 200) {
      final d = res.data!;
      return ResultadoDeCobro.aprobado(
        attemptId: d['attemptId'] as String,
        orderStatus: d['orderStatus'] as String? ?? 'PAID',
      );
    }
    if (res.statusCode == 402) {
      throw _error(res);
    }
    throw _error(res);
  }

  Future<String> clavePublica() async {
    final res = await _api.get<Map<String, dynamic>>('/checkout/config');
    if (res.statusCode != 200 || res.data == null) throw _error(res);
    return res.data!['publicKey'] as String? ?? '';
  }

  // ─── Vendedor ─────────────────────────────────────────────────────────────

  Future<({List<Venta> items, String? nextCursor})> misVentas({String? cursor}) async {
    final res = await _api.get<Map<String, dynamic>>('/seller/orders', query: {
      'limit': 20,
      if (cursor != null) 'cursor': cursor,
    });
    if (res.statusCode != 200 || res.data == null) throw _error(res);
    return (
      items: (res.data!['items'] as List<dynamic>)
          .map((e) => Venta.fromJson(e as Map<String, dynamic>))
          .toList(),
      nextCursor: res.data!['nextCursor'] as String?,
    );
  }

  /// Confirma la entrega con el codigo que tiene quien compro.
  ///
  /// Es el UNICO camino a DELIVERED: avanzarVenta no lo acepta. "Entregado"
  /// es una afirmacion sobre el mundo fisico y no puede hacerla solo quien
  /// tiene interes en que sea cierta.
  /// Califica una compra.
  ///
  /// El backend valida que sea una compra propia y concretada, y que no haya
  /// otra resena de esa misma orden: un indice unico sobre orderId lo
  /// garantiza, asi que dos toques seguidos no crean dos.
  Future<void> resenar(
    String orderId, {
    required int rating,
    String comentario = "",
  }) async {
    final res = await _api.post<Map<String, dynamic>>(
      "/orders/$orderId/review",
      data: {
        "rating": rating,
        if (comentario.isNotEmpty) "comment": comentario,
      },
    );
    if (res.statusCode != 201 && res.statusCode != 200) throw _error(res);
  }

  Future<void> confirmarEntrega(String orderId, String codigo) async {
    final res = await _api.post<Map<String, dynamic>>(
      "/seller/orders/$orderId/delivery-confirmation",
      data: {"code": codigo},
    );
    if (res.statusCode != 201 && res.statusCode != 200) throw _error(res);
  }

  Future<void> avanzarVenta(String orderId, String status) async {
    final res = await _api.patch<Map<String, dynamic>>(
      '/seller/orders/$orderId/fulfillment',
      data: {'status': status},
    );
    if (res.statusCode != 200) throw _error(res);
  }

  PedidoException _error(Response<dynamic> res) {
    final d = res.data;
    if (d is Map && d['error'] is Map) {
      final error = d['error'] as Map;
      final codigo = error['code'] as String?;

      final detalles = error['details'];
      if (detalles is List && detalles.isNotEmpty) {
        final primero = detalles.first;
        if (primero is Map && primero['message'] is String) {
          return PedidoException(primero['message'] as String, codigo: codigo);
        }
      }
      final msg = error['message'];
      if (msg is String && msg.isNotEmpty) return PedidoException(msg, codigo: codigo);
    }
    return PedidoException('No se pudo completar la operación.');
  }
}

/// El desenlace de un cobro, con los TRES casos.
sealed class ResultadoDeCobro {
  const ResultadoDeCobro();

  const factory ResultadoDeCobro.aprobado({
    required String attemptId,
    required String orderStatus,
  }) = CobroAprobado;

  /// No sabemos. **No es un fallo.**
  const factory ResultadoDeCobro.incierto() = CobroIncierto;
}

class CobroAprobado extends ResultadoDeCobro {
  const CobroAprobado({required this.attemptId, required this.orderStatus});
  final String attemptId;
  final String orderStatus;
}

class CobroIncierto extends ResultadoDeCobro {
  const CobroIncierto();
}

class PedidoException implements Exception {
  PedidoException(this.mensaje, {this.codigo});
  final String mensaje;
  final String? codigo;

  bool get faltaDireccion => codigo == 'ADDRESS_REQUIRED';
  bool get reservaVencida => codigo == 'RESERVATION_EXPIRED';

  /// VendoX es 18+ y todavía no declaró su fecha de nacimiento.
  ///
  /// Se resuelve ahí mismo, con la hoja. Es el mismo criterio que
  /// `faltaDireccion`: un requisito que la persona puede completar sin salir de
  /// la compra.
  bool get faltaFechaDeNacimiento => codigo == 'BIRTH_DATE_REQUIRED';

  /// Declaró ser menor de 18.
  ///
  /// ⚠️ Esto NO se resuelve completando nada. La app tiene que explicar y
  /// cerrar, no volver a abrir el formulario.
  bool get esMenorDeEdad => codigo == 'UNDERAGE';

  /// Este vendedor no puede recibir pagos ahora. Quien compra no hizo nada mal.
  bool get vendedorSinCobros => codigo == 'MP_ACCOUNT_REQUIRED';
  bool get rechazado => codigo == 'PAYMENT_REJECTED';
  bool get yaHayUnPagoEnCurso => codigo == 'PAYMENT_IN_FLIGHT';

  @override
  String toString() => mensaje;
}

/// Genera una clave de idempotencia nueva.
///
/// Se llama UNA vez por intento y se reusa en todos los reintentos de ese
/// intento. Generar una por llamada anularía el mecanismo.
String nuevaClaveDeIdempotencia(String prefijo) {
  final azar = Random();
  final sufijo = List.generate(16, (_) => azar.nextInt(16).toRadixString(16)).join();
  return '$prefijo-${DateTime.now().microsecondsSinceEpoch}-$sufijo';
}

final ordersRepositoryProvider = Provider<OrdersRepository>(
  (ref) => OrdersRepository(ref.watch(apiClientProvider)),
);

final misPedidosProvider = FutureProvider<({List<Pedido> items, String? nextCursor})>((ref) async {
  ref.watch(sesionProvider);
  return ref.watch(ordersRepositoryProvider).misPedidos();
});

final misVentasProvider = FutureProvider<({List<Venta> items, String? nextCursor})>((ref) async {
  ref.watch(sesionProvider);
  return ref.watch(ordersRepositoryProvider).misVentas();
});

final misDireccionesProvider = FutureProvider<List<Direccion>>((ref) async {
  ref.watch(sesionProvider);
  return ref.watch(ordersRepositoryProvider).direcciones();
});

final pedidoProvider = FutureProvider.family<Pedido, String>((ref, id) async {
  return ref.watch(ordersRepositoryProvider).pedido(id);
});
