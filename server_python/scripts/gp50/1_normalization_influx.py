import sys

# Print immediately when script starts
sys.stdout.write("=" * 80 + "\n")
sys.stdout.write("1_normalization_influx.py: Script starting, importing modules...\n")
sys.stdout.write("=" * 80 + "\n")
sys.stdout.flush()

try:
    import os, json, math as m, re
    from datetime import datetime
    import pandas as pd
    import numpy as np
    import utilities as u
    from dateutil import tz as dateutil_tz
    from dateutil.tz import gettz

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

def get_influx_to_normalized_mapping():
    """
    Returns mappings from InfluxDB measurement names to normalized channel names.
    Based on the mappings in 1_normalization_csv.py.
    
    Returns:
        tuple: (angle_map, regular_map, special_map)
        - angle_map: dict mapping normalized_name -> (influx_name, angle_range)
        - regular_map: dict mapping normalized_name -> influx_name
        - special_map: dict mapping normalized_name -> influx_name for special columns
    """
    # Angle channels: normalized_name -> (influx_name, angle_range)
    angle_map = {
        "Hdg_deg": ("HEADING_deg", "360"),
        "Cog_deg": ("GPS_COG_deg", "360"),
        "Twa_tgt_deg": ("TARG_TWA_deg", "180"),
        "Awa_bow_deg": ("AWA_BOW_SGP_deg", "180"),
        "Awa_mhu_deg": ("AWA_MHU_SGP_deg", "180"),
        "Twa_bow_deg": ("TWA_BOW_SGP_deg", "180"),
        "Twa_mhu_deg": ("TWA_MHU_SGP_deg", "180"),
        "Twd_bow_deg": ("TWD_BOW_SGP_deg", "360"),
        "Twd_mhu_deg": ("TWD_MHU_SGP_deg", "360"),
        "Awa_sgp_deg": ("AWA_SGP_deg", "180"),
        "Twd_sgp_deg": ("TWD_SGP_deg", "360"),
        "Twa_sgp_deg": ("TWA_SGP_deg", "180"),
        "Awa_deg": ("AWA_SGP_deg", "180"),
        "Twd_deg": ("TWD_SGP_deg", "360"),
        "Twa_deg": ("TWA_SGP_deg", "180"),
        "Cur_dir_est_deg": ("CURRENT_DIRECTION_deg", "360"),
    }
    
    # Regular channels: normalized_name -> influx_name
    regular_map = {
        "Bsp_kph": "BOAT_SPEED_km_h_1",
        "Vmg_kph": "VMG_km_h_1",
        "Sog_kph": "GPS_SOG_km_h_1",
        "Bsp_polar_kph": "POLAR_BOAT_SPEED_km_h_1",
        "Vmg_tgt_kph": "TARG_VMG_km_h_1",
        "Bsp_tgt_kph": "TARG_BOAT_SPEED_km_h_1",
        "Aws_bow_kph": "AWS_BOW_SGP_km_h_1",
        "Aws_mhu_kph": "AWS_MHU_SGP_km_h_1",
        "Tws_bow_kph": "TWS_BOW_SGP_km_h_1",
        "Tws_mhu_kph": "TWS_MHU_SGP_km_h_1",
        "Aws_sgp_kph": "AWS_SGP_km_h_1",
        "Aws_kph": "AWS_SGP_km_h_1",
        "Tws_sgp_kph": "TWS_SGP_km_h_1",
        "Tws_tm_kph": "TWS_TM_km_h_1",
        "Tws_kph": "TWS_TM_km_h_1",
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
        "Pitch_deg": "PITCH_deg",
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
        "WING_clew_pos_mm": "LENGTH_WING_CLEW_mm",
        "JIB_lead_ang_deg": "ANGLE_JIB_SHT_deg",
        "JIB_lead_pct": "PER_JIB_LEAD_pct",
        "JIB_sheet_pct": "PER_JIB_SHEET_pct",
        "JIB_cunno_load_kgf": "LOAD_JIB_CUNNO_kgf",
        "JIB_sheet_load_kgf": "LOAD_JIB_SHEET_kgf",
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
        "Cur_rate_est_kph": "CURRENT_MAGNITUDE_km_h_1"
    }
    
    # Special columns that need mapping
    special_map = {
        "Lat_dd": "LATITUDE_GPS_unk",
        "Lng_dd": "LONGITUDE_GPS_unk",
        "TIME_RACE_s": "TIME_RACE_s",
        "Course_axis_deg": "TRK_COURSE_AXIS_deg",
    }
    
    return angle_map, regular_map, special_map

