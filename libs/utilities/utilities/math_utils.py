import math as m
import numpy as np
import re
from typing import List, Union
from math import radians
from scipy.optimize import least_squares
from scipy.signal import butter, filtfilt

mps = 0.514444

def polar_to_vec(speed, angle_deg):
    a = radians(angle_deg)
    return np.array([speed * np.cos(a), speed * np.sin(a)])

def vec_to_dir_deg(v):
    return (np.degrees(np.arctan2(v[1], v[0])) + 360) % 360

def wrap180(angle):
    return ((angle + 180) % 360) - 180

def ema(series, alpha): #exponential filter
    s = np.zeros_like(series, dtype=float)
    s[0] = series[0]
    for i in range(1, len(series)):
        s[i] = alpha * series[i] + (1 - alpha) * s[i-1]
    return s

def ewm360(series, alpha, adjust=False):
    """
    Exponential weighted moving average for circular angles (0-360 degrees).
    
    This function properly handles circular averaging by converting angles to
    sin/cos components, applying EWM to each component separately, then converting
    back to angles. This prevents incorrect averaging when angles wrap around
    the 0/360 boundary (e.g., averaging 359° and 1° should give 0°, not 180°).
    
    Args:
        series: Array-like of angles in degrees (0-360)
        alpha: Smoothing factor (0 < alpha <= 1). Higher values = less smoothing.
        adjust: If True, divides by decaying adjustment factor (pandas EWM behavior)
    
    Returns:
        Array of smoothed angles in degrees (0-360)
    """
    import pandas as pd
    
    # Convert to radians and compute sin/cos components
    angles_rad = np.radians(series)
    sin_vals = np.sin(angles_rad)
    cos_vals = np.cos(angles_rad)
    
    # Apply EWM to sin and cos components separately
    sin_series = pd.Series(sin_vals)
    cos_series = pd.Series(cos_vals)
    
    sin_ewm = sin_series.ewm(alpha=alpha, adjust=adjust).mean()
    cos_ewm = cos_series.ewm(alpha=alpha, adjust=adjust).mean()
    
    # Convert back to angles using atan2
    result_rad = np.arctan2(sin_ewm.values, cos_ewm.values)
    result_deg = np.degrees(result_rad)
    
    # Normalize to 0-360 range
    result_deg = (result_deg + 360) % 360
    
    return result_deg

def zero_phase_lowpass(x, cutoff_hz, fs_hz, order=2):
    nyq = 0.5 * fs_hz
    Wn = cutoff_hz / nyq
    b, a = butter(order, Wn, btype="low")
    return filtfilt(b, a, x)

def zero_phase_angle(angle_deg, cutoff_hz, fs_hz):
    rad = np.radians(angle_deg)
    x = np.cos(rad)
    y = np.sin(rad)
    x_s = zero_phase_lowpass(x, cutoff_hz, fs_hz)
    y_s = zero_phase_lowpass(y, cutoff_hz, fs_hz)
    return (np.degrees(np.arctan2(y_s, x_s)) + 360) % 360

def residuals(params, hdg, cog, sog, tack, ride, lam=0.01):
    """
    Residual function for solving current and leeway from boat motion on opposite tacks.
    
    Leeway sign convention:
    - tack[i] = +1 for starboard tack (TWA >= 0), -1 for port tack (TWA < 0)
    - Li = tack[i] * Li_mag ensures raw leeway has opposite signs on opposite tacks
    - On starboard: positive leeway = drifting to port (left)
    - On port: negative leeway = drifting to port (left) - same physical behavior, opposite sign
    - This matches the convention: leeway = Hdg - COG (or Hdg - COW after current correction)
    """
    cx, cy, L0_deg, k_deg_per_h = params[:4]
    vb = params[4:]
    c = np.array([cx, cy])
    h_ref = np.mean(ride)

    res = []
    for i in range(len(hdg)):
        g = polar_to_vec(sog[i], cog[i])
        # Li = tack[i] * (L0_deg + k_deg_per_h * (ride[i] - h_ref))

        # User request: "reduce the sign on that effect"
        # Original: Li_mag = L0_deg + k_deg_per_h * (ride[i] - h_ref)
        # We will negate k to flip the sign/effect as requested.
        Li_mag = L0_deg - k_deg_per_h * (ride[i] - h_ref)
        Li = tack[i] * Li_mag

        b_dir = hdg[i] + Li

        b = polar_to_vec(vb[i], b_dir)
        r = g - (b + c)
        res.extend(r.tolist())

    # regularize current magnitude
    res.append(lam * cx)
    res.append(lam * cy)
    return np.array(res)

