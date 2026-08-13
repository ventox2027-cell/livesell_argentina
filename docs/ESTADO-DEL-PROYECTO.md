# VendoX · Estado técnico del proyecto

**Documento de traspaso.** Qué está construido, cómo, por qué se decidió así, y
qué está abierto.

**Fecha:** 13/08/2026
**Repositorio:** `github.com/ventox2027-cell/livesell_argentina` (privado)

---

## 0 · Qué es

Aplicación móvil de venta en vivo para Argentina. Feed vertical de video,
transmisiones en directo y compra integrada sin salir del video.

Tres principios que atraviesan todas las decisiones:

| | |
|---|---|
| **Argentina primero** | Infraestructura en São Paulo, Mercado Pago, WhatsApp, teléfonos con `+549`, direcciones con calle/altura/piso separados |
| **Lo simple ahora, escalable después** | Monolito modular, no microservicios. Un equipo chico con microservicios construye latencia y complejidad, no escala |
| **El backend es la fuente de verdad** | Ninguna decisión de dinero se toma en un dispositivo que el usuario controla |

---

## 1 · Estado por módulo

| Módulo | Estado | Notas |
|---|---|---|
| **Sprint 0A** · LiveKit | ✅ GO | Medido en campo con dos teléfonos reales |
| **Sprint 0B** · Mercado Pago | ✅ GO | Compra real acreditada, cero datos de tarjeta |
| **Auth** | ✅ funcionando | Login con Google real verificado end-to-end |
| App móvil (base) | ✅ instalable | Diseño, navegación, feed, perfil |
| **Sellers / Stores / Products / Variantes / Imágenes** | ✅ funcionando | Backend + Flutter. Catálogo real de punta a punta |
| **Inventory / Reservation** | ✅ funcionando | Sobreventa imposible por construcción. 1000 compradores → 5 reservas exactas |
| Feed (descubrimiento) | 🟡 parcial | Productos y stock reales. Falta el video: llega con Live Sessions |
| Orders / Payments (producción) | ⛔ no empezado | **Siguiente.** El spike ya validó el camino e `InventoryService.consume()` está listo esperándolo |
| Live Sessions / Realtime | ⛔ no empezado | |
| Search / Notifications | ⛔ no empezado | |
| Admin Lite | ⛔ no empezado | **Requisito previo al lanzamiento** |

---

## 2 · Stack

### Backend
```
Node 22 · TypeScript · NestJS 11 + Fastify
PostgreSQL 16 (Prisma) · Redis 7 · Zod
Vitest · ESLint + Prettier
```

**Monolito modular.** Cada módulo en `src/modules/<nombre>/` con su controlador,
servicio y DTOs. Sin dependencias cruzadas entre módulos salvo por interfaces
públicas.

**Prisma para CRUD, SQL crudo para los caminos con concurrencia.** El descuento
de stock necesita un `UPDATE ... WHERE (on_hand - reserved) >= qty` atómico, y
eso no se expresa bien con un ORM.

### Móvil
```
Flutter 3 · Dart · Riverpod
livekit_client · webview_flutter · google_sign_in
flutter_secure_storage · dio
```

### Infraestructura (planificada, aún no desplegada)
```
Fly.io región gru (São Paulo) · Neon PostgreSQL · Upstash Redis
Cloudflare CDN/R2 · LiveKit Cloud · Mercado Pago · FCM
```

Backend, base y Redis en la misma región: separarlos agrega un ida y vuelta a
cada consulta.

---

## 3 · Sprint 0 — los dos riesgos que podían matar el proyecto

El Sprint 0 existió para responder dos preguntas **midiendo**, antes de
construir producto sobre supuestos.

### R2 · ¿La latencia alcanza desde redes argentinas?

**Respuesta: sí.** ✅

| | |
|---|---|
| Glass-to-glass p95 | **577 ms** (objetivo 800, máximo tolerable 1500) |
| Mediciones | 10 manuales, fibra y 4G Personal |
| Pérdida de paquetes | 0,0 % en 426 muestras |
| Adaptive bitrate | Confirmado: 320/640/1920 en una misma sesión |

**Método:** el visor superpone su propio reloj —sincronizado contra el servidor
con el algoritmo de Cristian— sobre el video que muestra el reloj de la
notebook. Una sola captura de pantalla contiene los dos relojes. Eso elimina el
*rolling shutter* de fotografiar dos pantallas.

