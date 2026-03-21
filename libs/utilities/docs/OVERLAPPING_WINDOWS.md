# 30-Minute Overlapping Window Calibration

## Enhancement Summary

The calibration system now uses **overlapping 1-hour windows positioned every 30 minutes** throughout the day, providing 48 offset values instead of 24.

## How It Works

### Window Structure

Instead of fixed hourly windows:
```
Old: [00:00-00:59] [01:00-01:59] [02:00-02:59] ...
```

Now uses overlapping windows every 30 minutes:
```
New: [00:00-00:59]
          [00:30-01:29]
               [01:00-01:59]
                    [01:30-02:29]
```

Each window:
- **Width**: 1 hour of data
- **Step**: 30 minutes between window centers
- **Coverage**: Adjacent windows overlap by 50%
- **Total**: 48 windows (at times 00:00, 00:30, 01:00, ..., 23:00, 23:30)

### Offset Dictionary

Offsets are keyed by float values representing time in hours:
```python
offsets = {
    0.0: -0.08,   # 00:00 - uses data from 23:30-00:30
    0.5: -0.05,   # 00:30 - uses data from 00:00-01:00
    1.0: -0.03,   # 01:00 - uses data from 00:30-01:30
    1.5: -0.01,   # 01:30 - uses data from 01:00-02:00
    ...
    23.5: -0.10   # 23:30 - uses data from 23:00-00:00
}
```

### Application Logic

When applying calibration, each timestamp is mapped to the **nearest 30-minute mark**:
```python
time_hours = hour + minute/60.0  # e.g., 14:17 = 14.283
nearest_half_hour = round(time_hours * 2) / 2  # → 14.5 (14:30)
offset = offsets[nearest_half_hour]
```

## Benefits

1. **Finer Temporal Resolution**
   - 48 offsets vs 24 = 2x temporal sampling rate
   - Better captures time-varying sensor drift

2. **Smoother Transitions**
   - Each offset uses 1 hour of data → robust
   - Adjacent offsets share 50% of data → continuous
   - Reduces discontinuities at window boundaries

3. **Better Time-Varying Drift Capture**
   - Sensor bias can change throughout the day (temperature, sun angle, structural flex)
   - 30-minute resolution tracks these changes more accurately

4. **Overlapping Windows = More Data**
   - Each timestamp influences 2 offsets (the windows it falls within)
   - Provides redundancy and averaging effect

5. **Backward Compatible Structure**
   - Still returns `Dict[float, float]` keys at 0.5h steps
   - In the current library these half-hour maps are used for **leeway** symmetry (`optimize_leeway_offsets` / `apply_leeway_calibration`). AWA corrections come from the **performance-model** offset series (`calibrate_sailing_data` / `calibrate_and_fuse_pipeline`), not from half-hour AWA dicts.

## Example

### Training Day Analysis
```
Time  | Offset | Window Coverage      | Data Points
------|--------|---------------------|-------------
00:00 | +0.08° | 23:30 - 00:30       | 120 samples
00:30 | +0.12° | 00:00 - 01:00       | 120 samples  (60 overlap with above)
01:00 | +0.15° | 00:30 - 01:30       | 120 samples  (60 overlap with above)
...
```

### Applying to New Data
Timestamp `14:17:45`:
- Time in hours: 14.296
- Nearest 30-min mark: 14.5 (rounds to 14:30)
- Uses offset from window centered at 14:30

## Performance Impact

- **Training**: Marginal increase (~2x iterations, but each window same size)
- **Application**: Nearly identical (lookup is O(1), just more keys)
- **Memory**: 48 floats instead of 24 floats (negligible)

## Visual Comparison

### Without Overlapping (Old)
```
Offset at 01:00 uses: [01:00 ─────────────────────────── 01:59]
Offset at 02:00 uses: [02:00 ─────────────────────────── 02:59]
                          ▲
                    Discontinuity
```

### With Overlapping (New)
```
Offset at 01:00 uses: [00:30 ─────────────────────────── 01:30]
Offset at 01:30 uses:       [01:00 ─────────────────────────── 02:00]
Offset at 02:00 uses:             [01:30 ─────────────────────────── 02:30]
                                        ▲
                                Smooth transition
```

## Implementation Details

### Midnight Wraparound Handling
Windows near midnight properly wrap around:
```python
# Window at 00:00 (centered at midnight)
start = -0.5 hours (23:30 previous day)
end = +0.5 hours (00:30 current day)
# Uses data from 23:30-00:00 and 00:00-00:30

# Window at 23:30
start = 23.0 hours (23:00)
end = 24.5 hours (wraps to 00:30)
# Uses data from 23:00-00:00 and 00:00-00:30
```

### Rounding Logic
```python
# At 08:44 (8.733 hours)
8.733 * 2 = 17.466
round(17.466) = 17
17 / 2 = 8.5  → Use offset from 08:30

# At 08:46 (8.767 hours)
8.767 * 2 = 17.533
round(17.533) = 18
18 / 2 = 9.0  → Use offset from 09:00
```

Threshold is exactly 7.5 minutes before/after each 30-minute mark.

## Test Coverage

See `tests/test_cal_utils.py` — includes load/filter behavior, offset propagation on duplicate `ts`, `_apply_offsets_to_full_data` leeway sign checks, and leeway model / calibration pipeline tests.

## Migration Notes

**Library:** Residual-based half-hour AWA training and `get_calibrated_true_wind` were removed. Use `calibrate_sailing_data` or `calibrate_and_fuse_pipeline` for AWA (performance model) and leeway. Half-hour dicts remain part of the **leeway** path only.

## Demo

Run the interactive demo:
```bash
python examples/demo_overlapping_windows.py
```

Shows:
- Time-varying bias injection
- Offset computation at all 48 time points
- Calibration quality improvement
- Offset smoothness analysis
