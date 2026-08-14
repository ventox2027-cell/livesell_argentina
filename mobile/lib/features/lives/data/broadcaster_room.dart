import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:permission_handler/permission_handler.dart';

/// En qué estado está la transmisión desde el punto de vista del teléfono.
enum EstadoDeTransmision {
  /// Todavía no se pidieron permisos.
  inicial,

  /// Falta cámara o micrófono. No se puede seguir hasta que la persona los dé.
  sinPermisos,

  /// Conectando con LiveKit.
  conectando,

  /// Conectado, con la vista previa andando. **Nadie lo está viendo todavía.**
  listo,

  /// Publicando en público.
  alAire,

  /// Se cortó. Se está intentando volver sin terminar el vivo.
  reconectando,

  /// No se pudo conectar.
  fallo,
}

/// La cámara, el micrófono y la sala de LiveKit del que transmite.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SEPARADO DE LAS PANTALLAS A PROPÓSITO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La preparación y la pantalla en vivo son dos rutas distintas, y la conexión
/// tiene que sobrevivir el paso de una a la otra. Si la sala viviera dentro de
/// un `State`, ir de la vista previa a "en vivo" la destruiría y volvería a
/// crearla: dos segundos de negro justo cuando el vendedor acaba de decir
/// "¡arrancamos!".
///
/// Acá vive el ciclo de vida completo, y las pantallas se enganchan y
/// desenganchan sin tocarlo.
///
/// ─── La vista previa no publica ───
///
/// Al preparar, la cámara se enciende **localmente** y no se publica nada. La
/// sala de LiveKit existe —el backend la creó— pero mientras nadie publique no
/// hay nada que ver. Es lo que permite acomodarse el pelo sin público.
class BroadcasterRoom extends ChangeNotifier {
  Room? _sala;
  LocalVideoTrack? _video;
  LocalAudioTrack? _audio;

  EstadoDeTransmision _estado = EstadoDeTransmision.inicial;
  String? _error;
  bool _micApagado = false;
  bool _camaraFrontal = true;
  bool _publicando = false;

  EventsListener<RoomEvent>? _escucha;
  Timer? _reintento;
  int _intentos = 0;

  EstadoDeTransmision get estado => _estado;
  String? get error => _error;
  bool get micApagado => _micApagado;
  bool get camaraFrontal => _camaraFrontal;
  LocalVideoTrack? get video => _video;
  Room? get sala => _sala;

  /// `true` cuando hay vista previa: ya se puede ver el encuadre.
  bool get hayPreview => _video != null;

  /// Cuántas veces se reintentó la reconexión. Lo usa la pantalla para avisar.
  int get intentosDeReconexion => _intentos;

  void _cambiar(EstadoDeTransmision nuevo, {String? error}) {
    _estado = nuevo;
    _error = error;
    notifyListeners();
  }

  /// Pide cámara y micrófono.
  ///
  /// Devuelve `false` si falta alguno. La pantalla tiene que explicar cuál y
  /// ofrecer abrir los ajustes del sistema: un "permiso denegado" a secas deja
  /// a la persona sin saber qué tocar.
  Future<bool> pedirPermisos() async {
    final resultado = await [Permission.camera, Permission.microphone].request();

    final camara = resultado[Permission.camera];
    final micro = resultado[Permission.microphone];
    final ok = camara == PermissionStatus.granted && micro == PermissionStatus.granted;

    if (!ok) {
      _cambiar(
        EstadoDeTransmision.sinPermisos,
        error: camara != PermissionStatus.granted
            ? 'Necesitamos la cámara para transmitir.'
            : 'Necesitamos el micrófono para que te escuchen.',
      );
    }

    return ok;
  }

  /// Enciende la cámara localmente, sin publicar nada.
  Future<bool> abrirPreview() async {
    if (_video != null) return true;

    try {
      _video = await LocalVideoTrack.createCameraTrack(
        const CameraCaptureOptions(
          // Vertical, como el video que van a ver. Pedir 16:9 y recortar en el
          // viewer desperdicia ancho de banda en píxeles que nadie ve.
          params: VideoParametersPresets.h720_169,
          cameraPosition: CameraPosition.front,
        ),
      );
      _audio = await LocalAudioTrack.create();
      _cambiar(EstadoDeTransmision.listo);
      return true;
    } catch (e) {
      _cambiar(EstadoDeTransmision.fallo, error: 'No pudimos abrir la cámara.');
      return false;
    }
  }

