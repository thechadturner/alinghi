@echo off
setlocal
cd /d "%~dp0..\..\..\docker"
for /f "usebackq tokens=1,2 delims==" %%a in ("deploy.config.local") do (
    if not "%%a"=="" if not "%%a"=="#" set "%%a=%%b"
)
call "%CD%\set-deploy-ssh-opts.bat"
echo SSH_HOST=%SSH_HOST%
echo SSH_USER=%SSH_USER%
echo SSH_IDENTITY_OPTS=[%SSH_IDENTITY_OPTS%]
endlocal
