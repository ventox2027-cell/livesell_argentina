# Runbook — VendoX en IBM Cloud Code Engine (São Paulo)

Desplegar el backend en **Code Engine, región `br-sao`**.

Todo lo que sigue sale de la documentación oficial vigente de IBM (el repo
`ibm-cloud-docs/codeengine`). Donde IBM **no** documenta algo relevante, está
dicho explícitamente en vez de rellenado con una suposición.

> **Nada de esto está ejecutado.** Requiere tu cuenta y tu facturación. El
> objetivo del bloque de portabilidad fue que la imagen corra acá sin cambiar
> una línea de código — no desplegarla. No hagas el paso 9 hasta confirmar que
> Code Engine es el proveedor elegido.

---

## Por qué Code Engine y no Render

Render **no tiene región en Sudamérica**: sus regiones están en EE.UU., Europa
y Asia. Con Neon y Upstash en São Paulo, poner la API en Virginia agrega un
viaje transatlántico a *cada consulta* — y como el checkout hace varias
consultas seguidas, eso se multiplica.

Code Engine sí tiene `br-sao`, con tres zonas (`br-sao-1/2/3`). Es el único de
los tres candidatos que mantiene juntos API, base y Redis.

---

## Lo que hay que saber antes de tocar el panel

Cinco hechos de Code Engine que cambian cómo se despliega:

**1. El puerto es 8080 y lo inyecta la plataforma.**
Code Engine asume que la app escucha en `8080` y define la variable `PORT` con
ese valor. Se cambia con `--port`. **Sólo se puede exponer un puerto**, y
`8022`, `8008`, `8012`, `9090`, `9091` y `15090` están reservados.

**2. Escala a cero por omisión.**
`--min-scale` viene en `0` y `--max-scale` en `10`. Sin tráfico, no queda
ninguna instancia. Cuando llega una petición, se levanta una y se le enruta.

Esto es lo que rompe los `setInterval`: **un proceso apagado no reconcilia
nada**. Por eso el punto 8 de este runbook no es opcional.

**3. Ya hay una sonda de readiness, y es TCP.**
Por omisión, cada app tiene una sonda de tipo `tcp` que sólo comprueba que el
puerto esté abierto. Eso confirma que el proceso arrancó, no que pueda
consultar la base. Se cambia a HTTP contra `/ready`, que es la diferencia entre
recibir tráfico cuando se puede responder o cuando simplemente hay un socket.

**4. Las tareas programadas pueden disparar *jobs*.**
`ibmcloud ce sub cron create` acepta `--destination-type job`. Es exactamente
lo que necesita `jobs:una-vez`: un contenedor que hace un barrido y termina, sin
nada corriendo en el medio.

**5. IBM no documenta una cabecera propietaria de IP de cliente.**
A diferencia de Fly, que documenta `Fly-Client-IP` y la sobrescribe en el
borde, la documentación de Code Engine no describe ninguna equivalente. Por eso
`DEPLOYMENT_PROVIDER=ibm_code_engine` usa conteo de saltos sobre
`X-Forwarded-For` y **no** una cabecera propietaria — inventarse una sería
reabrir la falsificación de IP.

⚠️ **`TRUSTED_PROXY_HOPS=1` es una hipótesis hasta que la verifiques.** El paso
10 explica cómo comprobarla contra el despliegue real. Si el número está mal, el
límite de peticiones de los endpoints de login no protege nada, y no da ningún
error visible.

---

## 1 · Cuenta y CLI

1. Cuenta en <https://cloud.ibm.com/registration>. Requiere verificación; el
   plan Lite no pide tarjeta, pero Code Engine puede exigir cuenta *Pay-As-You-
   Go* según el uso. Si te frena ahí, avisame y evaluamos alternativas antes de
   que cargues una tarjeta.
2. Instalá el CLI:

   ```powershell
   iex (New-Object Net.WebClient).DownloadString('https://clis.cloud.ibm.com/install/powershell')
   ```

3. Cerrá y reabrí la terminal. Después:

   ```powershell
   ibmcloud login
   ibmcloud plugin install code-engine
   ibmcloud target -r br-sao
   ```

4. Comprobá la región:

   ```powershell
   ibmcloud target
   ```

   Tiene que decir `br-sao`. **Este es el paso que no se puede equivocar**: un
   proyecto en otra región deja la API lejos de Neon y Upstash, que es
   exactamente lo que estamos evitando.

---

## 2 · Proyecto

```powershell
ibmcloud ce project create --name vendox-staging
ibmcloud ce project select --name vendox-staging
```

Verificá:

