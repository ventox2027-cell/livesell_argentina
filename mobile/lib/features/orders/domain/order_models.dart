/// Modelos de pedidos y pagos.
///
/// ─── La app no calcula plata ───
///
/// Ningún total, comisión ni neto se calcula acá. Todo llega resuelto del
/// backend. Si la app hiciera su propia cuenta, algún día mostraría un número
/// y se cobraría otro — y el que se cobra siempre gana.
library;

import '../../seller/domain/seller_models.dart';

int _int(Object? v, [int fallback = 0]) =>
    v is int ? v : v is num ? v.toInt() : fallback;

/// Una línea del pedido, con todo copiado al momento de comprar.
class LineaDePedido {
  const LineaDePedido({
    required this.nombre,
    required this.variante,
    required this.cantidad,
    required this.precioUnitario,
    this.imagenUrl,
    this.sku,
  });

  factory LineaDePedido.fromJson(Map<String, dynamic> j) => LineaDePedido(
        nombre: j['productNameSnapshot'] as String? ?? '',
        variante: j['variantLabelSnapshot'] as String? ?? '',
        cantidad: _int(j['quantity'], 1),
        precioUnitario: _int(j['unitPrice']),
        imagenUrl: j['imageUrlSnapshot'] as String?,
        sku: j['skuSnapshot'] as String?,
      );

  final String nombre;
  final String variante;
  final int cantidad;
  final int precioUnitario;
  final String? imagenUrl;
  final String? sku;

  /// `true` cuando el producto no tenía opciones: mostrar "Default" no aporta.
  bool get varianteRelevante => variante.isNotEmpty && variante != 'Default';
}

/// Dirección de entrega, tal como quedó guardada en el pedido.
class DireccionEntrega {
  const DireccionEntrega({
    required this.destinatario,
    required this.calle,
    required this.numero,
    required this.ciudad,
    required this.provincia,
    required this.codigoPostal,
    this.piso,
    this.departamento,
    this.referencias,
    this.telefono,
  });

  factory DireccionEntrega.fromJson(Map<String, dynamic> j) => DireccionEntrega(
        destinatario: j['recipientFullName'] as String? ?? '',
        calle: j['street'] as String? ?? '',
        numero: j['number'] as String? ?? '',
        ciudad: j['city'] as String? ?? '',
        provincia: j['province'] as String? ?? '',
        codigoPostal: j['postalCode'] as String? ?? '',
        piso: j['floor'] as String?,
        departamento: j['apartment'] as String?,
        referencias: j['references'] as String?,
        telefono: j['phoneE164'] as String?,
      );

  final String destinatario;
  final String calle;
  final String numero;
  final String ciudad;
  final String provincia;
  final String codigoPostal;
  final String? piso;
  final String? departamento;
  final String? referencias;
  final String? telefono;

  /// "Av. Corrientes 1234, 3° B — CABA, Buenos Aires (C1043)"
  String get resumen {
    final unidad = [
      if (piso != null && piso!.isNotEmpty) '$piso°',
      if (departamento != null && departamento!.isNotEmpty) departamento,
    ].join(' ');

    return [
      '$calle $numero',
      if (unidad.isNotEmpty) unidad,
      '$ciudad, $provincia ($codigoPostal)',
    ].join(' — ');
  }
}

/// Un intento de cobro.
class IntentoDePago {
  const IntentoDePago({
    required this.id,
    required this.status,
    this.marca,
    this.ultimosCuatro,
    this.mensaje,
    this.fecha,
  });

  factory IntentoDePago.fromJson(Map<String, dynamic> j) => IntentoDePago(
        id: j['id'] as String,
        status: j['status'] as String? ?? 'CREATED',
        marca: j['brand'] as String?,
        ultimosCuatro: j['lastFour'] as String?,
        mensaje: j['failureMessageSafe'] as String?,
        fecha: j['createdAt'] == null ? null : DateTime.tryParse(j['createdAt'] as String),
      );

