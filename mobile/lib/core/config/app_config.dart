/// Valores por defecto inyectados en tiempo de compilación con `--dart-define`.
///
/// Son solo el punto de partida: lo que la app usa realmente sale de
/// [RuntimeConfig], que permite cambiar la URL del backend desde la pantalla de
/// inicio sin recompilar. Eso importa porque al pasar de WiFi a datos móviles
/// la dirección del backend cambia.
///
/// NUNCA un archivo `.env` empaquetado en el bundle: extraer un asset de un APK
/// es trivial. Y NUNCA las claves de LiveKit acá: la app solo recibe tokens ya
/// firmados por el backend.
class AppConfig {
  const AppConfig._();

  /// URL base del backend. Sin barra final.
  static const defaultApiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3100', // emulador de Android → localhost del host
  );

  /// Clave compartida del módulo de spike. Es de un entorno de pruebas y su
  /// alcance es crear salas de test; aun así, no se commitea.
  static const defaultSpikeApiKey = String.fromEnvironment('SPIKE_API_KEY');

  /// Cuántas muestras se acumulan antes de subir. Con 1/s son 10 s de buffer.
  static const sampleBatchSize = 10;

  /// Cada cuánto se toma una muestra de calidad.
  static const sampleIntervalMs = 1000;

  /// Cada cuánto el broadcaster publica la sonda de latencia por el canal de
  /// datos. 500 ms da ~120 muestras en un minuto: suficiente para percentiles
  /// sin saturar el canal.
  static const probeIntervalMs = 500;

  /// Reintentos de sincronización de reloj. Se conserva la de menor RTT.
  static const clockSyncSamples = 7;
}
