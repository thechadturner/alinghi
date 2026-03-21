"""
Multi-Sensor Calibration Test Page

Tests the multi-sensor calibration and fusion pipeline with bow and masthead sensors.
"""

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime

from utilities.cal_utils import (
    CalibrationConfig,
    calibrate_and_fuse_pipeline
)


# ============================================================================
# CONFIGURATION
# ============================================================================

CONFIG = CalibrationConfig(
    api_token="8493d8284a19ae9f5a23cafdec7de5bfccdce799d651d053e81bc2adc75a4002",
    class_name="gp50",
    project_id="1",
    date="20260118",  
    source_name="GER",
    rs="100ms",
    timezone="UTC"
)

# Multi-sensor configuration - bow and masthead sensors
AWA_SENSORS = ['Awa_bow_deg', 'Awa_mhu_deg'] 
AWS_SENSORS = ['Aws_bow_kph', 'Aws_mhu_kph']      
LEEWAY_SENSOR = 'Lwy_deg'

FUSION_METHOD = 'robust'  # 'robust' or 'weighted'
OUTLIER_THRESHOLD = 2.0   # For robust fusion


# ============================================================================
# VISUALIZATION FUNCTIONS
# ============================================================================

def create_multi_sensor_comparison_plots(df_final, multi_results):
    """
    Create comparison plots showing bow, masthead, and fused sensors
    for upwind and downwind conditions with port/starboard splits.
    """
    
    # Add tack classification
    df_final['tack'] = np.where(df_final['Twa_deg'] < 0, 'port', 'starboard')
    df_final['sailing_mode'] = df_final['Twa_deg'].abs().apply(
        lambda x: 'Upwind' if x < 90 else 'Downwind'
    )
    
    # Get sensor names from results
    sensor_names = multi_results['recommended_sensors']
    bow_sensor = [s for s in sensor_names if 'bow' in s.lower()][0] if any('bow' in s.lower() for s in sensor_names) else sensor_names[1]
    mhu_sensor = [s for s in sensor_names if 'mhu' in s.lower()][0] if any('mhu' in s.lower() for s in sensor_names) else sensor_names[0]
    
    # Create figure with 4x3 grid (AWA upwind/downwind, Leeway upwind/downwind) x (Bow, Masthead, Fused)
    fig = plt.figure(figsize=(18, 14))
    fig.suptitle(f'Multi-Sensor Fusion Results: {CONFIG.source_name} - {CONFIG.date}', fontsize=14, fontweight='bold')
    
    # ========== UPWIND AWA ==========
    df_upwind = df_final[df_final['sailing_mode'] == 'Upwind'].copy()
    
    # Bow AWA Upwind
    ax1 = plt.subplot(4, 3, 1)
    if bow_sensor in df_upwind.columns:
        port = df_upwind[df_upwind['tack'] == 'port'][bow_sensor].abs()
        stbd = df_upwind[df_upwind['tack'] == 'starboard'][bow_sensor].abs()
        port.plot.density(ax=ax1, label=f'Port (μ={port.mean():.2f}°)', color='blue', linewidth=2)
        stbd.plot.density(ax=ax1, label=f'Stbd (μ={stbd.mean():.2f}°)', color='orange', linewidth=2)
        ax1.axvline(port.mean(), color='blue', linestyle='--', alpha=0.5)
        ax1.axvline(stbd.mean(), color='orange', linestyle='--', alpha=0.5)
        ax1.set_title(f'AWA UPWIND - Bow Sensor\nΔ={abs(port.mean()-stbd.mean()):.3f}°', fontsize=10)
    ax1.set_xlabel('|AWA| (degrees)')
    ax1.set_ylabel('Probability Density')
    ax1.legend(fontsize=8)
    ax1.grid(True, alpha=0.3)
    
    # Masthead AWA Upwind
    ax2 = plt.subplot(4, 3, 2)
    if mhu_sensor in df_upwind.columns:
        port = df_upwind[df_upwind['tack'] == 'port'][mhu_sensor].abs()
        stbd = df_upwind[df_upwind['tack'] == 'starboard'][mhu_sensor].abs()
        port.plot.density(ax=ax2, label=f'Port (μ={port.mean():.2f}°)', color='blue', linewidth=2)
        stbd.plot.density(ax=ax2, label=f'Stbd (μ={stbd.mean():.2f}°)', color='orange', linewidth=2)
        ax2.axvline(port.mean(), color='blue', linestyle='--', alpha=0.5)
        ax2.axvline(stbd.mean(), color='orange', linestyle='--', alpha=0.5)
        ax2.set_title(f'AWA UPWIND - Masthead Sensor\nΔ={abs(port.mean()-stbd.mean()):.3f}°', fontsize=10)
    ax2.set_xlabel('|AWA| (degrees)')
    ax2.set_ylabel('Probability Density')
    ax2.legend(fontsize=8)
    ax2.grid(True, alpha=0.3)
    
    # Fused AWA Upwind
    ax3 = plt.subplot(4, 3, 3)
    if 'Awa_fused_deg' in df_upwind.columns:
        port = df_upwind[df_upwind['tack'] == 'port']['Awa_fused_deg'].abs()
        stbd = df_upwind[df_upwind['tack'] == 'starboard']['Awa_fused_deg'].abs()
        port.plot.density(ax=ax3, label=f'Port (μ={port.mean():.2f}°)', color='blue', linewidth=2)
        stbd.plot.density(ax=ax3, label=f'Stbd (μ={stbd.mean():.2f}°)', color='orange', linewidth=2)
        ax3.axvline(port.mean(), color='blue', linestyle='--', alpha=0.5)
        ax3.axvline(stbd.mean(), color='orange', linestyle='--', alpha=0.5)
        ax3.set_title(f'AWA UPWIND - FUSED\nΔ={abs(port.mean()-stbd.mean()):.3f}°', fontsize=10, fontweight='bold', color='green')
    ax3.set_xlabel('|AWA| (degrees)')
    ax3.set_ylabel('Probability Density')
    ax3.legend(fontsize=8)
    ax3.grid(True, alpha=0.3)
    
    # ========== DOWNWIND AWA ==========
    df_downwind = df_final[df_final['sailing_mode'] == 'Downwind'].copy()
    
    # Bow AWA Downwind
    ax4 = plt.subplot(4, 3, 4)
    if bow_sensor in df_downwind.columns:
        port = df_downwind[df_downwind['tack'] == 'port'][bow_sensor].abs()
        stbd = df_downwind[df_downwind['tack'] == 'starboard'][bow_sensor].abs()
        port.plot.density(ax=ax4, label=f'Port (μ={port.mean():.2f}°)', color='blue', linewidth=2)
        stbd.plot.density(ax=ax4, label=f'Stbd (μ={stbd.mean():.2f}°)', color='orange', linewidth=2)
        ax4.axvline(port.mean(), color='blue', linestyle='--', alpha=0.5)
        ax4.axvline(stbd.mean(), color='orange', linestyle='--', alpha=0.5)
        ax4.set_title(f'AWA DOWNWIND - Bow Sensor\nΔ={abs(port.mean()-stbd.mean()):.3f}°', fontsize=10)
    ax4.set_xlabel('|AWA| (degrees)')
    ax4.set_ylabel('Probability Density')
    ax4.legend(fontsize=8)
    ax4.grid(True, alpha=0.3)
    
    # Masthead AWA Downwind
    ax5 = plt.subplot(4, 3, 5)
    if mhu_sensor in df_downwind.columns:
        port = df_downwind[df_downwind['tack'] == 'port'][mhu_sensor].abs()
        stbd = df_downwind[df_downwind['tack'] == 'starboard'][mhu_sensor].abs()
        port.plot.density(ax=ax5, label=f'Port (μ={port.mean():.2f}°)', color='blue', linewidth=2)
        stbd.plot.density(ax=ax5, label=f'Stbd (μ={stbd.mean():.2f}°)', color='orange', linewidth=2)
        ax5.axvline(port.mean(), color='blue', linestyle='--', alpha=0.5)
        ax5.axvline(stbd.mean(), color='orange', linestyle='--', alpha=0.5)
        ax5.set_title(f'AWA DOWNWIND - Masthead Sensor\nΔ={abs(port.mean()-stbd.mean()):.3f}°', fontsize=10)
    ax5.set_xlabel('|AWA| (degrees)')
    ax5.set_ylabel('Probability Density')
    ax5.legend(fontsize=8)
    ax5.grid(True, alpha=0.3)
    
    # Fused AWA Downwind
    ax6 = plt.subplot(4, 3, 6)
    if 'Awa_fused_deg' in df_downwind.columns:
        port = df_downwind[df_downwind['tack'] == 'port']['Awa_fused_deg'].abs()
        stbd = df_downwind[df_downwind['tack'] == 'starboard']['Awa_fused_deg'].abs()
        port.plot.density(ax=ax6, label=f'Port (μ={port.mean():.2f}°)', color='blue', linewidth=2)
        stbd.plot.density(ax=ax6, label=f'Stbd (μ={stbd.mean():.2f}°)', color='orange', linewidth=2)
        ax6.axvline(port.mean(), color='blue', linestyle='--', alpha=0.5)
        ax6.axvline(stbd.mean(), color='orange', linestyle='--', alpha=0.5)
        ax6.set_title(f'AWA DOWNWIND - FUSED\nΔ={abs(port.mean()-stbd.mean()):.3f}°', fontsize=10, fontweight='bold', color='green')
    ax6.set_xlabel('|AWA| (degrees)')
    ax6.set_ylabel('Probability Density')
    ax6.legend(fontsize=8)
    ax6.grid(True, alpha=0.3)
    
    # ========== UPWIND LEEWAY (Normalized) ==========
    # Add normalized leeway
    df_upwind['normalized_lwy'] = df_upwind[LEEWAY_SENSOR] * np.sign(df_upwind['Twa_deg'])
    df_downwind['normalized_lwy'] = df_downwind[LEEWAY_SENSOR] * np.sign(df_downwind['Twa_deg'])
    
    # Leeway Upwind - Port vs Stbd
    ax7 = plt.subplot(4, 3, 7)
    port = df_upwind[df_upwind['tack'] == 'port']['normalized_lwy']
    stbd = df_upwind[df_upwind['tack'] == 'starboard']['normalized_lwy']
    port.plot.density(ax=ax7, label=f'Port (μ={port.mean():.3f}°)', color='blue', linewidth=2)
    stbd.plot.density(ax=ax7, label=f'Stbd (μ={stbd.mean():.3f}°)', color='orange', linewidth=2)
    ax7.axvline(port.mean(), color='blue', linestyle='--', alpha=0.5)
    ax7.axvline(stbd.mean(), color='orange', linestyle='--', alpha=0.5)
    ax7.set_title(f'LEEWAY UPWIND - Calibrated\nΔ={abs(port.mean()-stbd.mean()):.3f}°', fontsize=10, fontweight='bold', color='green')
    ax7.set_xlabel('Normalized Leeway (degrees)')
    ax7.set_ylabel('Probability Density')
    ax7.legend(fontsize=8)
    ax7.grid(True, alpha=0.3)
    
    # TWS Upwind comparison
    ax8 = plt.subplot(4, 3, 8)
    if 'Tws_fused_kph' in df_upwind.columns:
        port = df_upwind[df_upwind['tack'] == 'port']['Tws_fused_kph']
        stbd = df_upwind[df_upwind['tack'] == 'starboard']['Tws_fused_kph']
        port.plot.density(ax=ax8, label=f'Port (μ={port.mean():.2f} kph)', color='blue', linewidth=2)
        stbd.plot.density(ax=ax8, label=f'Stbd (μ={stbd.mean():.2f} kph)', color='orange', linewidth=2)
        ax8.axvline(port.mean(), color='blue', linestyle='--', alpha=0.5)
        ax8.axvline(stbd.mean(), color='orange', linestyle='--', alpha=0.5)
        ax8.set_title(f'TWS UPWIND - Fused\nΔ={abs(port.mean()-stbd.mean()):.2f} kph', fontsize=10)
    ax8.set_xlabel('TWS (kph)')
    ax8.set_ylabel('Probability Density')
    ax8.legend(fontsize=8)
    ax8.grid(True, alpha=0.3)
    
    # TWD Upwind comparison
    ax9 = plt.subplot(4, 3, 9)
    if 'Twd_fused_deg' in df_upwind.columns:
        twd_upwind = df_upwind['Twd_fused_deg']
        twd_upwind.plot.density(ax=ax9, label=f'μ={twd_upwind.mean():.1f}°, σ={twd_upwind.std():.2f}°', color='green', linewidth=2)
        ax9.axvline(twd_upwind.mean(), color='green', linestyle='--', alpha=0.5)
        ax9.set_title(f'TWD UPWIND - Fused', fontsize=10)
    ax9.set_xlabel('TWD (degrees)')
    ax9.set_ylabel('Probability Density')
    ax9.legend(fontsize=8)
    ax9.grid(True, alpha=0.3)
    
    # ========== DOWNWIND LEEWAY ==========
    # Leeway Downwind - Port vs Stbd
    ax10 = plt.subplot(4, 3, 10)
    port = df_downwind[df_downwind['tack'] == 'port']['normalized_lwy']
    stbd = df_downwind[df_downwind['tack'] == 'starboard']['normalized_lwy']
    port.plot.density(ax=ax10, label=f'Port (μ={port.mean():.3f}°)', color='blue', linewidth=2)
    stbd.plot.density(ax=ax10, label=f'Stbd (μ={stbd.mean():.3f}°)', color='orange', linewidth=2)
    ax10.axvline(port.mean(), color='blue', linestyle='--', alpha=0.5)
    ax10.axvline(stbd.mean(), color='orange', linestyle='--', alpha=0.5)
    ax10.set_title(f'LEEWAY DOWNWIND - Calibrated\nΔ={abs(port.mean()-stbd.mean()):.3f}°', fontsize=10, fontweight='bold', color='green')
    ax10.set_xlabel('Normalized Leeway (degrees)')
    ax10.set_ylabel('Probability Density')
    ax10.legend(fontsize=8)
    ax10.grid(True, alpha=0.3)
    
    # TWS Downwind comparison
    ax11 = plt.subplot(4, 3, 11)
    if 'Tws_fused_kph' in df_downwind.columns:
        port = df_downwind[df_downwind['tack'] == 'port']['Tws_fused_kph']
        stbd = df_downwind[df_downwind['tack'] == 'starboard']['Tws_fused_kph']
        port.plot.density(ax=ax11, label=f'Port (μ={port.mean():.2f} kph)', color='blue', linewidth=2)
        stbd.plot.density(ax=ax11, label=f'Stbd (μ={stbd.mean():.2f} kph)', color='orange', linewidth=2)
        ax11.axvline(port.mean(), color='blue', linestyle='--', alpha=0.5)
        ax11.axvline(stbd.mean(), color='orange', linestyle='--', alpha=0.5)
        ax11.set_title(f'TWS DOWNWIND - Fused\nΔ={abs(port.mean()-stbd.mean()):.2f} kph', fontsize=10)
    ax11.set_xlabel('TWS (kph)')
    ax11.set_ylabel('Probability Density')
    ax11.legend(fontsize=8)
    ax11.grid(True, alpha=0.3)
    
    # TWD Downwind comparison
    ax12 = plt.subplot(4, 3, 12)
    if 'Twd_fused_deg' in df_downwind.columns:
        twd_downwind = df_downwind['Twd_fused_deg']
        twd_downwind.plot.density(ax=ax12, label=f'μ={twd_downwind.mean():.1f}°, σ={twd_downwind.std():.2f}°', color='green', linewidth=2)
        ax12.axvline(twd_downwind.mean(), color='green', linestyle='--', alpha=0.5)
        ax12.set_title(f'TWD DOWNWIND - Fused', fontsize=10)
    ax12.set_xlabel('TWD (degrees)')
    ax12.set_ylabel('Probability Density')
    ax12.legend(fontsize=8)
    ax12.grid(True, alpha=0.3)
    
    plt.tight_layout()
    return fig


