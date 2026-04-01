from datetime import time, datetime, timedelta
from tracemalloc import start
from typing import List, Dict, Any, Optional, Literal, Tuple
import requests
import pandas as pd
import numpy as np

import requests
import json
import threading
import time as time_module
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

from dotenv import load_dotenv
from pathlib import Path
import os
from dateutil import tz
from dateutil.tz import gettz
from influxdb_client import InfluxDBClient
from .logging_utils import log_warning, log_error, log_info

# from app.utils import response

# Load environment variables (Docker, system env, .env files, etc.)
# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (utilities is in libs/utilities/utilities/, so go up 3 levels)
# This assumes the project root is where .env files are located
project_root = Path(__file__).parent.parent.parent.parent

# Load environment files based on mode
# Development: .env -> .env.local
# Production: .env.production -> .env.production.local
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"

base_env_path = project_root / base_env_file
local_env_path = project_root / local_env_file

# Load environment files (matching main.py pattern)
# Priority: Docker env vars (set by Docker Compose) > .env.production.local > .env.production
# In Docker containers, files don't exist but Docker Compose sets env vars from env_file: entries
# In local development, files exist and are loaded as fallback

# Load base .env file first (defaults) - don't override existing env vars (Docker has priority)
if base_env_path.exists():
    load_dotenv(dotenv_path=base_env_path, override=False)

# Load local .env file second (overrides base, gitignored secrets) - override to allow local secrets to override base
if local_env_path.exists():
    load_dotenv(dotenv_path=local_env_path, override=True)

# Detect if running in Docker container
# Check for DOCKER_CONTAINER env var or if /.dockerenv file exists
def is_docker_container():
    """Check if running inside a Docker container"""
    if os.getenv("DOCKER_CONTAINER") == "true":
        return True
    if os.path.exists("/.dockerenv"):
        return True
    # Check if 'node' hostname resolves (Docker service name)
    try:
        import socket
        socket.gethostbyname("node")
        return True
    except (socket.gaierror, OSError):
        return False

# Determine default host based on environment
# In production, always use "node" (Docker service name) since all services run in Docker
# In development, use Docker service name if in container, otherwise localhost
if is_production:
    DEFAULT_HOST = "node"  # Production always uses Docker service names
elif is_docker_container():
    DEFAULT_HOST = "node"  # Development in Docker uses service names
else:
    DEFAULT_HOST = "localhost"  # Local development outside Docker

def normalize_url_to_http(url: str) -> str:
    """
    Normalize URL to use HTTP protocol for internal network connections.
    Internal IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x, localhost, 127.0.0.1) should use HTTP.
    """
    if not url:
        return url
    
    # Extract host from URL
    import re
    # Match http:// or https:// followed by host:port/path
    match = re.match(r'^(https?://)([^:/]+)(?::(\d+))?(/.*)?$', url)
    if not match:
        return url
    
    protocol, host, port, path = match.groups()
    path = path or ''
    
    # Check if host is an internal network address
    is_internal = (
        host in ['localhost', '127.0.0.1', 'node'] or
        host.startswith('192.168.') or
        host.startswith('10.') or
        (host.startswith('172.') and 16 <= int(host.split('.')[1]) <= 31)
    )
    
    # Force HTTP for internal addresses
    if is_internal:
        protocol = 'http://'
    
    # Reconstruct URL
    if port:
        return f"{protocol}{host}:{port}{path}"
    else:
        return f"{protocol}{host}{path}"

# FILE_API_URL: Use Docker service name for file server (node:8079) or localhost for local dev
# Can be overridden by setting FILE_API_URL environment variable
FILE_API_URL = os.getenv("FILE_API_URL")
if not FILE_API_URL:
    # Default based on environment
    FILE_API_URL = f"http://{DEFAULT_HOST}:8079/api"
else:
    # Normalize to HTTP for internal network connections
    FILE_API_URL = normalize_url_to_http(FILE_API_URL)

# APP_API_URL: Use Docker service name for app server (node:8069) or localhost for local dev
# Can be overridden by setting APP_API_URL environment variable
APP_API_URL = os.getenv("APP_API_URL")
if not APP_API_URL:
    # Default based on environment
    APP_API_URL = f"http://{DEFAULT_HOST}:8069"
else:
    # Normalize to HTTP for internal network connections
    APP_API_URL = normalize_url_to_http(APP_API_URL)

# ADMIN_API_URL: Use Docker service name for admin server (node:8059) or localhost for local dev
# Can be overridden by setting ADMIN_API_URL environment variable
ADMIN_API_URL = os.getenv("ADMIN_API_URL")
if not ADMIN_API_URL:
    # Default based on environment
    ADMIN_API_URL = f"http://{DEFAULT_HOST}:8059"
else:
    # Normalize to HTTP for internal network connections
    ADMIN_API_URL = normalize_url_to_http(ADMIN_API_URL)

# Timeouts for admin server (8059): processing scripts can trigger long-running DELETE/POST (e.g. by_event_type, events)
# so we use longer read timeouts to avoid ReadTimeout when the admin server or DB is slow.
ADMIN_GET_TIMEOUT = (120, 600)      # 10 min read for GET
ADMIN_POST_TIMEOUT = (120, 900)     # 15 min read for POST
ADMIN_PUT_TIMEOUT = (120, 900)     # 15 min read for PUT
ADMIN_DELETE_TIMEOUT = (120, 600)  # 10 min read for DELETE

# Optional host override: when set, all API requests use this host (ports 8079, 8069, 8059).
# Allows local scripts to target production. Set via set_api_host(); if None, existing env/default behavior is used.
_api_host_override: Optional[str] = None

# When set, use path-based routing (e.g. https://www.racesight.cloud) so requests go through nginx on 443.
# Set automatically when set_api_host() is called with a value containing "://".
_api_base_url_override: Optional[str] = None


def set_api_host(host: Optional[str]) -> None:
    """
    Set the API host or base URL used for all requests (file, app, admin).

    - If host contains \"://\" (e.g. https://www.racesight.cloud), it is treated as a base URL:
      requests use path-based routing through nginx (no backend ports). Use this when only
      ports 80/443 are exposed.
    - Otherwise host is treated as a hostname (e.g. www.racesight.cloud): requests use
      ports 8079 (file), 8069 (app), 8059 (admin). Use when those ports are reachable.

    Pass None to clear and use env/default behavior.
    """
    global _api_host_override, _api_base_url_override
    if not host or not isinstance(host, str):
        _api_host_override = None
        _api_base_url_override = None
        return
    s = host.strip()
    if not s:
        _api_host_override = None
        _api_base_url_override = None
        return
    if "://" in s:
        _api_base_url_override = s.rstrip("/")
        _api_host_override = None
    else:
        _api_host_override = s
        _api_base_url_override = None


def get_api_host() -> Optional[str]:
    """Return the current API host override, or None if using env/default or base URL mode."""
    return _api_host_override


def get_api_base_url() -> Optional[str]:
    """Return the current API base URL override (nginx path-based mode), or None."""
    return _api_base_url_override


def _is_base_url_mode() -> bool:
    """True when using base URL (e.g. through nginx) so admin paths are /api/admin/xxx."""
    return _api_base_url_override is not None


def _get_file_api_url() -> str:
    """Return the file API base URL (override host/base or FILE_API_URL)."""
    if _api_base_url_override:
        return f"{_api_base_url_override}/api/file"
    if _api_host_override:
        return normalize_url_to_http(f"http://{_api_host_override}:8079/api")
    return FILE_API_URL


def _get_app_api_url() -> str:
    """Return the app API base URL (override host/base or APP_API_URL)."""
    if _api_base_url_override:
        return _api_base_url_override
    if _api_host_override:
        return normalize_url_to_http(f"http://{_api_host_override}:8069")
    return APP_API_URL


def _get_admin_api_url() -> str:
    """Return the admin API base URL (override host/base or ADMIN_API_URL)."""
    if _api_base_url_override:
        return f"{_api_base_url_override}/api/admin"
    if _api_host_override:
        return normalize_url_to_http(f"http://{_api_host_override}:8059")
    return ADMIN_API_URL


def parseBinary(binary_data: bytes) -> pd.DataFrame:
    import pyarrow as pa
    reader = pa.ipc.open_stream(pa.BufferReader(binary_data))
    table = reader.read_all()

    try:
        df = table.to_pandas(ignore_metadata=True)
    except Exception:
        try:
            df = table.to_pandas(types_mapper=lambda dtype: object, ignore_metadata=True)
        except Exception:
            df = pd.DataFrame(table.to_pylist())

    return df

def normalize_channel_type(channel_type: str) -> str:
    """
    Normalize channel type variations to canonical types used by the code.
    
    Maps variations like 'str', 'integer', 'float64' to canonical types:
    - 'string' (from 'str', 'text', 'varchar', etc.)
    - 'int' (from 'integer', 'int32', 'int64', etc.)
    - 'float' (from 'float32', 'float64', 'double', etc.)
    - 'datetime' (from 'date', 'timestamp', etc.)
    - Preserves angle-related suffixes (360, 180, angle)
    
    Args:
        channel_type: The channel type string to normalize
        
    Returns:
        Normalized channel type string
    """
    if not channel_type or not isinstance(channel_type, str):
        return channel_type
    
    # Convert to lowercase for case-insensitive matching
    type_lower = channel_type.lower().strip()
    
    # Check for angle-related types first (preserve these patterns)
    # The code checks for these substrings, so we preserve them
    has_angle = 'angle' in type_lower
    has_360 = '360' in type_lower
    has_180 = '180' in type_lower
    
    # If it's an angle type, preserve the angle parts and normalize any base type
    if has_angle or has_360 or has_180:
        # Extract and normalize base type (everything except angle/360/180)
        base_parts = []
        remaining = type_lower
        for keyword in ['angle', '360', '180']:
            remaining = remaining.replace(keyword, ' ')
        base_parts = [p for p in remaining.split() if p]
        
        # Normalize base type if present
        if base_parts:
            base_type = base_parts[0]
        else:
            base_type = 'float'  # Default for angle types
        
        # Map base types to canonical types
        type_mapping = {
            'str': 'string', 'text': 'string', 'varchar': 'string', 'char': 'string', 'string': 'string',
            'int': 'int', 'integer': 'int', 'int32': 'int', 'int64': 'int', 'int16': 'int', 'int8': 'int',
            'float': 'float', 'float32': 'float', 'float64': 'float', 'double': 'float', 'real': 'float', 'numeric': 'float', 'number': 'float',
            'datetime': 'datetime', 'date': 'datetime', 'timestamp': 'datetime', 'time': 'datetime',
        }
        normalized_base = type_mapping.get(base_type, 'float')  # Default to float for angle types
        
        # Reconstruct: preserve angle keywords, use normalized base
        angle_parts = []
        if has_angle:
            angle_parts.append('angle')
        if has_360:
            angle_parts.append('360')
        if has_180:
            angle_parts.append('180')
        
        # For angle types, typically just use angle parts (e.g., 'angle360')
        # But if base type is explicitly non-float, preserve it
        if normalized_base != 'float' and base_parts:
            return normalized_base + ''.join(angle_parts)
        else:
            return ''.join(angle_parts) if angle_parts else 'float'
    
    # For non-angle types, just normalize the base type
    type_mapping = {
        'str': 'string', 'text': 'string', 'varchar': 'string', 'char': 'string', 'string': 'string',
        'int': 'int', 'integer': 'int', 'int32': 'int', 'int64': 'int', 'int16': 'int', 'int8': 'int',
        'float': 'float', 'float32': 'float', 'float64': 'float', 'double': 'float', 'real': 'float', 'numeric': 'float', 'number': 'float',
        'datetime': 'datetime', 'date': 'datetime', 'timestamp': 'datetime', 'time': 'datetime',
    }
    
    return type_mapping.get(type_lower, type_lower)  # Return normalized or original if not in mapping

