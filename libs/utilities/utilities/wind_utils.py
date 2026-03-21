import math as m
from typing import Tuple
import pandas as pd
import numpy as np
from scipy.interpolate import UnivariateSpline
from .api_utils import resample_dataframe
from .math_utils import polar_to_vec, vec_to_dir_deg, solve_window, wrap180, zero_phase_lowpass, zero_phase_angle, poly_trend

# Import only the math functions we need to avoid circular imports
try:
    from .math_utils import angle_add, angle_subtract, solve_from_averages, mean360
except ImportError:
    # Fallback for when running as script or in certain environments
    from math_utils import angle_add, angle_subtract, solve_from_averages, mean360

def calculate_stw(hdg: float, cog: float, sog: float, lwy: float) -> float:
    """
    Estimate Speed Through Water (STW) considering leeway.
    - hdg: heading in degrees (0–360)
    - cog: course over ground in degrees (0–360)
    - sog: speed over ground in knots
    - lwy: leeway in degrees (+starboard, –port)

    Returns:
    - STW in knots
    """
    # Adjust heading by leeway to get effective heading through water
    cse = angle_add(hdg, lwy)
    
    # Compute the angle difference handling 360° wraparound
    angle_diff = angle_subtract(cog, cse)
    
    angle_diff_rad = m.radians(angle_diff)
    
    # Project SOG onto effective heading direction
    stw_knots = sog * abs(m.cos(angle_diff_rad))
    
    # Additional safety check
    stw_knots = max(0, stw_knots)  # Ensure STW is never negative
    
    return round(stw_knots, 2)

