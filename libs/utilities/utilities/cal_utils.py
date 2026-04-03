"""
Calibration utilities for sailing sensor data.

Provides **performance-model** AWA calibration (tack×mode XGB surfaces, matched-condition
offsets), optional multi-sensor fusion, single-sensor apply (no AWA/AWS fusion), and leeway
symmetry corrections. Entries: ``calibrate_and_fuse_pipeline``, ``calibrate_single_sensor_pipeline``.
"""

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
import os
import pandas as pd
import numpy as np
from xgboost import XGBRegressor

from .api_utils import get_channel_values
from .wind_utils import computeTrueWind_vectorized
from .ai_utils import train_XGBoost
from .logging_utils import log_info
from .speed_units import (
    aws_fused_norm_column,
    aws_fused_output_column,
    bsp_tws_feature_names,
    ensure_speed_columns,
    resolve_speed_unit,
    tws_fused_output_column,
)


channels = [
    {'name': 'Datetime', 'type': 'datetime'},
    {'name': 'ts', 'type': 'float'},
    {'name': 'Bsp_kph', 'type': 'float'},
    {'name': 'Twa_deg', 'type': 'angle180'},
    {'name': 'Tws_kph', 'type': 'float'},  # Added for V3 performance model calibration
    {'name': 'Awa_deg', 'type': 'angle180'},
    {'name': 'Awa_bow_deg', 'type': 'angle180'},
    {'name': 'Awa_mhu_deg', 'type': 'angle180'},
    {'name': 'Aws_kph', 'type': 'float'},
    {'name': 'Aws_bow_kph', 'type': 'float'},
    {'name': 'Aws_mhu_kph', 'type': 'float'},
    # Note: Awa_fused_deg, Awa_n_fused_deg, Aws_fused_norm_kph, Aws_fused_kph are
    # computed in the pipeline and do NOT exist in InfluxDB — do not add them here.
    {'name': 'Lwy_deg', 'type': 'float'},
    {'name': 'Hdg_deg', 'type': 'angle360'},
    {'name': 'Cog_deg', 'type': 'angle360'},
    {'name': 'Sog_kph', 'type': 'float'},
    {'name': 'RH_lwd_mm', 'type': 'float'},
    {'name': 'DB_cant_eff_lwd_deg', 'type': 'float'},
    {'name': 'JIB_sheet_load_kgf', 'type': 'float'},
    {'name': 'Grade', 'type': 'int'}
]

@dataclass
class CalibrationConfig:
    """Configuration for calibration data retrieval."""
    api_token: str
    class_name: str
    project_id: str
    date: str
    source_name: str
    rs: str = '1s'  # Resample frequency
    timezone: Optional[str] = None
    start_ts: Optional[float] = None  # Start timestamp (seconds) - aligns with processing data
    end_ts: Optional[float] = None    # End timestamp (seconds) - aligns with processing data
    # None or 'auto': infer from channel suffixes (_kph / _kts); 'kph' / 'kts' forces that unit.
    speed_unit: Optional[str] = None
    # If set, passed to get_channel_values instead of the default ``channels`` list.
    channel_list: Optional[List[Dict[str, str]]] = None
    # Applied to column names immediately after fetch (e.g. AC40_* → Hdg_deg, Awa_bow_deg).
    column_rename: Optional[Dict[str, str]] = None
    # Extra column names (canonical) appended to [Bsp_*, Tws_*] for perf-model AWA XGBoost
    # training and interrogation. Columns missing from the dataframe are ignored.
    perf_model_feature_extras: Optional[List[str]] = None
    # If True, after ``column_rename`` add AC40 leeward foil columns (see ``apply_ac40_foil_derived_columns``).
    apply_ac40_foil_derived_channels: bool = False
    # If set, ``train_leeway_model`` / ``compute_leeway_residuals`` use this feature list instead of
    # the legacy [Bsp_*, RH_lwd_mm, JIB_sheet_load_kgf, DB_cant_eff_lwd_deg] default.
    leeway_model_features: Optional[List[str]] = None


def apply_ac40_foil_derived_columns(df: pd.DataFrame) -> None:
    """
    In-place: leeward foil cant (by ``Twa_deg`` sign), effective cant vs heel, leeward sink.

    - ``Twa_deg`` > 0 → port foil; else → starboard foil.
    - ``Foil_lwd_cant_eff_deg`` = ``Foil_lwd_cant_deg`` - ``Heel_deg``.
    """
    if df is None or len(df) == 0 or 'Twa_deg' not in df.columns:
        return
    twa = pd.to_numeric(df['Twa_deg'], errors='coerce')
    port_side = (twa > 0).fillna(False).to_numpy(dtype=bool)

    if 'Foil_port_cant_deg' in df.columns and 'Foil_stbd_cant_deg' in df.columns:
        fp = pd.to_numeric(df['Foil_port_cant_deg'], errors='coerce').to_numpy(dtype=np.float64)
        fs = pd.to_numeric(df['Foil_stbd_cant_deg'], errors='coerce').to_numpy(dtype=np.float64)
        df['Foil_lwd_cant_deg'] = np.where(port_side, fp, fs)

    if 'Foil_lwd_cant_deg' in df.columns and 'Heel_deg' in df.columns:
        cant = pd.to_numeric(df['Foil_lwd_cant_deg'], errors='coerce').to_numpy(dtype=np.float64)
        heel = pd.to_numeric(df['Heel_deg'], errors='coerce').to_numpy(dtype=np.float64)
        df['Foil_lwd_cant_eff_deg'] = cant - heel

    if 'Foil_port_sink_m' in df.columns and 'Foil_stbd_sink_m' in df.columns:
        psk = pd.to_numeric(df['Foil_port_sink_m'], errors='coerce').to_numpy(dtype=np.float64)
        ssk = pd.to_numeric(df['Foil_stbd_sink_m'], errors='coerce').to_numpy(dtype=np.float64)
        df['Foil_lwd_sink_m'] = np.where(port_side, psk, ssk)


def load_calibration_data(config: CalibrationConfig, 
                          channel_list: Optional[List[Dict[str, str]]] = None,
                          filter_grade: Optional[int] = None,
                          include_all_grades: bool = False) -> pd.DataFrame:
    """
    Load calibration data from API.
    Uses start_ts/end_ts from config when provided to align time range with processing data.
    
    Args:
        config: Configuration containing API credentials and data source info
        channel_list: List of channel dictionaries, defaults to module-level 'channels'
        filter_grade: When ``include_all_grades`` is False: if set to an int, keep only
            ``Grade == filter_grade``; if None (default), keep ``Grade >= 2`` (calibration
            training set). Ignored when ``include_all_grades`` is True.
        include_all_grades: If True, do not filter on ``Grade`` (all quality grades in the
            requested time range). Use for applying trained offsets to the full timeline.
        
    Returns:
        DataFrame with requested channels; by default filtered to Grade >= 2 unless
        ``include_all_grades`` or ``filter_grade`` overrides apply.
    """
    if channel_list is None:
        channel_list = config.channel_list if config.channel_list is not None else channels

    df = get_channel_values(
        api_token=config.api_token,
        class_name=config.class_name,
        project_id=config.project_id,
        date=config.date,
        source_name=config.source_name,
        channel_list=channel_list,
        rs=config.rs,
        start_ts=config.start_ts,
        end_ts=config.end_ts,
        timezone=config.timezone
    )

    if getattr(config, 'column_rename', None):
        df = df.rename(columns=config.column_rename)

    if getattr(config, 'apply_ac40_foil_derived_channels', False):
        apply_ac40_foil_derived_columns(df)

    if include_all_grades:
        return df

    # Filter by grade: default to Grade >= 2 (includes Grade 2 and 3), or exact match if filter_grade is set
    if 'Grade' in df.columns:
        if filter_grade is not None:
            df = df[df['Grade'] == filter_grade].copy()
        else:
            # Default: include Grade 2 and 3 for calibration training
            df = df[df['Grade'] >= 2].copy()
    
    return df


def compute_initial_true_wind(df: pd.DataFrame, 
                               awa_col: str = 'Awa_deg',
                               lwy_col: str = 'Lwy_deg',
                               speed_unit: str = 'kph') -> pd.DataFrame:
    """
    Compute initial true wind using raw (uncalibrated) AWA and leeway.
    Needed to determine tack assignments.
    
    Args:
        df: DataFrame with sensor data
        awa_col: Name of AWA column
        lwy_col: Name of leeway column
        
    Returns:
        DataFrame with ``Tws_{speed_unit}``, Twa_deg, Twd_deg columns added
    """
    df = df.copy()
    
    # For computeTrueWind_vectorized: (aws, awa, stw, hdg, lwy)
    # We use Bsp as STW approximation
    # If no heading, we'll use Twa_deg for initial calculation (circular dependency handled)
    
    # Check if we have heading; if not, estimate from TWA + a reference direction
    if 'Hdg_deg' not in df.columns:
        # Assume TWA is available or compute later
        # For now, use a placeholder - we'll refine in iterations if needed
        hdg = np.zeros(len(df))  # Placeholder, will be updated iteratively
    else:
        hdg = df['Hdg_deg'].values
    
    bsp_c = f'Bsp_{speed_unit}'
    aws_c = aws_feature_column(df, speed_unit)
    if bsp_c not in df.columns or aws_c not in df.columns:
        raise ValueError(
            f"compute_initial_true_wind requires {bsp_c!r} and an AWS speed column; have AWS via {aws_c!r}."
        )
    tws, twa, twd = computeTrueWind_vectorized(
        aws=df[aws_c].values,
        awa=df[awa_col].values,
        stw=df[bsp_c].values,
        hdg=hdg,
        lwy=df[lwy_col].values
    )
    
    tws_out = f'Tws_{speed_unit}'
    df[tws_out] = tws
    df['Twa_deg'] = twa
    df['Twd_deg'] = twd
    
    return df


def add_tack_and_hour(df: pd.DataFrame) -> pd.DataFrame:
    """
    Add tack and hour columns for grouping operations.
    
    Args:
        df: DataFrame with Datetime and Twa_deg columns
        
    Returns:
        DataFrame with 'tack' and 'hour' columns added
    """
    df = df.copy()
    
    # Tack determination: TWA >= 0 is starboard, TWA < 0 is port
    df['tack'] = np.where(df['Twa_deg'] >= 0, 'starboard', 'port')
    
    # Hour of day (0-23)
    df['hour'] = df['Datetime'].dt.hour
    
    return df


