Charts, Builders, and Configuration Conventions

Builders
- Pages for composing chart configurations and loading data: Performance, Scatter, Timeseries, Probability, Overlay, Parallel, Polar Rose, Grid, Table, Video, Targets.
- Navigation back to explore pages must set correct menu type in global UI per TeamShare rules (e.g., setSelectedMenu("POLAR ROSE") when exiting PolarRose builder).

Chart Conventions
- Never hardcode data field names. Always use dynamic field names from configuration, and convert to lowercase when indexing data from the API.
- For display (labels/tooltips), use original case from configuration.

Map Visualizations
- Use d3.js on top of Mapbox (no built-in Mapbox layers).
- Components under src/components/charts/map/ include MapContainer.jsx, MapControls.jsx, MapVisualization.jsx and layers/ hooks for boat, track, and selection.
- Time-linked visualization with MapTimeSeries.jsx and global playback store.

Time Series, Scatter, Probability, PolarRose
- Components under src/components/charts/ provide specialized visualizations; rely on unifiedDataStore queries and selection/playback signals.
- Ensure axis channel names are validated and converted to lowercase for data access.

Targets and Performance
- TargetScatter/TargetTable for target data and tuning.
- Performance builder uses aggregated data via unifiedDataStore (aggregates source).

Error Handling
- Validate required axis names before processing data. Provide meaningful errors and fallbacks for optional props.

Cleanup
- For D3 selections and global listeners, implement cleanup in onCleanup.

