import pandas as pd
import numpy as np
import statsmodels.api as sm
import math as m
from typing import Tuple, Dict, Any

# Import only the math functions we need to avoid circular imports
try:
    from .math_utils import (
        angle_subtract, angle360_normalize, angle_between, angle_add,
        mean360, number, integer, mps
    )
    from .geo_utils import range_from_latlng, bearing_from_latlng
    from .logging_utils import log_error
except ImportError:
    # Fallback for when running as script or in certain environments
    from math_utils import (
        angle_subtract, angle360_normalize, angle_between, angle_add,
        mean360, number, integer, mps
    )
    from geo_utils import range_from_latlng, bearing_from_latlng
    from logging_utils import log_error

def PrepareTimeReference(df: pd.DataFrame) -> pd.DataFrame:
    """
    Prepare time reference columns for sailing data analysis.
    
    Converts datetime to Unix timestamp and calculates time periods between records.
    
    Args:
        df (pd.DataFrame): DataFrame containing 'Datetime' column
        
    Returns:
        pd.DataFrame: DataFrame with added 'ts' (timestamp) and 'Period' columns
    """
    try:
        # Handle timezone-aware and timezone-naive datetimes
        if df['Datetime'].dt.tz is None:
            # Timezone-naive: localize to UTC first
            df['ts'] = (df['Datetime'].dt.tz_localize('UTC').astype('int64') / 10**9).round(3)
        else:
            # Timezone-aware: convert to UTC
            df['ts'] = (df['Datetime'].dt.tz_convert('UTC').astype('int64') / 10**9).round(3)
        df['Period'] = df['ts'].diff().fillna(0) 
    except Exception as e:
        log_error("Error in PrepareTimeReference", e)

    return df

def IdentifyEntryExit(df: pd.DataFrame, start: float = -10, end: float = 10) -> Tuple[float, float]:
    """
    Identify entry and exit points of a sailing maneuver using angular rate analysis.
    
    Uses LOWESS smoothing to find where angular rate drops below threshold,
    indicating the start and end of a maneuver.
    
    Args:
        df (pd.DataFrame): DataFrame with 'sec' and 'Yaw_rate_dps' columns
        start (float): Start time boundary in seconds (default: -10)
        end (float): End time boundary in seconds (default: 10)
        
    Returns:
        tuple: (start_bound, end_bound) - Times when maneuver entry/exit occurs
    """
    try:
        if len(df) > 0:
            x_col = 'sec'
            y_col = 'Yaw_rate_dps'

            start_bound = 0.0
            end_bound = 0.0
            frac=0.03
        
            bounds = df[(df[x_col] > start) & (df[x_col] < end)].copy()
            abs_min = abs(bounds[y_col].min())
            abs_max = bounds[y_col].max()

            if abs_min > abs_max:
                bounds[y_col] *= -1

            peak_index = bounds[y_col].idxmax()
            peak_x = bounds.loc[peak_index, x_col]

            lowess = sm.nonparametric.lowess
            smoothed = lowess(bounds[y_col], bounds[x_col], frac=frac)
            smoothed_df = pd.DataFrame(smoothed, columns=[x_col, 'smoothed_y'])

            try:
                start_bound_f = smoothed_df[(smoothed_df[x_col] > start) & (smoothed_df[x_col] <= peak_x)]
                start_bound = start_bound_f[np.abs(start_bound_f['smoothed_y']) < 0.1].iloc[-1][x_col]
            except (IndexError, KeyError, ValueError):
                start_bound = start

            try:
                end_bound_f = smoothed_df[(smoothed_df[x_col] < end) & (smoothed_df[x_col] >= peak_x)]
                end_bound = end_bound_f[np.abs(end_bound_f['smoothed_y']) < 0.1].iloc[0][x_col]
            except (IndexError, KeyError, ValueError):
                end_bound = end
        else:
            start_bound = 0
            end_bound = 0
    except Exception as e:
        log_error("Error in IdentifyEntryExit", e)
        start_bound = start
        end_bound = end

    return round(start_bound,2), round(end_bound,2)

def getMostLikelyValue(df, column_name, start_ts, end_ts, default=0):
    """
    Get the most likely value within a time range.
    For numeric values, returns the median (most robust to outliers).
    For categorical/string values, returns the mode (most frequent).
    
    Args:
        df: DataFrame with 'ts' column
        column_name: Name of the column to get value from
        start_ts: Start timestamp (inclusive)
        end_ts: End timestamp (inclusive)
        default: Default value if no data found
        
    Returns:
        Most likely value from column_name within the time range, or default if no data
    """
    if column_name not in df.columns:
        return default
    
    # Filter dataframe to time range
    filtered_df = df[(df['ts'] >= start_ts) & (df['ts'] <= end_ts)]
    
    if len(filtered_df) == 0:
        return default
    
    # Get the column values, excluding NaN
    values = filtered_df[column_name].dropna()
    
    if len(values) == 0:
        return default
    
    # Determine data type and return appropriate statistic
    dtype = filtered_df[column_name].dtype
    
    # For numeric types, use median (most robust to outliers)
    if pd.api.types.is_numeric_dtype(dtype):
        value = values.median()
        return float(value) if pd.notna(value) else default
    
    # For categorical/string/object types, use mode (most frequent)
    else:
        mode_result = values.mode()
        if len(mode_result) > 0:
            return mode_result.iloc[0]
        else:
            return default

def getFoilingState(df: pd.DataFrame, ts: float) -> str:
    """
    Get foiling state from RH_lwd_mm and RH_wwd_mm.
    
    Args:
        df (pd.DataFrame): DataFrame with RH_lwd_mm and RH_wwd_mm columns
        ts (float): Timestamp to filter data
    Returns:
        str: Foiling state ('H1' or 'H0')
    """
    try:
        filtered_df = df.loc[(df['ts'] >= ts)]

        if not filtered_df.empty:
            row = filtered_df.iloc[0] 

            if row['Bsp_kts'] > 15 and row['Heel_n_deg'] < 8:
                return 'H0'
            elif row['Bsp_kts'] > 15 and row['Heel_n_deg'] > 8:
                return 'H1'
            elif row['Bsp_kts'] < 15 and row['Heel_n_deg'] > 5:
                return 'H1'
            elif row['Bsp_kts'] < 15 and row['Heel_n_deg'] < 5:
                return 'H2'
            else:
                return 'H1'
        else:
            return 'NA'
    except Exception as e:
        log_error("Error in getFoilingState", e)
        return 'NA'

