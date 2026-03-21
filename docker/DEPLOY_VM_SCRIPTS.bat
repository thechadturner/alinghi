@echo off
setlocal enabledelayedexpansion

REM ============================================
REM Python Scripts-Only Deployment
REM Copies server_python/scripts to production VM (no servers, no Docker)
REM ============================================

set "SCRIPT_DIR=%~dp0"
set "LOG_FILE=%SCRIPT_DIR%deploy_vm_scripts.log"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "CONFIG_FILE=%SCRIPT_DIR%deploy.config"

echo.
echo ============================================
echo   Deploy VM Scripts (Python scripts only)
echo ============================================
echo.
echo [INFO] Started: %date% %time%
echo [INFO] Log: %LOG_FILE%
echo.

if not exist "%CONFIG_FILE%" (
    echo [ERROR] Config not found: %CONFIG_FILE%
    echo [INFO] Create deploy.config or deploy.config.local
    pause
    exit /b 1
)

set "LOCAL_CONFIG=%SCRIPT_DIR%deploy.config.local"
if exist "%LOCAL_CONFIG%" (
    echo [INFO] Using local config: %LOCAL_CONFIG%
    set "CONFIG_FILE=%LOCAL_CONFIG%"
)

for /f "usebackq tokens=1,2 delims==" %%a in ("%CONFIG_FILE%") do (
    if not "%%a"=="" if not "%%a"=="#" (
        set "%%a=%%b"
    )
)

set "DEPLOY_DRY_RUN=%DEPLOY_DRY_RUN: =%"

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
if "%SSH_KEY%"=="" (
    echo [ERROR] SSH_KEY not set in %CONFIG_FILE%
    pause
    exit /b 1
)
if "%VM_BASE_PATH%"=="" (
    echo [ERROR] VM_BASE_PATH not set in %CONFIG_FILE%
    pause
    exit /b 1
)

if not exist "%SSH_KEY%" (
    echo [ERROR] SSH key not found: %SSH_KEY%
    pause
    exit /b 1
)

if not exist "%PROJECT_ROOT%\server_python\scripts" (
    echo [ERROR] server_python\scripts not found
    pause
    exit /b 1
)

cd /d "%PROJECT_ROOT%"

REM Same destination as DEPLOY_VM_SERVERS.bat: VM_BASE_PATH/scripts
set "REMOTE_SCRIPTS=%VM_BASE_PATH%/scripts"

if "%DEPLOY_DRY_RUN%"=="true" (
    echo [INFO] DRY RUN - no changes will be made
    echo [DRY RUN] Would deploy server_python\scripts to %SSH_USER%@%SSH_HOST%:%REMOTE_SCRIPTS%
    echo.
    pause
    exit /b 0
)

set "TEMP_DIR=%TEMP%\hunico-scripts-deploy-%RANDOM%"
echo [INFO] Creating archive from server_python\scripts...
mkdir "%TEMP_DIR%" 2>nul
if not exist "%TEMP_DIR%" (
    echo [ERROR] Failed to create temp dir
    pause
    exit /b 1
)

tar -czf "%TEMP_DIR%\scripts.tar.gz" -C server_python scripts 2>nul
if errorlevel 1 (
    echo [ERROR] Failed to create scripts.tar.gz
    rmdir /S /Q "%TEMP_DIR%" 2>nul
    pause
    exit /b 1
)
echo [SUCCESS] Archive created

echo [INFO] Uploading to %SSH_USER%@%SSH_HOST%:%REMOTE_SCRIPTS%...
scp -i "%SSH_KEY%" -o StrictHostKeyChecking=no -o ServerAliveInterval=30 "%TEMP_DIR%\scripts.tar.gz" %SSH_USER%@%SSH_HOST%:%VM_BASE_PATH%/scripts.tar.gz
if errorlevel 1 (
    echo [ERROR] Upload failed
    del /Q "%TEMP_DIR%\scripts.tar.gz" 2>nul
    rmdir /S /Q "%TEMP_DIR%" 2>nul
    pause
    exit /b 1
)
echo [SUCCESS] Uploaded

echo [INFO] Extracting on VM (same as DEPLOY_VM_SERVERS.bat)...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "mkdir -p %REMOTE_SCRIPTS% && (rm -rf %REMOTE_SCRIPTS%/* 2>/dev/null; true) && tar -xzf %VM_BASE_PATH%/scripts.tar.gz -C %REMOTE_SCRIPTS% --strip-components=1 && rm -f %VM_BASE_PATH%/scripts.tar.gz"
if errorlevel 1 (
    echo [ERROR] Extract on VM failed
    echo [INFO] SSH to VM and run: mkdir -p %REMOTE_SCRIPTS% ^&^& tar -xzf %VM_BASE_PATH%/scripts.tar.gz -C %REMOTE_SCRIPTS% --strip-components=1
    del /Q "%TEMP_DIR%\scripts.tar.gz" 2>nul
    rmdir /S /Q "%TEMP_DIR%" 2>nul
    pause
    exit /b 1
)
echo [SUCCESS] Scripts deployed to %REMOTE_SCRIPTS%

del /Q "%TEMP_DIR%\scripts.tar.gz" 2>nul
rmdir /S /Q "%TEMP_DIR%" 2>nul

echo.
echo ============================================
echo   Scripts deployment complete
echo ============================================
echo [INFO] Target: %REMOTE_SCRIPTS%
echo.
pause
exit /b 0
