import sys

# Print immediately when script starts
sys.stdout.write("=" * 80 + "\n")
sys.stdout.write("1_normalization_csv.py: Script starting, importing modules...\n")
sys.stdout.write("=" * 80 + "\n")
sys.stdout.flush()

try:
    import os, json, math as m, re
    import pandas as pd
    import numpy as np
    import utilities as u 

    from dotenv import load_dotenv
    from pathlib import Path 

    sys.stdout.write("Imports completed successfully.\n")
    sys.stdout.flush()
except Exception as e:
    sys.stdout.write(f"ERROR during import: {e}\n")
    import traceback
    sys.stdout.write(f"Traceback:\n{traceback.format_exc()}\n")
    sys.stdout.flush()
    sys.exit(1)

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
            
def read_data(file_path):
    try:
        print(f"Checking if file exists: {file_path}", flush=True)
        u.log(api_token, "1_normalization_csv.py", "info", "normalizing data", "reading: "+file_path)
        if os.path.exists(file_path):
            file_size = os.path.getsize(file_path) / (1024 * 1024)  # Size in MB
            print(f"File exists ({file_size:.2f} MB), reading CSV...", flush=True)
            print("This may take a while for large files...", flush=True)
            df = pd.read_csv(file_path)
            print(f"CSV read complete, {len(df)} rows loaded", flush=True)
            return df
        else:
            print(f"ERROR: File does not exist: {file_path}", flush=True)
            u.log(api_token, "1_normalization_csv.py", "error", "normalizing data", f"File does not exist: {file_path}")
    except Exception as e:
        u.log(api_token, "1_normalization_csv.py", "error", "normalizing data", "error reading file!")
        print(f"Error reading data from {file_path}: {e}", flush=True)
        import traceback
        print(f"Traceback: {traceback.format_exc()}", flush=True)
    
    return None

def processRaces(df):
    # Clear invalid legs
    df.loc[df['TRK_LEG_NUM_unk'].astype(float) < 1, 'Leg_number'] = pd.NA

    # Precompute float race/leg numbers for speed and consistency
    race_col = df['TRK_RACE_NUM_unk'].astype(float)
    leg_col  = df['TRK_LEG_NUM_unk'].astype(float)

    for race_num in race_col.unique():
        if pd.isna(race_num):
            continue

        try:
            race_number = int(race_num)
        except (ValueError, TypeError):
            continue

        # Mask for this race
        race_mask = race_col == float(race_number)
        dfr = df.loc[race_mask].copy()

        # Skip short races (leave defaults of -1)
        if dfr['Period'].sum() <= 300:
            continue

        # Mark valid race
        df.loc[race_mask, 'Race_number'] = race_number

        # Process legs
        for leg_num in dfr['TRK_LEG_NUM_unk'].unique():
            if pd.isna(leg_num):
                continue

            try:
                leg_number = int(leg_num)
            except (ValueError, TypeError):
                continue

            # Mask for this leg within this race
            leg_mask = race_mask & (leg_col == float(leg_number))
            dfr_leg = dfr.loc[dfr['TRK_LEG_NUM_unk'].astype(float) == float(leg_number)]

            if dfr_leg.empty:
                continue

            leg_min = dfr_leg['ts'].min()

            if leg_number == 1:
                # Assign leg 1 rows
                df.loc[leg_mask, 'Leg_number'] = 1

                # Prestart window (2 minutes before leg 1)
                prestart_mask = race_mask & (df['ts'] >= leg_min - 120) & (df['ts'] < leg_min)
                df.loc[prestart_mask, 'Leg_number'] = 0

                # Race window before prestart
                race_min = dfr['ts'].min()
                race_pre_mask = race_mask & (df['ts'] >= race_min) & (df['ts'] < leg_min - 120)
                df.loc[race_pre_mask, 'Race_number'] = -1

            elif leg_number > 1:
                df.loc[leg_mask, 'Leg_number'] = leg_number

    df['Race_number'] = df['Race_number'].fillna(-1).astype('int64')
    df['Leg_number'] = df['Leg_number'].fillna(-1).astype('int64')

    no_race_mask = (df['Race_number'] > 0) & (df['TIME_RACE_s'] == 0)
    df.loc[no_race_mask, 'Race_number'] = -1
    df.loc[no_race_mask, 'Leg_number'] = -1
    
    return df

