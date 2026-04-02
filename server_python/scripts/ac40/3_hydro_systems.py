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

# Per raw channel: map each reading x to display % with the same rule:
#   PER = clip(100 * (x - min) / (max - min), 0, 100)
# Each row is independent (cant uses cant min/max only; rake uses rake; etc.).
RANGES = [
    {'name': 'ANGLE_RUD_RAKE_P_deg', 'min': -2.7, 'max': 7},
    {'name': 'ANGLE_RUD_RAKE_S_deg', 'min': -2.7, 'max': 7},
    {'name': 'ANGLE_DB_RAKE_P_deg', 'min': -5, 'max': 8},
    {'name': 'ANGLE_DB_RAKE_S_deg', 'min': -5, 'max': 8},
    # If the logged cant signal is not linear 0–100 in boat units, set min/max to match sensor endpoints.
    {'name': 'CANT_POS_PCT_P_pct', 'min': 0, 'max': 100},
    {'name': 'CANT_POS_PCT_S_pct', 'min': 0, 'max': 100},
    {'name': 'LENGTH_DB_H_P_mm', 'min': 0, 'max': 1920},
    {'name': 'LENGTH_DB_H_S_mm', 'min': 0, 'max': 1920},
]

# Max physical stroke (mm); bore/rod diameters (mm); type single|double.
# Double-acting: pump_uses_bore_when_stroke_increases — if True, Δstroke>0 uses bore area, Δstroke<0 annulus
# (adding rake / foil rake / cant in / lowering board = bore per cylinder notes). Flip if sensor sign is inverted.
# Single-acting (jib): pump on retraction only → annulus × |Δs| when Δstroke<0; extension (Δs>0) → 0 L pump estimate.
# per_is_fraction: raw channel is 0–1 (not 0–100). If True, stroke_mm = per * stroke_max and PER_* is clipped to [0,1].
# If cant/rake looks ~100× too “quiet” in stroke/oil, set per_is_fraction True for that row (check logs: raw max ≤ ~1).
STROKES = [
    {'name': 'PER_JIB_SHEET_pct', 'stroke': 740, 'bore': 38.1, 'rod': 17.463, 'type': 'single'},
    {'name': 'PER_JIB_LEAD_pct', 'stroke': 310, 'bore': 31.75, 'rod': 17.463, 'type': 'single'},
    {'name': 'ANGLE_RUD_RAKE_P_deg', 'stroke': 130, 'bore': 31.75, 'rod': 19.05, 'type': 'double', 'pump_uses_bore_when_stroke_increases': True},
    {'name': 'ANGLE_RUD_RAKE_S_deg', 'stroke': 130, 'bore': 31.75, 'rod': 19.05, 'type': 'double', 'pump_uses_bore_when_stroke_increases': True},
    {'name': 'ANGLE_DB_RAKE_P_deg', 'stroke': 200, 'bore': 44.45, 'rod': 25.4, 'type': 'double', 'pump_uses_bore_when_stroke_increases': True},
    {'name': 'ANGLE_DB_RAKE_S_deg', 'stroke': 200, 'bore': 44.45, 'rod': 25.4, 'type': 'double', 'pump_uses_bore_when_stroke_increases': True},
    {'name': 'CANT_POS_PCT_P_pct', 'stroke': 340, 'bore': 47.625, 'rod': 31.75, 'type': 'double', 'pump_uses_bore_when_stroke_increases': True},
    {'name': 'CANT_POS_PCT_S_pct', 'stroke': 340, 'bore': 47.625, 'rod': 31.75, 'type': 'double', 'pump_uses_bore_when_stroke_increases': True},
    {'name': 'LENGTH_DB_H_P_mm', 'stroke': 462, 'bore': 38.1, 'rod': 28.575, 'type': 'double', 'pump_uses_bore_when_stroke_increases': True},
    {'name': 'LENGTH_DB_H_S_mm', 'stroke': 462, 'bore': 38.1, 'rod': 28.575, 'type': 'double', 'pump_uses_bore_when_stroke_increases': True},
]

RANGE_BY_RAW_NAME = {r['name']: r for r in RANGES}

