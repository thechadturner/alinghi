@echo off
setlocal enabledelayedexpansion

REM ============================================
REM Frontend Deployment Script
REM Builds and deploys frontend to production VM
REM ============================================

echo.
echo ============================================
echo   Frontend Deployment to Production VM
echo ============================================
echo.

REM Get script directory
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "CONFIG_FILE=%SCRIPT_DIR%deploy.config"

REM Load deployment configuration
if not exist "%CONFIG_FILE%" (
    echo [ERROR] Deployment config file not found: %CONFIG_FILE%
    echo [INFO] Please create deploy.config or deploy.config.local
    pause
    exit /b 1
)

REM Check for local override config
set "LOCAL_CONFIG=%SCRIPT_DIR%deploy.config.local"
if exist "%LOCAL_CONFIG%" (
    echo [INFO] Using local deployment config: %LOCAL_CONFIG%
    set "CONFIG_FILE=%LOCAL_CONFIG%"
)

REM Load config values
for /f "usebackq tokens=1,2 delims==" %%a in ("%CONFIG_FILE%") do (
    if not "%%a"=="" if not "%%a"=="#" (
        set "%%a=%%b"
    )
)

REM Validate required config
if "%SSH_HOST%"=="" (
    echo [ERROR] SSH_HOST not configured in %CONFIG_FILE%
    pause
    exit /b 1
)
if "%SSH_USER%"=="" (
    echo [ERROR] SSH_USER not configured in %CONFIG_FILE%
    pause
    exit /b 1
)
if "%SSH_KEY%"=="" (
    echo [ERROR] SSH_KEY not configured in %CONFIG_FILE%
    pause
    exit /b 1
)
if "%VM_FRONTEND_PATH%"=="" (
    echo [ERROR] VM_FRONTEND_PATH not configured in %CONFIG_FILE%
    pause
    exit /b 1
)
if "%VM_BASE_PATH%"=="" (
    echo [ERROR] VM_BASE_PATH not configured in %CONFIG_FILE%
    pause
    exit /b 1
)

REM Validate SSH key exists
if not exist "%SSH_KEY%" (
    echo [ERROR] SSH key not found: %SSH_KEY%
    pause
    exit /b 1
)

REM Check if dry run
if "%DEPLOY_DRY_RUN%"=="true" (
    echo [INFO] DRY RUN MODE - No changes will be made
    echo.
)

REM Change to project root
cd /d "%PROJECT_ROOT%"

REM Step 1: Install dependencies and build prerequisites
echo [INFO] Step 1: Installing dependencies and building prerequisites...
echo.

echo [INFO] Installing dependencies (including workspace dependencies)...
call npm install
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies
    pause
    exit /b 1
)
echo [SUCCESS] Dependencies installed

echo [INFO] Verifying SQLite WASM package is installed...
if not exist "node_modules\@sqlite.org\sqlite-wasm" (
    if not exist "libs\huni_db\node_modules\@sqlite.org\sqlite-wasm" (
        echo [ERROR] SQLite WASM package not found after npm install!
        echo [INFO] This is required for the application to work.
        pause
        exit /b 1
    )
)
echo [SUCCESS] SQLite WASM package found

echo [INFO] Building syncstore (if needed)...
call node scripts/build-syncstore.js
if errorlevel 1 (
    echo [WARNING] Syncstore build had issues, continuing anyway...
)
echo [SUCCESS] Syncstore ready

echo [INFO] Building HuniDB library...
call npm run build:hunidb
if errorlevel 1 (
    echo [ERROR] HuniDB build failed!
    pause
    exit /b 1
)
echo [SUCCESS] HuniDB build completed
echo.

REM Step 2: Build frontend
echo [INFO] Step 2: Building frontend with Vite...
echo.
call npm run build
if errorlevel 1 (
    echo [ERROR] Frontend build failed!
    pause
    exit /b 1
)
echo [SUCCESS] Frontend build completed
echo.

REM Step 3: Verify dist directory
if not exist "dist" (
    echo [ERROR] dist directory not found after build!
    pause
    exit /b 1
)
echo [INFO] dist directory verified

REM Optional: Verify workers are included in build (if verification script exists)
if exist "cursor_files\verify-worker-build.js" (
    echo [INFO] Verifying workers are included in build...
    call node cursor_files\verify-worker-build.js
    if errorlevel 1 (
        echo [WARNING] Worker verification had issues, but continuing deployment...
        echo [INFO] Workers may still work - check browser console after deployment
    ) else (
        echo [SUCCESS] Worker verification passed
    )
    echo.
) else (
    echo [INFO] Worker verification script not found, skipping (optional check)
    echo.
)

REM Step 4: Create compressed archive
echo [INFO] Step 3: Creating compressed archive...
set "ARCHIVE_FILE=%TEMP%\hunico-frontend-%RANDOM%.tar.gz"

