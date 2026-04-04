"""
Tests for calibration utilities (cal_utils.py) — new simple-name API.

Column names follow the simple unit-free convention used by ``calibrate_pipeline``:
``Awa``, ``Aws``, ``Bsp``, ``Tws``, ``Twa``, ``Twd``, ``Hdg``, ``Lwy``.
"""

import numpy as np
import pandas as pd
from datetime import datetime, timedelta, timezone

from utilities.cal_utils import (
    add_twa_mode_classification_column,
    compute_initial_true_wind,
    add_tack_and_hour,
    summarize_tack_mode_sector_counts,
    train_leeway_model,
    compute_leeway_residuals,
    optimize_leeway_offsets,
    apply_leeway_calibration,
    recompute_true_wind,
    _propagate_offset_columns,
)


# ---------------------------------------------------------------------------
# SYNTHETIC DATA
# ---------------------------------------------------------------------------

def generate_synthetic_sailing_data(n_samples: int = 1000, seed: int = 42) -> pd.DataFrame:
    """
    Synthetic sailing data with simple column names and realistic sensor biases.
    """
    np.random.seed(seed)
    start_time = datetime(2026, 2, 11, 0, 0, 0)
    timestamps = [start_time + timedelta(seconds=i) for i in range(n_samples)]

    bsp = 9 + 2 * np.sin(np.linspace(0, 4 * np.pi, n_samples)) + np.random.normal(0, 0.5, n_samples)
    bsp = np.clip(bsp, 5, 14)

    aws = 15 + 3 * np.sin(np.linspace(0, 3 * np.pi, n_samples)) + np.random.normal(0, 1, n_samples)
    aws = np.clip(aws, 8, 25)
    tws = aws * 0.9 + np.random.normal(0, 0.3, n_samples)

    twa_base = 40 * np.sin(np.linspace(0, 8 * np.pi, n_samples))
    twa = twa_base + np.random.normal(0, 3, n_samples)

    awa_true = 30 + (aws - 15) * 2 - (bsp - 9) * 1.5 + np.random.normal(0, 2, n_samples)
    awa_true = np.where(twa < 0, -np.abs(awa_true), np.abs(awa_true))
    tack_sign = np.sign(twa)
    awa_bias = np.where(tack_sign < 0, 3.0, -2.0)
    awa_measured = awa_true + awa_bias

    heel = 15 + (aws - 15) * 0.5 + np.random.normal(0, 1, n_samples)
    main_sheet_load = 800 + (aws - 15) * 30 + np.random.normal(0, 50, n_samples)
    cant_eff = 2 + (aws - 15) * 0.1 + np.random.normal(0, 0.3, n_samples)
    foil_sink = 0.5 + (bsp - 9) * 0.05 + np.random.normal(0, 0.02, n_samples)

    lwy_magnitude = 2 + (heel - 15) * 0.2 + (main_sheet_load - 800) * 0.001 - (cant_eff - 2) * 0.5
    lwy_magnitude = np.abs(lwy_magnitude + np.random.normal(0, 0.3, n_samples))
    lwy_bias_magnitude = np.where(tack_sign < 0, 1.0, -0.5)
    lwy_measured = (lwy_magnitude + lwy_bias_magnitude) * tack_sign

    hdg = 90.0 + 15 * np.sin(np.linspace(0, 6 * np.pi, n_samples)) + np.random.normal(0, 1, n_samples)
    twd = (hdg + twa) % 360

    return pd.DataFrame({
        'Datetime': timestamps,
        'ts': [(t - start_time).total_seconds() for t in timestamps],
        'Bsp': bsp,
        'Aws': aws,
        'Tws': tws,
        'Awa': awa_measured,
        'Twa': twa,
        'Twd': twd,
        'Hdg': hdg,
        'Lwy': lwy_measured,
        'Altitude': 100 + np.random.normal(0, 5, n_samples),
        'Main_sheet_load': main_sheet_load,
        'Foil_lwd_cant_eff': cant_eff,
        'Foil_lwd_sink': foil_sink,
        'Swh': 0.5 + np.random.normal(0, 0.1, n_samples),
        'Grade': 3,
        'awa_bias_injected': awa_bias,
        'lwy_bias_injected': lwy_bias_magnitude,
    })


