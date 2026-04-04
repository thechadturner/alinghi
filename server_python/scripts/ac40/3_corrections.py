"""
3_corrections.py: AWA calibration pipeline (CLI).

Fetches all channels, renames to simple unit-free names via ``SIMPLE_RENAME``,
computes foil-derived features, runs a pre-flight sanity check, then calls
``calibrate_pipeline`` from ``utilities.cal_utils``.

``calibrate_pipeline`` operates entirely on simple names (``Awa``, ``Aws``, ``Bsp``,
``Tws``, ``Twa``, ``Twd``, ``Hdg``, ``Lwy``) and returns the same DataFrame with
corrected columns added (``Awa_cor``, ``Aws_cor``, ``Twa_cor``, etc.).

``_rename_simple_to_suffixed`` then adds unit suffixes back (``Awa_cor`` →
``Awa_cor_deg``, ``Tws_cor`` → ``Tws_cor_kts``, etc.) before
``_finalize_corrections_geometry`` derives course and normalized-angle columns.

Multi-sensor usage: set ``multi_sensor=True`` in ``calibrate_pipeline`` call and
supply ``awa_sensors`` / ``aws_sensors`` lists — see
``utilities.cal_utils.calibrate_pipeline`` docstring for details.
"""

import re
import pandas as pd
import numpy as np
import sys
import json
import os
from pathlib import Path
from typing import List, Optional

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

import utilities as u

from dotenv import load_dotenv

is_production = os.getenv("NODE_ENV") == "production"

project_root = Path(__file__).parent.parent.parent.parent

base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"
load_dotenv(dotenv_path=project_root / base_env_file)
load_dotenv(dotenv_path=project_root / local_env_file, override=True)

api_token = os.getenv('SYSTEM_KEY')
if not api_token:
    raise RuntimeError("SYSTEM_KEY is missing from environment configuration.")

# ---------------------------------------------------------------------------
# CHANNEL SPECS
# ---------------------------------------------------------------------------

TARGET_FETCH_CHANNELS = [
    {'name': 'ts', 'type': 'float'},
    {'name': 'AC40_Tgt_Speed_kts', 'type': 'float'}
]

FETCH_CHANNELS = [
    {'name': 'ts', 'type': 'float'},
    {'name': 'Grade', 'type': 'int'},
    {'name': 'Hdg_deg', 'type': 'angle360'},
    {'name': 'Cog_deg', 'type': 'angle360'},
    {'name': 'Tws_kts', 'type': 'float'},
    {'name': 'Bsp_kts', 'type': 'float'},
    {'name': 'Awa_deg', 'type': 'angle180'},
    {'name': 'Aws_kts', 'type': 'float'},
    {'name': 'Twd_deg', 'type': 'angle360'},
    {'name': 'Twa_deg', 'type': 'angle180'},
    {'name': 'Cwa_deg', 'type': 'angle180'},
    {'name': 'AC40_VMG_kts', 'type': 'float'},
    {'name': 'AC40_Heel', 'type': 'float'},
    {'name': 'AC40_Trim', 'type': 'float'},
    {'name': 'Lwy_deg', 'type': 'float'},
    {'name': 'AC40_HullAltitude', 'type': 'int'},
    {'name': 'AC40_Loads_MainSheetLoad', 'type': 'float'},
    {'name': 'AC40_FoilPort_Cant', 'type': 'float'},
    {'name': 'AC40_FoilStbd_Cant', 'type': 'float'},
    {'name': 'AC40_FoilPort_Sink', 'type': 'float'},
    {'name': 'AC40_FoilStbd_Sink', 'type': 'float'},
    {'name': 'AC40_SignificantWaveHeight', 'type': 'float'}
]

# Rename BowWand ``AC40_*`` and suffixed names → simple unit-free names
SIMPLE_RENAME = {
    'Hdg_deg': 'Hdg',
    'Cog_deg': 'Cog',
    'Tws_kts': 'Tws',
    'Bsp_kts': 'Bsp',
    'Awa_deg': 'Awa',
    'Aws_kts': 'Aws',
    'Twd_deg': 'Twd',
    'Twa_deg': 'Twa',
    'Cwa_deg': 'Cwa',
    'Lwy_deg': 'Lwy',
    'AC40_VMG_kts': 'Vmg',
    'AC40_Heel': 'Heel',
    'AC40_Trim': 'Trim',
    'AC40_HullAltitude': 'Altitude',
    'AC40_Loads_MainSheetLoad': 'Main_sheet_load',
    'AC40_FoilPort_Cant': 'Foil_port_cant',
    'AC40_FoilStbd_Cant': 'Foil_stbd_cant',
    'AC40_FoilPort_Sink': 'Foil_port_sink',
    'AC40_FoilStbd_Sink': 'Foil_stbd_sink',
    'AC40_SignificantWaveHeight': 'Swh',
}