# |Δstroke| (mm) per timestep at or below this → treated as 0 for oil volume only (not raw DIFF_STROKE_*).
# Default applies to every STROKES row; OIL_VOL_STROKE_DEADBAND_BY_SOURCE overrides per channel.
# Reduces cross-source drift when one system has more ADC jitter (bore vs annulus makes signed noise biased).
# Tune down if real slow motion is suppressed; up if cumulative oil still looks noisy when stationary.
OIL_VOL_STROKE_DEADBAND_MM_DEFAULT = 0.2
OIL_VOL_STROKE_DEADBAND_BY_SOURCE: dict[str, float] = {}

# After deadband, |Δs_oil| at or below this (mm) → OIL_VOL forced to 0 (removes float residue on stationary rows).
OIL_DS_EFFECTIVE_ZERO_MM = 1e-9

# Row-wise sums of port+stbd OIL_VOL_*_L (after compute_diff_stroke_and_oil_volume).
# OIL_VOL_TOTAL_L sums each STROKES oil column once (same as the three *_TOTAL_L + DB_H_P + DB_H_S).
OIL_VOL_AGGREGATE_PAIRS: tuple[tuple[str, str, str], ...] = (
    ('OIL_VOL_DB_RAKE_TOTAL_L', 'ANGLE_DB_RAKE_P_deg', 'ANGLE_DB_RAKE_S_deg'),
    ('OIL_VOL_RUD_RAKE_TOTAL_L', 'ANGLE_RUD_RAKE_P_deg', 'ANGLE_RUD_RAKE_S_deg'),
    ('OIL_VOL_CANT_TOTAL_L', 'CANT_POS_PCT_P_pct', 'CANT_POS_PCT_S_pct'),
)
OIL_VOL_TOTAL_COLUMN = 'OIL_VOL_TOTAL_L'

# Columns excluded from range→percent mapping (time axes only).
_SKIP_RANGE_INPUT_COLS = frozenset({'ts', 'Datetime'})

# API/source channel name -> (Parquet PER_* column, Parquet STROKE_*_mm column)
CHANNEL_OUTPUT = {
    'PER_JIB_SHEET_pct': ('PER_JIB_SHEET_pct', 'STROKE_JIB_SHEET_mm'),
    'PER_JIB_LEAD_pct': ('PER_JIB_LEAD_pct', 'STROKE_JIB_LEAD_mm'),
    'ANGLE_RUD_RAKE_P_deg': ('PER_RUD_RAKE_P_pct', 'STROKE_RUD_RAKE_P_mm'),
    'ANGLE_RUD_RAKE_S_deg': ('PER_RUD_RAKE_S_pct', 'STROKE_RUD_RAKE_S_mm'),
    'ANGLE_DB_RAKE_P_deg': ('PER_DB_RAKE_P_pct', 'STROKE_DB_RAKE_P_mm'),
    'ANGLE_DB_RAKE_S_deg': ('PER_DB_RAKE_S_pct', 'STROKE_DB_RAKE_S_mm'),
    'CANT_POS_PCT_P_pct': ('PER_CANT_P_pct', 'STROKE_CANT_P_mm'),
    'CANT_POS_PCT_S_pct': ('PER_CANT_S_pct', 'STROKE_CANT_S_mm'),
    'LENGTH_DB_H_P_mm': ('PER_DB_H_P_pct', 'STROKE_DB_H_P_mm'),
    'LENGTH_DB_H_S_mm': ('PER_DB_H_S_pct', 'STROKE_DB_H_S_mm'),
}

HYDRAULIC_CHANNELS = [
    {'name': 'Datetime', 'type': 'datetime'},
    {'name': 'ts', 'type': 'float'},
    {'name': 'PER_JIB_SHEET_pct', 'type': 'float'},
    {'name': 'PER_JIB_LEAD_pct', 'type': 'float'},
    {'name': 'ANGLE_RUD_RAKE_P_deg', 'type': 'float'},
    {'name': 'ANGLE_RUD_RAKE_S_deg', 'type': 'float'},
    {'name': 'ANGLE_DB_RAKE_P_deg', 'type': 'float'},
    {'name': 'ANGLE_DB_RAKE_S_deg', 'type': 'float'},
    {'name': 'CANT_POS_PCT_P_pct', 'type': 'float'},
    {'name': 'CANT_POS_PCT_S_pct', 'type': 'float'},
    {'name': 'LENGTH_DB_H_P_mm', 'type': 'float'},
    {'name': 'LENGTH_DB_H_S_mm', 'type': 'float'},
]


