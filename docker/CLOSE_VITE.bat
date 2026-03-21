@echo off
setlocal ENABLEDELAYEDEXPANSION

REM ==== Free port 3000 if already in use ====
echo Checking for process using port 3000...

set "found="

FOR /F "tokens=5" %%P IN ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') DO (
  set "found=1"
  echo Found PID %%P using port 3000, attempting to terminate...
  taskkill /PID %%P /F >NUL 2>&1

  if !errorlevel! EQU 0 (
    echo Successfully terminated PID %%P on port 3000.
  ) else (
    echo Failed to terminate PID %%P on port 3000 (it may have already exited).
  )
)

if not defined found (
  echo No process found using port 3000.
)

echo Port 3000 check complete.
REM ==== End free port 3000 block ====

echo.
echo Script finished. Press any key to exit.
timeout /t -1