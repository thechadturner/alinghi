# Map Level-of-Detail (LOD) System Implementation Plan

## Overview
Implement a Level-of-Detail (LOD) system for the map component (`frontend/components/charts/map`) to improve rendering performance at different zoom levels. The system will dynamically adjust the number of data points rendered based on the current zoom level, reducing computational load when viewing the map at global scales.

## Target Component
- **Primary Component**: `frontend/components/charts/map/MapContainer.tsx`
- **Track Rendering**: `frontend/components/charts/map/components/TrackLayer.tsx`
- **Renderers**: 
  - `frontend/components/charts/map/renderers/ContinuousTrackRenderer.tsx`
  - `frontend/components/charts/map/renderers/SegmentedTrackRenderer.tsx`

## Goals
1. **Zoom-based Sampling**: Reduce data points rendered at lower zoom levels (< 12)
2. **Viewport Filtering**: Only render tracks within an expanded viewport (2x buffer)
3. **Smart Redraws**: Only trigger full redraws when crossing even zoom boundaries (e.g., 10→12, 12→14)
4. **Performance**: Hide tracks during active zooming, show when zoom completes
5. **Full Resolution**: Maintain 1-second resolution at zoom level 14 and above

## Architecture

### 1. LOD Utility Functions
**Location**: `frontend/components/charts/map/utils/lodUtils.ts` (new file)

```typescript
// Sampling rates by zoom level
export function getSampleRate(zoomLevel: number): number {
  if (zoomLevel >= 14) return 1;      // Full resolution
  if (zoomLevel >= 12) return 2;      // Every 2nd point
  if (zoomLevel >= 10) return 4;      // Every 4th point
  if (zoomLevel >= 8) return 8;       // Every 8th point
  if (zoomLevel >= 6) return 32;      // Every 32nd point
  if (zoomLevel >= 4) return 64;      // Every 64th point
  return 128;                          // Every 128th point
}

// Calculate expanded viewport bounds with 2x buffer
export function getExpandedViewportBounds(map: any) {
  if (!map) return null;
  
  try {
    const bounds = map.getBounds();
    if (!bounds) return null;
    
    const latRange = bounds.getNorth() - bounds.getSouth();
    const lngRange = bounds.getEast() - bounds.getWest();
    
    // 2x buffer = expand by 100% in each direction
    return {
      minLat: bounds.getSouth() - latRange,
      maxLat: bounds.getNorth() + latRange,
      minLng: bounds.getWest() - lngRange,
      maxLng: bounds.getEast() + lngRange
    };
  } catch (e) {
    return null;
  }
}

// Check if a track point is within viewport bounds
export function isPointInViewport(point: any, bounds: any, getLat: (p: any) => number | undefined, getLng: (p: any) => number | undefined): boolean {
  if (!point || !bounds) return false;
  const lat = getLat(point);
  const lng = getLng(point);
  if (lat === undefined || lng === undefined) return false;
  return lat >= bounds.minLat && lat <= bounds.maxLat &&
         lng >= bounds.minLng && lng <= bounds.maxLng;
}

// Sample a track based on the sample rate
export function sampleTrack(track: any[], sampleRate: number, zoomLevel: number): any[] {
  if (!track || track.length === 0) return track;
  if (sampleRate === 1) return track; // No sampling needed
  
  let sampled = [];
  for (let i = 0; i < track.length; i += sampleRate) {
    sampled.push(track[i]);
  }
  
  // Always include last point to complete the track
  if (sampled.length === 0 || sampled[sampled.length - 1] !== track[track.length - 1]) {
    sampled.push(track[track.length - 1]);
  }

  // Apply maximum point limit for very low zoom levels
  let maxPoints = Infinity;
  if (zoomLevel < 8) {
    maxPoints = 100;
  }
  if (zoomLevel < 6) {
    maxPoints = 50;
  }

  if (sampled.length > maxPoints) {
    const reductionFactor = Math.ceil(sampled.length / maxPoints);
    const furtherSampled = [];
    for (let i = 0; i < sampled.length; i += reductionFactor) {
      furtherSampled.push(sampled[i]);
    }
    // Ensure the last point is always included
    if (furtherSampled.length === 0 || furtherSampled[furtherSampled.length - 1] !== sampled[sampled.length - 1]) {
      furtherSampled.push(sampled[sampled.length - 1]);
    }
    sampled = furtherSampled;
  }
  
  return sampled;
}

// Determine if a full redraw is needed based on zoom level crossing even boundaries
export function shouldRedrawForZoom(currentZoom: number, lastRenderZoom: number | null): boolean {
  if (lastRenderZoom === null) return true; // Always redraw on first render
  
  const currentEven = Math.floor(currentZoom / 2) * 2;
  const lastEven = Math.floor(lastRenderZoom / 2) * 2;
  
  return currentEven !== lastEven;
}
```

### 2. TrackLayer Modifications
**File**: `frontend/components/charts/map/components/TrackLayer.tsx`

#### Changes Required:

1. **Add LOD State Management**:
   - Store original unfiltered data
   - Track last render zoom level
   - Track if LOD is enabled

2. **Modify `renderTracks` function**:
   - Apply viewport filtering before rendering
   - Apply sampling based on current zoom level
   - Store processed data for redraw logic

3. **Add Zoom Event Handlers**:
   - `zoomstart`: Hide track overlay (opacity: 0)
   - `zoomend`: Show track overlay (opacity: 1) and check if redraw needed
   - `moveend`: Check if redraw needed (viewport may have changed)

4. **Smart Redraw Logic**:
   - Only redraw when crossing even zoom boundaries
   - Re-process original data with new zoom/viewport
   - Update track positions using transform-based updates when not redrawing

