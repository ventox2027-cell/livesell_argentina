plugins {
    id("com.android.application")
    id("com.google.gms.google-services")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    /**
     * ⛔ `com.vendox.app` es DEFINITIVO.
     *
     * Antes era `ar.livesell.livesell_spike`, heredado del proyecto descartable
     * del Sprint 0. Se migró el 15 de agosto de 2026, antes de la primera
     * publicación, porque **el applicationId no se puede cambiar nunca más
     * después de publicar en Google Play**: queda en la URL de la ficha, en la
     * identidad de la app dentro de cada teléfono, y cambiarlo obliga a subir
     * una app nueva y pedirle a todo el mundo que la instale de cero.
     *
     * También es el paquete con el que está registrada la app en Firebase, y
     * el que tiene que figurar en el cliente de OAuth de Android en Google
     * Cloud junto con la huella SHA-1 de la clave de firma.
     *
     * El `namespace` es lo mismo por convención de Flutter: es el paquete de
     * las clases generadas (`R`, `BuildConfig`) y no tiene por qué coincidir
     * con el `applicationId`, pero mantenerlos iguales evita una fuente de
     * confusión que no aporta nada.
     */
    namespace = "com.vendox.app"

    // 36 fijo, no flutter.compileSdkVersion: flutter_webrtc lo exige.
    // Ver la explicación completa en android/build.gradle.kts.
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Ver la nota de `namespace`. Es definitivo y no se toca.
        applicationId = "com.vendox.app"

        // El WebRTC de LiveKit exige API 23 como mínimo.
        // maxOf y no un 23 fijo: si Flutter sube su mínimo, no lo bajamos por
        // dejar un número escrito a mano hace seis meses.
        minSdk = maxOf(flutter.minSdkVersion, 23)
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // ⚠️ FIRMADO CON LA CLAVE DE DEBUG.
            //
            // Sirve para instalar en teléfonos propios y nada más. Antes de
            // publicar hay que generar una clave propia y guardarla donde no se
            // pierda: si se pierde, NO se puede volver a publicar una
            // actualización de la app. Nunca. Hay que subir una app nueva y
            // pedirle a todo el mundo que la instale de cero.
            //
            // Al cambiarla también cambia la huella SHA-1, así que hay que
            // agregar un cliente de OAuth de Android nuevo en Google Cloud.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    // Nombre del archivo APK.
    //
    // Por defecto Gradle emite "app-arm64-v8a-release.apk", que al descargarlo
    // no dice de qué app es. Con varias versiones en la carpeta de descargas
    // no hay forma de saber cuál es cuál.
    applicationVariants.all {
        val variante = this
        variante.outputs.all {
            val salida = this as com.android.build.gradle.internal.api.BaseVariantOutputImpl
            val abi = salida.filters
                .firstOrNull { it.filterType == "ABI" }
                ?.identifier
                ?.let { "-$it" } ?: ""
            salida.outputFileName = "VendoX-${variante.versionName}$abi.apk"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