def estimate_current(df,
                          cur_rate_name="Cur_rate_est_kph",
                          cur_dir_name="Cur_dir_est_deg",
                          twa_name="Twa_deg",
                          hdg_name="Hdg_deg",
                          cog_name="Cog_deg",
                          sog_name="Sog_kph",
                          ride_height_name="RH_lwd_mm",
                          window_seconds=60,
                          min_points_per_tack=10,
                          ride_height_k=0.0,
                          speed_k=0.025,
                          upwind_twa_threshold=85,
                          downwind_twa_threshold=115):
    """
    Estimate current from boat data by comparing performance on opposite tacks.
    
    This function:
    1. Downsamples to 1Hz and smooths the data
    2. Rolls through the data finding windows with Grade > 1 on BOTH tacks
    3. Computes current vectors for each valid window (may be sparse - only 10 points in 4 hours is fine)
    4. Fits a global trend through the sparse estimates (LOWESS or linear)
    5. Upsamples back to original frequency
    
    IMPORTANT: This function creates smoothed versions of Hdg_deg and Cog_deg (with "_smooth" suffix)
    for internal use in current estimation calculations. These smoothed columns are:
    - Only created in a local resampled dataframe (df_1hz)
    - Only used internally for current estimation
    - NEVER returned or added to the input dataframe
    - NEVER affect the original Hdg_deg and Cog_deg columns
    
    The input dataframe is never modified. Only a copy is used internally, and only current
    columns (cur_rate_name, cur_dir_name) are returned.
    
    Leeway sign convention used internally:
    - Tack is determined as +1 for starboard (TWA >= 0), -1 for port (TWA < 0)
    - Leeway magnitude is multiplied by tack sign: Li = tack * Li_mag
    - This ensures raw leeway has opposite signs on opposite tacks for the same physical behavior
    - On starboard tack: positive leeway = drifting to port
    - On port tack: negative leeway = drifting to port (same physical behavior, opposite sign)
    
    Args:
        df: DataFrame with boat data (any index type, must have 'ts' column or numeric index)
        cur_rate_name: Name for output current speed column
        cur_dir_name: Name for output current direction column
        twa_name: True wind angle column name
        hdg_name: Heading column name
        cog_name: Course over ground column name
        sog_name: Speed over ground column name
        ride_height_name: Ride height column name
        window_seconds: Size of rolling window to find opposite tacks (default 120 = 2 minutes)
        min_points_per_tack: Minimum Grade > 1 points required on EACH tack for stable estimate (default 10)
        lowess_frac: LOWESS smoothing fraction 0-1, higher=smoother (default 0.5)
        ride_height_k: Sensitivity of leeway to ride height (deg/mm). Positive = higher ride height -> more leeway (default 0.0)
        speed_k: Sensitivity of leeway to boat speed (deg/knot) for speeds < 15 knots. Used instead of ride height for low-speed segments (default 0.2)
        upwind_twa_threshold: TWA threshold for upwind classification (abs(TWA) < threshold). Default 75° for high speed, 90° for low speed
        downwind_twa_threshold: TWA threshold for downwind classification (abs(TWA) > threshold). Default 125° for high speed, 90° for low speed
    
    Returns:
        DataFrame with ONLY current rate and direction columns (cur_rate_name, cur_dir_name),
        matching original index. Original dataframe columns are never modified or returned.
    """
    
    print("\n=== CURRENT ESTIMATION ===")
    
    # Maximum allowed current speed (kph) - typical ocean currents are 0-5 kph
    # For lake conditions (low speeds), use a much lower limit
    # Check mean boat speed to determine if we're in lake conditions
    if 'Bsp_kts' in df.columns:
        mean_bsp_kts = df['Bsp_kts'].mean()
    elif 'Bsp_kph' in df.columns:
        mean_bsp_kts = df['Bsp_kph'].mean() / 1.852
    elif 'Sog_kph' in df.columns:
        mean_bsp_kts = df['Sog_kph'].mean() / 1.852
    else:
        mean_bsp_kts = 20.0  # Default to high speed if unknown
    
    # Use lower maximum for lake conditions (Bsp < 15 kts)
    if mean_bsp_kts < 15:
        MAX_CURRENT_KPH = 0.5  # Lake conditions: expect very small currents (0.5 kph max)
        print(f"Lake conditions detected (mean Bsp = {mean_bsp_kts:.1f} kts): Using conservative max current = {MAX_CURRENT_KPH} kph")
    else:
        MAX_CURRENT_KPH = 5.0  # Ocean conditions: typical currents 0-5 kph
        print(f"Ocean conditions (mean Bsp = {mean_bsp_kts:.1f} kts): Using max current = {MAX_CURRENT_KPH} kph")
    
    # -----------------------------
    # 1) PREPARE DATA & DOWNSAMPLE
    # -----------------------------
    # Extract or create ts column for consistent indexing
    if 'ts' in df.columns:
        ts_values = df['ts'].values
        original_index = df.index.copy()
    elif pd.api.types.is_numeric_dtype(df.index):
        ts_values = df.index.values.astype('float64')
        original_index = df.index.copy()
    else:
        raise ValueError("DataFrame must have 'ts' column or numeric index representing timestamps")
    
    # Create working dataframe with ts as index
    # IMPORTANT: Work on a copy to ensure original dataframe is never modified
    df_work = df.copy()
    if df_work.index.name != 'ts':
        if 'ts' in df_work.columns:
            df_work = df_work.set_index('ts')
        else:
            # Index is already numeric ts
            df_work.index.name = 'ts'
    
    # Resample to 1Hz
    channel_list = [
        {'name': 'Grade', 'type': 'int'},
        {'name': twa_name, 'type': 'angle180'},
        {'name': hdg_name, 'type': 'angle360'},
        {'name': cog_name, 'type': 'angle360'},
        {'name': sog_name, 'type': 'float'},
        {'name': ride_height_name, 'type': 'float'},
    ]
    
    df_1hz = resample_dataframe(df_work, channel_list, "1s")
    
    # Convert DatetimeIndex back to ts (seconds since epoch)
    if isinstance(df_1hz.index, pd.DatetimeIndex):
        df_1hz.index = (df_1hz.index.astype('int64') // 10**9).astype('float64')
    
    # Smooth the navigation data (we're at 1Hz now)
    # IMPORTANT: These smoothed columns are ONLY for internal use in current estimation.
    # They are created with "_smooth" suffix and will NOT be returned or affect the original dataframe.
    # The original hdg_name and cog_name columns remain unchanged in df_1hz and are never modified.
    fs = 1.0
    cutoff = 1/30.0   # ~30 second time scale for smoothing at 1Hz
    
    # Create smoothed versions with explicit "_smooth" suffix - these are INTERNAL ONLY
    df_1hz["Hdg_deg_smooth"] = zero_phase_angle(df_1hz[hdg_name], cutoff, fs)
    df_1hz["Cog_deg_smooth"] = zero_phase_angle(df_1hz[cog_name], cutoff, fs)
    df_1hz["Sog_kph_smooth"] = zero_phase_lowpass(df_1hz[sog_name], cutoff, fs)
    df_1hz["tack"] = np.where(df_1hz[twa_name] >= 0, +1, -1)
    
    # Ensure original columns remain unchanged (they should be, but this is explicit)
    # The original hdg_name and cog_name columns in df_1hz are preserved and never modified
    
    print(f"Downsampled to {len(df_1hz)} points at 1Hz")
    print(f"Grade > 1: {(df_1hz['Grade'] > 1).sum()} points ({100*(df_1hz['Grade'] > 1).sum()/len(df_1hz):.1f}%)")
    print(f"Tack distribution: {df_1hz['tack'].value_counts().to_dict()}")
    
    # -----------------------------
    # 1.5) CHECK FOR LAKE CONDITIONS (SYMMETRIC LEEWAY)
    # -----------------------------
    # If leeway (Hdg - Cog) is symmetric between tacks, there's likely no current
    # Calculate simple leeway for symmetry check
    df_1hz_valid = df_1hz[df_1hz["Grade"] > 1].copy()
    if len(df_1hz_valid) > 0:
        hdg = df_1hz_valid[hdg_name].values
        cog = df_1hz_valid[cog_name].values
        simple_leeway = ((hdg - cog) + 180) % 360 - 180
        simple_leeway = np.where(simple_leeway == -180, 180, simple_leeway)
        
        # Check symmetry: compare mean leeway on port vs starboard tack
        # Filter for upwind data only: abs(twa) < 90
        twa_values = df_1hz_valid[twa_name].values
        upwind_mask = np.abs(twa_values) < 90
        
        port_mask = (df_1hz_valid["tack"] == -1) & upwind_mask
        stbd_mask = (df_1hz_valid["tack"] == 1) & upwind_mask
        
        if port_mask.sum() > 10 and stbd_mask.sum() > 10:
            port_leeway_mean = simple_leeway[port_mask].mean()
            stbd_leeway_mean = simple_leeway[stbd_mask].mean()
            
            # For symmetric leeway, port should be negative and starboard positive, roughly equal magnitude
            # Port tack leeway needs to be multiplied by -1 (or compared to -stbd) to account for sign convention
            # Symmetric means: port_leeway ≈ -stbd_leeway, or port_leeway + stbd_leeway ≈ 0
            # Check both: magnitude difference AND sign symmetry
            magnitude_diff = abs(abs(port_leeway_mean) - abs(stbd_leeway_mean))
            sign_symmetry = abs(port_leeway_mean + stbd_leeway_mean)  # Should be ~0 if symmetric
            leeway_asymmetry = max(magnitude_diff, sign_symmetry)  # Use worst case
            leeway_magnitude = (abs(port_leeway_mean) + abs(stbd_leeway_mean)) / 2.0
            
            print(f"Leeway symmetry check:")
            print(f"  Port tack mean leeway: {port_leeway_mean:.2f}°")
            print(f"  Starboard tack mean leeway: {stbd_leeway_mean:.2f}°")
            print(f"  Magnitude difference: {magnitude_diff:.2f}°")
            print(f"  Sign symmetry (port + stbd): {port_leeway_mean + stbd_leeway_mean:.2f}° (should be ~0)")
            print(f"  Combined asymmetry: {leeway_asymmetry:.2f}°")
            print(f"  Average magnitude: {leeway_magnitude:.2f}°")
            
            # If asymmetry is small (< 0.24°) and magnitude is small (< 2°), treat as lake (no current)
            # Now checks both magnitude difference AND that signs are opposite (sum ≈ 0)
            is_lake_conditions = leeway_asymmetry < 0.5 and leeway_magnitude < 2.0
            
            if is_lake_conditions:
                print(f"LAKE CONDITIONS DETECTED: Symmetric leeway suggests no significant current")
                print(f"  Using zero current for all data")
                # Return zero current for all timestamps
                result = pd.DataFrame({
                    cur_rate_name: 0.0,
                    cur_dir_name: 0.0
                }, index=original_index)
                return result
        else:
            is_lake_conditions = False
    else:
        is_lake_conditions = False
    
    # -----------------------------
    # 2) SEGMENT DATA & SOLVE
    # -----------------------------
    # Using discrete segments to estimate current
    
    valid_estimates = []
    
    # Define segments based on time
    start_ts = df_1hz.index[0]
    end_ts = df_1hz.index[-1]
    
    current_ts = start_ts
    
    print(f"Analyzing in {window_seconds}s segments...")
    
    while current_ts < end_ts:
        segment_end = current_ts + window_seconds
        
        # Select data for this segment
        mask = (df_1hz.index >= current_ts) & (df_1hz.index < segment_end)
        seg = df_1hz[mask]
        
        if len(seg) < 10:  # Skip if too few points
            current_ts += window_seconds
            continue
            
        # Filter for valid Grade (speed filtering happens per tack pair)
        # 15 kts = 27.78 kph
        min_sog_kph = 15 * 1.852
        seg_valid = seg[seg["Grade"] > 1]
        
        if len(seg_valid) < 10:
            current_ts += window_seconds
            continue
            
        # Categorize into Upwind / Downwind / Reaching
        # Thresholds are configurable based on boat speed conditions
        # High speed (Bsp >= 15): Upwind <= 75°, Downwind >= 125°
        # Low speed (Bsp < 15): Upwind < 90°, Downwind > 90°
        # Reaching: between thresholds (Ignored)
        
        abs_twa = seg_valid[twa_name].abs()
        
        is_upwind = abs_twa < upwind_twa_threshold
        is_downwind = abs_twa > downwind_twa_threshold
        
        upwind_data = seg_valid[is_upwind]
        downwind_data = seg_valid[is_downwind]
        
        # Check if we have enough points on BOTH tacks for Upwind
        uw_estimates = []
        if len(upwind_data) > 0:
            uw_port = upwind_data[upwind_data["tack"] == -1]
            uw_stbd = upwind_data[upwind_data["tack"] == 1]
            
            if len(uw_port) >= min_points_per_tack and len(uw_stbd) >= min_points_per_tack:
                # Calculate averages
                hdg_p = mean360(uw_port["Hdg_deg_smooth"])
                cog_p = mean360(uw_port["Cog_deg_smooth"])
                sog_p = uw_port["Sog_kph_smooth"].mean()
                
                hdg_s = mean360(uw_stbd["Hdg_deg_smooth"])
                cog_s = mean360(uw_stbd["Cog_deg_smooth"])
                sog_s = uw_stbd["Sog_kph_smooth"].mean()
                
                # Convert SOG to knots for the solver to keep numbers in typical range
                sog_p_kts = sog_p / 1.852
                sog_s_kts = sog_s / 1.852
                
                # ========================================================================
                # SYMMETRY CHECK: If leeway is already symmetric, no current is needed
                # ========================================================================
                # Calculate observed leeway (Hdg - Cog) for each tack
                lwy_p_obs = angle_subtract(hdg_p, cog_p)  # Observed leeway port
                lwy_s_obs = angle_subtract(hdg_s, cog_s)  # Observed leeway starboard
                
                # Check symmetry: if leeway magnitudes are similar, there's no current
                lwy_p_abs = abs(lwy_p_obs)
                lwy_s_abs = abs(lwy_s_obs)
                leeway_asymmetry = abs(lwy_p_abs - lwy_s_abs)
                leeway_magnitude_avg = (lwy_p_abs + lwy_s_abs) / 2.0
                
                # If leeway is symmetric (< 1° difference) and magnitude is small (< 3°), 
                # skip solver and use zero current (lake conditions)
                if leeway_asymmetry < 1.0 and leeway_magnitude_avg < 3.0:
                    # Symmetric leeway indicates no current - skip solver
                    cx = 0.0
                    cy = 0.0
                    uw_estimates.append((cx, cy, "symmetric-skip"))
                else:
                    # Proceed with solver only if leeway is asymmetric
                    # Determine if we should use speed-based or ride-height-based leeway
                    # Use speed-based for low speeds (< 15 knots), ride-height for high speeds (>= 15 knots)
                    avg_sog_kts = (sog_p_kts + sog_s_kts) / 2.0
                    use_speed_effect = avg_sog_kts < 15.0
                    
                    if use_speed_effect:
                        # Low-speed: Use boat speed effect instead of ride height
                        # Slower speed = higher speed_factor = more positive leeway on starboard tack
                        # Formula: (15 - sog_kts) * speed_k, clamped to non-negative
                        # If speeds are very similar, use average to avoid artificial asymmetry
                        speed_diff = abs(sog_p_kts - sog_s_kts)
                        if speed_diff < 0.5:  # Speeds within 0.5 knots - use average
                            avg_speed_factor = max(0.0, (15.0 - avg_sog_kts) * speed_k)
                            speed_factor_p = avg_speed_factor
                            speed_factor_s = avg_speed_factor
                        else:
                            speed_factor_p = max(0.0, (15.0 - sog_p_kts) * speed_k)
                            speed_factor_s = max(0.0, (15.0 - sog_s_kts) * speed_k)
                        rh_p_use = speed_factor_p
                        rh_s_use = speed_factor_s
                        rh_k_use = 1.0  # Use unity coefficient when using speed factors
                        method_used = "speed-based"
                    else:
                        # High-speed: Use ride height effect
                        rh_p_use = uw_port[ride_height_name].mean()
                        rh_s_use = uw_stbd[ride_height_name].mean()
                        rh_k_use = ride_height_k
                        method_used = "ride-height-based"
                    
                    try:
                        # Solve in knots
                        cx_kts, cy_kts, _, _ = solve_from_averages(hdg_p, cog_p, sog_p_kts, rh_p_use, hdg_s, cog_s, sog_s_kts, rh_s_use, rh_k=rh_k_use)
                        
                        # ========================================================================
                        # POST-SOLVER VALIDATION: Reject large current if leeway was symmetric
                        # ========================================================================
                        current_magnitude_kts = np.sqrt(cx_kts**2 + cy_kts**2)
                        
                        # If original leeway was symmetric but solver found large current, reject it
                        if leeway_asymmetry < 1.0 and current_magnitude_kts > 0.1:  # 0.1 kts = ~0.19 kph
                            # Original was symmetric but solver found significant current - likely spurious
                            cx_kts, cy_kts = 0.0, 0.0
                            method_used = method_used + "-rejected"
                        
                        # Convert back to kph
                        cx = cx_kts * 1.852
                        cy = cy_kts * 1.852
                        
                        uw_estimates.append((cx, cy, method_used))
                    except Exception:
                        pass

        # Check if we have enough points on BOTH tacks for Downwind
        dw_estimates = []
        if len(downwind_data) > 0:
            dw_port = downwind_data[downwind_data["tack"] == -1]
            dw_stbd = downwind_data[downwind_data["tack"] == 1]
            
            if len(dw_port) >= min_points_per_tack and len(dw_stbd) >= min_points_per_tack:
                # Calculate averages
                hdg_p = mean360(dw_port["Hdg_deg_smooth"])
                cog_p = mean360(dw_port["Cog_deg_smooth"])
                sog_p = dw_port["Sog_kph_smooth"].mean()
                
                hdg_s = mean360(dw_stbd["Hdg_deg_smooth"])
                cog_s = mean360(dw_stbd["Cog_deg_smooth"])
                sog_s = dw_stbd["Sog_kph_smooth"].mean()
                
                # Convert SOG to knots for the solver
                sog_p_kts = sog_p / 1.852
                sog_s_kts = sog_s / 1.852
                
                # ========================================================================
                # SYMMETRY CHECK: If leeway is already symmetric, no current is needed
                # ========================================================================
                # Calculate observed leeway (Hdg - Cog) for each tack
                lwy_p_obs = angle_subtract(hdg_p, cog_p)  # Observed leeway port
                lwy_s_obs = angle_subtract(hdg_s, cog_s)  # Observed leeway starboard
                
                # Check symmetry: if leeway magnitudes are similar, there's no current
                lwy_p_abs = abs(lwy_p_obs)
                lwy_s_abs = abs(lwy_s_obs)
                leeway_asymmetry = abs(lwy_p_abs - lwy_s_abs)
                leeway_magnitude_avg = (lwy_p_abs + lwy_s_abs) / 2.0
                
                # If leeway is symmetric (< 1° difference) and magnitude is small (< 3°), 
                # skip solver and use zero current (lake conditions)
                if leeway_asymmetry < 1.0 and leeway_magnitude_avg < 3.0:
                    # Symmetric leeway indicates no current - skip solver
                    cx = 0.0
                    cy = 0.0
                    dw_estimates.append((cx, cy, "symmetric-skip"))
                else:
                    # Proceed with solver only if leeway is asymmetric
                    # Determine if we should use speed-based or ride-height-based leeway
                    # Use speed-based for low speeds (< 15 knots), ride-height for high speeds (>= 15 knots)
                    avg_sog_kts = (sog_p_kts + sog_s_kts) / 2.0
                    use_speed_effect = avg_sog_kts < 15.0
                    
                    if use_speed_effect:
                        # Low-speed: Use boat speed effect instead of ride height
                        # Slower speed = higher speed_factor = more positive leeway on starboard tack
                        # Formula: (15 - sog_kts) * speed_k, clamped to non-negative
                        # If speeds are very similar, use average to avoid artificial asymmetry
                        speed_diff = abs(sog_p_kts - sog_s_kts)
                        if speed_diff < 0.5:  # Speeds within 0.5 knots - use average
                            avg_speed_factor = max(0.0, (15.0 - avg_sog_kts) * speed_k)
                            speed_factor_p = avg_speed_factor
                            speed_factor_s = avg_speed_factor
                        else:
                            speed_factor_p = max(0.0, (15.0 - sog_p_kts) * speed_k)
                            speed_factor_s = max(0.0, (15.0 - sog_s_kts) * speed_k)
                        rh_p_use = speed_factor_p
                        rh_s_use = speed_factor_s
                        rh_k_use = 1.0  # Use unity coefficient when using speed factors
                        method_used = "speed-based"
                    else:
                        # High-speed: Use ride height effect
                        rh_p_use = dw_port[ride_height_name].mean()
                        rh_s_use = dw_stbd[ride_height_name].mean()
                        rh_k_use = ride_height_k
                        method_used = "ride-height-based"
                    
                    try:
                        # Solve in knots
                        cx_kts, cy_kts, _, _ = solve_from_averages(hdg_p, cog_p, sog_p_kts, rh_p_use, hdg_s, cog_s, sog_s_kts, rh_s_use, rh_k=rh_k_use)
                        
                        # ========================================================================
                        # POST-SOLVER VALIDATION: Reject large current if leeway was symmetric
                        # ========================================================================
                        current_magnitude_kts = np.sqrt(cx_kts**2 + cy_kts**2)
                        
                        # If original leeway was symmetric but solver found large current, reject it
                        if leeway_asymmetry < 1.0 and current_magnitude_kts > 0.1:  # 0.1 kts = ~0.19 kph
                            # Original was symmetric but solver found significant current - likely spurious
                            cx_kts, cy_kts = 0.0, 0.0
                            method_used = method_used + "-rejected"
                        
                        # Convert back to kph
                        cx = cx_kts * 1.852
                        cy = cy_kts * 1.852
                        
                        dw_estimates.append((cx, cy, method_used))
                    except Exception:
                        pass

        # Combine estimates for this segment
        final_cx = []
        final_cy = []
        methods_used = []
        
        if uw_estimates:
            final_cx.append(uw_estimates[0][0])
            final_cy.append(uw_estimates[0][1])
            methods_used.append(uw_estimates[0][2])
            
        if dw_estimates:
            final_cx.append(dw_estimates[0][0])
            final_cy.append(dw_estimates[0][1])
            methods_used.append(dw_estimates[0][2])
            
        if final_cx:
            avg_cx = np.mean(final_cx)
            avg_cy = np.mean(final_cy)
            mid_time = current_ts + (window_seconds / 2)
            # Log which method was used (for debugging)
            method_summary = ", ".join(set(methods_used))
            if len(set(methods_used)) > 1:
                print(f"  Segment at {mid_time:.0f}s: Mixed methods ({method_summary})")
            # Store estimate with method info for later summary
            valid_estimates.append((mid_time, avg_cx, avg_cy, method_summary))
            
        current_ts += window_seconds

    print(f"Found {len(valid_estimates)} valid segments with estimates")
    
    # Count methods used for summary
    speed_based_count = sum(1 for est in valid_estimates if len(est) > 3 and "speed-based" in est[3])
    rh_based_count = sum(1 for est in valid_estimates if len(est) > 3 and "ride-height-based" in est[3])
    if speed_based_count > 0 or rh_based_count > 0:
        print(f"  Speed-based estimates: {speed_based_count}, Ride-height-based: {rh_based_count}")
    
    if len(valid_estimates) == 0:
        print("ERROR: No valid current estimates found!")
        print("Check that data has Grade > 1 on both tacks")
        # Return zeros
        result = pd.DataFrame({
            cur_rate_name: 0.0,
            cur_dir_name: 0.0
        }, index=original_index)
        return result
    
    # Convert to arrays for interpolation (extract first 3 elements, ignoring method info)
    ts_sparse = np.array([est[0] for est in valid_estimates])
    cx_sparse = np.array([est[1] for est in valid_estimates])
    cy_sparse = np.array([est[2] for est in valid_estimates])
    
    # Calculate current magnitudes from the raw estimates
    current_magnitudes = np.sqrt(cx_sparse**2 + cy_sparse**2)
    
    print(f"\nEstimate quality:")
    print(f"  Time span: {ts_sparse[-1] - ts_sparse[0]:.0f} seconds ({(ts_sparse[-1] - ts_sparse[0])/3600:.1f} hours)")
    print(f"  Average spacing: {np.mean(np.diff(ts_sparse)):.0f} seconds between estimates")
    print(f"  Estimates per hour: {len(valid_estimates) / ((ts_sparse[-1] - ts_sparse[0])/3600):.1f}")
    
    # Calculate magnitudes in knots for debug display
    current_magnitudes_kts = current_magnitudes / 1.852
    
    print(f"\nRaw current estimates:")
    print(f"  Rate (KPH) - min: {current_magnitudes.min():.2f}, max: {current_magnitudes.max():.2f}, mean: {current_magnitudes.mean():.2f} kph")
    print(f"  Rate (KTS) - min: {current_magnitudes_kts.min():.2f}, max: {current_magnitudes_kts.max():.2f}, mean: {current_magnitudes_kts.mean():.2f} kts")
    print(f"  X component: {cx_sparse.min():.2f} to {cx_sparse.max():.2f}")
    print(f"  Y component: {cy_sparse.min():.2f} to {cy_sparse.max():.2f}")
    
    # GUARD RAIL: Clip unreasonable current values
    outliers_count = (current_magnitudes > MAX_CURRENT_KPH).sum()
    if outliers_count > 0:
        print(f"WARNING: Found {outliers_count} estimates exceeding {MAX_CURRENT_KPH} kph, clipping to max")
        # Clip the vectors while preserving direction
        scale_factors = np.minimum(1.0, MAX_CURRENT_KPH / current_magnitudes)
        cx_sparse = cx_sparse * scale_factors
        cy_sparse = cy_sparse * scale_factors
        current_magnitudes = np.sqrt(cx_sparse**2 + cy_sparse**2)
        print(f"After clipping - max: {current_magnitudes.max():.2f} kph")
    
    # -----------------------------
    # 3) FIT GLOBAL TREND TO FULL TIMELINE
    # -----------------------------
    # Fit a smooth global trend through the sparse estimates
    # Evaluate directly at original timestamps to avoid gaps at edges
    
    print(f"\nTrend fitting method: Linear (Least Squares)")
    
    if len(ts_sparse) >= 2:
        # Fit linear trend to X and Y components
        poly_cx = np.polyfit(ts_sparse, cx_sparse, 1)
        poly_cy = np.polyfit(ts_sparse, cy_sparse, 1)
        
        # Evaluate linear trend directly at original timestamps (allows extrapolation)
        # This ensures coverage from beginning to end of the dataframe
        cx_smooth = np.polyval(poly_cx, ts_values)
        cy_smooth = np.polyval(poly_cy, ts_values)
        
    else:
        # Single point - constant value
        print("WARNING: Only 1 point, using constant value")
        cx_smooth = np.full_like(ts_values, cx_sparse[0], dtype=float)
        cy_smooth = np.full_like(ts_values, cy_sparse[0], dtype=float)
    
    # Convert to rate and direction
    current_rate = np.sqrt(cx_smooth**2 + cy_smooth**2)
    current_dir = np.array([vec_to_dir_deg([cx, cy]) for cx, cy in zip(cx_smooth, cy_smooth)])
    
    # GUARD RAIL: Clip trend values to max current (in case trend extrapolates)
    if np.any(current_rate > MAX_CURRENT_KPH):
        n_clipped = (current_rate > MAX_CURRENT_KPH).sum()
        print(f"WARNING: Clipping {n_clipped} trend points exceeding {MAX_CURRENT_KPH} kph")
        # Clip the vectors while preserving direction
        scale_factors = np.minimum(1.0, MAX_CURRENT_KPH / current_rate)
        cx_smooth = cx_smooth * scale_factors
        cy_smooth = cy_smooth * scale_factors
        current_rate = np.sqrt(cx_smooth**2 + cy_smooth**2)
    
    # GUARD RAIL: Replace any NaN values with zero
    nan_count = np.isnan(current_rate).sum() + np.isnan(current_dir).sum()
    if nan_count > 0:
        print(f"WARNING: Found {nan_count} NaN values, replacing with zeros")
        current_rate = np.nan_to_num(current_rate, nan=0.0)
        current_dir = np.nan_to_num(current_dir, nan=0.0)
        cx_smooth = np.nan_to_num(cx_smooth, nan=0.0)
        cy_smooth = np.nan_to_num(cy_smooth, nan=0.0)
    
    # Create DataFrame directly with original timestamps
    # IMPORTANT: Only return current columns. Do NOT return any smoothed navigation data.
    # The smoothed Hdg_deg_smooth, Cog_deg_smooth, and Sog_kph_smooth columns are internal only
    # and must never leave this function. The original dataframe columns remain unchanged.
    # Explicitly create a new DataFrame with ONLY the current columns to ensure no leakage.
    current_hf = pd.DataFrame({
        cur_rate_name: current_rate,
        cur_dir_name: current_dir
    }, index=ts_values)
    
    # Final safety check: Ensure we're only returning current columns, nothing else
    assert list(current_hf.columns) == [cur_rate_name, cur_dir_name], \
        f"estimate_current should only return current columns, but got: {list(current_hf.columns)}"
    
    print(f"\nTrend output (original frequency):")
    print(f"  Current rate: {current_rate.min():.2f} - {current_rate.max():.2f} kph (mean: {current_rate.mean():.2f})")
    print(f"  Current direction: {current_dir.min():.1f} - {current_dir.max():.1f} deg")
    print(f"  Coverage: {len(current_hf)} points from {ts_values[0]:.0f} to {ts_values[-1]:.0f}")
    
    # GUARD RAIL: Final safety checks on output data
    # Ensure no NaN values remain (shouldn't happen with direct evaluation, but check anyway)
    if current_hf[cur_rate_name].isna().any():
        print(f"WARNING: Found NaN values, filling with zeros")
        current_hf = current_hf.fillna(0.0)
    
    # Final clip to max current
    if (current_hf[cur_rate_name] > MAX_CURRENT_KPH).any():
        n_clipped = (current_hf[cur_rate_name] > MAX_CURRENT_KPH).sum()
        print(f"WARNING: Clipping {n_clipped} final points exceeding {MAX_CURRENT_KPH} kph")
        current_hf[cur_rate_name] = current_hf[cur_rate_name].clip(upper=MAX_CURRENT_KPH)
    
    # Ensure no negative values (shouldn't happen, but just in case)
    current_hf[cur_rate_name] = current_hf[cur_rate_name].clip(lower=0.0)
    
    # Restore original index (ts_values should match original_index length, but index type may differ)
    current_hf.index = original_index
    
    print(f"Output: {len(current_hf)} points (original frequency)")
    print(f"Final current rate range: {current_hf[cur_rate_name].min():.2f} - {current_hf[cur_rate_name].max():.2f} kph")
    print(f"NaN check - rate: {current_hf[cur_rate_name].isna().sum()}, dir: {current_hf[cur_dir_name].isna().sum()}")
    print("=== COMPLETE ===\n")
    
    return current_hf

def compute_leeway(df, current, cur_rate_name="cur_rate", cur_dir_name="cur_dir", sog_name="Sog_kph", cog_name="Cog_deg", hdg_name="Hdg_deg", leeway_name="Lwy_deg"):
    """
    Compute leeway (heading minus course over water) after accounting for current.
    
    This function outputs RAW leeway (not normalized). The sign convention is:
    - On starboard tack (TWA >= 0): Positive leeway means drifting to port/left
    - On port tack (TWA < 0): Negative leeway means drifting to port/left (same physical behavior)
    
    To get normalized leeway (same sign for same physical behavior on both tacks), multiply by sign(CWA):
        Lwy_n = Lwy * sign(CWA)
    where CWA is positive on starboard tack and negative on port tack.
    
    Args:
        df: DataFrame with boat data
        current: DataFrame with current rate and direction (from estimate_current)
        cur_rate_name: Name of current speed column
        cur_dir_name: Name of current direction column
        sog_name: Speed over ground column name
        cog_name: Course over ground column name
        hdg_name: Heading column name
        leeway_name: Name for output leeway column
    
    Returns:
        DataFrame with leeway column added (raw leeway, not normalized)
    """
    df = df.copy()
    df[cur_rate_name] = current[cur_rate_name]
    df[cur_dir_name] = current[cur_dir_name]

    # Vectorized implementation replacing iterrows loop
    sog = df[sog_name].to_numpy()
    cog = df[cog_name].to_numpy()
    cur_rate = df[cur_rate_name].to_numpy()
    cur_dir = df[cur_dir_name].to_numpy()
    hdg = df[hdg_name].to_numpy()
    
    # Convert angles to radians
    cog_rad = np.radians(cog)
    cur_dir_rad = np.radians(cur_dir)
    
    # g vector components (Ground Velocity)
    # polar_to_vec equivalent: x=speed*cos(a), y=speed*sin(a)
    gx = sog * np.cos(cog_rad)
    gy = sog * np.sin(cog_rad)
    
    # c vector components (Current Velocity)
    cx = cur_rate * np.cos(cur_dir_rad)
    cy = cur_rate * np.sin(cur_dir_rad)
    
    # b = g - c (Boat Velocity through water)
    bx = gx - cx
    by = gy - cy
    
    # Calculate boat speed magnitude to detect unstable cases
    b_speed = np.sqrt(bx**2 + by**2)
    
    # b_dir (Direction of boat through water)
    # arctan2 returns [-180, 180], convert to [0, 360] for consistency with hdg
    # When boat speed is very small, arctan2 becomes unstable - use heading as fallback
    b_dir = np.degrees(np.arctan2(by, bx))
    b_dir = (b_dir + 360) % 360
    
    # For very small boat speeds (< 0.1 m/s), use heading directly to avoid arctan2 instability
    b_dir = np.where(b_speed < 0.1, hdg, b_dir)
    
    # Leeway = Heading - Direction through water
    # Use proper angle subtraction that handles wrapping correctly
    # Convert both to [-180, 180] range first, then subtract
    hdg_wrapped = ((hdg + 180) % 360) - 180
    hdg_wrapped = np.where(hdg_wrapped == -180, 180, hdg_wrapped)
    b_dir_wrapped = ((b_dir + 180) % 360) - 180
    b_dir_wrapped = np.where(b_dir_wrapped == -180, 180, b_dir_wrapped)
    
    # Now subtract in [-180, 180] range
    diff = ((hdg_wrapped - b_dir_wrapped) + 180) % 360 - 180
    # Handle exact -180 case: convert to +180 for consistency
    lw = np.where(diff == -180, 180, diff)
    
    # Apply threshold: sog > 5. If sog <= 5, use Hdg - COG (assume 0 current effect / drift is all leeway).
    # This prevents wild leeway values when SOG is small and current subtraction is unstable,
    # and matches the user's expectation that leeway ~ (Hdg - COG) at slow speeds.
    
    # Calculate simple difference Hdg - COG (lwy)
    simple_diff = (hdg - cog + 180) % 360 - 180
    # Handle exact -180 case: convert to +180 for consistency
    simple_diff = np.where(simple_diff == -180, 180, simple_diff)
    
    # Rule: Corrected leeway (lw) should never exceed the simple leeway (lwy/simple_diff) in magnitude.
    # This acts as a guard rail against unstable current estimates producing huge leeway values.
    # If abs(lw) > abs(simple_diff), we assume the observed drift (simple_diff) is the maximum possible leeway.
    
    constrained_lw = np.where(np.abs(lw) > np.abs(simple_diff), simple_diff, lw)
    
    # Apply threshold based on SOG:
    # 1. SOG <= 5: Use simple Hdg - COG (assume current effect is negligible at very slow speeds)
    #    This prevents instability from current subtraction when SOG is too small
    # 2. SOG > 5: Use constrained corrected leeway (current-corrected, but bounded by simple_diff)
    
    final_lw = np.where(sog > 5, constrained_lw, simple_diff)
    
    # Final wrap to ensure all values are in [-180, 180] range
    final_lw = ((final_lw + 180) % 360) - 180
    final_lw = np.where(final_lw == -180, 180, final_lw)
    
    df[leeway_name] = final_lw
    return df

def calculate_current(sog: float, cog: float, stw: float, hdg: float, lwy: float) -> Tuple[float, float]:
    """
    Calculate current speed and direction considering leeway effects.
    
    This function accounts for leeway (sideways drift) when calculating current
    from the difference between boat motion through water and over ground.
    
    Args:
        sog (float): Speed over ground in knots
        cog (float): Course over ground in degrees (0-360)
        stw (float): Speed through water in knots  # Fixed documentation
        hdg (float): Boat heading in degrees (0-360)
        lwy (float): Leeway in degrees (+starboard, -port)
    
    Returns:
        tuple: (current_speed, current_direction)
            - current_speed (float): Current speed in knots
            - current_direction (float): Current direction in degrees (0-360)
    """
    # Input validation
    if sog < 0 or stw < 0:
        return 0.0, 0.0
    
    # Convert angles to radians
    cog_rad = m.radians(cog)
    
    # Calculate the boat's actual track through water (heading + leeway)
    boat_track_rad = m.radians(angle_subtract(hdg, lwy))
    # boat_track_rad = m.radians((hdg + lwy) % 360)

    # Boat velocity components relative to water (using actual track through water)
    # Using nautical convention: North=Y, East=X
    v_boat_x = stw * m.sin(boat_track_rad)  # East component
    v_boat_y = stw * m.cos(boat_track_rad)  # North component

    # Velocity components of the ground (observed movement)
    v_ground_x = sog * m.sin(cog_rad)  # East component
    v_ground_y = sog * m.cos(cog_rad)  # North component

    # Compute current velocity components
    # Current = Ground track - Boat track through water
    v_current_x = v_ground_x - v_boat_x
    v_current_y = v_ground_y - v_boat_y

    # Compute current speed
    current_speed = m.sqrt(v_current_x**2 + v_current_y**2)

    # Compute current direction (direction current is flowing TO)
    current_direction_rad = m.atan2(v_current_x, v_current_y)
    current_direction = (m.degrees(current_direction_rad) + 360) % 360
    # current_direction = (m.degrees(current_direction_rad) + 180) % 360

    return round(current_speed, 3), round(current_direction, 1)

def calculate_stw_cse(sog: float, cog: float, current_speed: float, current_direction: float, hdg: float = None) -> Tuple[float, float]:
    """
    Calculate speed over water and course over water given current conditions.
    
    This function determines how fast and in what direction the boat is moving
    through the water when current is factored out from ground track.
    
    Args:
        sog (float): Speed over ground in knots
        cog (float): Course over ground in degrees (0-360)
        current_speed (float): Current speed in knots
        current_direction (float): Current direction in degrees (0-360)
        hdg (float, optional): Heading in degrees (0-360). If provided, used to clamp CSE.
    
    Returns:
        tuple: (stw, cse)
            - stw (float): Speed over water in knots
            - cse (float): Course over water in degrees (0-360), clamped to not exceed COG
    """
    # Convert angles to radians
    cog_rad = m.radians(cog)
    current_direction_rad = m.radians(current_direction)
    
    # Calculate the components of the boat's speed over ground
    v_boat_x = sog * m.sin(cog_rad)
    v_boat_y = sog * m.cos(cog_rad)
    
    # Calculate the components of the current's speed
    v_current_x = current_speed * m.sin(current_direction_rad)
    v_current_y = current_speed * m.cos(current_direction_rad)
    
    # Calculate the resultant speed components over water
    v_resultant_x = v_boat_x - v_current_x
    v_resultant_y = v_boat_y - v_current_y
    
    # Calculate Speed Through Water (STW)
    stw = m.sqrt(v_resultant_x**2 + v_resultant_y**2)
    
    # Calculate the Course Over Water (CSE)
    cse = m.degrees(m.atan2(v_resultant_x, v_resultant_y))
    
    # Normalize COW to 0-360 degrees
    cse = (cse + 360) % 360
    
    # Clamp CSE to not exceed COG
    # CSE should never exceed COG (it can be less but not more)
    # The rule: CSE should be between Heading and COG, not beyond COG in the direction of drift
    if hdg is not None:
        # Calculate angular differences from heading
        diff_cog = angle_subtract(cog, hdg)  # How far COG is from heading
        diff_cse = angle_subtract(cse, hdg)  # How far CSE is from heading
        
        # If CSE is further from heading than COG (in the same direction), clamp to COG
        # This ensures CSE doesn't exceed COG in the direction of drift
        if abs(diff_cse) > abs(diff_cog) and (diff_cse * diff_cog >= 0):  # Same sign means same direction
            cse = cog
    else:
        # Without heading, use simple rule: if CSE exceeds COG in circular sense, clamp
        # This is a fallback - ideally heading should be provided
        diff = angle_subtract(cse, cog)
        # If CSE is ahead of COG (positive difference < 180), clamp to COG
        if 0 < diff < 180:
            cse = cog
    
    return stw, cse

def compute_apparent(tws: float, twa: float, stw: float, lwy: float) -> Tuple[float, float]:
    """
    Calculate apparent wind speed and angle from true wind and boat motion.
    
    Apparent wind is what the boat experiences due to the combination of true wind
    and the boat's movement through the water, including leeway effects.
    
    Args:
        tws (float): True wind speed in knots
        twa (float): True wind angle in degrees (-180 to +180, relative to bow)
        stw (float): Speed through water in knots
        lwy (float): Leeway in degrees (+starboard, -port)
    
    Returns:
        tuple: (aws, awa)
            - aws (float): Apparent wind speed in knots
            - awa (float): Apparent wind angle in degrees (0-180)
    """
    # Convert the true wind angle from degrees to radians
    twa_rad = m.radians(angle_add(twa, 180))
    lwy_rad = m.radians(lwy) * -1
    
    # True wind speed components (relative to the boat's heading)
    Vwx = tws * m.cos(twa_rad)
    Vwy = tws * m.sin(twa_rad)
    
    # Boat speed components (assuming the boat is moving directly along the x-axis) 
    Vbx = stw * m.cos(lwy_rad)
    Vby = stw * m.sin(lwy_rad)
    
    # Apparent wind speed components
    Vax = Vwx - Vbx
    Vay = Vwy - Vby
    
    # Apparent wind speed magnitude
    aws = m.sqrt(Vax**2 + Vay**2)
    
    # Apparent wind angle in radians
    awa_rad = m.atan2(Vay, Vax)
    
    # Convert apparent wind angle from radians to degrees
    awa_deg = 180 - m.degrees(awa_rad)
    
    if awa_deg > 180: 
        awa_deg = 360 - awa_deg

    return aws, awa_deg

def computeTrueWind(aws: float, awa: float, stw: float, hdg: float, lwy: float) -> Tuple[float, float, float]:
    """
    Calculate true wind from apparent wind measurements and boat motion.
    
    Converts the wind as measured on the boat (apparent wind) back to the actual
    wind conditions (true wind) by removing the effects of boat motion and leeway.
    
    Args:
        aws (float): Apparent wind speed in knots
        awa (float): Apparent wind angle in degrees (0-180)
        stw (float): Speed through water in knots
        hdg (float): Boat heading in degrees (0-360)
        lwy (float): Leeway in degrees (+starboard, -port)
    
    Returns:
        tuple: (tws, twa, twd)
            - tws (float): True wind speed in knots
            - twa (float): True wind angle in degrees (-180 to +180, relative to bow)
            - twd (float): True wind direction in degrees (0-360, compass bearing)
    """
    # Convert AWA to signed angle (-180 to +180) - no rotation needed
    if awa > 180:
        awa_signed = angle_subtract(awa, 360)
    else:
        awa_signed = awa

    # Convert leeway from "HDG - COG" convention (positive = drift to port) to a signed
    # angle in the boat frame (+Y = starboard). Drift to port is negative Y, so negate.
    lwy_signed = lwy * -1

    # Convert to radians
    awa_rad = m.radians(awa_signed)
    lwy_rad = m.radians(lwy_signed) 
    
    # Apparent wind components (boat frame: +X forward, +Y starboard)
    Vax = aws * m.cos(awa_rad)  # Forward component
    Vay = aws * m.sin(awa_rad)  # Starboard component
    
    # Boat velocity components through water (including leeway)
    Vbx = stw * m.cos(lwy_rad)  # Forward component (reduced by leeway)
    Vby = stw * m.sin(lwy_rad)  # Sideways component (leeway drift)
    
    # True wind = Apparent wind - Boat velocity
    Vwx = Vax - Vbx  # Changed from + to -
    Vwy = Vay - Vby  # Changed from + to -
    
    # True wind speed
    tws = m.sqrt(Vwx**2 + Vwy**2)
    
    # True wind angle (no extra rotations)
    twa_rad = m.atan2(Vwy, Vwx)
    twa_deg = m.degrees(twa_rad)
    
    # True wind direction
    twd_deg = angle_add(hdg, twa_deg)
    twd_deg = (twd_deg + 360) % 360  # Normalize to 0-360   # ~30 second smoothing
    
    return tws, twa_deg, twd_deg

def computeTrueWind_vectorized(aws, awa, stw, hdg, lwy, cur_rate=None, twd_original=None, tws_original=None):
    """
    Vectorized calculation of True Wind from apparent wind measurements and boat motion.
    
    This is a vectorized version of computeTrueWind that processes entire arrays at once,
    making it much faster for large datasets. It converts the wind as measured on the boat
    (apparent wind) back to the actual wind conditions (true wind) by removing the effects
    of boat motion and leeway.
    
    Args:
        aws: Apparent wind speed array (kph)
        awa: Apparent wind angle array (degrees, 0-180)
        stw: Speed through water array (kph)
        hdg: Boat heading array (degrees, 0-360)
        lwy: Leeway array (degrees, +starboard, -port)
        cur_rate: Optional current rate array (kph). If provided and < 0.01, uses original values
        twd_original: Optional original TWD array (degrees). Used when current is zero
        tws_original: Optional original TWS array (kph). Used when current is zero
    
    Returns:
        tuple: (tws, twa, twd)
            - tws: True wind speed array (kph)
            - twa: True wind angle array (degrees, -180 to +180, relative to bow)
            - twd: True wind direction array (degrees, 0-360, compass bearing)
    """
    # Convert inputs to numpy arrays if they're not already
    aws = np.asarray(aws)
    awa = np.asarray(awa)
    stw = np.asarray(stw)
    hdg = np.asarray(hdg)
    lwy = np.asarray(lwy)
    
    # Check if current is effectively zero - if so, use original Twd_deg directly
    # This ensures Twd_cor_deg matches Twd_deg when there's no current
    current_is_zero = None
    if cur_rate is not None:
        cur_rate = np.asarray(cur_rate)
        current_is_zero = cur_rate < 0.01  # Less than 0.01 kph = effectively zero
    
    # Convert AWA to signed angle (-180 to +180) - vectorized
    awa_signed = np.where(awa > 180, ((awa - 360) + 180) % 360 - 180, awa)
    # Handle the -180 edge case
    awa_signed = np.where(awa_signed == -180, 180, awa_signed)
    
    # Convert leeway from "HDG - COG" convention (positive = drift to port) to a signed
    # angle in the boat frame (+Y = starboard). Drift to port is negative Y, so negate.
    # On starboard tack: lwy > 0  →  lwy_signed < 0  →  Vby = sin(lwy_signed) < 0  ✓ (port drift)
    # On port tack:      lwy < 0  →  lwy_signed > 0  →  Vby = sin(lwy_signed) > 0  ✓ (starboard drift)
    lwy_signed = lwy * -1
    
    # Convert to radians (vectorized)
    awa_rad = np.radians(awa_signed)
    lwy_rad = np.radians(lwy_signed)
    
    # Apparent wind components (vectorized)
    # In boat frame: +X forward, +Y starboard
    Vax = aws * np.cos(awa_rad)
    Vay = aws * np.sin(awa_rad)
    
    # Boat velocity components through water (vectorized)
    # In boat frame: X forward, Y starboard
    Vbx = stw * np.cos(lwy_rad)
    Vby = stw * np.sin(lwy_rad)
    
    # True wind = Apparent wind - Boat velocity (vectorized)
    Vwx = Vax - Vbx
    Vwy = Vay - Vby
    
    # True wind speed (vectorized)
    tws = np.sqrt(Vwx**2 + Vwy**2)
    
    # True wind angle (vectorized)
    twa_rad = np.arctan2(Vwy, Vwx)
    twa_deg = np.degrees(twa_rad)
    
    # True wind direction (vectorized)
    # angle_add equivalent: (hdg + twa_deg + 360) % 360
    twd_deg = (hdg + twa_deg + 360) % 360
    
    # When current is zero, use original Twd_deg to ensure exact match
    if current_is_zero is not None and np.any(current_is_zero):
        if twd_original is not None:
            twd_original = np.asarray(twd_original)
            twd_deg = np.where(current_is_zero, twd_original, twd_deg)
        if tws_original is not None:
            tws_original = np.asarray(tws_original)
            # Convert to kph if needed (assuming input might be in knots)
            if tws_original.max() < 100:  # Likely in knots, convert to kph
                tws_original = tws_original * 1.852
            tws = np.where(current_is_zero, tws_original, tws)
    
    return tws, twa_deg, twd_deg

def computeStw_vectorized(sog, cog, cur_rate, cur_dir, hdg=None):
    """
    Vectorized calculation of Speed Through Water (STW) and Course Over Water (CSE).
    
    This is a vectorized version that processes entire arrays at once, making it
    much faster for large datasets. It calculates how fast and in what direction
    the boat is moving through the water when current is factored out from ground track.
    
    Args:
        sog: Speed over ground array (kph)
        cog: Course over ground array (degrees, 0-360)
        cur_rate: Current speed array (kph)
        cur_dir: Current direction array (degrees, 0-360)
        hdg: Optional heading array (degrees, 0-360). If provided, used to clamp CSE.
    
    Returns:
        tuple: (stw, cse)
            - stw: Speed through water array (kph)
            - cse: Course over water array (degrees, 0-360), clamped to not exceed COG
    """
    # Convert inputs to numpy arrays if they're not already
    sog = np.asarray(sog)
    cog = np.asarray(cog)
    cur_rate = np.asarray(cur_rate)
    cur_dir = np.asarray(cur_dir)
    
    # Convert angles to radians (vectorized)
    cog_rad = np.radians(cog)
    cur_dir_rad = np.radians(cur_dir)
    
    # Calculate components (vectorized)
    v_boat_x = sog * np.sin(cog_rad)
    v_boat_y = sog * np.cos(cog_rad)
    v_current_x = cur_rate * np.sin(cur_dir_rad)
    v_current_y = cur_rate * np.cos(cur_dir_rad)
    
    # Calculate resultant components (vectorized)
    v_resultant_x = v_boat_x - v_current_x
    v_resultant_y = v_boat_y - v_current_y
    
    # Calculate STW (vectorized)
    stw = np.sqrt(v_resultant_x**2 + v_resultant_y**2)
    
    # Calculate CSE (vectorized)
    cse = np.degrees(np.arctan2(v_resultant_x, v_resultant_y))
    cse = (cse + 360) % 360  # Normalize to 0-360
    
    # Clamp CSE to not exceed COG (CSE can be less but not more than COG)
    # CSE should be between Heading and COG, not beyond COG in the direction of drift
    if hdg is not None:
        hdg = np.asarray(hdg)
        # Calculate angular differences from heading
        diff_cog = ((cog - hdg) + 180) % 360 - 180  # How far COG is from heading
        diff_cse = ((cse - hdg) + 180) % 360 - 180  # How far CSE is from heading
        # Handle -180 edge case
        diff_cog = np.where(diff_cog == -180, 180, diff_cog)
        diff_cse = np.where(diff_cse == -180, 180, diff_cse)
        # If CSE is further from heading than COG (in the same direction), clamp to COG
        # Same sign means same direction from heading
        same_direction = (diff_cse * diff_cog >= 0)
        exceeds_cog = np.abs(diff_cse) > np.abs(diff_cog)
        clamp_mask = same_direction & exceeds_cog
        cse = np.where(clamp_mask, cog, cse)
    
    return stw, cse

def adjustTrueWind(tws: float, twa: float, cur_rate: float, cur_dir: float, hdg: float) -> Tuple[float, float]:
    """
    Adjust true wind calculations to account for current effects.
    
    The standard "True Wind" (TWA/TWS) is typically calculated relative to the water (Surface Wind).
    However, when current exists, the "Ground Wind" (wind over ground) is different.
    
    This function converts Surface Wind (relative to water) to Ground Wind (relative to seabed),
    BUT returns the angle relative to the BOAT'S HEADING (TWA), not the Course.
    
    Args:
        tws (float): True wind speed in knots (Surface Wind)
        twa (float): True wind angle in degrees (Surface Wind, relative to Heading)
        cur_rate (float): Current speed in knots
        cur_dir (float): Current direction in degrees (0-360)
        hdg (float): Heading in degrees (0-360)
    
    Returns:
        tuple: (adjusted_tws, adjusted_twa)
            - adjusted_tws (float): Ground Wind Speed in knots
            - adjusted_twa (float): Ground Wind Angle relative to HEADING
    """
    # 1. Calculate Surface Wind direction (TWD_surface)
    twd_surface = angle_add(hdg, twa)
    # Convert to radians for calculation (vector points WHERE wind goes TO)
    # Meteorological convention: wind dir is FROM.
    # Vector arithmetic usually easier with direction TO.
    # Surface Wind Vector (TO): TWD_surface + 180
    
    twd_surface_to_rad = m.radians(twd_surface + 180)
    
    # 2. Surface Wind Vector
    # Wind movement relative to Water
    vw_x = tws * m.sin(twd_surface_to_rad)
    vw_y = tws * m.cos(twd_surface_to_rad)
    
    # 3. Current Vector (Movement of Water relative to Ground)
    # Current direction is usually TO
    cur_dir_rad = m.radians(cur_dir)
    vc_x = cur_rate * m.sin(cur_dir_rad)
    vc_y = cur_rate * m.cos(cur_dir_rad)
    
    # 4. Ground Wind Vector (Movement of Air relative to Ground)
    # V_ground_wind = V_surface_wind + V_current
    vg_x = vw_x + vc_x
    vg_y = vw_y + vc_y
    
    # Ground Wind Speed
    gw_spd = m.sqrt(vg_x**2 + vg_y**2)
    
    # Ground Wind Direction (Where wind is going TO)
    gw_dir_to = m.degrees(m.atan2(vg_x, vg_y))
    gw_dir_to = (gw_dir_to + 360) % 360
    
    # Ground Wind Direction (Where wind comes FROM)
    gw_dir_from = (gw_dir_to + 180) % 360
    
    # Calculate TWA relative to HEADING (as requested)
    # TWA = TWD - Heading
    gw_twa = angle_subtract(gw_dir_from, hdg)
    
    return gw_spd, gw_twa