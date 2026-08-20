import 'dart:io';

import 'package:dio/dio.dart';

/// Traduce un error a algo que una persona pueda leer.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE NUNCA PUEDE LLEGAR A LA PANTALLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Hoy hay 29 lugares que hacen `AppSnack.error(context, e.toString())`. Cuando
/// eso es un `DioException`, la persona lee algo así:
///
///     DioException [connection error]: The connection errored:
///     Failed host lookup: 'api.vendox.com.ar' (OS Error: No address
///     associated with hostname, errno = 7)
///
/// Eso no le dice a nadie que se le cayó el wifi. Le dice que la app está rota,
/// y de paso publica el nombre del servidor y un número de error del sistema
/// operativo.
///
/// ─── Y no es sólo estética ───
///
/// Un mensaje técnico hace que la gente cierre la app en vez de esperar diez
/// segundos a que vuelva la señal. El problema se resolvía solo; el texto hizo
/// que pareciera que no.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL MENSAJE DEL BACKEND SÍ SE RESPETA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Cuando el servidor contestó algo, ese texto está escrito para quien lo lee y
/// se muestra tal cual. Lo que se traduce acá es lo otro: no llegamos a hablar
/// con el servidor.

// ─────────────────────────────────────────────────────────────────────────────

/// Qué salió mal, en las categorías que le importan a quien está mirando.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// «SIN CONEXIÓN» ERA MENTIRA LA MITAD DE LAS VECES
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Reportado en QA: con el wifi andando perfecto, abrir la app mostraba «No
/// pudimos conectarnos. Revisá tu conexión». La persona miraba el teléfono,
/// veía las barras llenas, y no entendía nada.
///
/// La causa es que todo lo que no fuera una respuesta del servidor se metía en
/// la misma bolsa. Y ahí adentro hay tres cosas muy distintas:
///
///   · **No hay Internet.** El DNS no resuelve, la red no está. Revisar la
///     conexión es exactamente lo que hay que hacer.
///   · **No llegamos al servidor.** Hay Internet, pero VendoX no contesta el
///     saludo. Revisar la conexión no sirve de nada: el problema es nuestro.
///   · **El servidor es lento.** Conectamos bien y se está tomando su tiempo.
///     Decirle a alguien que revise su wifi mientras nuestro backend piensa es
///     mandarlo a arreglar algo que no está roto.
///
/// Los tres se ven igual desde el código si uno no mira el tipo. Por eso esto
/// existe.
enum ClaseDeFallo {
  /// El teléfono no tiene red. El DNS no resuelve o la red no está.
  sinInternet,

  /// Hay red pero no llegamos: rechazo o tiempo agotado al conectar.
  noLlegamosAlServidor,

  /// Conectamos y no contesta a tiempo. El problema es nuestro, no de la red.
  servidorLento,

  /// Nada de lo anterior: una respuesta del servidor, o un error del programa.
  noEsDeRed,
}

/// Clasifica el fallo. Es lo que decide QUÉ SE LE DICE a la persona.
///
/// ⚠️ Distinto de [esFalloDeRed], que decide OTRA cosa: si conviene reintentar
/// cuando vuelva la conectividad. Las dos preguntas tienen respuestas distintas
/// y juntarlas fue el origen del mensaje equivocado.
ClaseDeFallo claseDeFallo(Object e) {
  final socket = e is SocketException ? e : (e is DioException ? e.error : null);

  if (socket is SocketException) {
    /**
     * Un fallo de resolución es, en la práctica, no tener Internet.
     *
     * `Failed host lookup` aparece cuando el DNS no contesta, y eso pasa
     * cuando la red no está. Un servidor caído NO produce esto: el nombre
     * resuelve igual y después falla la conexión, que es el caso de abajo.
     */
    final texto = socket.message;
    if (texto.contains('Failed host lookup') ||
        texto.contains('Network is unreachable') ||
        texto.contains('No address associated with hostname')) {
      return ClaseDeFallo.sinInternet;
    }
    return ClaseDeFallo.noLlegamosAlServidor;
  }

  if (e is! DioException) return ClaseDeFallo.noEsDeRed;

  return switch (e.type) {
    DioExceptionType.connectionTimeout ||
    DioExceptionType.connectionError =>
      ClaseDeFallo.noLlegamosAlServidor,

    /**
     * ⚠️ Acá está el arreglo.
     *
     * `receiveTimeout` significa que la conexión se abrió, la petición viajó, y
     * el servidor no contestó a tiempo. La red funcionó de punta a punta. Decir
     * «revisá tu conexión» es señalar al único componente que anduvo bien.
     */
    DioExceptionType.receiveTimeout || DioExceptionType.sendTimeout => ClaseDeFallo.servidorLento,
    _ => ClaseDeFallo.noEsDeRed,
  };
}

