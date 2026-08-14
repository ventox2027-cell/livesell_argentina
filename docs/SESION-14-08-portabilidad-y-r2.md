# VendoX — Sesión del 14/08/2026

Informe de traspaso. Cubre todo lo hecho desde el prompt de *staging real* hasta
el cierre del bloque de Cloudflare R2.

| | Al empezar | Al cerrar |
|---|---|---|
| Commit | `8e26acf` | `2260b88` |
| Tests backend | 449 | **550** |
| Tests Flutter | 33 | 33 |
| lint / typecheck / `flutter analyze` | verde | verde |
| Imagen Docker | **no se podía construir** | construye y corre verificada |
| Proveedor de compute | Fly.io (bloqueado) | **neutral** |
| Imágenes | disco local | **Cloudflare R2** |

**Tres commits, todos en `master` y pusheados:**

- `f4b0c7d` — la app deja de depender del proveedor de compute
- `839aaaa` — imágenes en Cloudflare R2, con el bucket cerrado
- `2260b88` — arreglo: el backend no arrancaba en modo local por `/media` duplicado

---

# 1 · Punto de partida y cambio de plan

El bloque arrancó como *"dejar VendoX corriendo fuera de la notebook"* en Fly.io.
A mitad de camino, **Fly quedó bloqueado porque la cuenta exige tarjeta de
crédito**.

Se evaluó Render y **se descartó**: sus regiones están en EE.UU., Europa y Asia.
No tiene Sudamérica. Con Neon y Upstash ya creados en São Paulo, poner la API en
Virginia agrega un viaje transatlántico a *cada consulta* — y el checkout hace
varias seguidas.

Se decidió entonces **hacer la aplicación neutral respecto del proveedor de
compute** antes de elegir uno. El candidato es IBM Cloud Code Engine, que sí
tiene región `br-sao`.

El principio que ordenó todo el bloque:

> **LA APLICACIÓN NO DEBE DEPENDER DEL PROVEEDOR DE COMPUTE PARA SER CORRECTA.**

---

# 2 · Auditoría de seguridad — dos hallazgos serios

## 2.1 · La IP del cliente se podía falsificar

**Esto se iba a producción en el próximo despliegue.**

`main.ts` tenía `trustProxy: true`. Con esa configuración, Fastify toma la
entrada **más a la izquierda** de `X-Forwarded-For` — y esa la escribe quien
llama:

```
curl -H "X-Forwarded-For: 1.2.3.4" https://api/.../auth/google
```

`request.ip` devolvía `1.2.3.4`. Rotando el valor, una sola persona son un
millón de direcciones distintas.

Lo que rompe es justo lo que más importa: **los endpoints de login son los
únicos que se limitan por IP**, porque todavía no hay usuario a quien atribuirle
los intentos. Alguien probando credenciales robadas pasaba de 10 intentos por
minuto a los que quisiera.

Es el mismo agujero del bug de CGNAT que ya habíamos arreglado, entrando por la
otra puerta.

## 2.2 · `/metrics` estaba abierto

No tiene datos personales, y por eso es fácil dejarlo pasar. Pero publica:

- órdenes creadas por minuto → la facturación aproximada
- tasa de rechazo de pagos
- devoluciones
- un contador por ruta → el mapa completo de la API, endpoints no documentados
  incluidos

Ahora exige token, con comparación en tiempo constante.

## 2.3 · Validación de arranque para tres trampas silenciosas

Se agregaron reglas que **impiden arrancar** ante configuraciones que no fallan
al inicio sino bajo carga — o que no fallan nunca:

| Se detecta | Qué pasaba si no |
|---|---|
| pooler de Neon sin `pgbouncer=true` | `prepared statement "s0" already exists`, intermitente, con pinta de bug del código |
| `redis://` en vez de `rediss://` | el token de Upstash viaja **en texto plano** y nada lo indica |
| `TRUSTED_PROXY_HOPS=0` detrás de un proxy | todo el tráfico comparte un contador y una persona deja afuera al resto |
| `DIRECT_URL` ausente o igual al pooler | `migrate deploy` se cuelga o deja la migración a medias |
| `STORAGE_DRIVER=local` fuera de desarrollo | el disco no se comparte entre instancias y se borra al escalar a cero |

