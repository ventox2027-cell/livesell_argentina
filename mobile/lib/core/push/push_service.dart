import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import '../enlaces/destino.dart';

/// Lo que corre cuando llega un aviso con la app CERRADA o en segundo plano.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// TIENE QUE SER UNA FUNCIÓN DE NIVEL SUPERIOR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Firebase la ejecuta en un motor de Dart **aparte**: no hay árbol de
/// widgets, no hay providers, no hay nada del estado de la app. Un método de
/// una clase o una función anidada no se puede referenciar desde ahí y falla
/// en tiempo de ejecución, no al compilar.
///
/// ⚠️ Y por eso mismo no navega ni toca la interfaz. Lo único que hace falta
/// acá es que exista: Android muestra la notificación solo, y el destino se
/// resuelve recién cuando alguien la toca —ahí sí con la app viva—.
@pragma('vm:entry-point')
Future<void> manejarAvisoEnSegundoPlano(RemoteMessage mensaje) async {
  debugPrint('Push: aviso en segundo plano (${mensaje.data['type']})');
}

/// Los avisos push.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BACKEND YA DECIDE QUÉ Y A QUIÉN. ESTO SÓLO RECIBE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Quién recibe qué, qué categorías están apagadas, cuáles no se pueden apagar,
/// los reintentos y los tokens muertos: todo eso vive en el servidor desde hace
/// rato y funciona. Este archivo no reimplementa nada de eso.
///
/// Lo único que hace la app es: pedir permiso, conseguir el token, entregárselo
/// al backend por el endpoint que ya existe, y saber a dónde llevar cuando
/// alguien toca un aviso.
///
/// ⚠️ **No hay filtrado de categorías acá.** El backend ya no crea el aviso si
/// la persona apagó esa categoría —ver `notifications.service.ts`, la primera
/// línea de `crear()`—. Un segundo filtro del lado de la app sería una segunda
/// definición de la misma regla, y el día que difieran nadie va a saber cuál
/// manda.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL PERMISO NO SE PIDE AL ABRIR LA APP
/// ═══════════════════════════════════════════════════════════════════════════
///
/// En Android 13+ el permiso se pide una sola vez de verdad: si la persona
/// dice que no, el sistema no vuelve a mostrar el diálogo nunca más y hay que
/// mandarla a los ajustes del teléfono. O sea que la primera vez es la única.
///
/// Gastarla en el arranque —cuando todavía no sabe qué es la app— es
/// convertirla en un "no" casi seguro. Se pide después de la primera compra,
/// que es el momento en que un aviso significa algo concreto: «te avisamos
/// cuando tu pedido salga». Ver `permiso_de_avisos.dart`.
class PushService {
  PushService._();
  static final instance = PushService._();

  bool _inicializado = false;
  String? _ultimoTokenEnviado;

  /// Se llama cuando llega un aviso y hay que llevar a alguien a algún lado.
  ///
  /// Lo pone la capa de arriba: este archivo no conoce el enrutador ni las
  /// pantallas. Quién resuelve el destino es `core/enlaces/destino.dart`, el
  /// mismo módulo que usan los enlaces de vendox.com.ar — con dos resolutores,
  /// el mismo producto abriría una pantalla desde WhatsApp y otra desde un
  /// aviso.
  void Function(Destino destino)? alTocar;

  /// Sube el token al backend. Lo inyecta quien tenga el repositorio de auth.
  Future<void> Function(String? token)? registrarToken;

  /// Si Firebase está disponible en este binario.
  ///
  /// `false` cuando falta `google-services.json` — que es exactamente el estado
  /// de cualquier clon del repositorio, porque ese archivo no se versiona. La
  /// app tiene que arrancar igual: sin avisos, no rota.
  bool get disponible => _inicializado;

