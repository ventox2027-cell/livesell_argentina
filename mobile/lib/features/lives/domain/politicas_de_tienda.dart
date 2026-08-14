/// Lo que la tienda promete: cuánto sale el envío y qué pasa si no le gusta.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// TODOS LOS TEXTOS VIENEN DEL BACKEND
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Esta clase no arma frases: las recibe. Es deliberado.
///
/// El texto de la política tiene efecto legal, y tiene que decir exactamente lo
/// mismo en la app, en el detalle del pedido y en el mail. Tres textos escritos
/// por separado terminan diciendo tres cosas distintas, y ante una diferencia,
/// la que vale es la más favorable al comprador — o sea, siempre perdemos.
///
/// Lo mismo con `permiteRetiro` y `costo`: la app no reimplementa las reglas de
/// qué modo permite qué. Las recibe calculadas. El día que aparezca un modo
/// nuevo, la app no se entera y sigue funcionando.
library;

/// Cómo cobra el envío esta tienda.
class PoliticaDeEnvio {
  const PoliticaDeEnvio({
    required this.modo,
    required this.costo,
    required this.etiqueta,
    required this.permiteEnvio,
    required this.permiteRetiro,
    required this.trasladaCostoDelProcesador,
    this.nota,
  });

  /// Lectura defensiva: si el bloque falta —una versión vieja del backend, o un
  /// cuerpo de error que se coló— se asume envío gratis y sin retiro. Es lo que
  /// menos sorprende: nadie ve un costo que no existe y nadie ofrece un retiro
  /// que la tienda no hace.
  factory PoliticaDeEnvio.fromJson(Map<String, dynamic>? j) {
    if (j == null) return const PoliticaDeEnvio.desconocida();

    return PoliticaDeEnvio(
      modo: j['modo'] as String? ?? 'FREE',
      costo: (j['costo'] as num?)?.toInt() ?? 0,
      etiqueta: j['etiqueta'] as String? ?? 'Envío',
      permiteEnvio: j['permiteEnvio'] as bool? ?? true,
      permiteRetiro: j['permiteRetiro'] as bool? ?? false,
      trasladaCostoDelProcesador: j['trasladaCostoDelProcesador'] as bool? ?? false,
      nota: j['nota'] as String?,
    );
  }

  const PoliticaDeEnvio.desconocida()
      : modo = 'FREE',
        costo = 0,
        etiqueta = 'Envío',
        permiteEnvio = true,
        permiteRetiro = false,
        trasladaCostoDelProcesador = false,
        nota = null;

  final String modo;

  /// Cuánto sale el envío a domicilio, en centavos.
  final int costo;

  /// "Envío gratis", "Envío", "Retiro en persona". Lo escribe el backend.
  final String etiqueta;

  final bool permiteEnvio;
  final bool permiteRetiro;

  /// Si al total se le va a sumar el costo del medio de pago.
  ///
  /// Se avisa ANTES de llegar al checkout: un recargo que aparece recién con la
  /// tarjeta en la mano se siente como algo escondido, aunque esté explicado.
  final bool trasladaCostoDelProcesador;

  /// "Envíos los martes y jueves", "Retiro por Palermo". Del vendedor.
  final String? nota;

  /// ¿Hay algo que elegir, o hay una sola forma de recibirlo?
  bool get hayQueElegir => permiteEnvio && permiteRetiro;

  bool get esGratis => permiteEnvio && costo == 0;
}

/// Cambios y devoluciones.
class PoliticaDeCambios {
  const PoliticaDeCambios({
    required this.modo,
    required this.dias,
    required this.titulo,
    required this.lineas,
    required this.derechoDeArrepentimiento,
  });

  /// Si el bloque falta, se muestra sólo el derecho legal.
  ///
  /// Nunca se cae al vacío: el derecho de arrepentimiento existe siempre, y una
  /// pantalla que no lo muestre porque el JSON vino raro es exactamente lo que
  /// la Resolución 424/2020 no permite.
  factory PoliticaDeCambios.fromJson(Map<String, dynamic>? j) {
    final resumen = j?['resumen'] as Map<String, dynamic>?;
    final lineas = (resumen?['lineas'] as List<dynamic>? ?? const [])
        .map((e) => e as String? ?? '')
        .where((s) => s.isNotEmpty)
        .toList();

    return PoliticaDeCambios(
      modo: j?['modo'] as String? ?? 'SOLO_LEGAL',
      dias: (j?['dias'] as num?)?.toInt() ?? 10,
      titulo: resumen?['titulo'] as String? ?? 'Cambios y devoluciones',
      lineas: lineas,
      derechoDeArrepentimiento:
          resumen?['derechoDeArrepentimiento'] as String? ?? _arrepentimientoPorOmision,
    );
  }

  /// El texto mínimo, para cuando el backend no lo mandó.
  ///
  /// Copiado del backend a propósito y no inventado: si algún día cambia la
  /// redacción allá, esto queda viejo, pero sigue diciendo algo cierto. Un
  /// respaldo que diga menos de lo que la ley da sería peor que no tener nada.
  static const _arrepentimientoPorOmision =
      'Tenés 10 días corridos desde que recibís el producto para arrepentirte de '
      'la compra, sin dar motivos y sin costo. Es un derecho que te da la ley y '
      'no depende del vendedor.';

  final String modo;

  /// Los días que valen de verdad, con el piso legal ya aplicado.
  final int dias;

  final String titulo;

  /// Lo que ofrece esta tienda, línea por línea.
  final List<String> lineas;

  /// El derecho legal. Se muestra SIEMPRE, elija lo que elija el vendedor.
  final String derechoDeArrepentimiento;

  /// ¿Ofrece algo más que el mínimo legal?
  ///
  /// Sirve para destacarlo: una tienda que da treinta días de devolución sin
  /// causa está compitiendo con eso y merece que se vea.
  bool get ofreceMasQueElMinimo => modo != 'SOLO_LEGAL' || dias > 10;
}
