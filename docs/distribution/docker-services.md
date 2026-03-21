# Docker Services Documentation

This document provides technical documentation for the Docker services used in the Hunico application.

## Service Overview

The Hunico application uses the following Docker services:

- **Node.js Services**: Unified container running multiple Node.js servers (app, admin, file, media, stream)
- **Python Service**: FastAPI server for data processing
- **Redis**: Cache and session storage
- **Nginx**: Reverse proxy and static file server

## Node.js Services

### Architecture

All Node.js servers run in a unified Docker container managed by `docker/compose/node.yml`. The container runs multiple servers using a startup script (`docker/scripts/start-servers.sh`).

### Services in Container

- **server_app**: Main application API server (port 8069)
- **server_admin**: Admin API server (port 8059)
- **server_file**: File API server (port 8079)
- **server_media**: Media streaming server (port 8089)
- **server_stream**: Streaming service (port 8099)

### Building the Docker Image

From the workspace root directory:

```bash
# Build using Docker Compose
docker-compose -f docker/compose/node.yml build

# Or build directly
docker build -f docker/dockerfiles/Dockerfile.nodejs -t hunico-node:latest .
```

### Running the Container

Using Docker Compose (recommended):

```bash
docker-compose -f docker/compose/node.yml up -d
```

### Environment Variables

#### Required Variables

- **JWT_SECRET** (required): Secret key for JWT token validation
- **SYSTEM_KEY** (required): System key for authentication (also used as PAT fallback)

#### Port Configuration

- **APP_PORT**: Port for the main application API server (default: 8069)
- **ADMIN_PORT**: Port for the admin API server (default: 8059)
- **FILE_PORT**: Port for the file API server (default: 8079)
- **MEDIA_PORT**: Port for the media streaming server (default: 8089)
- **STREAM_PORT**: Port for the streaming service (default: 8099)

#### Network Configuration

- **API_HOST**: Host for API services (default: host.docker.internal)
  - Use `host.docker.internal` on Windows/Mac Docker Desktop to access host machine
  - **Alternative**: Use your actual host IP address (e.g., `192.168.0.18`) for more reliable connections
  - On Linux, use the host's IP address or `172.17.0.1` (Docker bridge gateway)

#### Database Configuration

- **DB_HOST**: PostgreSQL host (default: 192.168.0.18)
  - **Recommended**: Use your actual host machine IP address
  - **Important**: Set this in your `.env` file. Do NOT set it in the `environment:` section of docker-compose.yml to avoid conflicts
  - **PostgreSQL Configuration**: Ensure `pg_hba.conf` allows connections from the Docker container IP
- **DB_PORT**: PostgreSQL port (default: 5432)
- **DB_NAME**: Database name (default: hunico)
- **DB_USER**: Database user (default: postgres)
- **DB_PASSWORD**: Database password (required)
- **DB_SSL**: Enable SSL for database connections (default: false for local development, true for hosted PostgreSQL)
- **DB_SSL_REJECT_UNAUTHORIZED**: Reject unauthorized SSL certificates (default: false)

#### CORS Configuration

- **CORS_ORIGINS**: Comma-separated list of allowed CORS origins (default: *)
  - Example: `http://localhost:3000,http://localhost:5173,https://app.example.com`

### File Storage and Volumes

The servers use file paths for storing uploads and media files. By default, these paths are configured via environment variables:

- **DATA_DIRECTORY**: Directory for data file uploads (default: `C:/MyApps/Hunico/Uploads/Data`)
- **MEDIA_DIRECTORY**: Directory for media files (default: `C:/MyApps/Hunico/Uploads/Media`)

#### Path Conversion in Docker

When running in Docker, the media server automatically converts Windows file paths to container paths:

- **Windows paths** (from database): `C:\MyApps\Hunico\Uploads\Media\System\1\ac75\20240905\youtube\{res}\video1.mp4`
- **Container paths** (actual file access): `/media/System/1/ac75/20240905/youtube/high_res/video1.mp4`

The conversion:
1. Detects Windows paths (drive letters like `C:`)
2. Extracts the path after `/Media/` or `\Media\`
3. Prepends `/media` (the mounted volume path)
4. Handles both forward slashes and backslashes

### Health Checks

Each container includes a health check that pings `/api/health` every 30 seconds. Check health status:

```bash
docker ps
```

Or view detailed health status:

```bash
docker inspect --format='{{json .State.Health}}' hunico-node | jq
```

### Troubleshooting

#### Container won't start

1. Check logs:
   ```bash
   docker-compose -f docker/compose/node.yml logs node
   ```

2. Verify environment variables are set correctly:
   ```bash
   docker exec hunico-node env | grep JWT_SECRET
   ```

3. Check database connectivity:
   ```bash
   docker exec hunico-node node -e "require('pg').Pool({host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME}).query('SELECT 1', (err, res) => console.log(err || 'Connected'))"
   ```

#### Database connection issues

1. **Verify DB_HOST is set correctly**:
   ```bash
   docker exec hunico-node sh -c "echo DB_HOST=\$DB_HOST"
   ```
   - Should show your actual IP (e.g., `192.168.0.18`), not `localhost`

2. **Check PostgreSQL pg_hba.conf**:
   - Ensure your PostgreSQL `pg_hba.conf` allows connections from the Docker container
   - Add entry: `host hunico postgres 192.168.0.18/32 md5`
   - Restart PostgreSQL after changes

3. **Test database connection**:
   ```bash
   docker exec hunico-node node -e "const {Pool}=require('pg');const p=new Pool({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,ssl:process.env.DB_SSL==='true'});p.query('SELECT 1',(e,r)=>console.log(e?'Error:'+e.message:'Connected'))"
   ```

## Python Service

### Architecture

The Python service runs as a separate Docker container managed by `docker/compose/python.yml`. It provides FastAPI endpoints for data processing.

### Building the Docker Image

From the workspace root directory:

```bash
# Build using Docker Compose
docker-compose -f docker/compose/python.yml build