/// Si el problema es la red y no una respuesta del servidor.
///
/// Se distingue porque cambia qué hacer: un fallo de red se reintenta solo
/// cuando vuelve la señal; un 409 del backend no se reintenta nunca.
///
/// ⚠️ A propósito es MÁS AMPLIO que `ClaseDeFallo.sinInternet`. Acá la pregunta
/// es «¿conviene reintentar cuando vuelva la conectividad?», y la respuesta es
/// sí también para un tiempo agotado: un corte de red de dos segundos se ve
/// como timeout, no como DNS caído. Angostarlo rompería la recuperación
/// automática, que hoy funciona.
bool esFalloDeRed(Object e) {
  if (e is SocketException) return true;
  if (e is! DioException) return false;

  return switch (e.type) {
    DioExceptionType.connectionError ||
    DioExceptionType.connectionTimeout ||
    DioExceptionType.sendTimeout ||
    DioExceptionType.receiveTimeout =>
      true,
    // `unknown` envuelve lo que Dio no clasificó. Casi siempre es la red, pero
    // se comprueba en vez de suponerlo: un error de parseo también cae acá, y
    // reintentarlo cuando vuelve el wifi no lo va a arreglar.
    DioExceptionType.unknown => e.error is SocketException,
    _ => false,
  };
}

/// El texto que se le muestra a una persona.
///
/// ⚠️ Nunca incluye hostnames, errno, nombres de excepción ni rutas. Si algo de
/// eso hace falta para diagnosticar, va al log — no a la pantalla.
String mensajeDeError(Object e) {
  final mensajeDelFallo = switch (claseDeFallo(e)) {
    ClaseDeFallo.sinInternet =>
      'Sin conexión a Internet. Lo reintentamos solos en cuanto vuelva.',
    ClaseDeFallo.noLlegamosAlServidor =>
      'No pudimos conectarnos con VendoX. Lo reintentamos solos en un momento.',
    ClaseDeFallo.servidorLento =>
      'VendoX está tardando más de lo esperado. Lo reintentamos solos.',
    ClaseDeFallo.noEsDeRed => null,
  };
  if (mensajeDelFallo != null) return mensajeDelFallo;

  if (e is DioException) {
    final codigo = e.response?.statusCode ?? 0;

    // Lo que el backend haya escrito para quien lo lee, se respeta.
    final delServidor = _mensajeDelCuerpo(e.response?.data);
    if (delServidor != null) return delServidor;

    if (codigo >= 500) {
      return 'Tuvimos un problema de nuestro lado. Probá de nuevo en un momento.';
    }
    if (codigo == 401 || codigo == 403) {
      return 'Tu sesión expiró. Entrá de nuevo.';
    }
    if (codigo == 404) return 'No encontramos lo que buscabas.';

    /**
     * El caso que no hay que dejar pasar: un `DioException` sin cuerpo ni
     * código reconocible.
     *
     * Devolver `e.toString()` acá sería reintroducir el bug entero por la
     * puerta de atrás, y en el único caso donde nadie lo va a notar hasta que
     * le pase a alguien.
     */
    return 'No pudimos completar la operación. Probá de nuevo.';
  }

  /**
   * ⚠️ Un `Error` de Dart NUNCA se muestra, diga lo que diga.
   *
   * `Error` y `Exception` no son lo mismo: `Exception` es algo previsto que
   * pasó, `Error` es un defecto del programa. `StateError`, `RangeError`,
   * `TypeError`.
   *
   * La comprobación por texto de más abajo no alcanza para estos, y el caso
   * que lo demostró es feo: `StateError('Connection closed before full header
   * was received')` se convierte en «Bad state: Connection closed before full
   * header was received». No dice «Exception», no dice «errno», no dice nada
   * que una lista de marcas pueda atrapar — y le aparece entero a la persona.
   *
   * El tipo lo resuelve de raíz: el texto de un `Error` está escrito para
   * quien programa, siempre.
   */
  if (e is Error) return 'No pudimos completar la operación. Probá de nuevo.';

  /**
   * Cualquier otra cosa.
   *
   * Se usa `toString()` sólo si el mensaje NO parece técnico. Las excepciones
   * del dominio —`ComercioException`— devuelven su texto en `toString()`, y ése
   * está escrito para leerse; las del sistema empiezan con el nombre de la
   * clase.
   */
  final texto = e.toString();
  if (_pareceTecnico(texto)) {
    return 'No pudimos completar la operación. Probá de nuevo.';
  }
  return texto;
}

String? _mensajeDelCuerpo(Object? data) {
  if (data is! Map) return null;
  final error = data['error'];
  if (error is! Map) return null;
  final msg = error['message'];
  return msg is String && msg.isNotEmpty ? msg : null;
}

/// Si un texto tiene pinta de mensaje de sistema y no de frase.
///
/// La heurística es deliberadamente amplia: ante la duda, se muestra el
/// genérico. Un mensaje de dominio perdido es molesto; un `errno` en pantalla
/// es peor.
bool _pareceTecnico(String texto) {
  const marcas = [
    'Exception',
    'Error:',
    'errno',
    'OS Error',
    'SocketException',
    'DioException',
    'HandshakeException',
    'Failed host lookup',
    'http://',
    'https://',
    '#0',
  ];
  return marcas.any(texto.contains);
}
