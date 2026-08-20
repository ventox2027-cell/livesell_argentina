# Diagnóstico de conectividad y performance — v0.1.2

**Medido el 20 de agosto de 2026, desde Argentina, contra producción.**
Reproducible con `node tools/medir-latencia.mjs`.

---

## 1. La respuesta corta

**No hay cold start.** Ni de Railway ni de Neon. Se midió después de siete
minutos sin tráfico y los números son idénticos.

La causa raíz es otra, y son dos sumadas:

1. **Un `SELECT 1` desde el backend hasta Neon tarda 621 ms.** Consistente,
   medición tras medición. Es el costo dominante de todo lo que toca la base.
2. **Abrir la conexión desde el teléfono cuesta ~280 ms**, y Dart la tiraba a
   los 15 segundos de quietud. Eso es lo que hacía que «la primera vez» y
   «después de un rato» se sintieran lentas.

Lo que se veía como «sin conexión» no era el Internet del teléfono: era el
mensaje equivocado para un servidor lento.

---

## 2. Tiempos por tramo

### Desde un cliente en Argentina

| Ruta | Frío (conexión nueva) | Caliente p50 | p95 |
|---|---|---|---|
| `/health` (sin base) | 498–635 ms | **166 ms** | 180 ms |
| `/ready` (base + Redis) | 1140–1179 ms | **747–781 ms** | 783 ms |
| `/api/v1/categories` (en memoria) | 444–455 ms | **168 ms** | 173 ms |
| `/api/v1/discover/products` | 1607–1805 ms | **1336–1418 ms** | 2032 ms |

### Descomposición de una conexión nueva

| Tramo | Tiempo | Qué es |
|---|---|---|
| DNS | 178–267 ms la 1.ª vez, 0–1 ms después | Resolver el nombre. No es nuestro. |
| TCP | **133–141 ms** | Un viaje de ida y vuelta. **Es la distancia.** |
| TLS | **135–164 ms** | Otro viaje. |
| **Subtotal para poder empezar** | **≈ 280 ms** (+DNS la 1.ª vez) | |
| Servidor | 33 ms (`/health`) | Lo único que arregla el código |

### Del lado del servidor — lo dice él mismo

`GET /ready` publica la latencia de cada dependencia. Ocho muestras seguidas:

```
  db= 621  redis= 114
  db= 625  redis= 114
  db= 624  redis= 114
  db= 622  redis= 114
  db= 622  redis= 114
  db= 626  redis= 114
  db= 747  redis= 114
  db= 627  redis= 114
```

`db` es **exactamente** `SELECT 1` — nada más, medido dentro del proceso
(`PrismaService.ping()`). **621 ms.** El propio servidor lo marca como
`degraded`.

---

## 3. Qué es cada cosa

| Causa | Costo | ¿Se arregla con código? |
|---|---|---|
| **Backend → Neon** | **621 ms por interacción con la base** | No. Es topología. |
| Distancia ARG → backend | 133 ms por petición | No. Es geografía. |
| Abrir conexión (TCP+TLS) | 280 ms, **repetido cada 15 s de quietud** | **Sí. Arreglado.** |
| DNS primera resolución | 178–267 ms, una vez | No. Es el resolver del ISP. |
| Redis (Upstash) | 114 ms | No es el problema. |
| **Cold start de Railway** | **0 — no existe** | — |
| **Autosuspend de Neon** | **0 — no existe** | — |
| Flutter | ~40 ms hasta `runApp` | Ya optimizado |

### Cold start: descartado con datos

Tras **siete minutos sin una sola petición**:

| | Antes | Tras 7 min de silencio |
|---|---|---|
| `/health` caliente p50 | 166 ms | 167 ms |
| `/ready` caliente p50 | 747 ms | 781 ms |
| `/discover` caliente p50 | 1336 ms | 1418 ms |

Si Neon suspendiera su compute, la primera consulta después del silencio
costaría segundos. Costó lo mismo. **El proceso no duerme y la base tampoco.**

