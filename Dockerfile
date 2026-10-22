# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim

# Dépendances complètes (outils de build compris).
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Secrets facultatifs pour un registre ou un proxy d'entreprise :
# docker build --secret id=npmrc,src=$HOME/.npmrc --secret id=npm_ca,src=ca.crt .
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    --mount=type=secret,id=npm_ca,target=/run/secrets/npm_ca \
    npm ci --ignore-scripts --no-audit --no-fund

# Construction, puis retrait des dépendances de développement.
FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# Image d'exécution : utilisateur non root, données sur /data.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/backup.mjs ./scripts/backup.mjs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
