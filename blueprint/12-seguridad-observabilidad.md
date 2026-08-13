# 12 — Seguridad y observabilidad

Cubre: **§21 Seguridad · §22 Observabilidad**

---

## §21. Seguridad

### Autenticación

**JWT de acceso corto + refresh rotativo.** Sin sesiones en servidor: los servidores tienen que ser *stateless* para escalar horizontalmente (§35).

| Token | Duración | Dónde vive | Contiene |
|---|---|---|---|
| Access | **15 min** | Memoria de la app | `sub`, `role`, `sellerId?`, `jti` |
| Refresh | **30 días**, rotativo | Keychain / Keystore | Opaco, solo el hash está en la base |

```typescript
// backend/src/modules/auth/application/refresh.usecase.ts
async execute(rawToken: string, ip: string): Promise<TokenPair> {
  const hash = sha256(rawToken);
  const stored = await this.repo.findByHash(hash);

  if (!stored)                     throw new UnauthorizedError('INVALID_REFRESH');
  if (stored.expiresAt < new Date()) throw new UnauthorizedError('EXPIRED_REFRESH');

  // ⛔ DETECCIÓN DE ROBO.
  // Si llega un token que YA fue rotado, hay dos posibilidades: o alguien
  // lo robó, o el legítimo lo reusó. En ambos casos se revoca TODA la familia
  // y se fuerza a volver a iniciar sesión. Es la única defensa efectiva
  // contra un refresh token filtrado.
  if (stored.replacedBy || stored.revokedAt) {
    await this.repo.revokeFamily(stored.userId);
    await this.audit.log('auth.refresh_reuse_detected', { userId: stored.userId, ip });
    await this.alerts.notify('refresh-token-reuse', { userId: stored.userId });
    throw new UnauthorizedError('TOKEN_REUSE_DETECTED');
  }

  const next = await this.repo.rotate(stored, ip);
  return this.issuePair(stored.userId, next);
}
```

**Inicio de sesión social.** El `idToken` de Google y el `identityToken` de Apple se verifican **contra las claves públicas del proveedor** (JWKS cacheado), nunca decodificando sin validar. Se comprueban `aud`, `iss`, `exp` y el `nonce` en el caso de Apple.

**Apple Sign-In es obligatorio** si ofrecemos Google. Es política de la App Store y el rechazo por esto cuesta una semana de revisión.

### Autorización — RBAC

```typescript
// backend/src/shared/security/guards/resource-owner.guard.ts
// No alcanza con "es vendedor": hay que verificar que sea el vendedor
// DUEÑO del recurso. Es el fallo de autorización más común en marketplaces:
// un vendedor editando el producto de otro.
@Injectable()
export class SellerOwnsResourceGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const { sellerId } = req.user;
    const resourceId = req.params.id;
    const type = this.reflector.get<ResourceType>('resourceType', ctx.getHandler());

    const owner = await this.resolver.getOwnerSellerId(type, resourceId);
    if (owner !== sellerId) throw new ForbiddenError('NOT_RESOURCE_OWNER');
    return true;
  }
}
```

Roles: `buyer` · `seller` · `moderator` · `admin`. Se verifica **en cada endpoint**, nunca por convención de ruta.

### Validación de entrada

```typescript
// Zod en el borde. Nada entra sin validar.
export const CreateOrderSchema = z.object({
  items: z.array(z.object({
    variantId: z.string().regex(/^var_[0-9A-HJKMNP-TV-Z]{26}$/),
    quantity:  z.number().int().min(1).max(10),
  })).min(1).max(20),
  liveId:    z.string().regex(/^liv_/).optional(),
  addressId: z.string().regex(/^adr_/).optional(),
  channel:   z.enum(['ui_button', 'voice', 'whatsapp']).default('ui_button'),
}).strict();   // ⛔ strict: una propiedad extra es un error, no se ignora
```

`.strict()` importa: sin él, un cliente puede mandar `{ totalCents: 1 }` y, si algún día alguien hace un `spread` descuidado del body, se cuela. Con `.strict()`, la petición se rechaza.

**Inyección SQL:** Prisma parametriza. Los `$queryRaw` usan **plantillas etiquetadas**, nunca concatenación:

```typescript
await prisma.$queryRaw`SELECT * FROM inventory WHERE variant_id = ${id}`;   // ✅ parametrizado
await prisma.$queryRawUnsafe(`SELECT … WHERE id = '${id}'`);                 // ❌ prohibido en CI
```

Regla de ESLint que prohíbe `$queryRawUnsafe` y `$executeRawUnsafe` en todo el repositorio.

### Rate limiting

| Alcance | Límite |
|---|---|
| Global por IP | 300 / min |
| Por usuario autenticado | 600 / min |
| `POST /auth/phone/request` | **3 / hora por número** |
| `POST /auth/*` | 10 / min por IP |
| `POST /orders` | 10 / min por usuario |
| `POST /orders/{id}/pay` | 5 / min por usuario |
| `POST /me/addresses` | 3 / hora por usuario |
| `comment:send` (WS) | 5 / 10 s |
| Subida de imágenes | 200 / hora por vendedor |

Implementado con ventana deslizante en Redis. Los webhooks del PSP **no** se limitan.

### Datos sensibles

| Dato | Tratamiento |
|---|---|
| **Tarjetas** | ❌ **Nunca tocan nuestros servidores.** Solo tokens de MP. Alcance SAQ-A |
| **DNI / CUIL** | Cifrado a nivel de columna con `pgcrypto`. Clave en Secrets Manager, inyectada por sesión |
| Direcciones | En claro pero con acceso auditado; alerta si una consulta devuelve más de 100 filas |
| Teléfonos | En claro; enmascarados en logs |
| Contraseñas | No existen — solo OIDC y OTP |
| Tokens de refresh | Solo el hash SHA-256 en la base |
| Tokens de MP del vendedor | Cifrados con `pgcrypto` |

**`user_addresses` es el activo más sensible del sistema.** Un volcado expone el documento y el domicilio de toda la base de usuarios. Además del cifrado: acceso restringido por IAM, sin réplica a entornos de desarrollo y alerta ante lecturas masivas.

**Datos personales en logs:** un serializador de Pino los borra antes de escribir.

```typescript
// backend/src/shared/observability/logger.service.ts
const REDACT = [
  'req.headers.authorization', 'req.headers.cookie',
  '*.password', '*.cardToken', '*.card_number', '*.cvv', '*.securityCode',
  '*.docNumber', '*.doc_number', '*.phoneE164',
  '*.accessToken', '*.refreshToken', '*.mpAccessToken',
];
```

Se verifica con un test que envía datos sensibles y comprueba que no aparecen en la salida.

### Superficie de red

- **TLS 1.3** en todas partes. HSTS con `preload`.
- **Certificate pinning** en Flutter para los endpoints de pago. Con respaldo: dos pines (actual y siguiente) para que la rotación del certificado no rompa la app en producción.
- **CORS** restringido: solo el dominio del admin. La app móvil no usa CORS.
- **WAF de Cloudflare** delante de todo: bloqueo geográfico salvo Argentina en el PMV, protección contra bots, mitigación de DDoS.
- **Los webhooks son públicos pero verificados por firma**, y solo se aceptan de los rangos de IP del proveedor cuando estén documentados.

### Secrets

Nunca en el repositorio, nunca en la imagen de Docker.

```
Producción/Staging: Fly.io Secrets + Cloudflare Secrets Store
Desarrollo:         .env.local, en .gitignore, con .env.example versionado
CI:                 GitHub Actions Secrets con OIDC (sin claves de larga vida)
```

Escaneo de secretos en cada PR con `gitleaks`. Rotación cada 90 días de: JWT secrets, claves de LiveKit, webhook secrets.

### La app móvil

| Riesgo | Mitigación |
|---|---|
| Ingeniería inversa del APK | Ofuscación con `--obfuscate --split-debug-info` |
| Tokens en almacenamiento inseguro | `flutter_secure_storage` (Keychain / Keystore) |
| Dispositivos con root/jailbreak | Detección + advertencia. **No se bloquea**: falsos positivos y usuarios legítimos |
| Captura de pantalla en el pago | `FLAG_SECURE` en la hoja de pago (Android) |
| Manipulación de la lógica de precios | **No hay lógica de precios en el cliente.** Es la defensa real |

**La defensa de fondo no es ofuscar la app: es que la app no tenga nada que valga la pena robar.** No calcula precios, no decide stock, no confirma pagos. Todo lo importante pasa en el servidor.