### 3. MapContainer Integration
**File**: `frontend/components/charts/map/MapContainer.tsx`

#### Changes Required:

1. **Pass Zoom Level to TrackLayer**:
   - Track current zoom level in MapContainer
   - Pass zoom level as prop to TrackLayer

2. **Coordinate LOD with Other Layers**:
   - Ensure BoatLayer respects same zoom thresholds
   - Coordinate with RaceCourseLayer visibility

### 4. Renderer Modifications
**Files**: 
- `frontend/components/charts/map/renderers/ContinuousTrackRenderer.tsx`
- `frontend/components/charts/map/renderers/SegmentedTrackRenderer.tsx`

#### Changes Required:

1. **Accept Pre-processed Data**:
   - Renderers should receive already-sampled and filtered data
   - No additional sampling needed in renderers

2. **Maintain Selection Logic**:
   - Ensure brush/selection logic works with sampled data
   - Selection should work on full dataset, not sampled

## Implementation Steps

### Step 1: Create LOD Utility Functions
- [ ] Create `frontend/components/charts/map/utils/lodUtils.ts`
- [ ] Implement `getSampleRate`, `getExpandedViewportBounds`, `isPointInViewport`, `sampleTrack`, `shouldRedrawForZoom`
- [ ] Add unit tests for utility functions

### Step 2: Modify TrackLayer Component
- [ ] Import LOD utility functions
- [ ] Add state variables: `originalData`, `lastRenderZoom`, `lodEnabled`
- [ ] Modify `renderTracks` to apply viewport filtering and sampling
- [ ] Add zoom event handlers (`zoomstart`, `zoomend`, `moveend`)
- [ ] Implement smart redraw logic using `shouldRedrawForZoom`
- [ ] Add visibility toggle during zoom operations
- [ ] Add console logging for debugging (points drawn vs total points)

### Step 3: Update MapContainer
- [ ] Track current zoom level in MapContainer
- [ ] Pass zoom level prop to TrackLayer
- [ ] Ensure zoom level is reactive and updates properly

### Step 4: Update Renderers (if needed)
- [ ] Verify renderers work with pre-processed (sampled) data
- [ ] Ensure selection/brush logic maintains access to full dataset
- [ ] Test that renderers don't apply additional sampling

### Step 5: Testing and Optimization
- [ ] Test zoom transitions from global to detail view
- [ ] Verify performance improvements at low zoom levels
- [ ] Test viewport filtering when panning
- [ ] Verify selection/brush functionality still works
- [ ] Test with different data sizes (small, medium, large datasets)
- [ ] Add performance metrics/logging

### Step 6: Documentation
- [ ] Document LOD system behavior
- [ ] Document zoom level thresholds
- [ ] Add code comments explaining LOD logic

## Technical Details

### Zoom Level Thresholds
- **Zoom ≥ 14**: Full resolution (1x sampling)
- **Zoom ≥ 12**: 2x sampling (every 2nd point)
- **Zoom ≥ 10**: 4x sampling (every 4th point)
- **Zoom ≥ 8**: 8x sampling (every 8th point)
- **Zoom ≥ 6**: 32x sampling (every 32nd point) + 100 point max per track
- **Zoom ≥ 4**: 64x sampling (every 64th point) + 50 point max per track
- **Zoom < 4**: 128x sampling (every 128th point) + 50 point max per track

### Viewport Filtering
- Expand viewport bounds by 2x (100% buffer in each direction)
- Filter tracks to only those with at least one point in expanded viewport
- Prevents pop-in/pop-out effects at viewport edges

### Redraw Strategy
- **Full Redraw**: Only when crossing even zoom boundaries (e.g., 9→10, 11→12)
- **Transform Update**: When zooming within same even boundary (e.g., 10.1→10.5)
- **Visibility**: Hide tracks during active zoom, show when zoom completes

### Performance Optimizations
1. **Hide During Zoom**: Set track overlay opacity to 0 during `zoomstart`, restore on `zoomend`
2. **Debounce Redraws**: Use `shouldRedrawForZoom` to prevent excessive redraws
3. **Viewport Culling**: Only process tracks that are potentially visible
4. **Point Limits**: Enforce maximum points per track at very low zoom levels

## Edge Cases and Considerations

1. **Selection/Brush Logic**: 
   - Selection must work on full dataset, not sampled
   - Store full dataset separately for selection operations
   - Only apply sampling to visual representation

2. **Time Window Filtering**:
   - Apply time window filtering before LOD sampling
   - Ensure LOD doesn't interfere with time-based filtering

3. **Maneuver Circles**:
   - Maneuver circles should respect LOD sampling
   - May need to adjust circle density at low zoom levels

4. **Boat Layer**:
   - Coordinate boat visibility with zoom thresholds
   - Ensure boats don't render at very low zoom levels

5. **Race Course Layer**:
   - Race course boundary should respect zoom thresholds
   - May need separate zoom threshold for race course visibility

## Success Criteria

1. ✅ Significant reduction in rendered points at zoom levels < 12
2. ✅ Smooth zoom experience without lag
3. ✅ Full resolution maintained at zoom level 14+
4. ✅ Selection/brush functionality remains intact
5. ✅ No visual artifacts or pop-in/pop-out issues
6. ✅ Console logging shows effective point reduction

## Future Enhancements

1. **Adaptive Sampling**: Adjust sampling based on track density
2. **Progressive Loading**: Load higher detail as zoom increases
3. **Web Worker Processing**: Move LOD processing to web worker for very large datasets
4. **Configurable Thresholds**: Allow users to adjust LOD thresholds via settings
