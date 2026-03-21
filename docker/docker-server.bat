@echo off
setlocal enabledelayedexpansion

REM ============================================
REM Docker Server Management Script
REM ============================================

REM Get service name from parameter or use default
set "SERVICE_NAME=%~1"
set "COMMAND=%~2"

REM Check if first arg is a command (not a service name)
if not "%SERVICE_NAME%"=="" (
    if /i "%SERVICE_NAME%"=="build" set "SERVICE_NAME=python" & set "COMMAND=%~1"
    if /i "%SERVICE_NAME%"=="up" set "SERVICE_NAME=python" & set "COMMAND=%~1"
    if /i "%SERVICE_NAME%"=="start" set "SERVICE_NAME=python" & set "COMMAND=%~1"
    if /i "%SERVICE_NAME%"=="stop" set "SERVICE_NAME=python" & set "COMMAND=%~1"
    if /i "%SERVICE_NAME%"=="down" set "SERVICE_NAME=python" & set "COMMAND=%~1"
    if /i "%SERVICE_NAME%"=="restart" set "SERVICE_NAME=python" & set "COMMAND=%~1"
    if /i "%SERVICE_NAME%"=="logs" set "SERVICE_NAME=python" & set "COMMAND=%~1"
    if /i "%SERVICE_NAME%"=="status" set "SERVICE_NAME=python" & set "COMMAND=%~1"
    if /i "%SERVICE_NAME%"=="rebuild" set "SERVICE_NAME=python" & set "COMMAND=%~1"
    if /i "%SERVICE_NAME%"=="shell" set "SERVICE_NAME=python" & set "COMMAND=%~1"
    if /i "%SERVICE_NAME%"=="help" set "SERVICE_NAME=python" & set "COMMAND=%~1"
    if /i "%SERVICE_NAME%"=="list" set "SERVICE_NAME=python" & set "COMMAND=%~1"
)

if "%SERVICE_NAME%"=="" set "SERVICE_NAME=python"

REM Load service configuration
call :load_service_config "%SERVICE_NAME%"
if errorlevel 1 (
    echo [ERROR] Service '%SERVICE_NAME%' not found in docker-services.config
    echo [INFO] Available services:
    call :list_services
    echo.
    echo [INFO] Usage: docker-server.bat [service_name] [command]
    pause
    exit /b 1
)

REM Check if Docker command exists
where docker >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker command not found in PATH.
    echo [INFO] Please make sure Docker Desktop is installed and added to your PATH.
    echo [INFO] You may need to restart your terminal after installing Docker Desktop.
    pause
    exit /b 1
)

REM Check if docker-compose command exists
where docker-compose >nul 2>&1
if errorlevel 1 (
    echo [WARNING] docker-compose command not found, trying 'docker compose'...
    docker compose version >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Neither 'docker-compose' nor 'docker compose' is available.
        echo [INFO] Please install Docker Compose or use Docker Desktop which includes it.
        pause
        exit /b 1
    )
)

REM Check if Docker is running
echo [INFO] Checking Docker status...
REM Simple check: if docker command exists, assume it's available
REM docker-compose will give clear error if Docker isn't actually running
docker --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker command not found in PATH.
    echo [INFO] Please make sure Docker Desktop is installed and added to your PATH.
    pause
    exit /b 1
)
echo [SUCCESS] Docker command found!
echo [INFO] Note: If Docker Desktop isn't running, docker-compose will show an error.
echo.

REM Check if .env file exists (paths in config are relative to project root)
set "PROJECT_ROOT=%~dp0.."
if not exist "%PROJECT_ROOT%\%SERVICE_ENV_FILE%" (
    echo [WARNING] .env file not found at %PROJECT_ROOT%\%SERVICE_ENV_FILE%
    echo [INFO] You can create one from env.example or set environment variables manually.
    echo.
)

REM Parse command line arguments
if "%COMMAND%"=="" goto :menu
if /i "%COMMAND%"=="build" goto :build
if /i "%COMMAND%"=="up" goto :up
if /i "%COMMAND%"=="start" goto :start
if /i "%COMMAND%"=="stop" goto :stop
if /i "%COMMAND%"=="down" goto :down
if /i "%COMMAND%"=="restart" goto :restart
if /i "%COMMAND%"=="logs" goto :logs
if /i "%COMMAND%"=="status" goto :status
if /i "%COMMAND%"=="rebuild" goto :rebuild
if /i "%COMMAND%"=="shell" goto :shell
if /i "%COMMAND%"=="help" goto :help
if /i "%COMMAND%"=="list" goto :list_services_menu
goto :menu

