@echo off
setlocal enabledelayedexpansion

REM ============================================
REM Server Deployment Script
REM Builds and deploys all servers to production VM
REM SSH: use docker\deploy.config.local with SSH_KEY=path\to\private key ^(see set-deploy-ssh-opts.bat^).
REM
REM TLS: PEMs are gitignored. Before wiping VM_SERVERS_PATH we copy servers/docker/nginx/ssl into
REM VM_BASE_PATH/.deploy-ssl-preserve, then merge it back after extract. If still no fullchain.pem
REM + privkey.pem, docker/scripts/ensure-nginx-tls-on-vm.sh generates self-signed certs ^(optional
REM DEPLOY_NGINX_TLS_SAN_IP in deploy.config.local for an extra IP in SAN^).
REM ============================================

REM Get script directory and set up logging
set "SCRIPT_DIR=%~dp0"
set "LOG_FILE=%SCRIPT_DIR%deploy_vm_servers.log"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "CONFIG_FILE=%SCRIPT_DIR%deploy.config"

echo.
echo ============================================
echo   Server Deployment to Production VM
echo ============================================
echo.
echo [INFO] Deployment started: %date% %time%
echo [INFO] Log file: %LOG_FILE%
echo.

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

REM Trim whitespace from DEPLOY_DRY_RUN
set "DEPLOY_DRY_RUN=%DEPLOY_DRY_RUN: =%"

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
if "%VM_SERVERS_PATH%"=="" (
    echo [ERROR] VM_SERVERS_PATH not configured in %CONFIG_FILE%
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

REM Step 1: Build HuniDB library
echo [INFO] Step 1: Building HuniDB library...
echo.
call npm run build:hunidb
if errorlevel 1 (
    echo [ERROR] HuniDB build failed!
    pause
    exit /b 1
)
echo [SUCCESS] HuniDB build completed
echo.

REM Step 1a: Create temporary deployment directory FIRST
set "TEMP_DIR=%TEMP%\hunico-servers-deploy-%RANDOM%"
echo [INFO] Creating temporary directory: %TEMP_DIR%
mkdir "%TEMP_DIR%" 2>nul
if not exist "%TEMP_DIR%" (
    echo [ERROR] Failed to create temporary directory
    echo [INFO] Temp path: %TEMP%
    pause
    exit /b 1
)
echo [SUCCESS] Temporary directory created
mkdir "%TEMP_DIR%\servers" 2>nul
echo.

REM Step 1b: Build Docker images locally
echo [INFO] Step 1c: Building Docker images locally...
echo [INFO] This avoids building on the VM and is much faster
echo.

REM Build Node.js image (includes ffmpeg/ffprobe for video upload metadata; SKIP_VIDEO_FFMPEG at runtime only skips encoding)
echo [INFO] Building hunico-node image...
docker build -f docker/dockerfiles/Dockerfile.nodejs -t hunico-node:latest . >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to build Node.js Docker image
    echo [INFO] Run: docker build --build-arg SKIP_VIDEO_FFMPEG=%%SKIP_VIDEO_FFMPEG%% -f docker/dockerfiles/Dockerfile.nodejs -t hunico-node:latest .
    pause
    exit /b 1
)
echo [SUCCESS] hunico-node image built

REM Build Python image
echo [INFO] Building hunico-python image...
docker build -f docker/dockerfiles/Dockerfile.python -t hunico-python:latest . >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to build Python Docker image
    echo [INFO] Run: docker build -f docker/dockerfiles/Dockerfile.python -t hunico-python:latest .
    pause
    exit /b 1
)
echo [SUCCESS] hunico-python image built

REM Save images to tar file (temp directory now exists)
echo [INFO] Saving Docker images to tar file...
echo [DEBUG] Output file: %TEMP_DIR%\docker-images.tar
docker save hunico-node:latest hunico-python:latest -o "%TEMP_DIR%\docker-images.tar" 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to save Docker images to temp directory
    echo [INFO] Trying alternative location...
    set "ALT_TAR=%USERPROFILE%\docker-images.tar"
    docker save hunico-node:latest hunico-python:latest -o "!ALT_TAR!" 2>&1
    if errorlevel 1 (
        echo [ERROR] Failed to save Docker images to alternative location
        pause
        exit /b 1
    )
    echo [SUCCESS] Docker images saved to: !ALT_TAR!
    echo [INFO] Moving to temp directory...
    move /Y "!ALT_TAR!" "%TEMP_DIR%\docker-images.tar" >nul
) else (
    echo [SUCCESS] Docker images saved
)
echo.

REM Step 3: Copy server directories (excluding node_modules)
echo [INFO] Step 2: Packaging server files...
echo [INFO] Excluding node_modules - will be installed on VM...
echo [INFO] Using robocopy to exclude node_modules directories...
echo.

REM Copy server directories (exclude unnecessary files/dirs)
REM robocopy returns 0-7 for success, 8+ for errors
REM /XD excludes directories, /XF excludes files, /E copies subdirectories including empty ones
REM /NFL /NDL /NJH /NJS /NP suppresses output for cleaner logs
REM Exclude: node_modules, .git, logs, dist, build, coverage, test files, docs, cache, etc.
REM server_python is not deployed here - app runs from Docker image; scripts go to VM_SCRIPTS_PATH only
for %%d in (server_app server_admin server_file server_media server_stream) do (
    if exist "%%d" (
        echo [INFO] Copying %%d - excluding unnecessary files...
        robocopy "%%d" "%TEMP_DIR%\servers\%%d" /E /XD node_modules .git logs dist build coverage .vscode .idea .cache .npm __tests__ docs test tests /XF *.log *.db *.sqlite *.bak *.backup *.md README* *.test.* *.spec.* *.pyc *.ignore /NFL /NDL /NJH /NJS /NP >nul
        if errorlevel 8 (
            echo [WARNING] Failed to copy %%d
        ) else (
            echo [SUCCESS] %%d copied
        )
    )
)

