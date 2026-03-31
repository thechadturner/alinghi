"""
Batch Calibration Analysis Script

Runs calibration on multiple data sources and reports true wind improvements.
"""

import pandas as pd
import numpy as np
from datetime import datetime
from typing import List, Dict, Tuple
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from utilities.cal_utils import (
    calibrate_sailing_data,
    load_calibration_data,
    CalibrationConfig,
    compute_initial_true_wind,
    add_tack_and_hour,
    calibrate_and_fuse_pipeline
)


# ============================================================================
# CONFIGURATION
# ============================================================================

# Processing mode: 'single' or 'multi'
MODE = 'multi'  # Set to 'single' for single-sensor, 'multi' for multi-sensor fusion

# Base configuration (API credentials from environment — do not commit secrets)
_API_TOKEN = os.environ.get("SYSTEM_KEY")
if not _API_TOKEN:
    raise RuntimeError("SYSTEM_KEY must be set in the environment to run batch_calibration_analysis.py")

BASE_CONFIG = CalibrationConfig(
    api_token=_API_TOKEN,
    class_name="ac40",
    project_id="1",
    date="20260118",  
    source_name="GER",
    rs="100ms",
    timezone="UTC"
)


class SourceConfig:
    """Configuration for a single data source."""
    def __init__(self, date: str, source_name: str):
        self.date = date
        self.source_name = source_name
        
    def __repr__(self):
        return f"{self.date}_{self.source_name}"


# List of data sources to process
DATA_SOURCES = [
    SourceConfig('20260118', 'AUS'),
    SourceConfig('20260118', 'ITA'),
    SourceConfig('20260118', 'GER'),
    SourceConfig('20260118', 'SWE'),
    SourceConfig('20260118', 'GBR'),
    SourceConfig('20260118', 'BRA'),
    SourceConfig('20260118', 'SUI'),
    SourceConfig('20260118', 'CAN'),
    SourceConfig('20260118', 'USA'),
]

# Channel configuration
AWA_CHANNEL = 'Awa_deg'  # For single-sensor mode
LEEWAY_CHANNEL = 'Lwy_deg'

# Multi-sensor configuration
AWA_SENSORS = ['Awa_bow_deg', 'Awa_mhu_deg']  # For multi-sensor mode
AWS_SENSORS = ['Aws_bow_kph', 'Aws_mhu_kph']  # Optional
FUSION_METHOD = 'robust'  # 'robust' or 'weighted'

CHANNELS = [
    {'name': 'Datetime', 'type': 'datetime'},
    {'name': 'ts', 'type': 'float'},
    {'name': 'Awa_deg', 'type': 'angle180'},
    {'name': 'Awa_bow_deg', 'type': 'angle180'},
    {'name': 'Awa_mhu_deg', 'type': 'angle180'},
    {'name': 'Aws_kph', 'type': 'float'},
    {'name': 'Aws_bow_kph', 'type': 'float'},
    {'name': 'Aws_mhu_kph', 'type': 'float'},
    {'name': 'Bsp_kph', 'type': 'float'},
    {'name': 'Lwy_deg', 'type': 'float'},
    {'name': 'Hdg_deg', 'type': 'angle360'},  # REQUIRED for TWD computation
    {'name': 'Cog_deg', 'type': 'angle360'},
    {'name': 'Sog_kph', 'type': 'float'},
    {'name': 'RH_lwd_mm', 'type': 'float'},
    {'name': 'JIB_sheet_load_kgf', 'type': 'float'},
    {'name': 'DB_cant_eff_lwd_deg', 'type': 'float'},
    {'name': 'Grade', 'type': 'int'},
]


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def load_data(date: str, source_name: str) -> pd.DataFrame:
    """Load calibration data from API."""
    # Create config for this specific source
    config = CalibrationConfig(
        class_name=BASE_CONFIG.class_name,
        project_id=BASE_CONFIG.project_id,
        api_token=BASE_CONFIG.api_token,
        date=date,
        source_name=source_name,
        rs=BASE_CONFIG.rs,
        timezone=BASE_CONFIG.timezone
    )
    
    # Load data using cal_utils function (filters to Grade 3)
    df = load_calibration_data(config, channel_list=CHANNELS)
    
    return df


