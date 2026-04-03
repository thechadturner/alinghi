import sys
import json
import os
import utilities as u

from dotenv import load_dotenv
from pathlib import Path

s = u.LocalStorage()

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (three levels up from server_python/scripts/ac40/)
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

LOG_SCRIPT = "0_map.py"

if __name__ == "__main__":
    parameters_json = {}
    # Set True to run from IDE / CLI without argv JSON (edit values in the branch below). Same pattern as 2_processing.py / 3_corrections.py.
    USE_MANUAL_TEST_INPUTS = False

    try:
        if USE_MANUAL_TEST_INPUTS:
            class_name = "AC40"
            project_id = 2
            dataset_id = 2
            date = "20260330"
            source_name = "AC40-SUI1"
            start_time = None
            end_time = None
            batch = False
            verbose = True
            day_type = ["TRAINING", "RACING"]
            race_type = ["INSHORE", "COASTAL", "OFFSHORE"]
            parameters_json = {"verbose": verbose}
        else:
            parameters_str = sys.argv[1]
            parameters_json = json.loads(parameters_str)

            u.log(api_token, LOG_SCRIPT, "info", "parameters", parameters_str)

            class_name = parameters_json.get("class_name")
            project_id = parameters_json.get("project_id")
            dataset_id = parameters_json.get("dataset_id")
            date = parameters_json.get("date")
            source_name = parameters_json.get("source_name")
            start_time = parameters_json.get("start_time")
            end_time = parameters_json.get("end_time")
            if start_time == "":
                start_time = None
            if end_time == "":
                end_time = None
            batch = parameters_json.get("batch", False)
            verbose = parameters_json.get("verbose", False)

            day_type = parameters_json.get("day_type", ["TRAINING", "RACING"])
            race_type = parameters_json.get("race_type", ["INSHORE", "COASTAL", "OFFSHORE"])

        if not isinstance(day_type, list):
            day_type = [day_type] if day_type is not None else ["TRAINING", "RACING"]
        if not isinstance(race_type, list):
            race_type = [race_type] if race_type is not None else ["INSHORE", "COASTAL", "OFFSHORE"]

        s.set_item("class_name", class_name)
        s.set_item("project_id", project_id)
        s.set_item("dataset_id", dataset_id)
        s.set_item("date", date)
        s.set_item("source_name", source_name)
        s.set_item("start_time", start_time)
        s.set_item("end_time", end_time)
        s.set_item("batch", batch)
        s.set_item("verbose", verbose)
        s.set_item("day_type", json.dumps(day_type))
        s.set_item("race_type", json.dumps(race_type))

        u.log(api_token, LOG_SCRIPT, "info", f"Executing script on ${source_name} and ${date}", str(u.dt.now()))

        success_status = []

        import Map
        success = Map.start(api_token, project_id, dataset_id, class_name, date, source_name, start_time, end_time, verbose)
        success_status.append(success)

        if any(not status for status in success_status):
            u.log(api_token, LOG_SCRIPT, "info", "Scripts Failed!", str(u.dt.now()))
            print("Scripts Failed:", u.dt.now(), flush=True)
            sys.exit(1)
        else:
            try:
                u.update_dataset_date_modified(api_token, class_name, project_id, dataset_id=dataset_id)
            except Exception as e:
                u.log(api_token, LOG_SCRIPT, "warn", "date_modified update", f"Failed to update date_modified: {str(e)}")

            u.log(api_token, LOG_SCRIPT, "info", "Script Completed!", str(u.dt.now()))
            print("Script Completed:", u.dt.now(), flush=True)
            sys.exit(0)

    except Exception as error:
        import traceback
        error_trace = traceback.format_exc()
        u.log(api_token, LOG_SCRIPT, "error", "map script", "script exception error:" + str(error))
        u.log(api_token, LOG_SCRIPT, "error", "map script", "traceback:" + error_trace)
        try:
            print(f"Scripts Failed: {str(error)}", flush=True)
            if parameters_json.get("verbose", False):
                print(error_trace, flush=True)
        except UnicodeEncodeError:
            print(f"Scripts Failed: {str(error).encode('ascii', errors='replace').decode('ascii')}", flush=True)
            if parameters_json.get("verbose", False):
                print(error_trace.encode("ascii", errors="replace").decode("ascii"), flush=True)
        sys.exit(1)