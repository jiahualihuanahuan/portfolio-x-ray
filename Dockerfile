# Portfolio X-ray — standalone Node server (ETF look-through).
#   docker compose up -d --build
# Listens on 0.0.0.0:8096 inside the container. Map it with HOST_PORT.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    NITRO_PRESET=node-server
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Lockfile was generated with npm 10.9.8; newer npm treats optional ajv peers as out of sync.
RUN npm install -g npm@10.9.8 && npm ci
COPY . .
RUN npm run build && test -f .output/server/index.mjs

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8096 \
    HOST=0.0.0.0 \
    NITRO_HOST=0.0.0.0 \
    TZ=America/Toronto
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/lookthru && chown -R node:node /data
COPY --from=build --chown=node:node /app/.output ./.output
USER node
EXPOSE 8096
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8096)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