def get_required_channels():
    """
    Returns the complete list of channels required by all downstream scripts.
    Uses InfluxDB measurement names for the query, which will be mapped to normalized names after download.
    
    Returns:
        List of channel dictionaries with 'name' (InfluxDB name) and 'type' for InfluxDB query
    """
    angle_map, regular_map, special_map = get_influx_to_normalized_mapping()
    
    channels = [
        # Core time and location (use InfluxDB names)
        {'name': 'LATITUDE_GPS_unk', 'type': 'float'},
        {'name': 'LONGITUDE_GPS_unk', 'type': 'float'},
        {'name': 'TRK_RACE_NUM_unk', 'type': 'int'},
        {'name': 'TRK_LEG_NUM_unk', 'type': 'int'},
        {'name': 'TIME_RACE_s', 'type': 'float'},
        {'name': 'TIME_TC_START_s', 'type': 'float'},
        {'name': 'TRK_COURSE_AXIS_deg', 'type': 'float'},
        {'name': 'TRK_RACE_RANK_unk', 'type': 'float'},
        {'name': 'TRK_BOAT_RACE_STATUS_unk', 'type': 'float'},
        {'name': 'PC_DTO_m', 'type': 'float'},
        {'name': 'PC_DTL_m', 'type': 'float'},
        {'name': 'PC_TTK_s', 'type': 'float'},
        {'name': 'PC_START_RATIO_unk', 'type': 'float'},
        {'name': 'PC_START_LINE_PER_pct', 'type': 'float'},
        {'name': 'ANGLE_CANT_STOW_TARG_UW_deg', 'type': 'float'},
        {'name': 'ANGLE_CANT_STOW_TARG_DW_deg', 'type': 'float'},
        {'name': 'ANGLE_CANT_DROP_TARG_UW_deg', 'type': 'float'},
        {'name': 'ANGLE_CANT_DROP_TARG_DW_deg', 'type': 'float'},
        
        # Wind measurements (use InfluxDB names from mappings)
        {'name': regular_map['Tws_tm_kph'], 'type': 'float'},
        {'name': regular_map['Tws_bow_kph'], 'type': 'float'},
        {'name': regular_map['Tws_mhu_kph'], 'type': 'float'},
        {'name': regular_map['Tws_sgp_kph'], 'type': 'float'},
        {'name': angle_map['Twd_deg'][0], 'type': 'angle360'},
        {'name': angle_map['Twd_bow_deg'][0], 'type': 'angle360'},
        {'name': angle_map['Twd_mhu_deg'][0], 'type': 'angle360'},
        {'name': angle_map['Twd_sgp_deg'][0], 'type': 'angle360'},
        {'name': angle_map['Twa_deg'][0], 'type': 'angle180'},
        {'name': angle_map['Twa_bow_deg'][0], 'type': 'angle180'},
        {'name': angle_map['Twa_mhu_deg'][0], 'type': 'angle180'},
        {'name': angle_map['Twa_tgt_deg'][0], 'type': 'angle180'},
        {'name': angle_map['Twa_sgp_deg'][0], 'type': 'angle180'},
        
        # Apparent wind
        {'name': regular_map['Aws_kph'], 'type': 'float'},
        {'name': regular_map['Aws_bow_kph'], 'type': 'float'},
        {'name': regular_map['Aws_mhu_kph'], 'type': 'float'},
        {'name': regular_map['Aws_sgp_kph'], 'type': 'float'},
        {'name': angle_map['Awa_deg'][0], 'type': 'angle180'},
        {'name': angle_map['Awa_bow_deg'][0], 'type': 'angle180'},
        {'name': angle_map['Awa_mhu_deg'][0], 'type': 'angle180'},
        {'name': angle_map['Awa_sgp_deg'][0], 'type': 'angle180'},
        
        # Course and heading
        {'name': angle_map['Hdg_deg'][0], 'type': 'angle360'},
        {'name': angle_map['Cog_deg'][0], 'type': 'angle360'},
        
        # Speed measurements
        {'name': regular_map['Sog_kph'], 'type': 'float'},
        {'name': regular_map['Bsp_kph'], 'type': 'float'},
        # Note: Bsp_kts is calculated from Bsp_kph later, not downloaded from InfluxDB
        {'name': regular_map['Bsp_tgt_kph'], 'type': 'float'},
        {'name': regular_map['Bsp_polar_kph'], 'type': 'float'},
        {'name': regular_map['Vmg_kph'], 'type': 'float'},
        {'name': regular_map['Vmg_tgt_kph'], 'type': 'float'},
        
        # Boat attitude
        {'name': regular_map['Pitch_deg'], 'type': 'float'},
        {'name': regular_map['Heel_deg'], 'type': 'float'},
        {'name': regular_map['Lwy_deg'], 'type': 'float'},
        
        # Rates
        {'name': regular_map['Pitch_rate_dps'], 'type': 'float'},
        {'name': regular_map['Yaw_rate_dps'], 'type': 'float'},
        {'name': regular_map['Roll_rate_dps'], 'type': 'float'},
        
        # Righting hull
        {'name': regular_map['RH_port_mm'], 'type': 'float'},
        {'name': regular_map['RH_stbd_mm'], 'type': 'float'},
        {'name': regular_map['RH_bow_mm'], 'type': 'float'},
        
        # Rudder
        {'name': regular_map['RUD_ang_deg'], 'type': 'float'},
        {'name': regular_map['RUD_rake_ang_deg'], 'type': 'float'},
        {'name': regular_map['RUD_diff_ang_deg'], 'type': 'float'},
        {'name': regular_map['RUD_imm_port_mm'], 'type': 'float'},
        {'name': regular_map['RUD_imm_stbd_mm'], 'type': 'float'},
        
        # Daggerboard
        {'name': regular_map['DB_rake_ang_port_deg'], 'type': 'float'},
        {'name': regular_map['DB_rake_ang_stbd_deg'], 'type': 'float'},
        {'name': regular_map['DB_rake_aoa_port_deg'], 'type': 'float'},
        {'name': regular_map['DB_rake_aoa_stbd_deg'], 'type': 'float'},
        {'name': regular_map['DB_cant_port_deg'], 'type': 'float'},
        {'name': regular_map['DB_cant_stbd_deg'], 'type': 'float'},
        {'name': regular_map['DB_cant_eff_port_deg'], 'type': 'float'},
        {'name': regular_map['DB_cant_eff_stbd_deg'], 'type': 'float'},
        {'name': regular_map['DB_ext_port_mm'], 'type': 'float'},
        {'name': regular_map['DB_ext_stbd_mm'], 'type': 'float'},
        {'name': regular_map['DB_imm_port_mm'], 'type': 'float'},
        {'name': regular_map['DB_imm_stbd_mm'], 'type': 'float'},
        {'name': regular_map['DB_piercing_port_mm'], 'type': 'float'},
        {'name': regular_map['DB_piercing_stbd_mm'], 'type': 'float'},
        {'name': regular_map['DB_stow_state_stbd'], 'type': 'float'},
        {'name': regular_map['DB_stow_state_port'], 'type': 'float'},
        
        # Wing controls
        {'name': regular_map['CA1_ang_deg'], 'type': 'float'},
        {'name': regular_map['CA2_ang_deg'], 'type': 'float'},
        {'name': regular_map['CA3_ang_deg'], 'type': 'float'},
        {'name': regular_map['CA4_ang_deg'], 'type': 'float'},
        {'name': regular_map['CA5_ang_deg'], 'type': 'float'},
        {'name': regular_map['CA6_ang_deg'], 'type': 'float'},
        {'name': regular_map['WING_twist_deg'], 'type': 'float'},
        {'name': regular_map['WING_rot_deg'], 'type': 'float'},
        {'name': regular_map['WING_aoa_deg'], 'type': 'float'},
        {'name': regular_map['WING_clew_ang_deg'], 'type': 'float'},
        {'name': regular_map['WING_clew_pos_mm'], 'type': 'float'},
        
        # Jib
        {'name': regular_map['JIB_sheet_pct'], 'type': 'float'},
        {'name': regular_map['JIB_sheet_load_kgf'], 'type': 'float'},
        {'name': regular_map['JIB_cunno_load_kgf'], 'type': 'float'},
        {'name': regular_map['JIB_lead_ang_deg'], 'type': 'float'},
        {'name': regular_map['JIB_lead_pct'], 'type': 'float'},
        
        # Rig loads
        {'name': regular_map['BOBSTAY_load_tf'], 'type': 'float'},
        {'name': regular_map['SHRD_lwr_port_tf'], 'type': 'float'},
        {'name': regular_map['SHRD_lwr_stbd_tf'], 'type': 'float'},
        {'name': regular_map['SHRD_upr_port_tf'], 'type': 'float'},
        {'name': regular_map['SHRD_upr_stbd_tf'], 'type': 'float'},

        # Current (cur)
        {'name': regular_map['Cur_rate_est_kph'], 'type': 'float'},
        {'name': angle_map['Cur_dir_est_deg'][0], 'type': 'angle360'},
    ]
    
    # Remove duplicates (ts appears once, keep unique names)
    seen = set()
    unique_channels = []
    for ch in channels:
        if ch['name'] not in seen:
            seen.add(ch['name'])
            unique_channels.append(ch)
    
    return unique_channels

