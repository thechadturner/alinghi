import pandas as pd
import numpy as np
import sys
import json
import os
import urllib.parse

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

def calculate_vmg_loss(vmg_baseline, vmg_avg, time_seconds):
    """
    Calculate VMG loss in meters.
    
    Args:
        vmg_baseline: Baseline VMG in kph
        vmg_avg: Average VMG in kph
        time_seconds: Time period in seconds
    
    Returns:
        Loss in meters (positive = loss, negative = gain)
    """
    if pd.isna(vmg_baseline) or pd.isna(vmg_avg) or pd.isna(time_seconds):
        return 0.0
    
    # Convert: (kph difference) * (seconds / 3600) * 1000 = meters
    loss_meters = (vmg_baseline - vmg_avg) * (time_seconds / 3600.0) * 1000.0
    return loss_meters

def process_maneuver_type(api_token, class_name, project_id, dataset_id, event_type, verbose=False):
    """
    Process a single maneuver type: retrieve data, bin by TWS, calculate losses, and update database.
    
    Args:
        api_token: API authentication token
        class_name: Class name (e.g., 'GP50')
        project_id: Project ID
        dataset_id: Dataset ID
        event_type: Maneuver type (e.g., 'tack', 'gybe', etc.)
        verbose: Enable verbose logging
    
    Returns:
        True if successful, False otherwise
    """
    try:
        # Define channels to request
        channels = [
            'vmg_baseline',
            'vmg_total_avg',
            'vmg_inv_avg',
            'vmg_turn_avg',
            'vmg_build_avg',
            'tws_avg'
        ]
        
        channels_json = json.dumps(channels)
        channels_encoded = urllib.parse.quote(channels_json)
        
        # Build filters to only include maneuvers with GRADE > 1
        filters = {
            'GRADE': [2, 3, 4, 5]  # Only grades greater than 1
        }
        filters_json = json.dumps(filters)
        filters_encoded = urllib.parse.quote(filters_json)
        
        # Build API URL
        url = f":8069/api/data/maneuvers-table-data?class_name={class_name}&project_id={project_id}&dataset_id={dataset_id}&event_type={event_type}&channels={channels_encoded}&filters={filters_encoded}"
        
        if verbose:
            u.log(api_token, "update_loss.py", "info", f"Fetching {event_type} maneuvers", f"URL: {url}")
        
        # Call API to get maneuver data
        response = u.get_api_data(api_token, url)
        
        if not response.get('success'):
            u.log(api_token, "update_loss.py", "warn", f"No data for {event_type}", response.get('message', 'Unknown error'))
            return False
        
        data = response.get('data', [])
        
        if not data or len(data) == 0:
            u.log(api_token, "update_loss.py", "info", f"No {event_type} maneuvers found", "Skipping")
            return True
        
        # Convert to DataFrame
        df = pd.DataFrame(data)
        
        if verbose:
            u.log(api_token, "update_loss.py", "info", f"Processing {event_type}", f"Found {len(df)} maneuvers")
        
        # Filter out rows with missing critical data
        df = df.dropna(subset=['tws_avg', 'vmg_baseline'])
        
        if len(df) == 0:
            u.log(api_token, "update_loss.py", "info", f"No valid {event_type} data", "All rows have missing critical fields - skipping")
            return True
        
        # Sort by TWS
        df = df.sort_values(by='tws_avg').reset_index(drop=True)
        
        # Find minimum TWS value
        min_tws = df['tws_avg'].min()
        max_tws = df['tws_avg'].max()
        
        if verbose:
            u.log(api_token, "update_loss.py", "info", f"{event_type} TWS range", f"Min: {min_tws:.2f}, Max: {max_tws:.2f}")
        
        # Create TWS bins starting from min_tws in increments of 2 kph
        bins = []
        bin_start = min_tws
        while bin_start < max_tws + 2:
            bins.append((bin_start, bin_start + 2))
            bin_start += 2
        
        # Calculate maximum vmg_baseline for each bin
        bin_baselines = {}
        for bin_min, bin_max in bins:
            events_in_bin = df[(df['tws_avg'] >= bin_min) & (df['tws_avg'] < bin_max)]
            
            if len(events_in_bin) > 0:
                max_baseline = events_in_bin['vmg_baseline'].max()
                bin_baselines[(bin_min, bin_max)] = max_baseline
                
                if verbose:
                    u.log(api_token, "update_loss.py", "info", 
                          f"{event_type} bin [{bin_min:.1f}-{bin_max:.1f})", 
                          f"Count: {len(events_in_bin)}, Max Baseline: {max_baseline:.2f} kph")

        if event_type == 'bearaway' or event_type == 'roundup':
            total_time = 30
            inv_time = 10
            turn_time = 10
            build_time = 10
        else:
            total_time = 35
            inv_time = 10
            turn_time = 10
            build_time = 15
        
        # Process each event and calculate losses
        updates_successful = 0
        updates_failed = 0
        
        for idx, row in df.iterrows():
            event_id = row['event_id']
            tws_avg = row['tws_avg']
            
            # Find which bin this event belongs to
            vmg_baseline_for_bin = None
            for (bin_min, bin_max), max_baseline in bin_baselines.items():
                if bin_min <= tws_avg < bin_max:
                    vmg_baseline_for_bin = max_baseline
                    break
            
            if vmg_baseline_for_bin is None:
                u.log(api_token, "update_loss.py", "warn", f"No bin for event {event_id}", f"TWS: {tws_avg}")
                updates_failed += 1
                continue
            
            # Calculate losses
            loss_total_vmg = calculate_vmg_loss(
                vmg_baseline_for_bin, 
                row.get('vmg_total_avg', 0), 
                total_time
            )
            
            loss_inv_vmg = calculate_vmg_loss(
                vmg_baseline_for_bin, 
                row.get('vmg_inv_avg', 0), 
                inv_time
            )
            
            loss_turn_vmg = calculate_vmg_loss(
                vmg_baseline_for_bin, 
                row.get('vmg_turn_avg', 0), 
                turn_time
            )
            
            loss_build_vmg = calculate_vmg_loss(
                vmg_baseline_for_bin, 
                row.get('vmg_build_avg', 0), 
                build_time
            )
            
            # Update database via API
            update_url = ":8059/api/events/maneuver-loss"
            # Ensure all values are native Python types (not NumPy types) for JSON serialization
            update_body = {
                "class_name": class_name,
                "project_id": int(project_id),
                "event_id": int(event_id),
                "vmg_applied": float(round(vmg_baseline_for_bin, 2)),
                "loss_total_vmg": float(round(loss_total_vmg, 2)),
                "loss_inv_vmg": float(round(loss_inv_vmg, 2)),
                "loss_turn_vmg": float(round(loss_turn_vmg, 2)),
                "loss_build_vmg": float(round(loss_build_vmg, 2))
            }
            
            update_response = u.put_api_data(api_token, update_url, update_body)
            
            if update_response.get('success'):
                updates_successful += 1
                if verbose and updates_successful % 10 == 0:
                    u.log(api_token, "update_loss.py", "info", 
                          f"{event_type} progress", 
                          f"Updated {updates_successful}/{len(df)} events")
            else:
                updates_failed += 1
                u.log(api_token, "update_loss.py", "error", 
                      f"Failed to update event {event_id}", 
                      update_response.get('message', 'Unknown error'))
        
        u.log(api_token, "update_loss.py", "info", 
              f"{event_type} complete", 
              f"Success: {updates_successful}, Failed: {updates_failed}")
        
        return updates_failed == 0
        
    except Exception as e:
        u.log(api_token, "update_loss.py", "error", f"Error processing {event_type}", str(e))
        return False

