import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/lives/domain/live_models.dart';

/// Lo que el perfil del vendedor muestra de su reputación.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// TRES INSIGNIAS, TRES SIGNIFICADOS, NINGUNA COMPRABLE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El backend ya calculaba `cumplimiento`, `esNuevo` y `destacado`, y la app
/// los tiraba al parsear: la pantalla mostraba menos de lo que el sistema
/// sabía. Estos tests fijan que lleguen, y que el `null` se respete.
///
/// El `null` importa tanto como el número. «Sin datos» y «cumple el 0 %» son
/// cosas opuestas, y un cero sobre un vendedor nuevo lo hunde por algo que no
/// hizo.

Map<String, dynamic> _json(Map<String, dynamic> extra) => {
      'id': 'sel_1',
      'nombre': 'Ana',
      'seguidores': 10,
      'resenas': 0,
      'ventas': 0,
      ...extra,
    };

void main() {
  group('El cumplimiento', () {
    test('llega cuando el servidor lo calculó', () {
      expect(PerfilDeVendedor.fromJson(_json({'cumplimiento': 97})).cumplimiento, 97);
    });

    test('⛔ ausente es null, NO cero', () {
      /**
       * EL TEST QUE IMPORTA.
       *
       * El servidor manda `null` hasta que hay operaciones suficientes: un
       * «100 %» sobre una sola venta no es información, y un «0 %» sobre quien
       * todavía no despachó nada es una acusación.
       *
       * Si acá se convirtiera a cero, la pantalla mostraría «0 % de
       * cumplimiento» a todo vendedor nuevo.
       */
      expect(PerfilDeVendedor.fromJson(_json({})).cumplimiento, isNull);
      expect(PerfilDeVendedor.fromJson(_json({'cumplimiento': null})).cumplimiento, isNull);
    });
  });

  group('Las tres insignias', () {
    test('son independientes', () {
      final p = PerfilDeVendedor.fromJson(
        _json({'identidadVerificada': true, 'vendedorConfiable': false, 'destacado': false}),
      );

      expect(p.identidadVerificada, isTrue);
      expect(p.vendedorConfiable, isFalse);
      expect(p.destacado, isFalse);
    });

    test('⛔ destacado ausente es false', () {
      // Nunca se inventa una insignia: es lo que la haría dejar de significar
      // algo.
      expect(PerfilDeVendedor.fromJson(_json({})).destacado, isFalse);
    });

    test('⛔ estar destacado NO implica estar verificado', () {
      /**
       * Son cosas distintas: destacado se gana vendiendo bien, verificado se
       * comprueba con un documento. Alguien puede tener una y no la otra.
       */
      final p = PerfilDeVendedor.fromJson(_json({'destacado': true}));

      expect(p.destacado, isTrue);
      expect(p.identidadVerificada, isFalse);
    });
  });

  group('Vendedor nuevo', () {
    test('lo decide el servidor', () {
      /**
       * Con `esNuevo: true` la pantalla dice «recién empieza» en vez de
       * mostrar ceros. El umbral está en `reputacion.ts` y no se duplica acá:
       * dos definiciones de «nuevo» que discrepan harían que se muestre
       * «recién empieza» al lado de un promedio de estrellas.
       */
      final p = PerfilDeVendedor.fromJson(
        _json({'esNuevo': true, 'ventas': 2, 'resenas': 1, 'rating': 5.0}),
      );

      expect(p.esNuevo, isTrue);
      expect(p.sinReputacion, isTrue);
    });

    test('sin el campo, se cae al respaldo local', () {
      // Para una respuesta vieja que no lo traiga.
      expect(PerfilDeVendedor.fromJson(_json({})).sinReputacion, isTrue);
      expect(
        PerfilDeVendedor.fromJson(_json({'ventas': 40, 'resenas': 12})).sinReputacion,
        isFalse,
      );
    });
  });
}