**Hallazgo contraintuitivo:** 4G midió más rápido que WiFi (344 vs 480 ms).
Explicación en los datos: en 4G el ABR bajó a 417 kbps y 320px. Menos píxeles
se codifican y decodifican más rápido. La latencia bajó porque la calidad bajó
— que es el compromiso correcto para un vivo de venta.

#### 🚨 El hallazgo principal, y no es de latencia

**El SFU tarda entre 13,7 y 20,1 segundos en avisar que el emisor se cayó.**

```
22:14:26  el emisor pierde la red — LA IMAGEN SE CONGELA
22:14:40  recién acá llega TRACK_UNSUBSCRIBED
22:14:46  vuelven a llegar cuadros
```

Es el *participant timeout* de LiveKit. Durante esa ventana la señalización
dice que todo está bien mientras el espectador mira una foto.

**Consecuencias de producto (son requisitos, no deuda):**

1. La UI de reconexión **no puede** basarse en eventos de track. Llegaría 15
   segundos tarde, cuando la persona ya se fue.
2. Hace falta un **watchdog de cuadros en el cliente**: si `framesDecoded` no
   avanza durante ~2 s, avisar.
3. **La pantalla no debe ponerse negra.** Último cuadro congelado + chat vivo +
   aviso explícito. Un corte explicado se tolera; uno mudo se lee como "la app
   se rompió".

Esto además invalidó nuestra propia instrumentación: medíamos el corte con los
eventos de track y reportaba **1601 ms para una interrupción real de 20 s**. Un
error de 12×, siempre hacia abajo. La medición correcta usa los cuadros
decodificados (`backend/src/modules/spike/freeze.ts`).

#### Resiliencia medida

| Prueba | Corte de red | Imagen congelada |
|---|---|---|
| WiFi → 4G | 0 s | 6,0 s |
| 4G → WiFi | 0 s | 6,0 s |
| Avión corto | 13 s | 20,0 s |
| Avión largo | 42 s | 49,0 s |

**Costo fijo de recuperación: ~7 segundos** por encima del corte real.
Las cuatro se recuperaron solas, sin errores.

#### Deuda anotada de 0A
- Time-to-first-frame de **4020 ms** (objetivo ≤1500). Problema de UX al entrar
  a un live. Mitigación: miniatura mientras carga.
- 6 s de congelamiento al cambiar de red aun sin corte real.
- Sólo una operadora medida (Personal). Con la calibración hecha (+29 ms de
  sesgo), medir Movistar/Claro ya no requiere fotos.

### R1 · ¿Podemos cobrar sin arrastrar el alcance PCI completo?

**Respuesta: sí, alcance SAQ-A.** ✅

**El camino elegido:** CardForm de Mercado Pago en un WebView, con
`iframe: true`. Los campos del número y del código de seguridad son **iframes
servidos por Mercado Pago**. El PAN no pasa por nuestro DOM, ni por Dart, ni
por nuestro backend.

Si pasara por campos nuestros, el sistema entraría en **SAQ-D**: auditoría
anual, escaneos trimestrales, segmentación de red. Para un equipo de esta
escala eso no es caro, es inviable.

**Verificado sobre datos reales tras una compra con `4509 9535 6623 3704`:**

| Verificación | Resultado |
|---|---|
| Filas con `cardholder`, `first_six`, `security_code` o `token` | **0** |
| El BIN `450995` en pagos, auditoría, webhooks o logs | **0** |
| Lo que sí se guarda | `card_last_four = 3704`, `brand = visa` |

**Compra real:** de tocar *Pagar* a `ORDER = PAID` en **1,8 segundos**.

#### Hallazgo: la guarda de monotonía actuó sola

```
07:46:10.502  API      payment.attempt          PENDING_PAYMENT → PROCESSING
07:46:12.307  API      payment.status_changed   PROCESSING      → PAID
07:46:12.988  WEBHOOK  payment.no_change        PAID            → PAID
```

El webhook llegó **681 ms después** de que la respuesta directa ya hubiera
acreditado. El sistema reconoció que no había nada que cambiar. Sin esa guarda,
dos caminos de confirmación habrían acreditado el mismo pago dos veces — en la
primera compra real, sin provocarlo.

#### Robustez verificada contra Mercado Pago real

| | |
|---|---|
| Webhook duplicado → una acreditación | ✅ |
| Firma inválida → `HASH_MISMATCH` | ✅ |
| Reenvío de 20 min → `STALE_TIMESTAMP` | ✅ |
| Sin firma → `MISSING_SIGNATURE` | ✅ |
| Webhook perdido → conciliador lo resuelve | ✅ |
| Corte de red → `PROCESSING`, **nunca** `FAILED` | ✅ |
| Rechazo → se puede reintentar con otra tarjeta | ✅ |

