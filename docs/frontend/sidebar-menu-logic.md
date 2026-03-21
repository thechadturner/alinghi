# Sidebar Menu Logic Documentation

## Overview
The sidebar component (`src/components/dashboard/Sidebar.jsx`) manages dynamic menu generation based on the current application context. It determines which explore and reports menus to display based on user selections and project state.

## Core Concepts

### Menu Modes
The sidebar operates in 5 distinct modes based on the current selection context:

1. **MODE 1: Dataset Mode** - When a specific dataset is selected (`selectedDatasetId > 0`)
2. **MODE 2: Day Mode** - When a specific date is selected (`selectedDate` is valid)
3. **MODE 3: Project Source Mode** - When a specific source is selected (`selectedSourceId > 0`)
4. **MODE 4: Project Level Mode** - When no dataset, date, or source is selected (project browsing)
5. **MODE 5: Project All Mode** - When all sources are selected (`selectedSourceId` is 0 or undefined)

### Auto-Selection Behavior
- **Auto-selection enabled**: MODE 1 (Dataset) and MODE 2 (Day) - automatically selects the first available menu item
- **Auto-selection disabled**: MODE 3, 4, and 5 - allows user to manually choose from available options

## Signal Dependencies

### Required Signals
- `selectedClassName()` - Current class name
- `selectedProjectId()` - Current project ID
- `selectedDatasetId()` - Selected dataset ID (0 = none)
- `selectedDate()` - Selected date (empty/null = none)
- `selectedSourceId()` - Selected source ID (0 = all sources)
- `selectedSourceName()` - Selected source name

### Global Signals
- `hasVideoMenu()` - Controls visibility of video elements in MapTimeSeries component

## Menu Generation Logic

### MODE 1: Dataset Mode
**Trigger**: `selectedDatasetId() > 0`
**API Calls**:
- `dataset/explore` - Dataset-specific exploration pages
- `dataset/reports` - Dataset-specific reports

**Behavior**: Auto-selects first available menu item

### MODE 2: Day Mode
**Trigger**: `selectedDate()` is valid AND `selectedDatasetId() === 0`
**API Calls**:
- `day/explore` - Day-specific exploration pages
- `day/reports` - Day-specific reports

**Behavior**: Auto-selects first available menu item

### MODE 3: Project Source Mode
**Trigger**: `selectedSourceId() > 0` AND no valid dataset/date
**API Calls**:
- `project/source/explore` - Source-specific exploration pages
- `project/source/reports` - Source-specific reports

**Behavior**: No auto-selection - user must choose

### MODE 4: Project Level Mode
**Trigger**: No dataset, date, or source selected
**API Calls**:
- `project/all/explore` - Project-level exploration pages
- `project/all/reports` - Project-level reports

**Behavior**: No auto-selection - user must choose

### MODE 5: Project All Mode
**Trigger**: `selectedSourceId() === 0` AND no valid dataset/date
**API Calls**:
- `project/all/explore` - All sources exploration pages
- `project/all/reports` - All sources reports

**Behavior**: No auto-selection - user must choose

## Reactive Updates

### Menu Update Triggers
1. **General Updates**: `fetchMenuTrigger()` or `updateMenus()` signals
2. **Source Changes**: When `selectedSourceId` changes and no valid dataset/date exists

### createEffect Hooks
```javascript
// General menu updates
createEffect(async () => {
  if (fetchMenuTrigger() || updateMenus()) {
    if (selectedClassName() && selectedProjectId()) {
      await fetchDynamicMenuItems();
    }
  }
});

// Source-specific updates
createEffect(async () => {
  const sourceId = selectedSourceId();
  const datasetId = selectedDatasetId();
  const date = selectedDate();
  
  if (sourceId !== undefined && selectedClassName() && selectedProjectId()) {
    const hasValidDataset = datasetId > 0;
    const hasValidDate = isValidDate(date);
    
    if (!hasValidDataset && !hasValidDate) {
      console.log('🔄 Source changed and no valid dataset/date - updating sidebar menus');
      await fetchDynamicMenuItems();
    }
  }
});
```

## Video Menu Integration

### Video Menu Detection
The sidebar automatically detects when video pages are available and sets the global `hasVideoMenu` signal:

```javascript
// Check if VIDEO menu is available
const videoAvailable = data.some(item => item.page_name === 'VIDEO');
setHasVideoMenu(videoAvailable);
```

### Video Element Control
The `hasVideoMenu` signal controls visibility of video elements in the MapTimeSeries component:
- Video label display
- Media rectangles overlay
- Video-related UI elements

## Menu Validation

### Current Menu Validation
When menus are loaded, the system validates if the currently selected menu is still available:

```javascript
const currentMenu = selectedMenu();
const isCurrentMenuAvailable = data.some(item => item.page_name === currentMenu);
if (!isCurrentMenuAvailable && data.length > 0) {
  console.log('🔄 Sidebar: Current menu', currentMenu, 'not available, switching to', data[0].page_name);
  setSelectedMenu(data[0].page_name);
  loadComponent(data[0].file_path);
}
```

**Note**: This validation only occurs in MODE 1 and MODE 2 (auto-selection modes).

## Error Handling

### API Error Handling
- Uses AbortController for request cancellation
- Graceful degradation when explore pages are empty
- Independent reports loading (reports load even if explore fails)
- Comprehensive error logging via console utilities

### Fallback Behavior
- Empty explore pages don't prevent reports from loading
- Missing menu items trigger validation and potential menu switching
- Invalid selections fall back to appropriate default states

## Performance Considerations

### Debounced Updates
- Menu updates are debounced to prevent excessive API calls
- Batch processing for multiple signal changes
- Efficient re-rendering with SolidJS signals

### Caching
- Menu items are cached in component state
- Only refetch when context actually changes
- Smart dependency tracking prevents unnecessary updates

## Integration Points

### Component Loading
- `loadComponent()` function loads appropriate page components
- Dynamic component resolution based on `file_path` from API
- Component state management and cleanup

### State Synchronization
- Integrates with persistent store for menu/page state
- Cross-window synchronization via postMessage
- Local state restoration on component mount

## Debugging

### Console Logging
- Comprehensive debug logging for each mode
- API response logging
- State change tracking
- Error reporting with context

### Debug Helpers
- Mode identification logging
- Signal value debugging
- API endpoint tracking
- Menu validation logging

## Best Practices

### Adding New Menu Types
1. Add new mode condition in `fetchDynamicMenuItems()`
2. Implement appropriate API calls
3. Set correct divider labels
4. Handle video menu detection
5. Implement appropriate auto-selection behavior
6. Add comprehensive logging

### Modifying Auto-Selection
- Only modify auto-selection in MODE 1 and MODE 2
- Project modes (3, 4, 5) should never auto-select
- Always provide user choice in project browsing contexts

### Video Integration
- Always check for video availability when loading menus
- Update `hasVideoMenu` signal appropriately
- Ensure video elements respect the global signal state
