# Multi-stage production Dockerfile для Dogfight (v1.0.0)
# Stage 1: збірка клієнта (Vite -> client/dist)
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci

COPY shared ./shared
COPY client ./client

RUN npm run build --workspace=dogfight-client

# Stage 2: мінімальний production-образ (< 200 MB) без devDependencies
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    LOG_DIR=/app/logs \
    STATIC_DIR=/app/client/dist \
    APP_VERSION=1.0.0

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci --omit=dev --workspace=@dogfight/shared --workspace=dogfight-server \
    && npm cache clean --force

COPY shared/src ./shared/src
COPY server/src ./server/src
COPY --from=builder /app/client/dist ./client/dist

RUN mkdir -p /app/logs && chown -R node:node /app/logs

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/src/index.ts"]