def solve_window(hdg, cog, sog, tack, ride):
    N = len(hdg)
    x0 = np.zeros(4 + N)
    x0[2] = 2.0      # baseline leeway guess
    x0[3] = 0.0      # ride-height sensitivity guess
    x0[4:] = sog     # vb guess

    result = least_squares(
        residuals,
        x0,
        args=(hdg, cog, sog, tack, ride),
        max_nfev=200,
    )
    cx, cy, L0, k = result.x[:4]
    return cx, cy, L0, k

def poly_trend(df, col, degree=3, is_angle=False):
    """
    Replace df[col] with a polynomial trend (default: cubic) from start to end.

    Args:
        df (pd.DataFrame): Input dataframe
        col (str): Column name to trend
        degree (int): Polynomial degree (1 = linear, 2 = quadratic, 3 = cubic, etc.)
        is_angle (bool): Whether the column is angular (0–360 wrap)

    Returns:
        pd.DataFrame: df with df[col] overwritten by its polynomial trend
    """

    x = df[col].to_numpy()
    t = np.arange(len(df), dtype=float)

    # Angular case: fit polynomial in vector space
    if is_angle:
        rad = np.radians(x)
        vx = np.cos(rad)
        vy = np.sin(rad)

        # Fit polynomial to each component
        px = np.polyfit(t, vx, degree)
        py = np.polyfit(t, vy, degree)

        vx_fit = np.polyval(px, t)
        vy_fit = np.polyval(py, t)

        ang_fit = (np.degrees(np.arctan2(vy_fit, vx_fit)) + 360) % 360
        df[col] = ang_fit
        return df

    # Linear data: direct polynomial fit
    p = np.polyfit(t, x, degree)
    df[col] = np.polyval(p, t)
    return df


def linear_trend(df, col, is_angle=False):
    """
    Replace df[col] with a global linear trend from start to end of the file.

    Args:
        df (pd.DataFrame): Input dataframe
        col (str): Column name to trend
        is_angle (bool): Whether the column is angular (0–360 wrap)

    Returns:
        pd.DataFrame: df with df[col] overwritten by its linear trend
    """

    x = df[col].to_numpy()

    # Time axis (0 ... N-1)
    t = np.arange(len(df), dtype=float)

    # Angular case: fit in vector space
    if is_angle:
        rad = np.radians(x)
        vx = np.cos(rad)
        vy = np.sin(rad)

        ax, bx = np.polyfit(t, vx, 1)
        ay, by = np.polyfit(t, vy, 1)

        vx_fit = ax * t + bx
        vy_fit = ay * t + by

        ang_fit = (np.degrees(np.arctan2(vy_fit, vx_fit)) + 360) % 360
        df[col] = ang_fit
        return df

    # Linear case
    a, b = np.polyfit(t, x, 1)
    df[col] = a * t + b
    return df


def get_even_integer(number: Union[int, float]) -> int:
    """
    Extract the nearest even integer from number.

    Args:
        number (float): Number to convert

    Returns:
        int: The nearest even integer value.
    """
    # Find the two closest even integers (floor and ceil)
    lower_even = m.floor(number / 2) * 2
    upper_even = lower_even + 2

    # Compare which is closer
    if abs(number - lower_even) <= abs(number - upper_even):
        return lower_even
    else:
        return upper_even


def get_numeric_values(string: str) -> float:
    """
    Extract numeric values from a string.

    Args:
        string (str): The string to extract numeric values from.

    Returns:
        float: The extracted numeric value.
    """
    number = re.findall(r"[-+]?\d*\.\d+|\d+", string)
    return float(''.join(number))

