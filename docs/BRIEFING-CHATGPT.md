# VendoX · Briefing para ChatGPT

**Copiá y pegá este documento entero.** Es el estado real del proyecto al
13/08/2026, con los números medidos y las decisiones ya tomadas.

---

## Cómo trabajamos

Sos la responsable de **producción**: analizás, decidís y priorizás. Claude
(Opus, en Claude Code) **ejecuta**: escribe el código, lo corre, lo prueba
contra bases reales y reporta con números.

Mateo prueba en dispositivos reales y trae los defectos que sólo aparecen
usando la app.

Lo que Claude entrega en cada bloque: código completo (nunca pseudocódigo),
migraciones, tests ejecutados, resultado de lint/typecheck/`flutter analyze`,
bugs encontrados, deuda técnica nueva, qué se puede probar desde el celular y
un mensaje de commit sugerido. No declara nada terminado sin haberlo ejecutado.

**Lo que necesitamos de vos:** las decisiones de la sección final. Están
frenando cosas concretas.

---

## Qué es VendoX

App móvil de venta en vivo para Argentina. Feed vertical de video,
transmisiones en directo y compra sin salir del video.

Tres principios que atraviesan todo:

| | |
|---|---|
| **Argentina primero** | Infra en São Paulo, Mercado Pago, WhatsApp, teléfonos `+549` |
| **Simple ahora, escalable después** | Monolito modular, no microservicios |
| **El backend es la fuente de verdad** | Ninguna decisión de dinero se toma en un dispositivo que el usuario controla |

**Stack:** Node 22 · TypeScript · NestJS 11 + Fastify · PostgreSQL 16 (Prisma)
· Redis 7 · Zod · Vitest. Móvil: Flutter 3 · Riverpod · Dio · LiveKit.

**Repositorio:** `github.com/ventox2027-cell/livesell_argentina` (privado).
Último commit: `623edc8`.

---

## Estado por módulo

| Módulo | Estado |
|---|---|
| Sprint 0A · LiveKit | ✅ GO, medido en campo |
| Sprint 0B · Mercado Pago | ✅ GO, compra real acreditada |
| Auth | ✅ funcionando con Google real |
| Sellers / Stores / Products / Variantes / Imágenes | ✅ funcionando |
| **Inventory / Reservation** | ✅ funcionando |
| **Orders / Payments / Refunds** | ✅ funcionando |
| Feed (descubrimiento) | 🟡 productos y stock reales, falta el video |
| **Live Sessions / Realtime** | ⛔ **siguiente** |
| Search / Notifications | ⛔ |
| Admin Lite | ⛔ **requisito previo al lanzamiento** |

**449 tests** de backend contra PostgreSQL real y **33 de contrato** en la app.
Lint, typecheck y `flutter analyze` en verde.

---

## Lo que ya está medido (no estimado)

### Video — Sprint 0A: GO

- **Glass-to-glass p95: 577 ms** (objetivo 800, tolerable 1500).
- 0,0 % de pérdida de paquetes en 426 muestras.
- 4G midió *más rápido* que WiFi (344 vs 480 ms) porque el bitrate adaptativo
  bajó la calidad. Es el compromiso correcto para un vivo de venta.

**El hallazgo que cambió requisitos:** el SFU tarda **13,7 a 20,1 segundos** en
avisar que el emisor se cayó. Durante esa ventana la señalización dice que todo
está bien mientras el espectador mira una foto congelada.

Consecuencias (son requisitos, no deuda):
1. La UI de reconexión no puede basarse en eventos de track.
2. Hace falta un **watchdog de cuadros en el cliente** (`framesDecoded`).
3. La pantalla no debe ponerse negra: último cuadro + chat vivo + aviso.

Cuatro cortes de red, cuatro recuperaciones automáticas. Costo fijo de
recuperación: ~7 s por encima del corte real.

**Pendiente:** time-to-first-frame de **4020 ms** (objetivo ≤1500).

### Pagos — Sprint 0B: GO

- **Alcance PCI SAQ-A**, no SAQ-D. CardForm de Mercado Pago en WebView con
  `iframe: true`: el número de tarjeta no pasa por nuestro DOM, ni por Dart, ni
  por nuestro backend. SAQ-D implicaría auditoría anual y escaneos
  trimestrales: inviable para un equipo de esta escala.
