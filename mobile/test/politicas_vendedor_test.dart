import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/seller/domain/politicas_models.dart';
import 'package:vendox/features/seller/domain/seller_models.dart' show porcentajeLegible;

/// Las reglas del formulario de políticas del vendedor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA VALIDACIÓN QUE MANDA NO ES ESTA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El piso legal lo imponen el backend y un CHECK de la base. Lo de acá sirve
/// para otra cosa: que la pantalla no deje al vendedor mandar algo que va a
/// volver rechazado, y sobre todo que no le OFREZCA una opción imposible.
///
/// La diferencia importa. Si el formulario permite elegir "el envío de vuelta
/// lo paga el comprador" con arrepentimiento puro, el vendedor lo elige, toca
/// guardar, y recibe un error que parece un capricho nuestro. Que la opción
/// directamente no exista es la única forma de que no se sienta así.
void main() {
  group('Modo de envío', () {
    test('cambiar a un modo sin envío pone el monto en cero', () {
      /**
       * Un monto guardado con modo "gratis" es una combinación que el backend y
       * la base rechazan. Peor: si el vendedor vuelve a "costo fijo" más tarde,
       * un monto viejo escondido reaparecería y le cobraría a alguien un envío
       * que no eligió.
       */
      const conCosto = PoliticaDeEnvioEditable(
        modo: ModoDeEnvio.fixedPrice,
        montoFijo: 350000,
        trasladaCostoDelProcesador: false,
      );

      expect(conCosto.copiarCon(modo: ModoDeEnvio.free).montoFijo, 0);
      expect(conCosto.copiarCon(modo: ModoDeEnvio.pickupOnly).montoFijo, 0);
    });

    test('los modos que cobran conservan el monto', () {
      const p = PoliticaDeEnvioEditable(
        modo: ModoDeEnvio.fixedPrice,
        montoFijo: 350000,
        trasladaCostoDelProcesador: false,
      );
      expect(p.copiarCon(modo: ModoDeEnvio.fixedOrPickup).montoFijo, 350000);
    });

    test('⛔ cobrar envío sin monto no se puede guardar', () {
      const sinMonto = PoliticaDeEnvioEditable(
        modo: ModoDeEnvio.fixedPrice,
        montoFijo: 0,
        trasladaCostoDelProcesador: false,
      );
      expect(sinMonto.esValida, isFalse);
    });

    test('no cobrar envío con monto cero sí se puede', () {
      const gratis = PoliticaDeEnvioEditable(
        modo: ModoDeEnvio.free,
        montoFijo: 0,
        trasladaCostoDelProcesador: false,
      );
      expect(gratis.esValida, isTrue);
    });

    test('un modo desconocido del backend cae en el más inocuo', () {
      // Es el único que no le cobra de más a nadie por un valor mal leído. Un
      // modo nuevo del servidor no puede hacer que la app cobre un envío que
      // no entiende.
      expect(ModoDeEnvio.desde('MODO_QUE_NO_EXISTE'), ModoDeEnvio.free);
      expect(ModoDeEnvio.desde(null), ModoDeEnvio.free);
    });

    test('los nombres que se mandan son los que espera el backend', () {
      // Un nombre mal escrito acá se ve como un 400 sin explicación.
      expect(ModoDeEnvio.free.name, 'FREE');
      expect(ModoDeEnvio.fixedPrice.name, 'FIXED_PRICE');
      expect(ModoDeEnvio.pickupOnly.name, 'PICKUP_ONLY');
      expect(ModoDeEnvio.fixedOrPickup.name, 'FIXED_OR_PICKUP');
    });

    test('lee lo que devuelve el backend', () {
      final p = PoliticaDeEnvioEditable.fromJson(const {
        'shippingMode': 'FIXED_OR_PICKUP',
        'shippingFlatAmount': 350000,
        'shippingNote': 'Martes y jueves',
        'processorFeeMode': 'PASSED_TO_BUYER',
      });

      expect(p.modo, ModoDeEnvio.fixedOrPickup);
      expect(p.montoFijo, 350000);
      expect(p.nota, 'Martes y jueves');
      expect(p.trasladaCostoDelProcesador, isTrue);
    });
  });

  group('Cambios y devoluciones', () {
    const soloLegal = PoliticaDeCambiosEditable(
      modo: ModoDeCambios.soloLegal,
      dias: 10,
      envioDeVueltaLoPagaElVendedor: true,
    );

    test('⛔ menos de diez días no se puede guardar', () {
      for (final dias in [0, 3, 9]) {
        expect(soloLegal.copiarCon(dias: dias).esValida, isFalse, reason: '$dias días');
      }
    });

    test('diez o más sí', () {
      for (final dias in [10, 30, 365]) {
        expect(soloLegal.copiarCon(dias: dias).esValida, isTrue, reason: '$dias días');
      }
    });

    test('un número absurdo tampoco: es un cero de más', () {
      expect(soloLegal.copiarCon(dias: 3650).esValida, isFalse);
    });

    test('⛔ el arrepentimiento puro fuerza que el envío lo pague el vendedor', () {
      /**
       * Art. 34 de la ley 24.240: la revocación es "sin costo alguno" para el
       * comprador. La pantalla no ofrece la opción contraria, y si de alguna
       * forma llegara marcada, cambiar a este modo la corrige sola.
       */
      const ofreceMas = PoliticaDeCambiosEditable(
        modo: ModoDeCambios.devolucionSinCausa,
        dias: 30,
        envioDeVueltaLoPagaElVendedor: false,
      );

      final vueltaAlMinimo = ofreceMas.copiarCon(modo: ModoDeCambios.soloLegal);
      expect(vueltaAlMinimo.envioDeVueltaLoPagaElVendedor, isTrue);
      expect(vueltaAlMinimo.puedeElegirQuienPagaElEnvio, isFalse);
    });

    test('ofreciendo más que el mínimo sí puede elegir quién paga', () {
      // Ya no es arrepentimiento: es un servicio adicional que está regalando,
      // y puede poner sus condiciones.
      final p = soloLegal.copiarCon(modo: ModoDeCambios.cambioSinCausa);
      expect(p.puedeElegirQuienPagaElEnvio, isTrue);
      expect(p.copiarCon(envioDeVueltaLoPagaElVendedor: false).envioDeVueltaLoPagaElVendedor,
          isFalse);
    });

    test('el mínimo legal declarado es el de la ley 24.240', () {
      expect(PoliticaDeCambiosEditable.diasMinimosLegales, 10);
    });

    test('un modo desconocido cae en el mínimo legal', () {
      // El mínimo legal no es "nada": son diez días. Caer ahí ante un valor que
      // la app no entiende es el lado seguro del error.
      expect(ModoDeCambios.desde('LO_QUE_SEA'), ModoDeCambios.soloLegal);
      expect(ModoDeCambios.desde(null), ModoDeCambios.soloLegal);
    });

    test('lee lo que devuelve el backend', () {
      final p = PoliticaDeCambiosEditable.fromJson(const {
        'exchangeMode': 'CAMBIO_SIN_CAUSA',
        'exchangeWindowDays': 30,
        'returnShippingPaidBy': 'COMPRADOR',
        'exchangeNote': 'Con la etiqueta puesta.',
      });

      expect(p.modo, ModoDeCambios.cambioSinCausa);
      expect(p.dias, 30);
      expect(p.envioDeVueltaLoPagaElVendedor, isFalse);
      expect(p.nota, 'Con la etiqueta puesta.');
    });

    test('un JSON sin los campos cae en el mínimo legal, no en cero', () {
      // Si el backend no los manda —una versión vieja, un cuerpo de error que
      // se coló— el formulario no puede mostrar "0 días para devolver".
      final p = PoliticaDeCambiosEditable.fromJson(const {});
      expect(p.dias, PoliticaDeCambiosEditable.diasMinimosLegales);
      expect(p.modo, ModoDeCambios.soloLegal);
      expect(p.envioDeVueltaLoPagaElVendedor, isTrue);
      expect(p.esValida, isTrue);
    });
  });

  group('Las tasas del ejemplo vienen del servidor', () {
    /**
     * El ejemplo de «cuánto va a ver quien compre» tenía las dos tasas escritas
     * a mano en el Dart: 600 puntos básicos de comisión y 619 de costo del
     * procesador. Son los mismos valores que el backend usa por omisión, así
     * que el número daba bien — de casualidad.
     *
     * El día que alguien mueva `VENDOX_PLATFORM_FEE_BPS` en el servidor, el
     * vendedor sigue leyendo «6 %» y una resta que ya no es la suya. Nada
     * falla, nada avisa: la pantalla miente con seguridad.
     *
     * Por eso las tasas viajan en el mismo payload que el resto de la política.
     */
    test('lee la comisión y el costo del procesador del JSON', () {
      final p = PoliticaDeEnvioEditable.fromJson(const {
        'shippingMode': 'FREE',
        'comisionBps': 450,
        'costoDelProcesadorBps': 700,
      });

      expect(p.comisionBps, 450);
      expect(p.costoDelProcesadorBps, 700);
    });

    test('sin los campos usa los mismos valores que el backend por omisión', () {
      // Un servidor viejo que todavía no los manda no puede dejar el ejemplo en
      // cero: «Comisión de VendoX (0 %)» es peor que una estimación vieja.
      final p = PoliticaDeEnvioEditable.fromJson(const {'shippingMode': 'FREE'});

      expect(p.comisionBps, 600);
      expect(p.costoDelProcesadorBps, 619);
    });

    test('copiarCon no las pierde al tocar otra cosa', () {
      // El formulario reconstruye el objeto en cada tecla. Si `copiarCon` las
      // dejara caer, el ejemplo volvería al valor por omisión mientras el
      // vendedor escribe el monto del envío.
      final p = PoliticaDeEnvioEditable.fromJson(const {
        'shippingMode': 'FIXED_PRICE',
        'shippingFlatAmount': 350000,
        'comisionBps': 450,
        'costoDelProcesadorBps': 700,
      });

      final tocada = p.copiarCon(montoFijo: 500000);
      expect(tocada.comisionBps, 450);
      expect(tocada.costoDelProcesadorBps, 700);
    });
  });

  group('Porcentaje legible', () {
    test('una tasa redonda no muestra decimales de relleno', () {
      // «6,00 %» se lee como si la tasa tuviera una precisión que no tiene.
      expect(porcentajeLegible(600), '6');
    });

    test('una tasa con decimales los muestra, con coma', () {
      expect(porcentajeLegible(619), '6,19');
      // Con punto sería un número de otro país justo donde se habla de plata.
      expect(porcentajeLegible(619), isNot(contains('.')));
    });

    test('una tasa no redonda lleva los dos decimales', () {
      // 450 puntos básicos es 4,5 %, y se muestra «4,50». Dos decimales fijos
      // es lo que se espera de una cifra de dinero.
      expect(porcentajeLegible(450), '4,50');
    });
  });
}
