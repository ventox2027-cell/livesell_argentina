import 'dart:async';

import 'package:dio/dio.dart';

import '../auth/token_store.dart';
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

    _dio.interceptors.add(
      InterceptorsWrapper(onRequest: _alPedir, onResponse: _alResponder),
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

  Future<Response<T>> post<T>(String path, {Object? data, bool sinAuth = false}) =>
      _dio.post<T>(path, data: data, options: Options(extra: {'sinAuth': sinAuth}));

  Future<Response<T>> patch<T>(String path, {Object? data}) => _dio.patch<T>(path, data: data);

  /// Reemplazo completo. Se usa donde el backend expone `PUT` de verdad —el
  /// horario de la tienda— y no como sinónimo de `PATCH`: mandar medio recurso
  /// a un `PUT` borra lo que no se mandó.
  Future<Response<T>> put<T>(String path, {Object? data}) => _dio.put<T>(path, data: data);

  Future<Response<T>> delete<T>(String path) => _dio.delete<T>(path);
}
