# Docker Configuration · RaceSight – Alinghi

This directory contains Docker-related configuration and scripts for **RaceSight – Alinghi** (this Git repository). Compose service names, networks, and image tags follow this repo’s conventions; see the [root README](../README.md) for edition context.

## Structure

```
docker/
├── compose/              # Docker Compose files for service orchestration
│   ├── python.yml       # Python FastAPI service
│   ├── node.yml         # Node.js services (all servers in one container)
│   ├── nginx.yml        # Nginx reverse proxy
│   └── production.yml   # Production deployment configuration
├── dockerfiles/          # Orchestration-level Dockerfiles
│   ├── Dockerfile.python # Python FastAPI service
│   └── Dockerfile.nodejs # Unified Node.js container (combines all servers)
├── nginx/                # Nginx configuration files
│   ├── nginx-dev.conf   # Development configuration
│   ├── nginx-prod.conf  # Production configuration
│   └── scripts/         # SSL certificate scripts
├── scripts/              # Shell scripts for container operations
│   └── start-servers.sh # Node.js multi-server startup script
├── docker-services.config # Service registry for batch scripts
├── deploy.config         # Deployment configuration template
├── deploy.config.local   # Local deployment configuration (gitignored)
└── *.bat                 # Windows batch scripts for Docker management
```

## Quick Start

### Start All Services
```cmd
docker\DOCKER_START_ALL.bat
```

### Stop All Services
```cmd
docker\stop-services.sh
```

### Deploy to Production
```cmd
docker\DEPLOY_VM_SERVERS.bat
docker\DEPLOY_VM_FRONTEND.bat
```

On a **new VM without Docker**, copy the installer then SSH in once: run `docker\PUSH_INSTALL_DOCKER_TO_VM.bat`, then `sudo bash /tmp/racesight-install-docker.sh` on the server. See [installation-guide](../docs/distribution/installation-guide.md).

## Service Configuration

Services are registered in `docker-services.config`. Each service entry defines:
- Service name
- Compose file location
- Environment file
- Default port
- Description

## Dockerfiles Location

**Dockerfiles** (all in `docker/dockerfiles/` for consistency):
- `docker/dockerfiles/Dockerfile.python` - Python FastAPI service
- `docker/dockerfiles/Dockerfile.nodejs` - Unified Node.js container (combines all servers: app, admin, file, media, stream)

## Host-mounted directories (data, media, scripts)

Data, media, and Python server scripts are stored on the host and mounted into containers at runtime (not baked into images):

- **Data**: `DATA_DIRECTORY` — mounted into Node and Python containers (host paths come from `deploy.config` / `.env`).
- **Media**: `MEDIA_DIRECTORY` — mounted into Node container.
- **Python scripts**: `SCRIPTS_DIRECTORY` — mounted into the Python container at `/app/server_python/scripts`. In production, `setup-vm.sh` creates the scripts directory and `DEPLOY_VM_SERVERS.bat` copies `server_python/scripts` into it. See `VM_SCRIPTS_PATH` in `deploy.config`.

## Deployment: Permission errors on VM

If server deploy fails during extraction with "Permission denied" or "Cannot mkdir", the VM deployment path has root-owned files. On the VM run once: `sudo chown -R <deploy-user>:<deploy-user> <VM_BASE_PATH>` (e.g. `sudo chown -R racesight:racesight /home/racesight/racesight`), then re-run the deploy script. See [Deployment Guide](../docs/distribution/deployment-guide.md#tar-extraction-permission-denied-or-cannot-mkdir) for details.

## Documentation

**All distribution and deployment documentation has been moved to `docs/distribution/`:**

- [Distribution Documentation](../docs/distribution/README.md) - Overview and index
- [Deployment Guide](../docs/distribution/deployment-guide.md) - Production deployment instructions
- [Installation Guide](../docs/distribution/installation-guide.md) - Docker installation and setup
- [HTTPS/SSL Setup](../docs/distribution/https-ssl-setup.md) - SSL certificate configuration
- [Docker Services](../docs/distribution/docker-services.md) - Technical documentation for services
- [Docker Scripts](../docs/distribution/docker-scripts.md) - Batch scripts and automation tools

