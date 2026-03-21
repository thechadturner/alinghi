# Persistence & Selection Store Review - Post Nginx Refactoring

## Overview
This document reviews the persistence mechanisms (selectionStore, persistentStore, and API settings) to identify potential issues after the nginx refactoring.

## Architecture Summary

### 1. Selection Store (`frontend/store/selectionStore.ts`)
- **Storage Mechanism**: Uses `createSyncSignal` from `@solidjs/sync` with `autoSync: true`
- **Backend**: IndexedDB/localStorage (via syncstore package)
- **Cross-window**: Uses `window.postMessage` and custom events
- **Persistence Keys**: 
  - `selection`, `cutEvents`, `selectedRange`, `selectedRanges`, `selectedEvents`
  - `hasSelection`, `isCut`, `isSelectionLoading`, `allowTimeWindow`
  - `triggerUpdate`, `triggerSelection`

### 2. Persistent Store (`frontend/store/persistantStore.ts`)
- **Storage Mechanism**: Dual-layer
  - **Local**: `localStorage` via `createPersistentSignal`
  - **Remote**: API via `/api/users/settings` endpoint
- **Sync Strategy**: 
  - Local changes → localStorage immediately
  - API sync debounced (500ms) via `saveToAPI()`
  - API load on app initialization

### 3. API Settings Service (`frontend/services/persistentSettingsService.ts`)
- **Endpoint**: `/api/users/settings`
- **Methods**: GET (load), POST (save/upsert), PUT (update), DELETE
- **Nginx Route**: `/api/` → `proxy_pass http://node_app`

## Potential Issues Identified

### Issue 1: Race Condition Between API Load and Selection Restore
**Location**: `frontend/index.tsx` and `frontend/store/selectionStore.ts`

**Problem**: 
- `clearSelectionOnStartup()` runs before `initializeSelectionStore()`
- `createSyncSignal` with `autoSync: true` may restore from IndexedDB before API settings are loaded
- If API settings contain selection-related data, it could conflict

**Current Flow**:
```
1. clearSelectionOnStartup() - clears/resets selection
2. initializeSelectionStore() - creates sync signals (auto-restores from IndexedDB)
3. API settings load (async) - may contain conflicting state
```

**Recommendation**: 
- Ensure `clearSelectionOnStartup()` runs AFTER sync signals are initialized
- Or add a flag to prevent auto-restore until API settings are loaded

### Issue 2: Nginx Proxy Timeout for Settings API
**Location**: `docker/nginx/nginx-prod.conf` and `docker/nginx/nginx-dev.conf`

**Problem**:
- Settings API uses standard `/api/` route with 60s timeouts
- If API is slow or database is under load, requests might timeout
- No retry logic in `persistentSettingsService`

**Current Configuration**:
```nginx
proxy_connect_timeout 60s;
proxy_send_timeout 60s;
proxy_read_timeout 60s;
```

**Recommendation**:
- Add retry logic in `persistentSettingsService.loadSettings()`
- Consider longer timeout for settings endpoint (settings are not time-critical)
- Add fallback to localStorage if API fails

### Issue 3: Cross-Window Synchronization May Not Work Through Nginx
**Location**: `frontend/store/selectionStore.ts` and `frontend/store/persistantStore.ts`

**Problem**:
- Cross-window sync uses `window.postMessage` and `window.opener`
- This is browser-based and shouldn't be affected by nginx
- However, if windows are opened from different origins (e.g., different ports), sync will fail

**Current Implementation**:
```typescript
window.opener.postMessage({
  type: 'SELECTION_UPDATE_FROM_CHILD',
  payload: { ... },
  windowName: window.name
}, window.location.origin);
```

**Recommendation**:
- Verify `window.location.origin` is consistent across windows
- Add error handling for cross-window communication failures
- Consider using BroadcastChannel API as fallback

### Issue 4: clearSyncData May Not Fully Clear IndexedDB
**Location**: `frontend/store/selectionStore.ts` - `clearSelection()` function

**Problem**:
- `clearSyncData()` is called, but we don't know if it fully clears IndexedDB
- The syncstore package may cache data in memory
- If IndexedDB isn't fully cleared, data may restore on reload

**Current Implementation**:
```typescript
clearSyncData("selection");
clearSyncData("cutEvents");
// ... etc
```

**Recommendation**:
- Verify `clearSyncData()` implementation in syncstore
- Add manual IndexedDB cleanup if needed
- Test that cleared selections don't restore after reload

