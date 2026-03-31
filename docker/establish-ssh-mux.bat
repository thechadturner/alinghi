@echo off
REM After set-deploy-ssh-opts: open one SSH session so password auth is prompted once (password mode only).
REM Subsequent ssh/scp with the same ControlPath reuse the socket. Uses SSH_REMOTE_OPTS from set-deploy-ssh-opts.

if /i "%SSH_USE_MULTIPLEX%"=="false" exit /b 0
if "%SSH_MUX_OPTS%"=="" exit /b 0
if not "%SSH_KEY%"=="" exit /b 0

echo.
echo [INFO] SSH multiplex: enter your SSH password once for this run.
echo [INFO] Later ssh and scp in this window reuse the connection.
echo.
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "true"
if errorlevel 1 (
    echo [ERROR] SSH connection failed.
    exit /b 1
)
exit /b 0
