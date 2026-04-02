import pandas as pd
import numpy as np
import sys
import json
import os
from pathlib import Path

# Configure stdout/stderr to use UTF-8 encoding to handle Unicode characters
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

import utilities as u

from dotenv import load_dotenv

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (three levels up from server_python/scripts/ac40/)
project_root = Path(__file__).parent.parent.parent.parent

base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"

load_dotenv(dotenv_path=project_root / base_env_file)
load_dotenv(dotenv_path=project_root / local_env_file, override=True)

api_token = os.getenv('SYSTEM_KEY')
if not api_token:
    raise RuntimeError("SYSTEM_KEY is missing from environment configuration.")

LOG_SCRIPT = "3_systems.py"

channels = [
    {'name': 'Datetime', 'type': 'datetime'},
    {'name': 'ts', 'type': 'float'},
    {'name': 'RH_lwd_mm', 'type': 'float'}
]


def get_data(class_name, project_id, date, source_name, start_ts, end_ts):
    df = pd.DataFrame()
    try:
        dfi = u.get_channel_values(
            api_token,
            class_name,
            project_id,
            date,
            source_name,
            channels,
            '100ms',
            start_ts,
            end_ts,
            'UTC'
        )

        if dfi is None or len(dfi) == 0:
            return df

        u.log(api_token, LOG_SCRIPT, "info", "get_data", str(len(dfi)) + " records found!")

        if dfi['ts'].dtype == 'Float64':
            dfi['ts'] = dfi['ts'].astype('float64')

        ts_sample = dfi['ts'].dropna()
        if len(ts_sample) > 0:
            if ts_sample.max() > 1e12:
                dfi['ts'] = (dfi['ts'] / 1000.0).round(3)
            else:
                dfi['ts'] = dfi['ts'].round(3)

        dfo = dfi.copy()
        if 'Datetime' in dfo.columns:
            dfo['Datetime'] = pd.to_datetime(dfo['Datetime'], utc=True, errors='coerce')
            if dfo['Datetime'].dtype.name.startswith('datetime64'):
                if dfo['Datetime'].dt.tz is None:
                    dfo['Datetime'] = dfo['Datetime'].dt.tz_localize('UTC')
                elif str(dfo['Datetime'].dt.tz) != 'UTC':
                    dfo['Datetime'] = dfo['Datetime'].dt.tz_convert('UTC')

        if 'ts' in dfo.columns:
            dfo['ts'] = pd.to_numeric(dfo['ts'], errors='coerce').fillna(0)
            dfo = dfo.sort_values('ts', kind='mergesort').reset_index(drop=True)

        return dfo
    except Exception as e:
        u.log(api_token, LOG_SCRIPT, "error", "get_data", "script exception error:" + str(e))
        return df


def format_datetime_series_racesight_parquet(dt: pd.Series) -> pd.Series:
    """
    UTC strings for Parquet: '2026-03-01 05:20:35.900000095+00:00'
    (space between date and time, 9-digit fractional nanoseconds, +00:00).
    """
    dt = pd.to_datetime(dt, utc=True, errors='coerce')
    out = pd.Series(pd.NA, index=dt.index, dtype=pd.StringDtype())
    mask = dt.notna()
    if not mask.any():
        return out
    i8 = dt.loc[mask].astype('int64')
    ns_rem = i8 % (10**9)
    i8_sec = i8 - ns_rem
    base_dt = pd.to_datetime(i8_sec, utc=True, unit='ns')
    bases = base_dt.dt.strftime('%Y-%m-%d %H:%M:%S')
    frac = ns_rem.map(lambda n: f'{int(n):09d}')
    formatted = bases + '.' + frac + '+00:00'
    out.loc[mask] = formatted.values
    return out


