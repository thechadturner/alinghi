"""
Debug script to check InfluxDB query results for AC40 data.
This script will help diagnose why Docker returns only one file while local execution returns four.
"""

import os
import sys
from datetime import datetime
from dateutil import tz
from pathlib import Path

# Add utilities to path
sys.path.append(str(Path(__file__).parent.parent / 'libs' / 'utilities'))

import utilities as u
from dotenv import load_dotenv

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"
print(f"Environment mode: {'production' if is_production else 'development'}")

# Get project root
project_root = Path(__file__).parent.parent

# Load environment files
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"

base_env_path = project_root / base_env_file
local_env_path = project_root / local_env_file

print(f"Loading env files:")
print(f"  Base: {base_env_path} (exists: {base_env_path.exists()})")
print(f"  Local: {local_env_path} (exists: {local_env_path.exists()})")

load_dotenv(dotenv_path=base_env_path)
load_dotenv(dotenv_path=local_env_path, override=True)

# Check environment variables
print(f"\nEnvironment variables:")
print(f"  NODE_ENV: {os.getenv('NODE_ENV')}")
print(f"  TZ: {os.getenv('TZ')}")
print(f"  INFLUX_HOST: {os.getenv('INFLUX_HOST')}")
print(f"  INFLUX_DATABASE: {os.getenv('INFLUX_DATABASE')}")
print(f"  INFLUX_BUCKET: {os.getenv('INFLUX_BUCKET')}")
print(f"  INFLUX_TOKEN: {'✓ Set' if os.getenv('INFLUX_TOKEN') else '✗ Not set'}")
print(f"  DATA_DIRECTORY: {os.getenv('DATA_DIRECTORY')}")

# Test parameters
date = "20260116"
source_name = "GER"

print(f"\nTest query parameters:")
print(f"  Date: {date}")
print(f"  Source: {source_name}")

# Convert date to formatted date
date_str = str(date)
if len(date_str) == 8 and date_str.isdigit():
    formatted_date = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
else:
    print(f"ERROR: Invalid date format: {date_str}")
    sys.exit(1)

print(f"  Formatted date: {formatted_date}")

# Show what time range will be queried
start_time = f"{formatted_date}T00:00:00Z"
stop_time = f"{formatted_date}T23:59:59Z"
print(f"  Query time range (UTC): {start_time} to {stop_time}")

# Convert to local timezone for comparison
tz_local = tz.tzlocal()
start_dt_utc = datetime.strptime(start_time, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=tz.UTC)
stop_dt_utc = datetime.strptime(stop_time, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=tz.UTC)
start_dt_local = start_dt_utc.astimezone(tz_local)
stop_dt_local = stop_dt_utc.astimezone(tz_local)

print(f"  Query time range (local): {start_dt_local} to {stop_dt_local}")

# Test query with a single channel
print(f"\nTesting InfluxDB query with a single channel...")
test_channels = [
    {'name': 'BOAT_SPEED_km_h_1', 'type': 'float'}
]

try:
    df = u.get_channel_values_influx(
        date=date,
        source_name=source_name,
        channel_list=test_channels,
        rs='100ms',
        start_ts=None,
        end_ts=None,
        timezone='UTC',
        level='strm',
        skipMissing=False
    )
    
    if df is not None and len(df) > 0:
        print(f"✓ Query successful! Retrieved {len(df)} rows")
        
        # Show time range of data
        if 'ts' in df.columns:
            min_ts = df['ts'].min()
            max_ts = df['ts'].max()
            min_dt_utc = datetime.fromtimestamp(min_ts, tz=tz.UTC)
            max_dt_utc = datetime.fromtimestamp(max_ts, tz=tz.UTC)
            min_dt_local = min_dt_utc.astimezone(tz_local)
            max_dt_local = max_dt_utc.astimezone(tz_local)
            
            print(f"  Data time range (UTC): {min_dt_utc} to {max_dt_utc}")
            print(f"  Data time range (local): {min_dt_local} to {max_dt_local}")
            
            # Show hourly distribution
            print(f"\n  Hourly distribution:")
            df['hour'] = df['ts'].apply(lambda x: datetime.fromtimestamp(x, tz=tz.UTC).strftime('%Y-%m-%d %H:00'))
            hour_counts = df.groupby('hour').size()
            for hour, count in hour_counts.items():
                print(f"    {hour}: {count} rows")
        else:
            print(f"  WARNING: No 'ts' column in result")
            print(f"  Columns: {df.columns.tolist()}")
    else:
        print(f"✗ Query returned no data")
        
except Exception as e:
    print(f"✗ Query failed with error: {e}")
    import traceback
    print(f"Traceback:\n{traceback.format_exc()}")

print(f"\nDiagnostic complete!")