# ---------------------------------------------------------------------------
# SYNTHETIC DATA SANITY
# ---------------------------------------------------------------------------

def test_generate_synthetic_data():
    df = generate_synthetic_sailing_data(n_samples=500)
    assert len(df) == 500
    assert 'Awa' in df.columns
    assert 'Lwy' in df.columns
    assert df['Grade'].unique()[0] == 3
    assert 'awa_bias_injected' in df.columns
    assert df['awa_bias_injected'].nunique() == 2


# ---------------------------------------------------------------------------
# compute_initial_true_wind
# ---------------------------------------------------------------------------

def test_compute_initial_true_wind_prefers_finite_stream_columns():
    """Finite instrument TWA/TWD/TWS must not be replaced when prefer_stream_true_wind=True."""
    df = pd.DataFrame({
        'Hdg': [0.0],
        'Lwy': [0.0],
        'Bsp': [10.0],
        'Aws': [15.0],
        'Awa': [30.0],
        'Twa': [-42.0],
        'Twd': [318.0],
        'Tws': [12.5],
    })
    out = compute_initial_true_wind(df.copy(), prefer_stream_true_wind=True)
    assert float(out['Twa'].iloc[0]) == -42.0
    assert float(out['Twd'].iloc[0]) == 318.0
    assert float(out['Tws'].iloc[0]) == 12.5


def test_compute_initial_true_wind_prefer_stream_false_uses_computed():
    df = pd.DataFrame({
        'Hdg': [0.0],
        'Lwy': [0.0],
        'Bsp': [10.0],
        'Aws': [15.0],
        'Awa': [30.0],
        'Twa': [-42.0],
        'Twd': [318.0],
        'Tws': [12.5],
    })
    out_keep = compute_initial_true_wind(df.copy(), prefer_stream_true_wind=True)
    out_over = compute_initial_true_wind(df.copy(), prefer_stream_true_wind=False)
    assert float(out_keep['Twa'].iloc[0]) == -42.0
    assert float(out_over['Twa'].iloc[0]) != -42.0 or float(out_over['Twd'].iloc[0]) != 318.0


# ---------------------------------------------------------------------------
# add_twa_mode_classification_column
# ---------------------------------------------------------------------------

def test_add_twa_mode_classification_keeps_stream_twa_when_finite():
    df = pd.DataFrame({
        'Twa': [40.0],
        'Hdg': [0.0],
        'Twd': [90.0],
    })
    out = add_twa_mode_classification_column(df, twa_col='Twa')
    assert float(out['Twa_mode'].iloc[0]) == 40.0


def test_add_twa_mode_classification_fills_nan_twa_from_twd_hdg():
    df = pd.DataFrame({
        'Twa': [np.nan],
        'Hdg': [10.0],
        'Twd': [100.0],
    })
    out = add_twa_mode_classification_column(df, twa_col='Twa')
    assert abs(float(out['Twa_mode'].iloc[0]) - 90.0) < 1e-9


# ---------------------------------------------------------------------------
# add_tack_and_hour
# ---------------------------------------------------------------------------

def test_add_tack_and_hour():
    df = generate_synthetic_sailing_data(n_samples=100)
    df = compute_initial_true_wind(df)
    df = add_twa_mode_classification_column(df)
    df = add_tack_and_hour(df)

    assert 'tack' in df.columns
    assert 'hour' in df.columns
    assert set(df['tack'].unique()) <= {'port', 'starboard'}
    assert df['hour'].min() >= 0
    assert df['hour'].max() <= 23


# ---------------------------------------------------------------------------
# summarize_tack_mode_sector_counts
# ---------------------------------------------------------------------------

def test_summarize_tack_mode_sector_counts_matches_perf_bands():
    """Port/stbd × upwind/downwind counts use |TWA|<80 and |TWA|>115."""
    df = pd.DataFrame({
        "tack": ["port", "port", "starboard", "starboard", "port", "starboard"],
        "Twa_mode": [-40.0, -100.0, 45.0, 120.0, 90.0, np.nan],
    })
    c = summarize_tack_mode_sector_counts(df, twa_col='Twa')
    assert c["port_upwind"] == 1    # |-40| < 80
    assert c["stbd_upwind"] == 1    # |45| < 80
    assert c["port_downwind"] == 0
    assert c["stbd_downwind"] == 1  # |120| > 115
    assert c["reaching_or_nan_twa"] == 3  # |100|, |90|, and NaN


