# ──────────────────────────────────────────────────────────────
# Claudeck Marketplace — showcase site container
#
# Serves the static showcase (showcase/) plus the mock API routes
# (/api/registry, /api/plugins/:name) via scripts/dev-server.js,
# which reproduces every vercel.json rewrite in pure Node stdlib.
# No runtime dependencies — the image is just Node + the repo.
# ──────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Copy the whole repo. .dockerignore keeps node_modules/.git/etc out.
COPY . .

# Generate the mock serverless routes (api/plugins/*.js) that the
# server loads at request time. Mirrors Vercel's buildCommand.
RUN node scripts/build-server-routes.js

# The server listens on $PORT on 0.0.0.0. Default 3010 to steer clear of
# Dokploy's own port 3000. Override via the PORT env var if needed.
ENV PORT=3010
EXPOSE 3010

# Basic liveness check against the homepage rewrite.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

CMD ["node", "scripts/dev-server.js"]
