import numpy as np
import pandas as pd
from .logging_utils import log_warning
from typing import Optional, Tuple

def haversine_m(df, lat_col="lat", lon_col="lon"):
    """Vectorized haversine distance in meters between consecutive points."""
    lat1 = np.deg2rad(df[lat_col])
    lon1 = np.deg2rad(df[lon_col])
    lat2 = lat1.shift(1)
    lon2 = lon1.shift(1)

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = np.sin(dlat/2)**2 + np.cos(lat1)*np.cos(lat2)*np.sin(dlon/2)**2
    c = 2 * np.arcsin(np.sqrt(a))
    return 6371000 * c  # Earth radius in meters

def filter_impossible_acceleration(
    df,
    ts_col="timestamp",
    lat_col="lat",
    lon_col="lon",
    accel_threshold=15.0,   # m/s² (tune for your sport)
    smoothing_window=5,
    drop_intermediates=True
):
    """
    Detect and remove GPS glitches using impossible acceleration.
    Works perfectly for 10Hz data derived from 1Hz GPS (triangle spikes).
    """

    # --- 1. Compute dt (seconds) directly from epoch timestamps ---
    df["_dt"] = df[ts_col].diff()

    # --- 2. Compute distance between points ---
    df["_dist_m"] = haversine_m(df, lat_col, lon_col)

    # --- 3. Compute speed (m/s) ---
    df["_speed_mps"] = df["_dist_m"] / df["_dt"]

    # --- 4. Compute acceleration (m/s²) ---
    df["_accel_mps2"] = df["_speed_mps"].diff() / df["_dt"]

    # --- 5. Detect impossible acceleration ---
    mask = df["_accel_mps2"].abs() > accel_threshold

    # --- 6. Mask lat/lon where acceleration is impossible ---
    df["_lat_clean"] = df[lat_col].mask(mask)
    df["_lon_clean"] = df[lon_col].mask(mask)

    # --- 7. Forward-fill to avoid NaN cascades ---
    df["_lat_clean"] = df["_lat_clean"].ffill()
    df["_lon_clean"] = df["_lon_clean"].ffill()

    # --- 8. Smooth the cleaned signal ---
    df[lat_col] = df["_lat_clean"].rolling(smoothing_window, min_periods=1).mean()
    df[lon_col] = df["_lon_clean"].rolling(smoothing_window, min_periods=1).mean()

    # --- 9. Cleanup ---
    if drop_intermediates:
        df.drop(columns=[
            "_dt", "_dist_m", "_speed_mps", "_accel_mps2",
            "_lat_clean", "_lon_clean"
        ], inplace=True)

    return df


def rolling_median_latlon_filter(
    df,
    lat_col="lat",
    lon_col="lon",
    window=11,                 # ~1 second at 10 Hz
    deviation_threshold=0.0003,  # ~30 m (tune as needed)
    smoothing_window=5,
    drop_intermediates=True
):
    """
    Remove GPS spikes (including 1-second triangular ramps) using a rolling median
    and deviation threshold. Fully vectorized and tail-safe.
    """

    # --- 1. Rolling median (non-centered to avoid tail distortion) ---
    df["_lat_med"] = df[lat_col].rolling(window, center=False, min_periods=1).median()
    df["_lon_med"] = df[lon_col].rolling(window, center=False, min_periods=1).median()

    # --- 2. Deviation from median ---
    df["_lat_dev"] = (df[lat_col] - df["_lat_med"]).abs()
    df["_lon_dev"] = (df[lon_col] - df["_lon_med"]).abs()

    # --- 3. Mask outliers ---
    mask = (df["_lat_dev"] > deviation_threshold) | (df["_lon_dev"] > deviation_threshold)
    df["_lat_clean"] = df[lat_col].mask(mask)
    df["_lon_clean"] = df[lon_col].mask(mask)

    # --- 4. Forward-fill to avoid NaN cascades at the tail ---
    df["_lat_clean"] = df["_lat_clean"].ffill()
    df["_lon_clean"] = df["_lon_clean"].ffill()

    # --- 5. Smooth the cleaned signal ---
    df[lat_col] = df["_lat_clean"].rolling(smoothing_window, min_periods=1).mean()
    df[lon_col] = df["_lon_clean"].rolling(smoothing_window, min_periods=1).mean()

    # --- 6. Cleanup ---
    if drop_intermediates:
        df.drop(columns=[
            "_lat_med", "_lon_med",
            "_lat_dev", "_lon_dev",
            "_lat_clean", "_lon_clean"
        ], inplace=True)

    return df

