# run.py
import os
from dotenv import load_dotenv
from pathlib import Path
import uvicorn

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (two levels up from server_python/)
project_root = Path(__file__).parent.parent

# Load environment files based on mode
# Development: .env -> .env.local
# Production: .env.production -> .env.production.local
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"

base_env_path = project_root / base_env_file
local_env_path = project_root / local_env_file

# Load base .env file first (defaults)
load_dotenv(dotenv_path=base_env_path)

# Load local .env file second (overrides base, gitignored secrets)
load_dotenv(dotenv_path=local_env_path, override=True)

port = int(os.getenv("PYTHON_PORT", 8049))

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app", 
        host="0.0.0.0", 
        port=port, 
        reload=True,
        reload_dirs=["./app"]  # Specify only your app directory
    )