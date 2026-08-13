# SPRINT 0 · Resultados

> Plantilla. Se completa **durante** las pruebas de campo, no después de memoria.
> Este documento es la evidencia de la decisión GO/NO-GO.

---

## 0A · LiveKit

**Fecha:** 11/08/2026 · **Backend:** local + túnel Cloudflare (todavía no hay staging)
**Dispositivos:** A = emisor · B = espectador · **LiveKit:** `ventox-hywz9bzq` (LiveKit Cloud)
**Sesiones:** 5 · **muestras:** 5189 · **mediciones manuales:** 10 · **errores:** 0

### Paso 0 · Prueba de humo con navegador (preliminar)

> Antes de instalar Flutter, se validó el circuito con LiveKit Meet en el
> navegador de dos celulares, WiFi, y el reloj `tools/glass-timer.html` en modo local.

| | |
|---|---|
| Fecha | 11/08/2026 |
| Método | Dos pantallas en una foto (notebook + celular B) |
| Resultado | **Sub-segundo, claramente. Estimación a ojo: ~100–300 ms** |
| Confiabilidad | ⚠️ **Baja** — no se pudieron leer los dígitos de ms con nitidez |
| Conclusión | ✅ **Descarta el escenario catastrófico.** Justifica invertir en la medición formal |

**Limitación del método:** fotografiar milisegundos con la cámara de un celular
falla por *rolling shutter* y desenfoque de movimiento. La medición formal usa
**captura de pantalla** del visor (overlay y video en la misma pantalla), que
elimina el problema. Ver RUNBOOK §6.

---

### Resumen ejecutivo

**VEREDICTO: ✅ GO**

Glass-to-glass **p95 de 577 ms** sobre 10 mediciones manuales en dos condiciones
(fibra y 4G Personal), muy por debajo del objetivo de 800 ms. El adaptive
bitrate quedó confirmado funcionando y las cuatro pruebas de corte de red se
recuperaron solas, sin errores. **Se sigue con LiveKit** y se pasa al Sprint 0B
(Mercado Pago).

Dos puntos flojos, ninguno bloqueante y ninguno atribuible a LiveKit:

- **El primer frame tarda ~4 segundos.**
- **La app tarda hasta 20 s en darse cuenta de que se cortó el video**, porque
  el SFU tarda ese tiempo en declarar caído al emisor. Se resuelve con un
  watchdog propio; queda como requisito del módulo Live Sessions.

### Glass-to-glass por condición (mediciones manuales)

| # | Condición | Operadora | n | p50 | **p95** | máx | Resultado |
|---|---|---|---|---|---|---|---|
| 1 | Fibra, ambos en WiFi | — | 6 | 479,5 | **579,5** | 583 | ✅ |
| 2 | 4G transmitiendo, viewer en WiFi | Personal | 4 | 343,5 | **418,7** | 425 | ✅ |
| 3 | 4G transmitiendo | Movistar | — | — | — | — | pendiente |
| 4 | 4G transmitiendo | Claro | — | — | — | — | pendiente |
| 5 | 4G ambos extremos | | — | — | — | — | pendiente |
| 6 | Hora pico | | — | — | — | — | pendiente |
| 7 | En movimiento | | — | — | — | — | pendiente |
| 8 | Señal débil | | — | — | — | — | pendiente |

**Global:** n=10 · p50 426 ms · **p95 576,7 ms** · máx 583 ms · desvío 94,8 ms

**Criterio:** p95 ≤ 800 ms = PASS · 800–1500 ms = CAVEAT · > 1500 ms = FAIL

#### 🔍 Hallazgo: 4G resultó MÁS RÁPIDO que WiFi

`343 ms` en 4G contra `479 ms` en fibra. Es contraintuitivo y tiene explicación
en los datos de calidad:

| | WiFi (fibra) | 4G (Personal) |
|---|---|---|
| Bitrate p50 | ~3000 kbps | 417 kbps |
| Resolución | 1080×1920 fija | 320 / 640 / 1920 (alternando) |
| fps p50 | 13 | 20 |

En 4G el **adaptive bitrate bajó la calidad**, y menos píxeles significan menos
tiempo de codificación y decodificación. **La latencia bajó porque la calidad
bajó.** No es que 4G sea mejor que la fibra: es el compromiso que hace el ABR.

