import java.util.Properties
import java.io.File
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("com.google.gms.google-services")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

/**
 * La clave con la que se firma la release.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * EL ARCHIVO NO ESTÁ EN EL REPOSITORIO, Y NO PUEDE ESTARLO
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `key.properties` apunta a un `.jks` que vive fuera del proyecto y lleva dos
 * contraseñas. Está en `.gitignore` —junto con `*.jks` y `*.keystore`— y si
 * alguna vez se sube, hay que rotar la clave: cualquiera que la tenga puede
 * firmar una actualización que Play va a aceptar como nuestra.
 *
 * ⚠️ Y si se PIERDE, no se puede volver a publicar una actualización nunca
 * más. Google no la reemplaza. Hay que subir una app nueva, con otro id, y
 * pedirle a todo el mundo que la instale de cero.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SIN EL ARCHIVO, LA RELEASE **FALLA**
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Antes caía a la clave de depuración en silencio. La intención era buena —un
 * clon del repositorio tiene que poder compilar sin la clave de nadie— pero el
 * resultado fue el que se ve venir: se compiló un APK de release firmado con
 * debug, se instaló en un teléfono, y el problema recién apareció cuando
 * alguien lo miró con `apksigner`. Un AAB así subido a Play se rechaza, y en el
 * mejor de los casos se pierde el viaje.
 *
 * Ahora la release aborta con un mensaje que dice qué archivo falta. El debug
 * sigue compilando sin nada, que es lo que el clon necesita de verdad.
 *
 * ─── Y si igual querés una release firmada con debug ───
 *
 * Existe, pero hay que pedirlo en voz alta:
 *
 *     flutter build apk --release --android-project-arg=firmaDebugAdrede=true
 *     ./gradlew assembleRelease -PfirmaDebugAdrede=true
 *
 * Sirve para inspeccionar el binario o medir el tamaño sin tener la clave. Al
 * ser explícito no puede pasar por accidente, que es la única propiedad que le
 * pedimos.
 */
val propiedadesDeFirma = Properties()
val archivoDeFirma = rootProject.file("key.properties")
if (archivoDeFirma.exists()) {
    propiedadesDeFirma.load(FileInputStream(archivoDeFirma))
}

/**
 * Qué le falta a la configuración de firma para servir.
 *
 * Devuelve la lista de problemas, vacía si está todo. Se revisa campo por campo
 * en vez de mirar sólo si el archivo existe: un `key.properties` con la
 * contraseña en blanco —porque se copió la plantilla y se completó a medias—
 * hoy pasaba el control y reventaba mucho después, con un error de Gradle que
 * no dice qué pasó.
 */
val problemasDeFirma: List<String> = when {
    !archivoDeFirma.exists() -> listOf("no existe ${archivoDeFirma.absolutePath}")
    else -> buildList {
        for (campo in listOf("storeFile", "storePassword", "keyAlias", "keyPassword")) {
            if (propiedadesDeFirma.getProperty(campo).isNullOrBlank()) {
                add("falta `$campo` en key.properties")
            }
        }
        val ruta = propiedadesDeFirma.getProperty("storeFile")
        if (!ruta.isNullOrBlank() && !File(ruta).exists()) {
            add("`storeFile` apunta a un archivo que no está: $ruta")
        }
    }
}

val hayClaveDeSubida = problemasDeFirma.isEmpty()

/** La escotilla explícita. Ver el comentario de arriba. */
val firmaDebugAdrede = project.findProperty("firmaDebugAdrede") == "true"

/**
 * El portón: una release sin clave no llega a producir un archivo.
 *
 * Va en el grafo de tareas y no en la configuración porque Gradle configura
 * TODOS los tipos de compilación siempre. Fallar acá arriba rompería
 * `assembleDebug`, el sync del IDE y `flutter test` — todo lo que no tiene
 * nada que ver con firmar.
 *
 * El grafo, en cambio, sabe qué se está por construir de verdad.
 */
gradle.taskGraph.whenReady {
    val vaAConstruirRelease = allTasks.any { tarea ->
        tarea.project == project &&
            Regex("^(assemble|bundle|package).*Release$").matches(tarea.name)
    }

    if (!vaAConstruirRelease || hayClaveDeSubida) return@whenReady

    if (firmaDebugAdrede) {
        logger.warn(
            "\n⚠️  Release firmada con la clave de DEPURACIÓN, a pedido " +
                "(-PfirmaDebugAdrede=true).\n" +
                "    Este binario NO sirve para Play Console.\n",
        )
        return@whenReady
    }

    throw GradleException(
        buildString {
            append("\n\n")
            append("No se puede firmar la release.\n\n")
            problemasDeFirma.forEach { append("  · $it\n") }
            append("\nQué hacer:\n\n")
            append("  1. Copiar android/key.properties.example a android/key.properties\n")
            append("  2. Completar storeFile, storePassword, keyAlias y keyPassword\n")
            append("  3. Comprobar que git no lo ve:\n")
            append("       git check-ignore -v mobile/android/key.properties\n\n")
            append("El archivo queda fuera del repositorio y las contraseñas van en un\n")
            append("gestor de contraseñas, nunca en el repo ni en una variable de CI en\n")
            append("texto plano.\n\n")
            append("Si de verdad querés una release firmada con debug —para inspeccionar\n")
            append("el binario, no para publicar— pedila explícitamente:\n\n")
            append("  flutter build apk --release --android-project-arg=firmaDebugAdrede=true\n\n")
        },
    )
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

    signingConfigs {
        create("upload") {
            if (hayClaveDeSubida) {
                keyAlias = propiedadesDeFirma.getProperty("keyAlias")
                keyPassword = propiedadesDeFirma.getProperty("keyPassword")
                storeFile = file(propiedadesDeFirma.getProperty("storeFile"))
                storePassword = propiedadesDeFirma.getProperty("storePassword")
            }
        }
    }

    buildTypes {
        release {
            /**
             * Con `key.properties` válido, la clave de subida. Sin él, debug —
             * pero esa rama ya no llega a producir nada: el portón del grafo de
             * tareas aborta la compilación antes. Ver arriba.
             *
             * Queda asignada igual porque la CONFIGURACIÓN tiene que ser válida
             * aunque no haya clave: el sync del IDE y `assembleDebug` pasan por
             * acá, y dejar el campo en null los rompería.
             *
             * ⚠️ Si la clave de subida se pierde, NO se puede volver a publicar
             * una actualización de la app. Nunca. Google no la reemplaza: hay
             * que subir una app nueva, con otro id, y pedirle a todo el mundo
             * que la instale de cero.
             *
             * Al cambiar la clave también cambia la huella SHA-1, así que hay
             * que registrar el cliente de OAuth de Android nuevo en Google
             * Cloud y agregar la huella en Firebase, o Google Sign-In deja de
             * funcionar.
             */
            signingConfig =
                if (hayClaveDeSubida) signingConfigs.getByName("upload")
                else signingConfigs.getByName("debug")
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