def parse_resample_frequency_to_ms(rs: str) -> float:
    """
    Parse pandas resampling frequency string to milliseconds.
    
    Examples:
        '100ms' -> 100
        '1s' -> 1000
        '200ms' -> 200
        '500ms' -> 500
        
    Args:
        rs: Resampling frequency string (e.g., '100ms', '1s')
        
    Returns:
        Frequency in milliseconds as float
    """
    if not rs or not isinstance(rs, str):
        return float('inf')  # Return large value if invalid
    
    rs_lower = rs.lower().strip()
    
    # Handle milliseconds
    if rs_lower.endswith('ms'):
        try:
            return float(rs_lower[:-2])
        except ValueError:
            return float('inf')
    
    # Handle seconds
    if rs_lower.endswith('s'):
        try:
            return float(rs_lower[:-1]) * 1000
        except ValueError:
            return float('inf')
    
    # Handle minutes
    if rs_lower.endswith('min') or rs_lower.endswith('m'):
        try:
            value = float(rs_lower[:-3] if rs_lower.endswith('min') else rs_lower[:-1])
            return value * 60 * 1000
        except ValueError:
            return float('inf')
    
    # Handle hours
    if rs_lower.endswith('h'):
        try:
            return float(rs_lower[:-1]) * 60 * 60 * 1000
        except ValueError:
            return float('inf')
    
    # Default: try to parse as number (assume milliseconds)
    try:
        return float(rs_lower)
    except ValueError:
        return float('inf')


def fill_outer_merge_numeric_gaps(df: pd.DataFrame, ts_col: str = "ts") -> pd.DataFrame:
    """
    After an outer merge on time: fill NaNs in numeric columns.

    Float columns use linear interpolation along ``ts_col`` between known samples
    (``limit_area='inside'``), then forward/backward fill for leading/trailing gaps.
    Integer and other numeric columns use forward/backward fill only (discrete / no ramp).

    ``ts_col`` is left unchanged. Rows are sorted by ``ts_col``.
    """
    if df is None or len(df) == 0 or ts_col not in df.columns:
        return df

    out = df.sort_values(by=[ts_col], ascending=True, kind="mergesort")
    if out[ts_col].duplicated().any():
        out = out.drop_duplicates(subset=[ts_col], keep="first")

    numeric_cols = [c for c in out.select_dtypes(include=[np.number]).columns if c != ts_col]
    if not numeric_cols:
        return out

    float_cols: List[str] = []
    for c in numeric_cols:
        if pd.api.types.is_float_dtype(out[c]):
            float_cols.append(c)
        elif str(out[c].dtype) == "Float64":
            float_cols.append(c)

    step_cols = [c for c in numeric_cols if c not in float_cols]

    idx = pd.to_numeric(out[ts_col], errors="coerce")
    ts_all_valid = bool(idx.notna().all())

    if ts_all_valid and float_cols:
        for col in float_cols:
            vals = pd.to_numeric(out[col], errors="coerce")
            s = pd.Series(vals.to_numpy(dtype=np.float64), index=idx)
            try:
                filled = s.interpolate(
                    method="index",
                    limit_direction="both",
                    limit_area="inside",
                )
            except TypeError:
                filled = s.interpolate(method="index", limit_direction="both")
            out[col] = filled.to_numpy()

    fill_edge = float_cols + step_cols
    if fill_edge:
        out.loc[:, fill_edge] = out.loc[:, fill_edge].ffill().bfill()

    return out


def resample_dataframe(dfi: pd.DataFrame, channels: List[Dict[str, str]], rs: str) -> pd.DataFrame:
    # Validate inputs
    if dfi is None or len(dfi) == 0:
        return pd.DataFrame()
    
    # Check if dataframe has any columns (besides the index)
    if len(dfi.columns) == 0:
        log_error(f"resample_dataframe: Dataframe has no columns to resample. Index type: {type(dfi.index)}, Index length: {len(dfi.index)}")
        return pd.DataFrame()
    
    # Validate resampling frequency
    if not isinstance(rs, str) or len(rs) == 0:
        log_error(f"resample_dataframe: Invalid resampling frequency: {rs}")
        return pd.DataFrame()
    
    # Check for reasonable data size before resampling
    if len(dfi) > 50000000:  # 50 million rows
        log_error(f"resample_dataframe: Dataset too large ({len(dfi)} rows). This may cause memory issues.")
        return pd.DataFrame()
    
    df = dfi.copy()
    
    # Convert ts index to DatetimeIndex temporarily for resampling
    df.index = pd.to_datetime(df.index, unit='s', utc=True)
    
    # Add sin/cos columns for angular types (needed for proper averaging)
    for ch in channels:
        channel_name = ch['name']
        channel_type = normalize_channel_type(ch['type'])
        if channel_name in df.columns and ('angle' in channel_type or '360' in channel_type or '180' in channel_type):
            df['sin_' + channel_name] = np.sin(np.deg2rad(df[channel_name]))
            df['cos_' + channel_name] = np.cos(np.deg2rad(df[channel_name]))
   
    # Parse resampling frequency to determine optimal string aggregation method
    rs_ms = parse_resample_frequency_to_ms(rs)
    use_fast_string_agg = rs_ms <= 200  # Use 'last' for <= 200ms, lambda for > 200ms
    
    # Convert non-ordered categorical columns to string before aggregation
    # This prevents "Cannot perform max with non-ordered Categorical" errors
    for ch in channels:
        channel_name = ch['name']
        channel_type = normalize_channel_type(ch['type'])
        
        if channel_name in df.columns and channel_type in ['string']:
            # Handle string columns before resampling
            if pd.api.types.is_numeric_dtype(df[channel_name]):
                # If numeric (e.g., 0 values from old data), convert to string and replace "0" with ""
                df[channel_name] = df[channel_name].astype(str)
                # Replace numeric string representations with empty string
                df[channel_name] = df[channel_name].replace(['0', '0.0', 'nan', 'None', 'NaN', '<NA>'], '')
            elif pd.api.types.is_categorical_dtype(df[channel_name]):
                if not df[channel_name].cat.ordered:
                    # Convert non-ordered categorical to string
                    df[channel_name] = df[channel_name].astype(str)
            elif not pd.api.types.is_string_dtype(df[channel_name]) and not pd.api.types.is_object_dtype(df[channel_name]):
                # Convert to string if not already
                df[channel_name] = df[channel_name].astype(str)
                # Replace any numeric string representations
                df[channel_name] = df[channel_name].replace(['0', '0.0'], '')
    
    # Build aggregation dictionary
    agg_dict = {}
    for ch in channels:
        channel_name = ch['name']
        channel_type = normalize_channel_type(ch['type'])
        
        # Only add to agg_dict if the column exists in the dataframe
        if channel_name not in df.columns:
            continue

        # Use explicit equality checks for clarity and to ensure correct aggregation
        if channel_type == 'int':
            agg_dict[channel_name] = 'max'
        elif channel_type == 'float':
            agg_dict[channel_name] = 'mean'
        elif channel_type in ['string']:
            agg_dict[channel_name] = 'max'
        elif channel_type == 'datetime':
            agg_dict[channel_name] = 'first'
        elif 'angle' in channel_type or '360' in channel_type or '180' in channel_type:
            agg_dict[channel_name] = 'mean'
            if 'sin_' + channel_name in df.columns:
                agg_dict['sin_' + channel_name] = 'mean'
            if 'cos_' + channel_name in df.columns:
                agg_dict['cos_' + channel_name] = 'mean'

    # Validate that we have columns to aggregate
    if len(agg_dict) == 0:
        log_error(f"resample_dataframe: No columns to aggregate")
        return pd.DataFrame()
    
    # Perform resampling
    try:
        # Use origin='epoch' to ensure all frames align to Unix epoch boundaries
        # This guarantees identical timestamps across all channel groups
        # Only aggregate columns that are explicitly in agg_dict to avoid default mean for numeric columns
        dfs = df.resample(rs, origin='epoch').agg(agg_dict)
    except MemoryError as e:
        log_error(f"resample_dataframe: Memory error during resampling. DataFrame size: {len(df)}, resample freq: {rs}. Error: {str(e)}")
        raise
    except Exception as e:
        log_error(f"resample_dataframe: Error during resampling. DataFrame size: {len(df)}, resample freq: {rs}. Error: {str(e)}")
        raise

    # Convert index to ts (float seconds) for merging
    # Use nanosecond precision then convert to seconds with 3 decimals
    dfs.index = (dfs.index.astype('int64') / 1e9).round(3)
    dfs.index.name = 'ts'
    # Ensure index dtype is float64
    dfs.index = dfs.index.astype('float64')

    # Separate integer columns from float columns for different handling
    # Integer columns should NOT be interpolated (they're discrete categorical values)
    # Float columns can be interpolated (they're continuous numeric values)
    int_channel_names = [ch['name'] for ch in channels if normalize_channel_type(ch.get('type', '')) == 'int' and ch['name'] in dfs.columns]
    all_numeric_cols = dfs.select_dtypes(include=[np.number]).columns
    float_numeric_cols = [col for col in all_numeric_cols if col not in int_channel_names]
    
    # Interpolate only float numeric columns (continuous values)
    if len(float_numeric_cols) > 0:
        dfs[float_numeric_cols] = dfs[float_numeric_cols].interpolate(method='linear').ffill().bfill()
    
    # Forward fill/backward fill integer columns (discrete values should not be interpolated)
    if len(int_channel_names) > 0:
        dfs[int_channel_names] = dfs[int_channel_names].ffill().bfill()

    # Forward fill/backward fill string columns (metadata should be preserved across resampled intervals)
    string_channel_names = [ch['name'] for ch in channels if normalize_channel_type(ch.get('type', '')) == 'string' and ch['name'] in dfs.columns]
    if len(string_channel_names) > 0:
        for col in string_channel_names:
            # Forward fill then backward fill to preserve metadata continuity
            dfs[col] = dfs[col].ffill().bfill()
            # Replace 'nan', 'None', 'NaN', '<NA>' strings with empty string
            dfs[col] = dfs[col].replace(['nan', 'None', 'NaN', '<NA>'], '')

    # Convert angular averages back from sin/cos
    for ch in channels:
        channel_name = ch['name']
        channel_type = normalize_channel_type(ch['type'])
    
        if channel_name not in dfs.columns:
            continue
            
        if '360' in channel_type:
            dfs[channel_name] = np.rad2deg(np.arctan2(dfs['sin_'+channel_name], dfs['cos_'+channel_name]))
            dfs[channel_name] = (dfs[channel_name] + 360) % 360
            dfs.drop(['sin_'+channel_name, 'cos_'+channel_name], axis=1, inplace=True)
        elif '180' in channel_type:
            dfs[channel_name] = np.rad2deg(np.arctan2(dfs['sin_'+channel_name], dfs['cos_'+channel_name]))
            dfs[channel_name] = (dfs[channel_name] + 180) % 360 - 180
            dfs.drop(['sin_'+channel_name, 'cos_'+channel_name], axis=1, inplace=True)

    return dfs

def get_file_data(api_token: str, url: str, params: Dict[str, Any]) -> List[Any]:
    try:
        response = requests.get(
            url, 
            params=params,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_token}"
            }
        )

        if response.status_code == 200:
            # Check if response has content before parsing JSON
            if not response.text or response.text.strip() == "":
                log_warning(f"Empty response from {url}")
                return []
                
            try:
                result = response.json()
                if result.get("success") == True:
                    return result.get("data", [])
                else:
                    log_warning(f"API returned success=False for {url}: {result.get('message', 'No message')}")
                    return []
            except json.JSONDecodeError as e:
                log_error(f"Invalid JSON response from {url}: {str(e)}")
                log_error(f"Response preview: '{response.text[:200]}...'")
                return []
        else:
            log_error(f"{url} returned status {response.status_code}")
            log_error(f"Response: {response.text[:200]}")
            return []
            
    except requests.exceptions.RequestException as e:
        log_error(f"Request error for {url}", e)
        return []

def get_classes(api_token: str, project_id: str) -> List[Any]:
    """
    Sends a GET request to the `/classes` endpoint to retrieve the channel list.
    """
    url = f"{_get_file_api_url()}/classes"
    params = { "project_id": project_id }

    return get_file_data(api_token, url, params)

    
def get_sources(api_token: str, class_name: str, project_id: str, date: str) -> List[Any]:
    """
    Sends a GET request to the `/sources` endpoint to retrieve the channel list.
    """
    url = f"{_get_file_api_url()}/sources"
    params = {
        "class_name": str(class_name),
        "project_id": project_id,
        "date": str(date)
    }

    return get_file_data(api_token, url, params)