def rolling_mean_and_shift_angle(
    df: pd.DataFrame,
    input_col: str,
    output_col: str,
    smoothing_window: int,
    offset_window: int,
    drop_intermediates: bool = True,
    angle_range: str = "360"
) -> pd.DataFrame:

    sin_col = f"{output_col}_sin"
    cos_col = f"{output_col}_cos"
    smoothed_col = f"{output_col}_smoothed"

    # 1. Normalize angles
    if angle_range == "180":
        angles = ((df[input_col] + 180) % 360) - 180
    else:
        angles = df[input_col] % 360

    radians = np.deg2rad(angles)

    # 2. Store sin/cos
    df.loc[:, sin_col] = np.sin(radians)
    df.loc[:, cos_col] = np.cos(radians)

    # 3. Smooth sin/cos
    sin_smooth = (
        df[sin_col]
        .rolling(window=smoothing_window, min_periods=1, center=False)
        .mean()
        .ffill()
        .bfill()
    )

    cos_smooth = (
        df[cos_col]
        .rolling(window=smoothing_window, min_periods=1, center=False)
        .mean()
        .ffill()
        .bfill()
    )

    # 4. Convert back to angle
    angle_result = np.rad2deg(np.arctan2(sin_smooth, cos_smooth))

    # 5. Normalize output
    if angle_range == "180":
        df.loc[:, smoothed_col] = angle_result
    else:
        df.loc[:, smoothed_col] = angle_result % 360

    # 6. Shift
    df.loc[:, output_col] = df[smoothed_col].shift(offset_window)

    # 7. Tail clamp
    last_idx = df.index[-1]
    df.loc[last_idx, output_col] = df.loc[last_idx, smoothed_col]

    # 8. Cleanup
    if drop_intermediates:
        df.drop(columns=[sin_col, cos_col, smoothed_col], inplace=True, errors="ignore")

    return df

def rolling_mean_and_shift(
    df: pd.DataFrame,
    input_col: str,
    output_col: str,
    smoothing_window: int,
    offset_window: int,
    drop_intermediates: bool = True
) -> pd.DataFrame:

    smoothed_col = f"{output_col}_smoothed"

    # 1. Rolling mean (non-centered)
    df.loc[:, smoothed_col] = (
        df[input_col]
        .rolling(window=smoothing_window, min_periods=1, center=False)
        .mean()
    )

    # 2. Fill to avoid NaNs
    df.loc[:, smoothed_col] = df[smoothed_col].ffill().bfill()

    # 3. Shift
    df.loc[:, output_col] = df[smoothed_col].shift(offset_window)

    # 4. Tail clamp
    last_idx = df.index[-1]
    df.loc[last_idx, output_col] = df.loc[last_idx, smoothed_col]

    # 5. Cleanup
    if drop_intermediates:
        df.drop(columns=[smoothed_col], inplace=True, errors="ignore")

    return df

def interpolate_twa(tws: float, boat_speed: float, target_twa: float, data: np.ndarray) -> Optional[float]:
    """
    Interpolate True Wind Angle (TWA) based on True Wind Speed and boat speed.
    
    This function performs 2D interpolation on polar data to find the TWA that 
    corresponds to given TWS and boat speed, considering only TWA values within 
    20 degrees of the target.
    
    Args:
        tws (float): True Wind Speed in knots
        boat_speed (float): Current boat speed in knots
        target_twa (float): Target True Wind Angle in degrees for filtering
        data (np.ndarray): Polar data array where first column is TWS values,
                          subsequent columns alternate between velocity and TWA
    
    Returns:
        float or None: Interpolated TWA in degrees, or None if no valid 
                      interpolation found or boat speed exceeds polar limits
    """
    # Extract TWS values from the first column
    tws_values = data[:, 0]
    
    # Find nearest TWS values for interpolation
    lower_idx = np.searchsorted(tws_values, tws) - 1
    upper_idx = lower_idx + 1
    
    if lower_idx < 0:
        lower_idx = 0
    if upper_idx >= len(tws_values):
        upper_idx = len(tws_values) - 1
    
    # Interpolate boat speed and TWA for the given TWS
    interp_twa_values = []
    interp_boat_speeds = []
    for i in range(1, data.shape[1], 2):  # Iterate over velocity (v) and TWA (a) columns
        v_lower = data[lower_idx, i]
        a_lower = data[lower_idx, i + 1]
        v_upper = data[upper_idx, i]
        a_upper = data[upper_idx, i + 1]
        
        # Linear interpolation for velocity and TWA
        v_interp = np.interp(tws, [tws_values[lower_idx], tws_values[upper_idx]], [v_lower, v_upper])
        a_interp = np.interp(tws, [tws_values[lower_idx], tws_values[upper_idx]], [a_lower, a_upper])

        # Only consider TWA values within 20 degrees of target
        if abs(a_interp - target_twa) <= 20:
            interp_boat_speeds.append(v_interp)
            interp_twa_values.append(a_interp)
    
    if not interp_boat_speeds:
        log_warning("No valid boat speed found within constraints.")
        return None  # No valid interpolation found within constraints
    
    # Limit extrapolation: if boat speed is higher than max in the interpolated range, return None
    max_boat_speed = max(interp_boat_speeds)
    if boat_speed > max_boat_speed:
        log_warning(f"Boat speed {boat_speed} is higher than max interpolated speed {max_boat_speed}, returning None.")
        return None
    
    # Interpolate TWA for the given boat speed
    twa_interp = np.interp(boat_speed, interp_boat_speeds, interp_twa_values)

    return twa_interp

