# Network Configuration Guide

This guide explains how to configure the application for different networks and environments using environment variables.

## Environment Variables

### Network Mode Configuration

Set `VITE_NETWORK_MODE` to control how the application determines network configuration:

```bash
# Auto-detect (recommended for most cases)
VITE_NETWORK_MODE=auto

# Force localhost (development)
VITE_NETWORK_MODE=localhost

# Force network IP (production)
VITE_NETWORK_MODE=network

# Use custom host
VITE_NETWORK_MODE=custom
VITE_CUSTOM_HOST=192.168.1.100
```

### Port Configuration

Note: Port configuration is no longer needed for the frontend since all requests go through nginx using relative URLs. The backend services still use these ports internally, but the frontend always accesses them via nginx routes.

### Nginx Reverse Proxy

The application always uses nginx as a reverse proxy. All API routes go through nginx (port 80):
- Frontend uses relative URLs (`/api`, `/api/media/video`, etc.)
- All API routes go through nginx (port 80)
- Vite dev server is proxied through nginx (HMR works via nginx WebSocket proxy)
- Production builds are served by nginx

## Configuration Modes

### 1. Auto Mode (Default)
```bash
VITE_NETWORK_MODE=auto
```
- **Localhost**: When accessing via `localhost` or `127.0.0.1`, uses localhost for all services
- **Network IP**: When accessing via network IP (e.g., `192.168.1.100`), uses the same IP for all services
- **Best for**: Most use cases, automatically adapts to the environment

### 2. Localhost Mode
```bash
VITE_NETWORK_MODE=localhost
```
- **Always uses**: `localhost` for all services regardless of access method
- **Best for**: Development when you want to force localhost usage

### 3. Network Mode
```bash
VITE_NETWORK_MODE=network
```
- **Always uses**: Current hostname for all services
- **Best for**: Production when you want to force network IP usage

### 4. Custom Mode
```bash
VITE_NETWORK_MODE=custom
VITE_CUSTOM_HOST=192.168.1.100
```
- **Always uses**: The specified custom host for all services
- **Best for**: Specific network configurations or load balancers

## Example Configurations

### Development (Local)
```bash
VITE_NETWORK_MODE=auto
VITE_API_HOST=http://localhost
VITE_APP_PORT=8069
VITE_MEDIA_PORT=8089
```

### Production (Network)
```bash
VITE_NETWORK_MODE=auto
VITE_API_HOST=http://192.168.1.100
VITE_APP_PORT=8069
VITE_MEDIA_PORT=8089
```

### Load Balancer/Proxy
```bash
VITE_NETWORK_MODE=custom
VITE_CUSTOM_HOST=myapp.company.com
VITE_API_HOST=https://api.company.com
VITE_APP_PORT=443
VITE_MEDIA_PORT=443
```

### Nginx Configuration
- **Frontend**: Access via `http://localhost` (nginx on port 80)
- **API routes**: All go through nginx (`/api/*`)
- **Development**: Vite dev server proxied through nginx (HMR works)
- **Production**: Static files served by nginx

## Server Configuration

### Media Server
The media server automatically binds to `0.0.0.0` to accept connections from any network interface.

**Docker Path Conversion**: When running in Docker, the media server automatically converts Windows file paths to container paths:
- Windows paths from database: `C:\MyApps\RaceSight\Uploads\Media\System\...`
- Container paths: `/media/System/...` (mounted volume)
- Conversion happens automatically - no configuration needed

**Video Quality**: Videos default to `high_res` quality and only downgrade when buffering is detected during playback.

### CORS Configuration
The servers are configured to accept requests from any origin when no specific CORS origins are set.

## Troubleshooting

### Video Not Loading
1. Check if `VITE_NETWORK_MODE` is set correctly
2. Verify the media server is running on the correct port
3. Check browser console for network configuration logs
4. Test media server connectivity: `http://your-ip:8089/api/health`
5. **Docker-specific**: Check that video paths are being converted correctly
   - Media server logs show: `Path converted: C:\... -> /media/...`
   - Verify files exist in container: `docker exec node ls -la /media/System/...`
6. **Video Quality**: Check browser console for quality selection
   - Default should be `high_res`
   - Only downgrades if buffering is detected during playback

### Network Access Issues
1. Ensure the media server is bound to `0.0.0.0` (not `127.0.0.1`)
2. Check firewall settings
3. Verify the network IP is accessible from client machines
4. **Docker**: Ensure media directory is properly mounted in docker-compose.yml

### Video Quality Issues
1. **Defaulting to low_res**: 
   - Check browser console for quality selection logs
   - Verify `currentQuality` signal is initialized to `high_res`
   - Check if buffering detection is triggering incorrectly (should only trigger during playback)
2. **Buffering detection**:
   - Only triggers when video is actually playing (`currentTime > 0`)
   - Requires 5-second grace period before downgrading
   - Check logs for "Playback performance issues detected"

### Development vs Production

**Development**:
- Access: `http://localhost` (nginx proxies to Vite dev server on port 3000)
- API: Through nginx (`/api/*` routes)
- HMR: Works through nginx WebSocket proxy

**Production**:
```bash
npm run build  # Build frontend first
```
- Access: `http://localhost` (nginx serves static files)
- API: Through nginx (`/api/*` routes)

**Custom setups**: Use `VITE_NETWORK_MODE=custom` with `VITE_CUSTOM_HOST`

## Migration Between Networks

When moving the application to a different computer or network:

1. **No changes needed** if using `VITE_NETWORK_MODE=auto` (recommended)
2. **Update IP addresses** if using custom mode
3. **Restart services** after configuration changes
4. **Test connectivity** using the health endpoints

## Health Endpoints

Test service connectivity:
- **API**: `http://your-ip:8069/api/health`
- **Media**: `http://your-ip:8089/api/health`
- **File**: `http://your-ip:8079/api/health`
- **Admin**: `http://your-ip:8059/api/health`
