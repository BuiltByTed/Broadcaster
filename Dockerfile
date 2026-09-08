# Build stage for frontend
FROM node:24-bookworm-slim AS frontend-builder

WORKDIR /app

# Copy Webapp package files and install dependencies
COPY Webapp/package*.json ./Webapp/
RUN cd Webapp && npm ci

# Copy Webapp source and build
COPY Webapp ./Webapp
RUN cd Webapp && npm run build

# Install native runtime dependencies with the same Node version as production.
FROM node:24-bookworm-slim AS backend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Runtime stage
FROM nvidia/cuda:12.6.3-runtime-ubuntu24.04

# Install system dependencies and ffmpeg with NVIDIA support
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Use the supported Node runtime from the build stage.
COPY --from=backend-builder /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=backend-builder /app/node_modules ./node_modules
COPY package.json ./

# Copy application code (excluding Webapp source, only need built files)
COPY Classes ./Classes
COPY Utilities ./Utilities
COPY Broadcaster.js ./
COPY config.docker.txt ./config.txt

# Copy built frontend from builder stage
COPY --from=frontend-builder /app/Webapp/dist ./Webapp/dist
COPY Webapp/TelevisionUI.js ./Webapp/
COPY Webapp/staticAssets.js ./Webapp/
COPY Webapp/static ./Webapp/static
COPY Webapp/static-4x3 ./Webapp/static-4x3

# Create broadcaster user with UID 99 (nobody) and GID 100 (users)
RUN groupadd -g 100 users || true && \
    useradd -u 99 -g 100 -m -s /bin/bash broadcaster

# Create directories for volumes with correct ownership
RUN mkdir -p /data /media && \
    chown -R 99:100 /data /media /app

ARG DEPLOY_ID=local
ENV DEPLOY_ID=$DEPLOY_ID

# Environment variables
ENV CACHE_DIR=/data
ENV CHANNEL_LIST=/data/channels.json
ENV NODE_ENV=production
ENV WEB_UI_PORT=12121

# Switch to broadcaster user
USER broadcaster

# Expose the web UI port
EXPOSE 12121

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:12121/healthz || exit 1

# Start the application
CMD ["node", "Broadcaster.js"]