def get_dates(api_token: str, class_name: str, project_id: str) -> List[Any]:
    """
    Sends a GET request to the `/dates` endpoint to retrieve the channel list.
    """
    url = f"{_get_file_api_url()}/dates"
    params = {
        "class_name": str(class_name),
        "project_id": project_id
    }

    return get_file_data(api_token, url, params)
    
def get_channels(api_token: str, class_name: str, project_id: str, date: str, source_name: str) -> List[Any]:
    """
    Sends a GET request to the `/channels` endpoint to retrieve the channel list.
    
    Args:
        api_token: API authentication token
        class_name: Class name
        project_id: Project ID
        date: Date in YYYYMMDD format (dashes/slashes will be automatically removed)
        source_name: Source name
    
    Returns:
        List of available channels
    """
    # Normalize date format to YYYYMMDD (remove dashes/slashes) for file server API
    date = str(date).replace('-', '').replace('/', '')
    
    url = f"{_get_file_api_url()}/channels"
    params = {
        "class_name": str(class_name),
        "project_id": project_id,
        "date": date,
        "source_name": str(source_name),
    }

    return get_file_data(api_token, url, params)

def get_channel_groups(api_token: str, class_name: str, project_id: str, date: str, source_name: str, channel_list: List[Dict[str, str]]) -> List[Any]:
    channel_names = [ch['name'] for ch in channel_list]

    """
    Sends a POST request to the `/channel-groups` endpoint to retrieve the channel list by file.
    """
    # Ensure all parameters are strings for API consistency
    project_id = str(project_id)
    class_name = str(class_name)
    # Normalize date format to YYYYMMDD (remove dashes/slashes) for file server API
    date = str(date).replace('-', '').replace('/', '')
    source_name = str(source_name)
    
    url = f"{_get_file_api_url()}/channel-groups"
    params = {
        "class_name": class_name,
        "project_id": project_id,
        "date": date,
        "source_name": source_name,
        "channel_names": channel_names
    }

    response = requests.post(
        url,
        json=params,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_token}"
        }
    )

    if response.status_code == 200: 
        # Check if response has content before parsing JSON
        if not response.text or response.text.strip() == "":
            log_warning(f"Empty response from channel-groups API for class '{class_name}'")
            return []
            
        try:
            result = response.json()
            if result.get("success") == True:
                return result.get("data", [])
            else:
                log_warning(f"API returned success=False for channel-groups: {result.get('message', 'No message')}")
                return []
        except json.JSONDecodeError as e:
            log_error(f"Invalid JSON response from channel-groups API: {str(e)}")
            log_error(f"Response preview: '{response.text[:200]}...'")
            return []
    else:
        log_error(f"Channel-groups API returned status {response.status_code}")
        log_error(f"Response: {response.text[:200]}")
        log_error(
            "If message is 'Source not found', ensure the file server has parquet under "
            f"DATA_DIRECTORY/System/{project_id}/{str(class_name).lower()}/{date}/{source_name}/ "
            "(folder name must match source_name; case is resolved case-insensitively on the server)."
        )
        return []


def _execute_influx_query_chunk(query_api, influx_bucket: str, influx_database: str, boat: str, formatted_date: str, measurements: List[str], level: str, start_time: str, stop_time: str) -> pd.DataFrame:
    """
    Helper function to execute a single InfluxDB query chunk.
    
    Args:
        query_api: InfluxDB query API instance
        influx_bucket: InfluxDB bucket name
        influx_database: InfluxDB database/org name
        boat: Boat/source name filter
        formatted_date: Date in YYYY-MM-DD format
        measurements: List of measurement names to query
        level: Data level filter ('strm' or 'log')
        start_time: Start time in ISO format
        stop_time: Stop time in ISO format
    
    Returns:
        DataFrame with raw query results (with _time column)
    """
    # Build regex pattern for measurements
    measurements_pattern = '|'.join(measurements)
    
    # Build boat filter
    boat_filter = f'|> filter(fn: (r) => r.boat == "{boat}")\n    ' if boat else ''
    
    # Build Flux query - NO resampling in InfluxDB, we'll do it in pandas after removing NaNs
    query = f'''
    from(bucket: "{influx_bucket}")
        |> range(start: {start_time}, stop: {stop_time})
        |> filter(fn: (r) => r._measurement =~ /^({measurements_pattern})$/)
        |> filter(fn: (r) => r._field == "value")
        |> filter(fn: (r) => r.level == "{level}")
        {boat_filter}|> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
        |> drop(columns: ["_start", "_stop", "_field", "level", "result", "table"])
        |> sort(columns: ["_time"])
    '''
    
    # Execute query - get raw data without resampling
    # Log query details for debugging (without exposing token)
    query_info = f"[InfluxDB] Executing query: bucket={influx_bucket}, org={influx_database}, boat={boat}, date={formatted_date}, level={level}, measurements={len(measurements)}, time_range={start_time} to {stop_time}"
    print(query_info, flush=True)
    log_info(query_info)
    
    try:
        df = query_api.query_data_frame(query=query, org=influx_database)
    except Exception as query_error:
        error_msg = f"InfluxDB query failed: {str(query_error)}"
        query_details = f"Query details: bucket={influx_bucket}, org={influx_database}, boat={boat}, date={formatted_date}, time_range={start_time} to {stop_time}"
        print(f"ERROR: {error_msg}", flush=True)
        print(f"ERROR: {query_details}", flush=True)
        log_error(error_msg)
        log_error(query_details)
        raise  # Re-raise to be caught by outer exception handler
    
    # Convert _time to ts if data exists
    if df is not None and not df.empty:
        # Step 1: Convert _time (UTC datetime from InfluxDB) to ts (Unix timestamp in seconds)
        if '_time' in df.columns:
            # _time from InfluxDB is already a datetime, convert to Unix timestamp (seconds)
            # Check the dtype to determine the correct divisor
            dtype_str = str(df['_time'].dtype)
            
            if 'datetime64[us' in dtype_str:
                # Microseconds - divide by 1e6
                df['ts'] = pd.to_datetime(df['_time']).astype('int64') / 1e6
            elif 'datetime64[ms' in dtype_str:
                # Milliseconds - divide by 1e3
                df['ts'] = pd.to_datetime(df['_time']).astype('int64') / 1e3
            elif 'datetime64[ns' in dtype_str:
                # Nanoseconds - divide by 1e9
                df['ts'] = pd.to_datetime(df['_time']).astype('int64') / 1e9
            else:
                # Default to nanoseconds for backward compatibility
                df['ts'] = pd.to_datetime(df['_time']).astype('int64') / 1e9
            
            # Validate timestamp range (should be between 2020-01-01 and current time + 1 year buffer)
            from datetime import datetime
            min_valid_ts = datetime(2020, 1, 1).timestamp()  # 1577836800
            max_valid_ts = datetime.now().timestamp() + (365 * 24 * 3600)  # Current time + 1 year
            
            if len(df) > 0:
                min_ts = df['ts'].min()
                max_ts = df['ts'].max()
                
                if min_ts < min_valid_ts or max_ts > max_valid_ts:
                    log_error(f"[InfluxDB] Invalid timestamp range detected: {datetime.fromtimestamp(min_ts)} to {datetime.fromtimestamp(max_ts)}. Expected range: 2020-01-01 to {datetime.fromtimestamp(max_valid_ts).strftime('%Y-%m-%d')}")
                    return pd.DataFrame()
            
            df = df.drop(columns=['_time'])
        else:
            log_error("'_time' column not found in InfluxDB query result")
            return pd.DataFrame()
        
        # Ensure ts is float64 and consistently rounded to 3 decimals
        if 'ts' in df.columns:
            df['ts'] = df['ts'].round(3).astype('float64')
        
        # Sort by ts (all subsequent processing uses ts as time reference)
        if 'ts' in df.columns and len(df) > 0:
            df.sort_values(by=['ts'], inplace=True, ascending=True)
    
    return df if df is not None else pd.DataFrame()


IOX_TABLE = '"iox"."universalized_logs"'


def _resolve_influx_query_version(explicit: Optional[str]) -> Literal["2", "3"]:
    if explicit is not None:
        v = str(explicit).strip().lower()
        if v not in ("2", "3"):
            raise ValueError(f"influx_version must be '2' or '3', got {explicit!r}")
        return v  # type: ignore[return-value]
    env_v = (os.getenv("INFLUX_QUERY_VERSION") or "3").strip().lower()
    if env_v not in ("2", "3"):
        log_error(f"INFLUX_QUERY_VERSION must be 2 or 3, got {env_v!r}; defaulting to 3")
        return "3"
    return env_v  # type: ignore[return-value]


def _normalize_influx_token(raw: Optional[str]) -> str:
    if raw is None or raw == "":
        return ""
    t = str(raw).strip()
    if (t.startswith("'") and t.endswith("'")) or (t.startswith('"') and t.endswith('"')):
        t = t[1:-1].strip()
    return t


def _influx_v3_origin_from_host(influx_host: str) -> str:
    raw = str(influx_host or "").strip()
    if not raw.startswith(("http://", "https://")):
        raw = f"http://{raw}"
    parsed = urlparse(raw)
    port_env = (os.getenv("INFLUX_PORT") or "").strip()
    host = parsed.hostname or ""
    scheme = parsed.scheme or "http"
    if parsed.port:
        netloc = f"{host}:{parsed.port}"
    elif port_env:
        netloc = f"{host}:{port_env}"
    else:
        netloc = host
    return f"{scheme}://{netloc}".rstrip("/")


def _influx_v3_sql_string_literal(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _influx_v3_sql_quote_ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def _influx_v3_sql_time_chunk_predicate(start_sec: float, end_sec: float, overall_end_sec: float) -> str:
    start_iso = datetime.fromtimestamp(start_sec, tz=tz.tzutc()).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    end_iso = datetime.fromtimestamp(end_sec, tz=tz.tzutc()).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    end_date = datetime.fromtimestamp(end_sec, tz=tz.tzutc())
    on_utc_hour_boundary = (
        end_date.minute == 0
        and end_date.second == 0
        and end_date.microsecond == 0
    )
    use_exclusive = on_utc_hour_boundary and end_sec < overall_end_sec
    if use_exclusive:
        return f"time >= {_influx_v3_sql_string_literal(start_iso)} AND time < {_influx_v3_sql_string_literal(end_iso)}"
    return f"time >= {_influx_v3_sql_string_literal(start_iso)} AND time <= {_influx_v3_sql_string_literal(end_iso)}"


def _influx_v3_parse_jsonl(body: str) -> List[Dict[str, Any]]:
    lines = [ln for ln in str(body or "").splitlines() if ln.strip()]
    if not lines:
        return []
    out: List[Dict[str, Any]] = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            if not out and line.strip().startswith("{"):
                obj = json.loads(line)
                msg = obj.get("error") or obj.get("message") or obj.get("detail") or line
                raise ValueError(msg if isinstance(msg, str) else json.dumps(msg)) from None
            raise
    return out


def _influx_v3_query_sql(origin: str, token: str, database: str, sql: str, timeout_sec: float) -> List[Dict[str, Any]]:
    url = f"{origin.rstrip('/')}/api/v3/query_sql"
    payload = json.dumps({"db": database, "q": sql, "format": "jsonl"})
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }
    last_err: Optional[Exception] = None
    for attempt in (1, 2):
        try:
            r = requests.post(url, data=payload.encode("utf-8"), headers=headers, timeout=timeout_sec)
            if r.status_code == 504 and attempt == 1:
                log_warning(
                    "[InfluxDB v3] Gateway timeout (504); retrying once in 3s..."
                )
                time_module.sleep(3)
                continue
            if r.status_code >= 400:
                raise RuntimeError(
                    f"InfluxDB v3 query_sql HTTP {r.status_code}: {r.text[:800]}"
                )
            return _influx_v3_parse_jsonl(r.text)
        except requests.Timeout as e:
            last_err = e
            if attempt == 1:
                log_warning("[InfluxDB v3] Request timeout; retrying once in 3s...")
                time_module.sleep(3)
                continue
            raise
    if last_err:
        raise last_err
    return []