Es un dato de producto, no una anomalía: en redes móviles el sistema prioriza
fluidez sobre nitidez, que es exactamente lo que queremos en un live de venta.

Nota metodológica: parte de la diferencia también viene del fps. A 13 fps cada
cuadro dura 77 ms, lo que agrega error de cuantización hacia arriba en la
lectura. Los 13 fps del WiFi se debieron a **poca luz ambiente** (la cámara
alarga la exposición), no al transporte.

### Calibración de la estimación automática

| Concepto | Valor |
|---|---|
| Pares (manual, estimado) | 4 |
| **Sesgo medio** (`manual − estimado`) | **+29 ms** (la estimación subestima) |
| Desvío del sesgo | 33 ms |
| Presupuestos sugeridos | encode 55 ms · render 48 ms |

> **Consecuencia práctica: la estimación automática es confiable dentro de
> ±30 ms.** Las próximas corridas no necesitan fotos — alcanza con
> `estimatedE2eMs + 29`. Eso convierte una medición de 20 minutos con fotos en
> una de 2 minutos automática.

### Conexión y resiliencia

| Métrica | Valor | Criterio | Resultado |
|---|---|---|---|
| Tiempo de conexión | emisor 693 ms · espectador 1433 ms | — | ✅ |
| **Time-to-first-frame** | **4020 ms** | p95 ≤ 1500 ms | ❌ **a investigar** |
| Reconexión de la sala propia | 1008 / 1352 ms | p95 ≤ 5 s | ✅ |
| **Corte de imagen que ve el espectador** | **p50 13 s · máx 49 s** | — | ⚠️ **ver abajo** |
| Errores | 0 en toda la campaña | — | ✅ |

**Sobre los 4 segundos hasta el primer frame:** no bloquea el GO —una vez que
arranca, la latencia es excelente— pero sí es un problema de UX. Entrar a un
live y esperar 4 segundos con la pantalla negra es exactamente donde la gente
se va. Hipótesis a verificar en el mes 1: negociación ICE lenta, o que el
`autoSubscribe` espera el keyframe siguiente en vez de pedir uno inmediato.
Mitigación de producto: mostrar la miniatura del live mientras carga, en lugar
de una pantalla en negro.

| # | Prueba | Corte de red real | **Imagen congelada** | Recuperación | ✅/❌ |
|---|---|---|---|---|---|
| R1 | WiFi → 4G en A | 0 s (sin corte) | **6,0 s** | automática | ✅ |
| R2 | 4G → WiFi en A | 0 s (sin corte) | **6,0 s** | automática | ✅ |
| R3 | Avión corto | 13 s | **20,0 s** | automática | ✅ |
| R4 | Avión largo | 42 s | **49,0 s** | automática | ✅ |
| R5 | WiFi → 4G en B | | | | pendiente |
| R6 | Ascensor | | | | pendiente |
| R7 | Segundo plano 10 s | | | | pendiente |
| R8 | 30 min continuos | | | | pendiente |

**Lo que pasa el examen:** las cuatro pruebas se recuperaron **solas**, sin
tocar la app, sin reiniciar la sesión y sin un solo error. La sala del
espectador nunca se cayó, y la reconexión del emisor tardó ~1,2 s. El
transporte aguanta la calle.

**El costo fijo de recuperación es de ~7 segundos:**

```
imagen congelada ≈ corte de red + 7 s
```

13 s de corte → 20 s congelado. 42 s → 49 s. Es consistente, y significa que
incluso un bache de 2 segundos en el subte le cuesta al vendedor ~9 segundos
de pantalla quieta.

#### 🚨 Hallazgo principal: la app está CIEGA durante 17 segundos

Es el resultado más importante de las pruebas de resiliencia, y no se ve en
ninguna métrica de latencia.

| Instante | Qué pasa |
|---|---|
| 22:14:26 | Al emisor se le cae la red. **La imagen se congela.** |
| 22:14:26 → 22:14:40 | El SFU todavía considera vivo al emisor. **La app no sabe nada.** |
| 22:14:40 | Recién acá llega `TRACK_UNSUBSCRIBED` |
| 22:14:46 | Vuelven a llegar cuadros |

**Retardo de detección medido: 13,7 s a 20,1 s (media 16,9 s).**