# Feature lists use simple names (no unit suffixes).
# Foil-derived columns are computed by _compute_foil_features before calibration.
AWA_FEATURES = [
    'Bsp', 'Tws', 'Altitude', 'Foil_lwd_sink', 'Foil_lwd_cant_eff',
    'Main_sheet_load', 'Swh',
]

LWY_FEATURES = [
    'Bsp', 'Tws', 'Heel', 'Altitude', 'Foil_lwd_sink', 'Foil_lwd_cant_eff',
    'Main_sheet_load', 'Swh',
]

# ---------------------------------------------------------------------------
# EMA CONSTANTS (shared with 1_normalization_influx.py)
# ---------------------------------------------------------------------------

SMOOTH_SECONDS = 10
RS_PERIOD_SEC = 0.1
EMA_ALPHA = 0.001


# ---------------------------------------------------------------------------
# RAW DATA FETCH
# ---------------------------------------------------------------------------

def _fetch_raw_data(
    class_name, project_id, date, source_name, start_ts=None, end_ts=None
) -> pd.DataFrame:
    """
    Single ``get_channel_values`` call.

    Applies ``SIMPLE_RENAME``, normalises ``ts`` to seconds, removes data gaps.
    Returns the full DataFrame (all grades) — callers filter as needed.
    Foil-derived features are NOT computed here; call ``_compute_foil_features`` next.
    """
    dfi = u.get_channel_values(
        api_token, class_name, project_id, date, source_name,
        FETCH_CHANNELS, '100ms', start_ts, end_ts, 'UTC',
    )
    if dfi is None or len(dfi) == 0:
        return pd.DataFrame()
    dfi = dfi.rename(columns=SIMPLE_RENAME)
    if dfi['ts'].dtype == 'Float64':
        dfi['ts'] = dfi['ts'].astype('float64')
    ts_sample = dfi['ts'].dropna()
    if len(ts_sample) > 0 and ts_sample.max() > 1e12:
        dfi['ts'] = (dfi['ts'] / 1000.0).round(3)
    else:
        dfi['ts'] = dfi['ts'].round(3)
    if 'Bsp' in dfi.columns:
        dfi = u.remove_gaps(dfi, 'Bsp', 'ts')
    return dfi


# ---------------------------------------------------------------------------
# FOIL FEATURES (simple names)
# ---------------------------------------------------------------------------

def _compute_foil_features(df: pd.DataFrame) -> None:
    """
    In-place: leeward foil cant, effective cant vs heel, leeward sink.

    Uses ``Twa`` sign: positive (starboard tack) → port-side foil is leeward.
    Inputs: ``Foil_port_cant``, ``Foil_stbd_cant``, ``Foil_port_sink``,
    ``Foil_stbd_sink``, ``Heel``, ``Twa``.
    Writes: ``Foil_lwd_cant``, ``Foil_lwd_cant_eff``, ``Foil_lwd_sink``.
    """
    if df is None or len(df) == 0 or 'Twa' not in df.columns:
        return
    twa = pd.to_numeric(df['Twa'], errors='coerce')
    port_side = (twa > 0).fillna(False).to_numpy(dtype=bool)

    if 'Foil_port_cant' in df.columns and 'Foil_stbd_cant' in df.columns:
        fp = pd.to_numeric(df['Foil_port_cant'], errors='coerce').to_numpy(dtype=np.float64)
        fs = pd.to_numeric(df['Foil_stbd_cant'], errors='coerce').to_numpy(dtype=np.float64)
        df['Foil_lwd_cant'] = np.where(port_side, fp, fs)

    if 'Foil_lwd_cant' in df.columns and 'Heel' in df.columns:
        cant = pd.to_numeric(df['Foil_lwd_cant'], errors='coerce').to_numpy(dtype=np.float64)
        heel = pd.to_numeric(df['Heel'], errors='coerce').to_numpy(dtype=np.float64)
        df['Foil_lwd_cant_eff'] = cant - heel

    if 'Foil_port_sink' in df.columns and 'Foil_stbd_sink' in df.columns:
        psk = pd.to_numeric(df['Foil_port_sink'], errors='coerce').to_numpy(dtype=np.float64)
        ssk = pd.to_numeric(df['Foil_stbd_sink'], errors='coerce').to_numpy(dtype=np.float64)
        df['Foil_lwd_sink'] = np.where(port_side, psk, ssk)


