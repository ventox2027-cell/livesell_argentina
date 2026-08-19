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

/// Si el problema es la red y no una respuesta del servidor.
///
/// Se distingue porque cambia qué hacer: un fallo de red se reintenta solo
/// cuando vuelve la señal; un 409 del backend no se reintenta nunca.
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
  if (esFalloDeRed(e)) {
    return 'No pudimos conectarnos. Revisá tu conexión: lo reintentamos solos '
        'en cuanto vuelva.';
  }

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
