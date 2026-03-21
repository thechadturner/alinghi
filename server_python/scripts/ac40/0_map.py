import sys
import json
import os
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
    s = u.LocalStorage()

    parameters_str = sys.argv[1]
    parameters_json = json.loads(parameters_str)

    class_name = parameters_json.get('class_name')
    project_id = parameters_json.get('project_id')
    dataset_id = parameters_json.get('dataset_id')
    date = parameters_json.get('date')
    source_name = parameters_json.get('source_name')
    start_time = parameters_json.get('start_time')
    end_time = parameters_json.get('end_time')
    batch = parameters_json.get('batch', False)
    verbose = parameters_json.get('verbose')

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

    # # LOCAL STORAGE
    # api_token = s.get_item('api_token')
    # project_id = s.get_item('project_id')
    # dataset_id = s.get_item('dataset_id')
    # class_name = s.get_item('class_name')
    # date = s.get_item('date')
    # source_name = s.get_item('source_name')
    # start_time = s.get_item('start_time')
    # end_time = s.get_item('end_time')

    # # MANUAL INPUT
    # api_token = os.getenv('SYSTEM_KEY')
    # project_id = 1
    # dataset_id = 12
    # class_name = "GP50"
    # date = "20260118"
    # source_name = "SUI"
    # start_time = None
    # end_time = None
    # verbose = True

    # s.set_item('api_token', api_token)
    # s.set_item('class_name', class_name)
    # s.set_item('project_id', project_id)
    # s.set_item('dataset_id', dataset_id)
    # s.set_item('date', date)
    # s.set_item('source_name', source_name)
    # s.set_item('start_time', start_time)
    # s.set_item('end_time', end_time)

    u.log(api_token, "0_map.py", "info", f"Executing script on ${source_name} and ${date}", str(u.dt.now()))

    success_status = []

    #Execute Scripts
    import Map
    success = Map.start(api_token, project_id, dataset_id, class_name, date, source_name, start_time, end_time, verbose)
    success_status.append(success)

    # UPDATE DATASET VISIBILITY
    if any(not status for status in success_status):
        u.log(api_token, "0_map.py", "info", "Scripts Failed!", str(u.dt.now()))
        print("Scripts Failed:", u.dt.now(), flush=True)
        sys.exit(1)
    else:
        try:
            u.update_dataset_date_modified(api_token, class_name, project_id, dataset_id=dataset_id)
        except Exception as e:
            u.log(api_token, "0_map.py", "warn", "date_modified update", f"Failed to update date_modified: {str(e)}")

        u.log(api_token, "0_map.py", "info", "Script Completed!", str(u.dt.now()))
        print("Script Completed:", u.dt.now(), flush=True)
        sys.exit(0)