def is_float(v: Union[str, int, float]) -> bool:
    """
    Check if a value can be converted to a float.

    Args:
        v: The value to check.

    Returns:
        bool: True if the value can be converted to a float, False otherwise.
    """
    try:
        float(str(v))
        return True
    except ValueError:
        return False

def integer(val: Union[str, int, float, None]) -> int:
    """
    Convert a value to an integer.

    Args:
        val: The value to convert.

    Returns:
        int: The converted integer value, or 0 if conversion fails.
    """
    try:
        return int(val) if val is not None else 0
    except ValueError:
        return 0

def number(val: Union[str, int, float, None]) -> float:
    """
    Convert a value to a float.

    Args:
        val: The value to convert.

    Returns:
        float: The converted float value, or 0.0 if conversion fails.
    """
    if val is None:
        return 0.0
    
    # Handle string input by trying to extract numeric values
    if isinstance(val, str):
        val = val.strip()
        if not val:
            return 0.0
        # Try to extract numeric values from the string
        try:
            # First try direct conversion
            value = float(val)
        except ValueError:
            # If that fails, try to extract numeric values using regex
            try:
                numeric_matches = re.findall(r"[-+]?\d*\.?\d+", val)
                if numeric_matches:
                    value = float(numeric_matches[0])
                else:
                    return 0.0
            except (ValueError, IndexError):
                return 0.0
    else:
        try:
            value = float(val)
        except (ValueError, TypeError):
            return 0.0
    
    # Return the value if it's finite, otherwise return 0.0
    return value if m.isfinite(value) else 0.0

def sign(val: Union[int, float]) -> int:
    """
    Get the sign of a value.

    Args:
        val: The value to check.

    Returns:
        int: 1 if the value is positive, 0 otherwise.
    """
    return 1 if val > 0 else 0

def aav(data: List[float], freq: int) -> float:
    """
    Calculate the average absolute value of a list of numbers.

    Args:
        data (list): The list of numbers.
        freq (int): The frequency.

    Returns:
        float: The average absolute value.
    """
    try:
        s = sum(abs(d - pd) for i, (d, pd) in enumerate(zip(data, [data[0]] + data[:-1])))
        return float(s / (len(data) / freq))
    except (ZeroDivisionError, ValueError, TypeError, IndexError):
        return 0

def rtvr(data: List[float], freq: int, percentile: float = 90.0) -> float:
    """
    Calculate the Robust Total Variation (rTVR) metric.
    
    rTVR measures the variability in a signal while being robust to outliers
    by using percentile-based thresholding instead of all variations.

    Args:
        data (list): The list of numbers.
        freq (int): The frequency (samples per unit time).
        percentile (float): Percentile threshold for robustness (default: 90.0).
                          Values above this percentile are capped.

    Returns:
        float: The robust total variation metric.
    """
    try:
        if len(data) < 2:
            return 0.0
        
        # Calculate absolute differences between consecutive points
        variations = [abs(d - pd) for d, pd in zip(data[1:], data[:-1])]
        
        if not variations:
            return 0.0
        
        # Calculate the percentile threshold for robustness
        sorted_variations = sorted(variations)
        threshold_idx = int(len(sorted_variations) * (percentile / 100.0))
        threshold = sorted_variations[min(threshold_idx, len(sorted_variations) - 1)]
        
        # Cap variations at the threshold (robustness to outliers)
        capped_variations = [min(v, threshold) for v in variations]
        
        # Calculate the robust total variation normalized by frequency
        total_variation = sum(capped_variations)
        return float(total_variation / (len(data) / freq))
    except (ZeroDivisionError, ValueError, TypeError, IndexError):
        return 0.0

def mean360(data: List[float]) -> float:
    """
    Calculate the mean angle in degrees.

    Args:
        data (list): The list of angles in degrees.

    Returns:
        float: The mean angle in degrees.
    """
    try:
        sin_sum = sum(m.sin(d * (m.pi / 180)) for d in data)
        cos_sum = sum(m.cos(d * (m.pi / 180)) for d in data)
        return angle360_normalize(m.atan2(sin_sum, cos_sum) * (180 / m.pi))
    except (ValueError, TypeError, ZeroDivisionError):
        return 0

