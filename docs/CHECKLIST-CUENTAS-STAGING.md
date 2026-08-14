# Checklist de cuentas para staging

Todo lo que hay que crear **antes** de poder desplegar, en orden. Cada paso
depende del anterior.

Son tres proveedores y los tres tienen que estar en **São Paulo**. No es una
preferencia: la app, la base y Redis se hablan en cada petición, y ponerlos en
regiones distintas agrega un ida y vuelta transatlántico a cada consulta. Con
todo en `gru`/`sa-east-1`, la latencia entre ellos es de un dígito en
milisegundos.

## Regla sobre los secretos

**No me pases ninguna contraseña, token ni cadena de conexión por el chat.**

Cada paso termina diciendo dónde cargar el valor. Van a Fly y a GitHub, que los
guardan cifrados. Un secreto pegado en una conversación queda en el historial
para siempre y hay que rotarlo.

Cuando termines un paso, decime "listo el 1" y sigo. No hace falta que me
muestres nada.

---

## 1 · Fly.io — donde corre el backend

**Cuenta**

1. Entrá a <https://fly.io/app/sign-up>. Podés registrarte con GitHub.
2. Fly pide **tarjeta de crédito** aunque no cobre nada al principio. Es para
   verificar identidad; sin eso no deja crear máquinas. Cargala en
   Billing → Add payment method.
3. El plan por defecto ya sirve. No contrates nada extra todavía: en el punto S
   del plan te paso los números de costo reales y ahí decidís.

**CLI**

En PowerShell:

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

Cerrá y volvé a abrir la terminal para que tome el PATH. Después:

```powershell
fly auth login
```

Se abre el navegador. Cuando vuelva a la terminal:

```powershell
fly auth whoami
```

Tiene que mostrar tu email.

**La app**

Desde `backend/`, y **con `--no-deploy`** — todavía no hay base ni Redis, un
deploy ahora arranca, falla el chequeo de salud y Fly reintenta en bucle:

```powershell
fly apps create livesell-api-staging --org personal
```

Si el nombre está tomado, elegí otro y avisame: hay que cambiarlo en
`fly.toml` y en el workflow de despliegue.

**Token para el despliegue automático**

```powershell
fly tokens create deploy --name github-actions --expiry 8760h
```

Imprime un token que empieza con `FlyV1`. Copialo y pegalo en:

GitHub → tu repo → Settings → Secrets and variables → Actions →
New repository secret → nombre **`FLY_API_TOKEN`**.

Es un token de despliegue, no tu cuenta entera: sólo puede desplegar esta app.

---

## 2 · Neon — PostgreSQL

1. <https://console.neon.tech/signup>.
2. Create project:
   - **Name:** `vendox-staging`
   - **Postgres version:** 16
   - **Region:** `AWS South America (São Paulo)` — `sa-east-1`.
     ⚠️ Esto **no se puede cambiar después**. Un proyecto en Virginia obliga a
     borrarlo y rehacerlo.
3. Neon crea una base llamada `neondb`. Sirve.

**Las dos cadenas de conexión, que no son intercambiables**

En Dashboard → Connection string vas a ver un selector **Pooled connection**.
Necesitás las dos variantes, y confundirlas es el error más caro de este
documento:

| | Cómo se reconoce | Para qué |
|---|---|---|
| **Con pooler** | el host lleva `-pooler` | la aplicación |
| **Directa** | el host **no** lleva `-pooler` | las migraciones |

**a) La del pooler**, con el selector *Pooled connection* activado. Agregale al
final:

```
&pgbouncer=true&connection_limit=5
```

Queda algo con esta forma:

```
postgresql://USER:PASS@ep-xxx-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require&pgbouncer=true&connection_limit=5
```

Cargala en Fly, desde `backend/`:

```powershell
fly secrets set DATABASE_URL="...pegar acá..." --app livesell-api-staging
```

*Por qué esos parámetros:* sin `pgbouncer=true`, Prisma usa prepared statements
que PgBouncer no puede sostener en modo transacción, y aparecen errores
`prepared statement "s0" already exists` — intermitentes, sólo bajo
concurrencia, con toda la pinta de ser un bug del código. El
`connection_limit=5` evita que cada instancia abra más conexiones de las que el
plan permite. El backend ahora **no arranca** si esta URL apunta al pooler sin
`pgbouncer=true`, así que si te lo olvidás te enterás en el arranque y no bajo
carga.

**b) La directa**, con *Pooled connection* desactivado, sin agregarle nada.

Va a GitHub → Settings → Secrets and variables → Actions → nuevo secreto
**`STAGING_DATABASE_URL_DIRECT`**.

*Por qué:* `prisma migrate deploy` toma un lock de sesión y ejecuta DDL. Contra
el pooler eso se cuelga o falla a la mitad, y una migración parcialmente
aplicada es bastante peor que una que no corrió.

---

**Verificá la cadena antes de seguir**

Desde `backend/`, con la URL del pooler:

```powershell
$env:CHECK_DATABASE_URL="postgresql://...la del pooler..."
npm run check:conexiones
```

Comprueba la región, el `pgbouncer=true`, el `sslmode`, la latencia real y la
versión de PostgreSQL. **No imprime la cadena** — la salida se puede pegar en
un chat sin consecuencias, así que si algo sale en rojo mostrámela.

