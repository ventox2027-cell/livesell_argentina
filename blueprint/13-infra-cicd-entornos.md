# 13 — Infraestructura, CI/CD y despliegue

Cubre: **§23 CI/CD · §24 Regiones y entornos · §25 Variables de entorno · §28 Deployment · §29 Estimación de recursos · §30 Escalado horizontal**

---

## §24. Regiones — la decisión contraintuitiva

### Dónde poner el cómputo

**Todo el cómputo y la base van a São Paulo. Nada en Buenos Aires.**

Suena mal para una app "Argentina first", así que hay que justificarlo con números:

| Recorrido | RTT |
|---|---|
| Buenos Aires ↔ São Paulo | **25–40 ms** |
| Buenos Aires ↔ Virginia (us-east-1) | 130–170 ms |
| Buenos Aires ↔ Buenos Aires | 5–15 ms |

La tentación es poner la API en Buenos Aires para ahorrar esos 30 ms. **Es un error**, y la razón es la aritmética de las consultas:

```
Escenario A — API en Buenos Aires, base en São Paulo:
  usuario → API:  10 ms
  API → base:     30 ms × 12 consultas = 360 ms   ⛔
  Total:         ~370 ms

Escenario B — API y base en São Paulo:
  usuario → API:  35 ms
  API → base:      1 ms × 12 consultas =  12 ms
  Total:          ~47 ms                            ✅
```

**Una petición dispara entre 10 y 20 consultas. Colocar la aplicación junto a la base ahorra un orden de magnitud más que acercarla al usuario.** El escenario A es 8 veces más lento pese a estar "más cerca".

Lo que **sí** va al borde en Buenos Aires: CDN, WAF y cache de estáticos — Cloudflare tiene PoP local. Ahí no hay ida y vuelta a la base y los 30 ms se ganan de verdad.

**Verificación obligatoria del Sprint 0:** medir el RTT real desde las cuatro operadoras argentinas (Movistar, Personal, Claro, fibra) hacia São Paulo. Si supera los 60 ms de forma consistente, se reevalúa.

### Elección de hosting

| | **Fly.io** ✅ | AWS ECS Fargate | Railway / Render |
|---|---|---|---|
| Región Sudamérica | ✅ `gru` (São Paulo) + `eze` (Buenos Aires) | ✅ `sa-east-1` | ⚠️ Verificar |
| Docker nativo | ✅ | ✅ | ✅ |
| Tiempo hasta el primer deploy | **~30 min** | ~2 días | ~1 h |
| WebSockets de larga duración | ✅ | ✅ | ✅ |
| Grupos de procesos (api/worker) | ✅ Nativo | Servicios separados | Limitado |
| Costo a escala chica | **Bajo** | Medio | Medio |
| Costo a escala grande | Medio | **Bajo** | Alto |
| Necesita DevOps | **No** | Sí | No |

**Elección: Fly.io.** Con un equipo chico y 4 semanas, la velocidad de despliegue vale más que la optimización de costos. Fly da grupos de procesos nativos (api / worker / scheduler desde un solo `fly.toml`), región en São Paulo y despliegue con un comando.

**Disparador de migración a AWS ECS, definido por adelantado:** cuando el gasto mensual en cómputo supere **USD 1.500** o cuando haya un SRE en el equipo. En ese punto, ECS sale entre un 30 % y un 40 % más barato y la operación deja de ser un problema.

### Los cuatro proveedores

```
Cómputo   → Fly.io (gru)
Postgres  → Neon (sa-east-1)     · pooling incluido, branching para staging
Redis     → Upstash (sa-east-1)  · plan dedicado, no serverless
Edge      → Cloudflare           · CDN + R2 + WAF, PoP en Buenos Aires
```

Cuatro vendedores, cada uno reemplazable de forma independiente. No es lock-in: son commodities con API compatible (Postgres, Redis, S3).

**Neon aporta una ventaja concreta:** *branching* de base de datos. Cada PR puede levantar una rama con los datos de producción anonimizados, correr las migraciones y destruirla al mergear. Eso convierte "¿esta migración rompe algo?" en algo verificable en CI.

---

## §28. Estrategia de deployment

### Topología