:menu
echo.
echo ============================================
echo   Docker Server Management
echo ============================================
echo.
echo Current Service: %SERVICE_NAME% - %SERVICE_DESC%
echo.
echo Available commands:
echo   1. build    - Build the Docker image
echo   2. up       - Build and start the container (detached)
echo   3. start    - Start existing container
echo   4. stop     - Stop the container
echo   5. restart  - Restart the container
echo   6. down     - Stop and remove the container
echo   7. logs     - View container logs
echo   8. status   - Check container status
echo   9. rebuild  - Rebuild and restart (force)
echo  10. shell    - Open shell in container
echo  11. list     - List all available services
echo  12. help     - Show this help
echo.
set /p choice="Enter command (1-12) or command name: "

if "%choice%"=="1" goto :build
if "%choice%"=="2" goto :up
if "%choice%"=="3" goto :start
if "%choice%"=="4" goto :stop
if "%choice%"=="5" goto :restart
if "%choice%"=="6" goto :down
if "%choice%"=="7" goto :logs
if "%choice%"=="8" goto :status
if "%choice%"=="9" goto :rebuild
if "%choice%"=="10" goto :shell
if "%choice%"=="11" goto :list_services_menu
if "%choice%"=="12" goto :help
goto :menu

:list_services_menu
echo.
echo ============================================
echo   Available Docker Services
echo ============================================
echo.
call :list_services
echo.
pause
goto :menu

:build
echo.
echo [INFO] Building Docker image for: %SERVICE_NAME%
REM Change to project root (parent of docker folder) for docker-compose
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"
REM Copy .env files to compose directory if they exist (docker-compose looks for .env in same dir as compose file)
if exist "%PROJECT_ROOT%\.env" (
    copy /y "%PROJECT_ROOT%\.env" "%PROJECT_ROOT%\docker\compose\.env" >nul 2>&1
)
if exist "%PROJECT_ROOT%\.env.local" (
    copy /y "%PROJECT_ROOT%\.env.local" "%PROJECT_ROOT%\docker\compose\.env.local" >nul 2>&1
)
docker-compose -f "%SERVICE_COMPOSE_FILE%" build
if errorlevel 1 (
    echo [ERROR] Build failed!
    pause
    exit /b 1
)
echo [SUCCESS] Build completed!
goto :end

:up
echo.
echo [INFO] Building and starting container: %SERVICE_NAME%
REM Change to project root (parent of docker folder) for docker-compose
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"
REM Copy .env files to compose directory if they exist (docker-compose looks for .env in same dir as compose file)
if exist "%PROJECT_ROOT%\.env" (
    copy /y "%PROJECT_ROOT%\.env" "%PROJECT_ROOT%\docker\compose\.env" >nul 2>&1
)
if exist "%PROJECT_ROOT%\.env.local" (
    copy /y "%PROJECT_ROOT%\.env.local" "%PROJECT_ROOT%\docker\compose\.env.local" >nul 2>&1
)
docker-compose -f "%SERVICE_COMPOSE_FILE%" up -d --build
if errorlevel 1 (
    echo [ERROR] Failed to start container!
    pause
    exit /b 1
)
echo [SUCCESS] Container started!
if not "%SERVICE_PORT%"=="" (
    echo [INFO] Service should be available at http://localhost:%SERVICE_PORT%
    echo [INFO] Health check: http://localhost:%SERVICE_PORT%/api/health
)
goto :end

:start
echo.
echo [INFO] Starting container: %SERVICE_NAME%
REM Change to project root (parent of docker folder) for docker-compose
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"
docker-compose -f "%SERVICE_COMPOSE_FILE%" start
if errorlevel 1 (
    echo [ERROR] Failed to start container!
    pause
    exit /b 1
)
echo [SUCCESS] Container started!
goto :end

:stop
echo.
echo [INFO] Stopping container: %SERVICE_NAME%
REM Change to project root (parent of docker folder) for docker-compose
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"
docker-compose -f "%SERVICE_COMPOSE_FILE%" stop
if errorlevel 1 (
    echo [ERROR] Failed to stop container!
    pause
    exit /b 1
)
echo [SUCCESS] Container stopped!
goto :end

:restart
echo.
echo [INFO] Restarting container: %SERVICE_NAME%
REM Change to project root (parent of docker folder) for docker-compose
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"
docker-compose -f "%SERVICE_COMPOSE_FILE%" restart
if errorlevel 1 (
    echo [ERROR] Failed to restart container!
    pause
    exit /b 1
)
echo [SUCCESS] Container restarted!
goto :end

:down
echo.
echo [WARNING] This will stop and remove the container: %SERVICE_NAME%
set /p confirm="Are you sure? (y/N): "
if /i not "%confirm%"=="y" (
    echo [INFO] Operation cancelled.
    goto :end
)
echo [INFO] Stopping and removing container...
REM Change to project root (parent of docker folder) for docker-compose
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"
docker-compose -f "%SERVICE_COMPOSE_FILE%" down
if errorlevel 1 (
    echo [ERROR] Failed to remove container!
    pause
    exit /b 1
)
echo [SUCCESS] Container stopped and removed!
goto :end

