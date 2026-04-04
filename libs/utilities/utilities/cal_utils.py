"""
Calibration utilities for sailing sensor data.

Provides performance-model AWA calibration (tack×mode XGB surfaces, matched-condition
offsets), single-sensor and multi-sensor (per-sensor then fuse) paths, and leeway
symmetry corrections.

Public entry: ``calibrate_pipeline``.

Callers are responsible for:
- Fetching and renaming columns to simple unit-free names (e.g. ``Awa``, ``Aws``,
  ``Bsp``, ``Tws``, ``Twa``, ``Twd``, ``Hdg``, ``Lwy``).
- Computing any foil-derived columns before calling.
- Passing the full DataFrame (all grades); training filters to Grade>=2 internally.

Multi-sensor usage: pass ``multi_sensor=True`` with
``awa_sensors=['Awa1','Awa2']`` / ``aws_sensors=['Aws1','Aws2']``.  Each sensor pair
is calibrated independently, then ``fuse_sensors_robust`` merges corrected outputs
into ``Awa_cor`` / ``Aws_cor``.  Downstream recompute_true_wind and rename steps are
mode-agnostic.
"""

from typing import Dict, List, Optional, Tuple
import pandas as pd
import numpy as np
from xgboost import XGBRegressor

from .wind_utils import computeTrueWind_vectorized
from .ai_utils import train_XGBoost
from .logging_utils import log_info


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def _prefer_stream_or_computed(
    stream: Optional[np.ndarray],
    computed: np.ndarray,
) -> np.ndarray:
    """Per element: use finite stream value when present, else computed."""
    comp = np.asarray(computed, dtype=np.float64)
    if stream is None:
        return comp
    s = np.asarray(stream, dtype=np.float64)
    if s.shape != comp.shape:
        return comp
    return np.where(np.isfinite(s), s, comp)


# ---------------------------------------------------------------------------
# TRUE WIND
# ---------------------------------------------------------------------------

def compute_initial_true_wind(
    df: pd.DataFrame,
    awa_col: str = 'Awa',
    aws_col: str = 'Aws',
    bsp_col: str = 'Bsp',
    lwy_col: str = 'Lwy',
    hdg_col: str = 'Hdg',
    twa_col: str = 'Twa',
    tws_col: str = 'Tws',
    twd_col: str = 'Twd',
    *,
    prefer_stream_true_wind: bool = True,
) -> pd.DataFrame:
    """
    True-wind prep for calibration: run ``computeTrueWind_vectorized`` from
    AWA/AWS/BSP/HDG/Lwy.

    When ``prefer_stream_true_wind`` is True (default), finite instrument ``twa_col``,
    ``twd_col``, and ``tws_col`` from ``df`` are kept; computed values fill NaNs or
    missing columns only.  When False, computed values replace everywhere (legacy).
    """
    df = df.copy()

    hdg = (
        pd.to_numeric(df[hdg_col], errors='coerce').to_numpy(dtype=np.float64)
        if hdg_col in df.columns
        else np.zeros(len(df))
    )

    if bsp_col not in df.columns or aws_col not in df.columns:
        raise ValueError(
            f"compute_initial_true_wind requires {bsp_col!r} and {aws_col!r}."
        )
    if awa_col not in df.columns:
        raise ValueError(f"compute_initial_true_wind requires {awa_col!r}.")

    twa_stream = (
        pd.to_numeric(df[twa_col], errors='coerce').to_numpy(dtype=np.float64)
        if twa_col in df.columns else None
    )
    twd_stream = (
        pd.to_numeric(df[twd_col], errors='coerce').to_numpy(dtype=np.float64)
        if twd_col in df.columns else None
    )
    tws_stream = (
        pd.to_numeric(df[tws_col], errors='coerce').to_numpy(dtype=np.float64)
        if tws_col in df.columns else None
    )

    tws, twa, twd = computeTrueWind_vectorized(
        aws=pd.to_numeric(df[aws_col], errors='coerce').to_numpy(dtype=np.float64),
        awa=pd.to_numeric(df[awa_col], errors='coerce').to_numpy(dtype=np.float64),
        stw=pd.to_numeric(df[bsp_col], errors='coerce').to_numpy(dtype=np.float64),
        hdg=hdg,
        lwy=pd.to_numeric(df[lwy_col], errors='coerce').to_numpy(dtype=np.float64)
        if lwy_col in df.columns
        else np.zeros(len(df)),
    )

    if prefer_stream_true_wind:
        df[tws_col] = _prefer_stream_or_computed(tws_stream, tws)
        df[twa_col] = _prefer_stream_or_computed(twa_stream, twa)
        df[twd_col] = _prefer_stream_or_computed(twd_stream, twd)
    else:
        df[tws_col] = tws
        df[twa_col] = twa
        df[twd_col] = twd

    return df


def signed_twa_from_twd_hdg_deg(hdg: np.ndarray, twd: np.ndarray) -> np.ndarray:
    """Signed true wind angle (-180..180°) from compass TWD and heading."""
    h = np.asarray(hdg, dtype=np.float64)
    w = np.asarray(twd, dtype=np.float64)
    return ((w - h + 540.0) % 360.0) - 180.0


def recompute_true_wind(
    df: pd.DataFrame,
    awa_col: str,
    aws_col: str,
    bsp_col: str,
    lwy_col: str,
    hdg_col: str,
) -> pd.DataFrame:
    """
    Recompute true wind using calibrated AWA, AWS, and leeway values.

    Writes ``Twa_cor``, ``Tws_cor``, ``Twd_cor`` onto a copy of ``df``.
    ``hdg_col`` is required for accurate TWD.
    """
    df = df.copy()
    if hdg_col not in df.columns:
        raise ValueError(
            f"recompute_true_wind requires {hdg_col!r} for accurate TWD computation."
        )
    if aws_col not in df.columns:
        raise ValueError(f"recompute_true_wind requires {aws_col!r}.")
    if bsp_col not in df.columns:
        raise ValueError(f"recompute_true_wind requires {bsp_col!r}.")

    tws, twa, twd = computeTrueWind_vectorized(
        aws=pd.to_numeric(df[aws_col], errors='coerce').to_numpy(dtype=np.float64),
        awa=pd.to_numeric(df[awa_col], errors='coerce').to_numpy(dtype=np.float64),
        stw=pd.to_numeric(df[bsp_col], errors='coerce').to_numpy(dtype=np.float64),
        hdg=pd.to_numeric(df[hdg_col], errors='coerce').to_numpy(dtype=np.float64),
        lwy=pd.to_numeric(df[lwy_col], errors='coerce').to_numpy(dtype=np.float64)
        if lwy_col in df.columns
        else np.zeros(len(df)),
    )
    df['Twa_cor'] = twa
    df['Tws_cor'] = tws
    df['Twd_cor'] = twd
    return df