#### ⛔ Bloqueado: la segunda compra en dos clics

Investigado a fondo. Dos de tres eslabones funcionan:

| Paso | |
|---|---|
| Crear cliente en Mercado Pago | ✅ |
| Guardar la tarjeta | ✅ HTTP 201, devuelve `card_id` |
| Tokenizar desde la tarjeta guardada | ✅ y **sin pedir CVV** |
| **Cobrar con ese token** | ❌ `{"cause":[],"error":null,"message":"internal_error","status":500}` |

Cuatro formas del bloque `payer` probadas, las cuatro con el mismo 500 sin
causa. **Es un fallo del lado de Mercado Pago**, no un payload mal armado.

Pista posible: al guardar la tarjeta, Mercado Pago descarta el número de
documento (`identification.number` queda `null`) aunque el token se creó con él.

Problema de diseño adicional sin resolver: guardar consume un token y cobrar
consume otro, pero una pasada por el formulario produce **uno solo**. Con
`iframe: true` los campos no son nuestros y no se pueden releer.

**Requiere:** consulta a soporte de Mercado Pago, o probar con una aplicación
habilitada para producción.

---

## 4 · Auth (implementado)

### Decisiones estructurales

**El guard es GLOBAL y todo está cerrado por defecto.** Abrir una ruta exige
escribir `@Public()`. La alternativa —proteger endpoint por endpoint— falla
siempre igual: alguien agrega una ruta, se olvida del decorador, y queda
abierta. El olvido no se ve al revisar porque lo que falta es una línea que no
está.

**Los refresh tokens NO son JWT.** Son secretos opacos de 256 bits de los que
sólo se guarda el SHA-256. Un JWT de refresco no se puede revocar sin lista
negra, y toda la seguridad depende de poder cortar una sesión desde el
servidor. El precio —una consulta por refresco, cada 15 min por dispositivo—
es barato.

**Rotación con detección de reuso.** Cada refresco quema el anterior. Si uno ya
quemado reaparece, hay dos copias circulando; como no se puede distinguir al
dueño del ladrón, **se revoca la familia entera**. Molesto para el legítimo,
mucho menos molesto que un desconocido comprando con su cuenta.

**El rol se lee de la BASE en cada petición, no del token.** Cuesta una lectura
por índice primario. Compra que suspender a un estafador tenga efecto ahora y
no cuando venza su access token.

**Identidades en tabla propia** (desviación del esquema de referencia). Con un
solo par `authProvider`/`providerSub` en `User`, alguien que entró con Google y
un día toca "Continuar con Apple" o termina con una cuenta duplicada —historial
partido en dos— o no puede entrar.

**Teléfono opcional al registrarse** (segunda desviación). El registro social no
entrega teléfono, y exigirlo rompe el onboarding rápido. Se pide antes de
COMPRAR, no antes de mirar.

### El detalle de Google Sign-In

En Android hay que pasar `serverClientId` con el ID del cliente **WEB**, no el
de Android. Eso hace que el token de identidad tenga la audiencia que el
backend verifica. Sin eso, o no llega token, o llega uno que se rechaza — y el
error de Google no distingue entre las dos cosas.

El cliente de Android igual hace falta: valida paquete + huella SHA-1.

### Endpoints

```
GET    /auth/config          público · client IDs y flags
POST   /auth/google          público · límite 10/min
POST   /auth/apple           público · misma cuota que Google
POST   /auth/dev             público · sólo con AUTH_DEV_LOGIN_ENABLED
POST   /auth/refresh         público · límite 30/min
POST   /auth/logout          público
POST   /auth/logout-all      autenticado
GET    /auth/sessions        autenticado
GET    /auth/me              autenticado
PATCH  /auth/me              autenticado
PATCH  /auth/push-token      autenticado
DELETE /auth/me              autenticado · borrado lógico + anonimización
```

Google y Apple **comparten cuota**: separarlas le daría a un atacante el doble
de intentos alternando.

---

## 5 · Aplicación móvil

### Sistema de diseño

**Tema oscuro, y no como opción.** La app es video a pantalla completa. Un fondo
claro obliga al ojo a saltar entre dos niveles de brillo, cansa en sesiones
largas —una transmisión dura media hora— y le roba contraste a lo que importa.

