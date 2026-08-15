# SPRINT 0A · Runbook del spike de LiveKit

**Objetivo:** decidir GO / NO-GO sobre LiveKit Cloud con datos medidos en Argentina, no con la hoja de marketing del proveedor.

**Regla del sprint:** `MEASURE BEFORE ASSUMING`. Si este spike falla, se frena todo lo demás y se replantea la integración de video.

---

## 1. Qué medimos y por qué

| Métrica | Cómo se obtiene | Por qué importa |
|---|---|---|
| **Glass-to-glass** | **Manual, con foto** (§5) | Es la única latencia real: cámara → pantalla. Todo lo demás es un proxy |
| Latencia de sonda | Canal de datos de LiveKit, automática | Da volumen de muestras. Es un **piso**: se saltea encode, jitter buffer, decode y render |
| Estimación de e2e | `sonda + jitterBuffer + presupuestos` | Se calibra contra las mediciones manuales |
| Tiempo de conexión | Evento `ROOM_CONNECTED` | Cuánto tarda en entrar a un live |
| Time-to-first-frame | Primer frame decodificado | Lo que percibe el usuario al abrir un live |
| Tiempo de reconexión | `ROOM_RECONNECTING` → `ROOM_RECONNECTED` | Si un corte de 4G mata el live, el producto no funciona en la calle |
| Bitrate, fps, capa | Estadísticas de WebRTC | Valida que el adaptive bitrate funcione de verdad |
| Pérdida de paquetes | Estadísticas de WebRTC | Contextualiza los números malos |

### Por qué la medición manual y no solo la automática

La sonda automática viaja por el **canal de datos**, que no atraviesa el codificador de video, el jitter buffer ni el decodificador. Un número de 200 ms en la sonda puede corresponder a 700 ms de glass-to-glass real.

Podríamos estimar ese hueco con constantes, y lo hacemos — pero **una estimación calibrada contra cero mediciones reales es una invención**. Por eso el criterio GO/NO-GO exige **10 mediciones manuales como mínimo**; con menos, el backend devuelve `INSUFFICIENT_DATA`, que es un resultado honesto.

Después de 10 fotos, el informe calcula el sesgo entre estimación y realidad, y a partir de ahí el número automático sí es confiable.

---

## 2. Qué necesitás

**Hardware**

- [ ] **Teléfono A** — transmisor. Android o iOS **físico** (un emulador codifica por software y los números no significan nada).
- [ ] **Teléfono B** — receptor. Físico.
- [ ] **Teléfono C o cámara** — para fotografiar la pantalla de B. Sirve cualquiera.
- [ ] **Notebook o tablet** — muestra el reloj de referencia.
- [ ] Cargadores. Transmitir vacía una batería en menos de una hora.

**Chips (idealmente uno por operadora)**

- [ ] Personal · [ ] Movistar · [ ] Claro · [ ] WiFi de fibra

**Cuentas**

