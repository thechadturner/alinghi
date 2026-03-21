# Bedrock Intellectual Property (IP) Documentation

**Purpose:** This document outlines existing ideas, functionality, and codebase information that constitute the bedrock intellectual property of the application. It is intended for use at the start of a new contract or engagement to clearly document pre-existing IP.

**Last Updated:** March 2026  
**Application:** RACESIGHT

---

## 1. Application Overview

- **Product name:** RACESIGHT (user-facing product and repository/organization name).
- **Domain:** Sailing and racing analytics platform — real-time and historical performance data, event detection, fleet comparison, and visualization for sailing classes (e.g. AC75, GP50).
- **Stack:** SolidJS frontend, Node.js/Express backend services, Python (FastAPI) for processing scripts, Redis for streaming, PostgreSQL for persistence, SQLite/WASM (HuniDB) for client-side storage.

---

## 2. Proprietary Names and Identifiers

| Identifier | Usage |
|------------|--------|
| **RACESIGHT** | Product and repository/organization name; used in docs, package descriptions (e.g. `@racesight/hunidb`, `@racesight/mcp-solid-server`), and user-facing copy. |
| **HuniDB** | Proprietary client-side database library (SQLite/WASM + IndexedDB). Package: `@racesight/hunidb`. |
| **SyncStore** | Custom cross-window sync package used via `@solidjs/sync` (github: thechadturner/syncstore). Part of the application’s multi-window architecture. |

---

## 3. Core IP by Category

### 3.1 Architecture and System Design

- **Multi-service backend:** Separate services for app API, admin, file/media, streaming, and Python script execution (server_app, server_admin, server_file, server_media, server_stream, server_python).
- **Class-driven schema:** Database and APIs are organized by sailing “class” (e.g. `ac75`, `gp50`) with parallel table sets per class (datasets, events, media, targets, etc.).
- **Unified data store and caching policy:** Central frontend store that applies global filters and time windows; in-session in-memory caches for chart/query data; HuniDB used only for non-timeseries (events, aggregates, map data, objects). Timeseries are not persisted client-side.
- **Data normalization pattern:** Metadata fields normalized to lowercase with underscores in store/HuniDB; channel names preserved in original case for InfluxDB compatibility. Documented in `docs/architecture/DATA_NORMALIZATION_PATTERN.md`.
- **Multi-window synchronization:** Hybrid approach using SyncStore (localStorage/IndexedDB) plus hub-based postMessage (filter store, selection store) for cross-window and cross-browser-window sync; guard flags to avoid echo loops.

**Key references:**  
`docs/frontend/frontend-architecture.md`, `docs/frontend/data-caching-policy.md`, `docs/database/database-schema.md`, `docs/README.md`.

---

### 3.2 Streaming and Real-Time Processing

- **Streaming service design:** Ingestion from external WebSocket/InfluxDB sources → state machine processor → Redis time-series storage (24h retention) and WebSocket broadcast to clients. Up to ~20 concurrent sources.
- **Computed channels (sailing-specific):**  
  - **TACK:** `cwa > 0 ? 'stbd' : 'port'`.  
  - **POINTOFSAIL:** CWA bands (e.g. &lt;70° upwind, 70–120° reach, &gt;120° downwind).  
  - **MANEUVER_TYPE:** Tack (T) / Gybe (G) from TWA sign-change logic; per-source state (prevTwa, prevCwa, etc.).
- **Redis usage:** Sorted sets per channel (`stream:source_id:channel_name`), batch writes, retention cleanup, channel metadata in hashes.

**Key references:**  
`server_stream/`, `docs/streaming/streaming-service-overview.md`, `docs/streaming/streaming-data-processing.md`.

---

### 3.3 Sailing and Racing Domain Logic

