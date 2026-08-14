import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/orders/domain/order_models.dart';

/// El contrato de pedidos entre el backend y la app.
///
/// Los JSON son respuestas reales de `/api/v1/orders`. Es la misma costura
/// donde ya se escondieron dos defectos —el `content-type` de los DELETE y el
/// `id` faltante en las imágenes—: las dos mitades bien probadas por separado
/// y nadie probando el medio.
void main() {
  final pedidoJson = {
    'id': 'ord_01KZZ0ABCDEFGHIJKLMNOPQRST',
    'reference': 'A4F2K9XY',
    'status': 'CONFIRMED',
    'currency': 'ARS',
    'itemsSubtotal': 890000,
    'shippingAmount': 0,
    'discountAmount': 0,
    'grossAmount': 890000,
    'platformFeeBps': 600,
    'platformFeeAmount': 53400,
    'sellerNetAmount': 836600,
    'createdAt': '2026-08-14T02:00:00.000Z',
    'paidAt': '2026-08-14T02:00:03.000Z',
    'confirmedAt': '2026-08-14T02:00:03.500Z',
    'shippingAddress': {
      'recipientFullName': 'Ana Pérez',
      'street': 'Av. Corrientes',
      'number': '1234',
      'floor': '3',
      'apartment': 'B',
      'city': 'CABA',
      'province': 'Buenos Aires',
      'postalCode': 'C1043',
      'references': 'Portón negro',
      'phoneE164': '+5491122334455',
    },
    'items': [
      {
        'productNameSnapshot': 'Vela aromática',
        'variantLabelSnapshot': 'Default',
        'skuSnapshot': null,
        'imageUrlSnapshot': 'https://ejemplo.test/vela.jpg',
        'quantity': 1,
        'unitPrice': 890000,
        'subtotal': 890000,
      },
    ],
    'attempts': [
      {
        'id': 'pat_01KZZ0',
        'status': 'APPROVED',
        'brand': 'visa',
        'lastFour': '3704',
        'failureMessageSafe': null,
        'createdAt': '2026-08-14T02:00:01.000Z',
      },
    ],
  };

  group('Pedido', () {
    test('se parsea completo', () {
      final p = Pedido.fromJson(pedidoJson);

      expect(p.referencia, 'A4F2K9XY');
      expect(p.total, r'$ 8.900,00');
      expect(p.lineas.single.nombre, 'Vela aromática');
      expect(p.intentos.single.tarjeta, 'visa •••• 3704');
      expect(p.direccion!.resumen, contains('Av. Corrientes 1234'));
      expect(p.direccion!.resumen, contains('C1043'));
    });

    test('"Default" no se muestra como variante', () {
      // Un producto sin opciones tiene una variante DEFAULT interna. Mostrar
      // "Default" debajo del nombre no le dice nada a nadie.
      final p = Pedido.fromJson(pedidoJson);
      expect(p.lineas.single.varianteRelevante, isFalse);
    });

    test('una variante real sí se muestra', () {
      final conVariante = {
        ...pedidoJson,
        'items': [
          {...(pedidoJson['items']! as List).first as Map<String, dynamic>,
            'variantLabelSnapshot': 'Negro / M'},
        ],
      };
      expect(Pedido.fromJson(conVariante).lineas.single.varianteRelevante, isTrue);
    });

    test('campos ausentes no tumban la pantalla', () {
      // La app vive en teléfonos que no se actualizan junto con el servidor.
      final p = Pedido.fromJson({'id': 'ord_x', 'status': 'PENDING_PAYMENT'});
      expect(p.lineas, isEmpty);
      expect(p.direccion, isNull);
      expect(p.grossAmount, 0);
    });
  });

  group('⛔ Qué se le dice a la persona', () {
    test('ningún código técnico llega a la pantalla', () {
      /**
       * Nadie entiende `PAYMENT_REQUIRES_REFUND` ni `cc_rejected_other_reason`.
       * Se recorren TODOS los estados posibles del backend y se comprueba que
       * ninguno se filtre tal cual a la interfaz.
       */
      const estados = [
        'PENDING_PAYMENT',
        'PROCESSING_PAYMENT',
        'PAID',
        'CONFIRMED',
        'PREPARING',
        'READY_TO_SHIP',
        'SHIPPED',
        'DELIVERED',
        'PAYMENT_FAILED',
        'PAYMENT_REQUIRES_REFUND',
        'REFUND_PENDING',
        'REFUNDED',
        'EXPIRED',
        'CANCELLED',
      ];

      for (final estado in estados) {
        final p = Pedido.fromJson({...pedidoJson, 'status': estado});
        final texto = '${p.estado.titulo} ${p.estado.detalle}';

        expect(texto, isNot(contains('_')), reason: 'guiones bajos en "$estado"');
        expect(texto.toUpperCase(), isNot(equals(texto)), reason: 'todo en mayúsculas en "$estado"');
        expect(p.estado.titulo.length, greaterThan(3), reason: 'título vacío en "$estado"');
      }
    });

    test('el pago acreditado sin stock se explica completo', () {
      /**
       * Es el caso más delicado del sistema: se le cobró a alguien y no hay
       * producto. Esconderlo detrás de "hubo un problema" hace que la persona
       * crea que le robamos.
       */
      final p = Pedido.fromJson({...pedidoJson, 'status': 'PAYMENT_REQUIRES_REFUND'});

      expect(p.estado.detalle, contains('acreditó'));
      expect(p.estado.detalle.toLowerCase(), contains('devolu'));
      expect(p.estado.tono, TonoDeEstado.alerta);
    });

    test('⛔ un pago incierto NUNCA dice que falló', () {
      /**
       * El cobro pudo haberse procesado. Decir "el pago falló" invita a pagar
       * de nuevo, y eso cobra dos veces.
       */
      final p = Pedido.fromJson({...pedidoJson, 'status': 'PROCESSING_PAYMENT'});

      final texto = '${p.estado.titulo} ${p.estado.detalle}'.toLowerCase();
      expect(texto, isNot(contains('falló')));
      expect(texto, isNot(contains('error')));
      expect(texto, contains('verificando'));

      // Y no se ofrece pagar de nuevo.
      expect(p.sePuedePagar, isFalse);
      expect(p.verificandose, isTrue);
    });

    test('un rechazo SÍ deja reintentar', () {
      final p = Pedido.fromJson({...pedidoJson, 'status': 'PAYMENT_FAILED'});
      expect(p.sePuedePagar, isTrue);
      expect(p.estado.detalle.toLowerCase(), contains('otra tarjeta'));
    });

    test('una compra confirmada no se puede cancelar', () {
      final p = Pedido.fromJson({...pedidoJson, 'status': 'CONFIRMED'});
      expect(p.sePuedeCancelar, isFalse);
      expect(p.estado.tono, TonoDeEstado.exito);
    });
  });

  group('Intento de pago', () {
    test('distingue los tres desenlaces', () {
      IntentoDePago de(String status) =>
          IntentoDePago.fromJson({'id': 'pat_x', 'status': status});

      expect(de('APPROVED').aprobado, isTrue);
      expect(de('REJECTED').rechazado, isTrue);

      // Los tres estados inciertos.
      expect(de('CREATED').incierto, isTrue);
      expect(de('PROCESSING').incierto, isTrue);
      expect(de('UNKNOWN_PENDING_RECONCILIATION').incierto, isTrue);

      // Y un incierto NO es un rechazo.
      expect(de('UNKNOWN_PENDING_RECONCILIATION').rechazado, isFalse);
    });

    test('sin tarjeta no inventa una', () {
      final sinDatos = IntentoDePago.fromJson({'id': 'pat_x', 'status': 'REJECTED'});
      expect(sinDatos.tarjeta, isNull);
    });
  });

  group('Venta del vendedor', () {
    final ventaJson = {
      'id': 'ord_x',
      'reference': 'B7K2M4NP',
      'status': 'CONFIRMED',
      'grossAmount': 890000,
      'sellerNetAmount': 836600,
      'platformFeeAmount': 53400,
      'createdAt': '2026-08-14T02:00:00.000Z',
      'items': [
        {
          'productNameSnapshot': 'Vela aromática',
          'variantLabelSnapshot': 'Negro / M',
          'quantity': 2,
          'unitPrice': 445000,
        },
      ],
      'shippingAddress': pedidoJson['shippingAddress'],
      'buyerSnapshot': {'nombre': 'Ana Pérez'},
    };

    test('el flujo de preparación avanza de a un paso', () {
      Venta con(String status) => Venta.fromJson({...ventaJson, 'status': status});

      expect(con('CONFIRMED').siguienteEstado, 'PREPARING');
      expect(con('PREPARING').siguienteEstado, 'READY_TO_SHIP');
      expect(con('READY_TO_SHIP').siguienteEstado, 'SHIPPED');
      // Después de despachar, el vendedor no tiene más pasos.
      expect(con('SHIPPED').siguienteEstado, isNull);
      expect(con('DELIVERED').siguienteEstado, isNull);
    });

    test('⛔ no hay siguiente paso para estados de plata', () {
      // El vendedor no puede declarar pagada ni devuelta una venta.
      Venta con(String status) => Venta.fromJson({...ventaJson, 'status': status});

      expect(con('PAID').siguienteEstado, isNull);
      expect(con('PAYMENT_REQUIRES_REFUND').siguienteEstado, isNull);
      expect(con('REFUNDED').siguienteEstado, isNull);
    });

    test('trae lo que hace falta para despachar', () {
      final v = Venta.fromJson(ventaJson);
      expect(v.direccion!.destinatario, 'Ana Pérez');
      expect(v.direccion!.resumen, contains('Av. Corrientes'));
      expect(v.lineas.single.cantidad, 2);
      expect(v.neto, 836600);
    });
  });

  group('Dirección', () {
    test('arma el resumen con piso y departamento', () {
      final d = DireccionEntrega.fromJson(
        pedidoJson['shippingAddress']! as Map<String, dynamic>,
      );
      expect(d.resumen, 'Av. Corrientes 1234 — 3° B — CABA, Buenos Aires (C1043)');
    });

    test('sin piso ni departamento no deja huecos', () {
      final d = DireccionEntrega.fromJson({
        'recipientFullName': 'Juan',
        'street': 'San Martín',
        'number': '500',
        'city': 'Rosario',
        'province': 'Santa Fe',
        'postalCode': '2000',
      });
      expect(d.resumen, 'San Martín 500 — Rosario, Santa Fe (2000)');
      expect(d.resumen, isNot(contains('—  —')));
    });
  });
}
