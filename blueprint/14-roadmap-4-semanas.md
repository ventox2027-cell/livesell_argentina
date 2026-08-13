# 14 — Roadmap técnico de 4 semanas

Cubre: **§32 Plan de PMV realmente funcional**

---

## 1. Supuestos y advertencia

| Supuesto | Valor |
|---|---|
| Equipo | 5 personas: 2 Flutter, 2 backend, 1 full-stack/infra |
| Sprint | 1 semana (5 días hábiles) |
| Diseño | Las pantallas críticas están diseñadas **antes** del Sprint 1 |
| Trabajo previo | Sprint 0 de 3 días, **no negociable** |
| "Hecho" | Desplegado en staging, probado en dispositivo real, con telemetría |

**Advertencia honesta.** Cuatro semanas para este alcance es agresivo. Es alcanzable **solo** si:

- (a) el Sprint 0 se completa de verdad, con las dos pruebas de concepto resueltas;
- (b) se usan servicios gestionados en vez de construir;
- (c) nadie toca la lista de "qué NO construimos" del documento [01](01-arquitectura-y-stack.md) §31;
- (d) hay vendedores reales probando desde el Sprint 2.

Si alguna falla, lo realista son **6 semanas**. Es mejor saberlo ahora que en la semana 4. En §5 está el orden de recorte, decidido en frío.

## 2. Sprint 0 — Fundaciones (3 días, antes de la semana 1)

**Ni una línea de código de producto hasta terminar esto.** Todo lo que se salte acá se paga con intereses en el Sprint 3.

### Los trámites de plazo largo

Si no arrancan el día 1, bloquean el lanzamiento aunque el código esté listo. Son la ruta crítica real del proyecto:

| Trámite | Plazo típico | Bloquea |
|---|---|---|
| **Cuenta de producción de Mercado Pago** | 3–10 días hábiles | Cobrar de verdad |
| Cuenta de Apple Developer | 1–7 días | Publicar en iOS |
| Cuenta de Google Play | 1–3 días | Publicar en Android |
| Alta en LiveKit Cloud + cuota | 1–2 días | Streaming en producción |

### Las dos pruebas de concepto que deciden el proyecto

> Son los riesgos **R1** y **R2** del [README](../README.md) §3. Si alguna falla, el blueprint cambia — y es mucho mejor que cambie el día 1 que en la semana 3.

**PoC 1 — Tokenización de Mercado Pago desde Flutter (día 1).**
Objetivo: obtener un `card_token` usable desde la app. Plan A es el CardForm de MP en un `WebView`. Criterio de aceptación: se cobra un pago de prueba en sandbox con una tarjeta guardada.
Si falla → plan B (REST directo) → plan C (Checkout Pro, degrada la UX).

**PoC 2 — LiveKit desde Argentina (día 2).**
Objetivo: medir latencia real cámara→pantalla desde **cuatro conexiones argentinas distintas** (Movistar, Personal, Claro, fibra). 20 muestras cada una. Criterio: **p95 < 800 ms**.
Si falla → reevaluar Cloudflare (PoP en Buenos Aires) asumiendo el costo de integrar WHIP/WHEP a mano.

### Día a día

| Día | Backend / Infra | Flutter |
|---|---|---|
| **D1** | Cuentas Fly/Neon/Upstash/Cloudflare. **Iniciar los 4 trámites.** Terraform base | Proyecto Flutter, go_router, Riverpod, tema base. **PoC 1: tokenización MP** |
| **D2** | GitHub Actions: lint → test → build → deploy a staging. `/health` desplegado. Prisma + migración inicial | **PoC 2: LiveKit + medición de latencia.** Firebase configurado, push de prueba en dispositivo físico |
| **D3** | `env.schema.ts`, Sentry, Grafana, `dependency-cruiser`, Testcontainers funcionando | Codemagic construyendo iOS. Generación de modelos desde OpenAPI. `FakeLiveProvider` |

### Criterio de salida

- [ ] `git push` a `main` despliega solo en staging.
- [ ] Una build se instala en un iPhone y un Android reales.
- [ ] Un push de prueba llega a ambos.
- [ ] **PoC 1 verde:** token de tarjeta obtenido desde Flutter.
- [ ] **PoC 2 verde:** p95 < 800 ms desde 4 conexiones argentinas.
- [ ] Los 4 trámites iniciados, con número de expediente.
- [ ] Test de integración con Testcontainers corriendo en CI.

