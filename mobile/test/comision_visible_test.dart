import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/seller/data/tasas_api.dart';
import 'package:vendox/features/seller/domain/desglose_de_precio.dart';

/// La comisión que ve el vendedor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// NINGÚN PORCENTAJE SE DECIDE ACÁ
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Con la comisión por volumen, «la comisión de VendoX» dejó de ser un número:
/// un Business con volumen paga 3 % o 3,5 %, y el mismo campo trae valores
/// distintos según quién pregunte.
///
/// Estos tests existen para que no vuelva a haber un porcentaje escrito en
/// Dart. Ya pasó dos veces —la pantalla de políticas con 600, y la de Pro con
/// «6 %» en el texto— y las dos veces siguió funcionando todo mientras le
/// mostraba al vendedor un número que no era el suyo.
void main() {
  group('El detalle de la comisión viene armado del servidor', () {
    test('la etiqueta se usa tal cual llega', () {
      final d = DetalleDeComision.desdeJson({
        'bps': 350,
        'etiqueta': 'Comisión VendoX Business (3,5%)',
        'bajoPorVolumen': true,
        'aviso': 'Tu comisión bajó por volumen de ventas.',
      });

      expect(d!.etiqueta, 'Comisión VendoX Business (3,5%)');
      expect(d.bps, 350);
      expect(d.bajoPorVolumen, isTrue);
      expect(d.aviso, 'Tu comisión bajó por volumen de ventas.');
    });

    /// El caso normal no dice nada sobre la comisión. Una pantalla que siempre
    /// tiene un mensaje convierte el mensaje en decoración.
    test('sin novedades, el aviso es null', () {
      final d = DetalleDeComision.desdeJson({
        'bps': 400,
        'etiqueta': 'Comisión VendoX (4%)',
        'bajoPorVolumen': false,
        'aviso': null,
      });

      expect(d!.aviso, isNull);
      expect(d.bajoPorVolumen, isFalse);
    });

    /// ⛔ `bajoPorVolumen` NO se deduce comparando contra 400.
    ///
    /// Si la app comparara, tendría que saber cuál es la tasa base — que es
    /// justamente el número que no puede conocer. Y el día que la base cambie,
    /// la pantalla diría «tu comisión bajó» a todo el mundo.
    test('⛔ bajoPorVolumen sale del servidor, no de comparar bps', () {
      // Un caso deliberadamente incoherente: 400 bps marcado como rebajado.
      // Podría pasar si la tasa base cambiara y este vendedor tuviera un tramo.
      final d = DetalleDeComision.desdeJson({
        'bps': 400,
        'etiqueta': 'Comisión VendoX Business (4%)',
        'bajoPorVolumen': true,
        'aviso': 'Tu comisión bajó por volumen de ventas.',
      });

      expect(d!.bajoPorVolumen, isTrue);
    });

    test('el aviso de devoluciones altas también llega armado', () {
      final d = DetalleDeComision.desdeJson({
        'bps': 400,
        'etiqueta': 'Comisión VendoX (4%)',
        'bajoPorVolumen': false,
        'aviso': 'Tenés el volumen para una comisión más baja, pero tu tasa de '
            'devoluciones está por encima del límite. Cuando baje, el descuento vuelve solo.',
      });

      expect(d!.aviso, contains('devoluciones'));
      // No se pinta como buena noticia: no bajó nada.
      expect(d.bajoPorVolumen, isFalse);
    });

    /// Un servidor viejo que todavía no manda el campo no puede romper el
    /// editor de productos.
    test('⛔ sin el campo, no explota: devuelve null', () {
      expect(DetalleDeComision.desdeJson(null), isNull);
      expect(DetalleDeComision.desdeJson('cualquier cosa'), isNull);
      expect(DetalleDeComision.desdeJson({'bps': 400}), isNull);
    });
  });

  group('Las tasas', () {
    test('traen la comisión de este vendedor y su explicación', () {
      final t = TasasDeVendox.fromJson({
        'comisionBps': 300,
        'costoDelProcesadorBps': 619,
        'comision': {
          'bps': 300,
          'etiqueta': 'Comisión VendoX Business (3%)',
          'bajoPorVolumen': true,
          'aviso': 'Tu comisión bajó por volumen de ventas.',
        },
      });

      expect(t.comisionBps, 300);
      expect(t.comision!.etiqueta, 'Comisión VendoX Business (3%)');
    });

    test('sin el detalle, la tasa sigue llegando', () {
      final t = TasasDeVendox.fromJson({'comisionBps': 350, 'costoDelProcesadorBps': 619});

      expect(t.comisionBps, 350);
      expect(t.comision, isNull);
    });

    /// ⛔ EL RESPALDO ES LA TASA BASE, NUNCA UN TRAMO.
    ///
    /// Cuando el servidor no contestó no se le supone un descuento a nadie: el
    /// desglose mostraría un neto más alto del real y el vendedor publicaría a
    /// un precio pensando que le queda más.
    test('el respaldo es la tasa base, no un tramo', () {
      expect(TasasDeVendox.porOmision.comisionBps, 400);
      expect(TasasDeVendox.porOmision.comision, isNull);
    });

    test('una respuesta vacía cae al respaldo sin romperse', () {
      final t = TasasDeVendox.fromJson({});

      expect(t.comisionBps, TasasDeVendox.porOmision.comisionBps);
      expect(t.costoDelProcesadorBps, TasasDeVendox.porOmision.costoDelProcesadorBps);
    });
  });

  group('El desglose usa la tasa que llegó', () {
    /// Sobre $100.000, la diferencia entre 4 % y 3 % es $1.000. Es la plata que
    /// el vendedor calcula mal si la app usa la tasa equivocada.
    test('con 4 % descuenta 4 %', () {
      final d = desglosarPrecio(precio: 10_000_000, comisionBps: 400, costoDelProcesadorBps: 0);

      expect(d.comision, 400_000);
      expect(d.netoEstimado, 9_600_000);
    });

    test('con 3,5 % descuenta 3,5 %', () {
      final d = desglosarPrecio(precio: 10_000_000, comisionBps: 350, costoDelProcesadorBps: 0);

      expect(d.comision, 350_000);
    });

    test('con 3 % descuenta 3 %', () {
      final d = desglosarPrecio(precio: 10_000_000, comisionBps: 300, costoDelProcesadorBps: 0);

      expect(d.comision, 300_000);
      expect(d.netoEstimado, 9_700_000);
    });

    /// El recorrido completo del caso Business: la app recibe 3,5 % y el
    /// desglose sale con 3,5 %, sin que ningún 4 % se meta en el medio.
    test('un Business con tramo ve su tasa en el desglose', () {
      final t = TasasDeVendox.fromJson({
        'comisionBps': 350,
        'costoDelProcesadorBps': 619,
        'comision': {
          'bps': 350,
          'etiqueta': 'Comisión VendoX Business (3,5%)',
          'bajoPorVolumen': true,
          'aviso': 'Tu comisión bajó por volumen de ventas.',
        },
      });

      final d = desglosarPrecio(
        precio: 10_000_000,
        comisionBps: t.comisionBps,
        costoDelProcesadorBps: t.costoDelProcesadorBps,
      );

      expect(d.comision, 350_000);
      expect(t.comision!.etiqueta, contains('3,5%'));
    });
  });
}
