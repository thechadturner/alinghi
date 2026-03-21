# SimpleScatter Component Architecture

## Overview

The `SimpleScatter` component renders high-performance scatter plots with density optimization and regression analysis. It uses web workers for offloading heavy computations, IndexedDB for persistent caching, and implements a queue system for sequential processing of multiple charts.

## Key Features

1. **Density Optimization**: Reduces rendered points while preserving visual density
2. **IndexedDB Caching**: Persistent cache to avoid recomputation on redraws/resizes
3. **Web Worker Processing**: Offloads heavy computations from main thread
4. **Regression Analysis**: Supports Linear, Polynomial (2,3), and LOESS regression
5. **Sequential Processing**: Queue system ensures charts process one at a time
6. **Color Grouping**: Supports DEFAULT, TACK, GRADE, and UW/DW color modes

## Architecture Flow

### 1. Initial Data Processing

```
User loads page
    ↓
SimpleScatter receives props.chart
    ↓
processChartData() applies filters (chart-specific or global)
    ↓
processDataWithEnhancedWorker() called if no enhancedData exists
    ↓
enhancedScatterWorkerManager.processEnhancedScatterData()
```

### 2. Cache Check

The worker manager first checks IndexedDB cache:

```javascript
// Generate cache key including all relevant parameters
const cacheKey = createDensityOptimizationCacheKey(
  className,
  sourceId,
  colorType,
  regressionMethod,  // ← CRITICAL: Prevents cache collisions
  chartFilters,
  globalFilters,
  selectionState
);

// Check if cache entry exists and data hash matches
const cachedEntry = await getDensityOptimizedData(cacheKey);
if (cachedEntry && cachedEntry.metadata.dataHash === dataHash) {
  // Validate regression data exists if needed
  if (needsRegression && hasRegression) {
    return cachedEntry.optimizedData;  // Cache HIT
  }
}
```

**Cache Key Components:**
- `className`: Dataset context
- `sourceId`: Data source identifier
- `colorType`: DEFAULT, TACK, GRADE, UW/DW, By Channel
- `regressionMethod`: Linear, Poly 2, Poly 3, Loess, None
- `chartFilters`: Chart-specific TWA state filters
- `globalFilters`: States, races, legs, grades
- `selectionState`: selectedRange, selectedEvents, cutEvents

**Why regressionMethod is critical:**
Without including it in the cache key, a Linear regression chart would reuse a cached Loess entry (or vice versa), resulting in missing regression data.

### 3. Worker Processing

If cache miss or invalid:

```
Push to processing queue
    ↓
processQueue() ensures sequential execution
    ↓
Send data to web worker (or fallback to main thread)
    ↓
Worker processes:
  - Groups data by colorType
  - Applies density optimization per group
  - Calculates regression for each group
    ↓
Store result in IndexedDB cache
    ↓
Return EnhancedScatterResult
```

### 4. Rendering

```javascript
// CRITICAL: Never render unoptimized data
if (!finalEnhancedResult && data.length > 0) {
  return;  // Wait for optimized data
}

const renderData = finalEnhancedResult.groups.flatMap(group => group.data);
// Apply range/cut filtering
// Calculate scales
// Render circles
// Draw regressions (at end of render)
```

### 5. Regression Drawing

Regressions are drawn in the **same render effect**, right after the scatter points:

```javascript
// At end of main render effect, with valid scales:
if (regressionMethod !== "None" && finalEnhancedResult && xScale && yScale) {
  // Validate scales have valid dimensions (not 0, not NaN)
  // Clear existing regression lines
  // Draw regression for each group using group.color
}
```

**Why in main render effect:**
- Ensures scales are correct and current
- Avoids timing issues with separate effects
- Guarantees regression uses same coordinate system as scatter plot

## Key Components

### enhancedScatterWorkerManager.ts

Manages worker lifecycle, cache interactions, and sequential processing queue.