# ---------------------------------------------------------------------------
# TWA MODE / TACK HELPERS
# ---------------------------------------------------------------------------

def _twa_mode_col(twa_col: str, df: pd.DataFrame) -> str:
    """Return ``{twa_col}_mode`` if present on ``df``, else ``twa_col``."""
    mode = f'{twa_col}_mode'
    return mode if mode in df.columns else twa_col


def add_twa_mode_classification_column(
    df: pd.DataFrame,
    twa_col: str = 'Twa',
) -> pd.DataFrame:
    """
    Add ``{twa_col}_mode`` for tack and upwind/downwind/reaching classification.

    Rows where ``twa_col`` is missing are filled from ``(Twd - Hdg)`` when both
    compass columns are finite.
    """
    df = df.copy()
    if twa_col not in df.columns:
        return df
    twa_phys = pd.to_numeric(df[twa_col], errors='coerce').to_numpy(dtype=np.float64, copy=True)
    need_fill = ~np.isfinite(twa_phys)
    if need_fill.any() and 'Hdg' in df.columns and 'Twd' in df.columns:
        hdg = pd.to_numeric(df['Hdg'], errors='coerce').to_numpy(dtype=np.float64)
        twd = pd.to_numeric(df['Twd'], errors='coerce').to_numpy(dtype=np.float64)
        twa_nav = signed_twa_from_twd_hdg_deg(hdg, twd)
        fill = need_fill & np.isfinite(hdg) & np.isfinite(twd)
        twa_phys[fill] = twa_nav[fill]
    df[f'{twa_col}_mode'] = twa_phys
    return df


def add_tack_and_hour(df: pd.DataFrame, twa_col: str = 'Twa') -> pd.DataFrame:
    """
    Add ``tack`` (port/starboard) and ``hour`` (0-23) columns.
    Uses ``{twa_col}_mode`` when available, else ``twa_col``.
    """
    df = df.copy()
    twa_key = _twa_mode_col(twa_col, df)
    if twa_key not in df.columns:
        twa_key = twa_col
    twa_s = pd.to_numeric(df[twa_key], errors='coerce')
    df['tack'] = np.where(twa_s >= 0, 'starboard', 'port')
    df['hour'] = df['Datetime'].dt.hour
    return df


# ---------------------------------------------------------------------------
# SECTOR COUNTS / LOGGING
# ---------------------------------------------------------------------------

PERF_MODEL_UPWIND_ABS_TWA_MAX = 80.0
PERF_MODEL_DOWNWIND_ABS_TWA_MIN = 115.0


def summarize_tack_mode_sector_counts(
    df: pd.DataFrame,
    twa_col: str = 'Twa',
) -> Dict[str, int]:
    """
    Count rows by tack and wind sector using the same |TWA| rules as perf-model training.
    """
    if df is None or len(df) == 0 or 'tack' not in df.columns:
        return {}
    twa_key = _twa_mode_col(twa_col, df)
    if twa_key not in df.columns:
        return {}
    tack = df['tack'].astype(str)
    twa_abs = pd.to_numeric(df[twa_key], errors='coerce').abs()
    uw = twa_abs < PERF_MODEL_UPWIND_ABS_TWA_MAX
    dw = twa_abs > PERF_MODEL_DOWNWIND_ABS_TWA_MIN
    has_twa = twa_abs.notna()
    rec = has_twa & ~uw & ~dw
    port = tack == 'port'
    stbd = tack == 'starboard'
    valid_tack = port | stbd
    reaching_or_nan = valid_tack & (~has_twa | rec)
    return {
        'port_upwind': int((port & uw).sum()),
        'stbd_upwind': int((stbd & uw).sum()),
        'port_downwind': int((port & dw).sum()),
        'stbd_downwind': int((stbd & dw).sum()),
        'reaching_or_nan_twa': int(reaching_or_nan.sum()),
    }


def log_calibration_tack_mode_counts(
    df: pd.DataFrame,
    *,
    verbose: bool,
    label: str = 'calibration',
    twa_col: str = 'Twa',
    grade_filter: Optional[int] = None,
) -> Dict[str, int]:
    """Log tack × upwind/downwind counts for diagnostics before AWA calibration."""
    sub = df
    if grade_filter is not None and df is not None and len(df) > 0 and 'Grade' in df.columns:
        g = pd.to_numeric(df['Grade'], errors='coerce')
        sub = df.loc[g == grade_filter]
    counts = summarize_tack_mode_sector_counts(sub, twa_col=twa_col)
    n = len(sub) if sub is not None else 0
    if not counts:
        log_info(f'[{label}] tack×mode: no tack/TWA columns (n={n:,})')
        return {}
    msg = (
        f'[{label}] tack×wind |TWA|<{PERF_MODEL_UPWIND_ABS_TWA_MAX:.0f}=upwind '
        f'|TWA|>{PERF_MODEL_DOWNWIND_ABS_TWA_MIN:.0f}=downwind — '
        f'port_up={counts["port_upwind"]:,} stbd_up={counts["stbd_upwind"]:,} '
        f'port_dw={counts["port_downwind"]:,} stbd_dw={counts["stbd_downwind"]:,} '
        f'reaching/nan_twa={counts["reaching_or_nan_twa"]:,} (n={n:,})'
    )
    log_info(msg)
    if verbose:
        print(msg, flush=True)
    return counts


def _dataframe_for_leeway_calibration(
    df: pd.DataFrame, filter_grade: Optional[int], min_samples: int = 100
) -> pd.DataFrame:
    """Subset used to train leeway XGBoost and build half-hour tack-balance maps."""
    if filter_grade is None or 'Grade' not in df.columns:
        return df
    g = pd.to_numeric(df['Grade'], errors='coerce')
    sub = df[g == filter_grade].copy()
    if len(sub) >= min_samples:
        return sub
    log_info(
        f'leeway calibration: Grade=={filter_grade} has {len(sub)} rows (< {min_samples}); '
        'using full calibration frame for leeway train/optimize.'
    )
    return df


