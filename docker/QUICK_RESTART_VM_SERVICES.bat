@echo off
REM ============================================
REM Restart Docker Services on VM
REM Quick restart without full redeployment
REM Pushes docker\nginx\nginx-prod.conf from this repo to the VM each run ^(no full deploy needed^).
REM After compose up, runs docker\scripts\quick-restart-connectivity.sh: data/media mounts + /api/ready ^(Postgres^).
REM SSH: set SSH_KEY in deploy.config.local for key auth; else one password per run ^(mux off by default^).
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
if "%VM_BASE_PATH%"=="" (
    echo [ERROR] VM_BASE_PATH not configured
    pause
    exit /b 1
)

call "%SCRIPT_DIR%set-deploy-ssh-opts.bat"
if errorlevel 1 (
    pause
    exit /b 1
)
REM Do not call establish-ssh-mux.bat here: with default empty SSH_MUX_OPTS it only adds an extra
REM SSH (second password). All work runs in one ssh below.

set "NGINX_PROD_LOCAL=%SCRIPT_DIR%nginx\nginx-prod.conf"
if not exist "%NGINX_PROD_LOCAL%" (
    echo [ERROR] Missing local nginx config: %NGINX_PROD_LOCAL%
    echo [ERROR] Expected docker\nginx\nginx-prod.conf next to this script.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Restarting Docker Services on VM
echo ============================================
echo.

REM Sync nginx config from this repo so quick restart never depends on a prior full deploy.
REM Only remove host path if it is a mistaken directory (Docker creates it when the file was missing).
REM Do NOT blindly rm the file — that would delete a valid config.
echo [INFO] Syncing nginx-prod.conf to VM...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'mkdir -p %VM_BASE_PATH%/servers/docker/nginx && if [ -d %VM_BASE_PATH%/servers/docker/nginx/nginx-prod.conf ]; then echo INFO: Removing mistaken nginx-prod.conf directory...; docker run --rm -v %VM_BASE_PATH%/servers/docker/nginx:/mnt alpine rm -rf /mnt/nginx-prod.conf; fi'"
if errorlevel 1 (
    echo [ERROR] SSH mkdir/nginx cleanup failed.
    pause
    exit /b 1
)
scp %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no "%NGINX_PROD_LOCAL%" %SSH_USER%@%SSH_HOST%:%VM_BASE_PATH%/servers/docker/nginx/nginx-prod.conf
if errorlevel 1 (
    echo [ERROR] scp nginx-prod.conf to VM failed.
    pause
    exit /b 1
)

REM Single SSH: one authentication, then full restart + status on the VM
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'echo INFO: Stopping containers...; cd %VM_BASE_PATH% && (docker compose -f docker-compose.yml down --remove-orphans 2>/dev/null || docker compose down --remove-orphans 2>/dev/null || docker-compose -f docker-compose.yml down --remove-orphans 2>/dev/null || docker-compose down --remove-orphans 2>/dev/null || true); echo INFO: Force stopping all hunico containers...; docker stop hunico-redis hunico-node hunico-python hunico-nginx 2>/dev/null || true; echo INFO: Removing all hunico containers...; docker rm -f hunico-redis hunico-node hunico-python hunico-nginx 2>/dev/null || true; echo INFO: Removing problematic network...; docker network rm hunico-network 2>/dev/null || true; echo INFO: Removing all hunico networks...; docker network ls --filter name=hunico --format \"{{.Name}}\" | xargs -r docker network rm 2>/dev/null || true; echo INFO: Starting containers with fresh network...; cd %VM_BASE_PATH% || { echo ERROR: cd to VM_BASE_PATH failed; exit 1; }; (docker compose -f docker-compose.yml up -d 2>&1 || docker compose up -d 2>&1 || docker-compose -f docker-compose.yml up -d 2>&1 || docker-compose up -d 2>&1) || { echo ERROR: docker compose up failed; ls -la %VM_BASE_PATH%/docker-compose.yml; exit 1; }; echo; echo INFO: Waiting 5 seconds for services to start...; sleep 5; echo; echo INFO: Container status:; docker ps --format \"table {{.Names}}\t{{.Status}}\t{{.Ports}}\"; echo; echo INFO: Nginx probe deferred to post-restart script: Node probes nginx :80 and :443 /api/health with retries.'"
if errorlevel 1 (
    echo [ERROR] Remote restart failed ^(see messages above^).
    pause
    exit /b 1
)

set "CONNECTIVITY_SCRIPT=%SCRIPT_DIR%scripts\quick-restart-connectivity.sh"
if exist "%CONNECTIVITY_SCRIPT%" (
    echo.
    echo [INFO] Running post-restart checks ^(mounts + Postgres via /api/ready^)...
    echo [INFO] Piping script to VM with CR stripped ^(Windows CRLF safe^)...
    REM scp leaves CRLF; bash on Linux fails. Pipe stdin through sed on the VM, then bash -s.
    type "%CONNECTIVITY_SCRIPT%" | ssh -T %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "sed 's/\r$//' | bash -s"
    if errorlevel 1 (
        echo [ERROR] Post-restart connectivity checks failed ^(see messages above^).
        pause
        exit /b 1
    )
) else (
    echo [WARNING] Missing %CONNECTIVITY_SCRIPT% — skipping post-restart checks.
)

echo.
echo [SUCCESS] Restart complete!
echo.
pause
