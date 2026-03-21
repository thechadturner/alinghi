@echo off
setlocal enabledelayedexpansion

REM ============================================
REM Docker Server - Start Node.js Service Only
REM ============================================

echo.
echo ============================================
echo   Starting Node.js Docker Service
echo ============================================
echo.

REM Check if Docker command exists
where docker >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker command not found in PATH.
    echo [INFO] Please make sure Docker Desktop is installed and added to your PATH.
    echo [INFO] You may need to restart your terminal after installing Docker Desktop.
    pause
    exit /b 1
)

REM Get the directory where this batch file is located
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "COMPOSE_FILE=%SCRIPT_DIR%compose\node.yml"

if not exist "%COMPOSE_FILE%" (
    echo [ERROR] Node.js compose file not found at %COMPOSE_FILE%!
    pause
    exit /b 1
)

REM Create shared network if it doesn't exist
echo [INFO] Ensuring shared Docker network exists...
docker network create hunico-network 2>nul
if errorlevel 1 (
    echo [INFO] Network hunico-network already exists or created successfully
) else (
    echo [SUCCESS] Network hunico-network created
)
echo.

REM Change to project root for docker-compose
cd /d "%PROJECT_ROOT%"

REM Copy .env files to compose directory if they exist (docker-compose looks for .env in same dir as compose file)
if exist "%PROJECT_ROOT%\.env" (
    copy /y "%PROJECT_ROOT%\.env" "%PROJECT_ROOT%\docker\compose\.env" >nul 2>&1
    echo [INFO] Copied .env file to compose directory
)
if exist "%PROJECT_ROOT%\.env.local" (
    copy /y "%PROJECT_ROOT%\.env.local" "%PROJECT_ROOT%\docker\compose\.env.local" >nul 2>&1
    echo [INFO] Copied .env.local file to compose directory
)

echo [INFO] Starting Node.js service...
echo [INFO] Compose file: docker\compose\node.yml
echo [INFO] This will start Node.js servers (App, Admin, File, Media, Stream) and Redis
echo.

REM Build and start the container
docker-compose -f "docker\compose\node.yml" up -d --build

if errorlevel 1 (
    echo [ERROR] Failed to start Node.js service!
    echo.
    echo [INFO] To view logs: docker-compose -f "docker\compose\node.yml" logs
    echo [INFO] To check status: docker ps
    echo.
    pause
    exit /b 1
) else (
    echo [SUCCESS] Node.js service started successfully!
    echo.
    echo [INFO] Services available at:
    echo   - App Server: http://localhost:8069
    echo   - Admin Server: http://localhost:8059
    echo   - File Server: http://localhost:8079
    echo   - Media Server: http://localhost:8089
    echo   - Stream Server: http://localhost:8099
    echo   - Redis: localhost:6379
    echo.
    echo [INFO] To view logs: docker-compose -f "docker\compose\node.yml" logs -f
    echo [INFO] To stop: docker-compose -f "docker\compose\node.yml" down
    echo [INFO] To check status: docker ps
    echo.
)

pause
exit /b 0