# ---------------------------------------------------------------------------
# AWA CALIBRATION — PERFORMANCE MODEL
# ---------------------------------------------------------------------------

MAX_AWA_LWY_CALIBRATION_OFFSET_DEG = 5.0


def _clip_offset_deg_scalar(
    value: float, limit: float = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG
) -> float:
    return float(np.clip(value, -limit, limit))


def _clip_offset_deg_array(
    arr: np.ndarray, limit: float = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG
) -> np.ndarray:
    return np.clip(np.asarray(arr, dtype=np.float64), -limit, limit)


def train_tack_mode_model(
    df: pd.DataFrame,
    tack: str,
    mode: str,
    awa_col: str,
    features: List[str],
    min_samples: int = 100,
    twa_col: str = 'Twa',
) -> Optional[XGBRegressor]:
    """
    Train XGBoost model predicting abs(AWA) for a specific tack and sailing mode.

    ``features`` is the complete explicit feature column list (e.g. ``['Bsp','Tws',...]``).
    Returns ``None`` when there is insufficient data.
    """
    if tack == 'port':
        df_tack = df[df['tack'] == 'port'].copy()
    elif tack == 'starboard':
        df_tack = df[df['tack'] == 'starboard'].copy()
    else:
        raise ValueError(f"tack must be 'port' or 'starboard', got {tack!r}")

    twa_key = _twa_mode_col(twa_col, df_tack)
    if twa_key not in df_tack.columns:
        return None

    twa_abs = pd.to_numeric(df_tack[twa_key], errors='coerce').abs()
    if mode == 'upwind':
        df_mode = df_tack[twa_abs < PERF_MODEL_UPWIND_ABS_TWA_MAX].copy()
    elif mode == 'downwind':
        df_mode = df_tack[twa_abs > PERF_MODEL_DOWNWIND_ABS_TWA_MIN].copy()
    else:
        raise ValueError(f"mode must be 'upwind' or 'downwind', got {mode!r}")

    required = list(features) + [awa_col]
    missing = [c for c in required if c not in df_mode.columns]
    if missing:
        return None

    df_clean = df_mode[required].dropna().copy()
    if len(df_clean) < min_samples:
        return None

    df_clean['abs_awa'] = df_clean[awa_col].abs()
    try:
        return train_XGBoost(df_clean, features, 'abs_awa')
    except Exception:
        return None


def compute_perf_model_awa_offset(
    port_model: Optional[XGBRegressor],
    stbd_model: Optional[XGBRegressor],
    query_X: np.ndarray,
) -> Optional[float]:
    """
    Compute AWA offset by interrogating port and starboard models at matched conditions.
    Returns scalar offset (degrees), or None if either model is missing.
    """
    if port_model is None or stbd_model is None:
        return None
    if query_X is None or len(query_X) == 0:
        return None
    X = np.asarray(query_X, dtype=np.float64)
    if X.ndim == 1:
        X = X.reshape(1, -1)
    offset = float(np.mean(port_model.predict(X) - stbd_model.predict(X)) / 2.0)
    return _clip_offset_deg_scalar(offset)


def compute_rolling_perf_model_awa_offsets(
    df: pd.DataFrame,
    awa_col: str,
    twa_col: str,
    awa_features: List[str],
    window_sec: float = 30 * 60,
    step_sec: float = 60,
    min_samples_per_model: int = 100,
    model_update_interval_sec: float = 30 * 60,
    *,
    verbose: bool = False,
) -> Tuple[pd.Series, pd.Series, Optional[float], Optional[float]]:
    """
    Compute rolling AWA offsets using the V3 performance model approach.

    Trains four models (port/stbd × upwind/downwind) from ``awa_features`` and
    interrogates them at matched conditions.  ``df`` should be Grade>=2 only.
    """
    if 'ts' not in df.columns or 'tack' not in df.columns or twa_col not in df.columns:
        raise ValueError(f"df must have columns: ts, tack, {twa_col!r}")

    missing_feats = [f for f in awa_features if f not in df.columns]
    if missing_feats:
        raise ValueError(
            f"compute_rolling_perf_model_awa_offsets: features missing from df: {missing_feats}"
        )

    df = df.sort_values('ts').reset_index(drop=True)
    t_min = float(df['ts'].min())
    t_max = float(df['ts'].max())
    grid_times = np.arange(t_min, t_max + step_sec * 0.5, step_sec)

    uw_offsets = np.full(len(grid_times), np.nan)
    dw_offsets = np.full(len(grid_times), np.nan)
    first_valid_ts: Optional[float] = None
    first_valid_offset: Optional[float] = None

    models: Dict = {
        'port_upwind': None, 'port_downwind': None,
        'starboard_upwind': None, 'starboard_downwind': None,
    }
    last_model_update_ts = None

    for i, t in enumerate(grid_times):
        if (last_model_update_ts is None or
                (t - last_model_update_ts) >= model_update_interval_sec):
            df_train = df[(df['ts'] <= t) & (df['ts'] >= t_min)].copy()
            if 'Grade' in df_train.columns:
                df_train = df_train[df_train['Grade'] >= 2].copy()

            for key, tk, md in (
                ('port_upwind', 'port', 'upwind'),
                ('port_downwind', 'port', 'downwind'),
                ('starboard_upwind', 'starboard', 'upwind'),
                ('starboard_downwind', 'starboard', 'downwind'),
            ):
                new_m = train_tack_mode_model(
                    df_train, tk, md, awa_col,
                    features=list(awa_features),
                    min_samples=min_samples_per_model,
                    twa_col=twa_col,
                )
                if new_m is not None:
                    models[key] = new_m

            if verbose:
                trained = [k for k, v in models.items() if v is not None]
                print(
                    f'    [V3] t={t:.0f}: models trained: {trained or "none"} '
                    f'(n_train={len(df_train):,})'
                )
            last_model_update_ts = t

        window = df[(df['ts'] >= t - window_sec) & (df['ts'] <= t)]
        if len(window) == 0:
            if i > 0:
                uw_offsets[i] = uw_offsets[i - 1] if not np.isnan(uw_offsets[i - 1]) else np.nan
                dw_offsets[i] = dw_offsets[i - 1] if not np.isnan(dw_offsets[i - 1]) else np.nan
            continue

        twa_key = _twa_mode_col(twa_col, window)
        twa_abs_w = pd.to_numeric(window[twa_key], errors='coerce').abs()
        window_uw = window[twa_abs_w < PERF_MODEL_UPWIND_ABS_TWA_MAX]
        window_dw = window[twa_abs_w > PERF_MODEL_DOWNWIND_ABS_TWA_MIN]

        if (len(window_uw) > 0 and
                models['port_upwind'] is not None and
                models['starboard_upwind'] is not None and
                all(c in window_uw.columns for c in awa_features)):
            feat_uw = window_uw[awa_features].dropna()
            if len(feat_uw) > 0:
                off = compute_perf_model_awa_offset(
                    models['port_upwind'], models['starboard_upwind'],
                    feat_uw.to_numpy(dtype=np.float64),
                )
                if off is not None:
                    uw_offsets[i] = off

        if (len(window_dw) > 0 and
                models['port_downwind'] is not None and
                models['starboard_downwind'] is not None and
                all(c in window_dw.columns for c in awa_features)):
            feat_dw = window_dw[awa_features].dropna()
            if len(feat_dw) > 0:
                off = compute_perf_model_awa_offset(
                    models['port_downwind'], models['starboard_downwind'],
                    feat_dw.to_numpy(dtype=np.float64),
                )
                if off is not None:
                    dw_offsets[i] = off

        if np.isnan(uw_offsets[i]) and i > 0:
            uw_offsets[i] = uw_offsets[i - 1] if not np.isnan(uw_offsets[i - 1]) else np.nan
        if np.isnan(dw_offsets[i]) and i > 0:
            dw_offsets[i] = dw_offsets[i - 1] if not np.isnan(dw_offsets[i - 1]) else np.nan

        if first_valid_ts is None and not np.isnan(uw_offsets[i]):
            first_valid_ts = float(t)
            first_valid_offset = float(uw_offsets[i])

    # Fill NaN downwind with corresponding upwind at same time index
    dw_offsets_filled = dw_offsets.copy()
    for i in range(len(dw_offsets_filled)):
        if np.isnan(dw_offsets_filled[i]):
            dw_offsets_filled[i] = uw_offsets[i]

    lim = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG
    uw_offsets = _clip_offset_deg_array(uw_offsets, lim)
    dw_offsets_filled = _clip_offset_deg_array(dw_offsets_filled, lim)
    if first_valid_offset is not None:
        first_valid_offset = _clip_offset_deg_scalar(float(first_valid_offset), lim)

    if verbose:
        uw_v = uw_offsets[~np.isnan(uw_offsets)]
        dw_v = dw_offsets_filled[~np.isnan(dw_offsets_filled)]
        if len(uw_v) > 0:
            print(
                f'    [V3 offsets] upwind  : {len(uw_v):,}/{len(uw_offsets):,} valid, '
                f'mean={float(np.mean(uw_v)):.3f}°'
            )
        else:
            print('    [V3 offsets] upwind  : 0 valid — no correction applied')
        if len(dw_v) > 0:
            print(
                f'    [V3 offsets] downwind: {len(dw_v):,}/{len(dw_offsets_filled):,} valid, '
                f'mean={float(np.mean(dw_v)):.3f}°'
            )
        else:
            print('    [V3 offsets] downwind: 0 valid — will fall back to upwind offset')

    return (
        pd.Series(uw_offsets, index=grid_times),
        pd.Series(dw_offsets_filled, index=grid_times),
        first_valid_ts,
        first_valid_offset,
    )


