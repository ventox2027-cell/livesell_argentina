/// Las políticas de la tienda, del lado del vendedor.
///
/// Separadas de `features/lives/domain/politicas_de_tienda.dart`, que es lo que
/// ve quien COMPRA. No son el mismo objeto: al comprador le llega el texto ya
/// escrito y los derivados calculados, al vendedor le llegan los campos crudos
/// que puede editar.
///
/// Fundirlas obligaría a que el modelo del comprador cargara campos que sólo
/// tienen sentido en el formulario del vendedor, y a que el formulario dependa
/// de textos que sólo se arman para mostrar.
library;

enum ModoDeEnvio {
  /// Envío sin costo para quien compra.
  free,

  /// Un monto fijo, siempre el mismo.
  fixedPrice,

  /// No hay envío: se busca en persona.
  pickupOnly,

  /// Las dos, y quien compra elige.
  fixedOrPickup;

  /// El nombre que espera el backend.
  String get name => switch (this) {
        ModoDeEnvio.free => 'FREE',
        ModoDeEnvio.fixedPrice => 'FIXED_PRICE',
        ModoDeEnvio.pickupOnly => 'PICKUP_ONLY',
        ModoDeEnvio.fixedOrPickup => 'FIXED_OR_PICKUP',
      };

  static ModoDeEnvio desde(String? valor) => switch (valor) {
        'FIXED_PRICE' => ModoDeEnvio.fixedPrice,
        'PICKUP_ONLY' => ModoDeEnvio.pickupOnly,
        'FIXED_OR_PICKUP' => ModoDeEnvio.fixedOrPickup,
        // Un modo que la app no conoce cae en el más inocuo: envío gratis. Es
        // el único que no le cobra de más a nadie por un valor mal leído.
        _ => ModoDeEnvio.free,
      };

  String get titulo => switch (this) {
        ModoDeEnvio.free => 'Envío gratis',
        ModoDeEnvio.fixedPrice => 'Costo fijo',
        ModoDeEnvio.pickupOnly => 'Sólo retiro en persona',
        ModoDeEnvio.fixedOrPickup => 'Envío o retiro',
      };

  String get explicacion => switch (this) {
        ModoDeEnvio.free => 'Vos pagás el envío. Se ve como "Envío gratis".',
        ModoDeEnvio.fixedPrice => 'Se le suma al total. Siempre el mismo monto.',
        ModoDeEnvio.pickupOnly => 'Coordinás la entrega por chat. No hay costo de envío.',
        ModoDeEnvio.fixedOrPickup => 'Quien compra elige, y ve el precio de cada opción.',
      };

  bool get necesitaMonto => this == ModoDeEnvio.fixedPrice || this == ModoDeEnvio.fixedOrPickup;
}

class PoliticaDeEnvioEditable {
  const PoliticaDeEnvioEditable({
    required this.modo,
    required this.montoFijo,
    required this.trasladaCostoDelProcesador,
    this.nota,
    this.recargoDisponible = false,
    this.comisionBps = 400,
    this.costoDelProcesadorBps = 619,
  });

  factory PoliticaDeEnvioEditable.fromJson(Map<String, dynamic> j) => PoliticaDeEnvioEditable(
        modo: ModoDeEnvio.desde(j['shippingMode'] as String?),
        montoFijo: (j['shippingFlatAmount'] as num?)?.toInt() ?? 0,
        nota: j['shippingNote'] as String?,
        trasladaCostoDelProcesador: j['processorFeeMode'] == 'PASSED_TO_BUYER',
        recargoDisponible: j['recargoAlCompradorDisponible'] as bool? ?? false,
        comisionBps: (j['comisionBps'] as num?)?.toInt() ?? 400,
        costoDelProcesadorBps: (j['costoDelProcesadorBps'] as num?)?.toInt() ?? 619,
      );

  final ModoDeEnvio modo;

  /// En centavos, como todo el dinero del proyecto.
  final int montoFijo;

  final String? nota;

  /// Si el costo de Mercado Pago se le suma al comprador.
  ///
  /// El costo es del vendedor de todas formas: esto sólo decide si lo absorbe o
  /// lo traslada.
  final bool trasladaCostoDelProcesador;

  /// Si ESTE servidor permite trasladarlo. Apagado en la beta.
  ///
  /// La opcion se muestra deshabilitada y no oculta: el vendedor que ya la
  /// tenia elegida tiene que poder ver que paso con su configuracion, no
  /// encontrarse con que desaparecio.
  final bool recargoDisponible;

  /// La comisión de ESTE vendedor, en puntos básicos. 400 = 4 %.
  ///
  /// Viene del servidor, no escrita a mano acá: es el número con el que la
  /// pantalla arma el ejemplo, y si la tasa cambia el ejemplo tiene que cambiar
  /// con ella.
  ///
  /// ⚠️ Ya no es una constante del negocio. Un Business con volumen paga 350 o
  /// 300, así que el mismo campo trae valores distintos según quién pregunte.
  /// El respaldo de 400 es la tasa BASE: ante un servidor que no contestó, no
  /// se le supone un descuento a nadie.
  ///
  /// Este valor decía 600 —la comisión vieja— hasta que la tasa bajó a 4 %. No
  /// rompió nada y nadie se enteró, porque un respaldo sólo se usa cuando el
  /// servidor falla. Es exactamente por eso que conviene que sea el correcto.
  final int comisionBps;

  /// Estimación del costo de Mercado Pago, en puntos básicos.
  ///
  /// Es aproximada y la pantalla lo aclara: la tasa real la informan ellos
  /// después de cobrar y depende del plazo de acreditación y del medio de pago.
  final int costoDelProcesadorBps;

