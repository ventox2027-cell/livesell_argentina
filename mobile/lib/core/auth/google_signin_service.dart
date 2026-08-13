import 'package:google_sign_in/google_sign_in.dart';

/// Inicio de sesión con Google.
///
/// ─── El detalle que hace fallar esta integración ───
///
/// En Android hay que pasar `serverClientId` con el ID del cliente **WEB**, no
/// el de Android. Ese parámetro es lo que hace que Google emita un token de
/// identidad con la audiencia correcta — la que nuestro backend verifica.
///
/// Sin él, o no llega token, o llega uno cuya audiencia el backend rechaza. Es
/// contraintuitivo y es el motivo por el que la mitad de las integraciones de
/// Google Sign-In no funcionan la primera vez.
///
/// El cliente de Android igual hace falta, aunque su ID no se nombre acá:
/// Google valida el paquete y la huella del certificado al autorizar el flujo.
///
/// ─── Lo que NO hace ───
///
/// No decide nada sobre la sesión. Obtiene un token de Google y lo entrega; a
/// partir de ahí manda el backend, que es el único que puede verificar la
/// firma. La app nunca cree lo que dice un token sin verificar.
class GoogleSignInService {
  GoogleSignInService._();
  static final instance = GoogleSignInService._();

  bool _inicializado = false;
  String? _serverClientId;

  /// Prepara el SDK. Idempotente: la app puede llamarlo cada vez que resuelve
  /// la configuración sin que eso cueste nada.
  Future<void> inicializar({required String serverClientId}) async {
    if (_inicializado && _serverClientId == serverClientId) return;
    await GoogleSignIn.instance.initialize(serverClientId: serverClientId);
    _inicializado = true;
    _serverClientId = serverClientId;
  }

  bool get listo => _inicializado;

  /// Abre el selector de cuentas y devuelve el token de identidad.
  ///
  /// `null` significa que la persona canceló, que no es un error: cerrar el
  /// selector es una decisión válida y no tiene que mostrar nada rojo.
  Future<String?> obtenerIdToken() async {
    if (!_inicializado) {
      throw StateError('Google Sign-In sin inicializar: falta el serverClientId');
    }

    try {
      final cuenta = await GoogleSignIn.instance.authenticate();
      final idToken = cuenta.authentication.idToken;

      if (idToken == null) {
        /// Sin token de identidad no hay nada que verificar.
        ///
        /// Cuando pasa, casi siempre es una de dos: el `serverClientId` no
        /// corresponde a un cliente WEB, o el cliente de Android no tiene
        /// cargada la huella del certificado con el que está firmado el APK.
        throw const GoogleSignInFallo(
          'Google no devolvió un token de identidad. Revisá el client ID web y '
          'la huella SHA-1 del cliente de Android.',
        );
      }
      return idToken;
    } on GoogleSignInException catch (e) {
      // Cancelar no es un fallo.
      if (e.code == GoogleSignInExceptionCode.canceled) return null;

      throw GoogleSignInFallo(_explicar(e));
    }
  }

  Future<void> cerrarSesion() async {
    if (!_inicializado) return;
    try {
      await GoogleSignIn.instance.signOut();
    } catch (_) {
      // Que Google no pueda cerrar su sesión no puede impedir que la persona
      // salga de la nuestra.
    }
  }

  /// Traduce los códigos del SDK a algo accionable.
  ///
  /// El más común y el más opaco es el de configuración: Google no dice qué
  /// está mal, y las causas posibles son siempre las mismas tres.
  String _explicar(GoogleSignInException e) {
    return switch (e.code) {
      GoogleSignInExceptionCode.canceled => 'Cancelaste el inicio de sesión.',
      GoogleSignInExceptionCode.interrupted =>
        'Se interrumpió el inicio de sesión. Probá de nuevo.',
      GoogleSignInExceptionCode.clientConfigurationError =>
        'La configuración de Google no coincide con esta app. Suele ser la huella '
            'SHA-1, el nombre del paquete, o que el cambio todavía no propagó '
            '(puede tardar horas).',
      GoogleSignInExceptionCode.providerConfigurationError =>
        'Falta configurar el proyecto de Google.',
      GoogleSignInExceptionCode.uiUnavailable =>
        'No se pudo abrir el selector de cuentas de Google.',
      GoogleSignInExceptionCode.userMismatch =>
        'La cuenta elegida no coincide con la esperada.',
      _ => 'No se pudo iniciar sesión con Google: ${e.description ?? e.code.name}',
    };
  }
}

class GoogleSignInFallo implements Exception {
  const GoogleSignInFallo(this.mensaje);
  final String mensaje;
  @override
  String toString() => mensaje;
}
