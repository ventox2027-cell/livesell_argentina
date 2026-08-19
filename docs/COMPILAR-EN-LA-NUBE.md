# Compilar el APK sin tu PC

El backend corre en Railway, la base en Neon, las imágenes en R2. Lo último que
necesitaba una máquina prendida era compilar la app.

El workflow `.github/workflows/build-apk.yml` lo resuelve: se dispara a mano
desde GitHub y deja el APK descargable, **también desde el teléfono**.

---

## Los cinco secretos

Van en GitHub → **Settings → Secrets and variables → Actions → New repository
secret**. No van al repositorio, no aparecen en los logs y yo no los veo.

| Secreto | Qué es |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | el `.jks` codificado en base64 |
| `ANDROID_KEYSTORE_PASSWORD` | la contraseña del keystore |
| `ANDROID_KEY_ALIAS` | `vendox-upload` |
| `ANDROID_KEY_PASSWORD` | la contraseña de la clave |
| `GOOGLE_SERVICES_JSON_BASE64` | el `google-services.json` en base64 |

### Cómo obtener los dos en base64

En PowerShell, **sin que el contenido pase por la pantalla**:

```powershell
# El keystore
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\VendoX-Secrets\Android\vendox-upload.jks")) | Set-Clipboard
```

Queda en el portapapeles: pegalo directo en el campo de GitHub y listo. No lo
imprimas, no lo guardes en un archivo, no lo pegues en un chat.

```powershell
# El google-services.json
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\App nueva para vendedores en vivo\mobile\android\app\google-services.json")) | Set-Clipboard
```

Las dos contraseñas y el alias los pegás desde tu gestor de contraseñas.

---

## Cómo se usa

GitHub → pestaña **Actions** → **APK firmado** → **Run workflow**.

Pide dos cosas:

| Campo | Para qué |
|---|---|
| `api_base_url` | a qué backend le habla esa build. Por omisión, el de Railway |
| `motivo` | una etiqueta para el artefacto: `qa`, `prueba-login`, lo que sirva |

También se dispara solo al etiquetar una versión (`git tag v0.2.0 && git push
--tags`).

**No** corre en cada push: un artefacto firmado por commit quema minutos y llena
la lista de binarios que nadie va a instalar. Los tests sí corren en cada push,
en `ci.yml`.

---

## Cómo bajarlo al teléfono

1. Entrá a **Actions** desde el navegador del teléfono
2. Abrí la corrida que terminó
3. Abajo de todo, sección **Artifacts** → `vendox-apk-...`
4. Se baja un `.zip`. Descomprimilo y tocá el APK

Android va a pedir permiso para instalar desde el navegador. Es normal la
primera vez.

---

## Qué verifica antes de darte el archivo

El workflow no se limita a compilar. Si algo de esto falla, no hay artefacto:

**Análisis y tests.** Un artefacto firmado sale con la etiqueta de «listo para
instalar». Si viniera de código que no pasa sus propios tests, esa etiqueta
miente.

**Que la firma NO sea la de depuración.** No es teórico: el 17 de agosto se
descubrió que todas las builds salían con `CN=Android Debug` porque faltaba
`key.properties` y Gradle caía a la clave de depuración en silencio. Se
instalaron en un teléfono y nadie se enteró hasta mirarlo con `apksigner`.

El build local ahora falla si falta la clave; acá se comprueba el **resultado**,
que es la única prueba que no depende de que esa otra guarda siga en su lugar.

**Que no haya secretos en el binario.** `tools/escanear-secretos.mjs` revisa lo
versionado; esto revisa lo **compilado**, que es donde terminaría una clave
embebida por error.

---

## El costo que conviene saber

Subir la clave de firma a GitHub tiene un riesgo real: **quien acceda a esos
secretos puede firmar una actualización que Play acepta como tuya.**

GitHub los cifra y los enmascara en los logs, y es la práctica estándar de la
industria. Pero el riesgo existe y conviene tenerlo presente:

- Los secretos no se pueden leer una vez cargados, ni siquiera por vos
- Cualquiera con permiso de escritura en el repositorio puede disparar el
  workflow y, con un workflow modificado, exfiltrarlos
- Si sospechás que se filtró: se rota la clave de subida en Play Console
  (**Configuración → Integridad de la app → clave de subida**), que es de las
  pocas cosas que Google sí deja rotar

Si preferís no subirla, la alternativa es seguir compilando localmente y usar el
workflow sólo para los tests. Se pierde la independencia de la PC, que era el
punto.

---

## Lo que todavía necesita tu PC

Nada, para iterar. Queda pendiente, y no depende de esto:

| | Depende de |
|---|---|
| Distribuir a testers sin bajar un zip | Play Console (prueba interna) o Firebase App Distribution |
| Páginas de privacidad y eliminación | publicarlas en Cloudflare Pages |
| `vendox.com.ar` | tu socio |
