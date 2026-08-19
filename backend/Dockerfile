# Imagen del backend de VendoX.
#
# ═══════════════════════════════════════════════════════════════════════════
# NEUTRAL RESPECTO DEL PROVEEDOR
# ═══════════════════════════════════════════════════════════════════════════
#
# Esta imagen corre sin cambios en Fly.io, IBM Cloud Code Engine, Render o
# cualquier runtime de contenedores. No hay nada de un proveedor acá adentro:
# lo que varía —el puerto, el rol del proceso, de qué cabecera sale la IP del
# cliente— entra por variables de entorno.
#
# Las tres formas de arrancarla:
#
#   node dist/main.js         API (y tareas periódicas si APP_ROLE=all)
#   node dist/main-worker.js  sólo tareas periódicas, sin puerto abierto
#   node dist/jobs-once.js    un barrido y termina, para tareas programadas
#
# Multi-etapa para que la imagen final no arrastre el toolchain: menos
# superficie de ataque, menos bytes que mover en cada despliegue y arranques en
# frío más rápidos — que en plataformas que escalan a cero se notan en cada
# petición que llega con el contenedor apagado.

# ─── 1. Dependencias ──────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# `corepack` toma la versión de pnpm del campo `packageManager` de package.json.
# Sin ese campo, la versión de pnpm sería la que traiga la imagen base ese día:
# el lockfile podría resolverse distinto entre dos builds del mismo commit.
RUN corepack enable

# ⚠️ `pnpm-workspace.yaml` NO es opcional acá.
#
# Desde pnpm 10, `overrides` y `allowBuilds` viven en ese archivo y no en
# package.json. Sin copiarlo, pnpm no ve el override de Fastify que sí está
# grabado en el lockfile, y `--frozen-lockfile` falla con un desajuste que
# parece un problema del lockfile y no lo es:
#
#     ERR_PNPM_LOCKFILE_CONFIG_MISMATCH
#     The current "overrides" configuration doesn't match the value found in
#     the lockfile
#
# Faltaba, y por eso la imagen no se podía construir.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma

# `--frozen-lockfile` falla si el lockfile no coincide con la configuración, en
# vez de actualizarlo en silencio. Un build que corrige el lockfile por su
# cuenta instala versiones que nadie revisó.
RUN pnpm install --frozen-lockfile

# ─── 2. Compilación ───────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `prisma generate` antes de compilar: el cliente generado es lo que tipa las
# consultas, y sin él la compilación falla.
#
# `prune --prod` deja fuera las dependencias de desarrollo. Es la diferencia
# entre llevarse el compilador de TypeScript y el framework de tests a
# producción o no.
#
# ⚠️ Por eso `prisma` —el CLI, no `@prisma/client`— vive en `dependencies` y no
# en `devDependencies`.
#
# Parece un error y no lo es. El CLI no se usa en runtime, así que su lugar
# natural sería devDependencies; pero entonces `prune --prod` lo saca de la
# imagen, y con él se va la única forma de correr `prisma migrate deploy` al
# desplegar.
#
# Lo que pasa cuando falta: el comando de arranque
# `prisma migrate deploy && node dist/main.js` falla con "not found", la
# plataforma cae al CMD de abajo, y la API levanta perfecto contra una base sin
# esquema. `/health` responde 200 y **todas las consultas dan 500**. Pasó al
# desplegar en Railway: el contenedor se veía sano y nada decía que las
# migraciones no habían corrido.
#
# El costo son 67 MB de imagen. Barato al lado de un despliegue que parece
# exitoso y no lo es.
RUN pnpm prisma generate && pnpm build && pnpm prune --prod

# ─── 3. Runtime ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV TZ=UTC

# ⚠️ PORT NO se fija acá.
#
# Lo inyecta la plataforma y espera que el proceso escuche exactamente ahí.
# Code Engine usa 8080 por omisión, Fly toma el de fly.toml, Render el suyo.
# Un valor fijo en la imagen gana sobre el de la plataforma en algunos
# runtimes, y el resultado es un contenedor que arranca, no recibe una sola
# petición y se reinicia en bucle sin un error que lo explique.
#
# La configuración exige `PORT` explícito fuera de local justamente por esto.

# Qué commit está corriendo.
#
# Lo expone /health, y el despliegue lo comprueba: sin esto, un despliegue que
# falló en silencio y dejó arriba la versión anterior pasaría como exitoso.
# También es lo primero que se mira cuando algo se rompe.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

# Usuario sin privilegios: si alguien logra ejecutar código, no es root.
#
# Algunas plataformas además rechazan contenedores que corren como root, o les
# asignan un UID arbitrario. Los archivos se copian con `--chown` para que el
# proceso pueda leerlos en cualquiera de los dos casos.
RUN addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --chown=app:app scripts/arrancar.sh ./scripts/arrancar.sh

# El sitio público de vendox.com.ar.
#
# ⚠️ Vive en `backend/web` y no en la raíz del repositorio, y no es un capricho:
# el contexto de construcción de esta imagen ES `backend/`. Un `COPY ../web` no
# existe en Docker — lo que está fuera del contexto no se puede copiar.
#
# Que esté al lado del backend además es honesto: es el backend quien lo sirve.
# Ver el comentario de `raizDelSitio` en `main.ts` para por qué vendox.com.ar y
# api.vendox.com.ar son el mismo servicio.
COPY --chown=app:app web ./web
RUN chmod +x ./scripts/arrancar.sh

USER app

# Documental: la plataforma publica el puerto que ella eligió, no éste. Se deja
# el 3000 porque es el valor por omisión de la configuración.
EXPOSE 3000

# ─── Señales ─────────────────────────────────────────────────────────────────
#
# Sin gestor de procesos a propósito. `CMD` en forma exec (con corchetes) hace
# que Node sea el PID 1 y reciba SIGTERM directamente.
#
# La forma shell —`CMD node dist/main.js`— metería un `/bin/sh` como PID 1 que
# NO reenvía señales: el proceso nunca se enteraría del SIGTERM, seguiría
# atendiendo hasta el SIGKILL y cada despliegue cortaría peticiones a la mitad.
# Es un detalle de sintaxis con consecuencia directa sobre pagos en vuelo.
#
# El apagado ordenado está en `src/shutdown.ts`: drena, cierra Prisma y Redis,
# detiene los reconciliadores y devuelve los jobs tomados.
#
# ─── Y por qué entonces el CMD es un script de shell ───
#
# Porque `arrancar.sh` termina con `exec node dist/main.js`. `exec` REEMPLAZA el
# proceso del shell por Node en vez de dejarlo como padre, así que Node vuelve a
# ser el PID 1 y recibe SIGTERM directo. Todo lo de arriba sigue valiendo.
#
# Sin ese `exec`, el shell quedaría de PID 1 sin reenviar señales — el caso que
# el comentario describe.
#
# El script aplica las migraciones pendientes antes de servir. Vive en la imagen
# y no en un campo de texto del proveedor: uno se lee en un diff y se prueba, el
# otro no. Ver la nota de `scripts/arrancar.sh`.
CMD ["./scripts/arrancar.sh"]