**Si el D3 termina sin esto, se retrasa el Sprint 1.** Arrancar con las fundaciones a medias es la forma más eficaz de perder las 4 semanas.

---

## 3. Los cuatro sprints

### Sprint 1 — Identidad, video y feed

> **Objetivo:** un usuario se registra en 15 segundos, un vendedor transmite y el feed vertical funciona.
> Es el corazón del producto. Sin esto no hay nada.

| Área | Entregable |
|---|---|
| **Auth** | Google + Apple + OTP de teléfono. **5 campos, sin DNI ni dirección** |
| Permiso de push | Se pide **al seguir**, no al arrancar |
| Vendedores | Alta de tienda, perfil |
| **Emisión** | Cámara vertical, previsualización, iniciar/terminar |
| **Recepción** | Visor a pantalla completa con LiveKit + respaldo LL-HLS |
| **Feed vertical** | `PageView` infinito, pool de 3 reproductores, precarga |
| Backend | Módulos `auth`, `users`, `sellers`, `lives`. Webhooks de LiveKit |

| Día | Flutter | Backend |
|---|---|---|
| **L** | Google/Apple Sign-In, alta de teléfono con OTP | `auth` con OIDC + JWT rotativo, `users` |
| **M** | Pantalla de emisión: permisos, previsualización, controles | `lives`: crear sala en LiveKit, tokens de publicador y audiencia |
| **X** | Visor con `LiveProvider` + `FakeLiveProvider` | `GET /lives/{id}/ticket` con lógica de modo. Webhooks de LiveKit |
| **J** | **Feed vertical con pool de reproductores** | `GET /feed` con ranking heurístico. Presencia en Redis |
| **V** | Registro de token push, permiso al seguir, pulido | `follows`, contadores fragmentados, `/lives/{id}/state` |

**Definition of Done**

- [ ] Registro con Google en menos de 15 s, **sin pedir DNI ni dirección**.
- [ ] Transmisión de 15 min desde un móvil real en 4G, sin caídas.
- [ ] Latencia medida < 1,5 s en el visor.
- [ ] Feed con 20 elementos a 60 fps en un Android de gama media.
- [ ] **40 deslizamientos sin fuga de reproductores ni audio de fondo.**
- [ ] Reconexión: cortar el WiFi 20 s y que el live sobreviva.

**Riesgos:** Apple Sign-In es obligatorio si hay Google (política de la App Store) — implementarlo el lunes, no al final. El pool de reproductores hay que probarlo con 40 deslizamientos como parte del DoD, no "después".

---

### Sprint 2 — Catálogo, stock y compra

> **Objetivo:** un espectador compra sin salir del video, con dinero real. Primera compra con formulario, segunda en 2 clics.

| Área | Entregable |
|---|---|
| Catálogo | Productos, variantes, imágenes, stock y **peso** (obligatorio) |
| **Destacar producto** | Panel del vendedor con **botones grandes** + `PRODUCT_FEATURED` por WS |
| **Inventory Reservation** | Reserva atómica en Postgres, TTL 5 min, expiración |
| **Dirección** | Formulario único de primera compra: DNI/CUIL, dirección desglosada, CP |
| **Compra** | `POST /orders` idempotente + `POST /orders/{id}/pay` |
| **Pagos** | Mercado Pago: cobro, webhook, conciliación |

| Día | Flutter | Backend |
|---|---|---|
| **L** | Editor de producto: fotos, variantes, stock, peso | `products`, `inventory`. Subida a R2 con URL prefirmada |
| **M** | Control del live: botones grandes para destacar. Tarjeta destacada con cuotas | `live_featured_products` con índice único parcial. Gateway Socket.IO |
| **X** | **Formulario de dirección**: una pantalla, autocompletado de CP, validación de CUIL | 🔴 **`inventory.reserve` + tests de concurrencia.** `user_addresses` |
| **J** | **Hoja de compra sobre el video** (el reproductor no se desmonta) | 🔴 `orders` con idempotencia. `payments` con MP |
| **V** | Confirmación in-stream. Segunda compra en 2 clics | 🔴 Webhook firmado + deduplicación + conciliador |

**Definition of Done**

