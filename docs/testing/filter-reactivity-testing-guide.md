# Filter Reactivity Testing Guide

## Overview
This guide provides step-by-step instructions for testing the optimized filter reactivity system across different window configurations.

## Prerequisites
1. Ensure all servers are running (app, admin, file, media)
2. Have a project with datasets loaded
3. Open browser DevTools console for debugging

## Test Scenarios

### Scenario 1: Split Window (Same Browser Tab)
**Goal**: Verify filters sync between main dashboard and split view

1. **Setup**
   - Open main dashboard
   - Navigate to a dataset
   - Click any chart to open it in split view

2. **Test Filter Application from Main Dashboard**
   - In main dashboard sidebar, apply a TWA filter (e.g., "Upwind")
   - **Expected**: Split view chart updates within 200ms
   - **Verify**: Console shows "Filter state changed, redrawing chart" ONCE per chart

3. **Test Filter Application from Split View**
   - In split view, change a filter
   - **Expected**: Main dashboard updates
   - **Verify**: Both views show the same filtered data

4. **Debug Commands**
   ```javascript
   // In console, run:
   window.debugFilters()
   // Should show same filter state in both main and split views
   ```

### Scenario 2: Separate Browser Window (Same Browser)
**Goal**: Verify filters sync across separate windows via Sidebar hub

1. **Setup**
   - Open main dashboard
   - Right-click a chart menu item → "Open in new window"
   - Position windows side-by-side

2. **Test Filter Application from Main Window**
   - In main dashboard, apply TWA filter "Downwind"
   - **Expected**: Child window updates within 200ms
   - **Verify**: Watch DevTools in child window for message receipt

3. **Test Filter Application from Child Window**
   - In child window console: 
   ```javascript
   // Watch for messages
   window.addEventListener('message', (e) => {
     if (e.data.type === 'FILTER_STORE_UPDATE') {
       console.log('✅ Received filter update:', e.data.payload);
     }
   });
   ```
   - Apply filter in child window
   - **Expected**: Main dashboard receives update and redistributes to all windows
   - **Verify**: Console in main window shows "📢 Sidebar: Received filter update from child"

4. **Test Initialization Sync**
   - With filters already applied in main window
   - Open NEW child window
   - **Expected**: New window immediately requests and receives current filter state
   - **Verify**: In new window console:
   ```javascript
   // Should see:
   // "🪟 Window: Requesting current filter state from parent"
   // "🪟 Window: Dispatching filterStoreUpdate event"
   ```

### Scenario 3: Multiple Child Windows
**Goal**: Verify Sidebar hub broadcasts to all windows

1. **Setup**
   - Open main dashboard
   - Open 3 separate child windows with different charts

2. **Test Broadcast to All**
   - Apply filter in main dashboard
   - **Expected**: All 3 child windows update simultaneously
   - **Verify**: Each window logs filter update reception

3. **Test Child-to-Child via Hub**
   - Apply filter in Child Window 1
   - **Expected**: 
     - Main dashboard receives message
     - Main dashboard broadcasts to Child Window 2 and Child Window 3
     - Child Window 1 also receives confirmation
   - **Verify**: All windows show same filter state via `window.debugFilters()`

### Scenario 4: No Duplicate Redraws
**Goal**: Ensure charts redraw exactly once per filter change

1. **Setup**
   - Open any chart (TimeSeries, PerfScatter, SimpleScatter, etc.)
   - Open DevTools console

2. **Apply Filter**
   - Select any filter
   - **Expected**: Console shows filter effect trigger ONCE:
   ```
   🔍 [ComponentName]: Filter state changed, redrawing chart... { effectCount: 1 }
   ```
   - **Fail Condition**: If `effectCount` exceeds 50, infinite loop detected

3. **Apply Multiple Filters Quickly**
   - Click "Upwind", then immediately "Port"
   - **Expected**: Debouncing coalesces updates into single redraw
   - **Verify**: Only one "redrawing chart" log after 200ms

### Scenario 5: Filter Persistence
**Goal**: Verify filters persist across page refreshes

1. **Setup**
   - Apply multiple filters (TWA states, race, leg, grade)
   - Note current state via `window.debugFilters()`

2. **Test Refresh**
   - Refresh the page (F5)
   - **Expected**: Filters restore from localStorage
   - **Verify**: `window.debugFilters()` shows same state