  /// Arranca Firebase. Se llama una vez, al iniciar la app.
  ///
  /// ⚠️ No pide permiso ni pregunta el token: sólo deja el motor encendido.
  /// Pedir permiso acá es el error que este archivo existe para evitar.
  Future<void> inicializar() async {
    if (_inicializado) return;

    try {
      await Firebase.initializeApp();
      _inicializado = true;
    } catch (e) {
      /**
       * Sin `google-services.json` esto tira, y está bien que tire acá y no en
       * medio de una compra. La app sigue: los avisos son una mejora, no un
       * requisito para vender.
       */
      debugPrint('Push: Firebase no inicializó, la app sigue sin avisos. $e');
      return;
    }

    // Con la app abierta, Android no muestra nada por su cuenta. Esto pide que
    // sí lo haga, para no tener que dibujar un cartel propio.
    await FirebaseMessaging.instance
        .setForegroundNotificationPresentationOptions(alert: true, badge: true, sound: true);

    /**
     * El token se renueva solo: al reinstalar, al restaurar un backup, o cuando
     * Firebase lo decide. Sin escuchar esto, el backend se queda con uno viejo
     * y los avisos dejan de llegar sin que nadie se entere.
     */
    FirebaseMessaging.instance.onTokenRefresh.listen((token) {
      _ultimoTokenEnviado = null; // fuerza el reenvío aunque el valor repita
      unawaited(_subir(token));
    });

    // App abierta.
    FirebaseMessaging.onMessage.listen((mensaje) {
      debugPrint('Push: aviso en primer plano (${mensaje.data['type']})');
    });

    // App CERRADA o en segundo plano: Firebase despierta un motor aparte.
    FirebaseMessaging.onBackgroundMessage(manejarAvisoEnSegundoPlano);

    // App en segundo plano y se toca el aviso.
    FirebaseMessaging.onMessageOpenedApp.listen(_abrir);

    /**
     * App CERRADA y se toca el aviso.
     *
     * Éste es distinto de los otros dos: el aviso llegó antes de que existiera
     * el listener, así que hay que preguntarlo explícitamente. Es el caso que
     * más se olvida y el que hace que «toqué la notificación y me abrió el
     * feed» sea el bug más común de cualquier app con push.
     */
    final inicial = await FirebaseMessaging.instance.getInitialMessage();
    if (inicial != null) _abrir(inicial);
  }

  /// Pide el permiso y, si lo dan, sube el token.
  ///
  /// Devuelve si quedó habilitado. Quien llama decide qué mostrar con eso —
  /// este archivo no dibuja nada.
  Future<bool> pedirPermisoYRegistrar() async {
    if (!_inicializado) return false;

    final ajustes = await FirebaseMessaging.instance.requestPermission();
    final autorizado = ajustes.authorizationStatus == AuthorizationStatus.authorized ||
        ajustes.authorizationStatus == AuthorizationStatus.provisional;

    if (!autorizado) return false;

    final token = await FirebaseMessaging.instance.getToken();
    if (token != null) await _subir(token);
    return true;
  }

  /// Si ya lo autorizó antes, vuelve a subir el token sin volver a preguntar.
  ///
  /// Se llama al entrar: el token puede haber cambiado mientras la sesión
  /// estaba cerrada, y quien ya dijo que sí no tiene que volver a decidirlo.
  Future<void> reengancharSiYaAutorizo() async {
    if (!_inicializado) return;

    final ajustes = await FirebaseMessaging.instance.getNotificationSettings();
    if (ajustes.authorizationStatus != AuthorizationStatus.authorized) return;

    final token = await FirebaseMessaging.instance.getToken();
    if (token != null) await _subir(token);
  }

  /// Desvincula el token de esta cuenta al cerrar sesión.
  ///
  /// ═══════════════════════════════════════════════════════════════════════
  /// ES LO QUE EVITA MANDARLE LOS AVISOS DE UNO AL TELÉFONO DE OTRO
  /// ═══════════════════════════════════════════════════════════════════════
  ///
  /// Sin esto, el dispositivo queda asociado a la cuenta anterior. Alguien
  /// cierra sesión, entra otra persona en el mismo teléfono, y el primero
  /// sigue recibiendo «tu pedido salió» de pedidos que ya no son suyos.
  ///
  /// Se avisa al backend ANTES de borrar el token local: si se borra primero y
  /// la red falla, no queda nada que mandar y el vínculo sobrevive.
  Future<void> desvincular() async {
    _ultimoTokenEnviado = null;

    try {
      await registrarToken?.call(null);
    } catch (e) {
      // Sin red no se puede avisar. Se borra local igual —la persona pidió
      // salir— y el token queda huérfano hasta que el backend lo declare
      // muerto en el primer envío fallido.
      debugPrint('Push: no se pudo desvincular en el servidor. $e');
    }

    if (!_inicializado) return;
    try {
      await FirebaseMessaging.instance.deleteToken();
    } catch (_) {
      // Idem: no puede impedir cerrar sesión.
    }
  }

  /// Sube el token, salvo que sea el mismo que ya se subió.
  ///
  /// El corto se paga: `getToken()` devuelve lo mismo en cada arranque, y sin
  /// esto la app haría una escritura en la base por cada vez que se abre.
  Future<void> _subir(String token) async {
    if (token == _ultimoTokenEnviado) return;

    try {
      await registrarToken?.call(token);
      _ultimoTokenEnviado = token;
    } catch (e) {
      // Se reintenta en el próximo arranque o en la próxima renovación. No hay
      // cola propia: agregar reintentos acá sería un segundo sistema al lado
      // del que el backend ya tiene.
      debugPrint('Push: no se pudo registrar el token. $e');
    }
  }

  void _abrir(RemoteMessage mensaje) {
    final destino = resolverAviso(mensaje.data);
    if (destino != null) alTocar?.call(destino);
  }
}