  final String id;
  final String status;
  final String? marca;
  final String? ultimosCuatro;
  final String? mensaje;
  final DateTime? fecha;

  bool get aprobado => status == 'APPROVED';
  bool get rechazado => status == 'REJECTED';

  /// El cobro se mandó y no sabemos cómo terminó.
  ///
  /// **No es un fallo.** La app nunca debe decir "el pago falló" ante esto:
  /// puede haberse procesado, y hacer pagar de nuevo cobraría dos veces.
  bool get incierto =>
      status == 'PROCESSING' ||
      status == 'CREATED' ||
      status == 'UNKNOWN_PENDING_RECONCILIATION';

  /// `visa •••• 3704`
  String? get tarjeta {
    if (ultimosCuatro == null) return null;
    return '${marca ?? "tarjeta"} •••• $ultimosCuatro';
  }
}

/// Un pedido.
class Pedido {
  const Pedido({
    required this.id,
    required this.referencia,
    required this.status,
    required this.grossAmount,
    required this.fecha,
    this.itemsSubtotal = 0,
    this.shippingAmount = 0,
    this.platformFeeAmount = 0,
    this.sellerNetAmount = 0,
    this.lineas = const [],
    this.intentos = const [],
    this.direccion,
    this.tienda,
    this.motivo,
    this.pagadoEl,
    this.confirmadoEl,
  });

  factory Pedido.fromJson(Map<String, dynamic> j) {
    final store = j['store'] as Map<String, dynamic>?;
    final direccion = j['shippingAddress'] as Map<String, dynamic>?;

    return Pedido(
      id: j['id'] as String,
      referencia: j['reference'] as String? ?? '',
      status: j['status'] as String? ?? 'PENDING_PAYMENT',
      grossAmount: _int(j['grossAmount']),
      fecha: DateTime.tryParse(j['createdAt'] as String? ?? '') ?? DateTime.now(),
      itemsSubtotal: _int(j['itemsSubtotal']),
      shippingAmount: _int(j['shippingAmount']),
      platformFeeAmount: _int(j['platformFeeAmount']),
      sellerNetAmount: _int(j['sellerNetAmount']),
      lineas: (j['items'] as List<dynamic>? ?? [])
          .map((e) => LineaDePedido.fromJson(e as Map<String, dynamic>))
          .toList(),
      intentos: (j['attempts'] as List<dynamic>? ?? [])
          .map((e) => IntentoDePago.fromJson(e as Map<String, dynamic>))
          .toList(),
      direccion: direccion == null ? null : DireccionEntrega.fromJson(direccion),
      tienda: store?['name'] as String?,
      motivo: j['statusReason'] as String?,
      pagadoEl: DateTime.tryParse(j['paidAt'] as String? ?? ''),
      confirmadoEl: DateTime.tryParse(j['confirmedAt'] as String? ?? ''),
    );
  }

  final String id;
  final String referencia;
  final String status;
  final int grossAmount;
  final DateTime fecha;
  final int itemsSubtotal;
  final int shippingAmount;
  final int platformFeeAmount;
  final int sellerNetAmount;
  final List<LineaDePedido> lineas;
  final List<IntentoDePago> intentos;
  final DireccionEntrega? direccion;
  final String? tienda;

  /// Por qué está como está. Lo escribe el backend, ya en castellano.
  final String? motivo;
  final DateTime? pagadoEl;
  final DateTime? confirmadoEl;

  String get total => formatearPesos(grossAmount);
  bool get sePuedePagar => status == 'PENDING_PAYMENT' || status == 'PAYMENT_FAILED';
  bool get sePuedeCancelar => sePuedePagar;
  bool get terminado =>
      status == 'DELIVERED' || status == 'CANCELLED' || status == 'EXPIRED' || status == 'REFUNDED';

  /// Un cobro en vuelo del que no se sabe el resultado.
  ///
  /// La app NO puede ofrecer pagar de nuevo en este estado.
  bool get verificandose => status == 'PROCESSING_PAYMENT';

