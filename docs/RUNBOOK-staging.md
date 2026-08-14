# Levantar staging

**Estado: la configuración está escrita y verificada; el entorno NO está
creado.** Falta hacer las cuentas y cargar los secretos — son pasos que
necesitan tu tarjeta y tu correo, no código.

Este documento es la secuencia exacta. Debería llevar unos cuarenta minutos.

---

## Por qué staging, y por qué ahora

Hoy todo corre en la notebook con un túnel de Cloudflare cuya URL cambia cada
vez que se reinicia. Eso alcanzó hasta acá, pero deja tres cosas sin poder
hacerse:

1. **Medir capacidad de verdad.** La curva actual —p95 de 21 ms con 5 reservas
   en vuelo, 203 ms con 20— es la de un portátil con Docker Desktop, Node y el
   corredor de tests peleando por la misma CPU. Cuánto aguanta en serio no se
   sabe.
2. **Que Mercado Pago mande webhooks a una URL estable.** Con el túnel hay que
   reconfigurar el panel cada vez.
3. **Probar con gente que no esté en tu red.**

---

## Lo que hace falta crear

| Servicio | Para qué | Plan |
|---|---|---|
| **Fly.io** | La API, región `gru` (São Paulo) | Pago por uso; una máquina compartida sale poco |
| **Neon** | PostgreSQL, región São Paulo | Gratis alcanza para staging |
| **Upstash** | Redis, región São Paulo | Gratis alcanza para staging |

Los tres en **São Paulo**. No es capricho: separar la app de su base agrega un
ida y vuelta a cada consulta, y en el camino de compra hay varias.

---

## 1 · La base — Neon

1. Crear un proyecto en `neon.tech`, región **AWS São Paulo (sa-east-1)**.
2. Guardar **las dos** cadenas de conexión. Neon da dos y **no son
   intercambiables**:

   | Cuál | Para qué |
   |---|---|
   | **Pooled** (`...-pooler...`) | La aplicación. Es la que va en `DATABASE_URL` |
   | **Directa** (sin `-pooler`) | Las migraciones |

   **Esto importa y es la trampa más común de Neon.** El pooler corre pgbouncer
   en modo transacción, que corta las sesiones con estado. `prisma migrate
   deploy` las necesita: contra el pooler falla a la mitad y puede dejar el
   esquema por la mitad.

   A la pooled hay que agregarle `?pgbouncer=true&connection_limit=1`.

---

## 2 · Redis — Upstash

1. Crear una base en `upstash.com`, región **São Paulo**.
2. Copiar la URL `rediss://` (con dos eses: es TLS).

**Se puede vender con Redis caído.** Está diseñado así y probado: toda la suite
de inventario corre con la cola apagada. Redis da precisión en los vencimientos
y el límite de peticiones, nada más. Por eso `/ready` lo reporta como
`degraded` y no saca la instancia de servicio.

---

## 3 · La API — Fly.io

```bash
cd backend

fly auth login
fly apps create livesell-api-staging

# El fly.toml ya está en el repo con la región y los chequeos configurados.
```

### Los secretos

**Ninguno de estos va al repositorio.** Se cargan una vez y quedan cifrados en
Fly.

```bash
fly secrets set \
  DATABASE_URL="postgresql://...-pooler...?pgbouncer=true&connection_limit=1" \
  REDIS_URL="rediss://..." \
  JWT_SECRET="$(openssl rand -hex 48)" \
  LIVEKIT_API_KEY="..." \
  LIVEKIT_API_SECRET="..." \
  LIVEKIT_WS_URL="wss://....livekit.cloud" \
  LIVEKIT_HTTP_URL="https://....livekit.cloud" \
  GOOGLE_CLIENT_ID_WEB="..." \
  GOOGLE_CLIENT_ID_ANDROID="..." \
  MP_ACCESS_TOKEN="..." \
  MP_PUBLIC_KEY="..." \
  MP_WEBHOOK_SECRET="..." \
  MP_NOTIFICATION_URL="https://livesell-api-staging.fly.dev/webhooks/orders/mercadopago" \
  PUBLIC_BASE_URL="https://livesell-api-staging.fly.dev" \
  --app livesell-api-staging
```

