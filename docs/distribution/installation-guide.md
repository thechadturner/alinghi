# Docker Installation and Service Management

This guide explains how to install Docker on the production VM and manage the RaceSight services.

## Prerequisites

- SSH access to the production VM
- Root or sudo access on the VM
- Ubuntu/Debian-based Linux system

## Step 1: Install Docker

SSH to your VM and run the installation script:

```bash
ssh -i "your-key.pem" racesight@20.224.64.96
cd /home/racesight/racesight/servers/docker
sudo bash install-docker.sh
```

The script will:
- Install Docker Engine
- Install docker-compose (plugin or standalone)
- Start and enable Docker service
- Add your user to the docker group (if running with sudo)

**Important**: If the script adds you to the docker group, you need to log out and back in for the changes to take effect.

## Step 2: Verify Installation

After installation, verify Docker is working:

```bash
docker --version
docker-compose --version
# or
docker compose version
```

Test Docker with:

```bash
docker run hello-world
```

## Step 3: Run VM Setup (if not already done)

```bash
cd /home/racesight/racesight/servers/docker
sudo bash setup-vm.sh
```

This creates the necessary directories and Docker network.

## Step 4: Start Services

Once Docker is installed and the deployment is complete, start all services:

```bash
cd /home/racesight/racesight
bash servers/docker/start-services.sh
```

Or if the scripts are in the base directory:

```bash
cd /home/racesight/racesight
bash docker/start-services.sh
```

## Service Management Scripts

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

## Manual Service Management

You can also manage services manually using docker-compose:

```bash
cd /home/racesight/racesight

# Start services
docker-compose -f docker-compose.yml up -d --build

# Stop services
docker-compose -f docker-compose.yml down

# View logs
docker-compose -f docker-compose.yml logs -f

# View logs for specific service
docker-compose -f docker-compose.yml logs -f node
docker-compose -f docker-compose.yml logs -f python
docker-compose -f docker-compose.yml logs -f redis
docker-compose -f docker-compose.yml logs -f nginx

# Check status
docker-compose -f docker-compose.yml ps

# Restart a specific service
docker-compose -f docker-compose.yml restart node
```

## Troubleshooting

### Docker Permission Denied

If you get "permission denied" errors:

```bash
# Add your user to docker group (if not already done)
sudo usermod -aG docker $USER

# Log out and back in, or run:
newgrp docker

# Or run commands with sudo
sudo docker ps
```

### Services Won't Start

1. Check Docker is running:
   ```bash
   sudo systemctl status docker
   ```

2. Check logs:
   ```bash
   docker-compose -f docker-compose.yml logs
   ```

3. Check disk space:
   ```bash
   df -h
   ```

4. Check ports are available:
   ```bash
   netstat -tulpn | grep -E '8069|8059|8079|8089|8099|8049|80|443'
   ```

### Rebuild Services After Code Changes

After deploying new code:

```bash
cd /home/racesight/racesight
docker-compose -f docker-compose.yml up -d --build
```

This rebuilds the images with the new code.

## Service Ports

- **nginx**: 80 (HTTP), 443 (HTTPS)
- **node (app)**: 8069
- **node (admin)**: 8059
- **node (file)**: 8079
- **node (media)**: 8089
- **node (stream)**: 8099
- **python**: 8049
- **redis**: 6379

## Health Checks

Check if services are healthy:

```bash
# Check all services
docker-compose -f docker-compose.yml ps

# Check specific service health
docker inspect hunico-node --format='{{.State.Health.Status}}'
docker inspect hunico-python --format='{{.State.Health.Status}}'
```

## Next Steps

After services are running:

1. Verify services are accessible:
   ```bash
   curl http://localhost/api/health
   ```

2. Check nginx is serving the frontend:
   ```bash
   curl http://localhost/
   ```

3. Monitor logs:
   ```bash
   docker-compose -f docker-compose.yml logs -f
   ```

## Docker Desktop for Windows (Development)

For local development on Windows, you can use Docker Desktop. See the [Docker Services documentation](./docker-services.md) for details on local development setup.

