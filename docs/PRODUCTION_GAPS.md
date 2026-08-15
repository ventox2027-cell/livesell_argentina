# Lo que falta para producción

Estado al 15 de agosto de 2026.

Ordenado por lo que **bloquea** publicar, después por lo que duele y al final
por lo que se puede vivir sin. Cada hueco dice qué es, por qué está así, y quién
lo puede cerrar.

---

## Bloquea publicar en Google Play

Cuatro cosas. **Ninguna es código**: las cuatro necesitan a alguien con acceso a
cuentas, y tres son irreversibles si se hacen mal.

### 1 · La APK está firmada con la clave de debug

`android/app/build.gradle.kts` usa `signingConfigs.getByName("debug")`. Sirve
para instalar en teléfonos propios y nada más.

**Por qué no lo resolvimos:** generar la clave de subida es irreversible y hay
que hacerlo con la persona presente. **Si esa clave se pierde, no se puede
volver a publicar una actualización de la app nunca**: hay que subir una app
nueva, con otro identificador, y pedirle a todo el mundo que la instale de cero.

**Efecto lateral que se olvida:** al cambiar la clave cambia la huella SHA-1, y
hay que **agregar un cliente de OAuth de Android nuevo en Google Cloud** o el
inicio de sesión con Google deja de funcionar en la APK firmada.

→ **Lo cierra:** quien administra la cuenta de Google Play.

### 2 · Las dos páginas públicas no están publicadas

`web/privacidad/` y `web/eliminar-cuenta/` están escritas y listas. El DNS y el
hosting no se tocaron: es una acción externa que no nos corresponde tomar solos.

Google Play verifica las dos URLs, y la de eliminación de datos se declara
aparte en **Contenido de la app → Eliminación de datos**.

→ **Lo cierra:** quien administra el dominio. Instrucciones en
[`web/README.md`](../web/README.md).

### 3 · `privacidad@vendox.com.ar` no existe

Las dos páginas lo publican como canal de contacto y prometen respuesta en 10
días corridos, que es lo que fija la Ley 25.326.

→ **Lo cierra:** quien administra el correo del dominio.

### 4 · Credenciales de producción de Mercado Pago

Hoy el sistema anda con credenciales de prueba. Cargar las de producción
significa que el próximo cobro es plata real.

→ **Lo cierra:** quien administra la cuenta de Mercado Pago.

---

## Duele, y necesita una decisión

### 5 · Las notificaciones push no llegan a ningún teléfono

El backend está **entero**: outbox, worker, reintentos, manejo de tokens
muertos y FCM HTTP v1 con la credencial cargada desde fuera del repositorio.

La app **no tiene `firebase_messaging`** y nunca obtiene un token. El parámetro
`pushToken` existe en `loginConGoogle` y nadie se lo pasa.

**Y acá hay un choque que necesita una decisión, no código:** la app de Firebase
se creó como `com.vendox.app`, y el `applicationId` real de la app es
`ar.livesell.livesell_spike`. Un `google-services.json` de `com.vendox.app` no
sirve para este paquete.

Las dos salidas:

| Opción | Qué implica |
|---|---|
| **Crear una app Android nueva en Firebase** con `ar.livesell.livesell_spike` | Cinco minutos. El `applicationId` queda con nombre de spike para siempre, visible en la URL de Play Store |
| **Cambiar el `applicationId` a `com.vendox.app`** | Es el nombre definitivo y correcto. ⛔ **Está prohibido tocarlo sin autorización explícita**, y una vez publicado en Play NO se puede cambiar nunca más |

Si la app se va a publicar con este identificador para siempre, conviene
decidirlo **antes** de la primera publicación y no después.

→ **Necesita:** una decisión del dueño del producto.

### 6 · Sin verificación real de identidad de vendedores

`seller_verifications` tiene los campos para un proveedor externo
—`identity_provider`, `identity_result`, `tax_provider`, `tax_result`— y
**ninguno está conectado**. Hoy la verificación es manual desde el panel.

Para una beta cerrada con vendedores conocidos alcanza. Con vendedores abiertos,
no: es la puerta por la que entra el fraude.

### 7 · Nadie mira la cola de moderación

El panel existe y funciona. Lo que no existe es la rutina: quién la abre, cada
cuánto, y qué pasa si nadie la abre en tres días. Un producto prohibido se
oculta solo al primer reporte; todo lo demás espera a una persona.

→ **Necesita:** una decisión operativa, no código.

---

## Se puede vivir sin esto en la beta

### 8 · R8 está apagado

`minifyEnabled` no está definido, así que la APK no se achica ni se ofusca.
Encenderlo puede romper plugins **en tiempo de ejecución**, de una forma que no
se ve compilando. No se toca sin poder probar en un teléfono real.

### 9 · Sin purga automática de `auth_events`, `notifications` ni `reports`

El chat sí se borra solo a los 30 días. Estas tres crecen sin techo. Ninguna
promesa pública se rompe —la política de privacidad no fija un plazo para
ellas— pero en un año es una tabla que nadie quiere consultar.

### 10 · `SENTRY_DSN` es una variable muerta

Está en `env.schema.ts`, el paquete no está instalado y nadie la lee. O se
implementa o se saca: una variable que sugiere que mandamos errores a un tercero
cuando no lo hacemos confunde a la próxima auditoría de privacidad.

### 11 · El escáner de secretos no corre solo

`tools/escanear-secretos.mjs` está listo y verificado con un control positivo.
No hay hook de pre-commit ni CI que lo dispare: hay que acordarse.

### 12 · No hay reporte de reseñas desde la app

El backend soporta `targetType: 'REVIEW'`. Ninguna pantalla lista reseñas
todavía, así que no hay desde dónde tocar «reportar».

### 13 · No hay expulsión de un vivo

Hay silencio temporal, que resuelve el caso real. Echar a alguien de una sala
pública exige decidir qué pasa si vuelve a entrar, y esa decisión no está
tomada.

### 14 · Iniciar sesión con Apple está deshabilitado

Implementado en el backend. El botón está en la app y apagado hasta que exista
la cuenta de desarrollador de Apple. No bloquea Android.

---

## Deuda conocida y aceptada

Cosas que sabemos y decidimos no arreglar ahora.

- **El `applicationId` dice `livesell_spike`.** Ver el hueco 5.
- **Las tablas del spike siguen en el esquema** (`spike_*`, `SpikeOrder`,
  `SpikeCustomerCard`). No corren en producción —`env.schema.ts` lo prohíbe— y
  borrarlas es una migración destructiva que no aporta nada hoy.
- **El envío es manual.** No hay integración con ningún correo: el vendedor
  cobra el envío y lo despacha por su cuenta. Es una decisión de la V1.
- **El catálogo de categorías es plano.** La columna `parent_id` está para el
  día que una categoría sea tan grande que haya que partirla.
- **Apagar una bandera de emergencia exige reiniciar el proceso.** Son segundos,
  y la alternativa era un segundo mecanismo de configuración conviviendo con el
  que ya existe.

---

## Lo que NO es un hueco

Para que nadie lo agregue a la lista por confusión:

- **Los vivos no se graban.** Es una decisión, no una falta.
- **No guardamos el historial de búsqueda.** Ídem.
- **No hay tarjetas guardadas en producción.** El código existe, es del spike, y
  `env.schema.ts` impide que corra fuera de desarrollo.
- **No hay analítica de terceros.** A propósito: no hay rastreadores dentro de
  la app.