**Processing Queue:**
```javascript
private processingQueue = [];
private isProcessing = false;

processEnhancedScatterData() → Push to queue
    ↓
processQueue() processes sequentially
    ↓
One chart at a time, no race conditions
```

**Cache Storage:**
After processing, stores:
- Optimized data
- Regression results
- Metadata (timestamp, dataHash, lastAccessed)

**Data Hash:**
- SHA-256 hash of raw data
- Invalidates cache when underlying data changes
- Ensures cache contains data for the correct dataset version

### enhanced-scatter-processor.ts (Web Worker)

**Processing Pipeline:**

1. **Filter Valid Data**
   ```javascript
   const validData = data.filter(item => {
     const x = Number(item[xField]);
     const y = Number(item[yField]);
     return !isNaN(x) && !isNaN(y) && x !== null && y !== null;
   });
   ```

2. **Group by Color Type**
   - DEFAULT → Single 'ALL' group
   - TACK → 'PORT' (red), 'STBD' (green) groups
   - GRADE → 'GRADE_1' (red), 'GRADE_2' (lightgreen), 'GRADE_3' (darkgreen), 'GRADE_0' (lightgray)
   - UW/DW → 'UPWIND' (blue), 'REACH' (orange), 'DOWNWIND' (purple)
   - By Channel → Continuous color mapping

3. **Density Optimization** (per group)
   ```javascript
   const optimizedData = optimizeDensity(
     groupData,
     maxPoints,  // Typically 3000
     xScale, yScale
   );
   ```

4. **Regression Calculation** (per group)
   ```javascript
   if (regressionMethod !== 'None') {
     regression = calculateWeightedRegression(
       optimizedData,
       regressionMethod,
       xDomain
     );
   }
   ```

### densityOptimizationCache.ts

Utility functions for cache management:

**createDensityOptimizationCacheKey:**
- Generates unique string key from all parameters
- Sorts arrays to ensure consistent hashing
- Includes regressionMethod to prevent collisions

**hashData:**
- Creates SHA-256 hash of raw data
- Used for content-based cache invalidation
- Detects when underlying dataset changes

### SimpleScatter.jsx Component

**Key Signals:**
- `enhancedData()`: Stores the optimized result from worker
- `isProcessingData()`: Indicates if worker is currently processing
- `lastProcessedCacheKey()`: Tracks last successful cache key
- `currentRegressionMethod()`: Active regression type
- `currentScales()`: X/Y scales for regression drawing
- `scatterRendered()`: Marks when scatter points are rendered

**Main Render Effect:**
1. Wait for chart and data
2. Check for existing `enhancedData()`
3. If missing or cache key changed → process
4. **CRITICAL**: Never render if `!finalEnhancedResult && data.length > 0`
5. Derive `renderData` ONLY from `finalEnhancedResult.groups`
6. Apply range/cut filtering to `renderData`
7. Calculate scales from full `renderData` (for consistent axes)
8. Render scatter circles
9. Draw regression lines (if applicable)

## Critical Implementation Details

### 1. Cache Key Must Include Regression Method

**Problem:** Without including `regressionMethod` in cache key, different regression types collide:
- Linear chart caches result without regression
- Loess chart reuses Linear cache → missing regression data

**Solution:** Include in cache key:
```javascript
const cacheKey = createDensityOptimizationCacheKey(
  className, sourceId, colorType,
  regressionMethod,  // ← Prevents collisions
  chartFilters, globalFilters, selectionState
);
```

### 2. Never Render Unoptimized Data

**Problem:** Fallback error handlers return unoptimized data:
```javascript
// BAD - Don't do this:
return {
  groups: [{ groupName: 'ALL', data: data }]  // All 14,760 points!
};
```

**Solution:** Strict guard before rendering:
```javascript
// CRITICAL: Never render without optimized data
if (!finalEnhancedResult && data.length > 0) {
  return;  // Wait for processing to complete
}

const renderData = finalEnhancedResult.groups.flatMap(group => group.data);
```

### 3. Regression Must Wait for Valid Scales