Un solo acento fuerte (`#FF3B5C`), reservado para la acción que genera plata. El
rojo de "EN VIVO" es **distinto** a propósito: un indicador de estado no puede
parecer un botón.

### Cliente HTTP: el problema de la estampida

Al abrir la app se disparan varias peticiones que reciben 401 a la vez. Si cada
una refresca por su cuenta, la primera rota el token y las demás llegan con uno
ya quemado → el backend lo lee como robo → **revoca la familia** → la app cierra
sesión sola cada vez que se abre, de forma intermitente.

Se resuelve con un único refresco compartido.

**Un fallo de RED no borra los tokens.** Si lo hiciera, un subte sin señal
desloguearía a la persona justo cuando menos ganas tiene de volver a entrar.

### Pantallas

| | Estado |
|---|---|
| Bienvenida | ✅ Google real + modo prueba + configurar servidor · logo VendoX |
| Feed vertical | ✅ **productos reales** del catálogo. Falta el video |
| Panel del vendedor | ✅ crear tienda, listar productos, ajustes |
| Editor de producto | ✅ nombre, precio, fotos, variantes, publicar |
| Buscar / En vivo / Pedidos | 📋 pantallas que explican qué va a haber |
| Perfil | ✅ funcional contra el backend |

El feed se construyó **antes** que el video a propósito: la parte difícil de un
feed de venta no es reproducir, es que en dos segundos se entienda qué se
ofrece y cuánto sale.

**El feed vacío no se rellena con ejemplos.** Un catálogo falso hace que el
vendedor crea que la app ya tiene contenido y no publique el suyo — que hoy es
lo único que puede llenarlo. En su lugar hay un estado vacío que invita a crear
la tienda.

---

## 5b · Bloque comercial

```
Seller ──1:N── Store ──1:N── Product ──1:N── ProductVariant
                                 │                  │
                                 ├── ProductOption ─┤ (vía ProductVariantOption)
                                 │      └── ProductOptionValue
                                 └── ProductImage
```

### Las cuatro reglas que ordenan el módulo

**1 · Todo producto tiene al menos una variante.** Uno "sin variantes" recibe una
`DEFAULT` automática que el vendedor nunca ve. Sin esa regla habría dos
arquitecturas de inventario conviviendo, y cada consulta de stock tendría que
preguntar antes cuál aplica. Con la variante por defecto, Inventory apunta
siempre a `productVariantId` y la pregunta no existe.

**2 · La pertenencia va en el WHERE, nunca en un `if`.** No hay
`findUnique(id)` seguido de comprobar el dueño: se busca
`findFirst({ where: { id, store: { sellerId } } })`. Un IDOR deja de ser un
chequeo que alguien puede olvidar y pasa a ser imposible de escribir mal.

**3 · Un recurso ajeno responde 404, no 403.** Un 403 confirma que el id existe
y permite enumerar catálogos ajenos probando ids.

**4 · Las combinaciones de variantes las controla la base.** `optionsKey` es la
lista de ids de valores ordenada y unida por `|`, con
`@@unique([productId, optionsKey])`. Dos peticiones simultáneas no pueden crear
la misma combinación aunque el código las deje pasar.

### Endpoints

```
POST   /sellers                                  crea perfil + tienda (transacción)
GET    /sellers/me
PATCH  /sellers/me
GET    /sellers/by-slug/:slug                    público

GET    /stores/me
PATCH  /stores/:id
PATCH  /stores/:id/slug                          aparte: rompe enlaces compartidos
GET    /stores/by-slug/:slug                     público
GET    /stores/by-slug/:slug/products            público · vidriera

GET    /discover/products                        público · el feed

GET    /products/mine
POST   /products
GET    /products/:id
PATCH  /products/:id
DELETE /products/:id                             borrado lógico

POST   /products/:id/variants
PATCH  /products/:id/variants/:variantId
DELETE /products/:id/variants/:variantId         nunca la última

POST   /products/:id/images                      multipart · tipo por magic bytes
DELETE /products/:id/images/:imageId
PATCH  /products/:id/images/reorder
```

Ningún endpoint acepta `sellerId` ni `storeId` del cliente. Salen del token.

---

## 5c · Inventario y reservas

### El principio

**PostgreSQL es la única autoridad sobre el stock.** Redis no decide stock.
Flutter no decide stock. LiveKit no decide stock.

> **Es mejor rechazar una venta que vender stock que no existe.**