def filter_offset_series_exponential(
    offset_series: pd.Series, alpha: float = 0.001
) -> pd.Series:
    """Apply EMA filter to an offset series (smaller alpha = more smoothing)."""
    if offset_series is None or len(offset_series) == 0:
        return offset_series
    if alpha is None or alpha <= 0 or alpha > 1:
        return offset_series
    sorted_series = offset_series.sort_index()
    vals = sorted_series.values.astype(float)
    if np.any(~np.isnan(vals)):
        smoothed = pd.Series(vals, dtype=float, index=sorted_series.index).ewm(
            alpha=alpha, adjust=False
        ).mean()
        return smoothed.reindex(offset_series.index)
    return offset_series


def filter_offset_dict_exponential(
    offset_dict: Dict[float, float], alpha: float = 0.001
) -> Dict[float, float]:
    """Apply EMA filter to a half-hour offset dictionary."""
    if offset_dict is None or len(offset_dict) == 0:
        return offset_dict
    if alpha is None or alpha <= 0 or alpha > 1:
        return offset_dict
    half_hours = sorted(offset_dict.keys())
    values = [offset_dict[hh] for hh in half_hours]
    if not values:
        return offset_dict
    offset_series = pd.Series(values, index=half_hours, dtype=float)
    filtered = filter_offset_series_exponential(offset_series, alpha=alpha)
    lim = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG
    return {hh: _clip_offset_deg_scalar(float(filtered[hh]), lim) for hh in half_hours}


