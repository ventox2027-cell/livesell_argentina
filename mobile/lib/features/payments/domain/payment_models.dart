/// Modelos del spike de pagos.
///
/// Regla que gobierna este archivo: **ningún campo de tarjeta**. Ni número, ni
/// código de seguridad, ni titular. Lo único que viaja es el token de un solo
/// uso que devuelve Mercado Pago, y los últimos cuatro dígitos para mostrar.
///
/// Si alguna vez alguien necesita agregar acá un campo con el número de la
/// tarjeta, la respuesta es que el diseño está mal, no el modelo.
library;

enum OrderStatus {
  pendingPayment,
  processing,
  paid,
  failed,
  cancelled,
  refunded,
  unknown;

  static OrderStatus parse(String? raw) => switch (raw) {
        'PENDING_PAYMENT' => OrderStatus.pendingPayment,
        'PROCESSING' => OrderStatus.processing,
        'PAID' => OrderStatus.paid,
        'FAILED' => OrderStatus.failed,
        'CANCELLED' => OrderStatus.cancelled,
        'REFUNDED' => OrderStatus.refunded,
        _ => OrderStatus.unknown,
      };

  /// Texto para la persona que compra. Nunca se le muestra el nombre interno
  /// del estado: "PROCESSING" no le dice nada a nadie.
  String get etiqueta => switch (this) {
        OrderStatus.pendingPayment => 'Esperando el pago',
        OrderStatus.processing => 'Procesando',
        OrderStatus.paid => 'Pagado',
        OrderStatus.failed => 'Rechazado',
        OrderStatus.cancelled => 'Cancelado',
        OrderStatus.refunded => 'Devuelto',
        OrderStatus.unknown => 'Sin definir',
      };
}

class Order {
  const Order({
    required this.id,
    required this.status,
    required this.amountCents,
    required this.description,
    required this.buyerEmail,
  });

  factory Order.fromJson(Map<String, dynamic> json) => Order(
        id: json['id'] as String,
        status: OrderStatus.parse(json['status'] as String?),
        amountCents: (json['amountCents'] as num).toInt(),
        description: json['description'] as String? ?? '',
        buyerEmail: json['buyerEmail'] as String? ?? '',
      );

  final String id;
  final OrderStatus status;
  final int amountCents;
  final String description;
  final String buyerEmail;

  /// Para mostrar y para armar la URL del checkout. El cobro NO usa esto: usa
  /// el monto que el backend tiene en la base.
  double get amount => amountCents / 100;
}

/// Resultado de un intento de cobro.
///
/// Los tres casos existen por separado a propósito. `desconocido` es el que
/// suele olvidarse y el que hace perder plata: si un timeout se tratara como
/// rechazo, la persona pagaría de nuevo y quedaría cobrada dos veces.
enum PayOutcome {
  resuelto,
  rechazado,
  desconocido;

  static PayOutcome parse(String? raw) => switch (raw) {
        'RESOLVED' => PayOutcome.resuelto,
        'REJECTED' => PayOutcome.rechazado,
        _ => PayOutcome.desconocido,
      };
}

class PayResult {
  const PayResult({required this.outcome, required this.order, this.message});

  factory PayResult.fromJson(Map<String, dynamic> json) => PayResult(
        outcome: PayOutcome.parse(json['outcome'] as String?),
        order: Order.fromJson(json['order'] as Map<String, dynamic>),
        message: json['message'] as String?,
      );

  final PayOutcome outcome;
  final Order order;
  final String? message;
}

/// Lo que la página del WebView le manda a la app cuando tokenizó.
///
/// `token` es de un solo uso y sólo sirve para este cobro. No se guarda, no se
/// registra en un log y no se reintenta con él.
class CardToken {
  const CardToken({
    required this.token,
    required this.paymentMethodId,
    required this.installments,
    this.issuerId,
  });

  factory CardToken.fromJson(Map<String, dynamic> json) => CardToken(
        token: json['token'] as String,
        paymentMethodId: json['paymentMethodId'] as String? ?? '',
        installments: (json['installments'] as num?)?.toInt() ?? 1,
        issuerId: json['issuerId']?.toString(),
      );

  final String token;
  final String paymentMethodId;
  final int installments;
  final String? issuerId;

  /// `toString` explícito para que un `print` accidental no vuelque el token.
  @override
  String toString() => 'CardToken($paymentMethodId, $installments cuotas)';
}

class SavedCard {
  const SavedCard({required this.id, required this.lastFour, this.brand});

  factory SavedCard.fromJson(Map<String, dynamic> json) => SavedCard(
        id: json['mpCardId'] as String,
        lastFour: json['lastFour'] as String? ?? '????',
        brand: json['brand'] as String?,
      );

  final String id;
  final String lastFour;
  final String? brand;
}
