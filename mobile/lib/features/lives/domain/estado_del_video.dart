/// Qué mostrar sobre el video de un vivo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ESTO ES UN MÓDULO APARTE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La decisión de "¿aviso que se cortó?" depende de cuatro cosas —lo que dice
/// el backend, si alguna vez llegó un cuadro, cuánto hace que no avanza, y
/// cuánto hace que se cortó— y adentro del widget no se puede probar: haría
/// falta una sala de LiveKit real con estadísticas de recepción.
///
/// Ahí vivía un bug que estuvo dando vueltas sin que nadie lo reportara bien.
/// Ver `vioAlgunCuadro`.
library;

enum EstadoDelVideo {
  /// Todavía no llegó el primer cuadro. **No se avisa nada.**
  cargando,

  /// Llegando video, todo normal.
  enVivo,

  /// Hace poco que no llega. Casi siempre vuelve.
  reconectando,

  /// Pasó el umbral largo. Ya no se promete que vuelva.
  interrumpido,

  /// Lo dice el backend. Es definitivo.
  terminado,
}

/// Cuánto sin un cuadro nuevo antes de considerar que se cortó.
///
/// Dos segundos. Un vivo a 30 cuadros por segundo que pasa dos segundos sin
/// decodificar uno solo no está teniendo un hipo: se cortó.
const umbralDeCongelado = Duration(seconds: 2);

/// Cuánto sin video antes de dejar de prometer que vuelve.
///
/// Treinta segundos. Menos sería impaciente —una reconexión sobre datos
/// móviles tarda perfectamente diez o quince— y más deja a la persona mirando
/// un spinner que ya no significa nada.
const umbralDeInterrupcion = Duration(seconds: 30);

/// ¿Hay que considerar que el video se congeló?
///
/// ⚠️ `vioAlgunCuadro` es la condición que faltaba, y su ausencia declaraba
/// congelado el arranque de TODOS los vivos.
///
/// El primer cuadro tarda unos cuatro segundos —medido en campo— y el umbral
/// son dos. Al arrancar, el contador de cuadros vale cero y sigue valiendo
/// cero, así que "no avanzó" era cierto y el aviso aparecía: durante unos dos
/// segundos, en cada vivo que alguien abría, se leía "el vendedor está
/// recuperando la conexión" sobre un vendedor perfectamente conectado.
///
/// Después desaparecía solo. Por eso nunca se reportó bien: "a veces tarda y
/// dice algo raro".
bool videoCongelado({required bool vioAlgunCuadro, required Duration sinAvance}) {
  if (!vioAlgunCuadro) return false;
  return sinAvance > umbralDeCongelado;
}

/// La decisión completa de qué cartel mostrar.
///
/// El orden de las comprobaciones importa: lo que dice el backend gana sobre
/// cualquier medición local. Si el vivo terminó, no tiene sentido ofrecer
/// esperar una reconexión que no va a llegar.
EstadoDelVideo estadoDelVideo({
  /// `ENDED` o `FAILED` según el backend.
  required bool terminado,

  /// `RECONNECTING` según el backend. Es una señal más, no la única.
  required bool reconectandoSegunBackend,

  /// Si alguna vez llegó un cuadro en esta conexión.
  required bool vioAlgunCuadro,

  /// Hace cuánto que el contador de cuadros no avanza.
  required Duration sinAvance,

  /// Hace cuánto que se detectó el corte. `null` si no hay corte.
  Duration? desdeElCorte,
}) {
  if (terminado) return EstadoDelVideo.terminado;

  final congelado = videoCongelado(vioAlgunCuadro: vioAlgunCuadro, sinAvance: sinAvance);
  if (!congelado && !reconectandoSegunBackend) {
    // Sin cuadros todavía y sin problema declarado: está cargando, no fallando.
    return vioAlgunCuadro ? EstadoDelVideo.enVivo : EstadoDelVideo.cargando;
  }

  if (desdeElCorte != null && desdeElCorte >= umbralDeInterrupcion) {
    return EstadoDelVideo.interrumpido;
  }
  return EstadoDelVideo.reconectando;
}