def compute_awa_perf_model_offset_array(
    df: pd.DataFrame,
    uw_offset_series: pd.Series,
    dw_offset_series: pd.Series,
    first_valid_ts: Optional[float],
    first_valid_offset: Optional[float],
    twa_col: str = 'Twa',
) -> np.ndarray:
    """Per-row blended V3 perf-model AWA offset (before time-ordered ffill/bfill)."""
    if 'ts' not in df.columns or twa_col not in df.columns:
        raise ValueError(f"df must have 'ts' and {twa_col!r} columns")

    ts = df['ts'].values
    twa_band_col = _twa_mode_col(twa_col, df)
    abs_twa = pd.to_numeric(df[twa_band_col], errors='coerce').abs().to_numpy(
        dtype=np.float64
    )
    n = len(df)

    grid_ts_uw = uw_offset_series.index.values
    grid_ts_dw = dw_offset_series.index.values
    offset_vals_uw = uw_offset_series.values
    offset_vals_dw = dw_offset_series.values

    uw_offset_per_row = np.zeros(n, dtype=float)
    dw_offset_per_row = np.zeros(n, dtype=float)

    for i in range(n):
        t = ts[i]
        if first_valid_ts is not None and t < first_valid_ts and first_valid_offset is not None:
            uw_offset_per_row[i] = first_valid_offset
            dw_offset_per_row[i] = first_valid_offset
        else:
            for offset_per_row_arr, grid_ts, offset_vals in (
                (uw_offset_per_row, grid_ts_uw, offset_vals_uw),
                (dw_offset_per_row, grid_ts_dw, offset_vals_dw),
            ):
                idx = np.searchsorted(grid_ts, t, side='right') - 1
                if idx < 0:
                    offset_per_row_arr[i] = (
                        first_valid_offset if first_valid_offset is not None
                        else (offset_vals[0] if len(offset_vals) > 0 and not np.isnan(offset_vals[0]) else 0.0)
                    )
                elif idx >= len(offset_vals) - 1:
                    last_val = offset_vals[-1] if len(offset_vals) > 0 else np.nan
                    offset_per_row_arr[i] = (
                        last_val if not np.isnan(last_val)
                        else (first_valid_offset if first_valid_offset is not None else 0.0)
                    )
                else:
                    t0, t1 = grid_ts[idx], grid_ts[idx + 1]
                    v0, v1 = offset_vals[idx], offset_vals[idx + 1]
                    if np.isnan(v0) and np.isnan(v1):
                        offset_per_row_arr[i] = first_valid_offset if first_valid_offset is not None else 0.0
                    elif np.isnan(v0):
                        offset_per_row_arr[i] = v1
                    elif np.isnan(v1):
                        offset_per_row_arr[i] = v0
                    elif t1 > t0:
                        a = (t - t0) / (t1 - t0)
                        offset_per_row_arr[i] = v0 * (1 - a) + v1 * a
                    else:
                        offset_per_row_arr[i] = v0

    is_upwind = abs_twa < PERF_MODEL_UPWIND_ABS_TWA_MAX
    is_downwind = abs_twa > PERF_MODEL_DOWNWIND_ABS_TWA_MIN
    is_reaching = ~is_upwind & ~is_downwind

    offset_per_row = np.zeros(n, dtype=float)
    offset_per_row[is_upwind] = uw_offset_per_row[is_upwind]
    offset_per_row[is_downwind] = dw_offset_per_row[is_downwind]

    if np.any(is_reaching):
        blend = np.clip((abs_twa[is_reaching] - 80) / (115 - 80), 0, 1)
        offset_per_row[is_reaching] = (
            uw_offset_per_row[is_reaching] * (1 - blend)
            + dw_offset_per_row[is_reaching] * blend
        )

    return _clip_offset_deg_array(offset_per_row)


def apply_awa_perf_model_calibration(
    df: pd.DataFrame,
    uw_offset_series: pd.Series,
    dw_offset_series: pd.Series,
    first_valid_ts: Optional[float],
    first_valid_offset: Optional[float],
    awa_channel_name: str = 'Awa',
    output_applied_column: Optional[str] = 'Awa_offset',
    twa_col: str = 'Twa',
) -> pd.DataFrame:
    """
    Apply V3 performance model AWA offsets.  Modifies ``awa_channel_name`` in-place
    on a copy; optionally stores the per-row applied offset in ``output_applied_column``.
    """
    df = df.copy()
    offset_per_row = compute_awa_perf_model_offset_array(
        df, uw_offset_series, dw_offset_series, first_valid_ts, first_valid_offset,
        twa_col=twa_col,
    )
    ts = df['ts'].values
    offset_per_row = _time_order_ffill_bfill_1d(offset_per_row, ts)
    offset_per_row = np.nan_to_num(offset_per_row, nan=0.0)
    offset_per_row = _clip_offset_deg_array(offset_per_row)

    df[awa_channel_name] = pd.to_numeric(df[awa_channel_name], errors='coerce').to_numpy(
        dtype=np.float64
    ) + offset_per_row
    if output_applied_column:
        df[output_applied_column] = offset_per_row
    return df


# ---------------------------------------------------------------------------
# LEEWAY CALIBRATION
# ---------------------------------------------------------------------------

def train_leeway_model(
    df: pd.DataFrame,
    lwy_col: str,
    features: List[str],
    *,
    twa_col: str = 'Twa',
) -> Optional[XGBRegressor]:
    """
    Train XGBoost model predicting normalized leeway magnitude.
    ``features`` is required (no legacy fallback).
    """
    target = lwy_col
    required = list(features) + [target, twa_col]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f'train_leeway_model: missing columns: {missing}')

    df_clean = df[required].dropna().copy()
    if len(df_clean) < 100:
        raise ValueError(
            f'train_leeway_model: insufficient data {len(df_clean)} rows (minimum 100)'
        )
    df_clean['normalized_lwy'] = df_clean[target] * np.sign(df_clean[twa_col])
    return train_XGBoost(df_clean, features, 'normalized_lwy')


def compute_leeway_residuals(
    df: pd.DataFrame,
    model: XGBRegressor,
    lwy_col: str,
    features: List[str],
    *,
    twa_col: str = 'Twa',
) -> pd.DataFrame:
    """
    Compute leeway prediction residuals (diagnostic; adds ``lwy_residual`` column).
    ``features`` must match the list used to train ``model``.
    """
    df = df.copy()
    X = df[features].values
    predictions = model.predict(X)
    normalized_lwy = df[lwy_col].values * np.sign(df[twa_col].values)
    df['lwy_residual'] = normalized_lwy - predictions
    return df


# ---------------------------------------------------------------------------
# OFFSET PROPAGATION HELPERS
# ---------------------------------------------------------------------------

def _time_order_ffill_bfill_1d(values: np.ndarray, ts: np.ndarray) -> np.ndarray:
    """Forward-fill then back-fill 1D ``values`` along ascending time ``ts``."""
    n = len(values)
    if n == 0:
        return values
    ts = np.asarray(ts, dtype=np.float64)
    if ts.shape[0] != n or np.any(~np.isfinite(ts)):
        ts = np.arange(n, dtype=np.float64)
    order = np.argsort(ts, kind='mergesort')
    inv = np.empty_like(order)
    inv[order] = np.arange(n, dtype=int)
    work = np.asarray(values, dtype=np.float64, order='C')[order]
    filled = pd.Series(work).ffill().bfill().to_numpy()
    return filled[inv]


def _half_hour_offset_lookup(off_map: Dict[float, float], h: float) -> float:
    h = float(h) % 24.0
    if h in off_map:
        return float(off_map[h])
    hr = round(h * 2.0) / 2.0 % 24.0
    return float(off_map.get(hr, off_map.get(h, 0.0)))


def _ts_array_for_df(df: pd.DataFrame) -> np.ndarray:
    n = len(df)
    return df['ts'].values if 'ts' in df.columns else np.arange(n, dtype=np.float64)


