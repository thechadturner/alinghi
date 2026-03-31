"""
3_corrections.py: Multi-sensor fusion calibration (CLI) — performance-model AWA.
Trains separate XGBoost models per tack × mode (port/stbd × upwind/downwind) on Bsp + Tws,
cross-interrogates port vs stbd models at matched conditions to derive a continuous AWA offset.
Excludes reaching (80–115 deg) from calibration; outputs corrected channels (_cor) and
Awa_offset_deg at 100ms to DATA_DIRECTORY.

Training uses Grade >= 2 only (minimum 100 samples per model). The apply phase loads all grades
in range, builds explicit offset channels (leeway and AWA), forward/back-fills those offsets
along time once, then corrects raw AWA/leeway so every row (including Grade 0/1) uses the same
propagated offsets before fusion and true-wind computation. AWS is not offset-corrected; fused
or raw AWS feeds fusion and true wind as-is.

Offset filtering: AWA grid offsets are filtered using exponential moving average (alpha=0.001)
before interpolation to row timestamps, similar to the smoothing applied to corrected TWS/TWD data.
This dampens rapid changes in offsets for more stable corrections. Leeway half-hour maps are not
EMA-filtered in the same way; low-grade segments inherit neighbor offsets via the shared
time-ordered ffill/bfill on offset columns in the full-grade dataframe.
"""

import pandas as pd
import numpy as np
import sys
import json
import os
from pathlib import Path

# Configure stdout/stderr to use UTF-8 encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

import utilities as u

from utilities.speed_units import (
    KNOTS_PER_KPH,
    aws_fused_norm_column,
    convert_speed_array,
    convert_speed_series,
)

from dotenv import load_dotenv

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (three levels up from server_python/scripts/ac40/)
project_root = Path(__file__).parent.parent.parent.parent

# Load environment files based on mode (same as 2_processing.py)
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"
base_env_path = project_root / base_env_file
local_env_path = project_root / local_env_file

load_dotenv(dotenv_path=base_env_path)
load_dotenv(dotenv_path=local_env_path, override=True)

api_token = os.getenv('SYSTEM_KEY')
if not api_token:
    raise RuntimeError("SYSTEM_KEY is missing from environment configuration.")

# Default multi-sensor and single-sensor fallback
DEFAULT_AWA_SENSORS = ['Awa_bow_deg', 'Awa_mhu_deg']
DEFAULT_AWS_SENSORS = ['Aws_bow_kph', 'Aws_mhu_kph']
FALLBACK_AWA_SENSORS = ['Awa_deg']
FALLBACK_AWS_SENSORS = ['Aws_kph']
LEEWAY_SENSOR = 'Lwy_deg'
FUSION_METHOD = 'robust'
OUTLIER_THRESHOLD = 2.0

# kph → knots (same as utilities.speed_units.KNOTS_PER_KPH)
KPH_TO_KTS = KNOTS_PER_KPH


def _norm_speed_unit(u: str) -> str:
    return u if u in ('kph', 'kts') else 'kph'


def _fused_to_cor_map(speed_unit: str) -> dict:
    u = _norm_speed_unit(speed_unit)
    return {
        'Awa_fused_deg': 'Awa_cor_deg',
        f'Aws_fused_{u}': f'Aws_cor_{u}',
        f'Tws_fused_{u}': f'Tws_cor_{u}',
        'Twa_fused_deg': 'Twa_cor_deg',
        'Twd_fused_deg': 'Twd_cor_deg',
    }


def _aws_fallback_cols(speed_unit: str):
    u = _norm_speed_unit(speed_unit)
    return [
        aws_fused_norm_column(u),
        f'Aws_{u}',
        f'Aws_bow_{u}',
        f'Aws_mhu_{u}',
    ]


def _sensor_name_to_cor_column(sensor_name: str) -> str:
    for raw_suf, cor_suf in (('_deg', '_cor_deg'), ('_kph', '_cor_kph'), ('_kts', '_cor_kts')):
        if sensor_name.endswith(raw_suf):
            return sensor_name[: -len(raw_suf)] + cor_suf
    return sensor_name


def _bow_mhu_aws_pairs(speed_unit: str):
    u = _norm_speed_unit(speed_unit)
    return [('Awa_bow_deg', f'Aws_bow_{u}'), ('Awa_mhu_deg', f'Aws_mhu_{u}')]


def _bsp_series_for_unit(df: pd.DataFrame, speed_unit: str):
    u = _norm_speed_unit(speed_unit)
    col = f'Bsp_{u}'
    other_u = 'kts' if u == 'kph' else 'kph'
    other_col = f'Bsp_{other_u}'
    if col in df.columns:
        return pd.to_numeric(df[col], errors='coerce').to_numpy(dtype=np.float64)
    if other_col in df.columns:
        v = pd.to_numeric(df[other_col], errors='coerce').to_numpy(dtype=np.float64)
        return convert_speed_array(v, other_u, u)
    return None


def _bsp_values_as_kph_for_vmg(df: pd.DataFrame):
    """Prefer Bsp_kph for VMG / target % columns (chart contract)."""
    if 'Bsp_kph' in df.columns:
        return pd.to_numeric(df['Bsp_kph'], errors='coerce').to_numpy(dtype=np.float64)
    if 'Bsp_kts' in df.columns:
        v = pd.to_numeric(df['Bsp_kts'], errors='coerce').to_numpy(dtype=np.float64)
        return convert_speed_array(v, 'kts', 'kph')
    return None

# Exponential filter alpha for TWS/TWD smoothing - matches normalization's smoothing.
SMOOTH_SECONDS = 10  # Same as 1_normalization_influx.py
RS_PERIOD_SEC = 0.1  # 100ms
EMA_ALPHA = 0.001

def _reindex_fill_numeric_columns(df_idx: pd.DataFrame) -> None:
    """In-place: angles (*_deg), Grade, and offset-step columns use ffill/bfill; other numerics linear."""
    for col in df_idx.columns:
        s = df_idx[col]
        if not pd.api.types.is_numeric_dtype(s):
            continue
        if col == 'Grade':
            df_idx[col] = s.ffill().bfill().round()
        elif (
            col.endswith('_deg')
            or col.startswith('Awa_offset__')
            or col.endswith('_cor_kph')
            or col.endswith('_cor_kts')
        ):
            df_idx[col] = s.ffill().bfill()
        else:
            df_idx[col] = s.interpolate(method='linear', limit_direction='both')


