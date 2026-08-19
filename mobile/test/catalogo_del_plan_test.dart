import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';

/// El contador «2 de 3 productos publicados».
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE ESTOS TESTS PROTEGEN ES QUE LA APP NO INVENTE EL NÚMERO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El tope del plan Free es una regla de negocio que vive en el backend, que es
/// el único lugar donde se puede hacer cumplir. La app la muestra y nada más.
///
/// Una copia del `3` acá adentro sería una segunda verdad: el día que el plan
/// cambie, la pantalla le mostraría al vendedor un número que no es, y el error
/// se vería recién cuando alguien reclame.
void main() {
  group('Estado del catálogo', () {
    test('se arma con lo que mandó el backend', () {
      final e = EstadoDelCatalogo.desdeJson({
        'publicados': 2,
        'limite': 3,
        'puedePublicar': true,
      });

      expect(e!.publicados, 2);
      expect(e.limite, 3);
      expect(e.puedePublicar, isTrue);
    });

    test('el resumen es el texto que ve el vendedor', () {
      final e = EstadoDelCatalogo.desdeJson({
        'publicados': 2,
        'limite': 3,
        'puedePublicar': true,
      });

      expect(e!.resumen, '2 de 3 productos publicados');
    });

    /// `limite: null` es lo que le dice a la pantalla que no muestre contador.
    /// Un «12 de ∞» no le sirve a nadie.
    test('⛔ sin tope no hay contador que mostrar', () {
      final e = EstadoDelCatalogo.desdeJson({
        'publicados': 12,
        'limite': null,
        'puedePublicar': true,
      });

      expect(e!.tieneTope, isFalse);
      expect(e.resumen, isNull);
    });

    /// EL TEST QUE IMPIDE QUE LA APP DECIDA POR SU CUENTA.
    ///
    /// `puedePublicar` viene resuelto del servidor. Si esta clase lo recalculara
    /// —`publicados < limite`— habría dos reglas, y la de la app ganaría en la
    /// pantalla mientras la del servidor ganaría en el rechazo. El vendedor
    /// vería un botón habilitado que da error.
    test('⛔ puedePublicar sale del backend, no se recalcula acá', () {
      // Un caso deliberadamente incoherente: 1 de 3, pero el servidor dice que
      // no. Podría pasar por una regla que la app no conoce todavía.
      final e = EstadoDelCatalogo.desdeJson({
        'publicados': 1,
        'limite': 3,
        'puedePublicar': false,
      });

      expect(e!.puedePublicar, isFalse);
    });

    test('en el tope, puedePublicar llega en false', () {
      final e = EstadoDelCatalogo.desdeJson({
        'publicados': 3,
        'limite': 3,
        'puedePublicar': false,
      });

      expect(e!.puedePublicar, isFalse);
      expect(e.resumen, '3 de 3 productos publicados');
    });

    /// Quien ya tenía más de tres cuando se introdujo el límite los conserva.
    /// La pantalla tiene que poder decirlo sin romperse.
    test('un vendedor por encima del tope se muestra tal cual', () {
      final e = EstadoDelCatalogo.desdeJson({
        'publicados': 6,
        'limite': 3,
        'puedePublicar': false,
      });

      expect(e!.resumen, '6 de 3 productos publicados');
    });

    /// Una respuesta vieja del backend —o un endpoint que todavía no lo manda—
    /// no puede tumbar la pantalla de productos.
    test('⛔ sin el campo, no explota: devuelve null', () {
      expect(EstadoDelCatalogo.desdeJson(null), isNull);
      expect(EstadoDelCatalogo.desdeJson('cualquier cosa'), isNull);
    });
  });

  group('La página del listado', () {
    test('sin catálogo el campo queda en null', () {
      const p = Pagina<String>(items: ['a']);

      expect(p.catalogo, isNull);
    });

    test('con catálogo lo transporta', () {
      final p = Pagina<String>(
        items: const ['a'],
        catalogo: EstadoDelCatalogo.desdeJson({
          'publicados': 1,
          'limite': 3,
          'puedePublicar': true,
        }),
      );

      expect(p.catalogo!.resumen, '1 de 3 productos publicados');
    });
  });
}
