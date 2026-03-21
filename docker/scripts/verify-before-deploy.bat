@echo off
REM Pre-deployment verification script
REM Run this before deploying to ensure everything is configured correctly

echo ============================================
echo   Pre-Deployment Verification
echo ============================================
echo.

set "ERRORS=0"

REM Check 1: Verify production-prebuilt.yml is correct
echo [1] Checking production-prebuilt.yml...
if not exist "docker\compose\production-prebuilt.yml" (
    echo   [ERROR] production-prebuilt.yml not found
    set /a ERRORS+=1
    goto :end
)

REM Check if INFLUX_TOKEN is in environment section (should NOT be)
findstr /C:"INFLUX_TOKEN=${INFLUX_TOKEN:-}" "docker\compose\production-prebuilt.yml" >nul 2>&1
if %errorlevel% equ 0 (
    echo   [ERROR] INFLUX_TOKEN found in environment section - this will prevent env_file from loading it
    set /a ERRORS+=1
) else (
    echo   [OK] INFLUX_TOKEN NOT in environment section
)

REM Check if INFLUX_BUCKET is in environment section (should NOT be)
findstr /C:"INFLUX_BUCKET=${INFLUX_BUCKET:-}" "docker\compose\production-prebuilt.yml" >nul 2>&1
if %errorlevel% equ 0 (
    echo   [ERROR] INFLUX_BUCKET found in environment section - this will prevent env_file from loading it
    set /a ERRORS+=1
) else (
    echo   [OK] INFLUX_BUCKET NOT in environment section
)

REM Check if env_file section exists
findstr /C:"env_file:" "docker\compose\production-prebuilt.yml" >nul 2>&1
if %errorlevel% neq 0 (
    echo   [ERROR] env_file section not found
    set /a ERRORS+=1
) else (
    echo   [OK] env_file section exists
)

REM Check if .env.production.local is mentioned in env_file
findstr /C:".env.production.local" "docker\compose\production-prebuilt.yml" >nul 2>&1
if %errorlevel% neq 0 (
    echo   [ERROR] .env.production.local not found in env_file section
    set /a ERRORS+=1
) else (
    echo   [OK] .env.production.local is in env_file section
)
echo.

REM Check 2: Verify .env.production.local exists (optional - might not be in repo)
echo [2] Checking .env.production.local...
if not exist ".env.production.local" (
    echo   [WARNING] .env.production.local not found locally
    echo   [INFO] This is OK if it exists on the production server
) else (
    echo   [OK] .env.production.local exists locally
    
    REM Check if it contains INFLUX_TOKEN
    findstr /B /C:"INFLUX_TOKEN=" ".env.production.local" >nul 2>&1
    if %errorlevel% neq 0 (
        echo   [WARNING] INFLUX_TOKEN not found in .env.production.local
    ) else (
        echo   [OK] INFLUX_TOKEN found in .env.production.local
    )
    
    REM Check if it contains INFLUX_BUCKET
    findstr /B /C:"INFLUX_BUCKET=" ".env.production.local" >nul 2>&1
    if %errorlevel% neq 0 (
        echo   [WARNING] INFLUX_BUCKET not found in .env.production.local
    ) else (
        echo   [OK] INFLUX_BUCKET found in .env.production.local
    )
)
echo.

REM Check 3: Verify deploy script exists
echo [3] Checking deploy script...
if not exist "docker\DEPLOY_VM_SERVERS.bat" (
    echo   [ERROR] DEPLOY_VM_SERVERS.bat not found
    set /a ERRORS+=1
) else (
    echo   [OK] DEPLOY_VM_SERVERS.bat exists
)
echo.

REM Check 4: Verify production.yml is also correct (for consistency)
echo [4] Checking production.yml (for consistency)...
if exist "docker\compose\production.yml" (
    findstr /C:"INFLUX_TOKEN=${INFLUX_TOKEN:-}" "docker\compose\production.yml" >nul 2>&1
    if %errorlevel% equ 0 (
        echo   [WARNING] INFLUX_TOKEN found in production.yml environment section
    ) else (
        echo   [OK] production.yml is correctly configured
    )
) else (
    echo   [INFO] production.yml not found (not used in prebuilt deployment)
)
echo.

REM Summary
echo ============================================
echo   Summary
echo ============================================
if %ERRORS% equ 0 (
    echo [SUCCESS] All checks passed! Ready to deploy.
    echo.
    echo Next steps:
    echo   1. Ensure .env.production.local exists on production server with INFLUX_TOKEN and INFLUX_BUCKET
    echo   2. Run: docker\DEPLOY_VM_SERVERS.bat
    echo   3. After deployment, verify on server: docker exec hunico-node sh -c 'echo "INFLUX_TOKEN=${INFLUX_TOKEN:+SET}${INFLUX_TOKEN:-NOT_SET}"'
    exit /b 0
) else (
    echo [ERROR] Found %ERRORS% error(s) - please fix before deploying
    exit /b 1
)

:end
if %ERRORS% gtr 0 (
    exit /b 1
) else (
    exit /b 0
)
