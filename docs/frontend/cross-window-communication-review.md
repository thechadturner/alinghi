# Cross-Window Communication Review

## Summary
This document reviews the cross-window communication implementation and identifies key lessons learned from fixing the ManeuverWindow synchronization issues.

## Key Issues Fixed in ManeuverWindow

### 1. Window Registration
**Problem:** `instanceof Window` check fails across different window contexts.

**Solution:** Check for `postMessage` function instead:
```typescript
if (event.source && typeof (event.source as any).postMessage === 'function') {
  // Valid window
}
```

**Why:** Cross-window contexts can have different prototype chains, making `instanceof` unreliable.

### 2. Window Name Timing
**Problem:** Window name not set early enough, causing messages to arrive before name is available.

**Solution:** Set window name at the very start of `onMount`, before any communication:
```typescript
onMount(async () => {
  // Set window name FIRST, before any handlers or communication
  if (!window.name) {
    window.name = `window-${Date.now()}`;
  }
  // ... rest of setup
});
```

### 3. Document Hidden Checks
**Problem:** `!document.hidden` checks prevent background windows from receiving updates.

**Solution:** Remove `document.hidden` checks from message handlers. Process updates even when hidden:
```typescript
// ❌ BAD: Blocks background windows
if (!document.hidden) {
  window.dispatchEvent(new CustomEvent('globalStoreUpdate', { detail: payload }));
}

// ✅ GOOD: Process regardless of visibility
window.dispatchEvent(new CustomEvent('globalStoreUpdate', { detail: payload }));
```

**Why:** Windows need to receive updates even when in background so they're ready when user switches to them.

### 4. Timestamp-Based Sync
**Problem:** Payload hash comparison can miss legitimate updates with same values.

**Solution:** Use timestamp-based sync with `_crossWindowSync` flag:
```typescript
// In sender:
const payload = {
  ...data,
  _crossWindowSync: true,
  _timestamp: Date.now(),
  _sourceWindow: window.name
};

// In receiver (globalStore):
if (payload._crossWindowSync && payload._timestamp) {
  if (sentEventTimestamps.has(payload._timestamp)) {
    // We sent this, ignore
    return;
  }
  // Process cross-window sync from other windows
}
```

**Why:** Timestamps uniquely identify events and prevent duplicate processing while ensuring all cross-window updates are processed.

### 5. State Request Tracking
**Problem:** Query parameters or defaults override synced values from parent.

**Solution:** Track which values were synced from parent and don't override them:
```typescript
let colorSyncedFromParent = false;
let eventTypeSyncedFromParent = false;
let phaseSyncedFromParent = false;

// After receiving state from parent:
if (colorAfterSync !== colorBeforeSync) {
  colorSyncedFromParent = true;
}

// When applying query params or defaults:
if (!colorSyncedFromParent) {
  // Only apply default if not synced from parent
  setColor(defaultColor);
}
```

### 6. BroadcastChannel Fallback
**Problem:** Windows that lose `window.opener` (e.g., moved tabs) can't receive updates.

**Solution:** Use BroadcastChannel as fallback:
```typescript
const broadcastChannel = new BroadcastChannel('global-store-updates');
broadcastChannel.onmessage = (event) => {
  if (event.data.type === 'GLOBAL_STORE_UPDATE' && event.data.sourceWindow !== window.name) {
    window.dispatchEvent(new CustomEvent('globalStoreUpdate', { detail: event.data.payload }));
  }
};
```

## Communication Flow

### Initial State Sync
1. Child window opens and sets `window.name` early
2. Child sends `WINDOW_READY` to parent
3. Parent registers child window (using `postMessage` check)
4. Child requests state: `REQUEST_GLOBAL_STATE`, `REQUEST_SELECTION_STATE`, `REQUEST_FILTER_STATE`
5. Parent responds with current state
6. Child processes responses and tracks synced values
7. Child applies query params/defaults only for non-synced values

### Ongoing Updates
1. Main window changes state (e.g., color, selection)
2. `globalStore` dispatches `globalStoreUpdate` CustomEvent
3. `Sidebar` catches event and broadcasts to all registered child windows
4. Child windows receive `GLOBAL_STORE_UPDATE` message
5. Child windows dispatch `globalStoreUpdate` CustomEvent locally
6. `globalStore` in child window processes update (using timestamp to avoid loops)

## Bulletproof Checklist

- [x] Window name set early in `onMount`
- [x] Window registration uses `postMessage` check, not `instanceof`
- [x] No `document.hidden` checks blocking message processing
- [x] Timestamp-based sync with `_crossWindowSync` flag
- [x] State request tracking to prevent override
- [x] BroadcastChannel fallback for moved windows
- [x] Origin verification for security
- [x] Error handling for closed windows
- [x] Cleanup of event listeners

## Lessons for Window Component

The `Window.tsx` component should apply all the same fixes:
1. Set window name early
2. Remove `document.hidden` checks
3. Use timestamp-based sync
4. Add BroadcastChannel fallback
5. Track synced state to prevent override