# Channels needed for fallback (uncorrected data as _cor when pipeline fails).
FALLBACK_CHANNELS = [
    {'name': 'ts', 'type': 'float'},
    {'name': 'Tws_kts', 'type': 'float'},
    {'name': 'Twd_deg', 'type': 'angle360'},
    {'name': 'Twa_deg', 'type': 'angle180'},
    {'name': 'Awa_deg', 'type': 'angle180'},
    {'name': 'Aws_kph', 'type': 'float'},
    {'name': 'Lwy_deg', 'type': 'float'},
    {'name': 'Hdg_deg', 'type': 'angle360'},
    {'name': 'Bsp_kts', 'type': 'float'},
    {'name': 'Twa_bow_deg', 'type': 'angle180'},
    {'name': 'Twa_mhu_deg', 'type': 'angle180'},
    {'name': 'Twd_bow_deg', 'type': 'angle360'},
    {'name': 'Twd_mhu_deg', 'type': 'angle360'},
]

TARGET_CHANNELS = [
    {'name': 'Bsp_kph', 'type': 'float'},
    {'name': 'Bsp_tgt_kph', 'type': 'float'},
    {'name': 'Vmg_tgt_kph', 'type': 'float'},
]


def get_processed_data_ts_range(class_name, project_id, date, source_name):
    """Load processed_data_racesight.parquet and return (ts_min, ts_max, ts_series)."""
    data_dir = os.getenv('DATA_DIRECTORY', 'C:/MyApps/Hunico/Uploads/Data')
    date_str = str(date).replace('-', '').replace('/', '')
    dir_path = os.path.join(data_dir, 'System', str(project_id), class_name, date_str, source_name)
    path = os.path.join(dir_path, 'processed_data_racesight.parquet')
    if not os.path.exists(path):
        return None, None, None
    try:
        df = pd.read_parquet(path, columns=['ts'])
        if df is None or len(df) == 0:
            return None, None, None
        ts = df['ts'].dropna()
        if len(ts) == 0:
            return None, None, None
        return float(ts.min()), float(ts.max()), ts
    except Exception:
        return None, None, None


def get_canonical_ts_for_fusion(class_name, project_id, date, source_name):
    """
    Timestamp grid for fusion output: prefer processed_data_racesight.parquet (100ms norm stream);
    if missing, try Influx tier parquets (legacy influx_data.parquet or influx_data_*hz) for reindex.
    """
    proc_min, proc_max, proc_ts = get_processed_data_ts_range(class_name, project_id, date, source_name)
    if proc_ts is not None and len(proc_ts) > 0:
        return proc_min, proc_max, proc_ts
    data_dir = os.getenv('DATA_DIRECTORY', 'C:/MyApps/Hunico/Uploads/Data')
    date_str = str(date).replace('-', '').replace('/', '')
    dir_path = os.path.join(data_dir, 'System', str(project_id), class_name, date_str, source_name)
    influx_path = None
    for fname in (
        'influx_data.parquet',
        'influx_data_raw.parquet',
        'influx_data_10hz.parquet',
        'influx_data_1hz.parquet',
    ):
        p = os.path.join(dir_path, fname)
        if os.path.exists(p):
            influx_path = p
            break
    if not influx_path:
        return None, None, None
    try:
        df = pd.read_parquet(influx_path, columns=['ts'])
        if df is None or len(df) == 0:
            return None, None, None
        ts = df['ts'].dropna()
        if len(ts) == 0:
            return None, None, None
        return float(ts.min()), float(ts.max()), ts
    except Exception:
        return None, None, None


def _recompute_primary_true_wind_on_output_grid(df_out, df_final, speed_unit='kph'):
    """
    After reindex to processed ts: recompute fused true wind from corrected AWA/AWS/leeway and
    boat state merged from df_final (Bsp in ``speed_unit``). Requires Hdg_deg on df_out (before add_cse_cwa).
    """
    if df_out is None or len(df_out) == 0 or 'ts' not in df_out.columns:
        return df_out
    u = _norm_speed_unit(speed_unit)
    aws_cor = f'Aws_cor_{u}'
    tws_cor = f'Tws_cor_{u}'
    need = ('Awa_cor_deg', aws_cor, 'Lwy_cor_deg', 'Hdg_deg')
    if not all(c in df_out.columns for c in need):
        return df_out
    bsp_col = f'Bsp_{u}'
    other_u = 'kts' if u == 'kph' else 'kph'
    other_col = f'Bsp_{other_u}'
    if bsp_col in df_final.columns:
        bsp_src = df_final[['ts', bsp_col]].copy()
    elif other_col in df_final.columns:
        bsp_src = df_final[['ts', other_col]].copy()
        bsp_src[bsp_col] = convert_speed_series(bsp_src[other_col], other_u, u)
        bsp_src = bsp_src[['ts', bsp_col]]
    else:
        u.log(api_token, "3_corrections.py", "warning", "pipeline",
              "Skipping full-grid TW recompute: no Bsp_kph/Bsp_kts in fusion dataframe")
        return df_out
    bsp_src['ts'] = pd.to_numeric(bsp_src['ts'], errors='coerce').round(3)
    bsp_src = bsp_src.drop_duplicates(subset=['ts'], keep='last')
    out_ts = pd.to_numeric(df_out['ts'], errors='coerce').round(3)
    merged = pd.DataFrame({'ts': out_ts.values}).merge(bsp_src, on='ts', how='left')
    stw = pd.to_numeric(merged[bsp_col], errors='coerce')
    stw = stw.ffill().bfill()
    from utilities.wind_utils import computeTrueWind_vectorized
    aws = pd.to_numeric(df_out[aws_cor], errors='coerce')
    awa = pd.to_numeric(df_out['Awa_cor_deg'], errors='coerce')
    hdg = pd.to_numeric(df_out['Hdg_deg'], errors='coerce')
    lwy = pd.to_numeric(df_out['Lwy_cor_deg'], errors='coerce')
    tws, twa, twd = computeTrueWind_vectorized(
        aws=aws.values,
        awa=awa.values,
        stw=stw.values,
        hdg=hdg.values,
        lwy=lwy.values,
    )
    df_out[tws_cor] = tws
    df_out['Twa_cor_deg'] = twa
    df_out['Twd_cor_deg'] = twd
    return df_out


