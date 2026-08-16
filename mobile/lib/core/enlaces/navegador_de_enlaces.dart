import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';

import '../config/paginas_publicas.dart';
import 'destino.dart';

/// Lleva a alguien al lugar que pidió un enlace o un aviso.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// NO ES UN ROUTER
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La app navega con `Navigator` imperativo en quince pantallas. Meter
/// `go_router` ahora para resolver cuatro enlaces sería reescribir la
/// navegación entera en medio de un congelamiento, y dejar dos formas de
/// navegar conviviendo — que es peor que cualquiera de las dos sola.
///
/// Esto es una clave global de navegador y un `switch`. Cuando la app migre a
/// un router de verdad, se cambia [_abrir] y nada más.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LOS TRES MOMENTOS EN QUE LLEGA UN ENLACE
/// ═══════════════════════════════════════════════════════════════════════════
///
///   · **App cerrada** — el enlace ya llegó antes de que existiera nadie
///     escuchando. Hay que preguntarlo: `getInitialLink()`.
///   · **App en segundo plano** — llega por el flujo, con la app viva.
///   · **App abierta** — igual que el anterior. Android reusa la actividad
///     porque `MainActivity` es `singleTop`.
///
/// El primero es el que más se olvida, y es el que hace que «toqué el enlace y
/// me abrió el feed» sea el bug clásico de cualquier app con deep links.
class NavegadorDeEnlaces {
  NavegadorDeEnlaces._();
  static final instance = NavegadorDeEnlaces._();

  /// La llave del `Navigator` de la app. La pone `MaterialApp`.
  final llave = GlobalKey<NavigatorState>();

  final _appLinks = AppLinks();
  StreamSubscription<Uri>? _suscripcion;

  /// Construye la pantalla de un destino. Lo inyecta la capa de arriba: este
  /// archivo no importa ninguna pantalla, así no se vuelve el centro del mundo.
  Widget? Function(DestinoEnApp destino)? pantallaDe;

  /// Abre una URL en el navegador del teléfono.
  Future<bool> Function(String url)? abrirEnNavegador;

  /// Un destino que llegó antes de que hubiera con qué abrirlo.
  ///
  /// Pasa siempre en el arranque en frío: el enlace está listo mucho antes que
  /// el árbol de widgets. Se guarda y se consume cuando la app avisa que ya
  /// puede navegar. Ver [listoParaNavegar].
  Destino? _pendiente;
  bool _listo = false;

  /// Empieza a escuchar. Se llama una vez, al iniciar la app.
  Future<void> inicializar() async {
    try {
      final inicial = await _appLinks.getInitialLink();
      if (inicial != null) manejar(resolverEnlace(inicial));
    } catch (e) {
      debugPrint('Enlaces: no se pudo leer el enlace inicial. $e');
    }

    _suscripcion = _appLinks.uriLinkStream.listen(
      (uri) => manejar(resolverEnlace(uri)),
      onError: (Object e) => debugPrint('Enlaces: error en el flujo. $e'),
    );
  }

  /// La app ya puede navegar: hay sesión resuelta y árbol montado.
  ///
  /// Consume lo que hubiera quedado esperando. Sin esto, un enlace tocado con
  /// la app cerrada se pierde: llega mientras la pantalla todavía es el
  /// indicador de carga y `Navigator` no existe.
  void listoParaNavegar() {
    _listo = true;
    final pendiente = _pendiente;
    if (pendiente != null) {
      _pendiente = null;
      manejar(pendiente);
    }
  }

  /// Resuelve qué hacer con un destino.
  void manejar(Destino? destino) {
    if (destino == null) {
      /**
       * ⚠️ Acá NO se navega a ningún lado, y es deliberado.
       *
       * Un enlace que no reconocemos abre la app y la deja donde estaba. La
       * alternativa —mandar al feed— deja a alguien que tocó esperando un
       * producto en una pantalla que no pidió, sin entender qué pasó.
       */
      debugPrint('Enlaces: no reconocido, no se navega.');
      return;
    }

    if (!_listo) {
      _pendiente = destino;
      return;
    }

    switch (destino) {
      case DestinoWeb(:final url):
        /**
         * Una página nuestra que no es una pantalla: privacidad, eliminar
         * cuenta. Va al navegador con su URL a la vista.
         *
         * Que la app las intercepte es el costo de tomar el dominio entero en
         * el intent-filter, y devolverlas así es más barato que enumerar rutas
         * en el manifiesto y tener que publicar una versión cada vez que el
         * backend agrega una.
         */
        final abriendo = abrirEnNavegador?.call(url);
        if (abriendo != null) unawaited(abriendo);

      case DestinoEnApp():
        _abrir(destino);
    }
  }

  void _abrir(DestinoEnApp destino) {
    final navegador = llave.currentState;
    if (navegador == null) {
      // El árbol se desmontó entre medio. Se guarda para el próximo intento.
      _pendiente = destino;
      return;
    }

    final pantalla = pantallaDe?.call(destino);
    if (pantalla == null) {
      // Un destino que la app conoce pero para el que todavía no hay pantalla.
      // Mejor no hacer nada que abrir otra cosa.
      debugPrint('Enlaces: sin pantalla para ${destino.tipo.name}.');
      return;
    }

    unawaited(navegador.push(MaterialPageRoute<void>(builder: (_) => pantalla)));
  }

  /// Sólo para tests: deja el estado como recién creado.
  @visibleForTesting
  void reiniciar() {
    _pendiente = null;
    _listo = false;
  }

  /// Sólo para tests: qué quedó esperando.
  @visibleForTesting
  Destino? get pendiente => _pendiente;

  Future<void> dispose() async {
    await _suscripcion?.cancel();
    _suscripcion = null;
  }
}

/// El abridor por defecto, para no repetir el import en cada llamador.
Future<bool> abrirUrlEnNavegador(String url) => abrirPaginaPublica(url);