### Lo que NO se hace, en ningún camino

```ts
const inv = await prisma.inventory.findUnique(...)   // 1. leer
if (inv.onHand - inv.reserved >= qty) {              // 2. decidir
  await prisma.inventory.update(...)                 // 3. escribir
}
```

Entre el paso 1 y el 3 hay una ventana. Durante un vivo son microsegundos y
pasan cien peticiones por ella: las cien leen "queda 1", las cien deciden que
sí, y las cien escriben.

**No se arregla achicando la ventana. Se arregla eliminándola:**

```sql
UPDATE inventory
   SET reserved = reserved + $qty
 WHERE id = $id AND (on_hand - reserved) >= $qty
RETURNING on_hand, reserved
```

La condición y la escritura son la misma operación. PostgreSQL serializa las
escrituras sobre la fila: la tercera petición evalúa el WHERE contra el valor
que dejaron las dos primeras. Cero filas afectadas **es** la respuesta:
`OUT_OF_STOCK`. Sin reintentos, sin bloqueo optimista, sin `SELECT FOR UPDATE`.

**Verificado, no supuesto.** Se reemplazó a propósito ese UPDATE por el patrón
ingenuo y el test de los 100 compradores pasó de 2 reservas a **45**. El test
detecta la sobreventa.

### Tres capas de defensa

| | Qué impide |
|---|---|
| 1 · El UPDATE condicional | Que dos peticiones aparten la misma unidad |
| 2 · `CHECK (reserved <= on_hand)` | Que un bug futuro sobrevenda: la transacción explota en vez de vender |
| 3 · Índice único parcial | Dos reservas activas de la misma persona y variante |

### Reglas del modelo

**El inventario cuelga de la variante, nunca del producto.** Todo producto
tiene al menos una variante —los simples reciben una `DEFAULT`— así que no hay
dos lógicas de stock conviviendo.

**`available` no se guarda: se calcula.** Persistirlo obligaría a mantener tres
columnas sincronizadas, y la tercera se desincronizaría el día que alguien
escriba un UPDATE que se la olvide.

**Sin columna `version`.** El bloqueo optimista resuelve lo mismo que el UPDATE
condicional pero peor: obliga a reintentar en el código.

**Consumir descuenta de las DOS columnas.**

```
antes:   onHand 10 · reserved 2 · disponibles 8
consume 1
después: onHand  9 · reserved 1 · disponibles 8
```

Restar sólo de `reserved` devolvería la unidad vendida al mostrador.

### Máquina de estados

```
        ┌──────────────┐
        │    ACTIVE    │  ← el único estado que ocupa `reserved`
        └───┬───┬───┬──┘
   consume ─┘   │   └─ cancela el comprador
                │
      CONSUMED  EXPIRED  CANCELLED
```

Los tres finales son definitivos. **La liberación va pegada a la transición, y
la transición ocurre una sola vez** — por eso liberar stock dos veces es
imposible sin necesidad de un `if`:

```sql
UPDATE inventory_reservations
   SET status = 'EXPIRED', expired_at = now()
 WHERE id = $1 AND status = 'ACTIVE' AND expires_at <= now()
RETURNING quantity, inventory_id
```

Dos workers simultáneos: uno afecta una fila, el otro cero.

### TTL: dos mecanismos, uno solo obligatorio

| | Da | Si falla |
|---|---|---|
| Job diferido de BullMQ | Precisión al segundo | El reconciliador lo cubre |
| Reconciliador cada 30 s | La garantía | Nada más lo cubre |

**¿Se puede vender con Redis caído? Sí.** `expires_at` ya está en PostgreSQL;
el job sólo sirve para que alguien mire en el momento exacto. `programar()`
**nunca lanza**: se llama después de que la reserva ya está cometida, y un
fallo ahí no puede deshacer una venta que ya ocurrió.

La regla, escrita para que no se erosione: **si perder Redis puede impedir una
venta, el diseño está mal.**

Toda la suite de inventario corre con la cola apagada. Que pase entera es la
demostración.

### Idempotencia

`Idempotency-Key` es **obligatoria**. El caso que la justifica es el normal en
una red móvil argentina: la petición llega, el backend aparta la unidad, la
respuesta se pierde, la app reintenta. Sin clave, el reintento aparta una
segunda unidad — y el síntoma, stock que se evapora en zonas con mala señal, es
casi imposible de diagnosticar después.

