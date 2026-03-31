@echo off
setlocal

REM ============================================
REM Copy install-docker.sh to the VM (one-time)
REM Use before full DEPLOY_VM_SERVERS if Docker is not installed yet.
REM Reads docker/deploy.config or deploy.config.local (same as other VM bats).
REM SSH_KEY in deploy.config.local uses SSH_REMOTE_OPTS ^(no password for scp^).
REM ============================================

set "SCRIPT_DIR=%~dp0"
set "CONFIG_FILE=%SCRIPT_DIR%deploy.config"

if not exist "%CONFIG_FILE%" (
    echo [ERROR] Config not found: %CONFIG_FILE%
    pause
    exit /b 1
)

set "LOCAL_CONFIG=%SCRIPT_DIR%deploy.config.local"
if exist "%LOCAL_CONFIG%" (
    echo [INFO] Using local config: %LOCAL_CONFIG%
    set "CONFIG_FILE=%LOCAL_CONFIG%"
)

for /f "usebackq tokens=1,2 delims==" %%a in ("%CONFIG_FILE%") do (
    if not "%%a"=="" if not "%%a"=="#" set "%%a=%%b"
)

if "%SSH_HOST%"=="" (
    echo [ERROR] SSH_HOST not set in config
    pause
    exit /b 1
)
if "%SSH_USER%"=="" (
    echo [ERROR] SSH_USER not set in config
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

set "INSTALL_SCRIPT=%SCRIPT_DIR%install-docker.sh"
if not exist "%INSTALL_SCRIPT%" (
    echo [ERROR] Not found: %INSTALL_SCRIPT%
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Push install-docker.sh to VM
echo ============================================
echo [INFO] Target: %SSH_USER%@%SSH_HOST%
echo [INFO] Remote: /tmp/racesight-install-docker.sh
echo.

scp %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no -o ServerAliveInterval=30 "%INSTALL_SCRIPT%" %SSH_USER%@%SSH_HOST%:/tmp/racesight-install-docker.sh
if errorlevel 1 (
    echo [ERROR] scp failed
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Script copied.
echo.
echo [INFO] On the VM, run (Ubuntu/Debian):
echo   ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST%
echo   sudo bash /tmp/racesight-install-docker.sh
echo.
echo [INFO] If the installer adds you to the docker group, log out and back in before deploy.
echo [INFO] Then create dirs/network: see docs/distribution/installation-guide.md ^(setup-vm.sh^).
echo.
pause