Contra una base recién creada va a decir "todavía no se corrieron las
migraciones". Es lo correcto: eso es el paso H.

---

## 3 · Upstash — Redis

1. <https://console.upstash.com/>.
2. Create Database:
   - **Name:** `vendox-staging`
   - **Type:** Regional
   - **Region:** `AWS sa-east-1 (São Paulo)`
   - **TLS:** activado. Viene así; no lo desactives.
3. En la pestaña del detalle, sección **Connect**, elegí **ioredis** en el
   selector de cliente. Copiá la URL: empieza con **`rediss://`** — con dos
   eses.

```powershell
fly secrets set REDIS_URL="rediss://..." --app livesell-api-staging
```

⚠️ Upstash también ofrece la variante `redis://`, con una sola ese. Esa manda
el token de autenticación **en texto plano por internet abierto**. Y funciona
igual: no da error, no avisa nada, simplemente tus credenciales viajan a la
vista. El backend ahora rechaza arrancar con `redis://` fuera de local
justamente porque es un fallo que no se nota.

Verificala igual que la de Neon:

```powershell
$env:CHECK_REDIS_URL="rediss://..."
npm run check:conexiones
```

Además de la región y el TLS, comprueba que estén disponibles los comandos que
usan BullMQ y el límite de peticiones. El sistema tolera que Redis se caiga,
pero no tolera un Redis que responde y no sabe hacer lo que se le pide.

---

## 4 · Los secretos restantes

Todos juntos, desde `backend/`. Generá los dos primeros en la terminal, no los
inventes a mano:

```powershell
# Clave de firma de los tokens de sesión.
fly secrets set JWT_SECRET="$(openssl rand -base64 48)" --app livesell-api-staging

# Clave para leer /metrics.
fly secrets set METRICS_TOKEN="$(openssl rand -hex 32)" --app livesell-api-staging
```

Si no tenés `openssl` en PowerShell, sirve:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }))
```

**LiveKit** — de <https://cloud.livekit.io>, en Settings → Keys. Ya las tenés
del sprint 0; si son las mismas de local, reusalas:

```powershell
fly secrets set `
  LIVEKIT_API_KEY="..." `
  LIVEKIT_API_SECRET="..." `
  LIVEKIT_WS_URL="wss://tu-proyecto.livekit.cloud" `
  LIVEKIT_HTTP_URL="https://tu-proyecto.livekit.cloud" `
  --app livesell-api-staging
```

**URL pública** — la necesita para armar los enlaces de las imágenes. No se
puede deducir de la petición: detrás del proxy de Fly, el host que ve el
servidor no es el que el teléfono puede volver a pedir.

```powershell
fly secrets set PUBLIC_BASE_URL="https://livesell-api-staging.fly.dev" --app livesell-api-staging
```

**Mercado Pago** — credenciales de **prueba**, las que empiezan con `TEST-`. El
backend rechaza arrancar fuera de producción con un token productivo: es la
salvaguarda contra cobrarle de verdad a alguien durante una prueba.

```powershell
fly secrets set `
  MP_ACCESS_TOKEN="TEST-..." `
  MP_PUBLIC_KEY="TEST-..." `
  MP_WEBHOOK_SECRET="..." `
  MP_NOTIFICATION_URL="https://livesell-api-staging.fly.dev/webhooks/mercadopago" `
  --app livesell-api-staging
```

El `MP_WEBHOOK_SECRET` sale del panel de Mercado Pago → Tus integraciones → tu
aplicación → Webhooks → Configurar notificaciones. Ahí mismo cargá la URL de
`MP_NOTIFICATION_URL` y suscribite al evento **Pagos**. Eso es el punto J del
plan; si preferís, lo dejamos para cuando la app ya esté desplegada y
respondiendo.

---

## 5 · Verificación

Cuando termines, esto:

```powershell
fly secrets list --app livesell-api-staging
```

Muestra los **nombres** y un hash de cada uno, nunca los valores. Tienen que
estar los 13:

```
DATABASE_URL          REDIS_URL             JWT_SECRET
METRICS_TOKEN         LIVEKIT_API_KEY       LIVEKIT_API_SECRET
LIVEKIT_WS_URL        LIVEKIT_HTTP_URL      PUBLIC_BASE_URL
MP_ACCESS_TOKEN       MP_PUBLIC_KEY         MP_WEBHOOK_SECRET
MP_NOTIFICATION_URL
```

Y en GitHub → Settings → Secrets and variables → Actions, los dos:

```
FLY_API_TOKEN    STAGING_DATABASE_URL_DIRECT
```

Avisame y sigo con el despliegue, las migraciones y las pruebas de carga
(puntos G en adelante).

---

## Lo que NO hay que hacer

- **No pongas la URL del pooler en `STAGING_DATABASE_URL_DIRECT`.** Las
  migraciones se cuelgan o quedan a medio aplicar.
- **No uses `redis://`.** Las credenciales viajan sin cifrar y nada lo indica.
- **No pongas credenciales productivas de Mercado Pago.** El backend las
  rechaza, pero la salvaguarda es la segunda línea de defensa, no la primera.
- **No elijas otra región.** En Neon no se puede cambiar después.
- **No me pegues ningún valor por chat.** Si ya lo hiciste con alguno, decímelo
  y lo rotamos antes de seguir.