def _merge_calibrated_lwy_hdg_from_final(df_out, df_final):
    """
    Map fusion-time calibrated Lwy and heading onto df_out.ts (canonical grid), same idea as
    merging Bsp for TW: avoids relying on reindex fill alone when API vs parquet timestamps differ.
    Writes Lwy_cor_deg from df_final['Lwy_deg'] (already offset-corrected in the pipeline).
    """
    if (
        df_out is None
        or len(df_out) == 0
        or df_final is None
        or len(df_final) == 0
        or 'ts' not in df_out.columns
    ):
        return df_out
    cols = []
    if 'Lwy_deg' in df_final.columns:
        cols.append('Lwy_deg')
    if 'Hdg_deg' in df_final.columns:
        cols.append('Hdg_deg')
    if not cols:
        return df_out
    src = df_final[['ts'] + cols].copy()
    src['ts'] = pd.to_numeric(src['ts'], errors='coerce').round(3)
    src = src.drop_duplicates(subset=['ts'], keep='last')
    out_ts = pd.to_numeric(df_out['ts'], errors='coerce').round(3)
    merged = pd.DataFrame({'ts': out_ts.values}).merge(src, on='ts', how='left')
    if 'Lwy_deg' in cols:
        v = pd.to_numeric(merged['Lwy_deg'], errors='coerce').ffill().bfill()
        df_out['Lwy_cor_deg'] = v.to_numpy(dtype=np.float64, copy=False)
    if 'Hdg_deg' in cols:
        v = pd.to_numeric(merged['Hdg_deg'], errors='coerce').ffill().bfill()
        df_out['Hdg_deg'] = v.to_numpy(dtype=np.float64, copy=False)
    return df_out


def _finalize_fusion_geometry(df_out):
    """
    After full-grid TW recompute: smooth TWS/TWD (and recorded AWA offset), then derive
    Lwy_n_cor_deg, Cse_cor_deg, Cwa_cor_deg, Cwa_n_cor_deg and normalized _cor angles on the same grid.
    """
    df_out = apply_exponential_filter_tws_twd(df_out)
    df_out = apply_exponential_filter_awa_offset(df_out)
    df_out = add_cse_cwa_leeway_columns(df_out)
    df_out = add_normalized_cor_columns(df_out)
    df_out = add_normalized_pre_leeway_from_offsets(df_out)
    return df_out