- [ ] **Una compra real, con dinero real, en producción.**
- [ ] Primera compra (con formulario) en menos de 90 s.
- [ ] **Segunda compra en 2 clics y menos de 10 s.**
- [ ] **El video no se pausa en ningún momento** — verificado con el test de widget.
- [ ] **300 reservas concurrentes sobre 2 unidades → exactamente 2 éxitos.**
- [ ] Doble toque en "Pagar" → un solo cobro.
- [ ] Reserva vencida → stock devuelto en menos de 2 s.
- [ ] Webhook perdido a propósito → conciliado en menos de 5 min.
- [ ] Validación de CUIL rechazando un dígito verificador inválido.

**Riesgos:** el script de reserva y sus tests de concurrencia se escriben el **miércoles**, con carga, sin excepción. Es el módulo que no puede fallar. El dataset de códigos postales argentinos (CSV público) se carga el lunes.

---

### Sprint 3 — Tiempo real, notificaciones y panel del vendedor

> **Objetivo:** el live se llena porque la gente se entera, y el vendedor puede operar.

| Área | Entregable |
|---|---|
| **Eventos en vivo** | Catálogo completo de eventos WS con agrupación y `seq` |
| Comentarios y reacciones | Comentarios + corazones agregados cada 500 ms |
| **Push Tipo A** | Contenido, agrupado, prioridad media |
| **Push Tipo B** | Live, prioridad alta, canal y sonido propios, TTL 15 min |
| Colas | BullMQ: fan-out con jitter, DLQ, deduplicación |
| **Panel del vendedor** | Pedidos, métricas en vivo, preparar y despachar |

| Día | Flutter | Backend |
|---|---|---|
| **L** | Capa de comentarios sobre el video, lista virtualizada | Eventos WS completos, `EventBatcher`, rooms |
| **M** | Capa de reacciones con `CustomPainter` + `RepaintBoundary` | Agregador de reacciones. `VIEWER_COUNT` cada 2 s |
| **X** | **Canales de notificación de Android** (Kotlin nativo) | Fan-out con tramos y jitter. Topics de FCM. Deduplicación |
| **J** | Ajustes de notificaciones. Deep links | Métricas del vendedor en Redis → WS cada 2 s |
| **V** | Panel del vendedor: pedidos, preparar, marcar listo | Estados de pedido. Agrupación de envíos por CP |

**Definition of Done**

- [ ] 1.000 eventos/s de WS sin superar 1 s de latencia.
- [ ] **10.000 reacciones/s de entrada → 2 eventos/s de salida por cliente.**
- [ ] Push Tipo B en menos de 45 s a 10 dispositivos reales, **con sonido distintivo**.
- [ ] Push Tipo A agrupa 4 publicaciones en una sola notificación.
- [ ] Deep link abre el live **con la app cerrada**.
- [ ] Reconectar el WS resincroniza con `GET /lives/{id}/state`.
- [ ] Un job crítico que agota reintentos llega a la DLQ y dispara alerta.

**Riesgos:** el sonido de push se prueba en **dispositivo físico el lunes** — el simulador de iOS no reproduce sonidos de push. El canal de Android es **inmutable** una vez creado: su configuración se revisa con dos pares de ojos.

---

### Sprint 4 — Buscador, carga y lanzamiento

> **Objetivo:** el producto es descubrible y el sistema aguanta.

| Área | Entregable |
|---|---|
| **Buscador** | Postgres FTS, lives priorizados, autocompletado |
| **ADMIN LITE** | Next.js + RBAC. 13 vistas de lectura + 4 acciones. **Bloqueante de lanzamiento** |
| Feed personalizado | Ranking con señales de follow y afinidad |
| **Hardening** | Pruebas de carga, límites, runbooks, alertas |
| **Lanzamiento** | Fichas de tienda, política de privacidad, envío a revisión |

| Día | Flutter | Backend + Admin |
|---|---|---|
| **L** | Pantalla de búsqueda: autocompletado, carrusel de lives | `search` con `SearchProvider` + Postgres FTS |
| **M** | Filtros, estado vacío con sugerencias | Ranking con umbral. **Endpoints `/admin/*` con guard de rol** |
| **X** | Seguimiento de pedidos, "Mis compras" | 🔴 **Admin Lite: vistas de order, payment y webhooks de MP** |
| **J** | Pulido, accesibilidad, estados de error | 🔴 **Pruebas de carga con k6.** Admin Lite: reservas, lives, audit |
| **V** | Envío a App Store y Play | Runbooks, alertas, guardia. Compra real en producción |