### Checklist de seguridad antes de lanzar

- [ ] `gitleaks` limpio en todo el historial.
- [ ] `pnpm audit` / `dart pub outdated` sin vulnerabilidades altas.
- [ ] Test de redacción: datos sensibles no aparecen en logs ni en Sentry.
- [ ] Detección de reuso de refresh token probada.
- [ ] Autorización probada: un vendedor no puede editar recursos de otro.
- [ ] Rate limiting verificado en los endpoints de auth y pago.
- [ ] Firma de webhooks probada con una firma inválida.
- [ ] Cifrado de DNI verificado: la columna es ilegible sin la clave.
- [ ] Certificate pinning probado con un proxy interceptor.
- [ ] Datos de tarjeta ausentes de logs, Sentry y base (verificado por búsqueda).
- [ ] WAF activo con bloqueo geográfico.

---

## §22. Observabilidad

### Logging estructurado

JSON, siempre. Con `traceId` propagado **desde la app móvil**.

```typescript
// backend/src/shared/observability/logger.service.ts
export const loggerConfig: LoggerOptions = {
  level: env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACT, censor: '[REDACTED]' },
  formatters: { level: (label) => ({ level: label }) },
  base: { service: 'api', env: env.NODE_ENV, version: env.GIT_SHA },
};

// Todo log incluye el contexto de la petición.
log.info({
  traceId: ctx.traceId,       // ← viene de la app en el header x-trace-id
  userId: ctx.userId,
  route: 'POST /orders',
  durationMs: 142,
  orderId, liveId, variantId,
}, 'order created');
```

**El `traceId` nace en la app.** Cuando un vendedor diga "no me deja cobrar", hay que poder reconstruir la traza completa desde el toque en la pantalla hasta Mercado Pago. Sin propagarlo desde el cliente, la investigación empieza a ciegas.

### Métricas

Prometheus en `/metrics`, recolectado por Grafana Cloud.

**Técnicas**

```
http_request_duration_seconds{route, method, status}     histogram
http_requests_total{route, method, status}               counter
db_query_duration_seconds{operation}                     histogram
db_pool_connections{state}                               gauge
redis_command_duration_seconds{command}                  histogram
queue_jobs_total{queue, status}                          counter
queue_job_duration_seconds{queue}                        histogram
queue_depth{queue}                                       gauge
websocket_connections_active                             gauge
websocket_events_sent_total{event}                       counter
```

**De negocio — las que realmente importan**

```
lives_active                                             gauge
live_viewers_total{liveId}                               gauge
live_stream_failures_total{reason}                       counter
stream_mode_switches_total{from,to}                      counter

inventory_reservations_total{result}                     counter
inventory_reservation_duration_seconds                   histogram
inventory_negative_available_total                       counter   ⛔ debe ser SIEMPRE 0
inventory_paid_without_stock_total                       counter   ⛔ debe ser SIEMPRE 0

orders_created_total{source}                             counter
orders_expired_total                                     counter
payments_total{provider, status}                         counter
payments_reconciled_total                                counter
payment_duration_seconds{provider}                       histogram
gmv_cents_total{sellerId}                                counter

push_sent_total{type, result}                            counter
push_delivery_duration_seconds{type}                     histogram
```

Las dos marcadas con ⛔ son **alertas críticas ante cualquier valor distinto de cero**. No son métricas de tendencia: son detectores de bugs graves.

### Los cinco tableros del día del lanzamiento

**1. Salud del live** — lives activos, espectadores totales, latencia p95 por modo, tasa de conmutación a LL-HLS, fallos del reproductor por operadora.

**2. Embudo de compra en tiempo real** — `live_view → product_click → reservation → order → payment → confirmed`. Una caída en cualquier escalón es una alerta, no un dato.

**3. Dinero** — GMV por hora, tasa de éxito de pagos por proveedor, pagos huérfanos, conciliaciones, reembolsos.

**4. Salud del sistema** — p95 de la API, tasa de error, conexiones de base, profundidad de colas, memoria de Redis.

**5. Notificaciones** — enviados, entregados, abiertos y **desactivaciones**, por tipo.

### Trazado distribuido

OpenTelemetry, con el `traceId` viajando desde Flutter:

```
📱 tap "Comprar"
 └─ HTTP POST /orders                              142 ms
     ├─ auth.verify                                  2 ms
     ├─ idempotency.check                            3 ms
     ├─ inventory.reserve                           28 ms
     │   └─ db.UPDATE inventory                     24 ms
     ├─ orders.create                               31 ms
     │   └─ db.INSERT order + items                 27 ms
     ├─ outbox.insert                                8 ms
     └─ db.COMMIT                                   41 ms
 └─ (async) queue: expire-reservation            +5 min
 └─ (async) ws: STOCK_UPDATED                        3 ms
```

Muestreo: **100 % de los errores, 100 % de las rutas de pago, 10 % del resto.** Trazar todo a escala es caro y no aporta; trazar todo lo que involucra dinero, sí.

### Errores — Sentry

```typescript
Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  release: env.GIT_SHA,
  tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
  beforeSend(event) {
    // Los errores esperados de dominio NO son errores de sistema.
    // Un INSUFFICIENT_STOCK es el sistema funcionando bien.
    if (EXPECTED_DOMAIN_ERRORS.has(event.tags?.errorCode)) return null;
    return scrubPii(event);
  },
});
```

**Filtrar los errores de dominio esperados es lo que mantiene Sentry útil.** Sin ese filtro, el ruido de `INSUFFICIENT_STOCK` y `RESERVATION_EXPIRED` tapa los errores reales y en dos semanas nadie mira las alertas.

En Flutter, `sentry_flutter` con símbolos de depuración subidos en cada build, más contexto de red (tipo de conexión, operadora) en cada evento.

### Health checks

```typescript
// GET /health — ¿el proceso está vivo? Sin dependencias externas.
//   Lo usa Fly.io para reiniciar. Debe responder aunque Postgres esté caído:
//   si dependiera de la base, una caída de base reiniciaría todas las
//   instancias en bucle y empeoraría el incidente.
{ "status": "ok", "uptime": 3841, "version": "a3f9c21" }

// GET /ready — ¿puede recibir tráfico? Comprueba dependencias.
//   Lo usa el balanceador para sacar la instancia de rotación.
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok", "latencyMs": 3 },
    "redis":    { "status": "ok", "latencyMs": 1 },
    "livekit":  { "status": "ok", "latencyMs": 42 },
    "mercadopago": { "status": "degraded", "latencyMs": 890 }
  }
}
```

**`degraded` no saca la instancia de rotación.** Que Mercado Pago esté lento no significa que no podamos servir el feed, los lives ni el catálogo. Solo `database` y `redis` en estado `error` devuelven 503.

### Alertas

| Alerta | Umbral | Severidad |
|---|---|---|
| `inventory_negative_available_total > 0` | Cualquiera | 🔴 **Despierta a alguien** |
| `inventory_paid_without_stock_total > 0` | Cualquiera | 🔴 **Despierta a alguien** |
| Job crítico en la DLQ | Cualquiera | 🔴 **Despierta a alguien** |
| Tasa de éxito de pagos | < 95 % durante 5 min | 🔴 |
| Tasa de error de la API | > 2 % durante 5 min | 🔴 |
| p95 de la API | > 1 s durante 10 min | 🟠 |
| Fallos del reproductor | > 5 % de las sesiones | 🟠 |
| Profundidad de `push-send` | > 10.000 durante 5 min | 🟠 |
| Antigüedad del barrido de reservas | > 2 min | 🟠 |
| Conexiones de Postgres | > 80 % del máximo | 🟠 |
| Memoria de Redis | > 85 % | 🟠 |
| Desactivaciones de push | > 1 % diario | 🟡 |
| `payments_reconciled_total` creciendo | Tendencia sostenida | 🟡 Los webhooks no llegan |

**Regla anti-fatiga:** si una alerta 🔴 suena más de una vez por semana sin ser un incidente real, se recalibra o se baja de severidad. Una alerta que se ignora es peor que no tenerla.

### Retención

| Dato | Retención |
|---|---|
| Logs de aplicación | 30 días |
| Trazas | 7 días |
| Métricas | 13 meses (comparación interanual) |
| `audit_logs` | **7 años** (requisito fiscal) |
| `analytics_events` | 24 meses, particionado por mes |
| Errores de Sentry | 90 días |