def run_corrections_pipeline(class_name, project_id, date, source_name,
                            start_ts=None, end_ts=None, verbose=False,
                            ts_grid=None,
                            window_sec=30 * 60, step_sec=60,
                            model_update_interval_sec=30 * 60, min_samples_per_model=100,
                            speed_unit=None):
    """
    Run multi-sensor fusion calibration (performance-model AWA).
    Returns DataFrame on the canonical ts grid (when available) with _cor channels, offsets,
    recomputed primary true wind, and leeway/course geometry columns (Lwy_cor_deg, Lwy_n_cor_deg,
    Cse_cor_deg, Cwa_cor_deg, Cwa_n_cor_deg, Awa_n_cor_deg, Twa_n_cor_deg, Lwy_n_deg) after EMA.

    Args:
        window_sec: Trailing window length in seconds for query condition extraction
        step_sec: Grid step in seconds
        model_update_interval_sec: Interval (seconds) between model retraining
        min_samples_per_model: Minimum samples per model for training
        speed_unit: ``None`` / ``'auto'`` infer from channel suffixes; ``'kph'`` / ``'kts'`` forces unit.
    """
    from utilities.cal_utils import CalibrationConfig, calibrate_and_fuse_pipeline

    date_str = str(date).replace('-', '').replace('/', '')

    su_cfg = None
    if speed_unit in ('kph', 'kts'):
        su_cfg = speed_unit
    elif speed_unit not in (None, 'auto'):
        u.log(api_token, "3_corrections.py", "warning", "parameters",
              f"Invalid speed_unit {speed_unit!r}; using auto (infer from channels).")

    proc_min, proc_max, proc_ts = get_canonical_ts_for_fusion(class_name, project_id, date, source_name)
    if proc_min is not None and proc_max is not None:
        cfg_start = proc_min
        cfg_end = proc_max
        if verbose:
            u.log(api_token, "3_corrections.py", "info", "pipeline",
                  f"Using processed_data ts range [{proc_min:.1f}, {proc_max:.1f}] as basis")
    else:
        cfg_start = start_ts
        cfg_end = end_ts

    config = CalibrationConfig(
        api_token=api_token,
        class_name=class_name,
        project_id=str(project_id),
        date=date_str,
        source_name=source_name,
        rs='100ms',
        timezone='UTC',
        start_ts=cfg_start,
        end_ts=cfg_end,
        speed_unit=su_cfg,
    )

    for awa_sensors, aws_sensors in [
        (DEFAULT_AWA_SENSORS, DEFAULT_AWS_SENSORS),
        (FALLBACK_AWA_SENSORS, FALLBACK_AWS_SENSORS),
    ]:
        try:
            results = calibrate_and_fuse_pipeline(
                config=config,
                awa_sensors=awa_sensors,
                aws_sensors=aws_sensors,
                lwy_sensor=LEEWAY_SENSOR,
                fusion_method=FUSION_METHOD,
                outlier_threshold=OUTLIER_THRESHOLD,
                window_sec=window_sec,
                step_sec=step_sec,
                model_update_interval_sec=model_update_interval_sec,
                min_samples_per_model=min_samples_per_model,
            )
            break
        except ValueError as e:
            err_msg = str(e)
            if "No sensors successfully calibrated" in err_msg or "none of the requested sensors" in err_msg.lower():
                continue
            raise
        except Exception as e:
            if "not found in DataFrame" in str(e) or "None of the requested sensors" in str(e):
                continue
            raise
    else:
        u.log(api_token, "3_corrections.py", "error", "pipeline",
              "No sensors successfully calibrated (tried multi and single-sensor)")
        raise ValueError("No sensors successfully calibrated")

    df_final = results['data']

    if proc_ts is not None and len(proc_ts) > 0:
        n_grid = len(pd.Series(proc_ts).dropna().unique())
        n_f = len(df_final)
        if n_grid != n_f:
            msg = (
                f"Fusion pipeline row count {n_f} != canonical ts grid {n_grid} "
                f"(processed_data or influx_data parquet); reindex will align output."
            )
            u.log(api_token, "3_corrections.py", "warning", "pipeline", msg)
            if verbose:
                print(msg, flush=True)

    df_out = df_final[['ts']].copy()
    multi_results = results['multi_sensor_results']
    best_tr = multi_results['recommended_sensors'][0]
    fuse_unit = _norm_speed_unit(
        multi_results['sensor_calibrations'][best_tr]['calibration'].get('speed_unit', 'kph')
    )
    fused_to_cor = _fused_to_cor_map(fuse_unit)
    aws_cor = f'Aws_cor_{fuse_unit}'
    tws_cor = f'Tws_cor_{fuse_unit}'
    fused_keys_vals = set(fused_to_cor.keys()) | set(fused_to_cor.values())
    # Carry Grade (and race metadata) into fusion parquet so _cor channels align with Grade on the
    # same row when charts query fusion alone or when DuckDB merge keys differ slightly from processed_data.
    for _meta in ('Grade', 'Race_number', 'Leg_number'):
        if _meta in df_final.columns and _meta not in df_out.columns:
            df_out[_meta] = df_final[_meta].values
    for fused_col, cor_col in fused_to_cor.items():
        if fused_col in df_final.columns:
            df_out[cor_col] = df_final[fused_col].values
    # Fusion is often NaN on Grade < 2 when a sensor drops out; offsets still apply to best_sensor
    # / Aws — use calibrated singles so _cor channels stay continuous after offset propagation.
    if 'Awa_cor_deg' in df_out.columns and 'Awa_deg' in df_final.columns:
        fus = pd.to_numeric(df_out['Awa_cor_deg'], errors='coerce')
        fb = pd.to_numeric(df_final['Awa_deg'], errors='coerce')
        df_out['Awa_cor_deg'] = fus.combine_first(fb).to_numpy()
    if aws_cor in df_out.columns:
        fus = pd.to_numeric(df_out[aws_cor], errors='coerce')
        aws_fb = None
        for c in _aws_fallback_cols(fuse_unit):
            if c in df_final.columns:
                aws_fb = pd.to_numeric(df_final[c], errors='coerce')
                break
        if aws_fb is not None:
            df_out[aws_cor] = fus.combine_first(aws_fb).to_numpy()
    n = len(df_out)
    if 'Twd_cor_deg' not in df_out.columns:
        if 'Twd_deg' in df_final.columns:
            df_out['Twd_cor_deg'] = df_final['Twd_deg'].values
        elif 'Hdg_deg' in df_final.columns and 'Twa_fused_deg' in df_final.columns:
            twd = (df_final['Hdg_deg'].values + df_final['Twa_fused_deg'].values)
            df_out['Twd_cor_deg'] = ((twd % 360) + 360) % 360
        elif 'Hdg_deg' in df_final.columns:
            df_out['Twd_cor_deg'] = df_final['Hdg_deg'].values
        else:
            df_out['Twd_cor_deg'] = np.zeros(n)
    if tws_cor not in df_out.columns:
        tws_src = f'Tws_{fuse_unit}'
        if tws_src in df_final.columns:
            df_out[tws_cor] = pd.to_numeric(df_final[tws_src], errors='coerce').to_numpy(dtype=np.float64, copy=True)
        elif fuse_unit == 'kph' and 'Tws_kts' in df_final.columns:
            v = pd.to_numeric(df_final['Tws_kts'], errors='coerce').to_numpy(dtype=np.float64, copy=True)
            df_out[tws_cor] = convert_speed_array(v, 'kts', 'kph')
        elif fuse_unit == 'kts' and 'Tws_kph' in df_final.columns:
            v = pd.to_numeric(df_final['Tws_kph'], errors='coerce').to_numpy(dtype=np.float64, copy=True)
            df_out[tws_cor] = convert_speed_array(v, 'kph', 'kts')
        else:
            df_out[tws_cor] = np.zeros(n)
    if 'Twa_cor_deg' not in df_out.columns:
        df_out['Twa_cor_deg'] = df_final['Twa_deg'].values if 'Twa_deg' in df_final.columns else np.zeros(n)
    if 'Awa_cor_deg' not in df_out.columns:
        df_out['Awa_cor_deg'] = df_final['Awa_deg'].values if 'Awa_deg' in df_final.columns else np.zeros(n)
    if aws_cor not in df_out.columns:
        raw_aws = f'Aws_{fuse_unit}'
        if raw_aws in df_final.columns:
            df_out[aws_cor] = df_final[raw_aws].values
        elif fuse_unit == 'kph' and 'Aws_kph' in df_final.columns:
            df_out[aws_cor] = df_final['Aws_kph'].values
        elif fuse_unit == 'kts' and 'Aws_kts' in df_final.columns:
            df_out[aws_cor] = df_final['Aws_kts'].values
        else:
            df_out[aws_cor] = np.zeros(n)
    if 'Lwy_cor_deg' not in df_out.columns:
        df_out['Lwy_cor_deg'] = df_final['Lwy_deg'].values if 'Lwy_deg' in df_final.columns else np.zeros(n)
    if 'Hdg_deg' in df_final.columns:
        df_out['Hdg_deg'] = df_final['Hdg_deg'].values

    if 'Awa_offset_deg' in df_final.columns:
        df_out['Awa_offset_deg'] = df_final['Awa_offset_deg'].values
    for _oc in ('Lwy_offset_norm_deg', 'Lwy_offset_deg'):
        if _oc in df_final.columns:
            df_out[_oc] = df_final[_oc].values
    for col in df_final.columns:
        if col.startswith('Awa_offset__') and col not in df_out.columns:
            df_out[col] = df_final[col].values

    for pre_col in ('Awa_n_fused_deg', aws_fused_norm_column(fuse_unit), 'Awa_fused_pre_deg'):
        if pre_col in df_final.columns:
            df_out[pre_col] = df_final[pre_col].values

    for sensor in multi_results.get('recommended_sensors', []):
        if sensor in df_final.columns:
            if sensor.endswith('_deg'):
                df_out[_sensor_name_to_cor_column(sensor)] = df_final[sensor].values
            elif sensor.endswith('_kph') or sensor.endswith('_kts'):
                df_out[_sensor_name_to_cor_column(sensor)] = df_final[sensor].values
    for col in df_final.columns:
        if col in df_out.columns:
            continue
        if ('bow' in col or 'mhu' in col) and col not in fused_keys_vals:
            if col.endswith('_deg'):
                df_out[_sensor_name_to_cor_column(col)] = df_final[col].values
            elif col.endswith('_kph') or col.endswith('_kts'):
                df_out[_sensor_name_to_cor_column(col)] = df_final[col].values

    stw = _bsp_series_for_unit(df_final, fuse_unit)
    required_for_tw = ['Hdg_deg', 'Lwy_deg']
    if stw is not None and all(c in df_final.columns for c in required_for_tw):
        from utilities.wind_utils import computeTrueWind_vectorized
        hdg = df_final['Hdg_deg'].values
        lwy = df_final['Lwy_deg'].values
        for awa_col, aws_col in _bow_mhu_aws_pairs(fuse_unit):
            if awa_col in df_final.columns and aws_col in df_final.columns:
                tws, twa, twd = computeTrueWind_vectorized(
                    aws=df_final[aws_col].values,
                    awa=df_final[awa_col].values,
                    stw=stw,
                    hdg=hdg,
                    lwy=lwy
                )
                suffix = 'bow' if 'bow' in awa_col else 'mhu'
                df_out[f'Tws_{suffix}_cor_{fuse_unit}'] = tws
                df_out[f'Twa_{suffix}_cor_deg'] = twa
                df_out[f'Twd_{suffix}_cor_deg'] = twd

    if 'ts' in df_out.columns and len(df_out) > 0:
        ts = df_out['ts']
        if ts.dtype == 'Float64':
            df_out['ts'] = ts.astype('float64')
        df_out['ts'] = df_out['ts'].round(3)

    if proc_ts is not None and len(proc_ts) > 0 and len(df_out) > 0:
        proc_ts_sorted = np.sort(proc_ts.dropna().unique())
        df_out = df_out.set_index('ts')
        df_out = df_out.reindex(proc_ts_sorted)
        _reindex_fill_numeric_columns(df_out)
        df_out = df_out.reset_index()
        df_out['ts'] = df_out['ts'].round(3)

    if len(df_out) > 0:
        df_out = _merge_calibrated_lwy_hdg_from_final(df_out, df_final)
        # Fill before recompute: ensures Aws_cor_* and Lwy_cor_deg are non-NaN
        # for Grade 0/1 rows with absent sensors so the recompute has valid inputs.
        _reindex_fill_numeric_columns(df_out)
        df_out = _recompute_primary_true_wind_on_output_grid(df_out, df_final, fuse_unit)
        # Fill after recompute: any rows still NaN (both sensors genuinely absent)
        # inherit the nearest-in-time corrected values (ffill/bfill) so ALL grades
        # have valid _cor channels before derived geometry columns are computed.
        _reindex_fill_numeric_columns(df_out)
        df_out = _finalize_fusion_geometry(df_out)

    return df_out, results