if __name__ == "__main__":
    try:
        # Print immediately to ensure output is captured
        print("=" * 80, flush=True)
        print("1_normalization_csv.py STARTED", flush=True)
        print("=" * 80, flush=True)
        
        # Validate that we have the required command line argument
        if len(sys.argv) < 2:
            error_msg = "ERROR: Missing required parameters argument"
            print(error_msg, flush=True)
            u.log(api_token, "1_normalization_csv.py", "error", "normalizing data", error_msg)
            sys.exit(1)
        
        parameters_str = sys.argv[1]
        print(f"Received parameters string (length: {len(parameters_str)})", flush=True)
        
        try:
            parameters_json = json.loads(parameters_str)
        except json.JSONDecodeError as json_error:
            error_msg = f"ERROR: Failed to parse parameters JSON: {str(json_error)}"
            print(error_msg, flush=True)
            print(f"Parameters string: {parameters_str[:200]}...", flush=True)  # Print first 200 chars for debugging
            u.log(api_token, "1_normalization_csv.py", "error", "normalizing data", error_msg)
            sys.exit(1)

        #LOG
        u.log(api_token, "1_normalization_csv.py", "info", "parameters", parameters_str)
        print("Parameters parsed successfully", flush=True)

        class_name = parameters_json.get('class_name')
        project_id = parameters_json.get('project_id')
        date = parameters_json.get('date')
        source_name = parameters_json.get('source_name')
        file_name = parameters_json.get('file_name')
        batch = parameters_json.get('batch', False)
        
        # Validate all required parameters
        print(f"Validating parameters...", flush=True)
        missing_params = []
        if not class_name:
            missing_params.append('class_name')
        if not project_id:
            missing_params.append('project_id')
        if not date:
            missing_params.append('date')
        if not source_name:
            missing_params.append('source_name')
        if not file_name:
            missing_params.append('file_name')
        
        if missing_params:
            error_msg = f"ERROR: Missing required parameters: {', '.join(missing_params)}"
            print(error_msg, flush=True)
            print(f"Received parameters: class_name={class_name}, project_id={project_id}, date={date}, source_name={source_name}, file_name={file_name}", flush=True)
            u.log(api_token, "1_normalization_csv.py", "error", "normalizing data", error_msg)
            sys.exit(1)
        
        print(f"✓ All required parameters present", flush=True)
        print(f"Processing: class_name={class_name}, project_id={project_id}, date={date}, source_name={source_name}", flush=True)
        print(f"File: {file_name}", flush=True)
        
        # Validate file_name is a string and not empty
        if not isinstance(file_name, str) or not file_name.strip():
            error_msg = f"ERROR: file_name must be a non-empty string, got: {type(file_name).__name__} = {file_name}"
            print(error_msg, flush=True)
            u.log(api_token, "1_normalization_csv.py", "error", "normalizing data", error_msg)
            sys.exit(1)

        # # MANUAL INPUT
        # class_name = 'GP50'
        # project_id = 2
        # date = '20250314'
        # source_name = 'GER'
        # file_name = r'C:\MyApps\Hunico\Uploads\Data\Raw\2\gp50\20250314\GER\log_GER_2025-03-14_10Hz.csv'
        # batch = False

        filename_only = os.path.basename(file_name)
        filename_no_ext = os.path.splitext(filename_only)[0]

        print("Normalizing: "+filename_no_ext, flush=True)
        print(f"Starting normalization for file: {filename_only}", flush=True)
        u.log(api_token, "1_normalization_csv.py", "info", "normalizing data", f"Starting normalization for file: {filename_only}")
        
        print(f"Reading file: {file_name}", flush=True)
        df = read_data(file_name)
        if df is not None and len(df) > 0:
            print(f"{len(df)} rows found!", flush=True)
            print("File read successfully, starting processing...", flush=True)

            try:
                df.infer_objects()
            except Exception as e:
                u.log(api_token, "1_normalization_csv.py", "warning", "normalizing data", f"Error in infer_objects: {str(e)}")

            print("Preparing datetime...", flush=True)
            df.rename(columns={'DATETIME': 'Datetime'}, inplace=True)
            df.rename(columns={'TIME_LOCAL_unk': 'Datetime_local'}, inplace=True)

            # Convert Datetime to UTC timezone-aware
            df['Datetime'] = pd.to_datetime(df['Datetime'], format='ISO8601', errors='coerce', utc=True)
            df['Datetime_local'] = pd.to_datetime(df['Datetime_local'], format='ISO8601', errors='coerce', utc=False)
            
            # Calculate timezone offset and store as string for Datetime_local
            # This preserves the local timezone information
            mask_local = df['Datetime_local'].notna()
            if mask_local.any():
                # Calculate offset between local and UTC time
                datetime_utc = df.loc[mask_local, 'Datetime']
                datetime_local = df.loc[mask_local, 'Datetime_local']
                
                # If Datetime_local is timezone-naive, calculate offset from difference with UTC
                if datetime_local.dt.tz is None:
                    # Make both naive for comparison
                    datetime_utc_naive = datetime_utc.dt.tz_localize(None)
                    time_diff_hours = (datetime_local - datetime_utc_naive).dt.total_seconds() / 3600
                else:
                    # Both timezone-aware
                    time_diff_hours = (datetime_local - datetime_utc).dt.total_seconds() / 3600
                
                # Format Datetime_local as string with timezone offset
                datetime_str = datetime_local.dt.strftime('%Y-%m-%d %H:%M:%S.%f')
                offset_str = time_diff_hours.apply(lambda h: f"{int(h):+03d}:00")
                
                # Convert column to object type before assigning strings to avoid dtype warning
                df['Datetime_local'] = df['Datetime_local'].astype('object')
                df.loc[mask_local, 'Datetime_local'] = datetime_str + offset_str
            else:
                # No valid values, convert to object type
                df['Datetime_local'] = df['Datetime_local'].astype('object')
            
            # Fill NaT values with empty string for Datetime_local
            df.loc[~mask_local, 'Datetime_local'] = ''
            
            df['ts'] = (df['Datetime'].astype('int64') / 10**9).astype('float64').round(3)
            df['Period'] = df['ts'].diff()

            print("Filtering data...", flush=True)
            # ISSOLATE SAILING DATA
            min_mask = (df["BOAT_SPEED_km_h_1"] > 10) & (df["ANGLE_CA1_deg"].abs() > 5)
            max_mask = (df["BOAT_SPEED_km_h_1"] > 20) & (df["ANGLE_CA1_deg"].abs() > 5) | (df["TIME_RACE_s"] > 0)
            min_ts = df.loc[min_mask, "ts"].min() - 60
            max_ts = df.loc[max_mask, "ts"].max() + 60
            range_mask = (df["ts"] >= min_ts) & (df["ts"] <= max_ts)
            df = df.loc[range_mask].copy()

            print("Smoothing seconds...", flush=True)
            period_series = df['Period'] > 0

            smooth_seconds = 10
            if len(period_series) > 0:
                # Use mode if available, else median
                period_mode = period_series.mode()
                period = period_mode.iloc[0] if len(period_mode) > 0 else period_series.median()

                # Sanity check: period should be positive and reasonable
                if period > 0 and period < 5:
                    smoothing_window = max(1, int(round(smooth_seconds / period)))
                    offset_window = -int(smoothing_window // 2)
                else:
                    # Fallback to median if mode is unreasonable
                    period = period_series.median()
                    smoothing_window = max(1, int(round(smooth_seconds / period))) if period > 0 else 1
                    offset_window = -int(smoothing_window // 2)
            else:
                smoothing_window = 1
                offset_window = 0

            print("Smoothing columns...", flush=True)
            col_map = {
                "Hdg_deg": ("HEADING_deg", "360"),
                "Cog_deg": ("GPS_COG_deg", "360"),
                "Twa_tgt_deg": ("TARG_TWA_deg", "180"),
                "Awa_bow_deg": ("AWA_BOW_SGP_deg", "180"),
                "Awa_mhu_deg": ("AWA_MHU_SGP_deg", "180"),
                "Twa_bow_deg": ("TWA_BOW_SGP_deg", "180"),
                "Twa_mhu_deg": ("TWA_MHU_SGP_deg", "180"),
                "Twd_bow_deg": ("TWD_BOW_SGP_deg", "360"),
                "Twd_mhu_deg": ("TWD_MHU_SGP_deg", "360"),
                "Awa_deg": ("AWA_SGP_deg", "180"),
                "Twd_deg": ("TWD_SGP_deg", "360"),
                "Twa_deg": ("TWA_SGP_deg", "180"),
                "Awa_tm_deg": ("AWA_TM_deg", "180"),
                "Twd_tm_deg": ("TWD_TM_deg", "360"),
                "Twa_tm_deg": ("TWA_TM_deg", "180"),
            }

            print(f"Processing lat / lng glitches...", flush=True)

            df['Lat_dd'] = df['LATITUDE_GPS_unk']
            df['Lng_dd'] = df['LONGITUDE_GPS_unk']
            # df = u.filter_impossible_acceleration(df, ts_col='ts', lat_col='Lat_f', lon_col='Lng_f', accel_threshold=15, smoothing_window=smoothing_window, drop_intermediates=True)
            df = u.rolling_median_latlon_filter(df, lat_col='Lat_dd', lon_col='Lng_dd', window=11, deviation_threshold=0.0003, smoothing_window=smoothing_window, drop_intermediates=True)

            print(f"Processing {len(col_map)} angle columns...", flush=True)

            for output_col, (input_col, angle_range) in col_map.items():
                try:
                    df = u.rolling_mean_and_shift_angle(df, input_col=input_col, output_col=output_col, smoothing_window=smoothing_window, offset_window=offset_window, angle_range=angle_range)
                except Exception as e:
                    df[output_col] = np.nan
                    # print(f"Error in rolling_mean_and_shift_angle: {e}", flush=True)
                    u.log(api_token, "1_normalization_csv.py", "warning", "normalizing data", "rolling_mean_and_shift_angle error: " + str(e))
                    continue
                
            df.rename(columns={'PITCH_deg': 'PITCH_deg_ori'}, inplace=True)

            col_map = {
                "Bsp_kph": "BOAT_SPEED_km_h_1",
                "Bsp_kts": "BSP_kn",
                "Vmg_kph": "VMG_km_h_1",
                "Sog_kph": "GPS_SOG_km_h_1",
                "Bsp_polar_kph": "POLAR_BOAT_SPEED_km_h_1",
                "Vmg_tgt_kph": "TARG_VMG_km_h_1",
                "Bsp_tgt_kph": "TARG_BOAT_SPEED_km_h_1",
                "Aws_bow_kph": "AWS_BOW_SGP_km_h_1",
                "Aws_mhu_kph": "AWS_MHU_SGP_km_h_1",
                "Tws_bow_kph": "TWS_BOW_SGP_km_h_1",
                "Tws_mhu_kph": "TWS_MHU_SGP_km_h_1",
                "Aws_kph": "AWS_SGP_km_h_1",
                "Tws_kph": "TWS_SGP_km_h_1",
                "Twd_tm_deg": "TWD_TM_deg",
                "Tws_tm_kph": "TWS_TM_km_h_1",
                "RH_port_mm": "LENGTH_RH_P_mm",
                "RH_stbd_mm": "LENGTH_RH_S_mm",
                "RH_bow_mm": "LENGTH_RH_BOW_mm",
                "DB_ext_port_mm": "LENGTH_DB_H_P_mm",
                "DB_ext_stbd_mm": "LENGTH_DB_H_S_mm",
                "DB_imm_port_mm": "LENGTH_IMMERSION_DB_P_mm",
                "DB_imm_stbd_mm": "LENGTH_IMMERSION_DB_S_mm",
                "RUD_imm_port_mm": "LENGTH_IMMERSION_RUD_P_mm",
                "RUD_imm_stbd_mm": "LENGTH_IMMERSION_RUD_S_mm",
                "DB_piercing_port_mm": "LENGTH_DB_PIERCING_P_m",
                "DB_piercing_stbd_mm": "LENGTH_DB_PIERCING_S_m",
                "Lwy_deg": "LEEWAY_deg",
                "Pitch_deg": "PITCH_deg_ori",
                "Heel_deg": "HEEL_deg",
                "Yaw_rate_dps": "RATE_YAW_deg_s_1",
                "Pitch_rate_dps": "RATE_PITCH_deg_s_1",
                "Roll_rate_dps": "RATE_ROLL_deg_s_1",
                "CA1_ang_deg": "ANGLE_CA1_deg",
                "CA2_ang_deg": "ANGLE_CA2_deg",
                "CA3_ang_deg": "ANGLE_CA3_deg",
                "CA4_ang_deg": "ANGLE_CA4_deg",
                "CA5_ang_deg": "ANGLE_CA5_deg",
                "CA6_ang_deg": "ANGLE_CA6_deg",
                "WING_twist_deg": "ANGLE_WING_TWIST_deg",
                "WING_rot_deg": "ANGLE_WING_ROT_deg",
                "WING_aoa_deg": "AWA_-_E1_deg",
                "WING_clew_ang_deg": "ANGLE_CLEW_deg",
                "WING_clew_ang_to_ctr_deg": "ANGLE_CLEW_TO_CTR_deg",
                "WING_clew_pos_mm": "LENGTH_WING_CLEW_mm",
                "JIB_lead_ang_deg": "ANGLE_JIB_SHT_deg",
                "JIB_lead_pct": "PER_JIB_LEAD_pct",
                "JIB_sheet_pct": "PER_JIB_SHEET_pct",
                "JIB_cunno_load_kgf": "LOAD_JIB_CUNNO_kgf.1",
                "JIB_sheet_load_kgf": "LOAD_JIB_SHEET_kgf.1",
                "RUD_ang_deg": "ANGLE_RUDDER_deg",
                "RUD_rake_ang_deg": "ANGLE_RUD_AVG_deg",
                "RUD_diff_ang_deg": "ANGLE_RUD_DIFF_TACK_deg",
                "DB_rake_ang_port_deg": "ANGLE_DB_RAKE_P_deg",
                "DB_rake_ang_stbd_deg": "ANGLE_DB_RAKE_S_deg",
                "DB_rake_aoa_port_deg": "ANGLE_DB_RAKE_P_AOA_deg",
                "DB_rake_aoa_stbd_deg": "ANGLE_DB_RAKE_S_AOA_deg",
                "DB_cant_port_deg": "ANGLE_DB_CANT_P_deg",
                "DB_cant_stbd_deg": "ANGLE_DB_CANT_S_deg",
                "DB_cant_eff_port_deg": "ANGLE_DB_CANT_P_EFF_deg",
                "DB_cant_eff_stbd_deg": "ANGLE_DB_CANT_S_EFF_deg",
                "DB_stow_state_port": "DB_STOW_STATE_P_unk",
                "DB_stow_state_stbd": "DB_STOW_STATE_S_unk",
                "SHRD_lwr_port_tf": "LOAD_SHRD_LWR_P_tf",
                "SHRD_lwr_stbd_tf": "LOAD_SHRD_LWR_S_tf",
                "SHRD_upr_port_tf": "LOAD_SHRD_UPR_P_tf",
                "SHRD_upr_stbd_tf": "LOAD_SHRD_UPR_S_tf",
                "BOBSTAY_load_tf": "LOAD_BOBSTAY_tf",
            }

            print(f"Processing {len(col_map)} regular columns...", flush=True)
            for output_col, input_col in col_map.items():
                try:
                    df = u.rolling_mean_and_shift(df,input_col=input_col,output_col=output_col,smoothing_window=smoothing_window,offset_window=offset_window)
                except Exception as e:
                    df[output_col] = np.nan
                    # print(f"Error in rolling_mean_and_shift: {e}", flush=True)
                    u.log(api_token, "1_normalization_csv.py", "warning", "normalizing data", "rolling_mean_and_shift error: " + str(e))
                    continue

            # NEW CHANELS / UNITS CONVERSIONS
            print("New Channels and units conversions...", flush=True)

            try:
                df.rename(columns={'TRK_COURSE_AXIS_deg': 'Course_axis_deg'}, inplace=True)
            except Exception as e:
                u.log(api_token, "1_normalization_csv.py", "warning", "normalizing data", f"Error renaming Course_axis_deg: {str(e)}")

            df['Race_number'] = -1
            df['Leg_number'] = -1

            try:
                df = processRaces(df)
            except Exception as e:
                u.log(api_token, "1_normalization_csv.py", "warning", "normalizing data", f"Error in processRaces: {str(e)}")
                # Continue with default race/leg numbers

            # RAW ACCELERATION
            first_bsp = df['Bsp_kts'].iloc[0] if len(df) > 0 else 0.0
            df['PrevBsp'] = df['Bsp_kts'].shift(fill_value=first_bsp)
            bsp_diff = (df['Bsp_kts'] - df['PrevBsp']) * u.mps
            df['Accel_rate_mps2_raw'] = np.where(
                period_series,
                bsp_diff / df['Period'],
                0.0
            )

            # SMOOTHED ACCELERATION
            df['Accel_rate_mps2_smoothed'] = df['Accel_rate_mps2_raw'].rolling(
                window=smoothing_window, 
                min_periods=1
            ).mean()
            df['Accel_rate_mps2'] = df['Accel_rate_mps2_smoothed'].shift(offset_window)

            df.drop(columns=['PrevBsp','Accel_rate_mps2_smoothed','Accel_rate_mps2_raw'], inplace=True)

            df['Tws_delta_kph'] = (df['Tws_mhu_kph'] - df['Tws_bow_kph']) 
            df['Tws_delta_kts'] = df['Tws_delta_kph'] * 0.539957 
            df['Twa_delta_deg'] = df['Twa_mhu_deg'] - df['Twa_bow_deg']
            df['Cwa_deg'] = df.apply(lambda row: u.angle_subtract(row['Twd_deg'], row['Cog_deg']), axis=1)

            df = df.copy()
            
            df['Tws_kts'] = df['Tws_kph'] * 0.539957
            df['Tws_tm_kts'] = df['Tws_tm_kph'] * 0.539957
            df['Tws_bow_kts'] = df['Tws_bow_kph'] * 0.539957
            df['Tws_mhu_kts'] = df['Tws_mhu_kph'] * 0.539957

            df = df.copy()

            df['Aws_kts'] = df['Aws_kph'] * 0.539957
            df['Sog_kts'] = df['Sog_kph'] * 0.539957
            df['Bsp_tgt_kts'] = df['Bsp_tgt_kph'] * 0.539957
            df['Vmg_tgt_kts'] = abs(df['Vmg_tgt_kph'] * 0.539957)
            df['Vmg_tgt_kph'] = abs(df['Vmg_tgt_kph'])

            df = df.copy()

            df['Vmg_kts'] = abs(df['Bsp_kts'] * np.cos(np.radians(df['Cwa_deg'])))
            df['Vmg_kph'] = abs(df['Bsp_kph'] * np.cos(np.radians(df['Cwa_deg'])))

            # Defragment DataFrame after many column additions to improve performance
            df = df.copy()

            # NORMALIZE CHANELS
            df['Awa_n_deg'] = abs(df['Awa_deg'])
            df['Twa_n_deg'] = abs(df['Twa_deg'])
            df['Cwa_n_deg'] = abs(df['Cwa_deg'])
            df['Twa_bow_n_deg'] = abs(df['Twa_bow_deg'])
            df['Twa_mhu_n_deg'] = abs(df['Twa_mhu_deg'])
            df['Twa_avg_n_deg'] = abs(df['Twa_avg_deg'])

            # PERFORMANCE PERCENTAGES
            try:
                # Use safe division to handle NaN values from rolling_mean_and_shift failures
                df['Bsp_perc'] = np.where(df['Bsp_tgt_kts'] != 0, (df['Bsp_kts'] / df['Bsp_tgt_kts']) * 100, 0)
                df['Vmg_perc'] = np.where(df['Vmg_tgt_kts'] != 0, (df['Vmg_kts'] / df['Vmg_tgt_kts']) * 100, 0)
                df['Polar_perc'] = np.where(df['Bsp_polar_kph'] != 0, (df['Bsp_kph'] / df['Bsp_polar_kph']) * 100, 0)

                df['Vmg_perc'] = df['Vmg_perc'].clip(lower=0, upper=150)
                df['Bsp_perc'] = df['Bsp_perc'].clip(lower=0, upper=150)
                df['Polar_perc'] = df['Polar_perc'].clip(lower=0, upper=150)
            except Exception as e:
                u.log(api_token, "1_normalization_csv.py", "warning", "normalizing data", f"Error computing performance percentages: {str(e)}")
                # Set default values if computation fails
                df['Bsp_perc'] = 0
                df['Vmg_perc'] = 0
                df['Polar_perc'] = 0

            df = df.copy()

            tack_sign = np.sign(df['Twa_deg'])

            df['CA1_ang_n_deg'] = (df['CA1_ang_deg'] * tack_sign) * -1
            df['CA2_ang_n_deg'] = (df['CA2_ang_deg'] * tack_sign) * -1
            df['CA3_ang_n_deg'] = (df['CA3_ang_deg'] * tack_sign) * -1
            df['CA4_ang_n_deg'] = (df['CA4_ang_deg'] * tack_sign) * -1
            df['CA5_ang_n_deg'] = (df['CA5_ang_deg'] * tack_sign) * -1
            df['CA6_ang_n_deg'] = (df['CA6_ang_deg'] * tack_sign) * -1
            df['WING_twist_n_deg'] = df['WING_twist_deg'] * tack_sign
            df['WING_rot_n_deg'] = df['WING_rot_deg'] * tack_sign
            df['WING_aoa_n_deg'] = df['WING_aoa_deg'] * tack_sign
            df['WING_clew_ang_n_deg'] = df['WING_clew_ang_deg'] * tack_sign
            df['WING_clew_ang_n_to_ctr_deg'] = df['WING_clew_ang_to_ctr_deg'] * tack_sign
            df['WING_clew_pos_n_mm'] = df['WING_clew_pos_mm'] * tack_sign

            df['Heel_deg'] = df['Heel_deg'] * -1
            df['Heel_n_deg'] = df['Heel_deg'] * tack_sign
            df['RUD_ang_n_deg'] = df['RUD_ang_deg'] * tack_sign

            df['Lwy2_deg'] = df.apply(lambda row: u.angle_subtract(row['Hdg_deg'], row['Cog_deg']), axis=1)
            df['Lwy2_deg'] = np.where(df['Bsp_kph'] < 5 or df['Lwy2_deg'] > 50, 1, df['Lwy2_deg'])
            df['Lwy_n_deg'] = df['Lwy_deg'] * tack_sign
            df['Lwy2_n_deg'] = df['Lwy2_deg'] * tack_sign
            
            df['Roll_rate_n_dps'] = df['Roll_rate_dps'] * tack_sign
            df['Yaw_rate_n_dps'] = df['Yaw_rate_dps'] * tack_sign

            # DERIVE WWD / LWD CHANNELS
            df['RH_lwd_mm'] = np.where(tack_sign > 0, df['RH_port_mm'], df['RH_stbd_mm'])
            df['RH_wwd_mm'] = np.where(tack_sign > 0, df['RH_stbd_mm'], df['RH_port_mm'])

            df['Foiling_state'] = np.select(
                [
                    (df['Bsp_kts'] > 15) & (df['Heel_n_deg'] < 8),                    # H0
                    (df['Bsp_kts'] > 15) & (df['Heel_n_deg'] > 8),                    # H1
                    (df['Bsp_kts'] < 15) & (df['Heel_n_deg'] > 5),                    # H1
                    (df['Bsp_kts'] < 15) & (df['Heel_n_deg'] < 5),                    # H2
                ],
                [
                    0,
                    1,
                    1,
                    2
                ],
                default=1  # matches your final else
            )

            df = df.copy()

            df['DB_rake_ang_lwd_deg'] = np.where(tack_sign > 0, df['DB_rake_ang_port_deg'], df['DB_rake_ang_stbd_deg'])
            df['DB_rake_ang_wwd_deg'] = np.where(tack_sign > 0, df['DB_rake_ang_stbd_deg'], df['DB_rake_ang_port_deg'])
            df['DB_rake_aoa_lwd_deg'] = np.where(tack_sign > 0, df['DB_rake_aoa_port_deg'], df['DB_rake_aoa_stbd_deg'])
            df['DB_rake_aoa_wwd_deg'] = np.where(tack_sign > 0, df['DB_rake_aoa_stbd_deg'], df['DB_rake_aoa_port_deg'])

            df['DB_ext_lwd_mm'] = np.where(tack_sign > 0, df['DB_ext_port_mm'], df['DB_ext_stbd_mm'])
            df['DB_ext_wwd_mm'] = np.where(tack_sign > 0, df['DB_ext_stbd_mm'], df['DB_ext_port_mm'])
            df['DB_cant_lwd_deg'] = np.where(tack_sign > 0, df['DB_cant_port_deg'], df['DB_cant_stbd_deg'])
            df['DB_cant_wwd_deg'] = np.where(tack_sign > 0, df['DB_cant_stbd_deg'], df['DB_cant_port_deg'])
            df['DB_cant_eff_lwd_deg'] = np.where(tack_sign > 0, df['DB_cant_eff_port_deg'], df['DB_cant_eff_stbd_deg'])
            df['DB_cant_eff_wwd_deg'] = np.where(tack_sign > 0, df['DB_cant_eff_stbd_deg'], df['DB_cant_eff_port_deg'])

            df['DB_imm_lwd_mm'] = np.where(tack_sign > 0, df['DB_imm_port_mm'], df['DB_imm_stbd_mm'])
            df['DB_imm_wwd_mm'] = np.where(tack_sign > 0, df['DB_imm_stbd_mm'], df['DB_imm_port_mm'])
            df['DB_piercing_lwd_mm'] = np.where(tack_sign > 0, df['DB_piercing_port_mm'], df['DB_piercing_stbd_mm'])
            df['DB_piercing_wwd_mm'] = np.where(tack_sign > 0, df['DB_piercing_stbd_mm'], df['DB_piercing_port_mm'])
            df['RUD_imm_lwd_mm'] = np.where(tack_sign > 0, df['RUD_imm_port_mm'], df['RUD_imm_stbd_mm'])
            df['RUD_imm_wwd_mm'] = np.where(tack_sign > 0, df['RUD_imm_stbd_mm'], df['RUD_imm_port_mm'])
            df['RUD_imm_tot_mm'] = df['RUD_imm_lwd_mm'] + df['RUD_imm_wwd_mm']

            df['SHRD_lwr_lwd_tf'] = np.where(tack_sign > 0, df['SHRD_lwr_port_tf'], df['SHRD_lwr_stbd_tf'])
            df['SHRD_lwr_wwd_tf'] = np.where(tack_sign > 0, df['SHRD_lwr_stbd_tf'], df['SHRD_lwr_port_tf'])
            df['SHRD_upr_lwd_tf'] = np.where(tack_sign > 0, df['SHRD_upr_port_tf'], df['SHRD_upr_stbd_tf'])
            df['SHRD_upr_wwd_tf'] = np.where(tack_sign > 0, df['SHRD_upr_stbd_tf'], df['SHRD_upr_port_tf'])

            df['RIG_load_tf'] = np.where(tack_sign > 0, df['SHRD_lwr_stbd_tf'] + df['SHRD_upr_stbd_tf'] + df['BOBSTAY_load_tf'], df['SHRD_upr_stbd_tf'] + df['SHRD_upr_port_tf'] + df['BOBSTAY_load_tf'])

            # PREPARE DATAFRAME
            try:
                df = df.copy()
                datetime_cols = df.select_dtypes(include=['datetime64[ns, UTC]', 'datetime64[ns]']).columns
                numeric_cols = df.select_dtypes(include=[np.number]).columns
                df[numeric_cols] = df[numeric_cols].fillna(0)
                df[numeric_cols] = df[numeric_cols].replace(np.nan, 0)
                u.remove_gaps(df, 'Bsp_kts', 'ts')
            except Exception as e:
                u.log(api_token, "1_normalization_csv.py", "warning", "normalizing data", f"Error preparing dataframe: {str(e)}")
                # Continue - try to save what we have

            print("Computing VMC...", flush=True)
            try:
                df = df.copy()

                df = u.computeVMC(df)

                # VMC is computed in computeVMC, now convert to kph if needed
                if 'Vmc_kts' in df.columns:
                    df['Vmc_kph'] = df['Vmc_kts'] * 1.852
            except Exception as e:
                u.log(api_token, "1_normalization_csv.py", "warning", "normalizing data", f"Error computing VMC: {str(e)}")
                # Continue without VMC if computation fails

            print("Wrapping up...", flush=True)
            
            # Sort by Datetime to ensure chronological order before saving
            df = df.sort_values(by='Datetime').reset_index(drop=True)

            # Get data directory from environment variable
            data_dir = os.getenv('DATA_DIRECTORY', 'C:/MyApps/Hunico/Uploads/Data')
            
            # Normalize class_name to lowercase for consistent directory structure
            class_lower = class_name.lower() if class_name else ''
            
            # Ensure directory exists
            output_dir = os.path.join(data_dir, 'System', str(project_id), class_lower, date, source_name)
            os.makedirs(output_dir, exist_ok=True)
            
            print("Saving files split into 1-hour chunks...", flush=True)
            u.log(api_token, "1_normalization_csv.py", "info", "normalizing data", "saving normalized data to parquet in 1-hour chunks...")

            try:
                # Ensure Datetime is datetime type for grouping
                if 'Datetime' in df.columns:
                    df['Datetime'] = pd.to_datetime(df['Datetime'])
                elif 'ts' in df.columns:
                    df['Datetime'] = pd.to_datetime(df['ts'], unit='s', utc=True)
                
                # Group by hour (floor to hour boundary)
                df['Hour'] = df['Datetime'].dt.floor('H')
                
                # Get unique hours
                unique_hours = df['Hour'].unique()
                num_files = len(unique_hours)
                
                print(f"Splitting data into {num_files} file(s) by hour...", flush=True)
                
                files_saved = 0
                for hour in sorted(unique_hours):
                    # Filter data for this hour
                    hour_mask = df['Hour'] == hour
                    df_hour = df[hour_mask].copy()
                    
                    # Remove the temporary Hour column
                    df_hour = df_hour.drop(columns=['Hour'])
                    
                    if len(df_hour) == 0:
                        continue
                    
                    # Get hour range: start at this hour, end at next hour
                    hour_start = hour
                    hour_end = hour_start + pd.Timedelta(hours=1)
                    
                    # Format hour for filename: HHMM format
                    hour_str = hour_start.strftime('%H%M')
                    hour_end_str = hour_end.strftime('%H%M')
                    
                    # Extract base filename without extension and add hour range
                    # Filename pattern: {base_filename}_{HHMM}-{HHMM}_norm.parquet
                    filename_hour = f"{filename_no_ext}_{hour_str}-{hour_end_str}"
                    file_path = os.path.join(output_dir, filename_hour+'_norm.parquet')
                    
                    # Remove existing file if it exists
                    if os.path.exists(file_path):
                        os.remove(file_path)
                    
                    # Save this hour's data
                    df_hour.to_parquet(file_path, engine='pyarrow', index=False)
                    files_saved += 1
                    print(f"Saved hour chunk {hour_start.strftime('%H:%M')} to {hour_end.strftime('%H:%M')}: {file_path} ({len(df_hour)} rows)", flush=True)
                
                print(f"✓ Saved {files_saved} parquet file(s) in JavaScript-compatible format!", flush=True)
                u.log(api_token, "1_normalization_csv.py", "info", "normalizing data", f"success! Saved {files_saved} file(s) split by hour")
                print("Script Completed:", u.dt.now(), flush=True)
                sys.exit(0)  # Exit with success code to signal completion to the server
            except Exception as save_error:
                error_msg = f"Failed to save parquet file(s): {str(save_error)}"
                print(error_msg, flush=True)
                import traceback
                print(f"Traceback: {traceback.format_exc()}", flush=True)
                u.log(api_token, "1_normalization_csv.py", "error", "normalizing data", error_msg)
                # Only exit with error code if file save fails - this is a critical failure
                sys.exit(1)  # Exit with error code to signal failure to the server
        else:
            u.log(api_token, "1_normalization_csv.py", "error", "normalizing data", "failed to read data")
            print("Failed to read data.", flush=True)
            sys.exit(1)  # Exit with error code to signal failure to the server
    except Exception as error:
        u.log(api_token, "1_normalization_csv.py", "error", "normalizing data", "script exception error:"+str(error))
        print("Error:", str(error), flush=True)
        sys.exit(1)  # Exit with error code to signal failure to the server