def getMetadata(df: pd.DataFrame, ts: float, class_name: str) -> Dict[str, Any]:
    """
    Extract race and sail configuration metadata from sailing data.
    
    Retrieves race information and sail codes, converting them to standardized IDs.
    
    Args:
        df (pd.DataFrame): DataFrame containing race and sail data
        ts (float): Reference timestamp to filter data
        class_name (str): Class name ('ac40')
    Returns:
        dict: Dictionary containing race and sail metadata with standardized IDs
    """
    eventinfo = {}
    config = ""  # Initialize config with default value
    try:
        filtered_df = df.loc[(df['ts'] >= ts)]

        if not filtered_df.empty:
            row = filtered_df.iloc[0] 

            info = {}
            info["Race_number"] = int(number(row.get('Race_number', 0)))
            info["Leg_number"] = int(number(row.get('Leg_number', 0)))
            eventinfo["RACES"] = info

            if class_name.lower() == 'ac40':
                info = {}
                info["Name"] = str(row.get('Name', ''))
                info["Wing_code"] = str(row.get('Wing_code', ''))
                info["Headsail_code"] = str(row.get('Headsail_code', ''))
                info["Daggerboard_code"] = str(row.get('Daggerboard_code', ''))
                info["Rudder_code"] = str(row.get('Rudder_code', ''))
                info["Crew_count"] = str(row.get('Crew_count', ''))
                eventinfo["CONFIGURATION"] = info

                config = str(row.get('Config_code', ''))
                if config == 'nan':
                    config = 'NA'
            else:
                # Default config for unknown class names
                config = "NA"

        eventinfo["CONFIG"] = config
        eventinfo["NOTE"] = ''
    except (KeyError, IndexError) as e:
        # If required columns are missing, return empty eventinfo
        log_error("Error in getMetadata - missing column", e)
        return eventinfo
            
    return eventinfo

def updateManeuverTime(df: pd.DataFrame, ts: float, type: str, window: float = 5) -> float:
    """
    Find the exact timestamp of a sailing maneuver based on Course Wind Angle or speed.
    
    For TAKEOFF: returns the first moment in the window when boat speed >= 28 kph.
    For TACK/GYBE/other: analyzes CWA (Course Wind Angle) within a time window to
    pinpoint the exact moment of the maneuver.
    
    Args:
        df (pd.DataFrame): DataFrame containing sailing data with 'ts', 'Cwa_deg', and 'Bsp_kts' columns
        ts (float): Approximate timestamp of the maneuver
        type (str): Type of maneuver ('TAKEOFF', 'TACK', 'GYBE', or other)
        window (float): Time window in seconds on either side of ts to search (default: 5)
        
    Returns:
        float: The exact timestamp of the maneuver
    """
    
    if type == "TAKEOFF":
        if 'Bsp_kts' not in df.columns:
            return ts
        dfc = df.loc[(df['ts'] > ts - window) & (df['ts'] < ts + window)].copy()
        if dfc.empty:
            return ts
        passed = dfc.loc[dfc['Bsp_kts'] >= 15]
        if passed.empty:
            return ts
        return float(passed.sort_values('ts').iloc[0]['ts'])

    df['Twa_n_deg'] = df['Twa_deg'].abs()
    dfc = df.loc[(df['ts'] > ts - window) & (df['ts'] < ts + window)].copy()
    
    if len(dfc) == 0:
        return ts
        
    try:
        if type == "TACK":
            dff = dfc[dfc['Twa_n_deg'].eq(dfc['Twa_n_deg'].min())]
        elif type == "GYBE":
            dff = dfc[dfc['Twa_n_deg'].eq(dfc['Twa_n_deg'].max())]
        else:
            dfi = dfc[dfc['Twa_n_deg'] >= 90].copy()
            if len(dfi) == 0:
                return ts 
            
            dff = dfi[dfi['Twa_n_deg'].eq(dfi['Twa_n_deg'].min())]
        
        return dff.iloc[0]['ts']
    except (IndexError, KeyError):
        return ts
    
def PrepareManeuverVmg(df: pd.DataFrame) -> None:
    """
    Calculate VMG (Velocity Made Good) and performance metrics for maneuver analysis.
    
    Computes wind angles, VMG, and performance deltas using average true wind direction.
    Simplified version focused on VMG calculations.
    
    Args:
        df (pd.DataFrame): DataFrame containing sailing data
        
    Returns:
        None: Modifies DataFrame in place with VMG and performance columns
    """
    try:
        # Calculate average TWD (True Wind Direction)
        twd_avg = mean360(df['Twd_deg'].tolist())

        # Initialize columns
        df['Twa_deg'] = 0.00
        df['Lwy_n_deg'] = 0.00
        df['Cwa_deg'] = 0.00
        df['Vmg_kts'] = 0.00
        df['Vmg_n_kts'] = 0.00
        df['BspTgtDelta'] = 0.00
        df['VmgTgtDelta'] = 0.00
        df['Vmg_perc'] = 0.00

        # Compute CSE (Course Through Water) = Hdg - Lwy (using corrected leeway if available)
        if 'Hdg_deg' in df.columns:
            # Use corrected leeway if available, otherwise fallback to uncorrected
            lwy_col = (
                'AC40_Leeway_cor_deg' if 'AC40_Leeway_cor_deg' in df.columns
                else ('Lwy_cor_deg' if 'Lwy_cor_deg' in df.columns else 'Lwy_deg')
            )
            if lwy_col in df.columns:
                cse = ((df['Hdg_deg'] - df[lwy_col]) + 180) % 360 - 180
                cse[cse == -180] = 180
                df['Cse_deg'] = cse
            else:
                # Fallback to heading if no leeway available
                df['Cse_deg'] = df['Hdg_deg']
        else:
            # Fallback to COG if no heading available
            df['Cse_deg'] = df['Cog_deg'] if 'Cog_deg' in df.columns else 0.0

        # Compute previous CSE using shift for vectorized operation
        df['PrevCse'] = df['Cse_deg'].shift(fill_value=df['Cse_deg'].iloc[0])

        # Calculate Turn Angle from CSE (Course Through Water) instead of COG
        diff = df['Cse_deg'] - df['PrevCse']
        df['TurnAng'] = ((diff + 180) % 360) - 180

        # Handle cumulative turn angles
        df['TotalTurnAng'] = df['TurnAng'].cumsum()

        # Performance calculations (vectorized) - use CSE instead of COG for CWA
        twd_hdg_diff = twd_avg - df['Hdg_deg']
        df['Twa_cor'] = ((twd_hdg_diff + 180) % 360) - 180
        twd_cse_diff = twd_avg - df['Cse_deg']
        df['Cwa_cor'] = ((twd_cse_diff + 180) % 360) - 180
        df['Vmg_cor'] = np.abs(np.cos(np.radians(df['Cwa_cor'])) * df['Bsp_kts'])

        # Update columns
        df['Twa_deg'] = df['Twa_cor']
        df['Lwy_n_deg'] = df['Lwy_deg'] * np.sign(df['Cwa_cor'])
        df['Cwa_deg'] = df['Cwa_cor']
        df['Vmg_kts'] = df['Vmg_cor']
        df['Vmg_n_kts'] = df['Vmg_cor'].abs()
        df['Vmg_perc'] = (df['Vmg_n_kts'].fillna(0) / df['Vmg_tgt_kts'].fillna(0)) * 100
        df['BspTgtDelta'] = df['Bsp_kts'] - df['Bsp_tgt_kts']
        df['VmgTgtDelta'] = df['Vmg_kts'].abs() - df['Vmg_tgt_kts'].abs()
    except Exception as e:
        log_error("Error in PrepareManeuverVmg", e)