def add_cse_cwa_leeway_columns(df_out):
    """Compute Cse_cor_deg, Cwa_cor_deg, Lwy_n_cor_deg, Cwa_n_cor_deg. Drops Hdg_deg after use."""
    if df_out is None or len(df_out) == 0:
        return df_out
    if 'Twa_cor_deg' not in df_out.columns:
        return df_out
    sign_twa = np.sign(df_out['Twa_cor_deg'].values)
    sign_twa[sign_twa == 0] = 1

    if 'Lwy_cor_deg' in df_out.columns:
        df_out['Lwy_n_cor_deg'] = df_out['Lwy_cor_deg'].values * sign_twa

    if 'Hdg_deg' in df_out.columns and 'Lwy_cor_deg' in df_out.columns:
        hdg = df_out['Hdg_deg'].values
        lwy = df_out['Lwy_cor_deg'].values
        
        # Course through water = Heading - Leeway
        # Leeway convention: Lwy = HDG - COG (positive = drift to port on starboard tack)
        # Therefore: COG = HDG - Lwy,  and CSE ≈ COG  →  CSE = HDG - Lwy
        #
        # NOTE: If the instrument stores Lwy as COG - HDG (opposite convention), then
        # on starboard: Lwy_stored < 0 when it should be > 0. In that case, we would need
        # to negate: lwy = -lwy before computing CSE. However, if Lwy_n is positive (as
        # the user reports), then Lwy_cor must be positive on starboard, so the convention
        # appears correct. If TWA > CWA is still observed, check for calibration bugs
        # (e.g. the single-tack fallback in optimize_leeway_offsets that was fixed).
        cse = ((hdg - lwy) + 180) % 360 - 180
        cse[cse == -180] = 180
        df_out['Cse_cor_deg'] = cse
        if 'Twd_cor_deg' in df_out.columns:
            twd = df_out['Twd_cor_deg'].values
            # Course Wind Angle = True Wind Direction - Course through water
            # Algebraic relationship: CWA = TWA + Lwy_raw (always, by substitution)
            # Derivation: TWA = TWD - HDG,  CSE = HDG - Lwy  →  CWA = TWD - CSE = TWA + Lwy
            #
            # In NORMALIZED space (Lwy_n = Lwy_raw * sign(TWA)):
            #   CWA_n = CWA * sign(TWA) = (TWA + Lwy_raw) * sign(TWA) = TWA_n + Lwy_n
            #   ∴ CWA_n > TWA_n whenever Lwy_n > 0 (always true for physical leeway)
            #
            # If CWA_n < TWA_n is observed with positive Lwy_n, possible causes:
            # 1. Stored Lwy_cor has wrong sign (COG - HDG instead of HDG - COG) → negate Lwy
            # 2. Calibration bug applied wrong offset to missing-tack rows (fixed in optimize_leeway_offsets)
            # 3. TWD_cor computation error (check computeTrueWind_vectorized)
            cwa = ((twd - cse) + 180) % 360 - 180
            cwa[cwa == -180] = 180
            df_out['Cwa_cor_deg'] = cwa
            df_out['Cwa_n_cor_deg'] = cwa * sign_twa
        df_out.drop(columns=['Hdg_deg'], inplace=True, errors='ignore')

    return df_out


def add_normalized_cor_columns(df_out):
    """Add Awa_n_cor_deg, Twa_n_cor_deg (value * sign(Twa_cor_deg))."""
    if df_out is None or len(df_out) == 0:
        return df_out
    if 'Twa_cor_deg' not in df_out.columns:
        return df_out
    sign_twa = np.sign(df_out['Twa_cor_deg'].values)
    sign_twa[sign_twa == 0] = 1
    if 'Awa_cor_deg' in df_out.columns:
        df_out['Awa_n_cor_deg'] = df_out['Awa_cor_deg'].values * sign_twa
    df_out['Twa_n_cor_deg'] = df_out['Twa_cor_deg'].values * sign_twa
    return df_out


def add_normalized_pre_leeway_from_offsets(df_out):
    """
    Lwy_n_deg on the fusion output grid: normalized corrected leeway minus propagated offset.
    Matches apply_lwy_calibration_using_offsets (avoids merged processed_data linear artifacts for Grade < 2).
    """
    if df_out is None or len(df_out) == 0:
        return df_out
    if 'Lwy_n_cor_deg' not in df_out.columns or 'Lwy_offset_norm_deg' not in df_out.columns:
        return df_out
    cor = pd.to_numeric(df_out['Lwy_n_cor_deg'], errors='coerce').to_numpy(dtype=np.float64)
    off = pd.to_numeric(df_out['Lwy_offset_norm_deg'], errors='coerce').to_numpy(dtype=np.float64)
    df_out['Lwy_n_deg'] = cor - off
    return df_out


def apply_exponential_filter_tws_twd(df_out, alpha=EMA_ALPHA):
    """Apply EMA to TWS/TWD _cor columns."""
    if df_out is None or len(df_out) == 0:
        return df_out
    if alpha is None or alpha <= 0 or alpha > 1:
        return df_out
    tws_cols = [
        c for c in df_out.columns
        if c.startswith('Tws_') and (c.endswith('_cor_kph') or c.endswith('_cor_kts'))
    ]
    twd_cols = [c for c in df_out.columns if c.startswith('Twd_') and c.endswith('_cor_deg')]
    for col in tws_cols:
        vals = df_out[col].values.astype(float)
        if np.any(~np.isnan(vals)):
            smoothed = pd.Series(vals, dtype=float).ewm(alpha=alpha, adjust=False).mean().values
            df_out[col] = smoothed
    for col in twd_cols:
        vals = df_out[col].values.astype(float)
        if np.any(~np.isnan(vals)):
            smoothed = u.ewm360(vals, alpha, adjust=False)
            df_out[col] = smoothed
    return df_out


