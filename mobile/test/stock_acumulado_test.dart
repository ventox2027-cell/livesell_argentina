import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/inventory/domain/ajustes_acumulados.dart';

/// Consolidar toques de stock sin perder ninguno.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ACÁ SE PUEDE PERDER STOCK SIN QUE SE NOTE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El error que importa no es una excepción: es que el vendedor vea 8 en
/// pantalla y el servidor guarde 5. No falla nada, no hay log, y el problema
/// aparece cuando alguien compra y no hay unidades.
///
/// El caso que lo produce es siempre el mismo: los toques que llegan MIENTRAS
/// una petición viaja. Si se pisan, se pierden.
void main() {
  group('Acumular y mandar', () {
    test('sin toques no hay nada que mandar', () {
      final a = AjustesAcumulados();

      expect(a.tomar(), isNull);
      expect(a.hayTrabajo, isFalse);
    });

    /// El caso de la queja: tocar cinco veces rápido tiene que ser UNA
    /// petición de +5, no cinco de +1.
    test('cinco toques seguidos se mandan en una sola petición', () {
      final a = AjustesAcumulados();
      for (var i = 0; i < 5; i += 1) {
        a.sumar(1);
      }

      expect(a.tomar(), 5);
      expect(a.tomar(), isNull, reason: 'ya se llevó todo');
    });

    test('sumar y restar se compensan', () {
      final a = AjustesAcumulados()
        ..sumar(3)
        ..sumar(-1);

      expect(a.tomar(), 2);
    });

    /// Si los toques se cancelan entre sí, no hay nada que mandar. Tocar `+` y
    /// después `−` no tiene por qué generar tráfico.
    test('un +1 y un −1 no generan petición', () {
      final a = AjustesAcumulados()
        ..sumar(1)
        ..sumar(-1);

      expect(a.tomar(), isNull);
    });
  });

  group('Los toques que llegan mientras la petición viaja', () {
    /// ⛔ EL TEST QUE PROTEGE EL STOCK.
    ///
    /// Se manda +2, y mientras eso viaja el vendedor toca tres veces más. Esos
    /// tres NO se pueden perder: tienen que salir en la próxima tanda.
    test('⛔ no se pierden: salen en la tanda siguiente', () {
      final a = AjustesAcumulados()..sumar(2);

      expect(a.tomar(), 2);

      // Mientras viaja.
      a
        ..sumar(1)
        ..sumar(1)
        ..sumar(1);

      // Todavía no se pueden mandar: hay una en el aire.
      expect(a.tomar(), isNull);
      expect(a.pendiente, 3);

      a.confirmar();
      expect(a.tomar(), 3);
    });

    /// Dos peticiones simultáneas de la misma variante llegarían en cualquier
    /// orden. El resultado final sería el mismo —los deltas son relativos— pero
    /// el refresco intermedio haría saltar el número bajo el dedo.
    test('⛔ no se mandan dos peticiones a la vez', () {
      final a = AjustesAcumulados()..sumar(1);
      expect(a.tomar(), 1);

      a.sumar(1);
      expect(a.tomar(), isNull);
      expect(a.enVuelo, isTrue);
    });

    test('después de confirmar se puede mandar de nuevo', () {
      final a = AjustesAcumulados()..sumar(1);
      a.tomar();
      a.confirmar();

      a.sumar(4);
      expect(a.tomar(), 4);
    });

    /// `hayTrabajo` es lo que impide que un refresco del servidor pise el valor
    /// que la persona está viendo mientras toca.
    test('hay trabajo mientras algo está pendiente o en el aire', () {
      final a = AjustesAcumulados();
      expect(a.hayTrabajo, isFalse);

      a.sumar(1);
      expect(a.hayTrabajo, isTrue, reason: 'pendiente sin mandar');

      a.tomar();
      expect(a.hayTrabajo, isTrue, reason: 'en el aire');

      a.confirmar();
      expect(a.hayTrabajo, isFalse);
    });
  });

  group('Cuando el servidor rechaza', () {
    /// ⛔ Se descarta TAMBIÉN lo pendiente, y es a propósito.
    ///
    /// Si el ajuste que viajaba no entró, los toques posteriores se calcularon
    /// sobre un número que nunca existió. Mandarlos igual dejaría el stock en
    /// un valor que nadie pidió: el vendedor tocó `+3` creyendo que había 5,
    /// pero el servidor sigue en 2.
    test('⛔ un fallo descarta también lo acumulado después', () {
      final a = AjustesAcumulados()..sumar(3);
      a.tomar();
      a.sumar(3); // tocó más mientras viajaba

      a.fallar();

      expect(a.pendiente, 0);
      expect(a.tomar(), isNull);
      expect(a.hayTrabajo, isFalse, reason: 'la pantalla vuelve al valor del servidor');
    });

    test('después de fallar se puede volver a empezar', () {
      final a = AjustesAcumulados()..sumar(2);
      a.tomar();
      a.fallar();

      a.sumar(1);
      expect(a.tomar(), 1);
    });
  });

  group('Al cerrar la pantalla', () {
    /// Salir dos décimas después de tocar `+` es lo más normal del mundo. Ese
    /// toque tiene que salir igual, o el stock que el vendedor vio no es el que
    /// quedó guardado.
    test('⛔ lo que quedó sin mandar se manda igual', () {
      final a = AjustesAcumulados()..sumar(4);

      expect(a.alSalir(), 4);
    });

    test('sin nada pendiente no se manda nada', () {
      expect(AjustesAcumulados().alSalir(), isNull);
    });

    test('no se manda dos veces', () {
      final a = AjustesAcumulados()..sumar(2);

      expect(a.alSalir(), 2);
      expect(a.alSalir(), isNull);
    });

    /// Lo que ya está en el aire no se vuelve a mandar al salir: llegaría dos
    /// veces y el stock quedaría duplicado.
    test('⛔ lo que ya viaja NO se manda otra vez', () {
      final a = AjustesAcumulados()..sumar(3);
      expect(a.tomar(), 3);

      expect(a.alSalir(), isNull);
    });
  });

  group('El total termina donde tiene que terminar', () {
    /// El recorrido completo de la queja: de 1 a 5 con cinco toques rápidos,
    /// una petición en el medio, y el resto después.
    test('1 → 5 con una ráfaga y un envío en el medio suma exactamente +4', () {
      final a = AjustesAcumulados();
      var aplicadoEnElServidor = 1;

      a.sumar(1); // 2
      final primera = a.tomar()!;
      a
        ..sumar(1) // 3
        ..sumar(1) // 4
        ..sumar(1); // 5

      aplicadoEnElServidor += primera;
      a.confirmar();

      final segunda = a.tomar()!;
      aplicadoEnElServidor += segunda;
      a.confirmar();

      expect(aplicadoEnElServidor, 5);
      expect(a.hayTrabajo, isFalse);
    });
  });
}
