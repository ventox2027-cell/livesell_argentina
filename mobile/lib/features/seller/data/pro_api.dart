import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../auth/state/auth_providers.dart';

/// VendoX Pro y los cupones, desde la app.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// NO HAY NADA ACÁ QUE COBRE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Y no es que falte: el backend tampoco tiene un endpoint para contratar. La
/// membresía está desacoplada del cobro a propósito —cada tienda de
/// aplicaciones tiene sus reglas sobre bienes digitales y elegir mal significa
/// reescribir o que rechacen la app—, así que hoy Pro se otorga desde el panel
/// de administración.
///
/// Cuando exista cobro, se agrega un método acá y nada más de este archivo
/// cambia.

/// El plan vigente del vendedor.
class MiMembresia {
  const MiMembresia({
    required this.plan,
    required this.beneficios,
    required this.cuponesActivosPermitidos,
    this.vigenteHasta,
    this.diasRestantes,
    this.origen = 'GRATIS',
  });

  factory MiMembresia.fromJson(Map<String, dynamic> j) {
    final limites = j['limites'] as Map<String, dynamic>? ?? const {};

    return MiMembresia(
      plan: j['plan'] as String? ?? 'FREE',
      beneficios: (j['beneficios'] as List<dynamic>? ?? const [])
          .map((e) => e.toString())
          .toList(growable: false),
      cuponesActivosPermitidos: (limites['cuponesActivos'] as num?)?.toInt() ?? 0,
      vigenteHasta: DateTime.tryParse(j['vigenteHasta'] as String? ?? ''),
      diasRestantes: (j['diasRestantes'] as num?)?.toInt(),
      origen: j['origen'] as String? ?? 'GRATIS',
    );
  }

  final String plan;
  final List<String> beneficios;
  final int cuponesActivosPermitidos;

  /// `null` en Free: no vence.
  final DateTime? vigenteHasta;

  /// Cuántos días le quedan. `null` en Free.
  ///
  /// Lo calcula el servidor. La app **no** lo deriva de [vigenteHasta]: el
  /// reloj del teléfono se puede haber quedado atrasado, y una cuenta regresiva
  /// que no coincide con la del backend es peor que ninguna.
  final int? diasRestantes;

  /// De dónde salió: `GRATIS`, `CORTESIA`, `PRUEBA` o `PAGO`.
  ///
  /// El vendedor tiene derecho a saberlo: alguien con Pro de cortesía que cree
  /// que lo está pagando no entiende por qué le vence.
  final String origen;

  bool get esPro => plan == 'PRO';
  bool get puedeUsarCupones => beneficios.contains('CUPONES');
  bool get puedeVerAnalitica => beneficios.contains('ANALITICA_AVANZADA');

  /// Si conviene avisarle que está por vencer. El umbral es el mismo que usa
  /// el backend para mandar el aviso.
  bool get venceProximo => diasRestantes != null && diasRestantes! <= 7;
}

/// Un cupón del vendedor.
class Cupon {
  const Cupon({
    required this.id,
    required this.codigo,
    required this.tipo,
    required this.valor,
    required this.usos,
    required this.activo,
    this.minimoCentavos,
    this.topeCentavos,
    this.usosRestantes,
    this.hasta,
  });

  factory Cupon.fromJson(Map<String, dynamic> j) => Cupon(
        id: j['id'] as String,
        codigo: j['codigo'] as String? ?? '',
        tipo: j['tipo'] as String? ?? 'PORCENTAJE',
        valor: (j['valor'] as num?)?.toInt() ?? 0,
        usos: (j['usos'] as num?)?.toInt() ?? 0,
        activo: j['activo'] as bool? ?? false,
        minimoCentavos: (j['minimoCentavos'] as num?)?.toInt(),
        topeCentavos: (j['topeCentavos'] as num?)?.toInt(),
        // `null` cuando es ilimitado. NO se convierte a un número: no se puede
        // mostrar una cifra que no existe.
        usosRestantes: (j['usosRestantes'] as num?)?.toInt(),
        hasta: DateTime.tryParse(j['hasta'] as String? ?? ''),
      );

  final String id;
  final String codigo;
  final String tipo;
  final int valor;
  final int usos;
  final bool activo;
  final int? minimoCentavos;
  final int? topeCentavos;

  /// Cuántos quedan, o `null` si es ilimitado.
  final int? usosRestantes;
  final DateTime? hasta;

  bool get esPorcentaje => tipo == 'PORCENTAJE';
  bool get agotado => usosRestantes != null && usosRestantes! <= 0;
}

class ProApi {
  ProApi(this._api);
  final ApiClient _api;

  Future<MiMembresia> miMembresia() async {
    final res = await _api.get<Map<String, dynamic>>('/seller/membership');
    return MiMembresia.fromJson(res.data!);
  }

  Future<List<Cupon>> misCupones() async {
    final res = await _api.get<List<dynamic>>('/seller/coupons');
    return (res.data ?? const [])
        .map((e) => Cupon.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  /// Crea un cupón.
  ///
  /// El backend valida todo lo que importa —el máximo, el tope, la ventana— y
  /// devuelve el motivo. La app no reimplementa esas reglas: dos validaciones
  /// del mismo criterio terminan discrepando, y la que gana es la del servidor.
  Future<Cupon> crearCupon({
    required String codigo,
    required String tipo,
    required int valor,
    int? minimoCentavos,
    int? topeCentavos,
    int? usosMaximos,
  }) async {
    final res = await _api.raw.post<Map<String, dynamic>>(
      '/seller/coupons',
      data: {
        'codigo': codigo,
        'tipo': tipo,
        'valor': valor,
        if (minimoCentavos != null) 'minimoCentavos': minimoCentavos,
        if (topeCentavos != null) 'topeCentavos': topeCentavos,
        if (usosMaximos != null) 'usosMaximos': usosMaximos,
      },
    );
    if (res.statusCode != 201 && res.statusCode != 200) {
      throw CuponException(_mensajeDe(res.data));
    }
    return Cupon.fromJson(res.data!);
  }

  Future<void> alternarCupon(String id, {required bool activo}) async {
    await _api.post<Map<String, dynamic>>('/seller/coupons/$id/toggle', data: {'activo': activo});
  }

  Future<void> borrarCupon(String id) async {
    await _api.delete<Map<String, dynamic>>('/seller/coupons/$id');
  }
}

/// El error con el mensaje que escribió el servidor.
///
/// Se propaga tal cual: dice cuál es el problema —«el descuento máximo es
/// 80 %», «ya tenés un cupón con ese código»— y reescribirlo en la app sería
/// perder la precisión justo donde el vendedor necesita saber qué corregir.
class CuponException implements Exception {
  const CuponException(this.mensaje);
  final String mensaje;

  @override
  String toString() => mensaje;
}

String _mensajeDe(Object? cuerpo) {
  if (cuerpo is Map<String, dynamic>) {
    final error = cuerpo['error'];
    if (error is Map<String, dynamic>) {
      final m = error['message'];
      if (m is String && m.isNotEmpty) return m;
    }
  }
  return 'No pudimos crear el cupón';
}

final proApiProvider = Provider<ProApi>((ref) => ProApi(ref.watch(apiClientProvider)));

final miMembresiaProvider = FutureProvider<MiMembresia>(
  (ref) => ref.watch(proApiProvider).miMembresia(),
);

final misCuponesProvider = FutureProvider<List<Cupon>>(
  (ref) => ref.watch(proApiProvider).misCupones(),
);