### Lo que sí explica «la primera vez tarda»

No es el servidor despertándose. Es el cliente:

- **DNS sin cachear**: 178–267 ms, sólo en la primera apertura.
- **TCP + TLS**: 280 ms, que se pagaban **de nuevo cada 15 segundos** de
  inactividad porque `HttpClient` de Dart cierra las conexiones ociosas ahí.

Eso explica los tres síntomas a la vez: la primera apertura es la peor (DNS +
handshake), cerrar y volver a abrir enseguida va mejor (DNS cacheado), y
cualquier acción después de una pausa se siente lenta (handshake de nuevo).

---

## 4. Verificación de la infraestructura

| Qué | Verificado | Cómo |
|---|---|---|
| Neon región | **`sa-east-1`** (São Paulo) | Leído del entorno, **sólo el token de región** |
| `DATABASE_URL` | pooled (`-pooler`) | ídem |
| `DIRECT_URL` | directa | ídem — correcto para migraciones |
| Redis | Upstash, región no deducible de la URL | 114 ms, no es el cuello |
| DNS de `api.vendox.com.ar` | CNAME → `3diuvg9x.up.railway.app` → `69.46.46.0` | `nslookup` |
| Redirecciones | **Ninguna** (`num_redirects=0`) | `curl -L` |
| IPv6 | **No hay AAAA.** Sólo IPv4 | `nslookup -type=AAAA` |
| HTTP | **HTTP/1.1**, no h2 | `curl -w %{http_version}` |
| Prisma | **Mantiene pool.** No abre conexión por petición | `PrismaService`, `datasources` |

### ⚠️ Lo que NO se pudo verificar

- **La región de Railway.** No es observable desde afuera: el borde es un
  proxy. La suposición «US East» sigue siendo suposición.
- **La región de Upstash.** La URL no la lleva.
- **El `.env` leído es el local**, no el de Railway. Puede diferir.

### Un dato que no cierra

621 ms para un `SELECT 1` es **unas cinco veces** el viaje esperado entre
Estados Unidos y São Paulo (~120 ms). Las explicaciones posibles:

- el contenedor no está donde creemos;
- el pooler de Neon agrega saltos;
- el compute de Neon está limitado.

**Esto conviene mirarlo en el panel de Railway antes de mover nada**, porque si
el contenedor ya estuviera cerca, mover la región no arreglaría nada.

### El dominio de Railway, como diagnóstico

`https://3diuvg9x.up.railway.app` devuelve **404 «Application not found»**: la
aplicación sólo está ruteada por el dominio propio. **No sirve como referencia**
—sus 220 ms son del borde, no de la app— pero confirma que el dominio propio no
agrega nada: `/health` responde en 166 ms con un viaje de red de 133.

---

## 5. Qué se arregló ahora

Sólo cliente y UX, como se pidió. **Ningún timeout se tocó. Ningún reintento
agresivo. Ningún loader nuevo.**

### a) La conexión se reusa tres minutos, no quince segundos

`HttpClient` de Dart cierra las conexiones ociosas a los 15 s. Se subió a 3
minutos y se limitó a 6 conexiones por host, como un navegador.

**No es esconder nada**: los timeouts quedan donde estaban. Es dejar de tirar
una conexión que sigue siendo válida — HTTP tiene keep-alive exactamente para
esto, y el servidor la cierra cuando quiere.

**Ahorro esperado: ~280 ms en cada acción que hoy ocurre después de más de 15
segundos de quietud**, que es casi todas las de un vendedor.

### b) Un servidor lento ya no dice «revisá tu conexión»

Antes todo lo que no fuera una respuesta del servidor caía en la misma bolsa.
Ahora son tres cosas distintas:

| Qué pasó | Qué se dice |
|---|---|
| El DNS no resuelve → no hay red | «Sin conexión a Internet» |
| Hay red pero no llegamos | «No pudimos conectarnos con VendoX» |
| Conectamos y no contesta a tiempo | «VendoX está tardando más de lo esperado» |

