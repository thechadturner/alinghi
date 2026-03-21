@echo off
REM Simple tee-like function for batch - writes to both console and file
REM Usage: call tee-output.bat "message" "logfile"
setlocal
set "MESSAGE=%~1"
set "LOGFILE=%~2"
echo %MESSAGE%
echo %MESSAGE% >> "%LOGFILE%"
endlocal
