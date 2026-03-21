"""
Discover available sensor channels in the data.
Queries the API to find what AWA/AWS sensors exist for different boats.
"""

import sys
sys.path.insert(0, '..')

from utilities.api_utils import get_channel_values
from utilities.cal_utils import CalibrationConfig

# Test configuration
CONFIG = CalibrationConfig(
    api_token="8493d8284a19ae9f5a23cafdec7de5bfccdce799d651d053e81bc2adc75a4002",
    class_name="gp50",
    project_id="1",
    date="20260118",  
    source_name="GER",
    rs="100ms",
    timezone="UTC"
)

print("=" * 80)
print("SENSOR DISCOVERY")
print("=" * 80)
print(f"\nQuerying: {CONFIG.source_name} on {CONFIG.date}")

# Try to discover AWA/AWS sensors
potential_sensors = [
    # AWA sensors - bow and masthead variations
    'Awa_deg',
    'Awa_bow_deg', 
    'Awa_mhu_deg',
    'Awa_masthead_deg',
    'Awa_mast_deg',
    'AWA_deg',
    'AWA_bow_deg',
    'AWA_mhu_deg',
    
    # AWS sensors
    'Aws_kph',
    'Aws_bow_kph',
    'Aws_mhu_kph', 
    'Aws_masthead_kph',
    'Aws_mast_kph',
    'AWS_kph',
    'AWS_bow_kph',
    'AWS_mhu_kph',
]

print("\nChecking for sensors...")
available_sensors = []

for sensor in potential_sensors:
    try:
        # Try to fetch a small sample
        result = get_channel_values(
            api_token=CONFIG.api_token,
            class_name=CONFIG.class_name,
            project_id=CONFIG.project_id,
            date=CONFIG.date,
            source_name=CONFIG.source_name,
            rs=CONFIG.rs,
            channels=[{'name': sensor, 'type': 'float'}],
            timezone=CONFIG.timezone,
            use_grades=True,
            grade=3
        )
        
        if result is not None and len(result) > 0:
            # Check if we got actual data (not all NaN)
            if result[sensor].notna().sum() > 0:
                available_sensors.append(sensor)
                print(f"  ✓ {sensor}: {len(result)} samples, {result[sensor].notna().sum()} non-null")
    except Exception as e:
        # Sensor doesn't exist or error occurred
        pass

print("\n" + "=" * 80)
print("AVAILABLE SENSORS")
print("=" * 80)

if available_sensors:
    awa_sensors = [s for s in available_sensors if 'Awa' in s or 'AWA' in s]
    aws_sensors = [s for s in available_sensors if 'Aws' in s or 'AWS' in s]
    
    print("\nAWA Sensors:")
    for s in awa_sensors:
        print(f"  - {s}")
    
    print("\nAWS Sensors:")
    for s in aws_sensors:
        print(f"  - {s}")
    
    print("\n" + "=" * 80)
    print("CONFIGURATION FOR multi_sensor_test.py")
    print("=" * 80)
    print("\nAWA_SENSORS = [" + ", ".join([f"'{s}'" for s in awa_sensors]) + "]")
    print("AWS_SENSORS = [" + ", ".join([f"'{s}'" for s in aws_sensors]) + "]")
else:
    print("\nNo sensors found. The API may not have expected channel names.")
    print("Check the API documentation for correct channel naming.")

print("\n" + "=" * 80)