def apply_exponential_filter_awa_offset(df_out, alpha=EMA_ALPHA):
    """
    Apply EMA to Awa_offset_deg to smooth recorded offset values.
    
    Note: Offsets are already filtered before application in the calibration pipeline
    (cal_utils.py). This function smooths the recorded offset values for consistency
    with the corrected data smoothing, but does not affect the corrected data itself.
    """
    if df_out is None or len(df_out) == 0:
        return df_out
    if alpha is None or alpha <= 0 or alpha > 1:
        return df_out
    if 'Awa_offset_deg' not in df_out.columns:
        return df_out
    vals = df_out['Awa_offset_deg'].values.astype(float)
    if np.any(~np.isnan(vals)):
        smoothed = pd.Series(vals, dtype=float).ewm(alpha=alpha, adjust=False).mean().values
        df_out['Awa_offset_deg'] = smoothed
    return df_out


def load_and_merge_target_channels(df_out, class_name, project_id, date, source_name,
                                   start_ts=None, end_ts=None):
    """Fetch Bsp_tgt_kph, Vmg_tgt_kph and merge into df_out by ts."""
    if df_out is None or len(df_out) == 0:
        return df_out
    try:
        df_tgt = u.get_channel_values(
            api_token, class_name, project_id, date, source_name,
            TARGET_CHANNELS, '100ms', start_ts, end_ts, 'UTC'
        )
        if df_tgt is None or len(df_tgt) == 0:
            return df_out
        if 'Bsp_tgt_kph' not in df_tgt.columns and 'Vmg_tgt_kph' not in df_tgt.columns:
            return df_out
        ts_tgt = df_tgt['ts'].dropna()
        if len(ts_tgt) > 0 and ts_tgt.max() > 1e12:
            df_tgt = df_tgt.copy()
            df_tgt['ts'] = (df_tgt['ts'] / 1000.0).round(3)
        else:
            df_tgt = df_tgt.copy()
            df_tgt['ts'] = df_tgt['ts'].round(3)
        merge_cols = [c for c in ['Bsp_kph', 'Bsp_tgt_kph', 'Vmg_tgt_kph'] if c in df_tgt.columns]
        df_out = df_out.merge(df_tgt[['ts'] + merge_cols], on='ts', how='left')
    except Exception:
        pass
    return df_out


def add_target_corrections(df, update_tgt=False):
    """Output Bsp_tgt_cor_*, Vmg_tgt_cor_* from target channels."""
    if df is None or len(df) == 0:
        return df
    if 'Bsp_tgt_kph' in df.columns:
        if update_tgt:
            df['Bsp_tgt_cor_kph'] = np.abs(df['Bsp_tgt_kph'].values * KPH_TO_KTS)
        else:
            df['Bsp_tgt_cor_kph'] = np.abs(df['Bsp_tgt_kph'].values)
        df['Bsp_tgt_cor_kts'] = np.abs(df['Bsp_tgt_cor_kph'].values * KPH_TO_KTS)
    if 'Vmg_tgt_kph' in df.columns:
        if update_tgt:
            df['Vmg_tgt_cor_kph'] = np.abs(df['Vmg_tgt_kph'].values * KPH_TO_KTS)
        else:
            df['Vmg_tgt_cor_kph'] = np.abs(df['Vmg_tgt_kph'].values)
        df['Vmg_tgt_cor_kts'] = np.abs(df['Vmg_tgt_cor_kph'].values * KPH_TO_KTS)
    return df


def add_vmg_bsp_perc_columns(df):
    """Compute Vmg_cor_kph, Vmg_cor_perc, Bsp_cor_perc."""
    if df is None or len(df) == 0:
        return df
    bsp_kph = _bsp_values_as_kph_for_vmg(df)
    if bsp_kph is not None and 'Cwa_cor_deg' in df.columns:
        cwa = np.radians(pd.to_numeric(df['Cwa_cor_deg'], errors='coerce').to_numpy(dtype=np.float64))
        df['Vmg_cor_kph'] = np.abs(bsp_kph * np.cos(cwa))
        df['Vmg_cor_kts'] = np.abs(convert_speed_array(bsp_kph, 'kph', 'kts') * np.cos(cwa))
    if 'Vmg_cor_kph' in df.columns and 'Vmg_tgt_cor_kph' in df.columns:
        tgt = df['Vmg_tgt_cor_kph'].values
        df['Vmg_cor_perc'] = np.where(tgt != 0, (df['Vmg_cor_kph'].values / tgt) * 100, 0)
        df['Vmg_cor_perc'] = df['Vmg_cor_perc'].clip(lower=0, upper=150)
    if bsp_kph is not None and 'Bsp_tgt_cor_kph' in df.columns:
        tgt = df['Bsp_tgt_cor_kph'].values
        df['Bsp_cor_perc'] = np.where(tgt != 0, (bsp_kph / tgt) * 100, 0)
        df['Bsp_cor_perc'] = df['Bsp_cor_perc'].clip(lower=0, upper=150)
    return df


