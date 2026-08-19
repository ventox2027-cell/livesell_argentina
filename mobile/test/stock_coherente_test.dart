import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/inventory/domain/inventory_models.dart';
import 'package:vendox/features/inventory/domain/stock_optimista.dart';

/// La pantalla de stock no puede contradecirse a sí misma.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BUG REPORTADO DESDE UN TELÉFONO REAL
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El contador de una variante ya mostraba 14 mientras el resumen de arriba
/// seguía diciendo:
///
///     Total 9 · Reservadas 0 · Disponibles 9
///
/// y así se quedaba varios segundos.
///
/// No era un refresco que faltaba: eran **dos fuentes de verdad**. El resumen
/// leía los datos del servidor y cada fila su propio estado local. Cualquier
/// arreglo que dejara las dos fuentes en pie iba a volver a separarse.
///
/// `StockOptimista` es la única fuente. Estos tests prueban que resumen y filas
/// no pueden discrepar.
StockProducto delServidor(List<({String id, int onHand, int reservado})> variantes) =>
    StockProducto(
      productId: 'prd_1',
      variants: variantes
          .map((v) => StockVariante(
                variantId: v.id,
                title: v.id,
                onHand: v.onHand,
                reserved: v.reservado,
                available: v.onHand - v.reservado,
              ))
          .toList(),
    );

void main() {
  group('El resumen y las filas muestran lo mismo', () {
    /// ⛔ EL TEST DEL BUG.
    ///
    /// Se suman 5 unidades localmente. El resumen tiene que reflejarlo en el
    /// mismo estado, sin esperar al servidor.
    test('⛔ al sumar 5, el total del resumen sube 5 inmediatamente', () {
      final servidor = delServidor([(id: 'v1', onHand: 9, reservado: 0)]);
      final antes = StockOptimista(delServidor: servidor);
      expect(antes.totalOnHand, 9);

      final despues = antes.conAjuste('v1', 14);

      expect(despues.totalOnHand, 14, reason: 'el resumen');
      expect(despues.onHandDe('v1'), 14, reason: 'la fila');
      expect(despues.variantes.single.onHand, 14);
    });

    test('el total es la suma de lo que muestran las filas', () {
      final vista = StockOptimista(
        delServidor: delServidor([
          (id: 'v1', onHand: 3, reservado: 0),
          (id: 'v2', onHand: 4, reservado: 0),
        ]),
      ).conAjuste('v1', 10);

      final sumaDeLasFilas = vista.variantes.fold(0, (s, v) => s + v.onHand);

      expect(vista.totalOnHand, sumaDeLasFilas);
      expect(vista.totalOnHand, 14);
    });

    test('un ajuste en una variante no toca las otras', () {
      final vista = StockOptimista(
        delServidor: delServidor([
          (id: 'v1', onHand: 3, reservado: 0),
          (id: 'v2', onHand: 4, reservado: 0),
        ]),
      ).conAjuste('v1', 8);

      expect(vista.onHandDe('v2'), 4);
    });
  });

  group('Con unidades reservadas', () {
    /// ⛔ LAS RESERVAS NUNCA SON OPTIMISTAS.
    ///
    /// Son de los compradores y cambian por su cuenta mientras el vendedor
    /// mira la pantalla. Inventar disponibilidad le haría creer que puede
    /// vender algo que otro ya tiene apartado.
    test('⛔ el reservado NO se toca al ajustar', () {
      final vista = StockOptimista(
        delServidor: delServidor([(id: 'v1', onHand: 10, reservado: 3)]),
      ).conAjuste('v1', 15);

      expect(vista.totalReservado, 3, reason: 'lo decide el servidor');
      expect(vista.totalOnHand, 15);
    });

    /// La disponibilidad SÍ se adelanta, porque es consecuencia de lo que el
    /// vendedor acaba de hacer: `onHand mostrado − reservado del servidor`.
    test('la disponibilidad se recalcula con el valor mostrado', () {
      final vista = StockOptimista(
        delServidor: delServidor([(id: 'v1', onHand: 10, reservado: 3)]),
      ).conAjuste('v1', 15);

      expect(vista.totalDisponible, 12);
      expect(vista.variantes.single.available, 12);
    });

    /// ⛔ Nunca un negativo en pantalla. Con 3 apartadas y el vendedor bajando
    /// a cero, «−3 disponibles» no significa nada para nadie.
    test('⛔ la disponibilidad no baja de cero', () {
      final vista = StockOptimista(
        delServidor: delServidor([(id: 'v1', onHand: 10, reservado: 3)]),
      ).conAjuste('v1', 0);

      expect(vista.totalDisponible, 0);
    });
  });

  group('Cuando llegan datos del servidor', () {
    /// ⛔ Un refresco NO puede pisar lo que la persona está tocando.
    ///
    /// La respuesta de una petición anterior llega mientras hay toques nuevos
    /// en vuelo. Si pisara, el número saltaría hacia atrás bajo el dedo.
    test('⛔ los ajustes con trabajo pendiente sobreviven al refresco', () {
      final vista = StockOptimista(
        delServidor: delServidor([(id: 'v1', onHand: 9, reservado: 0)]),
      ).conAjuste('v1', 14);

      final refrescada = vista.conDatosDelServidor(
        delServidor([(id: 'v1', onHand: 11, reservado: 0)]),
        (_) => true, // sigue habiendo toques sin confirmar
      );

      expect(refrescada.totalOnHand, 14, reason: 'manda lo que la persona ve');
    });

    /// Y cuando ya no queda nada pendiente, manda el servidor. Es la
    /// reconciliación.
    test('sin trabajo pendiente, manda el servidor', () {
      final vista = StockOptimista(
        delServidor: delServidor([(id: 'v1', onHand: 9, reservado: 0)]),
      ).conAjuste('v1', 14);

      final refrescada = vista.conDatosDelServidor(
        delServidor([(id: 'v1', onHand: 14, reservado: 0)]),
        (_) => false,
      );

      expect(refrescada.totalOnHand, 14);
      expect(refrescada.hayAjustes, isFalse, reason: 'el optimista se soltó');
    });

    /// Un fallo en una variante no puede tirar el optimista de otra que sigue
    /// en curso: sería castigar un toque por un error que no era suyo.
    test('⛔ soltar una variante no toca las demás', () {
      final vista = StockOptimista(
        delServidor: delServidor([
          (id: 'v1', onHand: 3, reservado: 0),
          (id: 'v2', onHand: 4, reservado: 0),
        ]),
      ).conAjuste('v1', 8).conAjuste('v2', 9);

      final tras = vista.sinAjuste('v1');

      expect(tras.onHandDe('v1'), 3, reason: 'volvió al servidor');
      expect(tras.onHandDe('v2'), 9, reason: 'sigue optimista');
    });
  });

  group('Sin ajustes es transparente', () {
    test('muestra exactamente lo del servidor', () {
      final servidor = delServidor([
        (id: 'v1', onHand: 7, reservado: 2),
        (id: 'v2', onHand: 5, reservado: 0),
      ]);
      final vista = StockOptimista(delServidor: servidor);

      expect(vista.totalOnHand, 12);
      expect(vista.totalReservado, 2);
      expect(vista.totalDisponible, 10);
      expect(vista.hayAjustes, isFalse);
    });
  });
}
