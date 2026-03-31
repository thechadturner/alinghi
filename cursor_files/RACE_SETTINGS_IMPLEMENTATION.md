# Race Settings Implementation Summary

## Overview
Created a new `RaceSettings` modal component for managing source visibility in Race Summary and Prestart pages. The component links to the same global `selectedSources` from `filterStore` that FleetMap uses, ensuring consistent source filtering across all race-related pages.

## Files Created

### 1. `frontend/components/menus/RaceSettings.tsx`
- **Purpose**: Modal component for managing data source visibility
- **Key Features**:
  - Shows only the "Data Sources" section (no other filters)
  - Links to global `selectedSources` from `filterStore`
  - Deferred updates (changes only applied when "Apply" button is clicked)
  - Select All / None buttons for quick selection
  - Source colors from `sourcesStore` for visual consistency
  - Saves to persistent settings API (same as PageSettings)
  - Info text explaining that settings are shared with Fleet Map

## Files Modified

### 2. `frontend/reports/ac40/day/reports/RaceSummary.tsx`
- **Changes**:
  - Added import for `RaceSettings` component
  - Added settings icon in the upper left of the page header
  - Restructured header layout with flexbox to accommodate settings icon
  - Settings icon appears before the "Race Summary" title with proper spacing (1rem gap)

### 3. `frontend/reports/ac40/day/reports/Prestart.tsx`
- **Changes**:
  - Added import for `RaceSettings` component
  - Added settings icon to the left of the existing dropdown buttons
  - Settings icon appears in the `prestart-controls` section with proper spacing (0.5rem gap)

## Architecture & Integration

### Global Source Filtering
The implementation leverages the existing `filterStore` architecture:

```typescript
// filterStore.ts exports:
export const selectedSources = (): string[]
export const setSelectedSources = (value: string[]) => void
```

### Data Flow
1. **RaceSettings Modal**:
   - Reads current selections from `filterStore.selectedSources()`
   - User makes changes in local state
   - On "Apply", updates global `filterStore.selectedSources()`
   - Saves to persistent settings API

2. **RaceSummary & Prestart Pages**:
   - Already use `filterStoreSelectedSources()` to filter data
   - Automatically react to changes in `filterStore.selectedSources()`
   - Filter rows in:
     - `fetchRaceDayResults()` - Race Summary "All" view
     - `fetchRaceSummary()` - Race Summary single race view
     - `fetchRaceSetup()` - Race Setup/Averages table
     - `fetchTable()` - Prestart table
     - `fetchMapData()` - Prestart map tracks
     - `fetchTimeseries()` - Prestart timeseries charts

3. **FleetMap**:
   - Uses the same `filterStore.selectedSources()`
   - Changes in RaceSettings automatically affect FleetMap
   - Changes in FleetMap (via PageSettings) automatically affect Race pages

### Consistency with Existing Patterns
- **Modal Structure**: Follows the same pattern as `PageSettings.tsx`
  - Same overlay/modal classes (`pagesettings-overlay`, `pagesettings-modal`)
  - Same header/body/footer structure
  - Same "Apply" button behavior (green button, only shows when changes detected)
  - Same "Close" button behavior (X in header when no changes)

- **Source Selection UI**:
  - Same pill-style buttons with source colors
  - Same Select All / None buttons
  - Same hover effects and transitions
  - Sorted by source_id for consistent ordering

- **Settings Icon**:
  - Uses `FiSettings` from `solid-icons/fi` (same as PageSettings)
  - Same size (24px)
  - Same hover effect (opacity: 0.7)
  - Same cursor pointer style

## User Experience

### Race Summary Page
- Settings icon appears in the upper left, before the page title
- Icon is horizontally aligned with the title
- Clicking opens the Race Settings modal
- Changes apply to all three tables on the page:
  - Results table (All races or single race)
  - Stats table (single race detail)
  - Average Setup table

### Prestart Page
- Settings icon appears to the left of the View and Races dropdowns
- Icon is vertically aligned with the dropdown buttons
- Clicking opens the Race Settings modal
- Changes apply to:
  - Prestart table (all views)
  - Map tracks
  - Timeseries charts

### Modal Behavior
- **Opening**: Loads current selections from filterStore
- **Editing**: Changes are local until "Apply" is clicked
- **Apply**: Updates global filterStore, saves to API, closes modal
- **Close (X)**: Only available when no changes made; closes without saving
- **Close (button)**: Only available when no changes made; closes without saving

## Benefits

1. **Consistency**: Same source filtering across Race Summary, Prestart, and FleetMap
2. **Simplicity**: Only shows sources (no other filters), focused on the race reports use case
3. **Persistence**: Settings saved to API and restored on page load
4. **Reactivity**: Changes immediately affect all connected pages
5. **User-Friendly**: Clear UI with Select All/None, source colors, and Apply/Close buttons
6. **Non-Intrusive**: Settings icon is small and positioned to not interfere with existing UI

## Technical Notes

### Type Safety
- Uses TypeScript throughout
- Proper typing for source objects from `sourcesStore`
- Type-safe signal usage with SolidJS

### Performance
- Deferred updates (local state until Apply)
- Efficient Set operations for selection tracking
- Memoized source list (sorted once)

### Error Handling
- Debug logging for all operations
- Graceful handling of missing sources
- Fallback UI when no sources available

## Testing Recommendations

1. **Source Filtering**:
   - Select/deselect sources in RaceSettings
   - Verify tables filter correctly in Race Summary
   - Verify table/map/charts filter correctly in Prestart
   - Verify FleetMap reflects the same selections

2. **Persistence**:
   - Change sources, close browser
   - Reopen and verify selections are restored
   - Test across different projects/classes

3. **UI/UX**:
   - Test Apply button (only shows when changes made)
   - Test Close button/X (only available when no changes)
   - Test Select All / None buttons
   - Verify source colors display correctly
   - Test modal overlay click (should not close modal)

4. **Edge Cases**:
   - No sources available (should show message)
   - All sources deselected (should show empty tables)
   - Rapid open/close of modal (should not leak state)

## Future Enhancements

Possible future improvements:
1. Add keyboard shortcuts (ESC to close when no changes)
2. Add search/filter for source list (if many sources)
3. Add "Recently Used" sources section
4. Add tooltips with source metadata
5. Add confirmation dialog when closing with unsaved changes