⚠️ Los tres **siguen reintentándose solos** cuando vuelve la conectividad. Esa
parte funcionaba y no se tocó: hay un test que lo fija.

### c) Se instrumentó qué petición se lleva el arranque

Cada petición queda anotada en la traza mientras dura el arranque, con su
método, su ruta y su duración. Se lee con `adb logcat -s flutter`.

⚠️ Sólo el método y la ruta. Nunca la cadena de consulta —ahí viaja el término
de búsqueda—, nunca las cabeceras, nunca el cuerpo.

### d) Un script de medición

`node tools/medir-latencia.mjs`, con `--repeticiones` y `--base`. Separa DNS,
TCP, TLS, espera y total; y compara conexión nueva contra conexión reusada.

---

## 6. Recomendación de infraestructura

**No se ejecutó nada.**

### El número que decide

De un `/discover/products` de ~1418 ms desde un teléfono argentino:

```
   133 ms  ARG → backend            (distancia)
  ~1285 ms servidor, casi todo Neon (topología)
```

Y de esos ~1285 ms, **cada interacción con la base cuesta 621 ms**.

Ninguna optimización de consultas cambia eso. Se puede bajar el *número* de
viajes —ya se hizo— pero no lo que cuesta cada uno.

### Qué mover

**El compute a São Paulo. La base NO se toca.**

| | Hoy | Propuesto |
|---|---|---|
| Backend | ¿US East? | **São Paulo** |
| Neon | `sa-east-1` | `sa-east-1`, sin cambios |

Gana dos veces: el viaje a la base pasa de 621 ms a red interna del proveedor
(~1–5 ms), y el teléfono deja de estar a 133 ms del servidor (ARG → São Paulo
son ~30–40 ms).

### Impacto esperado

| Ruta | Hoy | Estimado |
|---|---|---|
| `/health` | 166 ms | ~40 ms |
| `/ready` | 781 ms | ~50 ms |
| `/discover/products` | 1418 ms | **~120–250 ms** |

⚠️ Son estimaciones aritméticas —distancia medida menos distancia esperada—,
no una medición. El número real sale de probarlo.

### Riesgo, downtime y rollback

| | |
|---|---|
| **Riesgo** | Bajo. **No se migra ni un dato.** El proceso no guarda estado. |
| **Downtime** | Un redespliegue: segundos, con el drenaje ordenado que ya existe. Si Railway obliga a crear un servicio nuevo, hay que mover el CNAME: minutos, y conviene bajar el TTL una semana antes. |
| **Rollback** | Volver a la región anterior y redesplegar. Si fue servicio nuevo: dejar el viejo encendido hasta confirmar y devolver el CNAME. |
| **Costo** | No inferible desde nuestra configuración. Railway cobra por uso, no por región, pero **hay que confirmarlo en el panel**: no lo afirmo. |

### Antes de ejecutar

1. **Confirmar en el panel de Railway en qué región está hoy el contenedor.**
   Es el dato que falta y el que decide todo.
2. **Confirmar que Railway ofrezca São Paulo** en el plan actual.
3. **Averiguar la región de Upstash.** Con 114 ms no es el cuello hoy, pero si
   queda en Estados Unidos pasaría a serlo cuando el resto baje a ~40 ms.
4. Si el contenedor **ya** estuviera cerca de Neon, entonces los 621 ms son
   otra cosa —pooler o compute— y hay que investigar eso en vez de mover nada.

---

## 7. Lo que queda pendiente y depende de infraestructura

- Crear/guardar/publicar producto: **1 viaje cada uno**, ya sin serialización
  del lado del cliente. Sus 5–8 segundos son ese viaje más el costo de la
  base. Bajan solos con el punto 6.
- Subida de fotos: es transferencia real a R2. No mejora con la región.
- Los 621 ms del `SELECT 1`: **no se pueden arreglar desde el código**.