**Única por `userId + idempotencyKey`, no globalmente.** La clave la elige el
cliente: con unicidad global, una colisión de UUID entre dos personas le
devolvería a una la reserva de la otra.

Se guarda además una huella del cuerpo. Misma clave con otro pedido → `409`, en
vez de devolver en silencio algo distinto de lo que se pidió.

### Una sola reserva activa por persona y variante

Tocar "Comprar" de nuevo **reutiliza** la reserva existente. Actualizar la
cantidad obligaría a liberar y volver a tomar, y esa secuencia tiene un instante
en el que el stock está suelto y otro comprador se lo lleva.

### Endpoints

```
POST   /inventory/reservations              Idempotency-Key obligatoria
GET    /inventory/reservations/mine
GET    /inventory/reservations/:id          ajena → 404
DELETE /inventory/reservations/:id          cancelar

GET    /variants/:variantId/availability    público · etiqueta, no números

GET    /products/:productId/inventory                          vendedor
PATCH  /products/:id/variants/:variantId/inventory             onHand o adjust
```

**Ningún endpoint permite escribir `reserved`.** Poder ponerlo en cero
permitiría "liberar" unidades que otro ya tiene apartadas.

**El vendedor no puede bajar `onHand` por debajo de `reserved`.** Con 10 y 8
apartadas, poner 5 dejaría a tres personas sin lo que ya creían tener. Si quiere
dejar de vender, la herramienta es pausar la variante.

### Lo que se le muestra al comprador

`IN_STOCK` · `LOW_STOCK` · `OUT_OF_STOCK`. El número exacto sale **sólo** con
`LOW_STOCK`: "Últimas 3" ayuda a decidir y no revela volumen; publicar "quedan
847" le regala a la competencia el ritmo de ventas del vendedor.

---

## 6 · Los defectos que encontró probar en campo

Ninguno lo hubiera encontrado un test. **Cinco habrían llegado a producción.**

| # | Defecto | Consecuencia |
|---|---|---|
| 1 | `Boolean("false")` es `true` en JS | El interruptor que apagaba los módulos de spike **no apagaba nada**. Exponen endpoints sin autenticación |
| 2 | Clave de idempotencia por orden | **Una orden rechazada no se podía pagar nunca más, con ninguna tarjeta** |
| 3 | Orden trabada sin pago | `PROCESSING` eterno, imposible reintentar |
| 4 | El corte de video se medía con eventos de track | Error de **12×**, siempre hacia abajo |
| 5 | `this` no era el CardForm | El formulario de pago se colgaba en silencio |
| 6 | Errores de MP sin traducir | El comprador leía `invalid card_number_validation` |
| 7 | El límite de peticiones caía a por-IP en **todos** los endpoints con sesión | `RateLimitGuard` corre antes que `AuthGuard`, así que `req.user` todavía no existe. Detrás del CGNAT de una operadora, **3 tiendas nuevas por hora para un bloque entero de abonados** |
| 8 | El arranque de los tests no registraba `@fastify/multipart` | Los tests corrían contra un servidor distinto del real. Toda la subida de imágenes devolvía 415 en test y nadie lo notaba: **no había ni un test de imágenes** |
| 9 | Una reserva vencida que el barrido todavía no tocó bloqueaba la siguiente | El índice único parcial la ve ACTIVE y rechaza la nueva. El comprador recibía de vuelta **una reserva muerta con el contador en 00:00** |
| 10 | BullMQ 6 rechaza `:` en nombres de cola | El proceso no arrancaba. Apareció al ejecutar, no al leer |
| 11 | `tsx` no emite metadata de decoradores | La inyección de dependencias entregaba `undefined` y el síntoma era un 500 desde adentro de un guard. El proyecto ya lo había resuelto para los tests con swc; el script de estrés lo volvió a pisar |

**El patrón:** el error nunca estuvo en el camino feliz. Estuvo en qué pasa
cuando algo se corta a la mitad, cuando el aviso llega tarde, o cuando llega dos
veces. Los defectos 2 y 3 son el mismo error de razonamiento con dos disfraces:
asumir que el camino feliz es el único que termina.

---

