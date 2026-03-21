#!/bin/bash
# Docker Installation Script for RaceSight production VM
# This script installs Docker and docker-compose on Ubuntu/Debian systems

set -e

echo "============================================"
echo "  Docker Installation Script"
echo "============================================"
echo

# Check if running as root or with sudo
if [ "$EUID" -ne 0 ]; then 
    echo "[ERROR] Please run this script as root or with sudo"
    echo "Usage: sudo bash install-docker.sh"
    exit 1
fi

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    VER=$VERSION_ID
else
    echo "[ERROR] Cannot detect OS version"
    exit 1
fi

echo "[INFO] Detected OS: $OS $VER"
echo

# Check if Docker is already installed
if command -v docker >/dev/null 2>&1; then
    echo "[INFO] Docker is already installed"
    docker --version
    DOCKER_INSTALLED=true
else
    DOCKER_INSTALLED=false
fi

# Check if docker-compose is already installed
if command -v docker-compose >/dev/null 2>&1 || docker compose version >/dev/null 2>&1; then
    echo "[INFO] docker-compose is already installed"
    if command -v docker-compose >/dev/null 2>&1; then
        docker-compose --version
    else
        docker compose version
    fi
    COMPOSE_INSTALLED=true
else
    COMPOSE_INSTALLED=false
fi

if [ "$DOCKER_INSTALLED" = true ] && [ "$COMPOSE_INSTALLED" = true ]; then
    echo
    echo "[SUCCESS] Docker and docker-compose are already installed!"
    echo "[INFO] Skipping installation"
    exit 0
fi

echo
echo "[INFO] Starting Docker installation..."
echo

# Update package index
echo "[INFO] Updating package index..."
apt-get update -qq

# Install prerequisites
echo "[INFO] Installing prerequisites..."
apt-get install -y -qq \
    ca-certificates \
    curl \
    gnupg \
    lsb-release

# Add Docker's official GPG key
echo "[INFO] Adding Docker's official GPG key..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/$OS/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# Set up Docker repository
echo "[INFO] Setting up Docker repository..."
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

# Update package index again
echo "[INFO] Updating package index with Docker repository..."
apt-get update -qq

# Install Docker Engine
if [ "$DOCKER_INSTALLED" = false ]; then
    echo "[INFO] Installing Docker Engine..."
    apt-get install -y -qq \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin
    
    echo "[SUCCESS] Docker Engine installed"
else
    echo "[INFO] Docker Engine already installed, skipping"
fi

# Install docker-compose (standalone if not using plugin)
if [ "$COMPOSE_INSTALLED" = false ]; then
    echo "[INFO] Installing docker-compose..."
    # Try to use docker compose plugin first
    if docker compose version >/dev/null 2>&1; then
        echo "[SUCCESS] docker compose plugin is available"
    else
        # Install standalone docker-compose
        DOCKER_COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep 'tag_name' | cut -d\" -f4)
        echo "[INFO] Installing docker-compose standalone version $DOCKER_COMPOSE_VERSION..."
        curl -L "https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
        chmod +x /usr/local/bin/docker-compose
        echo "[SUCCESS] docker-compose installed"
    fi
else
    echo "[INFO] docker-compose already installed, skipping"
fi

# Start and enable Docker service
echo "[INFO] Starting Docker service..."
systemctl start docker
systemctl enable docker

# Add current user to docker group (if not root)
if [ "$SUDO_USER" ]; then
    echo "[INFO] Adding user $SUDO_USER to docker group..."
    usermod -aG docker $SUDO_USER
    echo "[INFO] User $SUDO_USER added to docker group"
    echo "[WARNING] User needs to log out and back in for group changes to take effect"
fi

# Verify installation
echo
echo "[INFO] Verifying installation..."
docker --version
if command -v docker-compose >/dev/null 2>&1; then
    docker-compose --version
elif docker compose version >/dev/null 2>&1; then
    docker compose version
fi

echo
echo "============================================"
echo "  Docker Installation Complete"
echo "============================================"
echo
echo "[SUCCESS] Docker and docker-compose are now installed!"
echo
echo "[INFO] Next steps:"
echo "  1. If you added a user to docker group, log out and back in"
echo "  2. Run: sudo bash setup-vm.sh (if not already done)"
echo "  3. Run: bash start-services.sh (to start all services)"
echo