# ============================================================================
# MAIN TEST FUNCTION
# ============================================================================

def run_multi_sensor_test():
    """Test multi-sensor calibration and fusion pipeline."""
    
    print("\n" + "="*30)
    print("MULTI-SENSOR CALIBRATION TEST")
    print("="*30)
    print(f"\nConfiguration:")
    print(f"  Date: {CONFIG.date}")
    print(f"  Source: {CONFIG.source_name}")
    print(f"  AWA Sensors: {AWA_SENSORS}")
    print(f"  Leeway Sensor: {LEEWAY_SENSOR}")
    print(f"  Fusion Method: {FUSION_METHOD}")
    
    # Run complete pipeline
    try:
        results = calibrate_and_fuse_pipeline(
            config=CONFIG,
            awa_sensors=AWA_SENSORS,
            aws_sensors=AWS_SENSORS,
            lwy_sensor=LEEWAY_SENSOR,
            fusion_method=FUSION_METHOD,
            outlier_threshold=OUTLIER_THRESHOLD,
        )
        
        # Extract results
        df_final = results['data']
        multi_sensor_results = results['multi_sensor_results']
        fusion_stats = results['fusion_stats']
        
        # Print summary
        print("\n" + "="*30)
        print("RESULTS SUMMARY")
        print("="*30)
        
        print(f"\nSensors Calibrated: {len(multi_sensor_results['recommended_sensors'])}")
        for i, sensor in enumerate(multi_sensor_results['recommended_sensors'], 1):
            score = multi_sensor_results['sensor_calibrations'][sensor]['quality_score']
            print(f"  {i}. {sensor}: {score:.1f}/100")
        
        print(f"\nFusion Method: {results['fusion_method']}")
        
        if 'Awa_fused_deg' in df_final.columns:
            print(f"\nFused AWA Statistics:")
            print(f"  Mean: {df_final['Awa_fused_deg'].abs().mean():.2f}°")
            print(f"  Std: {df_final['Awa_fused_deg'].std():.2f}°")
            
            if 'Awa_n_sensors' in df_final.columns:
                print(f"  Avg sensors used: {df_final['Awa_n_sensors'].mean():.2f}")
            
            if 'Awa_uncertainty' in df_final.columns:
                uncertainty = df_final['Awa_uncertainty'].dropna()
                if len(uncertainty) > 0:
                    print(f"  Mean uncertainty: {uncertainty.mean():.3f}°")
        
        if 'Tws_fused_kph' in df_final.columns:
            print(f"\nFused True Wind:")
            print(f"  TWS mean: {df_final['Tws_fused_kph'].mean():.2f} kph")
            print(f"  TWS std: {df_final['Tws_fused_kph'].std():.2f} kph")
            
            if 'Twd_fused_deg' in df_final.columns:
                print(f"  TWD mean: {df_final['Twd_fused_deg'].mean():.1f}°")
                print(f"  TWD std: {df_final['Twd_fused_deg'].std():.2f}°")
        
        # Show sensor differences and fusion behavior
        print("\n" + "="*30)
        print("SENSOR COMPARISON - RAW DIFFERENCES")
        print("="*30)
        
        if 'Awa_bow_deg' in df_final.columns and 'Awa_mhu_deg' in df_final.columns:
            bow = df_final['Awa_bow_deg'].values
            mhu = df_final['Awa_mhu_deg'].values
            diff = mhu - bow  # Masthead minus Bow
            
            print(f"\nCalibrated Sensor Readings:")
            print(f"  Bow AWA mean:      {np.mean(np.abs(bow)):.3f}° (|AWA|)")
            print(f"  Masthead AWA mean: {np.mean(np.abs(mhu)):.3f}° (|AWA|)")
            print(f"\nSensor Disagreement (Masthead - Bow):")
            print(f"  Mean difference:   {np.mean(diff):+.3f}°")
            print(f"  Std difference:    {np.std(diff):.3f}°")
            print(f"  Max difference:    {np.max(np.abs(diff)):.3f}°")
            print(f"  95th percentile:   {np.percentile(np.abs(diff), 95):.3f}°")
            
            if 'Awa_fused_deg' in df_final.columns:
                fused = df_final['Awa_fused_deg'].values
                bow_to_fused = fused - bow
                mhu_to_fused = fused - mhu
                
                print(f"\nFusion creates intermediate value:")
                print(f"  Bow->Fused:        {np.mean(bow_to_fused):+.3f}° (fused is {abs(np.mean(bow_to_fused)):.3f}° {'above' if np.mean(bow_to_fused) > 0 else 'below'} bow)")
                print(f"  Masthead->Fused:   {np.mean(mhu_to_fused):+.3f}° (fused is {abs(np.mean(mhu_to_fused)):.3f}° {'above' if np.mean(mhu_to_fused) > 0 else 'below'} mast)")
                print(f"\n  Verification: Bow offset ({np.mean(bow_to_fused):+.3f}°) + Mast offset ({np.mean(mhu_to_fused):+.3f}°) = {np.mean(bow_to_fused) + np.mean(mhu_to_fused):.3f}° (should be ~0)")
                
                # Sample comparison - show a few representative points
                print(f"\nSample values (first 10 points):")
                print(f"  {'Sample':>6} {'Bow':>8} {'Masthead':>10} {'Fused':>8} {'Mhu-Bow':>10}")
                print(f"  {'-'*6} {'-'*8} {'-'*10} {'-'*8} {'-'*10}")
                for i in range(min(10, len(bow))):
                    print(f"  {i+1:>6} {bow[i]:>8.2f} {mhu[i]:>10.2f} {fused[i]:>8.2f} {(mhu[i]-bow[i]):>10.2f}")
        
        # Generate comparison plots
        print("\n" + "="*30)
        print("GENERATING PLOTS")
        print("="*30)
        
        print("\nCreating multi-sensor comparison plots...")
        fig = create_multi_sensor_comparison_plots(df_final, multi_sensor_results)
        plot_filename = f"multi_sensor_comparison_{CONFIG.source_name}_{CONFIG.date}.png"
        fig.savefig(plot_filename, dpi=150, bbox_inches='tight')
        print(f"  Saved: {plot_filename}")
        plt.close(fig)
        
        # Export calibrated data to parquet
        print("\n" + "="*30)
        print("EXPORTING CALIBRATED DATA")
        print("="*30)
        
        parquet_filename = f"calibrated_data_{CONFIG.source_name}_{CONFIG.date}.parquet"
        
        # Select key columns for export (only if they exist)
        potential_cols = [
            'Datetime', 'ts', 
            'Bsp_kph', 'Hdg_deg', 'Cog_deg', 'Sog_kph',
            LEEWAY_SENSOR,
            'Twa_deg', 'tack', 'hour_offset', 'sailing_mode'
        ]
        
        export_cols = [col for col in potential_cols if col in df_final.columns]
        
        # Add sensor columns that exist
        for sensor in AWA_SENSORS + AWS_SENSORS:
            if sensor in df_final.columns:
                export_cols.append(sensor)
        
        # Add fused columns
        fused_cols = ['Awa_fused_deg', 'Aws_fused_kph', 'Awa_n_sensors', 'Awa_uncertainty',
                      'Tws_fused_kph', 'Twa_fused_deg', 'Twd_fused_deg',
                      'Awa_bow_deg_outlier', 'Awa_mhu_deg_outlier']
        for col in fused_cols:
            if col in df_final.columns:
                export_cols.append(col)
        
        # Export
        df_export = df_final[export_cols].copy()
        df_export.to_parquet(parquet_filename, index=False)
        print(f"\nExported {len(df_export):,} samples to: {parquet_filename}")
        print(f"Columns exported: {len(export_cols)}")
        print(f"  Key columns: {', '.join(export_cols[:10])}")
        if len(export_cols) > 10:
            print(f"  ... and {len(export_cols)-10} more")
        
        print("\n" + "="*30)
        print("[OK] TEST COMPLETE")
        print("="*30)
        
        return results
        
    except Exception as e:
        print(f"\n[ERROR] TEST FAILED: {e}")
        import traceback
        traceback.print_exc()
        return None


if __name__ == "__main__":
    results = run_multi_sensor_test()
