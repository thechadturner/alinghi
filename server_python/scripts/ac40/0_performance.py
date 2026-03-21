import sys
import json
import os
import pandas as pd
import utilities as u 

from dotenv import load_dotenv
from pathlib import Path

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (three levels up from server_python/scripts/gp50/)
project_root = Path(__file__).parent.parent.parent.parent

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

api_token = os.getenv('SYSTEM_KEY')
if not api_token:
    raise RuntimeError("SYSTEM_KEY is missing from environment configuration.")

if __name__ == "__main__":
    parameters_str = sys.argv[1]
    parameters_json = json.loads(parameters_str)

    # Get values from parameters, with fallback to local storage
    class_name = parameters_json.get('class_name')
    project_id = parameters_json.get('project_id')
    dataset_id = parameters_json.get('dataset_id')
    date = parameters_json.get('date')
    source_name = parameters_json.get('source_name')
    start_time = parameters_json.get('start_time')
    end_time = parameters_json.get('end_time')
    batch = parameters_json.get('batch', False)
    verbose = parameters_json.get('verbose')

    s = u.LocalStorage()
    s.set_item('api_token', api_token)
    s.set_item('class_name', class_name)
    s.set_item('project_id', project_id)
    s.set_item('dataset_id', dataset_id)
    s.set_item('date', date)
    s.set_item('source_name', source_name)
    s.set_item('start_time', start_time)
    s.set_item('end_time', end_time)
    s.set_item('batch', batch)
    s.set_item('verbose', verbose)

    # s = u.LocalStorage()
    # api_token = os.getenv('SYSTEM_KEY')
    # project_id = s.get_item('project_id')
    # dataset_id = s.get_item('dataset_id')
    # class_name = s.get_item('class_name')
    # date = s.get_item('date')
    # source_name = s.get_item('source_name')
    # start_time = s.get_item('start_time')
    # end_time = s.get_item('end_time')
    # verbose = s.get_item('verbose')

    # # MANUAL INPUT
    # api_token = os.getenv('SYSTEM_KEY')
    # project_id = 1
    # dataset_id = 100
    # class_name = "GP50"
    # date = "20260301"
    # source_name = "GER"
    # start_time = None
    # end_time = None
    # verbose = True

    # s = u.LocalStorage()
    # s.set_item('api_token', api_token)
    # s.set_item('class_name', class_name)
    # s.set_item('project_id', project_id)
    # s.set_item('dataset_id', dataset_id)
    # s.set_item('date', date)
    # s.set_item('source_name', source_name)
    # s.set_item('start_time', start_time)
    # s.set_item('end_time', end_time)

    # print(api_token, project_id, dataset_id, class_name, date, source_name, start_time, end_time)

    u.log(api_token, "0_performance.py", "info", f"Executing script on ${source_name} and ${date}", str(u.dt.now()))

    # Print parameter values for debugging
    print(f"Starting Performance script with parameters:", flush=True)
    print(f"  api_token: {'*****' + api_token[-4:] if api_token and len(api_token) > 4 else 'MISSING'}", flush=True)
    print(f"  project_id: {project_id}", flush=True)
    print(f"  dataset_id: {dataset_id}", flush=True)
    print(f"  class_name: {class_name}", flush=True)
    print(f"  date: {date}", flush=True)
    print(f"  source_name: {source_name}", flush=True)
    print(f"  verbose: {verbose}", flush=True)

    success_status = []

    #Execute Scripts
    try:
        import Performance
        success = Performance.start(api_token, project_id, dataset_id, class_name, date, source_name, None, None, verbose)
        success_status.append(success)
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"ERROR calling Performance.start(): {str(e)}", flush=True)
        print(f"Full traceback:\n{error_details}", flush=True)
        u.log(api_token, "0_performance.py", "error", "Performance.start() failed", f"{str(e)}\n{error_details}")
        success_status.append(False)

    # UPDATE DATASET VISIBILITY
    if any(not status for status in success_status):
        u.log(api_token, "0_performance.py", "info", "Scripts Failed!", str(u.dt.now()))
        print("Scripts Failed:", u.dt.now(), flush=True)
        sys.exit(1)  # Exit with error code to signal failure to the server
    else:
        try:
            u.update_dataset_date_modified(api_token, class_name, project_id, dataset_id=dataset_id)
        except Exception as e:
            u.log(api_token, "0_performance.py", "warn", "date_modified update", f"Failed to update date_modified: {str(e)}")

        u.log(api_token, "0_performance.py", "info", "Script Completed!", str(u.dt.now()))
        print("Script Completed:", u.dt.now(), flush=True)
        sys.exit(0)  # Exit with success code