REM Copy shared directory (exclude unnecessary files/dirs)
if exist "shared" (
    echo [INFO] Copying shared - excluding unnecessary files...
    robocopy "shared" "%TEMP_DIR%\servers\shared" /E /XD node_modules .git logs dist build coverage .vscode .idea .cache .npm __tests__ docs test tests /XF *.log *.db *.sqlite *.bak *.backup *.md README* *.test.* *.spec.* *.pyc *.ignore /NFL /NDL /NJH /NJS /NP >nul
    if errorlevel 8 (
        echo [WARNING] Failed to copy shared
    ) else (
        echo [SUCCESS] shared copied
    )
)

REM Copy frontend directory (CRITICAL for nginx to serve the website!)
REM Frontend is deployed separately using DEPLOY_VM_FRONTEND.bat
echo [INFO] Note: Frontend should be deployed separately using DEPLOY_VM_FRONTEND.bat
echo [INFO] Skipping frontend in server deployment...

REM Copy libs directory - only production files needed
if exist "libs" (
    echo [INFO] Copying libs - production files only...
    mkdir "%TEMP_DIR%\servers\libs" 2>nul
    
    REM Copy huni_db - only dist/ and package.json (already built in Step 1)
    if exist "libs\huni_db" (
        echo [INFO] Copying huni_db - dist and package.json only...
        mkdir "%TEMP_DIR%\servers\libs\huni_db" 2>nul
        REM Copy dist directory (the built output)
        if exist "libs\huni_db\dist" (
            robocopy "libs\huni_db\dist" "%TEMP_DIR%\servers\libs\huni_db\dist" /E /NFL /NDL /NJH /NJS /NP >nul
        )
        REM Copy package.json (needed for dependency info)
        if exist "libs\huni_db\package.json" (
            copy /Y "libs\huni_db\package.json" "%TEMP_DIR%\servers\libs\huni_db\package.json" >nul
        )
        echo [SUCCESS] huni_db copied (dist and package.json only)
    )
    
    REM Copy utilities - Python package only (exclude tests, docs, cache, build artifacts)
    if exist "libs\utilities" (
        echo [INFO] Copying utilities - Python package only...
        mkdir "%TEMP_DIR%\servers\libs\utilities" 2>nul
        
        REM Copy utilities package directory (the actual Python package)
        if exist "libs\utilities\utilities" (
            robocopy "libs\utilities\utilities" "%TEMP_DIR%\servers\libs\utilities\utilities" /E /XD __pycache__ /XF *.pyc *.pyo *.ignore /NFL /NDL /NJH /NJS /NP >nul
        )
        
        REM Copy setup files needed for installation
        if exist "libs\utilities\setup.py" (
            copy /Y "libs\utilities\setup.py" "%TEMP_DIR%\servers\libs\utilities\setup.py" >nul
        )
        if exist "libs\utilities\pyproject.toml" (
            copy /Y "libs\utilities\pyproject.toml" "%TEMP_DIR%\servers\libs\utilities\pyproject.toml" >nul
        )
        if exist "libs\utilities\requirements.txt" (
            copy /Y "libs\utilities\requirements.txt" "%TEMP_DIR%\servers\libs\utilities\requirements.txt" >nul
        )
        if exist "libs\utilities\LICENSE" (
            copy /Y "libs\utilities\LICENSE" "%TEMP_DIR%\servers\libs\utilities\LICENSE" >nul
        )
        
        echo [SUCCESS] utilities copied (package and setup files only)
    )
)

