"""
Performance_update.py - Update aggregate statistics for existing events

OVERVIEW:
This script updates aggregate statistics (AVG, STD, AAV, RTVR) for existing events 
in the database. It loops through multiple date/source combinations, retrieves data,
and computes statistics for existing events without creating new ones.

KEY FEATURES:
- Processes multiple dates and source_names in nested loops
- Automatically retrieves dataset_id for each date/source combination via API
- Downloads existing events via API: GET /api/events (does not create new events)
- Computes AVG, STD, AAV, and RTVR statistics for each event
- Updates aggregate values in database via: POST /api/events/aggregates
- Supports adding/updating missing data channels for existing events

API ENDPOINTS USED:
1. GET /api/datasets/date/dataset_id - Retrieves dataset_id for a date/source
2. GET /api/events - Retrieves existing events for a dataset
3. PUT /api/events/row - Updates individual aggregate column values
   - Updates specific columns for existing event aggregates
   - Requires: class_name, project_id, table, event_id, agr_type, column, value

USAGE EXAMPLE:
    dates_list = ['2026-02-01', '2026-02-02', '2026-02-03']
    sources_list = ['SOURCE1', 'SOURCE2']
    event_types_list = ['PHASE', 'PERIOD', 'BIN 10']
    
    start(api_token, project_id, class_name, 
          dates_list, sources_list, event_types_list, 
          None, None, verbose=True)

PARAMETERS:
- api_token: API authentication token
- project_id: Project identifier
- class_name: Class name (e.g., 'ac40')
- dates: List of dates or single date string
- source_names: List of source names or single source string
- event_types: List of event types to update (e.g., ['PHASE', 'PERIOD', 'BIN 10'])
- start_time/end_time: Optional time filters (None for full day)
- verbose: True to enable detailed logging
"""

import pandas as pd
import numpy as np
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote

import utilities as u 

from dotenv import load_dotenv
from pathlib import Path

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

def get_data(api_token, project_id, class_name, date, source_name, channels, start_ts, end_ts, verbose):
    df = pd.DataFrame()
    try:
        dfi = u.get_channel_values(api_token, class_name, project_id, date, source_name, channels, '100ms', start_ts, end_ts, 'UTC')

        if dfi is not None and len(dfi) > 0:           
            if verbose:
                print('data retrieved:',len(dfi),'records found', flush=True)

            return dfi
        else:
            return df
    except Exception as e:
        u.log(api_token, "Performance_update.py", "error", "get_data", str(e))
        return df

#COMPUTE STATS 
def computeStats(api_token, verbose, class_name, project_id, dataset_id, event_type, df):
    if verbose:
        print('Computing stats: '+str(event_type), flush=True)  

    u.log(api_token, "Performance_update.py", "info", "computing stats", str(event_type))
                                
    # Retrieve existing events from the database
    res = u.get_api_data(api_token, ":8069/api/events?class_name="+str(class_name)+"&project_id="+str(project_id)+"&dataset_id="+str(dataset_id)+"&timezone=UTC")
    
    try:
        if res["success"]:
            # Filter events by the specified event_type
            all_events = res["data"]
            json_data = [event for event in all_events if event.get('event_type') == event_type]
            
            if verbose:
                print(f'  Found {len(json_data)} existing {event_type} events to update', flush=True)
            
            if len(json_data) == 0:
                if verbose:
                    print(f'  No existing {event_type} events found - skipping', flush=True)
                return

            # Process each event individually with PUT requests
            update_count = 0
            
            for index, period in enumerate(json_data): 
                event_id = period['event_id']

                start_ts = u.get_timestamp_from_str(period['start_time'], force_utc=True)
                end_ts = u.get_timestamp_from_str(period['end_time'], force_utc=True)
                
                if start_ts is not None and end_ts is not None and not pd.isna(start_ts) and not pd.isna(end_ts):
                    dff = df.loc[(df['ts'] >= start_ts) & (df['ts'] < end_ts)].copy()
                                
                    if isinstance(dff, pd.DataFrame):
                        if len(dff) > 0:                     
                            value = dff['Polar_perc'].mean()
                            
                            # Update DB_cant_stow_tgt_deg column
                            data = {
                                "class_name": str(class_name),
                                "project_id": int(project_id),
                                "table": "events_aggregate",
                                "event_id": int(event_id),
                                "agr_type": "AVG",
                                "column": "Bsp_polar_perc",
                                "value": str(round(value, 3))
                            }
                            res = u.put_api_data(api_token, ":8059/api/events/row", data)
                            
                            if res.get("success"):
                                update_count += 1
                                if verbose and update_count % 10 == 0:
                                    print(f"AVG updated {update_count} events...", flush=True)
                            else:
                                if verbose:
                                    if not res.get("success"):
                                        print(f"AVG update failed for event {event_id} (WING_clew_pos_mm): {res}", flush=True)
            
            if verbose and update_count > 0:
                print(f"AVG completed: {update_count} events updated!", flush=True)
        else:
            error_msg = f"Failed to retrieve events: {res.get('message', 'Unknown error')}"
            if verbose:
                print(f'  ERROR: {error_msg}', flush=True)
            u.log(api_token, "Performance_update.py", "error", "retrieve events", error_msg)
    except Exception as e:
        print('computeStats exception: '+str(e), flush=True)
        u.log(api_token, "Performance_update.py", "error", "computeStats", str(e))


