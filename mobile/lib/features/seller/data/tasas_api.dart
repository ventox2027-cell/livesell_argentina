import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/state/auth_providers.dart';

/// Cómo se explica la comisión de ESTE vendedor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA ETIQUETA VIENE ARMADA, Y NO ES PEREZA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// «Comisión VendoX (4%)» o «Comisión VendoX Business (3,5%)» las escribe el
/// servidor. La app podría armarlas con el plan y los bps, pero eso sería un
/// `switch` sobre motivos de tasa acá adentro: dos copias de la misma regla, y
/// la del teléfono desactualizada hasta que alguien publique una versión nueva.
///
/// Es exactamente el problema que ya tuvimos con las tasas escritas a mano, un
/// escalón más arriba.
class DetalleDeComision {
  const DetalleDeComision({
    required this.bps,
    required this.etiqueta,
    required this.bajoPorVolumen,
    this.aviso,
  });

  final int bps;

  /// El texto de la línea del desglose, ya formateado.
  final String etiqueta;

  /// Si esta tasa es más baja que la base por volumen de ventas.
  ///
  /// Booleano y no una comparación contra 400: la app no tiene por qué saber
  /// cuál es la tasa base para poder decir «tu comisión bajó».
  final bool bajoPorVolumen;

  /// Qué contarle al vendedor sobre su comisión, o `null` si no hay nada.
  ///
  /// `null` en el caso normal. Una pantalla que siempre dice algo sobre la
  /// comisión convierte el mensaje en decoración, y el día que haya novedades
  /// de verdad nadie lo va a leer.
  final String? aviso;

  static DetalleDeComision? desdeJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final etiqueta = json['etiqueta'] as String?;
    if (etiqueta == null) return null;

    return DetalleDeComision(
      bps: (json['bps'] as num?)?.toInt() ?? 0,
      etiqueta: etiqueta,
      bajoPorVolumen: json['bajoPorVolumen'] as bool? ?? false,
      aviso: json['aviso'] as String?,
    );
  }
}

/// Lo que se lleva cada uno, en puntos básicos.
class TasasDeVendox {
  const TasasDeVendox({
    required this.comisionBps,
    required this.costoDelProcesadorBps,
    this.comision,
  });

  /// La comisión de ESTE vendedor. 400 = 4 %.
  ///
  /// ⚠️ No es una constante del negocio: un Business con volumen paga 350 o
  /// 300. Por eso viaja en cada respuesta y no hay ningún 4 % escrito en Dart.
  final int comisionBps;

  /// Estimación del costo de Mercado Pago. 619 = 6,19 %.
  final int costoDelProcesadorBps;

  /// Cómo explicar esa comisión. `null` contra un servidor viejo.
  final DetalleDeComision? comision;

  /// Los mismos valores que el backend usa por omisión.
  ///
  /// Existen para un servidor viejo que todavía no mande los campos, no para
  /// ahorrarse la consulta. Un desglose con las tasas en cero le diría al
  /// vendedor que recibe el precio entero, que es peor que no mostrar nada.
  ///
  /// ⚠️ Es el peor lugar posible para una tasa incorrecta, así que vale
  /// repetirlo: esto NO es «la comisión de VendoX». Es el último recurso
  /// cuando el servidor no contestó, y por eso coincide con la tasa base y no
  /// con ningún tramo — nunca hay que suponerle un descuento a nadie.
  static const porOmision = TasasDeVendox(comisionBps: 400, costoDelProcesadorBps: 619);

  factory TasasDeVendox.fromJson(Map<String, dynamic> j) => TasasDeVendox(
        comisionBps: (j['comisionBps'] as num?)?.toInt() ?? porOmision.comisionBps,
        costoDelProcesadorBps:
            (j['costoDelProcesadorBps'] as num?)?.toInt() ?? porOmision.costoDelProcesadorBps,
        comision: DetalleDeComision.desdeJson(j['comision']),
      );
}

/// Las tasas con las que se arma el desglose del precio.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// VIENEN DEL SERVIDOR, NO ESCRITAS ACÁ
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El editor recalcula el desglose en cada tecla, sin ir al servidor: la
/// OPERACIÓN se copia porque no hay alternativa razonable. Las TASAS no.
///
/// Ya pasó una vez: la pantalla de políticas tenía 600 y 619 escritos a mano y
/// daba bien de casualidad, porque coincidían con los del servidor. El día que
/// la comisión bajó a 4 %, ese ejemplo habría seguido mostrando 6 % sin que
/// nada fallara ni avisara.
///
/// Con `keepAlive` se pide una vez por sesión. Cambian una vez por trimestre;
/// pedirlas cada vez que se abre el editor sería un viaje por formulario.
final tasasProvider = FutureProvider<TasasDeVendox>((ref) async {
  ref.keepAlive();

  final api = ref.watch(apiClientProvider);
  final res = await api.get<Map<String, dynamic>>('/stores/me');

  if (res.statusCode != 200 || res.data == null) {
    // Sin tasas no se muestra un desglose equivocado: se muestra el de por
    // omisión, que es el del negocio. La pantalla igual aclara que el costo del
    // procesador es estimado.
    return TasasDeVendox.porOmision;
  }

  return TasasDeVendox.fromJson(res.data!);
});