- **Maneuver detection and segmentation:** Python utilities and GP50 scripts for identifying and segmenting maneuvers (tacks, gybes, bearaways, roundups, takeoffs, prestart, etc.) using angular rate (e.g. LOWESS on yaw rate), entry/exit bounds, and sailing-specific thresholds.
- **Race/leg and performance:** Identification of race legs, VMG/VMC-style metrics, polar interpolation (TWA, VMG, BSP), mark wind, and performance aggregates. Metadata (race_number, leg_number, grade, state, config) stored in event tags and used for filtering.
- **Event types and tags:** Dataset events (e.g. CREW, HEADSAIL, CONFIGURATION, race/prestart) with sync/diff logic (update/insert/delete) and tag updates (e.g. mid_time, key-value tags). Server-side event tag updates and matching by time containment.
- **Wind/weather and geo:** True wind from apparent, current adjustment, air density, range/bearing from lat/lng, angle normalization (360/180), mean360/std360 for circular stats.

**Key references:**  
`libs/utilities/utilities/race_utils.py`, `libs/utilities/` (math_utils, geo_utils, wind_utils, interp_utils), `server_python/scripts/gp50/` (maneuvers, performance, map, race, markwind, normalization, processing), `server_admin/controllers/events.js`.

---

### 3.4 Client-Side Libraries and Patterns

- **HuniDB:** TypeScript library for SQLite/WASM in the browser with IndexedDB persistence; migrations, transactions, query/exec API, schema DSL, query builder. Used for events, aggregates, map data, objects; not used for raw timeseries in current design.
- **UnifiedDataStore:** Single entry point for chart/builders; applies filters and time windows; LRU and query caches; channel availability and “no data” backoff; clearCacheForDataSource / clearAllData.
- **FilterStore, SelectionStore, PlaybackStore:** Global filter state (states, races, legs, grades); selection (ranges, events, cut events); playback time; all integrated with SyncStore and cross-window hub.
- **Sidebar and menu logic:** Dynamic menu generation by context (dataset, day, project source/level); multiple modes and auto-selection behaviors; reactive updates and video menu integration.
- **Chart/builders:** Performance, Scatter, TimeSeries, Probability, Overlay, Parallel, Polar Rose, Grid, Table, Video, Targets. Configuration-driven axis/channel names; no hardcoded field names; lowercase for data access, original case for display.
- **SimpleScatter and density optimization:** Queue-based processing, web worker (enhanced scatter processor), density optimization with cache key (class, source, colorType, regressionMethod, filters, selection); regression (Linear, Poly 2/3, LOESS); color grouping (DEFAULT, TACK, GRADE, UW/DW).
- **Map visualizations:** D3 on top of Mapbox (no built-in Mapbox layers); track rendering (e.g. continuous/segmented), time-linked MapTimeSeries and playback; multi-source mapping and time-window filtering with WebGL renderer cache invalidation when time window goes to “full”.
- **Page scaling and scroll behavior:** Strategies for large datasets; container height/inverse-scale for maneuver TimeSeries and performance pages.

**Key references:**  
`libs/huni_db/`, `frontend/store/unifiedDataStore.ts`, `frontend/store/filterStore.ts`, `frontend/store/selectionStore.ts`, `frontend/store/playbackStore.ts`, `frontend/components/dashboard/Sidebar.tsx`, `docs/frontend/simpleScatter-architecture.md`, `docs/frontend/frontend-charts-and-builders.md`, `docs/frontend/multi-source-mapping-strategy.md`, `docs/frontend/sidebar-menu-logic.md`.

---

### 3.5 Backend and API Design

- **Admin events API:** CRUD and bulk operations for dataset events; updateEventTags; syncDatasetEvents (diff desired CREW/HEADSAIL/race/prestart vs current, optional CONFIG/CONFIGURATION updates); time normalization and timezone handling (preserveTimezone, ensureExplicitTimezone).
- **Authentication and authorization:** JWT and Personal Access Tokens (PAT); permission levels (e.g. SUPERUSER, ADMINISTRATOR, PUBLISHER, CONTRIBUTOR, READER) and access types (READ, WRITE, DELETE, ADMIN); project-scoped permissions and user_projects.
- **Python service:** FastAPI wrapper for running scripts (e.g. GP50 normalization, processing, maneuvers, performance, map); SSE for progress; env-based config (e.g. SYSTEM_KEY) and parameter passing (class_name, project_id, dataset_id, etc.).