# ---------------------------------------------------------------------------
# CALIBRATION DATA SANITY CHECK
# ---------------------------------------------------------------------------

def _check_calibration_data(
    df: pd.DataFrame,
    min_samples_per_model: int = 100,
) -> tuple[bool, str]:
    """
    Pre-flight check on Grade>=2 data before running the calibration pipeline.

    Checks:
    1. Enough Grade>=2 rows (>= 4 × ``min_samples_per_model``).
    2. Both port and starboard tack covered (using ``Twa`` sign).
    3. Upwind (|Twa| < 80) and downwind (|Twa| > 115) coverage.

    Returns ``(ok, reason)`` where ``reason`` is an empty string on success.
    """
    if df is None or len(df) == 0:
        return False, 'Empty DataFrame'

    if 'Grade' in df.columns:
        df_train = df[pd.to_numeric(df['Grade'], errors='coerce') >= 2].copy()
    else:
        df_train = df.copy()

    min_rows = 4 * min_samples_per_model
    if len(df_train) < min_rows:
        return False, (
            f'Insufficient Grade>=2 rows: {len(df_train)} (need {min_rows})'
        )

    if 'Twa' not in df_train.columns:
        return False, 'Twa column missing'

    twa = pd.to_numeric(df_train['Twa'], errors='coerce')
    has_port = (twa < 0).any()
    has_stbd = (twa > 0).any()
    if not has_port or not has_stbd:
        return False, (
            f'Missing tack coverage: port={has_port}, starboard={has_stbd}'
        )

    twa_abs = twa.abs()
    has_upwind = (twa_abs < 80).any()
    has_downwind = (twa_abs > 115).any()
    if not has_upwind or not has_downwind:
        return False, (
            f'Missing wind mode coverage: upwind={has_upwind}, downwind={has_downwind}'
        )

    return True, ''


# ---------------------------------------------------------------------------
# FALLBACK (no calibration)
# ---------------------------------------------------------------------------

def _build_fallback_cor_df(dfi: pd.DataFrame) -> pd.DataFrame:
    """
    Copy raw simple-named channels into ``*_cor`` columns (no model offsets).

    Produces the same column set as ``calibrate_pipeline`` output (simple names)
    so that ``_rename_simple_to_suffixed`` and ``_finalize_corrections_geometry``
    work identically for both calibrated and fallback paths.
    """
    if dfi is None or len(dfi) == 0:
        return pd.DataFrame()
    df = dfi.copy()

    for raw, cor in [
        ('Awa', 'Awa_cor'),
        ('Aws', 'Aws_cor'),
        ('Tws', 'Tws_cor'),
        ('Twa', 'Twa_cor'),
        ('Twd', 'Twd_cor'),
        ('Lwy', 'Lwy_cor'),
    ]:
        df[cor] = (
            pd.to_numeric(df[raw], errors='coerce').to_numpy(dtype=np.float64, copy=True)
            if raw in df.columns
            else np.zeros(len(df))
        )

    df['Awa_offset'] = 0.0
    df['Lwy_offset'] = 0.0
    df['Lwy_offset_norm_deg'] = 0.0
    return df


# ---------------------------------------------------------------------------
# RENAME SIMPLE → SUFFIXED
# ---------------------------------------------------------------------------

