Frontend Developer Guide

Auth and Session
- Auth handshake runs on app start (frontend/index.tsx). If tokens exist, it calls authManager.getCurrentUser and then GET /api/users/subscription.
- On failure, tokens are cleared and user state reset.

CSRF and Fetch Interceptor
- frontend/utils/fetchInterceptor ensures CSRF tokens are attached to mutating requests.
- Use getData/postData helpers from frontend/utils/global.

Console and Logging
- Use frontend/utils/console console_logger functions for messages, errors, warnings, API logs. Honors VITE_VERBOSE.

Data Field Case Sensitivity (Critical)
- API data fields are lowercase. In charts, always convert config axis names to lowercase to access data.
- Preserve original case for display (labels, tooltips).

Multi-Window Patterns
- Use selectionStore/playbackStore createSyncSignal for cross-window state sync.
- Avoid infinite loops by guarding broadcasts with isUpdatingFromCrossWindow and similar flags.

IndexedDB Usage
- Prefer unifiedDataStore/queryDataByChannels for data access; it handles cache, filters, time ranges, missing channel fetching.

Cleanup
- Use onCleanup to remove D3 selections, event listeners, and store effects in components that set them up.
- Store cleanup: All stores (selectionStore, playbackStore, filterStore) provide register*StoreCleanup() functions that should be called in App.jsx or root components. These register automatic cleanup via onCleanup hooks.
- Syncstore cleanup: clearSyncData() automatically triggers cleanup for registered signals. No manual cleanup needed for sync signals - they clean up automatically when components unmount.

Performance and Fleet Performance History
- Filter and onMount logic are aligned between Performance History and Fleet Performance History. Session restores all five filters; event/year are pre-filled from the dataset selection only when the filter is empty and the selection is not ALL. See [performance-history-fleet-alignment.md](./performance-history-fleet-alignment.md).

Timezone in API responses
- Performance and fleet-performance data API responses include a `timezone` field per row (dataset timezone). Use it to convert UTC timestamps to local time for display (e.g. `formatDateTime(ts, row.timezone)` in `frontend/utils/global.ts`).

Testing and Cursor Files
- Place any AI-generated or dev-only scripts under frontend/cursor_files/ as per repository rules.

