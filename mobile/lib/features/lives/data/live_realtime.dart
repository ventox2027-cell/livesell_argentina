import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import '../../../core/config/runtime_config.dart';

/// La conexión en tiempo real del vivo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SEPARADA DE LIVEKIT, Y ESO IMPORTA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// LiveKit trae audio y video. El chat, el producto destacado, el stock y el
/// estado vienen por acá.
///
/// La consecuencia práctica es la que se ve cuando algo falla: si el video se
/// corta, **esta conexión sigue viva**. El chat sigue, el producto destacado
/// sigue, y se puede seguir comprando. Si estuvieran en el mismo canal, un
/// problema de red del vendedor apagaría también el comercio.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LOS EVENTOS NO SON LA VERDAD
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Un mensaje se puede perder, duplicar o llegar tarde. Lo que llega por acá
/// se usa para **mostrar**: el "últimas 3", el chat, el cambio de producto.
///
/// Nada de esto autoriza una compra. Cuando alguien toca comprar, el backend
/// vuelve a decidir con un UPDATE condicional. Si un evento perdido pudiera
/// causar una sobreventa, el diseño estaría mal.
class LiveRealtime {
  LiveRealtime({required this.token});

  final String token;

  io.Socket? _socket;
  String? _salaActual;

  final _chat = StreamController<MensajeDeChat>.broadcast();
  final _destacado = StreamController<Map<String, dynamic>>.broadcast();
  final _stock = StreamController<({String variantId, int disponible})>.broadcast();
  final _estado = StreamController<String>.broadcast();
  final _espectadores = StreamController<int>.broadcast();
  final _conectado = StreamController<bool>.broadcast();

  Stream<MensajeDeChat> get chat => _chat.stream;
  Stream<Map<String, dynamic>> get productoDestacado => _destacado.stream;
  Stream<({String variantId, int disponible})> get stock => _stock.stream;
  Stream<String> get estado => _estado.stream;
  Stream<int> get espectadores => _espectadores.stream;
  Stream<bool> get conectado => _conectado.stream;

  bool get estaConectado => _socket?.connected ?? false;

  void conectar() {
    if (_socket != null) return;

    final base = RuntimeConfig.instance.apiBaseUrl;

    final socket = io.io(
      '$base/live',
      io.OptionBuilder()
          // WebSocket nativo, sin respaldo por long-polling: el backend sólo
          // acepta ese transporte.
          .setTransports(['websocket'])
          .setAuth({'token': token})
          .enableReconnection()
          // Reintentos con techo: sin él, una caída larga deja los intentos a
          // intervalos absurdos y la app no se recupera sola.
          .setReconnectionDelay(500)
          .setReconnectionDelayMax(5000)
          .build(),
    );

    socket.onConnect((_) {
      _conectado.add(true);
      // Al reconectar se vuelve a entrar a la sala: el servidor no recuerda en
      // cuál estábamos, y sin esto la reconexión deja un socket vivo que no
      // recibe nada — el peor de los fallos, porque parece que funciona.
      final sala = _salaActual;
      if (sala != null) socket.emit('join', {'liveSessionId': sala});
    });

    socket.onDisconnect((_) => _conectado.add(false));

    socket.onConnectError((e) {
      if (kDebugMode) debugPrint('realtime: no se pudo conectar — $e');
      _conectado.add(false);
    });

    socket.on('live.chat.message.v1', (d) {
      final j = d as Map<String, dynamic>?;
      if (j != null) _chat.add(MensajeDeChat.fromJson(j));
    });

    socket.on('live.product.featured.v1', (d) {
      final j = d as Map<String, dynamic>?;
      if (j != null) _destacado.add(j);
    });

    socket.on('live.product.stock_changed.v1', (d) {
      final j = d as Map<String, dynamic>?;
      if (j == null) return;
      final id = j['variantId'] as String?;
      final disp = (j['disponible'] as num?)?.toInt();
      if (id != null && disp != null) _stock.add((variantId: id, disponible: disp));
    });

    socket.on('live.state_changed.v1', (d) {
      final j = d as Map<String, dynamic>?;
      final e = j?['estado'] as String?;
      if (e != null) _estado.add(e);
    });

    socket.on('live.ended.v1', (_) => _estado.add('ENDED'));

    socket.on('live.viewer_count.v1', (d) {
      final j = d as Map<String, dynamic>?;
      final n = (j?['cantidad'] as num?)?.toInt();
      if (n != null) _espectadores.add(n);
    });

    _socket = socket;
  }

  /// Entrar a la sala de un vivo.
  ///
  /// Se guarda cuál es para poder volver a entrar tras una reconexión.
  void entrarA(String liveSessionId) {
    _salaActual = liveSessionId;
    _socket?.emit('join', {'liveSessionId': liveSessionId});
  }

  void salir() {
    _socket?.emit('leave', <String, dynamic>{});
    _salaActual = null;
  }

  void enviarMensaje(String texto) {
    final sala = _salaActual;
    if (sala == null || texto.trim().isEmpty) return;
    _socket?.emit('chat', {'liveSessionId': sala, 'texto': texto.trim()});
  }

  void desconectar() {
    _socket?.dispose();
    _socket = null;
    _salaActual = null;
  }

  void dispose() {
    desconectar();
    _chat.close();
    _destacado.close();
    _stock.close();
    _estado.close();
    _espectadores.close();
    _conectado.close();
  }
}

class MensajeDeChat {
  const MensajeDeChat({
    required this.id,
    required this.nombre,
    required this.texto,
    required this.esVendedor,
  });

  factory MensajeDeChat.fromJson(Map<String, dynamic> j) => MensajeDeChat(
        id: j['id'] as String? ?? '',
        nombre: j['nombre'] as String? ?? '',
        texto: j['texto'] as String? ?? '',
        esVendedor: j['esVendedor'] as bool? ?? false,
      );

  final String id;
  final String nombre;
  final String texto;
  final bool esVendedor;
}
