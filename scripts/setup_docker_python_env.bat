@echo off
REM Setup script to create a Python virtual environment matching Docker configuration
REM This ensures local testing matches the Docker environment

echo ========================================
echo Docker Python Environment Setup
echo ========================================
echo.

REM Check Python version
python --version
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH
    exit /b 1
)

REM Create virtual environment
echo Creating virtual environment: venv_docker
python -m venv venv_docker
if errorlevel 1 (
    echo ERROR: Failed to create virtual environment
    exit /b 1
)

REM Activate virtual environment
echo Activating virtual environment...
call venv_docker\Scripts\activate.bat
if errorlevel 1 (
    echo ERROR: Failed to activate virtual environment
    exit /b 1
)

REM Upgrade pip
echo Upgrading pip...
python -m pip install --upgrade pip

REM Install server_python requirements
echo.
echo Installing server_python requirements...
cd server_python
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Failed to install server_python requirements
    cd ..
    exit /b 1
)
cd ..

REM Install utilities requirements
echo.
echo Installing utilities requirements...
cd libs\utilities
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Failed to install utilities requirements
    cd ..\..
    exit /b 1
)
cd ..\..

REM Install utilities package in editable mode
echo.
echo Installing utilities package in editable mode...
pip install -e libs\utilities
if errorlevel 1 (
    echo ERROR: Failed to install utilities package
    exit /b 1
)

echo.
echo ========================================
echo Setup Complete!
echo ========================================
echo.
echo To activate this environment in the future, run:
echo   venv_docker\Scripts\activate
echo.
echo To verify package versions match Docker:
echo   pip list
echo.

pause
