## 7 · Decisiones de arquitectura

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | LiveKit Cloud (WebRTC) | Agora, Mux, HLS propio | Sub-segundo real medido |
| 2 | **Sin umbral fijo** para pasar a LL-HLS | "3000 espectadores = LL-HLS" | Un número inventado no es una regla. Se activa con datos de costo y capacidad |
| 3 | Fly.io `gru` | us-east | Menor latencia hacia Argentina |
| 4 | Monolito modular | Microservicios | Equipo chico |
| 5 | PostgreSQL única fuente de verdad | Stock en Redis | Redis no decide stock. Jamás |
| 6 | SQL crudo en caminos concurrentes | Prisma en todo | El descuento de stock tiene que ser atómico de verdad |
| 7 | Los webhooks nunca son fuente de verdad | Confiar en el cuerpo | Un aviso firmado sigue siendo un aviso: el estado se consulta |
| 8 | Idempotencia por índice UNIQUE | Chequeo en código | La carrera la resuelve el motor, no un `if` |
| 9 | Flutter + Riverpod | React Native | Hot reload, un render engine, video predecible |
| 10 | Sin Critical Alerts ni Time Sensitive | Usarlas para captar atención | Política de Apple. Un rechazo cuesta semanas |
| 11 | **Admin Lite antes del lanzamiento** | Diferir el panel | Sin forma de ver un pago o suspender un vendedor, el primer problema se atiende con `psql` |

---

## 8 · Reglas que no se negocian

- **Ningún secreto en el repositorio.** Los `.env` viven en la máquina y en
  `fly secrets`.
- **Ningún dato de tarjeta en nuestros sistemas.** Ni base, ni logs, ni mensajes
  de error. Sólo los últimos cuatro dígitos.
- **Ninguna automatización no oficial de WhatsApp.** Sólo Business Platform.
- **Ninguna decisión de dinero en el cliente.**
- **Ningún módulo de spike encendido en producción.** La configuración lo
  impide y el proceso no arranca si se intenta.

---

## 9 · Métricas y objetivos

| Métrica | Objetivo | Máximo | Medido |
|---|---|---|---|
| Glass-to-glass | ≤ 800 ms | 1500 ms | **577 ms** ✅ |
| Tiempo hasta el primer cuadro | ≤ 1500 ms | 3000 ms | **4020 ms** ❌ |
| Reconexión de sala | ≤ 5 s | 10 s | **1,4 s** ✅ |
| Compra completa | — | — | **1,8 s** ✅ |
| Chat de extremo a extremo | ≤ 300 ms | 800 ms | sin medir |

**Tests:** 362 en backend (unitarios + integración contra PostgreSQL real).
Typecheck, lint y `flutter analyze` en verde.

---

## 10 · Qué está abierto

### Bloqueado por terceros
- **Compra en dos clics** — `internal_error` de Mercado Pago (§3).

### Requiere decisión de producto
- **¿Seguimos con el orden previsto?** Con el stock cerrado, lo siguiente sería
  **Orders**: es lo único que falta para cobrar de verdad, y
  `consumeReservation()` ya está listo esperándolo.
- **Time-to-first-frame de 4 s.** ¿Se investiga antes de seguir, o se mitiga con
  una miniatura y se posterga?
- **Modelo de comisión** — no está definido en ningún lado todavía.
- **Moderación** — quién revisa un vivo denunciado y con qué herramientas.

### Deuda técnica anotada
1. **Watchdog de cuadros en el cliente** (§3, hallazgo principal de 0A).
2. **Migrar a la API de Orders de Mercado Pago.** Está marcada como recomendada.
   Costo acotado a `mp.client.ts` y al parseo del webhook.
3. **El conciliador tiene que ser un trabajo periódico**, no un botón.
4. **Habilitación de Checkout API para producción** — falta confirmar qué pide
   Mercado Pago.
5. **`applicationId` es `ar.livesell.livesell_spike`.** Hay que cambiarlo antes
   de publicar; una vez en Play **no se puede cambiar nunca más**. Cambiarlo
   obliga a recrear el cliente OAuth de Android.
6. **El APK de release está firmado con la clave de debug.** Antes de publicar
   hay que generar una propia y guardarla: si se pierde, **no se puede volver a
   publicar una actualización jamás**.
7. **Sin CI/CD ni despliegue.** Todo corre local con un túnel de Cloudflare.
8. **Sin notificaciones push.** FCM no está integrado.
9. **R5–R8 de resiliencia sin ejecutar** (viewer cambiando de red, ascensor,
   segundo plano, 30 min continuos).

**Del bloque comercial:**

10. **`R2StorageProvider` es un esqueleto.** Hoy las imágenes las sirve el propio
    proceso de la API desde `storage/`, y sólo en desarrollo. Aceptable en local,
    no en producción: cada foto ocupa una conexión del servidor de aplicación en
    vez de salir por un CDN. La interfaz ya está separada, así que el cambio es
    una clase y una variable de entorno.