def _influx_v3_normalize_row(record: Dict[str, Any], _idx: int) -> Dict[str, Any]:
    result = dict(record)
    meta_keys = {"_time", "time", "ts", "result", "table", "boat", "level"}
    for key in list(result.keys()):
        if key in meta_keys:
            continue
        if key in ("LATITUDE_GPS_unk", "LONGITUDE_GPS_unk"):
            val = result[key]
            if isinstance(val, (int, float)) and val is not None and not (isinstance(val, float) and (val != val)):
                result[key] = float(val) / 10000000.0
    time_raw = result.get("time") or result.get("_time")
    if time_raw is not None:
        if isinstance(time_raw, (int, float)):
            ts = float(time_raw)
            if ts > 1e12:
                ts = round(ts / 1000.0, 3)
            elif ts > 1e10:
                ts = round(ts / 1e9, 3)
            else:
                ts = round(ts, 3)
        else:
            d = pd.to_datetime(time_raw, utc=True)
            ts = round(d.timestamp(), 3)
        result["ts"] = ts
        result.pop("time", None)
        result.pop("_time", None)
    return result


def _influx_v3_raw_rows_to_dataframe(raw_results: List[Dict[str, Any]], measurements: List[str]) -> pd.DataFrame:
    if not raw_results:
        return pd.DataFrame()
    normalized = [_influx_v3_normalize_row(dict(r), i) for i, r in enumerate(raw_results)]
    df = pd.DataFrame(normalized)
    if "ts" not in df.columns:
        log_error("[InfluxDB v3] No time/ts in query results")
        return pd.DataFrame()
    drop_cols = [c for c in ("boat", "level", "result", "table") if c in df.columns]
    if drop_cols:
        df = df.drop(columns=drop_cols, errors="ignore")
    min_valid_ts = datetime(2020, 1, 1).timestamp()
    max_valid_ts = datetime.now().timestamp() + (365 * 24 * 3600)
    if len(df) > 0:
        mn = float(df["ts"].min())
        mx = float(df["ts"].max())
        if mn < min_valid_ts or mx > max_valid_ts:
            log_error(
                f"[InfluxDB v3] Invalid timestamp range: {mn} to {mx}"
            )
            return pd.DataFrame()
    df["ts"] = df["ts"].round(3).astype("float64")
    df.sort_values(by=["ts"], inplace=True, ascending=True)
    for m in measurements:
        if m not in df.columns:
            df[m] = np.nan
    return df


def _build_influx_v3_time_ranges_hour_aligned(chunk_start_ts: float, chunk_end_ts: float) -> List[Tuple[float, float]]:
    ranges: List[Tuple[float, float]] = []
    current_start = chunk_start_ts
    while current_start < chunk_end_ts:
        current_dt = datetime.fromtimestamp(current_start, tz=tz.tzutc())
        if current_dt.minute != 0 or current_dt.second != 0 or current_dt.microsecond != 0:
            next_hour = current_dt.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
            current_end = min(next_hour.timestamp(), chunk_end_ts)
        else:
            next_hour = current_dt + timedelta(hours=1)
            current_end = min(next_hour.timestamp(), chunk_end_ts)
        ranges.append((current_start, current_end))
        current_start = current_end
    return ranges


def _build_influx_v3_time_ranges_fixed_hour_slices(start_ts_num: float, end_ts_num: float) -> List[Tuple[float, float]]:
    ranges: List[Tuple[float, float]] = []
    current_start = start_ts_num
    chunk_size = 3600
    while current_start < end_ts_num:
        current_end = min(current_start + chunk_size, end_ts_num)
        ranges.append((current_start, current_end))
        current_start = current_end
    return ranges


