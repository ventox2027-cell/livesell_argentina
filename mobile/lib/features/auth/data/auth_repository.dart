import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:dio/dio.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/auth/token_store.dart';
import '../../../core/network/api_client.dart';
import '../domain/session.dart';

/// Habla con la API de autenticación.
class AuthRepository {
  AuthRepository({required ApiClient api, required TokenStore tokens})
      : _api = api,
        _tokens = tokens;

  final ApiClient _api;
  final TokenStore _tokens;

  static const _kInstallId = 'device.installId';

  /// Identificador estable de la instalación.
  ///
  /// Se genera una vez y se guarda. NO se usa el ID de publicidad ni nada que
  /// identifique a la persona entre aplicaciones distintas: esto sirve para
  /// que pueda cerrar la sesión de un teléfono concreto, y para nada más.
  Future<String> _installId() async {
    final prefs = await SharedPreferences.getInstance();
    final existente = prefs.getString(_kInstallId);
    if (existente != null) return existente;

    final nuevo = 'inst_${DateTime.now().microsecondsSinceEpoch}_${pid.hashCode.abs()}';
    await prefs.setString(_kInstallId, nuevo);
    return nuevo;
  }

  Future<Map<String, dynamic>> _dispositivo({String? pushToken}) async {
    final info = DeviceInfoPlugin();
    String modelo = 'desconocido';
    String osVersion = 'desconocida';
    final String plataforma = Platform.isIOS ? 'ios' : 'android';

    try {
      if (Platform.isAndroid) {
        final a = await info.androidInfo;
        modelo = '${a.manufacturer} ${a.model}';
        osVersion = 'Android ${a.version.release}';
      } else if (Platform.isIOS) {
        final i = await info.iosInfo;
        modelo = i.utsname.machine;
        osVersion = '${i.systemName} ${i.systemVersion}';
      }
    } catch (_) {
      // El modelo es para diagnóstico. Que falle no puede impedir entrar.
    }

    return {
      'installId': await _installId(),
      'platform': plataforma,
      'appVersion': '0.1.0',
      'osVersion': osVersion,
      'model': modelo,
      if (pushToken != null) 'pushToken': pushToken,
      'timezone': 'America/Argentina/Buenos_Aires',
    };
  }

  Future<ConSesion> loginConGoogle(String idToken, {String? pushToken}) async => _login(
        '/auth/google',
        {'idToken': idToken, 'device': await _dispositivo(pushToken: pushToken)},
      );

  Future<ConSesion> loginConApple(
    String idToken, {
    String? firstName,
    String? lastName,
    String? pushToken,
  }) async =>
      _login('/auth/apple', {
        'idToken': idToken,
        if (firstName != null) 'firstName': firstName,
        if (lastName != null) 'lastName': lastName,
        'device': await _dispositivo(pushToken: pushToken),
      });

  /// Acceso de desarrollo. Sólo funciona si el backend lo tiene habilitado,
  /// que en producción está prohibido por configuración.
  Future<ConSesion> loginDeDesarrollo({
    required String email,
    String firstName = 'Prueba',
    String lastName = 'Local',
    String role = 'buyer',
  }) async =>
      _login('/auth/dev', {
        'email': email,
        'firstName': firstName,
        'lastName': lastName,
        'role': role,
        'device': await _dispositivo(),
      });

  Future<ConSesion> _login(String ruta, Map<String, dynamic> cuerpo) async {
    final res = await _api.post<Map<String, dynamic>>(ruta, data: cuerpo, sinAuth: true);
    final datos = res.data;

    if (datos == null || (res.statusCode != 200 && res.statusCode != 201)) {
      throw AuthException(_mensajeDeError(res));
    }

    final usuario = Usuario.fromJson(datos['user'] as Map<String, dynamic>);
    await _tokens.guardar(
      accessToken: datos['accessToken'] as String,
      refreshToken: datos['refreshToken'] as String,
      expiraEn: DateTime.parse(datos['expiresAt'] as String),
      usuario: usuario.toJson(),
    );

    return ConSesion(usuario: usuario, faltantes: _faltantes(datos['missing']));
  }

  /// Restaura la sesión al abrir la app.
  ///
  /// Se consulta al backend en vez de confiar en lo guardado: la cuenta puede
  /// haber sido suspendida, o el perfil actualizado desde otro dispositivo.
  /// Si no hay red, se usa lo que había en disco — es preferible mostrar datos
  /// de hace un rato a exigir conexión para abrir la app.
  Future<EstadoSesion> restaurar() async {
    final refresh = await _tokens.refreshToken();
    if (refresh == null) return const SinSesion();

    try {
      final res = await _api.get<Map<String, dynamic>>('/auth/me');
      final datos = res.data;

      if (res.statusCode == 200 && datos != null) {
        final usuario = Usuario.fromJson(datos);
        await _tokens.guardarUsuario(usuario.toJson());
        return ConSesion(usuario: usuario, faltantes: _faltantes(datos['missing']));
      }

      if (res.statusCode == 401) {
        await _tokens.limpiar();
        return const SinSesion(motivo: 'Tu sesión venció. Entrá de nuevo.');
      }
      if (res.statusCode == 403) {
        await _tokens.limpiar();
        return const SinSesion(motivo: 'Tu cuenta está suspendida.');
      }
    } on DioException {
      // Sin red: se sigue con lo guardado.
    }

    final guardado = await _tokens.usuario();
    if (guardado == null) return const SinSesion();
    return ConSesion(usuario: Usuario.fromJson(guardado));
  }