def start(api_token, project_id, dataset_id, class_name, verbose):
    try:
        u.log(api_token, "update_loss.py", "info", "Starting maneuver loss analysis", f"Dataset: {dataset_id}")
        
        maneuver_types = ['TACK', 'GYBE', 'ROUNDUP', 'BEARAWAY', 'TAKEOFF']
        
        success_status = []
        
        # Process each maneuver type
        for maneuver_type in maneuver_types:
            u.log(api_token, "update_loss.py", "info", 
                  f"Processing {maneuver_type} maneuvers", 
                  "Starting...")
            
            success = process_maneuver_type(
                api_token, 
                class_name, 
                project_id, 
                dataset_id, 
                maneuver_type, 
                verbose
            )
            success_status.append(success)
        
        # Check overall success
        if all(success_status):
            u.log(api_token, "update_loss.py", "info", 
                  "Maneuver loss update complete", 
                  "All maneuver types processed successfully")
            print("Maneuver loss update completed successfully", flush=True)
            return True
        else:
            u.log(api_token, "update_loss.py", "warn", 
                  "Maneuver loss update completed with errors", 
                  "Some maneuver types failed")
            print("Maneuver loss update completed with errors", flush=True)
            return False
            
    except Exception as e:
        u.log(api_token, "update_loss.py", "error", 
              "Fatal error in maneuver loss analysis", 
              str(e))
        print(f"Fatal error: {str(e)}", flush=True)
        return False