:logs
echo.
echo [INFO] Showing container logs for: %SERVICE_NAME% (Ctrl+C to exit)...
echo.
REM Change to project root (parent of docker folder) for docker-compose
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"
docker-compose -f "%SERVICE_COMPOSE_FILE%" logs -f
goto :end

:status
echo.
echo [INFO] Container status for: %SERVICE_NAME%
echo.
REM Change to project root (parent of docker folder) for docker-compose
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"
docker-compose -f "%SERVICE_COMPOSE_FILE%" ps
echo.
echo [INFO] Container health:
docker inspect --format='{{.State.Health.Status}}' %SERVICE_NAME% 2>nul
if errorlevel 1 (
    echo [INFO] Health check not available or container not running
)
goto :end

:rebuild
echo.
echo [WARNING] This will rebuild the image and restart the container: %SERVICE_NAME%
set /p confirm="Are you sure? (y/N): "
if /i not "%confirm%"=="y" (
    echo [INFO] Operation cancelled.
    goto :end
)
REM Change to project root (parent of docker folder) for docker-compose
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"
echo [INFO] Stopping container...
docker-compose -f "%SERVICE_COMPOSE_FILE%" down
echo [INFO] Rebuilding image...
docker-compose -f "%SERVICE_COMPOSE_FILE%" build --no-cache
if errorlevel 1 (
    echo [ERROR] Rebuild failed!
    pause
    exit /b 1
)
echo [INFO] Starting container...
docker-compose -f "%SERVICE_COMPOSE_FILE%" up -d
if errorlevel 1 (
    echo [ERROR] Failed to start container!
    pause
    exit /b 1
)
echo [SUCCESS] Container rebuilt and restarted!
goto :end

:shell
echo.
echo [INFO] Opening shell in container...
echo [INFO] Type 'exit' to return
echo.
docker exec -it %SERVICE_NAME% /bin/bash
if errorlevel 1 (
    echo [INFO] Bash not available, trying sh...
    docker exec -it %SERVICE_NAME% /bin/sh
)
goto :end

:help
echo.
echo ============================================
echo   Docker Server Management - Help
echo ============================================
echo.
echo Usage: docker-server.bat [service_name] [command]
echo.
echo   service_name  - Name of the service (default: python)
echo   command       - Command to execute
echo.
echo Examples:
echo   docker-server.bat                    - Interactive menu (default service)
echo   docker-server.bat python up          - Start python service
echo   docker-server.bat node logs         - View logs for node service
echo   docker-server.bat list              - List all available services
echo.
echo Usage: docker-server.bat [command]
echo.
echo Commands:
echo   build    - Build the Docker image
echo   up       - Build and start the container (detached mode)
echo   start    - Start an existing stopped container
echo   stop     - Stop the running container
echo   restart  - Restart the container
echo   down     - Stop and remove the container
echo   logs     - View and follow container logs
echo   status   - Check container status and health
echo   rebuild  - Force rebuild image and restart container
echo   shell    - Open an interactive shell in the container
echo   help     - Show this help message
echo.
echo Examples:
echo   docker-server.bat up          - Start the server
echo   docker-server.bat logs       - View logs
echo   docker-server.bat restart    - Restart the server
echo.
echo Environment Variables:
echo   Make sure .env file exists with required variables:
echo   - JWT_SECRET (required)
echo   - SYSTEM_KEY (required)
echo   - PYTHON_PORT (default: 8049)
echo   - And other optional variables
echo.
goto :end

REM ============================================
REM Helper Functions
REM ============================================

:load_service_config
set "target_service=%~1"
set "found=0"

REM Get the directory where this batch file is located
set "SCRIPT_DIR=%~dp0"
set "CONFIG_FILE=%SCRIPT_DIR%docker-services.config"

if not exist "%CONFIG_FILE%" (
    echo [ERROR] docker-services.config file not found at %CONFIG_FILE%!
    exit /b 1
)

for /f "tokens=1,2,3,4,5 delims=|" %%a in ('type "%CONFIG_FILE%" ^| findstr /v "^REM" ^| findstr /v "^$"') do (
    if /i "%%a"=="%target_service%" (
        set "SERVICE_COMPOSE_FILE=%%b"
        set "SERVICE_ENV_FILE=%%c"
        set "SERVICE_PORT=%%d"
        set "SERVICE_DESC=%%e"
        set "found=1"
        goto :config_loaded
    )
)

:config_loaded
if "%found%"=="0" exit /b 1
exit /b 0

:list_services
REM Get the directory where this batch file is located
set "SCRIPT_DIR=%~dp0"
set "CONFIG_FILE=%SCRIPT_DIR%docker-services.config"

if not exist "%CONFIG_FILE%" (
    echo   (No services configured)
    exit /b 0
)

for /f "tokens=1,5 delims=|" %%a in ('type "%CONFIG_FILE%" ^| findstr /v "^REM" ^| findstr /v "^$"') do (
    echo   - %%a: %%b
)
exit /b 0

:end
echo.
pause
exit /b 0