def aws_feature_column(df: pd.DataFrame, speed_unit: str = 'kph') -> str:
    """Prefer pre-calibration fused AWS, then post-cal Aws_fused_*, else SGP Aws_* for ``speed_unit``."""
    norm = aws_fused_norm_column(speed_unit)
    fused = aws_fused_output_column(speed_unit)
    raw = f'Aws_{speed_unit}'
    for c in (norm, fused, raw):
        if c in df.columns:
            return c
    for c in df.columns:
        if c.startswith('Aws_') and c.endswith(f'_{speed_unit}'):
            return c
    raise ValueError(f"No AWS speed column found for unit {speed_unit!r} in dataframe columns.")


def _default_pre_fusion_awa_sensors(df: pd.DataFrame, primary_awa: str) -> List[str]:
    preferred = ['Awa_bow_deg', 'Awa_mhu_deg']
    avail = [c for c in preferred if c in df.columns]
    if len(avail) >= 2:
        return avail
    if primary_awa in df.columns:
        return [primary_awa]
    return [c for c in preferred if c in df.columns]


def _default_pre_fusion_aws_sensors(df: pd.DataFrame, speed_unit: str = 'kph') -> List[str]:
    suf = f'_{speed_unit}'
    preferred = [f'Aws_bow{suf}', f'Aws_mhu{suf}']
    avail = [c for c in preferred if c in df.columns]
    if len(avail) >= 2:
        return avail
    raw = f'Aws{suf}'
    if raw in df.columns:
        return [raw]
    return avail


def add_pre_calibration_fused_awa_aws(
    df: pd.DataFrame,
    awa_sensors: List[str],
    aws_sensors: Optional[List[str]],
    speed_unit: str = 'kph',
) -> pd.DataFrame:
    """
    Robust fuse of raw AWA/AWS from listed sensors before calibration offsets.
    Writes Awa_n_fused_deg (and Awa_fused_pre_deg when >=2 AWA), Aws_fused_norm_{speed_unit}.
    Post-calibration fuse_awa_aws_pairs still writes Awa_fused_deg / Aws_fused_*.
    """
    from .sensor_fusion import fuse_sensors_robust

    df = df.copy()
    awa_avail = [s for s in awa_sensors if s in df.columns]
    if len(awa_avail) >= 2:
        tmp = fuse_sensors_robust(df, awa_avail)
        df['Awa_fused_pre_deg'] = tmp['value_fused'].values
        df['Awa_n_fused_deg'] = np.abs(df['Awa_fused_pre_deg'].values)
    elif len(awa_avail) == 1:
        v = pd.to_numeric(df[awa_avail[0]], errors='coerce')
        df['Awa_n_fused_deg'] = np.abs(v.values)

    norm_col = aws_fused_norm_column(speed_unit)
    raw_aws = f'Aws_{speed_unit}'
    aws_avail = [s for s in (aws_sensors or []) if s in df.columns]
    if len(aws_avail) >= 2:
        tmp = fuse_sensors_robust(df, aws_avail)
        df[norm_col] = tmp['value_fused'].values
    elif len(aws_avail) == 1:
        df[norm_col] = pd.to_numeric(df[aws_avail[0]], errors='coerce').values
    elif raw_aws in df.columns:
        df[norm_col] = pd.to_numeric(df[raw_aws], errors='coerce').values

    if raw_aws not in df.columns and norm_col in df.columns:
        df[raw_aws] = df[norm_col].values

    return df


# ============================================================================
# PERFORMANCE MODEL AWA CALIBRATION (tack × mode XGB surfaces)
# ============================================================================

# Maximum magnitude (degrees) for AWA performance-model offsets and normalized leeway offsets.
MAX_AWA_LWY_CALIBRATION_OFFSET_DEG = 5.0


def _clip_offset_deg_scalar(value: float, limit: float = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG) -> float:
    """Clip a single offset to ``[-limit, limit]``."""
    return float(np.clip(value, -limit, limit))


def _clip_offset_deg_array(
    arr: np.ndarray, limit: float = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG
) -> np.ndarray:
    """Clip array to ``[-limit, limit]`` (NaNs preserved)."""
    return np.clip(np.asarray(arr, dtype=np.float64), -limit, limit)


def perf_model_awa_feature_names(
    speed_unit: str,
    df: pd.DataFrame,
    extras: Optional[List[str]] = None,
) -> List[str]:
    """
    Ordered feature list for tack×mode AWA performance models: Bsp, Tws, then optional extras
    present in ``df``.
    """
    names: List[str] = list(bsp_tws_feature_names(speed_unit))
    for c in extras or []:
        if c and c not in names and c in df.columns:
            names.append(c)
    return names


def train_tack_mode_model(
    df: pd.DataFrame,
    tack: str,
    mode: str,
    awa_channel_name: str = 'Awa_deg',
    features: Optional[List[str]] = None,
    min_samples: int = 100,
    speed_unit: str = 'kph',
) -> Optional[XGBRegressor]:
    """
    Train XGBoost model to predict absolute AWA for a specific tack and sailing mode.
    
    V3 approach: separate models per tack (port/starboard) × mode (upwind/downwind)
    to capture boat performance differences. Uses features [Bsp_*, Tws_*] for ``speed_unit`` to
    predict abs(AWA) at matched conditions.
    
    Args:
        df: DataFrame with feature and target columns, including 'tack' and 'Twa_deg'
        tack: 'port' or 'starboard' to filter data
        mode: 'upwind' or 'downwind' to filter by TWA band
        awa_channel_name: Name of AWA column to predict
        features: Feature columns (default: Bsp/Tws for ``speed_unit``)
        min_samples: Minimum samples required for training
        
    Returns:
        Trained XGBRegressor model, or None if insufficient data
    """
    if features is None:
        features = list(bsp_tws_feature_names(speed_unit))
    
    # Filter by tack
    if tack == 'port':
        df_tack = df[df['tack'] == 'port'].copy()
    elif tack == 'starboard':
        df_tack = df[df['tack'] == 'starboard'].copy()
    else:
        raise ValueError(f"tack must be 'port' or 'starboard', got '{tack}'")
    
    # Filter by mode (upwind/downwind)
    if 'Twa_deg' not in df_tack.columns:
        raise ValueError("Twa_deg column required for mode filtering")
    
    if mode == 'upwind':
        # Upwind: abs(Twa) < 80
        df_mode = df_tack[df_tack['Twa_deg'].abs() < 80].copy()
    elif mode == 'downwind':
        # Downwind: abs(Twa) > 115
        df_mode = df_tack[df_tack['Twa_deg'].abs() > 115].copy()
    else:
        raise ValueError(f"mode must be 'upwind' or 'downwind', got '{mode}'")
    
    # Check for required columns
    required = features + [awa_channel_name]
    missing = [c for c in required if c not in df_mode.columns]
    if missing:
        return None  # Insufficient data, return None instead of raising
    
    # Remove rows with NaN in features or target
    df_clean = df_mode[required].dropna().copy()
    
    if len(df_clean) < min_samples:
        return None  # Insufficient data
    
    # Train on absolute AWA values
    df_clean['abs_awa'] = df_clean[awa_channel_name].abs()
    try:
        model = train_XGBoost(df_clean, features, 'abs_awa')
        return model
    except Exception:
        return None


def compute_perf_model_awa_offset(
    port_model: Optional[XGBRegressor],
    stbd_model: Optional[XGBRegressor],
    query_X: np.ndarray,
) -> Optional[float]:
    """
    Compute AWA offset by interrogating port and starboard models at matched conditions.

    Evaluates both models at the same feature rows (Bsp, Tws, and any trained extras)
    and returns the mean difference divided by 2.

    Args:
        port_model: Trained XGBRegressor for port tack (predicts abs(AWA))
        stbd_model: Trained XGBRegressor for starboard tack (predicts abs(AWA))
        query_X: Feature matrix ``(n_rows, n_features)`` matching training column order.

    Returns:
        Scalar offset value (degrees), or None if either model is missing
    """
    if port_model is None or stbd_model is None:
        return None

    if query_X is None or len(query_X) == 0:
        return None

    X = np.asarray(query_X, dtype=np.float64)
    if X.ndim == 1:
        X = X.reshape(1, -1)

    # Predict from both models
    port_pred = port_model.predict(X)
    stbd_pred = stbd_model.predict(X)
    
    # Offset = mean(port_pred - stbd_pred) / 2
    # This is the correction needed: positive means port reads higher, so we add to both
    # to reduce port magnitude and increase stbd magnitude
    offset = float(np.mean(port_pred - stbd_pred) / 2.0)
    return _clip_offset_deg_scalar(offset)


