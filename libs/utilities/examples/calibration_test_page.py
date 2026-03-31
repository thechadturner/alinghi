"""
Calibration Test Page - Interactive testing and validation

This script loads real sailing data, runs calibration, and provides detailed
before/after comparisons to evaluate calibration quality.

Usage:
    1. Update CONFIG with your API credentials and data source
    2. Update CHANNELS list to match your boat's sensor names
       (e.g., change 'Awa_deg' to 'Awa_bow_deg' or 'Awa_mhu_deg')
    3. Update AWA_CHANNEL to match the AWA sensor you want to calibrate
    4. Run: python examples/calibration_test_page.py
    
The script will:
    - Fetch real data from your API for the specified channels
    - Run calibration to equalize AWA and leeway between tacks
    - Generate detailed before/after comparison reports
    - Save calibrated data and plots
"""

import numpy as np
import pandas as pd
from datetime import datetime
import matplotlib.pyplot as plt
from pathlib import Path

from utilities.cal_utils import (
    CalibrationConfig,
    calibrate_sailing_data_v3,
    get_calibrated_true_wind,
    load_calibration_data,  # Fetches REAL data from your API using get_channel_values()
    compute_initial_true_wind,
    add_tack_and_hour
)


# ============================================================================
# CONFIGURATION - UPDATE THESE VALUES
# ============================================================================

CONFIG = CalibrationConfig(
    api_token="8493d8284a19ae9f5a23cafdec7de5bfccdce799d651d053e81bc2adc75a4002",
    class_name="ac40",
    project_id="1",
    date="20260118",  
    source_name="GER",
    rs="100ms",
    timezone="UTC"
)

# Channels to request from API
# Format: [{'name': 'channel_name', 'type': 'data_type'}, ...]
# Common types: 'float', 'angle180', 'angle360', 'datetime', 'int'
CHANNELS = [
    {'name': 'Datetime', 'type': 'datetime'},
    {'name': 'ts', 'type': 'float'},
    {'name': 'Awa_deg', 'type': 'angle180'},      # Apparent Wind Angle
    {'name': 'Aws_kph', 'type': 'float'},         # Apparent Wind Speed
    {'name': 'Bsp_kph', 'type': 'float'},         # Boat Speed
    {'name': 'Lwy_deg', 'type': 'float'},         # Leeway
    {'name': 'Hdg_deg', 'type': 'angle360'},      # Heading
    {'name': 'Cog_deg', 'type': 'angle360'},      # Course Over Ground
    {'name': 'Sog_kph', 'type': 'float'},         # Speed Over Ground
    {'name': 'RH_lwd_mm', 'type': 'float'},       # Righting moment (for leeway model)
    {'name': 'JIB_sheet_load_kgf', 'type': 'float'},  # Jib sheet load (for leeway model)
    {'name': 'DB_cant_eff_lwd_deg', 'type': 'float'}, # Daggerboard cant (for leeway model)
    {'name': 'Grade', 'type': 'int'},             # Data quality grade (will filter to 3)
]

AWA_CHANNEL = 'Awa_deg'  # Must match one of the channel names above
LEEWAY_CHANNEL = 'Lwy_deg'  # Must match one of the channel names above

SAVE_RESULTS = True  # Save calibrated data to CSV
SAVE_PLOTS = True    # Save comparison plots as images


# ============================================================================
# ANALYSIS FUNCTIONS
# ============================================================================

def compute_statistics(df, prefix=""):
    """Compute key statistics for calibration evaluation."""
    stats = {}
    
    # Filter to Grade 3 only if Grade column exists
    if 'Grade' in df.columns:
        df = df[df['Grade'] == 3].copy()
    
    # Ensure normalized leeway column exists
    if 'normalized_lwy' not in df.columns and LEEWAY_CHANNEL in df.columns and 'Twa_deg' in df.columns:
        df['normalized_lwy'] = df[LEEWAY_CHANNEL] * np.sign(df['Twa_deg'])
    
    # True wind statistics
    stats[f'{prefix}tws_mean'] = df['Tws_kph'].mean()
    stats[f'{prefix}tws_std'] = df['Tws_kph'].std()
    stats[f'{prefix}twa_mean'] = df['Twa_deg'].mean()
    stats[f'{prefix}twa_std'] = df['Twa_deg'].std()
    stats[f'{prefix}twd_mean'] = df['Twd_deg'].mean()
    stats[f'{prefix}twd_std'] = df['Twd_deg'].std()
    
    # Sensor statistics (using normalized leeway)
    stats[f'{prefix}awa_mean'] = df[AWA_CHANNEL].abs().mean()
    stats[f'{prefix}awa_std'] = df[AWA_CHANNEL].std()
    stats[f'{prefix}lwy_mean'] = df['normalized_lwy'].mean()
    stats[f'{prefix}lwy_std'] = df['normalized_lwy'].std()
    
    # Tack balance
    port_data = df[df['tack'] == 'port']
    stbd_data = df[df['tack'] == 'starboard']
    
    if len(port_data) > 0 and len(stbd_data) > 0:
        stats[f'{prefix}awa_port_mean'] = port_data[AWA_CHANNEL].abs().mean()
        stats[f'{prefix}awa_stbd_mean'] = stbd_data[AWA_CHANNEL].abs().mean()
        stats[f'{prefix}awa_tack_diff'] = abs(stats[f'{prefix}awa_port_mean'] - stats[f'{prefix}awa_stbd_mean'])
        
        stats[f'{prefix}lwy_port_mean'] = port_data['normalized_lwy'].mean()
        stats[f'{prefix}lwy_stbd_mean'] = stbd_data['normalized_lwy'].mean()
        stats[f'{prefix}lwy_tack_diff'] = abs(stats[f'{prefix}lwy_port_mean'] - stats[f'{prefix}lwy_stbd_mean'])
    
    return stats


def compare_statistics(stats_before, stats_after):
    """Compare before/after statistics and compute improvements."""
    comparison = {}
    
    for key in stats_before.keys():
        if key.startswith('before_'):
            metric = key.replace('before_', '')
            after_key = f'after_{metric}'
            
            if after_key in stats_after:
                before_val = stats_before[key]
                after_val = stats_after[after_key]
                
                # Compute change
                change = after_val - before_val
                
                # For std dev and differences, negative change is improvement
                if 'std' in metric or 'diff' in metric:
                    pct_improvement = ((before_val - after_val) / before_val * 100) if before_val != 0 else 0
                else:
                    pct_improvement = None
                
                comparison[metric] = {
                    'before': before_val,
                    'after': after_val,
                    'change': change,
                    'improvement_pct': pct_improvement
                }
    
    return comparison


def analyze_residuals(df):
    """Analyze residuals by tack."""
    analysis = {}
    
    if 'awa_residual' in df.columns:
        port = df[df['tack'] == 'port']['awa_residual']
        stbd = df[df['tack'] == 'starboard']['awa_residual']
        
        analysis['awa'] = {
            'port_mean': port.mean(),
            'port_std': port.std(),
            'stbd_mean': stbd.mean(),
            'stbd_std': stbd.std(),
            'balance': abs(abs(port.mean()) - abs(stbd.mean()))
        }
    
    if 'lwy_residual' in df.columns:
        port = df[df['tack'] == 'port']['lwy_residual']
        stbd = df[df['tack'] == 'starboard']['lwy_residual']
        
        analysis['lwy'] = {
            'port_mean': port.mean(),
            'port_std': port.std(),
            'stbd_mean': stbd.mean(),
            'stbd_std': stbd.std(),
            'balance': abs(abs(port.mean()) - abs(stbd.mean()))
        }
    
    return analysis