```mermaid
flowchart TB
    U["📱 Usuarios en Argentina"] --> CF["Cloudflare<br/>PoP Buenos Aires<br/>WAF · CDN · R2"]
    CF --> FLY["Fly Proxy — región gru"]

    subgraph GRU["SÃO PAULO"]
        FLY --> API1["api-1"]
        FLY --> API2["api-2"]
        FLY --> APIN["api-N<br/>autoescalado"]

        W1["worker-critical<br/>reservas · pagos · push"]
        W2["worker-background<br/>media · search · analytics"]
        SCH["scheduler<br/>⚠️ SIEMPRE 1 instancia"]

        API1 & API2 & APIN --> PG[("Neon Postgres<br/>+ pooler")]
        API1 & API2 & APIN --> RD[("Upstash Redis")]
        W1 & W2 & SCH --> PG
        W1 & W2 & SCH --> RD
    end

    API1 & API2 & APIN -.->|"Socket.IO redis-adapter"| RD

    style SCH fill:#7c2d12,color:#fff
```

**El `scheduler` corre con exactamente una instancia.** Emite los trabajos periódicos (barrido de reservas, conciliación de pagos, publicación del outbox). Duplicarlo duplica cada barrido. Está marcado en rojo porque es el error de configuración más fácil de cometer.

**`worker-critical` y `worker-background` están separados a propósito.** Si el procesamiento de imágenes satura el proceso, no puede retrasar la expiración de una reserva ni la acreditación de un pago.

### `fly.toml`

```toml
app = "livesell-api"
primary_region = "gru"

[build]
  dockerfile = "Dockerfile"

[processes]
  api             = "node dist/main.js"
  worker_critical = "node dist/main.js"
  worker_bg       = "node dist/main.js"
  scheduler       = "node dist/main.js"

[env]
  NODE_ENV = "production"
  PORT     = "3000"
  TZ       = "UTC"                      # la base en UTC, siempre

[[services]]
  processes     = ["api"]
  internal_port = 3000
  protocol      = "tcp"
  auto_stop_machines  = false           # ⛔ NUNCA en api: perdería WebSockets
  auto_start_machines = true
  min_machines_running = 2              # sin single point of failure

  [[services.ports]]
    port     = 443
    handlers = ["tls", "http"]

  [services.concurrency]
    type       = "connections"          # no "requests": los WS son persistentes
    soft_limit = 400
    hard_limit = 600

  [[services.http_checks]]
    path     = "/ready"
    interval = "10s"
    timeout  = "3s"

[[vm]]
  processes = ["api"]
  size      = "shared-cpu-2x"
  memory    = "1gb"

[[vm]]
  processes = ["worker_critical"]
  size      = "shared-cpu-2x"
  memory    = "1gb"

[[vm]]
  processes = ["worker_bg", "scheduler"]
  size      = "shared-cpu-1x"
  memory    = "512mb"
```

`auto_stop_machines = false` en `api` es crítico: con WebSockets persistentes, dormir una máquina desconecta a todos sus clientes.

### Dockerfile

```dockerfile
# backend/Dockerfile — multi-stage, sin root, sin herramientas de build en la imagen final
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate && pnpm build && pnpm prune --prod

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Usuario sin privilegios: si alguien logra ejecución remota, no es root.
RUN groupadd -r app && useradd -r -g app app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
USER app
EXPOSE 3000
# dumb-init: reenvía SIGTERM al proceso de Node para un apagado limpio.
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/main.js"]
```

### Apagado ordenado

Sin esto, cada despliegue corta compras a mitad de camino.

```typescript
// backend/src/main.ts
app.enableShutdownHooks();

process.on('SIGTERM', async () => {
  logger.info('SIGTERM — iniciando apagado ordenado');

  // 1) /ready empieza a devolver 503: el balanceador saca esta instancia.
  healthService.setNotReady();
  await sleep(5_000);                    // deja que el LB se entere

  // 2) Avisar a los clientes de WebSocket para que reconecten a otra instancia.
  io.emit('SERVER_SHUTDOWN', { reconnectIn: 1000 });
  await sleep(2_000);

  // 3) Terminar los jobs en curso. Sin esto, un pago a medias queda huérfano.
  await queueManager.closeGracefully(25_000);

  // 4) Cerrar conexiones.
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
});
```

Fly.io da 30 segundos antes del `SIGKILL`; el presupuesto de arriba entra con margen.

### Migraciones en el despliegue

```yaml
# Las migraciones corren en un paso APARTE, ANTES de desplegar el código.
# Nunca en el arranque del contenedor: con N instancias arrancando a la vez,
# N procesos intentarían migrar en paralelo.
- name: Migrate
  run: flyctl ssh console -C "pnpm prisma migrate deploy" -a livesell-api
```