Es el timeout de participante del SFU: LiveKit espera ~15 s sin paquetes antes
de dar por caído a un emisor. Durante esa ventana la señalización dice que todo
está bien mientras el espectador mira una foto.

Tres consecuencias, todas de producto:

1. **La UI de reconexión no puede basarse en los eventos de track.** Si la app
   espera el `TRACK_UNSUBSCRIBED`, el cartel de "el vendedor está reconectando"
   aparece 15 segundos tarde, cuando la persona ya se fue.
2. **Hay que correr un watchdog de cuadros en el cliente**: si `framesDecoded`
   no avanza durante ~2 s, avisar. Es la misma lógica que
   [freeze.ts](../../backend/src/modules/spike/freeze.ts), del lado del teléfono.
3. **La pantalla no debe ponerse negra.** Último cuadro congelado + chat vivo +
   aviso explícito. Un corte explicado se tolera; uno mudo se lee como "la app
   se rompió".

Esto entra como **requisito** del módulo Live Sessions, no como deuda.

> **Nota de método.** Estos números NO salen de los eventos de la sala sino de
> los cuadros decodificados. La instrumentación original medía el hueco entre
> `TRACK_UNSUBSCRIBED` y `TRACK_SUBSCRIBED` y reportó **1601 ms** para el corte
> que en realidad duró **20 s**: un error de 12×, siempre hacia abajo. El
> porqué está documentado en `freeze.ts`. Resolución del instrumento: 4 s —
> cortes más breves que eso no se pueden afirmar.

### Calidad y adaptive bitrate — sesión 4G

| Métrica | Valor | Lectura |
|---|---|---|
| **Alturas observadas** | **320 · 640 · 1920** | ✅ **El ABR funciona** — cambió de capa solo |
| Capas observadas | low · medium · high | ✅ las tres |
| Bitrate | p50 417 kbps · máx 1016 | Bajó de 3000 (WiFi) para sostener la conexión |
| fps | p50 20 · máx 26 | Aceptable; mejora con más luz |
| **Pérdida de paquetes** | **0,0 % en 426 muestras** | ✅ excelente |
| Freezes (aprox.) | 54 en ~7 min | ⚠️ a vigilar |
| Calidad de conexión | 428/430 muestras en `excellent` | ✅ |

**La confirmación del ABR es el segundo resultado más importante después de la
latencia.** Ver tres resoluciones distintas en una misma sesión prueba que el
SFU está adaptando la capa a las condiciones de red sin intervención nuestra.
Es la funcionalidad que hace que un vendedor con mala señal siga transmitiendo
en lugar de cortarse.

### Observaciones cualitativas

> Lo que los números no capturan.

- **¿La interacción se siente en tiempo real?** Sí. Con 426 ms de mediana, el
  saludo con la mano se ve prácticamente en el momento.
- **¿La reconexión molesta?** Sí, pero no por la reconexión en sí —que es
  rápida— sino porque **no se comunica**. Esa es la conclusión de R1–R4 y el
  motivo de que el watchdog pase de "mejora" a "requisito".
- **¿Diferencias entre operadoras?** Sin datos: solo se midió Personal.
- **¿Algo se rompió que los números no muestran?** No. Cero errores, cero
  cierres inesperados, ninguna sesión que haya que reiniciar a mano.

### Decisión

**Seguimos con LiveKit:** ✅ **Sí**

**Justificación:** p95 de 577 ms sobre 10 mediciones manuales en dos
condiciones, con 0 % de pérdida de paquetes y adaptive bitrate confirmado. El
margen contra el objetivo de 800 ms es amplio, y contra el máximo tolerable de
1500 ms es de casi 3×. No hay evidencia que justifique el costo de evaluar otro
proveedor.

Las pruebas de resiliencia **confirman** el GO: cuatro cortes provocados, cuatro
recuperaciones automáticas, cero errores. El problema que aparecerá abajo no es
del transporte sino de cómo la app lo cuenta, y eso lo controlamos nosotros.

**Requisitos que salieron de las pruebas (van al módulo Live Sessions):**

1. **Watchdog de cuadros en el cliente**, umbral ~2 s. Sin esto la app tarda
   17 s en enterarse de que no hay video. Es el hallazgo principal.
