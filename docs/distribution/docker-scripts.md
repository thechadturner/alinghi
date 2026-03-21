# Docker Management Scripts

This document describes the batch scripts and automation tools for managing Docker containers.

## Overview

The project includes batch scripts to manage Docker containers for multiple services. These scripts provide a convenient way to start, stop, and manage services without manually running docker-compose commands.

## Quick Start

### Simple Commands (Default Service)

```batch
REM Start the default service (server_python)
docker-start.bat

REM Stop the default service
docker-stop.bat
```

### Advanced Management

```batch
REM Interactive menu
docker-server.bat

REM Or use commands directly
docker-server.bat up
docker-server.bat logs
docker-server.bat status
```

## Multi-Service Support

### Configuration File

Services are defined in `docker/docker-services.config`:

```
SERVICE_NAME|COMPOSE_FILE|ENV_FILE|PORT|DESCRIPTION
```

Example:
```
server_python|server_python\docker-compose.yml|server_python\.env|8049|Python FastAPI Server
server_node|server_node\docker-compose.yml|server_node\.env|3000|Node.js Server
database|database\docker-compose.yml|database\.env|5432|PostgreSQL Database
```

### Using Multiple Services

```batch
REM Start a specific service
docker-start.bat server_python
docker-start.bat server_node

REM Stop a specific service
docker-stop.bat server_python
docker-stop.bat server_node

REM Advanced management for specific service
docker-server.bat server_python up
docker-server.bat server_node logs
docker-server.bat database status
```

## Available Commands

### docker-start.bat
- Builds and starts a service
- Usage: `docker-start.bat [service_name]`
- Default: `server_python`

### docker-stop.bat
- Stops a service
- Usage: `docker-stop.bat [service_name]`
- Default: `server_python`

### docker-server.bat
- Full management interface with menu
- Usage: `docker-server.bat [service_name] [command]`
- Commands: `build`, `up`, `start`, `stop`, `restart`, `down`, `logs`, `status`, `rebuild`, `shell`, `list`, `help`

## Service Management Scripts (Linux/VM)

All service management scripts are located in `/home/racesight/racesight/servers/docker/` or `/home/racesight/racesight/docker/`:

### Start Services
```bash
bash start-services.sh
```
Starts all Docker containers and builds images if needed.

### Stop Services
```bash
bash stop-services.sh
```
Stops all Docker containers gracefully.

### Restart Services
```bash
bash restart-services.sh
```
Stops and then starts all services.

### Check Status
```bash
bash status-services.sh
```
Shows the status of all running containers.

## Adding a New Service

1. Create your service directory (e.g., `server_node/`)
2. Add Docker configuration files (`Dockerfile`, `docker-compose.yml`)
3. Add entry to `docker/docker-services.config`:
   ```
   server_node|server_node\docker-compose.yml|server_node\.env|3000|Node.js Server
   ```
4. Use the scripts with the new service name:
   ```batch
   docker-start.bat server_node
   ```

## Examples

```batch
REM Start default service
docker-start.bat

REM Start specific service
docker-start.bat server_python

REM View logs for a service
docker-server.bat server_python logs

REM Check status of all services
docker-server.bat server_python status
docker-server.bat server_node status

REM List all available services
docker-server.bat list
```

## Notes

- All scripts check if Docker is running before executing
- Scripts automatically load service configuration from `docker-services.config`
- Environment variables are loaded from service-specific `.env` files
- Default service is `server_python` if no service name is provided

