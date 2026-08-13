# Live Shopping Argentina

Aplicación móvil de venta en vivo: feed vertical de video, transmisiones en
directo y compra integrada. Lanzamiento exclusivo en Argentina.

```
Vendedor transmite  →  espectador ve con < 600 ms de retraso  →  compra sin salir del vivo
```

---

## Estado actual

| Sprint | Qué valida | Estado |
|---|---|---|
| **0A · LiveKit** | ¿La latencia alcanza desde redes argentinas? | ✅ **GO** — p95 de 577 ms |
| **0B · Mercado Pago** | ¿Podemos cobrar sin arrastrar alcance PCI? | ✅ **GO** — SAQ-A, 0 datos de tarjeta |
| **1 · Auth** | Producto | ▶️ **siguiente** |

La evidencia de las decisiones está en [docs/sprint-0/RESULTS.md](docs/sprint-0/RESULTS.md).

**Sprint 0 cerrado con GO el 13/08/2026.** Los dos riesgos técnicos que podían
matar el proyecto están respondidos con mediciones, no con opiniones.

> Siete defectos reales aparecieron sólo al probar con teléfonos y dinero de
> verdad. Cuatro habrían llegado a producción. El error nunca estuvo en el
> camino feliz: estuvo en qué pasa cuando algo se corta a la mitad, cuando el
> aviso llega tarde, o cuando llega dos veces.

---

## Por qué hay un Sprint 0

Cuatro riesgos pueden matar este proyecto. Tres son técnicos y se responden
midiendo, no discutiendo.

| # | Riesgo | Si sale mal | Cómo se responde |
|---|---|---|---|
| **R1** | Tokenizar tarjetas desde Flutter arrastra alcance PCI completo | No podemos cobrar, o el costo de cumplimiento entierra el proyecto | Spike 0B |
| **R2** | La latencia desde redes argentinas hace que el vivo no se sienta vivo | El producto pierde su única ventaja | Spike 0A ✅ |
| **R3** | Mercado de dos lados vacío: sin vendedores no hay compradores | Nadie usa la app | Producto, no técnico |
| **R4** | El costo de video por espectador no cierra | Cada usuario nuevo pierde plata | Se mide en 0A, se vigila siempre |

R2 ya está respondido. R1 es el que queda, y es el que de verdad decide si hay
proyecto.

---

## Decisiones de arquitectura

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **LiveKit Cloud (WebRTC)** | Agora, Mux, HLS propio | Sub-segundo real medido. Migrar después cuesta más que empezar bien |
| 2 | **Sin umbral fijo de espectadores** para pasar a LL-HLS | "3000 espectadores = LL-HLS" | Un número inventado no es una regla. Se activa con datos de costo y capacidad |
| 3 | **Fly.io, región `gru`** (São Paulo) | us-east | Es el punto con menor latencia hacia Argentina |
| 4 | **Neon PostgreSQL + Upstash Redis**, misma región | Base en otra región | Separar la app de su base agrega un ida y vuelta por consulta |
| 5 | **NestJS + Fastify, monolito modular** | Microservicios | Un equipo chico con microservicios construye latencia y complejidad, no escala |
| 6 | **PostgreSQL como única fuente de verdad** | Stock en Redis | Redis no decide stock. Jamás |
| 7 | **SQL crudo en los caminos con concurrencia** | Prisma en todo | El `UPDATE ... WHERE (on_hand - reserved) >= qty` tiene que ser atómico de verdad |
| 8 | **Flutter + Riverpod** | React Native | Hot reload, un solo render engine, rendimiento de video predecible |
| 9 | **El backend es la fuente de verdad** | Lógica de precios en la app | Ninguna decisión de plata se toma en un dispositivo que el usuario controla |
| 10 | **Idempotencia garantizada por índices UNIQUE** | Chequeo en código | La carrera la resuelve el motor, no un `if` |
| 11 | **Los webhooks nunca son fuente de verdad** | Confiar en el cuerpo | Un aviso firmado sigue siendo un aviso: el estado se consulta |
| 12 | **Outbox transaccional** para eventos | Publicar y rezar | Un evento perdido es un push que nunca llega |
| 13 | **Tokens de LiveKit firmados en el backend**, `canPublish: false` para espectadores | Confiar en la app | El invariante se aplica en el servidor, no en el cliente |
| 14 | **Sin Critical Alerts ni Time Sensitive** en notificaciones comerciales | Usarlas para "captar atención" | Política de Apple. Un rechazo de tienda cuesta semanas |
| 15 | **Admin Lite antes del lanzamiento** | Diferir el panel | Sin forma de ver un pago o suspender un vendedor, el primer problema real se atiende con `psql` |

---

## Estructura

```
blueprint/     Especificación técnica: 15 documentos, 33 secciones
backend/       NestJS + Fastify + Prisma
mobile/        Flutter — hoy contiene la app de medición del Sprint 0
db/            Esquema completo de referencia (se incorpora al arrancar Auth)
docs/sprint-0/ Procedimiento de campo y resultados medidos
tools/         Utilidades de medición (reloj glass-to-glass, servidor de APK)
```

Por dónde empezar a leer:

1. [blueprint/01-arquitectura-y-stack.md](blueprint/01-arquitectura-y-stack.md) — el mapa
2. [docs/sprint-0/RESULTS.md](docs/sprint-0/RESULTS.md) — qué se midió y qué dio
3. [blueprint/14-roadmap-4-semanas.md](blueprint/14-roadmap-4-semanas.md) — el plan

---

## Levantar el entorno local

```bash
cd backend
cp .env.example .env          # completar con las credenciales propias
pnpm install
pnpm infra:up                 # PostgreSQL en 5433, Redis en 6380
pnpm prisma:deploy
pnpm dev                      # http://localhost:3100/health
```

Los puertos no son los estándar a propósito: esta máquina corre otro proyecto
que ya ocupa 5432 y 6379.

Para los tests hace falta una base separada, una sola vez:

```bash
pnpm test:db:create
pnpm test:db:migrate
pnpm test
```

La base de pruebas está separada por una razón concreta: los tests de
integración escriben latencias inventadas y pagos falsos. Cuando compartían
base con desarrollo, esos datos se mezclaron con mediciones de campo reales y
el informe dio un veredicto que nadie había medido.

---

## Reglas que no se negocian

- **Ningún secreto en el repositorio.** Los `.env` viven en la máquina y en
  `fly secrets`. Nunca en `.env.example`.
- **Ningún dato de tarjeta en nuestros sistemas.** Ni en la base, ni en los
  logs, ni en un mensaje de error. Sólo los últimos cuatro dígitos.
- **Ninguna automatización no oficial de WhatsApp.** Sólo la Business Platform.
- **Ninguna decisión de dinero en el cliente.** Precios, stock y estados se
  resuelven en el backend.
- **Ningún `SPIKE_ENABLED` ni `PAYMENTS_SPIKE_ENABLED` en producción.** La
  configuración lo impide y no arranca si se intenta.

---

## Objetivos de latencia

| Métrica | Objetivo | Máximo tolerable | Medido |
|---|---|---|---|
| Glass-to-glass | ≤ 800 ms | 1500 ms | **577 ms** ✅ |
| Tiempo hasta el primer cuadro | ≤ 1500 ms | 3000 ms | 4020 ms ❌ |
| Reconexión de la sala | ≤ 5 s | 10 s | 1,4 s ✅ |
| Corte de imagen ante caída de red | — | — | corte de red + ~7 s |
| Chat de extremo a extremo | ≤ 300 ms | 800 ms | sin medir |
