# =============================================================================
# TORQUE — Multi-stage Docker Build
# =============================================================================
# Stage 1: Build the dashboard (Vite + React + Tailwind)
# Stage 2: Production server with pre-built dashboard assets
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Dashboard build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: Production server
# ---------------------------------------------------------------------------
FROM node:22-alpine

# better-sqlite3 requires build tools for native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install server dependencies (separate layer for caching)
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Install root dependencies (ws, uuid, bonjour-service)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy server source
COPY server/ ./server/

# Copy built dashboard assets from stage 1
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist

# Create persistent data directory for SQLite
RUN mkdir -p /data

# Environment defaults
ENV TORQUE_DATA_DIR=/data
ENV NODE_ENV=production

# Ports:
#   3456 — Dashboard (web UI + WebSocket)
#   3457 — REST API
#   3458 — MCP SSE transport
#   9394 — GPU metrics (optional)
EXPOSE 3456 3457 3458 9394

# Health check — REST API health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3457/healthz || exit 1

# Run as non-root for security
RUN addgroup -g 1001 torque && adduser -u 1001 -G torque -s /bin/sh -D torque
RUN chown -R torque:torque /app /data
USER torque

# The server reads from stdin for MCP protocol; keep stdin open
CMD ["node", "server/index.js"]
