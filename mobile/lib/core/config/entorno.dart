import 'package:flutter/foundation.dart';

/// Qué parte de la app es para nosotros y qué parte es para la gente.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL PROBLEMA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El perfil tenía una sección «Desarrollo» con las herramientas del Sprint 0 y
/// la URL del backend a la vista, y la pantalla de bienvenida un botón
/// «Configurar servidor». Todo eso viaja en la APK que se sube a Google Play.
///
/// Tres cosas distintas mal:
///
///   1. **Un revisor de Google entra ahí.** Una pantalla de medición de
///      latencia de LiveKit en una app de compras es exactamente lo que hace
///      que una revisión se detenga a preguntar qué es.
///   2. **«Configurar servidor» es apuntar la app a donde uno quiera.** En un
///      teléfono ajeno eso significa que alguien puede redirigir la app a un
///      servidor suyo y ver pasar todo lo que la app manda.
///   3. **La URL del backend a la vista** le regala a cualquiera el objetivo a
///      atacar sin tener que abrir la APK.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ NO ALCANZA CON `kReleaseMode`
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La prueba de campo se hace con APKs de release —una compilación de debug no
/// sirve para medir latencia ni para dársela a alguien que está en otra
/// ciudad—, y esas APKs necesitan poder cambiar de servidor: al pasar de WiFi a
/// datos móviles la dirección del backend cambia, y sin ese botón hay que
/// recompilar y reinstalar en cada teléfono.
///
/// Entonces son dos ejes, no uno:
///
/// | Compilación                                       | Herramientas |
/// |---------------------------------------------------|--------------|
/// | debug                                             | sí           |
/// | release con `--dart-define=VENDOX_HERRAMIENTAS=true` | sí        |
/// | release sin nada                                  | **no**       |
///
/// La APK de Google Play se compila sin la bandera, y no hay forma de
/// encenderla desde adentro: es una constante de compilación, así que el código
/// de esas pantallas ni siquiera queda en el binario.
class Entorno {
  const Entorno._();

  /// Encendido a mano al compilar:
  ///
  /// ```
  /// flutter build apk --release --dart-define=VENDOX_HERRAMIENTAS=true
  /// ```
  static const _pedidasAlCompilar = bool.fromEnvironment('VENDOX_HERRAMIENTAS');

  /// ¿Se muestran las herramientas internas?
  ///
  /// En debug siempre: es la compilación con la que se desarrolla y esconderlas
  /// ahí sólo molesta.
  static const herramientas = kDebugMode || _pedidasAlCompilar;

  /// Lo contrario, para que las condiciones se lean derechas.
  ///
  /// `if (Entorno.esParaLaGente)` se entiende de una; `if (!Entorno.herramientas)`
  /// obliga a leer dos veces.
  static const esParaLaGente = !herramientas;
}