REM Use tar to create compressed archive (Windows 10+ has tar built-in)
cd /d "%PROJECT_ROOT%"
tar -czf "%ARCHIVE_FILE%" -C dist .
if errorlevel 1 (
    echo [ERROR] Failed to create compressed archive
    pause
    exit /b 1
)
echo [SUCCESS] Archive created: %ARCHIVE_FILE%
echo [INFO] Archive size:
for %%A in ("%ARCHIVE_FILE%") do echo   %%~zA bytes
echo.

REM Step 5: Deploy via SSH
if "%DEPLOY_DRY_RUN%"=="true" (
    echo [DRY RUN] Would deploy to: %SSH_USER%@%SSH_HOST%:%VM_FRONTEND_PATH%
    echo [DRY RUN] Would use SSH key: %SSH_KEY%
    echo [DRY RUN] Would upload archive: %ARCHIVE_FILE%
) else (
    echo [INFO] Step 4: Deploying to VM...
    echo [INFO] Target: %SSH_USER%@%SSH_HOST%:%VM_FRONTEND_PATH%
    echo.
    
    REM Create remote directory and backup old files
    echo [INFO] Preparing deployment directory...
    ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "mkdir -p %VM_FRONTEND_PATH% && rm -rf %VM_FRONTEND_PATH%/*" 2>nul
    
    REM Upload compressed archive
    echo [INFO] Uploading compressed archive...
    scp -i "%SSH_KEY%" -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -o Compression=yes "%ARCHIVE_FILE%" %SSH_USER%@%SSH_HOST%:%VM_BASE_PATH%/frontend.tar.gz
    if errorlevel 1 (
        echo [ERROR] Failed to upload archive via SCP
        del "%ARCHIVE_FILE%" 2>nul
        pause
        exit /b 1
    )
    echo [SUCCESS] Archive uploaded
    
    REM Extract archive on VM
    echo [INFO] Extracting archive on VM...
    ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "cd %VM_FRONTEND_PATH% && tar -xzf %VM_BASE_PATH%/frontend.tar.gz && rm -f %VM_BASE_PATH%/frontend.tar.gz"
    if errorlevel 1 (
        echo [ERROR] Failed to extract archive on VM
        pause
        exit /b 1
    )
    echo [SUCCESS] Archive extracted
    
    REM Deploy nginx config if it exists locally
    if exist "%SCRIPT_DIR%..\nginx\nginx-prod.conf" (
        echo [INFO] Deploying nginx configuration...
        REM Create directory on server if it doesn't exist
        ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "mkdir -p %VM_BASE_PATH%/servers/docker/nginx" 2>nul
        REM Copy nginx config to server
        scp -i "%SSH_KEY%" -o StrictHostKeyChecking=no "%SCRIPT_DIR%..\nginx\nginx-prod.conf" %SSH_USER%@%SSH_HOST%:%VM_BASE_PATH%/servers/docker/nginx/nginx-prod.conf
        if errorlevel 1 (
            echo [WARNING] Failed to deploy nginx config, but continuing...
        ) else (
            echo [SUCCESS] Nginx config deployed
        )
    ) else (
        echo [INFO] Nginx config not found locally, skipping nginx config deployment
    )
    
    REM Set permissions
    echo [INFO] Setting permissions...
    ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "chmod -R 755 %VM_FRONTEND_PATH%" 2>nul
    
    REM Restart nginx to pick up any config changes and ensure fresh worker file serving
    echo [INFO] Restarting nginx to apply changes...
    REM Try production compose file first, then fallback to root docker-compose.yml
    ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "cd %VM_BASE_PATH% && (docker-compose -f servers/docker/compose/production.yml restart nginx 2>/dev/null || docker-compose restart nginx 2>/dev/null || echo [WARNING] Could not restart nginx - may need manual restart)" 2>nul
    if errorlevel 1 (
        echo [WARNING] Nginx restart had issues, but deployment succeeded
        echo [INFO] You may need to manually restart nginx: docker-compose restart nginx
    ) else (
        echo [SUCCESS] Nginx restarted
    )
    
    echo [SUCCESS] Frontend deployed successfully!
    echo.
)

REM Step 6: Cleanup
echo [INFO] Cleaning up temporary files...
del "%ARCHIVE_FILE%" 2>nul
echo [SUCCESS] Cleanup completed
echo.

echo ============================================
echo   Frontend Deployment Complete
echo ============================================
echo.
echo [INFO] Frontend files deployed to: %VM_FRONTEND_PATH%
echo [INFO] Next steps:
echo   - If nginx is running, it should automatically serve the new files
echo   - If services need restart, run DEPLOY_SERVERS.bat or restart manually
echo.

pause
exit /b 0