def PrepareManeuverData(df: pd.DataFrame, event_type: str = 'NONE') -> None:
    """
    Comprehensive preparation of sailing data for maneuver analysis.
    
    Calculates angular rates, Accel_rate_mps2erations, wind angles, VMG, and applies smoothing.
    Includes turn angle calculations and performance metrics.
    
    Args:
        df (pd.DataFrame): DataFrame containing raw sailing data
        
    Returns:
        None: Modifies DataFrame in place with all calculated maneuver metrics
    """

    # Fill missing values, excluding datetime columns which are timezone-aware
    # Also exclude string/object columns to prevent type conversion
    datetime_cols = df.select_dtypes(include=['datetime64[ns, UTC]', 'datetime64[ns]']).columns
    string_cols = set(df.select_dtypes(include=['object', 'string']).columns)
    # Also check for common string column names that should be preserved
    known_string_cols = ['Wing_code', 'Headsail_code', 'Daggerboard_code', 'Rudder_code', 'Config_code', 'Name']
    string_cols.update([col for col in known_string_cols if col in df.columns])
    non_datetime_cols = [col for col in df.columns if col not in datetime_cols and col not in string_cols]
    if len(non_datetime_cols) > 0:
        df[non_datetime_cols] = df[non_datetime_cols].fillna(0)

    # Reset index to ensure contiguous numeric indexing
    df.reset_index(drop=True, inplace=True)

    # Batch initialize columns for better performance
    init_cols = {
        'Twa_deg': 0.0,
        'Lwy_n_deg': 0.0,
        'Cwa_deg': 0.0,
        'Vmg_kts': 0.0,
        'Vmg_n_kts': 0.0,
        'BspTgtDelta': 0.0,
        'VmgTgtDelta': 0.0,
        'Vmg_perc': 0.0
    }
    for col, val in init_cols.items():
        if col not in df.columns:
            df[col] = val

    # Calculate Period (keep as float, will sanitize zeros later where needed)
    df['Period'] = df['ts'].diff()

    # Calculate smoothing window more efficiently
    # Use mode() instead of value_counts().idxmax() for better performance
    period_series = df['Period'].dropna()
    if len(period_series) > 0:
        period_mode = period_series.mode()
        period = period_mode.iloc[0] if len(period_mode) > 0 else period_series.median()
        # Ensure period is positive and reasonable
        if period > 0 and period < 5:  # Sanity check: period should be < 5 seconds
            smoothing_window = max(1, int(2 / period))
            offset_window = -int(smoothing_window / 2)
        else:
            # Fallback to median if mode is unreasonable
            period = period_series.median()
            smoothing_window = max(1, int(2 / period)) if period > 0 else 1
            offset_window = -int(smoothing_window / 2)
    else:
        smoothing_window = 1
        offset_window = 0


    df_stable = df[df['Yaw_rate_n_dps'].abs() <= 2]

    if period > 0 and len(df_stable) > 0:
        n_records = max(1, int(10 / period))
        n_records = min(n_records, len(df_stable))

        # First seconds of stable data
        first = df_stable.iloc[:n_records]
        twd_start = mean360(first['Twd_deg'].dropna().tolist())
        hdg_start = mean360(first['Hdg_deg'].dropna().tolist())

        # Last seconds stable data
        last = df_stable.iloc[-n_records:]
        twd_end = mean360(last['Twd_deg'].dropna().tolist())
        hdg_end = mean360(last['Hdg_deg'].dropna().tolist())

        # Compute rotation reference
        if event_type in ('TACK', 'GYBE'):
            twd_avg = mean360([twd_start, twd_end])

            if event_type == 'TACK':
                twd_avg_hdg = mean360([hdg_start, hdg_end])
            else:  # GYBE
                twd_avg_hdg = (mean360([hdg_start, hdg_end]) + 180) % 360

            if angle_between(twd_avg, twd_avg_hdg) < 5:
                twd_avg = mean360([twd_avg_hdg, twd_avg])
        else:
            twd_avg = mean360([twd_start, twd_end])
    else:
        twd_avg = mean360(df_stable['Twd_deg'].dropna().tolist())

    df['Twd_cor'] = twd_avg

    # Compute CSE (Course Through Water) = Hdg - Lwy (using corrected leeway if available)
    if 'Hdg_deg' in df.columns:
        # Use corrected leeway if available, otherwise fallback to uncorrected
        lwy_col = (
            'AC40_Leeway_cor_deg' if 'AC40_Leeway_cor_deg' in df.columns
            else ('Lwy_cor_deg' if 'Lwy_cor_deg' in df.columns else 'Lwy_deg')
        )
        if lwy_col in df.columns:
            cse = ((df['Hdg_deg'] - df[lwy_col]) + 180) % 360 - 180
            cse[cse == -180] = 180
            df['Cse_deg'] = cse
        else:
            # Fallback to heading if no leeway available
            df['Cse_deg'] = df['Hdg_deg']
    else:
        # Fallback to COG if no heading available
        df['Cse_deg'] = df['Cog_deg'] if 'Cog_deg' in df.columns else 0.0

    # Add Previous values (vectorized, more efficient)
    first_cse = df['Cse_deg'].iloc[0] if len(df) > 0 else 0.0
    first_bsp = df['Bsp_kts'].iloc[0] if len(df) > 0 else 0.0
    df['PrevCse'] = df['Cse_deg'].shift(fill_value=first_cse)
    df['PrevBsp'] = df['Bsp_kts'].shift(fill_value=first_bsp)

    # Calculate Turn Angle from CSE (Course Through Water) instead of COG
    diff = df['Cse_deg'] - df['PrevCse']
    df['TurnAng'] = ((diff + 180) % 360) - 180

    # Handle cumulative turn angles
    df['TotalTurnAng'] = df['TurnAng'].cumsum()

    # Check if columns already exist (more efficient check)
    calc_Yaw_rate_dps = "Yaw_rate_dps" not in df.columns
    calc_Accel_rate_mps2 = "Accel_rate_mps2" not in df.columns

    # Calculate Angular Rate and Acceleration (use Period > 0 before sanitization)
    # Create a mask for valid periods to avoid division by zero
    valid_period_mask = df['Period'] > 0
    
    if calc_Yaw_rate_dps:
        df['Yaw_rate_dps_raw'] = np.where(
            valid_period_mask, 
            df['TurnAng'] / df['Period'], 
            0.0
        )

    if calc_Accel_rate_mps2:
        bsp_diff = (df['Bsp_kts'] - df['PrevBsp']) * mps
        df['Accel_rate_mps2_raw'] = np.where(
            valid_period_mask,
            bsp_diff / df['Period'],
            0.0
        )

    # Sanitize data for performance metrics (use .loc to avoid SettingWithCopyWarning)
    # Replace 0 with NaN only for columns that need it, using vectorized operations
    df.loc[df['Period'] == 0, 'Period'] = np.nan
    if 'Bsp_tgt_kts' in df.columns:
        df.loc[df['Bsp_tgt_kts'] == 0, 'Bsp_tgt_kts'] = np.nan
    if 'Vmg_tgt_kts' in df.columns:
        df.loc[df['Vmg_tgt_kts'] == 0, 'Vmg_tgt_kts'] = np.nan

    # Recompute Wind Angles and VMG (vectorized, compute once)
    twd_hdg_diff = twd_avg - df['Hdg_deg']
    df['Twa_cor'] = ((twd_hdg_diff + 180) % 360) - 180
    twd_cog_diff = twd_avg - df['Cog_deg']
    df['Cwa_cor'] = ((twd_cog_diff + 180) % 360) - 180
    df['Vmg_cor'] = np.cos(np.radians(df['Cwa_cor'])) * df['Bsp_kts']

    # SMOOTH ACCELERATION (use direct column access instead of get_loc/iloc)
    if calc_Accel_rate_mps2:
        df['Accel_rate_mps2_smoothed'] = df['Accel_rate_mps2_raw'].rolling(
            window=smoothing_window, 
            min_periods=1
        ).mean()
        df['Accel_rate_mps2'] = df['Accel_rate_mps2_smoothed'].shift(offset_window)
    
    # SMOOTHING ANGULAR RATE (use direct column access)
    if calc_Yaw_rate_dps:
        df['Yaw_rate_dps_smoothed'] = df['Yaw_rate_dps_raw'].rolling(
            window=smoothing_window,
            min_periods=1
        ).mean()
        df['Yaw_rate_dps'] = df['Yaw_rate_dps_smoothed'].shift(offset_window)

    # Drop temporary columns efficiently (use drop instead of del)
    cols_to_drop = []
    if calc_Yaw_rate_dps:
        cols_to_drop.extend(['Yaw_rate_dps_smoothed', 'Yaw_rate_dps_raw'])
    if calc_Accel_rate_mps2:
        cols_to_drop.extend(['Accel_rate_mps2_smoothed', 'Accel_rate_mps2_raw'])

    # Performance Metrics (vectorized assignments, handle NaN divisions)
    df['Twa_deg'] = df['Twa_cor']
    df['Lwy_n_deg'] = df['Lwy_deg'] * np.sign(df['Cwa_cor'])
    df['Twa_n_deg'] = df['Twa_deg'].abs()
    df['Cwa_deg'] = df['Cwa_cor']
    df['Vmg_kts'] = df['Vmg_cor']
    df['Vmg_n_kts'] = df['Vmg_cor'].abs()
    
    # Handle division by zero/NaN safely; allow 0, cap absolute max, and disallow huge row-to-row jumps
    VMG_PERC_MAX = 150.0       # absolute cap; above → NaN
    VMG_PERC_MAX_STEP = 10.0   # max allowed change from one row to the next (percentage points)
    if 'Vmg_tgt_kts' in df.columns:
        raw_pct = np.where(
            df['Vmg_tgt_kts'].notna() & (df['Vmg_tgt_kts'] != 0),
            (df['Vmg_n_kts'] / df['Vmg_tgt_kts']) * 100,
            np.nan
        )
        raw_pct = np.where((raw_pct >= 0) & (raw_pct <= VMG_PERC_MAX), raw_pct, np.nan)
        step = np.abs(np.diff(raw_pct, prepend=raw_pct[0]))
        raw_pct = np.where(step <= VMG_PERC_MAX_STEP, raw_pct, np.nan)
        df['Vmg_perc'] = raw_pct
    else:
        df['Vmg_perc'] = np.nan
    
    if 'Bsp_tgt_kts' in df.columns:
        df['BspTgtDelta'] = df['Bsp_kts'] - df['Bsp_tgt_kts']
    else:
        df['BspTgtDelta'] = np.nan
    
    if 'Vmg_tgt_kts' in df.columns:
        df['VmgTgtDelta'] = df['Vmg_kts'].abs() - df['Vmg_tgt_kts'].abs()
    else:
        df['VmgTgtDelta'] = np.nan
    
    # Drop all temporary columns
    if cols_to_drop:
        df.drop(columns=cols_to_drop, inplace=True)
    
