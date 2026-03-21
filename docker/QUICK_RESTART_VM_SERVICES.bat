@echo off
REM ============================================
REM Restart Docker Services on VM
REM Quick restart without full redeployment
REM ============================================

setlocal

set "SCRIPT_DIR=%~dp0"
set "CONFIG_FILE=%SCRIPT_DIR%deploy.config"

REM Check for local override config
set "LOCAL_CONFIG=%SCRIPT_DIR%deploy.config.local"
if exist "%LOCAL_CONFIG%" (
    set "CONFIG_FILE=%LOCAL_CONFIG%"
)

REM Load config
if not exist "%CONFIG_FILE%" (
    echo [ERROR] Config file not found: %CONFIG_FILE%
    pause
    exit /b 1
)

for /f "usebackq tokens=1,2 delims==" %%a in ("%CONFIG_FILE%") do (
    if not "%%a"=="" if not "%%a"=="#" set "%%a=%%b"
)

REM Validate required config
if "%SSH_HOST%"=="" (
    echo [ERROR] SSH_HOST not configured
    pause
    exit /b 1
)
if "%SSH_USER%"=="" (
    echo [ERROR] SSH_USER not configured
    pause
    exit /b 1
)
if "%SSH_KEY%"=="" (
    echo [ERROR] SSH_KEY not configured
    pause
    exit /b 1
)
if "%VM_BASE_PATH%"=="" (
    echo [ERROR] VM_BASE_PATH not configured
    pause
    exit /b 1
)

REM Validate SSH key exists
if not exist "%SSH_KEY%" (
    echo [ERROR] SSH key not found: %SSH_KEY%
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Restarting Docker Services on VM
echo ============================================
echo.

echo [INFO] Stopping containers...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "cd %VM_BASE_PATH% && docker compose down --remove-orphans 2>/dev/null || true"

echo [INFO] Force stopping all hunico containers...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker stop hunico-redis hunico-node hunico-python hunico-nginx 2>/dev/null || true"

echo [INFO] Removing all hunico containers...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker rm -f hunico-redis hunico-node hunico-python hunico-nginx 2>/dev/null || true"

echo [INFO] Removing problematic network...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker network rm hunico-network 2>/dev/null || true"

echo [INFO] Removing all hunico networks...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker network ls --filter 'name=hunico' --format '{{.Name}}' | xargs -r docker network rm 2>/dev/null || true"

echo [INFO] Starting containers with fresh network...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "cd %VM_BASE_PATH% && docker compose up -d 2>&1"
if errorlevel 1 (
    echo [ERROR] Failed to start containers
    echo [INFO] Showing docker-compose.yml location...
    ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "ls -la %VM_BASE_PATH%/docker-compose.yml"
    pause
    exit /b 1
)

echo.
echo [INFO] Waiting 5 seconds for services to start...
timeout /t 5 /nobreak >nul

echo.
echo [INFO] Container status:
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"

echo.
echo [INFO] Testing connectivity from nginx to node:
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx wget -q -O- http://node:8069/api/health 2>&1 || echo 'FAILED: Cannot reach node'"

echo.
echo [SUCCESS] Restart complete!
echo.
pause