def _fetch_influx_v3_dataframe(
    formatted_date: str,
    boat: str,
    level: str,
    measurements: List[str],
    eff_start: Optional[float],
    eff_end: Optional[float],
    had_explicit_range: bool,
) -> Tuple[pd.DataFrame, str, str]:
    """Returns (df, start_time_desc, stop_time_desc) for logging."""
    token = _normalize_influx_token(os.getenv("INFLUX_TOKEN"))
    influx_host = os.getenv("INFLUX_HOST")
    influx_database = os.getenv("INFLUX_DATABASE")
    if not token or not influx_host or not influx_database:
        log_error("[InfluxDB v3] INFLUX_TOKEN, INFLUX_HOST, INFLUX_DATABASE required")
        return pd.DataFrame(), "(n/a)", "(n/a)"
    origin = _influx_v3_origin_from_host(influx_host)
    try:
        timeout_ms = int(os.getenv("INFLUX_TIMEOUT_MS") or "120000")
    except ValueError:
        timeout_ms = 120000
    timeout_sec = max(1.0, timeout_ms / 1000.0)

    utc_day_start = datetime.strptime(f"{formatted_date} 00:00:00", "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz.tzutc()).timestamp()
    utc_day_end = datetime.strptime(f"{formatted_date} 23:59:59", "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz.tzutc()).timestamp()

    start_ts_num: float
    end_ts_num: float
    if eff_start is not None and eff_end is not None:
        start_ts_num = float(eff_start)
        end_ts_num = float(eff_end)
    else:
        start_ts_num = utc_day_start
        end_ts_num = utc_day_end

    CHUNK_THRESHOLD_SECONDS = 900
    MEASUREMENT_CHUNK_THRESHOLD = 50
    BATCH_SIZE = 30
    try:
        query_limit = max(10000, int(os.getenv("INFLUX_QUERY_LIMIT") or "500000"))
    except ValueError:
        query_limit = 500000
    try:
        chunk_concurrency_raw = int(os.getenv("INFLUX_CHUNK_CONCURRENCY") or "2")
    except ValueError:
        chunk_concurrency_raw = 2
    chunk_concurrency = max(1, min(5, chunk_concurrency_raw))

    use_chunking = (not had_explicit_range) or (end_ts_num - start_ts_num > CHUNK_THRESHOLD_SECONDS)
    use_measurement_chunking = len(measurements) > MEASUREMENT_CHUNK_THRESHOLD

    start_time_log = "(n/a)"
    stop_time_log = "(n/a)"
    raw_results: List[Dict[str, Any]] = []

    def build_select_cols(batch: List[str]) -> str:
        parts = ["time"] + [_influx_v3_sql_quote_ident(m) for m in batch]
        return ", ".join(parts)

    if use_chunking or use_measurement_chunking:
        chunk_start_ts: Optional[float] = None
        chunk_end_ts: Optional[float] = None
        if use_chunking:
            chunk_start_ts = start_ts_num
            chunk_end_ts = end_ts_num
        measurement_batches: List[List[str]] = []
        if use_measurement_chunking:
            for i in range(0, len(measurements), BATCH_SIZE):
                measurement_batches.append(measurements[i : i + BATCH_SIZE])
            log_info(
                f"[InfluxDB v3] Split {len(measurements)} measurements into {len(measurement_batches)} batches"
            )
        else:
            measurement_batches = [measurements]

        time_ranges: List[Tuple[float, float]] = []
        if use_chunking and chunk_start_ts is not None and chunk_end_ts is not None:
            time_ranges = _build_influx_v3_time_ranges_hour_aligned(chunk_start_ts, chunk_end_ts)
            log_info(
                f"[InfluxDB v3] Time chunking: {len(time_ranges)} hour-aligned segment(s)"
            )
        else:
            time_ranges = _build_influx_v3_time_ranges_fixed_hour_slices(start_ts_num, end_ts_num)

        chunk_jobs: List[Tuple[Tuple[float, float], List[str]]] = []
        for tr in time_ranges:
            for mb in measurement_batches:
                chunk_jobs.append((tr, mb))

        log_info(
            f"[InfluxDB v3] Executing {len(chunk_jobs)} chunk query(ies) with concurrency {chunk_concurrency}"
        )

        def run_one_chunk(job: Tuple[Tuple[float, float], List[str]]) -> List[Dict[str, Any]]:
            (t0, t1), batch = job
            time_pred = _influx_v3_sql_time_chunk_predicate(t0, t1, end_ts_num)
            cols = build_select_cols(batch)
            chunk_sql = (
                f"SELECT {cols} FROM {IOX_TABLE}\n"
                f"WHERE {time_pred}\n"
                f"  AND boat = {_influx_v3_sql_string_literal(boat)} AND level = {_influx_v3_sql_string_literal(level)}\n"
                f"ORDER BY time\n"
                f"LIMIT {query_limit}"
            )
            try:
                return _influx_v3_query_sql(origin, token, influx_database, chunk_sql, timeout_sec)
            except Exception as e:
                log_error(f"[InfluxDB v3] Chunk query failed: {e}", e)
                return []

        chunk_results: List[List[Dict[str, Any]]] = [[] for _ in chunk_jobs]
        with ThreadPoolExecutor(max_workers=min(chunk_concurrency, max(1, len(chunk_jobs)))) as ex:
            futures = {ex.submit(run_one_chunk, job): idx for idx, job in enumerate(chunk_jobs)}
            for fut in as_completed(futures):
                idx = futures[fut]
                try:
                    chunk_results[idx] = fut.result()
                except Exception as e:
                    log_error(f"[InfluxDB v3] Chunk worker error: {e}", e)
                    chunk_results[idx] = []

        truncated = sum(1 for r in chunk_results if len(r) >= query_limit)
        if truncated:
            log_warning(
                f"[InfluxDB v3] {truncated} chunk(s) hit row limit ({query_limit}); result may be truncated"
            )

        for r in chunk_results:
            raw_results.extend(r)

        seen_ts = set()
        deduped: List[Dict[str, Any]] = []
        for rec in raw_results:
            tr = rec.get("time") or rec.get("_time") or rec.get("ts")
            key = str(tr) if tr is not None else None
            if key and key in seen_ts:
                continue
            if key:
                seen_ts.add(key)
            deduped.append(rec)
        raw_results = deduped
        start_time_log = f"chunked({start_ts_num}..{end_ts_num})"
        stop_time_log = "(chunked)"
    else:
        start_iso = datetime.fromtimestamp(start_ts_num, tz=tz.tzutc()).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        stop_iso = datetime.fromtimestamp(end_ts_num, tz=tz.tzutc()).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        start_time_log = start_iso
        stop_time_log = stop_iso
        cols = build_select_cols(measurements)
        sql_query = (
            f"SELECT {cols} FROM {IOX_TABLE}\n"
            f"WHERE time >= {_influx_v3_sql_string_literal(start_iso)} AND time <= {_influx_v3_sql_string_literal(stop_iso)}\n"
            f"  AND boat = {_influx_v3_sql_string_literal(boat)} AND level = {_influx_v3_sql_string_literal(level)}\n"
            f"ORDER BY time\n"
            f"LIMIT {query_limit}"
        )
        log_info(
            f"[InfluxDB v3] SQL: db={influx_database}, boat={boat}, date={formatted_date}, level={level}, "
            f"measurements={len(measurements)}, range={start_iso} to {stop_iso}"
        )
        try:
            raw_results = _influx_v3_query_sql(origin, token, influx_database, sql_query, timeout_sec)
        except Exception as e:
            log_error(f"[InfluxDB v3] Query failed: {e}", e)
            raw_results = []
        if len(raw_results) >= query_limit:
            log_warning(
                f"[InfluxDB v3] Single query hit row limit ({query_limit}); result may be truncated"
            )

    df = _influx_v3_raw_rows_to_dataframe(raw_results, measurements)
    return df, start_time_log, stop_time_log


def _get_channel_values_influx_v2(
    date: str,
    source_name: str,
    level: str,
    eff_start: Optional[float],
    eff_end: Optional[float],
    formatted_date: str,
    measurements: List[str],
) -> Tuple[pd.DataFrame, str, str, str, str, str, str]:
    """
    Flux (Influx 2) fetch. Returns (df, boat, start_time_log, stop_time_log, influx_host, influx_database, influx_bucket).
    """
    dff = pd.DataFrame()
    influx_token = os.getenv("INFLUX_TOKEN")
    influx_host = os.getenv("INFLUX_HOST")
    influx_database = os.getenv("INFLUX_DATABASE")
    influx_bucket = os.getenv("INFLUX_BUCKET")

    print(
        f"[InfluxDB] Checking environment variables: HOST={'OK' if influx_host else 'MISSING'}, "
        f"TOKEN={'OK' if influx_token else 'MISSING'}, DATABASE={'OK' if influx_database else 'MISSING'}, "
        f"BUCKET={'OK' if influx_bucket else 'MISSING'}",
        flush=True,
    )

    if not influx_token:
        print(f"[InfluxDB] Debug: NODE_ENV={os.getenv('NODE_ENV')}, project_root={project_root}", flush=True)
        print(f"[InfluxDB] Debug: Looking for .env files at: {base_env_path}, {local_env_path}", flush=True)
        if local_env_path.exists():
            print(f"[InfluxDB] Debug: .env.production.local file exists at {local_env_path}", flush=True)
        else:
            print(f"[InfluxDB] Debug: .env.production.local file NOT FOUND at {local_env_path}", flush=True)
            print(
                "[InfluxDB] Debug: In Docker, docker-compose should set env vars from .env.production.local",
                flush=True,
            )
            print("[InfluxDB] Debug: Check if docker-compose is loading the file correctly", flush=True)

    if not influx_token:
        error_msg = f"INFLUX_TOKEN environment variable is not set. Query parameters: date={date}, source_name={source_name}"
        print(f"ERROR: {error_msg}", flush=True)
        log_error(error_msg)
        return dff, "", "(n/a)", "(n/a)", "", "", ""
    if not influx_host:
        error_msg = f"INFLUX_HOST environment variable is not set. Query parameters: date={date}, source_name={source_name}"
        print(f"ERROR: {error_msg}", flush=True)
        log_error(error_msg)
        return dff, "", "(n/a)", "(n/a)", "", "", ""
    if not influx_database:
        error_msg = f"INFLUX_DATABASE environment variable is not set. Query parameters: date={date}, source_name={source_name}"
        print(f"ERROR: {error_msg}", flush=True)
        log_error(error_msg)
        return dff, "", "(n/a)", "(n/a)", "", "", ""
    if not influx_bucket:
        error_msg = f"INFLUX_BUCKET environment variable is not set. Query parameters: date={date}, source_name={source_name}"
        print(f"ERROR: {error_msg}", flush=True)
        log_error(error_msg)
        return dff, "", "(n/a)", "(n/a)", "", "", ""

    if not influx_host.startswith(("http://", "https://")):
        influx_url = f"http://{influx_host}"
    else:
        influx_url = influx_host

    boat = str(source_name)
    try:
        timeout_ms = int(os.getenv("INFLUX_TIMEOUT_MS") or "120000")
    except ValueError:
        timeout_ms = 120000
    client = InfluxDBClient(
        url=influx_url, token=influx_token, org=influx_database, timeout=timeout_ms
    )
    query_api = client.query_api()

    CHUNK_THRESHOLD_SECONDS = 900
    use_chunking = False
    chunk_start_ts: Optional[float] = None
    chunk_end_ts: Optional[float] = None
    start_time = "(n/a)"
    stop_time = "(n/a)"

    if eff_start is not None and eff_end is not None:
        time_range = eff_end - eff_start
        if time_range > CHUNK_THRESHOLD_SECONDS:
            use_chunking = True
            chunk_start_ts = eff_start
            chunk_end_ts = eff_end
            print(
                f"[InfluxDB] Time range {time_range}s ({time_range/60:.1f} minutes) exceeds "
                f"{CHUNK_THRESHOLD_SECONDS}s threshold. Splitting into 1-hour chunks aligned to hour boundaries.",
                flush=True,
            )
            log_warning(
                f"[InfluxDB] Chunking query: {time_range}s range split into 1-hour chunks"
            )

    if use_chunking and chunk_start_ts is not None and chunk_end_ts is not None:
        chunk_dfs: List[pd.DataFrame] = []
        current_start = chunk_start_ts
        while current_start < chunk_end_ts:
            current_dt = datetime.fromtimestamp(current_start, tz=tz.tzutc())
            if current_dt.minute != 0 or current_dt.second != 0 or current_dt.microsecond != 0:
                next_hour = current_dt.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
                current_end = min(next_hour.timestamp(), chunk_end_ts)
            else:
                next_hour = current_dt + timedelta(hours=1)
                current_end = min(next_hour.timestamp(), chunk_end_ts)
            chunk_start_time = datetime.fromtimestamp(current_start, tz=tz.tzutc()).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
            chunk_stop_time = datetime.fromtimestamp(current_end, tz=tz.tzutc()).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
            chunk_df = _execute_influx_query_chunk(
                query_api,
                influx_bucket,
                influx_database,
                boat,
                formatted_date,
                measurements,
                level,
                chunk_start_time,
                chunk_stop_time,
            )
            if chunk_df is not None and not chunk_df.empty:
                chunk_dfs.append(chunk_df)
                print(
                    f"[InfluxDB] Chunk {current_start} to {current_end}: retrieved {len(chunk_df)} rows",
                    flush=True,
                )
            current_start = current_end
        if len(chunk_dfs) > 0:
            df = pd.concat(chunk_dfs, ignore_index=True)
            df = df.drop_duplicates(subset=["ts"], keep="first")
            df.sort_values(by=["ts"], inplace=True, ascending=True)
            print(f"[InfluxDB] Merged {len(chunk_dfs)} chunks into {len(df)} total rows", flush=True)
        else:
            df = pd.DataFrame()
    else:
        if eff_start is not None and eff_end is not None:
            start_time = datetime.fromtimestamp(eff_start, tz=tz.tzutc()).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
            stop_time = datetime.fromtimestamp(eff_end, tz=tz.tzutc()).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        else:
            start_time = f"{formatted_date}T00:00:00Z"
            stop_time = f"{formatted_date}T23:59:59Z"
        df = _execute_influx_query_chunk(
            query_api,
            influx_bucket,
            influx_database,
            boat,
            formatted_date,
            measurements,
            level,
            start_time,
            stop_time,
        )

    if use_chunking and chunk_start_ts is not None and chunk_end_ts is not None:
        start_time = f"chunked({chunk_start_ts}..{chunk_end_ts})"
        stop_time = "(chunked)"

    client.close()
    return df, boat, start_time, stop_time, influx_host, influx_database, influx_bucket


def get_dataset_timezone_for_date(
    api_token: str, class_name: str, project_id: str, date: str
) -> Optional[str]:
    """
    Resolve IANA timezone for a dataset calendar date via app API
    GET /api/datasets/date/timezone (same source as RaceSight frontend).

    Args:
        api_token: Bearer token for app API
        class_name: Schema/class (e.g. ac40)
        project_id: Project id
        date: YYYYMMDD or YYYY-MM-DD

    Returns:
        Timezone string (e.g. Europe/Madrid) or None if not found / error
    """
    if not api_token or not class_name or not project_id or not date:
        return None
    date_clean = str(date).replace("-", "").replace("/", "")
    if len(date_clean) != 8 or not date_clean.isdigit():
        return None
    try:
        from urllib.parse import urlencode

        query = urlencode(
            {
                "class_name": str(class_name).strip(),
                "project_id": str(project_id).strip(),
                "date": date_clean,
            }
        )
        result = get_api_data(api_token, f":8069/api/datasets/date/timezone?{query}")
        if not result or not result.get("success"):
            return None
        data = result.get("data")
        if not data or not isinstance(data, dict):
            return None
        tz = data.get("timezone")
        if tz is not None and str(tz).strip():
            return str(tz).strip()
    except Exception as e:
        log_warning(f"get_dataset_timezone_for_date failed: {e}")
    return None


def _timezone_for_influx_day_range(
    timezone: Optional[str],
    start_ts: Optional[float],
    end_ts: Optional[float],
    api_token: str,
    class_name: str,
    project_id: str,
    date_yyyymmdd: str,
) -> Optional[str]:
    """
    IANA timezone to interpret ``date_yyyymmdd`` as a local calendar day for Influx ``range()``.
    If ``start_ts``/``end_ts`` are set, returns ``timezone`` unchanged (window is explicit).
    If ``timezone`` is set and not UTC, returns it. Otherwise tries ``get_dataset_timezone_for_date``.
    """
    if start_ts is not None or end_ts is not None:
        return timezone
    if timezone and str(timezone).strip() and str(timezone).upper() != "UTC":
        return str(timezone).strip()
    resolved = get_dataset_timezone_for_date(api_token, class_name, project_id, date_yyyymmdd)
    if resolved:
        log_info(f"[get_channel_values] Dataset timezone for Influx day range: {resolved}")
        return resolved
    return timezone


def get_channel_values_influx(
    date: str,
    source_name: str,
    channel_list: List[Dict[str, str]],
    rs: str = '1s',
    start_ts: Optional[float] = None,
    end_ts: Optional[float] = None,
    timezone: Optional[str] = None,
    level: str = 'strm',
    skipMissing: bool = True,
    influx_version: Optional[Literal["2", "3"]] = None,
) -> pd.DataFrame:
    """
    Retrieves channel data from InfluxDB (v3 SQL API by default, or v2 Flux when requested).

    Args:
        date: Date in YYYYMMDD format (local calendar day when using implicit day range)
        source_name: Source name (maps to 'boat' in InfluxDB)
        channel_list: List of channel dictionaries with 'name' and 'type' keys
        rs: Resampling frequency (e.g., '1s', '100ms'). Defaults to '1s' if not provided.
        start_ts: Optional start timestamp in seconds
        end_ts: Optional end timestamp in seconds
        timezone: For implicit full-day query: non-UTC defines local midnight–end-of-day converted to UTC
            for Flux; None or UTC uses UTC calendar day (with warning). Also used for ``Datetime`` tz_convert.
        level: Data level filter ('strm' or 'log'). Defaults to 'strm'.
        skipMissing: If True (default), skip channels with no data. If False, include missing channels filled with np.nan.
        influx_version: ``'2'`` (Flux + bucket) or ``'3'`` (HTTP SQL). If omitted, uses env ``INFLUX_QUERY_VERSION`` (default ``3``).

    Returns:
        DataFrame with channel data
    """
    try:
        ver = _resolve_influx_query_version(influx_version)
    except ValueError as e:
        log_error(str(e))
        return pd.DataFrame()

    if not rs or (isinstance(rs, str) and rs.strip() == ''):
        rs = '1s'

    dff = pd.DataFrame()

    date_str = str(date)
    if len(date_str) != 8 or not date_str.isdigit():
        log_error(f"Invalid date format: {date_str}. Expected YYYYMMDD format.")
        return dff
    formatted_date = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"

    measurements = [
        ch["name"]
        for ch in channel_list
        if ch.get("name") and ch["name"] not in ("ts", "Datetime")
    ]
    if len(measurements) == 0:
        log_warning("No measurements to query (only 'ts' / 'Datetime' in channel_list)")
        return dff

    had_explicit_range = start_ts is not None and end_ts is not None
    eff_start: Optional[float] = start_ts
    eff_end: Optional[float] = end_ts

    if not had_explicit_range:
        if eff_start is None and eff_end is None:
            influx_day_tz: Optional[str] = None
            if timezone and str(timezone).strip() and str(timezone).upper() != "UTC":
                influx_day_tz = str(timezone).strip()
            if influx_day_tz:
                try:
                    tz_info = gettz(influx_day_tz)
                    if tz_info is not None:
                        date_ymd = formatted_date
                        local_start = datetime.strptime(
                            f"{date_ymd} 00:00:00", "%Y-%m-%d %H:%M:%S"
                        ).replace(tzinfo=tz_info)
                        local_end = datetime.strptime(
                            f"{date_ymd} 23:59:59", "%Y-%m-%d %H:%M:%S"
                        ).replace(tzinfo=tz_info)
                        eff_start = local_start.astimezone(tz.tzutc()).timestamp()
                        eff_end = local_end.astimezone(tz.tzutc()).timestamp()
                    else:
                        log_warning(
                            f"Unknown timezone '{influx_day_tz}' for Influx day range; using UTC calendar day"
                        )
                except Exception as tz_err:
                    log_warning(
                        f"Could not build local day range for '{influx_day_tz}': {tz_err}; using UTC calendar day"
                    )
                    eff_start = None
                    eff_end = None
            if eff_start is None and eff_end is None:
                log_warning(
                    "[InfluxDB] Using UTC calendar day for range (pass a non-UTC IANA timezone for local day)"
                )

    try:
        influx_host = ""
        influx_database = ""
        influx_bucket = ""
        boat = str(source_name)

        if ver == "2":
            df, boat, start_time, stop_time, influx_host, influx_database, influx_bucket = _get_channel_values_influx_v2(
                date,
                source_name,
                level,
                eff_start,
                eff_end,
                formatted_date,
                measurements,
            )
        else:
            df, start_time, stop_time = _fetch_influx_v3_dataframe(
                formatted_date,
                boat,
                level,
                measurements,
                eff_start,
                eff_end,
                had_explicit_range,
            )
            influx_host = os.getenv("INFLUX_HOST") or ""
            influx_database = os.getenv("INFLUX_DATABASE") or ""
            influx_bucket = "(Influx v3 — no bucket)"

        boat_log = boat or str(source_name)

        if df is not None and not df.empty:
            # Dataset size check
            if len(df) > 10000000:
                log_error(f"Large dataset detected: {len(df)} rows. May cause memory issues.")
                return dff
            
            # Process each channel individually: remove NaNs, resample, then merge
            processed_channels = []
            base_column = 'ts'  # Use ts as the primary time reference
            
            # Get string columns (these need special handling - forward/backward fill, not resampled)
            string_cols = [ch['name'] for ch in channel_list if normalize_channel_type(ch.get('type', '')) == 'string' and ch['name'] in df.columns]
            
            # Process string columns separately (forward/backward fill, no resampling)
            if len(string_cols) > 0:
                string_df = df[[base_column] + string_cols].copy()
                for col in string_cols:
                    # Forward fill then backward fill to preserve metadata continuity
                    string_df[col] = string_df[col].ffill().bfill()
                    # Replace 'nan', 'None', 'NaN', '<NA>' strings with empty string
                    string_df[col] = string_df[col].replace(['nan', 'None', 'NaN', '<NA>'], '')
                processed_channels.append(string_df)
            
            # Process each numeric channel individually
            for ch in channel_list:
                channel_name = ch['name']
                channel_type = normalize_channel_type(ch.get('type', ''))
                
                # Skip if not in dataframe or if it's a string column (already processed) or if it's ts
                if channel_name not in df.columns or channel_name in string_cols or channel_name == base_column:
                    continue
                
                # Create a dataframe with just ts and this channel
                channel_df = df[[base_column, channel_name]].copy()
                
                # Remove NaN values for this channel
                channel_df = channel_df.dropna(subset=[channel_name])
                
                # Skip if no data left after removing NaNs
                if len(channel_df) == 0:
                    continue
                
                # Type enforcement before resampling
                if channel_type == 'float':
                    channel_df[channel_name] = pd.to_numeric(channel_df[channel_name], errors='coerce').astype('float64')
                elif channel_type == 'int':
                    if pd.api.types.is_float_dtype(channel_df[channel_name]):
                        channel_df[channel_name] = channel_df[channel_name].round().fillna(0).astype('int64')
                    else:
                        channel_df[channel_name] = pd.to_numeric(channel_df[channel_name], errors='coerce').round().fillna(0).astype('int64')
                
                # Set ts as index for resampling
                channel_df.set_index(base_column, inplace=True)
                
                # Resample this channel using pandas resample_dataframe
                if rs and isinstance(rs, str) and len(rs.strip()) > 0:
                    # Create a single-channel channel_list for resampling
                    single_channel_list = [{'name': channel_name, 'type': ch.get('type', '')}]
                    channel_df_resampled = resample_dataframe(channel_df, single_channel_list, rs)
                else:
                    # No resampling needed, just reset index
                    channel_df_resampled = channel_df.reset_index()
                    channel_df_resampled.set_index(base_column, inplace=True)
                
                # Reset index to get ts back as column
                channel_df_resampled = channel_df_resampled.reset_index()
                
                # Store processed channel (only ts and the channel column)
                processed_channels.append(channel_df_resampled[[base_column, channel_name]])
            
            # Merge all processed channels together using ts as the key
            if len(processed_channels) > 0:
                # Start with the first channel
                dff = processed_channels[0]
                
                # Merge remaining channels
                for channel_df in processed_channels[1:]:
                    dff = pd.merge(dff, channel_df, on=base_column, how='outer', sort=True)
                
                # Outer-merge gaps: linear-in-time fill for floats; ffill/bfill for ints and edges.
                dff = fill_outer_merge_numeric_gaps(dff, base_column)

                if 'Datetime' not in dff.columns:
                    dff['Datetime'] = pd.to_datetime(dff[base_column], unit='s', utc=True)
                    if timezone:
                        dff['Datetime'] = dff['Datetime'].dt.tz_convert(timezone)
                
                # Replace 'NA' strings with 0 for non-string columns
                non_categorical_cols = [col for col in dff.columns 
                                       if not pd.api.types.is_categorical_dtype(dff[col]) 
                                       and col not in string_cols
                                       and col not in [base_column, 'Datetime']]
                if len(non_categorical_cols) > 0:
                    for col in non_categorical_cols:
                        mask = dff[col] == 'NA'
                        if mask.any():
                            dff.loc[mask, col] = 0
                
                # Infer object types explicitly
                dff = dff.infer_objects(copy=False)
                
                # If skipMissing=False, add missing channels filled with np.nan
                if not skipMissing and len(dff) > 0 and base_column in dff.columns:
                    # Get list of requested channel names (exclude 'ts' and 'Datetime')
                    requested_channels = [ch['name'] for ch in channel_list if ch['name'] not in ['ts', 'Datetime']]
                    missing_channels = [ch for ch in requested_channels if ch not in dff.columns]
                    
                    if len(missing_channels) > 0:
                        for ch in channel_list:
                            channel_name = ch['name']
                            if channel_name in missing_channels:
                                channel_type = normalize_channel_type(ch.get('type', ''))
                                
                                # Create column filled with appropriate NaN values
                                if channel_type == 'string':
                                    # For strings, use empty string or None (pandas will handle as object dtype)
                                    dff[channel_name] = pd.Series([np.nan] * len(dff), dtype=object)
                                elif channel_type == 'int':
                                    # For integers, use nullable int64
                                    dff[channel_name] = pd.Series([np.nan] * len(dff), dtype='Int64')
                                else:
                                    # For floats and other types, use float64 with NaN
                                    dff[channel_name] = pd.Series([np.nan] * len(dff), dtype='float64')
            else:
                # No channels processed, return empty dataframe with ts column
                dff = pd.DataFrame(columns=[base_column])
            
            return dff
        else:
            # Query succeeded but returned no data - log diagnostic info
            warning_msg = (
                f"No data returned from InfluxDB v{ver} query for boat={boat_log}, "
                f"level={level}, date={formatted_date}"
            )
            print(f"WARNING: {warning_msg}", flush=True)
            log_warning(warning_msg)

            if ver == "2":
                query_params = (
                    f"Query parameters: bucket={influx_bucket}, org={influx_database}, "
                    f"time_range={start_time} to {stop_time}, measurements={len(measurements)}"
                )
                conn_info = (
                    f"Connection: host={influx_host}, database={influx_database}, bucket={influx_bucket}"
                )
            else:
                query_params = (
                    f"Query parameters: db={influx_database}, influx=v3, "
                    f"time_range={start_time} to {stop_time}, measurements={len(measurements)}"
                )
                conn_info = (
                    f"Connection: host={influx_host}, database={influx_database} (Influx v3)"
                )
            print(f"WARNING: {query_params}", flush=True)
            log_warning(query_params)
            print(f"WARNING: {conn_info}", flush=True)
            log_warning(conn_info)
            
            if df is None:
                none_msg = "Query returned None (possible connection or query syntax error)"
                print(f"WARNING: {none_msg}", flush=True)
                log_warning(none_msg)
            elif df.empty:
                empty_msg = "Query returned empty DataFrame (no data matching criteria)"
                print(f"WARNING: {empty_msg}", flush=True)
                log_warning(empty_msg)
            return dff
            
    except Exception as e:
        log_error(f"Error in get_channel_values_influx: {str(e)}", e)
        return dff

def get_channel_values(
    api_token: str,
    class_name: str,
    project_id: str,
    date: str,
    source_name: str,
    channel_list: List[Dict[str, str]],
    rs: str = '1s',
    start_ts: Optional[float] = None,
    end_ts: Optional[float] = None,
    timezone: Optional[str] = None,
    influx_version: Optional[Literal["2", "3"]] = None,
) -> pd.DataFrame:
    """
    Retrieves channel data from the file server API.
    
    Performs server-side resampling when resolution is provided. Date format is automatically
    normalized to YYYYMMDD (dashes and slashes are removed).
    
    Args:
        api_token: API authentication token
        class_name: Class name
        project_id: Project ID
        date: Date in YYYYMMDD format (dashes/slashes will be automatically removed)
        source_name: Source name
        channel_list: List of channel dictionaries with 'name' and 'type' keys
        rs: Resampling frequency (e.g., '1s', '100ms'). Defaults to '1s' if not provided. Use empty string for full frequency.
        start_ts: Optional start timestamp in seconds
        end_ts: Optional end timestamp in seconds
        timezone: Optional timezone for file-server requests and parquet ``Datetime`` handling.
            For Influx fallbacks with a full-day query (no ``start_ts``/``end_ts``), if this is
            missing or ``UTC``, the dataset timezone is resolved from the app API and passed to Influx
            so the Flux window matches the local calendar date.
        influx_version: ``'2'`` (Flux) or ``'3'`` (SQL API) for Influx fallbacks; default from
            ``INFLUX_QUERY_VERSION`` (defaults to ``3``).

    Returns:
        DataFrame with channel data (already resampled if rs provided)
    """
    # Default to '1s' if rs is empty or None
    if not rs or (isinstance(rs, str) and rs.strip() == ''):
        rs = '1s'
    
    dff = pd.DataFrame()
    try:
        # Ensure project_id is string for API consistency
        project_id = str(project_id)
        class_name = str(class_name)
        # Normalize date format to YYYYMMDD (remove dashes/slashes) for file server API
        date = str(date).replace('-', '').replace('/', '')
        source_name = str(source_name)

        influx_timezone = _timezone_for_influx_day_range(
            timezone, start_ts, end_ts, api_token, class_name, project_id, date
        )

        # Get channel groups from the API
        channel_groups = get_channel_groups(api_token, class_name, project_id, date, source_name, channel_list)
        
        if len(channel_groups) == 0:
            log_error(f"No channel groups returned for class_name={class_name}, project_id={project_id}, date={date}, source_name={source_name}")
            log_error(
                "Check file server: directory must exist with .parquet files at "
                f"System/{project_id}/{str(class_name).lower()}/{date}/{source_name}/ "
                "(see channel-groups / channel-values API and DATA_DIRECTORY)."
            )
            return dff
            
        frames = []

        for group_idx, group in enumerate(channel_groups):
            channels = group.get('channels', [])
    
            if len(channels) > 1:
                group_channels = [ch for ch in channel_list if ch['name'] in channels]

                hasTs = False
                for item in group_channels:
                    if item['name'] == 'ts':
                        hasTs = True
                        break

                # Always add 'ts' if not already present (user-requested channels like 'Datetime' are preserved)
                if not hasTs:
                    input_list = [{"name": 'ts', "type": 'float'}] + group_channels
                else:
                    input_list = group_channels

                url = f"{_get_file_api_url()}/channel-values"
                
                # Normalize timestamps to ensure they're floats (not int or other types)
                start_ts_normalized = float(start_ts) if start_ts is not None else None
                end_ts_normalized = float(end_ts) if end_ts is not None else None
                
                params = {
                    "class_name": class_name,
                    "project_id": project_id,
                    "date": date,
                    "source_name": source_name,
                    "channel_list": input_list,
                    "start_ts": start_ts_normalized,
                    "end_ts": end_ts_normalized,
                }
                
                # Add resolution parameter if provided (file server performs server-side resampling)
                if rs and rs.strip():
                    params["resolution"] = rs.strip()
                
                # Add timezone to params if provided
                if timezone:
                    params["timezone"] = timezone

                response = requests.post(
                    url,
                    json=params,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_token}"
                    }
                )

                try:
                    if response.status_code == 200:
                        df = parseBinary(response.content)

                        if df is not None and len(df) > 0:
                            # Use ts directly as index (DuckDB already resampled if resolution provided)
                            if 'ts' in df.columns:
                                # Basic validation: check for valid ts values
                                if df['ts'].isna().all():
                                    log_error("All ts values are invalid")
                                    continue
                            else:
                                log_error("'ts' column not found in dataframe")
                                continue
                            
                            # Dataset size check
                            if len(df) > 10000000:
                                log_error(f"Large dataset detected: {len(df)} rows. May cause memory issues.")
                                continue
                            
                            # Remove duplicate timestamps before setting index
                            # This can happen when merging results from multiple files
                            if 'ts' in df.columns:
                                # Drop duplicates on ts, keeping first occurrence
                                df = df.drop_duplicates(subset=['ts'], keep='first')
                            
                            # Set ts as index for merging (no resampling needed - DuckDB handled it)
                            df.set_index('ts', inplace=True)
                            
                            # Only append non-empty dataframes
                            if len(df) > 0:
                                frames.append(df)
                    elif response.status_code == 204:
                        # 204 is a valid response meaning "no content", continue to next group
                        continue
                    else:
                        log_error(f"Channel values API returned status {response.status_code}: {response.text[:200]}")
                except Exception as e:
                    log_error(f"Error processing channel group {group_idx + 1}: {str(e)}")
                    continue
            else:
                # Skip groups with <= 1 channel
                continue

        if len(frames) > 0:
            # Filter out any empty frames that might have slipped through
            non_empty_frames = [f for f in frames if len(f) > 0]
            
            if len(non_empty_frames) == 0:
                return dff
            
            # Merge on ts index (all frames have same ts values from DuckDB resampling)
            dfc = pd.concat(non_empty_frames, axis=1, sort=True, join='outer')
            
            # Remove duplicate columns (keep first occurrence)
            dfc = dfc.loc[:, ~dfc.columns.duplicated(keep='first')]
            
            # Reset index to make ts a column
            dfc = dfc.reset_index()
            
            # Ensure ts is float64 and consistently rounded to 3 decimals
            if 'ts' in dfc.columns:
                dfc['ts'] = dfc['ts'].round(3).astype('float64')
            
            # Create Datetime column from ts at the very end
            if 'ts' in dfc.columns:
                if 'Datetime' in dfc.columns:
                    # Parse Datetime (should be UTC string with Z from file server)
                    try:
                        dfc['Datetime'] = pd.to_datetime(dfc['Datetime'], utc=True, format='ISO8601')
                    except (ValueError, TypeError):
                        # Fallback to mixed if ISO8601 strict parsing fails or format not supported
                        try:
                            dfc['Datetime'] = pd.to_datetime(dfc['Datetime'], utc=True, format='mixed')
                        except (ValueError, TypeError):
                             # Last resort fallback
                            dfc['Datetime'] = pd.to_datetime(dfc['Datetime'], utc=True)

                    # Convert to specified timezone if provided, otherwise keep UTC
                    if timezone:
                        dfc['Datetime'] = dfc['Datetime'].dt.tz_convert(timezone)
                    # If no timezone specified, keep as UTC (already timezone-aware)
                else:
                    # Create from ts - ts is in UTC seconds
                    dfc['Datetime'] = pd.to_datetime(dfc['ts'], unit='s', utc=True)
                    # Convert to specified timezone if provided, otherwise keep UTC
                    if timezone:
                        dfc['Datetime'] = dfc['Datetime'].dt.tz_convert(timezone)
                    # If no timezone specified, keep as UTC (already timezone-aware)

            # Type enforcement for columns (DuckDB may have different types)
            for ch in channel_list:
                channel_name = ch['name']
                channel_type = normalize_channel_type(ch['type'])

                if channel_name in dfc.columns:
                    # Post-processing type adjustments
                    if channel_type == 'float':
                        if not pd.api.types.is_float_dtype(dfc[channel_name]) or str(dfc[channel_name].dtype) == 'Float64':
                            dfc[channel_name] = pd.to_numeric(dfc[channel_name], errors='coerce').astype('float64')
                    elif channel_type == 'int':
                        if pd.api.types.is_float_dtype(dfc[channel_name]):
                            dfc[channel_name] = dfc[channel_name].round().fillna(0).astype('int64')
                    elif channel_type == 'string':
                        if not pd.api.types.is_string_dtype(dfc[channel_name]) and not pd.api.types.is_object_dtype(dfc[channel_name]):
                            dfc[channel_name] = dfc[channel_name].astype(str)
                        dfc[channel_name] = dfc[channel_name].replace(['nan', 'None', 'NaN', '<NA>'], '')

            # Outer-merge / NULL buckets: time-linear interpolation for floats; ffill/bfill for ints and edges.
            if 'ts' in dfc.columns and len(dfc) > 0:
                dfc = fill_outer_merge_numeric_gaps(dfc, "ts")

            # Forward fill and backward fill NaN values for string columns to preserve metadata continuity
            string_cols = [ch['name'] for ch in channel_list if normalize_channel_type(ch.get('type', '')) == 'string' and ch['name'] in dfc.columns]
            if len(string_cols) > 0:
                for col in string_cols:
                    # Forward fill (use previous valid value) then backward fill (use next valid value)
                    # This ensures string metadata is preserved across all rows
                    dfc[col] = dfc[col].ffill().bfill()
            
            # Replace 'NA' strings with 0, avoiding categorical and string columns
            non_categorical_cols = [col for col in dfc.columns 
                                   if not pd.api.types.is_categorical_dtype(dfc[col]) 
                                   and col not in string_cols]
            if len(non_categorical_cols) > 0:
                for col in non_categorical_cols:
                    # Use mask to directly replace 'NA' strings with 0 (no FutureWarning)
                    mask = dfc[col] == 'NA'
                    if mask.any():
                        dfc.loc[mask, col] = 0
            
            # Infer object types explicitly
            dfc = dfc.infer_objects(copy=False)

            # Check for missing channels and try to get them from InfluxDB
            # Get list of requested channel names (exclude 'ts' and 'Datetime')
            requested_channels = [ch['name'] for ch in channel_list if ch['name'] not in ['ts', 'Datetime']]
            missing_channel_names = [ch for ch in requested_channels if ch not in dfc.columns]
            
            if len(missing_channel_names) > 0:
                log_info(f"Channels not found in file system: {missing_channel_names}. Attempting to retrieve from InfluxDB.")
                
                # Build channel list for missing channels
                missing_channel_list = [ch for ch in channel_list if ch['name'] in missing_channel_names]
                
                # Try to get missing channels from InfluxDB
                try:
                    influx_df = get_channel_values_influx(
                        date=date,
                        source_name=source_name,
                        channel_list=missing_channel_list,
                        rs=rs,
                        start_ts=start_ts,
                        end_ts=end_ts,
                        timezone=influx_timezone,
                        level='strm',  # Use 'strm' level by default
                        influx_version=influx_version,
                    )
                    
                    if influx_df is not None and not influx_df.empty and 'ts' in influx_df.columns:
                        log_info(f"Retrieved {len([col for col in influx_df.columns if col not in ['ts', 'Datetime']])} channels from InfluxDB")
                        
                        # Merge InfluxDB data with file system data on 'ts'
                        # Set ts as index for both dataframes
                        if 'ts' in dfc.columns:
                            dfc.set_index('ts', inplace=True)
                        if 'ts' in influx_df.columns:
                            influx_df.set_index('ts', inplace=True)
                        
                        # Merge on ts index (outer join to keep all timestamps)
                        dfc = pd.concat([dfc, influx_df], axis=1, sort=True, join='outer')
                        
                        # Remove duplicate columns (keep first occurrence - file system takes precedence)
                        dfc = dfc.loc[:, ~dfc.columns.duplicated(keep='first')]
                        
                        # Reset index to make ts a column again
                        dfc = dfc.reset_index()
                        
                        if 'ts' in dfc.columns and len(dfc) > 0:
                            dfc = fill_outer_merge_numeric_gaps(dfc, "ts")
                        
                        # Update missing channels list to only include channels still missing after InfluxDB
                        missing_channel_names = [ch for ch in missing_channel_names if ch not in dfc.columns]
                    else:
                        log_warning(f"No data retrieved from InfluxDB for missing channels: {missing_channel_names}")
                        
                except Exception as e:
                    log_error(f"Error retrieving missing channels from InfluxDB: {str(e)}", e)

            dff = dfc

            return dff

        # No data from file system - try to get all channels from InfluxDB
        log_warning(f"No data from file system for date={date}, source={source_name}. Attempting to retrieve from InfluxDB.")
        
        try:
            influx_df = get_channel_values_influx(
                date=date,
                source_name=source_name,
                channel_list=channel_list,
                rs=rs,
                start_ts=start_ts,
                end_ts=end_ts,
                timezone=influx_timezone,
                level='strm',  # Use 'strm' level by default
                influx_version=influx_version,
            )
            
            if influx_df is not None and not influx_df.empty:
                log_info(f"Retrieved {len([col for col in influx_df.columns if col not in ['ts', 'Datetime']])} channels from InfluxDB")
                return influx_df
            else:
                log_warning("No data retrieved from InfluxDB either")
                return dff
                
        except Exception as e:
            log_error(f"Error retrieving data from InfluxDB: {str(e)}", e)
            return dff
            
    except requests.exceptions.RequestException as e:
        log_error("Error in get_channel_values", e)
        return dff