> **Admin Lite entra en el Sprint 4 y desplaza a las etiquetas de envío en PDF**, que pasan al mes 2 (hasta entonces, lista de pedidos en pantalla). Es el intercambio correcto: sin visibilidad de webhooks de Mercado Pago, el primer incidente de pago se depura a ciegas contra la base con `psql`, en producción y con un cliente esperando.
>
> **La vista de webhooks de MP es la de mayor valor por hora invertida de todo el panel.** Distingue en 10 segundos entre "Mercado Pago no nos avisó" y "nos avisó y lo procesamos mal", que son dos incidentes con soluciones opuestas.

**Definition of Done**

- [ ] Buscar el nombre de un vendedor lo devuelve primero.
- [ ] Un live aparece en el carrusel en menos de 5 s desde que arranca.
- [ ] Buscar "remeras" **no** devuelve un live de gorras solo por estar en vivo.
- [ ] "camion" encuentra "camión"; "capera" encuentra "campera".
- [ ] **k6: 10.000 espectadores concurrentes con compras activas.**
- [ ] **k6: 1.000 compras concurrentes sobre 100 unidades → exactamente 100 órdenes.**
- [ ] Runbooks escritos: caída de LiveKit, de MP, de Redis, de Postgres.
- [ ] Builds enviadas a ambas tiendas.

**Riesgos:** la revisión de App Store tarda de 1 a 7 días — hay que enviar una build de prueba en el **Sprint 3** para detectar rechazos de política a tiempo. La prueba de carga parcial se hace al final de **cada** sprint, no solo al final.

---

## 4. Orden de construcción del backend

Las dependencias mandan. Este es el orden y no es negociable:

```
auth → users → sellers → products → inventory → lives
  → realtime → orders → payments → follows → notifications → search → feed
```

`auth` primero porque todo lo demás necesita un usuario identificado. `inventory` antes que `orders` porque una orden sin reserva no tiene sentido. `payments` después de `orders` porque un pago sin orden tampoco.

## 5. Orden de recorte — decidido en frío

Si un sprint se atrasa, este es el orden en que se sacrifica alcance. Está decidido ahora, con la cabeza fría, para no discutirlo el jueves a las once de la noche:

| # | Se recorta | Qué lo reemplaza |
|---|---|---|
| 1 | Etiquetas PDF de envío | Lista de pedidos en pantalla |
| 2 | Autocompletado de búsqueda | Buscar al enviar |
| 3 | Reacciones (corazones) | Solo comentarios |
| 4 | Panel de métricas en vivo | El vendedor mira sus pedidos después |
| 5 | Push Tipo A (contenido) | Solo Tipo B (live) |
| 6 | Feed personalizado | Feed heurístico: lives primero, por espectadores |
| 7 | Búsqueda completa | Solo buscar vendedores por nombre |
| 8 | Admin Lite: vistas de reservas, lives y audit | Las 5 vistas núcleo (user, seller, order, payment, **webhooks**) no se recortan |
| **Nunca** | **Feed vertical · video · reserva de stock · compra · pago · push Tipo B · Admin Lite núcleo** | **Son el producto y su operación** |

**Los siete irrenunciables son el recorrido del PMV de tu punto 2, más la capacidad de operar un incidente.** Si algo de eso no está, no hay nada que lanzar.

## 6. Después del PMV

| Mes | Foco |
|---|---|
| **Mes 2** | **Panel admin en Next.js.** Chat mejorado. Métricas del vendedor. MODO como segundo medio de pago |
| **Mes 3** | **Fase 2: capa de voz** consumiendo los mismos endpoints. Meilisearch si se cruzó el umbral. Integración con Andreani |
| **Mes 4** | Recomendación con ML. WhatsApp Business. App de repartidor. Preparación de expansión regional |

**La capa de voz es la prueba de fuego del diseño.** Si al construirla hay que tocar algún endpoint de compra, la abstracción del documento [08](08-api-y-realtime.md) falló y hay que corregirla, no parcharla. Debería ser: `VOZ → STT → intent parser → POST /inventory/reservations → POST /orders`. Los mismos endpoints, un cliente nuevo.

## 7. Cómo medir si el sprint cerró

Tres preguntas cada viernes. Si alguna respuesta es "no", el sprint no cerró:

1. ¿Está desplegado en staging y probado en **dispositivo real**?
2. ¿Se cumplió **cada** punto de la Definition of Done, sin asteriscos?
3. ¿La telemetría del sprint anterior **sigue verde**?

La tercera es la que se olvida y la que hunde los proyectos: apilar funcionalidad sobre cimientos que ya empezaron a agrietarse.
