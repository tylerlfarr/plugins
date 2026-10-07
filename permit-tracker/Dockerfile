# Permit Ledger — single-instance React/Express + SQLite (Node 22 + lockfile)
#
# postinstall runs `npm run build` for Hostinger's full-tree `npm install`.
# Docker copies package files first, so install MUST use --ignore-scripts,
# then build explicitly after the full source tree is present.
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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/server ./server
USER root
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