def per_column_for_source(source_name: str) -> str:
    return CHANNEL_OUTPUT[source_name][0]


def stroke_column_for_source(source_name: str) -> str:
    return CHANNEL_OUTPUT[source_name][1]


def diff_stroke_column_for_source(source_name: str) -> str:
    return stroke_column_for_source(source_name).replace('STROKE_', 'DIFF_STROKE_', 1)


def oil_vol_column_for_source(source_name: str) -> str:
    return stroke_column_for_source(source_name).replace('STROKE_', 'OIL_VOL_', 1).replace('_mm', '_L')


def bore_area_mm2(d_bore_mm: float) -> float:
    r = d_bore_mm / 2.0
    return float(np.pi * r * r)


def annulus_area_mm2(d_bore_mm: float, d_rod_mm: float) -> float:
    r_b = d_bore_mm / 2.0
    r_r = d_rod_mm / 2.0
    return float(np.pi * (r_b * r_b - r_r * r_r))


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


def get_data(class_name, project_id, date, source_name, start_ts, end_ts):
    df = pd.DataFrame()
    try:
        dfi = u.get_channel_values(
            api_token,
            class_name,
            project_id,
            date,
            source_name,
            HYDRAULIC_CHANNELS,
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
        # API often returns Datetime as object dtype (Timestamp); normalize before numeric fillna / parquet
        if 'Datetime' in dfo.columns:
            dfo['Datetime'] = pd.to_datetime(dfo['Datetime'], utc=True, errors='coerce')
            if dfo['Datetime'].dtype.name.startswith('datetime64'):
                if dfo['Datetime'].dt.tz is None:
                    dfo['Datetime'] = dfo['Datetime'].dt.tz_localize('UTC')
                elif str(dfo['Datetime'].dt.tz) != 'UTC':
                    dfo['Datetime'] = dfo['Datetime'].dt.tz_convert('UTC')

        # Do not fillna(0) on sensor columns: gaps stay NaN so diff()/oil volume avoid spurious jumps at reconnect.
        if 'ts' in dfo.columns:
            dfo['ts'] = pd.to_numeric(dfo['ts'], errors='coerce').fillna(0)
            dfo = dfo.sort_values('ts', kind='mergesort').reset_index(drop=True)

        return dfo
    except Exception as e:
        u.log(api_token, LOG_SCRIPT, "error", "get_data", "script exception error:" + str(e))
        return df


def compute_percentages(df):
    """
    For each dataframe column that has a RANGES entry (except ts / Datetime):
    PER_* = clip(100 * (reading - min) / (max - min), 0, 100).
    """
    out = df.copy()

    for col in out.columns:
        if col in _SKIP_RANGE_INPUT_COLS:
            continue
        if col not in RANGE_BY_RAW_NAME:
            continue
        if col not in CHANNEL_OUTPUT:
            u.log(
                api_token, LOG_SCRIPT, "warning", "compute_percentages",
                f"{col!r} in RANGES but not in CHANNEL_OUTPUT; skip PER column",
            )
            continue
        r = RANGE_BY_RAW_NAME[col]
        lo, hi = r['min'], r['max']
        per_out = per_column_for_source(col)
        x = pd.to_numeric(out[col], errors='coerce')
        if hi == lo:
            u.log(
                api_token, LOG_SCRIPT, "warning", "compute_percentages",
                f"{col}: min==max ({lo}), {per_out} set to NaN",
            )
            out[per_out] = np.nan
        else:
            p = 100.0 * (x - lo) / (hi - lo)
            out[per_out] = np.clip(p, 0.0, 100.0)

    for r in RANGES:
        raw = r['name']
        if raw not in out.columns:
            u.log(api_token, LOG_SCRIPT, "warning", "compute_percentages", f"missing raw column {raw!r}")

    return out


def compute_strokes(df):
    """
    stroke_mm: per_is_fraction → per×stroke_max (per 0–1). Otherwise PER is 0–100 → (per/100)×stroke_max.
    """
    out = df.copy()

    for s in STROKES:
        name = s['name']
        stroke_max = float(s['stroke'])
        per_col = per_column_for_source(name)
        stroke_col = stroke_column_for_source(name)
        if per_col not in out.columns:
            u.log(api_token, LOG_SCRIPT, "warning", "compute_strokes", f"missing {per_col!r} for {name!r}")
            out[stroke_col] = np.nan
            continue
        p = pd.to_numeric(out[per_col], errors='coerce')
        if s.get('per_is_fraction'):
            out[stroke_col] = p * stroke_max
        else:
            # PER_* and ranged outputs are 0–100; scale to 0–1 only for stroke length
            out[stroke_col] = (p / 100.0) * stroke_max

    return out


def compute_diff_stroke_and_oil_volume(df):
    """
    Per timestep: DIFF_STROKE_*_mm = diff(STROKE_*_mm); OIL_VOL_*_L = incremental pump-side volume (L) from bore/annulus × |Δs|.
    Rows sorted by ts. Oil volume uses OIL_VOL_STROKE_DEADBAND_MM_DEFAULT (or per-source override) on |Δs|; raw diff is unchanged.
    """
    out = df.copy()
    if 'ts' in out.columns:
        out = out.sort_values('ts', kind='mergesort').reset_index(drop=True)

    for s in STROKES:
        name = s['name']
        stroke_col = stroke_column_for_source(name)
        diff_col = diff_stroke_column_for_source(name)
        vol_col = oil_vol_column_for_source(name)
        if stroke_col not in out.columns:
            u.log(api_token, LOG_SCRIPT, "warning", "compute_diff_stroke_and_oil_volume", f"missing {stroke_col!r}")
            out[diff_col] = np.nan
            out[vol_col] = np.nan
            continue

        smm = pd.to_numeric(out[stroke_col], errors='coerce')
        ds = smm.diff()
        out[diff_col] = ds

        deadband_mm = float(OIL_VOL_STROKE_DEADBAND_BY_SOURCE.get(name, OIL_VOL_STROKE_DEADBAND_MM_DEFAULT))
        if deadband_mm > 0:
            ds_oil = ds.copy()
            small = ds_oil.notna() & (ds_oil.abs() <= deadband_mm)
            ds_oil = ds_oil.mask(small, 0.0)
        else:
            ds_oil = ds

        bore = s.get('bore')
        rod = s.get('rod')
        act_type = s.get('type', 'double')
        if bore is None or rod is None:
            u.log(
                api_token, LOG_SCRIPT, "warning", "compute_diff_stroke_and_oil_volume",
                f"{name!r}: missing bore/rod, {vol_col} set to NaN",
            )
            out[vol_col] = np.nan
            continue
        try:
            d_b = float(bore)
            d_r = float(rod)
        except (TypeError, ValueError):
            u.log(
                api_token, LOG_SCRIPT, "warning", "compute_diff_stroke_and_oil_volume",
                f"{name!r}: invalid bore/rod, {vol_col} set to NaN",
            )
            out[vol_col] = np.nan
            continue
        if d_r >= d_b:
            u.log(
                api_token, LOG_SCRIPT, "warning", "compute_diff_stroke_and_oil_volume",
                f"{name!r}: rod >= bore, {vol_col} set to NaN",
            )
            out[vol_col] = np.nan
            continue

        a_bore = bore_area_mm2(d_b)
        a_ann = annulus_area_mm2(d_b, d_r)
        vol_mm3 = pd.Series(np.nan, index=out.index, dtype='float64')
        valid = ds_oil.notna()

        if act_type == 'single':
            neg = valid & (ds_oil < 0)
            pos = valid & (ds_oil > 0)
            zero = valid & (ds_oil == 0)
            vol_mm3.loc[neg] = a_ann * ds_oil.loc[neg].abs()
            vol_mm3.loc[pos] = 0.0
            vol_mm3.loc[zero] = 0.0
        else:
            bore_on_pos = bool(s.get('pump_uses_bore_when_stroke_increases', True))
            pos = valid & (ds_oil > 0)
            neg = valid & (ds_oil < 0)
            zero = valid & (ds_oil == 0)
            if bore_on_pos:
                vol_mm3.loc[pos] = a_bore * ds_oil.loc[pos].abs()
                vol_mm3.loc[neg] = a_ann * ds_oil.loc[neg].abs()
            else:
                vol_mm3.loc[pos] = a_ann * ds_oil.loc[pos].abs()
                vol_mm3.loc[neg] = a_bore * ds_oil.loc[neg].abs()
            vol_mm3.loc[zero] = 0.0

        vol_l = vol_mm3 / 1_000_000.0
        stationary = valid & (ds_oil.abs() <= OIL_DS_EFFECTIVE_ZERO_MM)
        out[vol_col] = vol_l.mask(stationary, 0.0)

    return out


def compute_oil_volume_aggregate_columns(df: pd.DataFrame) -> pd.DataFrame:
    """
    Add OIL_VOL_*_TOTAL_L (port+stbd per function) and OIL_VOL_TOTAL_L (all eight per-stroke columns once).

    Row-wise: each *_TOTAL_L equals the sum of the corresponding OIL_VOL_*_L columns with null-aware rules
    (pandas sum(..., min_count=1): skip NaN; if both sides NaN the total is NaN; one side NaN yields the other).
    Uses pd.to_numeric(..., errors='coerce') so nullable/extension dtypes from upstream frames do not corrupt sums.
    """
    per_stroke_oil = [oil_vol_column_for_source(s['name']) for s in STROKES]
    oil_block: dict[str, pd.Series] = {}
    for col in per_stroke_oil:
        if col in df.columns:
            oil_block[col] = pd.to_numeric(df[col], errors='coerce')
        else:
            oil_block[col] = pd.Series(np.nan, index=df.index, dtype='float64')
    oil_df = pd.DataFrame(oil_block, index=df.index)

    for out_name, src_p, src_s in OIL_VOL_AGGREGATE_PAIRS:
        c_p = oil_vol_column_for_source(src_p)
        c_s = oil_vol_column_for_source(src_s)
        df[out_name] = oil_df[[c_p, c_s]].sum(axis=1, min_count=1)

    df[OIL_VOL_TOTAL_COLUMN] = oil_df.sum(axis=1, min_count=1)
    return df


def build_hydraulic_export_df(df: pd.DataFrame) -> pd.DataFrame:
    """
    Parquet: ts, optional Datetime, PER_* (0–100), STROKE_*_mm, DIFF_STROKE_*_mm,
    OIL_VOL_*_L (incremental L per timestep), OIL_VOL_*_TOTAL_L and OIL_VOL_TOTAL_L.
    """
    cols: list[str] = ['ts']
    if 'Datetime' in df.columns:
        cols.append('Datetime')

    pct_cols = [per_column_for_source(s['name']) for s in STROKES]
    stroke_cols = [stroke_column_for_source(s['name']) for s in STROKES]
    diff_cols = [diff_stroke_column_for_source(s['name']) for s in STROKES]
    oil_cols = [oil_vol_column_for_source(s['name']) for s in STROKES]
    oil_agg_tail = [t[0] for t in OIL_VOL_AGGREGATE_PAIRS] + [OIL_VOL_TOTAL_COLUMN]

    ordered = cols + pct_cols + stroke_cols + diff_cols + oil_cols + oil_agg_tail
    present = [c for c in ordered if c in df.columns]
    return df[present].copy()


def _filesystem_class_dir(class_name: str) -> str:
    """Lowercase class folder under DATA_DIRECTORY/system/... (matches file server paths)."""
    return str(class_name or '').strip().lower()


def _write_hydraulic_parquet(df_export, class_name, project_id, date, source_name):
    data_dir = os.getenv('DATA_DIRECTORY', 'C:/MyApps/Hunico/Uploads/Data')
    out_dir = os.path.join(
        data_dir, 'system', str(project_id), _filesystem_class_dir(class_name), date, source_name,
    )
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, 'hydraulic_systems_data_racesight.parquet')
    if os.path.exists(path):
        os.remove(path)
    out = df_export.copy()
    if 'Datetime' in out.columns:
        out['Datetime'] = format_datetime_series_racesight_parquet(out['Datetime'])
    out.to_parquet(path, engine='pyarrow')
    return path


if __name__ == "__main__":
    parameters_json = {}
    # True: run from IDE without argv — edit class_name / project_id / date / source_name below.
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

        df_pct = compute_percentages(df_raw)

        df_stroke = compute_strokes(df_pct)

        df_diffvol = compute_diff_stroke_and_oil_volume(df_stroke)

        compute_oil_volume_aggregate_columns(df_diffvol)

        df_export = build_hydraulic_export_df(df_diffvol)

        path = _write_hydraulic_parquet(df_export, class_name, project_id, date, source_name)

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