11. **Las imágenes se guardan tal cual llegan.** No se generan miniaturas ni se
    recomprime del lado del servidor. El teléfono reduce a 1600 px antes de
    subir, así que el problema no es urgente, pero el feed descarga la imagen
    completa para mostrarla en 46 px.
12. **La moderación de vendedores es reactiva y no tiene herramientas.** Un
    vendedor nace `ACTIVE`; suspenderlo hoy es un `UPDATE` a mano. Es una
    dependencia directa de Admin Lite.
13. **El feed ordena por fecha, nada más.** No es un algoritmo y no pretende
    serlo: con diez productos, cualquier ranking sería ruido. Cuando haya señal
    —vistas, compras, sesiones en vivo— se reemplaza en `listDiscover`.
14. **"Seguir" y "me gusta" son estado local de la pantalla.** No se persisten:
    los botones están para que el diseño se pueda evaluar completo, pero no hay
    tabla detrás todavía.
15. **Cambiar el slug de la tienda tiene endpoint pero no interfaz.** Se dejó
    aparte a propósito —rompe todos los enlaces ya compartidos— y merece una
    confirmación explícita que todavía no está dibujada.

**Del inventario:**

16. **Falta medir capacidad en hardware de staging.** La curva local es
    p95 = 21 ms con 5 reservas en vuelo, 76 ms con 10, 203 ms con 20 y 243 ms
    con 40. El trabajo real de una reserva son ~18 ms; el resto es cola. Se
    descartó que fuera el fsync de los commits (500 transacciones sueltas
    tardan 335 ms, o sea 0,67 ms cada una) y quitar un viaje a la base tampoco
    movió el p95, así que el límite es de capacidad del entorno —un portátil
    con Docker Desktop, Node y el corredor de tests en la misma CPU—. **Cuánto
    aguanta de verdad no se sabe hasta medirlo en Fly.io.**
17. **La reserva es de UNA variante.** La arquitectura no lo impide para varias
    —`ordenDeBloqueo()` ya define el orden de bloqueo que hay que respetar para
    no generar deadlocks— pero el endpoint todavía recibe una sola.
18. **La reserva NO congela precio.** Es deliberado: una reserva es de stock, no
    una orden disfrazada. La foto del precio la va a tomar `Order`.
19. **`EXPIRED → CONSUMED` está prohibido, y hay un caso real sin resolver:** un
    pago que se acredita en el mismo instante en que la reserva vence. Hoy
    `consume()` devuelve `changed: false` y no descuenta. Orders va a tener que
    decidir entre volver a reservar o devolver la plata; no se puede resolver
    desde inventario porque implica una decisión de dinero.
20. **El barrido procesa 200 reservas por vuelta.** Con volumen alto y el
    intervalo actual podría acumular atraso. El número está donde se cambia y el
    caso está lejos, pero conviene vigilarlo cuando haya tráfico.

### Riesgos no técnicos, sin respuesta
- **R3 · Mercado de dos lados vacío.** Sin vendedores no hay compradores. No se
  responde midiendo: se responde lanzando.
- **R4 · Costo de video por espectador.** Se vigila desde el primer día.

---

## 11 · Mapa del repositorio

```
blueprint/            15 documentos · especificación técnica completa
backend/
  src/config/         validación de entorno con Zod (mata el proceso si falla)
  src/modules/
    auth/             ✅ implementado
    commerce/         ✅ sellers, stores, products, variantes, imágenes
    inventory/        ✅ stock y reservas · sobreventa imposible por construcción
    livekit/          tokens y webhooks
    spike/            Sprint 0A · se borra al cerrar el sprint
    payments/         Sprint 0B · mp-signature, order-state y el saneado
                      sobreviven al spike
  src/shared/         errores, guards, observabilidad, Prisma, Redis
  prisma/schema.prisma
  test/               362 tests · test/stress/ prueba de 1000 compradores
mobile/
  lib/core/           design, auth, network, config
  lib/features/       auth, feed, seller, inventory, profile, search, lives, orders, spike
db/                   esquema completo de referencia (se incorpora por módulo)
docs/sprint-0/        RUNBOOKs y RESULTS con la evidencia medida
tools/                reloj glass-to-glass, servidor de APK
```

**Dónde mirar primero:** `docs/sprint-0/RESULTS.md` tiene la evidencia de las
dos decisiones que ya se tomaron, con los números.