def get_fallback_corrections_data(class_name, project_id, date, source_name,
                                  start_ts=None, end_ts=None):
    """Load uncorrected wind data and return DataFrame with _cor column names (no Awa_offset_deg)."""
    df = pd.DataFrame()
    try:
        dfi = u.get_channel_values(
            api_token, class_name, project_id, date, source_name,
            FALLBACK_CHANNELS, '100ms', start_ts, end_ts, 'UTC'
        )
        if dfi is None or len(dfi) == 0:
            return df
        if dfi['ts'].dtype == 'Float64':
            dfi['ts'] = dfi['ts'].astype('float64')
        ts_sample = dfi['ts'].dropna()
        if len(ts_sample) > 0 and ts_sample.max() > 1e12:
            dfi['ts'] = (dfi['ts'] / 1000.0).round(3)
        else:
            dfi['ts'] = dfi['ts'].round(3)
        if 'Bsp_kts' in dfi.columns:
            dfi = u.remove_gaps(dfi, 'Bsp_kts', 'ts')
        df_out = pd.DataFrame()
        df_out['ts'] = dfi['ts'].values
        n = len(df_out)
        if 'Tws_kts' in dfi.columns:
            v = pd.to_numeric(dfi['Tws_kts'], errors='coerce').to_numpy(dtype=np.float64, copy=True)
            df_out['Tws_cor_kph'] = convert_speed_array(v, 'kts', 'kph')
        else:
            df_out['Tws_cor_kph'] = np.zeros(n)
        if 'Twd_deg' in dfi.columns:
            df_out['Twd_cor_deg'] = dfi['Twd_deg'].values
        elif 'Hdg_deg' in dfi.columns and 'Twa_deg' in dfi.columns:
            twd = (dfi['Hdg_deg'].values + dfi['Twa_deg'].values)
            df_out['Twd_cor_deg'] = ((twd % 360) + 360) % 360
        elif 'Hdg_deg' in dfi.columns:
            df_out['Twd_cor_deg'] = dfi['Hdg_deg'].values
        else:
            df_out['Twd_cor_deg'] = np.zeros(n)
        df_out['Twa_cor_deg'] = dfi['Twa_deg'].values if 'Twa_deg' in dfi.columns else np.zeros(n)
        df_out['Awa_cor_deg'] = dfi['Awa_deg'].values if 'Awa_deg' in dfi.columns else np.zeros(n)
        df_out['Aws_cor_kph'] = dfi['Aws_kph'].values if 'Aws_kph' in dfi.columns else np.zeros(n)
        df_out['Lwy_cor_deg'] = dfi['Lwy_deg'].values if 'Lwy_deg' in dfi.columns else np.zeros(n)
        if 'Hdg_deg' in dfi.columns:
            df_out['Hdg_deg'] = dfi['Hdg_deg'].values
        for raw, cor in [('Twa_bow_deg', 'Twa_bow_cor_deg'), ('Twa_mhu_deg', 'Twa_mhu_cor_deg'),
                         ('Twd_bow_deg', 'Twd_bow_cor_deg'), ('Twd_mhu_deg', 'Twd_mhu_cor_deg')]:
            if raw in dfi.columns:
                df_out[cor] = dfi[raw].values
        return df_out
    except Exception as e:
        u.log(api_token, "3_corrections.py", "error", "fallback", f"get_fallback_corrections_data: {e}")
        return df


PARQUET_EXCLUDE_COLUMNS = [
    'Tws_kts', 'Twd_deg', 'Twa_deg', 'Awa_deg', 'Aws_kph', 'Lwy_deg', 'Hdg_deg', 'Bsp_kts',
    'Bsp_kph', 'Bsp_tgt_kph', 'Vmg_tgt_kph',
]

PARQUET_DATA_ORDER = [
    'ts', 'Datetime', 'Grade', 'Race_number', 'Leg_number',
    'Awa_n_fused_deg', 'Awa_fused_pre_deg', 'Aws_fused_norm_kph', 'Aws_fused_norm_kts',
    'Awa_cor_deg', 'Awa_offset_deg', 'Lwy_offset_norm_deg', 'Lwy_offset_deg',
    'Aws_cor_kph', 'Aws_cor_kts', 'Tws_cor_kph', 'Tws_cor_kts', 'Twa_cor_deg', 'Twd_cor_deg',
    'Tws_bow_cor_kph', 'Tws_mhu_cor_kph', 'Tws_bow_cor_kts', 'Tws_mhu_cor_kts',
    'Twa_bow_cor_deg', 'Twa_mhu_cor_deg', 'Twd_bow_cor_deg', 'Twd_mhu_cor_deg',
    'Lwy_cor_deg', 'Lwy_n_deg', 'Lwy_n_cor_deg', 'Cse_cor_deg', 'Cwa_cor_deg', 'Cwa_n_cor_deg',
    'Awa_n_cor_deg', 'Twa_n_cor_deg',
    'Awa_bow_cor_deg', 'Awa_mhu_cor_deg', 'Aws_bow_cor_kph', 'Aws_mhu_cor_kph',
    'Aws_bow_cor_kts', 'Aws_mhu_cor_kts',
    'Bsp_tgt_cor_kph', 'Bsp_tgt_cor_kts', 'Vmg_tgt_cor_kph', 'Vmg_tgt_cor_kts',
    'Vmg_cor_kph', 'Vmg_cor_kts', 'Vmg_cor_perc', 'Bsp_cor_perc',
]


def _reorder_parquet_columns(df_out):
    if df_out is None or len(df_out.columns) == 0:
        return df_out
    ordered = [c for c in PARQUET_DATA_ORDER if c in df_out.columns]
    ordered += [c for c in df_out.columns if c not in ordered]
    return df_out[[c for c in ordered]]


def save_corrections_parquet(df_out, class_name, project_id, date, source_name):
    """
    Write fusion_corrections_racesight.parquet via a same-directory temp file + os.replace.

    In-place overwrite can fail or appear stale on Windows when the file server (DuckDB)
    still has the old parquet open; deleting first also risks a window with no file.
    Atomic replace ensures readers see either the previous or the complete new file.
    """
    data_dir = os.getenv('DATA_DIRECTORY', 'C:/MyApps/Hunico/Uploads/Data')
    date_str = str(date).replace('-', '').replace('/', '')
    dir_path = os.path.join(data_dir, 'System', str(project_id), class_name, date_str, source_name)
    os.makedirs(dir_path, exist_ok=True)
    path = os.path.join(dir_path, 'fusion_corrections_racesight.parquet')
    tmp_path = path + '.tmp'

    df_out = df_out.drop(columns=[c for c in PARQUET_EXCLUDE_COLUMNS if c in df_out.columns], errors='ignore')
    if 'ts' in df_out.columns:
        ts = df_out['ts'].values
        ts_valid = ts[~np.isnan(ts)]
        if len(ts_valid) > 0 and np.max(ts_valid) > 1e12:
            df_out['Datetime'] = pd.to_datetime(ts, unit='ms', utc=True, errors='coerce')
        else:
            df_out['Datetime'] = pd.to_datetime(ts, unit='s', utc=True, errors='coerce')
    df_out = _reorder_parquet_columns(df_out)

    if os.path.exists(tmp_path):
        try:
            os.remove(tmp_path)
        except OSError as e:
            u.log(api_token, "3_corrections.py", "warning", "parquet",
                  f"Could not remove stale temp parquet {tmp_path}: {e}")

    try:
        df_out.to_parquet(tmp_path, engine='pyarrow')
    except Exception:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise
    try:
        os.replace(tmp_path, path)
    except OSError as e:
        u.log(
            api_token,
            "3_corrections.py",
            "error",
            "parquet",
            f"os.replace failed; new data left at {tmp_path}. Close readers of {path} and retry. {e}",
        )
        raise
    return path