- Compra real: de tocar *Pagar* a `PAID` en **1,8 segundos**.
- Verificado sobre datos reales: **cero** filas con datos de tarjeta en base,
  auditoría, webhooks y logs. Sólo se guarda `last_four` y `brand`.
- La guarda de monotonía actuó sola en la primera compra real: el webhook llegó
  681 ms después de que la respuesta directa ya había acreditado. Sin esa
  guarda, se acreditaba dos veces.

**Bloqueado por Mercado Pago:** la compra en dos clics con tarjeta guardada
devuelve `internal_error` 500 en las cuatro variantes que probamos. Es del lado
de ellos, está documentado y se frenó ahí.

### Inventario — sin sobreventa posible

- **100 compradores simultáneos, 2 unidades → exactamente 2 y 98 sin stock.**
- **1000 compradores, 5 unidades → exactamente 5, 995 sin stock, 0 errores.**
- Una reserva cuesta ~18 ms. p95 de 65 ms con 10 peticiones en vuelo.

---

## Las decisiones de arquitectura ya tomadas

No hace falta re-discutirlas salvo que tengas un argumento nuevo. Cada una
tiene su razón escrita en el código.

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| LiveKit Cloud (WebRTC) | Agora, Mux, HLS propio | Sub-segundo real medido. Y el SDK de Flutter es oficial |
| Monolito modular | Microservicios | Equipo chico. Microservicios construyen latencia, no escala |
| PostgreSQL única fuente de verdad del stock | Redis | Redis no decide stock. Jamás |
| SQL crudo en caminos concurrentes | Prisma en todo | El descuento de stock tiene que ser atómico de verdad |
| Los webhooks nunca son fuente de verdad | Confiar en el cuerpo | Un aviso firmado sigue siendo un aviso: el estado se consulta |
| Idempotencia por índice UNIQUE | Chequeo en código | La carrera la resuelve el motor, no un `if` |
| Flutter + Riverpod | React Native | Un solo render engine, video predecible |
| Admin Lite antes del lanzamiento | Diferirlo | Sin panel, el primer problema se atiende con `psql` |
| Tema oscuro sin opción clara | Modo claro | La app es video a pantalla completa |

### Las tres reglas de seguridad del catálogo

**1 · La pertenencia va en el WHERE, nunca en un `if`.**
No hay `findUnique(id)` seguido de comprobar el dueño: se busca
`findFirst({ where: { id, store: { sellerId } } })`. Un IDOR deja de ser un
chequeo que alguien puede olvidar y pasa a ser imposible de escribir mal.

**2 · Un recurso ajeno responde 404, no 403.**
Un 403 confirma que el id existe y permite enumerar el catálogo de la
competencia probando ids.

**3 · Ningún endpoint acepta ids de pertenencia del cliente.**
`sellerId` y `storeId` salen del token, siempre.

### Cómo se hace imposible la sobreventa

Lo que **no** se hace en ningún camino:

```
1. leer stock  →  2. decidir en TypeScript  →  3. escribir
```

Entre el paso 1 y el 3 hay una ventana. Durante un vivo son microsegundos y
pasan cien peticiones por ella: las cien leen "queda 1" y las cien escriben.

No se arregla achicando la ventana. **Se elimina**, poniendo la condición
dentro del UPDATE:

```sql
UPDATE inventory
   SET reserved = reserved + $qty
 WHERE id = $id AND (on_hand - reserved) >= $qty
```

PostgreSQL serializa las escrituras sobre la fila. Cero filas afectadas **es**
la respuesta: `OUT_OF_STOCK`.

Tres capas de defensa: el UPDATE condicional decide; `CHECK (reserved <=
on_hand)` hace que un bug futuro explote en vez de vender dos veces; un índice
único parcial impide dos reservas activas de la misma persona.

**Verificado, no supuesto:** se reemplazó a propósito ese UPDATE por el patrón
ingenuo y el test de los 100 compradores pasó de 2 reservas a **45**.

### Reservas

- TTL de 5 minutos, calculado por el backend. La app nunca decide vencimiento.
- `Idempotency-Key` obligatoria. El caso real: la petición llega, el backend
  aparta la unidad, la respuesta se pierde y la app reintenta. Sin clave, el
  reintento aparta una segunda unidad — y el síntoma, stock que se evapora en
  zonas con mala señal, es casi imposible de diagnosticar después.
