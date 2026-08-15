import 'package:dio/dio.dart';

import '../../../core/config/runtime_config.dart';
import '../domain/payment_models.dart';

/// Cliente HTTP del spike de pagos.
///
/// La app **nunca** habla con Mercado Pago para cobrar. Sólo el backend tiene
/// el access token, y sólo el backend sabe cuánto vale una orden. Desde acá se
/// manda un token de tarjeta y se recibe un estado; nada más.
class PaymentsApi {
  PaymentsApi({Dio? dio})
      : _dio = dio ??
            Dio(
              BaseOptions(
                baseUrl: '${RuntimeConfig.instance.apiBaseUrl}/api/v1',
                connectTimeout: const Duration(seconds: 10),
                // Más largo que el resto de la app: un cobro pasa por Mercado
                // Pago y puede tardar. Cortar antes de tiempo genera
                // exactamente la incertidumbre que queremos evitar.
                receiveTimeout: const Duration(seconds: 30),
                headers: {
                  'content-type': 'application/json',
                  'x-spike-key': RuntimeConfig.instance.spikeApiKey,
                },
              ),
            );

  final Dio _dio;

  void applyConfig() {
    _dio.options.baseUrl = '${RuntimeConfig.instance.apiBaseUrl}/api/v1';
    _dio.options.headers['x-spike-key'] = RuntimeConfig.instance.spikeApiKey;
  }

  /// URL de la página de tokenización, para abrir en el WebView.
  ///
  /// El monto va en la URL sólo para mostrarse. Si alguien la edita, ve otro
  /// número y se le cobra el mismo: el backend usa el monto de la base.
  Uri checkoutUrl(Order order) =>
      Uri.parse('${RuntimeConfig.instance.apiBaseUrl}/checkout').replace(
        queryParameters: {
          'orderId': order.id,
          'amount': order.amount.toStringAsFixed(2),
          'email': order.buyerEmail,
          'desc': order.description,
        },
      );

  Future<Map<String, dynamic>> config() async {
    final res = await _dio.get<Map<String, dynamic>>('/payments/config');
    return res.data!;
  }

  /// Crea una orden.
  ///
  /// `idempotencyKey` la genera quien llama y **se repite** si hay que
  /// reintentar. Es lo que impide que dos toques del botón creen dos órdenes.
  Future<Order> createOrder({
    required String idempotencyKey,
    required String buyerEmail,
    required String description,
    required int amountCents,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/payments/orders',
      data: {
        'idempotencyKey': idempotencyKey,
        'buyerEmail': buyerEmail,
        'description': description,
        'amountCents': amountCents,
      },
    );
    return Order.fromJson(res.data!['order'] as Map<String, dynamic>);
  }

  Future<Order> getOrder(String orderId) async {
    final res = await _dio.get<Map<String, dynamic>>('/payments/orders/$orderId');
    return Order.fromJson(res.data!);
  }

  /// Ejecuta el cobro con el token que devolvió el WebView.
  Future<PayResult> pay({
    required String orderId,
    required CardToken card,
    bool saveCard = false,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/payments/orders/$orderId/pay',
      data: {
        'token': card.token,
        'paymentMethodId': card.paymentMethodId,
        'installments': card.installments,
        if (card.issuerId != null) 'issuerId': card.issuerId,
        'saveCard': saveCard,
      },
    );
    return PayResult.fromJson(res.data!);
  }

  Future<List<SavedCard>> savedCards(String email) async {
    final res = await _dio.get<List<dynamic>>(
      '/payments/cards',
      queryParameters: {'email': email},
    );
    return (res.data ?? []).map((e) => SavedCard.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// Dispara la conciliación a mano.
  ///
  /// En producción es un trabajo periódico. Acá es un botón, para poder
  /// demostrar en la prueba de campo que una orden con el webhook perdido se
  /// resuelve igual — que es uno de los criterios PASS/FAIL del sprint.
  Future<Map<String, dynamic>> reconcile() async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/payments/reconcile',
      data: {'olderThanMs': 0},
    );
    return res.data!;
  }
}
