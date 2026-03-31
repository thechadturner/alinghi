import sys
import json
import os
import utilities as u 

from dotenv import load_dotenv
from pathlib import Path

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (three levels up from server_python/scripts/ac75/)
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
    try:
        class_name = 'AC40'
        project_id = '2'

        # SAVING MENUS
        print("Adding maneuver menus...", flush=True)
        json_str = json.dumps({"menus": ["TABLE","MAP","TIME SERIES","SCATTER"]}, indent=2)
        jsondata = {"class_name": class_name,"project_id": project_id, "object_name": "maneuver_menus", "json": json_str}
        res = u.post_api_data(api_token, ":8059/api/classes/object", jsondata)

        json_str = json.dumps({"data": ["BASICS","FOILS","AERO"]}, indent=2)
        jsondata = {"class_name": class_name,"project_id": project_id, "object_name": "maneuver_timeseries_options", "json": json_str}
        res = u.post_api_data(api_token, ":8059/api/classes/object", jsondata)

        # SAVING FILTER REQUIREMENTS
        print("Adding filters definitions...", flush=True)
        json_str = json.dumps({"filter_types": {"Twa_deg": ["upwind", "downwind", "reaching", "port", "stbd"], "Grade": "numeric", "Config": "string", "Leg_number": "numeric", "Race_number": "numeric"}, "default_filters": ["Twa_deg", "Race_number", "Leg_number", "Grade", "Config"], "filter_channels": [{"name": "Twa_deg", "type": "float", "display_name": "True Wind Angle"}, {"name": "Race_number", "type": "int", "display_name": "Race Number"}, {"name": "Leg_number", "type": "int", "display_name": "Leg Number"}, {"name": "Grade", "type": "int", "display_name": "Grade"}, {"name": "Config", "type": "string", "display_name": "Config"}]}, indent=2)
        jsondata = {"class_name": class_name,"project_id": project_id, "object_name": "filters_dataset", "json": json_str}
        res = u.post_api_data(api_token, ":8059/api/classes/object", jsondata)

        json_str = json.dumps({"filter_types": {"Twa_deg": ["upwind", "downwind", "reaching", "port", "stbd"], "Grade": "numeric", "Config": "string", "Leg_number": "numeric", "Race_number": "numeric", "Source_name": "string"}, "default_filters": ["Twa_deg", "Source_name", "Race_number", "Leg_number", "Grade", "Config"], "filter_channels": [{"name": "Twa_deg", "type": "float", "display_name": "True Wind Angle"}, {"name": "Source_name", "type": "string", "display_name": "Source Name"}, {"name": "Race_number", "type": "int", "display_name": "Race Number"}, {"name": "Leg_number", "type": "int", "display_name": "Leg Number"}, {"name": "Grade", "type": "int", "display_name": "Grade"}, {"name": "Config", "type": "string", "display_name": "Config"}]}, indent=2)
        jsondata = {"class_name": class_name,"project_id": project_id, "object_name": "filters_day", "json": json_str}
        res = u.post_api_data(api_token, ":8059/api/classes/object", jsondata)

        json_str = json.dumps({"filter_types": {"Twa_deg": ["upwind", "downwind", "reaching", "port", "stbd"], "Grade": "numeric", "Config": "string", "Year": "string", "Event": "string", "Source_name": "string"}, "default_filters": ["Twa_deg", "Source_name", "Grade", "Year", "Event", "Config"], "filter_channels": [{"name": "Twa_deg", "type": "float", "display_name": "True Wind Angle"}, {"name": "Source_name", "type": "string", "display_name": "Source Name"}, {"name": "Year", "type": "string", "display_name": "Year"}, {"name": "Event", "type": "string", "display_name": "Event"}, {"name": "Grade", "type": "int", "display_name": "Grade"}, {"name": "Config", "type": "string", "display_name": "Config"}]}, indent=2)
        jsondata = {"class_name": class_name,"project_id": project_id, "object_name": "filter_fleet", "json": json_str}
        res = u.post_api_data(api_token, ":8059/api/classes/object", jsondata)

        json_str = json.dumps({"filter_types": {"Twa_deg": ["upwind", "downwind", "reaching", "port", "stbd"], "Grade": "numeric", "Config": "string", "Year": "string", "Event": "string"}, "default_filters": ["Twa_deg", "Grade", "Year", "Event", "Config"], "filter_channels": [{"name": "Twa_deg", "type": "float", "display_name": "True Wind Angle"}, {"name": "Year", "type": "string", "display_name": "Year"}, {"name": "Event", "type": "string", "display_name": "Event"}, {"name": "Grade", "type": "int", "display_name": "Grade"}, {"name": "Config", "type": "string", "display_name": "Config"}]}, indent=2)
        jsondata = {"class_name": class_name,"project_id": project_id, "object_name": "filter_source", "json": json_str}
        res = u.post_api_data(api_token, ":8059/api/classes/object", jsondata)

        # SAVING CHANNEL REQUIREMENTS
        print("Adding default channels...", flush=True)
        # Note: These field names must match the actual database column names after normalization
        # See 1_normalization_csv.py for the actual column names used in the database
        json_str = json.dumps({
            "lat_name": "Lat_dd", 
            "lng_name": "Lng_dd", 
            "twa_name": "Twa_deg", 
            "twd_name": "Twd_deg",
            "tws_name": "Tws_kts", 
            "bsp_name": "Bsp_kts", 
            "hdg_name": "Hdg_deg"
        }, indent=2)
        jsondata = {"class_name": class_name,"project_id": project_id, "object_name": "default_channels", "json": json_str}
        res = u.post_api_data(api_token, ":8059/api/classes/object", jsondata)

        u.log(api_token, "0_init_class.py", "info", "Script Completed!", str(u.dt.now()))
        print("Script Completed:", u.dt.now(), flush=True)
        sys.exit(0)
    except Exception as e:
        u.log(api_token, "0_init_class.py", "error", "exception", str(e))
        print(f"Script exception error: {e}", flush=True)
        sys.exit(1)