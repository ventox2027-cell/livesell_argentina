import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/lives/domain/destacado_optimista.dart';

/// Destacar un producto durante el vivo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE SE MEDÍA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El vendedor tocaba un producto y su propia pantalla tardaba dos viajes a
/// Railway en acompañarlo: `POST /live/:id/feature` y después `GET
/// /live/:id/panel`, uno detrás del otro. En medio de un vivo eso es una
/// eternidad.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// PERO EL PROBLEMA DIFÍCIL ES EL ORDEN, NO LA VELOCIDAD
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Con red lenta, destacar A y enseguida B deja dos peticiones viajando. Si la
/// respuesta de A llega después de la de B y cada respuesta pisa lo que se
/// muestra, el vivo termina exhibiendo A cuando el vendedor eligió B.
///
/// Eso es peor que la lentitud: nadie lo entiende y nadie lo reporta. Se ve una
/// vez, en un vivo, y no se puede reproducir.
void main() {
  group('Lo que se muestra', () {
    /// Sin elección pendiente manda el servidor.
    test('sin elección local, manda el servidor', () {
      const d = DestacadoOptimista();
      expect(d.mostrado('var_servidor'), 'var_servidor');
    });

    /// ⛔ EL EFECTO INMEDIATO: elegir cambia lo que se ve, sin red de por medio.
    test('⛔ apenas elige, se muestra lo elegido', () {
      final d = const DestacadoOptimista().elegir('var_b');
      expect(d.mostrado('var_a'), 'var_b');
    });

    /// «Dejá de destacar» también es una elección.
    ///
    /// ⚠️ Si se modelara con `null` a secas, sería indistinguible de «no hay
    /// elección», y quitar el destacado no se vería hasta que contestara el
    /// servidor.
    test('⛔ quitar el destacado se ve en el momento', () {
      final d = const DestacadoOptimista().elegir(null);
      expect(d.mostrado('var_a'), isNull);
    });
  });

  group('Cuando llega la respuesta', () {
    /// Confirmada Y con el panel diciendo lo mismo: se suelta.
    test('se suelta cuando el panel ya lo refleja', () {
      final d = const DestacadoOptimista().elegir('var_b');
      final tras = d.confirmado(delServidor: 'var_b');

      expect(tras.hayEleccionPendiente, isFalse);
      expect(tras.mostrado('var_b'), 'var_b');
    });

    /// ⛔ Y NO se suelta si el panel todavía dice lo viejo.
    ///
    /// Es el parpadeo hacia atrás: entre soltar y que llegue el panel nuevo
    /// —hasta cinco segundos, que es cada cuánto se refresca— se vería el
    /// destacado ANTERIOR.
    test('⛔ no se suelta mientras el panel diga lo viejo', () {
      final d = const DestacadoOptimista().elegir('var_b');
      final tras = d.confirmado(delServidor: 'var_a');

      expect(tras.mostrado('var_a'), 'var_b');
    });
  });

  group('Dos elecciones seguidas con red lenta', () {
    /// ⛔ EL TEST QUE PEDÍA EL REPORTE.
    ///
    /// Destacar A, enseguida B, y que la respuesta de A llegue TARDE. El vivo
    /// tiene que terminar mostrando B.
    test('⛔ destacar A y enseguida B: gana B aunque A conteste después', () {
      var d = const DestacadoOptimista();

      d = d.elegir('var_a');
      d = d.elegir('var_b');

      // Llega A, tarde. No puede tocar nada.
      d = d.confirmado(delServidor: 'var_a');
      expect(d.mostrado('var_a'), 'var_b', reason: 'la respuesta vieja pisó la elección nueva');

      // Y cuando llega B, con el panel al día, se suelta.
      d = d.confirmado(delServidor: 'var_b');
      expect(d.hayEleccionPendiente, isFalse);
      expect(d.mostrado('var_b'), 'var_b');
    });

    /// ⛔ Y un FALLO viejo tampoco puede deshacer la elección nueva.
    ///
    /// El caso feo: A falla, B está en curso. Si el rollback de A se aplicara,
    /// el vendedor vería volver el producto anterior justo después de haber
    /// elegido otro.
    test('⛔ si A falla después de elegir B, B se queda', () {
      var d = const DestacadoOptimista();

      d = d.elegir('var_a');
      final intentoDeA = d.secuencia;
      d = d.elegir('var_b');

      d = d.fallo(deSecuencia: intentoDeA);

      expect(d.mostrado('var_previo'), 'var_b');
    });
  });

  group('Cuando falla', () {
    /// ⛔ EL ROLLBACK: vuelve lo que decía el servidor.
    test('⛔ se suelta la elección y manda el servidor', () {
      final d = const DestacadoOptimista().elegir('var_b');
      final tras = d.fallo(deSecuencia: d.secuencia);

      expect(tras.hayEleccionPendiente, isFalse);
      expect(tras.mostrado('var_a'), 'var_a');
    });

    /// La secuencia NO se reinicia al fallar.
    ///
    /// Si volviera a cero, una respuesta vieja de un intento anterior podría
    /// coincidir por número con uno nuevo y pisarlo.
    test('⛔ la secuencia nunca vuelve atrás', () {
      var d = const DestacadoOptimista().elegir('var_a');
      final antes = d.secuencia;
      d = d.fallo(deSecuencia: antes);

      expect(d.secuencia, antes);
      expect(d.elegir('var_b').secuencia, greaterThan(antes));
    });
  });
}