def get_api_data(api_token: str, url: str) -> Dict[str, Any]:
    try:
        # Handle legacy port prefixes (:8069, :8059) for backward compatibility
        # Strip port prefix and route to appropriate base URL
        if url.startswith(":8059"):
            base_url = _get_admin_api_url()
            clean_url = url[5:]  # Remove ":8059" prefix
        elif url.startswith(":8069"):
            base_url = _get_app_api_url()
            clean_url = url[5:]  # Remove ":8069" prefix
        else:
            base_url = _get_app_api_url()
            clean_url = url
        
        # With base URL (nginx), admin path is /api/admin/xxx; clean_url is /api/xxx so append clean_url[4:]
        if url.startswith(":8059") and _is_base_url_mode() and clean_url.startswith("/api/"):
            full_url = f"{base_url}{clean_url[4:]}"
        else:
            full_url = f"{base_url}{clean_url}"
        # Use longer timeout for admin server (8059) to avoid ReadTimeout during processing
        timeout = ADMIN_GET_TIMEOUT if url.startswith(":8059") else (120, 120)
        response = requests.get(
            full_url, 
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_token}"
            },
            timeout=timeout
        )

        if not response.text or response.text.strip() == "":
            log_warning(f"Empty response from {full_url}")
            return { "success": False, "message": "Empty response" }
            
        try:
            return response.json()
        except json.JSONDecodeError as e:
            log_error(f"Invalid JSON from {full_url}", e)
            return { "success": False, "message": f"Invalid JSON: {str(e)}" }
            
    except requests.exceptions.RequestException as e:
        log_error(f"Request error for {full_url}", e)
        return { "success": False, "message": str(e) }

