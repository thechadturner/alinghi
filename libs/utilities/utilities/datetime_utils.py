from datetime import datetime as dt, timedelta as td, timezone as tz
import pytz
from dateutil import parser
from dateutil.tz import gettz
from .logging_utils import log_error
from typing import Optional

def get_utc_offset(datetime_obj: dt, zone: str = 'Europe/Madrid') -> int:
    """
    Get the UTC offset for a given datetime object and timezone.

    Args:
        datetime_obj (datetime): The datetime object to get the offset for.
        zone (str): The timezone to use for the offset calculation.

    Returns:
        int: The UTC offset in hours.
    """
    try:
        timezone = pytz.timezone(zone)

        # Check if datetime_obj is naive
        if datetime_obj.tzinfo is None:
            localized_datetime = timezone.localize(datetime_obj)
        else:
            localized_datetime = datetime_obj.astimezone(timezone)

        utc_offset = localized_datetime.utcoffset()
        
        return int(utc_offset.total_seconds() // 3600)
    except Exception as e:
        log_error("Error in get_utc_offset", e)
        return 0

def get_utc_datetime_from_ts(ts: float) -> dt:
    """
    Convert a timestamp to a UTC datetime object.
    Always returns a timezone-aware UTC datetime object.

    Args:
        ts (float): The timestamp to convert (Unix timestamp in seconds).

    Returns:
        datetime: The UTC datetime object with tzinfo=UTC.
    """

    status = False
    try:
        datetime_obj = dt.fromtimestamp(ts, tz=tz.utc)
        status = True
    except (ValueError, OSError, OverflowError):
        status = False
    
    if status == False:
        datetime_obj = dt.fromtimestamp(ts / 1000, tz=tz.utc)
    
    # Ensure the datetime is UTC (safeguard)
    if datetime_obj.tzinfo != tz.utc:
        # If somehow not UTC, convert to UTC
        datetime_obj = datetime_obj.astimezone(tz.utc)

    return datetime_obj

def get_local_datetime_from_ts(ts: float) -> dt:
    """
    Convert a timestamp to a localized datetime object.

    Args:
        ts (float): The timestamp to convert.

    Returns:
        datetime: The localized datetime object.
    """
    status = False
    try:
        datetime_obj = dt.fromtimestamp(ts)
        status = True
    except (ValueError, OSError, OverflowError):
        status = False
    
    if status == False:
        datetime_obj = dt.fromtimestamp(ts / 1000)

    return datetime_obj

def get_utc_datetime_from_ts(ts: float) -> dt:
    """
    Convert a timestamp to a UTC datetime object.

    Args:
        ts (float): The timestamp to convert.

    Returns:
        datetime: The UTC datetime object.
    """
    status = False
    try:
        datetime_obj = dt.fromtimestamp(ts, tz=tz.utc)
        status = True
    except (ValueError, OSError, OverflowError):
        status = False
    
    if status == False:
        datetime_obj = dt.fromtimestamp(ts / 1000, tz=tz.utc)

    return datetime_obj

def get_timestamp_from_str(val: str, force_utc: bool = True) -> float:
    """
    Convert a datetime string to a UTC timestamp.

    Args:
        val (str): The datetime string to convert.
        force_utc (bool): If True, convert datetime to UTC before getting timestamp.
                         If False, use the datetime's original timezone.
                         Default: True

    Returns:
        float: The UTC timestamp (or timestamp in original timezone if force_utc=False).
    """
    datetime_obj = get_datetime_obj(val, force_utc=force_utc)
    return datetime_obj.timestamp()

def get_datetime_obj(val: str, default_tz: str = "Europe/Madrid", force_utc: bool = False) -> dt:
    """
    Convert a string to a timezone-aware datetime object and ensure it is in the expected timezone.

    Args:
        val (str): The datetime string to convert.
        default_tz (str): The default timezone to apply if none is found.
        force_utc (bool): If True, always return UTC. When True, naive datetimes are assumed to be UTC.

    Returns:
        datetime: A timezone-aware datetime object.
    """
    val_str = str(val).strip()

    try:
        dt_obj = parser.isoparse(val_str)  # Detects timezone if present

        # If datetime is naive, assume timezone based on force_utc flag
        if dt_obj.tzinfo is None:
            # If force_utc is True, assume naive datetime is already in UTC
            # Otherwise, use the provided default timezone
            assumed_tz = "UTC" if force_utc else default_tz
            dt_obj = dt_obj.replace(tzinfo=gettz(assumed_tz))

        # Convert to UTC if forced
        if force_utc:
            return dt_obj.astimezone(gettz("UTC"))

        return dt_obj.astimezone(gettz(default_tz))

    except Exception as e:
        raise ValueError(f"Unable to parse datetime: {val}. Error: {e}")

def get_date(val: Optional[str]) -> Optional[str]:
    """
    Extract the date from a datetime string.

    Args:
        val (str): The datetime string.

    Returns:
        str: The date in 'YYYY-MM-DD' format.
    """
    try:
        if val is not None:
            ret = get_datetime_obj(val)
            return str(ret.date())
        else:
            return None
    except Exception as e:
        log_error("Error in get_date", e)
        return None

def get_year(val: Optional[str]) -> Optional[str]:
    """
    Extract the year from a datetime string.

    Args:
        val (str): The datetime string.

    Returns:
        str: The year as a string.
    """
    try:
        if val is not None:
            if len(val) < 11:
                val += " 12:00:00.00"
            ret = get_datetime_obj(val)
            return str(ret.year)
        else:
            return None
    except Exception as e:
        log_error("Error in get_year", e)
        return None
    
def clean_datetime(str: str) -> str:
    return str.replace("T"," ").replace("Z","").replace('"', '')

def format_timestamp(ts) -> str:
    """
    Format a timestamp to a string with explicit timezone indicator.
    Preserves timezone information from input - does NOT modify timezone.
    
    Args:
        ts: Can be a string (with or without timezone), datetime object, or other type
        
    Returns:
        str: ISO format timestamp string with timezone indicator
        - If input is a string: returns as-is (preserves timezone like 'Z', '+00:00', '+01:00', etc.)
        - If input is a datetime object: formats with its original timezone (preserves +01:00, +04:00, etc.)
        - Otherwise: converts to string
    """
    if isinstance(ts, str):
        # If already a string, return as-is (should already have timezone indicator)
        return ts
    elif hasattr(ts, 'strftime'):
        # If it's a datetime object, format it with its timezone preserved
        if ts.tzinfo is None:
            # If timezone-naive, assume UTC and make it timezone-aware
            ts = ts.replace(tzinfo=tz.utc)
            return ts.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        else:
            # If timezone-aware, preserve the timezone and format with explicit offset
            # Check if it's UTC by comparing UTC offset
            utc_offset = ts.utcoffset()
            is_utc = (utc_offset is not None and utc_offset.total_seconds() == 0)
            
            if is_utc:
                # UTC timezone - format with 'Z' for clarity
                return ts.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
            else:
                # Non-UTC timezone - format with offset like +01:00, +04:00, etc.
                # Use isoformat() which includes timezone offset
                iso_str = ts.isoformat()
                # Ensure microseconds are included
                if '.' not in iso_str.split('+')[0].split('-')[-1].split('Z')[0]:
                    # No microseconds, add them before timezone
                    if '+' in iso_str:
                        iso_str = iso_str.replace('+', '.000000+', 1)
                    elif iso_str.count('-') >= 3:  # Has timezone offset with -
                        # Split from the right to preserve date separators
                        parts = iso_str.rsplit('-', 1)
                        if len(parts) == 2:
                            iso_str = parts[0] + '.000000-' + parts[1]
                    elif iso_str.endswith('Z'):
                        iso_str = iso_str.replace('Z', '.000000Z')
                return iso_str
    else:
        # Fallback: convert to string
        return str(ts)