def NormalizeManeuverData(df: pd.DataFrame) -> None:
    """
    Normalize angular rate data to ensure consistent sign convention.
    
    Ensures angular rate has consistent polarity by comparing maximum absolute values
    within the maneuver window and flipping sign if necessary.
    
    Args:
        df (pd.DataFrame): DataFrame with 'sec', 'Yaw_rate_dps', and 'TotalTurnAng' columns
        
    Returns:
        None: Modifies DataFrame in place with normalized angular data
    """
    try:        
        dfa = df.loc[(df['sec'] >= -10) & (df['sec'] <= 10)].copy()
        Yaw_rate_dps_max = abs(dfa['Yaw_rate_dps'].max())
        Yaw_rate_dps_min = abs(dfa['Yaw_rate_dps'].min())
        
        if Yaw_rate_dps_min > Yaw_rate_dps_max:
            df['Yaw_rate_dps'] = df['Yaw_rate_dps'] * -1
            df['TotalTurnAng'] = df['TotalTurnAng'] * -1   
    except Exception as e:
        log_error("Error in NormalizeManeuverData", e)

def UpdateManeuverSeconds(df: pd.DataFrame, mrvr_ts: float) -> None:
    """
    Update time reference to be relative to maneuver timestamp.
    
    Converts absolute timestamps to seconds relative to the maneuver time,
    creating a 'sec' column for maneuver-centric analysis.
    
    Args:
        df (pd.DataFrame): DataFrame containing 'ts' timestamp column
        mrvr_ts (float): Maneuver timestamp to use as reference (t=0)
        
    Returns:
        None: Modifies DataFrame in place with 'sec' column
    """
    try:
        # Use .loc to avoid SettingWithCopyWarning when df is a slice
        df.loc[:, 'sec'] = 0.0
        df.loc[:, 'sec'] = df['ts'] - mrvr_ts
    except Exception as e:
        log_error("Error in UpdateManeuverSeconds", e)

