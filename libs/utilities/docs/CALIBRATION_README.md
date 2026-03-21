# Sailing sensor calibration (performance-model AWA + leeway + fusion)

The `utilities.cal_utils` module calibrates apparent wind angle (AWA) using **tack × mode performance models** (port/starboard × upwind/downwind XGBoost surfaces on `Bsp_kph` and `Tws_kph`), applies **half-hour leeway symmetry offsets** (48 keys per tack), and supports **multi-sensor fusion** via `calibrate_and_fuse_pipeline` (as used by GP50 `3_corrections.py`).

## Overview

- **AWA**: Rolling offsets from matched-condition interrogation of separate port/starboard models in upwind and downwind bands (reaching excluded in training windows).
- **Leeway**: XGBoost residual model + half-hour port/starboard offset maps in normalized leeway space.
- **Fusion**: After training on Grade ≥ 2, offsets are propagated to all grades, sensors are fused, and true wind is computed from fused AWA/AWS.

**Offset clamping**: AWA performance-model offsets and normalized leeway offsets are clipped to **±5°** after EMA smoothing / propagation where applicable.

## Main entry points

| Function | Role |
|----------|------|
| `calibrate_sailing_data` | Single-sensor session: perf-model AWA + leeway + `recompute_true_wind` on Grade ≥ 2 load. |
| `calibrate_multi_sensors` | Health checks; runs `calibrate_sailing_data` per AWA sensor; ranks sensors. |
| `calibrate_and_fuse_pipeline` | Multi-sensor: calibrate → load all grades → apply offsets → fuse → `fuse_and_compute_true_wind`. |

## Usage

### Single-sensor (performance model)

```python
from utilities.cal_utils import CalibrationConfig, calibrate_sailing_data

config = CalibrationConfig(
    api_token=os.environ["SYSTEM_KEY"],
    class_name="gp50",
    project_id="1",
    date="20260118",
    source_name="GER",
    rs="100ms",
    timezone="UTC",
)

result = calibrate_sailing_data(
    config,
    awa_channel_name="Awa_bow_deg",
    lwy_channel_name="Lwy_deg",
)

df = result["data"]
# result["awa_offsets"]["perf_model"] → (uw_series, dw_series, first_valid_ts, first_valid_offset)
# result["lwy_offsets"] → {"port": dict, "starboard": dict}
# result["awa_model"] is always None (four tack×mode models are internal)
```

### Multi-sensor fusion (production-aligned)

```python
from utilities.cal_utils import calibrate_and_fuse_pipeline

out = calibrate_and_fuse_pipeline(
    config=config,
    awa_sensors=["Awa_bow_deg", "Awa_mhu_deg"],
    aws_sensors=["Aws_bow_kph", "Aws_mhu_kph"],
    lwy_sensor="Lwy_deg",
    fusion_method="robust",
)
df_fused = out["data"]
```

### Applying to new data

There is **no** separate “apply pre-trained models only” helper in the library. Re-run `calibrate_sailing_data` / `calibrate_and_fuse_pipeline` with a `CalibrationConfig` that points at the new time range (or integrate the same steps in your own job). For GP50, `server_python/scripts/gp50/3_corrections.py` writes `fusion_corrections_racesight.parquet` for downstream use.

## API reference

### `CalibrationConfig`

Dataclass: `api_token`, `class_name`, `project_id`, `date`, `source_name`, optional `rs`, `timezone`, `start_ts`, `end_ts`.

### `load_calibration_data`

Loads channels via `get_channel_values`. Default: **Grade ≥ 2**. Use `include_all_grades=True` for the fusion apply phase (handled inside `calibrate_and_fuse_pipeline`).

### Return shape (`calibrate_sailing_data`)

- `data`: calibrated dataframe with `Awa_offset_deg`, leeway columns, recomputed true wind.
- `awa_offsets["perf_model"]`: tuple of upwind/downwind offset series (indexed by time grid), plus first-valid metadata.
- `lwy_offsets`: port/starboard half-hour dicts.
- `lwy_model`: leeway XGBoost model.
- `awa_model`: `None` (perf path).

## Data requirements

- **Grade**: Training uses Grade ≥ 2 by default; fusion applies to all grades in range.
- **Channels**: See module-level `channels` in `cal_utils.py` (Datetime, ts, Bsp, Twa, Tws, AWA/AWS variants, Lwy, Hdg, boat-state features, Grade, etc.).

## Testing

```bash
cd libs/utilities
pytest tests/test_cal_utils.py -v
```

## Examples in repo

- `examples/multi_sensor_test.py` — `calibrate_and_fuse_pipeline`
- `examples/batch_calibration_analysis.py` — batch stats (requires `SYSTEM_KEY` in the environment)

## References

- True wind: `computeTrueWind_vectorized` in `wind_utils.py`
- Data API: `get_channel_values` in `api_utils.py`
- Sensor fusion: `sensor_fusion.py`
