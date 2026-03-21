#!/bin/bash
# Setup script to create a Python virtual environment matching Docker configuration
# This ensures local testing matches the Docker environment

echo "========================================"
echo "Docker Python Environment Setup"
echo "========================================"
echo ""

# Check Python version
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is not installed or not in PATH"
    exit 1
fi

python3 --version

# Create virtual environment
echo "Creating virtual environment: venv_docker"
python3 -m venv venv_docker
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to create virtual environment"
    exit 1
fi

# Activate virtual environment
echo "Activating virtual environment..."
source venv_docker/bin/activate
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to activate virtual environment"
    exit 1
fi

# Upgrade pip
echo ""
echo "Upgrading pip..."
python -m pip install --upgrade pip

# Install server_python requirements
echo ""
echo "Installing server_python requirements..."
cd server_python
pip install -r requirements.txt
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install server_python requirements"
    cd ..
    exit 1
fi
cd ..

# Install utilities requirements
echo ""
echo "Installing utilities requirements..."
cd libs/utilities
pip install -r requirements.txt
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install utilities requirements"
    cd ../..
    exit 1
fi
cd ../..

# Install utilities package in editable mode
echo ""
echo "Installing utilities package in editable mode..."
pip install -e libs/utilities
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install utilities package"
    exit 1
fi

echo ""
echo "========================================"
echo "Setup Complete!"
echo "========================================"
echo ""
echo "To activate this environment in the future, run:"
echo "  source venv_docker/bin/activate"
echo ""
echo "To verify package versions match Docker:"
echo "  pip list"
echo ""
























