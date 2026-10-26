# syntax=docker/dockerfile:1
# Centinela dashboard: static build served by unprivileged nginx, which also proxies /api
# to the server so the browser stays same-origin. Build from the repository root:
#   docker build -f packages/web/Dockerfile -t centinela-web .
ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/loggen/package.json packages/loggen/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json vitest.shared.ts ./
# src/lib/attack.ts imports the ATT&CK names from data/ (bundled as a lazy chunk).
COPY data/mitre-attack data/mitre-attack
COPY packages/shared packages/shared
COPY packages/web packages/web
RUN npm run build -w packages/web

# nginx-unprivileged runs as uid 101 and listens on 8080.
FROM ${NGINX_IMAGE} AS runtime
ENV API_UPSTREAM=http://server:3000
COPY packages/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 8080