def detect_and_correct_bow_mhu_sensor_issues(df, apply_corrections=False):
    print("Validating bow and mhu sensors...", flush=True)

    """
    Detects issues between _bow and _mhu sensors by comparing Tws (True Wind Speed) values.
    If one sensor shows very low or very high readings compared to the other, it's likely faulty.
    Optionally replaces all measurements from the bad sensor with data from the good sensor.
    
    Measurements that can be replaced include:
    - Awa (Apparent Wind Angle)
    - Aws (Apparent Wind Speed)
    - Twa (True Wind Angle)
    - Twd (True Wind Direction)
    - Tws (True Wind Speed)
    
    Both kph and kts versions are handled.
    
    Args:
        df: DataFrame with _bow and _mhu sensor channels
        apply_corrections: If True, replaces bad sensor data with good sensor data.
                          If False, only detects and logs issues without making changes.
        
    Returns:
        df: DataFrame with corrected sensor data (if apply_corrections=True) or unchanged (if False)
    """
    issues_detected = []
    corrections_made = []
    
    # Check if we have both bow and mhu Tws channels (check both kph and kts)
    tws_bow_kph = 'Tws_bow_kph' if 'Tws_bow_kph' in df.columns else None
    tws_mhu_kph = 'Tws_mhu_kph' if 'Tws_mhu_kph' in df.columns else None
    tws_bow_kts = 'Tws_bow_kts' if 'Tws_bow_kts' in df.columns else None
    tws_mhu_kts = 'Tws_mhu_kts' if 'Tws_mhu_kts' in df.columns else None
    
    # Use kph if available, otherwise kts
    tws_bow_col = tws_bow_kph or tws_bow_kts
    tws_mhu_col = tws_mhu_kph or tws_mhu_kts
    
    if not tws_bow_col or not tws_mhu_col:
        print("Sensor validation: Missing Tws_bow or Tws_mhu channels, skipping sensor validation", flush=True)
        return df
    
    # Get valid data points where both sensors have readings
    valid_mask = df[tws_bow_col].notna() & df[tws_mhu_col].notna() & (df[tws_bow_col] > 0) & (df[tws_mhu_col] > 0)
    
    if not valid_mask.any():
        print("Sensor validation: No overlapping valid data between bow and mhu sensors", flush=True)
        return df
    
    valid_bow = df.loc[valid_mask, tws_bow_col]
    valid_mhu = df.loc[valid_mask, tws_mhu_col]
    
    # Calculate statistics
    bow_median = valid_bow.median()
    mhu_median = valid_mhu.median()
    bow_std = valid_bow.std()
    mhu_std = valid_mhu.std()
    
    # OUTLIER DETECTION: Check for extreme values (very high or very low) that indicate sensor issues
    # Use IQR (Interquartile Range) method to detect outliers
    bow_q1 = valid_bow.quantile(0.25)
    bow_q3 = valid_bow.quantile(0.75)
    bow_iqr = bow_q3 - bow_q1
    bow_lower_bound = bow_q1 - 3.0 * bow_iqr  # 3x IQR for extreme outliers
    bow_upper_bound = bow_q3 + 3.0 * bow_iqr
    
    mhu_q1 = valid_mhu.quantile(0.25)
    mhu_q3 = valid_mhu.quantile(0.75)
    mhu_iqr = mhu_q3 - mhu_q1
    mhu_lower_bound = mhu_q1 - 3.0 * mhu_iqr
    mhu_upper_bound = mhu_q3 + 3.0 * mhu_iqr
    
    # Count outliers in each sensor
    bow_outliers = ((valid_bow < bow_lower_bound) | (valid_bow > bow_upper_bound)).sum()
    mhu_outliers = ((valid_mhu < mhu_lower_bound) | (valid_mhu > mhu_upper_bound)).sum()
    total_points = len(valid_bow)
    bow_outlier_pct = (bow_outliers / total_points * 100) if total_points > 0 else 0
    mhu_outlier_pct = (mhu_outliers / total_points * 100) if total_points > 0 else 0
    
    # Also check for extreme differences between sensors at each point
    # If one sensor is consistently much higher or lower than the other, it's likely bad
    diff_series = abs(valid_bow - valid_mhu)
    relative_diff_series = diff_series / np.maximum(valid_bow, valid_mhu)
    extreme_diff_mask = relative_diff_series > 0.50  # More than 50% difference
    extreme_diff_count = extreme_diff_mask.sum()
    extreme_diff_pct = (extreme_diff_count / total_points * 100) if total_points > 0 else 0
    
    # Check for extreme values (very high or very low) compared to reasonable ranges
    # Typical wind speeds: 5-40 kts (9-74 kph)
    reasonable_min = 5 if tws_bow_kts else 9
    reasonable_max = 40 if tws_bow_kts else 74
    
    bow_extreme_low = (valid_bow < reasonable_min * 0.3).sum()  # Less than 30% of minimum
    bow_extreme_high = (valid_bow > reasonable_max * 2.0).sum()  # More than 2x maximum
    mhu_extreme_low = (valid_mhu < reasonable_min * 0.3).sum()
    mhu_extreme_high = (valid_mhu > reasonable_max * 2.0).sum()
    
    bow_extreme_pct = ((bow_extreme_low + bow_extreme_high) / total_points * 100) if total_points > 0 else 0
    mhu_extreme_pct = ((mhu_extreme_low + mhu_extreme_high) / total_points * 100) if total_points > 0 else 0
    
    # Calculate relative difference
    if bow_median > 0 and mhu_median > 0:
        relative_diff = abs(bow_median - mhu_median) / max(bow_median, mhu_median)
    else:
        relative_diff = 0
    
    # Threshold for detecting significant issues (30% difference suggests a problem)
    significant_diff_threshold = 0.30
    outlier_threshold_pct = 5.0  # If more than 5% of values are outliers, likely a sensor issue
    extreme_value_threshold_pct = 2.0  # If more than 2% are extreme (very high/low), likely an issue
    
    # Also check if one is suspiciously low or high compared to reference (Tws_kph or Tws_kts)
    reference_col = 'Tws_kph' if 'Tws_kph' in df.columns else ('Tws_kts' if 'Tws_kts' in df.columns else None)
    
    # Determine if outlier detection indicates a problem
    outlier_issue_detected = False
    outlier_bad_sensor = None
    
    # Check outlier percentages
    if bow_outlier_pct > outlier_threshold_pct and mhu_outlier_pct <= outlier_threshold_pct:
        outlier_issue_detected = True
        outlier_bad_sensor = 'bow'
    elif mhu_outlier_pct > outlier_threshold_pct and bow_outlier_pct <= outlier_threshold_pct:
        outlier_issue_detected = True
        outlier_bad_sensor = 'mhu'
    
    # Check extreme value percentages
    if bow_extreme_pct > extreme_value_threshold_pct and mhu_extreme_pct <= extreme_value_threshold_pct:
        outlier_issue_detected = True
        outlier_bad_sensor = 'bow'
    elif mhu_extreme_pct > extreme_value_threshold_pct and bow_extreme_pct <= extreme_value_threshold_pct:
        outlier_issue_detected = True
        outlier_bad_sensor = 'mhu'
    
    # Check for high percentage of extreme differences
    if extreme_diff_pct > 10.0:  # More than 10% of points have >50% difference
        if not outlier_issue_detected:
            # If we have extreme differences but can't determine which is bad from outliers,
            # we'll use the median comparison below
            outlier_issue_detected = True
    
    # If no outlier issues and median difference is small, sensors are consistent
    if not outlier_issue_detected and relative_diff < significant_diff_threshold:
        print(f"Sensor validation: Correction needed = False", flush=True)
        u.log(api_token, "1_normalization_influx.py", "info", "sensor_validation", "Sensor validation: Correction needed = False")
        return df
    
    # Determine which sensor is "good" by comparing to reference or using statistical analysis
    bad_sensor = None
    good_sensor = None
    
    # If outlier detection identified a bad sensor, use that as a strong indicator
    if outlier_bad_sensor:
        bad_sensor = outlier_bad_sensor
        good_sensor = 'mhu' if outlier_bad_sensor == 'bow' else 'bow'
    
    # Use reference Tws to validate or determine which sensor is correct
    if reference_col and reference_col in df.columns:
        # Use reference Tws to determine which sensor is correct
        ref_valid = df[reference_col].notna() & (df[reference_col] > 0)
        if ref_valid.any():
            ref_median = df.loc[ref_valid, reference_col].median()
            bow_diff_from_ref = abs(bow_median - ref_median) / ref_median if ref_median > 0 else float('inf')
            mhu_diff_from_ref = abs(mhu_median - ref_median) / ref_median if ref_median > 0 else float('inf')
            
            # If outlier detection already identified a bad sensor, validate it
            if not outlier_bad_sensor:
                # No outlier detection result, use reference to determine
                if bow_diff_from_ref < mhu_diff_from_ref:
                    good_sensor = 'bow'
                    bad_sensor = 'mhu'
                else:
                    good_sensor = 'mhu'
                    bad_sensor = 'bow'
    
    # If no reference and outlier detection didn't identify a sensor, use statistical analysis
    if not good_sensor:
        # Check which one has more reasonable values (not too low, not too high)
        # Typical wind speeds: 5-40 kts (9-74 kph)
        reasonable_min = 5 if tws_bow_kts else 9
        reasonable_max = 40 if tws_bow_kts else 74
        
        bow_in_range = reasonable_min <= bow_median <= reasonable_max
        mhu_in_range = reasonable_min <= mhu_median <= reasonable_max
        
        # Consider outlier percentages in decision
        # If one has significantly more outliers, it's likely the bad sensor
        if bow_outlier_pct > mhu_outlier_pct * 2:  # Bow has 2x more outliers
            good_sensor = 'mhu'
            bad_sensor = 'bow'
        elif mhu_outlier_pct > bow_outlier_pct * 2:  # MHU has 2x more outliers
            good_sensor = 'bow'
            bad_sensor = 'mhu'
        elif bow_in_range and not mhu_in_range:
            good_sensor = 'bow'
            bad_sensor = 'mhu'
        elif mhu_in_range and not bow_in_range:
            good_sensor = 'mhu'
            bad_sensor = 'bow'
        else:
            # Both in range or both out of range - use lower std (more consistent) and fewer outliers
            # Combine std and outlier percentage for decision
            bow_score = bow_std + (bow_outlier_pct * 10)  # Weight outliers more heavily
            mhu_score = mhu_std + (mhu_outlier_pct * 10)
            
            if bow_score < mhu_score:
                good_sensor = 'bow'
                bad_sensor = 'mhu'
            else:
                good_sensor = 'mhu'
                bad_sensor = 'bow'
    
    # Identify all channels that would be replaced
    channel_types = ['Awa', 'Aws', 'Twa', 'Twd', 'Tws']
    units = ['_deg', '_kph', '_kts']
    
    replacements_detected = []
    corrections_applied = False
    
    for channel_type in channel_types:
        for unit in units:
            bad_col = f"{channel_type}_{bad_sensor}{unit}"
            good_col = f"{channel_type}_{good_sensor}{unit}"
            
            if bad_col in df.columns and good_col in df.columns:
                # Check how many values would be replaced
                replace_mask = df[bad_col].notna() & df[good_col].notna()
                if replace_mask.any():
                    num_to_replace = replace_mask.sum()
                    replacements_detected.append(f"{bad_col} <- {good_col} ({num_to_replace} values)")
                    
                    # Only apply correction if enabled
                    if apply_corrections:
                        df.loc[replace_mask, bad_col] = df.loc[replace_mask, good_col]
                        corrections_applied = True
    
    if replacements_detected:
        # Single message: Correction needed = True
        if corrections_applied:
            correction_msg = f"Correction applied: {bad_sensor} sensor replaced with {good_sensor} sensor data"
        else:
            correction_msg = f"Correction needed: {bad_sensor} sensor needs replacement with {good_sensor} sensor data (set apply_corrections=True to enable)"
        
        print(f"Sensor validation: Correction needed = True, Correction applied = {corrections_applied}", flush=True)
        u.log(api_token, "1_normalization_influx.py", "warning", "sensor_validation", 
              f"Sensor validation: Correction needed = True, Correction applied = {corrections_applied}. {correction_msg}")
    else:
        # No replacements needed
        print(f"Sensor validation: Correction needed = False", flush=True)
        u.log(api_token, "1_normalization_influx.py", "info", "sensor_validation", "Sensor validation: Correction needed = False")
    
    return df

