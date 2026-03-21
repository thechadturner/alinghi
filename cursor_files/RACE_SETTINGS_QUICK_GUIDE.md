# Race Settings - Quick Implementation Guide

## What Was Built

A new **Race Settings** modal component that allows users to control which data sources (boats/teams) are displayed in the Race Summary and Prestart pages. This modal links to the same global source filter used by the Fleet Map, ensuring consistency across all race-related views.

## Key Features

### 1. **Unified Source Control**
- Single source of truth: `filterStore.selectedSources()`
- Changes in Race Settings affect:
  - Race Summary page (all tables)
  - Prestart page (table, map, charts)
  - Fleet Map (automatically synced)

### 2. **User Interface**
- **Settings Icon**: Gear icon (⚙️) positioned in the upper left
  - Race Summary: Before the page title
  - Prestart: Before the View/Races dropdowns
- **Modal**: Clean, focused interface showing only data sources
  - Select All / None buttons for quick selection
  - Source colors for visual identification
  - Apply button (only shows when changes made)
  - Close button/X (only available when no changes)

### 3. **Data Persistence**
- Settings saved to persistent API
- Restored automatically on page load
- Shared across browser sessions

## File Structure

```
frontend/
├── components/
│   └── menus/
│       └── RaceSettings.tsx          # New modal component
└── reports/
    └── gp50/
        └── day/
            └── reports/
                ├── RaceSummary.tsx   # Updated: Added settings icon
                └── Prestart.tsx      # Updated: Added settings icon
```

## How It Works

### Architecture Flow

```
┌─────────────────┐
│  RaceSettings   │
│     Modal       │
└────────┬────────┘
         │
         │ reads/writes
         ▼
┌─────────────────┐
│  filterStore    │
│ selectedSources │◄───────┐
└────────┬────────┘        │
         │                 │
         │ triggers        │ triggers
         │ re-render       │ re-render
         ▼                 │
┌─────────────────┐        │
│  Race Summary   │        │
│   - Results     │        │
│   - Stats       │        │
│   - Averages    │        │
└─────────────────┘        │
         │                 │
         ▼                 │
┌─────────────────┐        │
│   Prestart      │        │
│   - Table       │        │
│   - Map         │        │
│   - Charts      │        │
└─────────────────┘        │
         │                 │
         ▼                 │
┌─────────────────┐        │
│   Fleet Map     │────────┘
└─────────────────┘
```

### Code Integration

#### RaceSettings Component
```typescript
// Links to global filterStore
import { selectedSources, setSelectedSources } from "../../store/filterStore";

// On Apply:
setSelectedSources(sourceNames); // Updates global state
// → Triggers re-render in all connected components
```

#### Race Summary & Prestart
```typescript
// Already filtering by selectedSources
const selectedSourceNames = getSelectedSourceNames();
if (selectedSourceNames) {
  rows = rows.filter((row) => {
    const sourceName = String(row.source_name).toLowerCase().trim();
    return sourceName && selectedSourceNames.has(sourceName);
  });
}
```

## Usage

### For Users

1. **Open Settings**:
   - Click the gear icon (⚙️) in the upper left of Race Summary or Prestart page

2. **Select Sources**:
   - Click on source names to toggle selection
   - Use "Select All" or "None" for quick selection
   - Selected sources show in color (same as Fleet Map)

3. **Apply Changes**:
   - Click "Apply" to save and close
   - Changes immediately affect all tables/maps/charts
   - Settings are saved and restored on next visit

### For Developers

#### Adding Settings to a New Page

```typescript
// 1. Import the component
import RaceSettings from "../../../../components/menus/RaceSettings";

// 2. Add the icon to your page layout
<div style={{ display: "flex", gap: "1rem" }}>
  <RaceSettings />
  <h1>Your Page Title</h1>
</div>

// 3. Filter your data by selectedSources
import { selectedSources as filterStoreSelectedSources } from "../../../../store/filterStore";

const getSelectedSourceNames = (): Set<string> | null => {
  const sourceNames = filterStoreSelectedSources();
  if (Array.isArray(sourceNames) && sourceNames.length > 0) {
    return new Set(sourceNames.map((name: string) => String(name).toLowerCase().trim()));
  }
  return null;
};

// In your data fetch:
const selectedSourceNames = getSelectedSourceNames();
if (selectedSourceNames) {
  data = data.filter((row) => {
    const sourceName = String(row.source_name).toLowerCase().trim();
    return sourceName && selectedSourceNames.has(sourceName);
  });
}
```

## Testing Checklist

- [ ] Settings icon appears in Race Summary (upper left, before title)
- [ ] Settings icon appears in Prestart (left of dropdowns)
- [ ] Modal opens when clicking settings icon
- [ ] Sources list shows all available sources
- [ ] Select All / None buttons work
- [ ] Source colors display correctly
- [ ] Apply button only shows when changes made
- [ ] Close button/X only available when no changes
- [ ] Changes apply to Race Summary tables
- [ ] Changes apply to Prestart table/map/charts
- [ ] Changes sync with Fleet Map
- [ ] Settings persist after page reload
- [ ] Settings save to API (check network tab)

## Troubleshooting

### Settings icon not visible
- Check that `RaceSettings` component is imported
- Verify the icon is in the correct container
- Check CSS for display/visibility issues

### Sources not filtering
- Verify `getSelectedSourceNames()` is called in data fetch
- Check that source names match (case-insensitive)
- Look for console errors in browser dev tools

### Settings not persisting
- Check that user is logged in
- Verify API endpoint is reachable
- Check browser console for save errors

### Modal not opening
- Check for JavaScript errors in console
- Verify Portal mount point exists
- Check z-index conflicts with other modals

## Related Files

- `frontend/store/filterStore.ts` - Global source filter state
- `frontend/store/sourcesStore.ts` - Source metadata and colors
- `frontend/components/menus/PageSettings.tsx` - Similar pattern for Fleet Map
- `frontend/services/persistentSettingsService.ts` - API persistence

## Future Enhancements

Potential improvements:
1. Keyboard shortcuts (ESC to close)
2. Search/filter for large source lists
3. Recently used sources section
4. Bulk operations (select by project, etc.)
5. Source grouping/categories
