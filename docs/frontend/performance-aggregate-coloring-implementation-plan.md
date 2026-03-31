# Performance Aggregate Coloring – Implementation Plan

This plan fixes Performance pages not coloring aggregates by aligning with filter-object names and ensuring processed points have the keys the chart expects. Follow the steps in order.

---

## 1. Goal and approach

- **Problem**: Scatter/box points on Performance reports render as lightgrey; color-by (Grade, Race, Leg, State, Config, source_name) does not apply.
- **Cause**: Processed data has only lowercase metadata (`race_number`, `leg_number`, `grade`, …). The chart resolves color with `resolveDataField(d, props.color)` where `props.color` is e.g. `'RACE'`; the point has no `RACE` or `race`, so the value is undefined and no group matches.
- **Approach**: Use **filter-object names** as the single source of truth (e.g. `Race_number`, `Leg_number`, `Grade`, `State`, `Config`, `source_name`). Processors add those exact keys to each point; `getColorOptions()` returns those names unchanged; chart and pages use the same names. Fallbacks keep legacy lowercase-only data working.

---

## 2. Implementation order

Do the steps in this order so that data, options, and UI stay consistent.

| Phase | What | Files |
|-------|------|--------|
| **A** | Add filter-object name keys to processed points | `performanceDataService.ts`, `fleetPerformanceDataService.ts` |
| **B** | Return filter names from getColorOptions (no UPPERCASE mapping) | `unifiedFilterService.ts` |
| **C** | Resolve color field with filter name + lowercase fallback | `colorScale.ts` |
| **D** | Use color option as group key; optional display labels | Performance pages, PerfSettings/Legend if needed |

---

## 3. Phase A – Add filter-object keys in processors

**Standard set of keys** (from filter config / DATA_NORMALIZATION_PATTERN):  
`Race_number`, `Leg_number`, `Grade`, `State`, `Config`, `source_name`, `Event`, `Year`, `TACK`.

Add these **in addition to** existing lowercase fields (do not remove `race_number`, `leg_number`, etc.).

### 3.1 `frontend/services/performanceDataService.ts`

**Location**: Inside `processPerformanceData`, in the object built for each aggregate (the `baseObject` used in `processedAggregates.map`).

**Current block** (approx. lines 2818–2850): `baseObject` has `tack`, `race_number`, `leg_number`, `grade`, `config`, `year`, `event`, `state` and no filter-object-name keys.

**Change**: Immediately after the existing metadata block (after `state: state`), add the filter-object-name aliases:

```ts
// Filter-object names for chart coloring (single source of truth)
Race_number: race,
Leg_number: leg,
Grade: grade,
State: state,
Config: config,
source_name: item.source_name,
Event: event,
Year: year,
TACK: tack,
```

- Use the same variables already defined above (`race`, `leg`, `grade`, `state`, `config`, `event`, `year`, `tack`). For `source_name` use the same value as `baseObject.source_name` (already set).
- Add the same set to the **cloud** branch: in `processedCloud` map, in the object built for each cloud point (approx. lines 2932–2962), add the same keys after the existing `state: state` / `STATE: state` block.

**Skip list**: In the `Object.keys(item).forEach` that copies numeric fields (approx. 2875–2895), add the new keys to `skipFields` so they are not overwritten:  
`'Race_number', 'Leg_number', 'Grade', 'State', 'Config', 'source_name', 'Event', 'Year', 'TACK'` (and keep existing skip list).

### 3.2 `frontend/services/fleetPerformanceDataService.ts`

**Location**: Inside `processFleetPerformanceData`, in the object built for each aggregate in `processedAggregates.map` (approx. 1862–1886).

**Change**: After the existing metadata block (`state: state`), add:

```ts
// Filter-object names for chart coloring (single source of truth)
Race_number: race,
Leg_number: leg,
Grade: grade,
State: state,
Config: config,
source_name: sourceName,
Event: event,
Year: year,
TACK: item.tack ?? (twaValue < 0 ? 'PORT' : 'STBD'),
```

Use the existing variables (`race`, `leg`, `grade`, `state`, `config`, `year`, `event`, `sourceName`). Add the same keys to the **cloud** branch (in the `processedCloud` map, object built per item, approx. 1945–1964). Add these key names to the `skipFields` array in the `Object.keys(item).forEach` blocks (aggregates and cloud) so they are not overwritten.

