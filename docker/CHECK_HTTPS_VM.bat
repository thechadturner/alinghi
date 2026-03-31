@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "CONFIG_FILE=%SCRIPT_DIR%deploy.config"
if exist "%SCRIPT_DIR%deploy.config.local" set "CONFIG_FILE=%SCRIPT_DIR%deploy.config.local"
if not exist "%CONFIG_FILE%" (
    echo [ERROR] Missing %CONFIG_FILE%
    pause
    exit /b 1
)
for /f "usebackq tokens=1,2 delims==" %%a in ("%CONFIG_FILE%") do (
    if not "%%a"=="" if not "%%a"=="#" set "%%a=%%b"
)
call "%SCRIPT_DIR%set-deploy-ssh-opts.bat" || exit /b 1
if "%SSH_HOST%"=="" (
    echo [ERROR] SSH_HOST not set
    pause
    exit /b 1
)

echo.
echo === On YOUR PC (PowerShell) — must be same LAN/VPN as the VM ===
echo   ping %SSH_HOST%
echo   Test-NetConnection -ComputerName %SSH_HOST% -Port 443
echo   Test-NetConnection -ComputerName %SSH_HOST% -Port 80
echo   If TcpTestSucceeded is False: firewall, routing, or nothing listening on the VM.
echo.
echo === SSH diagnostics (VM) ===
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'docker ps -a --filter name=hunico-nginx'"
echo.
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'docker logs --tail 30 hunico-nginx 2>&1'"
echo.
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'ss -lntp'"
echo.
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'docker exec hunico-nginx wget -q -O- -T 3 http://127.0.0.1/api/health 2>&1'"
echo.
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'ls -la servers/docker/nginx/ssl/ 2>/dev/null; ls -la docker/nginx/ssl/ 2>/dev/null'"
echo.
pause
