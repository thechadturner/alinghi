@echo off
setlocal enabledelayedexpansion

REM Test key-based login (no password) using SSH_KEY from deploy config.

set "SCRIPT_DIR=%~dp0"
set "CONFIG_FILE=%SCRIPT_DIR%deploy.config"
set "LOCAL_CONFIG=%SCRIPT_DIR%deploy.config.local"

if not exist "%CONFIG_FILE%" (
    echo [ERROR] Missing %CONFIG_FILE%
    pause
    exit /b 1
)
if exist "%LOCAL_CONFIG%" (
    set "CONFIG_FILE=%LOCAL_CONFIG%"
)

for /f "usebackq tokens=1,2 delims==" %%a in ("%CONFIG_FILE%") do (
    if not "%%a"=="" if not "%%a"=="#" set "%%a=%%b"
)

if "%SSH_HOST%"=="" (
    echo [ERROR] SSH_HOST not set
    pause
    exit /b 1
)
if "%SSH_USER%"=="" (
    echo [ERROR] SSH_USER not set
    pause
    exit /b 1
)
if "%SSH_KEY%"=="" (
    echo [ERROR] SSH_KEY not set
    pause
    exit /b 1
)
if not exist "%SSH_KEY%" (
    echo [ERROR] Private key not found: %SSH_KEY%
    pause
    exit /b 1
)

call "%SCRIPT_DIR%set-deploy-ssh-opts.bat"
if errorlevel 1 (
    pause
    exit /b 1
)

echo [INFO] Testing key auth: %SSH_USER%@%SSH_HOST% ^(BatchMode, same opts as deploy scripts^)
ssh -o BatchMode=yes -o StrictHostKeyChecking=no %SSH_REMOTE_OPTS% %SSH_USER%@%SSH_HOST% "echo SSH key auth OK"
if errorlevel 1 (
    echo [ERROR] Key login failed. Run INSTALL_SSH_PUBKEY_TO_VM.bat once if you have not installed the public key.
    pause
    exit /b 1
)
echo [SUCCESS] SSH key authentication works.
pause
exit /b 0