  PoliticaDeEnvioEditable copiarCon({
    ModoDeEnvio? modo,
    int? montoFijo,
    String? nota,
    bool? trasladaCostoDelProcesador,
  }) =>
      PoliticaDeEnvioEditable(
        modo: modo ?? this.modo,
        // Los modos que no cobran envío tienen que ir con monto cero: el
        // backend y la base rechazan la combinación incoherente, y es mejor no
        // dejar que el formulario llegue a mandarla.
        montoFijo: (modo ?? this.modo).necesitaMonto ? (montoFijo ?? this.montoFijo) : 0,
        nota: nota ?? this.nota,
        trasladaCostoDelProcesador: trasladaCostoDelProcesador ?? this.trasladaCostoDelProcesador,
        recargoDisponible: recargoDisponible,
        comisionBps: comisionBps,
        costoDelProcesadorBps: costoDelProcesadorBps,
      );

  /// ¿Se puede guardar tal como está?
  ///
  /// Repite la regla del backend a propósito: acá sirve para deshabilitar el
  /// botón antes de que la persona lo toque, en vez de dejarla mandar algo que
  /// va a volver con un error.
  bool get esValida => !modo.necesitaMonto || montoFijo > 0;
}

enum ModoDeCambios {
  /// Sólo lo que obliga la ley. Que no es "nada": son diez días.
  soloLegal,

  /// Cambia por otro talle o color dentro del plazo.
  cambioSinCausa,

  /// Devuelve la plata dentro del plazo, sin pedir motivo.
  devolucionSinCausa;

  String get name => switch (this) {
        ModoDeCambios.soloLegal => 'SOLO_LEGAL',
        ModoDeCambios.cambioSinCausa => 'CAMBIO_SIN_CAUSA',
        ModoDeCambios.devolucionSinCausa => 'DEVOLUCION_SIN_CAUSA',
      };

  static ModoDeCambios desde(String? valor) => switch (valor) {
        'CAMBIO_SIN_CAUSA' => ModoDeCambios.cambioSinCausa,
        'DEVOLUCION_SIN_CAUSA' => ModoDeCambios.devolucionSinCausa,
        _ => ModoDeCambios.soloLegal,
      };

  String get titulo => switch (this) {
        ModoDeCambios.soloLegal => 'Lo que dice la ley',
        ModoDeCambios.cambioSinCausa => 'Cambio por otro talle o color',
        ModoDeCambios.devolucionSinCausa => 'Devolución del dinero',
      };

  String get explicacion => switch (this) {
        ModoDeCambios.soloLegal =>
          'Diez días para arrepentirse, que es el mínimo legal en Argentina.',
        ModoDeCambios.cambioSinCausa => 'Además del mínimo legal, aceptás cambios sin motivo.',
        ModoDeCambios.devolucionSinCausa =>
          'Además del mínimo legal, devolvés la plata sin pedir motivos.',
      };
}

class PoliticaDeCambiosEditable {
  const PoliticaDeCambiosEditable({
    required this.modo,
    required this.dias,
    required this.envioDeVueltaLoPagaElVendedor,
    this.nota,
  });

  factory PoliticaDeCambiosEditable.fromJson(Map<String, dynamic> j) => PoliticaDeCambiosEditable(
        modo: ModoDeCambios.desde(j['exchangeMode'] as String?),
        dias: (j['exchangeWindowDays'] as num?)?.toInt() ?? diasMinimosLegales,
        envioDeVueltaLoPagaElVendedor: j['returnShippingPaidBy'] != 'COMPRADOR',
        nota: j['exchangeNote'] as String?,
      );

  /// El piso que fija la ley 24.240 para compras a distancia. **No negociable.**
  ///
  /// Está acá además de en el backend para poder decirlo en la pantalla, no
  /// para validar: la validación que manda es la del servidor y la de la base.
  static const diasMinimosLegales = 10;
  static const diasMaximos = 365;

  final ModoDeCambios modo;
  final int dias;
  final bool envioDeVueltaLoPagaElVendedor;
  final String? nota;

  PoliticaDeCambiosEditable copiarCon({
    ModoDeCambios? modo,
    int? dias,
    bool? envioDeVueltaLoPagaElVendedor,
    String? nota,
  }) {
    final nuevoModo = modo ?? this.modo;
    return PoliticaDeCambiosEditable(
      modo: nuevoModo,
      dias: dias ?? this.dias,
      /**
       * El arrepentimiento puro es "sin costo alguno" para el comprador —art.
       * 34 de la ley 24.240—, así que el envío de vuelta lo paga el vendedor.
       *
       * Se fuerza acá al cambiar de modo en vez de dejar que el backend lo
       * rechace: si la pantalla permitiera elegirlo, el vendedor tocaría una
       * opción imposible y recibiría un error que parece un capricho nuestro.
       */
      envioDeVueltaLoPagaElVendedor: nuevoModo == ModoDeCambios.soloLegal
          ? true
          : (envioDeVueltaLoPagaElVendedor ?? this.envioDeVueltaLoPagaElVendedor),
      nota: nota ?? this.nota,
    );
  }

  bool get esValida => dias >= diasMinimosLegales && dias <= diasMaximos;

  /// ¿Puede elegir quién paga el envío de vuelta?
  ///
  /// Sólo si ofrece MÁS que el mínimo: ahí ya no es arrepentimiento sino un
  /// servicio adicional que está regalando, y puede poner sus condiciones.
  bool get puedeElegirQuienPagaElEnvio => modo != ModoDeCambios.soloLegal;
}
