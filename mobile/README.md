# mobile · App del Sprint 0

App Flutter del spike de LiveKit. **No es la app del producto**: es el
instrumento de medición. Se descarta cuando el spike tenga veredicto.

Lo que sí sobrevive es el patrón: `ClockSync`, `StatsAdapter` y la separación
entre instrumentación (controlador) y presentación (widgets).

## Puesta en marcha

Este directorio trae `lib/` y `pubspec.yaml`, pero **no** las carpetas nativas
`android/` e `ios/`: se generan con la herramienta de Flutter para que queden
con la versión y el identificador correctos.

```bash
cd mobile

# 1. Generar los proyectos nativos SIN pisar lib/ ni pubspec.yaml.
#    `flutter create .` respeta los archivos existentes.
#
#    ⛔ El identificador definitivo es `com.vendox.app`. Si algún día hay que
#    regenerar las carpetas nativas, tiene que salir con ESE paquete: después
#    de publicar en Google Play no se puede cambiar nunca más.
flutter create . --org com.vendox --project-name app --platforms android,ios

# 2. Dependencias
flutter pub get

# 3. Permisos nativos — ver docs/sprint-0/RUNBOOK-livekit.md §5
#    Android: CAMERA, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS… + minSdk 23
#    iOS:     NSCameraUsageDescription, NSMicrophoneUsageDescription + iOS 13

# 4. Correr en un dispositivo FÍSICO, en release
flutter devices
flutter run --release -d <deviceId> \
  --dart-define=API_BASE_URL=https://livesell-api-staging.fly.dev \
  --dart-define=SPIKE_API_KEY=<clave>
```

> **`--release`, siempre.** En debug, Dart corre sin AOT y los números salen
> entre un 20 % y un 40 % peores. Medir en debug es medir otra cosa.
>
> **Dispositivo físico, siempre.** Un emulador codifica por software.

## Estructura

```
lib/
├── main.dart
├── core/
│   ├── config/app_config.dart      # --dart-define. Nunca un .env en el bundle
│   ├── device/device_info.dart
│   ├── network/spike_api.dart      # único punto que habla con el backend
│   └── time/clock_sync.dart        # ⚠️ base de TODA la medición cruzada
└── features/spike/
    ├── domain/models.dart          # Dart puro, sin Flutter
    ├── data/
    │   ├── spike_session_controller.dart   # conecta, mide, sube
    │   └── stats_adapter.dart      # ⚠️ único archivo que toca tipos del SDK
    └── presentation/
        ├── home_screen.dart
        ├── broadcaster_screen.dart # teléfono A
        ├── viewer_screen.dart      # teléfono B + reloj de referencia
        └── widgets/stats_panel.dart
```

## Los dos archivos que hay que entender

**`core/time/clock_sync.dart`** — sin sincronización de reloj, restar un
timestamp del teléfono A de uno del teléfono B no significa nada: dos Android
pueden diferir en segundos y la latencia que buscamos está en centenas de
milisegundos. La app **se niega a medir** si no sincronizó.

**`data/stats_adapter.dart`** — aísla los tipos de estadísticas de
`livekit_client`, que cambian entre versiones. Si al actualizar el SDK deja de
compilar, se arregla ahí y nada más se entera.
