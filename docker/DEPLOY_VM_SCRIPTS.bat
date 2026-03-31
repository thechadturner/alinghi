@echo off
setlocal enabledelayedexpansion

REM ============================================
REM Python Scripts-Only Deployment
REM Copies server_python/scripts to production VM (no servers, no Docker)
REM SSH: deploy.config.local + SSH_KEY ^(set-deploy-ssh-opts.bat^).
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
if "%VM_BASE_PATH%"=="" (
    echo [ERROR] VM_BASE_PATH not set in %CONFIG_FILE%
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

echo [INFO] Streaming server_python\scripts to VM ^(single SSH — one password^)...
cd /d "%PROJECT_ROOT%\server_python"
tar -czf - scripts 2>nul | ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'mkdir -p %REMOTE_SCRIPTS% && (rm -rf %REMOTE_SCRIPTS%/* 2>/dev/null; true) && tar -xzf - -C %REMOTE_SCRIPTS% --strip-components=1'"
if errorlevel 1 (
    echo [ERROR] Deploy failed ^(tar stream or SSH extract^)
    echo [INFO] SSH to VM and fix %REMOTE_SCRIPTS% if needed
    cd /d "%PROJECT_ROOT%"
    pause
    exit /b 1
)
cd /d "%PROJECT_ROOT%"
echo [SUCCESS] Scripts deployed to %REMOTE_SCRIPTS%

echo.
echo ============================================
echo   Scripts deployment complete
echo ============================================
echo [INFO] Target: %REMOTE_SCRIPTS%
echo.
pause
exit /b 0