def std360(data: List[float]) -> float:
    """
    Calculate the standard deviation of angles in degrees.

    Args:
        data (list): The list of angles in degrees.

    Returns:
        float: The standard deviation of the angles.
    """
    try:
        sin_sum = sum(m.sin(d * (m.pi / 180)) for d in data)
        cos_sum = sum(m.cos(d * (m.pi / 180)) for d in data)
        mean_angle = m.atan2(sin_sum, cos_sum)
        squared_deviations = [(m.atan2(m.sin(d * (m.pi / 180)) - m.sin(mean_angle), 
                                       m.cos(d * (m.pi / 180)) - m.cos(mean_angle)))**2
                              for d in data]
        variance = sum(squared_deviations) / len(data)
        return m.sqrt(variance)
    except (ValueError, TypeError, ZeroDivisionError):
        return 0

def linear_interp(x0: float, y0: float, x1: float, y1: float, x: float) -> float:
    """
    Perform linear interpolation.

    Args:
        x0 (float): The first x-coordinate.
        y0 (float): The first y-coordinate.
        x1 (float): The second x-coordinate.
        y1 (float): The second y-coordinate.
        x (float): The x-coordinate to interpolate.

    Returns:
        float: The interpolated y-coordinate.
    """
    try:
        return y0 * (x - x1) / (x0 - x1) + y1 * (x - x0) / (x1 - x0)
    except (ZeroDivisionError, ValueError, TypeError):
        return 0

def angle_between(first: float, second: float) -> float:
    """
    Calculate the absolute difference between two angles.

    Args:
        first (float): The first angle.
        second (float): The second angle.

    Returns:
        float: The absolute difference between the two angles.
    """
    try:
        first = float(first)
        second = float(second)
        between = ((first - second) + 180) % 360 - 180
        return abs(between)
    except ValueError:
        return 0

def angle_subtract(first: float, second: float) -> float:
    """
    Subtract two angles and normalize the result to the range [-180, 180].

    Args:
        first (float): The first angle.
        second (float): The second angle.

    Returns:
        float: The normalized result of the subtraction.
    """
    try:
        first = float(first)
        second = float(second)
        result = ((first - second) + 180) % 360 - 180
        return 180 if result == -180 else result
    except ValueError:
        return 0

def angle_add(first: float, second: float) -> float:
    """
    Add two angles and normalize the result to the range [0, 360).

    Args:
        first (float): The first angle.
        second (float): The second angle.

    Returns:
        float: The normalized result of the addition.
    """
    try:
        first = float(first)
        second = float(second)
        result = (first + second) % 360
        return result
    except ValueError:
        return 0

def angle360_normalize(angle: float) -> float:
    """
    Normalize an angle to the range [0, 360).

    Args:
        angle (float): The angle to normalize.

    Returns:
        float: The normalized angle.
    """
    try:
        return angle % 360
    except TypeError:
        return 0

def angle180_normalize(angle: float) -> float:
    """
    Normalize an angle to the range [-180, 180].

    Args:
        angle (float): The angle to normalize.

    Returns:
        float: The normalized angle.
    """
    try:
        angle = angle % 360
        if angle > 180:
            angle -= 360
        elif angle <= -180:
            angle += 360
        return angle
    except TypeError:
        return 0
    
def add_vectors(mag1: float, dir1: float, mag2: float, dir2: float) -> tuple[float, float]:
    # Convert angles from degrees to radians
    dir1_rad = m.radians(dir1)
    dir2_rad = m.radians(dir2)

    # Calculate the components of the vectors
    x1 = mag1 * m.cos(dir1_rad)
    y1 = mag1 * m.sin(dir1_rad)
    x2 = mag2 * m.cos(dir2_rad)
    y2 = mag2 * m.sin(dir2_rad)

    # Add the vectors
    resultant_x = x1 + x2
    resultant_y = y1 + y2

    # Calculate the magnitude and direction of the resultant vector
    resultant_mag = m.sqrt(resultant_x**2 + resultant_y**2)
    resultant_dir = m.degrees(m.atan2(resultant_y, resultant_x))

    return resultant_mag, resultant_dir

