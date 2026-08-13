plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "ar.livesell.livesell_spike"

    // 36 fijo, no flutter.compileSdkVersion: flutter_webrtc lo exige.
    // Ver la explicación completa en android/build.gradle.kts.
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "ar.livesell.livesell_spike"

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