def _rename_simple_to_suffixed(df: pd.DataFrame) -> pd.DataFrame:
    """
    Rename simple unit-free column names back to suffixed form for parquet output.

    Handles both single-sensor and multi-sensor numbered columns (e.g. ``Awa1``,
    ``Awa1_cor``, ``Aws1``, ``Aws1_cor``).  Internal helper columns (``tack``,
    ``hour``, ``Twa_mode``, etc.) are dropped.
    """
    rename_map = {
        'Awa': 'Awa_deg',
        'Aws': 'Aws_kts',
        'Bsp': 'Bsp_kts',
        'Tws': 'Tws_kts',
        'Twa': 'Twa_deg',
        'Twd': 'Twd_deg',
        'Hdg': 'Hdg_deg',
        'Lwy': 'Lwy_deg',
        'Cog': 'Cog_deg',
        'Cwa': 'Cwa_deg',
        'Awa_cor': 'Awa_cor_deg',
        'Aws_cor': 'Aws_cor_kts',
        'Tws_cor': 'Tws_cor_kts',
        'Twa_cor': 'Twa_cor_deg',
        'Twd_cor': 'Twd_cor_deg',
        'Lwy_cor': 'Lwy_cor_deg',
        'Awa_offset': 'Awa_offset_deg',
        'Lwy_offset': 'Lwy_offset_deg',
    }

    # Multi-sensor numbered columns (Awa1, Awa2, Aws1, Aws2, ...)
    for col in list(df.columns):
        m_awa = re.match(r'^(Awa)(\d+)(_cor|_offset)?$', col)
        m_aws = re.match(r'^(Aws)(\d+)(_cor)?$', col)
        if m_awa:
            prefix, num, suffix = m_awa.group(1), m_awa.group(2), m_awa.group(3) or ''
            if suffix == '_cor':
                rename_map[col] = f'{prefix}{num}_cor_deg'
            elif suffix == '_offset':
                rename_map[col] = f'{prefix}{num}_offset_deg'
            else:
                rename_map[col] = f'{prefix}{num}_deg'
        elif m_aws:
            prefix, num, suffix = m_aws.group(1), m_aws.group(2), m_aws.group(3) or ''
            if suffix == '_cor':
                rename_map[col] = f'{prefix}{num}_cor_kts'
            else:
                rename_map[col] = f'{prefix}{num}_kts'

    df = df.rename(columns=rename_map)

    # Drop internal pipeline columns
    internal_cols = ['tack', 'hour', 'normalized_lwy', 'lwy_residual']
    twa_mode_cols = [c for c in df.columns if c.endswith('_mode')]
    df = df.drop(columns=[c for c in internal_cols + twa_mode_cols if c in df.columns],
                 errors='ignore')
    return df


# ---------------------------------------------------------------------------
# FINALIZE GEOMETRY
# ---------------------------------------------------------------------------

def _bsp_values_as_kts_for_vmg(df: pd.DataFrame):
    if 'Bsp_kts' not in df.columns:
        return None
    return pd.to_numeric(df['Bsp_kts'], errors='coerce').to_numpy(dtype=np.float64)


def _reindex_fill_numeric_columns(df_idx: pd.DataFrame) -> None:
    """In-place: angles (*_deg) and offset columns use ffill/bfill; other numerics linear."""
    for col in df_idx.columns:
        s = df_idx[col]
        if not pd.api.types.is_numeric_dtype(s):
            continue
        if col == 'Grade':
            df_idx[col] = s.ffill().bfill().round()
        elif col.endswith('_deg') or col.endswith('_cor_kts'):
            df_idx[col] = s.ffill().bfill()
        else:
            df_idx[col] = s.interpolate(method='linear', limit_direction='both')


def _finalize_corrections_geometry(df_out):
    """
    After rename to suffixed names: smooth TWS/TWD, smooth AWA offset, then derive
    ``Lwy_n_cor_deg``, ``Cse_cor_deg``, ``Cwa_cor_deg``, ``Cwa_n_cor_deg``, and
    normalized _cor angles on the same grid.
    """
    df_out = apply_exponential_filter_tws_twd(df_out)
    df_out = apply_exponential_filter_awa_offset(df_out)
    df_out = add_cse_cwa_leeway_columns(df_out)
    df_out = add_normalized_cor_columns(df_out)
    df_out = add_normalized_pre_leeway_from_offsets(df_out)
    return df_out


def add_cse_cwa_leeway_columns(df_out):
    """Compute ``Cse_cor_deg``, ``Cwa_cor_deg``, ``Lwy_n_cor_deg``, ``Cwa_n_cor_deg``."""
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
        cse = ((hdg - lwy) + 180) % 360 - 180
        cse[cse == -180] = 180
        df_out['Cse_cor_deg'] = cse
        if 'Twd_cor_deg' in df_out.columns:
            twd = df_out['Twd_cor_deg'].values
            cwa = ((twd - cse) + 180) % 360 - 180
            cwa[cwa == -180] = 180
            df_out['Cwa_cor_deg'] = cwa
            df_out['Cwa_n_cor_deg'] = cwa * sign_twa
        df_out.drop(columns=['Hdg_deg'], inplace=True, errors='ignore')

    return df_out