def _twa_ff_ordered(df: pd.DataFrame, twa_col: str = 'Twa') -> np.ndarray:
    """TWA forward-filled then back-filled along ``ts`` (for tack / half-hour lookups)."""
    ts = _ts_array_for_df(df)
    twa_raw = pd.to_numeric(df[twa_col], errors='coerce').to_numpy(
        dtype=np.float64, copy=True
    ) if twa_col in df.columns else np.full(len(df), np.nan)
    return _time_order_ffill_bfill_1d(
        np.where(np.isfinite(twa_raw), twa_raw, np.nan), ts
    )


def _half_hour_keys_from_df(df: pd.DataFrame) -> np.ndarray:
    time_hours = df['Datetime'].dt.hour + df['Datetime'].dt.minute / 60.0
    return np.mod(np.round(time_hours.to_numpy(dtype=float) * 2.0) / 2.0, 24.0)


def compute_lwy_offset_norm_raw_array(
    df: pd.DataFrame,
    port_offsets: Dict[float, float],
    stbd_offsets: Dict[float, float],
    twa_ff: np.ndarray,
) -> np.ndarray:
    """Per-row normalized leeway offset from half-hour maps."""
    n = len(df)
    nh = _half_hour_keys_from_df(df)
    offset_norm = np.full(n, np.nan, dtype=np.float64)
    for i in range(n):
        h = float(nh[i])
        if not np.isfinite(twa_ff[i]):
            continue
        if twa_ff[i] < 0:
            offset_norm[i] = _half_hour_offset_lookup(port_offsets, h)
        elif twa_ff[i] > 0:
            offset_norm[i] = _half_hour_offset_lookup(stbd_offsets, h)
    return offset_norm


def _propagate_offset_columns(df: pd.DataFrame, columns: List[str]) -> None:
    """
    In-place: treat offset columns like a sparse merge onto the full timeline.

    For each column: collapse duplicate ``ts`` (last row wins after sorting by time), run
    time-ordered ffill/bfill on the unique ``ts`` grid, broadcast back to every row, then
    ``nan_to_num(..., 0)``.
    """
    if len(df) == 0 or 'ts' not in df.columns:
        return
    ts_all = pd.to_numeric(df['ts'], errors='coerce').to_numpy(dtype=np.float64)
    unique_ts, inv = np.unique(ts_all, return_inverse=True)
    if len(unique_ts) == 0:
        return
    for col in columns:
        if col not in df.columns:
            continue
        arr = pd.to_numeric(df[col], errors='coerce').to_numpy(dtype=np.float64, copy=True)
        tdf = pd.DataFrame({'ts': ts_all, '_v': arr}).sort_values('ts', kind='mergesort')
        per_ts = tdf.groupby('ts', sort=False)['_v'].last()
        u_vals = per_ts.reindex(unique_ts).to_numpy(dtype=np.float64)
        filled_u = _time_order_ffill_bfill_1d(
            np.where(np.isfinite(u_vals), u_vals, np.nan), unique_ts
        )
        df[col] = np.nan_to_num(filled_u[inv], nan=0.0)


def apply_lwy_calibration_using_offsets(
    df: pd.DataFrame,
    lwy_col: str,
    lwy_raw: np.ndarray,
    offset_norm_filled: np.ndarray,
    twa_ff: np.ndarray,
) -> None:
    """``(lwy_raw * sign + offset) * sign`` with ``sign`` from time-filled TWA."""
    sign = np.sign(twa_ff)
    sign[~np.isfinite(sign)] = 1.0
    sign[sign == 0] = 1.0
    new_norm = lwy_raw * sign + offset_norm_filled
    df[lwy_col] = new_norm * sign


def optimize_leeway_offsets(
    df: pd.DataFrame,
    lwy_col: str = 'Lwy',
    twa_col: str = 'Twa',
) -> Tuple[Dict[float, float], Dict[float, float]]:
    """
    Compute leeway offsets using overlapping hourly windows every 30 minutes.

    Returns separate offsets for port and starboard tacks to balance normalized
    leeway means.
    """
    port_offsets: Dict[float, float] = {}
    stbd_offsets: Dict[float, float] = {}

    if 'normalized_lwy' not in df.columns:
        df = df.copy()
        df['normalized_lwy'] = df[lwy_col] * np.sign(df[twa_col])

    for half_hour_idx in range(48):
        window_center = half_hour_idx * 0.5
        start_hour = window_center - 0.5
        end_hour = window_center + 0.5

        df_time = df['Datetime'].dt.hour + df['Datetime'].dt.minute / 60.0
        if start_hour < 0:
            window_mask = (df_time >= (start_hour + 24)) | (df_time < end_hour)
        elif end_hour > 24:
            window_mask = (df_time >= start_hour) | (df_time < (end_hour - 24))
        else:
            window_mask = (df_time >= start_hour) & (df_time < end_hour)

        window_data = df[window_mask]
        if len(window_data) == 0:
            port_offsets[window_center] = 0.0
            stbd_offsets[window_center] = 0.0
            continue

        port_data = window_data[window_data['tack'] == 'port']
        stbd_data = window_data[window_data['tack'] == 'starboard']

        if len(port_data) > 0 and len(stbd_data) > 0:
            port_mean = port_data['normalized_lwy'].mean()
            stbd_mean = stbd_data['normalized_lwy'].mean()
            target = (port_mean + stbd_mean) / 2
            port_offsets[window_center] = target - port_mean
            stbd_offsets[window_center] = target - stbd_mean
        else:
            port_offsets[window_center] = 0.0
            stbd_offsets[window_center] = 0.0

    lim = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG
    port_offsets = {k: _clip_offset_deg_scalar(float(v), lim) for k, v in port_offsets.items()}
    stbd_offsets = {k: _clip_offset_deg_scalar(float(v), lim) for k, v in stbd_offsets.items()}
    return port_offsets, stbd_offsets


def apply_leeway_calibration(
    df: pd.DataFrame,
    port_offsets: Dict[float, float],
    stbd_offsets: Dict[float, float],
    lwy_col: str = 'Lwy',
    twa_col: str = 'Twa',
) -> pd.DataFrame:
    """
    Apply 30-minute leeway offsets in normalized leeway space.

    Derives per-row normalized offsets from port/stbd half-hour maps and TWA (with TWA
    forward/back-filled along ``ts``), propagates with ffill/bfill, then applies
    ``(lwy * sign + offset) * sign`` so Grade < 2 segments inherit neighbor corrections.
    """
    df = df.copy()
    n = len(df)
    if n == 0:
        return df
    ts = _ts_array_for_df(df)
    twa_ff = _twa_ff_ordered(df, twa_col=twa_col)
    raw = compute_lwy_offset_norm_raw_array(df, port_offsets, stbd_offsets, twa_ff)
    offset_norm = _time_order_ffill_bfill_1d(raw, ts)
    offset_norm = np.nan_to_num(offset_norm, nan=0.0)
    offset_norm = _clip_offset_deg_array(offset_norm)
    lwy = pd.to_numeric(df[lwy_col], errors='coerce').to_numpy(dtype=np.float64, copy=True)
    apply_lwy_calibration_using_offsets(df, lwy_col, lwy, offset_norm, twa_ff)
    return df


