Frontend Stores and Cross-Window Sync

Filter Store (frontend/store/filterStore.ts)
- Purpose: Centralized filter state management with cross-window synchronization.
- Signals: selectedStates[], selectedRaces[], selectedLegs[], selectedGrades[], raceOptions[], legOptions[], gradeOptions[], selectedHeadsailCodes[], selectedMainsailCodes[], headsailCodeOptions[], mainsailCodeOptions[].
- Filter Criteria: States (Upwind/Downwind/Reaching), Races, Legs, Grades, Sail Codes
- Filter Options: Available values for each filter type
- Cross-window: Uses hybrid approach:
  1. createSyncSignal with autoSync for same-browser tab sync (localStorage)
  2. CustomEvent 'filterStoreUpdate' for same-window component reactivity
  3. postMessage to parent opener (type: 'FILTER_UPDATE_FROM_CHILD') for cross-window sync
  4. Sidebar hub redistributes to all child windows (type: 'FILTER_STORE_UPDATE')
- Coalesced broadcasts: Batches multiple filter changes via queueMicrotask and dirty key tracking
- Guard: isUpdatingFromCrossWindow prevents echo loops
- Debugging: getFilterDebugInfo() exposes current state, accessible via window.debugFilters()
- Cleanup: registerFilterStoreCleanup() registers automatic cleanup via onCleanup. disposeFilterStore() removes event listeners and clears synced keys (clearSyncData now automatically triggers cleanup for registered signals).

Selection Store (frontend/store/selectionStore.ts)
- Purpose: Manage selection lifecycle (active selection, cut selection, ranges) and synchronize across windows.
- Signals: isSelectionLoading, hasSelection, isCut, selection[], cutEvents[], selectedRange[], selectedRanges[], selectedEvents[], triggerUpdate, triggerSelection, allowTimeWindow.
- Semantics:
  - selectedRange[]: Single brush range (timeline interactions). Set on brush; cleared on brush clear. Not used for map overlays.
  - selectedRanges[]: Union of event-based ranges (and future multi-brush). Populated from selectedEvents via cached event start/end times. Drives filtering for charts; drives map overlay colors (base track remains full dataset).
  - selectedEvents[]: Event selections (ids or event objects); used to derive selectedRanges[].
- Cross-window: Uses CustomEvent 'selectionStoreUpdate' for local updates and postMessage to parent opener (type: 'SELECTION_UPDATE_FROM_CHILD') for cross-window sync. Payloads include selectedRange and selectedRanges.
- Filter signals: Re-exports filter signals from filterStore for backward compatibility.
- Lifecycle & clearing logic:
  - Event selection: setSelectedEvents(...) → fetch time ranges from HuniDB cache → setSelectedRanges(ranges) → setSelectedRange([]).
  - Brush selection: setSelectedRange([range]) clears selectedRanges and selectedEvents.
  - Clear actions: clearSelection(), clearActiveSelection(), clearAllData(), clearSelectionOnStartup() clear both selectedRange and selectedRanges and synchronize across windows.
  - Cut: cutSelection() stores the current selectedRanges as cutEvents and clears active selection signals.
- Performance optimizations:
  - Event time ranges are fetched from HuniDB cache (fast indexed queries) - no API calls needed.
  - No data reprocessing: Map components use selectedRanges to filter data on-the-fly during rendering.
  - No persistence overhead: Event_id assignments are not persisted to HuniDB on selection changes (ContinuousTrackRenderer filters by time ranges dynamically).
  - Events are loaded once when dataset is accessed, not on every selection change.
- Cleanup: registerSelectionStoreCleanup() registers automatic cleanup via onCleanup. disposeSelectionStore() removes event listeners and clears synced keys (clearSyncData now automatically triggers cleanup for registered signals).

Playback Store (frontend/store/playbackStore.ts)
- Purpose: Control time playback across components and windows with priority arbitration.
- Signals: showPlayback, selectedTime (Date with conversion from string), isPlaying (throttled), playbackSpeed, timeWindow, videoTime, playbackInterval (local only), isManualTimeChange, shouldRestartPlayback, activeComponent.
- Priority: COMPONENT_PRIORITIES defines which component controls time (timeseries/map > playback). requestTimeControl/releaseTimeControl/forceReleaseTimeControl manage control.
- Interval: startPlaybackInterval/clearPlaybackInterval handle periodic time updates; uses detected data interval (fallback 500ms). Pauses on manual changes.
- Effects: initializeSelectionEffect hides playback and zeroes timeWindow on selection presence; initializeManualTimeChangeEffect pauses on manual changes; initializeIsPlayingFollowEffect mirrors interval with isPlaying.
- Cleanup: registerPlaybackStoreCleanup() registers automatic cleanup via onCleanup. disposePlaybackStore() stops intervals and clears synced keys (clearSyncData now automatically triggers cleanup for registered signals).

Unified Data Store (frontend/store/unifiedDataStore.ts)
- Purpose: Unified interface to fetch, filter, and query datasets (timeseries, mapdata, aggregates). HuniDB is used only for events and metadata, not for timeseries/map/aggregate data.
- Architecture: Two-layer for data (in-memory cache → API). HuniDB used for events, channel names, sources, and settings only.
- Sources: CHART_SOURCE_MAPPING maps chart types to data sources: mapdata, timeseries, aggregates, objects.
- API integration: unifiedDataAPI.getDataByChannels for data; storeDataInIndexedDB is a no-op for timeseries/map/aggregates.
- Cache Validation: CRITICAL - Always validates in-memory cache contains ALL requested channels before using (prevents incomplete data).
- getDataWithTimeRange: Uses in-memory data; no HuniDB data cache.
- Filters: Global filters applied at query layer using filterStore (states, races, legs, grades, timeRange).
  - Imports filter signals reactively from filterStore: selectedStates(), selectedRaces(), selectedLegs(), selectedGrades()
  - Diagnostic logging available when VITE_VERBOSE=true for debugging filter application
- Overlay / FleetDataTable: **Overlay** and **FleetDataTable** **must retrieve data from the API (timeseries) only**—not from map cache—so the full channel set (e.g. `Twa_n_deg`) is available. Overlay fetches once from the API, holds data in local state (`overlayData`), and passes the current row (`dataRow`) and optionally full timeseries (`timeseriesData`) to gauge children (TextBox, Donut, Sparkline, etc.). FleetDataTable always fetches its channels from the API per source and does not use map cache for loading. No HuniDB and no shared overlay cache; timestamps stay consistent and gauges update when `selectedTime` changes.
- Maintenance: resetDataStore, clearCache, clearAllData, getStorageInfo.
- Documentation: See `docs/frontend/unifiedDataStore-guide.md` for comprehensive guide, tips, and common pitfalls.

User Store (frontend/store/userStore.ts)
- Signals: isLoggedIn, user, subscription, isAccepted, isCookiePolicy.
- Populated during auth handshake in frontend/index.tsx; subscription fetched via /api/users/subscription.

Global Store (frontend/store/globalStore.ts)
- Purpose: Global application state shared across components.
- Signals: hasVideoMenu, setHasVideoMenu.
- Video Menu Control: Controls visibility of video elements in MapTimeSeries component based on sidebar menu availability.
- Integration: Set by Sidebar component when building explore menus, consumed by MapTimeSeries for conditional rendering.