Reglas de migración compatible en ambos sentidos:

1. Toda migración es **hacia adelante**. No hay `down` en producción.
2. Se despliega el código nuevo **con el esquema viejo funcionando**, se migra, y recién después se limpia.
3. Nada de `DROP COLUMN` en la misma migración que deja de usarla: se deja de escribir, se despliega, se espera una semana, se borra.
4. Índices con `CONCURRENTLY`, en su propia migración.

---

## §23. CI/CD

```mermaid
flowchart LR
    PR["Pull Request"] --> L["lint + format"]
    PR --> T["typecheck"]
    PR --> U["tests unitarios"]
    PR --> I["tests de integración<br/>Testcontainers"]
    PR --> S["gitleaks + audit"]
    PR --> D["dependency-cruiser<br/>fronteras de módulos"]
    PR --> B["build de Docker"]
    L & T & U & I & S & D & B --> OK{"¿Todo verde?"}
    OK -->|"no"| BLOCK["🚫 merge bloqueado"]
    OK -->|"sí"| MERGE["merge a main"]

    MERGE --> STG["deploy automático a STAGING"]
    STG --> SMOKE["smoke tests"]
    SMOKE --> GATE{"aprobación manual"}
    GATE --> PROD["deploy a PRODUCCIÓN"]
    PROD --> VERIFY["health + smoke"]
    VERIFY -->|"falla"| RB["rollback automático"]
```

```yaml
# .github/workflows/backend-ci.yml
name: Backend CI
on:
  pull_request: { paths: ['backend/**'] }
  push: { branches: [main], paths: ['backend/**'] }

jobs:
  quality:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: test, POSTGRES_DB: test }
        options: >-
          --health-cmd pg_isready --health-interval 10s --health-retries 5
      redis:
        image: redis:7
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }

      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm depcruise            # fronteras de módulos (documento 03)
      - run: pnpm prisma migrate deploy
        env: { DATABASE_URL: 'postgresql://postgres:test@localhost:5432/test' }
      - run: pnpm test:unit
      - run: pnpm test:integration     # incluye los tests de concurrencia de stock
        env:
          DATABASE_URL: 'postgresql://postgres:test@localhost:5432/test'
          REDIS_URL: 'redis://localhost:6379'
      - run: pnpm test:coverage -- --coverage.thresholds.lines=70

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
      - run: pnpm audit --audit-level=high

  deploy-staging:
    if: github.ref == 'refs/heads/main'
    needs: [quality, security]
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --app livesell-api-staging --strategy rolling
        env: { FLY_API_TOKEN: '${{ secrets.FLY_API_TOKEN }}' }
      - run: pnpm test:smoke --url https://staging.livesell.ar

  deploy-production:
    needs: [deploy-staging]
    runs-on: ubuntu-latest
    environment: production          # ← requiere aprobación manual en GitHub
    steps:
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl ssh console -C "pnpm prisma migrate deploy" -a livesell-api
      - run: flyctl deploy --app livesell-api --strategy canary
      - run: pnpm test:smoke --url https://api.livesell.ar
      - if: failure()
        run: flyctl releases rollback -a livesell-api
```

**Cobertura mínima del 70 % global, pero 90 % en `modules/inventory`, `modules/orders` y `modules/payments`.** Un umbral global uniforme es una métrica vacía; lo que importa es que las tres rutas del dinero estén cubiertas.

### CI de Flutter

```yaml
# .github/workflows/mobile-ci.yml
jobs:
  quality:
    steps:
      - uses: subosito/flutter-action@v2
      - run: flutter pub get
      - run: dart format --set-exit-if-changed .
      - run: flutter analyze --fatal-infos
      - run: flutter test --coverage
      - run: flutter build apk --debug        # verifica que compile

  build-release:
    if: github.ref == 'refs/heads/main'
    # Codemagic construye iOS (no hace falta un Mac local) y sube a
    # TestFlight e Internal Testing de Play.
```

---

## §24. Entornos

| | **Development** | **Staging** | **Production** |
|---|---|---|---|
| Dónde | Docker Compose local | Fly `gru` | Fly `gru` |
| Base | Postgres en contenedor | Neon (rama) | Neon (Multi-AZ) |
| Redis | Contenedor | Upstash chico | Upstash dedicado |
| LiveKit | Proyecto sandbox | Sandbox | Producción |
| Mercado Pago | **Sandbox** | **Sandbox** | **Producción** |
| FCM | Proyecto de dev | Proyecto de dev | Proyecto de prod |
| Datos | Semilla sintética | **Anonimizados** | Reales |
| Instancias de API | 1 | 1 | 2 – N |
| Dominio | `localhost:3000` | `staging.livesell.ar` | `api.livesell.ar` |