if __name__ == "__main__":
    try:
        parameters_str = sys.argv[1]
        parameters_json = json.loads(parameters_str)

        u.log(api_token, "3_corrections.py", "info", "parameters", parameters_str)

        class_name = parameters_json.get('class_name')
        project_id = parameters_json.get('project_id')
        dataset_id = parameters_json.get('dataset_id')
        date = parameters_json.get('date')
        source_name = parameters_json.get('source_name')
        start_time = parameters_json.get('start_time')
        end_time = parameters_json.get('end_time')
        verbose = parameters_json.get('verbose', False)
        if parameters_json.get('use_perf_model') is False:
            u.log(api_token, "3_corrections.py", "warning", "parameters",
                  "use_perf_model=False is ignored; only performance-model AWA calibration is supported.")
        if parameters_json.get('use_state_matched') or parameters_json.get('rolling_awa_balance'):
            u.log(api_token, "3_corrections.py", "warning", "parameters",
                  "V2 calibration parameters (use_state_matched, rolling_awa_balance, ...) are ignored.")

        window_sec = parameters_json.get('window_sec', 30 * 60)
        step_sec = parameters_json.get('step_sec', 60)
        model_update_interval_sec = parameters_json.get('model_update_interval_sec', 30 * 60)
        min_samples_per_model = parameters_json.get('min_samples_per_model', 100)
        speed_unit = parameters_json.get('speed_unit')

        print("Starting fusion corrections (performance-model AWA)...", flush=True)

        if not all([class_name, project_id, date, source_name]):
            u.log(api_token, "3_corrections.py", "error", "args",
                  "Missing class_name, project_id, date, or source_name")
            print("Script Failed: Missing class_name, project_id, date, or source_name", flush=True)
            sys.exit(1)

        start_ts = None
        end_ts = None
        if start_time and end_time:
            start_ts = u.get_timestamp_from_str(start_time) if isinstance(start_time, str) else start_time
            end_ts = u.get_timestamp_from_str(end_time) if isinstance(end_time, str) else end_time

        used_fallback = False
        results = None
        try:
            df_out, results = run_corrections_pipeline(
                class_name=class_name,
                project_id=project_id,
                date=date,
                source_name=source_name,
                start_ts=start_ts,
                end_ts=end_ts,
                verbose=verbose,
                window_sec=window_sec,
                step_sec=step_sec,
                model_update_interval_sec=model_update_interval_sec,
                min_samples_per_model=min_samples_per_model,
                speed_unit=speed_unit,
            )
            if df_out is None or len(df_out) == 0:
                raise ValueError("Pipeline returned no data")
        except Exception as pipeline_error:
            u.log(api_token, "3_corrections.py", "error", "pipeline", f"Fusion pipeline failed: {pipeline_error}")
            proc_min, proc_max, proc_ts = get_canonical_ts_for_fusion(class_name, project_id, date, source_name)
            fallback_start = proc_min if proc_min is not None else start_ts
            fallback_end = proc_max if proc_max is not None else end_ts
            df_out = get_fallback_corrections_data(
                class_name, project_id, date, source_name, fallback_start, fallback_end
            )
            if df_out is not None and len(df_out) > 0:
                df_out['Awa_offset_deg'] = 0.0
            if proc_ts is not None and len(proc_ts) > 0 and df_out is not None and len(df_out) > 0:
                proc_ts_sorted = np.sort(proc_ts.dropna().unique())
                df_out = df_out.set_index('ts')
                df_out = df_out.reindex(proc_ts_sorted)
                _reindex_fill_numeric_columns(df_out)
                df_out = df_out.reset_index()
                df_out['ts'] = df_out['ts'].round(3)
                if 'Awa_offset_deg' not in df_out.columns:
                    df_out['Awa_offset_deg'] = 0.0
            if df_out is None or len(df_out) == 0:
                u.log(api_token, "3_corrections.py", "error", "pipeline", "Pipeline and fallback had no data")
                print("Script Failed: No correction data and no fallback data", flush=True)
                sys.exit(1)
            if verbose:
                u.log(api_token, "3_corrections.py", "warning", "fallback",
                      "Using uncorrected fallback data for _cor channels")
            used_fallback = True

        if used_fallback:
            df_out = _finalize_fusion_geometry(df_out)
        t_min = float(df_out['ts'].min()) if 'ts' in df_out.columns and len(df_out) > 0 else start_ts
        t_max = float(df_out['ts'].max()) if 'ts' in df_out.columns and len(df_out) > 0 else end_ts
        df_out = load_and_merge_target_channels(
            df_out, class_name, project_id, date, source_name, t_min, t_max
        )
        df_out = add_target_corrections(df_out, update_tgt=False)
        df_out = add_vmg_bsp_perc_columns(df_out)

        path = save_corrections_parquet(df_out, class_name, project_id, date, source_name)
        print(f"Corrections saved: {len(df_out)} records" + (" (fallback)" if used_fallback else ""), flush=True)

        if dataset_id:
            # Register the Calibration dataset page (same pattern as Maneuvers/Performance)
            jsondata = {"class_name": class_name, "project_id": project_id, "dataset_id": dataset_id, "page_name": "CALIBRATION"}
            res = u.post_api_data(api_token, ":8059/api/datasets/page", jsondata)
            if res.get("success"):
                u.log(api_token, "3_corrections.py", "info", "Page Loaded!", "page_name: CALIBRATION")
            else:
                u.log(api_token, "3_corrections.py", "warning", "Page load failed", "page_name: CALIBRATION")

            date_norm = str(date).replace("-", "").replace("/", "").strip() if date else None
            if date_norm and len(date_norm) == 8:
                day_page_payload = {"class_name": class_name, "project_id": project_id, "date": date_norm, "page_name": "CALIBRATION"}
                day_res = u.post_api_data(api_token, ":8059/api/datasets/day-page", day_page_payload)
                if day_res.get("success"):
                    u.log(api_token, "3_corrections.py", "info", "Day page upserted", "page_name: CALIBRATION")
                else:
                    u.log(api_token, "3_corrections.py", "warning", "Day page upsert failed", day_res.get("message", "unknown"))

        sys.exit(0)

    except Exception as error:
        import traceback
        error_trace = traceback.format_exc()
        u.log(api_token, "3_corrections.py", "error", "corrections", "script exception error:" + str(error))
        u.log(api_token, "3_corrections.py", "error", "corrections", "traceback:" + error_trace)
        try:
            verbose = parameters_json.get('verbose', False)
        except NameError:
            verbose = False
        try:
            print(f"Script Failed: {str(error)}", flush=True)
            if verbose:
                print(error_trace, flush=True)
        except UnicodeEncodeError:
            print(f"Script Failed: {str(error).encode('ascii', errors='replace').decode('ascii')}", flush=True)
        sys.exit(1)
