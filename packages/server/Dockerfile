# syntax=docker/dockerfile:1
# Centinela API server. Build from the repository root:
#   docker build -f packages/server/Dockerfile -t centinela-server .
ARG NODE_IMAGE=node:22-bookworm-slim

# --- Workspace manifests only, so dependency layers are cached across code changes.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/loggen/package.json packages/loggen/

# --- Compile shared and server with the full dependency set.
FROM manifests AS build
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN npm run build -w packages/shared && npm run build -w packages/server

# --- Production dependencies of the server workspace only.
FROM manifests AS prod-deps
RUN npm ci --omit=dev --no-audit --no-fund --workspace @centinela/server

# --- Runtime: compiled code, migrations, rules and ATT&CK data; files owned by root,
# process running as the unprivileged `node` user.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist
COPY packages/server/migrations packages/server/migrations
COPY data/mitre-attack data/mitre-attack
COPY rules rules
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "packages/server/dist/index.js"]