# Or build directly
docker build -f docker/dockerfiles/Dockerfile.python -t hunico-python:latest .
```

### Running the Container

Using Docker Compose (recommended):

```bash
docker-compose -f docker/compose/python.yml up -d
```

### Environment Variables

#### Required Variables

- **JWT_SECRET** (required): Secret key for JWT token validation
- **SYSTEM_KEY** (required): System key for authentication (also used as PAT fallback)

#### Optional Variables

- **PYTHON_PORT**: Port for the Python service/FastAPI server (default: 8049)
- **APP_PORT**: Port for the main application API (default: 8069, used for external validation)
- **API_HOST**: Host for the main application API (default: localhost, used for external validation)
- **JWT_ISSUER**: JWT issuer claim for token validation (optional)
- **JWT_AUDIENCE**: JWT audience claim for token validation (optional)
- **PAT_TOKEN**: Personal Access Token (optional, falls back to SYSTEM_KEY if not set)
- **CORS_ORIGINS**: Comma-separated list of allowed CORS origins (default: *)
- **VITE_VERBOSE**: Enable verbose logging (default: false)
- **VALIDATE_WITH_EXTERNAL_SERVICE**: Enable external user validation (default: false)

### Health Check

The container includes a health check that pings `/api/health` every 30 seconds. Check health status:

```bash
docker ps
```

Or view logs:

```bash
docker logs hunico-python
```

### Development

For development, the docker-compose.yml can mount the `scripts` directory as a volume for live code reloading. For production, remove the volumes section from docker-compose.yml.

## Nginx Reverse Proxy

The application always uses nginx as a reverse proxy. All API routes go through nginx, providing a consistent development and production experience.

### Development Mode

1. **Start services**:
   ```bash
   docker-compose -f docker/compose/node.yml up -d
   docker-compose -f docker/compose/python.yml up -d
   docker-compose -f docker/compose/nginx.yml up -d
   npm run dev  # Start Vite dev server on host
   ```

2. **Access application**: `http://localhost` (nginx on port 80)
   - Frontend: Proxied to Vite dev server (port 3000)
   - API routes: Proxied to Docker containers
   - HMR: Works through nginx WebSocket proxy

### Production Mode

1. **Build frontend**:
   ```bash
   npm run build
   ```

2. **Start services**:
   ```bash
   docker-compose -f docker/compose/node.yml up -d
   docker-compose -f docker/compose/python.yml up -d
   docker-compose -f docker/compose/nginx.yml up -d
   ```

3. **Access application**: `http://localhost` (nginx serves static files)
   - Frontend: Static files from `/usr/share/nginx/html`
   - API routes: Proxied to Docker containers

### Nginx Configuration Files

- **`docker/nginx/nginx-dev.conf`**: Development config (proxies to Vite dev server)
- **`docker/nginx/nginx-prod.conf`**: Production config (serves static files)

The docker-compose file automatically uses the appropriate config based on whether `dist` directory exists.

### Troubleshooting Nginx

1. **HMR not working**:
   - Check nginx logs: `docker logs nginx`
   - Verify WebSocket upgrade headers are being forwarded
   - Ensure `clientPort: 80` is set in `vite.config.mjs`

2. **API routes not working**:
   - Verify nginx is running: `docker ps | grep nginx`
   - Check nginx config: `docker exec nginx cat /etc/nginx/conf.d/default.conf`
   - Test health endpoint: `curl http://localhost/health`

3. **Video streaming issues**:
   - Check nginx logs for video requests
   - Verify `proxy_buffering off` is set in nginx config
   - Test direct media server: `http://localhost:8089/api/health`

## Production Recommendations

For production environments:

1. **Use a secrets management system** (Docker Secrets, Kubernetes Secrets, AWS Secrets Manager, etc.)
2. **Never commit `.env` files** with real secrets
3. **Use strong, randomly generated values** for `JWT_SECRET` and `SYSTEM_KEY`
4. **Restrict `CORS_ORIGINS`** to specific domains (avoid using `*`)
5. **Use nginx reverse proxy** (always enabled)
6. **Set up SSL/TLS** (see [HTTPS/SSL Setup Guide](./https-ssl-setup.md))
7. **Set up proper logging** aggregation (ELK stack, CloudWatch, etc.)
8. **Use Docker networks** for service isolation
9. **Implement resource limits** in docker-compose.yml:
   ```yaml
   deploy:
     resources:
       limits:
         cpus: '1'
         memory: 512M
   ```

## Notes

- The build context is set to the workspace root (`.`) to access both individual servers and the `shared` directory
- The `shared` package is installed first to ensure dependencies are available
- All servers use Node.js 20 LTS
- Containers run with production dependencies only (`npm ci --only=production`)
- Health checks are configured for all services
- All servers are connected via a shared Docker network for inter-service communication
- **Environment Variable Precedence**: `process.env` (from Docker) takes precedence over `.env` file values
- **DB_HOST**: Should be set in `.env` file only, not in docker-compose.yml `environment:` section to avoid conflicts

