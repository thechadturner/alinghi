import os
import json
import pandas as pd
import numpy as np
import sys
import subprocess
import time
from scipy.interpolate import interp1d

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
    
def get_data(class_name, project_id, date, source_name, start_ts, end_ts):
    df = pd.DataFrame()
    try:
        channels = [
            {'name': 'Datetime', 'type': 'datetime'},
            {'name': 'ts', 'type': 'float'},
            {'name': 'Bsp_kts', 'type': 'float'}
        ]

        dfi = u.get_channel_values(api_token, class_name, project_id, date, source_name, channels, '1s', start_ts, end_ts, 'UTC')

        if dfi is not None and len(dfi) > 0:
            u.log(api_token, "2_process_and_execute.py", "info", "get_data", str(len(dfi))+" records found!")
            return dfi
        else:
            return df
    except Exception as e:
        u.log(api_token, "2_process_and_execute.py", "error", "processing data", "script exception error:"+str(e))
        return df

def run_script_realtime(script_path, params_str):
    """
    Run a script and stream its output in real-time.
    """
    try:
        # Use python3 explicitly
        python_executable = sys.executable
        
        # Start the process
        process = subprocess.Popen(
            [python_executable, "-u", script_path, params_str],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # Merge stderr into stdout
            text=True,
            bufsize=1,  # Line buffered
            universal_newlines=True
        )
        
        # Read output line by line
        while True:
            line = process.stdout.readline()
            if not line and process.poll() is not None:
                break
            
            if line:
                print(line.strip(), flush=True)
                
        # Get return code
        return_code = process.poll()
        return return_code
        
    except Exception as e:
        print(f"Error running script {script_path}: {str(e)}", flush=True)
        return -1