2. **Congelar el último cuadro y mantener el chat**, nunca pantalla negra.
3. **Aviso explícito al espectador** con el tiempo transcurrido, y al emisor un
   indicador de que su transmisión se cortó — hoy el emisor tampoco se entera.

**Deuda anotada, no bloqueante:**

4. **Time-to-first-frame de 4 s** — problema de UX al entrar a un live.
   Investigar en el mes 1. Mitigación inmediata: miniatura mientras carga.
5. **6 s de congelamiento al cambiar de red** (WiFi ⇄ 4G) aun sin corte real.
   Es el escenario del vendedor que sale de su casa. Ver si LiveKit expone
   algo tipo *ICE restart* anticipado.
6. **Solo una operadora medida** (Personal). Movistar y Claro quedan para
   cuando haya chips disponibles. Con la calibración hecha, ya no requieren
   fotos: alcanza con `estimatedE2eMs + 29 ms`.
7. **R5 a R8 sin ejecutar** (viewer cambiando de red, ascensor, segundo plano,
   30 min continuos). No bloquean el Sprint 0B; sí hay que cerrarlas antes del
   lanzamiento.
8. **Congelamientos de 4 a 8 s en la sesión de fibra** sin manipulación
   deliberada de red. No se pudo atribuir causa: esa sesión se corrió mientras
   se sacaban capturas y se abría la hoja de medición. Vigilar en una sesión
   limpia de 30 min (R8).

---

## 0B · Mercado Pago

**Fecha:** 13/08/2026 · **Backend:** local + túnel Cloudflare
**Credenciales:** de prueba (`TEST-`) · **Integración:** Checkout API + API de Pagos

### Camino de tokenización elegido

☑ **Plan A** — CardForm de MP en WebView, modo `iframe` · alcance PCI **SAQ-A**
☐ Plan B — REST directo desde la app · alcance **SAQ-A-EP**
☐ Plan C — Checkout Pro con deep link · **degrada la UX**

**Justificación:** con `iframe: true`, los campos del número y del código de
seguridad son iframes servidos por Mercado Pago. El PAN no pasa por el DOM de
la página, ni por Dart, ni por nuestro backend. Verificado sobre datos reales
más abajo. Es la diferencia entre un cuestionario y una auditoría anual con
escaneos trimestrales.

### Primera compra

| Paso | ✅/❌ | Nota |
|---|---|---|
| Producto de prueba visible | ✅ | |
| Formulario de tarjeta carga en el celular | ✅ | Detectó Banco Santander y cuotas solo |
| Tokenización | ✅ | El token nunca se persiste |
| `POST /orders` idempotente | ✅ | |
| Llamada a Mercado Pago | ✅ | |
| Pago aprobado | ✅ | `visa` · `accredited` · pago `1327860846` |
| Webhook recibido | ✅ | 681 ms después de la respuesta directa |
| Firma verificada | ✅ | `signature_valid = t` |
| Estado consultado contra la API de MP | ✅ | El cuerpo del webhook no se usa para decidir |
| ORDER = PAID | ✅ | |
| **Tiempo total** | **1,8 s** | de tocar *Pagar* a `PAID` |

### 🔍 Hallazgo: la guarda de monotonía funcionando en vivo

La bitácora de auditoría de la compra real:

```
07:46:10.502  API      payment.attempt          PENDING_PAYMENT → PROCESSING
07:46:12.307  API      payment.status_changed   PROCESSING      → PAID
07:46:12.988  WEBHOOK  payment.no_change        PAID            → PAID
```

El webhook llegó **681 ms después** de que la respuesta directa de Mercado Pago
ya hubiera acreditado el pago. El sistema reconoció que no había nada que
cambiar y registró `no_change` en vez de acreditar por segunda vez.

Es el escenario de doble acreditación, ocurriendo de forma natural en la
primera compra real — no provocado en un test. **Sin la guarda, la ruta de la
API y la del webhook habrían acreditado el mismo pago dos veces.**

### ⛔ Datos de tarjeta

Consultado sobre la base después de una compra real con `4509 9535 6623 3704`:

| Verificación | Resultado |
|---|---|
| Filas con `cardholder`, `first_six`, `security_code` o `token` | **0** |
| El BIN `450995` en la tabla de pagos | **0** |
| El BIN `450995` en la auditoría | **0** |
| El BIN `450995` en los webhooks guardados | **0** |
| Coincidencias en los logs del backend | **0** |
| Lo que sí se guarda | `card_last_four = 3704`, `brand = visa` |

