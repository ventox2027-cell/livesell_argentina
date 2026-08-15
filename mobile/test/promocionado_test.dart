import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/feed/domain/feed_models.dart';

/// La etiqueta «Promocionado».
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO DECIDE EL SERVIDOR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La app no infiere que algo es publicidad: lo lee de la respuesta. Y con la
/// bandera ausente —un backend viejo, un endpoint que todavía no la manda— la
/// respuesta segura es `false`: marcar como pago algo orgánico es tan mentira
/// como lo contrario.

Map<String, dynamic> _json({Object? promocionado}) => {
      'id': 'prd_1',
      'name': 'Campera de lana',
      'basePriceCents': 890000,
      'store': {
        'id': 'sto_1',
        'name': 'Tienda',
        'slug': 'tienda',
        'seller': {'id': 'sel_1', 'displayName': 'Ana', 'verificationStatus': 'UNVERIFIED'},
      },
      if (promocionado != null) 'promocionado': promocionado,
    };

void main() {
  group('La bandera de promocionado', () {
    test('llega del backend', () {
      expect(PublicacionFeed.fromJson(_json(promocionado: true)).promocionado, isTrue);
    });

    test('⛔ ausente es false, no verdadero', () {
      /**
       * El caso de un backend que todavía no la manda. Una tarjeta orgánica
       * etiquetada como publicidad es una mentira, igual que la de al lado.
       */
      expect(PublicacionFeed.fromJson(_json()).promocionado, isFalse);
    });

    test('⛔ un valor que no es booleano no la enciende', () {
      // Defensa contra un JSON raro: `'true'` como texto no cuenta.
      expect(PublicacionFeed.fromJson(_json(promocionado: 'true')).promocionado, isFalse);
    });

    test('⛔ ser promocionado NO es ser verificado', () {
      /**
       * Son dos cosas distintas y viven en campos distintos. Pagar por
       * aparecer no puede comprar el sello de identidad.
       */
      final p = PublicacionFeed.fromJson(_json(promocionado: true));
      expect(p.promocionado, isTrue);
      expect(p.verificado, isFalse);
    });
  });
}