REM Copy Docker files
echo [INFO] Copying Docker configuration...
if exist "docker\compose" (
    mkdir "%TEMP_DIR%\servers\docker\compose" 2>nul
    copy /Y "docker\compose\production-prebuilt.yml" "%TEMP_DIR%\servers\docker\compose\production-prebuilt.yml" >nul
    copy /Y "docker\compose\production.yml" "%TEMP_DIR%\servers\docker\compose\production.yml" >nul
    if errorlevel 1 (
        echo [WARNING] Failed to copy production.yml
    )
)
if exist "docker\dockerfiles" (
    xcopy /E /I /Y "docker\dockerfiles" "%TEMP_DIR%\servers\docker\dockerfiles\" >nul
    if errorlevel 1 (
        echo [WARNING] Failed to copy dockerfiles
    )
)
REM Copy nginx config (exclude logs, docs, and all log files - logs are generated on VM)
if exist "docker\nginx" (
    echo [INFO] Copying nginx config - excluding logs, docs, and log files...
    REM Create nginx directory first (but not logs subdirectory)
    mkdir "%TEMP_DIR%\servers\docker\nginx" 2>nul
    REM Copy nginx files excluding logs directory, docs, and all .log files
    REM /XD logs excludes the logs directory entirely
    REM /XF *.log excludes all .log files anywhere in the tree
    robocopy "docker\nginx" "%TEMP_DIR%\servers\docker\nginx" /E /XD logs docs /XF *.log *.md README* *.pyc *.ignore /NFL /NDL /NJH /NJS /NP >nul
    if errorlevel 8 (
        echo [WARNING] Failed to copy nginx config
    ) else (
        echo [SUCCESS] nginx config copied (logs and docs excluded)
        REM Create empty logs directory on VM (nginx will populate it at runtime)
        mkdir "%TEMP_DIR%\servers\docker\nginx\logs" 2>nul
    )
    if not exist "%TEMP_DIR%\servers\docker\nginx\nginx-prod.conf" (
        echo [ERROR] Packaged tree is missing servers\docker\nginx\nginx-prod.conf - Docker will fail to start hunico-nginx.
        echo [ERROR] Ensure docker\nginx\nginx-prod.conf exists in the repo and robocopy succeeded.
        pause
        exit /b 1
    )
)
REM Copy docker scripts (exclude docs and test files)
if exist "docker\scripts" (
    echo [INFO] Copying docker scripts - excluding docs and tests...
    robocopy "docker\scripts" "%TEMP_DIR%\servers\docker\scripts" /E /XD docs test tests /XF *.md README* *.test.* *.spec.* *.pyc *.ignore /NFL /NDL /NJH /NJS /NP >nul
    if errorlevel 8 (
        echo [WARNING] Failed to copy scripts
    ) else (
        echo [SUCCESS] docker scripts copied (docs excluded)
    )
)
if exist "docker\setup-vm.sh" (
    copy /Y "docker\setup-vm.sh" "%TEMP_DIR%\servers\docker\setup-vm.sh" >nul
    if errorlevel 1 (
        echo [WARNING] Failed to copy setup-vm.sh
    ) else (
        echo [SUCCESS] setup-vm.sh copied
    )
)
REM Copy service management scripts
for %%s in (install-docker.sh start-services.sh stop-services.sh restart-services.sh status-services.sh) do (
    if exist "docker\%%s" (
        copy /Y "docker\%%s" "%TEMP_DIR%\servers\docker\%%s" >nul
        if errorlevel 1 (
            echo [WARNING] Failed to copy %%s
        ) else (
            echo [SUCCESS] %%s copied
        )
    )
)

echo [SUCCESS] Server files packaged
echo.

REM Step 4: Handle environment files
echo [INFO] Step 3: Preparing environment files...
REM Copy env files to both servers directory and base directory (for docker-compose)
if exist ".env.production" (
    copy /Y ".env.production" "%TEMP_DIR%\servers\.env.production" >nul
    copy /Y ".env.production" "%TEMP_DIR%\.env.production" >nul
    echo [INFO] Copied .env.production
) else (
    echo [WARNING] .env.production not found - using template
    if exist ".env.production.template" (
        copy /Y ".env.production.template" "%TEMP_DIR%\servers\.env.production" >nul
        copy /Y ".env.production.template" "%TEMP_DIR%\.env.production" >nul
        echo [INFO] Copied .env.production.template as .env.production
    )
)
if exist ".env.production.local" (
    copy /Y ".env.production.local" "%TEMP_DIR%\servers\.env.production.local" >nul
    copy /Y ".env.production.local" "%TEMP_DIR%\.env.production.local" >nul
    echo [INFO] Copied .env.production.local
    echo [INFO] Note: Ensure .env.production.local contains InfluxDB config (INFLUX_HOST, INFLUX_TOKEN, INFLUX_BUCKET)
) else (
    echo [WARNING] .env.production.local not found - secrets may be missing
    echo [INFO] Create .env.production.local with your production secrets
    echo [INFO] Required for InfluxDB: INFLUX_HOST, INFLUX_TOKEN, INFLUX_BUCKET, INFLUX_DATABASE
)
echo.

REM Step 5: Create docker-compose.yml in root (use prebuilt version)
echo [INFO] Step 4: Creating production docker-compose.yml...
if exist "%TEMP_DIR%\servers\docker\compose\production-prebuilt.yml" (
    copy /Y "%TEMP_DIR%\servers\docker\compose\production-prebuilt.yml" "%TEMP_DIR%\docker-compose.yml" >nul
    if errorlevel 1 (
        echo [WARNING] Failed to copy docker-compose.yml
    ) else (
        echo [SUCCESS] docker-compose.yml created
    )
) else (
    echo [ERROR] production.yml not found in temp directory
    echo [INFO] Check if docker\compose\production.yml exists
)
echo [INFO] Step 4 completed successfully
echo [INFO] Starting Step 5: Deploy via SSH
if /i "%DEPLOY_DRY_RUN%"=="true" goto :dry_run_section
goto :real_deploy_section

:dry_run_section
echo [DRY RUN] Would deploy to: %SSH_USER%@%SSH_HOST%:%VM_SERVERS_PATH%
if "%SSH_KEY%"=="" (echo [DRY RUN] Would use password or ssh-agent auth) else (echo [DRY RUN] Would use SSH key: %SSH_KEY%)
echo [DRY RUN] Would copy files from: %TEMP_DIR%
goto :deploy_end

:real_deploy_section
echo [INFO] Step 5: Deploying to VM...
echo [INFO] Target: %SSH_USER%@%SSH_HOST%:%VM_SERVERS_PATH%
echo.

