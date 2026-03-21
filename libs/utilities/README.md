# Utilities Library

A comprehensive Python utility library for sailing data analysis, mathematical operations, geographical calculations, and API interactions.

## Features

- **Mathematical Utilities**: Angle normalization, interpolation, statistical calculations
- **Geographical Utilities**: Coordinate conversions, range/bearing calculations
- **Datetime Utilities**: Timezone handling, timestamp conversions
- **Wind & Weather Utilities**: Sailing-specific wind calculations, air density
- **Race Analysis**: Maneuver detection, race leg identification, performance metrics
- **API Utilities**: HTTP request handling, data resampling, binary parsing
- **Interpolation**: Polar data interpolation for sailing performance
- **Machine Learning**: XGBoost model training utilities

## Installation

```bash
pip install -e .
```

Or install from the utilities directory:

```bash
cd libs/utilities
pip install -e .
```

## Quick Start

```python
import utilities as u

# Angle calculations
angle = u.angle360_normalize(400)  # Returns 40
mean_wind = u.mean360([350, 10, 20])  # Returns 0 (wraps around 360)

# Geographical calculations
x, y = u.latlng_to_meters(39.12, 9.18, 39.13, 9.19)
lat, lng = u.meters_to_latlng(39.12, 9.18, x, y)

# Datetime utilities
dt = u.get_datetime_obj("2024-01-01 12:00:00")
ts = u.get_timestamp_from_str("2024-01-01 12:00:00")

# Race analysis
df = u.PrepareManeuverData(df)  # Prepares sailing data for analysis
df = u.identifyManeuvers(df)  # Identifies tacks, gybes, etc.
```

## Module Overview

### math_utils
Mathematical operations including:
- Angle normalization (`angle360_normalize`, `angle180_normalize`)
- Angle arithmetic (`angle_add`, `angle_subtract`, `angle_between`)
- Statistical functions (`mean360`, `std360`)
- Number parsing and conversion

### geo_utils
Geographical coordinate operations:
- `latlng_to_meters`: Convert lat/lng to meters
- `meters_to_latlng`: Convert meters to lat/lng
- `range_from_latlng`: Calculate distance between points
- `bearing_from_latlng`: Calculate bearing between points

### datetime_utils
Timezone-aware datetime handling:
- `get_datetime_obj`: Parse datetime strings with timezone support
- `get_timestamp_from_str`: Convert datetime strings to timestamps
- `get_utc_datetime_from_ts`: Convert timestamps to UTC datetime

### race_utils
Sailing race analysis functions:
- `PrepareManeuverData`: Prepare data for maneuver analysis
- `identifyManeuvers`: Automatically detect sailing maneuvers
- `IdentifyRaceLegs`: Segment races into legs
- `computeVMC`: Calculate Velocity Made Course

### wind_utils
Wind and current calculations:
- `calculate_stw`: Speed through water
- `calculate_current`: Current speed and direction
- `computeTrueWind`: Convert apparent to true wind
- `adjustTrueWind`: Adjust for current effects

### api_utils
HTTP API interaction utilities:
- `get_api_data`: GET requests
- `post_api_data`: POST requests
- `get_channel_values`: Retrieve time series data
- `log`: Async logging function

### interp_utils
Polar data interpolation:
- `interpolate_twa`: Interpolate True Wind Angle
- `interpolate_vmg`: Interpolate Velocity Made Good
- `interpolate_bsp`: Interpolate Boat Speed

## Dependencies

- pandas
- numpy
- requests
- pytz
- python-dateutil
- statsmodels
- xgboost
- scikit-learn
- pyarrow

## Type Hints

All functions include comprehensive type hints for better IDE support and type checking.

## Logging

The library uses Python's standard logging module. Configure logging levels as needed:

```python
import logging
logging.basicConfig(level=logging.INFO)
```

## Performance

The library has been optimized with vectorized operations where possible, especially in `race_utils` for handling large sailing datasets efficiently.

## Testing

Run tests with:

```bash
python -m pytest tests/
```

## License

MIT License

## Author

Chad Turner - thechadturner@gmail.com