def compute_rolling_perf_model_awa_offsets(
    df: pd.DataFrame,
    awa_channel_name: str = 'Awa_deg',
    window_sec: float = 30 * 60,
    step_sec: float = 60,
    min_samples_per_model: int = 100,
    model_update_interval_sec: float = 30 * 60,
    speed_unit: str = 'kph',
    perf_model_feature_extras: Optional[List[str]] = None,
) -> Tuple[pd.Series, pd.Series, Optional[float], Optional[float]]:
    """
    Compute rolling AWA offsets using V3 performance model approach.
    
    Trains four separate models (port/starboard × upwind/downwind) and interrogates
    them at matched conditions to derive time-varying offsets. Models are retrained
    at regular intervals using Grade >= 2 data accumulated up to that point.
    
    Args:
        df: DataFrame sorted by ts, with ts, tack, Twa_deg, Bsp_*, Tws_* (matching ``speed_unit``), awa_channel_name
        awa_channel_name: Name of AWA column
        window_sec: Trailing window length in seconds for query condition extraction
        step_sec: Grid step in seconds
        min_samples_per_model: Minimum samples per model for training
        model_update_interval_sec: Interval (seconds) between model retraining
        perf_model_feature_extras: Optional extra columns (must exist in ``df``) for XGBoost features.

    Returns:
        (uw_offset_series, dw_offset_series, first_valid_ts, first_valid_offset)
        - uw_offset_series: Series index=grid ts, value=upwind offset
        - dw_offset_series: Series index=grid ts, value=downwind offset
        - first_valid_ts: First grid time with valid offset, or None
        - first_valid_offset: Offset at first_valid_ts (upwind), or None
    """
    if 'ts' not in df.columns or 'tack' not in df.columns or 'Twa_deg' not in df.columns:
        raise ValueError("df must have columns: ts, tack, Twa_deg")
    bsp_col, tws_col = bsp_tws_feature_names(speed_unit)
    if bsp_col not in df.columns or tws_col not in df.columns:
        raise ValueError(
            f"compute_rolling_perf_model_awa_offsets requires {bsp_col!r} and {tws_col!r}"
        )

    feature_list = perf_model_awa_feature_names(speed_unit, df, perf_model_feature_extras)

    df = df.sort_values('ts').reset_index(drop=True)
    t_min = float(df['ts'].min())
    t_max = float(df['ts'].max())
    grid_times = np.arange(t_min, t_max + step_sec * 0.5, step_sec)
    
    uw_offsets = np.full(len(grid_times), np.nan)
    dw_offsets = np.full(len(grid_times), np.nan)
    
    first_valid_ts: Optional[float] = None
    first_valid_offset: Optional[float] = None
    
    # Track models and last update time
    models = {
        'port_upwind': None,
        'port_downwind': None,
        'starboard_upwind': None,
        'starboard_downwind': None
    }
    last_model_update_ts = None
    
    for i, t in enumerate(grid_times):
        # Check if we need to retrain models
        if (last_model_update_ts is None or 
            (t - last_model_update_ts) >= model_update_interval_sec):
            # Retrain all 4 models using Grade >= 2 data from start to current time
            df_train = df[(df['ts'] <= t) & (df['ts'] >= t_min)].copy()
            
            if 'Grade' in df_train.columns:
                df_train = df_train[df_train['Grade'] >= 2].copy()
            
            # Attempt to train each model independently; train_tack_mode_model returns
            # None when a tack×mode lacks sufficient samples (min_samples_per_model).
            new_pu = train_tack_mode_model(
                df_train, 'port', 'upwind', awa_channel_name,
                features=list(feature_list),
                min_samples=min_samples_per_model,
                speed_unit=speed_unit,
            )
            new_pd = train_tack_mode_model(
                df_train, 'port', 'downwind', awa_channel_name,
                features=list(feature_list),
                min_samples=min_samples_per_model,
                speed_unit=speed_unit,
            )
            new_su = train_tack_mode_model(
                df_train, 'starboard', 'upwind', awa_channel_name,
                features=list(feature_list),
                min_samples=min_samples_per_model,
                speed_unit=speed_unit,
            )
            new_sd = train_tack_mode_model(
                df_train, 'starboard', 'downwind', awa_channel_name,
                features=list(feature_list),
                min_samples=min_samples_per_model,
                speed_unit=speed_unit,
            )
            # Only replace a model if it successfully trained (keep last good model otherwise)
            if new_pu is not None:
                models['port_upwind'] = new_pu
            if new_pd is not None:
                models['port_downwind'] = new_pd
            if new_su is not None:
                models['starboard_upwind'] = new_su
            if new_sd is not None:
                models['starboard_downwind'] = new_sd
            trained = [k for k, v in models.items() if v is not None]
            print(f"    [V3] t={t:.0f}: models trained: {trained or 'none'} "
                  f"(n_train={len(df_train):,})")
            last_model_update_ts = t
        
        # Extract query conditions from trailing window
        window = df[(df['ts'] >= t - window_sec) & (df['ts'] <= t)]
        
        if len(window) == 0:
            # Carry forward last valid offset
            if i > 0:
                uw_offsets[i] = uw_offsets[i-1] if not np.isnan(uw_offsets[i-1]) else np.nan
                dw_offsets[i] = dw_offsets[i-1] if not np.isnan(dw_offsets[i-1]) else np.nan
            continue
        
        # Extract upwind and downwind conditions from window
        window_uw = window[window['Twa_deg'].abs() < 80]
        window_dw = window[window['Twa_deg'].abs() > 115]
        
        # Compute upwind offset
        if (len(window_uw) > 0 and
                models['port_upwind'] is not None and
                models['starboard_upwind'] is not None and
                all(c in window_uw.columns for c in feature_list)):
            feat_uw = window_uw[feature_list].dropna()
            if len(feat_uw) > 0:
                X_uw = feat_uw.to_numpy(dtype=np.float64, copy=False)
                offset_uw = compute_perf_model_awa_offset(
                    models['port_upwind'], models['starboard_upwind'], X_uw
                )
                if offset_uw is not None:
                    uw_offsets[i] = offset_uw

        # Compute downwind offset
        if (len(window_dw) > 0 and
                models['port_downwind'] is not None and
                models['starboard_downwind'] is not None and
                all(c in window_dw.columns for c in feature_list)):
            feat_dw = window_dw[feature_list].dropna()
            if len(feat_dw) > 0:
                X_dw = feat_dw.to_numpy(dtype=np.float64, copy=False)
                offset_dw = compute_perf_model_awa_offset(
                    models['port_downwind'], models['starboard_downwind'], X_dw
                )
                if offset_dw is not None:
                    dw_offsets[i] = offset_dw
        
        # Carry forward if no valid offset computed
        if np.isnan(uw_offsets[i]) and i > 0:
            uw_offsets[i] = uw_offsets[i-1] if not np.isnan(uw_offsets[i-1]) else np.nan
        if np.isnan(dw_offsets[i]) and i > 0:
            dw_offsets[i] = dw_offsets[i-1] if not np.isnan(dw_offsets[i-1]) else np.nan
        
        # Track first valid offset
        if first_valid_ts is None and not np.isnan(uw_offsets[i]):
            first_valid_ts = float(t)
            first_valid_offset = float(uw_offsets[i])
    
    uw_valid = uw_offsets[~np.isnan(uw_offsets)]
    dw_valid = dw_offsets[~np.isnan(dw_offsets)]
    print(f"    [V3 offsets] upwind  : {len(uw_valid):,}/{len(uw_offsets):,} valid, "
          f"mean={float(np.mean(uw_valid)):.3f}°, range=[{float(np.min(uw_valid)):.3f}, {float(np.max(uw_valid)):.3f}]°"
          if len(uw_valid) > 0 else f"    [V3 offsets] upwind  : 0 valid — no correction applied")
    print(f"    [V3 offsets] downwind: {len(dw_valid):,}/{len(dw_offsets):,} valid, "
          f"mean={float(np.mean(dw_valid)):.3f}°, range=[{float(np.min(dw_valid)):.3f}, {float(np.max(dw_valid)):.3f}]°"
          if len(dw_valid) > 0 else f"    [V3 offsets] downwind: 0 valid — will fall back to upwind offset")

    # Fill NaN downwind offsets with the corresponding upwind offset (same time index).
    # This is better than falling back to first_valid_offset when downwind models can't train.
    dw_offsets_filled = dw_offsets.copy()
    for i in range(len(dw_offsets_filled)):
        if np.isnan(dw_offsets_filled[i]):
            dw_offsets_filled[i] = uw_offsets[i]

    lim = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG
    uw_offsets = _clip_offset_deg_array(uw_offsets, lim)
    dw_offsets_filled = _clip_offset_deg_array(dw_offsets_filled, lim)
    if first_valid_offset is not None:
        first_valid_offset = _clip_offset_deg_scalar(float(first_valid_offset), lim)

    uw_offset_series = pd.Series(uw_offsets, index=grid_times)
    dw_offset_series = pd.Series(dw_offsets_filled, index=grid_times)
    
    return uw_offset_series, dw_offset_series, first_valid_ts, first_valid_offset


def filter_offset_series_exponential(offset_series: pd.Series, alpha: float = 0.001) -> pd.Series:
    """
    Apply exponential moving average filter to an offset series to dampen changes.
    
    Args:
        offset_series: Series with index=ts, value=offset
        alpha: EMA alpha parameter (0 < alpha <= 1). Smaller values = more smoothing.
            Default 0.001 matches the EMA_ALPHA used for TWS/TWD smoothing.
    
    Returns:
        Filtered Series with same index
    """
    if offset_series is None or len(offset_series) == 0:
        return offset_series
    if alpha is None or alpha <= 0 or alpha > 1:
        return offset_series
    
    # Sort by index (timestamp) to ensure proper temporal ordering
    sorted_series = offset_series.sort_index()
    vals = sorted_series.values.astype(float)
    
    if np.any(~np.isnan(vals)):
        # Apply exponential moving average
        smoothed = pd.Series(vals, dtype=float, index=sorted_series.index).ewm(
            alpha=alpha, adjust=False
        ).mean()
        # Return with original index order if it was different
        return smoothed.reindex(offset_series.index)
    
    return offset_series


def filter_offset_dict_exponential(offset_dict: Dict[float, float], alpha: float = 0.001) -> Dict[float, float]:
    """
    Apply exponential moving average filter to a dictionary-based offset (e.g., half-hour offsets).
    
    Converts the dictionary to a time series (treating half-hour keys as sequential), applies
    exponential filtering, and converts back to dictionary format. This dampens rapid changes
    in offsets similar to the filtering applied to corrected TWS/TWD data.
    
    Args:
        offset_dict: Dictionary mapping half-hour (0.0, 0.5, 1.0, ..., 23.5) to offset values
        alpha: EMA alpha parameter (0 < alpha <= 1). Smaller values = more smoothing.
            Default 0.001 matches the EMA_ALPHA used for TWS/TWD smoothing.
    
    Returns:
        Filtered dictionary with same keys
    """
    if offset_dict is None or len(offset_dict) == 0:
        return offset_dict
    if alpha is None or alpha <= 0 or alpha > 1:
        return offset_dict
    
    # Convert dictionary to sorted Series (by half-hour key)
    half_hours = sorted(offset_dict.keys())
    values = [offset_dict[hh] for hh in half_hours]
    
    if len(values) == 0:
        return offset_dict
    
    # Create a Series with half-hour as index for filtering
    offset_series = pd.Series(values, index=half_hours, dtype=float)
    
    # Apply exponential moving average filter
    filtered_series = filter_offset_series_exponential(offset_series, alpha=alpha)
    
    # Convert back to dictionary and clamp (same limit as AWA / leeway offsets)
    lim = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG
    filtered_dict = {
        hh: _clip_offset_deg_scalar(float(filtered_series[hh]), lim) for hh in half_hours
    }
    
    return filtered_dict