# ---------------------------------------------------------------------------
# CORE SINGLE-SENSOR CALIBRATION (AWA ONLY — no leeway, no TW recompute)
# ---------------------------------------------------------------------------

def _calibrate_one_sensor(
    df: pd.DataFrame,
    *,
    awa_col: str,
    aws_col: str,
    lwy_col: str,
    bsp_col: str,
    tws_col: str,
    twd_col: str,
    hdg_col: str,
    twa_col: str,
    awa_features: List[str],
    prefer_stream_true_wind: bool = True,
    window_sec: float = 1800,
    step_sec: float = 60,
    model_update_interval_sec: float = 1800,
    min_samples_per_model: int = 100,
    verbose: bool = False,
) -> pd.DataFrame:
    """
    AWA calibration for one sensor pair. Mutates ``df`` in-place and returns it.

    ``calibrate_pipeline`` is the only intended caller and already holds a
    private copy of the dataframe, so this function does not copy.

    Writes ``{awa_col}_cor``, ``{aws_col}_cor``, ``{awa_col}_offset`` onto ``df``.
    The original ``awa_col`` and ``aws_col`` columns are preserved unchanged.
    Does NOT calibrate leeway and does NOT recompute true wind — both are handled
    once by ``calibrate_pipeline`` after all sensors are processed.

    **Multi-sensor note:** ``compute_initial_true_wind`` overwrites the shared
    ``twa_col``/``tws_col``/``twd_col`` columns on every call. In the multi-sensor
    loop this is intentional — each sensor's perf model is trained against TW
    derived from its own AWA/AWS data. After the loop the shared TW columns reflect
    the last sensor processed; they are subsequently replaced by ``Twa_cor``,
    ``Tws_cor``, ``Twd_cor`` from ``recompute_true_wind``.
    """

    # Step 1: Compute initial true wind (uses stream TW when available)
    df = compute_initial_true_wind(
        df,
        awa_col=awa_col,
        aws_col=aws_col,
        bsp_col=bsp_col,
        lwy_col=lwy_col,
        hdg_col=hdg_col,
        twa_col=twa_col,
        tws_col=tws_col,
        twd_col=twd_col,
        prefer_stream_true_wind=prefer_stream_true_wind,
    )

    # Step 2: Tack × mode classification
    df = add_twa_mode_classification_column(df, twa_col=twa_col)
    df = add_tack_and_hour(df, twa_col=twa_col)

    # Step 3: Train rolling offsets on full df (internal Grade>=2 filtering)
    uw_offsets, dw_offsets, first_ts, first_off = compute_rolling_perf_model_awa_offsets(
        df,
        awa_col=awa_col,
        twa_col=twa_col,
        awa_features=awa_features,
        window_sec=window_sec,
        step_sec=step_sec,
        min_samples_per_model=min_samples_per_model,
        model_update_interval_sec=model_update_interval_sec,
        verbose=verbose,
    )

    # Step 4: EMA smooth offsets
    filter_alpha = 0.001
    lim = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG
    uw_offsets = filter_offset_series_exponential(uw_offsets, alpha=filter_alpha).clip(-lim, lim)
    dw_offsets = filter_offset_series_exponential(dw_offsets, alpha=filter_alpha).clip(-lim, lim)
    if first_off is not None:
        first_off = _clip_offset_deg_scalar(float(first_off), lim)

    # Step 5: Compute per-row offset array and write corrected columns
    offset_arr = compute_awa_perf_model_offset_array(
        df, uw_offsets, dw_offsets, first_ts, first_off, twa_col=twa_col
    )
    ts_arr = df['ts'].values
    offset_arr = _time_order_ffill_bfill_1d(offset_arr, ts_arr)
    offset_arr = np.nan_to_num(offset_arr, nan=0.0)
    offset_arr = _clip_offset_deg_array(offset_arr)

    awa_raw = pd.to_numeric(df[awa_col], errors='coerce').to_numpy(dtype=np.float64)
    df[f'{awa_col}_cor'] = awa_raw + offset_arr
    df[f'{awa_col}_offset'] = offset_arr
    # AWS: identity copy (no offset layer for AWS)
    df[f'{aws_col}_cor'] = pd.to_numeric(df[aws_col], errors='coerce').to_numpy(dtype=np.float64)

    return df


# ---------------------------------------------------------------------------
# PUBLIC ENTRY POINT
# ---------------------------------------------------------------------------

