# ── Stage 1: install dependencies ────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy deps from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY src/ ./src/

# Copy default settings
COPY settings.json ./settings.json

# Create cache directory with correct ownership and restrict permissions
RUN mkdir -p /app/cache \
    && chown appuser:appgroup /app/cache /app/settings.json \
    && chmod 700 /app/cache \
    && chmod 600 /app/settings.json

# Switch to non-root user
USER appuser

EXPOSE 3000

CMD ["node", "src/app.js"]