def add_normalized_cor_columns(df_out):
    """Add ``Awa_n_cor_deg``, ``Twa_n_cor_deg`` (value × sign(Twa_cor_deg))."""
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
    ``Lwy_n_deg`` on the corrections grid: normalized corrected leeway minus propagated offset.
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
    """Apply EMA to ``Tws_*_cor_kts`` and ``Twd_*_cor_deg`` columns."""
    if df_out is None or len(df_out) == 0:
        return df_out
    if alpha is None or alpha <= 0 or alpha > 1:
        return df_out
    tws_cols = [c for c in df_out.columns if c.startswith('Tws_') and c.endswith('_cor_kts')]
    twd_cols = [c for c in df_out.columns if c.startswith('Twd_') and c.endswith('_cor_deg')]
    for col in tws_cols:
        vals = df_out[col].values.astype(float)
        if np.any(~np.isnan(vals)):
            df_out[col] = pd.Series(vals, dtype=float).ewm(alpha=alpha, adjust=False).mean().values
    for col in twd_cols:
        vals = df_out[col].values.astype(float)
        if np.any(~np.isnan(vals)):
            df_out[col] = u.ewm360(vals, alpha, adjust=False)
    return df_out


def apply_exponential_filter_awa_offset(df_out, alpha=EMA_ALPHA):
    """Apply EMA to AWA offset columns to smooth recorded offset values.

    Handles ``Awa_offset_deg`` (single-sensor) and any ``Awa{n}_offset_deg``
    columns (multi-sensor, e.g. ``Awa1_offset_deg``, ``Awa2_offset_deg``).
    """
    if df_out is None or len(df_out) == 0:
        return df_out
    if alpha is None or alpha <= 0 or alpha > 1:
        return df_out
    offset_cols = [
        c for c in df_out.columns
        if c == 'Awa_offset_deg' or re.match(r'^Awa\d+_offset_deg$', c)
    ]
    if not offset_cols:
        return df_out
    for col in offset_cols:
        vals = df_out[col].values.astype(float)
        if np.any(~np.isnan(vals)):
            df_out[col] = pd.Series(vals, dtype=float).ewm(alpha=alpha, adjust=False).mean().values
    return df_out


# ---------------------------------------------------------------------------
# CORRECTIONS PIPELINE
# ---------------------------------------------------------------------------

def run_corrections_pipeline(
    class_name, project_id, date, source_name,
    start_ts=None, end_ts=None, verbose=False,
    window_sec=30 * 60, step_sec=60,
    model_update_interval_sec=30 * 60, min_samples_per_model=100,
    multi_sensor: bool = False,
    awa_sensors: Optional[List[str]] = None,
    aws_sensors: Optional[List[str]] = None,
):
    """
    Full corrections pipeline.

    1. Fetch raw data and rename to simple names (``SIMPLE_RENAME``).
    2. Compute foil-derived features (``_compute_foil_features``).
    3. Pre-flight sanity check (``_check_calibration_data``).
    4. If check passes: run ``calibrate_pipeline`` (AWA + leeway + TW recompute).
       If check fails: use identity-copy fallback (``_build_fallback_cor_df``).
    5. Rename simple names → suffixed (``_rename_simple_to_suffixed``).
    6. Derive geometry columns (``_finalize_corrections_geometry``).

    Returns ``(df_out, calibration_applied)`` where ``calibration_applied`` is
    ``True`` when the full calibration pipeline ran successfully.

    **Multi-sensor usage**: set ``multi_sensor=True`` and pass ``awa_sensors`` /
    ``aws_sensors`` (e.g. ``['Awa1', 'Awa2']`` / ``['Aws1', 'Aws2']``). The caller
    is responsible for ensuring those simple-named columns are present in the
    fetched dataframe before this function is called.
    """
    from utilities.cal_utils import calibrate_pipeline

    df_raw = _fetch_raw_data(class_name, project_id, date, source_name, start_ts, end_ts)
    if df_raw is None or len(df_raw) == 0:
        u.log(api_token, '3_corrections.py', 'error', 'pipeline',
              'get_channel_values returned no rows')
        return pd.DataFrame(), False

    _compute_foil_features(df_raw)

    ok, reason = _check_calibration_data(df_raw, min_samples_per_model=min_samples_per_model)

    if not ok:
        msg = f'Skipping calibration: {reason}'
        u.log(api_token, '3_corrections.py', 'warning', 'pipeline', msg)
        if verbose:
            print(msg, flush=True)
        df_cal = _build_fallback_cor_df(df_raw)
        df_out = _rename_simple_to_suffixed(df_cal)
        df_out = _finalize_corrections_geometry(df_out)
        return df_out, False

    if verbose:
        print(
            f'Starting AWA calibration: {len(df_raw):,} rows, '
            f'window={window_sec/60:.0f}min step={step_sec}s'
            f'{" (multi-sensor)" if multi_sensor else ""}',
            flush=True,
        )

    df_cal = calibrate_pipeline(
        df_raw,
        awa_col='Awa', aws_col='Aws', lwy_col='Lwy',
        bsp_col='Bsp', tws_col='Tws', twd_col='Twd', hdg_col='Hdg', twa_col='Twa',
        awa_features=AWA_FEATURES,
        lwy_features=LWY_FEATURES,
        multi_sensor=multi_sensor,
        awa_sensors=awa_sensors,
        aws_sensors=aws_sensors,
        leeway_training_grade=3,
        prefer_stream_true_wind=True,
        window_sec=window_sec,
        step_sec=step_sec,
        model_update_interval_sec=model_update_interval_sec,
        min_samples_per_model=min_samples_per_model,
        verbose=verbose,
    )

    df_out = _rename_simple_to_suffixed(df_cal)
    df_out = _finalize_corrections_geometry(df_out)
    return df_out, True


