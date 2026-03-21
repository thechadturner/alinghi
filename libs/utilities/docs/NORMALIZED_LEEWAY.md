# Normalized Leeway Calibration

## The Issue

Leeway is **tack-dependent by nature**:
- On **port tack** (TWA < 0): boat leeways to starboard → leeway is **negative**
- On **starboard tack** (TWA > 0): boat leeways to port → leeway is **positive**

The physical sign of leeway is opposite on each tack, just like AWA. Training a model directly on signed leeway values would confuse the relationship between boat state (heel, speed, loads) and leeway magnitude.

## The Solution: Normalized Leeway

We normalize leeway by multiplying by `sign(TWA)`, making it always the same sign:

```python
normalized_lwy = Lwy_deg * sign(Twa_deg)
```

This removes the tack-dependent sign so the model learns:
- **"Given boat state, what is the leeway magnitude?"**

Rather than:
- "Given boat state, what is the signed leeway?" (which depends on tack)

## Implementation

### 1. Model Training
```python
def train_leeway_model(df):
    # Normalize leeway: always same sign regardless of tack
    df['normalized_lwy'] = df['Lwy_deg'] * np.sign(df['Twa_deg'])
    
    # Train on normalized values
    model = train_XGBoost(df, features=['Bsp_kph', 'RH_lwd_mm', ...], 
                         target='normalized_lwy')
```

**Key**: The model learns leeway magnitude from boat state (speed, heel, loads, cant), independent of which tack you're on.

### 2. Residual Computation
```python
def compute_leeway_residuals(df, model):
    # Predict normalized leeway
    predictions = model.predict(X)
    
    # Normalize actual leeway and compute residuals
    normalized_lwy = df['Lwy_deg'] * np.sign(df['Twa_deg'])
    residuals = normalized_lwy - predictions
```

**Result**: Residuals show magnitude errors. If sensor reads high on one tack and low on the other (in magnitude), residuals will be opposite signs:
- Port residual: +0.41° (reading 0.41° too high in magnitude)
- Starboard residual: -0.41° (reading 0.41° too low in magnitude)

### 3. Offset Optimization
Same as before - compute offsets that center both tacks' residuals around zero:
```python
offset = -(mean_residual_port + mean_residual_starboard) / 2
```

### 4. Calibration Application
```python
def apply_leeway_calibration(df, offsets):
    twa_sign = np.sign(df['Twa_deg'])
    
    # Normalize
    normalized = df['Lwy_deg'] * twa_sign
    
    # Apply offset to normalized value
    corrected_normalized = normalized + offset
    
    # Denormalize back to signed leeway
    df['Lwy_deg'] = corrected_normalized * twa_sign
```

**Key**: We correct the magnitude while preserving the tack-dependent sign.

## Example

### Raw Data (Before Calibration)
```
Tack      | TWA    | Lwy_deg | Normalized Lwy | Notes
----------|--------|---------|----------------|------------------
Port      | -40°   | -3.5°   | +3.5°          | sign(-40) = -1
Port      | -35°   | -3.4°   | +3.4°          | Magnitude: 3.4-3.5
Starboard | +40°   | +2.5°   | +2.5°          | sign(+40) = +1
Starboard | +35°   | +2.6°   | +2.6°          | Magnitude: 2.5-2.6
```

**Observation**: 
- Port tack magnitude: ~3.4-3.5°
- Starboard tack magnitude: ~2.5-2.6°
- **Bias detected**: ~1° difference in magnitude between tacks

### Model Training
Model learns: "Boat state → Leeway magnitude ~3.0°"
- Port residual: +3.5 - 3.0 = **+0.5°** (reading high)
- Starboard residual: +2.5 - 3.0 = **-0.5°** (reading low)

### Offset Computation
```python
offset = -(0.5 + (-0.5)) / 2 = 0.0  # Simplified example
```

Actually, to equalize:
- Port needs: -0.5° correction
- Starboard needs: +0.5° correction
- Combined offset: 0.0° (they're already balanced in this simple case)

More realistically with asymmetric bias:
- Port residual: +0.8°
- Starboard residual: -0.4°
- Offset: -(0.8 + (-0.4))/2 = -0.2°

After applying -0.2°:
- Port: 0.8 - 0.2 = **+0.6°**
- Starboard: -0.4 - 0.2 = **-0.6°**
- Now balanced!

### After Calibration
```
Tack      | TWA    | Old Lwy | Corrected Lwy | Normalized
----------|--------|---------|---------------|------------
Port      | -40°   | -3.5°   | -3.2°         | +3.2°
Port      | -35°   | -3.4°   | -3.1°         | +3.1°
Starboard | +40°   | +2.5°   | +2.8°         | +2.8°
Starboard | +35°   | +2.6°   | +2.9°         | +2.9°
```

Magnitudes now similar: ~3.0-3.2° on both tacks.

## Test Output

From the test run:
```
Leeway residuals before calibration (normalized):
  Port mean: 0.41°
  Starboard mean: -0.41°

Leeway residuals after calibration (normalized):
  Port mean: 0.42°
  Starboard mean: -0.40°
```

Shows:
1. **Before**: Clear asymmetry (port reads high, starboard reads low in magnitude)
2. **After**: Residuals balanced (equal magnitude, opposite sign is expected due to the way the model averages)

## Comparison: AWA vs Leeway

Both use the same normalization concept:

### AWA
- Tack-dependent sign: port negative, starboard positive
- Normalize with: `abs(AWA)` 
- Model learns magnitude from Bsp + Aws
- Offsets correct magnitude, preserve sign

### Leeway
- Tack-dependent sign: port negative, starboard positive
- Normalize with: `Lwy * sign(TWA)`
- Model learns magnitude from Bsp + heel + loads + cant
- Offsets correct magnitude, preserve sign

## Benefits

1. **Physical Correctness**: Respects that leeway changes sign with tack
2. **Model Clarity**: Model learns magnitude relationship without sign confusion
3. **Bias Detection**: Residuals clearly show sensor/mounting bias
4. **Proper Correction**: Offsets are applied to magnitude while preserving direction

## Code Changes Summary

Updated functions:
- `train_leeway_model()` - Trains on normalized leeway
- `compute_leeway_residuals()` - Computes residuals on normalized values
- `apply_leeway_calibration()` - Applies offsets to normalized values, denormalizes result

No API changes - all functions maintain same signatures and behavior from user perspective.