Se verificó que **cada rechazo sale por su propia regla** y no por otra — un
test que espera `success: false` puede quedar verde sin probar nada.

---

# 3 · Portabilidad entre proveedores

## 3.1 · Resolución de IP del cliente

`ClientIpResolver` con **proveedor declarado, nunca detectado**.

| Proveedor | Estrategia | Por qué |
|---|---|---|
| `local` | IP del socket TCP | sin proxy, no sale de ninguna cabecera |
| `fly` | `Fly-Client-IP` → conteo de saltos | el borde de Fly la **sobrescribe** |
| `render` | conteo de saltos | no publica cabecera propietaria |
| `ibm_code_engine` | conteo de saltos | IBM no documenta ninguna |

La regla que lo sostiene: **una cabecera sólo es confiable si el borde donde
corrés la sobrescribe.** Mirar `Fly-Client-IP` "por si acaso" significaría que
en Code Engine cualquiera la manda y vuelve a elegir su IP.

`DEPLOYMENT_PROVIDER` se declara por variable de entorno y su lista es cerrada:
agregar un proveedor es agregar código que documente qué hace su borde.

Además se valida que el valor **parezca una IP**: termina siendo parte de una
clave de Redis, y aceptar cadenas arbitrarias de una cabecera para construir
claves es cómo Redis crece sin techo.

**17 tests**, uno por estrategia, levantando Fastify de verdad. Incluyen dos que
reproducen la configuración vieja para dejar escrito qué hacía.

> ⚠️ **Pendiente de verificación real.** `TRUSTED_PROXY_HOPS=1` para Code Engine
> es una hipótesis: IBM no documenta cuántas entradas agrega su ingress. El paso
> 10 del runbook explica cómo medirlo contra el despliegue. **Si el número está
> mal, el límite de login no protege nada y no da ningún error.**

## 3.2 · Puerto

`PORT` ya no tiene valor por defecto en el esquema: se exige explícito fuera de
local y recién después se rellena con 3000 para desarrollo. Con un `.default()`
era imposible distinguir "no lo mandaron" de "mandaron 3000".

El bind es `0.0.0.0`. Escuchar en `localhost` dentro de un contenedor ata el
socket al loopback del contenedor: el proceso arranca, el puerto figura abierto
desde adentro, y ninguna petición de afuera llega nunca.

## 3.3 · Escalado a cero: web, worker y tarea programada

**El problema.** Code Engine, Render y Fly apagan el contenedor cuando no hay
tráfico. Eso convierte un `setInterval` dentro del proceso web en una trampa:
deja de correr exactamente cuando más falta hace. De madrugada, sin visitas, es
cuando quedan reservas venciendo sin liberar y pagos en estado desconocido sin
resolver — y **no da ningún error**, simplemente deja de reconciliar.

**La solución.** `APP_ROLE = all | web | worker`, tres puntos de entrada sobre
**la misma imagen**:

```
node dist/main.js         API (y tareas si APP_ROLE=all)
node dist/main-worker.js  sólo tareas periódicas, sin puerto abierto
node dist/jobs-once.js    un barrido y termina, para tareas programadas
```

No es partir el sistema en microservicios: mismo repositorio, mismo código,
misma imagen. No hay red entre las partes, ni contrato que versionar, ni
despliegue que coordinar. Lo único que cambia es qué se enciende al arrancar.

**La cola de expiración se parte en dos mitades** con necesidades opuestas:

- **Producir** es parte de reservar, ocurre dentro de la petición del comprador
  → el proceso web la necesita siempre.
- **Consumir** es una espera bloqueante contra Redis → sólo el worker.

Si nadie consume, **no se pierde ninguna reserva**: el reconciliador barre por
`expires_at` en PostgreSQL. La cola da precisión al segundo; la garantía la da
la base.

**`jobs-once` se puede correr en paralelo con el worker sin daño**, y no por
suerte: la condición de vencimiento es un UPDATE condicional, y los
reconciliadores no deciden nada — le preguntan al proveedor de pagos y aplican
la respuesta. Esa propiedad es lo que permite tres formas de despliegue sin
tocar una línea de lógica.