**Key references:**  
`server_admin/controllers/events.js`, `docs/system/subscriptions-and-permissions.md`, `docs/python/python-service-overview.md`, `server_python/app/main.py`.

---

### 3.5a Python Scripting (Expanded)

The Python scripting layer is a FastAPI service that executes class-specific scripts in subprocesses, streams progress via SSE, and relies on a shared utilities library for sailing/race logic and API access.

#### Service and execution model

- **FastAPI app** (`server_python/app/main.py`): Exposes script execution (sync and background), progress over SSE, running-process listing, and cancel. Authenticates via JWT or PAT; loads env from project root (`.env` / `.env.local` or `.env.production` / `.env.production.local` based on `NODE_ENV`); uses `SYSTEM_KEY`, `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `APP_BASE_URL`, `CORS_ORIGINS`.
- **Script discovery:** Scripts live under `server_python/scripts/<class_name>/` (e.g. `scripts/gp50/`). The API accepts `class_name` and `script_name` (e.g. `0_map.py`); path is `scripts/<class_name.lower()>/<script_name>`. Case-insensitive script name matching is used when the file system differs.
- **Parameter passing:** The caller passes a JSON object (e.g. `class_name`, `project_id`, `dataset_id`, `date`, `source_name`, `start_time`, `end_time`, `batch`, `verbose`). The service invokes the script with this JSON as a single command-line argument (`sys.argv[1]`). Scripts often parse it and store context in `utilities.LocalStorage()` (in-memory key-value) for use by imported modules (e.g. Maneuvers, Map, Race).
- **Process management:** Subprocess execution with configurable timeout (e.g. 1 hour); stdout/stderr read in a loop and forwarded to SSE; error/warning keyword detection; process registry by `process_id`; graceful shutdown and SSE connection cleanup to avoid memory leaks.
- **SSE:** Real-time progress stream per user; events include script output, progress, completion, timeout; keepalive and heartbeat; cleanup of stale connections.

#### Utilities library (`libs/utilities`)

All scripts depend on the shared `utilities` package (imported as `import utilities as u`). It provides:

- **API access:** `get_api_data`, `post_api_data`, `get_channel_values` (timeseries from app API/Influx), `log` (async logging to API).
- **Race/sailing logic:** `race_utils` — `PrepareTimeReference`, `IdentifyEntryExit` (LOWESS-based maneuver bounds), `getMostLikelyValue`, `PrepareManeuverData`, `identifyManeuvers`, `IdentifyRaceLegs`, `remove_gaps`/`removeGaps`, and related helpers used across GP50 scripts.
- **Math/geo/datetime/wind:** `math_utils` (angle normalization, mean360, etc.), `geo_utils` (range/bearing, lat/lng conversions), `datetime_utils`, `wind_utils`, `interp_utils` (polar interpolation), `weather_utils`.
- **Local context:** `LocalStorage()` — in-memory key-value store for `api_token`, `class_name`, `project_id`, `dataset_id`, `date`, `source_name`, `start_time`, `end_time`, `batch`, `verbose` so that downstream modules do not need to thread parameters.

#### GP50 script pipeline (numbered flow)

Scripts are named by execution order and purpose:

| Script | Purpose |
|--------|--------|
| **0_init_class.py** | One-time class setup: posts maneuver menus, filter definitions (dataset/day/fleet/source), default channels (lat/lng, TWA, TWD, TWS, BSP, HDG), and other class objects to the API (`/api/classes/object`). |
| **0_maneuvers.py** | Entry point for maneuver detection: loads parameters and `LocalStorage`, then runs `Maneuvers.start()` which fetches MANEUVER_TYPE (and related) channel data and runs tacks, gybes, roundups, bearaways, takeoffs, prestart, and update_loss. |
| **0_race.py** | Race segmentation and race/leg metadata (e.g. identifies races and legs, posts or updates race/leg structure). |
| **0_performance.py** | Performance aggregates for the dataset (e.g. VMG, polar, or other performance metrics). |
| **0_map.py** | Map-related data generation (tracks, waypoints, or other map payloads) for the dataset. |
| **1_normalization_influx.py** | Fetches raw data from InfluxDB, applies class-specific channel mapping (angle vs regular vs special), normalizes names and units, and writes normalized timeseries (e.g. to API/Influx or internal store). Defines `get_influx_to_normalized_mapping()` for GP50. |
| **1_normalization_csv.py** | CSV-based normalization path (alternative to Influx). |
| **1_parseXml.py** | Parses XML input (e.g. race or config) and prepares structured data for downstream steps. |
| **2_processing.py** | Main processing: fetches normalized channel data via `get_channel_values`, applies gap removal, filters, and sailing-specific logic; can write events, aggregates, or derived channels; uses PyArrow and batch processing for large datasets. |
| **2_process_and_execute.py** | Orchestrates processing plus execution (e.g. runs 2_processing then 0_maneuvers, 0_race, 0_map, 0_performance in sequence). Used for “process and run all” workflows. |
| **2_process_and_execute_manual.py** | Manual/variant of the process-and-execute flow. |
| **3_execute.py** | Execution-only: runs Map, Race, Performance, etc. (no normalization/processing); used when raw data is already normalized. |
| **3_corrections.py** | Applies corrections to existing data (e.g. offsets, recalibration). |
| **4_cleanup.py** | Day-level cleanup: VMG day baselines per maneuver type, race position (leg/race position, positions gained/lost), grade-by-VMG updates from events_aggregate; runs over all datasets for a day. |
| **5_markwind.py** | Builds “markwind” object from Influx MDSS data: queries fixed boat names (e.g. FL1, FL2, SL1, M1, LG1, …), merges by timestamp, resamples (e.g. 10s), posts as project object `markwind`. |

#### Maneuvers subsystem

- **Maneuvers.py** (in `scripts/gp50/`): Orchestrator that loads Datetime/ts/Maneuver_type channel data via `get_channel_values`, then calls each maneuver module in sequence: tacks, gybes, roundups, bearaways, takeoffs, prestart, update_loss. Each submodule detects its maneuver type, computes entry/exit (often using `race_utils` such as `IdentifyEntryExit`), and posts events to the dataset-events API.
- **maneuvers/** (under `scripts/gp50/`):  
  - **tacks.py**, **gybes.py**: Tack and gybe detection and event creation.  
  - **roundups.py**, **bearaways.py**, **takeoffs.py**: Roundup, bearaway, and takeoff detection.  
  - **prestart.py**: Prestart phase detection and events.  
  - **update_loss.py**: Loss/VMG delta computation per maneuver and update of event tags (often used with 4_cleanup for day-scoped VMG baselines).

#### Maintenance scripts

- **maintenance/Maneuvers_update.py**: Updates or backfills maneuver events (e.g. after schema or logic changes).  
- **maintenance/Performance_update.py**: Updates or backfills performance aggregates.

#### Data and API usage

- Scripts read timeseries via `u.get_channel_values()` (API-backed, optionally Influx); write events, aggregates, map data, and class objects via `u.post_api_data()` to admin/app endpoints (e.g. dataset events, classes/object).  
- Normalization and processing use fixed channel sets (e.g. Datetime, ts, Lat_dd, Lng_dd, Tws_kts, Hdg_deg, Twd_deg, Bsp_kts, Twa_deg, Vmg_kts, Foiling_state, Yaw_rate_dps, Race_number, Leg_number, etc.) and type hints (datetime, float, angle360, angle180) for correct parsing and storage.

**Key references:**  
`server_python/app/main.py`, `server_python/app/dependencies/auth.py`, `server_python/scripts/gp50/` (all numbered and maintenance scripts), `server_python/scripts/gp50/Maneuvers.py`, `server_python/scripts/gp50/maneuvers/`, `libs/utilities/` (especially `race_utils.py`, `api_utils.py`), `docs/python/python-service-overview.md`, `docs/python/API_DOCUMENTATION.md`.

---

### 3.6 Performance and Reliability

- **Streaming:** Exponential backoff reconnection, connection state tracking, batch Redis writes, 24h retention.
- **Backend:** API compression, database pool configuration, SSE memory leak prevention patterns.
- **Frontend:** Debounced filter effects (e.g. 200ms), signature-based change detection, infinite-loop bailout, chunked processing with setTimeout for large arrays; HuniDB prepared statement caching and metrics.

**Key references:**  
`docs/optimization/`, `docs/backend/API_COMPRESSION.md`, `docs/backend/DATABASE_POOL_CONFIGURATION.md`, `docs/backend/SSE_MEMORY_LEAK_PREVENTION.md`, `libs/huni_db/docs/performance/PERFORMANCE_GUIDE.md`.

---

### 3.7 Video Integration, Data Scope, and Custom Reports

This section covers video–data synchronization, the single-day/single-source through full-history usage model, management of targets and polars, and customized report types (daily notes, cheat sheets, race reports, prestart visualizations).

#### Video integration with data

- **Unified time and playback:** A single reference time (`selectedTime`) in `playbackStore` drives both chart playheads and video position. When the user scrubs the timeline or plays, the video player seeks to the corresponding moment; when the user seeks in the video, `selectedTime` is updated so maps and time-series stay in sync. Playback speed, play/pause, and “manual” vs “synced” time changes are centralized in the playback store.
- **Media windows:** Video is stored per source/date as “media windows” (start, end, file name, optional timezone). The Video component (`frontend/components/charts/Video.tsx`) loads the list of windows for the current context (dataset or fleet day), selects the active file based on `selectedTime`, and can transition between files when time crosses window boundaries. Multi-tile layouts (e.g. fleet day) show one video per source; each tile can use per-row `source_name` when in fleet mode.
- **Map + video:** `MapTimeSeries` can run in a “video-only” mode (`videoOnly` prop) that restricts the timeline to media windows and disables brushing; used on the explore/Video page. The map and time-series charts share the same `selectedTime`, so boat position and time-series are aligned with the video frame.
- **Video sync helper:** `VideoSyncHelper` allows users to align video to data by entering a “known time” (UTC or local/dataset timezone) and applying an offset. It supports “sync all sources” to propagate an offset to all media windows. The backend is the single source of truth for converting local datetime to UTC. Used on the Video Sync page and wherever video–data alignment is configured.
- **Upload and storage:** Video upload (UploadMedia, server_file/server_media, server_admin) associates media with project/source/date. Optional “video upload bypass” (e.g. `SKIP_VIDEO_FFMPEG`) stores only med_res; frontend can run in “med_res only” mode (`VITE_MEDIA_MED_RES_ONLY`) for a single-resolution playback experience.
- **Video menu visibility:** The sidebar fetches menu items from the API; when a “VIDEO” page is present, `hasVideoMenu` is set so that MapTimeSeries and related UIs show video controls. Fleet Video is multi-source only (day scope); single-source Video builder is used in dataset scope.

#### Data scope: single day single source → multi source single day → full history

The sidebar’s five modes define how the user moves from narrow to broad scope:

| Scope | Sidebar mode | Trigger | Use case |
|-------|--------------|--------|----------|
| **Single day, single source** | MODE 1: Dataset | `selectedDatasetId > 0` | One dataset = one date + one source. Explore/reports are dataset-scoped (e.g. dataset/explore, dataset/reports). |
| **Single day, multi source** | MODE 2: Day | `selectedDate` valid, `selectedDatasetId === 0` | One date, multiple sources (e.g. fleet day). Menus: day/explore, day/reports (e.g. FleetMap, FleetVideo, FleetTimeSeries, FleetPerformance, FleetManeuvers, Prestart, Race Summary, Training Summary). |
| **Single source, full history** | MODE 3: Project Source | `selectedSourceId > 0`, no dataset/date | One boat/source across all dates. Menus: project/source/explore, project/source/reports (e.g. Performance History, Maneuvers History, Cheat Sheet). |
| **Project level** | MODE 4: Project | No dataset, date, or source | Browsing at project level; project/all explore and reports. |
| **Full history, all sources** | MODE 5: Project All | `selectedSourceId === 0`, no dataset/date | All boats, all time. Menus: project/all/explore, project/all/reports (e.g. Fleet Performance History, Fleet Maneuvers History, Fleet Cheat Sheet). |

Filter and API usage follow this scope: dataset-level uses `filters_dataset`; day-level uses `filters_day` (with `source_name`); fleet/project uses `filters_fleet` or `filter_source` / `filter_fleet`. The unified data store and services (e.g. performanceDataService, maneuversDataService) request data for the current context (dataset vs day vs project/source vs project/all) so that charts and reports show the correct single-day single-source, multi-source single-day, or full-history data.

#### Targets and polars

- **Targets:** The Targets tool (`frontend/reports/gp50/tools/Targets.tsx`) uses `TargetScatter` and `TargetTable` to compare boat performance against configurable target curves (e.g. red/green/blue target names stored in localStorage). Data is fetched by project/source; users select TWS/BSP (or other) axes and assign targets to series for scatter and table views. Target definitions can be managed via DayInfo or configuration (e.g. `parseTargetFilename`).
- **Polars:** The Polars tool (`frontend/reports/gp50/tools/Polars.tsx`) uses `PolarPlot` to display polar data (BSP or VMG vs TWA). Users can select TWS band, choose among multiple polars (red/green/blue), toggle display mode (BSP/VMG), and in some flows save or “save as” polar configurations. Data is project/source-scoped; polars are used for performance comparison and tuning.

#### Customized reports: daily notes, cheat sheets, race reports, prestart

- **Daily notes and day info:** DayInfo (`frontend/reports/gp50/DayInfo.tsx`) is the class-specific “day info” page (e.g. for a fleet day). It provides rich-text fields for summary, daily notes, technique notes, winning notes, and day-type notes (Quill + DOMPurify). It also supports dataset metadata (event name, description, timezone, TWS/TWD, shared flag, mast/foils/rudder), target selection, and links to process/SSE for running scripts. Used by admin/publisher for editing day-level notes and metadata that feed into daily summaries and context.
- **Cheat sheet summaries:**  
  - **Fleet Cheat Sheet** (`FleetCheatSheet.tsx`, project/all): Straight-line and maneuver cheat sheets across selected sources. Straight-line: group by Channel (one row per CONFIG per wind band) or by Wind (columns per wind bin); TWS and metric (BSP, TWA, VMG, heel, pitch, etc.) and point of sail selectors; API `cheat-sheet`. Maneuvers: group by Channel/Wind, TWS, maneuver type; API `maneuver-cheat-sheet`. Users can select/deselect sources and copy tables (with optional deltas).  
  - **Cheat Sheet** (project/source): Same concept for a single source across time (source-scoped cheat sheet).
- **Race reports:**  
  - **Race Summary** (`day/reports/RaceSummary.tsx`): Per-day, multi-source race summary. Fetches race-day-results, race-summary, and race-setup table data; supports “All” or a specific race; shows position, source name, race columns, averages, totals; optional “show deltas” and copy-to-clipboard. Uses `getRaceSummary_TableData` and related backend endpoints.  
  - **Training Summary** (`day/reports/TrainingSummary.tsx`): Day-level training summary with race-day-results and race-summary-style rows (position, source_name, VMG/polar/foiling/maneuver metrics). Filter by selected sources; TEAM cell styled by source color.
- **Prestart visualizations:** The Prestart report (`day/reports/Prestart.tsx`) combines:  
  - **PrestartReportMap:** Map view of prestart phase (marks, boat tracks, prestart-specific overlay).  
  - **PrestartChart:** Time-series of prestart-relevant channels (e.g. TTK, BSP, polar_perc, TWA, accel, heel, RH, and optional detail channels).  
  - Table view: API views `prestart | acceleration | maxbsp | reach | leg1` with configurable columns.  
  View options: PRESTART, ACCELERATION, MAX BSP, REACH, LEG 1. Prestart data and time-series chart sets are driven by Python/backend (e.g. prestart maneuver detection and addTimeSeriesData). Used for prestart analysis on a fleet day.

Other report types (e.g. Maneuvers, Performance, Events) are available at dataset, day, or project scope depending on the menu; all follow the same data-scope rules and filter/store integration above.

**Key references:**  
`frontend/store/playbackStore.ts`, `frontend/components/charts/Video.tsx`, `frontend/components/charts/map/MapTimeSeries.tsx`, `frontend/components/utilities/VideoSyncHelper.tsx`, `frontend/services/mediaFilesService.ts`, `frontend/services/mediaAvailabilityService.ts`, `docs/frontend/sidebar-menu-logic.md`, `frontend/components/dashboard/Sidebar.tsx`, `frontend/reports/gp50/tools/Targets.tsx`, `frontend/reports/gp50/tools/Polars.tsx`, `frontend/reports/gp50/DayInfo.tsx`, `frontend/reports/gp50/project/all/reports/FleetCheatSheet.tsx`, `frontend/reports/gp50/project/source/reports/CheatSheet.tsx`, `frontend/reports/gp50/day/reports/RaceSummary.tsx`, `frontend/reports/gp50/day/reports/TrainingSummary.tsx`, `frontend/reports/gp50/day/reports/Prestart.tsx`, `docs/backend/VIDEO_UPLOAD_BYPASS_AND_MED_RES_ONLY.md`, `server_app/controllers/data.js` (getRaceSummary_TableData, getCheatSheet_TableData, maneuver-cheat-sheet).

---

## 4. Codebase Structure (Summary)

| Area | Location | Notes |
|------|----------|--------|
| Frontend | `frontend/` | SolidJS, Vite; pages, components, store, services, workers |
| Shared | `shared/` | Auth and DB helpers used by servers |
| Server App | `server_app/` | Main application API |
| Server Admin | `server_admin/` | Admin API, events, users, projects |
| Server File/Media | `server_file/`, `server_media/` | File upload and media serving |
| Streaming | `server_stream/` | WebSocket/InfluxDB ingestion, processor, Redis, client WS |
| Python | `server_python/` | FastAPI app and GP50 (and class-specific) scripts |
| Libraries | `libs/huni_db/`, `libs/utilities/` | HuniDB (TS), sailing/race utilities (Python) |
| Docs | `docs/` | Architecture, backend, streaming, frontend, DB, system, optimization |
| Database schema | `database/` (and docs) | admin, ac75, gp50 schemas |

---

## 5. Key File and Module References

- **Unified data and caching:** `frontend/store/unifiedDataStore.ts`, `frontend/store/unifiedDataAPI.ts`, `docs/frontend/data-caching-policy.md`
- **Normalization:** `docs/architecture/DATA_NORMALIZATION_PATTERN.md`, `frontend/utils/dataNormalization.ts`
- **HuniDB schema/usage:** `frontend/store/huniDBSchema.ts`, `frontend/store/huniDBStore.ts`, `frontend/store/huniDBQueries.ts`, `libs/huni_db/`
- **Streaming processor:** `server_stream/controllers/processor.js`, `server_stream/controllers/redis.js`, `server_stream/controllers/websocket.js`
- **Events (admin):** `server_admin/controllers/events.js`
- **Race/maneuver logic:** `libs/utilities/utilities/race_utils.py`, `server_python/scripts/gp50/maneuvers/`, `server_python/scripts/gp50/0_maneuvers.py`, `server_python/scripts/gp50/Maneuvers.py`
- **Scatter/worker:** `frontend/components/charts/SimpleScatter.tsx`, `frontend/workers/enhanced-scatter-processor.ts`, `frontend/utils/enhancedScatterWorkerManager.ts`
- **Sync and cross-window:** `frontend/store/selectionStore.ts`, `frontend/store/filterStore.ts`, `scripts/build-syncstore.js`, dependency `@solidjs/sync` (github: thechadturner/syncstore)
- **Python service and scripts:** `server_python/app/main.py`, `server_python/app/dependencies/auth.py`, `server_python/scripts/gp50/` (0_init_class, 0_maneuvers, 0_race, 0_performance, 0_map, 1_normalization_influx, 1_normalization_csv, 2_processing, 2_process_and_execute, 3_execute, 4_cleanup, 5_markwind), `server_python/scripts/gp50/Maneuvers.py`, `server_python/scripts/gp50/maneuvers/` (tacks, gybes, roundups, bearaways, takeoffs, prestart, update_loss), `libs/utilities/` (race_utils, api_utils, math_utils, geo_utils, wind_utils, interp_utils)
- **Video, scope, and reports:** `frontend/store/playbackStore.ts`, `frontend/components/charts/Video.tsx`, `frontend/components/charts/map/MapTimeSeries.tsx`, `frontend/components/utilities/VideoSyncHelper.tsx`, `frontend/services/mediaFilesService.ts`, `frontend/reports/gp50/tools/Targets.tsx`, `frontend/reports/gp50/tools/Polars.tsx`, `frontend/reports/gp50/DayInfo.tsx`, `frontend/reports/gp50/day/reports/Prestart.tsx`, `frontend/reports/gp50/day/reports/RaceSummary.tsx`, `frontend/reports/gp50/day/reports/TrainingSummary.tsx`, `frontend/reports/gp50/project/all/reports/FleetCheatSheet.tsx`, `frontend/reports/gp50/project/source/reports/CheatSheet.tsx`, `docs/frontend/sidebar-menu-logic.md`

---

## 6. Third-Party vs Custom

- **Third-party (examples):** SolidJS, Vite, Express, FastAPI, Redis, PostgreSQL, InfluxDB client, Mapbox, D3, uPlot, Apache Arrow, bcrypt, JWT, etc. See `package.json` and Python requirements.
- **Custom / internal:** HuniDB library, SyncStore integration and build script, unified data store and caching policy, streaming state machine and computed channels, all sailing/race/event logic in `libs/utilities` and `server_python/scripts`, event sync/diff and tag update logic in `server_admin/controllers/events.js`, SimpleScatter density and regression pipeline, multi-window hub and filter/selection sync, data normalization and class-driven schema usage, and the overall multi-service and class-based architecture described above.

---

## 7. Recommendations for Maintaining This Document

1. **Update on major changes:** When adding new domains (e.g. new sailing class), new computed channels, or new client-side persistence patterns, add a short entry to the relevant section and refresh “Last Updated”.
2. **Keep references accurate:** When moving or renaming key files (e.g. events controller, processor, unifiedDataStore), update Section 5 and Section 4.
3. **Contract handover:** At contract start, provide this document plus links to `docs/README.md` and the main architecture docs so existing IP is clearly scoped before new work is contracted.

---

*This document describes pre-existing intellectual property in the RACESIGHT application as of the date above. It is not an exhaustive list of every file or feature but is intended to capture the main ideas, designs, and functionality that form the bedrock IP of the system.*
