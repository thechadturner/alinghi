RaceSight Frontend Architecture (frontend/)

Overview
The frontend is a SolidJS application that manages authentication, routing, multi-window synchronization, and data visualization. **Dataset explore timeseries** and other channel-values loads use `unifiedDataStore` → file **channel-values API** (parquet/DuckDB on the file server), with **in-session in-memory caches** (`dataCache`, `queryCache`, etc.—see [Data Caching Policy](./data-caching-policy.md)). **HuniDB** is used for client-side **events**, **metadata** (datasets, sources, channel hints), **json/settings**, **targets**, and **density** writes—not for persisting raw explore timeseries rows.

Entry Points
- frontend/index.tsx: Bootstraps app, installs fetch interceptor and console gate, initializes selection and playback stores, performs auth handshake, renders <App />.
- frontend/App.tsx: Declares routes with @solidjs/router, mounts global UI (Header, UploadToast), initializes playback effects and registers cleanup for all stores (selectionStore, playbackStore, filterStore) via onCleanup hooks.

Routing
- Pages are mapped under <Router> with routes for auth (/login, /register, etc.), admin, project/data info pages, builders (performance, scatter, timeseries, probability, overlay, parallel, polar-rose, grid, table, video), uploads, events, dashboard, and a /window page for multi-window experiences.

State Management
- SolidJS signals drive UI state.
- Cross-window synchronization via createSyncSignal from the shared syncstore package keeps selection and playback state consistent across windows.
- Syncstore cleanup: All sync signals use onCleanup for automatic cleanup. clearSyncData() automatically triggers cleanup for registered signals. Stores provide register*StoreCleanup() functions to register cleanup in components.
- Global store (globalStore.ts) manages application-wide state like video menu availability.
- Persistent store (persistantStore.ts) maintains user selections across sessions.

Data Flow
- Services in frontend/services call backend APIs. Timeseries/channel-values responses are merged into **unifiedDataStore** in-memory caches; explore flow details and diagrams are in [Data Caching Policy](./data-caching-policy.md).
- The unified data store frontend/store/unifiedDataStore.ts provides read/query helpers that apply global filters and time windows. Overlay gauge data must be retrieved from the **channel-values API** (full channel set)—not from map-specific payloads—and is held in Overlay component state (passed to gauge children via props).

Sidebar Component
- Dynamic menu generation based on application context (dataset, day, project source, project level).
- Five distinct modes with different auto-selection behaviors and API endpoints.
- Reactive updates triggered by user selections and context changes.
- Video menu integration controls visibility of video elements in MapTimeSeries.
- Comprehensive error handling and fallback behavior for missing data.

Multi-Window Sync
- Hybrid synchronization strategy combines localStorage sync (createSyncSignal) with hub-based postMessage routing:
  
  **Filter Updates:**
  1. Child window: Filter change → setSelectedStates() → markDirtyAndBroadcast()
  2. Coalesced broadcast via queueMicrotask batches multiple changes
  3. Dispatches CustomEvent 'filterStoreUpdate' locally (same-window components react)
  4. Sends postMessage to parent opener (type: 'FILTER_UPDATE_FROM_CHILD')
  5. Sidebar hub receives and broadcasts to ALL child windows (type: 'FILTER_STORE_UPDATE')
  6. Window.tsx converts postMessage → CustomEvent 'filterStoreUpdate'
  7. filterStore listener updates signals via batch()
  
  **Selection Updates:**
  - Similar flow but uses 'SELECTION_UPDATE_FROM_CHILD' / 'SELECTION_STORE_UPDATE' message types
  - Handled by selectionStore with CustomEvent 'selectionStoreUpdate'
  
  **Initialization:**
  - Child windows request current state on mount via 'REQUEST_FILTER_STATE' / 'REQUEST_SELECTION_STATE'
  - Parent responds with current signal values
  
  **Synchronization Mechanisms:**
  - createSyncSignal autoSync: localStorage for same-browser tab sync
  - CustomEvent: Same-window component reactivity
  - postMessage via Sidebar hub: Cross-window and cross-browser-window sync
  
- Guard flags (e.g., isUpdatingFromCrossWindow) prevent echo loops during cross-window updates.

Performance
- Large arrays are processed in chunks with setTimeout yielding to keep the UI responsive.
- Indexed and cached lookups by timestamp enable fast range queries.
- Chart components use batched filter effects with debouncing (200ms standard) to prevent multiple redraws:
  - Single createEffect tracks all filter signals (states, races, legs, grades)
  - Signature-based change detection prevents unnecessary updates
  - Infinite loop detection (>50 calls) with automatic bailout
  - Consistent 200ms debounce across all components

Health
- Console logging is centralized via frontend/utils/console to respect VITE_VERBOSE and provide structured API/debug logs.
- Debug helpers: window.debugFilters() provides real-time filter state inspection

