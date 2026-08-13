allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
/**
 * Fuerza compileSdk 36 en TODOS los módulos de plugins.
 *
 * Motivo: `flutter_webrtc` exige compilar contra la API 36 o superior, pero
 * `livekit_client` viene fijado en 34 y el build falla. Ambos son dependencias
 * de terceros —no podemos editar sus archivos—, así que se corrige acá.
 *
 * compileSdk solo determina contra qué APIs se COMPILA. No cambia minSdk (qué
 * dispositivos pueden instalar la app) ni targetSdk (a qué comportamientos de
 * runtime se adhiere la app), así que subirlo es seguro.
 *
 * Tiene que ser `afterEvaluate` y tiene que ir ANTES del bloque de Flutter que
 * viene abajo. Las dos condiciones importan:
 *
 *   · `plugins.withId` no sirve: se dispara al aplicarse el plugin, o sea ANTES
 *     de que el módulo ejecute su propio `android { compileSdk = 34 }`, que
 *     después lo pisa.
 *   · Registrado DESPUÉS del bloque de Flutter tampoco: ese llama a
 *     evaluationDependsOn(":app") y fuerza la evaluación, así que un
 *     afterEvaluate posterior falla con "project is already evaluated".
 *
 * Se puede quitar cuando livekit_client publique una versión alineada.
 */
subprojects {
    afterEvaluate {
        val androidExt = extensions.findByName("android")
        if (androidExt is com.android.build.gradle.LibraryExtension) {
            androidExt.compileSdk = 36
        }
    }
}

subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
