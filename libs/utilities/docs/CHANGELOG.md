# Changelog

## [Optimization Update] - 2024

### Added
- Comprehensive type hints to all functions for better IDE support and type checking
- Logging utilities module (`logging_utils.py`) for consistent error/warning/info logging
- Backward compatibility alias `removeGaps` for `remove_gaps` function
- Dependency analysis document (`DEPENDENCY_ANALYSIS.md`)

### Changed
- **BREAKING**: All print statements replaced with proper logging functions
  - Use `log_error()`, `log_warning()`, `log_info()`, or `log_debug()` instead
- **BREAKING**: Circular imports fixed in `wind_utils.py` and `race_utils.py`
  - These modules now import directly from `math_utils` and `geo_utils` instead of the parent package
- Error handling improved: bare `except:` clauses replaced with specific exception types
- Performance optimizations: vectorized operations in `race_utils.py`
  - `TurnAng` calculation now uses vectorized operations
  - `Twa_cor` and `Cwa_cor` calculations vectorized
  - `UpdateManeuverSeconds` now uses vectorized calculation
  - `computeVMC` VMC calculations vectorized
- Removed all commented-out code blocks

### Fixed
- Circular import issues between `wind_utils.py` ↔ `utilities` package
- Circular import issues between `race_utils.py` ↔ `utilities` package
- Bare except clauses replaced with specific exception handling
- All print statements replaced with proper logging

### Performance
- Vectorized angle calculations in `race_utils.py` (significant speedup for large datasets)
- Eliminated `iterrows()` loops where possible
- Replaced `apply(lambda)` with vectorized numpy/pandas operations

### Documentation
- Updated README.md with comprehensive module overview
- All functions now have complete type hints
- Improved docstrings throughout

### Migration Notes
- **No function signature changes**: All existing code should continue to work
- **Logging**: If you were relying on print output, configure Python logging to see messages
- **Imports**: Internal imports changed but external API remains the same

### Backward Compatibility
- `removeGaps` alias added for scripts using camelCase naming
- All function signatures remain unchanged
- All return types and behaviors preserved

