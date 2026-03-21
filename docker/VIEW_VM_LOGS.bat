@echo off
setlocal enabledelayedexpansion

REM ============================================
REM View VM Service Logs Script
REM Views logs for Docker services on production VM
REM ============================================

REM Get script directory
set "SCRIPT_DIR=%~dp0"
set "CONFIG_FILE=%SCRIPT_DIR%deploy.config"

REM Load deployment configuration
if not exist "%CONFIG_FILE%" (
    echo [ERROR] Deployment config file not found: %CONFIG_FILE%
    echo.
    pause
    exit /b 1
)

REM Check for local override config
set "LOCAL_CONFIG=%SCRIPT_DIR%deploy.config.local"
if exist "%LOCAL_CONFIG%" (
    set "CONFIG_FILE=%LOCAL_CONFIG%"
)

REM Load config values
for /f "usebackq tokens=1,2 delims==" %%a in ("%CONFIG_FILE%") do (
    if not "%%a"=="" (
        if not "%%a"=="#" (
            set "%%a=%%b"
        )
    )
)

REM Validate required config
if "%SSH_HOST%"=="" (
    echo [ERROR] SSH_HOST not configured
    echo.
    pause
    exit /b 1
)
if "%SSH_USER%"=="" (
    echo [ERROR] SSH_USER not configured
    echo.
    pause
    exit /b 1
)
if "%SSH_KEY%"=="" (
    echo [ERROR] SSH_KEY not configured
    echo.
    pause
    exit /b 1
)
if "%VM_BASE_PATH%"=="" (
    echo [ERROR] VM_BASE_PATH not configured
    echo.
    pause
    exit /b 1
)

REM Validate SSH key exists
if not exist "%SSH_KEY%" (
    echo [ERROR] SSH key not found: %SSH_KEY%
    echo.
    pause
    exit /b 1
)

REM Check if service name provided as argument
set "SERVICE_NAME=%~1"
if "%SERVICE_NAME%"=="" (
    set "SERVICE_NAME=node"
)

REM Check for follow flag
set "FOLLOW_MODE=0"
if /i "%~2"=="-f" set "FOLLOW_MODE=1"
if /i "%~2"=="--follow" set "FOLLOW_MODE=1"

REM Create log file
set "LOG_FILE=%SCRIPT_DIR%latest_vm_log.txt"

echo.
echo ============================================
echo   Viewing Logs: %SERVICE_NAME%
echo ============================================
echo.
echo [INFO] Connecting to: %SSH_USER%@%SSH_HOST%
echo [INFO] Service: %SERVICE_NAME%
echo [INFO] VM Path: %VM_BASE_PATH%
echo.

REM First check if containers are running
echo [INFO] Checking container status...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker ps -a --format 'table {{.Names}}\t{{.Status}}' | grep hunico || echo 'No Hunico containers found'"
echo.

REM Try docker compose V2 first, then V1
if "%FOLLOW_MODE%"=="0" goto :get_logs
goto :follow_logs

:get_logs
    echo [INFO] Retrieving last 100 lines of logs...
    echo [INFO] Saving to: %LOG_FILE%
    echo.
    
    REM Try getting logs from container directly first (more reliable)
    ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker logs hunico-%SERVICE_NAME% --tail=100 2>&1" > "%LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo [INFO] Container hunico-%SERVICE_NAME% not found, trying compose service...
        echo.
        call ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "cd %VM_BASE_PATH% && docker compose -f docker-compose.yml logs --tail=100 %SERVICE_NAME%" > "%LOG_FILE%" 2>&1
        if errorlevel 1 (
            echo.
            echo [INFO] Trying docker-compose (V1)...
            echo.
            call ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "cd %VM_BASE_PATH% && docker-compose -f docker-compose.yml logs --tail=100 %SERVICE_NAME%" > "%LOG_FILE%" 2>&1
            if errorlevel 1 (
                echo.
                echo [ERROR] Failed to retrieve logs
                echo [INFO] Available services: node, python, redis, nginx
                echo [INFO] Check that the service name is correct and containers are running
                echo.
                echo [INFO] Checking what containers exist...
                ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker ps -a"
                echo.
                pause
                exit /b 1
            )
        )
    )
    echo.
    
    REM Check if log file has content
    for %%A in ("%LOG_FILE%") do set "LOG_SIZE=%%~zA"
    if %LOG_SIZE% LSS 10 (
        echo [WARNING] Log file is empty or very small
        echo [INFO] Container may not have started or generated logs yet
        echo.
    )
    
    type "%LOG_FILE%"
    echo.
    echo ============================================
    echo   Logs Complete
    echo ============================================
    echo.
    echo [INFO] Logs saved to: %LOG_FILE%
    echo.
    echo [INFO] To view logs for other services:
    echo   VIEW_VM_LOGS.bat node     - Node.js services
    echo   VIEW_VM_LOGS.bat python   - Python service
    echo   VIEW_VM_LOGS.bat redis    - Redis
    echo   VIEW_VM_LOGS.bat nginx    - Nginx
    echo.
    echo [INFO] To follow logs in real-time:
    echo   VIEW_VM_LOGS.bat node -f
    echo.
    set /p "dummy=Press ENTER to close..."
    goto :end

:follow_logs
    echo [INFO] Following logs (press Ctrl+C to exit)...
    echo.
    call ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "cd %VM_BASE_PATH% && docker compose -f docker-compose.yml logs -f %SERVICE_NAME%"
    if errorlevel 1 (
        echo.
        echo [INFO] Trying docker-compose (V1)...
        echo.
        call ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "cd %VM_BASE_PATH% && docker-compose -f docker-compose.yml logs -f %SERVICE_NAME%"
    )
    if errorlevel 1 (
        echo.
        echo [ERROR] Failed to retrieve logs
        echo [INFO] Check that the service name is correct and the VM is accessible
        echo.
    )
    goto :end

:end
echo.
echo Logs complete.
set /p "dummy=Press ENTER to close this window..."
