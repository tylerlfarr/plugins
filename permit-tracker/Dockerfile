# Permit Ledger — single-instance React/Express + SQLite (Node 22 + lockfile)
#
# Hostinger: full-tree `npm install` runs package.json `postinstall` → `npm run build`.
# Docker: package files are copied before app source, so lifecycle scripts are skipped
# during `npm ci`, then:
#   - build stage: explicit `npm run build` after COPY .
#   - runtime stage: `npm rebuild better-sqlite3` so native bindings exist
#     (plain `--ignore-scripts` alone would leave better-sqlite3 unloadable)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    LISTEN_HOST=0.0.0.0 \
    AUTO_SEED=0 \
    PILOT_AUTH=1 \
    PERMIT_DB_PATH=/data/permit-ledger.sqlite \
    COOKIE_SECURE=1
# Toolchain for better-sqlite3 native compile/rebuild after --ignore-scripts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild better-sqlite3 \
  && npm cache clean --force
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/server ./server
USER root
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