**Es el resultado que sostiene todo el argumento de PCI**, y el único que, de
haber fallado, habría dado NO-GO por más que el cobro funcionara.

### Segunda compra (objetivo: 2 clics)

| Paso | ✅/❌ | Tiempo |
|---|---|---|
| Medio de pago guardado disponible | | |
| Confirmar | | |
| Pagar | | |
| Webhook → PAID | | |
| **Tiempo total (objetivo < 10 s)** | | |

### Robustez

Los 20 casos automáticos corren contra un doble de Mercado Pago
(`test/integration/payments-flow.spec.ts`). La columna de campo es contra el
Mercado Pago real, por el túnel.

| Prueba | Automático | En campo |
|---|---|---|
| Webhook duplicado → una sola acreditación | ✅ | ✅ ocurrió sola en la 1.ª compra |
| Firma inválida → rechazado | ✅ | ✅ `HASH_MISMATCH` |
| Reenvío de notificación vieja → rechazado | ✅ | ✅ `STALE_TIMESTAMP` |
| Sin firma → rechazado | ✅ | ✅ `MISSING_SIGNATURE` |
| Pago inexistente → archivado, sin pedir reintento | ✅ | ✅ `UNKNOWN_PAYMENT` |
| Notificación huérfana → no revienta | ✅ | — |
| Doble toque en "Pagar" → un solo cobro | ✅ | pendiente |
| Timeout de red → queda PROCESSING, nunca FAILED | ✅ | pendiente |
| **Webhook perdido → el conciliador lo resuelve** | ✅ | ✅ **ver abajo** |
| **Rechazo → reintento con otra tarjeta funciona** | ✅ | ✅ |
| Orden paga no se despaga con webhook desordenado | ✅ | — |
| Datos de tarjeta ausentes de logs y base | ✅ | ✅ verificado sobre datos reales |

Los tres rechazos quedan registrados con su motivo en `mp_webhook_events`, que
es lo que permite detectar si alguien está probando el endpoint.

### El conciliador, contra Mercado Pago real

Se provocó el peor caso: **un cobro acreditado del que nunca nos enteramos.**
Para forzarlo se cambió la clave de firma por una señuelo, de modo que la
notificación de Mercado Pago llegara y fuera rechazada.

```
08:43:24  API          order.created                       → PENDING_PAYMENT
08:43:28  (webhook recibido y RECHAZADO: HASH_MISMATCH)
          ── plata cobrada en Mercado Pago, orden colgada en PROCESSING ──
08:44:19  RECONCILER   payment.status_changed  PROCESSING  → PAID
```

El conciliador preguntó por nuestra referencia de orden, encontró el pago
aprobado y lo acreditó. **Sin él, esa venta quedaba cobrada y sin entregar.**

Es el escenario que ninguna otra capa cubre: la firma es correcta al rechazar,
el webhook hizo lo suyo, y aun así el sistema tenía que recuperarse solo.

### Recuperación después de un rechazo

| # | Intento | Clave de idempotencia | Pago | Resultado |
|---|---|---|---|---|
| 1 | `FUND` | `…c8e66188a952eb8f` | `1350331981` | `REJECTED` · fondos insuficientes |
| 2 | `APRO` | `…cedf3693094e413b` | `1350327949` | `APPROVED` |

La orden pasó `FAILED → PAID`. Claves distintas, pagos distintos.

> **Encontrado acá y corregido.** La primera versión usaba el id de la orden
> como clave de idempotencia. En el reintento se mandaba la misma y Mercado
> Pago devolvía la respuesta guardada del primer intento: **una orden
> rechazada no podía pagarse nunca más, con ninguna tarjeta.** La clave ahora
> se deriva del token, que es la unidad correcta de "un cobro".

### Casos de rechazo

| Titular | Estado esperado | Resultado |
|---|---|---|
| `FUND` — fondos insuficientes | `FAILED` | ✅ mensaje: *"La tarjeta no tiene fondos suficientes"* |
| Número mal tipeado | `FAILED` | ✅ mensaje: *"Revisá el número de la tarjeta"* |
| `SECU` — código inválido | `FAILED` | pendiente |
| `CALL` — requiere autorización | `FAILED` | pendiente |
| `CONT` — pendiente | `PROCESSING` | pendiente |