  /// Se conecta a la sala. Todavía **no publica**.
  Future<bool> conectar({required String wsUrl, required String token}) async {
    if (wsUrl.isEmpty || token.isEmpty) {
      _cambiar(EstadoDeTransmision.fallo, error: 'Falta la credencial de video.');
      return false;
    }

    _cambiar(EstadoDeTransmision.conectando);

    try {
      final sala = Room(
        roomOptions: const RoomOptions(
          adaptiveStream: true,
          // Capas de calidad: quien mira con mala señal recibe la más baja en
          // vez de cortarse. Lo decide LiveKit por espectador.
          dynacast: true,
        ),
      );

      await sala.connect(wsUrl, token);
      _sala = sala;
      _escuchar(sala);

      _cambiar(_publicando ? EstadoDeTransmision.alAire : EstadoDeTransmision.listo);
      return true;
    } catch (e) {
      _cambiar(EstadoDeTransmision.fallo, error: 'No pudimos conectar con el servidor de video.');
      return false;
    }
  }

  /// Publica cámara y micrófono: a partir de acá se ve en público.
  Future<bool> salirAlAire() async {
    final sala = _sala;
    if (sala == null) return false;

    try {
      if (_video == null) await abrirPreview();
      final video = _video;
      if (video == null) return false;

      await sala.localParticipant?.publishVideoTrack(video);
      if (_audio != null && !_micApagado) {
        await sala.localParticipant?.publishAudioTrack(_audio!);
      }

      _publicando = true;
      _cambiar(EstadoDeTransmision.alAire);
      return true;
    } catch (e) {
      _cambiar(EstadoDeTransmision.fallo, error: 'No pudimos publicar tu cámara.');
      return false;
    }
  }

  /// Cambia entre cámara frontal y trasera sin cortar la publicación.
  Future<void> darVueltaCamara() async {
    final video = _video;
    if (video == null) return;

    try {
      await video.setCameraPosition(
        _camaraFrontal ? CameraPosition.back : CameraPosition.front,
      );
      _camaraFrontal = !_camaraFrontal;
      notifyListeners();
    } catch (_) {
      // Algunos teléfonos no tienen cámara trasera utilizable. No es un error
      // que valga la pena mostrar: el botón simplemente no hace nada.
    }
  }

  Future<void> alternarMicrofono() async {
    _micApagado = !_micApagado;
    try {
      await _sala?.localParticipant?.setMicrophoneEnabled(!_micApagado);
    } catch (_) {
      // Si falla, se revierte para que el ícono no mienta sobre lo que se oye.
      _micApagado = !_micApagado;
    }
    notifyListeners();
  }

  /// Los eventos de la sala, que es de donde sale la reconexión.
  ///
  /// ⚠️ Perder la red **no termina el vivo**. LiveKit reintenta solo; mientras
  /// tanto el estado pasa a `reconectando`, la pantalla avisa "no cierres
  /// VendoX" y los espectadores siguen en la sala con el último cuadro
  /// congelado. Terminar el vivo al primer corte convertiría un semáforo con
  /// mala señal en una transmisión perdida.
  void _escuchar(Room sala) {
    _escucha?.dispose();
    _escucha = sala.createListener()
      ..on<RoomReconnectingEvent>((_) {
        _intentos += 1;
        _cambiar(EstadoDeTransmision.reconectando);
      })
      ..on<RoomReconnectedEvent>((_) {
        _intentos = 0;
        _cambiar(_publicando ? EstadoDeTransmision.alAire : EstadoDeTransmision.listo);
      })
      ..on<RoomDisconnectedEvent>((e) {
        // Una desconexión definitiva no se distingue sola de un corte largo.
        // Se marca como reconectando y el reintento decide.
        _cambiar(EstadoDeTransmision.reconectando);
        _programarReintento();
      });
  }

  /// Reintento propio, por si LiveKit se dio por vencido.
  ///
  /// Con espera creciente y tope: reintentar cada 200 ms contra una red caída
  /// gasta batería y no acelera nada.
  void _programarReintento() {
    _reintento?.cancel();
    if (_intentos >= 10) {
      _cambiar(EstadoDeTransmision.fallo, error: 'Se perdió la conexión.');
      return;
    }

    final espera = Duration(seconds: (1 << _intentos).clamp(1, 30));
    _reintento = Timer(espera, () {
      _intentos += 1;
      notifyListeners();
    });
  }

  /// Deja de publicar y se desconecta. El vivo lo cierra el backend.
  Future<void> cortar() async {
    _reintento?.cancel();
    _publicando = false;

    try {
      await _sala?.disconnect();
    } catch (_) {
      // Ya estaba caída.
    }

    await _liberarPistas();
    await _sala?.dispose();
    _sala = null;
    _cambiar(EstadoDeTransmision.inicial);
  }

  Future<void> _liberarPistas() async {
    try {
      await _video?.stop();
      await _audio?.stop();
    } catch (_) {
      // Nada que hacer si ya estaban paradas.
    }
    await _video?.dispose();
    await _audio?.dispose();
    _video = null;
    _audio = null;
  }

  @override
  void dispose() {
    _reintento?.cancel();
    _escucha?.dispose();
    unawaited(_sala?.disconnect());
    unawaited(_liberarPistas());
    _sala?.dispose();
    super.dispose();
  }
}