**Staging usa Mercado Pago en sandbox, no producción.** Un pago real disparado desde staging por un test es un incidente contable. La única prueba con dinero real se hace en producción, manualmente, antes de lanzar.

**Los datos de staging se anonimizan al copiarse:** teléfonos, emails y DNI se reemplazan. Un volcado de producción en staging es la fuga de datos personales más común y más evitable.

```yaml
# docker-compose.yml — desarrollo local
services:
  postgres:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: livesell }
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
    command: redis-server --maxmemory 256mb --maxmemory-policy noeviction
  mailpit:                      # emails de prueba
    image: axllent/mailpit
    ports: ['8025:8025']
volumes: { pgdata: }
```

---

## §25. Variables de entorno

**La aplicación no arranca si falta una.** `env.schema.ts` (documento 03) valida con Zod al inicio y mata el proceso con un mensaje claro. Nada de `process.env.X!` desperdigado ni fallos a las 3 de la mañana por un secreto vacío.

```bash
# ══════════════ APLICACIÓN ══════════════
NODE_ENV=production                      # development | staging | production
APP_ROLE=api                             # api | worker_critical | worker_bg | scheduler
PORT=3000
API_BASE_URL=https://api.livesell.ar
CORS_ORIGINS=https://admin.livesell.ar
LOG_LEVEL=info
GIT_SHA=a3f9c21                          # inyectado por CI, va en logs y Sentry
TZ=UTC

# ══════════════ BASE DE DATOS ══════════════
DATABASE_URL=postgresql://user:pass@ep-xxx.sa-east-1.aws.neon.tech/livesell?sslmode=require&pgbouncer=true
DATABASE_POOL_SIZE=10
# ⚠️ pgbouncer=true es OBLIGATORIO con pooling en modo transaction.
#    Sin él, Prisma usa prepared statements y produce errores intermitentes
#    imposibles de reproducir en desarrollo.
DOC_ENCRYPTION_KEY=<32 bytes base64>     # pgcrypto para DNI/CUIL

# ══════════════ REDIS ══════════════
REDIS_URL=rediss://default:pass@xxx.upstash.io:6379
REDIS_TLS=true

# ══════════════ AUTH ══════════════
JWT_ACCESS_SECRET=<mín. 32 bytes>
JWT_REFRESH_SECRET=<mín. 32 bytes, DISTINTO del anterior>
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
GOOGLE_CLIENT_ID_ANDROID=...apps.googleusercontent.com
GOOGLE_CLIENT_ID_IOS=...apps.googleusercontent.com
APPLE_TEAM_ID=...
APPLE_KEY_ID=...
APPLE_PRIVATE_KEY=<clave .p8>
APPLE_BUNDLE_ID=ar.livesell.app

# ══════════════ OTP / SMS ══════════════
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_VERIFY_SERVICE_SID=...

# ══════════════ STREAMING ══════════════
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_WS_URL=wss://livesell-xxx.livekit.cloud
LIVEKIT_WEBHOOK_KEY=...
LIVEKIT_EGRESS_ENABLED=true
LIVE_WEBRTC_MAX_VIEWERS=3000             # umbral de desborde a LL-HLS
LIVE_RECONNECT_GRACE_MS=90000

# ══════════════ PAGOS ══════════════
MP_ACCESS_TOKEN=APP_USR-...
MP_PUBLIC_KEY=APP_USR-...                # el WebView del CardForm lo usa
MP_WEBHOOK_SECRET=...
MP_CLIENT_ID=...                         # OAuth de vendedores
MP_CLIENT_SECRET=...
MP_ENVIRONMENT=production                # sandbox | production
PLATFORM_COMMISSION_BPS=1000             # 10 %
PAYOUT_HOLD_DAYS=7

# ══════════════ PUSH ══════════════
FCM_PROJECT_ID=livesell-prod
FCM_CLIENT_EMAIL=firebase-adminsdk-...@....iam.gserviceaccount.com
FCM_PRIVATE_KEY=<clave de la cuenta de servicio>
PUSH_LARGE_SELLER_THRESHOLD=10000        # topic vs envío individual
PUSH_JITTER_WINDOW_MS=45000

# ══════════════ STORAGE ══════════════
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_PUBLIC=livesell-public
R2_BUCKET_PRIVATE=livesell-private
CDN_BASE_URL=https://cdn.livesell.ar

# ══════════════ WHATSAPP (fase 2) ══════════════
WA_PHONE_NUMBER_ID=...
WA_ACCESS_TOKEN=...
WA_VERIFY_TOKEN=...

# ══════════════ OBSERVABILIDAD ══════════════
SENTRY_DSN=https://...@sentry.io/...
SENTRY_TRACES_SAMPLE_RATE=0.1
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-....grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic ...
GRAFANA_PROM_URL=...
GRAFANA_PROM_USER=...
GRAFANA_PROM_PASSWORD=...

# ══════════════ REGLAS DE NEGOCIO ══════════════
RESERVATION_TTL_MS=300000                # 5 min
ORDER_EXPIRY_MS=900000                   # 15 min
MAX_QUANTITY_PER_ORDER=10
GEOCODING_API_KEY=...
```