REM Step 5a: Clean up existing files on VM (clean deployment)
echo [INFO] Step 5a: Cleaning up existing files on VM...
if /i "%DEPLOY_SUDO_CHOWN%"=="false" (
    echo [INFO] Skipping sudo chown ^(DEPLOY_SUDO_CHOWN=false in deploy.config^). Step 6 chmod on docker-compose.yml is skipped too. Use only if paths are owned by %SSH_USER%.
) else (
    echo [INFO] Ensuring deploy user owns VM paths ^(fixes root-owned leftovers from Docker^)...
    echo [INFO] You may be prompted for your Linux sudo password for user %SSH_USER%. To skip, set DEPLOY_SUDO_CHOWN=false in deploy.config.local ^(see deploy.config^).
    REM ssh -t allocates a TTY so remote sudo can prompt; without -t, sudo waits invisibly and appears hung
    ssh -t %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "sudo chown -R %SSH_USER% %VM_SERVERS_PATH% %VM_BASE_PATH% || true"
)
REM TLS preserve + compose down + Docker wipe of server tree ^(two SSH calls; root-owned nginx/ssl needs container rm^)
echo [INFO] Stopping Docker, cleaning server tree, pruning images/volumes, creating dirs ^(single SSH — one password^)...
echo [INFO] Preserving TLS under %VM_BASE_PATH%/.deploy-ssl-preserve ^(Docker copy: PEMs may be root-owned from cert generation^)...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "mkdir -p %VM_BASE_PATH%/.deploy-ssl-preserve && docker run --rm -v %VM_SERVERS_PATH%:/srv -v %VM_BASE_PATH%/.deploy-ssl-preserve:/out alpine sh -c \"mkdir -p /out && if [ -d /srv/docker/nginx/ssl ]; then cp -a /srv/docker/nginx/ssl/. /out/; fi; exit 0\""
echo [INFO] Stopping Docker, cleaning server tree ^(Docker rm clears root-owned ssl under servers path^)...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'cd %VM_BASE_PATH% && (docker compose -f docker-compose.yml down --remove-orphans 2>/dev/null || docker-compose -f docker-compose.yml down --remove-orphans 2>/dev/null || true); docker run --rm -v %VM_SERVERS_PATH%:/mnt alpine rm -rf /mnt/* 2>/dev/null || true; rm -rf %VM_SERVERS_PATH%/* 2>/dev/null || true; rm -f %VM_BASE_PATH%/docker-images.tar; docker image prune -f; docker volume prune -f; mkdir -p %VM_SERVERS_PATH% %VM_BASE_PATH% %VM_BASE_PATH%/scripts'"
echo [SUCCESS] VM cleanup and remote directories ready
echo.
echo [INFO] Scripts directory: %VM_BASE_PATH%/scripts

REM Deploy server files using tar+gzip (more reliable for large transfers)
echo [INFO] Creating compressed archive of server files...
echo [INFO] Note: Frontend is deployed separately using DEPLOY_VM_FRONTEND.bat
cd /d "%TEMP_DIR%"
if errorlevel 1 (
    echo [ERROR] Failed to change to temp directory: %TEMP_DIR%
    echo [ERROR] Temp directory may not exist
    echo [ERROR] Current directory: %CD%
    goto :error_exit
)

REM Verify servers directory exists before creating archive
if not exist "servers" (
    echo [ERROR] servers directory not found in temp directory: %TEMP_DIR%\servers
    echo [ERROR] This indicates the file copying step failed
    echo [ERROR] Listing contents of temp directory:
    dir /b "%TEMP_DIR%" 2>nul
    goto :error_exit
)

REM Verify servers directory is not empty
dir /b "servers" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] servers directory exists but appears to be empty
    echo [ERROR] This indicates the file copying step failed
    goto :error_exit
)

echo [INFO] Creating archive from servers directory...
echo [INFO] Current directory: %CD%
echo [INFO] Servers directory contents:
dir /b "servers" 2>nul | findstr /v "^$" | findstr /n "^" | more
echo.
echo [INFO] Running: tar -czf servers.tar.gz servers
tar -czf servers.tar.gz servers 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to create tar archive
    echo [ERROR] Tar command returned error code: %ERRORLEVEL%
    echo [INFO] Check that servers directory exists and contains files
    echo [INFO] Verify tar is available: tar --version
    goto :error_exit
)
echo [SUCCESS] Archive created (servers only - frontend deployed separately)

echo.
echo [INFO] Step 6: Uploading server archive, compose, env, and permissions to VM...
echo [INFO] Testing SSH reachability to %SSH_USER%@%SSH_HOST% ...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "mkdir -p %VM_SERVERS_PATH% && echo ok"
if errorlevel 1 (
    echo [ERROR] Cannot reach the VM over SSH ^(see hints below^).
    call :print_ssh_connect_hints
    pause
    exit /b 1
)
echo [INFO] Uploading server files archive via SCP...
echo [INFO] This may take a few minutes depending on file size...
scp %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "%TEMP_DIR%\servers.tar.gz" %SSH_USER%@%SSH_HOST%:%VM_BASE_PATH%/servers.tar.gz
if errorlevel 1 (
    echo [ERROR] Failed to upload server files archive
    call :print_ssh_connect_hints
    pause
    exit /b 1
)
echo [SUCCESS] Server files archive uploaded

