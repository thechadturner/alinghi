"""
5_markwind.py: Build and post markwind object from Influx MDSS data.

Queries Influx at level='mdss' for a fixed set of boat names, merges by timestamp,
resamples to 10-second intervals, and posts the result as the project object 'markwind'.
Intended to be run once per date (e.g. after normalization in the upload flow).

Parameters (JSON in argv[1]): class_name, project_id, date (YYYYMMDD), timezone (optional).
"""

import sys
import json
import os
from pathlib import Path

sys.stdout.write("5_markwind.py: Script starting, importing modules...\n")
sys.stdout.flush()

try:
    import pandas as pd
    import numpy as np
    import utilities as u
    from datetime import datetime
    from dateutil import tz as dateutil_tz
    from dateutil.tz import gettz
    from dotenv import load_dotenv
except Exception as e:
    sys.stdout.write(f"ERROR during import: {e}\n")
    import traceback
    sys.stdout.write(traceback.format_exc() + "\n")
    sys.stdout.flush()
    sys.exit(1)

# Environment and project root (four levels up: ac40 -> scripts -> server_python -> root)
is_production = os.getenv("NODE_ENV") == "production"
project_root = Path(__file__).parent.parent.parent.parent
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"
base_env_path = project_root / base_env_file
local_env_path = project_root / local_env_file
load_dotenv(dotenv_path=base_env_path)
load_dotenv(dotenv_path=local_env_path, override=True)

api_token = os.getenv("SYSTEM_KEY")
if not api_token:
    raise RuntimeError("SYSTEM_KEY is missing from environment configuration.")

# MDSS channels (Influx measurement names and types)
MDSS_CHANNELS = [
    {"name": "LATITUDE_MDSS_deg", "type": "float"},
    {"name": "LONGITUDE_MDSS_deg", "type": "float"},
    {"name": "BOAT_SPEED_MDSS_km_h_1", "type": "float"},
    {"name": "TWS_MDSS_km_h_1", "type": "float"},
    {"name": "TWD_MDSS_deg", "type": "angle180"},
]

# Boat names to query at mdss level (race marks)
MARK_BOAT_NAMES = [
    "FL1", "FL2", "SL1", "SL2", "M1", "LG1", "LG2", "WG1", "WG2"
]

# Suffixes for renaming per-boat columns to {name}_lat, {name}_lng, etc.
MDSS_RENAME = {
    "LATITUDE_MDSS_deg": "_lat",
    "LONGITUDE_MDSS_deg": "_lng",
    "BOAT_SPEED_MDSS_km_h_1": "_bsp",
    "TWS_MDSS_km_h_1": "_tws",
    "TWD_MDSS_deg": "_twd",
}

RESAMPLE_INTERVAL_S = 10


