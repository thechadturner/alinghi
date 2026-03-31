@echo off
REM Sets SSH_IDENTITY_OPTS, SSH_COMMON_OPTS, SSH_REMOTE_OPTS for OpenSSH ssh/scp.
REM   SSH_IDENTITY_OPTS = -i "key" when deploy.config(.local) sets SSH_KEY (private key path).
REM   SSH_REMOTE_OPTS = identity + ControlMaster ^(if force^) + timeouts; with SSH_KEY adds
REM     IdentitiesOnly + publickey auth ^(avoids hangs from GSSAPI / password fallback^).
REM Also loads SSH multiplex options via set-ssh-mux-opts.bat (reuse one password per run).
REM Call after loading deploy.config; SCRIPT_DIR not required (uses %~dp0 for mux dir).

set "SSH_IDENTITY_OPTS="
if "%SSH_KEY%"=="" (
    echo [INFO] SSH_KEY not set: password or ssh-agent. Win32-OpenSSH cannot reuse one password for scp ^(see set-ssh-mux-opts.bat^). Add SSH_KEY in deploy.config.local for key-based login.
    goto :after_identity
)
if not exist "%SSH_KEY%" (
    echo [ERROR] SSH_KEY is set but file not found: %SSH_KEY%
    exit /b 1
)
set SSH_IDENTITY_OPTS=-i "%SSH_KEY%"
:after_identity
call "%~dp0set-ssh-mux-opts.bat"

set "SSH_COMMON_OPTS=-o ConnectTimeout=20 -o ConnectionAttempts=1 -o ServerAliveInterval=30"
if not "%SSH_KEY%"=="" (
    set "SSH_COMMON_OPTS=%SSH_COMMON_OPTS% -o IdentitiesOnly=yes -o PreferredAuthentications=publickey -o GSSAPIAuthentication=no"
)
set "SSH_REMOTE_OPTS=%SSH_IDENTITY_OPTS% %SSH_MUX_OPTS% %SSH_COMMON_OPTS%"
exit /b 0
