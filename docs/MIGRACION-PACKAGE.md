# Migración del package a `com.vendox.app`

15 de agosto de 2026. Autorizada explícitamente por el dueño del producto.

`ar.livesell.livesell_spike` → **`com.vendox.app`**

---

## Por qué se hizo ahora y no después

**El `applicationId` no se puede cambiar nunca más después de publicar en Google
Play.** Queda en la URL de la ficha, es la identidad de la app dentro de cada
teléfono, y cambiarlo obliga a subir una app nueva y pedirle a todo el mundo que
la instale de cero, perdiendo instalaciones, reseñas y posicionamiento.

El nombre viejo venía del proyecto descartable del Sprint 0. Además chocaba con
Firebase, donde la app ya está registrada como `com.vendox.app`, y ese choque
era lo que impedía cerrar las notificaciones push.

---

## Qué se cambió

| Archivo | Antes | Ahora |
|---|---|---|
| `android/app/build.gradle.kts` | `namespace` y `applicationId` = `ar.livesell.livesell_spike` | `com.vendox.app` |
| `android/app/src/main/kotlin/.../MainActivity.kt` | en `ar/livesell/livesell_spike/`, `package ar.livesell.livesell_spike` | movida a `com/vendox/app/`, `package com.vendox.app` |
| `ios/Runner.xcodeproj/project.pbxproj` | `PRODUCT_BUNDLE_IDENTIFIER = ar.livesell.livesellSpike` (6 apariciones) | `com.vendox.app` / `com.vendox.app.RunnerTests` |
| `ios/Runner/Info.plist` | `CFBundleName = livesell_spike` | `vendox` |
| `mobile/README.md`, `docs/`, `blueprint/` | referencias al paquete viejo | actualizadas |
| `welcome_screen.dart` | `prueba@livesell.ar` | `prueba@vendox.com.ar` |

**No hubo que tocar el backend.** No tenía ninguna referencia al paquete: el
`APPLE_BUNDLE_ID` es configuración, no código.

**El `AndroidManifest.xml` tampoco.** Las autoridades de los `FileProvider` de
`image_picker` y `share_plus` usan `${applicationId}`, así que se resolvieron
solas al nuevo nombre.

### Verificado sobre la APK compilada

```
com.vendox.app
com.vendox.app.MainActivity
com.vendox.app.flutter.image_provider
com.vendox.app.flutter.share_provider
com.vendox.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION
```

Y un barrido entrada por entrada del `.apk` buscando `livesell`:
**cero coincidencias**. Ninguna referencia técnica legítima al paquete viejo
sobrevive en el binario.

> En el primer barrido quedaba **una**: la cadena `prueba@livesell.ar`, el correo
> de ejemplo del acceso de desarrollo. No era el paquete, pero era el nombre
> viejo. Se cambió, y de paso el acceso de desarrollo pasó a estar detrás de
> `Entorno.herramientas`: `env.schema.ts` ya prohíbe encenderlo en producción,
> así que ese código no tiene por qué viajar en el binario.

---

## ⚠️ Lo que TENÉS que hacer vos, y en qué orden

Nada de esto lo puedo hacer yo: son credenciales y decisiones de cuentas.

### Paso 1 — Cliente de OAuth de Android para probar HOY

Sin esto, **el inicio de sesión con Google deja de funcionar en el teléfono**.
Falla con un error `10` (`DEVELOPER_ERROR`) que no explica nada.

El motivo: Google identifica a la app por **package name + huella SHA-1 de la
clave que la firmó**. Cambió el package, así que el cliente que existía ya no
corresponde a esta app.

Hoy la APK se firma con la clave de debug. Su huella es **pública** —es la misma
clave de debug de Android en todas las máquinas de este equipo— y es esta:

```
Package name:  com.vendox.app
SHA-1:         3B:2E:83:55:42:15:AA:58:16:FC:C1:E9:74:82:E2:FF:5F:EB:EC:3D
SHA-256:       A1:D8:C8:B6:3B:19:D3:36:F6:54:F0:87:E1:1F:5D:25:AE:65:2A:80:F7:DB:88:84:C2:72:FC:2E:FE:67:DA:A1
```