echo [INFO] Extracting files on VM...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "cd %VM_BASE_PATH% && docker run --rm -v %VM_BASE_PATH%:/mnt alpine rm -rf /mnt/servers 2>/dev/null || true && rm -rf servers 2>/dev/null || true && tar -xzf servers.tar.gz && docker run --rm -v %VM_SERVERS_PATH%:/mnt alpine rm -rf /mnt/* 2>/dev/null || true && rm -rf %VM_SERVERS_PATH%/* 2>/dev/null || true && cp -r servers/* %VM_SERVERS_PATH%/ && mkdir -p %VM_SERVERS_PATH%/docker/nginx/ssl && cp -a %VM_BASE_PATH%/.deploy-ssl-preserve/. %VM_SERVERS_PATH%/docker/nginx/ssl/ 2>/dev/null || true && chmod 644 %VM_SERVERS_PATH%/docker/nginx/ssl/fullchain.pem 2>/dev/null || true && chmod 600 %VM_SERVERS_PATH%/docker/nginx/ssl/privkey.pem 2>/dev/null || true && chmod 600 %VM_SERVERS_PATH%/docker/nginx/ssl/ca-key.pem 2>/dev/null || true && rm -rf servers && rm -f servers.tar.gz"
if errorlevel 1 (
    echo [ERROR] Failed to extract files on VM
    echo [INFO] Trying alternative extraction method...
    ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "docker run --rm -v %VM_SERVERS_PATH%:/mnt alpine rm -rf /mnt/* 2>/dev/null || true && cd %VM_BASE_PATH% && docker run --rm -v %VM_BASE_PATH%:/mnt alpine rm -rf /mnt/servers 2>/dev/null || true && rm -rf servers 2>/dev/null || true && tar -xzf servers.tar.gz && cp -r servers/* %VM_SERVERS_PATH%/ && mkdir -p %VM_SERVERS_PATH%/docker/nginx/ssl && cp -a %VM_BASE_PATH%/.deploy-ssl-preserve/. %VM_SERVERS_PATH%/docker/nginx/ssl/ 2>/dev/null || true && chmod 644 %VM_SERVERS_PATH%/docker/nginx/ssl/fullchain.pem 2>/dev/null || true && chmod 600 %VM_SERVERS_PATH%/docker/nginx/ssl/privkey.pem 2>/dev/null || true && chmod 600 %VM_SERVERS_PATH%/docker/nginx/ssl/ca-key.pem 2>/dev/null || true && rm -rf servers && rm -f %VM_BASE_PATH%/servers.tar.gz"
    if errorlevel 1 (
        echo [ERROR] Alternative extraction also failed
        echo.
        echo [INFO] If you see "Permission denied" or "Cannot mkdir", fix ownership on the VM:
        echo   ssh %SSH_REMOTE_OPTS% %SSH_USER%@%SSH_HOST%
        echo   sudo chown -R %SSH_USER%:%SSH_USER% %VM_BASE_PATH%
        echo   Then re-run this deploy script.
        echo.
        pause
        exit /b 1
    )
)
echo [SUCCESS] Server files deployed and extracted

echo [INFO] Ensuring nginx TLS files on VM ^(preserve merge + generate if still missing^)...
if not "%DEPLOY_NGINX_TLS_SAN_IP%"=="" (
    ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'bash %VM_SERVERS_PATH%/docker/scripts/ensure-nginx-tls-on-vm.sh %VM_SERVERS_PATH%/docker/nginx/ssl %DEPLOY_NGINX_TLS_SAN_IP%'"
) else (
    ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'bash %VM_SERVERS_PATH%/docker/scripts/ensure-nginx-tls-on-vm.sh %VM_SERVERS_PATH%/docker/nginx/ssl'"
)
if errorlevel 1 (
    echo [ERROR] ensure-nginx-tls-on-vm.sh failed ^(openssl missing on VM, or script not in archive^).
    echo [INFO] Fix VM openssl or place fullchain.pem and privkey.pem under %VM_SERVERS_PATH%/docker/nginx/ssl
    pause
    exit /b 1
)
echo [SUCCESS] Nginx TLS directory ready

cd /d "%PROJECT_ROOT%"

REM Deploy Python scripts into VM_BASE_PATH/scripts (same tree as data and media, e.g. ~/hunico/scripts)
if exist "server_python\scripts" (
    echo [INFO] Deploying Python scripts to %VM_BASE_PATH%/scripts from project server_python/scripts...
    tar -czf "%TEMP_DIR%\scripts.tar.gz" -C server_python scripts 2>nul
    if exist "%TEMP_DIR%\scripts.tar.gz" (
        scp %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no -o ServerAliveInterval=30 "%TEMP_DIR%\scripts.tar.gz" %SSH_USER%@%SSH_HOST%:%VM_BASE_PATH%/scripts.tar.gz
        if errorlevel 1 (
            echo [WARNING] Failed to upload scripts archive
        ) else (
            ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "mkdir -p %VM_BASE_PATH%/scripts && (rm -rf %VM_BASE_PATH%/scripts/* 2>/dev/null; true) && tar -xzf %VM_BASE_PATH%/scripts.tar.gz -C %VM_BASE_PATH%/scripts --strip-components=1 && rm -f %VM_BASE_PATH%/scripts.tar.gz"
            if errorlevel 1 (
                echo [WARNING] Failed to extract scripts on VM
            ) else (
                echo [SUCCESS] Python scripts deployed to %VM_BASE_PATH%/scripts
            )
        )
        del /Q "%TEMP_DIR%\scripts.tar.gz" 2>nul
    ) else (
        echo [WARNING] Failed to create scripts archive - check server_python\scripts exists
    )
) else (
    echo [WARNING] server_python\scripts not found - VM scripts directory not updated
)

REM Deploy docker-compose.yml to base path
echo [INFO] Uploading docker-compose.yml...
scp %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no -o ServerAliveInterval=30 "%TEMP_DIR%\docker-compose.yml" %SSH_USER%@%SSH_HOST%:%VM_BASE_PATH%/docker-compose.yml
if errorlevel 1 (
    echo [ERROR] Failed to upload docker-compose.yml
    pause
    exit /b 1
)
echo [SUCCESS] docker-compose.yml uploaded

