# Production Deployment Guide

This guide explains how to deploy the RaceSight application to a production Linux VM.

## Prerequisites

1. **SSH Access**: You need SSH access to the production VM with a private key
2. **Local Build Tools**: Node.js and npm installed locally
3. **VM Requirements**: 
   - Docker and docker-compose installed on the VM
   - Sufficient disk space for the application
   - Network access for Docker to pull images

## Configuration

### 1. Create Deployment Configuration

Copy `docker/deploy.config` to `docker/deploy.config.local` and customize:

```bash
# SSH Connection Details
SSH_HOST=20.224.64.96
SSH_USER=racesight
SSH_KEY=C:\Users\guyt2\OneDrive\Projects\AzureVM\RaceSight\racesight-azure-vm.pub.pem

# VM Deployment Paths
VM_BASE_PATH=/home/racesight/racesight
VM_FRONTEND_PATH=/home/racesight/racesight/frontend
VM_SERVERS_PATH=/home/racesight/racesight/servers
VM_DATA_PATH=/home/racesight/racesight/data
VM_MEDIA_PATH=/home/racesight/racesight/media
```

**Note**: `deploy.config.local` is gitignored and should not be committed. If your VM still uses a legacy deployment root (for example `/home/racesight/hunico`), set `VM_BASE_PATH` and related paths in `deploy.config.local` to match the server.

### 2. Create Production Environment Files

1. Copy `.env.production.template` to `.env.production` and customize non-secret values
2. Create `.env.production.local` with your production secrets:
   - `JWT_SECRET`
   - `SYSTEM_KEY`
   - `PAT_TOKEN`
   - `SUPER_USER`
   - `DB_HOST`
   - `DB_PASSWORD`
   - `REDIS_PASSWORD` (if required)

**Note**: `.env.production.local` is gitignored and should not be committed.

## Initial VM Setup

On the VM, run the setup script once (or it will be run automatically during deployment):

```bash
# SSH to VM
ssh -i <your-key> racesight@20.224.64.96

# Run setup script
cd /home/racesight/racesight
bash servers/docker/setup-vm.sh
```

This script will:
- Create directory structure
- Set up Docker network
- Create data/media directories
- Set proper permissions

## Deployment Process

### Frontend Deployment

Run the frontend deployment script from your local machine:

```bash
docker\DEPLOY_FRONTEND.bat
```

This script will:
1. Build the frontend (`npm run build`)
2. Package the `dist/` folder
3. Deploy to VM via SSH/SCP
4. Set proper permissions

### Server Deployment

Run the server deployment script from your local machine:

```bash
docker\DEPLOY_SERVERS.bat
```

This script will:
1. Build HuniDB library (`npm run build:hunidb`)
2. Package all server code and Docker configurations (excluding `node_modules`)
3. Deploy to VM via SSH/SCP
4. Install dependencies on VM (`npm install` for each server)
5. Deploy environment files
6. Optionally restart services (if `DEPLOY_RESTART_SERVICES=true`)

**Note**: `node_modules` directories are excluded from deployment and installed on the VM to ensure platform-specific binaries are correct for Linux.

## VM Directory Structure

After deployment, the VM will have this structure:

```
/home/racesight/racesight/
├── frontend/              # Production frontend build
│   ├── index.html
│   ├── assets/
│   └── ...
├── servers/               # Server code and Docker configs
│   ├── server_app/
│   ├── server_admin/
│   ├── server_file/
│   ├── server_media/
│   ├── server_stream/
│   ├── server_python/
│   ├── shared/
│   ├── libs/
│   └── docker/
│       ├── compose/
│       ├── dockerfiles/
│       └── nginx/
├── data/                  # Data storage (mounted in Docker)
├── media/                 # Media storage (mounted in Docker)
├── docker-compose.yml     # Production Docker Compose file
├── .env.production        # Production environment (non-secrets)
└── .env.production.local  # Production secrets (gitignored)
```

