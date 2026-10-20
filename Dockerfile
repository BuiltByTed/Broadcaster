# Build stage for frontend
FROM node:20-slim AS frontend-builder

WORKDIR /app

# Copy Webapp package files and install dependencies
COPY Webapp/package*.json ./Webapp/
RUN cd Webapp && npm ci

# Copy Webapp source and build
COPY Webapp ./Webapp
RUN cd Webapp && npm run build

# Runtime stage
FROM nvidia/cuda:12.6.3-runtime-ubuntu24.04

# Mozilla bug 2083449: remove only emSign ECC Root CA - G3.
COPY security/remove-g3.sh /usr/local/sbin/remove-g3
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/* && sh /usr/local/sbin/remove-g3
ENV NODE_OPTIONS=--use-openssl-ca SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt


# Install system dependencies and ffmpeg with NVIDIA support
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/* && \
    npm cache clean --force

# Create app directory
WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy application code (excluding Webapp source, only need built files)
COPY Classes ./Classes
COPY Utilities ./Utilities
COPY Broadcaster.js ./
COPY config.docker.txt ./config.txt

# Copy built frontend from builder stage
COPY --from=frontend-builder /app/Webapp/dist ./Webapp/dist
COPY Webapp/TelevisionUI.js ./Webapp/
COPY Webapp/static ./Webapp/static
COPY Webapp/static-4x3 ./Webapp/static-4x3
COPY Webapp/static.gif ./Webapp/

# Create broadcaster user with UID 99 (nobody) and GID 100 (users)
RUN groupadd -g 100 users || true && \
    useradd -u 99 -g 100 -m -s /bin/bash broadcaster

# Create directories for volumes with correct ownership
RUN mkdir -p /data /media && \
    chown -R 99:100 /data /media /app

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
  CMD curl -f http://localhost:12121/ || exit 1

# Start the application
CMD ["node", "Broadcaster.js"]

# Package installs must not reintroduce the distrusted anchor.
USER root
RUN sh /usr/local/sbin/remove-g3
USER broadcaster
