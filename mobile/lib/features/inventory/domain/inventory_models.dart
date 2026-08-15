/// Modelos de inventario y reservas.
///
/// ─── La app NO decide stock ───
///
/// Nada de acá calcula disponibilidad, vencimientos ni si se puede comprar.
/// Todo eso lo resuelve el backend y viaja ya resuelto. Un cliente que decida
/// stock por su cuenta va a estar equivocado en el momento exacto en que
/// importa: cuando hay dos personas peleando por la última unidad.
library;

int _int(Object? v, [int fallback = 0]) => v is int
    ? v
    : v is num
        ? v.toInt()
        : fallback;

/// Existencias de una variante, como las ve su vendedor.
class StockVariante {
  const StockVariante({
    required this.variantId,
    required this.title,
    required this.onHand,
    required this.reserved,
    required this.available,
    this.inventoryId,
    this.status = 'ACTIVE',
    this.isDefault = false,
    this.lowStockThreshold,
  });

  factory StockVariante.fromJson(Map<String, dynamic> j) => StockVariante(
        variantId: j['variantId'] as String,
        title: j['title'] as String? ?? '',
        onHand: _int(j['onHand']),
        reserved: _int(j['reserved']),
        available: _int(j['available']),
        inventoryId: j['inventoryId'] as String?,
        status: j['status'] as String? ?? 'ACTIVE',
        isDefault: j['isDefault'] as bool? ?? false,
        lowStockThreshold: j['lowStockThreshold'] == null ? null : _int(j['lowStockThreshold']),
      );

  final String variantId;
  final String title;

  /// Unidades físicas. Es lo ÚNICO que el vendedor puede editar.
  final int onHand;

  /// Apartadas por compradores. Sólo lectura: es consecuencia, no un dato.
  final int reserved;

  final int available;
  final String? inventoryId;
  final String status;
  final bool isDefault;
  final int? lowStockThreshold;

  bool get activa => status == 'ACTIVE';
  bool get agotada => available <= 0;
  bool get hayReservas => reserved > 0;
}

/// Stock de todas las variantes de un producto.
class StockProducto {
  const StockProducto({required this.productId, required this.variants});

  factory StockProducto.fromJson(Map<String, dynamic> j) => StockProducto(
        productId: j['productId'] as String,
        variants: (j['variants'] as List<dynamic>? ?? [])
            .map((e) => StockVariante.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  final String productId;
  final List<StockVariante> variants;

  int get totalOnHand => variants.fold(0, (s, v) => s + v.onHand);
  int get totalReservado => variants.fold(0, (s, v) => s + v.reserved);
  int get totalDisponible => variants.fold(0, (s, v) => s + v.available);

  /// Un producto simple: una sola variante, la automática.
  bool get esSimple => variants.length == 1 && variants.first.isDefault;
}

/// Disponibilidad pública, tal como la ve un comprador.
///
/// No trae el stock exacto salvo cuando quedan pocas unidades. Es una decisión
/// del backend, no una limitación: publicar el número le regala a la
/// competencia el ritmo de ventas del vendedor.
class Disponibilidad {
  const Disponibilidad({required this.availability, this.remaining});

  factory Disponibilidad.fromJson(Map<String, dynamic> j) => Disponibilidad(
        availability: j['availability'] as String? ?? 'OUT_OF_STOCK',
        remaining: j['remaining'] == null ? null : _int(j['remaining']),
      );

  final String availability;
  final int? remaining;

  bool get hay => availability != 'OUT_OF_STOCK';
  bool get quedanPocas => availability == 'LOW_STOCK';

  String get etiqueta => switch (availability) {
        'IN_STOCK' => 'Disponible',
        'LOW_STOCK' => remaining == null ? 'Quedan pocas' : 'Últimas $remaining',
        _ => 'Agotado',
      };
}

/// Una reserva de stock.
class Reserva {
  const Reserva({
    required this.reservationId,
    required this.status,
    required this.productVariantId,
    required this.quantity,
    required this.expiresAt,
    required this.remainingSeconds,
    this.reused = false,
  });

  factory Reserva.fromJson(Map<String, dynamic> j) => Reserva(
        reservationId: j['reservationId'] as String,
        status: j['status'] as String? ?? 'ACTIVE',
        productVariantId: j['productVariantId'] as String? ?? '',
        quantity: _int(j['quantity'], 1),
        expiresAt: DateTime.parse(j['expiresAt'] as String),
        // Los segundos que faltan los calcula el SERVIDOR y llegan resueltos.
        // Que los calculara la app implicaría confiar en el reloj del teléfono,
        // que puede estar corrido —o cambiado a mano— y entonces el contador
        // mostraría un tiempo que no existe.
        remainingSeconds: _int(j['remainingSeconds']),
        reused: j['reused'] as bool? ?? false,
      );

  final String reservationId;
  final String status;
  final String productVariantId;
  final int quantity;
  final DateTime expiresAt;
  final int remainingSeconds;

  /// `true` cuando el backend devolvió una reserva que ya existía.
  final bool reused;

  bool get activa => status == 'ACTIVE';

  /// Segundos que faltan, recalculados contra `expiresAt`.
  ///
  /// El contador de la pantalla es DECORACIÓN. La verdad es `expiresAt` del
  /// servidor: si la app dice 00:02 y el backend ya la venció, está vencida.
  /// Por eso al volver del segundo plano se recalcula contra esta fecha en vez
  /// de seguir restando desde donde se había quedado.
  int segundosRestantes() {
    final faltan = expiresAt.difference(DateTime.now()).inSeconds;
    return faltan < 0 ? 0 : faltan;
  }

  /// `04:59`
  static String formatearCuenta(int segundos) {
    final m = (segundos ~/ 60).toString().padLeft(2, '0');
    final s = (segundos % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }
}