def compute_awa_perf_model_offset_array(
    df: pd.DataFrame,
    uw_offset_series: pd.Series,
    dw_offset_series: pd.Series,
    first_valid_ts: Optional[float],
    first_valid_offset: Optional[float],
) -> np.ndarray:
    """
    Per-row blended V3 perf-model AWA offset (before time-ordered ffill/bfill on the offset channel).
    """
    if "ts" not in df.columns or "Twa_deg" not in df.columns:
        raise ValueError("df must have 'ts' and 'Twa_deg' columns")

    ts = df["ts"].values
    abs_twa = df["Twa_deg"].abs().values
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
            idx_uw = np.searchsorted(grid_ts_uw, t, side="right") - 1
            if idx_uw < 0:
                if first_valid_offset is not None:
                    uw_offset_per_row[i] = first_valid_offset
                else:
                    uw_offset_per_row[i] = (
                        offset_vals_uw[0] if len(offset_vals_uw) > 0 and not np.isnan(offset_vals_uw[0]) else 0.0
                    )
            elif idx_uw >= len(offset_vals_uw) - 1:
                last_val = offset_vals_uw[-1] if len(offset_vals_uw) > 0 else np.nan
                if not np.isnan(last_val):
                    uw_offset_per_row[i] = last_val
                elif first_valid_offset is not None:
                    uw_offset_per_row[i] = first_valid_offset
                else:
                    uw_offset_per_row[i] = 0.0
            else:
                t0, t1 = grid_ts_uw[idx_uw], grid_ts_uw[idx_uw + 1]
                v0, v1 = offset_vals_uw[idx_uw], offset_vals_uw[idx_uw + 1]
                if np.isnan(v0) and np.isnan(v1):
                    uw_offset_per_row[i] = first_valid_offset if first_valid_offset is not None else 0.0
                elif np.isnan(v0):
                    uw_offset_per_row[i] = v1
                elif np.isnan(v1):
                    uw_offset_per_row[i] = v0
                elif t1 > t0:
                    alpha = (t - t0) / (t1 - t0)
                    uw_offset_per_row[i] = v0 * (1 - alpha) + v1 * alpha
                else:
                    uw_offset_per_row[i] = v0

            idx_dw = np.searchsorted(grid_ts_dw, t, side="right") - 1
            if idx_dw < 0:
                if first_valid_offset is not None:
                    dw_offset_per_row[i] = first_valid_offset
                else:
                    dw_offset_per_row[i] = (
                        offset_vals_dw[0] if len(offset_vals_dw) > 0 and not np.isnan(offset_vals_dw[0]) else 0.0
                    )
            elif idx_dw >= len(offset_vals_dw) - 1:
                last_val = offset_vals_dw[-1] if len(offset_vals_dw) > 0 else np.nan
                if not np.isnan(last_val):
                    dw_offset_per_row[i] = last_val
                elif first_valid_offset is not None:
                    dw_offset_per_row[i] = first_valid_offset
                else:
                    dw_offset_per_row[i] = 0.0
            else:
                t0, t1 = grid_ts_dw[idx_dw], grid_ts_dw[idx_dw + 1]
                v0, v1 = offset_vals_dw[idx_dw], offset_vals_dw[idx_dw + 1]
                if np.isnan(v0) and np.isnan(v1):
                    dw_offset_per_row[i] = first_valid_offset if first_valid_offset is not None else 0.0
                elif np.isnan(v0):
                    dw_offset_per_row[i] = v1
                elif np.isnan(v1):
                    dw_offset_per_row[i] = v0
                elif t1 > t0:
                    alpha = (t - t0) / (t1 - t0)
                    dw_offset_per_row[i] = v0 * (1 - alpha) + v1 * alpha
                else:
                    dw_offset_per_row[i] = v0

    is_upwind = abs_twa < 80
    is_downwind = abs_twa > 115
    is_reaching = ~is_upwind & ~is_downwind

    offset_per_row = np.zeros(n, dtype=float)
    offset_per_row[is_upwind] = uw_offset_per_row[is_upwind]
    offset_per_row[is_downwind] = dw_offset_per_row[is_downwind]

    if np.any(is_reaching):
        reaching_twa = abs_twa[is_reaching]
        blend_alpha = np.clip((reaching_twa - 80) / (115 - 80), 0, 1)
        reaching_uw_offsets = uw_offset_per_row[is_reaching]
        reaching_dw_offsets = dw_offset_per_row[is_reaching]
        offset_per_row[is_reaching] = (
            reaching_uw_offsets * (1 - blend_alpha) + reaching_dw_offsets * blend_alpha
        )

    return _clip_offset_deg_array(offset_per_row)


def apply_awa_perf_model_calibration(
    df: pd.DataFrame,
    uw_offset_series: pd.Series,
    dw_offset_series: pd.Series,
    first_valid_ts: Optional[float],
    first_valid_offset: Optional[float],
    awa_channel_name: str = 'Awa_deg',
    output_applied_column: Optional[str] = 'Awa_offset_deg',
) -> pd.DataFrame:
    """
    Apply V3 performance model AWA offsets based on sailing mode.
    
    Per row, determines upwind/downwind/reaching and applies appropriate offset
    interpolated from the time series. Reaching rows blend between upwind and
    downwind offsets.
    
    Args:
        df: DataFrame with ts, Twa_deg, and AWA column
        uw_offset_series: Series index=grid ts, value=upwind offset
        dw_offset_series: Series index=grid ts, value=downwind offset
        first_valid_ts: First time with valid offset (for backfill)
        first_valid_offset: Offset at first_valid_ts (upwind)
        awa_channel_name: AWA column to calibrate
        output_applied_column: If set, add column with offset applied per row
        
    Returns:
        DataFrame with calibrated AWA and optional Awa_offset_deg column
    """
    df = df.copy()

    offset_per_row = compute_awa_perf_model_offset_array(
        df, uw_offset_series, dw_offset_series, first_valid_ts, first_valid_offset
    )
    ts = df["ts"].values
    offset_per_row = _time_order_ffill_bfill_1d(offset_per_row, ts)
    offset_per_row = np.nan_to_num(offset_per_row, nan=0.0)
    offset_per_row = _clip_offset_deg_array(offset_per_row)

    df[awa_channel_name] = df[awa_channel_name].values + offset_per_row

    if output_applied_column:
        df[output_applied_column] = offset_per_row

    return df


def train_leeway_model(
    df: pd.DataFrame,
    lwy_col: str = 'Lwy_deg',
    speed_unit: str = 'kph',
    features: Optional[List[str]] = None,
) -> Optional[XGBRegressor]:
    """
    Train XGBoost model to predict leeway magnitude from boat state.
    
    Uses normalized leeway (Lwy * sign(TWA)) as target to learn magnitude
    relationship independent of tack sign.
    
    Args:
        df: DataFrame with feature and target columns, including 'tack' column
        lwy_col: Name of leeway column
        speed_unit: Used only when ``features`` is None (legacy default includes ``Bsp_{speed_unit}``).
        features: Optional explicit feature column names; if None, uses RH/jib/cant legacy set.

    Returns:
        Trained XGBRegressor model, or None if training fails
    """
    if features is None:
        features = [f'Bsp_{speed_unit}', 'RH_lwd_mm', 'JIB_sheet_load_kgf', 'DB_cant_eff_lwd_deg']
    target = lwy_col

    # Check for required columns
    required = list(features) + [target, 'Twa_deg']
    if not all(col in df.columns for col in required):
        raise ValueError(f"Missing required columns for leeway model: {required}")
    
    # Remove rows with NaN
    df_clean = df[required].dropna().copy()
    
    if len(df_clean) < 100:
        raise ValueError(f"Insufficient data for training leeway model: {len(df_clean)} rows (minimum 100 required)")
    
    # Normalize leeway by sign(TWA) so it's always same sign regardless of tack
    # This way model learns: "given boat state, what is leeway magnitude?"
    df_clean['normalized_lwy'] = df_clean[target] * np.sign(df_clean['Twa_deg'])
    model = train_XGBoost(df_clean, features, 'normalized_lwy')
    
    return model


def compute_leeway_residuals(
    df: pd.DataFrame,
    model: XGBRegressor,
    lwy_col: str = 'Lwy_deg',
    speed_unit: str = 'kph',
    features: Optional[List[str]] = None,
) -> pd.DataFrame:
    """
    Compute leeway prediction residuals using normalized values.
    
    Since model predicts normalized leeway (lwy * sign(twa)), residuals show
    magnitude errors independent of tack.
    
    Args:
        df: DataFrame with sensor data including 'Twa_deg' column
        model: Trained leeway prediction model (predicts normalized values)
        lwy_col: Name of leeway column
        speed_unit: Used only when ``features`` is None.
        features: Must match the list used to train ``model`` when overriding defaults.

    Returns:
        DataFrame with 'lwy_residual' column added
    """
    df = df.copy()

    if features is None:
        features = [f'Bsp_{speed_unit}', 'RH_lwd_mm', 'JIB_sheet_load_kgf', 'DB_cant_eff_lwd_deg']
    
    # Predict normalized leeway
    X = df[features].values
    predictions = model.predict(X)
    
    # Normalize actual leeway and compute residuals
    normalized_lwy = df[lwy_col].values * np.sign(df['Twa_deg'].values)
    df['lwy_residual'] = normalized_lwy - predictions
    
    return df


def _time_order_ffill_bfill_1d(values: np.ndarray, ts: np.ndarray) -> np.ndarray:
    """
    Forward-fill then back-fill 1D ``values`` along ascending time ``ts``, then restore row order.
    Used to propagate calibration offsets into low-grade segments (Grade < 2) after they are
    derived on Grade >= 2 rows.
    """
    n = len(values)
    if n == 0:
        return values
    ts = np.asarray(ts, dtype=np.float64)
    if ts.shape[0] != n or np.any(~np.isfinite(ts)):
        ts = np.arange(n, dtype=np.float64)
    order = np.argsort(ts, kind="mergesort")
    inv = np.empty_like(order)
    inv[order] = np.arange(n, dtype=int)
    work = np.asarray(values, dtype=np.float64, order="C")[order]
    filled = pd.Series(work).ffill().bfill().to_numpy()
    return filled[inv]


def _half_hour_offset_lookup(off_map: Dict[float, float], h: float) -> float:
    """Resolve 30-minute clock key (0, 0.5, …, 23.5) for offset dictionaries."""
    h = float(h) % 24.0
    if h in off_map:
        return float(off_map[h])
    hr = round(h * 2.0) / 2.0 % 24.0
    return float(off_map.get(hr, off_map.get(h, 0.0)))


def _ts_array_for_df(df: pd.DataFrame) -> np.ndarray:
    n = len(df)
    return df["ts"].values if "ts" in df.columns else np.arange(n, dtype=np.float64)


def _twa_ff_ordered(df: pd.DataFrame) -> np.ndarray:
    """TWA forward-filled then back-filled along ``ts`` (for tack / half-hour lookups)."""
    ts = _ts_array_for_df(df)
    twa_raw = pd.to_numeric(df["Twa_deg"], errors="coerce").to_numpy(dtype=np.float64, copy=True)
    return _time_order_ffill_bfill_1d(np.where(np.isfinite(twa_raw), twa_raw, np.nan), ts)


