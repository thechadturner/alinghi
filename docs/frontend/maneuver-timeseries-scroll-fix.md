# Maneuver TimeSeries Container Height Fix

## Problem

The maneuver timeseries component was not filling the available viewport height. The container was only taking up approximately 55% of the page height, leaving significant empty space below the charts. Additionally, users were unable to scroll all the way down to see the last chart properly.

## Root Cause

The issue had multiple contributing factors:

1. **CSS Transform Scaling**: The page uses CSS `transform: scale()` to scale content based on viewport width. When content is scaled down (e.g., scale factor = 0.556), the container needs MORE layout height to achieve the desired visible height.

2. **Incorrect Height Calculation**: The initial approach used `window.innerHeight` directly without accounting for:
   - The CSS transform scale factor applied to parent containers
   - The container's position relative to the viewport
   - Parent container constraints

3. **Parent Container Constraints**: The `#timeseries-area` parent container had `height: 100%` which was constraining the child container's ability to grow.

4. **Excessive Padding**: Previous fixes added excessive padding (400px) and spacer elements (chartHeight * 3) to compensate for scroll issues, which created too much empty space.

## Solution

The fix involved calculating the container height dynamically using JavaScript, accounting for the CSS transform scale factor.

### Key Formula

When content is scaled down via CSS transform, you need MORE layout height to achieve the desired visible height:

```
layoutHeight = desiredVisibleHeight / scaleFactor
```

**Example:**
- Desired visible height: 734px
- Scale factor: 0.556
- Required layout height: 734 / 0.556 = 1321px

### Implementation

#### 1. Get the Scale Factor

The scale factor is applied to the `#media-container` parent via CSS transform. We extract it from the computed transform matrix:

```typescript
// Find the media-container parent that has the scale transform
let parent = containerRef.parentElement;
let mediaContainer: HTMLElement | null = null;
while (parent) {
  if (parent.id === 'media-container') {
    mediaContainer = parent;
    break;
  }
  parent = parent.parentElement;
}

// Get scale factor from CSS custom property or transform matrix
let scaleFactor = parseFloat(
  getComputedStyle(document.documentElement).getPropertyValue('--scale-factor')
) || 1;

// Extract from transform matrix if available (more reliable)
if (mediaContainer) {
  const transform = getComputedStyle(mediaContainer).transform;
  if (transform && transform !== 'none') {
    const matrix = transform.match(/matrix\(([^)]+)\)/);
    if (matrix) {
      const values = matrix[1].split(',').map(v => parseFloat(v.trim()));
      if (values.length >= 4) {
        scaleFactor = values[0]; // scaleX is the first value
      }
    }
  }
}
```

#### 2. Calculate Desired Visible Height

Calculate the desired visible height based on viewport minus fixed elements:

```typescript
const headerHeight = 60; // Account for header
const padding = 20; // Some padding for spacing
const legendElement = document.getElementById('maneuver-legend-timeseries');
const legendHeight = legendElement 
  ? legendElement.getBoundingClientRect().height 
  : 50;

const desiredVisibleHeight = window.innerHeight - headerHeight - legendHeight - padding;
```

#### 3. Calculate Layout Height

Apply the inverse scale factor to get the required layout height:

```typescript
// When content is scaled down, we need MORE layout height
const layoutHeight = desiredVisibleHeight / scaleFactor;
```

#### 4. Set Container Height

Set the height on both the container and its parent to ensure proper sizing:

```typescript
const heightValue = `${Math.max(400, layoutHeight)}px`;

// Set on the container
containerRef.style.setProperty('height', heightValue, 'important');
containerRef.style.setProperty('max-height', heightValue, 'important');

// Also ensure parent can accommodate this height
const timeseriesArea = document.getElementById('timeseries-area');
if (timeseriesArea) {
  timeseriesArea.style.setProperty('min-height', heightValue, 'important');
  timeseriesArea.style.setProperty('height', 'auto', 'important');
}
```

#### 5. Update on Resize

