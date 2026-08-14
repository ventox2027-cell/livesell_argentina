import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/orders/domain/order_models.dart';

/// Cuándo se puede calificar una compra, y cuándo ya no.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA REGLA LA DECIDE EL BACKEND; ESTO SÓLO EVITA OFRECER LO IMPOSIBLE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Un índice único sobre `orderId` impide la segunda reseña, y el servicio
/// comprueba que la compra sea propia y esté concretada. La app no reimplementa
/// nada de eso.
///
/// Lo que sí hace es no mostrar "Calificar compra" sobre algo que el backend va
/// a rechazar: un botón que falla siempre es peor que un botón que no está.
void main() {
  Pedido pedido({
    String status = 'DELIVERED',
    String? entregadoEl = '2026-08-14T12:00:00.000Z',
    Map<String, dynamic>? review,
  }) {
    return Pedido.fromJson({
      'id': 'ord_x',
      'reference': '9YPP2RWZ',
      'status': status,
      'grossAmount': 1500000,
      'createdAt': '2026-08-14T10:00:00.000Z',
      if (entregadoEl != null) 'deliveredAt': entregadoEl,
      if (review != null) 'review': review,
      'store': {'name': 'Taller Aroma'},
    });
  }

  group('Calificar', () {
    test('un pedido entregado y sin reseña se puede calificar', () {
      expect(pedido().sePuedeCalificar, isTrue);
    });

    test('⛔ uno que todavía no llegó, no', () {
      // Opinar sobre algo que no llegó mide la expectativa, no la experiencia.
      for (final estado in ['CONFIRMED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED']) {
        final p = pedido(status: estado, entregadoEl: null);
        expect(p.sePuedeCalificar, isFalse, reason: estado);
      }
    });

    test('⛔ uno ya calificado, tampoco', () {
      final p = pedido(review: {'id': 'rev_x', 'rating': 5});

      expect(p.sePuedeCalificar, isFalse);
      expect(p.calificacion, 5);
    });

    test('sin el campo review, la calificación es null y no cero', () {
      // Cero estrellas es una calificación pésima; "no calificado" es otra
      // cosa. Confundirlas mostraría cinco estrellas vacías como si alguien
      // hubiera opinado.
      expect(pedido().calificacion, isNull);
    });
  });

  group('Código de entrega', () {
    test('sólo se muestra mientras el pedido no llegó', () {
      final despachado = Pedido.fromJson({
        'id': 'ord_x',
        'reference': 'X',
        'status': 'SHIPPED',
        'grossAmount': 1,
        'createdAt': '2026-08-14T10:00:00.000Z',
        'deliveryCode': '482913',
        'shippedAt': '2026-08-14T11:00:00.000Z',
      });

      expect(despachado.esperaEntrega, isTrue);
      expect(despachado.codigoDeEntrega, '482913');
    });

    test('una vez entregado deja de mostrarse', () {
      final entregado = Pedido.fromJson({
        'id': 'ord_x',
        'reference': 'X',
        'status': 'DELIVERED',
        'grossAmount': 1,
        'createdAt': '2026-08-14T10:00:00.000Z',
        'deliveryCode': '482913',
        'deliveredAt': '2026-08-14T13:00:00.000Z',
      });

      // Ya cumplió su función. Seguir mostrándolo sólo suma un número a la
      // pantalla que nadie va a usar.
      expect(entregado.esperaEntrega, isFalse);
    });

    test('sin código, no hay nada que mostrar', () {
      // Es lo que pasa antes de que el vendedor despache.
      expect(pedido(status: 'CONFIRMED', entregadoEl: null).esperaEntrega, isFalse);
    });
  });
}