  /// Lo que se le dice a la persona.
  ///
  /// ─── Ningún código técnico llega a la pantalla ───
  ///
  /// Nadie entiende `cc_rejected_other_reason` ni `PAYMENT_REQUIRES_REFUND`.
  /// Y el caso del pago acreditado sin stock se explica completo: esconderlo
  /// detrás de "hubo un problema" hace que la persona crea que le robamos.
  EstadoDePedido get estado => switch (status) {
        'PENDING_PAYMENT' => const EstadoDePedido(
            'Falta pagar',
            'Todavía no completaste el pago.',
            TonoDeEstado.pendiente,
          ),
        'PROCESSING_PAYMENT' => const EstadoDePedido(
            'Verificando tu pago',
            'Estamos confirmando la operación con el banco. No hace falta que hagas nada.',
            TonoDeEstado.enCurso,
          ),
        'PAID' => const EstadoDePedido(
            'Pago acreditado',
            'Estamos confirmando tu compra.',
            TonoDeEstado.enCurso,
          ),
        'CONFIRMED' => const EstadoDePedido(
            '¡Compra confirmada!',
            'El vendedor ya la está preparando.',
            TonoDeEstado.exito,
          ),
        'PREPARING' => const EstadoDePedido(
            'Preparando tu pedido',
            'El vendedor lo está empaquetando.',
            TonoDeEstado.exito,
          ),
        'READY_TO_SHIP' => const EstadoDePedido(
            'Listo para despachar',
            'Ya está empaquetado y sale pronto.',
            TonoDeEstado.exito,
          ),
        'SHIPPED' => const EstadoDePedido(
            'En camino',
            'Tu pedido salió para tu dirección.',
            TonoDeEstado.exito,
          ),
        'DELIVERED' => const EstadoDePedido(
            'Entregado',
            '¡Que lo disfrutes!',
            TonoDeEstado.exito,
          ),
        'PAYMENT_FAILED' => const EstadoDePedido(
            'No pudimos procesar el pago',
            'Probá con otra tarjeta u otro medio de pago.',
            TonoDeEstado.error,
          ),
        'PAYMENT_REQUIRES_REFUND' => const EstadoDePedido(
            'Se agotó justo',
            'Tu pago se acreditó pero el producto se agotó. Estamos haciendo la devolución.',
            TonoDeEstado.alerta,
          ),
        'REFUND_PENDING' => const EstadoDePedido(
            'Devolución en curso',
            'Estamos devolviendo tu dinero. Puede tardar unos días hábiles.',
            TonoDeEstado.alerta,
          ),
        'REFUNDED' => const EstadoDePedido(
            'Dinero devuelto',
            'Ya te devolvimos el importe completo.',
            TonoDeEstado.neutro,
          ),
        'EXPIRED' => const EstadoDePedido(
            'Se venció',
            'Pasó el tiempo para pagar y se liberó el stock.',
            TonoDeEstado.neutro,
          ),
        'CANCELLED' => const EstadoDePedido(
            'Cancelado',
            'Cancelaste este pedido.',
            TonoDeEstado.neutro,
          ),
        _ => const EstadoDePedido('En proceso', '', TonoDeEstado.neutro),
      };
}

enum TonoDeEstado { pendiente, enCurso, exito, alerta, error, neutro }

class EstadoDePedido {
  const EstadoDePedido(this.titulo, this.detalle, this.tono);
  final String titulo;
  final String detalle;
  final TonoDeEstado tono;
}

/// Una dirección guardada del usuario.
class Direccion {
  const Direccion({
    required this.id,
    required this.destinatario,
    required this.documento,
    required this.telefono,
    required this.calle,
    required this.numero,
    required this.ciudad,
    required this.provincia,
    required this.codigoPostal,
    this.tipoDocumento = 'DNI',
    this.piso,
    this.departamento,
    this.referencias,
    this.principal = false,
  });