- **Se puede vender con Redis caído.** `expires_at` vive en PostgreSQL; el job
  diferido de BullMQ sólo da precisión y el reconciliador da la garantía. La
  regla: si perder Redis puede impedir una venta, el diseño está mal.
- Consumir descuenta de `onHand` **y** de `reserved`: restar sólo de `reserved`
  devolvería la unidad vendida al mostrador.
- Al comprador se le muestra `IN_STOCK` / `LOW_STOCK` / `OUT_OF_STOCK`. El
  número exacto sale sólo con `LOW_STOCK` ("Últimas 3"): publicar "quedan 847"
  le regala a la competencia el ritmo de ventas del vendedor.

---

## Reglas que no se negocian

- Nunca exponer API keys ni secretos. Nada de secretos de LiveKit en Flutter.
- No almacenar datos sensibles de tarjeta. Tokenización del proveedor.
- WhatsApp sólo por Business Platform / Cloud API. Nada de automatizaciones no
  oficiales.
- Sin Apple Critical Alerts. Sin Time Sensitive para notificaciones comerciales
  de LIVE salvo justificación de política clara.
- Nunca guardar binarios dentro de PostgreSQL.
- Nunca confiar en el `filename` que manda el usuario. El tipo de archivo se
  detecta por *magic bytes*, no por `content-type`.
- Si una decisión técnica es mala, se dice y se propone una mejor. No se acepta
  algo incorrecto sólo porque lo propuso alguien con autoridad.

---

## Los 12 defectos que encontró EJECUTAR, no leer

Ninguno lo hubiera encontrado revisando código. Varios habrían llegado a
producción.

| # | Defecto | Consecuencia |
|---|---|---|
| 1 | `Boolean("false")` es `true` en JS | El interruptor que apagaba los módulos de spike **no apagaba nada** |
| 2 | Clave de idempotencia por orden | **Una orden rechazada no se podía pagar nunca más, con ninguna tarjeta** |
| 3 | Orden trabada sin pago | `PROCESSING` eterno |
| 4 | El corte de video se medía con eventos de track | Error de **12×**, siempre hacia abajo |
| 5 | `this` no era el CardForm | El formulario de pago se colgaba en silencio |
| 6 | Errores de MP sin traducir | El comprador leía `invalid card_number_validation` |
| 7 | El rate limit caía a por-IP en todos los endpoints con sesión | Detrás del CGNAT de una operadora: **3 tiendas nuevas por hora para un bloque entero de abonados** |
| 8 | Los tests no registraban `@fastify/multipart` | Toda la subida de imágenes daba 415 en test. **No había ni un test de imágenes** |
| 9 | Una reserva vencida sin barrer bloqueaba la siguiente | El comprador recibía una reserva muerta con el contador en 00:00 |
| 10 | BullMQ 6 rechaza `:` en nombres de cola | El proceso no arrancaba |
| 11 | `tsx` no emite metadata de decoradores | 500 desde adentro de un guard, sin pista de la causa |
| 12 | Dio manda `content-type: application/json` sin cuerpo | **Los cuatro DELETE de la app rotos a la vez**, con la suite entera en verde |
| 13 | Los listados mandaban sólo `url` en las imágenes; el modelo de Flutter exigía el objeto completo | `type 'Null' is not a subtype of type 'String'`: **la lista de productos del vendedor se caía entera**, y sólo cuando un producto tenía foto |

**El patrón:** el error nunca estuvo en el camino feliz. Estuvo en qué pasa
cuando algo se corta a la mitad, cuando el aviso llega tarde o cuando llega dos
veces.

**La lección del 8 y el 12** (el mismo error con dos disfraces): los tests
armaban la aplicación por su cuenta sin ejecutar `main.ts`, así que probaban un
servidor que no era el de producción. Se resolvió moviendo toda la
configuración a un archivo único que usan `main.ts` y los tests.

**La lección del 12 y el 13:** los dos defectos viven **en la costura** entre
backend y app. Las dos mitades estaban bien probadas por separado y nadie
probaba el medio. Ahora hay tests de contrato en los dos lados: el backend
afirma la forma de lo que devuelve, y la app tiene sus primeros 17 tests
parseando respuestas reales del servidor —incluido el caso degradado, porque
un campo que falta tiene que degradar lo que se ve, nunca tumbar la pantalla.

