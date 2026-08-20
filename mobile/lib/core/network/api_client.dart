import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';

import '../auth/token_store.dart';
import '../config/traza_de_arranque.dart';
import '../config/runtime_config.dart';

/// Cliente HTTP de la aplicación.
///
/// ─── Lo que resuelve, y por qué no es trivial ───
///
/// El access token vive 15 minutos. Sin refresco automático, la persona vería
/// la app romperse cada cuarto de hora. Con refresco mal hecho, vería algo
/// peor: sesiones que se cierran solas.
///
/// El problema es la **estampida**. Al volver a abrir la app se disparan cinco
/// peticiones a la vez —feed, perfil, notificaciones— y las cinco reciben 401
/// al mismo tiempo. Si cada una refresca por su cuenta:
///
///   · Se hacen cinco refrescos con el MISMO token.
///   · El primero rota y quema ese token.
///   · Los otros cuatro llegan con un token ya quemado.
///   · El backend lo lee como robo y **revoca la familia entera**.
///
/// Resultado: la app cierra la sesión sola cada vez que se abre. Y el síntoma
/// aparece de forma intermitente, según el orden en que respondan las cinco.
///
/// La solución es un único refresco compartido: la primera petición que ve un
/// 401 arranca el refresco y las demás esperan ESA misma promesa.
class ApiClient {
  ApiClient({required TokenStore tokens, Dio? dio, Future<void> Function()? onSesionCerrada})
      : _tokens = tokens,
        _onSesionCerrada = onSesionCerrada,
        _dio = dio ?? Dio() {
    _dio.options
      ..baseUrl = '${RuntimeConfig.instance.apiBaseUrl}/api/v1'
      ..connectTimeout = const Duration(seconds: 10)
      ..receiveTimeout = const Duration(seconds: 20)
      ..headers['content-type'] = 'application/json'
      // No lanzar por códigos de error: se manejan explícitamente y así el
      // interceptor puede reintentar tras refrescar.
      ..validateStatus = (s) => s != null && s < 500;

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA CONEXIÓN SE REUSA TRES MINUTOS, NO QUINCE SEGUNDOS
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Medido desde Argentina contra `api.vendox.com.ar`:
     *
     *     TCP  ≈ 135 ms   ← un viaje de ida y vuelta. Es la distancia.
     *     TLS  ≈ 143 ms   ← otro viaje.
     *     ────────────
     *     ≈ 280 ms sólo para poder EMPEZAR a pedir algo.
     *
     * `HttpClient` de Dart cierra las conexiones ociosas a los **15 segundos**.
     * Un vendedor que mira su tienda, piensa, y toca un producto, ya pasó ese
     * tiempo: la petición siguiente vuelve a pagar los 280 ms enteros.
     *
     * Y no es sólo eso. `/health` responde en 166 ms cuando la conexión está
     * abierta y en ~500 con una nueva. O sea que **la mitad larga de una
     * petición rápida es abrir la conexión**, y se estaba tirando cada quince
     * segundos de quietud.
     *
     * ⚠️ Esto NO es subir un timeout ni esconder nada: los timeouts quedan
     * donde estaban. Es dejar de tirar una conexión que sigue siendo válida.
     * HTTP tiene keep-alive precisamente para esto, y el servidor la cierra
     * cuando quiere — el cliente no puede forzarlo a mantenerla.
     *
     * Tres minutos y no más: una conexión ociosa consume un socket del lado del
     * servidor, y pasado ese rato la app probablemente esté en segundo plano,
     * donde Android la corta igual.
     */
    /**
     * ⚠️ Sólo si el `Dio` lo creamos NOSOTROS.
     *
     * Quien inyecta un `Dio` ya eligió su adaptador —los tests le ponen uno de
     * mentira para no salir a la red— y pisárselo desde acá lo deja hablando
     * con Internet de verdad.
     *
     * Se descubrió rompiendo tres tests de categorías: esperaban un 404 del
     * doble y recibían un 400 del mundo real. Sin esa guarda, cualquier test
     * que inyecte un `Dio` deja de probar lo que cree.
     */
    if (dio == null) {
      _dio.httpClientAdapter = IOHttpClientAdapter(
        createHttpClient: () => HttpClient()
          ..idleTimeout = const Duration(minutes: 3)
          /**
           * Seis en paralelo, como un navegador.
           *
           * Sin tope, `HttpClient` abre una conexión por petición concurrente
           * y cada una paga su propio handshake. Con seis, las que sobran
           * esperan un hueco en vez de gastar 280 ms en abrir su propio túnel.
           */
          ..maxConnectionsPerHost = 6,
      );
    }

    /**
     * ⚠️ Los interceptores van SIEMPRE, con `Dio` propio o inyectado.
     *
     * Sólo el adaptador queda afuera del `if`: es lo único que un doble de
     * pruebas reemplaza. Meter los interceptores adentro dejaría a cualquier
     * test con `Dio` inyectado sin autenticación ni refresco de token — o sea
     * probando un cliente que no es el que corre.
     */
    _dio.interceptors.add(
      InterceptorsWrapper(onRequest: _alPedir, onResponse: _alResponder),
    );

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * QUÉ PETICIÓN SE LLEVA EL ARRANQUE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * «La primera apertura tarda muchísimo» no dice cuál de las peticiones es.
     * Y son varias, con costos muy distintos: la primera paga además abrir la
     * conexión —unos 280 ms de TCP y TLS desde Argentina— y las siguientes no.
     *
     * Esto anota cada petición mientras la traza del arranque sigue corriendo,
     * o sea hasta que el feed se ve. Después se apaga solo y no cuesta nada.
     *
     * ⚠️ Sólo el método y la RUTA. Nunca la cadena de consulta —ahí viaja el
     * término de búsqueda—, nunca las cabeceras, nunca el cuerpo.
     */
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (opciones, siguiente) {
          if (TrazaDeArranque.instancia.corriendo) {
            opciones.extra['_desdeMs'] = TrazaDeArranque.instancia.ahora;
          }
          siguiente.next(opciones);
        },
        onResponse: (respuesta, siguiente) {
          _anotar(respuesta.requestOptions, respuesta.statusCode);
          siguiente.next(respuesta);
        },
        onError: (error, siguiente) {
          _anotar(error.requestOptions, null);
          siguiente.next(error);
        },
      ),
    );
  }

  void _anotar(RequestOptions opciones, int? codigo) {
    final desde = opciones.extra['_desdeMs'];
    if (desde is! int || !TrazaDeArranque.instancia.corriendo) return;

    final etiqueta = codigo == null ? 'falló' : '$codigo';
    TrazaDeArranque.instancia.tramo(
      '${opciones.method} ${opciones.path} $etiqueta',
      desdeMs: desde,
    );
  }

  final Dio _dio;
  final TokenStore _tokens;
  final Future<void> Function()? _onSesionCerrada;

  /// El refresco en curso, si hay uno. Es lo que evita la estampida.
  Future<bool>? _refrescoEnCurso;

  Dio get raw => _dio;

  void applyConfig() {
    _dio.options.baseUrl = '${RuntimeConfig.instance.apiBaseUrl}/api/v1';
  }

  Future<void> _alPedir(RequestOptions options, RequestInterceptorHandler handler) async {
    /**
     * Sin cuerpo, sin `content-type`.
     *
     * ─── El bug que esto arregla ───
     *
     * `content-type: application/json` estaba puesto como cabecera POR DEFECTO
     * de todas las peticiones. Un DELETE no lleva cuerpo, así que salía
     * anunciando JSON y mandando cero bytes — y Fastify contesta:
     *
     *     400 · Body cannot be empty when content-type is set to
     *           'application/json'
     *
     * Eso rompía TODOS los DELETE de la app a la vez: cancelar una reserva,
     * borrar un producto, borrar una foto y eliminar la cuenta. Cuatro
     * funciones distintas con una sola causa.
     *
     * Y no lo detectó nadie: los tests usan `inject()`, que sólo manda
     * `content-type` cuando hay cuerpo, y las pruebas con curl tampoco lo
     * mandaban. O sea que el servidor estaba bien probado contra un cliente
     * que no era el nuestro.
     *
     * La cabecera describe el cuerpo. Si no hay cuerpo, no hay nada que
     * describir.
     */
    if (options.data == null) {
      options.headers.remove('content-type');
      options.headers.remove('Content-Type');
    }

    if (options.extra['sinAuth'] == true) return handler.next(options);

    /// Refresco PREVENTIVO.
    ///
    /// Si el token está por vencer se renueva antes de mandar, en vez de
    /// esperar el 401. Ahorra un viaje de ida y vuelta en el caso más común
    /// —abrir la app después de un rato— y evita que la primera pantalla
    /// parpadee mientras reintenta.
    if (await _tokens.aPuntoDeVencer()) {
      await _refrescar();
    }

    final token = await _tokens.accessToken();
    if (token != null) options.headers['authorization'] = 'Bearer $token';
    handler.next(options);
  }

  Future<void> _alResponder(Response<dynamic> res, ResponseInterceptorHandler handler) async {
    final esAuth = res.requestOptions.extra['sinAuth'] != true;
    final yaReintentado = res.requestOptions.extra['reintentado'] == true;

    if (res.statusCode != 401 || !esAuth || yaReintentado) {
      return handler.next(res);
    }

    // 401 pese al refresco preventivo: el token se invalidó del otro lado
    // (cuenta suspendida, sesión revocada, o el reloj estaba desfasado).
    final ok = await _refrescar();
    if (!ok) return handler.next(res);

    try {
      final opciones = res.requestOptions;
      opciones.extra['reintentado'] = true;
      final token = await _tokens.accessToken();
      if (token != null) opciones.headers['authorization'] = 'Bearer $token';
      final reintento = await _dio.fetch<dynamic>(opciones);
      return handler.resolve(reintento);
    } catch (_) {
      return handler.next(res);
    }
  }

  /// Refresca la sesión. Concurrente-seguro: varias llamadas comparten una.
  Future<bool> _refrescar() {
    // Si ya hay uno en vuelo, se espera ESE. Acá está la protección contra la
    // estampida que haría que el backend nos tome por ladrones.
    return _refrescoEnCurso ??= _hacerRefresco().whenComplete(() {
      _refrescoEnCurso = null;
    });
  }

  Future<bool> _hacerRefresco() async {
    final refresh = await _tokens.refreshToken();
    if (refresh == null) return false;

    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/auth/refresh',
        data: {'refreshToken': refresh},
        // Sin auth: es el endpoint que se usa justamente cuando no hay token
        // válido. Y sin reintento, para no entrar en un bucle.
        options: Options(extra: {'sinAuth': true, 'reintentado': true}),
      );

      final datos = res.data;
      if (res.statusCode != 200 && res.statusCode != 201 || datos == null) {
        /**
         * La sesión murió del lado del servidor.
         *
         * Puede ser expiración, cierre desde otro dispositivo, o detección de
         * robo. En los tres casos lo correcto es lo mismo: limpiar y pedir que
         * vuelva a entrar. Insistir sólo genera más rechazos.
         */
        await _tokens.limpiar();
        await _onSesionCerrada?.call();
        return false;
      }

      await _tokens.actualizarAcceso(
        accessToken: datos['accessToken'] as String,
        refreshToken: datos['refreshToken'] as String,
        expiraEn: DateTime.parse(datos['expiresAt'] as String),
      );
      return true;
    } on DioException {
      /**
       * Falló la RED, no la sesión.
       *
       * Distinción crítica: acá NO se limpian los tokens. Si lo hiciéramos,
       * un subte sin señal desloguearía a la persona, que es exactamente el
       * momento en que menos ganas tiene de volver a iniciar sesión.
       */
      return false;
    }
  }

  // ── Atajos ──

  Future<Response<T>> get<T>(String path, {Map<String, dynamic>? query, bool sinAuth = false}) =>
      _dio.get<T>(path, queryParameters: query, options: Options(extra: {'sinAuth': sinAuth}));

  /// `POST`, opcionalmente idempotente.
  ///
  /// `idempotencyKey` viaja como cabecera `Idempotency-Key` y le dice al
  /// servidor «esto es el mismo pedido que el anterior». Es lo único que evita
  /// duplicar cuando la petición llegó y lo que se perdió fue la respuesta —el
  /// caso que ningún botón deshabilitado cubre, porque para el teléfono «no me
  /// contestaron» y «no llegó» son lo mismo.
  Future<Response<T>> post<T>(
    String path, {
    Object? data,
    bool sinAuth = false,
    String? idempotencyKey,
  }) =>
      _dio.post<T>(
        path,
        data: data,
        options: Options(
          extra: {'sinAuth': sinAuth},
          headers: idempotencyKey == null ? null : {'idempotency-key': idempotencyKey},
        ),
      );

  Future<Response<T>> patch<T>(String path, {Object? data}) => _dio.patch<T>(path, data: data);

  /// Reemplazo completo. Se usa donde el backend expone `PUT` de verdad —el
  /// horario de la tienda— y no como sinónimo de `PATCH`: mandar medio recurso
  /// a un `PUT` borra lo que no se mandó.
  Future<Response<T>> put<T>(String path, {Object? data}) => _dio.put<T>(path, data: data);

  Future<Response<T>> delete<T>(String path) => _dio.delete<T>(path);
}