def post_api_data(api_token: str, url: str, body: Dict[str, Any]) -> Dict[str, Any]:
    try:
        # Handle legacy port prefixes (:8069, :8059) for backward compatibility
        # Strip port prefix and route to appropriate base URL
        if url.startswith(":8059"):
            base_url = _get_admin_api_url()
            clean_url = url[5:]  # Remove ":8059" prefix
        elif url.startswith(":8069"):
            base_url = _get_app_api_url()
            clean_url = url[5:]  # Remove ":8069" prefix
        else:
            base_url = _get_app_api_url()
            clean_url = url
        
        if url.startswith(":8059") and _is_base_url_mode() and clean_url.startswith("/api/"):
            full_url = f"{base_url}{clean_url[4:]}"
        else:
            full_url = f"{base_url}{clean_url}"
        # Use longer timeout for admin server (8059) so processing script doesn't stall (e.g. DELETE by_event_type, POST events)
        timeout = ADMIN_POST_TIMEOUT if url.startswith(":8059") else (300, 300)
        
        # Convert datetime/Timestamp objects and numpy/pandas types to JSON-serializable formats
        def convert_datetime_to_str(obj):
            """Recursively convert datetime/Timestamp objects and numpy/pandas types to JSON-serializable formats"""
            import datetime as dt
            if isinstance(obj, pd.Timestamp):
                return obj.isoformat()
            elif isinstance(obj, (dt.datetime, dt.date)):
                return obj.isoformat()
            elif isinstance(obj, np.datetime64):
                return pd.Timestamp(obj).isoformat()
            elif isinstance(obj, (np.integer, np.int64, np.int32, np.int16, np.int8)):
                return int(obj)
            elif isinstance(obj, (np.floating, np.float64, np.float32)):
                return float(obj)
            elif isinstance(obj, np.bool_):
                return bool(obj)
            elif isinstance(obj, np.generic):
                # Catch any other numpy scalar types
                return obj.item()  # Convert numpy scalar to Python native type
            elif isinstance(obj, dict):
                return {key: convert_datetime_to_str(value) for key, value in obj.items()}
            elif isinstance(obj, (list, tuple)):
                return [convert_datetime_to_str(item) for item in obj]
            return obj
        
        # Convert any datetime objects in the body to strings
        body_serializable = convert_datetime_to_str(body)
        
        # For very large payloads, use stream=False but allow chunked transfer
        # Calculate approximate payload size
        try:
            payload_size = len(json.dumps(body_serializable, default=str))
            if payload_size > 10 * 1024 * 1024:  # > 10MB
                log_warning(f"Large payload detected: {payload_size / 1024 / 1024:.2f}MB for POST {full_url}")
        except (TypeError, ValueError) as e:
            # If JSON serialization fails, log and continue
            log_warning(f"Could not calculate payload size: {str(e)}")
        
        # For large payloads, send as data instead of json to avoid double-encoding issues
        # This allows the server to receive the raw JSON string properly
        try:
            # Try sending as JSON first (normal case)
            response = requests.post(
                full_url,
                json=body_serializable, 
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_token}"
                },
                timeout=timeout,
                stream=False
            )
        except requests.exceptions.ConnectionError as e:
            # If connection is aborted, try sending as raw data with explicit content-type
            log_warning(f"Connection aborted with json=body, retrying with data=json.dumps(body) for {full_url}")
            response = requests.post(
                full_url,
                data=json.dumps(body_serializable, default=str),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_token}"
                },
                timeout=timeout,
                stream=False
            )  
    
        # Check response status code first
        if response.status_code >= 400:
            error_msg = f"HTTP {response.status_code}: {response.reason}"
            response_text = response.text[:500] if response.text else "(empty)"
            log_error(f"HTTP error from POST {full_url}: {error_msg}. Response: {response_text}")
            # Try to parse error response as JSON, otherwise return status text
            try:
                error_data = response.json()
                return { "success": False, "status": response.status_code, "message": error_data.get("message", error_msg) }
            except:
                return { "success": False, "status": response.status_code, "message": error_msg }
        
        if not response.text or response.text.strip() == "":
            log_warning(f"Empty response from POST {full_url} (status {response.status_code})")
            return { "success": False, "status": response.status_code, "message": "Empty response" }
            
        try:
            return response.json()
        except json.JSONDecodeError as e:
            response_text = response.text[:500] if response.text else "(empty)"
            log_error(f"Invalid JSON from POST {full_url} (status {response.status_code}): {str(e)}. Response: {response_text}")
            return { "success": False, "status": response.status_code, "message": f"Invalid JSON: {str(e)}" }
            
    except requests.exceptions.RequestException as e:
        log_error(f"Request error for POST {full_url}", e)
        return { "success": False, "message": str(e) }