3. **Test New Child Window**
   - With filters active, open new child window
   - **Expected**: Child window requests state from parent (not localStorage)
   - **Verify**: Child receives fresh state via postMessage

## Performance Benchmarks

### Expected Timings
- **Filter application**: <100ms for data processing
- **UI update**: <200ms for chart redraw (debounced)
- **Cross-window sync**: <50ms message propagation
- **Total end-to-end**: <300ms from filter click to all windows updated

### Measure Performance
```javascript
// In console:
performance.mark('filter-start');

// Apply filter, then after update:
performance.mark('filter-end');
performance.measure('filter-update', 'filter-start', 'filter-end');
console.log(performance.getEntriesByType('measure'));
```

## Debugging Tools

### Check Filter State
```javascript
// Current filter state and sync status
window.debugFilters()

// Expected output:
{
  selectedStates: ['upwind', 'downwind'],
  selectedRaces: ['1', '2'],
  selectedLegs: [],
  selectedGrades: [],
  hasActiveFilters: true,
  formattedFilters: ['Upwind', 'Downwind', 'Race 1', 'Race 2'],
  pendingBroadcast: false,
  dirtyKeys: [],
  isUpdatingFromCrossWindow: false
}
```

### Monitor Filter Updates
```javascript
// In child window console:
window.addEventListener('filterStoreUpdate', (e) => {
  console.log('🔄 CustomEvent received:', e.detail);
});

window.addEventListener('message', (e) => {
  if (e.data.type === 'FILTER_STORE_UPDATE') {
    console.log('📨 PostMessage received:', e.data.payload);
  }
});
```

### Check Sidebar Hub
```javascript
// In main dashboard console:
window.addEventListener('message', (e) => {
  if (e.data.type === 'FILTER_UPDATE_FROM_CHILD') {
    console.log('📬 Hub received from child:', e.data.windowName);
  }
});
```

### Detect Infinite Loops
- Watch for console errors: `🚨 INFINITE LOOP DETECTED in [Component] filter effect!`
- If detected, effect automatically bails out after 50 iterations
- This indicates a bug in filter signal reactivity

## Common Issues & Solutions

### Issue: Child window doesn't receive initial filters
**Cause**: Parent not responding to REQUEST_FILTER_STATE
**Solution**: Check Sidebar message handler includes REQUEST_FILTER_STATE case
**Verify**: In child console, should see "🪟 Window: Requesting current filter state"

### Issue: Filters applied multiple times
**Cause**: Missing signature check or debounce
**Solution**: Verify component uses batched filter effect pattern
**Verify**: Console should show effectCount=1 (not incrementing)

### Issue: Filters don't sync to sibling windows
**Cause**: Sidebar hub not broadcasting to sender
**Solution**: Ensure Sidebar broadcasts to ALL windows, not filtering out sender
**Verify**: Apply filter in child, check it receives confirmation message

### Issue: Race condition on page refresh
**Cause**: localStorage sync conflicts with postMessage
**Solution**: Child windows now prioritize REQUEST_FILTER_STATE over localStorage
**Verify**: New window should request state from parent, not just read localStorage

## Test Checklist

- [ ] Split view receives filters from main dashboard
- [ ] Split view sends filters to main dashboard
- [ ] Separate child window receives filters from main
- [ ] Separate child window sends filters to main
- [ ] Multiple child windows all update simultaneously
- [ ] Child-to-child updates route through hub
- [ ] New child window requests initial state
- [ ] Filters persist across refresh (localStorage)
- [ ] Charts redraw exactly once per filter change
- [ ] No infinite loops (effectCount stays low)
- [ ] Debouncing works (200ms delay observable)
- [ ] Performance <300ms end-to-end
- [ ] `window.debugFilters()` shows consistent state across windows

## Success Criteria

✅ All test scenarios pass
✅ No console errors or warnings
✅ Performance within benchmarks
✅ No duplicate redraws observed
✅ Filters sync reliably across all window types
✅ Debug tools provide useful information

## Reporting Issues

If tests fail, include:
1. Browser and version
2. Test scenario number
3. Console logs from all windows
4. Output from `window.debugFilters()` in each window
5. Timeline of actions taken
6. Expected vs actual behavior

