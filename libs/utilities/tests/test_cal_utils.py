"""
Tests for calibration utilities (cal_utils.py).

Covers performance-model / fusion helpers: data loading, offset propagation,
and leeway pieces used by ``calibrate_and_fuse_pipeline``.
"""

import numpy as np
import pandas as pd
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from utilities.cal_utils import (
    CalibrationConfig,
    load_calibration_data,
    compute_initial_true_wind,
    add_tack_and_hour,
    train_leeway_model,
    compute_leeway_residuals,
    optimize_leeway_offsets,
    apply_leeway_calibration,
    recompute_true_wind,
)
from utilities.speed_units import (
    convert_speed_array,
    ensure_speed_columns,
    infer_speed_unit_from_dataframe,
    resolve_speed_unit,
)


def generate_synthetic_sailing_data(n_samples=1000, seed=42):
    """
    Generate synthetic sailing data with realistic relationships and known sensor biases.
    """
    np.random.seed(seed)

    start_time = datetime(2026, 2, 11, 0, 0, 0)
    timestamps = [start_time + timedelta(seconds=i) for i in range(n_samples)]

    bsp = 9 + 2 * np.sin(np.linspace(0, 4 * np.pi, n_samples)) + np.random.normal(0, 0.5, n_samples)
    bsp = np.clip(bsp, 5, 14)

    aws = 15 + 3 * np.sin(np.linspace(0, 3 * np.pi, n_samples)) + np.random.normal(0, 1, n_samples)
    aws = np.clip(aws, 8, 25)

    twa_base = 40 * np.sin(np.linspace(0, 8 * np.pi, n_samples))
    twa = twa_base + np.random.normal(0, 3, n_samples)

    awa_true = 30 + (aws - 15) * 2 - (bsp - 9) * 1.5 + np.random.normal(0, 2, n_samples)
    awa_true = np.where(twa < 0, -np.abs(awa_true), np.abs(awa_true))

    tack_sign = np.sign(twa)
    awa_bias = np.where(tack_sign < 0, 3.0, -2.0)
    awa_measured = awa_true + awa_bias

    heel = 15 + (aws - 15) * 0.5 + np.random.normal(0, 1, n_samples)
    jib_load = 800 + (aws - 15) * 30 + np.random.normal(0, 50, n_samples)
    cant_eff = 2 + (aws - 15) * 0.1 + np.random.normal(0, 0.3, n_samples)

    lwy_magnitude = 2 + (heel - 15) * 0.2 + (jib_load - 800) * 0.001 - (cant_eff - 2) * 0.5
    lwy_magnitude = np.abs(lwy_magnitude + np.random.normal(0, 0.3, n_samples))

    lwy_bias_magnitude = np.where(tack_sign < 0, 1.0, -0.5)
    lwy_magnitude_measured = lwy_magnitude + lwy_bias_magnitude

    lwy_measured = lwy_magnitude_measured * tack_sign
    lwy_true = lwy_magnitude * tack_sign

    hdg = 90.0 + 15 * np.sin(np.linspace(0, 6 * np.pi, n_samples)) + np.random.normal(0, 1, n_samples)
    hdg = ((hdg + 180) % 360) - 180

    df = pd.DataFrame({
        'Datetime': timestamps,
        'ts': [(t - start_time).total_seconds() for t in timestamps],
        'Bsp_kph': bsp,
        'Twa_deg': twa,
        'Hdg_deg': hdg,
        'Awa_deg': awa_measured,
        'Aws_kph': aws,
        'Lwy_deg': lwy_measured,
        'RH_lwd_mm': heel,
        'DB_cant_eff_lwd_deg': cant_eff,
        'JIB_sheet_load_kgf': jib_load / 9.81,
        'Grade': 3,
        'Awa_true': awa_true,
        'Lwy_true': lwy_true,
        'awa_bias_injected': awa_bias,
        'lwy_bias_injected': lwy_bias_magnitude,
    })

    return df


def test_generate_synthetic_data():
    df = generate_synthetic_sailing_data(n_samples=500)

    assert len(df) == 500
    assert 'Awa_deg' in df.columns
    assert 'Lwy_deg' in df.columns
    assert df['Grade'].unique()[0] == 3
    assert 'awa_bias_injected' in df.columns
    assert df['awa_bias_injected'].nunique() == 2