def remove_duplicates(input_list: list) -> list:
    """
    Remove duplicate items from a list while preserving order.
    
    Args:
        input_list (list): List that may contain duplicates
        
    Returns:
        list: List with duplicates removed, order preserved
    """
    unique_list = []
    for item in input_list:
        if item not in unique_list:
            unique_list.append(item)
    return unique_list

def remove_gaps(dfi: pd.DataFrame, column_ref: str, datetime_ref: str, threshold_seconds: int = 30, zero_tolerance: float = 0.001) -> pd.DataFrame:
    """
    Remove data gaps where a reference column remains constant for extended periods.
    Identifies periods where the second derivative is near zero (indicating constant values)
    and removes segments longer than the threshold. Also removes the row immediately before and after each gap.
    
    Args:
        dfi (pd.DataFrame): Input DataFrame to filter
        column_ref (str): Column name to analyze for gaps
        datetime_ref (str): Datetime column name for duration calculation
        threshold_seconds (int): Minimum duration in seconds to consider a gap (default: 30)
        zero_tolerance (float): Tolerance for considering values as zero (default: 0.01)
        
    Returns:
        pd.DataFrame: Filtered DataFrame with gaps removed
    """
    df = dfi.copy()

    df['first_diff'] = df[column_ref].diff()
    df['second_diff'] = df['first_diff'].diff()
    
    # Add 0 to categorical columns before filling
    for col in df.select_dtypes(include='category').columns:
        if 0 not in df[col].cat.categories:
            df[col] = df[col].cat.add_categories([0])

    # Exclude datetime columns from fillna(0) as they are timezone-aware and incompatible with 0
    datetime_cols = df.select_dtypes(include=['datetime64[ns, UTC]', 'datetime64[ns]']).columns
    non_datetime_cols = [col for col in df.columns if col not in datetime_cols]
    if len(non_datetime_cols) > 0:
        df[non_datetime_cols] = df[non_datetime_cols].fillna(0)
    
    # Defragment DataFrame after column modifications to avoid performance warnings
    df = df.copy()
    
    df['is_zero'] = df['second_diff'].abs() <= zero_tolerance
    df['zero_period'] = (df['is_zero'] != df['is_zero'].shift()).cumsum()
    # Handle both datetime columns and timestamp (ts) columns for duration calculation
    if datetime_ref == 'ts' or df[datetime_ref].dtype in ['float64', 'float32', 'int64', 'int32']:
        # For timestamp columns, duration is just the difference in seconds
        df['period_duration'] = df.groupby('zero_period')[datetime_ref].transform(lambda x: x.max() - x.min())
    else:
        # For datetime columns, convert timedelta to seconds
        df['period_duration'] = df.groupby('zero_period')[datetime_ref].transform(lambda x: (x.max() - x.min()).total_seconds())
    mask = ~(df['is_zero'] & (df['period_duration'] > threshold_seconds))
    
    # Identify the start and end indices of each gap (using original index)
    gap_periods = df.loc[df['is_zero'] & (df['period_duration'] > threshold_seconds), 'zero_period'].unique()
    indices_to_remove = set()
    for period in gap_periods:
        gap_indices = df.index[df['zero_period'] == period].tolist()
        if gap_indices:
            # Use positional indices to avoid Timestamp arithmetic
            first_pos = df.index.get_loc(gap_indices[0])
            last_pos = df.index.get_loc(gap_indices[-1])
            before_pos = first_pos - 1
            after_pos = last_pos + 1
            if before_pos >= 0:
                before_idx = df.index[before_pos]
                indices_to_remove.add(before_idx)
            if after_pos < len(df):
                after_idx = df.index[after_pos]
                indices_to_remove.add(after_idx)
    # Combine mask and before/after indices
    final_mask = mask.copy()
    for idx in indices_to_remove:
        if idx in final_mask.index:
            final_mask.loc[idx] = False
    filtered_df = df[final_mask].copy()
    filtered_df = filtered_df.drop(columns=['is_zero', 'zero_period', 'period_duration','first_diff','second_diff'])
    
    return filtered_df

# Backward compatibility alias
removeGaps = remove_gaps