def calibrate_pipeline(
    df: pd.DataFrame,
    *,
    awa_col: str = 'Awa',
    aws_col: str = 'Aws',
    lwy_col: str = 'Lwy',
    bsp_col: str = 'Bsp',
    tws_col: str = 'Tws',
    twd_col: str = 'Twd',
    hdg_col: str = 'Hdg',
    twa_col: str = 'Twa',
    awa_features: List[str],
    lwy_features: List[str],
    multi_sensor: bool = False,
    awa_sensors: Optional[List[str]] = None,
    aws_sensors: Optional[List[str]] = None,
    leeway_training_grade: Optional[int] = None,
    prefer_stream_true_wind: bool = True,
    window_sec: float = 1800,
    step_sec: float = 60,
    model_update_interval_sec: float = 1800,
    min_samples_per_model: int = 100,
    verbose: bool = False,
) -> pd.DataFrame:
    """
    Main calibration entry point — handles both single-sensor and multi-sensor flows.

    **Single sensor** (``multi_sensor=False``, default):
        Calls ``_calibrate_one_sensor`` once with ``awa_col`` / ``aws_col``.
        Writes ``Awa_cor``, ``Aws_cor``, ``Awa_offset``.
        Fusion step is skipped.

    **Multi-sensor** (``multi_sensor=True``):
        Requires ``awa_sensors`` (e.g. ``['Awa1','Awa2']``) and ``aws_sensors``.
        Uses simple numeric suffixes — no ``_bow`` / ``_mhu`` style names.
        Calls ``_calibrate_one_sensor`` independently for each pair, then
        ``fuse_sensors_robust`` merges corrected outputs into ``Awa_cor`` / ``Aws_cor``.
        Per-sensor columns (``Awa1_cor``, ``Awa2_cor``, etc.) are preserved in df.

    Both paths then:
        1. Calibrate leeway once (using ``lwy_col``).
        2. Call ``recompute_true_wind`` to write ``Twa_cor``, ``Tws_cor``, ``Twd_cor``.

    Returns the same df with all original columns intact plus new corrected/offset columns.
    """
    df = df.copy()

    _one_sensor_kwargs = dict(
        lwy_col=lwy_col,
        bsp_col=bsp_col,
        tws_col=tws_col,
        twd_col=twd_col,
        hdg_col=hdg_col,
        twa_col=twa_col,
        awa_features=awa_features,
        prefer_stream_true_wind=prefer_stream_true_wind,
        window_sec=window_sec,
        step_sec=step_sec,
        model_update_interval_sec=model_update_interval_sec,
        min_samples_per_model=min_samples_per_model,
        verbose=verbose,
    )

    if not multi_sensor:
        # --- Single sensor ---
        df = _calibrate_one_sensor(df, awa_col=awa_col, aws_col=aws_col, **_one_sensor_kwargs)
        awa_cor_col = f'{awa_col}_cor'
        aws_cor_col = f'{aws_col}_cor'
    else:
        # --- Multi-sensor ---
        if not awa_sensors or not aws_sensors:
            raise ValueError(
                'calibrate_pipeline: multi_sensor=True requires awa_sensors and aws_sensors lists.'
            )
        if len(awa_sensors) != len(aws_sensors):
            raise ValueError(
                f'calibrate_pipeline: awa_sensors ({len(awa_sensors)}) and '
                f'aws_sensors ({len(aws_sensors)}) must have equal length.'
            )

        for awa_s, aws_s in zip(awa_sensors, aws_sensors):
            if verbose:
                print(f'  [multi] Calibrating sensor pair ({awa_s!r}, {aws_s!r})...', flush=True)
            df = _calibrate_one_sensor(df, awa_col=awa_s, aws_col=aws_s, **_one_sensor_kwargs)

        # Fuse corrected AWA sensors → Awa_cor
        from .sensor_fusion import fuse_sensors_robust
        awa_cor_cols = [f'{s}_cor' for s in awa_sensors if f'{s}_cor' in df.columns]
        aws_cor_cols = [f'{s}_cor' for s in aws_sensors if f'{s}_cor' in df.columns]

        if awa_cor_cols:
            fused = fuse_sensors_robust(df, awa_cor_cols)
            df['Awa_cor'] = fused['value_fused'].values
        else:
            df['Awa_cor'] = pd.to_numeric(df[awa_sensors[0]], errors='coerce').to_numpy(
                dtype=np.float64
            )

        if aws_cor_cols:
            fused = fuse_sensors_robust(df, aws_cor_cols)
            df['Aws_cor'] = fused['value_fused'].values
        else:
            df['Aws_cor'] = pd.to_numeric(df[aws_sensors[0]], errors='coerce').to_numpy(
                dtype=np.float64
            )

        awa_cor_col = 'Awa_cor'
        aws_cor_col = 'Aws_cor'

    # --- Leeway calibration (single step for both paths) ---
    df_leeway = _dataframe_for_leeway_calibration(df, leeway_training_grade, min_samples_per_model)

    # Train the XGBoost leeway model and use its residuals for offset optimization so
    # the half-hour statistical offsets only correct what the model missed, not the
    # full port/stbd imbalance.
    lwy_model = None
    try:
        lwy_model = train_leeway_model(df_leeway, lwy_col, lwy_features, twa_col=twa_col)
    except Exception as lwy_err:
        log_info(f'calibrate_pipeline: leeway model training failed ({lwy_err}); offsets computed from raw leeway.')

    df_leeway_opt = df_leeway.copy()
    if lwy_model is not None:
        df_leeway_opt = compute_leeway_residuals(
            df_leeway_opt, lwy_model, lwy_col, lwy_features, twa_col=twa_col
        )
        df_leeway_opt['normalized_lwy'] = df_leeway_opt['lwy_residual']

    port_offsets, stbd_offsets = optimize_leeway_offsets(df_leeway_opt, lwy_col, twa_col=twa_col)
    port_offsets = filter_offset_dict_exponential(port_offsets)
    stbd_offsets = filter_offset_dict_exponential(stbd_offsets)

    # Copy Lwy → Lwy_cor, apply calibration to the copy; preserve original Lwy
    df['Lwy_cor'] = pd.to_numeric(df[lwy_col], errors='coerce').to_numpy(dtype=np.float64, copy=True)
    ts_arr = _ts_array_for_df(df)
    twa_ff = _twa_ff_ordered(df, twa_col=twa_col)
    raw_norm = compute_lwy_offset_norm_raw_array(df, port_offsets, stbd_offsets, twa_ff)
    offset_norm = _time_order_ffill_bfill_1d(raw_norm, ts_arr)
    offset_norm = np.nan_to_num(offset_norm, nan=0.0)
    offset_norm = _clip_offset_deg_array(offset_norm)

    lwy_raw = pd.to_numeric(df[lwy_col], errors='coerce').to_numpy(dtype=np.float64, copy=True)
    apply_lwy_calibration_using_offsets(df, 'Lwy_cor', lwy_raw, offset_norm, twa_ff)
    df['Lwy_offset_norm_deg'] = offset_norm
    df['Lwy_offset'] = pd.to_numeric(df['Lwy_cor'], errors='coerce').to_numpy(
        dtype=np.float64
    ) - lwy_raw

    # --- Recompute true wind from calibrated channels ---
    df = recompute_true_wind(
        df,
        awa_col=awa_cor_col,
        aws_col=aws_cor_col,
        bsp_col=bsp_col,
        lwy_col='Lwy_cor',
        hdg_col=hdg_col,
    )

    # Rename Awa_offset (from single sensor) to canonical name when awa_col != 'Awa'
    if not multi_sensor and awa_col != 'Awa':
        if f'{awa_col}_offset' in df.columns and 'Awa_offset' not in df.columns:
            df['Awa_offset'] = df[f'{awa_col}_offset'].values
    elif not multi_sensor:
        # awa_col == 'Awa': offset column is already 'Awa_offset'
        pass

    return df