**Problem:** Regression draws with invalid scales (0 or NaN) on initial load:
```javascript
// BAD - Draws with scales that aren't valid yet
drawTrendLine(group.regression, group.color, scales.xScale, scales.yScale);
```

**Solution:** Validate scales before drawing:
```javascript
const yRange = yScale.range();
const xRange = xScale.range();
const hasValidYRange = yRange && yRange.length === 2 && Math.abs(yRange[1] - yRange[0]) > 10;
const hasValidXRange = xRange && xRange.length === 2 && Math.abs(xRange[1] - xRange[0]) > 10;

if (hasValidYRange && hasValidXRange) {
  drawTrendLine(...);
}
```

**Better Solution:** Draw regression in same effect as scatter, after scales are calculated:
```javascript
// At end of main render effect
const regressionMethod = currentRegressionMethod();
if (regressionMethod !== "None" && finalEnhancedResult && xScale && yScale) {
  // Scales are guaranteed to be valid here
  drawTrendLine(group.regression, group.color, xScale, yScale);
}
```

### 4. Main Thread Fallback Must Use ES6 Imports

**Problem:** Using `require()` in browser throws "require is not defined":
```javascript
// BAD - Doesn't work in browser
const { processEnhancedScatterData } = require('../workers/enhanced-scatter-processor');
```

**Solution:** Use ES6 imports at top of file:
```javascript
import { processEnhancedScatterData as processEnhancedScatterDataWorker } 
  from '../workers/enhanced-scatter-processor';

// Then in fallback:
const tempResult = processEnhancedScatterDataWorker(optimizedData, config);
```

### 5. Sequential Processing Queue

**Problem:** Multiple charts processing simultaneously cause race conditions:
- Charts use shared web worker
- Results can arrive out of order
- Cache writes can collide

**Solution:** Queue system ensures one chart at a time:
```javascript
private processingQueue = [];
private isProcessing = false;

async processEnhancedScatterData(...) {
  return new Promise((resolve, reject) => {
    this.processingQueue.push(async () => {
      try {
        // Process this chart's data
        const result = await worker.postMessage(...);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    
    if (!this.isProcessing) {
      this.processQueue();
    }
  });
}
```

### 6. Cache Validation for Regression Data

**Problem:** Old cached entries don't have regression data (from before regressionMethod was added to cache key):
```javascript
// Bad cached entry
{ groups: [{ regression: null }] }  // Missing regression data
```

**Solution:** Validate cached entry has regression data when needed:
```javascript
if (needsRegression) {
  const hasRegression = cachedEntry.optimizedData.groups?.some(group => group.regression);
  if (!hasRegression) {
    // Treat as cache miss, will recompute with regression
  } else {
    return cachedEntry.optimizedData;  // Cache HIT
  }
}
```

### 7. Always Use Same Scales for Regression

**Problem:** Regression drawing effect reads scales from `currentScales()` signal, but they might be from wrong render cycle:
```javascript
// BAD - Might read stale scales
const scales = currentScales();
drawTrendLine(regression, color, scales.xScale, scales.yScale);
```

**Solution:** Draw regression in same render effect, using scales calculated in that effect:
```javascript
// Good - Uses scales from current render
const yScale = d3.scaleLinear()...
const xScale = d3.scaleLinear()...
// ... (after rendering scatter)
drawTrendLine(regression, color, xScale, yScale);
```

## Data Flow Diagram

```
SimpleScatter Main Render Effect
    ↓
Check if enhancedData exists
    ↓
├─ NO → Call processDataWithEnhancedWorker()
│        ↓
│        enhancedScatterWorkerManager.processEnhancedScatterData()
│        ↓
│        Check cache
│        ↓
│        ├─ CACHE HIT → Return cached result
│        └─ CACHE MISS → Process in worker
│                          ↓
│                          Worker does:
│                          - Group by colorType
│                          - Density optimization per group
│                          - Regression per group
│                          - Return EnhancedScatterResult
│                          ↓
│                          Store in cache
│                          ↓
│                          Return to component
│
└─ YES → Use existing enhancedData
         ↓
Derive renderData from groups
    ↓
Apply range/cut filtering
    ↓
Calculate scales from renderData
    ↓
Store scales for regression
    ↓
Render scatter circles
    ↓
Draw regression lines (if applicable)
```

