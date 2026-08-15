// El horario de la tienda.
//
// ─── Los minutos son la verdad; "HH:MM" es sólo para mirar ───
//
// Una franja se guarda como dos enteros: minutos desde la medianoche. El texto
// se arma al dibujar.
//
// Guardar "09:30" como cadena obligaría a parsear en cada comparación, y ahí
// aparecen los problemas de siempre: "9:30" contra "09:30", el formato de 12
// horas, y la resta de horas que hay que hacer a mano. Con enteros, "¿está
// abierta?" es una comparación de números.

/// Cómo decide la tienda si está abierta.
enum ModoDeApertura {
  /// Siempre. Se compra a cualquier hora.
  alwaysOpen('ALWAYS_OPEN'),

  /// Según las franjas cargadas.
  scheduled('SCHEDULED'),

  /// Sólo mientras hay una transmisión al aire.
  liveOnly('LIVE_ONLY');

  const ModoDeApertura(this.name);

  /// El valor que entiende el backend. Se manda tal cual.
  final String name;

  static ModoDeApertura desde(String? valor) => switch (valor) {
        'SCHEDULED' => ModoDeApertura.scheduled,
        'LIVE_ONLY' => ModoDeApertura.liveOnly,
        // Ante un modo desconocido, abierta. Un valor que la app no reconoce no
        // puede terminar cerrando una tienda que su dueño dejó abierta.
        _ => ModoDeApertura.alwaysOpen,
      };
}

class FranjaHoraria {
  const FranjaHoraria({
    required this.dia,
    required this.abreMinutos,
    required this.cierraMinutos,
  });

  factory FranjaHoraria.fromJson(Map<String, dynamic> j) => FranjaHoraria(
        dia: (j['dia'] as num?)?.toInt() ?? 0,
        abreMinutos: (j['abreMinutos'] as num?)?.toInt() ?? 0,
        cierraMinutos: (j['cierraMinutos'] as num?)?.toInt() ?? 0,
      );

  /// 0 = domingo, 6 = sábado. Igual que `Intl` y que el backend.
  final int dia;
  final int abreMinutos;
  final int cierraMinutos;

  /// Cierra antes de abrir: la franja cruza la medianoche.
  ///
  /// No es un error de carga. Un vivo de 22:00 a 02:00 es de lo más común, y
  /// tratarlo como inválido obligaría al vendedor a partirlo en dos.
  bool get cruzaMedianoche => cierraMinutos < abreMinutos;

  FranjaHoraria copiaCon({int? abreMinutos, int? cierraMinutos}) => FranjaHoraria(
        dia: dia,
        abreMinutos: abreMinutos ?? this.abreMinutos,
        cierraMinutos: cierraMinutos ?? this.cierraMinutos,
      );
}

class HorarioDeTienda {
  const HorarioDeTienda({
    required this.modo,
    required this.zona,
    required this.franjas,
    this.abiertaAhora,
    this.motivo = '',
  });

  factory HorarioDeTienda.fromJson(Map<String, dynamic> j) {
    final estado = j['estadoActual'] as Map<String, dynamic>?;

    return HorarioDeTienda(
      modo: ModoDeApertura.desde(j['modo'] as String?),
      zona: j['zona'] as String? ?? 'America/Argentina/Buenos_Aires',
      franjas: (j['franjas'] as List<dynamic>? ?? const [])
          .map((e) => FranjaHoraria.fromJson(e as Map<String, dynamic>))
          .toList(),
      abiertaAhora: estado?['abierta'] as bool?,
      motivo: estado?['motivo'] as String? ?? '',
    );
  }

  final ModoDeApertura modo;

  /// La zona horaria de la TIENDA, no la del teléfono.
  ///
  /// Es lo que hace que "abre a las 9" signifique las 9 de quien vende. Con la
  /// zona del dispositivo, alguien mirando desde España vería la tienda cerrada
  /// a las 10 de la mañana de Buenos Aires.
  final String zona;

  final List<FranjaHoraria> franjas;
  final bool? abiertaAhora;
  final String motivo;

  HorarioDeTienda copiaCon({ModoDeApertura? modo, List<FranjaHoraria>? franjas}) => HorarioDeTienda(
        modo: modo ?? this.modo,
        zona: zona,
        franjas: franjas ?? this.franjas,
        abiertaAhora: abiertaAhora,
        motivo: motivo,
      );
}

const nombresDeDia = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/// Minutos desde la medianoche a "HH:MM".
String comoHora(int minutos) {
  final h = (minutos ~/ 60).toString().padLeft(2, '0');
  final m = (minutos % 60).toString().padLeft(2, '0');
  return '$h:$m';
}