**Verification**: After Phase A, each processed aggregate and cloud point must have both lowercase (`race_number`, …) and filter-object keys (`Race_number`, …). No other call sites need changes yet.

---

## 4. Phase B – getColorOptions returns filter names unchanged

**File**: `frontend/services/unifiedFilterService.ts`

**Current behavior**: `getColorOptions()` maps filter-channel names to UPPERCASE (e.g. `race_number` → `RACE`, `leg_number` → `LEG`, `source_name` → `SOURCE_NAME`). JSDoc says it returns “uppercase (e.g. ['TACK', 'GRADE', 'EVENT'])”.

**New behavior**: Return the **exact** names from the filter config (e.g. `Race_number`, `Leg_number`, `Grade`, `State`, `Config`, `source_name`, `Event`, `Year`, `TACK`). No UPPERCASE conversion.

### 4.1 default_groups branch (approx. 323–364)

- When building `colorOptions` from `(config as any).default_groups`:
  - **Do not** map to UPPERCASE. Use each `groupName` as-is (trimmed), except for a **normalization** only when the backend uses a different spelling (e.g. if backend sends `race_number` but filter_channels use `Race_number`, normalize to the filter_channels style; if backend and config both use `Race_number`, keep `Race_number`).
- For **TACK**: if the config does not list it but we still want it for dataset/source context, push `'TACK'` (keep this special case as-is).
- Remove the block that sets `colorName = 'RACE'`, `'LEG'`, `'SOURCE_NAME'`, etc. Replace with: push `groupName` (or normalized form to match filter_channels) into `colorOptions` without changing case.

### 4.2 filter_channels fallback (approx. 366–406)

- When building `colorOptions` from `config.filter_channels`:
  - **Do not** set `colorName = upperName` or map `race_number` → `RACE`. Push `channel.name` (the filter-channel name as returned by the API, e.g. `Race_number`, `Grade`) into `colorOptions`.
- Keep the `colorCapableFields` check so only color-capable channels are included; then use `channel.name` (or `channelName`) as the option value, not `colorName` derived from uppercase.

### 4.3 filter_types fallback (approx. 407–417)

- When adding options from `config.filter_types`, push `fieldName` (the key from the config object) as-is, not `upperName`.

### 4.4 Default fallback (approx. 419–426)

- When no options are found, return context-appropriate defaults using **filter-object style** names, e.g. `['TACK', 'Grade']` for dataset/source and `['Grade']` for day/fleet (or match whatever your filter_channels actually use for AC40).

### 4.5 JSDoc

- Update the JSDoc for `getColorOptions` to state that it returns “field names as in the filter config (e.g. ['Race_number', 'Leg_number', 'Grade', 'TACK'])”.

**Verification**: Call `getColorOptions(className, context)` and assert returned strings match filter config names (e.g. `Race_number`, not `RACE`). No other code should assume UPPERCASE from this function.

---

## 5. Phase C – resolveDataField supports filter name + lowercase

**File**: `frontend/utils/colorScale.ts`

**Function**: `resolveDataField(item, field)` (approx. 281–292).

**Current behavior**: Tries `item[field]` then `item[field.toLowerCase()]`. So for `field === 'Race_number'` it tries `item['race_number']` only via lowercase, which gives `race_number` – correct. For `field === 'RACE'` it tries `item['race']` which does not exist; `race_number` is not tried.

**Change**: After exact match and simple lowercase, add a **normalized-name** fallback so that filter-object and display names resolve to the stored lowercase key when needed:

1. If `item[field] !== undefined`, return it.
2. If `item[field.toLowerCase()] !== undefined`, return it.
3. **New**: Map known filter/display names to normalized (lowercase) key and try that:
   - Map: `Race_number` / `RACE` → `race_number`, `Leg_number` / `LEG` → `leg_number`, `Grade` / `GRADE` → `grade`, `State` / `STATE` → `state`, `Config` / `CONFIG` → `config`, `source_name` / `SOURCE_NAME` → `source_name`, `Event` / `EVENT` → `event`, `Year` / `YEAR` → `year`, `TACK` → `tack`.
   - Use a small constant map (e.g. `FIELD_TO_NORMALIZED`) from the canonical name (and optionally UPPERCASE) to the single lowercase key; then `if (item[normalizedKey] !== undefined) return item[normalizedKey]`.
4. Return `undefined` if still not found.

This keeps legacy data (only lowercase) and new data (with filter-object keys) both working.

