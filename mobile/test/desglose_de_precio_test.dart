import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/seller/data/tasas_api.dart';
import 'package:vendox/features/seller/domain/desglose_de_precio.dart';

/// Lo que el vendedor ve antes de publicar.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// QUÉ PROTEGE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El argumento comercial de VendoX es «te mostramos cuánto vas a pagar y
/// cuánto estimamos que vas a recibir, sin costos escondidos». Un número mal
/// calculado acá no es un bug de presentación: es esa promesa rota, y encima
/// del lado en que más se nota.
void main() {
  // Las tasas reales del negocio. Se escriben acá para que el test falle si
  // alguien cambia la aritmética, no si cambia la tasa: las tasas se pasan
  // siempre explícitas, como hace la pantalla con las que le manda el servidor.
  const comision = 400; // 4 %
  const procesador = 619; // 6,19 % estimado

  group('Desglose', () {
    test(r'sobre $100.000 da los números del negocio', () {
      final d = desglosarPrecio(
        precio: 10000000, // $100.000
        comisionBps: comision,
        costoDelProcesadorBps: procesador,
      );

      expect(d.comision, 400000); // $4.000
      expect(d.costoDelProcesador, 619000); // $6.190
      expect(d.netoEstimado, 8981000); // $89.810
    });

    test('las tres partes suman el precio', () {
      // El invariante que hace que el desglose sea creíble: si no cierra, la
      // persona ve tres números que no dan la cuenta y deja de confiar.
      for (final precio in [100, 12345, 890000, 10000000, 999999999]) {
        final d = desglosarPrecio(
          precio: precio,
          comisionBps: comision,
          costoDelProcesadorBps: procesador,
        );
        expect(
          d.comision + d.costoDelProcesador + d.netoEstimado,
          precio,
          reason: 'no cierra con $precio',
        );
      }
    });

    test('un precio vacío o cero no inventa números', () {
      // Mientras la persona todavía no escribió nada.
      for (final precio in [0, -1]) {
        final d = desglosarPrecio(
          precio: precio,
          comisionBps: comision,
          costoDelProcesadorBps: procesador,
        );
        expect(d.comision, 0);
        expect(d.costoDelProcesador, 0);
        expect(d.netoEstimado, 0);
      }
    });

    test('el redondeo es el mismo que el del backend', () {
      // `Math.floor((monto * bps + 5000) / 10000)` en TypeScript.
      expect(porcentajeDe(99999, 600), 6000);
      expect(porcentajeDe(833, 600), 50);
      expect(porcentajeDe(1, 600), 0); // 0,06 centavos → 0
      expect(porcentajeDe(9, 600), 1); // 0,54 → 1
    });
  });

  group('¿Cuánto querés recibir?', () {
    test(r'sugiere un precio para recibir $100.000', () {
      final p = precioParaRecibir(
        neto: 10000000,
        comisionBps: comision,
        costoDelProcesadorBps: procesador,
      );

      expect(p, isNotNull);
      // Con 10,19 % de costos: 100.000 / 0,8981 ≈ 111.346.
      expect(p! ~/ 100, inInclusiveRange(111000, 111500));
    });

    test('⛔ la ida y la vuelta cierran: nunca queda por debajo', () {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * EL TEST QUE HACE QUE ESTA FUNCIÓN VALGA LA PENA
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Si alguien pide recibir $100.000, ve «publicá a $111.350», acepta, y el
       * desglose de la misma pantalla le dice que va a recibir $99.998, la
       * herramienta destruye la confianza que vino a construir.
       *
       * Se prueba sobre un rango amplio, no sobre un caso lindo: el error de
       * redondeo aparece en valores que nadie elegiría a mano.
       */
      for (var neto = 100; neto <= 50000000; neto += 997) {
        final p = precioParaRecibir(
          neto: neto,
          comisionBps: comision,
          costoDelProcesadorBps: procesador,
        );
        expect(p, isNotNull, reason: 'sin precio para $neto');

        final d = desglosarPrecio(
          precio: p!,
          comisionBps: comision,
          costoDelProcesadorBps: procesador,
        );
        expect(
          d.netoEstimado,
          greaterThanOrEqualTo(neto),
          reason: 'pidió $neto y recibiría ${d.netoEstimado}',
        );
      }
    });

    test('no se pasa de generoso: el precio sugerido es el mínimo que sirve', () {
      // La contraparte. Sin esto, una función que devolviera el doble pasaría
      // el test de arriba y le haría publicar caro a todo el mundo.
      for (final neto in [10000, 500000, 10000000]) {
        final p = precioParaRecibir(
          neto: neto,
          comisionBps: comision,
          costoDelProcesadorBps: procesador,
        )!;

        final unoMenos = desglosarPrecio(
          precio: p - 1,
          comisionBps: comision,
          costoDelProcesadorBps: procesador,
        );
        expect(
          unoMenos.netoEstimado,
          lessThan(neto),
          reason: 'con un centavo menos también alcanzaba: $p no es el mínimo',
        );
      }
    });

    test('sin neto no hay sugerencia', () {
      expect(precioParaRecibir(neto: 0, comisionBps: comision, costoDelProcesadorBps: procesador),
          isNull);
    });

    test('⛔ si las tasas se comen todo, lo dice en vez de inventar', () {
      // No puede pasar con las tasas reales, pero un valor mal configurado no
      // puede producir un precio absurdo en la pantalla de alguien.
      expect(
        precioParaRecibir(neto: 10000, comisionBps: 5000, costoDelProcesadorBps: 5000),
        isNull,
      );
    });
  });

  group('Las tasas vienen del servidor', () {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * ESTE BUG YA PASÓ UNA VEZ
     * ═════════════════════════════════════════════════════════════════════════
     *
     * La pantalla de políticas tenía 600 y 619 escritos a mano en el Dart.
     * Daban bien de casualidad porque coincidían con los del servidor, y el día
     * que la comisión bajó a 4 % ese ejemplo habría seguido mostrando 6 % sin
     * que nada fallara ni avisara.
     *
     * La app copia la OPERACIÓN —el desglose se recalcula en cada tecla— pero
     * nunca las TASAS.
     */
    test('las lee del JSON', () {
      final t = TasasDeVendox.fromJson(const {
        'comisionBps': 250,
        'costoDelProcesadorBps': 1000,
      });

      expect(t.comisionBps, 250);
      expect(t.costoDelProcesadorBps, 1000);
    });

    test('sin los campos usa las del negocio, no cero', () {
      // Un servidor viejo que todavía no los mande. Con las tasas en cero el
      // desglose le diría al vendedor que recibe el precio entero, que es peor
      // que no mostrar nada.
      final t = TasasDeVendox.fromJson(const {});

      expect(t.comisionBps, 400);
      expect(t.costoDelProcesadorBps, 619);
    });
  });
}
