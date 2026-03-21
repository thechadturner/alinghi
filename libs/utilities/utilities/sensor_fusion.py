"""
Sensor Fusion Module

Combines multiple calibrated sensors into a single fused estimate.
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple


def fuse_sensors_robust(df: pd.DataFrame,
                       sensor_list: List[str],
                       outlier_threshold: float = 2.0,
                       min_sensors: int = 1) -> pd.DataFrame:
    """
    Robust sensor fusion using Median Absolute Deviation (MAD) for outlier rejection.
    
    At each timestamp:
    1. Compute median of all sensor readings
    2. Compute MAD = median(|sensor - median|)
    3. Convert MAD to std equivalent: 1.4826 * MAD
    4. Reject sensors with z-score > threshold
    5. Average remaining sensors
    
    Args:
        df: DataFrame with sensor columns
        sensor_list: List of sensor column names to fuse
        outlier_threshold: Z-score threshold for outlier rejection (default: 2.0)
        min_sensors: Minimum sensors required to produce fused value
        
    Returns:
        DataFrame with added columns:
        - 'value_fused': fused sensor value
        - 'n_sensors_used': number of sensors used per sample
        - 'fusion_uncertainty': estimated uncertainty (std of inliers)
    """
    df_result = df.copy()
    
    # Verify sensors exist
    available_sensors = [s for s in sensor_list if s in df.columns]
    if len(available_sensors) == 0:
        raise ValueError(f"None of the requested sensors found in DataFrame: {sensor_list}")
    
    # Create matrix of sensor readings
    sensor_matrix = df[available_sensors].values  # (n_samples, n_sensors)
    n_samples, n_sensors = sensor_matrix.shape
    
    # Initialize output arrays
    fused_values = np.full(n_samples, np.nan)
    n_sensors_used = np.zeros(n_samples, dtype=int)
    fusion_uncertainty = np.full(n_samples, np.nan)
    outlier_flags = np.zeros((n_samples, n_sensors), dtype=bool)
    
    # Process each timestamp
    for i in range(n_samples):
        readings = sensor_matrix[i, :]
        
        # Get valid (non-NaN) readings
        valid_mask = ~np.isnan(readings)
        valid_readings = readings[valid_mask]
        
        if len(valid_readings) < min_sensors:
            continue
        
        if len(valid_readings) == 1:
            # Only one sensor - use it directly
            fused_values[i] = valid_readings[0]
            n_sensors_used[i] = 1
            fusion_uncertainty[i] = np.nan  # Can't estimate uncertainty with 1 sensor
            continue
        
        # Compute median (robust central estimate)
        median_val = np.median(valid_readings)
        
        # Compute MAD (Median Absolute Deviation)
        absolute_deviations = np.abs(valid_readings - median_val)
        mad = np.median(absolute_deviations)
        
        if mad > 0:
            # Convert MAD to equivalent standard deviation
            # Factor 1.4826 assumes normal distribution
            mad_std = 1.4826 * mad
            
            # Compute z-scores
            z_scores = absolute_deviations / mad_std
            
            # Identify inliers
            inlier_mask = z_scores <= outlier_threshold
            inliers = valid_readings[inlier_mask]
            
            # Mark outliers in the full matrix for reporting
            valid_indices = np.where(valid_mask)[0]
            outlier_indices = valid_indices[~inlier_mask]
            outlier_flags[i, outlier_indices] = True
        else:
            # All readings identical - no outliers
            inliers = valid_readings
        
        # Compute fused value (mean of inliers)
        if len(inliers) >= min_sensors:
            fused_values[i] = np.mean(inliers)
            n_sensors_used[i] = len(inliers)
            
            # Estimate uncertainty (std of inliers)
            if len(inliers) > 1:
                fusion_uncertainty[i] = np.std(inliers, ddof=1)
            else:
                fusion_uncertainty[i] = np.nan
        else:
            # Too many outliers, not enough inliers
            n_sensors_used[i] = 0
    
    # Add results to dataframe
    df_result['value_fused'] = fused_values
    df_result['n_sensors_used'] = n_sensors_used
    df_result['fusion_uncertainty'] = fusion_uncertainty
    
    # Add per-sensor outlier flags as separate columns (for debugging)
    for j, sensor in enumerate(available_sensors):
        df_result[f'{sensor}_outlier'] = outlier_flags[:, j]
    
    return df_result


def fuse_sensors_weighted(df: pd.DataFrame,
                          sensor_configs: Dict[str, Dict],
                          weight_method: str = 'quality') -> pd.DataFrame:
    """
    Weighted average fusion using sensor quality scores.
    
    Args:
        df: DataFrame with sensor columns
        sensor_configs: Dict mapping sensor name to config with 'quality_score'
        weight_method: 'quality' (use quality scores) or 'uniform' (equal weights)
        
    Returns:
        DataFrame with added 'value_fused' column
    """
    df_result = df.copy()
    
    # Get sensors that passed health checks
    healthy_sensors = [s for s, cfg in sensor_configs.items() 
                       if cfg.get('health', {}).get('passed', False)]
    
    if len(healthy_sensors) == 0:
        raise ValueError("No healthy sensors available for fusion")
    
    # Compute weights
    weights = {}
    
    if weight_method == 'quality':
        # Weight by quality score
        total_quality = sum(sensor_configs[s]['quality_score'] for s in healthy_sensors)
        
        if total_quality == 0:
            # Fall back to uniform if all scores are zero
            for sensor in healthy_sensors:
                weights[sensor] = 1.0 / len(healthy_sensors)
        else:
            for sensor in healthy_sensors:
                weights[sensor] = sensor_configs[sensor]['quality_score'] / total_quality
    
    elif weight_method == 'uniform':
        # Equal weights
        for sensor in healthy_sensors:
            weights[sensor] = 1.0 / len(healthy_sensors)
    
    else:
        raise ValueError(f"Unknown weight_method: {weight_method}")
    
    # Apply weighted average
    fused_values = np.zeros(len(df))
    
    for sensor, weight in weights.items():
        if sensor in df.columns:
            # Handle NaNs by setting weight to 0 for NaN values
            sensor_values = df[sensor].fillna(0).values
            sensor_mask = ~df[sensor].isnull().values
            fused_values += sensor_values * weight * sensor_mask
    
    df_result['value_fused'] = fused_values
    
    # Store weights as dataframe attribute for transparency
    df_result.attrs['fusion_weights'] = weights
    df_result.attrs['fusion_method'] = 'weighted'
    
    return df_result


def fuse_awa_aws_pairs(df: pd.DataFrame,
                      awa_sensors: List[str],
                      aws_sensors: List[str],
                      fusion_method: str = 'robust',
                      sensor_configs: Optional[Dict] = None,
                      speed_unit: str = 'kph') -> pd.DataFrame:
    """
    Fuse AWA and AWS sensors separately.
    
    Args:
        df: DataFrame with sensor columns
        awa_sensors: List of AWA sensor column names
        aws_sensors: List of AWS sensor column names
        fusion_method: 'robust' or 'weighted'
        sensor_configs: Required if fusion_method='weighted'
        
    Returns:
        DataFrame with 'Awa_fused_deg' and ``Aws_fused_{speed_unit}`` columns
    """
    if speed_unit not in ('kph', 'kts'):
        raise ValueError(f"speed_unit must be 'kph' or 'kts', got {speed_unit!r}")
    aws_fused_name = f'Aws_fused_{speed_unit}'
    df_result = df.copy()
    
    # Fuse AWA sensors
    if len(awa_sensors) > 0:
        if fusion_method == 'robust':
            df_awa = fuse_sensors_robust(df, awa_sensors)
            df_result['Awa_fused_deg'] = df_awa['value_fused']
            df_result['Awa_n_sensors'] = df_awa['n_sensors_used']
            df_result['Awa_uncertainty'] = df_awa['fusion_uncertainty']
            
            # Copy outlier flags
            for sensor in awa_sensors:
                if f'{sensor}_outlier' in df_awa.columns:
                    df_result[f'{sensor}_outlier'] = df_awa[f'{sensor}_outlier']
        
        elif fusion_method == 'weighted':
            if sensor_configs is None:
                raise ValueError("sensor_configs required for weighted fusion")
            df_awa = fuse_sensors_weighted(df, sensor_configs, weight_method='quality')
            df_result['Awa_fused_deg'] = df_awa['value_fused']
            df_result.attrs['awa_fusion_weights'] = df_awa.attrs.get('fusion_weights', {})
    
    # Fuse AWS sensors
    if len(aws_sensors) > 0:
        if fusion_method == 'robust':
            df_aws = fuse_sensors_robust(df, aws_sensors)
            df_result[aws_fused_name] = df_aws['value_fused']
            df_result['Aws_n_sensors'] = df_aws['n_sensors_used']
            df_result['Aws_uncertainty'] = df_aws['fusion_uncertainty']
            
            # Copy outlier flags
            for sensor in aws_sensors:
                if f'{sensor}_outlier' in df_aws.columns:
                    df_result[f'{sensor}_outlier'] = df_aws[f'{sensor}_outlier']
        
        elif fusion_method == 'weighted':
            if sensor_configs is None:
                raise ValueError("sensor_configs required for weighted fusion")
            df_aws = fuse_sensors_weighted(df, sensor_configs, weight_method='quality')
            df_result[aws_fused_name] = df_aws['value_fused']
            df_result.attrs['aws_fusion_weights'] = df_aws.attrs.get('fusion_weights', {})
    
    return df_result


def compute_fusion_statistics(df: pd.DataFrame,
                              sensor_list: List[str],
                              fused_column: str = 'value_fused') -> Dict:
    """
    Compute diagnostic statistics for fusion quality.
    
    Args:
        df: DataFrame with sensor and fused columns
        sensor_list: List of sensor column names
        fused_column: Name of fused value column
        
    Returns:
        Dictionary with fusion statistics
    """
    stats = {
        'sensors': {},
        'overall': {}
    }
    
    fused = df[fused_column].dropna()
    
    if len(fused) == 0:
        return stats
    
    # Per-sensor RMSE vs fused solution
    for sensor in sensor_list:
        if sensor not in df.columns:
            continue
        
        # Find common valid indices
        common_idx = fused.index.intersection(df[sensor].dropna().index)
        
        if len(common_idx) > 0:
            diff = df.loc[common_idx, sensor] - fused.loc[common_idx]
            
            stats['sensors'][sensor] = {
                'rmse': np.sqrt(np.mean(diff**2)),
                'mae': np.mean(np.abs(diff)),
                'bias': np.mean(diff),
                'std': np.std(diff),
                'correlation': df.loc[common_idx, sensor].corr(fused.loc[common_idx]),
                'n_samples': len(common_idx)
            }
    
    # Overall statistics
    if 'n_sensors_used' in df.columns:
        n_used = df['n_sensors_used']
        stats['overall']['mean_sensors_used'] = n_used.mean()
        stats['overall']['min_sensors_used'] = n_used.min()
        stats['overall']['outlier_rate'] = (n_used < len(sensor_list)).sum() / len(n_used) * 100
    
    if 'fusion_uncertainty' in df.columns:
        uncertainty = df['fusion_uncertainty'].dropna()
        if len(uncertainty) > 0:
            stats['overall']['mean_uncertainty'] = uncertainty.mean()
            stats['overall']['max_uncertainty'] = uncertainty.max()
    
    return stats


def print_fusion_report(fusion_stats: Dict, sensor_list: List[str]):
    """
    Print human-readable fusion quality report.
    
    Args:
        fusion_stats: Output from compute_fusion_statistics()
        sensor_list: List of sensor names
    """
    print("\n" + "="*30)
    print("SENSOR FUSION QUALITY REPORT")
    print("="*30)
    
    # Per-sensor agreement with fusion
    print("\nPer-Sensor Agreement with Fused Solution:")
    print(f"{'Sensor':<25} {'RMSE':>10} {'MAE':>10} {'Bias':>10} {'Corr':>10} {'N':>10}")
    print("-" * 80)
    
    for sensor in sensor_list:
        if sensor in fusion_stats['sensors']:
            s = fusion_stats['sensors'][sensor]
            print(f"{sensor:<25} {s['rmse']:>10.3f} {s['mae']:>10.3f} "
                  f"{s['bias']:>+10.3f} {s['correlation']:>10.3f} {s['n_samples']:>10,}")
    
    # Overall fusion statistics
    if fusion_stats['overall']:
        print("\nOverall Fusion Statistics:")
        overall = fusion_stats['overall']
        
        if 'mean_sensors_used' in overall:
            print(f"  Mean sensors used: {overall['mean_sensors_used']:.2f} / {len(sensor_list)}")
            print(f"  Outlier rejection rate: {overall['outlier_rate']:.1f}%")
        
        if 'mean_uncertainty' in overall:
            print(f"  Mean uncertainty: {overall['mean_uncertainty']:.3f}")
            print(f"  Max uncertainty: {overall['max_uncertainty']:.3f}")
    
    print("="*30)