def identifyManeuvers(df: pd.DataFrame) -> pd.DataFrame:
    """
    Automatically identify sailing maneuvers from boat data.
    
    Detects tacks, gybes, bear-aways, and round-ups based on true wind angle changes
    and boat speed. Sets data quality grades and maneuver types.
    
    Args:
        df (pd.DataFrame): DataFrame with sailing data including 'Twa_deg', 'Bsp_kts', 'ts' columns
        
    Returns:
        pd.DataFrame: DataFrame with added 'Grade' and 'Maneuver_type' columns
    """
    if (len(df) > 0):
        first_list = []

        df.sort_values(by='ts', inplace=True)

        # Detect tack_change and pos_change using previous values from 1 second ago
        df['tack_change'] = (
            ((df['Twa_deg'].shift(1) > 0) & (df['Twa_deg'] < 0)) |
            ((df['Twa_deg'].shift(1) < 0) & (df['Twa_deg'] > 0))
        )

        tack_change_indexes = df.index[df['tack_change']]

        pts = None
        mnvr_ts = 0.000
        for idx in tack_change_indexes:
            row = df.loc[idx]
            mnvr_ts = number(row['ts'])

            if (number(row['Bsp_kts']) > 4):

                if pts == None or mnvr_ts - pts > 5:
                    dff = df.loc[(df['ts'] >= mnvr_ts - 5) & (df['ts'] <= mnvr_ts + 5)].copy()
                    twa_first = dff['Twa_deg'].iloc[0]
                    twa_last = dff['Twa_deg'].iloc[-1]
                    twa_min = dff['Twa_n_deg'].min()
                    twa_max = dff['Twa_n_deg'].max()
                    twa_avg = dff['Twa_n_deg'].mean()
                    turn_ang = angle_between(twa_first, twa_last)

                    # Strong indicators: extreme angles
                    if twa_min < 20 and turn_ang > 10:
                        first_list.append(['TACK', mnvr_ts])
                    elif twa_max > 160 and turn_ang > 10:
                        first_list.append(['GYBE', mnvr_ts])
                    # Fallback: classify based on angle range when tack_change is detected
                    elif turn_ang > 10:
                        # TACK typically happens at upwind angles (< 90°)
                        # GYBE typically happens at downwind angles (> 90°)
                        if twa_avg < 90:
                            first_list.append(['TACK', mnvr_ts])
                        else:
                            first_list.append(['GYBE', mnvr_ts])

            pts = mnvr_ts

        df['pos_change'] = (
            ((df['Twa_n_deg'].shift(1) < 90) & (df['Twa_n_deg'] > 90)) |
            ((df['Twa_n_deg'].shift(1) > 90) & (df['Twa_n_deg'] < 90))
        )
        
        pos_change_indexes = df.index[df['pos_change']]

        pts = None
        for idx in pos_change_indexes:
            row = df.loc[idx]

            if (number(row['Bsp_kts']) > 4):
                mnvr_ts = number(row['ts'])

                if pts == None or mnvr_ts - pts > 5:
                    dff = df.loc[(df['ts'] >= mnvr_ts - 5) & (df['ts'] <= mnvr_ts + 5)].copy()
                    twa_first = dff['Twa_n_deg'].iloc[0]
                    twa_last = dff['Twa_n_deg'].iloc[-1]
                    twa_avg = dff['Twa_n_deg'].mean()
                    turn_ang = angle_between(twa_first, twa_last)
                    
                    # Get the actual crossing point values (before and after the crossing)
                    # pos_change is detected at idx, meaning TWA crossed 90 at this point
                    try:
                        pos_in_index = df.index.get_loc(idx)
                        if pos_in_index > 0:
                            prev_idx = df.index[pos_in_index - 1]
                            prev_twa = df.loc[prev_idx, 'Twa_n_deg']
                            curr_twa = df.loc[idx, 'Twa_n_deg']
                        else:
                            # Can't get previous, use window values
                            prev_twa = twa_first
                            curr_twa = twa_last
                    except (KeyError, IndexError):
                        # Fallback to window values if index access fails
                        prev_twa = twa_first
                        curr_twa = twa_last

                    # Strong indicators: clear crossing with sufficient turn
                    if (twa_first < 90 and twa_last > 90 and turn_ang > 10):
                        first_list.append(['BEARAWAY', mnvr_ts])
                    elif (twa_first > 90 and twa_last < 90 and turn_ang > 10):
                        first_list.append(['ROUNDUP', mnvr_ts])
                    # Fallback: use the actual crossing point or average to determine direction
                    elif turn_ang > 10:
                        # BEARAWAY: crossing from < 90 to > 90 (upwind to downwind)
                        # ROUNDUP: crossing from > 90 to < 90 (downwind to upwind)
                        if prev_twa < 90 and curr_twa > 90:
                            first_list.append(['BEARAWAY', mnvr_ts])
                        elif prev_twa > 90 and curr_twa < 90:
                            first_list.append(['ROUNDUP', mnvr_ts])
                        # Additional fallback: classify based on average angle and turn direction
                        elif twa_avg < 90 and twa_last > twa_first:
                            # Average is upwind, turning away (increasing angle)
                            first_list.append(['BEARAWAY', mnvr_ts])
                        elif twa_avg > 90 and twa_last < twa_first:
                            # Average is downwind, turning up (decreasing angle)
                            first_list.append(['ROUNDUP', mnvr_ts])

            pts = mnvr_ts

        # Detect TAKEOFF: boat speed transitions from < 15 kts to >= 15 kts
        df['speed_crossing'] = (
            (df['Bsp_kts'].shift(1) < 15) & (df['Bsp_kts'] >= 15)
        )
        
        speed_crossing_indexes = df.index[df['speed_crossing']]
        
        pts = None
        for idx in speed_crossing_indexes:
            row = df.loc[idx]
            mnvr_ts = number(row['ts'])
            
            if pts == None or mnvr_ts - pts > 5:
                # Require boat speed was < 10 kts at 10 seconds prior to takeoff
                dff_before = df.loc[(df['ts'] >= mnvr_ts - 10) & (df['ts'] < mnvr_ts)].copy()
                if len(dff_before) == 0:
                    continue
                speed_10s_before = dff_before.sort_values('ts').iloc[0]['Bsp_kts']
                if speed_10s_before >= 10.0:
                    continue

                # Verify it's a valid takeoff - check that speed reaches at least 18 kts within 180 seconds
                verify_window = 180.0  # 180 seconds (3 minutes) after crossing
                dff_verify = df.loc[(df['ts'] >= mnvr_ts) & (df['ts'] <= mnvr_ts + verify_window)].copy()
                
                if len(dff_verify) > 0:
                    bs_max_verify = dff_verify['Bsp_kts'].max()
                    
                    # Verify boat reaches a reasonable speed after takeoff (at least 18 kts)
                    if bs_max_verify >= 18.0:
                        first_list.append(['TAKEOFF', mnvr_ts])
            
            pts = mnvr_ts

        if len(first_list) > 0:
            mnvr_list = remove_duplicates(first_list)
                               
            for mnvr in mnvr_list: 
                try:
                    mnvr_type = mnvr[0]
                    mnvr_ts = number(mnvr[1])

                    if (mnvr_type == 'TACK' or mnvr_type == 'GYBE'):
                        seconds_before = 5
                        seconds_after = 10
                    elif (mnvr_type == 'BEARAWAY' or mnvr_type == 'ROUNDUP'):
                        seconds_before = 5
                        seconds_after = 5
                    else:
                        seconds_before = 10
                        seconds_after = 20

                    if mnvr_type in ('BEARAWAY', 'ROUNDUP'):
                        start_ts = mnvr_ts - 5
                        end_ts = mnvr_ts + 10
                        dfa = df.loc[(df['ts'] >= start_ts) & (df['ts'] <= end_ts)]

                        if not dfa.empty:
                            start_heading = dfa['Hdg_deg'].iloc[0]
                            end_heading   = dfa['Hdg_deg'].iloc[-1]
                                                        # Compute signed minimal turn angle
                            turn_angle = end_heading - start_heading
                            turn_angle = (turn_angle + 180) % 360 - 180 

                            if abs(turn_angle) < 15:
                                continue   

                    if mnvr_type in ('TACK', 'GYBE'):
                        start_ts = mnvr_ts - 5
                        dfa = df.loc[(df['ts'] >= start_ts)]
                        start_twa = abs(dfa['Twa_deg'].iloc[0])

                        upwind = start_twa < 90
                        downwind = start_twa > 90

                        if mnvr_type == 'TACK' and downwind:
                            continue 
                        if mnvr_type == 'GYBE' and upwind:
                            continue 

                    start_ts = mnvr_ts - (seconds_before) 
                    end_ts = mnvr_ts + (seconds_after)

                    # IF MANEUVER QUALIFIES, APPLY GRADES
                    df.loc[(df['ts'] >= start_ts) & (df['ts'] <= end_ts) & (df['Grade'] > 1), 'Grade'] = 2
                    df.loc[(df['ts'] >= mnvr_ts - 3) & (df['ts'] <= mnvr_ts + 3) & (df['Grade'] > 0), 'Grade'] = 1

                    if mnvr_type == 'TAKEOFF':
                        df.loc[(df['ts'] == mnvr_ts), 'Maneuver_type'] = 'A'
                    else:
                        df.loc[(df['ts'] == mnvr_ts), 'Maneuver_type'] = mnvr_type[:1]
                except Exception as e:
                    log_error("Error in identifyManeuvers", e)

            # distinct_values = df['Maneuver_type'].unique()
            # print(distinct_values)
                
    return df
    