def print_report(stats_before, stats_after, comparison, residuals_before, residuals_after, offsets):
    """Print comprehensive calibration report."""
    
    print("\n" + "="*30)
    print("CALIBRATION TEST REPORT")
    print("="*30)
    
    print(f"\nData Source: {CONFIG.date} - {CONFIG.source_name}")
    print(f"AWA Channel: {AWA_CHANNEL}")
    print(f"Leeway Channel: {LEEWAY_CHANNEL}")
    print(f"Total samples: {len(stats_before.get('raw_data', []))}")
    
    # Tack distribution
    print("\n" + "-"*30)
    print("TACK DISTRIBUTION")
    print("-"*30)
    tack_counts = stats_before.get('tack_counts', {})
    total = sum(tack_counts.values())
    for tack, count in tack_counts.items():
        pct = count / total * 100 if total > 0 else 0
        print(f"  {tack:10s}: {count:6d} samples ({pct:5.1f}%)")
    
    # True wind comparison
    print("\n" + "-"*30)
    print("TRUE WIND COMPARISON")
    print("-"*30)
    print(f"{'Metric':<20s} {'Before':>12s} {'After':>12s} {'Change':>12s} {'Improve':>10s}")
    print("-"*30)
    
    tw_metrics = ['tws_mean', 'tws_std', 'twa_std', 'twd_std']
    for metric in tw_metrics:
        if metric in comparison:
            c = comparison[metric]
            improve = f"{c['improvement_pct']:+.1f}%" if c['improvement_pct'] is not None else "N/A"
            print(f"{metric:<20s} {c['before']:12.3f} {c['after']:12.3f} {c['change']:+12.3f} {improve:>10s}")
    
    # AWA comparison
    print("\n" + "-"*30)
    print("APPARENT WIND ANGLE (AWA) COMPARISON")
    print("-"*30)
    print(f"{'Metric':<25s} {'Before':>12s} {'After':>12s} {'Change':>12s} {'Improve':>10s}")
    print("-"*30)
    
    awa_metrics = ['awa_port_mean', 'awa_stbd_mean', 'awa_tack_diff', 'awa_std']
    for metric in awa_metrics:
        if metric in comparison:
            c = comparison[metric]
            improve = f"{c['improvement_pct']:+.1f}%" if c['improvement_pct'] is not None else "N/A"
            print(f"{metric:<25s} {c['before']:12.3f} {c['after']:12.3f} {c['change']:+12.3f} {improve:>10s}")
    
    # Leeway comparison
    print("\n" + "-"*30)
    print("NORMALIZED LEEWAY COMPARISON")
    print("-"*30)
    print(f"{'Metric':<25s} {'Before':>12s} {'After':>12s} {'Change':>12s} {'Improve':>10s}")
    print("-"*30)
    
    lwy_metrics = ['lwy_port_mean', 'lwy_stbd_mean', 'lwy_tack_diff', 'lwy_std']
    for metric in lwy_metrics:
        if metric in comparison:
            c = comparison[metric]
            improve = f"{c['improvement_pct']:+.1f}%" if c['improvement_pct'] is not None else "N/A"
            print(f"{metric:<25s} {c['before']:12.3f} {c['after']:12.3f} {c['change']:+12.3f} {improve:>10s}")
    
    # Residuals
    print("\n" + "-"*30)
    print("RESIDUAL ANALYSIS - BEFORE CALIBRATION")
    print("-"*30)
    if 'awa' in residuals_before:
        awa = residuals_before['awa']
        print(f"AWA Residuals:")
        print(f"  Port:      mean={awa['port_mean']:+7.3f}°  std={awa['port_std']:6.3f}°")
        print(f"  Starboard: mean={awa['stbd_mean']:+7.3f}°  std={awa['stbd_std']:6.3f}°")
        print(f"  Balance:   {awa['balance']:.3f}° (lower is better)")
    
    if 'lwy' in residuals_before:
        lwy = residuals_before['lwy']
        print(f"\nLeeway Residuals:")
        print(f"  Port:      mean={lwy['port_mean']:+7.3f}°  std={lwy['port_std']:6.3f}°")
        print(f"  Starboard: mean={lwy['stbd_mean']:+7.3f}°  std={lwy['stbd_std']:6.3f}°")
        print(f"  Balance:   {lwy['balance']:.3f}° (lower is better)")
    
    print("\n" + "-"*30)
    print("RESIDUAL ANALYSIS - AFTER CALIBRATION")
    print("-"*30)
    if 'awa' in residuals_after:
        awa = residuals_after['awa']
        print(f"AWA Residuals:")
        print(f"  Port:      mean={awa['port_mean']:+7.3f}°  std={awa['port_std']:6.3f}°")
        print(f"  Starboard: mean={awa['stbd_mean']:+7.3f}°  std={awa['stbd_std']:6.3f}°")
        print(f"  Balance:   {awa['balance']:.3f}° (lower is better)")
        
        if 'awa' in residuals_before:
            improvement = (residuals_before['awa']['balance'] - awa['balance']) / residuals_before['awa']['balance'] * 100
            print(f"  Improvement: {improvement:+.1f}%")
    
    if 'lwy' in residuals_after:
        lwy = residuals_after['lwy']
        print(f"\nLeeway Residuals:")
        print(f"  Port:      mean={lwy['port_mean']:+7.3f}°  std={lwy['port_std']:6.3f}°")
        print(f"  Starboard: mean={lwy['stbd_mean']:+7.3f}°  std={lwy['stbd_std']:6.3f}°")
        print(f"  Balance:   {lwy['balance']:.3f}° (lower is better)")
        
        if 'lwy' in residuals_before:
            improvement = (residuals_before['lwy']['balance'] - lwy['balance']) / residuals_before['lwy']['balance'] * 100
            print(f"  Improvement: {improvement:+.1f}%")
    
    # Offsets summary
    print("\n" + "-"*30)
    print("CALIBRATION OFFSETS")
    print("-"*30)
    
    if 'awa_offsets' in offsets:
        port_vals = list(offsets['awa_offsets']['port'].values())
        stbd_vals = list(offsets['awa_offsets']['starboard'].values())
        print(f"AWA Offsets (48 values, 30-min windows):")
        print(f"  Port Offsets:")
        print(f"    Min:    {min(port_vals):+7.3f}°")
        print(f"    Max:    {max(port_vals):+7.3f}°")
        print(f"    Mean:   {np.mean(port_vals):+7.3f}°")
        print(f"    Std:    {np.std(port_vals):7.3f}°")
        print(f"  Starboard Offsets:")
        print(f"    Min:    {min(stbd_vals):+7.3f}°")
        print(f"    Max:    {max(stbd_vals):+7.3f}°")
        print(f"    Mean:   {np.mean(stbd_vals):+7.3f}°")
        print(f"    Std:    {np.std(stbd_vals):7.3f}°")
        
        # Show sample times
        print(f"\n  Sample offsets:")
        for time in [0.0, 6.0, 12.0, 18.0]:
            hours = int(time)
            port_offset = offsets['awa_offsets']['port'].get(time, 0.0)
            stbd_offset = offsets['awa_offsets']['starboard'].get(time, 0.0)
            print(f"    {hours:02d}:00 → Port:{port_offset:+7.3f}°, Stbd:{stbd_offset:+7.3f}°")
    
    if 'lwy_offsets' in offsets:
        port_vals = list(offsets['lwy_offsets']['port'].values())
        stbd_vals = list(offsets['lwy_offsets']['starboard'].values())
        print(f"\nLeeway Offsets (48 values, 30-min windows):")
        print(f"  Port Offsets:")
        print(f"    Min:    {min(port_vals):+7.3f}°")
        print(f"    Max:    {max(port_vals):+7.3f}°")
        print(f"    Mean:   {np.mean(port_vals):+7.3f}°")
        print(f"    Std:    {np.std(port_vals):7.3f}°")
        print(f"  Starboard Offsets:")
        print(f"    Min:    {min(stbd_vals):+7.3f}°")
        print(f"    Max:    {max(stbd_vals):+7.3f}°")
        print(f"    Mean:   {np.mean(stbd_vals):+7.3f}°")
        print(f"    Std:    {np.std(stbd_vals):7.3f}°")
    
    print("\n" + "="*30)