def read_polar_data(filename: str) -> np.ndarray:
    """
    Read polar performance data from a tab-separated file.
    
    Reads sailing polar data where the first row is typically headers and 
    subsequent rows contain numerical performance data.
    
    Args:
        filename (str): Path to the polar data file (tab-separated format)
    
    Returns:
        np.ndarray: 2D array containing polar data with TWS in first column
                   and alternating velocity/angle pairs in subsequent columns
    """
    with open(filename, 'r') as file:
        lines = file.readlines()
    
    # Read numerical data
    data = np.array([list(map(float, line.strip().split('\t'))) for line in lines[1:]])
    
    return data

def read_target_data(filename: str) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Read target performance data from a tab-separated file.
    
    Reads performance target data containing TWS, BSP (Boat Speed), TWA, and VMG values.
    Expected file format: TWS, BSP, TWA, VMG columns with headers in first row.
    
    Args:
        filename (str): Path to the target data file (tab-separated format)
    
    Returns:
        tuple: (tws_values, bsp_values, twa_values, vmg_values)
            - tws_values (np.ndarray): True Wind Speed values
            - bsp_values (np.ndarray): Boat Speed values  
            - twa_values (np.ndarray): True Wind Angle values
            - vmg_values (np.ndarray): Velocity Made Good values
    """
    with open(filename, 'r') as file:
        lines = file.readlines()

    # Read numerical data (skip header)
    data = np.array([list(map(float, line.strip().split('\t'))) for line in lines[1:]])
    
    # Extract columns
    tws_values = data[:, 0]
    bsp_values = data[:, 1]
    twa_values = data[:, 2]
    vmg_values = data[:, 3]
    lwy_values = data[:, 4]
    
    return tws_values, bsp_values, twa_values, vmg_values, lwy_values

def interpolate_lwy(tws_input: float, twa_input: float, tws_values: np.ndarray, twa_values: np.ndarray, lwy_values: np.ndarray) -> Optional[float]:
    """
    Interpolate Leeway given TWS and TWA.
    
    Args:
        tws_input (float): TWS in knots
        twa_input (float): True Wind Angle in degrees
        tws_values (np.ndarray): Array of True Wind Speed values
        twa_values (np.ndarray): Array of True Wind Angle values  
        lwy_values (np.ndarray): Array of Leeway values
    
    Returns:
        float or None: Interpolated LWY
    
    Note:
        Uses upwind data if TWA < 90°, downwind data if TWA > 90°
    """
    if twa_input < 90:
        mask = twa_values < 90  # Use upwind data
    else:
        mask = twa_values > 90  # Use downwind data

    if not np.any(mask):
        log_warning(f"No matching data for TWA {twa_input}.")
        return None

    # Filter TWS and VMG based on the upwind/downwind mask
    tws_filtered = tws_values[mask]
    lwy_filtered = lwy_values[mask]

    # Ensure TWS is within bounds to prevent extrapolation
    if tws_input < min(tws_filtered) or tws_input > max(tws_filtered):
        log_warning(f"TWS {tws_input} is out of range. Returning 0.")
        return 0  

    # Interpolate TWS for the given VMG
    lwy_interp = np.interp(tws_input, tws_filtered, lwy_filtered)

    return lwy_interp

def interpolate_tws(type: str, input: float, twa_input: float, tws_values: np.ndarray, twa_values: np.ndarray, input_values: np.ndarray) -> Optional[float]:
    """
    Interpolate True Wind Speed based on VMG and TWA.
    
    Determines the TWS that would produce the given VMG at the specified TWA.
    Automatically selects upwind or downwind data based on TWA value.
    
    Args:
        input (float): Target in knots
        twa_input (float): True Wind Angle in degrees
        tws_values (np.ndarray): Array of True Wind Speed values
        twa_values (np.ndarray): Array of True Wind Angle values  
        input_values (np.ndarray): Array of Target values
    
    Returns:
        float or None: Interpolated TWS in knots, 0 if out of range, 
                      or None if no matching data found
    
    Note:
        Uses upwind data if TWA < 90°, downwind data if TWA > 90°
    """
    if twa_input < 90:
        mask = twa_values < 90  # Use upwind data
    else:
        mask = twa_values > 90  # Use downwind data

    if not np.any(mask):
        log_warning(f"No matching data for TWA {twa_input}.")
        return None

    # Filter TWS and VMG based on the upwind/downwind mask
    tws_filtered = tws_values[mask]
    input_filtered = input_values[mask]

    # Ensure TWS is within bounds to prevent extrapolation
    if input < min(input_filtered) or input > max(input_filtered):
        log_warning(f"{type} {input} is out of range. Returning 0.")
        return 0  

    # Interpolate TWS for the given VMG
    tws_interp = np.interp(input, input_filtered, tws_filtered)

    return tws_interp

def interpolate_vmg(tws_input: float, twa_input: float, tws_values: np.ndarray, twa_values: np.ndarray, vmg_values: np.ndarray) -> Optional[float]:
    """
    Interpolate Velocity Made Good based on TWS and TWA.
    
    Determines the expected VMG for given wind conditions and sailing angle.
    Automatically selects upwind or downwind data based on TWA value.
    
    Args:
        tws_input (float): True Wind Speed in knots
        twa_input (float): True Wind Angle in degrees
        tws_values (np.ndarray): Array of True Wind Speed values
        twa_values (np.ndarray): Array of True Wind Angle values
        vmg_values (np.ndarray): Array of VMG values
    
    Returns:
        float or None: Interpolated VMG in knots, 0 if out of range,
                      or None if no matching data found
    
    Note:
        Uses upwind data if TWA < 90°, downwind data if TWA > 90°
    """
    if twa_input < 90:
        mask = twa_values < 90  # Use upwind data
    else:
        mask = twa_values > 90  # Use downwind data

    if not np.any(mask):
        log_warning(f"No matching data for TWA {twa_input}.")
        return None

    # Filter TWS and VMG based on the upwind/downwind mask
    tws_filtered = tws_values[mask]
    vmg_filtered = vmg_values[mask]

    # Ensure TWS is within bounds to prevent extrapolation
    if tws_input < min(tws_filtered) or tws_input > max(tws_filtered):
        log_warning(f"TWS {tws_input} is out of range. Returning 0.")
        return 0  

    # Interpolate VMG for the given TWS
    vmg_interp = np.interp(tws_input, tws_filtered, vmg_filtered)

    return vmg_interp

def interpolate_bsp(tws_input: float, twa_input: float, tws_values: np.ndarray, twa_values: np.ndarray, bsp_values: np.ndarray) -> Optional[float]:
    """
    Interpolate Boat Speed based on TWS and TWA.
    
    Determines the expected boat speed for given wind conditions and sailing angle.
    Automatically selects upwind or downwind data based on TWA value.
    
    Args:
        tws_input (float): True Wind Speed in knots
        twa_input (float): True Wind Angle in degrees  
        tws_values (np.ndarray): Array of True Wind Speed values
        twa_values (np.ndarray): Array of True Wind Angle values
        bsp_values (np.ndarray): Array of Boat Speed values
    
    Returns:
        float or None: Interpolated boat speed in knots, 0 if out of range,
                      or None if no matching data found
    
    Note:
        Uses upwind data if TWA < 90°, downwind data if TWA > 90°
    """
    if twa_input < 90:
        mask = twa_values < 90  # Use upwind data
    else:
        mask = twa_values > 90  # Use downwind data

    if not np.any(mask):
        log_warning(f"No matching data for TWA {twa_input}.")
        return None

    # Filter TWS and VMG based on the upwind/downwind mask
    tws_filtered = tws_values[mask]
    bsp_filtered = bsp_values[mask]

    # Ensure TWS is within bounds to prevent extrapolation
    if tws_input < min(tws_filtered) or tws_input > max(tws_filtered):
        log_warning(f"TWS {tws_input} is out of range. Returning 0.")
        return 0  

    # Interpolate VMG for the given TWS
    bsp_interp = np.interp(tws_input, tws_filtered, bsp_filtered)

    return bsp_interp