> **`JWT_SECRET` tiene que ser distinto del de desarrollo.** Si fueran el
> mismo, un token emitido en la notebook serviría en staging.

### Primer despliegue

```bash
# Las migraciones van con la URL DIRECTA, no la del pooler.
DATABASE_URL="postgresql://...directa..." pnpm prisma migrate deploy

fly deploy --build-arg GIT_SHA="$(git rev-parse --short HEAD)"
```

### Comprobar

```bash
curl https://livesell-api-staging.fly.dev/health
curl https://livesell-api-staging.fly.dev/ready
```

`/ready` tiene que dar **200**. Si da 503, PostgreSQL no responde: revisar
`DATABASE_URL`. Si dice `degraded`, es Redis — la API sigue sirviendo y se
puede vender igual.

---

## 4 · Mercado Pago

En el panel de Mercado Pago → **Webhooks**, apuntar a:

```
https://livesell-api-staging.fly.dev/webhooks/orders/mercadopago
```

Y copiar la clave de firma a `MP_WEBHOOK_SECRET`.

> La URL de órdenes es `/webhooks/orders/mercadopago`. La vieja
> `/webhooks/mercadopago` es la del spike del Sprint 0B y sigue montada para
> poder diagnosticar; **no es la de producción**.

**Sin `MP_WEBHOOK_SECRET` configurada, todas las notificaciones se rechazan con
`NO_SECRET_CONFIGURED`.** Es deliberado: aceptar webhooks sin firmar porque
falta una variable de entorno sería dejar que cualquiera declare pagos.

---

## 5 · CI/CD

Ya está escrito en `.github/workflows/`.

**`ci.yml`** corre en cada PR y en cada push: lint, tipos, los tests de backend
contra un PostgreSQL real, y `flutter analyze` + los tests de contrato.

**`deploy-staging.yml`** corre al empujar a la rama `staging`:

```
verificar → migrar → desplegar → comprobar salud
```

Migrar **antes** de desplegar evita el peor escenario: código nuevo contra un
esquema viejo. Y si el chequeo de salud no pasa, el despliegue no se declara
exitoso aunque Fly diga que la máquina arrancó.

### Secretos de GitHub

En **Settings → Secrets → Actions**, ambiente `staging`:

| Secreto | De dónde sale |
|---|---|
| `FLY_API_TOKEN` | `fly tokens create deploy --app livesell-api-staging` |
| `STAGING_DATABASE_URL_DIRECT` | La cadena **directa** de Neon (no la del pooler) |

---

## 6 · La app apunta a staging

En la pantalla de bienvenida, **Configurar servidor**:

```
https://livesell-api-staging.fly.dev
```

Se guarda y no hace falta recompilar. La opción existe justamente porque la URL
del túnel cambiaba todo el tiempo.

---

## Qué medir apenas esté arriba

Es lo que hoy no se puede saber:

```bash
# Contra staging, no contra la notebook.
DATABASE_URL="<neon directa>" REDIS_URL="<upstash>" pnpm stress:inventory
DATABASE_URL="<neon directa>" REDIS_URL="<upstash>" pnpm stress:orders
```

La curva local dice que una reserva cuesta ~18 ms de trabajo real y que a
partir de ~15 en vuelo empieza a hacer cola. **Ese límite es del portátil, no
del código** — se comprobó que no es el fsync de los commits (500
transacciones sueltas tardan 335 ms) y que quitar viajes a la base no movía el
p95. Cuánto aguanta de verdad se sabe recién con esta medición.

---

## Producción todavía no

Este flujo llega hasta staging a propósito. Desplegar a producción de forma
automática necesita cosas que no existen:

- Vuelta atrás automática.
- Alertas sobre las métricas que ya se emiten.
- Alguien mirando.

Y antes del lanzamiento siguen pendientes, de la lista de deuda:

1. **El `applicationId` es `ar.livesell.livesell_spike`.** Una vez publicado en
   Play **no se puede cambiar nunca más**.
2. **El APK está firmado con la clave de debug.** Si se pierde la clave real,
   no se puede volver a publicar una actualización jamás.
3. **Admin Lite.** Sin panel, el primer problema se atiende con `psql`.