  factory Direccion.fromJson(Map<String, dynamic> j) => Direccion(
        id: j['id'] as String,
        destinatario: j['recipientFullName'] as String? ?? '',
        tipoDocumento: j['documentType'] as String? ?? 'DNI',
        documento: j['documentNumber'] as String? ?? '',
        telefono: j['phoneE164'] as String? ?? '',
        calle: j['street'] as String? ?? '',
        numero: j['number'] as String? ?? '',
        ciudad: j['city'] as String? ?? '',
        provincia: j['province'] as String? ?? '',
        codigoPostal: j['postalCode'] as String? ?? '',
        piso: j['floor'] as String?,
        departamento: j['apartment'] as String?,
        referencias: j['references'] as String?,
        principal: j['isDefault'] as bool? ?? false,
      );

  final String id;
  final String destinatario;
  final String tipoDocumento;
  final String documento;
  final String telefono;
  final String calle;
  final String numero;
  final String ciudad;
  final String provincia;
  final String codigoPostal;
  final String? piso;
  final String? departamento;
  final String? referencias;
  final bool principal;

  String get resumen {
    final unidad = [
      if (piso != null && piso!.isNotEmpty) '$piso°',
      if (departamento != null && departamento!.isNotEmpty) departamento,
    ].join(' ');
    return [
      '$calle $numero',
      if (unidad.isNotEmpty) unidad,
      '$ciudad, $provincia',
    ].join(', ');
  }
}

/// Una venta, como la ve el vendedor.
class Venta {
  const Venta({
    required this.id,
    required this.referencia,
    required this.status,
    required this.total,
    required this.neto,
    required this.fecha,
    this.comision = 0,
    this.lineas = const [],
    this.direccion,
    this.comprador,
  });

  factory Venta.fromJson(Map<String, dynamic> j) {
    final direccion = j['shippingAddress'] as Map<String, dynamic>?;
    final comprador = j['buyerSnapshot'] as Map<String, dynamic>?;

    return Venta(
      id: j['id'] as String,
      referencia: j['reference'] as String? ?? '',
      status: j['status'] as String? ?? '',
      total: _int(j['grossAmount']),
      neto: _int(j['sellerNetAmount']),
      comision: _int(j['platformFeeAmount']),
      fecha: DateTime.tryParse(j['createdAt'] as String? ?? '') ?? DateTime.now(),
      lineas: (j['items'] as List<dynamic>? ?? [])
          .map((e) => LineaDePedido.fromJson(e as Map<String, dynamic>))
          .toList(),
      direccion: direccion == null ? null : DireccionEntrega.fromJson(direccion),
      comprador: comprador?['nombre'] as String?,
    );
  }

  final String id;
  final String referencia;
  final String status;
  final int total;
  final int neto;
  final int comision;
  final DateTime fecha;
  final List<LineaDePedido> lineas;
  final DireccionEntrega? direccion;
  final String? comprador;

  /// Cuál es el próximo paso que puede dar el vendedor. `null` si no hay.
  String? get siguienteEstado => switch (status) {
        'CONFIRMED' => 'PREPARING',
        'PREPARING' => 'READY_TO_SHIP',
        'READY_TO_SHIP' => 'SHIPPED',
        _ => null,
      };

  String? get etiquetaSiguiente => switch (siguienteEstado) {
        'PREPARING' => 'Empezar a preparar',
        'READY_TO_SHIP' => 'Marcar como listo',
        'SHIPPED' => 'Marcar como despachado',
        _ => null,
      };

  String get etiquetaEstado => switch (status) {
        'CONFIRMED' => 'Nueva',
        'PREPARING' => 'Preparando',
        'READY_TO_SHIP' => 'Lista',
        'SHIPPED' => 'Despachada',
        'DELIVERED' => 'Entregada',
        'PAID' => 'Confirmando',
        'PAYMENT_REQUIRES_REFUND' => 'A devolver',
        'REFUND_PENDING' => 'Devolviendo',
        'REFUNDED' => 'Devuelta',
        _ => status,
      };
}
