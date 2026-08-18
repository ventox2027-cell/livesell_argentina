import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/state/auth_providers.dart';

/// Lo que se lleva cada uno, en puntos básicos.
class TasasDeVendox {
  const TasasDeVendox({required this.comisionBps, required this.costoDelProcesadorBps});

  /// La comisión de VendoX. 400 = 4 %.
  final int comisionBps;

  /// Estimación del costo de Mercado Pago. 619 = 6,19 %.
  final int costoDelProcesadorBps;

  /// Los mismos valores que el backend usa por omisión.
  ///
  /// Existen para un servidor viejo que todavía no mande los campos, no para
  /// ahorrarse la consulta. Un desglose con las tasas en cero le diría al
  /// vendedor que recibe el precio entero, que es peor que no mostrar nada.
  static const porOmision = TasasDeVendox(comisionBps: 400, costoDelProcesadorBps: 619);

  factory TasasDeVendox.fromJson(Map<String, dynamic> j) => TasasDeVendox(
        comisionBps: (j['comisionBps'] as num?)?.toInt() ?? porOmision.comisionBps,
        costoDelProcesadorBps:
            (j['costoDelProcesadorBps'] as num?)?.toInt() ?? porOmision.costoDelProcesadorBps,
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