## Starting Services on VM

After deployment, start the services:

```bash
# SSH to VM
ssh -i <your-key> racesight@20.224.64.96

# Navigate to base directory
cd /home/racesight/racesight

# Start all services
docker-compose -f docker-compose.yml up -d --build

# View logs
docker-compose -f docker-compose.yml logs -f

# Stop services
docker-compose -f docker-compose.yml down
```

## Services

The deployment includes these Docker services:

- **redis**: Redis cache (port 6379)
- **node**: All Node.js servers (ports 8069, 8059, 8079, 8089, 8099)
- **python**: Python/FastAPI server (port 8049)
- **nginx**: Reverse proxy and HTTPS server (ports 80, 443)

## Troubleshooting

### SSH Connection Issues

- Verify SSH key path in `deploy.config.local`
- Check SSH key permissions (should be readable)
- Test SSH connection manually: `ssh -i <key> <user>@<host>`

### Build Failures

- Ensure all dependencies are installed: `npm install`
- Check for build errors in the console output
- Verify Node.js version compatibility

### Deployment Failures

- Check VM disk space: `df -h`
- Verify Docker is running on VM: `docker ps`
- Check Docker network exists: `docker network ls | grep hunico-network`

### Tar extraction: "Permission denied" or "Cannot mkdir"

If the deploy script fails during "Extracting files on VM" with errors like `tar: servers/docker: Cannot mkdir: Permission denied` or `Cannot utime: Operation not permitted`, the VM has root-owned (or otherwise restricted) files under the deployment path. The deploy user cannot overwrite them.

**Fix on the VM (one-time):** SSH in and give the deploy user ownership of the deployment tree, then re-run the deploy script from your machine.

```bash
# SSH to VM (use your key and user from deploy.config)
ssh -i <your-key> <SSH_USER>@<SSH_HOST>

# Fix ownership (replace <SSH_USER> and path with your VM_BASE_PATH)
sudo chown -R <SSH_USER>:<SSH_USER> /home/racesight/racesight

# Exit and re-run from Windows: docker\DEPLOY_VM_SERVERS.bat
```

The deploy script now runs `sudo chown -R` before cleanup when possible; if your user has passwordless sudo for `chown`, that may prevent this. Otherwise run the one-time fix above.

### Service Startup Issues

- Check logs: `docker-compose -f docker-compose.yml logs`
- Verify environment files exist and are readable
- Check port availability: `netstat -tulpn | grep <port>`

### Environment Variable Issues

- Ensure `.env.production` and `.env.production.local` are in the base directory
- Verify required secrets are set in `.env.production.local`
- Check Docker container environment: `docker exec <container> env`

## Dry Run Mode

To test deployment without making changes:

1. Set `DEPLOY_DRY_RUN=true` in `deploy.config.local`
2. Run deployment scripts
3. Review what would be deployed

## Updating Services

To update services after code changes:

1. Make your code changes locally
2. Run `docker\DEPLOY_SERVERS.bat` (or `DEPLOY_FRONTEND.bat` for frontend)
3. Services will be restarted automatically if `DEPLOY_RESTART_SERVICES=true`

To manually restart services on VM:

```bash
cd /home/racesight/racesight
docker-compose -f docker-compose.yml down
docker-compose -f docker-compose.yml up -d --build
```

## SSL/HTTPS Setup

For HTTPS support, see the [HTTPS/SSL Setup Guide](./https-ssl-setup.md).

## Security Notes

- Never commit `.env.production.local` or `deploy.config.local`
- Use strong secrets for JWT_SECRET, SYSTEM_KEY, and database passwords
- Keep SSH keys secure and use proper permissions
- Regularly update dependencies and Docker images
- Monitor logs for security issues

## Support

For issues or questions:
1. Check logs on VM: `docker-compose -f docker-compose.yml logs`
2. Review deployment script output for errors
3. Verify configuration files are correct
4. Test SSH connection manually