_MIN_CH_LIST = [
    {'name': 'ts', 'type': 'float'},
    {'name': 'Grade', 'type': 'int'},
    {'name': 'Lwy_deg', 'type': 'float'},
]


def test_load_calibration_data_include_all_grades_keeps_low_grades():
    cfg = CalibrationConfig(
        api_token='t',
        class_name='C',
        project_id='1',
        date='20260101',
        source_name='S',
    )
    mixed = pd.DataFrame({
        'ts': [1.0, 2.0, 3.0, 4.0],
        'Grade': [0, 1, 2, 3],
        'Lwy_deg': [1.0, 2.0, 3.0, 4.0],
    })
    with patch('utilities.cal_utils.get_channel_values', return_value=mixed):
        out = load_calibration_data(cfg, channel_list=_MIN_CH_LIST, include_all_grades=True)
    assert len(out) == 4
    assert set(out['Grade'].tolist()) == {0, 1, 2, 3}


def test_load_calibration_data_default_filters_grade_ge_2():
    cfg = CalibrationConfig(
        api_token='t',
        class_name='C',
        project_id='1',
        date='20260101',
        source_name='S',
    )
    mixed = pd.DataFrame({
        'ts': [1.0, 2.0, 3.0, 4.0],
        'Grade': [0, 1, 2, 3],
        'Lwy_deg': [1.0, 2.0, 3.0, 4.0],
    })
    with patch('utilities.cal_utils.get_channel_values', return_value=mixed):
        out = load_calibration_data(cfg, channel_list=_MIN_CH_LIST)
    assert len(out) == 2
    assert out['Grade'].min() >= 2


def test_propagate_offset_columns_duplicate_ts_uses_last_sample():
    from utilities.cal_utils import _propagate_offset_columns

    df = pd.DataFrame({
        'ts': [1.0, 1.0, 2.0],
        'Awa_offset_deg': [10.0, 2.0, np.nan],
    })
    _propagate_offset_columns(df, ['Awa_offset_deg'])
    np.testing.assert_allclose(df['Awa_offset_deg'].to_numpy(), [2.0, 2.0, 2.0], rtol=0, atol=1e-9)


def _minimal_apply_offsets_frame(twa_deg, n=4):
    t0 = 1_000_000.0
    ts = t0 + np.arange(n, dtype=float)
    base = datetime(2026, 2, 11, 1, 0, 0, tzinfo=timezone.utc)
    return pd.DataFrame({
        'ts': ts,
        'Datetime': [base + timedelta(seconds=int(i)) for i in range(n)],
        'Twa_deg': [twa_deg] * n,
        'Grade': [2] * n,
        'Lwy_deg': [0.5] * n,
        'Hdg_deg': [10.0] * n,
        'Bsp_kph': [12.0] * n,
        'Tws_kph': [18.0] * n,
        'Aws_kph': [14.0] * n,
        'Awa_bow_deg': [35.0] * n,
    })


def test_apply_offsets_lwy_offset_deg_starboard_positive_twa():
    from utilities.cal_utils import _apply_offsets_to_full_data

    twa_deg = 50.0
    port_val, stbd_val, expected_lwy_off_deg = 0.0, 3.5, 3.5
    port_lwy = {i * 0.5: port_val for i in range(48)}
    stbd_lwy = {i * 0.5: stbd_val for i in range(48)}
    df_full = _minimal_apply_offsets_frame(twa_deg)
    ts = df_full['ts'].to_numpy(dtype=float)
    cal = {
        'lwy_offsets': {'port': port_lwy, 'starboard': stbd_lwy},
        'awa_offsets': {
            'perf_model': (
                pd.Series([0.0], index=[ts[0]]),
                pd.Series([0.0], index=[ts[0]]),
                None,
                None,
            )
        },
    }
    multi = {
        'recommended_sensors': ['Awa_bow_deg'],
        'sensor_calibrations': {'Awa_bow_deg': {'calibration': cal}},
    }
    out = _apply_offsets_to_full_data(
        df_full, multi, ['Awa_bow_deg'], ['Aws_kph'], 'Lwy_deg'
    )
    twa_ff = pd.to_numeric(out['Twa_deg'], errors='coerce').to_numpy(dtype=float)
    assert (twa_ff > 0).all(), 'fixture expects starboard TWA after compute_initial_true_wind'
    np.testing.assert_allclose(
        out['Lwy_offset_deg'].to_numpy(dtype=float),
        expected_lwy_off_deg,
        rtol=0,
        atol=1e-5,
    )