REM Deploy environment files to base path (for docker-compose)
echo [INFO] Uploading environment files...
if exist "%TEMP_DIR%\.env.production" (
    scp %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no -o ServerAliveInterval=30 "%TEMP_DIR%\.env.production" %SSH_USER%@%SSH_HOST%:%VM_BASE_PATH%/.env.production
    if errorlevel 1 (
        echo [WARNING] Failed to upload .env.production
    )
)
REM Check for .env.production.local and upload if it exists
set "ENV_LOCAL_FOUND=0"
if exist "%TEMP_DIR%\.env.production.local" (
    set "ENV_LOCAL_FOUND=1"
    scp %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no -o ServerAliveInterval=30 "%TEMP_DIR%\.env.production.local" %SSH_USER%@%SSH_HOST%:%VM_BASE_PATH%/.env.production.local
    if errorlevel 1 (
        echo [WARNING] Failed to upload .env.production.local
        set "ENV_LOCAL_FOUND=0"
    ) else (
        echo [INFO] .env.production.local uploaded (contains InfluxDB secrets)
    )
)
REM Only show warning if file was not found (not if upload failed)
if "%ENV_LOCAL_FOUND%"=="0" (
    if not exist "%TEMP_DIR%\.env.production.local" (
        echo [WARNING] .env.production.local not found - InfluxDB configuration may be missing
        echo [INFO] Python service requires: INFLUX_HOST, INFLUX_TOKEN, INFLUX_BUCKET
    )
)
REM Ensure .env exists for Compose variable substitution (Compose only auto-loads .env, not .env.production)
REM This makes SCRIPTS_DIRECTORY, DATA_DIRECTORY, MEDIA_DIRECTORY etc. apply to volume mounts
REM Use scp (same as .env.production upload) instead of ssh+cp — avoids a second SSH that can appear
REM "stalled" (hidden password prompt, mux reconnect, or ControlMaster wait after long uploads).
echo [INFO] Ensuring .env for Compose volume substitution...
if exist "%TEMP_DIR%\.env.production" (
    scp %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no -o ServerAliveInterval=30 "%TEMP_DIR%\.env.production" %SSH_USER%@%SSH_HOST%:%VM_BASE_PATH%/.env
    if errorlevel 1 (
        echo [WARNING] Failed to upload .env ^(copy of .env.production for Compose^)
    ) else (
        echo [SUCCESS] .env uploaded ^(Compose auto-loads .env for volume path substitution^)
    )
) else (
    echo [WARNING] No packaged .env.production — cannot create .env on VM
)
echo [SUCCESS] Environment files uploaded

REM Set permissions (compose file only; recursive chmod on servers tree can stall on large dirs)
REM Same opt-out as Step 5a sudo chown: DEPLOY_SUDO_CHOWN=false skips this chmod on the VM
if /i "%DEPLOY_SUDO_CHOWN%"=="false" (
    echo [INFO] Skipping chmod on docker-compose.yml ^(DEPLOY_SUDO_CHOWN=false^).
) else (
    echo [INFO] Setting permissions on docker-compose.yml...
    set "BASE_PATH_VAR=%VM_BASE_PATH%"
    ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no -o ConnectTimeout=10 %SSH_USER%@%SSH_HOST% "chmod 644 %BASE_PATH_VAR%/docker-compose.yml 2>/dev/null || true"
)

REM Step 7: Note about dependencies
REM Dependencies will be installed during Docker build, so we skip npm install here
echo [INFO] Note: Dependencies will be installed during Docker build
echo [INFO] Skipping npm install on VM (Docker handles this)
echo.

echo [SUCCESS] Servers deployed successfully!
echo.

REM Step 6a: Upload and load Docker images on VM
echo [INFO] Step 6a: Uploading Docker images to VM...
echo [INFO] This may take several minutes depending on connection speed...
REM Do not use: findstr docker-images.tar — hyphen makes findstr treat -images as switches and breaks cmd ^('take' / 'er-images.tar' errors^).
if not exist "%TEMP_DIR%\docker-images.tar" (
    echo [ERROR] docker-images.tar not found: %TEMP_DIR%\docker-images.tar
    pause
    exit /b 1
)
for %%A in ("%TEMP_DIR%\docker-images.tar") do echo [INFO] File size: %%~zA bytes ^(%%~nxA^)
scp %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -o Compression=yes "%TEMP_DIR%\docker-images.tar" %SSH_USER%@%SSH_HOST%:%VM_BASE_PATH%/docker-images.tar
if errorlevel 1 (
    echo [ERROR] Failed to upload Docker images
    echo [INFO] Cannot proceed without images
    pause
    exit /b 1
) else (
    echo [SUCCESS] Docker images uploaded
    echo.
    echo [INFO] Checking Docker on VM ^(docker load requires Docker Engine installed and %SSH_USER% able to run docker^)...
    ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no -o ConnectTimeout=15 %SSH_USER%@%SSH_HOST% "bash -lc 'command -v docker && docker --version'"
    if errorlevel 1 (
        echo [ERROR] Docker CLI not available on the VM for user %SSH_USER%.
        echo [INFO] Install Docker Engine on the VM, then: sudo usermod -aG docker %SSH_USER% ^(re-login^). See docs/distribution/installation-guide.md
        echo [INFO] Optional helper script: docker\PUSH_INSTALL_DOCKER_TO_VM.bat
        pause
        exit /b 1
    )
    echo.
    echo [INFO] Loading Docker images on VM ^(large tar: may take many minutes with no extra output — normal^)...
    REM bash -lc: login PATH ^(e.g. /snap/bin, /usr/local/bin^); plain ssh often only has /usr/bin:/bin
    ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no -o ServerAliveInterval=60 -o ServerAliveCountMax=10 %SSH_USER%@%SSH_HOST% "bash -lc 'cd %VM_BASE_PATH% && docker load -i docker-images.tar'"
    if errorlevel 1 (
        echo [ERROR] Failed to load Docker images on VM
        echo [INFO] If the VM said docker was not found, install Docker Engine and ensure user %SSH_USER% can run docker ^(see docs/distribution/installation-guide.md^).
        echo [INFO] If dockerd is stopped: sudo systemctl start docker ^(Linux^).
        echo [INFO] Quick check: ssh %SSH_USER%@%SSH_HOST% "bash -lc 'command -v docker; docker --version'"
        pause
        exit /b 1
    ) else (
        echo [SUCCESS] Docker images loaded on VM
        echo.
        echo [INFO] Cleaning up tar file on VM...
        ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "rm -f %VM_BASE_PATH%/docker-images.tar" 2>nul
        echo [SUCCESS] Cleanup completed
    )
)
echo.