## Performance Optimizations

### 1. Density Optimization

Reduces 7,483 data points to ~2,300-3,000 rendered points while preserving visual density:
- Clusters nearby points
- Prioritizes edge points
- Scales point sizes by density
- Maintains statistical integrity

### 2. IndexedDB Caching

- Cache entries include data hash for content-based invalidation
- Cache keys include all relevant parameters
- Automatic cache cleanup when underlying data changes
- Async cache operations don't block UI

### 3. Sequential Processing

- Queue ensures only one chart processes at a time
- Prevents race conditions in shared worker
- Ensures consistent cache writes
- Charts render as soon as their data is ready

### 4. Main Thread Fallback

- If workers unavailable, falls back to main thread processing
- Uses same processing logic as worker
- Full regression support
- Automatic error handling

## Lessons Learned

### 1. Don't Clear enhancedData Signal on Filter/ColorType Changes

**Bad Pattern:**
```javascript
// Don't do this:
if (colorTypeChanged) {
  setEnhancedData(null);  // Forces reprocessing
  setLastProcessedColorType(currentColorType);
}
```

**Good Pattern:**
```javascript
// Trust the cache:
const currentCacheKey = createDensityOptimizationCacheKey(...);
const cacheKeyChanged = lastProcessedCacheKey() !== null && 
                         lastProcessedCacheKey() !== currentCacheKey;

if ((!currentEnhancedResult || cacheKeyChanged) && data.length > 0 && !isProcessingData()) {
  // Process or fetch from cache
}
```

### 2. Always Await Async Processing

**Bad Pattern:**
```javascript
// Don't do this:
processDataWithEnhancedWorker(data, chart);  // Fire and forget
// ... rendering happens before processing completes
```

**Good Pattern:**
```javascript
const result = await processDataWithEnhancedWorker(data, chart);
// ... guaranteed to have result before proceeding
```

### 3. Validate Scales Before Drawing Regression

**Bad Pattern:**
```javascript
// Don't do this:
drawTrendLine(regression, color, scales.xScale, scales.yScale);
// Scales might be invalid (0 or NaN)
```

**Good Pattern:**
```javascript
const yRange = yScale.range();
const xRange = xScale.range();
const hasValidYRange = yRange && yRange.length === 2 && Math.abs(yRange[1] - yRange[0]) > 10;

if (hasValidYRange && hasValidXRange) {
  drawTrendLine(...);
}
```

### 4. Draw Regression After Scales Are Set

**Bad Pattern:**
```javascript
// Don't do this:
useEffect(() => {
  // Draw regression in separate effect
  // Scales might not be valid yet
}, [enhancedData, scales]);
```

**Good Pattern:**
```javascript
// Draw regression in same effect as scatter
// (at end of main render effect)
// Scales are guaranteed to be valid
```

### 5. Include All Parameters in Cache Key

**Bad Pattern:**
```javascript
// Don't do this:
const key = `${className}_${sourceId}_${colorType}`;
// Missing regressionMethod → cache collisions
```

**Good Pattern:**
```javascript
const key = createDensityOptimizationCacheKey(
  className, sourceId, colorType,
  regressionMethod,  // ← Include everything
  chartFilters, globalFilters, selectionState
);
```

### 6. Never Fall Back to Unoptimized Data

**Bad Pattern:**
```javascript
catch (error) {
  setEnhancedData({
    groups: [{ groupName: 'ALL', data: data }]  // All 14k points!
  });
}
```

**Good Pattern:**
```javascript
catch (error) {
  logError('Error processing data:', error);
  setEnhancedData(null);  // Wait for retry or show error
  return;
}
```

### 7. Use Processing Signals to Prevent Infinite Loops