# ---------------------------------------------------------------------------
# TARGET CHANNELS & VMG
# ---------------------------------------------------------------------------

def load_and_merge_target_channels(df_out, class_name, project_id, date, source_name,
                                   start_ts=None, end_ts=None):
    """Fetch ``Tgt_Speed_kts`` and merge as ``Bsp_tgt_kts``."""
    if df_out is None or len(df_out) == 0:
        return df_out
    try:
        df_tgt = u.get_channel_values(
            api_token, class_name, project_id, date, source_name,
            TARGET_FETCH_CHANNELS, '100ms', start_ts, end_ts, 'UTC',
        )
        if df_tgt is None or len(df_tgt) == 0:
            return df_out
        df_tgt = df_tgt.rename(columns={'AC40_Tgt_Speed_kts': 'Bsp_tgt_kts'})
        if 'Bsp_tgt_kts' not in df_tgt.columns:
            return df_out
        df_tgt = df_tgt.copy()
        ts_tgt = df_tgt['ts'].dropna()
        if len(ts_tgt) > 0 and ts_tgt.max() > 1e12:
            df_tgt['ts'] = (df_tgt['ts'] / 1000.0).round(3)
        else:
            df_tgt['ts'] = df_tgt['ts'].round(3)
        df_out = df_out.merge(df_tgt[['ts', 'Bsp_tgt_kts']], on='ts', how='left')
    except Exception:
        pass
    return df_out


def add_target_corrections(df, update_tgt=False):
    """Output ``Bsp_tgt_cor_kts``, ``Vmg_tgt_cor_kts`` from target channels."""
    if df is None or len(df) == 0:
        return df
    if 'Bsp_tgt_kts' in df.columns:
        df['Bsp_tgt_cor_kts'] = np.abs(
            pd.to_numeric(df['Bsp_tgt_kts'], errors='coerce').to_numpy(dtype=np.float64)
        )
    if 'Vmg_tgt_kts' in df.columns:
        df['Vmg_tgt_cor_kts'] = np.abs(
            pd.to_numeric(df['Vmg_tgt_kts'], errors='coerce').to_numpy(dtype=np.float64)
        )
    return df


