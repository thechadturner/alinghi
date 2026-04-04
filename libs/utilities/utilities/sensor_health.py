"""
Sensor Health Validation Module

Detects damaged, stuck, or faulty sensors before calibration.
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional


class SensorHealthCheck:
    """Validate sensor health using multiple diagnostic tests."""
    
    # Default thresholds for different sensor types
    THRESHOLDS = {
        'awa': {
            'min_std': 0.5,           # Minimum variation (degrees)
            'max_range': 180.0,       # Physical limit (degrees)
            'max_jump': 20.0,         # Max sample-to-sample change (degrees)
            'min_corr_bsp': 0.2,      # Minimum correlation with boat speed
            'max_null_pct': 10.0      # Maximum missing data percentage
        },
        'aws': {
            'min_std': 0.2,           # Minimum variation (kph)
            'max_range': 80.0,        # Physical limit (kph)
            'max_jump': 10.0,         # Max sample-to-sample change (kph)
            'min_corr_bsp': 0.3,      # Minimum correlation with boat speed
            'max_null_pct': 10.0      # Maximum missing data percentage
        },
        'leeway': {
            'min_std': 0.1,           # Minimum variation (degrees)
            'max_range': 10.0,        # Physical limit (degrees)
            'max_jump': 5.0,          # Max sample-to-sample change (degrees)
            'min_corr_heel': 0.2,     # Minimum correlation with heel/cant
            'max_null_pct': 10.0      # Maximum missing data percentage
        }
    }
    
    @staticmethod
    def get_sensor_type(sensor_name: str) -> str:
        """Determine sensor type from name."""
        name_lower = sensor_name.lower()
        if 'awa' in name_lower:
            return 'awa'
        elif 'aws' in name_lower:
            return 'aws'
        elif 'lwy' in name_lower or 'leeway' in name_lower:
            return 'leeway'
        else:
            return 'unknown'
    
    @classmethod
    def validate_sensor(cls, df: pd.DataFrame, sensor_name: str, 
                       custom_thresholds: Optional[Dict] = None) -> Dict:
        """
        Comprehensive health check for a single sensor.
        
        Args:
            df: DataFrame with sensor data
            sensor_name: Name of sensor column to check
            custom_thresholds: Override default thresholds
            
        Returns:
            Dictionary with health status:
            {
                'sensor': str,
                'sensor_type': str,
                'passed': bool,
                'issues': List[str],
                'warnings': List[str],
                'metrics': Dict[str, float],
                'score': float  # 0-100
            }
        """
        if sensor_name not in df.columns:
            return {
                'sensor': sensor_name,
                'sensor_type': 'unknown',
                'passed': False,
                'issues': ['SENSOR_NOT_FOUND'],
                'warnings': [],
                'metrics': {},
                'score': 0.0
            }
        
        sensor_type = cls.get_sensor_type(sensor_name)
        thresholds = custom_thresholds or cls.THRESHOLDS.get(sensor_type, {})
        
        health = {
            'sensor': sensor_name,
            'sensor_type': sensor_type,
            'passed': True,
            'issues': [],
            'warnings': [],
            'metrics': {},
            'score': 100.0  # Start with perfect score, deduct for issues
        }
        
        data = df[sensor_name].copy()
        
        # Test 1: Check for missing data
        null_pct = data.isnull().sum() / len(data) * 100
        health['metrics']['null_pct'] = null_pct
        
        if null_pct > thresholds.get('max_null_pct', 10.0):
            health['passed'] = False
            health['issues'].append(f'EXCESSIVE_NULLS ({null_pct:.1f}%)')
            health['score'] -= 30
        elif null_pct > 5.0:
            health['warnings'].append(f'High null rate: {null_pct:.1f}%')
            health['score'] -= 10
        
        # Filter out nulls for remaining tests
        data_clean = data.dropna()
        
        if len(data_clean) < 100:
            health['passed'] = False
            health['issues'].append('INSUFFICIENT_DATA')
            health['score'] = 0
            return health
        
        # Test 2: Stuck sensor (no variation)
        std = data_clean.std()
        health['metrics']['std'] = std
        
        min_std = thresholds.get('min_std', 0.1)
        if std < min_std:
            health['passed'] = False
            health['issues'].append(f'STUCK_SENSOR (σ={std:.3f})')
            health['score'] -= 40
        elif std < min_std * 2:
            health['warnings'].append(f'Low variation: σ={std:.3f}')
            health['score'] -= 15
        
        # Test 3: Out of physical range (use magnitude for signed angles / leeway)
        if sensor_type in ('awa', 'leeway'):
            abs_max = float(data_clean.abs().max())
        else:
            abs_max = float(data_clean.max())
        
        health['metrics']['max_value'] = abs_max
        
        max_range = thresholds.get('max_range', 1000.0)
        if abs_max > max_range:
            health['passed'] = False
            health['issues'].append(f'OUT_OF_RANGE (max={abs_max:.1f})')
            health['score'] -= 30
        
        # Test 4: Excessive noise (high frequency spikes)
        diff = data_clean.diff().abs()
        max_jump = diff.quantile(0.99)
        health['metrics']['max_jump_99pct'] = max_jump
        
        max_jump_threshold = thresholds.get('max_jump', 20.0)
        if max_jump > max_jump_threshold:
            health['passed'] = False
            health['issues'].append(f'EXCESSIVE_NOISE (99%ile jump={max_jump:.1f})')
            health['score'] -= 25
        elif max_jump > max_jump_threshold * 0.7:
            health['warnings'].append(f'High noise: 99%ile jump={max_jump:.1f}')
            health['score'] -= 10
        
        # Test 5: Correlation with related sensor
        if sensor_type in ['awa', 'aws'] and 'Bsp_kph' in df.columns:
            bsp = df['Bsp_kph'].dropna()
            common_idx = data.dropna().index.intersection(bsp.index)
            
            if len(common_idx) > 100:
                corr = data.loc[common_idx].corr(bsp.loc[common_idx])
                health['metrics']['corr_bsp'] = corr
                
                min_corr = thresholds.get('min_corr_bsp', 0.2)
                if abs(corr) < min_corr:
                    health['warnings'].append(f'Low BSP correlation: {corr:.2f}')
                    health['score'] -= 10
        
        # Test 6: Check for constant periods (flat lines)
        window_size = min(100, len(data_clean) // 10)
        if window_size > 10:
            rolling_std = data_clean.rolling(window=window_size).std()
            flat_periods = (rolling_std < min_std * 0.1).sum()
            flat_pct = flat_periods / len(rolling_std) * 100
            health['metrics']['flat_periods_pct'] = flat_pct
            
            if flat_pct > 10:
                health['warnings'].append(f'Flat periods: {flat_pct:.1f}%')
                health['score'] -= 5
        
        # Ensure score doesn't go negative
        health['score'] = max(0.0, health['score'])
        
        return health
    
    @classmethod
    def validate_all_sensors(cls, df: pd.DataFrame, 
                            sensor_list: List[str]) -> Dict[str, Dict]:
        """
        Validate multiple sensors.
        
        Args:
            df: DataFrame with sensor data
            sensor_list: List of sensor column names
            
        Returns:
            Dictionary mapping sensor name to health report
        """
        results = {}
        
        for sensor in sensor_list:
            results[sensor] = cls.validate_sensor(df, sensor)
        
        return results
    
    @staticmethod
    def print_health_report(health_results: Dict[str, Dict], 
                           show_passed: bool = True):
        """
        Print human-readable health report.
        
        Args:
            health_results: Output from validate_all_sensors()
            show_passed: Whether to show sensors that passed
        """
        print("\n" + "="*30)
        print("SENSOR HEALTH REPORT")
        print("="*30)
        
        failed = []
        warned = []
        passed = []
        
        for sensor, health in health_results.items():
            if not health['passed']:
                failed.append((sensor, health))
            elif health['warnings']:
                warned.append((sensor, health))
            else:
                passed.append((sensor, health))
        
        # Print failures
        if failed:
            print("\n[FAILED] FAILED SENSORS:")
            for sensor, health in failed:
                print(f"\n  {sensor} (Score: {health['score']:.1f}/100)")
                for issue in health['issues']:
                    print(f"    ! {issue}")
                if health['warnings']:
                    for warning in health['warnings']:
                        print(f"    ! {warning}")
        
        # Print warnings
        if warned:
            print("\n[WARNING] SENSORS WITH WARNINGS:")
            for sensor, health in warned:
                print(f"\n  {sensor} (Score: {health['score']:.1f}/100)")
                for warning in health['warnings']:
                    print(f"    * {warning}")
        
        # Print passed
        if show_passed and passed:
            print("\n[OK] HEALTHY SENSORS:")
            for sensor, health in passed:
                print(f"  {sensor} (Score: {health['score']:.1f}/100)")
        
        # Summary
        total = len(health_results)
        print("\n" + "-"*30)
        print(f"Summary: {len(passed)}/{total} passed, "
              f"{len(warned)}/{total} warnings, {len(failed)}/{total} failed")
        print("="*30)
    
    @staticmethod
    def get_healthy_sensors(health_results: Dict[str, Dict], 
                           min_score: float = 50.0) -> List[str]:
        """
        Get list of healthy sensors above minimum score threshold.
        
        Args:
            health_results: Output from validate_all_sensors()
            min_score: Minimum health score to consider sensor usable
            
        Returns:
            List of sensor names that passed health checks
        """
        healthy = []
        
        for sensor, health in health_results.items():
            if health['passed'] and health['score'] >= min_score:
                healthy.append(sensor)
        
        return healthy