**Verification**: For a point with only `race_number`, `resolveDataField(point, 'Race_number')` and `resolveDataField(point, 'RACE')` should both return the race value. For a point with `Race_number`, `resolveDataField(point, 'Race_number')` should return that value.

---

## 6. Phase D – Performance pages use color option as group key

Performance pages build `groups` from the selected color option and pass `color()` and `groups()` to AdvancedScatter. They currently use a `getFieldName()` that maps UPPERCASE to lowercase (e.g. `RACE` → `race_number`) for `groupBy(dataForGrouping, actualFieldName)`.

**New contract**: `color()` is now a filter-object name (e.g. `Race_number`). Processed data has that key. So we can use the color option directly for grouping, with a fallback for legacy data.

### 6.1 Dataset Performance – `frontend/reports/ac40/dataset/reports/Performance.tsx`

- **handleColorChange** (approx. 941–1065):
  - Keep `getFieldName(value)` but **update the map** so that filter-object names are passed through: for keys `Race_number`, `Leg_number`, `Grade`, `State`, `Config`, `source_name`, `Event`, `Year`, `TACK` return the **same** value (so `groupBy(data, value)` uses the new key). For backward compatibility, also map the old UPPERCASE names to lowercase so that if something still passes `RACE`, we still use `race_number` for grouping:
    - e.g. `'RACE' → 'race_number'`, `'LEG' → 'leg_number'`, `'GRADE' → 'grade'`, `'STATE' → 'state'`, `'CONFIG' → 'config'`, `'SOURCE_NAME' → 'source_name'`, `'EVENT' → 'event'`, `'YEAR' → 'year'`, `'TACK' → 'tack'`.
    - And: `'Race_number' → 'Race_number'`, `'Leg_number' → 'Leg_number'`, etc. (identity for filter names).
  - So: `const actualFieldName = getFieldName(value);` then `groupBy(dataForGrouping, actualFieldName)`. With Phase A, points have `Race_number`; so `actualFieldName === 'Race_number'` works. If a page ever still had only lowercase, we could set `actualFieldName = getFieldName(value)` to return `race_number` when value is `Race_number` (fallback); then both key styles work. **Recommended**: `getFieldName` returns the value as-is when it is already a filter name (e.g. `Race_number`); otherwise maps old UPPERCASE to lowercase. That way groupBy uses either `Race_number` or `race_number` and both work.
- **Default color**: When setting initial color (e.g. from persistent settings or first load), use a value that exists in `colors()` (e.g. first option or `TACK` if present). `colors()` now returns filter names, so default might be `'TACK'` or `'Grade'` depending on config.
- **Persistent settings**: Stored value may be old (e.g. `'RACE'`). On load, if the stored value is not in the new `colors()` list, map it once: e.g. `'RACE'` → `'Race_number'`, `'LEG'` → `'Leg_number'`, etc., then set color to that and save the new value on next save (optional). Or simply treat unknown as “use first available option”.

### 6.2 FleetPerformance – `frontend/reports/ac40/day/reports/FleetPerformance.tsx`

- **handleColorChange** (approx. 753–912): Same idea as Performance. Update `getFieldName` to:
  - Return the value as-is when it is a filter-object name (`Race_number`, `Leg_number`, `Grade`, `State`, `Config`, `source_name`, `Event`, `Year`, `TACK`).
  - Otherwise map old UPPERCASE to lowercase for backward compatibility.
- **SOURCE_NAME**: Already handled specially (source groups from sourcesStore). Keep that; the option value can be `source_name` or `Source_name` from config – use the same key for grouping (`source_name` or as returned by config) and ensure processed points have `source_name` (and optionally the same in filter name form). Display mapping (SOURCE_NAME → “Source” or “Source name”) can stay in `displayColorOptions` / `getInternalColorValue`; if getColorOptions now returns `source_name`, adjust those only if the UI previously expected `SOURCE_NAME`.
- Default color and persistent settings: same as 6.1 (prefer first option or a known default; map old UPPERCASE to filter name if needed).

### 6.3 FleetPerformanceHistory – `frontend/reports/ac40/project/all/reports/FleetPerformanceHistory.tsx`

- **handleColorChange** (approx. 1144–1300): Same `getFieldName` behavior as 6.1 and 6.2 (identity for filter names, UPPERCASE → lowercase fallback).
- **getFieldName** used when rebuilding groups (e.g. after data load): use the same mapping so `actualFieldName` is either the filter name or the lowercase key.

