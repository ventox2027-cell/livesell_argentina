import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/seller/data/pro_api.dart';

/// VendoX Pro, del lado de la app.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE SE PUEDE HACER SALE DE LA LISTA DE BENEFICIOS
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La app **no** deduce permisos del nombre del plan. Mira `beneficios`, que es
/// lo que el servidor calculó después de comparar el vencimiento contra su
/// propio reloj.
///
/// La diferencia importa: una fila puede decir `PRO` y estar vencida, y el
/// servidor manda `plan: FREE` con la lista vacía. Si la app mirara el nombre,
/// le dejaría usar cupones a alguien que dejó de pagar.

Map<String, dynamic> _json(Map<String, dynamic> extra) => {
      'plan': 'FREE',
      'beneficios': <String>[],
      'limites': {'cuponesActivos': 0, 'diasDeHistorial': 30},
      ...extra,
    };

void main() {
  group('La membresía', () {
    test('Free no habilita nada', () {
      final m = MiMembresia.fromJson(_json({}));

      expect(m.esPro, isFalse);
      expect(m.puedeUsarCupones, isFalse);
      expect(m.puedeVerAnalitica, isFalse);
      expect(m.diasRestantes, isNull);
    });

    test('Pro habilita lo que dice la lista', () {
      final m = MiMembresia.fromJson(
        _json({
          'plan': 'PRO',
          'beneficios': ['CUPONES', 'ANALITICA_AVANZADA', 'INSIGNIA_PRO'],
          'limites': {'cuponesActivos': 20, 'diasDeHistorial': 365},
          'diasRestantes': 12,
          'origen': 'PAGO',
        }),
      );

      expect(m.esPro, isTrue);
      expect(m.puedeUsarCupones, isTrue);
      expect(m.cuponesActivosPermitidos, 20);
      expect(m.diasRestantes, 12);
    });

    test('⛔ el permiso NO se deduce del nombre del plan', () {
      /**
       * EL TEST QUE IMPORTA.
       *
       * Un payload con `plan: PRO` y la lista vacía no puede habilitar nada.
       * No debería llegar —el servidor manda FREE cuando vence— pero si la app
       * mirara el nombre en vez de la lista, un bug del backend se convertiría
       * en herramientas gratis.
       */
      final m = MiMembresia.fromJson(_json({'plan': 'PRO', 'beneficios': <String>[]}));

      expect(m.esPro, isTrue);
      expect(m.puedeUsarCupones, isFalse);
      expect(m.puedeVerAnalitica, isFalse);
    });

    test('⛔ los días los cuenta el SERVIDOR, no el teléfono', () {
      /**
       * Con una fecha de vencimiento y sin `diasRestantes`, la app deja el
       * contador en `null` en vez de calcularlo. El reloj del teléfono se puede
       * haber quedado atrasado, y una cuenta regresiva que no coincide con la
       * del backend es peor que ninguna.
       */
      final m = MiMembresia.fromJson(
        _json({'plan': 'PRO', 'vigenteHasta': '2027-01-01T00:00:00.000Z'}),
      );

      expect(m.vigenteHasta, isNotNull);
      expect(m.diasRestantes, isNull);
    });

    test('el aviso de vencimiento usa el mismo umbral que el backend', () {
      expect(MiMembresia.fromJson(_json({'diasRestantes': 3})).venceProximo, isTrue);
      expect(MiMembresia.fromJson(_json({'diasRestantes': 20})).venceProximo, isFalse);
    });
  });

  group('Un cupón', () {
    Map<String, dynamic> cupon(Map<String, dynamic> extra) => {
          'id': 'cup_1',
          'codigo': 'VERANO25',
          'tipo': 'PORCENTAJE',
          'valor': 25,
          'usos': 3,
          'activo': true,
          ...extra,
        };

    test('⛔ sin límite de usos, usosRestantes es null', () {
      /**
       * Y NO cero. Es el mismo criterio que en todo el sistema: no se puede
       * mostrar una cifra que no existe. Un cero acá se leería como «agotado».
       */
      final c = Cupon.fromJson(cupon({}));

      expect(c.usosRestantes, isNull);
      expect(c.agotado, isFalse);
    });

    test('con límite, dice cuántos quedan', () {
      final c = Cupon.fromJson(cupon({'usosMaximos': 10, 'usosRestantes': 7}));
      expect(c.usosRestantes, 7);
      expect(c.agotado, isFalse);
    });

    test('agotado cuando no quedan', () {
      final c = Cupon.fromJson(cupon({'usosRestantes': 0}));
      expect(c.agotado, isTrue);
    });
  });
}
