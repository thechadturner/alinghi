@echo off
setlocal

REM ============================================
REM Check WASM Files on VM
REM SSH: deploy.config.local + SSH_KEY ^(set-deploy-ssh-opts.bat^).
REM ============================================

set "SCRIPT_DIR=%~dp0"
set "CONFIG_FILE=%SCRIPT_DIR%deploy.config"

REM Check for local override config
set "LOCAL_CONFIG=%SCRIPT_DIR%deploy.config.local"
if exist "%LOCAL_CONFIG%" (
    set "CONFIG_FILE=%LOCAL_CONFIG%"
)

REM Load config
if not exist "%CONFIG_FILE%" (
    echo [ERROR] Config not found: %CONFIG_FILE%
    pause
    exit /b 1
)
for /f "usebackq tokens=1,2 delims==" %%a in ("%CONFIG_FILE%") do (
    if not "%%a"=="" if not "%%a"=="#" set "%%a=%%b"
)

if "%SSH_HOST%"=="" (
    echo [ERROR] SSH_HOST not set in %CONFIG_FILE%
    pause
    exit /b 1
)
if "%SSH_USER%"=="" (
    echo [ERROR] SSH_USER not set in %CONFIG_FILE%
    pause
    exit /b 1
)
if "%VM_FRONTEND_PATH%"=="" (
    echo [ERROR] VM_FRONTEND_PATH not set in %CONFIG_FILE%
    pause
    exit /b 1
)

call "%SCRIPT_DIR%set-deploy-ssh-opts.bat"
if errorlevel 1 (
    pause
    exit /b 1
)
call "%SCRIPT_DIR%establish-ssh-mux.bat"
if errorlevel 1 (
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Checking WASM Files on VM
echo ============================================
echo.

echo [INFO] Checking frontend/assets directory on VM...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "ls -lah %VM_FRONTEND_PATH%/assets/ 2>&1 | head -30"

echo.
echo [INFO] Checking for sqlite3.wasm specifically...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "ls -lah %VM_FRONTEND_PATH%/assets/sqlite3.wasm 2>&1"

echo.
echo [INFO] Checking what Nginx sees...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx ls -lah /usr/share/nginx/html/assets/sqlite3.wasm 2>&1"

echo.
echo [INFO] Testing WASM file via HTTP...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx wget -q -O- http://localhost/assets/sqlite3.wasm 2>&1 | head -c 20 | od -An -tx1"

echo.
echo [INFO] Checking Nginx MIME types...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx cat /etc/nginx/mime.types 2>&1 | grep wasm"

echo.
pause