**Dónde cargarlo:** Google Cloud Console → APIs y servicios → Credenciales →
Crear credenciales → ID de cliente de OAuth → **Android**.

**No hay que cambiar nada en el `.env`.** El client ID de Android no se usa como
audiencia: la app manda el ID token firmado contra el **Web client ID**, que es
el que ya está en `GOOGLE_CLIENT_ID_WEB` y no cambia. El cliente de Android
existe sólo para que Google reconozca a la app.

Si querés que además valga como audiencia, cargalo en `GOOGLE_CLIENT_ID_ANDROID`.
Es opcional.

### Paso 2 — `google-services.json`

Firebase → configuración del proyecto → tu app Android `com.vendox.app` →
descargar `google-services.json` → dejarlo en:

```
mobile/android/app/google-services.json
```

Ya está en `.gitignore`, junto con los keystores y el `GoogleService-Info.plist`.
**No lo pegues en el chat ni lo commitees.**

Hasta que no agreguemos `firebase_messaging` el archivo no se lee, así que
podés bajarlo cuando quieras. Avisame cuando esté y cierro el push.

### Paso 3 — La clave de subida (cuando vayas a publicar)

**Decime cuándo querés hacerlo y te paso el comando exacto.** No la genero yo:
es irreversible, y **si se pierde no se puede volver a publicar una
actualización de VendoX nunca más**.

Cuando la generes vas a necesitar registrar **dos huellas más**, no una:

| Huella | De dónde sale | Para qué |
|---|---|---|
| SHA-1 de tu **clave de subida** | del `.jks` que generes | El OAuth de las APKs que compiles vos |
| SHA-1 de la **clave de firma de la app** | Play Console → Configuración → Integridad de la app → **Firma de apps** | El OAuth de la app que descarga la gente |

⚠️ **La segunda es la que más se olvida y la que rompe producción.** Con Play App
Signing —que es lo predeterminado— Google **vuelve a firmar** tu APK con una
clave propia antes de distribuirla. Esa es la firma que ven los teléfonos de la
gente. Si sólo registrás la tuya, el login con Google te anda perfecto en tu
teléfono y falla en el de todo el mundo.

Las dos huellas van al **mismo** cliente de OAuth de Android, o a dos clientes
distintos con el mismo package. Y también hay que agregarlas en Firebase
(configuración del proyecto → tu app Android → huellas digitales) y volver a
bajar el `google-services.json`.

Cuando llegue el momento:

1. Generás la clave → me pasás **sólo la huella SHA-1**, nunca el `.jks` ni su
   contraseña.
2. Yo dejo `build.gradle.kts` leyendo la firma desde un `key.properties` fuera
   del repositorio (ya está en `.gitignore`).
3. Subís el primer bundle, Play te muestra la huella de su clave de firma, y esa
   también se registra.

---

## Lo que NO cambió, a propósito

- **`versionCode` y `versionName`.** Los maneja Flutter desde `pubspec.yaml`.
- **La base de datos.** Nada guarda el nombre del paquete.
- **El backend.** Ninguna referencia.
- **Los datos de los teléfonos que ya tienen la app instalada.** Android trata a
  `com.vendox.app` como una app distinta: quien tenga instalada la versión con
  el paquete viejo **no recibe esta como actualización**, le van a quedar las
  dos. Hay que desinstalar la vieja a mano. Sólo afecta a los teléfonos de
  prueba, porque nunca se publicó nada.

---

## Estado

| | |
|---|---|
| APK de release compila | ✅ |
| Package en el manifiesto compilado | ✅ `com.vendox.app` |
| Rastro del paquete viejo en la APK | ✅ ninguno |
| `flutter analyze` | ✅ limpio |
| Tests de Flutter | ✅ 242 |
| Cliente de OAuth de Android registrado | ⬜ **te toca a vos** |
| `google-services.json` descargado | ⬜ **te toca a vos** |
| Clave de subida | ⬜ cuando decidas publicar |