def create_comparison_plots(df_before, df_after, offsets):
    """Create visualization plots comparing before/after calibration."""
    
    # Keep full data for TWS/TWD distributions (all grades)
    df_before_all = df_before.copy()
    df_after_all = df_after.copy()
    
    # Filter to Grade 3 only for AWA/Leeway comparison plots
    if 'Grade' in df_before.columns:
        df_before = df_before[df_before['Grade'] == 3].copy()
    if 'Grade' in df_after.columns:
        df_after = df_after[df_after['Grade'] == 3].copy()
    
    # Add normalized leeway columns if not present
    if 'normalized_lwy' not in df_before.columns:
        df_before['normalized_lwy'] = df_before[LEEWAY_CHANNEL] * np.sign(df_before['Twa_deg'])
    if 'normalized_lwy' not in df_after.columns:
        df_after['normalized_lwy'] = df_after[LEEWAY_CHANNEL] * np.sign(df_after['Twa_deg'])
    
    # Add upwind/downwind classification (upwind: |TWA| < 90°)
    df_before['sailing_mode'] = df_before['Twa_deg'].abs().apply(lambda x: 'Upwind' if x < 90 else 'Downwind')
    df_after['sailing_mode'] = df_after['Twa_deg'].abs().apply(lambda x: 'Upwind' if x < 90 else 'Downwind')
    
    fig = plt.figure(figsize=(16, 16))
    
    # Plot 1: AWA Upwind - Before vs After
    ax1 = plt.subplot(4, 3, 1)
    awa_upwind_before = df_before[df_before['sailing_mode'] == 'Upwind'][AWA_CHANNEL].abs()
    awa_upwind_after = df_after[df_after['sailing_mode'] == 'Upwind'][AWA_CHANNEL].abs()
    ax1.hist([awa_upwind_before, awa_upwind_after], bins=30, alpha=0.7, 
             label=[f'Before (n={len(awa_upwind_before)})', f'After (n={len(awa_upwind_after)})'])
    ax1.set_xlabel('|AWA| (degrees)')
    ax1.set_ylabel('Frequency')
    ax1.set_title('AWA UPWIND - Before vs After (Grade 3)')
    ax1.legend()
    ax1.grid(True, alpha=0.3)
    
    # Plot 2: AWA Downwind - Before vs After
    ax2 = plt.subplot(4, 3, 2)
    awa_downwind_before = df_before[df_before['sailing_mode'] == 'Downwind'][AWA_CHANNEL].abs()
    awa_downwind_after = df_after[df_after['sailing_mode'] == 'Downwind'][AWA_CHANNEL].abs()
    ax2.hist([awa_downwind_before, awa_downwind_after], bins=30, alpha=0.7,
             label=[f'Before (n={len(awa_downwind_before)})', f'After (n={len(awa_downwind_after)})'])
    ax2.set_xlabel('|AWA| (degrees)')
    ax2.set_ylabel('Frequency')
    ax2.set_title('AWA DOWNWIND - Before vs After (Grade 3)')
    ax2.legend()
    ax2.grid(True, alpha=0.3)
    
    # Plot 3: AWA offsets over time
    ax3 = plt.subplot(4, 3, 3)
    if 'awa_offsets' in offsets:
        times = sorted(offsets['awa_offsets']['port'].keys())
        port_values = [offsets['awa_offsets']['port'][t] for t in times]
        stbd_values = [offsets['awa_offsets']['starboard'][t] for t in times]
        ax3.plot(times, port_values, 'o-', linewidth=2, markersize=4, label='Port', color='blue')
        ax3.plot(times, stbd_values, 's-', linewidth=2, markersize=4, label='Starboard', color='orange')
        ax3.axhline(y=0, color='r', linestyle='--', alpha=0.5)
        ax3.set_xlabel('Hour of Day')
        ax3.set_ylabel('Offset (degrees)')
        ax3.set_title('AWA Offsets vs Time')
        ax3.legend()
        ax3.grid(True, alpha=0.3)
        ax3.set_xlim(-0.5, 24)
    
    # Plot 4: Normalized Leeway Upwind - Before vs After
    ax4 = plt.subplot(4, 3, 4)
    lwy_upwind_before = df_before[df_before['sailing_mode'] == 'Upwind']['normalized_lwy']
    lwy_upwind_after = df_after[df_after['sailing_mode'] == 'Upwind']['normalized_lwy']
    ax4.hist([lwy_upwind_before, lwy_upwind_after], bins=30, alpha=0.7,
             label=[f'Before (n={len(lwy_upwind_before)})', f'After (n={len(lwy_upwind_after)})'])
    ax4.set_xlabel('Normalized Leeway (degrees)')
    ax4.set_ylabel('Frequency')
    ax4.set_title('Normalized Leeway UPWIND - Before vs After (Grade 3)')
    ax4.legend()
    ax4.grid(True, alpha=0.3)
    
    # Plot 5: Normalized Leeway Downwind - Before vs After
    ax5 = plt.subplot(4, 3, 5)
    lwy_downwind_before = df_before[df_before['sailing_mode'] == 'Downwind']['normalized_lwy']
    lwy_downwind_after = df_after[df_after['sailing_mode'] == 'Downwind']['normalized_lwy']
    ax5.hist([lwy_downwind_before, lwy_downwind_after], bins=30, alpha=0.7,
             label=[f'Before (n={len(lwy_downwind_before)})', f'After (n={len(lwy_downwind_after)})'])
    ax5.set_xlabel('Normalized Leeway (degrees)')
    ax5.set_ylabel('Frequency')
    ax5.set_title('Normalized Leeway DOWNWIND - Before vs After (Grade 3)')
    ax5.legend()
    ax5.grid(True, alpha=0.3)
    
    # Plot 6: Leeway offsets
    ax6 = plt.subplot(4, 3, 6)
    if 'lwy_offsets' in offsets:
        times = sorted(offsets['lwy_offsets']['port'].keys())
        port_values = [offsets['lwy_offsets']['port'][t] for t in times]
        stbd_values = [offsets['lwy_offsets']['starboard'][t] for t in times]
        ax6.plot(times, port_values, 'o-', linewidth=2, markersize=4, label='Port', color='blue')
        ax6.plot(times, stbd_values, 's-', linewidth=2, markersize=4, label='Starboard', color='orange')
        ax6.axhline(y=0, color='r', linestyle='--', alpha=0.5)
        ax6.set_xlabel('Hour of Day')
        ax6.set_ylabel('Offset (degrees)')
        ax6.set_title('Leeway Offsets vs Time')
        ax6.legend()
        ax6.grid(True, alpha=0.3)
        ax6.set_xlim(-0.5, 24)
    
    # Plot 7: TWD stability before
    ax7 = plt.subplot(4, 3, 7)
    ax7.plot(df_before['Datetime'], df_before['Twd_deg'], linewidth=0.5, alpha=0.7)
    ax7.set_xlabel('Time')
    ax7.set_ylabel('TWD (degrees)')
    ax7.set_title('True Wind Direction - BEFORE (Grade 3)')
    ax7.grid(True, alpha=0.3)
    
    # Plot 8: TWD stability after
    ax8 = plt.subplot(4, 3, 8)
    ax8.plot(df_after['Datetime'], df_after['Twd_deg'], linewidth=0.5, alpha=0.7, color='green')
    ax8.set_xlabel('Time')
    ax8.set_ylabel('TWD (degrees)')
    ax8.set_title('True Wind Direction - AFTER (Grade 3)')
    ax8.grid(True, alpha=0.3)
    
    # Plot 9: Residuals
    ax9 = plt.subplot(4, 3, 9)
    if 'awa_residual' in df_after.columns:
        port_res = df_after[df_after['tack'] == 'port']['awa_residual']
        stbd_res = df_after[df_after['tack'] == 'starboard']['awa_residual']
        
        positions = [1, 2]
        data = [port_res, stbd_res]
        bp = ax9.boxplot(data, positions=positions, widths=0.6, patch_artist=True,
                         labels=['Port', 'Starboard'])
        for patch in bp['boxes']:
            patch.set_facecolor('lightblue')
        
        ax9.axhline(y=0, color='r', linestyle='--', alpha=0.5)
        ax9.set_ylabel('AWA Residual (degrees)')
        ax9.set_title('Residual Distribution After Calibration (Grade 3)')
        ax9.grid(True, alpha=0.3, axis='y')
    
    # Plot 10: TWS Distribution - Before vs After (ALL DATA - all grades)
    ax10 = plt.subplot(4, 3, 10)
    tws_before_all = df_before_all['Tws_kph']
    tws_after_all = df_after_all['Tws_kph']
    ax10.hist([tws_before_all, tws_after_all], bins=30, alpha=0.7,
              label=[f'Before (n={len(tws_before_all)})', f'After (n={len(tws_after_all)})'])
    ax10.set_xlabel('TWS (kph)')
    ax10.set_ylabel('Frequency')
    ax10.set_title('True Wind Speed - Before vs After (ALL DATA)')
    ax10.legend()
    ax10.grid(True, alpha=0.3)
    
    # Plot 11: TWD Distribution - Before vs After (ALL DATA - all grades)
    ax11 = plt.subplot(4, 3, 11)
    twd_before_all = df_before_all['Twd_deg']
    twd_after_all = df_after_all['Twd_deg']
    ax11.hist([twd_before_all, twd_after_all], bins=30, alpha=0.7,
              label=[f'Before (n={len(twd_before_all)})', f'After (n={len(twd_after_all)})'])
    ax11.set_xlabel('TWD (degrees)')
    ax11.set_ylabel('Frequency')
    ax11.set_title('True Wind Direction - Before vs After (ALL DATA)')
    ax11.legend()
    ax11.grid(True, alpha=0.3)
    
    plt.tight_layout()
    
    return fig