if __name__ == "__main__":
    try:
        s = u.LocalStorage()
        # Immediate message to confirm script has started
        print("Starting 2_process_and_execute.py...", flush=True)
        
        parameters_str = sys.argv[1]
        parameters_json = json.loads(parameters_str)

        #LOG
        u.log(api_token, "2_process_and_execute.py", "info", "parameters", parameters_str)

        class_name = parameters_json.get('class_name')
        project_id = parameters_json.get('project_id')
        dataset_id = parameters_json.get('dataset_id')
        date = parameters_json.get('date')
        source_name = parameters_json.get('source_name')
        batch = parameters_json.get('batch', False)
        verbose = parameters_json.get('verbose', False)
        day_type = parameters_json.get('day_type', ['TRAINING', 'RACING'])
        race_type = parameters_json.get('race_type', ['INSHORE'])

        # class_name = 'AC40'
        # project_id = 1
        # dataset_id = 7
        # date = '2026-01-17'
        # source_name = 'GER'
        # batch = False
        # verbose = True
        
        if verbose:
            print("Querying data...", flush=True)
            
        df = get_data(class_name, project_id, date, source_name, None, None)

        #LOG
        u.log(api_token, "2_process_and_execute.py", "info", "processing data", str(len(df))+ " records retrieved...")

        if len(df) > 0:
            if verbose:
                print(f"{len(df)} records found", flush=True)

            # Use full data range for dataset window; 2_processing.py handles filtering.
            min_ts = df['ts'].min()
            max_ts = df['ts'].max()
            start_time = u.get_utc_datetime_from_ts(min_ts).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
            end_time = u.get_utc_datetime_from_ts(max_ts).strftime('%Y-%m-%dT%H:%M:%S.%fZ')

            events_json = [
                {"Event": "Active", "Start": start_time, "End": end_time, "EventType": "Dataset"}
            ]
            
            date_str = date.replace('-', '')
            script_dir = os.path.dirname(os.path.abspath(__file__))

            # # Run 2_targets.py before 2_processing: update Twa_tgt_deg in normalized parquet from targets table
            # targets_script_path = os.path.join(script_dir, '2_targets.py')
            # targets_params = {
            #     'class_name': class_name,
            #     'project_id': project_id,
            #     'dataset_id': dataset_id,
            #     'date': date_str,
            #     'source_name': source_name,
            #     'start_time': start_time,
            #     'end_time': end_time,
            #     'batch': True,
            #     'verbose': verbose
            # }
            # targets_params_str = json.dumps(targets_params)
            # print("Applying targets to normalized data...", flush=True)
            # u.log(api_token, "2_process_and_execute.py", "info", "targets script", f"Starting 2_targets.py for dataset {dataset_id}")
            # return_code_targets = run_script_realtime(targets_script_path, targets_params_str)
            # if return_code_targets != 0:
            #     error_msg = f"2_targets.py failed with code {return_code_targets}"
            #     u.log(api_token, "2_process_and_execute.py", "error", "targets script", error_msg)
            #     raise Exception(error_msg)
            # u.log(api_token, "2_process_and_execute.py", "info", "targets script", "2_targets.py completed successfully")

            # Prepare parameters for processing.py
            processing_params = {
                'class_name': class_name,
                'project_id': project_id,
                'dataset_id': dataset_id,
                'date': date_str,
                'source_name': source_name,
                'start_time': start_time,
                'end_time': end_time,
                'events': events_json,
                'batch': True,
                'verbose': verbose,
                'day_type': day_type,
                'race_type': race_type
            }
            processing_params_str = json.dumps(processing_params)
            
            # Execute processing.py
            processing_script_path = os.path.join(script_dir, '2_processing.py')

            print("Processing data...", flush=True)
            u.log(api_token, "2_process_and_execute.py", "info", "processing script", f"Starting 2_processing.py for dataset {dataset_id}")
            
            # Use real-time execution helper
            return_code = run_script_realtime(processing_script_path, processing_params_str)
            
            # Check return code
            if return_code != 0:
                error_msg = f"Processing script failed with code {return_code}"
                u.log(api_token, "2_process_and_execute.py", "error", "processing script", error_msg)
                raise Exception(error_msg)
            else:
                u.log(api_token, "2_process_and_execute.py", "info", "processing script", "Processing script completed successfully")
                
                # Verify parquet file exists and is readable before starting execution
                # This ensures the file is fully written and flushed to disk
                data_dir = os.getenv('DATA_DIRECTORY', 'C:/MyApps/Alinghi/uploads/data')
                date_str_clean = date.replace('-', '') if date and '-' in date else date
                parquet_path = os.path.join(data_dir, 'system', str(project_id), class_name, date_str_clean, source_name, 'processed_data_racesight.parquet')
                
                max_wait_time = 10  # Maximum 10 seconds to wait for file
                wait_interval = 0.5  # Check every 0.5 seconds
                waited_time = 0
                parquet_ready = False
                
                while waited_time < max_wait_time:
                    if os.path.exists(parquet_path):
                        try:
                            # Try to read the file to verify it's complete and not corrupted
                            test_df = pd.read_parquet(parquet_path, engine='pyarrow')
                            if len(test_df) > 0 and 'Phase_id' in test_df.columns and 'Period_id' in test_df.columns:
                                parquet_ready = True
                                u.log(api_token, "2_process_and_execute.py", "info", "parquet verification", f"Parquet file verified: {len(test_df)} records, Phase_id and Period_id present")
                                break
                        except Exception as e:
                            u.log(api_token, "2_process_and_execute.py", "warning", "parquet verification", f"Parquet file exists but not readable yet: {str(e)}")
                    
                    time.sleep(wait_interval)
                    waited_time += wait_interval
                
                if not parquet_ready:
                    u.log(api_token, "2_process_and_execute.py", "warning", "parquet verification", f"Parquet file not ready after {max_wait_time}s, proceeding anyway (file: {parquet_path})")
                    print(f"Warning: Parquet file verification timeout, proceeding with execution...", flush=True)

                # Run 3_corrections.py (multi-sensor fusion calibration, outputs _cor parquet)
                corrections_params = {
                    'class_name': class_name,
                    'project_id': project_id,
                    'dataset_id': dataset_id,
                    'date': date_str_clean,
                    'source_name': source_name,
                    'start_time': start_time,
                    'end_time': end_time,
                    'batch': True,
                    'verbose': verbose
                }

                corrections_params_str = json.dumps(corrections_params)
                corrections_script_path = os.path.join(script_dir, '3_corrections.py')
                print("Running fusion corrections...", flush=True)
                u.log(api_token, "2_process_and_execute.py", "info", "corrections script", f"Starting 3_corrections.py for dataset {dataset_id}")
                return_code_corrections = run_script_realtime(corrections_script_path, corrections_params_str)
                if return_code_corrections != 0:
                    error_msg = f"Corrections script failed with code {return_code_corrections}"
                    u.log(api_token, "2_process_and_execute.py", "error", "corrections script", error_msg)
                    raise Exception(error_msg)
                u.log(api_token, "2_process_and_execute.py", "info", "corrections script", "Corrections script completed successfully")


                # Run 3_systems.py (compute system data)
                systems_params = {
                    'class_name': class_name,
                    'project_id': project_id,
                    'date': date_str_clean,
                    'source_name': source_name,
                    'start_time': start_time,
                    'end_time': end_time,
                    'verbose': verbose
                }

                systems_params_str = json.dumps(systems_params)
                systems_script_path = os.path.join(script_dir, '3_systems.py')
                print("Running systems data computation...", flush=True)
                u.log(api_token, "2_process_and_execute.py", "info", "systems script", f"Starting 3_systems.py for dataset {dataset_id}")
                return_code_corrections = run_script_realtime(systems_script_path, systems_params_str)
                if return_code_corrections != 0:
                    error_msg = f"Systems script failed with code {return_code_corrections}"
                    u.log(api_token, "2_process_and_execute.py", "error", "systems script", error_msg)
                    raise Exception(error_msg)
                u.log(api_token, "2_process_and_execute.py", "info", "systems script", "Systems script completed successfully")

                # Prepare parameters for 3_execute.py
                # 3_execute runs Map.start(), Maneuvers.start(), Performance.start(), Race.start() with these params.
                # Signatures: Map/Maneuvers/Performance.start(..., start_time, end_time, verbose); Race.start(..., verbose).
                # Pass start_time/end_time as None so Performance/Maneuvers/Map use full dataset range (same as when
                # running "Execute 3_execute" or "Execute 0_performance" from admin). Otherwise the narrow window
                # (Bsp > mean ± 60s) can cause get_channel_values to return no/fewer points.
                date_for_execute = date.replace('-', '') if date and '-' in date else date
                
                execute_params = {
                    'class_name': class_name,
                    'project_id': project_id,
                    'dataset_id': dataset_id,
                    'date': date_for_execute,
                    'source_name': source_name,
                    'start_time': None,
                    'end_time': None,
                    'batch': True,
                    'verbose': verbose
                }
                execute_params_str = json.dumps(execute_params)
                
                # Log parameters being passed to 3_execute.py
                u.log(api_token, "2_process_and_execute.py", "info", "execute script params", f"Parameters for 3_execute.py: {execute_params_str}")
                
                # Execute 3_execute.py
                # Use relative path from current script location (works in both local and Docker)
                script_dir = os.path.dirname(os.path.abspath(__file__))
                execute_script_path = os.path.join(script_dir, '3_execute.py')

                print("Computing stats & maneuvers...", flush=True)
                u.log(api_token, "2_process_and_execute.py", "info", "execute script", f"Starting 3_execute.py for dataset {dataset_id}")
                
                # Use real-time execution helper
                return_code = run_script_realtime(execute_script_path, execute_params_str)
                
                # Check return code
                if return_code != 0:
                    error_msg = f"Execute script failed with code {return_code}"
                    u.log(api_token, "2_process_and_execute.py", "error", "execute script", error_msg)
                    raise Exception(error_msg)
                else:
                    u.log(api_token, "2_process_and_execute.py", "info", "execute script", "Execute script completed successfully")
                    
                    # Log final success message
                    success_msg = f"2_process_and_execute.py completed successfully for dataset {dataset_id}"
                    u.log(api_token, "2_process_and_execute.py", "info", "script completion", success_msg)
                    
                    if batch == False:
                        print("Script Completed:", u.dt.now(), flush=True)
                    else:
                        print(f"Script Completed (batch mode): {u.dt.now()}", flush=True)
                    
                    sys.exit(0)
        else:
            error_msg = "No data found."
            u.log(api_token, "2_process_and_execute.py", "error", "exception", error_msg)
            raise Exception(error_msg)
    except Exception as e:
        u.log(api_token, "2_process_and_execute.py", "error", "exception", str(e))
        print(f"Script Failed: {str(e)}", flush=True)
        sys.exit(1)