# ─────────────────────────────────────────────────────
#  AISNESIA — Dockerfile
# ─────────────────────────────────────────────────────
FROM node:20-alpine

# Metadata
LABEL maintainer="RSUD Pare IT"
LABEL description="AISNESIA — AIS Realtime Ship Tracker"

# Create app directory
WORKDIR /app

# Install deps first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY server.js .
COPY public/   public/
COPY .env.example .env

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/healthz || exit 1

# Non-root user for security
RUN addgroup -S ais && adduser -S ais -G ais
USER ais

CMD ["node", "server.js"]
