# Imagen de producción del backend.
#
# Multi-etapa para que la imagen final no arrastre el toolchain de compilación:
# menos superficie de ataque y arranques más rápidos en Fly.io.

# ─── 1. Dependencias ──────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# ─── 2. Compilación ───────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate && pnpm build && pnpm prune --prod

# ─── 3. Runtime ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=UTC

# Qué commit está corriendo.
#
# Lo expone /health, y el despliegue lo comprueba: sin esto, un despliegue que
# falló en silencio y dejó arriba la versión anterior pasaría como exitoso.
# También es lo primero que se mira cuando algo se rompe en staging.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

# Usuario sin privilegios: si alguien logra ejecutar código, no es root.
RUN addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/package.json ./package.json

USER app
EXPOSE 3000

# dumb-init no está: Node 22 maneja SIGTERM correctamente y Nest cierra las
# conexiones en onModuleDestroy.
CMD ["node", "dist/main.js"]