### 6.4 PerformanceHistory – `frontend/reports/ac40/project/source/reports/PerformanceHistory.tsx`

- Same as 6.1: update `getFieldName` in the color-change path and any place that derives the group key from the selected color. Default and persistent color handling: use filter names; map old UPPERCASE when loading saved value if necessary.

### 6.5 Display labels (optional)

- DropDownButton and PerfSettings currently show the raw option string (e.g. `RACE` or, after change, `Race_number`). If you want friendlier labels (e.g. “Race”, “Race Number”):
  - Add a small helper or map in the page: `filterNameToLabel: Record<string, string>` (e.g. `Race_number` → `Race`, `Leg_number` → `Leg`, `Grade` → `Grade`, `source_name` → `Source`, etc.) and pass `filterNameToLabel[opt] || opt` as the display text for the dropdown option. Or use `display_name` from filter_channels if the page has access to the config. This step is optional and can be done after coloring works.

**Verification**: On each Performance page, select each color option (Grade, Race_number, Leg_number, State, Config, source_name where available). Points and legend should match; tooltip should show the correct value for the selected color field.

---

## 7. AdvancedScatter and tooltip

- **getColor**: Already uses `resolveDataField(d, props.color)`. With Phase C, both filter names and legacy keys resolve; no change required if `props.color` is the filter name.
- **Tooltip** (approx. 1231–1232): Currently `colorByValue = point[colorByField] || point[colorByField.toUpperCase()]`. After Phase A, points have e.g. `Race_number`; so when `props.color === 'Race_number'`, `point['Race_number']` exists. No code change needed unless you want to also try lowercase fallback here (then use `point[colorByField] ?? point[normalizedKey]` via the same map as in resolveDataField). Prefer reusing resolveDataField for the tooltip value so one place handles all fallbacks.

**Optional**: In the tooltip, use `resolveDataField(point, colorByField)` instead of direct property access so tooltip stays correct for legacy data.

---

## 8. Checklist summary

- [ ] **A1** – performanceDataService: add Race_number, Leg_number, Grade, State, Config, source_name, Event, Year, TACK to aggregate and cloud baseObject; update skipFields.
- [ ] **A2** – fleetPerformanceDataService: same keys for aggregate and cloud; update skipFields.
- [ ] **B** – unifiedFilterService.getColorOptions: return filter names unchanged (default_groups, filter_channels, filter_types, default fallback); update JSDoc.
- [ ] **C** – colorScale.resolveDataField: add normalized-name fallback map (filter name / UPPERCASE → lowercase key).
- [ ] **D1** – Performance (dataset): getFieldName identity for filter names + UPPERCASE→lowercase fallback; default/persistent color uses filter names.
- [ ] **D2** – FleetPerformance: same getFieldName; SOURCE_NAME/source_name display handling if needed.
- [ ] **D3** – FleetPerformanceHistory: same getFieldName and group key logic.
- [ ] **D4** – PerformanceHistory: same as Performance (dataset).
- [ ] **Optional** – Tooltip: use resolveDataField(point, colorByField) for color value.
- [ ] **Optional** – Dropdown/label: map filter names to short labels for display.

---

## 9. Testing

1. **Dataset Performance**: Open a dataset → Performance. Color by Grade, Race_number, Leg_number, State, Config. Points and legend colors should match; no lightgrey unless that value is actually “NONE” or missing.
2. **FleetPerformance (day)**: Same, plus color by source_name (or Source_name). Multiple sources should show distinct colors.
3. **FleetPerformanceHistory**: Same checks; color options should come from filters_fleet.
4. **PerformanceHistory**: Same; options from filters_source.
5. **Persistence**: Set color to e.g. Grade, reload page or reopen project; color selection should persist (and if you migrated from RACE to Race_number, one-time mapping on load is enough).
6. **Legacy**: If any code path still passes UPPERCASE (e.g. `RACE`) into resolveDataField or getFieldName, behavior should still work via fallbacks.

---

## 10. Reference – filter context and objects

- **dataset** → `filters_dataset` (single dataset).
- **day** → `filters_day` (single day, possibly multisource).
- **fleet** → `filters_fleet` (multisource, multiday).
- **source** → `filters_source` (single boat, multiday).

Performance page context usage is already correct; this plan does not change which context each page uses.
