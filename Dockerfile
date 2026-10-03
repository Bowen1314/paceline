# Paceline: one process serving the API, the SSE stream, the PayPal webhook
# endpoint and the built frontend.
#
#   docker build -t paceline .
#   docker run --rm -p 8791:8791 -v paceline-data:/data paceline
#
# Keys come only from the runtime environment (docker run -e / --env-file);
# nothing secret is copied into either stage. See .env.example for the names.

# ---- build: install everything, bundle the client (Vite) and the server (esbuild)
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build

# ---- runtime: the server bundle has no npm dependencies left (ajv is inlined),
# so the image carries dist/ and package.json (for "type": "module") only.
FROM node:22-slim AS runtime
# Port: PACELINE_PORT, else PORT (what most hosts inject), else 8791.
ENV NODE_ENV=production \
    PACELINE_HOST=0.0.0.0 \
    PACELINE_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8791
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const p = process.env.PACELINE_PORT || process.env.PORT || 8791; fetch('http://127.0.0.1:' + p + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server/index.js"]