:deploy_end
REM Step 7: Verify Docker images
echo [INFO] Step 7: Verifying Docker images...
echo.

if /i "%DEPLOY_DRY_RUN%"=="true" (
    echo [DRY RUN] Would verify Docker images on VM
) else (
    echo [INFO] Checking if Docker images are available on VM...
    ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'docker images | grep hunico'"
    if errorlevel 1 (
        echo [ERROR] Docker images not found on VM
        echo [INFO] Please check if images were loaded correctly
        pause
        exit /b 1
    )
    echo [SUCCESS] Docker images verified
)
echo.

REM Step 8: Final log cleanup (redundant but ensures clean state)
echo [INFO] Step 8: Final log cleanup...
echo [INFO] Ensuring all log files are removed for fresh start
echo.
if /i "%DEPLOY_DRY_RUN%"=="true" (
    echo [DRY RUN] Would clean up logs on VM
) else (
    REM Use delayed expansion (!SSH_OPTS!) — inside ( ) blocks %SSH_OPTS% expands before set runs, so -i key was dropped and ssh asked for a password
    REM Do NOT run recursive find over VM_SERVERS_PATH / VM_BASE_PATH — it can hang (large trees, NFS, bind mounts).
    set "SSH_OPTS=!SSH_REMOTE_OPTS! -o StrictHostKeyChecking=no -o BatchMode=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3"
    echo [INFO] Cleaning known log dirs only ^(no full-tree find^)...
    REM One SSH: stray *.log only at VM_BASE_PATH depth 1-2 ^(fast^), then clear standard log folders
    ssh !SSH_OPTS! %SSH_USER%@%SSH_HOST% "find %VM_BASE_PATH% -maxdepth 2 -type f -name '*.log' -delete 2>/dev/null; rm -rf %VM_SERVERS_PATH%/shared/logs/* %VM_SERVERS_PATH%/docker/nginx/logs/* %VM_SERVERS_PATH%/server_app/logs/* %VM_SERVERS_PATH%/server_admin/logs/* %VM_SERVERS_PATH%/server_file/logs/* %VM_SERVERS_PATH%/server_media/logs/* %VM_SERVERS_PATH%/server_stream/logs/* 2>/dev/null; mkdir -p %VM_SERVERS_PATH%/shared/logs %VM_SERVERS_PATH%/docker/nginx/logs %VM_SERVERS_PATH%/server_app/logs %VM_SERVERS_PATH%/server_admin/logs %VM_SERVERS_PATH%/server_file/logs %VM_SERVERS_PATH%/server_media/logs %VM_SERVERS_PATH%/server_stream/logs; echo log-cleanup-ok"
    
    echo [SUCCESS] All logs cleaned up
)
echo.

REM Step 8: Start Docker services
echo [INFO] Step 8: Starting Docker services...
echo.

if /i "%DEPLOY_DRY_RUN%"=="true" (
    echo [DRY RUN] Would start services on VM
) else (
    echo [INFO] Stopping and removing any existing containers
    ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'cd %VM_BASE_PATH% && (docker compose -f docker-compose.yml down --remove-orphans 2>/dev/null || docker-compose -f docker-compose.yml down --remove-orphans 2>/dev/null || true)'"
    
    echo [INFO] Removing any leftover containers with hunico names
    ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc \"docker ps -a --filter name=hunico --format '{{.Names}}' | xargs -r docker rm -f 2>/dev/null || true\""
    
    echo [SUCCESS] Old containers removed
    echo.
    
    echo [INFO] Starting containers with docker compose
    
    REM Try docker compose V2 first, then V1
    ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'cd %VM_BASE_PATH% && docker compose -f docker-compose.yml up -d'" 2>&1
    if errorlevel 1 (
        echo [INFO] Trying docker-compose V1
        ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'cd %VM_BASE_PATH% && docker-compose -f docker-compose.yml up -d'" 2>&1
        if errorlevel 1 (
            echo [ERROR] Failed to start Docker services
            echo [INFO] Checking for container conflicts...
            ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'docker ps -a | grep hunico'"
            pause
            exit /b 1
        ) else (
            echo [SUCCESS] Services started using docker-compose (V1)
        )
    ) else (
        echo [SUCCESS] Services started using docker compose (V2)
    )
    
    echo.
    echo [INFO] Waiting for services to be ready
    timeout /t 5 /nobreak >nul
    
    echo [INFO] Checking container status
    ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc \"docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'\""
    
    echo.
    echo [SUCCESS] All services started!
)
echo.