- [ ] Proyecto en [cloud.livekit.io](https://cloud.livekit.io) con API key y secret.
- [ ] Backend desplegado en staging (§4).

---

## 3. Levantar el backend localmente

```bash
cd backend

cp .env.example .env
#  Completar en .env:
#    LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_WS_URL, LIVEKIT_HTTP_URL
#    SPIKE_ENABLED=true
#    SPIKE_API_KEY=$(openssl rand -hex 32)

pnpm install
pnpm infra:up                 # Postgres + Redis en Docker
pnpm prisma:generate
pnpm prisma:migrate --name init_spike
pnpm dev
```

> **Puertos:** este proyecto usa **3100** (API), **5433** (Postgres) y **6380** (Redis),
> no los habituales 3000/5432/6379. Es a propósito: en la máquina de desarrollo
> conviven otros proyectos que ya ocupan los estándar. Los puertos viven en
> `docker-compose.yml` y `.env`; adentro de los contenedores siguen siendo los
> de siempre.

Verificación:

```bash
curl -s localhost:3100/health | jq
curl -s localhost:3100/ready  | jq          # database y redis en "ok"

# Esta crea una sala REAL en LiveKit: si responde, las credenciales están bien
curl -s -X POST localhost:3100/api/v1/spike/sessions \
  -H "x-spike-key: $SPIKE_API_KEY" -H "content-type: application/json" \
  -d '{"label":"prueba","networkType":"WIFI"}' | jq
```

Tests:

```bash
pnpm test:unit            # incluye el test de grants: un viewer NO puede publicar
pnpm test:integration     # recorrido completo contra Postgres real
```

---

## 4. Desplegar en staging

Las pruebas de campo se hacen contra **staging**, no contra tu notebook: si el backend está en tu máquina, estás midiendo tu red doméstica además de la de la operadora.

```bash
cd backend

fly launch --no-deploy --name livesell-api-staging --region gru
fly postgres create --name livesell-pg-staging --region gru   # o usar Neon
fly redis create --name livesell-redis-staging --region gru   # o usar Upstash

fly secrets set \
  DATABASE_URL="postgresql://..." \
  REDIS_URL="rediss://..." \
  LIVEKIT_API_KEY="APIxxx" \
  LIVEKIT_API_SECRET="xxx" \
  LIVEKIT_WS_URL="wss://tu-proyecto.livekit.cloud" \
  LIVEKIT_HTTP_URL="https://tu-proyecto.livekit.cloud" \
  SPIKE_ENABLED=true \
  SPIKE_API_KEY="$(openssl rand -hex 32)" \
  --app livesell-api-staging

fly deploy --app livesell-api-staging
fly ssh console -C "npx prisma migrate deploy" --app livesell-api-staging

curl -s https://livesell-api-staging.fly.dev/ready | jq
```

**Webhook de LiveKit** (opcional pero recomendado): en el panel de LiveKit Cloud → Settings → Webhooks, apuntar a
`https://livesell-api-staging.fly.dev/webhooks/livekit`.

---

## 5. Compilar la app en los dos teléfonos

```bash
cd mobile

# El repo trae lib/ y pubspec.yaml, pero NO las carpetas nativas: se generan
# para que queden con la versión y el identificador correctos.
# `flutter create .` respeta los archivos que ya existen.
# ⛔ HISTÓRICO. El paquete definitivo es `com.vendox.app` desde el 15/08/2026.
#    Este comando quedó como registro de cómo se generó el proyecto del Sprint 0.
#    Para regenerar las carpetas nativas hoy: --org com.vendox --project-name app
flutter create . --org ar.livesell --project-name livesell_spike --platforms android,ios

flutter pub get

# Android
flutter run --release -d <deviceId> \
  --dart-define=API_BASE_URL=https://livesell-api-staging.fly.dev \
  --dart-define=SPIKE_API_KEY=<la-clave>

# iOS (requiere Mac y un equipo de firma configurado en Xcode)
flutter run --release -d <deviceId> \
  --dart-define=API_BASE_URL=https://livesell-api-staging.fly.dev \
  --dart-define=SPIKE_API_KEY=<la-clave>
```

> **`--release`, no `--debug`.** En modo debug, Dart corre sin compilación AOT y los números de rendimiento son entre un 20 % y un 40 % peores. Medir en debug es medir otra cosa.

### Permisos nativos

**`android/app/src/main/AndroidManifest.xml`** — dentro de `<manifest>`, antes de `<application>`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-feature android:name="android.hardware.camera" android:required="true" />
```

En `android/app/build.gradle.kts`:

```kotlin
compileSdk = 36                              // lo exige flutter_webrtc
minSdk = maxOf(flutter.minSdkVersion, 23)    // lo exige el WebRTC de LiveKit
```

Y en `android/build.gradle.kts` hace falta forzar `compileSdk = 36` en los
módulos de plugins, porque `livekit_client` viene fijado en 34 y el build falla.
El bloque tiene que ser un `afterEvaluate` **registrado antes** del
`evaluationDependsOn(":app")` de Flutter — el archivo explica por qué las otras
dos formas obvias no funcionan.

**Además:** `android:usesCleartextTraffic="true"` en `<application>`. Android 9+
bloquea `http://` y el backend local se sirve sin TLS. **Solo para el spike.**

**`ios/Runner/Info.plist`**:

```xml
<key>NSCameraUsageDescription</key>
<string>Se usa la cámara para transmitir en vivo.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Se usa el micrófono para transmitir en vivo.</string>
<key>UIBackgroundModes</key>
<array><string>audio</string><string>voip</string></array>
```

En `ios/Podfile`, `platform :ios, '13.0'` como mínimo.

---

## 6. El método de medición glass-to-glass

Este es el núcleo del spike. Leelo entero antes de salir a la calle.

```
   ┌─────────────────┐         ┌──────────────┐         ┌──────────────┐
   │ 💻 NOTEBOOK     │  📷     │ 📱 TELÉFONO A │  ~~~►   │ 📱 TELÉFONO B │
   │ glass-timer.html│ ◄────── │ transmite     │ LiveKit │ recibe        │
   │  12:34.567      │  filma  │               │         │ + overlay     │
   └─────────────────┘         └──────────────┘         └──────┬───────┘
                                                                │
                                                       📸 se fotografía
                                                          SOLO esta pantalla
```

**Por qué una sola foto.** El teléfono B superpone su **propio** reloj sincronizado con el servidor. En la misma imagen quedan:

- El reloj **verde del overlay** = ahora.
- El reloj **dentro del video** = el instante en que la cámara de A capturó ese frame.

```
glass-to-glass = overlay − reloj dentro del video
```

Sin el overlay harían falta dos dispositivos en una misma foto y sincronizar dos lecturas, que es justo donde se cuela la mayor parte del error.

### Paso a paso

1. **Notebook:** abrí `tools/glass-timer.html` (doble clic o `python3 -m http.server` en `tools/`). Cargá la URL de staging y la `SPIKE_API_KEY`, y tocá **SINCRONIZAR Y EMPEZAR**. Verificá que arriba a la izquierda diga `sincronizado`. Poné la pantalla al **brillo máximo**.

2. **Teléfono A:** abrí la app → completá etiqueta, operadora y red → **CREAR SESIÓN Y TRANSMITIR**. Apuntá la cámara trasera a la pantalla de la notebook, a unos 40–50 cm, de modo que el reloj ocupe buena parte del encuadre.

3. **Teléfono B:** copiá el `sessionId` que muestra A → **UNIRSE COMO ESPECTADOR**. Deberías ver el reloj de la notebook dentro del video, y el reloj verde arriba.

4. **Esperá 30 segundos** a que el bitrate se estabilice. Medir en los primeros segundos da números malos que no representan el uso real.

5. **Sacá la foto** de la pantalla de B con el teléfono C. Que se lean **los dos** relojes.

6. **Cargá la medición** en B: botón `CARGAR MEDICIÓN DE LA FOTO` → ingresá los dos valores → guardar. La app hace la resta y valida que sea plausible.

7. **Repetí 10 veces por condición**, separando ~20 segundos entre fotos.

### Errores que arruinan la medición

| Error | Consecuencia |
|---|---|
| Brillo bajo en la notebook | El reloj sale quemado o ilegible en el video |
| Medir en los primeros 30 s | Bitrate todavía adaptándose, latencia inflada |
| Correr en `--debug` | Números entre 20 % y 40 % peores que la realidad |
| Reloj sin sincronizar | La resta no significa nada. **La app te frena si no sincronizó** |
| Usar un emulador | Codificación por software: los números no representan un teléfono real |
| Menos de 10 mediciones | El backend devuelve `INSUFFICIENT_DATA` y hace bien |
| Notebook en otra red | Da igual: el reloj se sincroniza con el servidor, no con los teléfonos |

---

## 7. Matriz de pruebas

Una sesión por fila. La etiqueta tiene que dejar claro qué se probó.

| # | Condición | Red A | Red B | Mediciones | Estado |
|---|---|---|---|---|---|
| 1 | Base: fibra en ambos | WiFi | WiFi | 10 | ☐ |
| 2 | Personal 4G transmitiendo | 4G Personal | WiFi | 10 | ☐ |
| 3 | Movistar 4G transmitiendo | 4G Movistar | WiFi | 10 | ☐ |
| 4 | Claro 4G transmitiendo | 4G Claro | WiFi | 10 | ☐ |
| 5 | 4G en ambos extremos | 4G | 4G | 10 | ☐ |
| 6 | Hora pico (19–21 h) | 4G | 4G | 10 | ☐ |
| 7 | En movimiento (colectivo/subte) | 4G | 4G | 10 | ☐ |
| 8 | Zona de señal débil | 4G | 4G | 10 | ☐ |

**Mínimo para decidir:** filas 1 a 5. Las filas 6 a 8 informan la escalera de degradación pero no bloquean el GO.

### Pruebas de resiliencia (sin foto, se miden solas)

Estas validan el requisito de que **el live sobreviva a la calle**:

| # | Prueba | Qué observar | Criterio |
|---|---|---|---|
| R1 | En A: WiFi → 4G (apagar WiFi) | `RECONECTANDO` en B y luego recuperación | Vuelve en < 10 s |
| R2 | En A: 4G → WiFi | Ídem | Vuelve en < 10 s |
| R3 | En A: modo avión 5 s | El live no muere | Vuelve solo |
| R4 | En A: modo avión 30 s | Ídem | Vuelve solo o falla limpio |
| R5 | En B: WiFi → 4G | El video se recupera | < 10 s |
| R6 | Entrar a un ascensor | Degradación, no caída | Recupera al salir |
| R7 | A en segundo plano 10 s | Comportamiento documentado | Sin crash |
| R8 | 30 min continuos | Sin fugas ni sobrecalentamiento | Estable |

Los tiempos de reconexión se registran solos: el controlador emite `ROOM_RECONNECTING` / `ROOM_RECONNECTED` con su duración.

---

## 8. Leer los resultados

```bash
# Informe de una sesión
curl -s https://livesell-api-staging.fly.dev/api/v1/spike/sessions/spk_XXX/report \
  -H "x-spike-key: $SPIKE_API_KEY" | jq

# Informe consolidado de todas las sesiones (esto es lo que se pega en RESULTS.md)
cd backend && pnpm spike:report
pnpm spike:report -- --json > ../docs/sprint-0/results-raw.json
```

El informe trae:

- `latency.glassToGlassManualMs` — **el número que decide**.
- `latency.estimatedE2eMs` — la estimación automática, con muchas más muestras.
- `calibration.biasMs` — cuánto se aparta la estimación de la realidad.
- `quality.heightsSeen` — si hay más de una altura, **el adaptive bitrate funciona**.
- `resilience.reconnectMs` — tiempos de reconexión.
- `verdict` — GO / GO_WITH_CAVEAT / NO_GO / INSUFFICIENT_DATA.

---

## 9. Criterio PASS / FAIL

| Métrica | ✅ PASS | ⚠️ CAVEAT | ❌ FAIL |
|---|---|---|---|
| **Glass-to-glass p95 (4G)** | ≤ 800 ms | 800 – 1500 ms | > 1500 ms |
| Glass-to-glass p95 (WiFi) | ≤ 600 ms | 600 – 1200 ms | > 1200 ms |
| Time-to-first-frame p95 | ≤ 1500 ms | 1500 – 3000 ms | > 3000 ms |
| Tiempo de reconexión p95 | ≤ 5 s | 5 – 10 s | > 10 s |
| Sobrevive a WiFi ⇄ 4G | Siempre | A veces | Nunca |
| Adaptive bitrate | Más de una altura observada | — | Una sola altura |
| Pérdida de paquetes p95 | ≤ 3 % | 3 – 8 % | > 8 % |
| Mediciones manuales | ≥ 10 por condición | — | < 10 |

### Qué hacer con cada resultado

**GO** → seguir con el Sprint 0B (Mercado Pago) y después con Auth.

**GO_WITH_CAVEAT** → hay que responder una pregunta cualitativa antes de seguir: **¿la interacción se siente en tiempo real?** Prueba concreta: alguien frente al teléfono A saluda con la mano; quien mira B dice "ahora". Si el retraso se percibe como conversación natural, es GO. Documentar la latencia real como presupuesto del producto y ajustar la UX (por ejemplo, el vendedor no debería esperar respuestas instantáneas del chat).

**NO_GO** → frenar. Alternativas en orden:
1. Verificar que LiveKit Cloud esté enrutando por el edge de São Paulo.
2. Probar con `--release` si por error se midió en debug.
3. Reevaluar **Cloudflare Realtime** (tiene PoP en Buenos Aires, latencia física menor; cuesta entre 2 y 3 semanas más de integración porque hay que hacer WHIP/WHEP a mano).
4. Reevaluar **Agora** (SDK oficial de Flutter, propietario).

**INSUFFICIENT_DATA** → no es un fallo del sistema: faltan mediciones. Volver a la calle.

---

## 10. Si algo no funciona

| Síntoma | Causa probable | Solución |
|---|---|---|
| "No se pudo sincronizar el reloj" | Backend inalcanzable o clave mal | Probar `/health` desde el navegador del teléfono |
| El teléfono B no ve video | Token emitido para otra sala | Verificar que el `sessionId` sea el correcto |
| Latencia negativa en la sonda | Relojes desincronizados | Volver a sincronizar (ícono de reloj en el inicio) |
| Todas las estadísticas en `—` | El SDK cambió los nombres de campo | Ajustar **solo** `mobile/lib/features/spike/data/stats_adapter.dart`: está aislado para esto |
| Se cae al conectar en iOS | Faltan claves en Info.plist | Ver §5 |
| Muy poco fps al transmitir | Teléfono de gama baja o sobrecalentado | Anotarlo: es un dato del mercado real, no un error |
| Reconexión que nunca vuelve | Token vencido | El del broadcaster dura 6 h; sesiones más largas requieren re-emitir |

### El celular no aparece en `adb devices`

Es el tropiezo más frecuente. En orden de probabilidad:

1. **El cable es solo de carga.** Muchísimos cables baratos no llevan los pines
   de datos. Probá con el original o con otro que sepas que transfiere archivos.
2. **Falta aceptar el diálogo en el teléfono.** Al conectarlo aparece
   *"¿Permitir la depuración USB?"* — hay que tocar **Permitir** y tildar
   *Permitir siempre desde esta computadora*. Si no apareció, desconectá y
   volvé a conectar mirando la pantalla.
3. **El modo USB está en "Solo carga".** Bajá la barra de notificaciones,
   tocá la notificación de USB y elegí **Transferencia de archivos (MTP)**.
4. **Depuración por USB desactivada.** Ajustes → Sistema → Opciones de
   desarrollador → *Depuración por USB*.
5. **Falta el driver OEM en Windows** (Xiaomi, Motorola, Huawei suelen pedirlo).
   Se instala desde el sitio del fabricante.

Diagnóstico:

```powershell
adb kill-server
adb start-server
adb devices -l
```

Si sale `unauthorized`, es el punto 2. Si sale vacío, es 1, 3 o 5.

**Diagnóstico del backend**

```bash
fly logs --app livesell-api-staging
curl -s https://livesell-api-staging.fly.dev/metrics | grep spike_
```

---

## 11. Antes de dar el veredicto

- [ ] Al menos 5 condiciones de la matriz completas.
- [ ] ≥ 10 mediciones manuales por condición.
- [ ] Las 8 pruebas de resiliencia ejecutadas.
- [ ] Ninguna corrida hecha en emulador o en `--debug`.
- [ ] `pnpm spike:report` guardado en `docs/sprint-0/RESULTS.md`.
- [ ] Fotos representativas archivadas (al menos una por condición).
- [ ] Sesgo de calibración calculado y anotado.
- [ ] **Veredicto escrito con su justificación**, no solo el número.