Ensure the height recalculates when the window or container resizes:

```typescript
// In onMount
const resizeObserver = new ResizeObserver(() => {
  // ... other resize logic
  updateContainerHeight();
});

window.addEventListener('resize', () => {
  updateContainerHeight();
});
```

### Complete Function Example

```typescript
const updateContainerHeight = () => {
  if (!containerRef) return;
  
  // Find the media-container parent that has the scale transform
  let parent = containerRef.parentElement;
  let mediaContainer: HTMLElement | null = null;
  while (parent) {
    if (parent.id === 'media-container') {
      mediaContainer = parent;
      break;
    }
    parent = parent.parentElement;
  }
  
  // Get the scale factor from CSS custom property or transform matrix
  let scaleFactor = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--scale-factor')
  ) || 1;
  
  if (mediaContainer) {
    const transform = getComputedStyle(mediaContainer).transform;
    if (transform && transform !== 'none') {
      const matrix = transform.match(/matrix\(([^)]+)\)/);
      if (matrix) {
        const values = matrix[1].split(',').map(v => parseFloat(v.trim()));
        if (values.length >= 4) {
          scaleFactor = values[0];
        }
      }
    }
  }
  
  // Get the legend element to account for its height
  const legendElement = document.getElementById('maneuver-legend-timeseries');
  const legendHeight = legendElement 
    ? legendElement.getBoundingClientRect().height 
    : 50;
  
  // Calculate desired visible height
  const headerHeight = 60;
  const padding = 20;
  const desiredVisibleHeight = window.innerHeight - headerHeight - legendHeight - padding;
  
  // Calculate layout height accounting for scale
  const layoutHeight = desiredVisibleHeight / scaleFactor;
  
  // Set height on container
  const heightValue = `${Math.max(400, layoutHeight)}px`;
  containerRef.style.setProperty('height', heightValue, 'important');
  containerRef.style.setProperty('max-height', heightValue, 'important');
  
  // Ensure parent can accommodate
  const timeseriesArea = document.getElementById('timeseries-area');
  if (timeseriesArea) {
    timeseriesArea.style.setProperty('min-height', heightValue, 'important');
    timeseriesArea.style.setProperty('height', 'auto', 'important');
  }
};
```

## CSS Changes

### Remove Fixed Height Constraints

Remove `min-height: 100%` from the container CSS to allow JavaScript to control height:

```css
/* TimeSeries chart container styling */
#media-container.maneuvers-page .time-series {
  width: 100% !important;
  /* height set dynamically via JavaScript to fit viewport */
  /* min-height removed - let JavaScript control height */
  overflow-y: auto !important;
  display: flex !important;
  flex-direction: column !important;
  position: relative !important;
}
```

### Reduce Excessive Padding

Reduce padding on parent containers since height is now properly calculated:

```css
#timeseries-area {
  padding-bottom: 100px; /* Reduced from 400px */
  /* ... other styles ... */
}
```

## Spacer Element Reduction

Reduce spacer elements in the chart rendering code:

```typescript
// Standard TimeSeries: Reduced from chartHeight * 3 to chartHeight * 0.5
fakeChartWrapper.append("svg")
  .attr("height", chartHeight * 0.5);

// Grouped TimeSeries: Reduced from chartHeight * 1.5 to chartHeight * 0.5
fakeChartWrapper.append("svg")
  .attr("height", chartHeight * 0.5);
```

## Why This Works

### The Math Behind Scaling

When CSS `transform: scale(0.556)` is applied:
- **Visual size**: Content appears 55.6% of its original size
- **Layout space**: Still requires 100% of the original space
- **To achieve 734px visible**: Need 734 / 0.556 = 1321px layout height

### Key Insights

1. **Transform scaling is visual only** - it doesn't affect layout calculations
2. **Layout height must be INVERSE of scale** - divide desired height by scale factor
3. **Parent containers must accommodate** - set min-height on parents
4. **Dynamic calculation is essential** - scale factor changes with viewport width

## Best Practices for Future Implementations