REM Step 9: Verify deployment
echo [INFO] Step 9: Verifying deployment...
echo.

echo [INFO] Checking all containers...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'docker ps -a'"
echo.

echo [INFO] Checking Hunico containers specifically...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc \"docker ps -a | grep hunico || echo No-hunico-containers\""
echo.

echo [INFO] Checking Docker network connectivity...
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc \"docker network inspect hunico_hunico-network 2>&1 | grep -A 5 Containers || docker network inspect hunico-network 2>&1 | grep -A 5 Containers || echo Network-not-found\""
echo.

echo [INFO] Checking container logs for errors...
echo [INFO] Redis logs:
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'docker logs hunico-redis --tail 20 2>&1 || echo redis-missing'"
echo.

echo [INFO] Node logs:
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'docker logs hunico-node --tail 30 2>&1 || echo node-missing'"
echo.

echo [INFO] Python logs:
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'docker logs hunico-python --tail 20 2>&1 || echo python-missing'"
echo.

echo [INFO] Nginx logs (last 30 lines - look for connection errors):
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'docker logs hunico-nginx --tail 30 2>&1 || echo nginx-missing'"
echo.

echo [INFO] Testing nginx -> node connectivity from inside nginx container:
ssh %SSH_REMOTE_OPTS% -o StrictHostKeyChecking=no %SSH_USER%@%SSH_HOST% "bash -lc 'docker exec hunico-nginx wget -q -O- http://node:8069/api/health 2>&1 || echo cannot-reach-node'"
echo.

REM Step 10: Cleanup
echo [INFO] Step 10: Cleaning up temporary files...
cd /d "%PROJECT_ROOT%"
del /Q "%TEMP_DIR%\docker-images.tar" 2>nul
del /Q "%TEMP_DIR%\servers.tar.gz" 2>nul
rmdir /S /Q "%TEMP_DIR%" 2>nul
echo [SUCCESS] Local cleanup completed
echo.

echo.
echo ============================================
echo   Server Deployment Complete
echo ============================================
echo.
echo [INFO] Server files deployed to: %VM_SERVERS_PATH%
echo [INFO] Docker compose file deployed to: %VM_BASE_PATH%/docker-compose.yml
echo.
echo [INFO] To view live logs on VM:
echo   ssh %SSH_REMOTE_OPTS% %SSH_USER%@%SSH_HOST%
echo   docker logs -f hunico-node
echo.
echo [INFO] To check service status:
echo   ssh %SSH_REMOTE_OPTS% %SSH_USER%@%SSH_HOST%
echo   docker ps
echo.
echo [INFO] To restart services:
echo   ssh %SSH_REMOTE_OPTS% %SSH_USER%@%SSH_HOST%
echo   cd %VM_BASE_PATH% ^&^& docker compose restart
echo.
echo [INFO] IMPORTANT: Verify InfluxDB configuration:
echo   - Ensure .env.production.local contains INFLUX_HOST, INFLUX_TOKEN, INFLUX_BUCKET
echo   - Check Python container: docker exec hunico-python sh -c 'echo INFLUX_HOST=$INFLUX_HOST'
echo   - Run verification script: bash docker/scripts/verify-deployment.sh
echo.

REM Append final status to log
(
echo.
echo ============================================
echo   Deployment completed: %date% %time%
echo ============================================
) >> "%LOG_FILE%"

echo.
echo Press any key to close...
pause >nul
exit /b 0

REM Called when SSH/SCP cannot connect (e.g. Connection timed out)
:print_ssh_connect_hints
echo.
echo [INFO] "Connection timed out" means your PC could not open TCP port 22 to %SSH_HOST%.
echo   - Use VPN or the network segment that can reach this VM
echo   - From this PC: ping %SSH_HOST%
echo   - PowerShell: Test-NetConnection -ComputerName %SSH_HOST% -Port 22
echo   - On the VM: sshd running, firewall allows 22 ^(e.g. sudo ufw allow 22/tcp^)
echo   - Non-default SSH port: add -p to ssh/scp or document in your SSH config
echo.
exit /b 0

REM Error exit handler - keeps window open and shows detailed error info
:error_exit
echo.
echo ============================================
echo   DEPLOYMENT FAILED
echo ============================================
echo.
echo [ERROR] An error occurred during deployment
echo [ERROR] Error time: %date% %time%
echo.
echo [INFO] Debugging information:
echo   - Temp directory: %TEMP_DIR%
echo   - Current directory: %CD%
echo   - Project root: %PROJECT_ROOT%
echo.
if exist "%TEMP_DIR%" (
    echo [INFO] Temp directory exists
    echo [INFO] Contents of temp directory:
    dir /b "%TEMP_DIR%" 2>nul
) else (
    echo [WARNING] Temp directory does not exist: %TEMP_DIR%
)
echo.
echo [INFO] Full error details have been logged to: %LOG_FILE%
echo.
echo [INFO] Common issues:
echo   1. Check that all required directories exist
echo   2. Verify tar command is available (Windows 10+)
echo   3. Check disk space in temp directory
echo   4. Review the log file for more details: %LOG_FILE%
echo.
echo Press any key to exit...
pause >nul
exit /b 1

REM Helper function to log to both console and file
:log
set "MSG=%~1"
echo !MSG!
echo !MSG! >> "%LOG_FILE%"
goto :eof