  Future<ConSesion> completarPerfil({
    String? firstName,
    String? lastName,
    String? phone,
    bool? whatsappOptIn,
    /// `AAAA-MM-DD`. VendoX es 18+ y sólo se puede declarar una vez.
    String? fechaDeNacimiento,
  }) async {
    final res = await _api.patch<Map<String, dynamic>>('/auth/me', data: {
      if (firstName != null) 'firstName': firstName,
      if (lastName != null) 'lastName': lastName,
      if (phone != null) 'phone': phone,
      if (whatsappOptIn != null) 'whatsappOptIn': whatsappOptIn,
      if (fechaDeNacimiento != null) 'birthDate': fechaDeNacimiento,
    });

    if (res.statusCode != 200 || res.data == null) {
      throw AuthException(_mensajeDeError(res), codigo: _codigoDeError(res));
    }

    final usuario = Usuario.fromJson(res.data!);
    await _tokens.guardarUsuario(usuario.toJson());
    // Se relee el estado para saber qué sigue faltando.
    final me = await _api.get<Map<String, dynamic>>('/auth/me');
    return ConSesion(usuario: usuario, faltantes: _faltantes(me.data?['missing']));
  }

  Future<void> cerrarSesion() async {
    final refresh = await _tokens.refreshToken();
    if (refresh != null) {
      try {
        await _api.post<Map<String, dynamic>>(
          '/auth/logout',
          data: {'refreshToken': refresh},
          sinAuth: true,
        );
      } on DioException {
        // Si no hay red, igual se limpia local: la persona pidió salir y la
        // app tiene que obedecer. El token de servidor vence solo.
      }
    }
    await _tokens.limpiar();
  }

  Future<void> cerrarTodasLasSesiones() async {
    try {
      await _api.post<Map<String, dynamic>>('/auth/logout-all');
    } finally {
      await _tokens.limpiar();
    }
  }

  Future<List<Map<String, dynamic>>> sesionesActivas() async {
    final res = await _api.get<List<dynamic>>('/auth/sessions');
    return (res.data ?? []).cast<Map<String, dynamic>>();
  }

  Future<void> cerrarCuenta() async {
    final res = await _api.delete<Map<String, dynamic>>('/auth/me');

    /**
     * ⚠️ Se comprueba el estado antes de limpiar, y antes NO se hacía.
     *
     * `ApiClient` usa `validateStatus: s < 500`, así que un 409 —hay pedidos en
     * curso, el backend no cerró nada— volvía por acá como si todo hubiera
     * salido bien. La app borraba la sesión local y mostraba "tu cuenta fue
     * eliminada" sobre una cuenta que seguía viva, con las ventas pendientes
     * intactas y sin forma de volver a entrar hasta iniciar sesión de nuevo.
     */
    if (res.statusCode != 200) {
      throw AuthException(_mensajeDeError(res), codigo: _codigoDeError(res));
    }

    await _tokens.limpiar();
  }

  /// Todo lo que el backend guarda sobre esta persona.
  ///
  /// Es un derecho, no una función de conveniencia: lo exige la Ley 25.326.
  Future<Map<String, dynamic>> exportarMisDatos() async {
    final res = await _api.get<Map<String, dynamic>>('/auth/me/export');
    if (res.statusCode != 200 || res.data == null) {
      throw AuthException(_mensajeDeError(res), codigo: _codigoDeError(res));
    }
    return res.data!;
  }

  List<DatoFaltante> _faltantes(Object? crudo) {
    if (crudo is! List) return const [];
    return crudo
        .whereType<String>()
        .map(DatoFaltante.desde)
        .whereType<DatoFaltante>()
        .toList(growable: false);
  }

  /// Mensaje para mostrar.
  ///
  /// Se prefiere SIEMPRE el del backend: es el único lugar donde se traducen
  /// los errores, y duplicar esos textos acá garantizaría que un día digan
  /// cosas distintas.
  String _mensajeDeError(Response<dynamic> res) {
    final datos = res.data;
    if (datos is Map && datos['error'] is Map) {
      final msg = (datos['error'] as Map)['message'];
      if (msg is String && msg.isNotEmpty) return msg;
    }
    return 'No pudimos completar la operación. Probá de nuevo.';
  }

  String? _codigoDeError(Response<dynamic> res) {
    final datos = res.data;
    if (datos is Map && datos['error'] is Map) {
      return (datos['error'] as Map)['code'] as String?;
    }
    return null;
  }
}

class AuthException implements Exception {
  AuthException(this.mensaje, {this.codigo});
  final String mensaje;

  /// El código estable del backend. Por ejemplo UNDERAGE.
  final String? codigo;

  /// La persona declaró ser menor de 18.
  ///
  /// Se distingue del resto porque NO se resuelve reintentando ni completando
  /// nada: la hoja tiene que cerrarse con una explicación, no volver a pedir la
  /// fecha en un bucle.
  bool get esMenorDeEdad => codigo == 'UNDERAGE';

  /// Ya estaba declarada y la nueva es distinta. Se corrige por soporte.
  bool get fechaYaDeclarada => codigo == 'BIRTH_DATE_ALREADY_SET';

  @override
  String toString() => mensaje;
}
