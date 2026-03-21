import numpy as np
import pandas as pd
import sys
import os
import json

import utilities as u

# Add maneuvers directory to path (relative to this script)
current_dir = os.path.dirname(os.path.abspath(__file__))
maneuvers_path = os.path.join(current_dir, 'maneuvers')
sys.path.append(maneuvers_path)

import tacks as t
import gybes as g
import roundups as r
import bearaways as b
import takeoffs as a
import update_loss as ul

def get_data(api_token, project_id, class_name, date, source_name, start_ts, end_ts, verbose):
    df = pd.DataFrame()
    try:
        channels = [
            {'name': 'Datetime', 'type': 'datetime'},
            {'name': 'ts', 'type': 'float'},
            {'name': 'Maneuver_type', 'type': 'string'}
        ]

        dfi = u.get_channel_values(api_token, class_name, project_id, date, source_name, channels, '1s', start_ts, end_ts, 'UTC')

        if dfi is not None and len(dfi) > 0:
            if verbose:
                print(len(dfi),"records retrieved!", flush=True)

            return dfi
        else:
            return df
    except Exception as e:
        print(f"Error retrieving data: {str(e)}", flush=True)
        return df
    
def start(api_token, project_id, dataset_id, class_name, date, source_name, start_time, end_time, verbose):
    success = False

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

    if len(api_token) > 0 and int(project_id) > 0 and int(dataset_id) > 0 and len(class_name) > 0:
        if verbose:
            print('Locating maneuvers...', flush=True)

        df = get_data(api_token, project_id, class_name, date, source_name, start_ts, end_ts, verbose)

        if len(df) > 0:
            success_status = []

            # TACKS
            if verbose:
                print('Processing Tacks...', flush=True)

            success = t.start(df, api_token, project_id, dataset_id, class_name, date, source_name, verbose)
            success_status.append(success)

            # GYBES
            if verbose:
                print('Processing Gybes...', flush=True)

            success = g.start(df, api_token, project_id, dataset_id, class_name, date, source_name, verbose)
            success_status.append(success)

            # ROUNDUPS
            if verbose:
                print('Processing Roundups...', flush=True)

            success = r.start(df, api_token, project_id, dataset_id, class_name, date, source_name, verbose)
            success_status.append(success)

            # BEARAWAYS
            if verbose:
                print('Processing Bearaways...', flush=True)

            success = b.start(df, api_token, project_id, dataset_id, class_name, date, source_name, verbose)
            success_status.append(success)

            # TAKEOFFS
            if verbose:
                print('Processing Takeoffs...', flush=True)

            success = a.start(df, api_token, project_id, dataset_id, class_name, date, source_name, verbose)
            success_status.append(success)

            # UPDATE LOSS
            if verbose:
                print('Updating Loss...', flush=True)

            success = ul.start(api_token, project_id, dataset_id, class_name, verbose)
            success_status.append(success)

            # FINALIZE
            if verbose:
                print('Wrapping up...', flush=True)

            if any(not status for status in success_status):
                u.log(api_token, "Maneuvers.py", "error", "Error loading Maneuver Data", "Unable to perform object insert/update.")
            else:
                print("Posting maneuvers to API...", flush=True)
                
                # ADD PAGE
                jsondata = {"class_name": class_name,"project_id": project_id, "dataset_id": dataset_id, "page_name": "MANEUVERS"}
                res = u.post_api_data(api_token, ":8059/api/datasets/page", jsondata)

                if (res["success"]):
                    u.log(api_token, "Maneuvers.py", "info", "Page Loaded!", "page_name: MANEUVERS")
                    u.log(api_token, "Maneuvers.py", "info", "Maneuver Data Loaded!", "Success!")
                    success = True
                else:
                    u.log(api_token, "Maneuvers.py", "error", "Page load failed!", "page_name: MANEUVERS")

                # Day-page upsert for day-mode sidebar (additive)
                date_norm = str(date).replace("-", "").replace("/", "").strip() if date else None
                if date_norm and len(date_norm) == 8:
                    day_page_payload = {"class_name": class_name, "project_id": project_id, "date": date_norm, "page_name": "MANEUVERS"}
                    day_res = u.post_api_data(api_token, ":8059/api/datasets/day-page", day_page_payload)
                    if day_res.get("success"):
                        u.log(api_token, "Maneuvers.py", "info", "Day page upserted", "page_name: MANEUVERS")
                    else:
                        u.log(api_token, "Maneuvers.py", "warning", "Day page upsert failed", day_res.get("message", "unknown"))

                # Update dataset date_modified to trigger cache refresh
                if success:
                    u.update_dataset_date_modified(api_token, class_name, project_id, dataset_id=dataset_id)

            return success
        else:
            # No data found
            u.log(api_token, "Maneuvers.py", "warn", "No maneuver data", "No data found in dataframe")
            return False
    else:
        # Invalid parameters
        u.log(api_token, "Maneuvers.py", "error", "Invalid parameters", "Missing required parameters")
        return False
        
# start()
    
    