### Issue 5: Persistent Store API Sync May Fail Silently
**Location**: `frontend/store/persistantStore.ts` - `saveToAPI()` function

**Problem**:
- API save errors are logged but don't prevent localStorage updates
- If API fails, localStorage and API will be out of sync
- No retry mechanism

**Current Implementation**:
```typescript
try {
  await persistentSettingsService.saveSettings(...);
  debug('[PersistentStore] Settings saved to API:', settings);
} catch (error) {
  warn('[PersistentStore] Failed to save settings to API:', error);
}
```

**Recommendation**:
- Add retry logic with exponential backoff
- Queue failed saves and retry later
- Add sync status indicator in UI

### Issue 6: Selection Store Uses Both localStorage and IndexedDB
**Location**: `frontend/store/selectionStore.ts` - `clearSelectionOnStartup()`

**Problem**:
- `clearSelectionOnStartup()` checks `localStorage.getItem('cutEvents')`
- But `createSyncSignal` uses IndexedDB
- This mismatch could cause incorrect behavior

**Current Implementation**:
```typescript
const persistedCutEvents = localStorage.getItem('cutEvents');
```

**Recommendation**:
- Remove localStorage checks (syncstore handles persistence)
- Rely solely on syncstore's IndexedDB storage
- Or verify syncstore's storage backend

### Issue 7: Settings API Endpoint May Not Be Properly Routed
**Location**: `docker/nginx/nginx-prod.conf` and `server_app/routes/users.js`

**Problem**:
- Settings endpoint is `/api/users/settings`
- Nginx routes `/api/` to `node_app`
- Need to verify route is properly configured

**Current Nginx Config**:
```nginx
location /api/ {
    proxy_pass http://node_app;
    # ...
}
```

**Recommendation**:
- Verify `/api/users/settings` routes correctly
- Test GET, POST, PUT, DELETE methods
- Check CORS headers if needed

## Testing Checklist

### Selection Store
- [ ] Clear selection → reload page → verify selection stays cleared
- [ ] Make selection → reload page → verify selection restores
- [ ] Open multiple windows → make selection in one → verify syncs to others
- [ ] Clear selection in one window → verify clears in all windows
- [ ] Test with IndexedDB disabled (private browsing)

### Persistent Store
- [ ] Change setting → reload page → verify setting persists
- [ ] Change setting → check API → verify saved to database
- [ ] Load page → verify settings load from API
- [ ] Disable network → change setting → verify saves to localStorage
- [ ] Re-enable network → verify settings sync to API

### API Settings
- [ ] Test GET `/api/users/settings?user_id=X`
- [ ] Test POST `/api/users/settings` with valid payload
- [ ] Test PUT `/api/users/settings` with valid payload
- [ ] Test DELETE `/api/users/settings` with valid payload
- [ ] Test with invalid user_id → verify error handling
- [ ] Test with nginx timeout → verify fallback to localStorage

### Cross-Window Sync
- [ ] Open two windows from same origin → verify sync works
- [ ] Open windows from different origins → verify fails gracefully
- [ ] Test with windows opened via `window.open()` → verify sync works
- [ ] Test with windows opened via links → verify sync works

## Recommendations

### High Priority
1. **Fix race condition**: Ensure `clearSelectionOnStartup()` runs after sync signals initialize
2. **Add retry logic**: Implement retry for API settings save/load
3. **Remove localStorage checks**: Use syncstore's IndexedDB exclusively
4. **Add error handling**: Better error handling for cross-window sync failures

### Medium Priority
5. **Add sync status**: UI indicator for API sync status
6. **Increase timeout**: Longer timeout for settings API endpoint
7. **Add logging**: More detailed logging for persistence operations
8. **Test IndexedDB**: Verify syncstore properly uses IndexedDB

### Low Priority
9. **Consider BroadcastChannel**: Alternative to window.postMessage
10. **Add metrics**: Track persistence success/failure rates
11. **Add admin UI**: View/edit persistent settings in admin panel

## Files to Review/Modify

### Critical
- `frontend/store/selectionStore.ts` - Fix race condition, remove localStorage checks
- `frontend/index.tsx` - Fix initialization order
- `frontend/services/persistentSettingsService.ts` - Add retry logic

### Important
- `frontend/store/persistantStore.ts` - Improve error handling
- `docker/nginx/nginx-prod.conf` - Verify settings endpoint routing
- `server_app/routes/users.js` - Verify settings endpoint implementation

### Testing
- Create test cases for all scenarios above
- Add integration tests for persistence
- Test with nginx in dev and prod modes

