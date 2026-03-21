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

# Set working directory back to server_app
WORKDIR /app/server_app

# Copy package files and install dependencies
COPY server_app/package*.json ./
RUN npm ci --only=production

# Copy the rest of the server_app application
COPY server_app/ ./

# Expose the port (default 8069, configurable via APP_PORT env var)
EXPOSE 8069

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8069/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Run the application
CMD ["node", "server.js"]