def format_datetime_utc(dt_val) -> str:
    """
    Format a datetime (or pandas Timestamp) as UTC string: YYYY-MM-DD HH:MM:SS.f+00.
    Converts to UTC if timezone-aware; tenths of seconds and explicit +00 suffix.
    """
    if dt_val is None or (isinstance(dt_val, float) and np.isnan(dt_val)):
        return ""
    tz_info = getattr(dt_val, "tzinfo", None)
    if tz_info is not None:
        if hasattr(dt_val, "tz_convert"):
            dt_val = dt_val.tz_convert(dateutil_tz.tzutc())
        else:
            dt_val = dt_val.astimezone(dateutil_tz.tzutc())
    if hasattr(dt_val, "strftime"):
        base = dt_val.strftime("%Y-%m-%d %H:%M:%S")
        microsecond = getattr(dt_val, "microsecond", 0) or 0
        tenths = (microsecond // 100_000) % 10
        return f"{base}.{tenths}+00"
    return str(dt_val)


def build_markwind_from_influx(date: str, timezone_str: str, start_ts: float, end_ts: float) -> list:
    """
    Query Influx at level='mdss' for each mark boat, merge on ts, resample to 10s,
    and return a list of { "DATETIME": str, "MARKS": [ { NAME, LAT, LON, BSP, TWS, TWD }, ... ] }.
    """
    dfs_per_boat = []
    for boat in MARK_BOAT_NAMES:
        try:
            df = u.get_channel_values_influx(
                date=date,
                source_name=boat,
                channel_list=MDSS_CHANNELS,
                rs="1s",
                start_ts=start_ts,
                end_ts=end_ts,
                timezone=timezone_str,
                level="mdss",
                skipMissing=True,
            )
        except Exception as e:
            u.log(api_token, "5_markwind.py", "warning", "mdss_query", f"Boat {boat}: {e}")
            continue
        if df is None or df.empty:
            continue
        rename = {m: boat + MDSS_RENAME[m] for m in MDSS_RENAME if m in df.columns}
        df = df.rename(columns=rename)
        # Keep only ts and per-boat columns so merge does not duplicate Datetime
        cols_keep = ["ts"] + [c for c in df.columns if c != "ts" and c.startswith(boat + "_")]
        dfs_per_boat.append(df[cols_keep].copy())
    if not dfs_per_boat:
        return []
    merged = dfs_per_boat[0]
    for df in dfs_per_boat[1:]:
        merged = pd.merge(merged, df, on="ts", how="outer", sort=True)
    merged = merged.drop_duplicates(subset=["ts"]).sort_values("ts").reset_index(drop=True)
    # Where BSP > 2, set to NaN
    for name in MARK_BOAT_NAMES:
        bsp_col = name + "_bsp"
        if bsp_col not in merged.columns:
            continue
        merged.loc[merged[bsp_col] > 2, bsp_col] = np.nan
    # Resample to one row every 10 seconds; resample() requires DatetimeIndex
    merged["ts"] = pd.to_numeric(merged["ts"], errors="coerce")
    merged = merged.dropna(subset=["ts"])
    dt_index = pd.to_datetime(merged["ts"], unit="s", utc=True)
    merged = merged.drop(columns=["ts"]).set_index(dt_index)
    merged.index.name = "datetime"
    resampled = merged.resample(f"{RESAMPLE_INTERVAL_S}s").first().dropna(how="all")
    resampled = resampled.reset_index()
    resampled["ts"] = (resampled["datetime"].astype("int64") // 10**9).astype("float")
    resampled["Datetime"] = resampled["datetime"]
    # Keep datetimes in UTC for output; format as YYYY-MM-DD HH:MM:SS.f+00
    racemarks_data = []
    for _, row in resampled.iterrows():
        creation_time = row.get("Datetime")
        if creation_time is None or (isinstance(creation_time, float) and np.isnan(creation_time)):
            creation_time = datetime.fromtimestamp(row["ts"], tz=dateutil_tz.tzutc())
        dt_str = format_datetime_utc(creation_time) or str(creation_time)
        marks_info = {"DATETIME": dt_str, "MARKS": []}
        for name in MARK_BOAT_NAMES:
            lat_col = name + "_lat"
            lng_col = name + "_lng"
            tws_col = name + "_tws"
            twd_col = name + "_twd"
            bsp_col = name + "_bsp"
            if lat_col not in row or lng_col not in row or tws_col not in row or twd_col not in row:
                continue
            lat = row[lat_col]
            lng = row[lng_col]
            tws = row[tws_col]
            twd = row[twd_col]
            bsp = row.get(bsp_col)
            if pd.isna(lat) or pd.isna(lng) or pd.isna(tws) or pd.isna(twd):
                continue
            # MDSS channels may store lat/lng as degrees × 1e7; convert to degrees
            lat_f = float(lat)
            lng_f = float(lng)
            if abs(lat_f) > 90 or abs(lng_f) > 180:
                lat_f = lat_f / 1e7
                lng_f = lng_f / 1e7
            mark = {
                "NAME": str(name),
                "LAT": str(lat_f),
                "LON": str(lng_f),
                "BSP": str(bsp) if bsp is not None and not pd.isna(bsp) else "",
                "TWS": str(tws),
                "TWD": str(twd),
            }
            marks_info["MARKS"].append(mark)
        if len(marks_info["MARKS"]) > 0:
            racemarks_data.append(marks_info)
    return racemarks_data


def main():
    try:
        if len(sys.argv) < 2:
            u.log(api_token, "5_markwind.py", "error", "parameters", "Missing parameters JSON")
            print("ERROR: Missing required parameters argument (JSON)", flush=True)
            sys.exit(1)

        parameters_str = sys.argv[1]
        u.log(api_token, "5_markwind.py", "info", "parameters", parameters_str)

        parameters_json = json.loads(parameters_str)
        class_name = parameters_json.get("class_name")
        project_id = parameters_json.get("project_id")
        date = parameters_json.get("date")
        timezone_str = parameters_json.get("timezone") or "Europe/Madrid"

        # class_name = 'ac40'
        # project_id = 1
        # date = '20260301'
        # timezone_str = 'Australia/Sydney'

        missing = [k for k, v in [("class_name", class_name), ("project_id", project_id), ("date", date)] if not v]
        if missing:
            u.log(api_token, "5_markwind.py", "error", "parameters", f"Missing: {missing}")
            print(f"ERROR: Missing required parameters: {missing}", flush=True)
            sys.exit(1)
        date = str(date).replace("-", "").replace("/", "")
        if len(date) != 8 or not date.isdigit():
            print("ERROR: date must be YYYYMMDD", flush=True)
            sys.exit(1)
        date_ymd = f"{date[0:4]}-{date[4:6]}-{date[6:8]}"
        tz_info = gettz(timezone_str) or gettz("Europe/Madrid")
        local_start = datetime.strptime(f"{date_ymd} 00:00:00", "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz_info)
        local_end = datetime.strptime(f"{date_ymd} 23:59:59", "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz_info)
        start_ts = local_start.astimezone(dateutil_tz.tzutc()).timestamp()
        end_ts = local_end.astimezone(dateutil_tz.tzutc()).timestamp()
        print(f"Building markwind from Influx mdss for date={date} timezone={timezone_str}", flush=True)
        racemarks_data = build_markwind_from_influx(date, timezone_str, start_ts, end_ts)
        if not racemarks_data:
            u.log(api_token, "5_markwind.py", "info", "markwind", "No mdss data for date, skipping post")
            print("No markwind data for this date, skipping post.", flush=True)
            sys.exit(0)
        marks_json_str = json.dumps(racemarks_data, indent=2)
        jsondata = {
            "class_name": class_name,
            "project_id": project_id,
            "date": date,
            "object_name": "markwind",
            "json": marks_json_str,
        }
        res = u.post_api_data(api_token, ":8059/api/projects/object", jsondata)
        if res.get("success"):
            u.log(api_token, "5_markwind.py", "info", "markwind", f"Posted markwind: {len(racemarks_data)} entries")
            print(f"Successfully posted markwind ({len(racemarks_data)} entries)", flush=True)
        else:
            u.log(api_token, "5_markwind.py", "error", "markwind", res.get("message", "Unknown error"))
            print(f"Failed to post markwind: {res.get('message', 'Unknown error')}", flush=True)
            sys.exit(1)
        print("5_markwind.py completed successfully.", flush=True)
    except json.JSONDecodeError as e:
        u.log(api_token, "5_markwind.py", "error", "parameters", str(e))
        print(f"ERROR: Invalid parameters JSON: {e}", flush=True)
        sys.exit(1)
    except Exception as e:
        u.log(api_token, "5_markwind.py", "error", "markwind", str(e))
        print(f"ERROR: {e}", flush=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
