@echo off
setlocal

REM ============================================
REM Check Frontend Deployment on VM
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
echo   Checking Frontend Deployment
echo ============================================
echo.

echo [INFO] Checking frontend directory on VM...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "ls -lah /home/racesight/hunico/frontend/ 2>&1 | head -20"

echo.
echo [INFO] Checking what Nginx is serving...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx ls -lah /usr/share/nginx/html/ 2>&1 | head -20"

echo.
echo [INFO] Checking if index.html exists in Nginx...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx cat /usr/share/nginx/html/index.html 2>&1 | head -30"

echo.
echo [INFO] Checking Nginx access logs...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx tail -20 /var/log/nginx/access.log 2>&1"

echo.
echo [INFO] Checking Nginx error logs...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx tail -20 /var/log/nginx/error.log 2>&1"

echo.
echo [INFO] Checking browser console errors (if any)...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker logs hunico-nginx 2>&1 | tail -20"

echo.
pause