def compute_twd(df: pd.DataFrame) -> pd.DataFrame:
    """Compute True Wind Direction from TWA and Heading."""
    df = df.copy()
    
    if 'Hdg_deg' not in df.columns:
        raise ValueError("Hdg_deg column required for TWD computation")
    
    # TWD = Heading + TWA (with wrapping)
    df['Twd_deg'] = (df['Hdg_deg'] + df['Twa_deg']) % 360
    
    return df


def compute_statistics(df: pd.DataFrame) -> Dict[str, float]:
    """Compute key statistics for true wind, AWA, and normalized leeway."""
    # Compute normalized leeway if not present
    if 'normalized_lwy' not in df.columns and LEEWAY_CHANNEL in df.columns and 'Twa_deg' in df.columns:
        df['normalized_lwy'] = df[LEEWAY_CHANNEL] * np.sign(df['Twa_deg'])
    
    stats = {
        'tws_mean': df['Tws_kph'].mean(),
        'tws_std': df['Tws_kph'].std(),
        'twd_mean': df['Twd_deg'].mean(),
        'twd_std': df['Twd_deg'].std(),
        'awa_mean': df[AWA_CHANNEL].abs().mean(),
        'awa_std': df[AWA_CHANNEL].std(),
        'lwy_norm_mean': df['normalized_lwy'].mean() if 'normalized_lwy' in df.columns else 0.0,
        'lwy_norm_std': df['normalized_lwy'].std() if 'normalized_lwy' in df.columns else 0.0,
        'n_samples': len(df),
    }
    return stats


def process_source(config: SourceConfig) -> Tuple[Dict[str, float], Dict[str, float]]:
    """
    Process a single data source and return before/after statistics.
    
    Returns:
        Tuple of (stats_before, stats_after)
    """
    # Create CalibrationConfig for this source
    cal_config = CalibrationConfig(
        api_token=BASE_CONFIG.api_token,
        class_name=BASE_CONFIG.class_name,
        project_id=BASE_CONFIG.project_id,
        date=config.date,
        source_name=config.source_name,
        rs=BASE_CONFIG.rs,
        timezone=BASE_CONFIG.timezone
    )
    
    # Load data
    df = load_data(config.date, config.source_name)
    
    # Compute initial true wind (BEFORE calibration) - adds Tws_kph, Twa_deg columns
    df_before = compute_initial_true_wind(df, awa_col=AWA_CHANNEL, lwy_col=LEEWAY_CHANNEL)
    
    # Compute TWD
    df_before = compute_twd(df_before)
    stats_before = compute_statistics(df_before)
    
    # Run calibration (loads data internally from config)
    calibration_result = calibrate_sailing_data(
        config=cal_config,
        awa_channel_name=AWA_CHANNEL,
        lwy_channel_name=LEEWAY_CHANNEL
    )
    
    df_after = calibration_result['data']
    
    # Compute TWD for calibrated data
    df_after = compute_twd(df_after)
    stats_after = compute_statistics(df_after)
    
    return stats_before, stats_after


def process_source_multi_sensor(config: SourceConfig) -> Tuple[Dict[str, float], Dict[str, float], Dict]:
    """
    Process a single data source using multi-sensor calibration and fusion.
    
    Returns:
        Tuple of (stats_before, stats_after, multi_sensor_info)
    """
    # Create CalibrationConfig for this source
    cal_config = CalibrationConfig(
        api_token=BASE_CONFIG.api_token,
        class_name=BASE_CONFIG.class_name,
        project_id=BASE_CONFIG.project_id,
        date=config.date,
        source_name=config.source_name,
        rs=BASE_CONFIG.rs,
        timezone=BASE_CONFIG.timezone
    )
    
    # Load data
    df = load_data(config.date, config.source_name)
    
    # Compute initial true wind (BEFORE calibration) using first sensor
    df_before = compute_initial_true_wind(df, awa_col=AWA_SENSORS[0], lwy_col=LEEWAY_CHANNEL)
    
    # Compute TWD
    df_before = compute_twd(df_before)
    stats_before = compute_statistics(df_before)
    
    # Run multi-sensor calibration and fusion
    pipeline_result = calibrate_and_fuse_pipeline(
        config=cal_config,
        awa_sensors=AWA_SENSORS,
        aws_sensors=AWS_SENSORS,
        lwy_sensor=LEEWAY_CHANNEL,
        fusion_method=FUSION_METHOD,
        outlier_threshold=2.0,
    )
    
    df_after = pipeline_result['data']
    multi_results = pipeline_result['multi_sensor_results']
    fusion_stats = pipeline_result['fusion_stats']
    
    # Compute TWD for fused data (uses Twd_fused_deg if available)
    if 'Twd_fused_deg' not in df_after.columns:
        df_after = compute_twd(df_after)
    
    # Get stats using fused columns
    df_after_for_stats = df_after.copy()
    if 'Awa_fused_deg' in df_after_for_stats.columns:
        df_after_for_stats[AWA_CHANNEL] = df_after_for_stats['Awa_fused_deg']
    if 'Tws_fused_kph' in df_after_for_stats.columns:
        df_after_for_stats['Tws_kph'] = df_after_for_stats['Tws_fused_kph']
    if 'Twd_fused_deg' in df_after_for_stats.columns:
        df_after_for_stats['Twd_deg'] = df_after_for_stats['Twd_fused_deg']
    
    stats_after = compute_statistics(df_after_for_stats)
    
    # Extract multi-sensor info
    multi_info = {
        'sensor_count': len(multi_results['recommended_sensors']),
        'sensors': multi_results['recommended_sensors'],
        'quality_scores': {s: multi_results['sensor_calibrations'][s]['quality_score'] 
                          for s in multi_results['recommended_sensors']},
        'fusion_method': pipeline_result['fusion_method']
    }
    
    return stats_before, stats_after, multi_info