## 3.4 · Apagado ordenado

`src/shutdown.ts`: drena → cierra → tope global, los tres configurables por
variable porque cada plataforma da un plazo distinto antes del SIGKILL.

Si algo se cuelga cerrando, **sale con código 1** en vez de esperar el SIGKILL,
que no ejecuta ningún cierre y deja las conexiones colgadas del otro lado.

**7 tests.**

## 3.5 · Dockerfile

Multi-etapa, Node 22 Alpine, pnpm fijado por `packageManager`, usuario sin
privilegios, **693 MB**, `CMD` en forma exec para que Node sea PID 1 y reciba
SIGTERM directamente. `PORT` ya no se fija en la imagen.

## 3.6 · Base de datos

`DATABASE_URL` (pooler) para la aplicación, **`DIRECT_URL` para las
migraciones**, declarado en el esquema de Prisma. Comando neutral:
`pnpm migrate:deploy`, sin acoplamiento a `fly ssh`.

## 3.7 · CI/CD

**Nuevo `build-image.yml`:** construye la imagen, la arranca contra PostgreSQL y
Redis de servicio, y verifica — **sin desplegar a ningún lado**. Comprueba que
no haya `.env` adentro, que no corra como root, y que el SIGTERM se atienda
midiendo cuánto tarda `docker stop`. Usa un puerto no estándar a propósito: si
el proceso ignorara `PORT`, fallaría.

**`deploy-staging.yml` (Fly) en pausa**, sólo manual. Se conserva porque la app
quedó neutral: si aparece la tarjeta, vuelve a servir cambiando tres variables.

---

# 4 · Cloudflare R2

## 4.1 · El problema que definió el diseño

El bucket es privado y **todavía no hay dominio propio**. Lo obvio sería guardar
URLs firmadas en la base. **Eso rompe el historial de pedidos.**

`OrderItem.imageUrlSnapshot` es un registro histórico: la foto que el comprador
vio cuando compró. Se guarda a propósito, para que si el vendedor después cambia
o borra la imagen, el pedido siga mostrando lo que se compró.

Una URL firmada vence. Guardarla ahí es sembrar imágenes rotas a plazo fijo: a
los cinco minutos el historial de pedidos de **todo el mundo** se vacía solo, y
nada lo avisa hasta que alguien abre una compra vieja.

## 4.2 · La salida

**URL nuestra estable que redirige a una firmada generada en el momento.**

```
teléfono → GET https://api.vendox.ar/media/products/prd_01ABC/<uuid>.webp
                    ↓ el backend firma al recibir la petición
              302 Location: https://…r2…?X-Amz-Signature=…
                    ↓
teléfono → GET Cloudflare      los bytes van directo, sin pasar por la API
```

Cuatro propiedades:

1. **Lo persistido no caduca.** La base guarda `/media/<clave>`, válido para
   siempre.
2. **El bucket sigue cerrado.** Sin firma no se baja nada; las firmas duran 5
   minutos.
3. **Los bytes no pasan por la API.** Como proxy, cada foto de cada producto de
   cada scroll ocuparía una conexión de Node mientras se transfiere.
4. **Se migra sin tocar la base.** Cuando exista el dominio, se configura
   `R2_PUBLIC_BASE_URL`: las URLs nuevas van directas al CDN y las viejas siguen
   funcionando por la redirección.

## 4.3 · Detalles

**Claves:** `products/<productId>/<uuid>.<ext>`. El UUID lo genera el backend; el
`filename` del cliente no se usa nunca como ruta. La extensión sale del **tipo
real** detectado por los primeros bytes, no del `content-type` declarado. Ese
mismo tipo real se guarda como `Content-Type`: un archivo guardado como
`text/html` y servido desde nuestro dominio sería XSS almacenado.

**Lectura:** `/media/<clave>` valida contra una expresión estrecha antes de
firmar nada. Todo lo que no tenga esa forma da **404 sin decir por qué** — un
mensaje distinto para "mal formada" y "no existe" le confirma a quien prueba
cuándo acertó la forma. **25 tests**, incluidos 10 intentos de salto de
directorio.

