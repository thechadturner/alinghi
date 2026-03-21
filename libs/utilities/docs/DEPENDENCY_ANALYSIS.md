# Utilities Library Dependency Analysis

## Function Usage Inventory

This document catalogs all utilities functions used in `server_python/scripts/ac75/` and their usage patterns.

### Functions Used by Scripts

#### API Functions (api_utils.py)
- `get_channel_values()` - Used in: 2_processing.py, Performance.py, all maneuver scripts
- `log()` - Used extensively across all scripts for logging
- `get_api_data()` - Used in: 2_processing.py, Performance.py
- `post_api_data()` - Used in: 2_processing.py, Performance.py, all maneuver scripts
- `put_api_data()` - Used in: 2_processing.py
- `delete_api_data()` - Used in: 2_processing.py, Performance.py, all maneuver scripts

#### Math Functions (math_utils.py)
- `mean360()` - Used extensively for angle averaging (Twd, Hdg, Cog)
- `std360()` - Used in: Performance.py for standard deviation of angles
- `angle_subtract()` - Used extensively for angle calculations
- `angle_add()` - Used in: wind_utils.py (indirectly)
- `angle360_normalize()` - Used in maneuver scripts for heading normalization
- `angle_between()` - Used in: race_utils.py (indirectly)
- `number()` - Used extensively for safe number conversion
- `get_even_integer()` - Used in maneuver scripts for TWS binning
- `mps` (constant) - Used for speed conversions (knots to m/s)

#### Geo Functions (geo_utils.py)
- `latlng_to_meters()` - Used in all maneuver scripts for coordinate conversion
- `meters_to_latlng()` - Used in all maneuver scripts for coordinate conversion
- `range_from_latlng()` - Used in: race_utils.py (indirectly)
- `bearing_from_latlng()` - Used in: race_utils.py (indirectly)

#### Datetime Functions (datetime_utils.py)
- `get_datetime_obj()` - Used extensively for datetime parsing
- `get_timestamp_from_str()` - Used in: 2_processing.py
- `get_utc_datetime_from_ts()` - Used in maneuver scripts
- `dt` (datetime module) - Used for timestamp operations
- `td` (timedelta) - Used for time arithmetic

#### Race Functions (race_utils.py)
- `PrepareManeuverData()` - Used in all maneuver scripts
- `PrepareManeuverVmg()` - Not directly used (internal to PrepareManeuverData)
- `updateManeuverTime()` - Used in all maneuver scripts
- `UpdateManeuverSeconds()` - Used in all maneuver scripts
- `NormalizeManeuverData()` - Used in all maneuver scripts
- `IdentifyEntryExit()` - Used in all maneuver scripts
- `getMetadata()` - Used in all maneuver scripts
- `identifyManeuvers()` - Used in: 2_processing.py
- `remove_gaps()` - Used in: 2_processing.py
- `PrepareTimeReference()` - Not directly used (internal)
- `IdentifyRaceLegs()` - Not directly used
- `computeVMC()` - Not directly used

#### Storage Functions (localstorage.py)
- `LocalStorage()` - Used in: Performance.py, all maneuver scripts

#### Wind Functions (wind_utils.py)
- Not directly used in scripts (used internally by race_utils)

#### Weather Functions (weather_utils.py)
- Not directly used in scripts

#### Interpolation Functions (interp_utils.py)
- Not directly used in scripts

#### String Functions (string_utils.py)
- Not directly used in scripts

#### AI Functions (ai_utils.py)
- Not directly used in scripts

### Functions NOT Used
These functions may be candidates for deprecation or are used internally:
- Most functions in `weather_utils.py`
- Most functions in `interp_utils.py`
- Most functions in `string_utils.py`
- Most functions in `ai_utils.py`
- Some functions in `race_utils.py` (PrepareTimeReference, IdentifyRaceLegs, computeVMC)

### Critical Dependencies
Functions that MUST maintain backward compatibility:
1. `angle_subtract()` - Critical for angle calculations, used extensively
2. `mean360()` - Critical for wind direction averaging
3. `PrepareManeuverData()` - Core function for maneuver processing
4. `get_channel_values()` - Core data retrieval function
5. `log()` - Used for all logging operations

## Code Quality Issues Found

### Print Statements (110+ found)
- `geo_utils.py`: 5 print statements
- `datetime_utils.py`: 3 print statements  
- `weather_utils.py`: 1 print statement
- `string_utils.py`: 1 print statement
- `race_utils.py`: 8 print statements
- `interp_utils.py`: 8 print statements
- `api_utils.py`: 30+ print statements
- `ai_utils.py`: 5 print statements

### Bare Except Clauses
- `race_utils.py`: 3 bare except clauses (lines 76, 82, 87)
- `datetime_utils.py`: 2 bare except clauses (lines 48, 70)
- `math_utils.py`: 4 bare except clauses (lines 134, 151, 173, 192)

### Import Issues
- `math_utils.py`: Missing `pd` import (line 132 in `aav` function - but function doesn't use pd)
- `wind_utils.py`: Circular import (imports utilities)
- `race_utils.py`: Circular import (imports utilities)

### Missing Type Hints
- All functions lack type hints

### Commented Code
- `race_utils.py`: Multiple commented sections
- `interp_utils.py`: Commented debug prints