# ============================================================================
# MAIN BATCH PROCESSING
# ============================================================================

def run_batch_analysis():
    """Run calibration analysis on all data sources and print results."""
    
    print("\n" + "="*30)
    print("BATCH CALIBRATION ANALYSIS")
    print("="*30)
    print(f"\nMode: {MODE.upper()}")
    print(f"Processing {len(DATA_SOURCES)} data source(s)...")
    
    if MODE == 'single':
        print(f"AWA Channel: {AWA_CHANNEL}")
        print(f"Leeway Channel: {LEEWAY_CHANNEL}")
    else:  # multi
        print(f"AWA Sensors: {AWA_SENSORS}")
        print(f"AWS Sensors: {AWS_SENSORS}")
        print(f"Leeway Sensor: {LEEWAY_CHANNEL}")
        print(f"Fusion Method: {FUSION_METHOD}")
    print()
    
    results = []
    
    # Process each source
    for i, config in enumerate(DATA_SOURCES, 1):
        print(f"[{i}/{len(DATA_SOURCES)}] Processing {config}...")
        
        try:
            if MODE == 'single':
                stats_before, stats_after = process_source(config)
                multi_info = None
            else:  # multi
                stats_before, stats_after, multi_info = process_source_multi_sensor(config)
            
            result = {
                'source': str(config),
                'date': config.date,
                'source_name': config.source_name,
                'n_samples': stats_before['n_samples'],
                'tws_before': stats_before['tws_mean'],
                'tws_after': stats_after['tws_mean'],
                'tws_delta': stats_after['tws_mean'] - stats_before['tws_mean'],
                'tws_std_before': stats_before['tws_std'],
                'tws_std_after': stats_after['tws_std'],
                'twd_before': stats_before['twd_mean'],
                'twd_after': stats_after['twd_mean'],
                'twd_delta': stats_after['twd_mean'] - stats_before['twd_mean'],
                'twd_std_before': stats_before['twd_std'],
                'twd_std_after': stats_after['twd_std'],
                'awa_before': stats_before['awa_mean'],
                'awa_after': stats_after['awa_mean'],
                'awa_delta': stats_after['awa_mean'] - stats_before['awa_mean'],
                'lwy_norm_before': stats_before['lwy_norm_mean'],
                'lwy_norm_after': stats_after['lwy_norm_mean'],
                'lwy_norm_delta': stats_after['lwy_norm_mean'] - stats_before['lwy_norm_mean'],
            }
            
            # Add multi-sensor info if available
            if multi_info:
                result['sensor_count'] = multi_info['sensor_count']
                result['sensors'] = multi_info['sensors']
                result['quality_scores'] = multi_info['quality_scores']
                result['fusion_method'] = multi_info['fusion_method']
            
            results.append(result)
            
            success_msg = (f"      [OK] Complete: TWS {result['tws_before']:.2f} -> {result['tws_after']:.2f} kph "
                          f"({result['tws_delta']:+.2f}), "
                          f"TWD {result['twd_before']:.1f} -> {result['twd_after']:.1f}deg "
                          f"({result['twd_delta']:+.1f}deg)")
            
            if multi_info:
                success_msg += f", Sensors: {multi_info['sensor_count']}"
            
            print(success_msg)
            
        except Exception as e:
            print(f"      [ERROR] {e}")
            import traceback
            traceback.print_exc()
            continue
    
    # Print summary table
    print("\n" + "="*30)
    print("SUMMARY RESULTS")
    print("="*30)
    print()
    
    if not results:
        print("No results to display - all sources failed.")
        return
    
    # Print header
    print(f"{'Source':<20} {'N':>7} {'TWS Before':>11} {'TWS After':>11} {'ΔTWS':>8} "
          f"{'TWD Before':>11} {'TWD After':>11} {'ΔTWD':>8}")
    print(f"{'':20} {'':>7} {'(kph)':>11} {'(kph)':>11} {'(kph)':>8} "
          f"{'(°)':>11} {'(°)':>11} {'(°)':>8}")
    print("-" * 100)
    
    # Print each result
    for r in results:
        print(f"{r['source']:<20} {r['n_samples']:>7,} "
              f"{r['tws_before']:>11.2f} {r['tws_after']:>11.2f} {r['tws_delta']:>+8.2f} "
              f"{r['twd_before']:>11.1f} {r['twd_after']:>11.1f} {r['twd_delta']:>+8.1f}")
    
    # Print averages if multiple sources
    if len(results) > 1:
        print("-" * 100)
        avg_tws_delta = np.mean([r['tws_delta'] for r in results])
        avg_twd_delta = np.mean([r['twd_delta'] for r in results])
        avg_tws_before = np.mean([r['tws_before'] for r in results])
        avg_tws_after = np.mean([r['tws_after'] for r in results])
        avg_twd_before = np.mean([r['twd_before'] for r in results])
        avg_twd_after = np.mean([r['twd_after'] for r in results])
        
        print(f"{'AVERAGE':<20} {'':<7} "
              f"{avg_tws_before:>11.2f} {avg_tws_after:>11.2f} {avg_tws_delta:>+8.2f} "
              f"{avg_twd_before:>11.1f} {avg_twd_after:>11.1f} {avg_twd_delta:>+8.1f}")
    
    # Print standard deviation improvements
    print("\n" + "="*30)
    print("STANDARD DEVIATION IMPROVEMENTS")
    print("="*30)
    print()
    print(f"{'Source':<20} {'TWS σ Before':>13} {'TWS σ After':>13} {'Improve':>9} "
          f"{'TWD σ Before':>13} {'TWD σ After':>13} {'Improve':>9}")
    print(f"{'':20} {'(kph)':>13} {'(kph)':>13} {'':>9} "
          f"{'(°)':>13} {'(°)':>13} {'':>9}")
    print("-" * 100)
    
    for r in results:
        tws_std_improve = (r['tws_std_before'] - r['tws_std_after']) / r['tws_std_before'] * 100
        twd_std_improve = (r['twd_std_before'] - r['twd_std_after']) / r['twd_std_before'] * 100
        
        print(f"{r['source']:<20} "
              f"{r['tws_std_before']:>13.2f} {r['tws_std_after']:>13.2f} {tws_std_improve:>+8.1f}% "
              f"{r['twd_std_before']:>13.2f} {r['twd_std_after']:>13.2f} {twd_std_improve:>+8.1f}%")
    
    if len(results) > 1:
        print("-" * 100)
        avg_tws_std_before = np.mean([r['tws_std_before'] for r in results])
        avg_tws_std_after = np.mean([r['tws_std_after'] for r in results])
        avg_twd_std_before = np.mean([r['twd_std_before'] for r in results])
        avg_twd_std_after = np.mean([r['twd_std_after'] for r in results])
        avg_tws_std_improve = (avg_tws_std_before - avg_tws_std_after) / avg_tws_std_before * 100
        avg_twd_std_improve = (avg_twd_std_before - avg_twd_std_after) / avg_twd_std_before * 100
        
        print(f"{'AVERAGE':<20} "
              f"{avg_tws_std_before:>13.2f} {avg_tws_std_after:>13.2f} {avg_tws_std_improve:>+8.1f}% "
              f"{avg_twd_std_before:>13.2f} {avg_twd_std_after:>13.2f} {avg_twd_std_improve:>+8.1f}%")
    
    # Print AWA and Normalized Leeway comparison
    print("\n" + "="*30)
    print("AWA AND NORMALIZED LEEWAY COMPARISON")
    print("="*30)
    print()
    print(f"{'Source':<20} {'|AWA| Before':>12} {'|AWA| After':>12} {'Δ|AWA|':>10} "
          f"{'Lwy Norm Before':>16} {'Lwy Norm After':>16} {'ΔLwy Norm':>12}")
    print(f"{'':20} {'(°)':>12} {'(°)':>12} {'(°)':>10} "
          f"{'(°)':>16} {'(°)':>16} {'(°)':>12}")
    print("-" * 110)
    
    for r in results:
        print(f"{r['source']:<20} "
              f"{r['awa_before']:>12.2f} {r['awa_after']:>12.2f} {r['awa_delta']:>+10.2f} "
              f"{r['lwy_norm_before']:>16.3f} {r['lwy_norm_after']:>16.3f} {r['lwy_norm_delta']:>+12.3f}")
    
    if len(results) > 1:
        print("-" * 110)
        avg_awa_before = np.mean([r['awa_before'] for r in results])
        avg_awa_after = np.mean([r['awa_after'] for r in results])
        avg_awa_delta = np.mean([r['awa_delta'] for r in results])
        avg_lwy_before = np.mean([r['lwy_norm_before'] for r in results])
        avg_lwy_after = np.mean([r['lwy_norm_after'] for r in results])
        avg_lwy_delta = np.mean([r['lwy_norm_delta'] for r in results])
        
        print(f"{'AVERAGE':<20} "
              f"{avg_awa_before:>12.2f} {avg_awa_after:>12.2f} {avg_awa_delta:>+10.2f} "
              f"{avg_lwy_before:>16.3f} {avg_lwy_after:>16.3f} {avg_lwy_delta:>+12.3f}")
    
    # Calculate and display TWS normalization coefficients
    print("\n" + "="*30)
    print("TWS NORMALIZATION COEFFICIENTS")
    print("="*30)
    print()
    print("Suggested multiplier coefficients to normalize each source to mean TWS:")
    print()
    
    if len(results) > 1:
        avg_tws_after = np.mean([r['tws_after'] for r in results])
        print(f"Target Mean TWS: {avg_tws_after:.2f} kph\n")
        print(f"{'Source':<20} {'Current TWS':>12} {'Target TWS':>12} {'Coefficient':>12} {'New TWS':>12}")
        print(f"{'':20} {'(kph)':>12} {'(kph)':>12} {'':>12} {'(kph)':>12}")
        print("-" * 70)
        
        for r in results:
            coefficient = avg_tws_after / r['tws_after'] if r['tws_after'] > 0 else 1.0
            new_tws = r['tws_after'] * coefficient
            print(f"{r['source']:<20} "
                  f"{r['tws_after']:>12.2f} {avg_tws_after:>12.2f} {coefficient:>12.4f} {new_tws:>12.2f}")
    else:
        print("Need multiple sources to calculate normalization coefficients.")
    
    # Calculate and display TWD normalization
    print("\n" + "="*30)
    print("TWD NORMALIZATION OFFSETS")
    print("="*30)
    print()
    print("Suggested offset adjustments to normalize each source to mean TWD:")
    print()
    
    if len(results) > 1:
        avg_twd_after = np.mean([r['twd_after'] for r in results])
        print(f"Target Mean TWD: {avg_twd_after:.1f}°\n")
        print(f"{'Source':<20} {'Current TWD':>12} {'Target TWD':>12} {'Offset':>12} {'New TWD':>12}")
        print(f"{'':20} {'(°)':>12} {'(°)':>12} {'(°)':>12} {'(°)':>12}")
        print("-" * 70)
        
        for r in results:
            offset = avg_twd_after - r['twd_after']
            new_twd = r['twd_after'] + offset
            print(f"{r['source']:<20} "
                  f"{r['twd_after']:>12.1f} {avg_twd_after:>12.1f} {offset:>+12.1f} {new_twd:>12.1f}")
    else:
        print("Need multiple sources to calculate normalization offsets.")
    
    print("\n" + "="*30)
    print()


if __name__ == "__main__":
    run_batch_analysis()
