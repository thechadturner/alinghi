@echo off
REM ControlMaster / ControlPath for OpenSSH.
REM Win32-OpenSSH breaks scp with mux: "getsockname failed: Not a socket" (see Win32-OpenSSH #405).
REM Multiplex is OFF unless you set SSH_USE_MULTIPLEX=force in deploy.config (unsupported on Windows).

set "SSH_MUX_OPTS="
if /i not "%SSH_USE_MULTIPLEX%"=="force" exit /b 0

echo [WARNING] SSH_USE_MULTIPLEX=force: Win32-OpenSSH often breaks scp with ControlMaster. Prefer SSH_KEY or disable force if uploads fail.
set "SSH_MUX_DIR=%~dp0.ssh_mux"
if not exist "%SSH_MUX_DIR%" mkdir "%SSH_MUX_DIR%" 2>nul
set "SSH_MUX_OPTS=-o ControlMaster=auto -o ControlPath=%SSH_MUX_DIR%\cm-%%C -o ControlPersist=30m"
exit /b 0
