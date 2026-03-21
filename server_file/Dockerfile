# Use Node.js LTS version as base
FROM node:20-slim

# Set working directory
WORKDIR /app

# Install system dependencies if needed
# DuckDB requires build tools for native compilation
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Copy shared directory first (for dependency resolution)
COPY shared /app/shared
WORKDIR /app/shared
RUN npm install

# Set working directory back to server_file
WORKDIR /app/server_file

# Copy package files and install dependencies (if package.json exists with dependencies)
COPY server_file/package*.json ./
RUN if [ -f package.json ] && grep -q '"dependencies"' package.json; then npm ci --only=production || true; fi

# Copy the rest of the server_file application
COPY server_file/ ./

# Expose the port (default 8079, configurable via FILE_PORT env var)
EXPOSE 8079

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8079/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Run the application
CMD ["node", "server.js"]

