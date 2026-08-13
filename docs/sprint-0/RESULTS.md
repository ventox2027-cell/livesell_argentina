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

> Se completa en el bloque siguiente del Sprint 0.

**Fecha:** ____ **Responsables:** ____

### Camino de tokenización elegido

☐ **Plan A** — CardForm / Bricks de MP en WebView · alcance PCI **SAQ-A**
☐ **Plan B** — REST directo desde la app · alcance **SAQ-A-EP**
☐ **Plan C** — Checkout Pro con deep link · **degrada la UX**

**Justificación:**

### Primera compra

| Paso | ✅/❌ | Tiempo | Nota |
|---|---|---|---|
| Producto de prueba visible | | | |
| Ingreso de medio de pago | | | |
| Tokenización | | | |
| `POST /orders` idempotente | | | |
| Llamada a Mercado Pago | | | |
| Pago aprobado | | | |
| Webhook recibido | | | |
| Firma verificada | | | |
| Estado consultado contra la API de MP | | | |
| ORDER = PAID | | | |
| **Tiempo total** | | | |

### Segunda compra (objetivo: 2 clics)

| Paso | ✅/❌ | Tiempo |
|---|---|---|
| Medio de pago guardado disponible | | |
| Confirmar | | |
| Pagar | | |
| Webhook → PAID | | |
| **Tiempo total (objetivo < 10 s)** | | |

### Robustez

| Prueba | ✅/❌ |
|---|---|
| Webhook duplicado → una sola acreditación | |
| Firma inválida → rechazado | |
| Doble toque en "Pagar" → un solo cobro | |
| Timeout de red → queda PENDING, nunca REJECTED | |
| Webhook perdido → conciliador lo resuelve | |
| Datos de tarjeta ausentes de logs y base | |

### Decisión

**Seguimos con Mercado Pago + Checkout API:** ☐ Sí ☐ No

**Justificación:**

---

## Decisión conjunta del Sprint 0

☐ **GO** — ambos spikes pasan. Se arranca con Auth.
☐ **GO PARCIAL** — uno pasa, el otro necesita otra vuelta. Detalle: ____
☐ **NO GO** — se replantea antes de seguir. Detalle: ____

**Firmado:** ____ **Fecha:** ____