```powershell
ibmcloud ce project current
```

---

## 3 · Registro de imágenes

Code Engine puede construir desde el repositorio, pero acá conviene subir la
imagen ya construida: es el mismo artefacto que probamos localmente, byte por
byte, en vez de uno que se construye distinto en otra máquina.

```powershell
ibmcloud plugin install container-registry
ibmcloud cr region-set br-sao
ibmcloud cr namespace-add vendox
ibmcloud cr login
```

---

## 4 · Construir y subir

Desde `backend/`:

```powershell
$sha = git rev-parse --short HEAD
docker build --build-arg GIT_SHA=$sha -t br.icr.io/vendox/api:$sha .
docker push br.icr.io/vendox/api:$sha
```

El `GIT_SHA` no es decorativo: `/health` lo devuelve, y es cómo se comprueba que
el despliegue efectivamente cambió la versión. Sin eso, un despliegue que falló
en silencio y dejó arriba la anterior se ve idéntico a uno exitoso.

---

## 5 · Secretos

**No pongas secretos en `--env`.** Quedan en la definición de la aplicación,
visibles para cualquiera que pueda leerla.

```powershell
ibmcloud ce secret create --name vendox-db `
  --from-literal "DATABASE_URL=postgresql://...-pooler...?sslmode=require&pgbouncer=true&connection_limit=5" `
  --from-literal "DIRECT_URL=postgresql://...sin-pooler...?sslmode=require"

ibmcloud ce secret create --name vendox-redis `
  --from-literal "REDIS_URL=rediss://default:TOKEN@HOST.upstash.io:6379"

ibmcloud ce secret create --name vendox-auth `
  --from-literal "JWT_SECRET=..." `
  --from-literal "METRICS_TOKEN=..."

ibmcloud ce secret create --name vendox-livekit `
  --from-literal "LIVEKIT_API_KEY=..." `
  --from-literal "LIVEKIT_API_SECRET=..." `
  --from-literal "LIVEKIT_WS_URL=wss://..." `
  --from-literal "LIVEKIT_HTTP_URL=https://..."

ibmcloud ce secret create --name vendox-mp `
  --from-literal "MP_ACCESS_TOKEN=TEST-..." `
  --from-literal "MP_PUBLIC_KEY=TEST-..." `
  --from-literal "MP_WEBHOOK_SECRET=..."
```

Los nombres de variable van tal cual: `--env-from-secret` inyecta cada clave del
secreto como una variable con ese mismo nombre.

---

## 6 · La aplicación web

```powershell
ibmcloud ce app create --name vendox-api `
  --image br.icr.io/vendox/api:$sha `
  --registry-secret vendox-registry `
  --port 8080 `
  --cpu 0.5 --memory 1G `
  --min-scale 1 --max-scale 3 `
  --concurrency 100 `
  --env-from-secret vendox-db `
  --env-from-secret vendox-redis `
  --env-from-secret vendox-auth `
  --env-from-secret vendox-livekit `
  --env-from-secret vendox-mp `
  --env NODE_ENV=staging `
  --env DEPLOYMENT_PROVIDER=ibm_code_engine `
  --env TRUSTED_PROXY_HOPS=1 `
  --env APP_ROLE=web `
  --env GIT_SHA=$sha `
  --env SPIKE_ENABLED=false `
  --env PAYMENTS_SPIKE_ENABLED=false `
  --env PUBLIC_BASE_URL=https://PENDIENTE
```

Cuatro decisiones que vale explicar:

**`--min-scale 1` y no 0.** Con 0, la primera petición después de un rato de
silencio espera a que arranque el contenedor: Node, Nest, el pool de Prisma, la
conexión a Redis. Son varios segundos, y le tocan justo a quien entra a un live.
Para staging es defendible poner 0 y ahorrar; para producción, no.

**`APP_ROLE=web`.** Las tareas periódicas NO corren en este proceso. Van en el
paso 8, y por eso `--min-scale 0` sería viable acá sin dejar de reconciliar.

**`--memory 1G`.** El default de Code Engine es 4 G, que para este proceso es
tirar plata. Node con Prisma y Redis entra cómodo en 1 G.

**`PUBLIC_BASE_URL` queda pendiente**: el dominio se conoce recién después de
crear la app. Se corrige en el paso siguiente.

---

## 7 · Dominio, readiness y migraciones

**El dominio:**

```powershell
ibmcloud ce app get --name vendox-api --output url
```

Devuelve algo como `https://vendox-api.abcdefg.br-sao.codeengine.appdomain.cloud`.
Con eso:

```powershell
ibmcloud ce app update --name vendox-api `
  --env PUBLIC_BASE_URL=https://EL-DOMINIO-QUE-SALIO `
  --env MP_NOTIFICATION_URL=https://EL-DOMINIO-QUE-SALIO/webhooks/mercadopago
```

HTTPS viene incluido en ese dominio, sin configurar nada.

**La sonda de readiness**, que por omisión es TCP:

```powershell
ibmcloud ce app update --name vendox-api `
  --probe-ready type=http --probe-ready path=/ready --probe-ready port=8080 `
  --probe-ready interval=15 --probe-ready timeout=3 --probe-ready failure-threshold=3
```

`/ready` devuelve 503 sólo si PostgreSQL no responde. **Redis caído es
`degraded`, no error**: con Redis abajo se puede seguir reservando, cobrando y
confirmando, así que sacar la instancia de servicio convertiría una degradación
en una caída total.

Ojo con la sintaxis: el prefijo `--probe-ready` se repite en cada propiedad.

**Las migraciones**, como un job que corre una vez:

```powershell
ibmcloud ce job create --name vendox-migrate `
  --image br.icr.io/vendox/api:$sha `
  --registry-secret vendox-registry `
  --command node --argument node_modules/prisma/build/index.js --argument migrate --argument deploy `
  --env-from-secret vendox-db `
  --maxexecutiontime 600 --retrylimit 0

ibmcloud ce jobrun submit --job vendox-migrate --name migrate-$sha
ibmcloud ce jobrun logs --name migrate-$sha
```

`--retrylimit 0` a propósito: una migración que falló a la mitad no se arregla
reintentándola a ciegas. Hay que mirar qué pasó.

Prisma usa `DIRECT_URL` para migrar porque está declarado en el esquema. Contra
el pooler, `migrate deploy` se cuelga esperando un lock de sesión que PgBouncer
no puede darle en modo transacción.

---

## 8 · Las tareas periódicas — el paso que no se puede saltear

Sin esto, con `APP_ROLE=web` **nadie vence reservas ni resuelve pagos
inciertos**. El sistema no da error: simplemente deja de reconciliar.

Hay dos formas. La segunda es la que encaja con Code Engine.

### Opción A — worker permanente

```powershell
ibmcloud ce app create --name vendox-worker `
  --image br.icr.io/vendox/api:$sha `
  --command node --argument dist/main-worker.js `
  --min-scale 1 --max-scale 1 `
  --cpu 0.25 --memory 512M `
  --env APP_ROLE=worker `
  --env-from-secret vendox-db --env-from-secret vendox-redis
```

Simple, pero paga una instancia encendida las 24 horas para algo que trabaja
unos segundos cada 30. Y como no abre puerto, la sonda TCP por omisión de Code
Engine falla — habría que agregarle un servidor HTTP que no necesita.

### Opción B — tarea programada *(recomendada)*

```powershell
ibmcloud ce job create --name vendox-jobs `
  --image br.icr.io/vendox/api:$sha `
  --registry-secret vendox-registry `
  --command node --argument dist/jobs-once.js `
  --cpu 0.25 --memory 512M `
  --maxexecutiontime 300 --retrylimit 1 `
  --env APP_ROLE=web `
  --env NODE_ENV=staging `
  --env DEPLOYMENT_PROVIDER=ibm_code_engine `
  --env-from-secret vendox-db `
  --env-from-secret vendox-redis `
  --env-from-secret vendox-mp

ibmcloud ce sub cron create --name vendox-jobs-cron `
  --destination-type job --destination vendox-jobs `
  --schedule "*/2 * * * *"
```

Cada 2 minutos: arranca un contenedor, barre, termina. Entre barrido y barrido
no hay nada corriendo ni nada que pagar.

`APP_ROLE=web` en un job de tareas periódicas no es un error: `jobs-once.js`
llama a los barridos directamente, y así no arranca además ningún temporizador
que no va a usar.

Las ejecuciones se borran solas a los 10 minutos, así que para revisar hay que
mirar los logs, no la lista de ejecuciones.

**Probalo a mano antes de confiar en el cron:**

```powershell
ibmcloud ce jobrun submit --job vendox-jobs --name jobs-prueba
ibmcloud ce jobrun logs --name jobs-prueba
```

Tiene que salir `barrido completo` y código de salida 0. Si sale `barrido con
fallos`, el código de salida es 1 y el planificador lo marca como fallido —
importa, porque si esto saliera siempre con 0, una tarea que lleva días
rompiéndose se vería igual que una que anda.

---

## 9 · Verificación

```powershell
$URL = ibmcloud ce app get --name vendox-api --output url