def compute_rh_lwd_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    From RH_lwd_mm:
    - rh300_cross: 1 on the row where RH crosses from >=300 to <300 (e.g. 300→299); else 0.
    - rh750_cross: 1 when crossing from >=750 to <750; else 0.
    - rh1400_cross: 1 when crossing from <=1400 to >1400; else 0.
    - rhZero: 1 if RH <= 0 (touchdown / not foiling vs RH_lwd_mm > 0); else 0; NaN if RH missing.
      Subset of rh300_below; use with rh300_below to split low band into non-foil vs 0 < RH < 300.
    - rh300_below: 1 if strictly below 300, 0 if at or above; NaN if RH missing.
    - rh750_below: 1 if strictly between 300 and 750 (RH > 300 and RH < 750); else 0; NaN if RH missing.
    - rh1400_above: 1 if strictly above 1400, 0 if at or below; NaN if RH missing.
    - rhGood: 1 if strictly between 750 and 1400 (RH > 750 and RH < 1400); else 0; NaN if RH missing.
    """
    out = df.copy()
    if 'RH_lwd_mm' not in out.columns:
        u.log(api_token, LOG_SCRIPT, "warning", "compute_rh_lwd_features", "missing RH_lwd_mm")
        return out

    rh = pd.to_numeric(out['RH_lwd_mm'], errors='coerce')
    s = rh.to_numpy(dtype=float)
    n = len(s)
    cross300 = np.zeros(n, dtype=np.int64)
    cross750 = np.zeros(n, dtype=np.int64)
    cross1400 = np.zeros(n, dtype=np.int64)
    if n >= 2:
        prev = s[:-1]
        curr = s[1:]
        ok = np.isfinite(prev) & np.isfinite(curr)
        cross300[1:] = (ok & (prev >= 300.0) & (curr < 300.0)).astype(np.int64)
        cross750[1:] = (ok & (prev >= 750.0) & (curr < 750.0)).astype(np.int64)
        cross1400[1:] = (ok & (prev <= 1400.0) & (curr > 1400.0)).astype(np.int64)

    out['rh300_cross'] = cross300
    out['rh750_cross'] = cross750
    out['rh1400_cross'] = cross1400

    at_or_below_zero = rh <= 0.0
    below300 = rh < 300.0
    between300_750 = (rh > 300.0) & (rh < 750.0)
    above1400 = rh > 1400.0

    out['rhZero'] = np.where(rh.notna(), at_or_below_zero.astype(np.float64), np.nan)
    out['rh300_below'] = np.where(rh.notna(), below300.astype(np.float64), np.nan)
    out['rh750_below'] = np.where(rh.notna(), between300_750.astype(np.float64), np.nan)
    out['rh1400_above'] = np.where(rh.notna(), above1400.astype(np.float64), np.nan)

    in_band = (rh > 750.0) & (rh < 1400.0)
    out['rhGood'] = np.where(rh.notna(), in_band.astype(np.float64), np.nan)

    return out


def build_flight_export_df(df: pd.DataFrame) -> pd.DataFrame:
    cols: list[str] = ['ts']
    if 'Datetime' in df.columns:
        cols.append('Datetime')
    cols.append('RH_lwd_mm')
    tail = [
        'rh300_cross', 'rh750_cross', 'rh1400_cross',
        'rhZero', 'rh300_below', 'rh750_below', 'rh1400_above', 'rhGood',
    ]
    ordered = cols + tail
    present = [c for c in ordered if c in df.columns]
    return df[present].copy()


def _filesystem_class_dir(class_name: str) -> str:
    return str(class_name or '').strip().lower()


def _write_flight_parquet(df_export, class_name, project_id, date, source_name):
    data_dir = os.getenv('DATA_DIRECTORY', 'C:/MyApps/Hunico/Uploads/Data')
    out_dir = os.path.join(
        data_dir, 'system', str(project_id), _filesystem_class_dir(class_name), date, source_name,
    )
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, 'flight_data_racesight.parquet')
    if os.path.exists(path):
        os.remove(path)
    out = df_export.copy()
    if 'Datetime' in out.columns:
        out['Datetime'] = format_datetime_series_racesight_parquet(out['Datetime'])
    out.to_parquet(path, engine='pyarrow')
    return path


if __name__ == "__main__":
    parameters_json = {}
    USE_MANUAL_TEST_INPUTS = False

    try:
        if USE_MANUAL_TEST_INPUTS:
            class_name = "AC40"
            project_id = 1
            date = "20260215"
            source_name = "GBR"
            start_time = None
            end_time = None
            verbose = True
            parameters_json = {'verbose': verbose}
        else:
            parameters_str = sys.argv[1]
            parameters_json = json.loads(parameters_str)

            u.log(api_token, LOG_SCRIPT, "info", "parameters", parameters_str)

            class_name = parameters_json.get('class_name')
            project_id = parameters_json.get('project_id')
            date = parameters_json.get('date')
            source_name = parameters_json.get('source_name')
            start_time = parameters_json.get('start_time')
            end_time = parameters_json.get('end_time')
            if start_time == '':
                start_time = None
            if end_time == '':
                end_time = None
            verbose = parameters_json.get('verbose', False)

        start_ts = u.get_timestamp_from_str(start_time) if isinstance(start_time, str) else start_time
        end_ts = u.get_timestamp_from_str(end_time) if isinstance(end_time, str) else end_time
        if start_ts is not None and pd.isna(start_ts):
            start_ts = None
        if end_ts is not None and pd.isna(end_ts):
            end_ts = None

        if verbose:
            print(f"{LOG_SCRIPT}: calling get_data", flush=True)

        df_raw = get_data(class_name, project_id, date, source_name, start_ts, end_ts)

        if verbose:
            print(f"{LOG_SCRIPT}: get_data returned {len(df_raw)} rows", flush=True)

        if len(df_raw) == 0:
            u.log(api_token, LOG_SCRIPT, "info", "main", "No data found")
            print(
                "Scripts Failed: No rows loaded (get_data returned empty). "
                f"class_name={class_name!r} project_id={project_id!r} date={date!r} source_name={source_name!r}",
                flush=True,
            )
            sys.exit(1)

        df_feat = compute_rh_lwd_features(df_raw)
        df_export = build_flight_export_df(df_feat)

        path = _write_flight_parquet(df_export, class_name, project_id, date, source_name)

        print(f"{len(df_export)} records saved to {path}", flush=True)
        sys.exit(0)

    except Exception as error:
        import traceback
        error_trace = traceback.format_exc()
        u.log(api_token, LOG_SCRIPT, "error", "main", "script exception error:" + str(error))
        u.log(api_token, LOG_SCRIPT, "error", "main", "traceback:" + error_trace)
        try:
            print(f"Scripts Failed: {str(error)}", flush=True)
            if parameters_json.get('verbose', False):
                print(error_trace, flush=True)
        except UnicodeEncodeError:
            print(f"Scripts Failed: {str(error).encode('ascii', errors='replace').decode('ascii')}", flush=True)
            if parameters_json.get('verbose', False):
                print(error_trace.encode('ascii', errors='replace').decode('ascii'), flush=True)
        sys.exit(1)