def start(api_token, project_id, class_name, dates, source_names, event_types, channels, start_time, end_time, verbose):
    """
    Updated to loop through multiple dates and source_names, downloading data for each combination.
    Downloads existing events for specified event_types and updates their aggregate statistics.
    The dataset_id is retrieved automatically from the API for each date/source combination.
    
    Args:
        api_token: API authentication token
        project_id: Project identifier
        class_name: Class name
        dates: List of dates to process (e.g., ['2026-02-10', '2026-02-11'])
        source_names: List of source names to process (e.g., ['SOURCE1', 'SOURCE2'])
        event_types: List of event types to compute stats for (e.g., ['PHASE', 'PERIOD', 'BIN 10'])
        start_time: Optional start time filter
        end_time: Optional end time filter
        verbose: Enable verbose logging
    """
    try:
        if len(api_token) > 0 and int(project_id) > 0 and len(class_name) > 0:
            u.log(api_token, "Performance_update.py", "info", "starting", "Processing multiple date/source combinations...")

            # Convert start_time and end_time to timestamps
            if start_time == None:
                start_ts = None
            elif len(start_time) == 0:
                start_ts = None
            else:
                start_ts = u.get_timestamp_from_str(start_time)

            if end_time == None:
                end_ts = None
            elif len(end_time) == 0:
                end_ts = None
            else:
                end_ts = u.get_timestamp_from_str(end_time)

            # Ensure dates and source_names are lists
            if not isinstance(dates, list):
                dates = [dates]
            if not isinstance(source_names, list):
                source_names = [source_names]
            if not isinstance(event_types, list):
                event_types = [event_types]

            total_combinations = len(dates) * len(source_names)
            current_combo = 0

            # Loop through each date and source_name combination
            for date in dates:
                for source_name in source_names:
                    current_combo += 1
                    
                    if verbose:
                        print(f'\n=== Processing combination {current_combo}/{total_combinations} ===', flush=True)
                        print(f'Date: {date}, Source: {source_name}', flush=True)
                        print('Retrieving dataset_id...', flush=True)
                    
                    # Retrieve dataset_id for this date/source combination
                    try:
                        res = u.get_api_data(api_token, f":8069/api/datasets/date/dataset_id?class_name={class_name}&project_id={project_id}&date={date}")
                        if res.get("success") and res.get("data"):
                            row = next((r for r in res["data"] if r.get('source_name') == source_name), None)
                            dataset_id = row.get('dataset_id') if row else None
                            
                            if dataset_id is None:
                                if verbose:
                                    print(f'No dataset_id found for {date}/{source_name}, skipping...', flush=True)
                                u.log(api_token, "Performance_update.py", "warning", "no dataset_id", f"No dataset_id for {date}/{source_name}")
                                continue
                            
                            if verbose:
                                print(f'Dataset ID: {dataset_id}', flush=True)
                        else:
                            if verbose:
                                print(f'Failed to retrieve dataset_id for {date}/{source_name}, skipping...', flush=True)
                            u.log(api_token, "Performance_update.py", "error", "api error", f"Failed to get dataset_id for {date}/{source_name}")
                            continue
                    except Exception as e:
                        if verbose:
                            print(f'Exception retrieving dataset_id for {date}/{source_name}: {str(e)}', flush=True)
                        u.log(api_token, "Performance_update.py", "error", "dataset_id exception", f"{date}/{source_name}: {str(e)}")
                        continue
                    
                    if verbose:
                        print('Retrieving data...', flush=True)
                    
                    # Download data for this date/source combination
                    df = get_data(api_token, project_id, class_name, date, source_name, channels, start_ts, end_ts, verbose)

                    if df is None or len(df) == 0:
                        if verbose:
                            print(f'No data found for {date}/{source_name}, skipping...', flush=True)
                        u.log(api_token, "Performance_update.py", "warning", "no data", f"No data for {date}/{source_name}")
                        continue

                    u.log(api_token, "Performance_update.py", "info", "data retrieved", f"{date}/{source_name}: {len(df)} records found")
                    
                    if verbose:
                        print(f'Data retrieved: {len(df)} records', flush=True)
                        print(f'Computing statistics for existing events...', flush=True)
                    
                    # Compute stats for existing events (parallel processing)
                    # Note: identifyEvents() call removed - we only update existing events
                    with ThreadPoolExecutor(max_workers=min(4, len(event_types))) as executor:
                        futures = []
                        
                        # Submit computeStats tasks for each event type
                        for event_type in event_types:
                            futures.append(executor.submit(computeStats, api_token, verbose, class_name, project_id, dataset_id, event_type, df))

                        # Wait for all tasks to complete and handle any exceptions
                        for future in as_completed(futures):
                            try:
                                future.result()  # This will raise any exceptions that occurred
                            except Exception as e:
                                u.log(api_token, "Performance_update.py", "error", "parallel execution", str(e))
                                print(f"Error in parallel execution: {e}", flush=True)
                    
                    if verbose:
                        print(f'✓ Completed {date}/{source_name}', flush=True)

            # After all combinations processed
            if verbose:
                print(f'\n=== All combinations processed ({total_combinations} total) ===', flush=True)

            u.log(api_token, "Performance_update.py", "info", "Performance Data Updated!", "Success!")

            if verbose:
                print('\n✓ Performance data update completed successfully!', flush=True)

            return True
        else:
            error_msg = f"Invalid parameters - api_token: {'set' if api_token and len(api_token) > 0 else 'missing'}, project_id: {project_id}, class_name: {class_name}"
            print(f"ERROR: {error_msg}", flush=True)
            u.log(api_token, "Performance_update.py", "error", "Invalid parameters", error_msg)
            return False
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"ERROR in Performance_update.start(): {str(e)}", flush=True)
        print(f"Full traceback:\n{error_details}", flush=True)
        u.log(api_token, "Performance_update.py", "error", "Performance Data Update Failed!", f"{str(e)}\n{error_details}")
        return False


# Example usage:
# To update statistics for multiple dates and sources:

channels = [ 
    {'name': 'Datetime', 'type': 'datetime'},
    {'name': 'ts', 'type': 'float'},
    {'name': 'Polar_perc', 'type': 'float'}
]

dates_list = ['2026-01-13','2026-01-14','2026-01-15','2026-01-16','2026-01-17','2026-01-18','2026-02-13','2026-02-14','2026-02-15']
sources_list = ['USA','GER','SUI','FRA','ITA','ESP','AUS','NZL','DEN','SWE','BRA','GBR','CAN']
event_types_list = ['PHASE', 'PERIOD', 'BIN 10']
start(api_token, 1, 'ac40', dates_list, sources_list, event_types_list, channels, None, None, True)


    