**Borrado:** después de cometer la transacción, y **no lanza**. Para ese momento
la imagen ya no existe para nadie; propagar el error haría que el vendedor viera
"no se pudo borrar" cuando sí se borró. Lo que queda es un objeto huérfano —
cuesta storage, no corrección — registrado con nivel `error` y contado en
`storage_delete_failed_total`.

**Métricas:** `storage_upload_total`, `storage_upload_failed_total`,
`storage_delete_total`, `storage_delete_failed_total`,
`storage_bytes_uploaded_total`. Sin etiquetas variables: poner el `storageKey`
haría explotar la memoria de Prometheus.

**Desarrollo sigue sin R2.** `STORAGE_DRIVER=local` es el default y no pide
ninguna credencial de Cloudflare para trabajar ni para correr los tests.

**Flutter no cambió.** No conoce R2, no tiene credenciales, no sabe que
Cloudflare existe.

---

# 5 · Bugs encontrados — trece

Todos aparecieron **ejecutando**, no leyendo código.

### Seguridad

1. **`trustProxy: true`** — la IP del cliente se podía falsificar y el límite de
   los endpoints de login no limitaba nada.
2. **`/metrics` abierto** — exponía volumen de ventas, tasa de rechazo de pagos
   y el mapa completo de rutas.

### La imagen no se podía construir

