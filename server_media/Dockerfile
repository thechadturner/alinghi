# Use Node.js LTS version as base
FROM node:20-slim

# Set working directory
WORKDIR /app

# Install system dependencies if needed
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy shared directory first (for dependency resolution)
COPY shared /app/shared
WORKDIR /app/shared
RUN npm install

# Set working directory back to server_media
WORKDIR /app/server_media

# Copy package files and install dependencies (if package.json exists with dependencies)
COPY server_media/package*.json ./
RUN if [ -f package.json ] && grep -q '"dependencies"' package.json; then npm ci --only=production || true; fi

# Copy the rest of the server_media application
COPY server_media/ ./

# Expose the port (default 8089, configurable via MEDIA_PORT env var)
EXPOSE 8089

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8089/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Run the application
CMD ["node", "server.js"]