def test_apply_offsets_lwy_offset_deg_port_tack_negative_sign():
    from utilities.cal_utils import _apply_offsets_to_full_data

    def _preserve_input_twa(df, awa_col='Awa_deg', lwy_col='Lwy_deg', speed_unit='kph', **kwargs):
        return df.copy()

    twa_deg = -45.0
    port_val, stbd_val, expected_lwy_off_deg = 2.0, 99.0, -2.0
    port_lwy = {i * 0.5: port_val for i in range(48)}
    stbd_lwy = {i * 0.5: stbd_val for i in range(48)}
    df_full = _minimal_apply_offsets_frame(twa_deg)
    ts = df_full['ts'].to_numpy(dtype=float)
    cal = {
        'lwy_offsets': {'port': port_lwy, 'starboard': stbd_lwy},
        'awa_offsets': {
            'perf_model': (
                pd.Series([0.0], index=[ts[0]]),
                pd.Series([0.0], index=[ts[0]]),
                None,
                None,
            )
        },
    }
    multi = {
        'recommended_sensors': ['Awa_bow_deg'],
        'sensor_calibrations': {'Awa_bow_deg': {'calibration': cal}},
    }
    with patch('utilities.cal_utils.compute_initial_true_wind', side_effect=_preserve_input_twa):
        out = _apply_offsets_to_full_data(
            df_full, multi, ['Awa_bow_deg'], ['Aws_kph'], 'Lwy_deg'
        )
    np.testing.assert_allclose(
        out['Lwy_offset_deg'].to_numpy(dtype=float),
        expected_lwy_off_deg,
        rtol=0,
        atol=1e-5,
    )
    norm = pd.to_numeric(out['Lwy_offset_norm_deg'], errors='coerce').to_numpy(dtype=float)
    np.testing.assert_allclose(norm * (-1.0), expected_lwy_off_deg, rtol=0, atol=1e-5)


def test_add_tack_and_hour():
    df = generate_synthetic_sailing_data(n_samples=100)
    df = compute_initial_true_wind(df)
    df = add_tack_and_hour(df)

    assert 'tack' in df.columns
    assert 'hour' in df.columns
    assert set(df['tack'].unique()) <= {'port', 'starboard'}
    assert df['hour'].min() >= 0
    assert df['hour'].max() <= 23


def test_train_leeway_model():
    df = generate_synthetic_sailing_data(n_samples=500)
    model = train_leeway_model(df)
    assert model is not None
    assert hasattr(model, 'predict')


def test_leeway_residuals():
    df = generate_synthetic_sailing_data(n_samples=500)
    model = train_leeway_model(df)
    df = compute_leeway_residuals(df, model)

    assert 'lwy_residual' in df.columns
    assert not df['lwy_residual'].isna().all()


def test_infer_speed_unit_from_bsp_suffix():
    df = pd.DataFrame({'Bsp_kts': [1.0], 'Aws_kts': [2.0]})
    assert infer_speed_unit_from_dataframe(df) == 'kts'


def test_infer_speed_unit_mixed_bsp_raises():
    df = pd.DataFrame({'Bsp_kph': [1.0], 'Bsp_kts': [2.0]})
    try:
        infer_speed_unit_from_dataframe(df)
        assert False, 'expected ValueError'
    except ValueError as e:
        assert 'Mixed speed units' in str(e)


def test_resolve_speed_unit_explicit_overrides_inference():
    df = pd.DataFrame({'Bsp_kts': [1.0], 'Aws_kts': [2.0]})
    assert resolve_speed_unit('kph', df) == 'kph'
    assert resolve_speed_unit('kts', df) == 'kts'