**Bad Pattern:**
```javascript
createEffect(() => {
  // Always processes on every effect run
  processDataWithEnhancedWorker(data, chart);
});
```

**Good Pattern:**
```javascript
const currentCacheKey = createDensityOptimizationCacheKey(...);
const cacheKeyChanged = lastProcessedCacheKey() !== null && 
                         lastProcessedCacheKey() !== currentCacheKey;

if ((!currentEnhancedResult || cacheKeyChanged) && 
    data.length > 0 && 
    !isProcessingData()) {
  // Only process when needed
  processDataWithEnhancedWorker(data, chart);
}
```

## Cache Strategy

### Cache Invalidation

1. **Content-based**: Data hash changes when underlying data changes
2. **Parameter-based**: Cache key changes when filters/selections/regression method changes
3. **Manual cleanup**: Call `clearDensityOptimizedCache()` when data is updated

### Cache Hit Scenarios

✅ Same data + same filters + same regression method → Cache hit  
✅ Same data + changed filters → Cache miss → New entry cached  
✅ Same data + changed regression method → Cache miss → New entry cached  
✅ Different data (hash changed) → Cache miss → New entry cached

### Cache Miss Scenarios

❌ No cache entry → Process and store  
❌ Data hash mismatch → Reprocess and store  
❌ Cache entry missing regression data → Reprocess with regression  

## Regression Methods

All regressions are calculated on **density-optimized data**, not raw data:

### Linear Regression
- Two endpoints (xDomain[0], xDomain[1])
- R² value for quality metric
- Fast computation

### Polynomial Regression (2nd/3rd degree)
- Weighted least squares
- Multiple polynomial terms
- Smooth curves

### LOESS (Locally Weighted Scatterplot Smoothing)
- Local weighted regression
- Configurable bandwidth
- 51 sampling points for smooth curves

## Color Type Handling

### DEFAULT
- Single group: 'ALL'
- Regression uses `chart.color`
- No grouping applied

### TACK
- Groups: 'PORT' (red), 'STBD' (green)
- Separate regression per group

### GRADE
- Groups: 'GRADE_0' (gray), 'GRADE_1' (red), 'GRADE_2' (lightgreen), 'GRADE_3' (darkgreen)
- Separate regression per group
- GRADE_0 excluded (filtered out as 'SKIP')

### UW/DW
- Groups: 'UPWIND' (blue), 'REACH' (orange), 'DOWNWIND' (purple)
- Separate regression per group

### By Channel
- Continuous color mapping from channel value
- Rainbow color scale
- Single group with all points

## Debugging Tips

### Check if data is cached
```javascript
console.log('Cache key:', currentCacheKey);
console.log('Last processed:', lastProcessedCacheKey());
```

### Check if scales are valid
```javascript
console.log('X scale range:', xScale.range());
console.log('Y scale range:', yScale.range());
```

### Check if regression data exists
```javascript
groups.forEach(group => {
  console.log(`Group ${group.groupName}:`, {
    hasRegression: !!group.regression,
    dataCount: group.data.length
  });
});
```

### Check worker status
```javascript
console.log('Worker available:', !!this.worker);
console.log('Is processing:', isProcessingData());
```

## Common Issues and Solutions

### Issue: Regression doesn't draw
- **Cause**: Cached entry missing regression data
- **Fix**: Cache validation rejects entries without regression when needed

### Issue: Chart renders all data points (not optimized)
- **Cause**: Main thread fallback failing
- **Fix**: Use ES6 imports instead of require()

### Issue: Regression appears off-chart
- **Cause**: Scales calculated before container dimensions are correct
- **Fix**: Validate scale dimensions > 10px before drawing

### Issue: Performance issues with multiple charts
- **Cause**: All charts processing simultaneously
- **Fix**: Sequential processing queue

### Issue: Cache not being used
- **Cause**: Cache key missing critical parameters (like regressionMethod)
- **Fix**: Include ALL relevant parameters in cache key generation