**Flutter** usa `--dart-define` en tiempo de compilación (nunca un `.env` empaquetado, que es trivial de extraer del APK):

```bash
flutter build appbundle \
  --dart-define=API_BASE_URL=https://api.livesell.ar \
  --dart-define=WS_URL=wss://api.livesell.ar/ws \
  --dart-define=SENTRY_DSN=... \
  --dart-define=MP_PUBLIC_KEY=... \
  --obfuscate --split-debug-info=build/symbols
```

---

## §29. Estimación de recursos

Supuestos: relación espectadores/compradores del 4 %, 60 % del tráfico concentrado en horario pico (20:00–23:00), ticket medio de ARS 25.000.

### 1.000 usuarios concurrentes

| Componente | Tamaño | Costo mensual aprox. |
|---|---|---|
| API (Fly) | 2 × `shared-cpu-2x`, 1 GB | USD 30 |
| Workers | 2 × `shared-cpu-1x`, 512 MB | USD 15 |
| Postgres (Neon) | 2 vCPU, 8 GB | USD 70 |
| Redis (Upstash) | 256 MB dedicado | USD 20 |
| Cloudflare R2 + CDN | 100 GB | USD 5 |
| LiveKit | ~600k min de participante | **USD 250–500** |
| Sentry + Grafana | Plan de arranque | USD 50 |
| **Total** | | **≈ USD 450–700** |

Carga: ~150 peticiones/s en pico, 1.000 conexiones WS, ~40 órdenes/min. **Sobra capacidad con holgura.**

### 10.000 usuarios concurrentes

| Componente | Tamaño | Costo mensual aprox. |
|---|---|---|
| API | 6 × `performance-1x`, 2 GB | USD 180 |
| Worker crítico | 3 × `shared-cpu-2x` | USD 45 |
| Worker background | 2 × `shared-cpu-1x` | USD 15 |
| Postgres | 4 vCPU, 16 GB + **1 réplica de lectura** | USD 300 |
| Redis | 1 GB dedicado | USD 60 |
| R2 + CDN | 1,5 TB | USD 40 |
| LiveKit | ~6M min de participante | **USD 2.500–5.000** |
| Observabilidad | | USD 150 |
| **Total** | | **≈ USD 3.300–5.800** |

Carga: ~1.500 peticiones/s, 10.000 conexiones WS, ~400 órdenes/min, 50 lives simultáneos.

**Aparecen los primeros cuellos de botella reales:**
- Se activa la réplica de lectura para el feed y la búsqueda.
- Los lives con más de 3.000 espectadores desbordan a LL-HLS.
- Se separan los workers críticos de los de background.

### 100.000 usuarios concurrentes

| Componente | Tamaño | Costo mensual aprox. |
|---|---|---|
| API | 20 × `performance-2x`, 4 GB | USD 1.200 |
| **Gateway WS dedicado** | 10 × `performance-1x` | USD 400 |
| Workers | 8 × `performance-1x` | USD 320 |
| Postgres | 16 vCPU, 64 GB + **2 réplicas** + PgBouncer | USD 1.800 |
| Redis | Cluster, 8 GB | USD 400 |
| R2 + CDN | 15 TB | USD 250 |
| LiveKit | ~60M min | **USD 20.000–40.000** |
| Meilisearch | Dedicado | USD 120 |
| Observabilidad | | USD 600 |
| **Total** | | **≈ USD 25.000–45.000** |

**A esta escala cambia la arquitectura, no solo el tamaño:**