def processRaces(df):
    # Initialize Race_number and Leg_number to -1 so we assign only from tracking in the race window
    df['Race_number'] = -1
    df['Leg_number'] = -1

    # Ensure TIME_RACE_s exists and is properly typed
    if 'TIME_RACE_s' in df.columns:
        df['TIME_RACE_s'] = df['TIME_RACE_s'].fillna(0).astype('float64')
    else:
        df['TIME_RACE_s'] = 0.0
        
    race_col_name = 'TRK_RACE_NUM_unk' if 'TRK_RACE_NUM_unk' in df.columns else None
    leg_col_name = 'TRK_LEG_NUM_unk' if 'TRK_LEG_NUM_unk' in df.columns else None
    
    # If not found, try to find them with different names
    if not race_col_name:
        for col in df.columns:
            if 'race' in col.lower() and 'num' in col.lower():
                race_col_name = col
                break
    
    if not leg_col_name:
        for col in df.columns:
            if 'leg' in col.lower() and 'num' in col.lower():
                leg_col_name = col
                break
    
    # If still not found, use defaults
    if not race_col_name or not leg_col_name:
        u.log(api_token, "1_normalization_influx.py", "warning", "processRaces", "Race/Leg tracking columns not found, using defaults")
        if 'Race_number' not in df.columns:
            df['Race_number'] = -1
        if 'Leg_number' not in df.columns:
            df['Leg_number'] = -1
        df['Race_number'] = df['Race_number'].fillna(-1).astype('int64')
        df['Leg_number'] = df['Leg_number'].fillna(-1).astype('int64')
        return df

    # Precompute float race/leg numbers for speed and consistency
    race_col = df[race_col_name].astype(float)
    leg_col  = df[leg_col_name].astype(float)

    # Boat race status: 2 = racing; race/leg assignment and race end use (status == 2 and leg > 0) to avoid spikes to 0
    status_col_name = 'TRK_BOAT_RACE_STATUS_unk' if 'TRK_BOAT_RACE_STATUS_unk' in df.columns else None
    status_col = df[status_col_name].astype(float) if status_col_name else None

    # Check required columns exist
    if 'Period' not in df.columns:
        u.log(api_token, "1_normalization_influx.py", "warning", "processRaces", "Period column not found, skipping race duration check")
        period_available = False
    else:
        period_available = True
    
    if 'ts' not in df.columns:
        u.log(api_token, "1_normalization_influx.py", "warning", "processRaces", "ts column not found, cannot process prestart windows or TIME_RACE_s validation")
        ts_available = False
    else:
        ts_available = True

    # Track valid race windows (for TIME_RACE_s validation later)
    valid_race_windows = []  # List of (start_ts, end_ts) tuples

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
        if period_available:
            if dfr['Period'].sum() <= 300:
                continue
        elif len(dfr) < 300:  # Fallback: use row count if Period unavailable
            continue

        # Require at least some leg data for this race
        leg_in_race = leg_col[race_mask]
        if leg_in_race.isna().all() or not (leg_in_race > 0).any():
            continue

        # Race start: when TRK_BOAT_RACE_STATUS_unk first goes > 1 (typically 2, can be 7). Fallback: TIME_RACE_s > 0 when status unavailable.
        race_with_time_mask = race_mask & (df['TIME_RACE_s'] > 0)
        status_gt1_mask = race_mask & (status_col > 1.0) if status_col is not None else None
        if status_col is not None:
            if not status_gt1_mask.any():
                continue
        else:
            if not race_with_time_mask.any():
                continue

        # Race start timestamp: first moment status > 1 (when available); else first TIME_RACE_s > 0
        if ts_available:
            if status_col is not None and status_gt1_mask.any():
                # Use first timestamp where TRK_BOAT_RACE_STATUS_unk > 1 as race start
                race_start_ts = df.loc[status_gt1_mask, 'ts'].min()
                prestart_window_start = race_start_ts - 120  # 2 minutes before race start
                if status_col is not None:
                    race_racing_mask = race_mask & (status_col == 2.0) & (leg_col > 0)
                    if race_racing_mask.any():
                        race_ts_max = df.loc[race_racing_mask, 'ts'].max()
                    else:
                        race_ts_max = df.loc[status_gt1_mask, 'ts'].max()
                else:
                    race_ts_max = df.loc[status_gt1_mask, 'ts'].max()
                valid_race_windows.append((prestart_window_start, race_ts_max))
                in_prestart = (df['ts'] >= prestart_window_start) & (df['ts'] < race_start_ts)
                in_race_time = (df['ts'] >= race_start_ts) & (df['ts'] <= race_ts_max)
                actually_racing = in_prestart | in_race_time
                window_mask = (
                    (race_col == float(race_number)) &
                    actually_racing &
                    ((df['Race_number'] == -1) | (df['Race_number'] == race_number))
                )
            else:
                # Fallback: no status or no status > 1 — use first TRK_LEG_NUM_unk == 1 or first TIME_RACE_s > 0
                leg_1_mask = race_mask & (leg_col == 1.0)
                if leg_1_mask.any():
                    race_start_ts = df.loc[leg_1_mask, 'ts'].min()
                    prestart_window_start = race_start_ts - 120
                    if status_col is not None:
                        race_racing_mask = race_mask & (status_col == 2.0) & (leg_col > 0)
                        if race_racing_mask.any():
                            race_ts_max = df.loc[race_racing_mask, 'ts'].max()
                        else:
                            race_ts_max = df.loc[race_with_time_mask, 'ts'].max()
                    else:
                        race_ts_max = df.loc[race_with_time_mask, 'ts'].max()
                    valid_race_windows.append((prestart_window_start, race_ts_max))
                    in_prestart = (df['ts'] >= prestart_window_start) & (df['ts'] < race_start_ts)
                    in_race_time = (df['TIME_RACE_s'] > 0) & (df['ts'] >= race_start_ts) & (df['ts'] <= race_ts_max)
                    actually_racing = in_prestart | in_race_time
                    window_mask = (
                        (race_col == float(race_number)) &
                        actually_racing &
                        ((df['Race_number'] == -1) | (df['Race_number'] == race_number))
                    )
                else:
                    race_ts_min = df.loc[race_with_time_mask, 'ts'].min()
                    race_start_ts = race_ts_min
                    prestart_window_start = race_ts_min - 120
                    if status_col is not None:
                        race_racing_mask = race_mask & (status_col == 2.0) & (leg_col > 0)
                        if race_racing_mask.any():
                            race_ts_max = df.loc[race_racing_mask, 'ts'].max()
                        else:
                            race_ts_max = df.loc[race_with_time_mask, 'ts'].max()
                    else:
                        race_ts_max = df.loc[race_with_time_mask, 'ts'].max()
                    valid_race_windows.append((prestart_window_start, race_ts_max))
                    in_race_time = (df['TIME_RACE_s'] > 0) & (df['ts'] >= race_ts_min) & (df['ts'] <= race_ts_max)
                    in_prestart = (df['ts'] >= prestart_window_start) & (df['ts'] < race_ts_min)
                    actually_racing = in_race_time | in_prestart
                    window_mask = (
                        (race_col == float(race_number)) &
                        actually_racing &
                        ((df['Race_number'] == -1) | (df['Race_number'] == race_number))
                    )
        else:
            # No ts: only assign where TIME_RACE_s > 0 for this race
            window_mask = (
                (race_col == float(race_number)) &
                race_with_time_mask &
                ((df['Race_number'] == -1) | (df['Race_number'] == race_number))
            )

        # Set Race_number and Leg_number from race start (status > 1). Leg_number = 1 when status > 1, stay 1 until TRK_LEG_NUM_unk > 1 then use tracker leg
        valid_leg_mask = window_mask
        if status_col is not None:
            valid_leg_mask = valid_leg_mask & (status_col > 1.0)
        df.loc[valid_leg_mask, 'Race_number'] = race_col.loc[valid_leg_mask].fillna(-1).astype('int64')
        # Leg_number: 1 from race start until tracker reports leg > 1; then use TRK_LEG_NUM_unk
        leg_values = leg_col.loc[valid_leg_mask]
        df.loc[valid_leg_mask, 'Leg_number'] = np.where(leg_values > 1, leg_values, 1).astype('int64')

        # Set Leg_number = 0 and Race_number for the 2 minutes prior to race start (prestart window); only when ts available
        if ts_available:
            prestart_assign_mask = (
                (race_col == float(race_number)) &
                (df['ts'] >= prestart_window_start) &
                (df['ts'] < race_start_ts)
            )
            df.loc[prestart_assign_mask, 'Race_number'] = race_number
            df.loc[prestart_assign_mask, 'Leg_number'] = 0

    # Forward-fill race/leg within each race so that rows after the window (or during status spikes)
    # keep the last assigned value instead of staying -1 when status is still 2
    df = df.sort_values('ts').reset_index(drop=True)
    race_group_col = '__race_group_key__'
    if race_col_name in df.columns:
        df[race_group_col] = pd.to_numeric(df[race_col_name], errors='coerce').fillna(-1.0)
    else:
        df[race_group_col] = -1.0
    df['Race_number'] = (
        df.groupby(race_group_col, group_keys=False)['Race_number']
        .apply(lambda x: x.replace(-1, np.nan).ffill().fillna(-1).astype('int64'))
    )
    df['Leg_number'] = (
        df.groupby(race_group_col, group_keys=False)['Leg_number']
        .apply(lambda x: x.replace(-1, np.nan).ffill().fillna(-1).astype('int64'))
    )
    df.drop(columns=[race_group_col], inplace=True)

    # Only set Race_number and Leg_number to -1 when outside a valid race window AND status != 2.
    # When status is still 2 we keep the last race/leg (so we don't zero out while boat status = 2).
    if ts_available and len(valid_race_windows) > 0:
        ts_values = df['ts'].values
        within_any_window = np.zeros(len(ts_values), dtype=bool)
        for window_start, window_end in valid_race_windows:
            within_any_window |= (ts_values >= window_start) & (ts_values <= window_end)
        outside_all_windows = ~within_any_window
        if status_col_name is not None and status_col_name in df.columns:
            status_after_sort = pd.to_numeric(df[status_col_name], errors='coerce')
            clear_mask = outside_all_windows & (status_after_sort != 2.0).to_numpy()
        else:
            clear_mask = outside_all_windows
        if clear_mask.any():
            df.loc[clear_mask, 'Race_number'] = -1
            df.loc[clear_mask, 'Leg_number'] = -1

    # Enforce invariant: Race_number > -1 only when Leg_number > -1
    df.loc[df['Leg_number'] == -1, 'Race_number'] = -1
    # Normalize invalid Race_number to -1 (NaN, null, or < 0)
    invalid_race = df['Race_number'].isna() | (df['Race_number'] < 0)
    df.loc[invalid_race, 'Race_number'] = -1
    df['Race_number'] = df['Race_number'].fillna(-1).astype('int64')
    df['Leg_number'] = df['Leg_number'].fillna(-1).astype('int64')

    return df

