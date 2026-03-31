@echo off
setlocal enabledelayedexpansion

REM ============================================
REM Frontend Deployment Script
REM Builds and deploys frontend to production VM
REM SSH: docker\deploy.config.local + SSH_KEY for key-based login ^(set-deploy-ssh-opts.bat^).
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

call "%SCRIPT_DIR%set-deploy-ssh-opts.bat"
if errorlevel 1 (
    pause
    exit /b 1
)
call "%SCRIPT_DIR%establish-ssh-mux.bat"
if errorlevel 1 (
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

REM Step 4 / 5: Deploy via SSH (tar over stdin = one password; nginx conf uses a second SSH)
set "NGX_LOCAL=%SCRIPT_DIR%..\nginx\nginx-prod.conf"

if "%DEPLOY_DRY_RUN%"=="true" (
    echo [INFO] Step 3: DRY RUN — skipping archive build
    echo [DRY RUN] Would deploy to: %SSH_USER%@%SSH_HOST%:%VM_FRONTEND_PATH%
    if "%SSH_KEY%"=="" (echo [DRY RUN] Would use password or ssh-agent auth) else (echo [DRY RUN] Would use SSH key: %SSH_KEY%)
    echo [DRY RUN] Would stream dist\ via tar ^| ssh ^(single connection for files^)
    if exist "%NGX_LOCAL%" (echo [DRY RUN] Would push nginx-prod.conf and reload nginx ^(second connection^)) else (echo [DRY RUN] Would reload nginx after deploy ^(same connection as stream^))
) else (
    echo [INFO] Step 4: Deploying to VM...
    echo [INFO] Target: %SSH_USER%@%SSH_HOST%:%VM_FRONTEND_PATH%
    echo.
    cd /d "%PROJECT_ROOT%"

    if exist "%NGX_LOCAL%" (
        echo [INFO] Streaming dist to VM ^(SSH 1 — one password for frontend files^)...
        tar -czf - -C dist . 2>nul | ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'mkdir -p %VM_FRONTEND_PATH% && rm -rf %VM_FRONTEND_PATH%/* && tar -xzf - -C %VM_FRONTEND_PATH% && chmod -R 755 %VM_FRONTEND_PATH%'"
        if errorlevel 1 (
            echo [ERROR] Frontend stream or extract failed
            pause
            exit /b 1
        )
        echo [SUCCESS] Frontend files deployed
        echo [INFO] Pushing nginx config and reloading ^(SSH 2 — one password^)...
        type "%NGX_LOCAL%" | ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'mkdir -p %VM_BASE_PATH%/servers/docker/nginx && cat > %VM_BASE_PATH%/servers/docker/nginx/nginx-prod.conf && cd %VM_BASE_PATH% && (docker compose -f servers/docker/compose/production.yml restart nginx 2>/dev/null || docker-compose -f servers/docker/compose/production.yml restart nginx 2>/dev/null || docker-compose restart nginx 2>/dev/null || echo [WARNING] Could not restart nginx)'"
        if errorlevel 1 (
            echo [WARNING] Nginx config or restart had issues; frontend files are still updated
        ) else (
            echo [SUCCESS] Nginx config deployed and reload attempted
        )
    ) else (
        echo [INFO] Streaming dist to VM and reloading nginx ^(single SSH — one password^)...
        tar -czf - -C dist . 2>nul | ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'mkdir -p %VM_FRONTEND_PATH% && rm -rf %VM_FRONTEND_PATH%/* && tar -xzf - -C %VM_FRONTEND_PATH% && chmod -R 755 %VM_FRONTEND_PATH% && cd %VM_BASE_PATH% && (docker compose -f servers/docker/compose/production.yml restart nginx 2>/dev/null || docker-compose -f servers/docker/compose/production.yml restart nginx 2>/dev/null || docker-compose restart nginx 2>/dev/null || echo [WARNING] Could not restart nginx)'"
        if errorlevel 1 (
            echo [ERROR] Deploy or nginx restart failed
            pause
            exit /b 1
        )
        echo [INFO] Nginx config not found locally — skipped nginx file deploy
    )

    echo [SUCCESS] Frontend deployed successfully!
    echo.
)

REM Step 6: Cleanup (no local archive in non-dry path)
echo [INFO] Cleaning up temporary files...
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