def put_api_data(api_token: str, url: str, body: Dict[str, Any]) -> Dict[str, Any]:
    try:
        # Handle legacy port prefixes (:8069, :8059) for backward compatibility
        # Strip port prefix and route to appropriate base URL
        if url.startswith(":8059"):
            base_url = _get_admin_api_url()
            clean_url = url[5:]  # Remove ":8059" prefix
        elif url.startswith(":8069"):
            base_url = _get_app_api_url()
            clean_url = url[5:]  # Remove ":8069" prefix
        else:
            base_url = _get_app_api_url()
            clean_url = url
        
        if url.startswith(":8059") and _is_base_url_mode() and clean_url.startswith("/api/"):
            full_url = f"{base_url}{clean_url[4:]}"
        else:
            full_url = f"{base_url}{clean_url}"
        # Use longer timeout for admin server (8059) for large updates
        timeout = ADMIN_PUT_TIMEOUT if url.startswith(":8059") else (300, 300)
        
        # Convert datetime/Timestamp objects and numpy/pandas types to JSON-serializable formats
        def convert_datetime_to_str(obj):
            """Recursively convert datetime/Timestamp objects and numpy/pandas types to JSON-serializable formats"""
            import datetime as dt
            if isinstance(obj, pd.Timestamp):
                return obj.isoformat()
            elif isinstance(obj, (dt.datetime, dt.date)):
                return obj.isoformat()
            elif isinstance(obj, np.datetime64):
                return pd.Timestamp(obj).isoformat()
            elif isinstance(obj, (np.integer, np.int64, np.int32, np.int16, np.int8)):
                return int(obj)
            elif isinstance(obj, (np.floating, np.float64, np.float32)):
                return float(obj)
            elif isinstance(obj, np.bool_):
                return bool(obj)
            elif isinstance(obj, np.generic):
                # Catch any other numpy scalar types
                return obj.item()  # Convert numpy scalar to Python native type
            elif isinstance(obj, dict):
                return {key: convert_datetime_to_str(value) for key, value in obj.items()}
            elif isinstance(obj, (list, tuple)):
                return [convert_datetime_to_str(item) for item in obj]
            return obj
        
        # Convert any datetime/numpy objects in the body to JSON-serializable formats
        body_serializable = convert_datetime_to_str(body)
        
        response = requests.put(
            full_url,
            json=body_serializable, 
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_token}"
            },
            timeout=timeout
        )  

        if not response.text or response.text.strip() == "":
            log_warning(f"Empty response from PUT {full_url}")
            return { "success": False, "message": "Empty response" }
            
        try:
            return response.json()
        except json.JSONDecodeError as e:
            log_error(f"Invalid JSON from PUT {full_url}", e)
            return { "success": False, "message": f"Invalid JSON: {str(e)}" }
            
    except requests.exceptions.RequestException as e:
        log_error(f"Request error for PUT {full_url}", e)
        return { "success": False, "message": str(e) }

def delete_api_data(api_token: str, url: str, body: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    try:
        # Handle legacy port prefixes (:8069, :8059) for backward compatibility
        # Strip port prefix and route to appropriate base URL
        if url.startswith(":8059"):
            base_url = _get_admin_api_url()
            clean_url = url[5:]  # Remove ":8059" prefix
        elif url.startswith(":8069"):
            base_url = _get_app_api_url()
            clean_url = url[5:]  # Remove ":8069" prefix
        else:
            base_url = _get_app_api_url()
            clean_url = url
        
        if url.startswith(":8059") and _is_base_url_mode() and clean_url.startswith("/api/"):
            full_url = f"{base_url}{clean_url[4:]}"
        else:
            full_url = f"{base_url}{clean_url}"
        # Use longer timeout for admin server (8059) so processing (e.g. by_event_type) doesn't time out
        timeout = ADMIN_DELETE_TIMEOUT if url.startswith(":8059") else (120, 120)
        response = requests.delete(
            full_url,
            data=json.dumps(body) if body else None,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_token}"
            },
            timeout=timeout
        )  

        if not response.text or response.text.strip() == "":
            log_warning(f"Empty response from DELETE {full_url}")
            return { "success": False, "message": "Empty response" }
            
        try:
            return response.json()
        except json.JSONDecodeError as e:
            log_error(f"Invalid JSON from DELETE {full_url}", e)
            return { "success": False, "message": f"Invalid JSON: {str(e)}" }
            
    except requests.exceptions.RequestException as e:
        log_error(f"Request error for DELETE {full_url}", e)
        return { "success": False, "message": str(e) }

def update_dataset_date_modified(api_token: str, class_name: str, project_id: int, source_id: int = None, source_name: str = None, date: str = None, dataset_id: int = None) -> bool:
    """
    Update dataset date_modified. Can use either dataset_id OR (source_id + date) OR (source_name + date).
    Returns True if successful, False otherwise.
    """
    try:
        # If source_name provided but not source_id, get source_id from source_name
        if source_name and not source_id:
            sources = get_sources(api_token, class_name, project_id, date)
            # Ensure sources is a list and contains dictionaries
            if not isinstance(sources, list):
                log_error(f"update_dataset_date_modified: get_sources returned unexpected type: {type(sources)}")
                return False
            
            matching_source = None
            for s in sources:
                # Check if s is a dictionary before calling .get()
                if isinstance(s, dict):
                    if s.get('source_name') == source_name:
                        matching_source = s
                        break
            
            if matching_source:
                source_id = matching_source.get('source_id')
            else:
                log_error(f"update_dataset_date_modified: Source '{source_name}' not found")
                return False
        
        update_url = ":8059/api/datasets/date-modified"
        update_payload = {
            "class_name": class_name,
            "project_id": project_id
        }
        
        if dataset_id:
            update_payload["dataset_id"] = dataset_id
        elif source_id and date:
            update_payload["source_id"] = source_id
            update_payload["date"] = date
        else:
            log_error("update_dataset_date_modified: Either dataset_id or (source_id/source_name and date) must be provided")
            return False
        
        update_response = put_api_data(api_token, update_url, update_payload)
        # Ensure update_response is a dictionary before calling .get()
        if isinstance(update_response, dict) and update_response.get('success'):
            return True
        else:
            error_msg = update_response.get('message', 'Unknown error') if isinstance(update_response, dict) else str(update_response)
            log_warning(f"Failed to update dataset date_modified: {error_msg}")
            return False
    except Exception as e:
        log_error(f"Error updating dataset date_modified: {str(e)}")
        return False

def log(api_token: str, file_name: str, message_type: str, message: str, context: Any) -> None:
    """
    Fire-and-forget logging function that sends log data asynchronously without waiting for response.
    """
    def _send_log():
        # Nginx routes /api/log to admin; in base-URL mode use base + /api/log/message
        if _is_base_url_mode():
            full_url = f"{_api_base_url_override}/api/log/message"
        else:
            full_url = f"{_get_admin_api_url()}/api/log/message"
        try:
            # Convert context to a JSON-serializable format
            # Handle exceptions, non-serializable objects, etc.
            def make_serializable(obj):
                """Recursively convert object to JSON-serializable format"""
                if obj is None:
                    return None
                elif isinstance(obj, Exception):
                    return str(obj)
                elif isinstance(obj, (str, int, float, bool)):
                    return obj
                elif isinstance(obj, dict):
                    return {str(k): make_serializable(v) for k, v in obj.items()}
                elif isinstance(obj, (list, tuple)):
                    return [make_serializable(item) for item in obj]
                else:
                    # For any other type, always convert to string to ensure serializability
                    return str(obj)
            
            context_serializable = make_serializable(context)
            
            # Final validation - ensure the entire payload is serializable
            jsondata = {"file_name": file_name, "message_type": message_type, "message": message, "context": context_serializable}
            json.dumps(jsondata)  # Test serialization before sending
            
            response = requests.post(
                full_url,
                json=jsondata, 
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_token}"
                },
                timeout=(10, 30)  # 10s connect, 30s read timeout for logging
            )
            
            # Try to parse response but ignore any errors silently
            if response.text and response.text.strip():
                response.json()
                
        except Exception as e:
            import sys
            # Ensure error message itself is always serializable
            error_msg = f"[utilities.log] Failed to send log to {full_url}: {type(e).__name__}: {str(e)}"
            print(error_msg, file=sys.stderr, flush=True)
    
    # Start the request in a separate thread and don't wait for it
    thread = threading.Thread(target=_send_log, daemon=True)
    thread.start()



# Import performance test functions for convenience
try:
    from ..test_duckdb_performance import run_performance_test, test_performance, test_downsampling_accuracy
except (ImportError, ValueError):
    # If import fails (e.g., relative import issues), define a wrapper
    def run_performance_test(api_token, class_name, project_id, date, source_name, channel_list,
                            resolution='1s', start_ts=None, end_ts=None, timezone=None):
        """Quick performance test - import from test_duckdb_performance module"""
        import sys
        import os
        # Add parent directory to path
        test_module_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'test_duckdb_performance.py')
        if os.path.exists(test_module_path):
            import importlib.util
            spec = importlib.util.spec_from_file_location("test_duckdb_performance", test_module_path)
            test_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(test_module)
            return test_module.run_performance_test(api_token, class_name, project_id, date, source_name,
                                                   channel_list, resolution, start_ts, end_ts, timezone)
        else:
            raise ImportError("test_duckdb_performance module not found")

