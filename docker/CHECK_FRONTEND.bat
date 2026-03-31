@echo off
setlocal

REM ============================================
REM Check Frontend Deployment on VM
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
echo   Checking Frontend Deployment
echo ============================================
echo.

echo [INFO] Checking frontend directory on VM...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "ls -lah %VM_FRONTEND_PATH%/ 2>&1 | head -20"

echo.
echo [INFO] Checking what Nginx is serving...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx ls -lah /usr/share/nginx/html/ 2>&1 | head -20"

echo.
echo [INFO] Checking if index.html exists in Nginx...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx cat /usr/share/nginx/html/index.html 2>&1 | head -30"

echo.
echo [INFO] Checking Nginx access logs...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx tail -20 /var/log/nginx/access.log 2>&1"

echo.
echo [INFO] Checking Nginx error logs...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker exec hunico-nginx tail -20 /var/log/nginx/error.log 2>&1"

echo.
echo [INFO] Checking browser console errors (if any)...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker logs hunico-nginx 2>&1 | tail -20"

echo.
pause
