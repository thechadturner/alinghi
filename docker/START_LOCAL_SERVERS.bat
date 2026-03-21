@echo off
setlocal enabledelayedexpansion

REM ============================================
REM Docker Server - Start All Services
REM ============================================

echo.
echo ============================================
echo   Starting All Docker Services
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
set "CONFIG_FILE=%SCRIPT_DIR%docker-services.config"

if not exist "%CONFIG_FILE%" (
    echo [ERROR] docker-services.config file not found at %CONFIG_FILE%!
    pause
    exit /b 1
)

echo [INFO] Reading services from configuration...
echo.

REM Create shared network if it doesn't exist (for nginx to connect to other services)
echo [INFO] Ensuring shared Docker network exists...
docker network create hunico-network 2>nul
if errorlevel 1 (
    echo [INFO] Network hunico-network already exists or created successfully
) else (
    echo [SUCCESS] Network hunico-network created
)
echo.

REM Read all services from config and start them
set "services_started=0"
set "services_failed=0"

for /f "tokens=1,2,3,4,5 delims=|" %%a in ('type "%CONFIG_FILE%" ^| findstr /v "^REM" ^| findstr /v "^$"') do (
    set "SERVICE_NAME=%%a"
    set "SERVICE_COMPOSE_FILE=%%b"
    set "SERVICE_ENV_FILE=%%c"
    set "SERVICE_PORT=%%d"
    set "SERVICE_DESC=%%e"
    
    echo.
    echo [INFO] Starting: !SERVICE_NAME! - !SERVICE_DESC!
    echo [INFO] Compose file: !SERVICE_COMPOSE_FILE!
    
    REM Change to project root (parent of docker folder) for docker-compose
    set "PROJECT_ROOT=%SCRIPT_DIR%.."
    cd /d "!PROJECT_ROOT!"
    
    REM Copy .env files to compose directory if they exist (docker-compose looks for .env in same dir as compose file)
    REM For production compose files, also copy .env.production and .env.production.local
    if exist "!PROJECT_ROOT!\.env" (
        copy /y "!PROJECT_ROOT!\.env" "!PROJECT_ROOT!\docker\compose\.env" >nul 2>&1
    )
    if exist "!PROJECT_ROOT!\.env.local" (
        copy /y "!PROJECT_ROOT!\.env.local" "!PROJECT_ROOT!\docker\compose\.env.local" >nul 2>&1
    )
    if exist "!PROJECT_ROOT!\.env.production" (
        copy /y "!PROJECT_ROOT!\.env.production" "!PROJECT_ROOT!\docker\compose\.env.production" >nul 2>&1
    )
    if exist "!PROJECT_ROOT!\.env.production.local" (
        copy /y "!PROJECT_ROOT!\.env.production.local" "!PROJECT_ROOT!\docker\compose\.env.production.local" >nul 2>&1
    )
    
    REM Build and start the container
    docker-compose -f "!SERVICE_COMPOSE_FILE!" up -d --build
    
    if errorlevel 1 (
        echo [ERROR] Failed to start !SERVICE_NAME!
        set /a services_failed+=1
    ) else (
        echo [SUCCESS] !SERVICE_NAME! started successfully!
        if not "!SERVICE_PORT!"=="" (
            echo [INFO] Service available at: http://localhost:!SERVICE_PORT!
        )
        set /a services_started+=1
    )
)

REM Always start nginx (required for application)
echo.
echo [INFO] Starting nginx reverse proxy...
echo [INFO] Compose file: docker\compose\nginx.yml

cd /d "!PROJECT_ROOT!"

REM Copy .env files to compose directory if they exist
REM For production compose files, also copy .env.production and .env.production.local
if exist "!PROJECT_ROOT!\.env" (
    copy /y "!PROJECT_ROOT!\.env" "!PROJECT_ROOT!\docker\compose\.env" >nul 2>&1
)
if exist "!PROJECT_ROOT!\.env.local" (
    copy /y "!PROJECT_ROOT!\.env.local" "!PROJECT_ROOT!\docker\compose\.env.local" >nul 2>&1
)
if exist "!PROJECT_ROOT!\.env.production" (
    copy /y "!PROJECT_ROOT!\.env.production" "!PROJECT_ROOT!\docker\compose\.env.production" >nul 2>&1
)
if exist "!PROJECT_ROOT!\.env.production.local" (
    copy /y "!PROJECT_ROOT!\.env.production.local" "!PROJECT_ROOT!\docker\compose\.env.production.local" >nul 2>&1
)

REM Start nginx
docker-compose -f "docker\compose\nginx.yml" up -d

if errorlevel 1 (
    echo [ERROR] Failed to start nginx
    set /a services_failed+=1
) else (
    echo [SUCCESS] nginx started successfully!
    echo [INFO] nginx available at: http://localhost:80
    set /a services_started+=1
)

echo.
echo ============================================
echo   Summary
echo ============================================
echo.
echo [INFO] Services started: !services_started!
echo [INFO] Services failed: !services_failed!
echo.

if !services_failed! gtr 0 (
    echo [WARNING] Some services failed to start. Check logs with:
    echo   docker-server.bat [service_name] logs
    echo.
) else (
    echo [SUCCESS] All services started successfully!
    echo.
    echo [INFO] To view logs: docker-server.bat [service_name] logs
    echo [INFO] To stop all: docker-stop-all.bat
    echo [INFO] To check status: docker ps
    echo.
)

pause
exit /b 0