def subtract_vectors(mag1: float, dir1: float, mag2: float, dir2: float) -> tuple[float, float]:
    # Convert angles from degrees to radians
    dir1_rad = m.radians(dir1)
    dir2_rad = m.radians(dir2)

    # Calculate the components of the vectors
    x1 = mag1 * m.cos(dir1_rad)
    y1 = mag1 * m.sin(dir1_rad)
    x2 = mag2 * m.cos(dir2_rad)
    y2 = mag2 * m.sin(dir2_rad)

    # Add the vectors
    resultant_x = x1 - x2
    resultant_y = y1 - y2

    # Calculate the magnitude and direction of the resultant vector
    resultant_mag = m.sqrt(resultant_x**2 + resultant_y**2)
    resultant_dir = m.degrees(m.atan2(resultant_y, resultant_x))

    return resultant_mag, resultant_dir

def residuals_avg(params, g_p, h_p, g_s, h_s, rh_p, rh_s, rh_k, lam):
    """
    Residuals for 2-point average solver.
    params: [cx, cy, l_base, stw]
    """
    cx, cy, l_base, stw = params
    c = np.array([cx, cy])
    
    # Calculate ride height mean to center the effect
    rh_mean = (rh_p + rh_s) / 2.0
    
    # Port tack (tack = -1)
    # Effect: Higher ride height -> More leeway magnitude
    # We use a fixed k (rh_k)
    l_mag_p = l_base + rh_k * (rh_p - rh_mean)
    
    # Li = -1 * l_mag (Standard convention: Port tack has negative leeway)
    li_p = -l_mag_p
    b_dir_p = h_p + li_p
    b_p = polar_to_vec(stw, b_dir_p)
    err_p = g_p - (b_p + c)
    
    # Stbd tack (tack = 1)
    # Effect: Higher ride height -> More leeway magnitude
    l_mag_s = l_base + rh_k * (rh_s - rh_mean)
    
    # Li = 1 * l_mag (Standard convention: Stbd tack has positive leeway)
    li_s = l_mag_s
    b_dir_s = h_s + li_s
    b_s = polar_to_vec(stw, b_dir_s)
    err_s = g_s - (b_s + c)
    
    # Regularization
    reg = np.array([lam * cx, lam * cy])
    
    return np.concatenate([err_p, err_s, reg])

def solve_from_averages(hdg_p, cog_p, sog_p, rh_p, hdg_s, cog_s, sog_s, rh_s, rh_k=0.0, lam=0.2):
    """
    Solve for current, leeway, and STW using average values from Port and Starboard tacks.
    
    Args:
        hdg_p, cog_p, sog_p, rh_p: Averages for Port tack (Navigation + Ride Height)
        hdg_s, cog_s, sog_s, rh_s: Averages for Starboard tack (Navigation + Ride Height)
        rh_k: Sensitivity of leeway to ride height (deg/mm). Fixed coefficient.
        lam: Regularization parameter for current magnitude (damping)
        
    Returns:
        tuple: (cx, cy, l_base, stw)
        Note: l_base is the baseline leeway magnitude at the average ride height.
    """
    # Ground vectors
    g_p = polar_to_vec(sog_p, cog_p)
    g_s = polar_to_vec(sog_s, cog_s)
    
    # Initial guess
    # Cx, Cy = 0, 0
    # L_base = 2.0 (Baseline drift magnitude)
    # STW = average SOG
    x0 = np.array([0.0, 0.0, 2.0, (sog_p + sog_s) / 2.0])
    
    result = least_squares(
        residuals_avg,
        x0,
        args=(g_p, hdg_p, g_s, hdg_s, rh_p, rh_s, rh_k, lam),
        ftol=1e-4,
        xtol=1e-4,
        max_nfev=100
    )
    
    return result.x