def add_vmg_bsp_perc_columns(df):
    """Compute ``Vmg_cor_kts``, ``Vmg_cor_perc``, ``Bsp_cor_perc``."""
    if df is None or len(df) == 0:
        return df
    bsp_kts = _bsp_values_as_kts_for_vmg(df)
    if bsp_kts is not None and 'Cwa_cor_deg' in df.columns:
        cwa = np.radians(
            pd.to_numeric(df['Cwa_cor_deg'], errors='coerce').to_numpy(dtype=np.float64)
        )
        df['Vmg_cor_kts'] = np.abs(bsp_kts * np.cos(cwa))
    if 'Vmg_cor_kts' in df.columns and 'Vmg_tgt_cor_kts' in df.columns:
        tgt = df['Vmg_tgt_cor_kts'].values
        df['Vmg_cor_perc'] = np.where(tgt != 0, (df['Vmg_cor_kts'].values / tgt) * 100, 0)
        df['Vmg_cor_perc'] = df['Vmg_cor_perc'].clip(lower=0, upper=150)
    if bsp_kts is not None and 'Bsp_tgt_cor_kts' in df.columns:
        tgt = df['Bsp_tgt_cor_kts'].values
        df['Bsp_cor_perc'] = np.where(tgt != 0, (bsp_kts / tgt) * 100, 0)
        df['Bsp_cor_perc'] = df['Bsp_cor_perc'].clip(lower=0, upper=150)
    return df


# ---------------------------------------------------------------------------
# PARQUET OUTPUT
# ---------------------------------------------------------------------------

PARQUET_EXCLUDE_COLUMNS = [
    'Bsp_tgt_kts',
]

PARQUET_DATA_ORDER = [
    'ts', 'Datetime', 'Grade', 'Race_number', 'Leg_number',
    'Awa_deg', 'Awa_n_deg', 'Twa_deg', 'Twa_n_deg', 'Cwa_deg', 'Cwa_n_deg', 'Twd_deg',
    'Aws_kts', 'Tws_kts', 'Bsp_kts',
    'Awa_cor_deg', 'Awa_n_cor_deg', 'Awa_offset_deg',
    'Aws_cor_kts', 'Tws_cor_kts', 'Twa_cor_deg', 'Twa_n_cor_deg', 'Twd_cor_deg',
    'Lwy_cor_deg', 'Lwy_n_cor_deg', 'Lwy_offset_deg', 'Lwy_offset_norm_deg', 'Lwy_n_deg',
    'Cse_cor_deg', 'Cwa_cor_deg', 'Cwa_n_cor_deg',
    'Bsp_tgt_cor_kts', 'Vmg_tgt_cor_kts',
    'Vmg_cor_kts', 'Vmg_cor_perc', 'Bsp_cor_perc',
]


def _reorder_parquet_columns(df_out):
    if df_out is None or len(df_out.columns) == 0:
        return df_out
    ordered = [c for c in PARQUET_DATA_ORDER if c in df_out.columns]
    ordered += [c for c in df_out.columns if c not in ordered]
    return df_out[ordered]


def save_corrections_parquet(df_out, class_name, project_id, date, source_name):
    """
    Write ``fusion_corrections_racesight.parquet`` via temp file + ``os.replace``.

    Atomic replace ensures readers see either the previous or the complete new file.
    """
    data_dir = os.getenv('DATA_DIRECTORY', 'C:/MyApps/Alinghi/uploads/data')
    date_str = str(date).replace('-', '').replace('/', '')
    dir_path = os.path.join(
        data_dir, 'system', str(project_id), class_name, date_str, source_name
    )
    os.makedirs(dir_path, exist_ok=True)
    path = os.path.join(dir_path, 'fusion_corrections_racesight.parquet')
    tmp_path = path + '.tmp'

    df_out = df_out.drop(
        columns=[c for c in PARQUET_EXCLUDE_COLUMNS if c in df_out.columns], errors='ignore'
    )
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
            u.log(api_token, '3_corrections.py', 'warning', 'parquet',
                  f'Could not remove stale temp parquet {tmp_path}: {e}')
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
        u.log(api_token, '3_corrections.py', 'error', 'parquet',
              f'os.replace failed; new data left at {tmp_path}. '
              f'Close readers of {path} and retry. {e}')
        raise
    return path


# ---------------------------------------------------------------------------
# ENTRY POINT
# ---------------------------------------------------------------------------

LOG_SCRIPT = "3_corrections.py"