def _half_hour_keys_from_df(df: pd.DataFrame) -> np.ndarray:
    time_hours = df["Datetime"].dt.hour + df["Datetime"].dt.minute / 60.0
    return np.mod(np.round(time_hours.to_numpy(dtype=float) * 2.0) / 2.0, 24.0)


def compute_lwy_offset_norm_raw_array(
    df: pd.DataFrame,
    port_offsets: Dict[float, float],
    stbd_offsets: Dict[float, float],
    twa_ff: np.ndarray,
) -> np.ndarray:
    """Per-row normalized leeway offset from half-hour maps (before time-ordered ffill/bfill)."""
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
    ``nan_to_num(..., 0)``. This matches “merge offsets with full stream, then ffill/bfill”
    and avoids gaps when duplicate timestamps or uneven row order break naive row-wise fill.
    """
    if len(df) == 0 or "ts" not in df.columns:
        return
    ts_all = pd.to_numeric(df["ts"], errors="coerce").to_numpy(dtype=np.float64, copy=False)
    unique_ts, inv = np.unique(ts_all, return_inverse=True)
    if len(unique_ts) == 0:
        return
    for col in columns:
        if col not in df.columns:
            continue
        arr = pd.to_numeric(df[col], errors="coerce").to_numpy(dtype=np.float64, copy=True)
        tdf = pd.DataFrame({"ts": ts_all, "_v": arr}).sort_values("ts", kind="mergesort")
        per_ts = tdf.groupby("ts", sort=False)["_v"].last()
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


def _awa_offset_storage_column(sensor: str, best_sensor: str) -> str:
    """Parquet-friendly offset column: best sensor uses ``Awa_offset_deg``; others ``Awa_offset__*``."""
    if sensor == best_sensor:
        return "Awa_offset_deg"
    safe = "".join(c if c.isalnum() or c in "._" else "_" for c in sensor)
    return f"Awa_offset__{safe}"


def optimize_leeway_offsets(df: pd.DataFrame, lwy_col: str = 'Lwy_deg') -> tuple[Dict[float, float], Dict[float, float]]:
    """
    Compute leeway offsets using overlapping hourly windows every 30 minutes.
    
    Returns SEPARATE offsets for port and starboard tacks to balance normalized leeway means.
    
    Args:
        df: DataFrame with leeway column, 'Twa_deg', 'tack', 'hour', and 'Datetime' columns
        lwy_col: Name of leeway column
        
    Returns:
        Tuple of (port_offsets, stbd_offsets) dictionaries mapping half-hour to offset values
    """
    port_offsets = {}
    stbd_offsets = {}
    
    # Ensure normalized leeway column exists
    if 'normalized_lwy' not in df.columns:
        df = df.copy()
        df['normalized_lwy'] = df[lwy_col] * np.sign(df['Twa_deg'])
    
    # Create 48 half-hour marks: 0.0, 0.5, 1.0, 1.5, ..., 23.5
    for half_hour_idx in range(48):
        window_center = half_hour_idx * 0.5
        
        # Define 1-hour window centered on this half-hour mark
        start_hour = window_center - 0.5
        end_hour = window_center + 0.5
        
        # Extract hour and minute from datetime for filtering
        df_time = df['Datetime'].dt.hour + df['Datetime'].dt.minute / 60.0
        
        # Handle wraparound at midnight
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
        
        # Compute tack-specific offsets to balance port and starboard normalized means
        if len(port_data) > 0 and len(stbd_data) > 0:
            port_mean = port_data['normalized_lwy'].mean()
            stbd_mean = stbd_data['normalized_lwy'].mean()
            
            # Target: midpoint between the two means
            target = (port_mean + stbd_mean) / 2
            
            # Compute change needed in normalized space
            port_offsets[window_center] = target - port_mean
            stbd_offsets[window_center] = target - stbd_mean
        elif len(port_data) > 0:
            # Only port data in this window: cannot balance tacks. Leave both offsets at 0
            # so that the missing-tack offset does NOT get applied to any opposite-tack rows
            # in the full (all-grade) dataset, which would flip their leeway sign.
            port_offsets[window_center] = 0.0
            stbd_offsets[window_center] = 0.0
        elif len(stbd_data) > 0:
            # Only starboard data: same reasoning – no cross-tack balance is possible.
            port_offsets[window_center] = 0.0
            stbd_offsets[window_center] = 0.0
        else:
            port_offsets[window_center] = 0.0
            stbd_offsets[window_center] = 0.0

    lim = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG
    port_offsets = {k: _clip_offset_deg_scalar(float(v), lim) for k, v in port_offsets.items()}
    stbd_offsets = {k: _clip_offset_deg_scalar(float(v), lim) for k, v in stbd_offsets.items()}
    
    return port_offsets, stbd_offsets


def apply_leeway_calibration(df: pd.DataFrame, port_offsets: Dict[float, float], 
                            stbd_offsets: Dict[float, float], lwy_col: str = 'Lwy_deg') -> pd.DataFrame:
    """
    Apply 30-minute leeway offsets in normalized leeway space.
    
    Derives per-row normalized offsets from port/stbd half-hour maps and TWA (with TWA
    forward/back-filled along ``ts`` for tack inference), propagates offsets with
    ``ffill``/``bfill`` in time order, then applies ``(lwy * sign + offset) * sign`` so
    Grade < 2 segments inherit neighboring corrections.
    """
    df = df.copy()
    n = len(df)
    if n == 0:
        return df

    ts = _ts_array_for_df(df)
    twa_ff = _twa_ff_ordered(df)
    raw = compute_lwy_offset_norm_raw_array(df, port_offsets, stbd_offsets, twa_ff)
    offset_norm = _time_order_ffill_bfill_1d(raw, ts)
    offset_norm = np.nan_to_num(offset_norm, nan=0.0)
    offset_norm = _clip_offset_deg_array(offset_norm)

    lwy = pd.to_numeric(df[lwy_col], errors='coerce').to_numpy(dtype=np.float64, copy=True)
    apply_lwy_calibration_using_offsets(df, lwy_col, lwy, offset_norm, twa_ff)
    return df


def recompute_true_wind(df: pd.DataFrame, 
                        awa_col: str = 'Awa_deg',
                        aws_col: Optional[str] = None,
                        lwy_col: str = 'Lwy_deg',
                        speed_unit: str = 'kph') -> pd.DataFrame:
    """
    Recompute true wind using calibrated AWA, AWS, and leeway values.
    
    Args:
        df: DataFrame with calibrated sensor data
        awa_col: Name of calibrated AWA column
        aws_col: Name of AWS column for true-wind (if None, uses fused or raw AWS; no tack offset layer)
        lwy_col: Name of calibrated leeway column
        
    Returns:
        DataFrame with updated ``Tws_{speed_unit}``, Twa_deg, Twd_deg columns
    """
    df = df.copy()
    
    # Use heading - REQUIRED for accurate TWD computation
    if 'Hdg_deg' not in df.columns:
        raise ValueError("Hdg_deg column required for true wind computation. "
                        "Cannot accurately derive heading from TWD after calibration changes AWA/leeway.")
    
    hdg = df['Hdg_deg'].values
    
    # Determine AWS column to use: fused norm / fused / raw (no tack-specific AWS offset layer).
    if aws_col is None:
        aws_col = aws_feature_column(df, speed_unit)
    
    if aws_col not in df.columns:
        raise ValueError(f"AWS column '{aws_col}' not found in DataFrame.")
    
    # Compute true wind with calibrated values
    bsp_c = f'Bsp_{speed_unit}'
    if bsp_c not in df.columns:
        raise ValueError(f"recompute_true_wind requires column {bsp_c!r}")
    tws, twa, twd = computeTrueWind_vectorized(
        aws=df[aws_col].values,
        awa=df[awa_col].values,
        stw=df[bsp_c].values,
        hdg=hdg,
        lwy=df[lwy_col].values
    )
    
    df[f'Tws_{speed_unit}'] = tws
    df['Twa_deg'] = twa
    df['Twd_deg'] = twd
    
    return df


def calibrate_sailing_data(
    config: CalibrationConfig,
    awa_channel_name: str = 'Awa_deg',
    lwy_channel_name: str = 'Lwy_deg',
    window_sec: float = 30 * 60,
    step_sec: float = 60,
    model_update_interval_sec: float = 30 * 60,
    min_samples_per_model: int = 100,
    pre_fusion_awa_sensors: Optional[List[str]] = None,
    pre_fusion_aws_sensors: Optional[List[str]] = None,
) -> Dict:
    """
    Single-sensor calibration: train performance models per tack × mode (upwind/downwind),
    then interrogate them at matched (Bsp, Tws) conditions to derive rolling AWA offsets.
    
    Models are retrained at regular intervals using Grade >= 2 data accumulated from session
    start, improving quality as more sailing time is logged.
    
    Args:
        config: CalibrationConfig with API credentials
        awa_channel_name: Name of AWA column
        lwy_channel_name: Name of leeway column
        window_sec: Trailing window length in seconds for query condition extraction
        step_sec: Grid step in seconds
        model_update_interval_sec: Interval (seconds) between model retraining
        min_samples_per_model: Minimum samples per model for training
        
    Returns:
        Dictionary with calibrated data, models, and offsets
    """
    # Step 1: Load data (Grade >= 2)
    df = load_calibration_data(config)
    if len(df) == 0:
        raise ValueError("No data loaded for calibration")
    awa_fuse = pre_fusion_awa_sensors if pre_fusion_awa_sensors is not None else _default_pre_fusion_awa_sensors(
        df, awa_channel_name
    )
    aws_fuse = pre_fusion_aws_sensors if pre_fusion_aws_sensors is not None else _default_pre_fusion_aws_sensors(
        df, "kph"
    )
    unit = resolve_speed_unit(config.speed_unit, df, aws_fuse)
    if pre_fusion_aws_sensors is None:
        aws_fuse = _default_pre_fusion_aws_sensors(df, unit)
    unit = resolve_speed_unit(config.speed_unit, df, aws_fuse)
    ensure_speed_columns(df, unit)
    df = add_pre_calibration_fused_awa_aws(df, awa_fuse, aws_fuse, speed_unit=unit)
    
    # Step 2: Compute initial true wind for tack determination
    df = compute_initial_true_wind(
        df, awa_col=awa_channel_name, lwy_col=lwy_channel_name, speed_unit=unit
    )
    
    # Step 3: Add tack column
    df = add_tack_and_hour(df)
    
    # Step 4: Compute rolling performance model offsets
    # This trains 4 models (port/starboard × upwind/downwind) and interrogates them
    uw_offset_series, dw_offset_series, first_valid_ts, first_valid_offset = (
        compute_rolling_perf_model_awa_offsets(
            df,
            awa_channel_name=awa_channel_name,
            window_sec=window_sec,
            step_sec=step_sec,
            min_samples_per_model=min_samples_per_model,
            model_update_interval_sec=model_update_interval_sec,
            speed_unit=unit,
            perf_model_feature_extras=config.perf_model_feature_extras,
        )
    )
    
    # Step 4.5: Apply exponential filter to dampen offset changes (similar to TWS/TWD smoothing)
    # Use default alpha=0.001 to match the smoothing applied to corrected data
    filter_alpha = 0.001
    lim = MAX_AWA_LWY_CALIBRATION_OFFSET_DEG
    uw_offset_series = filter_offset_series_exponential(uw_offset_series, alpha=filter_alpha).clip(
        -lim, lim
    )
    dw_offset_series = filter_offset_series_exponential(dw_offset_series, alpha=filter_alpha).clip(
        -lim, lim
    )
    if first_valid_offset is not None:
        first_valid_offset = _clip_offset_deg_scalar(float(first_valid_offset), lim)
    
    # Step 5: Apply AWA calibration
    df = apply_awa_perf_model_calibration(
        df,
        uw_offset_series,
        dw_offset_series,
        first_valid_ts,
        first_valid_offset,
        awa_channel_name=awa_channel_name,
        output_applied_column='Awa_offset_deg'
    )
    
    # Step 6: Train leeway model and apply half-hour leeway offsets
    lwy_model = train_leeway_model(
        df,
        lwy_channel_name,
        speed_unit=unit,
        features=config.leeway_model_features,
    )
    df = compute_leeway_residuals(
        df,
        lwy_model,
        lwy_channel_name,
        speed_unit=unit,
        features=config.leeway_model_features,
    )
    port_lwy_offsets, stbd_lwy_offsets = optimize_leeway_offsets(df, lwy_channel_name)
    df = apply_leeway_calibration(df, port_lwy_offsets, stbd_lwy_offsets, lwy_channel_name)

    # Step 7: Recompute true wind with calibrated values (AWS: fused/raw, no offset layer)
    df = recompute_true_wind(
        df, awa_col=awa_channel_name, aws_col=None, lwy_col=lwy_channel_name, speed_unit=unit
    )

    return {
        'data': df,
        'awa_model': None,  # perf path uses 4 tack×mode models internally, not one shared XGB
        'awa_features': perf_model_awa_feature_names(unit, df, config.perf_model_feature_extras),
        'speed_unit': unit,
        'awa_offsets': {
            'perf_model': (uw_offset_series, dw_offset_series, first_valid_ts, first_valid_offset)
        },
        'lwy_model': lwy_model,
        'lwy_offsets': {'port': port_lwy_offsets, 'starboard': stbd_lwy_offsets},
    }


# ============================================================================
# MULTI-SENSOR CALIBRATION & FUSION
# ============================================================================

def compute_calibration_quality(cal_result: Dict, df_before: pd.DataFrame,
                                awa_channel: str, lwy_channel: str) -> Dict[str, Any]:
    """
    Compute quality score for a calibration result (0-100 scale).

    Metrics (raw max 80, scaled to 0-100):
    - Port/stbd balance after calibration (40 pts max)
    - TWD std improvement (30 pts max)
    - Data coverage balance (10 pts max)

    AWA residual-based subscores were removed: ``awa_residual`` is not meaningful on the
    calibrated perf-model frame.

    Args:
        cal_result: Output from ``calibrate_sailing_data`` or the multi-sensor pipeline
        df_before: DataFrame before calibration (for comparison)
        awa_channel: Name of AWA column
        lwy_channel: Name of leeway column

    Returns:
        Dictionary with quality scores
    """
    df_after = cal_result['data']
    
    # Ensure normalized leeway exists
    if 'normalized_lwy' not in df_after.columns:
        df_after['normalized_lwy'] = df_after[lwy_channel] * np.sign(df_after['Twa_deg'])
    if 'normalized_lwy' not in df_before.columns:
        df_before['normalized_lwy'] = df_before[lwy_channel] * np.sign(df_before['Twa_deg'])
    
    scores: Dict[str, Any] = {
        'balance_score': 0.0,
        'stability_score': 0.0,
        'coverage_score': 0.0,
        'total': 0.0
    }
    
    # Metric 1: Port/Starboard balance (40 points max)
    port_awa = df_after[df_after['tack'] == 'port'][awa_channel].abs().mean()
    stbd_awa = df_after[df_after['tack'] == 'starboard'][awa_channel].abs().mean()
    balance_delta = abs(port_awa - stbd_awa)
    
    # Perfect balance (0.0°) = 40 pts, 0.2° = 30 pts, 1.0° = 0 pts
    scores['balance_score'] = max(0.0, 40.0 - balance_delta * 40.0)
    scores['balance_delta'] = balance_delta
    
    # Metric 2: TWD stability improvement (30 points max)
    if 'Twd_deg' in df_before.columns and 'Twd_deg' in df_after.columns:
        twd_std_before = df_before['Twd_deg'].std()
        twd_std_after = df_after['Twd_deg'].std()
        
        if twd_std_before > 0:
            stability_improve = (twd_std_before - twd_std_after) / twd_std_before
            # 10% improve = 30 pts, 0% = 0 pts, negative = 0 pts
            scores['stability_score'] = max(0.0, stability_improve * 300.0)
            scores['twd_improvement_pct'] = stability_improve * 100
    
    # Metric 3: Data coverage balance (10 points max)
    port_count = len(df_after[df_after['tack'] == 'port'])
    stbd_count = len(df_after[df_after['tack'] == 'starboard'])
    
    if port_count > 0 and stbd_count > 0:
        balance_ratio = min(port_count, stbd_count) / max(port_count, stbd_count)
        scores['coverage_score'] = balance_ratio * 10.0
        scores['data_balance_ratio'] = balance_ratio
    
    raw_total = scores['balance_score'] + scores['stability_score'] + scores['coverage_score']
    scores['total'] = raw_total * (100.0 / 80.0)
    
    return scores


def calibrate_multi_sensors(config: CalibrationConfig,
                           awa_sensors: List[str],
                           aws_sensors: Optional[List[str]] = None,
                           lwy_sensor: str = 'Lwy_deg',
                           min_health_score: float = 50.0,
                           *,
                           window_sec: float = 30 * 60,
                           step_sec: float = 60,
                           model_update_interval_sec: float = 30 * 60,
                           min_samples_per_model: int = 100) -> Dict:
    """
    Calibrate multiple AWA/AWS sensors independently with health validation (performance-model AWA).
    """
    from .sensor_health import SensorHealthCheck

    print("MULTI-SENSOR CALIBRATION PIPELINE (performance-model AWA)")

    results: Dict[str, Any] = {
        'sensor_health': {},
        'sensor_calibrations': {},
        'recommended_sensors': []
    }

    print("\n[1/3] Loading data...")
    df_original = load_calibration_data(config)
    unit = resolve_speed_unit(config.speed_unit, df_original, aws_sensors)
    ensure_speed_columns(df_original, unit)
    df_before = compute_initial_true_wind(
        df_original.copy(), awa_col=awa_sensors[0], lwy_col=lwy_sensor, speed_unit=unit
    )
    df_before = add_tack_and_hour(df_before)
    print(f"      [OK] Loaded {len(df_original):,} Grade >= 2 samples")

    print("\n[2/3] Performing health checks...")
    all_sensors = awa_sensors + ([lwy_sensor] if lwy_sensor not in awa_sensors else [])
    health_results = SensorHealthCheck.validate_all_sensors(df_original, all_sensors)
    results['sensor_health'] = health_results
    SensorHealthCheck.print_health_report(health_results)

    healthy_awa_sensors = [
        s for s in awa_sensors
        if health_results.get(s, {}).get('score', 0) >= min_health_score
    ]
    if len(healthy_awa_sensors) == 0:
        print("\n[ERROR] No healthy AWA sensors found!")
        return results
    print(f"\n[OK] {len(healthy_awa_sensors)}/{len(awa_sensors)} AWA sensors passed health checks")

    print(f"\n[3/3] Calibrating {len(healthy_awa_sensors)} sensor(s)...")
    for i, awa_sensor in enumerate(healthy_awa_sensors, 1):
        print(f"\n  [{i}/{len(healthy_awa_sensors)}] Calibrating {awa_sensor}...")
        try:
            cal_result = calibrate_sailing_data(
                config=config,
                awa_channel_name=awa_sensor,
                lwy_channel_name=lwy_sensor,
                window_sec=window_sec,
                step_sec=step_sec,
                model_update_interval_sec=model_update_interval_sec,
                min_samples_per_model=min_samples_per_model,
                pre_fusion_awa_sensors=awa_sensors,
                pre_fusion_aws_sensors=aws_sensors,
            )
            _store_cal_result(results, awa_sensor, cal_result, df_before, lwy_sensor)
        except Exception as e:
            print(f"        ✗ Calibration failed: {e}")
            results['sensor_calibrations'][awa_sensor] = {
                'calibration': None,
                'health': health_results[awa_sensor],
                'quality_scores': None,
                'quality_score': 0.0,
                'error': str(e)
            }

    _rank_and_print_sensors(results)
    return results


def _store_cal_result(results: Dict, awa_sensor: str, cal_result: Dict,
                      df_before: pd.DataFrame, lwy_sensor: str) -> None:
    quality_scores = compute_calibration_quality(cal_result, df_before, awa_sensor, lwy_sensor)
    results['sensor_calibrations'][awa_sensor] = {
        'calibration': cal_result,
        'health': results['sensor_health'][awa_sensor],
        'quality_scores': quality_scores,
        'quality_score': quality_scores['total']
    }
    print(f"        [OK] Quality score: {quality_scores['total']:.1f}/100")
    print(f"          - Port/Stbd balance: {quality_scores['balance_delta']:.3f}°")
    if 'twd_improvement_pct' in quality_scores:
        print(f"          - TWD improvement: {quality_scores['twd_improvement_pct']:+.1f}%")


def _rank_and_print_sensors(results: Dict) -> None:
    calibrated_sensors = [(sensor, data['quality_score'])
                         for sensor, data in results['sensor_calibrations'].items()
                         if data['calibration'] is not None]
    calibrated_sensors.sort(key=lambda x: x[1], reverse=True)
    results['recommended_sensors'] = [s[0] for s in calibrated_sensors]

    if results['recommended_sensors']:
        print(f"[OK] CALIBRATION COMPLETE - {len(results['recommended_sensors'])} sensor(s) calibrated")
        print(f"\nRecommended sensor ranking:")
        for i, sensor in enumerate(results['recommended_sensors'], 1):
            score = results['sensor_calibrations'][sensor]['quality_score']
            print(f"  {i}. {sensor} (quality: {score:.1f}/100)")
    else:
        print("[ERROR] NO SENSORS SUCCESSFULLY CALIBRATED")


def fuse_and_compute_true_wind(df: pd.DataFrame,
                                awa_fused_col: str = 'Awa_fused_deg',
                                aws_fused_col: Optional[str] = None,
                                lwy_col: str = 'Lwy_deg',
                                speed_unit: str = 'kph') -> pd.DataFrame:
    """
    Compute true wind from fused AWA/AWS sensors.
    
    When fused AWA/AWS are NaN at a timestep (e.g. both multi-sensor channels missing) but
    calibrated single-channel AWS/AWA exist, recomputes TW from those so low-grade segments
    still get ``Twa_fused_deg`` / ``Tws_fused_kph`` where inputs allow.
    
    Args:
        df: DataFrame with fused sensor columns
        awa_fused_col: Name of fused AWA column
        aws_fused_col: Name of fused AWS column
        lwy_col: Name of leeway column
        
    Returns:
        DataFrame with ``Tws_fused_{speed_unit}``, Twa_fused_deg, Twd_fused_deg added
    """
    df_result = df.copy()
    if aws_fused_col is None:
        aws_fused_col = aws_fused_output_column(speed_unit)
    
    # Use fused apparent wind if available, otherwise fall back to single sensor
    awa_col = awa_fused_col if awa_fused_col in df.columns else 'Awa_deg'
    raw_aws = f'Aws_{speed_unit}'
    aws_col = aws_fused_col if aws_fused_col in df.columns else raw_aws
    
    bsp_c = f'Bsp_{speed_unit}'
    stw = pd.to_numeric(df[bsp_c], errors='coerce')
    hdg = pd.to_numeric(df['Hdg_deg'], errors='coerce') if 'Hdg_deg' in df.columns else pd.Series(0.0, index=df.index)
    lwy = pd.to_numeric(df[lwy_col], errors='coerce')
    
    # Compute true wind (returns tuple: tws, twa_deg, twd_deg)
    tws, twa_deg, twd_deg = computeTrueWind_vectorized(
        aws=df[aws_col],
        awa=df[awa_col],
        stw=stw,
        hdg=hdg,
        lwy=lwy
    )
    
    # Fill rows where fusion inputs were missing but a calibrated single path exists
    aws_primary = pd.to_numeric(df[aws_col], errors='coerce').to_numpy(dtype=np.float64, copy=True)
    awa_primary = pd.to_numeric(df[awa_col], errors='coerce').to_numpy(dtype=np.float64, copy=True)
    aws_fb = aws_primary.copy()
    awa_fb = awa_primary.copy()
    for alt_aws in (f'Aws_bow_{speed_unit}', f'Aws_mhu_{speed_unit}'):
        if alt_aws in df.columns:
            ak = pd.to_numeric(df[alt_aws], errors='coerce').to_numpy(dtype=np.float64, copy=True)
            aws_fb = np.where(np.isnan(aws_fb), ak, aws_fb)
    if raw_aws in df.columns:
        ak = pd.to_numeric(df[raw_aws], errors='coerce').to_numpy(dtype=np.float64, copy=True)
        aws_fb = np.where(np.isnan(aws_fb), ak, aws_fb)
    for alt_awa in ('Awa_bow_deg', 'Awa_mhu_deg'):
        if alt_awa in df.columns:
            av = pd.to_numeric(df[alt_awa], errors='coerce').to_numpy(dtype=np.float64, copy=True)
            awa_fb = np.where(np.isnan(awa_fb), av, awa_fb)
    if 'Awa_deg' in df.columns:
        av = pd.to_numeric(df['Awa_deg'], errors='coerce').to_numpy(dtype=np.float64, copy=True)
        awa_fb = np.where(np.isnan(awa_fb), av, awa_fb)

    bad = np.isnan(tws) | np.isnan(twa_deg) | np.isnan(twd_deg)
    if np.any(bad):
        tws2, twa2, twd2 = computeTrueWind_vectorized(
            aws=aws_fb,
            awa=awa_fb,
            stw=stw,
            hdg=hdg,
            lwy=lwy
        )
        tws = np.asarray(tws, dtype=np.float64)
        twa_deg = np.asarray(twa_deg, dtype=np.float64)
        twd_deg = np.asarray(twd_deg, dtype=np.float64)
        tws[bad] = np.asarray(tws2, dtype=np.float64)[bad]
        twa_deg[bad] = np.asarray(twa2, dtype=np.float64)[bad]
        twd_deg[bad] = np.asarray(twd2, dtype=np.float64)[bad]
    
    df_result[tws_fused_output_column(speed_unit)] = tws
    df_result['Twa_fused_deg'] = twa_deg
    df_result['Twd_fused_deg'] = twd_deg
    
    return df_result


def _apply_offsets_to_full_data(df_full: pd.DataFrame,
                                 multi_results: Dict,
                                 awa_sensors: List[str],
                                 aws_sensors: Optional[List[str]],
                                 lwy_sensor: str,
                                 speed_unit: str = 'kph') -> pd.DataFrame:
    """
    Apply calibrated AWA (performance-model offset series) and leeway to the full dataframe
    (all grades).

    Materializes explicit offset columns (``Lwy_offset_norm_deg`` and per-sensor AWA offset
    columns), runs one time-ordered ffill/bfill pass on those columns, then applies them to
    the raw sensor snapshots so low-grade rows match the propagated offsets. AWS is not
    offset-corrected; fused/raw AWS values are used as-is for fusion and true wind.
    """
    best_sensor = multi_results['recommended_sensors'][0]
    sensor_calibrations = multi_results['sensor_calibrations']

    df_full = df_full.copy()

    first_awa = awa_sensors[0] if awa_sensors else 'Awa_deg'
    if first_awa not in df_full.columns:
        pick = [c for c in df_full.columns if c.startswith('Awa_') and c.endswith('_deg')]
        first_awa = pick[0] if pick else 'Awa_deg'

    df_full = add_pre_calibration_fused_awa_aws(
        df_full, list(awa_sensors), aws_sensors, speed_unit=speed_unit
    )

    # Same AWS column as calibrate_sailing_data (prefers Aws_fused_norm_* when present).
    aws_apply_col: Optional[str]
    try:
        aws_apply_col = aws_feature_column(df_full, speed_unit)
    except ValueError:
        aws_apply_col = None
    raw_aws = f'Aws_{speed_unit}'
    if aws_apply_col is None or aws_apply_col not in df_full.columns:
        aws_apply_col = raw_aws if raw_aws in df_full.columns else None
        if aws_apply_col is None and aws_sensors:
            aws_apply_col = next((s for s in aws_sensors if s in df_full.columns), None)
        if aws_apply_col is None:
            pick_aws = [
                c for c in df_full.columns
                if c.startswith('Aws_') and c.endswith(f'_{speed_unit}')
            ]
            aws_apply_col = pick_aws[0] if pick_aws else None

    if aws_apply_col and aws_apply_col in df_full.columns and raw_aws not in df_full.columns:
        df_full[raw_aws] = pd.to_numeric(df_full[aws_apply_col], errors='coerce')

    df_full = compute_initial_true_wind(
        df_full, awa_col=first_awa, lwy_col=lwy_sensor, speed_unit=speed_unit
    )
    df_full = add_tack_and_hour(df_full)

    lwy_raw = pd.to_numeric(df_full[lwy_sensor], errors='coerce').to_numpy(dtype=np.float64, copy=True)

    awa_raw: Dict[str, np.ndarray] = {}
    for sensor in multi_results['recommended_sensors']:
        if sensor in df_full.columns:
            awa_raw[sensor] = pd.to_numeric(df_full[sensor], errors='coerce').to_numpy(
                dtype=np.float64, copy=True
            )

    twa_ff = _twa_ff_ordered(df_full)

    cal0 = sensor_calibrations[best_sensor]['calibration']
    port_lwy, stbd_lwy = cal0['lwy_offsets']['port'], cal0['lwy_offsets']['starboard']
    lwy_norm_raw = compute_lwy_offset_norm_raw_array(df_full, port_lwy, stbd_lwy, twa_ff)
    df_full['Lwy_offset_norm_deg'] = _clip_offset_deg_array(lwy_norm_raw)
    offset_cols: List[str] = ['Lwy_offset_norm_deg']

    for sensor in multi_results['recommended_sensors']:
        if sensor not in df_full.columns:
            continue
        cal = sensor_calibrations[sensor]['calibration']
        awa_offsets_dict = cal.get('awa_offsets', {})
        oc = _awa_offset_storage_column(sensor, best_sensor)

        if 'perf_model' not in awa_offsets_dict:
            raise ValueError(
                f"Sensor {sensor!r}: expected awa_offsets['perf_model'] from calibrate_sailing_data; "
                f"got keys {list(awa_offsets_dict.keys())!r}"
            )
        uw_os, dw_os, first_valid_ts, first_valid_offset = awa_offsets_dict['perf_model']
        df_full[oc] = compute_awa_perf_model_offset_array(
            df_full, uw_os, dw_os, first_valid_ts, first_valid_offset
        )
        offset_cols.append(oc)

    _propagate_offset_columns(df_full, offset_cols)

    # Clamp after propagation (stored calibrations may pre-date limits; ffill preserves magnitude).
    for _ocol in offset_cols:
        if _ocol not in df_full.columns:
            continue
        _v = pd.to_numeric(df_full[_ocol], errors='coerce').to_numpy(dtype=np.float64, copy=False)
        df_full[_ocol] = _clip_offset_deg_array(_v)

    # User-visible leeway offset in raw degrees: same sign convention as apply (offset_norm * sign(TWA)).
    sign_lwy = np.sign(twa_ff)
    sign_lwy[~np.isfinite(sign_lwy)] = 1.0
    sign_lwy[sign_lwy == 0] = 1.0
    lwy_norm_prop = pd.to_numeric(df_full['Lwy_offset_norm_deg'], errors='coerce').to_numpy(
        dtype=np.float64, copy=True
    )
    df_full['Lwy_offset_deg'] = lwy_norm_prop * sign_lwy

    lwy_off = pd.to_numeric(df_full['Lwy_offset_norm_deg'], errors='coerce').to_numpy(
        dtype=np.float64, copy=True
    )
    apply_lwy_calibration_using_offsets(df_full, lwy_sensor, lwy_raw, lwy_off, twa_ff)

    for sensor in multi_results['recommended_sensors']:
        if sensor not in awa_raw:
            continue
        oc = _awa_offset_storage_column(sensor, best_sensor)
        if oc not in df_full.columns:
            continue
        off = pd.to_numeric(df_full[oc], errors='coerce').to_numpy(dtype=np.float64, copy=True)
        df_full[sensor] = awa_raw[sensor] + off

    # fuse_and_compute_true_wind uses Awa_fused_deg first, then falls back when fused is NaN.
    # Offsets above only touch recommended bow/MHU columns — Awa_deg from ingest is usually uncorrected.
    # Low-grade rows often drop one AWA sensor so fusion is NaN; without this, true wind recomputes from raw Awa_deg.
    if best_sensor in df_full.columns:
        df_full['Awa_deg'] = pd.to_numeric(df_full[best_sensor], errors='coerce')

    return df_full


def calibrate_and_fuse_pipeline(config: CalibrationConfig,
                                awa_sensors: List[str],
                                aws_sensors: Optional[List[str]] = None,
                                lwy_sensor: str = 'Lwy_deg',
                                fusion_method: str = 'robust',
                                outlier_threshold: float = 2.0,
                                *,
                                window_sec: float = 30 * 60,
                                step_sec: float = 60,
                                model_update_interval_sec: float = 30 * 60,
                                min_samples_per_model: int = 100) -> Dict:
    """
    Calibrate on Grade >= 2 (performance-model AWA), then load all grades in range, apply the same
    offsets, fuse, and compute true wind.
    """
    from .sensor_fusion import fuse_awa_aws_pairs, compute_fusion_statistics, print_fusion_report

    print("MULTI-SENSOR CALIBRATION & FUSION PIPELINE — performance-model AWA")

    multi_results = calibrate_multi_sensors(
        config=config,
        awa_sensors=awa_sensors,
        aws_sensors=aws_sensors,
        lwy_sensor=lwy_sensor,
        window_sec=window_sec,
        step_sec=step_sec,
        model_update_interval_sec=model_update_interval_sec,
        min_samples_per_model=min_samples_per_model,
    )
    if len(multi_results['recommended_sensors']) == 0:
        raise ValueError("No sensors successfully calibrated")

    print("\n[FUSION] Loading all grades in range and applying offsets (trained on Grade >= 2)...")
    df_full = load_calibration_data(config, include_all_grades=True)
    if len(df_full) == 0:
        raise ValueError("No full data loaded")
    if 'Grade' in df_full.columns:
        g = pd.to_numeric(df_full['Grade'], errors='coerce')
        n_low = int((g < 2).sum())
        print(f"      [FUSION] Full load: {len(df_full):,} rows, Grade<2: {n_low:,}")
    best_tr = multi_results['recommended_sensors'][0]
    fuse_unit = multi_results['sensor_calibrations'][best_tr]['calibration'].get(
        'speed_unit', 'kph'
    )
    ensure_speed_columns(df_full, fuse_unit)
    df_full = _apply_offsets_to_full_data(
        df_full, multi_results, awa_sensors, aws_sensors, lwy_sensor,
        speed_unit=fuse_unit,
    )
    print(f"      [OK] Applied offsets to {len(df_full):,} samples (all grades)")
    if os.environ.get('HUNICO_FUSION_TRACE', '').strip() == '1' and 'Grade' in df_full.columns:
        g = pd.to_numeric(df_full['Grade'], errors='coerce')
        low = g < 2
        if low.any():
            trace_parts: List[str] = []
            for name in ('Awa_offset_deg', 'Lwy_offset_norm_deg', 'Lwy_offset_deg'):
                if name not in df_full.columns:
                    continue
                v = pd.to_numeric(df_full.loc[low, name], errors='coerce')
                trace_parts.append(f'{name}: mean_abs={float(v.abs().mean()):.4g} n={int(low.sum())}')
            best_tr = multi_results['recommended_sensors'][0]
            for sensor in multi_results.get('recommended_sensors') or []:
                alt = _awa_offset_storage_column(sensor, best_tr)
                if alt.startswith('Awa_offset__') and alt in df_full.columns:
                    v = pd.to_numeric(df_full.loc[low, alt], errors='coerce')
                    trace_parts.append(f'{alt}: mean_abs={float(v.abs().mean()):.4g} n={int(low.sum())}')
            if trace_parts:
                print('      [FUSION][trace] Grade<2 offsets — ' + ', '.join(trace_parts))

    aws_to_use = [s for s in (aws_sensors or []) if s in df_full.columns]
    print(f"\n[FUSION] Fusing {len(multi_results['recommended_sensors'])} AWA sensor(s)"
          f"{', ' + str(len(aws_to_use)) + ' AWS sensor(s)' if aws_to_use else ''} using '{fusion_method}' method...")
    if fusion_method == 'robust':
        df_fused = fuse_awa_aws_pairs(
            df=df_full,
            awa_sensors=multi_results['recommended_sensors'],
            aws_sensors=aws_to_use,
            fusion_method='robust',
            speed_unit=fuse_unit,
        )
    elif fusion_method == 'weighted':
        df_fused = fuse_awa_aws_pairs(
            df=df_full,
            awa_sensors=multi_results['recommended_sensors'],
            aws_sensors=aws_to_use,
            fusion_method='weighted',
            sensor_configs=multi_results['sensor_calibrations'],
            speed_unit=fuse_unit,
        )
    else:
        raise ValueError(f"Unknown fusion_method: {fusion_method}")

    print("\n[FUSION] Computing true wind from fused sensors (full dataframe)...")
    df_final = fuse_and_compute_true_wind(df_fused, lwy_col=lwy_sensor, speed_unit=fuse_unit)
    for col in df_full.columns:
        if col in df_final.columns:
            continue
        if col in ('Lwy_offset_norm_deg', 'Lwy_offset_deg', 'Awa_offset_deg') or col.startswith(
            'Awa_offset__'
        ):
            df_final[col] = df_full[col].values

    print("\n[FUSION] Assessing fusion quality...")
    df_stats = df_final
    if 'Grade' in df_final.columns:
        df_grade3 = df_final[df_final['Grade'] == 3]
        if len(df_grade3) > 0:
            df_stats = df_grade3
    fusion_stats = compute_fusion_statistics(
        df=df_stats,
        sensor_list=multi_results['recommended_sensors'],
        fused_column='Awa_fused_deg'
    )
    print_fusion_report(fusion_stats, multi_results['recommended_sensors'])

    print("[OK] PIPELINE COMPLETE - Full dataframe with corrected true wind")

    return {
        'data': df_final,
        'multi_sensor_results': multi_results,
        'fusion_stats': fusion_stats,
        'fusion_method': fusion_method
    }


def calibrate_single_sensor_pipeline(
    config: CalibrationConfig,
    awa_sensor: str,
    aws_sensor: Optional[str] = None,
    lwy_sensor: str = 'Lwy_deg',
    *,
    window_sec: float = 30 * 60,
    step_sec: float = 60,
    model_update_interval_sec: float = 30 * 60,
    min_samples_per_model: int = 100,
) -> Dict:
    """
    Calibrate one AWA / AWS pair (performance-model AWA), load all grades, apply offsets,
    then compute true wind **without** multi-sensor ``fuse_awa_aws_pairs``.

    Fused column names (``Awa_fused_deg``, ``Aws_fused_*``, ``Tws_fused_*``, …) are filled from
    the calibrated primary sensor so downstream code can stay unchanged.
    """
    print("SINGLE-SENSOR CALIBRATION PIPELINE (no AWA/AWS fusion)")

    awa_sensors = [awa_sensor]
    aws_sensors = [aws_sensor] if aws_sensor else None

    multi_results = calibrate_multi_sensors(
        config=config,
        awa_sensors=awa_sensors,
        aws_sensors=aws_sensors,
        lwy_sensor=lwy_sensor,
        window_sec=window_sec,
        step_sec=step_sec,
        model_update_interval_sec=model_update_interval_sec,
        min_samples_per_model=min_samples_per_model,
    )
    if len(multi_results['recommended_sensors']) == 0:
        raise ValueError("No sensors successfully calibrated")

    print("\n[APPLY] Loading all grades in range and applying offsets (trained on Grade >= 2)...")
    df_full = load_calibration_data(config, include_all_grades=True)
    if len(df_full) == 0:
        raise ValueError("No full data loaded")
    if 'Grade' in df_full.columns:
        g = pd.to_numeric(df_full['Grade'], errors='coerce')
        n_low = int((g < 2).sum())
        print(f"      [APPLY] Full load: {len(df_full):,} rows, Grade<2: {n_low:,}")

    best_tr = multi_results['recommended_sensors'][0]
    fuse_unit = multi_results['sensor_calibrations'][best_tr]['calibration'].get(
        'speed_unit', 'kph'
    )
    ensure_speed_columns(df_full, fuse_unit)
    df_full = _apply_offsets_to_full_data(
        df_full,
        multi_results,
        awa_sensors,
        aws_sensors,
        lwy_sensor,
        speed_unit=fuse_unit,
    )
    print(f"      [OK] Applied offsets to {len(df_full):,} samples (all grades)")

    df_work = df_full.copy()
    raw_aws = f'Aws_{fuse_unit}'
    aws_fused = aws_fused_output_column(fuse_unit)
    df_work['Awa_fused_deg'] = pd.to_numeric(df_work[best_tr], errors='coerce')
    if raw_aws in df_work.columns:
        df_work[aws_fused] = pd.to_numeric(df_work[raw_aws], errors='coerce')
    else:
        candidates = [
            c
            for c in df_work.columns
            if c.startswith('Aws_') and c.endswith(f'_{fuse_unit}')
        ]
        if candidates:
            df_work[aws_fused] = pd.to_numeric(df_work[candidates[0]], errors='coerce')
        else:
            df_work[aws_fused] = np.nan

    print("\n[APPLY] Computing true wind from single calibrated apparent-wind path...")
    df_final = fuse_and_compute_true_wind(df_work, lwy_col=lwy_sensor, speed_unit=fuse_unit)
    for col in df_full.columns:
        if col in df_final.columns:
            continue
        if col in ('Lwy_offset_norm_deg', 'Lwy_offset_deg', 'Awa_offset_deg') or col.startswith(
            'Awa_offset__'
        ):
            df_final[col] = df_full[col].values

    print("[OK] SINGLE-SENSOR PIPELINE COMPLETE")

    return {
        'data': df_final,
        'multi_sensor_results': multi_results,
        'fusion_stats': None,
        'fusion_method': 'single_sensor',
    }