3. **El Dockerfile no copiaba `pnpm-workspace.yaml`**, donde viven los overrides
   desde pnpm 10. El error (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`) apunta al
   lockfile, que estaba bien.
4. **No había `.dockerignore`.** El `.env` con secretos reales entraba en una
   capa intermedia. No llega a la imagen final, pero las capas se conservan en
   caché y se leen con `docker history`. **Un secreto que estuvo en una capa hay
   que rotarlo.**
5. **`pnpm-workspace.yaml` usaba `allowBuilds`**, clave que pnpm no conoce:
   ignoraba el bloque entero y bloqueaba **todos** los scripts de instalación.
   Prisma quedaba sin sus engines nativos. La clave correcta es
   `onlyBuiltDependencies`.
6. **Deriva de versiones de pnpm**: el CI fijaba la 10 a mano, el lockfile es
   v9, y la máquina local tenía `node_modules` enlazado desde el store de la 11.
   Ahora hay una sola fuente: el campo `packageManager`.

### El apagado ordenado no funcionaba

7. **`enableShutdownHooks()` peleaba con el manejador propio de SIGTERM.** Nest
   cerraba todo en t=0 mientras el drenaje esperaba 5 segundos: la app respondía
   errores durante toda la ventana y el proceso salía con código 1, que la
   plataforma registra como apagado fallido. **El drenaje no drenaba nada.**
8. **`RedisService.onModuleDestroy` tumbaba el apagado** si Redis ya estaba
   cerrado o caído — absurdo en un sistema cuyo diseño entero asume que Redis se
   puede caer sin consecuencias.

### Configuración que crea dos programas

9. **El logger mataba el proceso** al arrancar la imagen de producción con
   `NODE_ENV=development`: `prune --prod` borra `pino-pretty` y el error no
   menciona dependencias por ningún lado.
10. **`main.ts` elegía el servidor de archivos por `NODE_ENV`** en vez de por el
    driver de storage. Apuntar el entorno local a R2 habría dado 404 en toda
    imagen.
11. **El backend no arrancaba en modo local por `/media` duplicado.**
    `MediaController` y `@fastify/static` declaraban la misma ruta y Fastify se
    niega a iniciar. *(Introducido y corregido en esta sesión — ver abajo.)*

### Tests que probaban otra cosa

12. **El helper de tests creaba el `FastifyAdapter` sin opciones.** `trustProxy`
    y `bodyLimit` existían sólo en producción: cualquier test del límite por IP
    corría en un servidor que ignora `X-Forwarded-For` mientras el real lo
    obedecía.
13. **El comodín `*` de pino matchea UN solo nivel.** Las credenciales del SDK de
    AWS viven en `err.config.credentials.secretAccessKey` — cuatro niveles — y
    ninguna ruta de redacción llegaba. **Esto afecta a todas las rutas
    existentes**, no sólo a las de storage: `*.cvv` tapa `{pago:{cvv}}` y no tapa
    `{req:{body:{cvv}}}`.

## Sobre el bug 11 — introducido en esta sesión

Vale registrarlo con precisión porque la lección es general.

Se verificó el bloque de R2 arrancando la app compilada con
`STORAGE_DRIVER=r2`. Pasó perfecto: en modo `r2` no se registra
`@fastify/static`, así que no había colisión de rutas. **El único modo roto era
`local`** — el que usa el desarrollo. Se commiteó y se pusheó así.

Apareció al intentar levantar el backend para el emulador.

> **Una condición sobre configuración crea DOS programas, y probar uno no dice
> nada del otro.**

El test nuevo (`storage-module.spec.ts`) arranca los dos caminos y reproduce el
conflicto.

---

# 6 · Verificaciones ejecutadas

## Imagen Docker

```
docker build                    OK, 693 MB
sin .env adentro                ✓
usuario                         app (no root)
/health                         200, version = el commit desplegado
/ready                          database ok 7ms · redis ok 3ms
/metrics sin token              401
/metrics con token              200
/api/v1/discover/products       200
PORT no estándar respetado      ✓
```

## Apagado ordenado, medido en el contenedor

| | Antes | Después |
|---|---|---|
| Peticiones durante el drenaje | app ya cerrada | **HTTP 200** en t=1s, 2s y 3s |
| Código de salida | 1 (fallido) | **0** |
| Log | `Connection is closed` + doble SIGTERM | `apagado ordenado iniciado` → `apagado completo` |

## Los tres roles, con la misma imagen

- **web** — HTTP, reconciliadores apagados, cola sólo productor
- **worker** — sin HTTP, reconciliadores cada 30s y 60s, cola productor y consumidor
- **jobs-once** — un barrido, `barrido completo`, salida 0

## R2, con la app compilada

```
302 → X-Amz-Expires=300
      cache-control: private, max-age=150   (mitad del TTL: nunca sobrevive a su firma)
      referrer-policy: no-referrer
/media/../../etc/passwd        → 404
/media/products/p1/foto.png    → 404   (sin UUID)
/api/v1/media/...              → 404   (fuera del prefijo, como debe)
```

## App en el emulador

Se levantó un Pixel 9 Pro (Android 17, x86_64) y se verificó el flujo completo:
login en modo prueba → feed con datos reales de la base local, mostrando
producto, precio, aviso de stock bajo (`Últimas 3`) y vendedor.

*(El emulador mostraba pantalla negra: había arrancado del todo pero con el
pipeline gráfico trabado — lo confirmó que `screencap` se colgara. Se resolvió
relanzándolo con `-gpu swiftshader_indirect -no-snapshot-load`. Es un problema
del emulador en Windows, no de la app.)*

---

# 7 · Estado de la infraestructura

| Componente | Estado |
|---|---|
| **Neon** — PostgreSQL São Paulo | ✅ creado |
| **Upstash** — Redis São Paulo, TLS | ✅ creado |
| **Cloudflare R2** — `vendox-products` | ✅ creado, privado |
| **Fly.io** | ❌ bloqueado: exige tarjeta de crédito |
| **Render** | ❌ descartado: sin región en Sudamérica |
| **IBM Code Engine `br-sao`** | ⏸️ candidato, runbook escrito, sin cuenta |
| **Dominio propio** | ⏸️ pendiente |
| **Webhook de Mercado Pago** | ❌ apunta a un túnel muerto |

## Documentos entregados

- `docs/CHECKLIST-CUENTAS-STAGING.md` — Fly, Neon y Upstash paso por paso
- `docs/RUNBOOK-staging-ibm-code-engine.md` — Code Engine, de los docs oficiales
  de IBM
- `docs/STORAGE-R2.md` — cómo funciona el almacenamiento
- `backend/.env.staging.example` — sólo nombres y marcadores

## Herramienta de verificación

`npm run check:conexiones` comprueba Neon, Upstash y R2 **sin imprimir ninguna
credencial** — la salida se puede pegar en un chat.

Para R2 sube un PNG, firma una URL, la descarga sin credenciales, comprueba que
el bucket **rechace** el acceso sin firma, y borra el objeto. Escribe de verdad a
propósito: un token de sólo lectura pasa cualquier comprobación pasiva y falla
recién cuando un vendedor sube su primera foto.

---

# 8 · Sobre Code Engine — hechos de la documentación oficial de IBM

Confirmado: **Code Engine tiene región `br-sao`** con tres zonas.

| | |
|---|---|
| Puerto | **8080** por omisión, inyectado como `PORT`; un solo puerto expuesto |
| Escalado | `min-scale` **0** por omisión → escala a cero; `max-scale` 10 |
| Sondas | readiness **TCP** por omisión — sólo comprueba que el puerto esté abierto. Hay que cambiarla a HTTP contra `/ready` |
| Tareas programadas | `ibmcloud ce sub cron create` acepta `--destination-type job` — exactamente lo que necesita `jobs-once` |
| Cabecera de IP de cliente | **IBM no documenta ninguna propietaria** |

Ese último punto es la razón de que `ibm_code_engine` use conteo de saltos y no
una cabecera: inventarse una sería reabrir la falsificación de IP.

---

# 9 · Deuda nueva

1. **`TRUSTED_PROXY_HOPS` sin verificar** contra un despliegue real. Si está mal,
   el límite de login no protege y no da error. Paso 10 del runbook.
2. **Sin barrido de objetos huérfanos en R2.** La métrica existe para alertarlo;
   el barrido se escribe si el contador se mueve.
3. **R2 nunca se ejercitó contra el bucket real** — falta correr
   `check:conexiones`.
4. **Sentry sigue sin conectar.**
5. **Sin pruebas de degradación con PostgreSQL caído.**
6. **`render` está implementado pero nunca ejercido.**
7. **Imagen de 693 MB** — se puede bajar bastante, no es prioridad.
8. **Webhook de Mercado Pago apuntando a un túnel muerto.** Sin él no llegan
   confirmaciones de pago, que es lo que ejercita el conciliador.
9. Las URLs prefirmadas de S3 exponen el *access key ID* (no el secreto) por
   diseño de la firma AWS v4. Desaparece cuando haya dominio público.

---

# 10 · Qué falta y de quién depende

## Requiere al dueño de las cuentas

1. **Verificar el bucket de R2** con `check:conexiones`. Es lo único que separa a
   R2 de estar cerrado del todo.
2. **Decidir el proveedor de compute.** Code Engine tiene el runbook listo.
   Ninguno de los dos requiere cambios de código.
3. **Firewall de la notebook**: la Ethernet quedó en perfil *público*, lo que
   bloquea las conexiones entrantes del teléfono físico. El emulador no depende
   de esto.
4. **Webhook de Mercado Pago**, si se quiere probar un pago de punta a punta.

## Siguiente bloque acordado

**Admin Lite V1** — herramienta operativa de soporte: buscar, entender, actuar y
auditar sobre usuarios, vendedores, productos, órdenes, pagos, devoluciones,
reservas, webhooks y auditoría.

Se acordó hacer **R2 antes que Admin Lite** porque Admin muestra imágenes de
producto: al revés, esas pantallas habrían quedado atadas al storage local que
después íbamos a reemplazar.

---

# 11 · Principios que quedaron escritos en el código

- **Una cabecera sólo es confiable si el borde donde corrés la sobrescribe.**
- **Una condición sobre configuración crea dos programas**, y probar uno no dice
  nada del otro.
- **Lo que se persiste no puede caducar.** Vale para las URLs de imágenes y para
  cualquier snapshot histórico.
- **La redacción de logs es la red debajo, no el plan.** El plan es no registrar
  objetos crudos de terceros.
- **La verdad sigue en PostgreSQL.** Que un barrido lo dispare un `setInterval`,
  un cron del proveedor o alguien a mano da igual: la decisión no está en el
  disparador. Por eso se puede cambiar de forma de despliegue sin tocar lógica.
