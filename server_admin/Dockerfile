# Use Node.js LTS version as base
FROM node:20-slim

# Set working directory
WORKDIR /app

# Install system dependencies if needed
# ffmpeg required for video upload processing (low_res, med_res, high_res renditions)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy shared directory first (for dependency resolution)
COPY shared /app/shared
WORKDIR /app/shared
RUN npm install

# Set working directory back to server_admin
WORKDIR /app/server_admin

# Copy package files and install dependencies
COPY server_admin/package*.json ./
RUN npm ci --only=production

# Copy the rest of the server_admin application
COPY server_admin/ ./

# Copy scripts directory (needed for truncate_datasets_cascade.js)
COPY scripts /app/scripts

# Expose the port (default 8059, configurable via ADMIN_PORT env var)
EXPOSE 8059

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8059/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Run the application
CMD ["node", "server.js"]

