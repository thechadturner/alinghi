@echo off
setlocal enabledelayedexpansion

REM One-time: append this machine's Alinghi public key to the VM authorized_keys.
REM Uses password authentication (no SSH_KEY). Run from repo after deploy.config.local exists.

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
    echo [ERROR] SSH_KEY not set in %CONFIG_FILE% ^(private key path; .pub must exist alongside^)
    pause
    exit /b 1
)

set "PUB_KEY=%SSH_KEY%.pub"
if not exist "%PUB_KEY%" (
    echo [ERROR] Public key not found: %PUB_KEY%
    pause
    exit /b 1
)

echo [INFO] Appending public key to %SSH_USER%@%SSH_HOST%:~/.ssh/authorized_keys
echo [INFO] You will be prompted for the VM user password once.
echo.
REM Password auth only here; do not use SSH_REMOTE_OPTS ^(no PreferredAuthentications=publickey^).
type "%PUB_KEY%" | ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20 -o ConnectionAttempts=1 %SSH_USER%@%SSH_HOST% "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
if errorlevel 1 (
    echo [ERROR] Failed. Check host, user, password, and network.
    pause
    exit /b 1
)
echo.
echo [SUCCESS] Public key installed. Test with VERIFY_SSH_TO_VM.bat
pause
exit /b 0