> **Deuda de producto encontrada acá.** El primer mensaje que vio el comprador
> fue `invalid card_number_validation`: correcto, preciso e inútil. Ahora los
> errores de Mercado Pago se traducen, y cada uno clasifica **qué puede hacer
> la persona** — corregir datos, usar otra tarjeta, llamar al banco o esperar.
> Ofrecer "reintentar" ante fondos insuficientes es hacerle perder el tiempo a
> alguien que quiere comprar.

### Segunda compra (objetivo: 2 clics) — 🚧 BLOQUEADA

Investigada a fondo contra Mercado Pago real. **Dos de los tres eslabones
funcionan; el tercero devuelve un error sin causa que no depende de nosotros.**

| Paso | Resultado |
|---|---|
| Crear el cliente (`POST /v1/customers`) | ✅ |
| Guardar la tarjeta (`POST /v1/customers/{id}/cards`) | ✅ HTTP 201, devuelve el `card_id` |
| Tokenizar desde la tarjeta guardada | ✅ y **funciona sin pedir el código de seguridad** |
| **Cobrar con ese token** | ❌ **`internal_error` 500, sin causa** |

Se probaron cuatro formas del bloque `payer` —`type`+`id`, `id`+`email`, con
`issuer_id`, con `identification`— y las cuatro devuelven exactamente:

```json
{"cause":[],"error":null,"message":"internal_error","status":500}
```

Un 500 con la lista de causas vacía es un fallo del lado de Mercado Pago, no
un payload mal armado. Seguir probando combinaciones es adivinar.

**Dato secundario que puede ser la pista:** al guardar la tarjeta, Mercado Pago
descarta el número de documento —queda `identification.number: null`— aunque el
token se haya creado con él. Puede que el cobro lo necesite y no lo encuentre.

**Además hay un problema de diseño por resolver.** Guardar la tarjeta consume
un token, y cobrar consume otro. Una pasada por el formulario produce **uno
solo**. Hacen falta dos tokens del mismo ingreso de datos, y con `iframe: true`
los campos no son nuestros, así que no se puede simplemente volver a leerlos.
Hay que verificar si `cardForm` permite emitir un segundo token.

**Qué hacer:** consultar a soporte de Mercado Pago con estos datos, o probar
con una aplicación habilitada para producción. **No bloquea el veredicto de
0B**: el riesgo R1 —tokenizar sin arrastrar el alcance PCI— ya está respondido
por la primera compra.

**Lo que NO se hizo, a propósito:** dejar el flujo a medias en la app. Una
pantalla de "pagar con tarjeta guardada" que falla en el último paso es peor
que no tenerla, porque parece terminada.

### Deuda anotada

1. **Migrar a la API de Orders** antes de producción. Mercado Pago la marca
   como recomendada y las funcionalidades nuevas van a aparecer ahí primero.
   Costo acotado a `mp.client.ts` y al parseo del webhook: la máquina de
   estados, la idempotencia y el conciliador no se tocan.
2. **Habilitación de Checkout API para producción.** Con credenciales de
   prueba funciona sin trámite; falta confirmar qué pide Mercado Pago para
   activar el ambiente productivo.
3. **Segunda compra en dos clics** con medio de pago guardado.

### Decisión

**Seguimos con Mercado Pago + Checkout API:** ☑ **Sí**

**Justificación:** una compra real terminó en `PAID` en 1,8 segundos, con
firma verificada, una sola acreditación pese a que llegaron dos caminos de
confirmación, y **cero datos de tarjeta** en base, auditoría y logs. El riesgo
R1 —que tokenizar desde Flutter arrastrara el alcance PCI completo— queda
descartado: los campos sensibles son iframes de Mercado Pago y el número no
toca ningún sistema nuestro.

---

## Decisión conjunta del Sprint 0

☐ **GO** — ambos spikes pasan. Se arranca con Auth.
☐ **GO PARCIAL** — uno pasa, el otro necesita otra vuelta. Detalle: ____
☐ **NO GO** — se replantea antes de seguir. Detalle: ____

**Firmado:** ____ **Fecha:** ____
