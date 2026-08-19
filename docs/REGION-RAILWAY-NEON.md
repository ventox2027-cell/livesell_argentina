# Región de Railway y Neon — informe técnico

**Estado: sólo auditoría. No se movió nada.**

Fecha de las mediciones: 19 de agosto de 2026, desde Argentina.

---

## 1. Dónde está cada cosa hoy

| Servicio | Región | Qué guarda |
|---|---|---|
| Railway (API) | US East | El proceso que responde. Nada persistente. |
| Neon (PostgreSQL) | `sa-east-1` (São Paulo) | Todo lo que se guarda. |
| Upstash (Redis) | sin confirmar | Reservas de stock, colas, límites por IP. |
| Cloudflare R2 | global | Imágenes y el APK. |

O sea: **el proceso y su base están en continentes distintos**, y las
personas que usan la app están del lado de la base.

---

## 2. Lo medido

Tres muestras por endpoint, desde Argentina contra `api.vendox.com.ar`.

| Ruta | Tiempo total | Trabajo propio |
|---|---|---|
| `/health` | **0,62 s** | ~0 — no toca la base |
| `/ready` | 1,20 s | ~0,58 s (ping a base + Redis) |
| `/api/v1/categories` | 0,61 s | ~0 — cacheado en memoria |
| `/api/v1/discover/products?limit=20` | **1,81 s** | ~1,19 s |

### Cómo se lee esto

`/health` no consulta nada: sus 0,62 s son **enteramente la distancia entre el
teléfono y Railway**. Ése es el piso de cualquier respuesta, y no lo baja
ninguna optimización de consultas.

El resto es ida y vuelta Railway ⇄ Neon. Medido antes: **~310 ms por viaje**.

---

## 3. Viajes a la base por endpoint

Contados sobre el código, no estimados.

| Endpoint | Viajes | En serie o en paralelo |
|---|---|---|
| `GET /health` | 0 | — |
| `GET /ready` | 2 | base y Redis, en paralelo |
| `GET /categories` | 0 tras el primero | `keepAlive` en memoria |
| `GET /discover/products` | 2–3 | `product.findMany` y promocionados en paralelo; la búsqueda por texto suma uno **antes**, en serie |
| `GET /sellers/me` | 1 | — |
| `GET /products/mine` | 1 | — |
| `POST /orders` | varios, en transacción | **en serie por definición** |
| `POST /live/:id/feature` | 1–2 | — |

### Cuáles duelen más con la distancia

1. **Las transacciones.** Una transacción son N viajes que **no se pueden
   paralelizar**: cada sentencia espera a la anterior porque comparten el
   mismo `BEGIN`. Crear una orden con reserva de stock es el peor caso del
   sistema, y es justo el que decide si alguien compra o abandona.

2. **Lo que pide en serie por lógica.** La búsqueda por texto de
   `/discover/products` resuelve primero qué ids coinciden y después los
   trae: dos viajes encadenados, ~620 ms sólo de distancia.

3. **Los `Promise.all`** son los que menos sufren: dos viajes en paralelo
   cuestan uno.

---

## 4. Qué pasaría si estuvieran juntos

Con compute y base en la misma región, el viaje Railway ⇄ Neon baja de ~310 ms
a **~1–5 ms** — es una red interna del proveedor, no internet.

### Escenario A — mover Railway a Sudamérica

Gana **dos veces**:

- Los viajes a la base se vuelven despreciables.
- Las personas dejan de estar a ~600 ms del servidor: Argentina → São Paulo son
  ~30–40 ms.

Estimación sobre lo medido:

| Ruta | Hoy | Estimado |
|---|---|---|
| `/health` | 0,62 s | ~0,05 s |
| `/discover/products` | 1,81 s | ~0,15–0,30 s |
| `/ready` | 1,20 s | ~0,10 s |

⚠️ Son estimaciones aritméticas: distancia medida menos distancia esperada. No
son una medición. El número real sale de probarlo.

### Escenario B — mover Neon a US East

Gana **una sola vez**: se arregla el viaje interno, y las personas siguen a
~600 ms del servidor.

| Ruta | Hoy | Estimado |
|---|---|---|
| `/discover/products` | 1,81 s | ~0,70 s |

Además implica **migrar datos**, que es la operación riesgosa de las dos.

### Conclusión

**A es mejor que B por bastante**, y encima no toca los datos.

---

## 5. Qué haría falta para A

### Lo que hay que confirmar antes

- [ ] **Que Railway ofrezca una región sudamericana** en el plan actual. Al
      momento de escribir esto no está verificado, y es la pregunta que
      decide todo lo demás.
- [ ] **En qué región está Upstash.** Si queda en Estados Unidos, las
      reservas de stock y el límite por IP pasan a ser lo lento.
- [ ] Si el cambio de región de Railway es un ajuste del servicio o exige
      **crear uno nuevo** — cambia el plan de despliegue y el rollback.

### Variables y servicios que se tocan

| Qué | Cambia | Por qué |
|---|---|---|
| `DATABASE_URL` | no | Neon no se mueve |
| `DIRECT_URL` | no | ídem |
| `REDIS_URL` | quizás | sólo si además se mueve Upstash |
| `PUBLIC_BASE_URL` | no | el dominio no cambia |
| DNS de `api.vendox.com.ar` | **sí, si Railway da un host nuevo** | el CNAME apunta al servicio |
| R2 | no | es global |
| Firebase / LiveKit / Mercado Pago | no | nada depende de dónde corre la API |

⚠️ Si Railway obliga a crear un servicio nuevo, **hay que tocar DNS**, y eso
está fuera de lo autorizado hasta ahora.

### Downtime probable

- **Si es un ajuste de región del mismo servicio:** un redespliegue. Con el
  apagado ordenado que ya existe —`registrarApagadoOrdenado`, 5 s de
  drenaje— el corte es de **segundos**, y las peticiones en vuelo terminan.
- **Si hay que crear un servicio nuevo y mover el DNS:** el corte lo marca la
  propagación del CNAME. Con TTL bajo puesto de antemano, **minutos**. Sin
  bajarlo antes, hasta lo que diga el TTL actual.

### Rollback

1. **Ajuste de región:** volver a la región anterior y redesplegar. No hay
   estado que revertir — el proceso no guarda nada.
2. **Servicio nuevo:** dejar el servicio viejo **encendido** hasta confirmar
   el nuevo, y volver el CNAME. Por eso conviene bajar el TTL antes de
   empezar y no después.

En los dos casos la base no se toca, así que no hay migración que deshacer.
Es la razón principal para preferir A.

---

## 6. Lo que NO justifica mover nada todavía

- El arranque de la app ya no espera un viaje de red (`eb836cd`), así que los
  ~600 ms de distancia ya no están en el camino de abrir la aplicación.
- El feed bajó de 3,48 s a 1,81 s sin tocar infraestructura.
- Mi tienda, destacar producto, borrar producto y subir fotos dejaron de
  esperar viajes que no hacían falta.

O sea: **buena parte de lo que se sentía como «la app es lenta» era código,
no distancia**, y eso ya está arreglado. Lo que queda es el piso duro de los
~600 ms, que sí es geografía.

---

## 7. Recomendación

Mover **Railway a Sudamérica**, no Neon. Antes:

1. Confirmar que la región existe en el plan actual.
2. Averiguar la región de Upstash.
3. Bajar el TTL del CNAME **una semana antes**, por si hace falta.

**Nada de esto se ejecuta sin aprobación explícita.**
