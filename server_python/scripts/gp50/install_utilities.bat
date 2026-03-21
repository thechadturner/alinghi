@echo off
REM Batch script to install utilities library for local development
REM This installs the utilities package in editable mode

echo Installing utilities library...
echo.

REM Get the script directory and navigate to utilities
REM From server_python\scripts\ac75\ to root: go up 3 levels (..\..\..)
set SCRIPT_DIR=%~dp0
set UTILITIES_DIR=%SCRIPT_DIR%..\..\..\libs\utilities

echo Changing to utilities directory: %UTILITIES_DIR%
cd /d "%UTILITIES_DIR%"

if not exist "%UTILITIES_DIR%" (
    echo ERROR: Utilities directory not found at %UTILITIES_DIR%
    pause
    exit /b 1
)

echo.
echo Step 1: Installing dependencies from requirements.txt...
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Failed to install requirements
    pause
    exit /b 1
)

echo.
echo Step 2: Installing utilities package in editable mode...
pip install -e .
if errorlevel 1 (
    echo ERROR: Failed to install utilities package
    pause
    exit /b 1
)

echo.
echo ========================================
echo Utilities library installed successfully!
echo ========================================
echo.
pause