def tack_from_twa(twa_deg):
    """
    Tack from true wind angle: +1 for starboard (TWA >= 0), -1 for port (TWA < 0).
    Accepts scalar or array-like; returns same shape (int).
    """
    twa = np.asarray(twa_deg, dtype=float)
    out = np.where(twa >= 0, 1, -1)
    if twa.ndim == 0:
        return int(out)
    return out.astype(int)


def getPointofSail(twa: float) -> int:
    """
    Determine point of sail based on true wind angle.
    
    Args:
        twa (float): True wind angle in degrees
        
    Returns:
        int: 1 for upwind sailing (abs(twa) <= 80), -1 for downwind sailing
    """
    if abs(twa) > 80:
        return -1
    else:
        return 1

def IdentifyRaceLegs(df: pd.DataFrame, mnvr_list: list) -> pd.DataFrame:
    """
    Identify and number race legs based on maneuvers and position changes.
    
    Analyzes maneuvers and geographic position to automatically segment races into legs.
    Detects bear-aways and round-ups that indicate mark roundings.
    
    Args:
        df (pd.DataFrame): DataFrame containing race data with position and maneuver info
        mnvr_list (list): List of maneuvers [type, timestamp] to analyze
        
    Returns:
        pd.DataFrame: DataFrame with 'Leg_number' column populated
    """
    try:
        sorted_list = sorted(mnvr_list, key=lambda x: int(x[1]))
        df.sort_values(by=['ts'], inplace=True, ascending=True)
        
        df.loc[(df['Race_number'].astype(str) == str(0)), 'Leg_number'] = -1
        df.loc[(df['Race_number'].astype(str) == str(0)), 'Race_number'] = -1
        
        df1 = df.loc[(df['Race_number'] != None)].copy()   
        df1['Race_Int'] = pd.to_numeric(df['Race_number'], errors='coerce').astype('Int64')
        
        df2 = df1.loc[(df1['Race_Int'] > 0)].copy()
        races = df2['Race_Int'].unique()
        
        if len(races) > 0:
            for race in races:
                
                if race > 0: 
                    #INITIAL RACE MIN MAX TIME               
                    dff = df.loc[(df['Race_number'].astype(str) == str(race))].copy()
                    ts_min = dff['ts'].min()
                    ts_max = dff['ts'].max()

                    lat0 = dff.iloc[0]['Lat_dd']
                    lng0 = dff.iloc[0]['Lng_dd'] 
                    
                    #PRESTART
                    race_includes_prestart = True
                    if race_includes_prestart:
                        race_start = ts_min + 120000
                        leg_start = ts_min
                        entry_start = leg_start - 120000
                    else:
                        race_start = ts_min
                        leg_start = ts_min - 120000
                        entry_start = leg_start - 120000
                    
                    #IF RACE IS SHORT, LEG 0 IS BEFORE THE START, LEG 1 IS AFTER THE START
                    if (ts_max - ts_min) > 300:
                        df.loc[(df['ts'] >= entry_start) & (df['ts'] <= race_start) & (df['Grade'] > 0), 'Grade'] = 1
                        df.loc[(df['ts'] >= leg_start) & (df['ts'] <= race_start), 'Leg_number'] = 0
                        df.loc[(df['ts'] >= leg_start) & (df['ts'] <= ts_max), 'Race_number'] = race
                        ts_min = race_start 
                        
                        leg_start = ts_min
                        Leg_number = 1 
                        prev_mnvr_type = 'NONE' 
                        
                        # LOOP THROUGH MANEUVERS THAT LIE INSIDE THIS RACE
                        filtered_list = [event for event in sorted_list if int(event[1]) > ts_min and int(event[1]) < ts_max]
                        
                        for mnvr in filtered_list:
                            mnvr_type = mnvr[0]
                            mnvr_ts = mnvr[1]
                            
                            if mnvr_ts > ts_min:
                                if (mnvr_ts > ts_min and mnvr_ts < ts_max):
                                    if mnvr_ts - leg_start > 120000:
                                        if mnvr_type == "BEARAWAY" and mnvr_type != prev_mnvr_type:
                                            dff = df.loc[(df['ts'] >= mnvr_ts - 60000) & (df['ts'] <= mnvr_ts + 60000)]
                                            
                                            if len(dff) > 0:
                                                lat = dff.iloc[0]['Lat_dd']
                                                lng = dff.iloc[0]['Lng_dd'] 
                                            
                                                dist = range_from_latlng(lat0, lng0, lat, lng)

                                                if dist > 900:                                       
                                                    pos_before = getPointofSail(dff.iloc[0]['Twa_n_deg'])
                                                    pos_after = getPointofSail(dff.iloc[-1]['Twa_n_deg'])
                                                    
                                                    if pos_before != pos_after: 
                                                        df.loc[(df['ts'] >= leg_start) & (df['ts'] <= mnvr_ts), 'Leg_number'] = Leg_number
                                                        
                                                        Leg_number += 1
                                                        leg_start = mnvr_ts
                                                        lat0 = lat
                                                        lng0 = lng
                                        elif mnvr_type == "ROUNDUP" and mnvr_type != prev_mnvr_type:  
                                            dff = df.loc[(df['ts'] >= mnvr_ts - 60000) & (df['ts'] <= mnvr_ts + 60000)]
                                            
                                            if len(dff) > 0:
                                                lat = dff.iloc[0]['Lat_dd']
                                                lng = dff.iloc[0]['Lng_dd'] 

                                                dist = range_from_latlng(lat0, lng0, lat, lng)

                                                if dist > 900: 
                                                    pos_before = getPointofSail(dff.iloc[0]['Twa_n_deg'])
                                                    pos_after = getPointofSail(dff.iloc[-1]['Twa_n_deg'])
                                                    
                                                    if pos_before != pos_after: 
                                                        df.loc[(df['ts'] >= leg_start) & (df['ts'] <= mnvr_ts), 'Leg_number'] = Leg_number
                                                        
                                                        Leg_number += 1
                                                        leg_start = mnvr_ts
                                                        lat0 = lat
                                                        lng0 = lng
                                            
                                prev_mnvr_type = mnvr_type
                                
                        if Leg_number > 1:
                            df.loc[(df['ts'] >= leg_start) & (df['ts'] <= ts_max), 'Leg_number'] = Leg_number
                    else:
                        df.loc[(df['ts'] >= entry_start) & (df['ts'] <= race_start) & (df['Grade'] > 0), 'Grade'] = 1
                        df.loc[(df['ts'] >= leg_start) & (df['ts'] <= race_start), 'Leg_number'] = 0
                        df.loc[(df['ts'] >= race_start), 'Leg_number'] = 1
                        
        return df
    except Exception as e:
        log_error("Error in IdentifyRaceLegs", e)         
        return df
    