if __name__ == "__main__":
    parameters_json = {}
    USE_MANUAL_TEST_INPUTS = True

    try:
        if USE_MANUAL_TEST_INPUTS:
            class_name = "AC40"
            project_id = 2
            dataset_id = 1
            date = "20260328"
            source_name = "AC40-SUI1"
            start_time = None
            end_time = None
            verbose = True
            window_sec = 30 * 60
            step_sec = 60
            model_update_interval_sec = 30 * 60
            min_samples_per_model = 100
            parameters_json = {"verbose": verbose}
        else:
            parameters_str = sys.argv[1]
            parameters_json = json.loads(parameters_str)
            u.log(api_token, LOG_SCRIPT, "info", "parameters", parameters_str)

            class_name = parameters_json.get("class_name")
            project_id = parameters_json.get("project_id")
            dataset_id = parameters_json.get("dataset_id")
            date = parameters_json.get("date")
            source_name = parameters_json.get("source_name")
            start_time = parameters_json.get("start_time")
            end_time = parameters_json.get("end_time")
            if start_time == "":
                start_time = None
            if end_time == "":
                end_time = None
            verbose = parameters_json.get("verbose", False)
            window_sec = parameters_json.get("window_sec", 30 * 60)
            step_sec = parameters_json.get("step_sec", 60)
            model_update_interval_sec = parameters_json.get("model_update_interval_sec", 30 * 60)
            min_samples_per_model = parameters_json.get("min_samples_per_model", 100)

        if parameters_json.get("use_perf_model") is False:
            u.log(api_token, LOG_SCRIPT, "warning", "parameters",
                  "use_perf_model=False is ignored; only performance-model AWA calibration is supported.")
        if parameters_json.get("use_state_matched") or parameters_json.get("rolling_awa_balance"):
            u.log(api_token, LOG_SCRIPT, "warning", "parameters",
                  "V2 calibration parameters (use_state_matched, rolling_awa_balance, ...) are ignored.")

        print("Starting corrections — fetch, foil features, sanity check, calibrate, save.",
              flush=True)

        if not all([class_name, project_id, date, source_name]):
            u.log(api_token, LOG_SCRIPT, "error", "args",
                  "Missing class_name, project_id, date, or source_name")
            print("Script Failed: Missing class_name, project_id, date, or source_name", flush=True)
            sys.exit(1)

        start_ts = None
        end_ts = None
        if start_time and end_time:
            start_ts = (
                u.get_timestamp_from_str(start_time) if isinstance(start_time, str) else start_time
            )
            end_ts = (
                u.get_timestamp_from_str(end_time) if isinstance(end_time, str) else end_time
            )

        df_out, calibration_applied = run_corrections_pipeline(
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
            )

        if df_out is None or len(df_out) == 0:
            u.log(api_token, LOG_SCRIPT, "error", "pipeline", "Pipeline returned no rows")
            print("Script Failed: No data from corrections pipeline", flush=True)
            sys.exit(1)

        t_min = float(df_out['ts'].min()) if 'ts' in df_out.columns and len(df_out) > 0 else start_ts
        t_max = float(df_out['ts'].max()) if 'ts' in df_out.columns and len(df_out) > 0 else end_ts
        df_out = load_and_merge_target_channels(
            df_out, class_name, project_id, date, source_name, t_min, t_max
        )
        df_out = add_target_corrections(df_out, update_tgt=False)
        df_out = add_vmg_bsp_perc_columns(df_out)

        path = save_corrections_parquet(df_out, class_name, project_id, date, source_name)
        print(
            f"Corrections saved: {len(df_out)} records"
            + (" (calibrated)" if calibration_applied else " (not calibrated — fallback only)"),
            flush=True,
        )

        if dataset_id:
            jsondata = {
                "class_name": class_name, "project_id": project_id,
                "dataset_id": dataset_id, "page_name": "CALIBRATION",
            }
            res = u.post_api_data(api_token, ":8059/api/datasets/page", jsondata)
            if res.get("success"):
                u.log(api_token, LOG_SCRIPT, "info", "Page Loaded!", "page_name: CALIBRATION")
            else:
                u.log(api_token, LOG_SCRIPT, "warning", "Page load failed", "page_name: CALIBRATION")

        sys.exit(0)

    except Exception as error:
        import traceback
        error_trace = traceback.format_exc()
        u.log(api_token, LOG_SCRIPT, "error", "corrections",
              "script exception error:" + str(error))
        u.log(api_token, LOG_SCRIPT, "error", "corrections", "traceback:" + error_trace)
        try:
            print(f"Script Failed: {str(error)}", flush=True)
            if parameters_json.get("verbose", False):
                print(error_trace, flush=True)
        except UnicodeEncodeError:
            print(
                f"Script Failed: {str(error).encode('ascii', errors='replace').decode('ascii')}",
                flush=True,
            )
            if parameters_json.get("verbose", False):
                print(error_trace.encode("ascii", errors="replace").decode("ascii"), flush=True)
        sys.exit(1)