### When Adding Height Calculations to Scaled Containers

1. **Always account for scale factor**: `layoutHeight = desiredHeight / scaleFactor`
2. **Find the scaled parent**: Locate the element with `transform: scale()` applied
3. **Extract scale from transform matrix**: More reliable than CSS variables
4. **Set height on both container and parent**: Ensure parent can accommodate
5. **Use `!important` to override CSS**: JavaScript-set styles need priority
6. **Update on resize**: Recalculate when window or container size changes

### Debugging Tips

Add comprehensive logging to verify calculations:

```typescript
console.log('Height calculation:', {
  windowInnerHeight: window.innerHeight,
  scaleFactorFromCSS: parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--scale-factor')) || 1,
  scaleFactorFromTransform: scaleFactor,
  headerHeight,
  legendHeight,
  padding,
  desiredVisibleHeight,
  layoutHeight,
  finalHeight: Math.max(400, layoutHeight)
});

// Verify actual rendered height
setTimeout(() => {
  const actualHeight = containerRef?.getBoundingClientRect().height;
  console.log('Actual rendered height (scaled):', actualHeight);
}, 100);
```

### Common Pitfalls to Avoid

❌ **Don't use viewport height directly without scale factor**
```typescript
// WRONG: Doesn't account for scaling
containerRef.style.height = `${window.innerHeight}px`;
```

❌ **Don't forget to update parent containers**
```typescript
// WRONG: Parent might constrain child
containerRef.style.height = heightValue;
// Missing: timeseriesArea.style.minHeight = heightValue;
```

❌ **Don't use fixed padding to compensate**
```css
/* WRONG: Creates excessive empty space */
#timeseries-area {
  padding-bottom: 400px;
}
```

✅ **Do calculate layout height with scale factor**
```typescript
// CORRECT: Accounts for scaling
const layoutHeight = desiredVisibleHeight / scaleFactor;
containerRef.style.setProperty('height', `${layoutHeight}px`, 'important');
```

## Testing

### Verification Steps

1. Navigate to the maneuver timeseries page
2. Check browser console for height calculation logs
3. Verify container fills viewport height (minus header/legend)
4. Test at different viewport widths (scale factors change)
5. Verify scrolling reaches the bottom without excessive empty space
6. Test with different numbers of charts

### Expected Results

- Container height should be approximately: `(viewportHeight - header - legend - padding) / scaleFactor`
- Actual rendered height (scaled) should match: `layoutHeight * scaleFactor`
- No excessive empty space below last chart
- Smooth scrolling to bottom

## Related: Performance and Fleet Performance Page

The same formula (`layoutHeight = desiredVisibleHeight / scaleFactor`) is used for the **Performance** and **Fleet Performance** report pages. There, `.performance-charts-scroll-container` height is set in JavaScript inside `setupMediaContainerScaling` (in `frontend/utils/global.ts`), with `desiredVisibleHeight` = viewport − header − legend height − padding. This prevents scrollbar overflow and keeps the scroll viewport bounded. See [Performance Page Scroll Fix](./performance-page-scroll-fix.md) for the full fix (overflow, padding, and JS-driven scroll container height).

## Related Files

- `frontend/components/maneuvers/standard/TimeSeries.tsx` - Standard timeseries implementation
- `frontend/components/maneuvers/grouped/TimeSeries.tsx` - Grouped timeseries implementation
- `frontend/styles/Styles.css` - Container styling and padding
- `docs/frontend/page-scaling-strategy.md` - General page scaling documentation
- `docs/frontend/performance-page-scroll-fix.md` - Performance/Fleet Performance scroll and scaling fix

## History

- **Date Fixed**: January 2025
- **Issue**: Container only 55% of viewport height, excessive scroll space
- **Solution**: Dynamic height calculation accounting for CSS transform scale factor
- **Key Innovation**: Inverse scale factor formula for layout height calculation

---

**Last Updated**: January 2025  
**Author**: AI Assistant  
**Status**: Production Ready ✅