def test_resolve_speed_unit_defaults_kts_when_no_speed_columns():
    df = pd.DataFrame({'ts': [1.0]})
    assert resolve_speed_unit(None, df) == 'kts'


def test_infer_speed_unit_bare_bsp_is_kts():
    df = pd.DataFrame({'Bsp': [5.0]})
    assert infer_speed_unit_from_dataframe(df) == 'kts'


def test_infer_speed_unit_unsuffixed_aws_sensor_name_implies_kts():
    df = pd.DataFrame({'ts': [1.0]})
    assert infer_speed_unit_from_dataframe(df, aws_sensor_names=['Aws_bow']) == 'kts'


def test_bare_bsp_with_bsp_kph_raises():
    df = pd.DataFrame({'Bsp': [1.0], 'Bsp_kph': [2.0]})
    try:
        infer_speed_unit_from_dataframe(df)
        assert False, 'expected ValueError'
    except ValueError as e:
        assert 'Ambiguous' in str(e)


def test_suffix_kph_with_bare_aws_bow_column_raises():
    df = pd.DataFrame({'Bsp_kph': [1.0], 'Aws_bow': [2.0]})
    try:
        infer_speed_unit_from_dataframe(df)
        assert False, 'expected ValueError'
    except ValueError as e:
        assert 'conflict' in str(e).lower()


def test_ensure_speed_columns_bare_bsp_to_kts_then_kph():
    df = pd.DataFrame({'Bsp': [10.0]})
    ensure_speed_columns(df, 'kts')
    assert 'Bsp_kts' in df.columns
    assert 'Bsp' not in df.columns
    np.testing.assert_allclose(df['Bsp_kts'].to_numpy(), [10.0], rtol=0, atol=1e-9)

    ensure_speed_columns(df, 'kph')
    assert 'Bsp_kph' in df.columns
    assert 'Bsp_kts' not in df.columns


def test_convert_speed_kph_kts_round_trip():
    x = np.array([0.0, 10.0, np.nan], dtype=np.float64)
    y = convert_speed_array(x, 'kph', 'kts')
    z = convert_speed_array(y, 'kts', 'kph')
    np.testing.assert_allclose(z[0], 0.0, atol=1e-12)
    np.testing.assert_allclose(z[1], 10.0, rtol=1e-9, atol=1e-9)
    assert np.isnan(z[2])


def test_leeway_calibration_pipeline():
    """Leeway half-hour offsets + apply + recompute true wind (no residual AWA)."""
    df = generate_synthetic_sailing_data(n_samples=2000, seed=123)
    df = compute_initial_true_wind(df)
    df = add_tack_and_hour(df)

    lwy_model = train_leeway_model(df)
    df = compute_leeway_residuals(df, lwy_model)
    port_lwy_res = df[df['tack'] == 'port']['lwy_residual'].mean()
    stbd_lwy_res = df[df['tack'] == 'starboard']['lwy_residual'].mean()
    assert abs(port_lwy_res - stbd_lwy_res) > 0.05

    lwy_port, lwy_stbd = optimize_leeway_offsets(df)
    df = apply_leeway_calibration(df, lwy_port, lwy_stbd)
    df = compute_leeway_residuals(df, lwy_model)
    port_after = df[df['tack'] == 'port']['lwy_residual'].mean()
    stbd_after = df[df['tack'] == 'starboard']['lwy_residual'].mean()
    assert abs(abs(port_after) - abs(stbd_after)) < 0.25

    df = recompute_true_wind(df)
    assert 'Tws_kph' in df.columns
    assert 'Twa_deg' in df.columns
    assert 'Twd_deg' in df.columns


if __name__ == '__main__':
    test_generate_synthetic_data()
    test_load_calibration_data_include_all_grades_keeps_low_grades()
    test_load_calibration_data_default_filters_grade_ge_2()
    test_propagate_offset_columns_duplicate_ts_uses_last_sample()
    test_apply_offsets_lwy_offset_deg_starboard_positive_twa()
    test_apply_offsets_lwy_offset_deg_port_tack_negative_sign()
    test_add_tack_and_hour()
    test_train_leeway_model()
    test_leeway_residuals()
    test_leeway_calibration_pipeline()
    print('All manual tests passed.')