if __name__ == "__main__":
    try:
        # Print immediately to ensure output is captured
        print("=" * 80, flush=True)
        print("1_normalization_influx.py STARTED", flush=True)
        print("=" * 80, flush=True)
        
        # Validate that we have the required command line argument
        if len(sys.argv) < 2:
            error_msg = "ERROR: Missing required parameters argument"
            print(error_msg, flush=True)
            u.log(api_token, "1_normalization_influx.py", "error", "normalizing data", error_msg)
            sys.exit(1)
        
        parameters_str = sys.argv[1]
        print(f"Received parameters string (length: {len(parameters_str)})", flush=True)
        
        try:
            parameters_json = json.loads(parameters_str)
        except json.JSONDecodeError as json_error:
            error_msg = f"ERROR: Failed to parse parameters JSON: {str(json_error)}"
            print(error_msg, flush=True)
            print(f"Parameters string: {parameters_str[:200]}...", flush=True)  # Print first 200 chars for debugging
            u.log(api_token, "1_normalization_influx.py", "error", "normalizing data", error_msg)
            sys.exit(1)
        
        #LOG
        u.log(api_token, "1_normalization_influx.py", "info", "parameters", parameters_str)
        print("Parameters parsed successfully", flush=True)

        class_name = parameters_json.get('class_name')
        project_id = parameters_json.get('project_id')
        date = parameters_json.get('date')
        source_name = parameters_json.get('source_name')
        start_time = parameters_json.get('start_time')
        end_time = parameters_json.get('end_time')
        # Timezone for interpreting date as local when start_time/end_time are not provided (e.g. from script execution page).
        timezone_str = parameters_json.get('timezone') or 'Europe/Madrid'
        batch = parameters_json.get('batch', False)

        # class_name = 'gp50'
        # project_id = 1
        # date = '20260213'
        # source_name = 'GER'
        # start_time = None
        # end_time = None
        # batch = False

        apply_wand_correction = True
        overwrite_existing = True

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
        
        if missing_params:
            error_msg = f"ERROR: Missing required parameters: {', '.join(missing_params)}"
            print(error_msg, flush=True)
            print(f"Received parameters: class_name={class_name}, project_id={project_id}, date={date}, source_name={source_name}", flush=True)
            u.log(api_token, "1_normalization_influx.py", "error", "normalizing data", error_msg)
            sys.exit(1)
        
        print(f"✓ All required parameters present", flush=True)
        print(f"Processing: class_name={class_name}, project_id={project_id}, date={date}, source_name={source_name}, timezone={timezone_str}", flush=True)
        if not start_time and not end_time:
            print(f"Date will be interpreted as local date in timezone {timezone_str}; Influx query range will be converted to UTC.", flush=True)
        
        # Convert start_time and end_time to timestamps if provided
        # Ensure date is in YYYYMMDD format (remove dashes/slashes)
        date_original = date
        date = date.replace('-', '').replace('/', '')
        
        # Validate date format
        if len(date) != 8 or not date.isdigit():
            error_msg = f"ERROR: Invalid date format after sanitization. Original: {date_original}, Sanitized: {date}. Expected YYYYMMDD format."
            print(error_msg, flush=True)
            u.log(api_token, "1_normalization_influx.py", "error", "normalizing data", error_msg)
            sys.exit(1)
        
        start_ts = None
        end_ts = None
        if start_time:
            start_ts = u.get_timestamp_from_str(start_time)
        if end_time:
            end_ts = u.get_timestamp_from_str(end_time)
        # When no explicit start/end: date is the dataset's local date (timezone passed from caller).
        # Convert local day 00:00:00–23:59:59 to UTC so Influx download uses the correct time range.
        if start_ts is None and end_ts is None and timezone_str:
            tz_info = gettz(timezone_str)
            if tz_info is None:
                tz_info = gettz('Europe/Madrid')
            date_ymd = f"{date[0:4]}-{date[4:6]}-{date[6:8]}"
            local_start = datetime.strptime(f"{date_ymd} 00:00:00", "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz_info)
            local_end = datetime.strptime(f"{date_ymd} 23:59:59", "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz_info)
            start_ts = local_start.astimezone(dateutil_tz.tzutc()).timestamp()
            end_ts = local_end.astimezone(dateutil_tz.tzutc()).timestamp()
            print(f"Date is local in {timezone_str}; time range converted to UTC for Influx: {date_ymd} -> UTC {start_ts} to {end_ts}", flush=True)

        print("Starting normalization from InfluxDB...", flush=True)
        u.log(api_token, "1_normalization_influx.py", "info", "normalizing data", f"Starting normalization from InfluxDB for date: {date}, source: {source_name}")
        
        # Get required channels
        channels = get_required_channels()
        print(f"Downloading {len(channels)} channels from InfluxDB...", flush=True)
        print(f"Date format check: date={date}, type={type(date)}, len={len(date)}", flush=True)
        print(f"Source name: {source_name}", flush=True)
        print(f"Channels count: {len(channels)}", flush=True)
        print(f"Resampling: 100ms", flush=True)

        # Download data from InfluxDB
        # Function signature: get_channel_values_influx(date, source_name, channel_list, rs='1s', start_ts=None, end_ts=None, timezone=None, level='strm')
        # Use keyword arguments to ensure correct parameter mapping
        try:
            df = u.get_channel_values_influx(
                date=date,
                source_name=source_name,
                channel_list=channels,
                rs='100ms',
                start_ts=start_ts,
                end_ts=end_ts,
                timezone=timezone_str,
                level='strm',
                skipMissing=False
            )
        except Exception as download_error:
            error_msg = f"Error downloading data from InfluxDB: {str(download_error)}"
            print(error_msg, flush=True)
            import traceback
            print(f"Traceback: {traceback.format_exc()}", flush=True)
            u.log(api_token, "1_normalization_influx.py", "error", "normalizing data", error_msg)
            sys.exit(1)
        
        if df is not None and len(df) > 0:
            print(f"{len(df)} rows found!", flush=True)
            print("Data downloaded successfully, starting processing...", flush=True)
            
            # Get mappings from InfluxDB names to normalized names
            angle_map, regular_map, special_map = get_influx_to_normalized_mapping()
            
            # Rename columns from InfluxDB names to normalized names
            print("Mapping InfluxDB column names to normalized names...", flush=True)
            rename_dict = {}
            
            # Map special columns
            for norm_name, influx_name in special_map.items():
                if influx_name in df.columns:
                    rename_dict[influx_name] = norm_name
            
            # Map angle columns (from angle_map)
            for norm_name, (influx_name, _) in angle_map.items():
                if influx_name in df.columns:
                    rename_dict[influx_name] = norm_name
            
            # Map regular columns
            for norm_name, influx_name in regular_map.items():
                if influx_name in df.columns:
                    rename_dict[influx_name] = norm_name
            
            # Apply renaming
            df.rename(columns=rename_dict, inplace=True)
            print(f"Renamed {len(rename_dict)} columns from InfluxDB to normalized names", flush=True)
            
            # Validate which required normalized channels are present
            all_normalized_names = set(angle_map.keys()) | set(regular_map.keys()) | set(special_map.keys())
            present_channels = set(df.columns)
            missing_channels = all_normalized_names - present_channels
            
            if missing_channels:
                missing_list = sorted(list(missing_channels))
                # Log all missing channels as error (not truncated)
                missing_channels_str = ', '.join(missing_list)
                error_msg = f"WARNING: Missing {len(missing_channels)} required normalized channels from InfluxDB data: {missing_channels_str}"
                print(error_msg, flush=True)
                u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", error_msg)
                
                # Also log which InfluxDB channel names were expected but not found
                # Build a map of normalized name -> InfluxDB name for missing channels
                missing_influx_names = []
                for norm_name in missing_list:
                    # Check in special_map
                    if norm_name in special_map:
                        missing_influx_names.append(f"{norm_name} (InfluxDB: {special_map[norm_name]})")
                    # Check in angle_map
                    elif norm_name in angle_map:
                        missing_influx_names.append(f"{norm_name} (InfluxDB: {angle_map[norm_name][0]})")
                    # Check in regular_map
                    elif norm_name in regular_map:
                        missing_influx_names.append(f"{norm_name} (InfluxDB: {regular_map[norm_name]})")
                    else:
                        missing_influx_names.append(norm_name)
                
                missing_influx_str = ', '.join(missing_influx_names)
                influx_error_msg = f"WARNING: Missing InfluxDB channels mapped to normalized names: {missing_influx_str}"
                print(influx_error_msg, flush=True)
                u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", influx_error_msg)
            
            # Ensure Datetime and ts columns exist (after renaming, DATETIME should be renamed to Datetime)
            if 'Datetime' not in df.columns:
                # Check if DATETIME exists (not yet renamed)
                if 'DATETIME' in df.columns:
                    df.rename(columns={'DATETIME': 'Datetime'}, inplace=True)
                elif 'ts' in df.columns:
                    df['Datetime'] = pd.to_datetime(df['ts'], unit='s', utc=True)
                else:
                    u.log(api_token, "1_normalization_influx.py", "error", "normalizing data", "Neither Datetime nor ts column found in downloaded data")
                    print("ERROR: Neither Datetime nor ts column found in downloaded data", flush=True)
                    sys.exit(1)
            
            if 'ts' not in df.columns:
                if 'Datetime' in df.columns:
                    df['ts'] = (pd.to_datetime(df['Datetime']).astype('int64') / 10**9).astype('float64').round(3)
                else:
                    u.log(api_token, "1_normalization_influx.py", "error", "normalizing data", "Neither Datetime nor ts column found in downloaded data")
                    print("ERROR: Neither Datetime nor ts column found in downloaded data", flush=True)
                    sys.exit(1)
            
            # Ensure ts is float64 and properly rounded
            if df['ts'].dtype == 'Float64':
                df['ts'] = df['ts'].astype('float64')
            df['ts'] = df['ts'].round(3)
            
            # Calculate Period from ts
            df['Period'] = df['ts'].diff()

            print("Filtering data...", flush=True)
            # ISOLATE SAILING DATA
            # Use normalized channel names (columns should already be renamed)
            # Need to check for InfluxDB names before renaming, or use normalized names after renaming
            # Since we rename early, use normalized names
            bsp_col = 'Bsp_kph' if 'Bsp_kph' in df.columns else ('Bsp_kts' if 'Bsp_kts' in df.columns else None)
            ca1_col = 'CA1_ang_deg' if 'CA1_ang_deg' in df.columns else None
            time_race_col = 'TIME_RACE_s' if 'TIME_RACE_s' in df.columns else None
            
            if bsp_col and ca1_col:
                min_mask = (df[bsp_col] > 10) & (df[ca1_col].abs() > 5)
                if time_race_col:
                    max_mask = (df[bsp_col] > 20) & (df[ca1_col].abs() > 5) | (df[time_race_col] > 0)
                else:
                    max_mask = (df[bsp_col] > 20) & (df[ca1_col].abs() > 5)
                
                if min_mask.any() and max_mask.any():
                    min_ts = df.loc[min_mask, "ts"].min() - 60
                    max_ts = df.loc[max_mask, "ts"].max() + 60
                    range_mask = (df["ts"] >= min_ts) & (df["ts"] <= max_ts)
                    df = df.loc[range_mask].copy()
                else:
                    u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", "No data matches filtering criteria, using all data")
                    print("Warning: No data matches filtering criteria, using all data", flush=True)
            else:
                u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", f"Missing required columns for filtering (Bsp: {bsp_col}, CA1: {ca1_col}), using all data")
                print("Warning: Missing required columns for filtering, using all data", flush=True)

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
            # Use angle_map to get the mappings (now columns are already renamed to normalized names)
            angle_map, regular_map, special_map = get_influx_to_normalized_mapping()
            
            # Build col_map for angle smoothing: normalized_name -> (normalized_name, angle_range)
            # Since we already renamed, input and output are the same
            col_map = {}
            for norm_name, (influx_name, angle_range) in angle_map.items():
                if norm_name in df.columns:
                    col_map[norm_name] = (norm_name, angle_range)

            print(f"Processing lat / lng glitches...", flush=True)

            # Lat_dd and Lng_dd should already be renamed from LATITUDE_GPS_unk and LONGITUDE_GPS_unk
            if 'Lat_dd' in df.columns and 'Lng_dd' in df.columns:
                # Convert from GPS format (divide by 10^7) to decimal degrees
                df['Lat_dd'] = pd.to_numeric(df['Lat_dd'], errors='coerce') / 10**7
                df['Lng_dd'] = pd.to_numeric(df['Lng_dd'], errors='coerce') / 10**7
                df = u.rolling_median_latlon_filter(df, lat_col='Lat_dd', lon_col='Lng_dd', window=11, deviation_threshold=0.0003, smoothing_window=smoothing_window, drop_intermediates=True)
            else:
                u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", "Lat_dd or Lng_dd not found, skipping lat/lng filtering")

            print(f"Processing {len(col_map)} angle columns...", flush=True)

            for output_col, (input_col, angle_range) in col_map.items():
                try:
                    df = u.rolling_mean_and_shift_angle(df, input_col=input_col, output_col=output_col, smoothing_window=smoothing_window, offset_window=offset_window, angle_range=angle_range)
                except Exception as e:
                    df[output_col] = np.nan
                    # print(f"Error in rolling_mean_and_shift_angle: {e}", flush=True)
                    u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", "rolling_mean_and_shift_angle error: " + str(e))
                    continue
                
            # Store original Pitch_deg if it exists before smoothing (rename PITCH_deg to PITCH_deg_ori first)
            if 'Pitch_deg' in df.columns:
                df.rename(columns={'Pitch_deg': 'PITCH_deg_ori'}, inplace=True)
            
            # Build col_map for regular channel smoothing using regular_map
            # Since columns are already renamed to normalized names, input and output are the same
            angle_map, regular_map, special_map = get_influx_to_normalized_mapping()
            col_map = {}
            for norm_name, influx_name in regular_map.items():
                if norm_name in df.columns:
                    col_map[norm_name] = norm_name  # Input and output are the same after renaming

            print(f"Processing {len(col_map)} regular columns...", flush=True)
            for output_col, input_col in col_map.items():
                try:
                    # Input and output are the same after renaming, but we still apply smoothing
                    df = u.rolling_mean_and_shift(df, input_col=input_col, output_col=output_col, smoothing_window=smoothing_window, offset_window=offset_window)
                except Exception as e:
                    # If smoothing fails, keep original values
                    u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", f"rolling_mean_and_shift error for {input_col}: {str(e)}")
                    continue
            
            # Rename PITCH_deg_ori back to Pitch_deg after smoothing
            if 'PITCH_deg_ori' in df.columns:
                df.rename(columns={'PITCH_deg_ori': 'Pitch_deg'}, inplace=True)

            # NEW CHANNELS / UNITS CONVERSIONS
            print("New Channels and units conversions...", flush=True)

            # Course_axis_deg should already be renamed from TRK_COURSE_AXIS_deg
            # If not present, it's okay - it's optional

            df['Race_number'] = -1
            df['Leg_number'] = -1

            try:
                df = processRaces(df)
            except Exception as e:
                u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", f"Error in processRaces: {str(e)}")
                # Continue with default race/leg numbers

            # RAW ACCELERATION (if Bsp_kts exists)
            df['Bsp_kts'] = df['Bsp_kph'] * 0.539957
            if 'Bsp_kts' in df.columns:
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

            # Calculate delta channels if source channels exist
            if 'Tws_mhu_kph' in df.columns and 'Tws_bow_kph' in df.columns:
                df['Tws_delta_kph'] = (df['Tws_mhu_kph'] - df['Tws_bow_kph']) 
                df['Tws_delta_kts'] = df['Tws_delta_kph'] * 0.539957
            if 'Twa_mhu_deg' in df.columns and 'Twa_bow_deg' in df.columns:
                df['Twa_delta_deg'] = df['Twa_mhu_deg'] - df['Twa_bow_deg']

            df = df.copy()
            
            # Convert kph to kts if source channels exist
            if 'Tws_kph' in df.columns:
                df['Tws_kts'] = df['Tws_kph'] * 0.539957
            if 'Tws_tm_kph' in df.columns:
                df['Tws_tm_kts'] = df['Tws_tm_kph'] * 0.539957
            if 'Tws_bow_kph' in df.columns:
                df['Tws_bow_kts'] = df['Tws_bow_kph'] * 0.539957
            if 'Tws_mhu_kph' in df.columns:
                df['Tws_mhu_kts'] = df['Tws_mhu_kph'] * 0.539957

            df = df.copy()
            
            # Detect and correct bow/mhu sensor issues by comparing Tws values
            # Set apply_corrections=True to replace all measurements from the bad sensor with the good sensor's data
            # Set apply_corrections=False (default) to only detect and log issues without making changes
            df = detect_and_correct_bow_mhu_sensor_issues(df, apply_wand_correction)

            if 'Aws_kph' in df.columns:
                df['Aws_kts'] = df['Aws_kph'] * 0.539957
            if 'Sog_kph' in df.columns:
                df['Sog_kts'] = df['Sog_kph'] * 0.539957
            if 'Bsp_tgt_kph' in df.columns:
                df['Bsp_tgt_kph'] = abs(df['Bsp_tgt_kph'])
                df['Bsp_tgt_kts'] = abs(df['Bsp_tgt_kph'] * 0.539957)
            if 'Vmg_tgt_kph' in df.columns:
                df['Vmg_tgt_kph'] = abs(df['Vmg_tgt_kph'])
                df['Vmg_tgt_kts'] = abs(df['Vmg_tgt_kph'] * 0.539957)

            df = df.copy()

            if 'Twd_deg' in df.columns:
                # Course Wind Angle = True Wind Direction - Course over ground
                # CWA is the angle from the boat's course (COG) to the wind direction (TWD)
                # Formula: CWA = TWD - COG (matches corrections: CWA = TWD - CSE)
                # On starboard tack with positive leeway (drifting to port):
                #   COG < HDG (course is to left of heading)
                #   TWA = TWD - HDG,  CWA = TWD - COG
                #   Since COG < HDG, we have CWA = TWD - COG > TWD - HDG = TWA
                #   Therefore: CWA_n > TWA_n when Lwy_n > 0 (expected relationship)
                # If TWA_n > CWA_n is observed, check COG values or sign convention
                df['Cwa_deg'] = df.apply(lambda row: u.angle_subtract(row['Twd_deg'], row['Cog_deg']), axis=1)
            
            # Calculate VMG if required channels exist
            if 'Bsp_kts' in df.columns and 'Cwa_deg' in df.columns:
                df['Vmg_kts'] = abs(df['Bsp_kts'] * np.cos(np.radians(df['Cwa_deg'])))
            if 'Bsp_kph' in df.columns and 'Cwa_deg' in df.columns:
                df['Vmg_kph'] = abs(df['Bsp_kph'] * np.cos(np.radians(df['Cwa_deg'])))

            # Defragment DataFrame after many column additions to improve performance
            df = df.copy()

            # NORMALIZE CHANNELS (absolute values)
            if 'Awa_deg' in df.columns:
                df['Awa_n_deg'] = abs(df['Awa_deg'])
            if 'Twa_deg' in df.columns:
                df['Twa_n_deg'] = abs(df['Twa_deg'])
            if 'Cwa_deg' in df.columns:
                df['Cwa_n_deg'] = abs(df['Cwa_deg'])
            if 'Twa_bow_deg' in df.columns:
                df['Twa_bow_n_deg'] = abs(df['Twa_bow_deg'])
            if 'Twa_mhu_deg' in df.columns:
                df['Twa_mhu_n_deg'] = abs(df['Twa_mhu_deg'])
            if 'Twa_avg_deg' in df.columns:
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
                u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", f"Error computing performance percentages: {str(e)}")
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
            df['WING_clew_pos_n_mm'] = df['WING_clew_pos_mm'] * tack_sign

            df['Heel_deg'] = df['Heel_deg'] * -1
            df['Heel_n_deg'] = df['Heel_deg'] * tack_sign
            df['RUD_ang_n_deg'] = df['RUD_ang_deg'] * tack_sign

            df['Lwy2_deg'] = df.apply(lambda row: u.angle_subtract(row['Hdg_deg'], row['Cog_deg']), axis=1)
            df['Lwy2_deg'] = np.where((df['Bsp_kph'] < 5) | (df['Lwy2_deg'] > 50), 1, df['Lwy2_deg'])
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

            # DERIVE WWD / LWD CHANNELS (only if source channels exist)
            if 'DB_imm_port_mm' in df.columns and 'DB_imm_stbd_mm' in df.columns:
                df['DB_imm_lwd_mm'] = np.where(tack_sign > 0, df['DB_imm_port_mm'], df['DB_imm_stbd_mm'])
                df['DB_imm_wwd_mm'] = np.where(tack_sign > 0, df['DB_imm_stbd_mm'], df['DB_imm_port_mm'])
            else:
                # Create empty columns if source channels are missing
                df['DB_imm_lwd_mm'] = 0.0
                df['DB_imm_wwd_mm'] = 0.0
            
            if 'DB_piercing_port_mm' in df.columns and 'DB_piercing_stbd_mm' in df.columns:
                df['DB_piercing_lwd_mm'] = np.where(tack_sign > 0, df['DB_piercing_port_mm'], df['DB_piercing_stbd_mm'])
                df['DB_piercing_wwd_mm'] = np.where(tack_sign > 0, df['DB_piercing_stbd_mm'], df['DB_piercing_port_mm'])
            else:
                df['DB_piercing_lwd_mm'] = 0.0
                df['DB_piercing_wwd_mm'] = 0.0
            
            if 'RUD_imm_port_mm' in df.columns and 'RUD_imm_stbd_mm' in df.columns:
                df['RUD_imm_lwd_mm'] = np.where(tack_sign > 0, df['RUD_imm_port_mm'], df['RUD_imm_stbd_mm'])
                df['RUD_imm_wwd_mm'] = np.where(tack_sign > 0, df['RUD_imm_stbd_mm'], df['RUD_imm_port_mm'])
                df['RUD_imm_tot_mm'] = df['RUD_imm_lwd_mm'] + df['RUD_imm_wwd_mm']
            else:
                df['RUD_imm_lwd_mm'] = 0.0
                df['RUD_imm_wwd_mm'] = 0.0
                df['RUD_imm_tot_mm'] = 0.0

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
                u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", f"Error preparing dataframe: {str(e)}")
                # Continue - try to save what we have

            print("Computing VMC...", flush=True)
            try:
                df = df.copy()

                df = u.computeVMC(df)

                # VMC is computed in computeVMC, now convert to kph if needed
                if 'Vmc_kts' in df.columns:
                    df['Vmc_kph'] = df['Vmc_kts'] * 1.852
            except Exception as e:
                u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", f"Error computing VMC: {str(e)}")
                # Continue without VMC if computation fails

            print("Wrapping up...", flush=True)
            
            # Sort by Datetime to ensure chronological order before saving
            df = df.sort_values(by='Datetime').reset_index(drop=True)

            # Get data directory from environment variable
            data_dir = os.getenv('DATA_DIRECTORY', 'C:/MyApps/Hunico/Uploads/Data')
            
            # Normalize class_name to lowercase for consistent directory structure
            class_lower = class_name.lower() if class_name else ''
            
            # Convert date from YYYYMMDD (used for directory) to YYYY-MM-DD format (used in filename)
            # date is the dataset's local date (in dataset timezone); same value must be used when creating the dataset record and when calling file/channel APIs so folder path matches.
            if len(date) == 8 and date.isdigit():
                date_formatted = f"{date[0:4]}-{date[4:6]}-{date[6:8]}"
            else:
                # If already in YYYY-MM-DD format, use as-is (remove any slashes)
                date_formatted = date.replace('/', '-')
            
            # Ensure directory exists (folder name uses local date YYYYMMDD)
            output_dir = os.path.join(data_dir, 'System', str(project_id), class_lower, date, source_name)
            os.makedirs(output_dir, exist_ok=True)
            
            # Clear destination folder contents if overwrite_existing is True
            if overwrite_existing:
                print(f"Clearing contents of destination folder: {output_dir}", flush=True)
                u.log(api_token, "1_normalization_influx.py", "info", "normalizing data", f"Clearing destination folder contents (overwrite_existing=True): {output_dir}")
                try:
                    # Count files before removing
                    files_to_remove = [f for f in os.listdir(output_dir) if os.path.isfile(os.path.join(output_dir, f))]
                    num_files = len(files_to_remove)
                    
                    # Remove all files in the directory
                    for filename in files_to_remove:
                        file_path = os.path.join(output_dir, filename)
                        os.remove(file_path)
                        print(f"Removed existing file: {filename}", flush=True)
                    
                    if num_files > 0:
                        print(f"✓ Cleared {num_files} file(s) from destination folder", flush=True)
                    else:
                        print(f"✓ Destination folder was already empty", flush=True)
                except Exception as clear_error:
                    error_msg = f"Warning: Failed to clear destination folder: {str(clear_error)}"
                    print(error_msg, flush=True)
                    u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", error_msg)
                    # Continue anyway - we'll overwrite files individually below
            
            print("Saving files split into 1-hour chunks...", flush=True)
            u.log(api_token, "1_normalization_influx.py", "info", "normalizing data", "saving normalized data to parquet in 1-hour chunks...")

            try:
                # Ensure Datetime is datetime type for grouping
                if 'Datetime' in df.columns:
                    df['Datetime'] = pd.to_datetime(df['Datetime'])
                elif 'ts' in df.columns:
                    df['Datetime'] = pd.to_datetime(df['ts'], unit='s', utc=True)
                
                # Group by hour (floor to hour boundary)
                df['Hour'] = df['Datetime'].dt.floor('h')
                
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
                    
                    # Filename pattern: log_{source_name}_{date}_10Hz_{HHMM}-{HHMM}_norm.parquet
                    filename_no_ext = f"log_{source_name}_{date_formatted}_10Hz_{hour_str}-{hour_end_str}"
                    file_path = os.path.join(output_dir, filename_no_ext+'_norm.parquet')
                    
                    # Remove existing file if it exists
                    if os.path.exists(file_path):
                        os.remove(file_path)
                    
                    # Save this hour's data
                    df_hour.to_parquet(file_path, engine='pyarrow', index=False)
                    files_saved += 1
                    print(f"Saved hour chunk {hour_start.strftime('%H:%M')} to {hour_end.strftime('%H:%M')}: {file_path} ({len(df_hour)} rows)", flush=True)
                
                print(f"✓ Saved {files_saved} parquet file(s) in JavaScript-compatible format!", flush=True)
                u.log(api_token, "1_normalization_influx.py", "info", "normalizing data", f"success! Saved {files_saved} file(s) split by hour")
                print("Script Completed:", u.dt.now(), flush=True)
                sys.exit(0)  # Exit with success code to signal completion to the server
            except Exception as save_error:
                error_msg = f"Failed to save parquet file(s): {str(save_error)}"
                print(error_msg, flush=True)
                import traceback
                print(f"Traceback: {traceback.format_exc()}", flush=True)
                u.log(api_token, "1_normalization_influx.py", "error", "normalizing data", error_msg)
                # Only exit with error code if file save fails - this is a critical failure
                sys.exit(1)  # Exit with error code to signal failure to the server
        else:
            # No data found for this source - skip silently
            warning_msg = f"No data found for source {source_name} on date {date}, skipping..."
            u.log(api_token, "1_normalization_influx.py", "warning", "normalizing data", warning_msg)
            print(warning_msg, flush=True)
            sys.exit(0)  # Exit with success code to allow other sources to continue
    except Exception as error:
        import traceback
        error_traceback = traceback.format_exc()
        error_msg = f"Script exception error: {str(error)}"
        print("=" * 80, flush=True)
        print("ERROR: Script exception occurred", flush=True)
        print("=" * 80, flush=True)
        print(error_msg, flush=True)
        print("Full traceback:", flush=True)
        print(error_traceback, flush=True)
        print("=" * 80, flush=True)
        u.log(api_token, "1_normalization_influx.py", "error", "normalizing data", error_msg)
        u.log(api_token, "1_normalization_influx.py", "error", "normalizing data", f"Traceback: {error_traceback}")
        sys.exit(1)  # Exit with error code to signal failure to the server