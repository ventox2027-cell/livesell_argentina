package com.vendox.app

import io.flutter.embedding.android.FlutterActivity

/**
 * La única Activity. Todo lo demás lo dibuja Flutter.
 *
 * El paquete tiene que coincidir con el `namespace` de `build.gradle.kts`: es
 * de donde Gradle resuelve `.MainActivity` en el AndroidManifest. Si no
 * coinciden, la app compila y crashea al abrir con `ClassNotFoundException`.
 */
class MainActivity : FlutterActivity()