---

## Deuda técnica abierta

**Bloqueantes antes de publicar:**

1. ~~`applicationId`~~ **RESUELTO el 15/08/2026: es `com.vendox.app`.** Queda
   pendiente registrar el cliente de OAuth de Android para ese paquete. Ver
   [MIGRACION-PACKAGE.md](MIGRACION-PACKAGE.md).
2. **El APK de release está firmado con la clave de debug.** Hay que generar
   una propia y guardarla: si se pierde, no se puede volver a publicar una
   actualización jamás.
3. **Admin Lite.** Sin panel no hay forma de ver un pago ni suspender un
   vendedor.

**Importante, no bloqueante:**

4. Watchdog de cuadros en el cliente (hallazgo principal de 0A).
5. Time-to-first-frame de 4 s.
6. `R2StorageProvider` es un esqueleto: hoy las imágenes las sirve el proceso
   de la API. La interfaz ya está separada, el cambio es una clase.
7. Sin miniaturas del lado del servidor: el feed descarga la imagen completa
   para mostrarla en 46 px.
8. Sin CI/CD ni despliegue. Todo corre local con un túnel de Cloudflare.
9. Sin notificaciones push. FCM no está integrado.
10. **Falta medir capacidad en hardware de staging.** La curva local:
    p95 de 21 ms con 5 reservas en vuelo, 76 ms con 10, 203 ms con 20. El
    trabajo real son ~18 ms; el resto es cola de un portátil con Docker
    Desktop. **Cuánto aguanta de verdad no se sabe.**
11. La reserva es de una sola variante (la arquitectura no lo impide para
    varias, y el orden de bloqueo para evitar deadlocks ya está escrito).
12. "Seguir" y "me gusta" son estado local de la pantalla, sin tabla detrás.
13. El conciliador de pagos tiene que ser un trabajo periódico, no un botón.
14. Migrar a la API de Orders de Mercado Pago (está marcada como recomendada).
15. R5–R8 de resiliencia de video sin ejecutar.

---

## Lo que necesitamos que decidas

### 1 · ¿Confirmás que lo siguiente es Orders?

Es lo único que falta para cobrar de verdad. `InventoryService.consume()` ya
está implementado y probado esperándolo.

### 2 · El caso de carrera que Orders tiene que resolver

Un pago se acredita **en el mismo instante** en que la reserva vence.

Hoy `EXPIRED → CONSUMED` está prohibido y `consume()` no descuenta nada. Las
opciones son volver a reservar (y fallar si otro se llevó la unidad) o devolver
la plata. **No se puede decidir desde inventario porque es una decisión de
dinero.** Necesitamos tu criterio.

### 3 · Modelo de comisión

No está definido en ningún lado. Orders lo va a necesitar: porcentaje, fijo,
mixto, quién paga la comisión de Mercado Pago, cuándo se liquida al vendedor.

### 4 · Time-to-first-frame de 4 segundos

¿Se investiga antes de seguir, o se mitiga con una miniatura y se posterga?

### 5 · Moderación

Un vendedor nace ACTIVO y la moderación es reactiva: se suspende ante una
denuncia. Falta definir quién revisa un vivo denunciado y con qué herramientas.
Es una dependencia directa de Admin Lite.

### 6 · ¿Cuándo desplegamos a staging?

Sin eso no podemos medir capacidad real ni probar con gente fuera de la red
local. Implica Fly.io, Neon y Upstash.

---

## Riesgos no técnicos, sin respuesta

- **Mercado de dos lados vacío.** Sin vendedores no hay compradores. Esto no se
  responde midiendo: se responde lanzando.
- **Costo de video por espectador.** Se vigila desde el primer día.

---

## Dónde está el detalle

- `docs/ESTADO-DEL-PROYECTO.md` — el documento técnico completo (757 líneas):
  esquemas, endpoints, SQL exacto, máquinas de estado.
- `docs/sprint-0/RESULTS.md` — la evidencia medida de las dos decisiones ya
  tomadas, con los números crudos.
- `docs/sprint-0/RUNBOOK-mercadopago.md` — cómo reproducir las pruebas de pago.