curl "$URL/health"
curl "$URL/ready"
curl -H "Authorization: Bearer EL-METRICS-TOKEN" "$URL/metrics" | Select-Object -First 5
curl "$URL/api/v1/discover/products?limit=1"
```

Qué mirar:

| Comprobación | Bien | Mal |
|---|---|---|
| `/health` → `version` | igual al `$sha` que desplegaste | el commit anterior: el despliegue no tomó |
| `/ready` → `database` | `ok`, latencia de un dígito | latencia alta = la base no está en São Paulo |
| `/ready` → `redis` | `ok` | `degraded` = revisá `rediss://` |
| `/metrics` sin token | **401** | 200 = `METRICS_TOKEN` no quedó cargado |
| `/api/v1/discover/products` | 200 | 500 = mirá los logs |

```powershell
ibmcloud ce app logs --name vendox-api --follow
```

El log de arranque dice el rol, el proveedor y qué estrategia de IP quedó
activa. Es la confirmación rápida de que la configuración llegó bien.

---

## 10 · Verificar `TRUSTED_PROXY_HOPS` — no lo saltees

**Esto es una hipótesis hasta que lo midas.** IBM no documenta cuántas entradas
agrega su ingress a `X-Forwarded-For`, y si el número está mal el límite de
peticiones de los endpoints de login no protege nada. Sin error visible.

Provocá un 429 desde dos IPs distintas —tu casa y el celular con datos
móviles— contra un endpoint limitado por IP:

```powershell
1..15 | ForEach-Object { curl -s -o /dev/null -w "%{http_code} " "$URL/api/v1/auth/dev" }
```

Después, desde el otro dispositivo, el mismo comando.

- **Correcto:** el primero llega a 429 y el segundo arranca de cero. Los
  contadores están separados por IP real.
- **Mal:** el segundo ya arranca limitado. Todos comparten contador →
  `TRUSTED_PROXY_HOPS` es más bajo de lo que debería.
- **Mal también:** ninguno llega nunca a 429. La IP está saliendo distinta en
  cada petición → el número es más alto de lo que debería, y se está leyendo lo
  que manda el cliente.

Y la prueba de falsificación, que es la que importa:

```powershell
1..15 | ForEach-Object {
  curl -s -o /dev/null -w "%{http_code} " -H "X-Forwarded-For: 1.2.3.$_" "$URL/api/v1/auth/dev"
}
```

**Tiene que llegar a 429 igual.** Si no llega, la cabecera se está tomando y hay
que subir `TRUSTED_PROXY_HOPS`. Contámelo y lo ajustamos.

---

## Costos

Code Engine cobra por vCPU-segundo y GB-segundo **consumidos**, más las
peticiones. El plan Lite incluye una cuota mensual gratuita.

Con esta configuración:

| Recurso | Configuración | Nota |
|---|---|---|
| API | 0.5 vCPU / 1 GB, min-scale 1 | siempre encendida: es el grueso |
| Tareas | 0.25 vCPU / 512 MB, cada 2 min | segundos por ejecución |
| Migraciones | por despliegue | despreciable |

Con `--min-scale 0` en la API el costo baja mucho, a cambio de que la primera
petición tras un rato de silencio espere el arranque en frío. Para staging es un
buen negocio; para producción, no.

No pongo números en pesos: los precios cambian y prefiero que mires la
calculadora oficial antes de decidir.

---

## Lo que NO está resuelto acá

- **Dominio propio.** Code Engine soporta mapeo de dominio con TLS gestionado
  (`ibmcloud ce domainmapping create`). No lo documento hasta que exista el
  dominio.
- **El webhook de Mercado Pago** necesita la URL definitiva cargada en el panel
  de MP. Es el paso siguiente al despliegue.
- **`TRUSTED_PROXY_HOPS`** está sin verificar contra un despliegue real. Paso 10.
- **Sentry** no está conectado.

---

## Volver a Fly, si aparece la tarjeta

No hay nada que revertir. La misma imagen corre en Fly cambiando tres variables:

```
DEPLOYMENT_PROVIDER=fly
APP_ROLE=all
PORT=3000
```

`fly.toml` sigue en el repositorio y actualizado. Con `DEPLOYMENT_PROVIDER=fly`
el resolver de IP pasa a usar `Fly-Client-IP`, que es más confiable que el
conteo de saltos porque el borde de Fly la sobrescribe.

Ésa es la propiedad que se buscaba con todo este bloque: la aplicación no
depende del proveedor de compute para ser correcta.