def computeVMC(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute Velocity Made Course (VMC) for each race leg.
    
    Calculates VMC based on the optimal course direction for each race leg,
    determined by start/end positions and wind direction. Also computes VMC ratio.
    If 'Course_axis_deg' exists, uses it for intermediate legs (legs 2 through second-to-last).
    For leg 1 and the final leg, always uses the calculated bearing-based VMC.
    
    Args:
        df (pd.DataFrame): DataFrame containing race data with position, course, and wind info
        
    Returns:
        pd.DataFrame: DataFrame with 'Vmc_kts', 'Vmc_ratio', and 'Vmc_Twd' columns added
    """
    df['Vmc_Twd'] = 0.0
    
    # Check if Course_axis_deg column exists
    has_course_axis = 'Course_axis_deg' in df.columns
    
    races = df['Race_number'].unique()
    
    for race_str in races:
        race = integer(race_str)

        if race > 0:
            df['Race_number'] = pd.to_numeric(df['Race_number'], errors='coerce').astype('Int64')
            df['Leg_number'] = pd.to_numeric(df['Leg_number'], errors='coerce').astype('Int64')

            dfl = df.loc[(df['Race_number'] == race)]
            
            race_legs = dfl['Leg_number'].unique()
            # Find the maximum leg number (final leg) for this race
            max_leg = max([integer(leg_str) for leg_str in race_legs if integer(leg_str) > 0], default=0)
            
            p_vmc_twd = 0
            for leg_str in race_legs:
                leg = integer(leg_str)
                
                if leg > 0:
                    dfl = df.loc[(df['Race_number'] == race) & (df['Leg_number'] == leg)].copy()
                    
                    # Check if we should use Course_axis_deg for this leg
                    use_course_axis = (has_course_axis and 
                                     leg != 1 and 
                                     leg != max_leg and
                                     'Course_axis_deg' in dfl.columns and
                                     dfl['Course_axis_deg'].notna().any())
                    
                    if use_course_axis:
                        # Use Course_axis_deg for intermediate legs
                        # Take the first non-null value for the leg
                        course_axis_value = dfl['Course_axis_deg'].dropna().iloc[0] if dfl['Course_axis_deg'].notna().any() else 0
                        if course_axis_value != 0:
                            df.loc[(df['Race_number'] == race) & (df['Leg_number'] == leg), 'Vmc_Twd'] = course_axis_value
                            p_vmc_twd = course_axis_value
                        else:
                            df.loc[(df['Race_number'] == race) & (df['Leg_number'] == leg), 'Vmc_Twd'] = 0
                    else:
                        # Use existing calculation for leg 1, final leg, or when Course_axis_deg doesn't exist
                        first_row = dfl.iloc[0]
                        last_row = dfl.iloc[-1]

                        first_twd = first_row['Twd_deg']
                        first_lat = first_row['Lat_dd']
                        first_lon = first_row['Lng_dd']
                        
                        last_lat = last_row['Lat_dd']
                        last_lon = last_row['Lng_dd']
                        
                        bearing = angle360_normalize(bearing_from_latlng(first_lat, first_lon, last_lat, last_lon))
                        
                        if abs(angle_subtract(bearing, first_twd)) > 90:
                            vmc_twd = angle_add(bearing, 180)
                        else:
                            vmc_twd = bearing

                        if leg == 1: 
                            if abs(angle_between(vmc_twd, first_twd)) > 45:
                                vmc_twd = first_twd
                        else:
                            if abs(angle_between(vmc_twd, p_vmc_twd)) > 20:
                                vmc_twd = p_vmc_twd
      
                        df.loc[(df['Race_number'] == race) & (df['Leg_number'] == leg), 'Vmc_Twd'] = vmc_twd
                        
                        p_vmc_twd = vmc_twd
                else:
                    df.loc[(df['Race_number'] == race) & (df['Leg_number'] == leg), 'Vmc_Twd'] = 0
        else:
            df.loc[(df['Race_number'] == race), 'Vmc_Twd'] = 0                          
    
    if len(races) > 0:
        # Vectorized VMC calculation
        mask = df['Vmc_Twd'] != 0
        if mask.any():
            # Calculate angle differences vectorized
            cog = df.loc[mask, 'Cog_deg'].values
            vmc_twd = df.loc[mask, 'Vmc_Twd'].values
            bsp = df.loc[mask, 'Bsp_kts'].values
            vmg = df.loc[mask, 'Vmg_kts'].values
            vmg_tgt = df.loc[mask, 'Vmg_tgt_kts'].values
            
            # Vectorized angle_between equivalent
            diff = ((cog - vmc_twd) + 180) % 360 - 180
            cwa = np.abs(diff)
            
            # Vectorized VMC calculation
            vmc = np.abs(np.cos(np.radians(cwa)) * bsp)
            # Safe division: avoid division by zero
            vmg_abs = np.abs(vmg)
            vmc_ratio = np.divide(np.abs(vmc), vmg_abs, out=np.zeros_like(vmc), where=vmg_abs != 0)
            vmc_ratio = np.where(vmc_ratio > 2, 2, vmc_ratio)
            # Safe division: avoid division by zero
            vmc_perc = np.divide(vmc, vmg_tgt, out=np.zeros_like(vmc), where=vmg_tgt != 0) * 100
            
            df.loc[mask, 'Vmc_kts'] = vmc
            df.loc[mask, 'Vmc_ratio'] = vmc_ratio
            df.loc[mask, 'Vmc_perc'] = vmc_perc
        
        # Set default values for rows where Vmc_Twd == 0
        mask_zero = df['Vmc_Twd'] == 0
        if mask_zero.any():
            df.loc[mask_zero, 'Vmc_kts'] = 0
            df.loc[mask_zero, 'Vmc_ratio'] = 1
    
    return df