# ---------------------------------------------------------------------------
# _propagate_offset_columns
# ---------------------------------------------------------------------------

def test_propagate_offset_columns_duplicate_ts_uses_last_sample():
    df = pd.DataFrame({
        'ts': [1.0, 1.0, 2.0],
        'Awa_offset': [10.0, 2.0, np.nan],
    })
    _propagate_offset_columns(df, ['Awa_offset'])
    np.testing.assert_allclose(
        df['Awa_offset'].to_numpy(), [2.0, 2.0, 2.0], rtol=0, atol=1e-9
    )


# ---------------------------------------------------------------------------
# train_leeway_model / compute_leeway_residuals
# ---------------------------------------------------------------------------

_LWY_FEATURES = [
    'Bsp', 'Tws', 'Altitude', 'Foil_lwd_sink', 'Foil_lwd_cant_eff',
    'Main_sheet_load', 'Swh',
]


def test_train_leeway_model():
    df = generate_synthetic_sailing_data(n_samples=500)
    model = train_leeway_model(df, lwy_col='Lwy', features=_LWY_FEATURES, twa_col='Twa')
    assert model is not None
    assert hasattr(model, 'predict')


def test_leeway_residuals():
    df = generate_synthetic_sailing_data(n_samples=500)
    model = train_leeway_model(df, lwy_col='Lwy', features=_LWY_FEATURES, twa_col='Twa')
    df_out = compute_leeway_residuals(df, model, lwy_col='Lwy', features=_LWY_FEATURES, twa_col='Twa')
    assert 'lwy_residual' in df_out.columns
    assert not df_out['lwy_residual'].isna().all()


# ---------------------------------------------------------------------------
# optimize_leeway_offsets / apply_leeway_calibration
# ---------------------------------------------------------------------------

def _make_leeway_frame(n: int = 200, twa_deg: float = 40.0) -> pd.DataFrame:
    start = datetime(2026, 2, 11, 0, 0, 0, tzinfo=timezone.utc)
    ts = np.arange(n, dtype=float)
    twa = np.where(np.arange(n) < n // 2, twa_deg, -twa_deg)
    lwy = twa * 0.05 + np.random.default_rng(1).normal(0, 0.1, n)
    return pd.DataFrame({
        'ts': ts,
        'Datetime': [start + timedelta(seconds=int(i)) for i in range(n)],
        'Twa': twa,
        'Lwy': lwy,
        'tack': np.where(twa > 0, 'starboard', 'port'),
        'Grade': 2,
    })


def test_optimize_leeway_offsets_returns_48_entries():
    df = _make_leeway_frame()
    port_off, stbd_off = optimize_leeway_offsets(df, lwy_col='Lwy', twa_col='Twa')
    assert len(port_off) == 48
    assert len(stbd_off) == 48


def test_apply_leeway_calibration_modifies_lwy_col():
    df = _make_leeway_frame()
    port_off = {i * 0.5: 0.5 for i in range(48)}
    stbd_off = {i * 0.5: -0.5 for i in range(48)}
    out = apply_leeway_calibration(df, port_off, stbd_off, lwy_col='Lwy', twa_col='Twa')
    # After calibration Lwy should be different from the original
    assert not np.allclose(out['Lwy'].values, df['Lwy'].values)


# ---------------------------------------------------------------------------
# recompute_true_wind
# ---------------------------------------------------------------------------

def test_recompute_true_wind_writes_cor_columns():
    df = generate_synthetic_sailing_data(n_samples=50)
    out = recompute_true_wind(df, awa_col='Awa', aws_col='Aws', bsp_col='Bsp',
                              lwy_col='Lwy', hdg_col='Hdg')
    assert 'Twa_cor' in out.columns
    assert 'Tws_cor' in out.columns
    assert 'Twd_cor' in out.columns
    assert not out['Twa_cor'].isna().all()
    assert not out['Tws_cor'].isna().all()