1. **El gateway de WebSocket se separa** del API. 100.000 conexiones persistentes tienen un perfil de memoria distinto al de las peticiones HTTP y hay que escalarlas por separado.
2. **Réplicas de lectura obligatorias** para feed, búsqueda y catálogo. Solo las escrituras van al primario.
3. **Se migra a AWS ECS** — a este gasto, la diferencia de precio paga un SRE con holgura.
4. **El video es el 60–80 % de la factura.** Acá se justifica evaluar Cloudflare (PoP en Buenos Aires) o LiveKit autohospedado, que a este volumen puede salir 5 veces más barato.
5. **`analytics_events` se particiona por mes** y se mueve a almacenamiento en columnas.
6. **Se separa el Redis de colas del de cache.**

**La economía cierra:** con 100.000 concurrentes, 4 % de conversión y ticket de ARS 25.000, el GMV mensual está en el orden de los millones de dólares. Con 10 % de comisión, USD 45.000 de infraestructura es un porcentaje muy pequeño. **El problema nunca es el costo absoluto: es no saber cuál es hasta que llega la factura.** Por eso el guardián de presupuesto por live del documento 02.

---

## §30. Qué escalar horizontalmente

| Componente | Escala | Cómo | Límite |
|---|---|---|---|
| **API HTTP** | ✅ Ilimitado | Stateless tras el LB | Conexiones a Postgres |
| **Gateway WS** | ✅ Ilimitado | Redis adapter | Memoria por conexión (~10 KB) |
| **Workers** | ✅ Ilimitado | BullMQ reparte solo | Throughput de Redis |
| **Redis** | ⚠️ Vertical, luego cluster | Sharding por hash | — |
| **Postgres escrituras** | ❌ **No escala en horizontal** | Solo vertical + particionado | **El cuello de botella final** |
| **Postgres lecturas** | ✅ Réplicas | Enrutado en el pool | Retraso de replicación |
| **Scheduler** | ❌ **1 instancia, siempre** | — | Por diseño |
| **CDN / R2** | ✅ Infinito | Lo hace Cloudflare | — |
| **LiveKit** | ✅ | Lo hace el proveedor | Costo |

### El único límite duro: escrituras en PostgreSQL

Todo lo demás escala agregando máquinas. Las escrituras no. Estrategia por etapas:

1. **Escalar vertical** (hasta 64 vCPU es mucho camino).
2. **Sacar las escrituras de alta frecuencia a Redis** — ya está hecho: contadores de espectadores, presencia, métricas en vivo.
3. **Particionar por tiempo** las tablas que solo crecen: `analytics_events`, `audit_logs`, `live_viewers`.
4. **Archivar** órdenes de más de 12 meses a almacenamiento frío.
5. **Sharding por `seller_id`** — último recurso, muy costoso. Un marketplace se presta bien porque los datos se particionan naturalmente por vendedor.

Los pasos 1 a 4 llevan cómodamente a **más de 500.000 usuarios concurrentes**. El paso 5 no debería hacer falta en 24 meses.

### Autoescalado

```toml
[services.auto_scaling]
  min_machines = 2
  max_machines = 20
  metric = "connections"
  target = 350
```

**Reglas del autoescalado:**

- **Escalar hacia arriba rápido, hacia abajo lento.** Subir en 30 segundos, bajar tras 10 minutos de calma. Bajar rápido corta WebSockets sin necesidad.
- **Precalentar antes de un live programado.** Un live agendado con 50.000 seguidores es carga **predecible**: se escala 10 minutos antes en lugar de reaccionar tarde. Es la ventaja de tener un calendario de vivos.
- **Los workers escalan por profundidad de cola**, no por CPU.

### Plan de capacidad para un live viral

Cuando un vendedor pasa de 200 a 20.000 espectadores en 90 segundos, el orden de fallo real es (documento 02 §5):

```
1º  Emisión de tickets      → cache con TTL 120 s + escalar API ×2 en 'watch'
2º  Fan-out de WebSocket    → agrupación de eventos, ventanas más largas
3º  Contador de espectadores → ya está en Redis, no en Postgres
4º  Reserva de stock        → un UPDATE por operación; Postgres lo aguanta
5º  SFU de WebRTC           → desborde a LL-HLS
6º  CDN                     → prácticamente nunca
```

**Nos defendemos en ese orden, no en el inverso.** La intuición dice "se cae el video"; la realidad es que se cae la API de autorización.
