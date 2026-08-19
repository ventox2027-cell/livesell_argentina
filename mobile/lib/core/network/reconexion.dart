import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// De dónde salen los avisos del sistema operativo.
///
/// Es un provider y no una llamada directa a `Connectivity()` porque, si no, no
/// habría forma de probar nada de esto: cortar el wifi de verdad no es algo que
/// un test pueda hacer. Acá se reemplaza por un `StreamController` y la caída se
/// simula.
final flujoDeConectividadProvider = Provider<Stream<List<ConnectivityResult>>>(
  (ref) => Connectivity().onConnectivityChanged,
);

/// Avisa cuando vuelve la red.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL PROBLEMA: LA APP NO SE RECUPERA SOLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Probado en un teléfono: se corta el wifi, la pantalla muestra su error, y
/// vuelve internet. Pasan treinta segundos y la pantalla sigue igual. Sólo
/// revive tocando «Reintentar».
///
/// Para quien lo usa, eso es una app que se rompió y hay que arreglar a mano.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ESTO SÓLO AVISA, Y NO REINTENTA NADA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La tentación es que este servicio invalide todos los providers al volver la
/// red. Sería un error: se dispararían veinte peticiones simultáneas, la
/// mayoría para refrescar pantallas que nadie está mirando y que ya tenían sus
/// datos bien.
///
/// Acá sólo se emite «volvió». Quien reacciona es cada pantalla que **está
/// mostrando un error en este momento** —ver `ReintentarAlVolverLaRed`—, así
/// que se pide exactamente lo que falló y nada más.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// «HAY WIFI» NO ES «HAY INTERNET»
/// ═══════════════════════════════════════════════════════════════════════════
///
/// `connectivity_plus` avisa cuando el teléfono se asocia a una red, y eso pasa
/// bastante antes de que el DNS resuelva. Reintentar en ese instante falla, y
/// deja a la pantalla en error justo cuando la red ya estaba volviendo.
///
/// Por eso hay una espera antes de avisar, y por eso el aviso puede repetirse
/// con una separación creciente: la primera vez puede ser temprano.
class Reconexion extends Notifier<int> {
  StreamSubscription<List<ConnectivityResult>>? _suscripcion;
  Timer? _temporizador;

  /// Cuántos avisos van desde la última vez que hubo red.
  ///
  /// Se usa para espaciar los reintentos. Se reinicia cuando la red se corta de
  /// nuevo: cada caída empieza su propia serie.
  int _intentosDeEstaCaida = 0;

  /// Un contador que sube cada vez que conviene reintentar.
  ///
  /// El valor no significa nada por sí mismo: lo único que importa es que
  /// CAMBIÓ. Un `bool` no serviría — dos reconexiones seguidas darían el mismo
  /// valor y nadie se enteraría de la segunda.
  @override
  int build() {
    _escuchar();
    ref.onDispose(() {
      _suscripcion?.cancel();
      _temporizador?.cancel();
    });
    return 0;
  }

  void _escuchar() {
    _suscripcion = ref.read(flujoDeConectividadProvider).listen(_alCambiar);
  }

  /// ⚠️ NO se lleva la cuenta de «antes había red».
  ///
  /// La versión obvia guarda un `bool` y sólo avisa en la transición de sin-red
  /// a con-red. Se ve razonable y está mal: este notifier nace cuando alguien lo
  /// mira por primera vez, que es DESPUÉS de que la pantalla falló. Si nació
  /// creyendo que había red —el valor inicial natural—, la vuelta de la red le
  /// parece «seguíamos igual» y no avisa nunca. La app quedaría exactamente como
  /// está hoy, con el arreglo puesto.
  ///
  /// Sin ese `bool`, cualquier evento con red presente programa un aviso. De más
  /// no sobra: si no hay ninguna pantalla en error, nadie está escuchando y el
  /// aviso no hace nada. Y un salto de wifi a datos también merece reintentar.
  void _alCambiar(List<ConnectivityResult> estados) {
    final hayRed = estados.any((e) => e != ConnectivityResult.none);

    if (!hayRed) {
      // Se cortó. Se cancela cualquier aviso pendiente y arranca una serie
      // nueva: los intentos de la caída anterior ya no valen.
      _temporizador?.cancel();
      _intentosDeEstaCaida = 0;
      return;
    }

    _programarAviso();
  }

  void _programarAviso() {
    _temporizador?.cancel();
    _temporizador = Timer(esperaParaElIntento(_intentosDeEstaCaida), () {
      _intentosDeEstaCaida += 1;
      state = state + 1;
    });
  }

  /// Vuelve a avisar, para quien todavía no pudo.
  ///
  /// Lo llama una pantalla cuyo reintento volvió a fallar: la red estaba
  /// asociada pero todavía no pasaba tráfico. Sin esto, un primer aviso
  /// temprano dejaría la pantalla en error hasta el próximo corte.
  void volveAAvisar() {
    if (_intentosDeEstaCaida >= maximoDeIntentos) return;
    _programarAviso();
  }
}

/// Cuántas veces se avisa por cada caída, como mucho.
///
/// Sin techo, una red que dice «conectado» y no pasa tráfico —un portal
/// cautivo de hotel, por ejemplo— haría reintentar para siempre. Pasado el
/// tope queda el botón «Reintentar», que es una decisión de la persona y no un
/// bucle.
const maximoDeIntentos = 5;

/// Cuánto esperar antes del aviso número `intento`.
///
/// Crece, y no linealmente. El primer aviso va casi enseguida —la mayoría de
/// las veces la red vuelve de verdad— y los siguientes se separan, porque si el
/// primero falló es señal de que la red todavía no está.
///
/// Se corta en 30 segundos: más allá, quien está mirando la pantalla ya tocó el
/// botón.
Duration esperaParaElIntento(int intento) {
  const escalones = [
    Duration(milliseconds: 800),
    Duration(seconds: 3),
    Duration(seconds: 8),
    Duration(seconds: 20),
    Duration(seconds: 30),
  ];
  final i = intento < 0 ? 0 : intento;
  return i >= escalones.length ? escalones.last : escalones[i];
}

final reconexionProvider = NotifierProvider<Reconexion, int>(Reconexion.new);
