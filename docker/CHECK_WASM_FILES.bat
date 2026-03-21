@echo off
setlocal

REM ============================================
REM Check WASM Files on VM
REM ============================================

set "SCRIPT_DIR=%~dp0"
set "CONFIG_FILE=%SCRIPT_DIR%deploy.config"

REM Check for local override config
set "LOCAL_CONFIG=%SCRIPT_DIR%deploy.config.local"
if exist "%LOCAL_CONFIG%" (
    set "CONFIG_FILE=%LOCAL_CONFIG%"
)

REM Load config
if exist "%CONFIG_FILE%" (
    for /f "usebackq tokens=1,2 delims==" %%a in ("%CONFIG_FILE%") do (
        if not "%%a"=="" if not "%%a"=="#" set "%%a=%%b"
    )
)

echo.
echo ============================================
echo   Checking WASM Files on VM
echo ============================================
echo.

echo [INFO] Checking frontend/assets directory on VM...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "ls -lah %VM_FRONTEND_PATH%/assets/ 2>&1 | head -30"

echo.
echo [INFO] Checking for sqlite3.wasm specifically...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "ls -lah %VM_FRONTEND_PATH%/assets/sqlite3.wasm 2>&1"

echo.
echo [INFO] Checking what Nginx sees...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx ls -lah /usr/share/nginx/html/assets/sqlite3.wasm 2>&1"

echo.
echo [INFO] Testing WASM file via HTTP...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx wget -q -O- http://localhost/assets/sqlite3.wasm 2>&1 | head -c 20 | od -An -tx1"

echo.
echo [INFO] Checking Nginx MIME types...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx cat /etc/nginx/mime.types 2>&1 | grep wasm"

echo.
pause