def create_upwind_comparison_plots(df_before, df_after):
    """Create upwind port vs starboard comparison plots for AWA, leeway, TWS, TWA, TWD."""
    
    # Filter to Grade 3 and upwind only
    if 'Grade' in df_before.columns:
        df_before = df_before[df_before['Grade'] == 3].copy()
    if 'Grade' in df_after.columns:
        df_after = df_after[df_after['Grade'] == 3].copy()
    
    # Add normalized leeway if not present
    if 'normalized_lwy' not in df_before.columns:
        df_before['normalized_lwy'] = df_before[LEEWAY_CHANNEL] * np.sign(df_before['Twa_deg'])
    if 'normalized_lwy' not in df_after.columns:
        df_after['normalized_lwy'] = df_after[LEEWAY_CHANNEL] * np.sign(df_after['Twa_deg'])
    
    # Add upwind/downwind classification
    df_before['sailing_mode'] = df_before['Twa_deg'].abs().apply(lambda x: 'Upwind' if x < 90 else 'Downwind')
    df_after['sailing_mode'] = df_after['Twa_deg'].abs().apply(lambda x: 'Upwind' if x < 90 else 'Downwind')
    
    # Filter to upwind only
    df_before_upwind = df_before[df_before['sailing_mode'] == 'Upwind'].copy()
    df_after_upwind = df_after[df_after['sailing_mode'] == 'Upwind'].copy()
    
    fig = plt.figure(figsize=(14, 18))
    
    # Plot 1: AWA Port vs Starboard BEFORE (Upwind)
    ax1 = plt.subplot(5, 2, 1)
    port_awa_before = df_before_upwind[df_before_upwind['tack'] == 'port'][AWA_CHANNEL].abs()
    stbd_awa_before = df_before_upwind[df_before_upwind['tack'] == 'starboard'][AWA_CHANNEL].abs()
    port_awa_before.plot.density(ax=ax1, label=f'Port (μ={port_awa_before.mean():.2f}°, n={len(port_awa_before)})', color='blue', linewidth=2)
    stbd_awa_before.plot.density(ax=ax1, label=f'Stbd (μ={stbd_awa_before.mean():.2f}°, n={len(stbd_awa_before)})', color='orange', linewidth=2)
    ax1.axvline(port_awa_before.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax1.axvline(stbd_awa_before.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax1.set_xlabel('|AWA| (degrees)')
    ax1.set_ylabel('Probability Density')
    ax1.set_title('AWA UPWIND Port vs Stbd - BEFORE (Grade 3)')
    ax1.legend()
    ax1.grid(True, alpha=0.3)
    
    # Plot 2: AWA Port vs Starboard AFTER (Upwind)
    ax2 = plt.subplot(5, 2, 2)
    port_awa_after = df_after_upwind[df_after_upwind['tack'] == 'port'][AWA_CHANNEL].abs()
    stbd_awa_after = df_after_upwind[df_after_upwind['tack'] == 'starboard'][AWA_CHANNEL].abs()
    port_awa_after.plot.density(ax=ax2, label=f'Port (μ={port_awa_after.mean():.2f}°, n={len(port_awa_after)})', color='blue', linewidth=2)
    stbd_awa_after.plot.density(ax=ax2, label=f'Stbd (μ={stbd_awa_after.mean():.2f}°, n={len(stbd_awa_after)})', color='orange', linewidth=2)
    ax2.axvline(port_awa_after.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax2.axvline(stbd_awa_after.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax2.set_xlabel('|AWA| (degrees)')
    ax2.set_ylabel('Probability Density')
    ax2.set_title('AWA UPWIND Port vs Stbd - AFTER (Grade 3)')
    ax2.legend()
    ax2.grid(True, alpha=0.3)
    
    # Plot 3: Normalized Leeway Port vs Starboard BEFORE (Upwind)
    ax3 = plt.subplot(5, 2, 3)
    port_lwy_before = df_before_upwind[df_before_upwind['tack'] == 'port']['normalized_lwy']
    stbd_lwy_before = df_before_upwind[df_before_upwind['tack'] == 'starboard']['normalized_lwy']
    port_lwy_before.plot.density(ax=ax3, label=f'Port (μ={port_lwy_before.mean():.3f}°, n={len(port_lwy_before)})', color='blue', linewidth=2)
    stbd_lwy_before.plot.density(ax=ax3, label=f'Stbd (μ={stbd_lwy_before.mean():.3f}°, n={len(stbd_lwy_before)})', color='orange', linewidth=2)
    ax3.axvline(port_lwy_before.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax3.axvline(stbd_lwy_before.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax3.set_xlabel('Normalized Leeway (degrees)')
    ax3.set_ylabel('Probability Density')
    ax3.set_title('Normalized Leeway UPWIND Port vs Stbd - BEFORE (Grade 3)')
    ax3.legend()
    ax3.grid(True, alpha=0.3)
    
    # Plot 4: Normalized Leeway Port vs Starboard AFTER (Upwind)
    ax4 = plt.subplot(5, 2, 4)
    port_lwy_after = df_after_upwind[df_after_upwind['tack'] == 'port']['normalized_lwy']
    stbd_lwy_after = df_after_upwind[df_after_upwind['tack'] == 'starboard']['normalized_lwy']
    port_lwy_after.plot.density(ax=ax4, label=f'Port (μ={port_lwy_after.mean():.3f}°, n={len(port_lwy_after)})', color='blue', linewidth=2)
    stbd_lwy_after.plot.density(ax=ax4, label=f'Stbd (μ={stbd_lwy_after.mean():.3f}°, n={len(stbd_lwy_after)})', color='orange', linewidth=2)
    ax4.axvline(port_lwy_after.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax4.axvline(stbd_lwy_after.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax4.set_xlabel('Normalized Leeway (degrees)')
    ax4.set_ylabel('Probability Density')
    ax4.set_title('Normalized Leeway UPWIND Port vs Stbd - AFTER (Grade 3)')
    ax4.legend()
    ax4.grid(True, alpha=0.3)
    
    # Plot 5: TWS Port vs Starboard BEFORE (Upwind)
    ax5 = plt.subplot(5, 2, 5)
    port_tws_before = df_before_upwind[df_before_upwind['tack'] == 'port']['Tws_kph']
    stbd_tws_before = df_before_upwind[df_before_upwind['tack'] == 'starboard']['Tws_kph']
    port_tws_before.plot.density(ax=ax5, label=f'Port (μ={port_tws_before.mean():.2f} kph, n={len(port_tws_before)})', color='blue', linewidth=2)
    stbd_tws_before.plot.density(ax=ax5, label=f'Stbd (μ={stbd_tws_before.mean():.2f} kph, n={len(stbd_tws_before)})', color='orange', linewidth=2)
    ax5.axvline(port_tws_before.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax5.axvline(stbd_tws_before.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax5.set_xlabel('TWS (kph)')
    ax5.set_ylabel('Probability Density')
    ax5.set_title('TWS UPWIND Port vs Stbd - BEFORE (Grade 3)')
    ax5.legend()
    ax5.grid(True, alpha=0.3)
    
    # Plot 6: TWS Port vs Starboard AFTER (Upwind)
    ax6 = plt.subplot(5, 2, 6)
    port_tws_after = df_after_upwind[df_after_upwind['tack'] == 'port']['Tws_kph']
    stbd_tws_after = df_after_upwind[df_after_upwind['tack'] == 'starboard']['Tws_kph']
    port_tws_after.plot.density(ax=ax6, label=f'Port (μ={port_tws_after.mean():.2f} kph, n={len(port_tws_after)})', color='blue', linewidth=2)
    stbd_tws_after.plot.density(ax=ax6, label=f'Stbd (μ={stbd_tws_after.mean():.2f} kph, n={len(stbd_tws_after)})', color='orange', linewidth=2)
    ax6.axvline(port_tws_after.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax6.axvline(stbd_tws_after.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax6.set_xlabel('TWS (kph)')
    ax6.set_ylabel('Probability Density')
    ax6.set_title('TWS UPWIND Port vs Stbd - AFTER (Grade 3)')
    ax6.legend()
    ax6.grid(True, alpha=0.3)
    
    # Plot 7: TWA Port vs Starboard BEFORE (Upwind)
    ax7 = plt.subplot(5, 2, 7)
    port_twa_before = df_before_upwind[df_before_upwind['tack'] == 'port']['Twa_deg'].abs()
    stbd_twa_before = df_before_upwind[df_before_upwind['tack'] == 'starboard']['Twa_deg'].abs()
    port_twa_before.plot.density(ax=ax7, label=f'Port (μ={port_twa_before.mean():.2f}°, n={len(port_twa_before)})', color='blue', linewidth=2)
    stbd_twa_before.plot.density(ax=ax7, label=f'Stbd (μ={stbd_twa_before.mean():.2f}°, n={len(stbd_twa_before)})', color='orange', linewidth=2)
    ax7.axvline(port_twa_before.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax7.axvline(stbd_twa_before.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax7.set_xlabel('|TWA| (degrees)')
    ax7.set_ylabel('Probability Density')
    ax7.set_title('TWA UPWIND Port vs Stbd - BEFORE (Grade 3)')
    ax7.legend()
    ax7.grid(True, alpha=0.3)
    
    # Plot 8: TWA Port vs Starboard AFTER (Upwind)
    ax8 = plt.subplot(5, 2, 8)
    port_twa_after = df_after_upwind[df_after_upwind['tack'] == 'port']['Twa_deg'].abs()
    stbd_twa_after = df_after_upwind[df_after_upwind['tack'] == 'starboard']['Twa_deg'].abs()
    port_twa_after.plot.density(ax=ax8, label=f'Port (μ={port_twa_after.mean():.2f}°, n={len(port_twa_after)})', color='blue', linewidth=2)
    stbd_twa_after.plot.density(ax=ax8, label=f'Stbd (μ={stbd_twa_after.mean():.2f}°, n={len(stbd_twa_after)})', color='orange', linewidth=2)
    ax8.axvline(port_twa_after.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax8.axvline(stbd_twa_after.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax8.set_xlabel('|TWA| (degrees)')
    ax8.set_ylabel('Probability Density')
    ax8.set_title('TWA UPWIND Port vs Stbd - AFTER (Grade 3)')
    ax8.legend()
    ax8.grid(True, alpha=0.3)
    
    # Plot 9: TWD Port vs Starboard BEFORE (Upwind)
    ax9 = plt.subplot(5, 2, 9)
    port_twd_before = df_before_upwind[df_before_upwind['tack'] == 'port']['Twd_deg']
    stbd_twd_before = df_before_upwind[df_before_upwind['tack'] == 'starboard']['Twd_deg']
    port_twd_before.plot.density(ax=ax9, label=f'Port (μ={port_twd_before.mean():.2f}°, n={len(port_twd_before)})', color='blue', linewidth=2)
    stbd_twd_before.plot.density(ax=ax9, label=f'Stbd (μ={stbd_twd_before.mean():.2f}°, n={len(stbd_twd_before)})', color='orange', linewidth=2)
    ax9.axvline(port_twd_before.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax9.axvline(stbd_twd_before.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax9.set_xlabel('TWD (degrees)')
    ax9.set_ylabel('Probability Density')
    ax9.set_title('TWD UPWIND Port vs Stbd - BEFORE (Grade 3)')
    ax9.legend()
    ax9.grid(True, alpha=0.3)
    
    # Plot 10: TWD Port vs Starboard AFTER (Upwind)
    ax10 = plt.subplot(5, 2, 10)
    port_twd_after = df_after_upwind[df_after_upwind['tack'] == 'port']['Twd_deg']
    stbd_twd_after = df_after_upwind[df_after_upwind['tack'] == 'starboard']['Twd_deg']
    port_twd_after.plot.density(ax=ax10, label=f'Port (μ={port_twd_after.mean():.2f}°, n={len(port_twd_after)})', color='blue', linewidth=2)
    stbd_twd_after.plot.density(ax=ax10, label=f'Stbd (μ={stbd_twd_after.mean():.2f}°, n={len(stbd_twd_after)})', color='orange', linewidth=2)
    ax10.axvline(port_twd_after.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax10.axvline(stbd_twd_after.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax10.set_xlabel('TWD (degrees)')
    ax10.set_ylabel('Probability Density')
    ax10.set_title('TWD UPWIND Port vs Stbd - AFTER (Grade 3)')
    ax10.legend()
    ax10.grid(True, alpha=0.3)
    
    plt.tight_layout()
    
    return fig


def create_downwind_comparison_plots(df_before, df_after):
    """Create downwind port vs starboard comparison plots for AWA, leeway, TWS, TWA, TWD."""
    
    # Filter to Grade 3 and downwind only
    if 'Grade' in df_before.columns:
        df_before = df_before[df_before['Grade'] == 3].copy()
    if 'Grade' in df_after.columns:
        df_after = df_after[df_after['Grade'] == 3].copy()
    
    # Add normalized leeway if not present
    if 'normalized_lwy' not in df_before.columns:
        df_before['normalized_lwy'] = df_before[LEEWAY_CHANNEL] * np.sign(df_before['Twa_deg'])
    if 'normalized_lwy' not in df_after.columns:
        df_after['normalized_lwy'] = df_after[LEEWAY_CHANNEL] * np.sign(df_after['Twa_deg'])
    
    # Add upwind/downwind classification
    df_before['sailing_mode'] = df_before['Twa_deg'].abs().apply(lambda x: 'Upwind' if x < 90 else 'Downwind')
    df_after['sailing_mode'] = df_after['Twa_deg'].abs().apply(lambda x: 'Upwind' if x < 90 else 'Downwind')
    
    # Filter to downwind only
    df_before_downwind = df_before[df_before['sailing_mode'] == 'Downwind'].copy()
    df_after_downwind = df_after[df_after['sailing_mode'] == 'Downwind'].copy()
    
    fig = plt.figure(figsize=(14, 18))
    
    # Plot 1: AWA Port vs Starboard BEFORE (Downwind)
    ax1 = plt.subplot(5, 2, 1)
    port_awa_before = df_before_downwind[df_before_downwind['tack'] == 'port'][AWA_CHANNEL].abs()
    stbd_awa_before = df_before_downwind[df_before_downwind['tack'] == 'starboard'][AWA_CHANNEL].abs()
    port_awa_before.plot.density(ax=ax1, label=f'Port (μ={port_awa_before.mean():.2f}°, n={len(port_awa_before)})', color='blue', linewidth=2)
    stbd_awa_before.plot.density(ax=ax1, label=f'Stbd (μ={stbd_awa_before.mean():.2f}°, n={len(stbd_awa_before)})', color='orange', linewidth=2)
    ax1.axvline(port_awa_before.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax1.axvline(stbd_awa_before.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax1.set_xlabel('|AWA| (degrees)')
    ax1.set_ylabel('Probability Density')
    ax1.set_title('AWA DOWNWIND Port vs Stbd - BEFORE (Grade 3)')
    ax1.legend()
    ax1.grid(True, alpha=0.3)
    
    # Plot 2: AWA Port vs Starboard AFTER (Downwind)
    ax2 = plt.subplot(5, 2, 2)
    port_awa_after = df_after_downwind[df_after_downwind['tack'] == 'port'][AWA_CHANNEL].abs()
    stbd_awa_after = df_after_downwind[df_after_downwind['tack'] == 'starboard'][AWA_CHANNEL].abs()
    port_awa_after.plot.density(ax=ax2, label=f'Port (μ={port_awa_after.mean():.2f}°, n={len(port_awa_after)})', color='blue', linewidth=2)
    stbd_awa_after.plot.density(ax=ax2, label=f'Stbd (μ={stbd_awa_after.mean():.2f}°, n={len(stbd_awa_after)})', color='orange', linewidth=2)
    ax2.axvline(port_awa_after.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax2.axvline(stbd_awa_after.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax2.set_xlabel('|AWA| (degrees)')
    ax2.set_ylabel('Probability Density')
    ax2.set_title('AWA DOWNWIND Port vs Stbd - AFTER (Grade 3)')
    ax2.legend()
    ax2.grid(True, alpha=0.3)
    
    # Plot 3: Normalized Leeway Port vs Starboard BEFORE (Downwind)
    ax3 = plt.subplot(5, 2, 3)
    port_lwy_before = df_before_downwind[df_before_downwind['tack'] == 'port']['normalized_lwy']
    stbd_lwy_before = df_before_downwind[df_before_downwind['tack'] == 'starboard']['normalized_lwy']
    port_lwy_before.plot.density(ax=ax3, label=f'Port (μ={port_lwy_before.mean():.3f}°, n={len(port_lwy_before)})', color='blue', linewidth=2)
    stbd_lwy_before.plot.density(ax=ax3, label=f'Stbd (μ={stbd_lwy_before.mean():.3f}°, n={len(stbd_lwy_before)})', color='orange', linewidth=2)
    ax3.axvline(port_lwy_before.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax3.axvline(stbd_lwy_before.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax3.set_xlabel('Normalized Leeway (degrees)')
    ax3.set_ylabel('Probability Density')
    ax3.set_title('Normalized Leeway DOWNWIND Port vs Stbd - BEFORE (Grade 3)')
    ax3.legend()
    ax3.grid(True, alpha=0.3)
    
    # Plot 4: Normalized Leeway Port vs Starboard AFTER (Downwind)
    ax4 = plt.subplot(5, 2, 4)
    port_lwy_after = df_after_downwind[df_after_downwind['tack'] == 'port']['normalized_lwy']
    stbd_lwy_after = df_after_downwind[df_after_downwind['tack'] == 'starboard']['normalized_lwy']
    port_lwy_after.plot.density(ax=ax4, label=f'Port (μ={port_lwy_after.mean():.3f}°, n={len(port_lwy_after)})', color='blue', linewidth=2)
    stbd_lwy_after.plot.density(ax=ax4, label=f'Stbd (μ={stbd_lwy_after.mean():.3f}°, n={len(stbd_lwy_after)})', color='orange', linewidth=2)
    ax4.axvline(port_lwy_after.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax4.axvline(stbd_lwy_after.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax4.set_xlabel('Normalized Leeway (degrees)')
    ax4.set_ylabel('Probability Density')
    ax4.set_title('Normalized Leeway DOWNWIND Port vs Stbd - AFTER (Grade 3)')
    ax4.legend()
    ax4.grid(True, alpha=0.3)
    
    # Plot 5: TWS Port vs Starboard BEFORE (Downwind)
    ax5 = plt.subplot(5, 2, 5)
    port_tws_before = df_before_downwind[df_before_downwind['tack'] == 'port']['Tws_kph']
    stbd_tws_before = df_before_downwind[df_before_downwind['tack'] == 'starboard']['Tws_kph']
    port_tws_before.plot.density(ax=ax5, label=f'Port (μ={port_tws_before.mean():.2f} kph, n={len(port_tws_before)})', color='blue', linewidth=2)
    stbd_tws_before.plot.density(ax=ax5, label=f'Stbd (μ={stbd_tws_before.mean():.2f} kph, n={len(stbd_tws_before)})', color='orange', linewidth=2)
    ax5.axvline(port_tws_before.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax5.axvline(stbd_tws_before.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax5.set_xlabel('TWS (kph)')
    ax5.set_ylabel('Probability Density')
    ax5.set_title('TWS DOWNWIND Port vs Stbd - BEFORE (Grade 3)')
    ax5.legend()
    ax5.grid(True, alpha=0.3)
    
    # Plot 6: TWS Port vs Starboard AFTER (Downwind)
    ax6 = plt.subplot(5, 2, 6)
    port_tws_after = df_after_downwind[df_after_downwind['tack'] == 'port']['Tws_kph']
    stbd_tws_after = df_after_downwind[df_after_downwind['tack'] == 'starboard']['Tws_kph']
    port_tws_after.plot.density(ax=ax6, label=f'Port (μ={port_tws_after.mean():.2f} kph, n={len(port_tws_after)})', color='blue', linewidth=2)
    stbd_tws_after.plot.density(ax=ax6, label=f'Stbd (μ={stbd_tws_after.mean():.2f} kph, n={len(stbd_tws_after)})', color='orange', linewidth=2)
    ax6.axvline(port_tws_after.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax6.axvline(stbd_tws_after.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax6.set_xlabel('TWS (kph)')
    ax6.set_ylabel('Probability Density')
    ax6.set_title('TWS DOWNWIND Port vs Stbd - AFTER (Grade 3)')
    ax6.legend()
    ax6.grid(True, alpha=0.3)
    
    # Plot 7: TWA Port vs Starboard BEFORE (Downwind)
    ax7 = plt.subplot(5, 2, 7)
    port_twa_before = df_before_downwind[df_before_downwind['tack'] == 'port']['Twa_deg'].abs()
    stbd_twa_before = df_before_downwind[df_before_downwind['tack'] == 'starboard']['Twa_deg'].abs()
    port_twa_before.plot.density(ax=ax7, label=f'Port (μ={port_twa_before.mean():.2f}°, n={len(port_twa_before)})', color='blue', linewidth=2)
    stbd_twa_before.plot.density(ax=ax7, label=f'Stbd (μ={stbd_twa_before.mean():.2f}°, n={len(stbd_twa_before)})', color='orange', linewidth=2)
    ax7.axvline(port_twa_before.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax7.axvline(stbd_twa_before.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax7.set_xlabel('|TWA| (degrees)')
    ax7.set_ylabel('Probability Density')
    ax7.set_title('TWA DOWNWIND Port vs Stbd - BEFORE (Grade 3)')
    ax7.legend()
    ax7.grid(True, alpha=0.3)
    
    # Plot 8: TWA Port vs Starboard AFTER (Downwind)
    ax8 = plt.subplot(5, 2, 8)
    port_twa_after = df_after_downwind[df_after_downwind['tack'] == 'port']['Twa_deg'].abs()
    stbd_twa_after = df_after_downwind[df_after_downwind['tack'] == 'starboard']['Twa_deg'].abs()
    port_twa_after.plot.density(ax=ax8, label=f'Port (μ={port_twa_after.mean():.2f}°, n={len(port_twa_after)})', color='blue', linewidth=2)
    stbd_twa_after.plot.density(ax=ax8, label=f'Stbd (μ={stbd_twa_after.mean():.2f}°, n={len(stbd_twa_after)})', color='orange', linewidth=2)
    ax8.axvline(port_twa_after.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax8.axvline(stbd_twa_after.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax8.set_xlabel('|TWA| (degrees)')
    ax8.set_ylabel('Probability Density')
    ax8.set_title('TWA DOWNWIND Port vs Stbd - AFTER (Grade 3)')
    ax8.legend()
    ax8.grid(True, alpha=0.3)
    
    # Plot 9: TWD Port vs Starboard BEFORE (Downwind)
    ax9 = plt.subplot(5, 2, 9)
    port_twd_before = df_before_downwind[df_before_downwind['tack'] == 'port']['Twd_deg']
    stbd_twd_before = df_before_downwind[df_before_downwind['tack'] == 'starboard']['Twd_deg']
    port_twd_before.plot.density(ax=ax9, label=f'Port (μ={port_twd_before.mean():.2f}°, n={len(port_twd_before)})', color='blue', linewidth=2)
    stbd_twd_before.plot.density(ax=ax9, label=f'Stbd (μ={stbd_twd_before.mean():.2f}°, n={len(stbd_twd_before)})', color='orange', linewidth=2)
    ax9.axvline(port_twd_before.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax9.axvline(stbd_twd_before.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax9.set_xlabel('TWD (degrees)')
    ax9.set_ylabel('Probability Density')
    ax9.set_title('TWD DOWNWIND Port vs Stbd - BEFORE (Grade 3)')
    ax9.legend()
    ax9.grid(True, alpha=0.3)
    
    # Plot 10: TWD Port vs Starboard AFTER (Downwind)
    ax10 = plt.subplot(5, 2, 10)
    port_twd_after = df_after_downwind[df_after_downwind['tack'] == 'port']['Twd_deg']
    stbd_twd_after = df_after_downwind[df_after_downwind['tack'] == 'starboard']['Twd_deg']
    port_twd_after.plot.density(ax=ax10, label=f'Port (μ={port_twd_after.mean():.2f}°, n={len(port_twd_after)})', color='blue', linewidth=2)
    stbd_twd_after.plot.density(ax=ax10, label=f'Stbd (μ={stbd_twd_after.mean():.2f}°, n={len(stbd_twd_after)})', color='orange', linewidth=2)
    ax10.axvline(port_twd_after.mean(), color='blue', linestyle='--', alpha=0.5, linewidth=1.5)
    ax10.axvline(stbd_twd_after.mean(), color='orange', linestyle='--', alpha=0.5, linewidth=1.5)
    ax10.set_xlabel('TWD (degrees)')
    ax10.set_ylabel('Probability Density')
    ax10.set_title('TWD DOWNWIND Port vs Stbd - AFTER (Grade 3)')
    ax10.legend()
    ax10.grid(True, alpha=0.3)
    
    plt.tight_layout()
    
    return fig


# ============================================================================
# MAIN TEST FUNCTION
# ============================================================================

def run_calibration_test():
    """Main test function - loads data, calibrates, and compares."""
    
    print("\n" + "="*30)
    print("CALIBRATION TEST PAGE")
    print("="*30)
    print(f"\nConfiguration:")
    print(f"  Date: {CONFIG.date}")
    print(f"  Source: {CONFIG.source_name}")
    print(f"  AWA Channel: {AWA_CHANNEL}")
    print(f"  Leeway Channel: {LEEWAY_CHANNEL}")
    
    # Step 1: Load data
    print("\n[1/6] Loading REAL calibration data from API...")
    print(f"      Requesting: {CONFIG.class_name}/{CONFIG.source_name} on {CONFIG.date}")
    print(f"      Sample rate: {CONFIG.rs}, Grade filter: 3")
    
    # Show channels being requested
    channel_names = [ch['name'] for ch in CHANNELS]
    print(f"      Channels ({len(channel_names)}): {', '.join(channel_names[:5])}...")
    print(f"                       ... {', '.join(channel_names[5:])}")
    
    try:
        df_original = load_calibration_data(CONFIG, channel_list=CHANNELS)
        print(f"      ✓ Loaded {len(df_original)} samples of REAL DATA from API")
        if len(df_original) > 0:
            time_start = df_original['Datetime'].min()
            time_end = df_original['Datetime'].max()
            duration = (time_end - time_start).total_seconds() / 3600
            print(f"      ✓ Time range: {time_start} to {time_end} ({duration:.1f} hours)")
            
            # Show available AWA channels
            awa_cols = [col for col in df_original.columns if 'Awa' in col or 'awa' in col]
            print(f"      ✓ Available AWA columns: {awa_cols}")
            
            # Validate AWA channel exists
            if AWA_CHANNEL not in df_original.columns:
                print(f"\n      ✗ ERROR: '{AWA_CHANNEL}' not found in data!")
                print(f"      Available AWA columns: {awa_cols}")
                print(f"\n      Please update AWA_CHANNEL in the CONFIG section to one of: {awa_cols}")
                return None
    except Exception as e:
        print(f"      ✗ Error loading data: {e}")
        print("\n      Please update the CONFIG section with valid credentials.")
        return None
    
    if len(df_original) == 0:
        print("      ✗ No data loaded. Check your configuration.")
        return None
    
    # Step 2: Compute initial true wind for comparison
    print("\n[2/6] Computing initial (uncalibrated) true wind...")
    df_before = compute_initial_true_wind(df_original.copy(), awa_col=AWA_CHANNEL, lwy_col=LEEWAY_CHANNEL)
    df_before = add_tack_and_hour(df_before)
    
    # Get tack counts
    tack_counts = df_before['tack'].value_counts().to_dict()
    stats_before = compute_statistics(df_before, prefix="before_")
    stats_before['tack_counts'] = tack_counts
    stats_before['raw_data'] = df_original
    print(f"      ✓ Port: {tack_counts.get('port', 0)}, Starboard: {tack_counts.get('starboard', 0)}")
    
    # Step 3: Run calibration
    print("\n[3/6] Running calibration pipeline...")
    try:
        result = calibrate_sailing_data_v3(CONFIG, awa_channel_name=AWA_CHANNEL, lwy_channel_name=LEEWAY_CHANNEL)
        print(f"      ✓ Calibration complete")
    except Exception as e:
        print(f"      ✗ Error during calibration: {e}")
        return None
    
    df_after = result['data']
    
    # Step 4: Compute statistics
    print("\n[4/6] Computing statistics...")
    stats_after = compute_statistics(df_after, prefix="after_")
    comparison = compare_statistics(stats_before, stats_after)
    
    # Analyze residuals
    residuals_before = analyze_residuals(result['data'])  # Has residuals from training
    
    # Need to recompute residuals after calibration for final check
    from utilities.cal_utils import compute_awa_residuals, compute_leeway_residuals
    df_final = compute_awa_residuals(df_after, result['awa_model'], AWA_CHANNEL)
    df_final = compute_leeway_residuals(df_final, result['lwy_model'], LEEWAY_CHANNEL)
    residuals_after = analyze_residuals(df_final)
    
    print(f"      ✓ Analysis complete")
    
    # Step 5: Print report
    print("\n[5/6] Generating report...")
    offsets = {
        'awa_offsets': result['awa_offsets'],
        'lwy_offsets': result['lwy_offsets']
    }
    print_report(stats_before, stats_after, comparison, residuals_before, residuals_after, offsets)
    
    # Step 6: Save results
    print("\n[6/6] Saving results...")
    
    if SAVE_RESULTS:
        # Save calibrated data
        output_file = Path(f"calibrated_data_{CONFIG.date}_{CONFIG.source_name}.csv")
        df_after.to_csv(output_file, index=False)
        print(f"      ✓ Saved calibrated data: {output_file}")
        
        # Save offsets
        offsets_file = Path(f"calibration_offsets_{CONFIG.date}_{CONFIG.source_name}.csv")
        offsets_data = {
            'time': sorted(result['awa_offsets']['port'].keys()),
            'awa_offset_port': [result['awa_offsets']['port'][t] for t in sorted(result['awa_offsets']['port'].keys())],
            'awa_offset_stbd': [result['awa_offsets']['starboard'][t] for t in sorted(result['awa_offsets']['starboard'].keys())],
            'lwy_offset_port': [result['lwy_offsets']['port'][t] for t in sorted(result['lwy_offsets']['port'].keys())],
            'lwy_offset_stbd': [result['lwy_offsets']['starboard'][t] for t in sorted(result['lwy_offsets']['starboard'].keys())]
        }
        offsets_df = pd.DataFrame(offsets_data)
        offsets_df.to_csv(offsets_file, index=False)
        print(f"      ✓ Saved offsets: {offsets_file}")
    
    if SAVE_PLOTS:
        try:
            # Main calibration plots
            fig = create_comparison_plots(df_before, df_after, offsets)
            plot_file = Path(f"calibration_plots_{CONFIG.date}_{CONFIG.source_name}.png")
            fig.savefig(plot_file, dpi=150, bbox_inches='tight')
            plt.close(fig)
            print(f"      ✓ Saved main plots: {plot_file}")
            
            # Upwind port vs starboard plots
            fig_upwind = create_upwind_comparison_plots(df_before, df_after)
            upwind_plot_file = Path(f"calibration_upwind_port_stbd_{CONFIG.date}_{CONFIG.source_name}.png")
            fig_upwind.savefig(upwind_plot_file, dpi=150, bbox_inches='tight')
            plt.close(fig_upwind)
            print(f"      ✓ Saved upwind port/stbd plots: {upwind_plot_file}")
            
            # Downwind port vs starboard plots
            fig_downwind = create_downwind_comparison_plots(df_before, df_after)
            downwind_plot_file = Path(f"calibration_downwind_port_stbd_{CONFIG.date}_{CONFIG.source_name}.png")
            fig_downwind.savefig(downwind_plot_file, dpi=150, bbox_inches='tight')
            plt.close(fig_downwind)
            print(f"      ✓ Saved downwind port/stbd plots: {downwind_plot_file}")
        except Exception as e:
            print(f"      ⚠ Could not create plots: {e}")
            print(f"        (matplotlib may not be available)")
    
    print("\n" + "="*30)
    print("TEST COMPLETE")
    print("="*30)
    
    return {
        'original': df_original,
        'before': df_before,
        'after': df_after,
        'stats': comparison,
        'result': result
    }


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == '__main__':
    # Check if configuration is set
    if "your_api_token" in CONFIG.api_token.lower():
        print("\n" + "="*30)
        print("⚠ CONFIGURATION REQUIRED")
        print("="*30)
        print("\nPlease update the CONFIG section at the top of this file with:")
        print("  - api_token")
        print("  - class_name")
        print("  - project_id")
        print("  - date (YYYYMMDD)")
        print("  - source_name")
        print("\nThen run this script again.")
        print("="*30 + "\n")
    else:
        # Run the test
        results = run_calibration_test()
        
        if results is not None:
            print("\n✓ Results available in 'results' variable")
            print("  - results['original']: Original data")
            print("  - results['before']: Before calibration (with initial true wind)")
            print("  - results['after']: After calibration")
            print("  - results['stats']: Statistical comparison")
            print("  - results['result']: Full calibration result (models + offsets)")
            
            # Make results available for interactive use
            globals()['results'] = results
