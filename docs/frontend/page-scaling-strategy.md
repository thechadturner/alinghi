# Page Scaling Strategy Documentation

## Overview

This document outlines the comprehensive page scaling strategy implemented in RaceSight to provide responsive, zoom-out behavior across all screen sizes while maintaining proper scrolling and content visibility.

## The Problem We Solved

### Initial Incorrect Approach
The original implementation used `height: calc(100vh * var(--scale-factor))` which was mathematically incorrect:

- **Small screens** (scale-factor = 0.5): `100vh * 0.5 = 50vh` → Content cut off
- **Wide screens** (scale-factor = 1): `100vh * 1 = 100vh` → Still cut off due to header

### The Real Issue
When content is scaled DOWN by CSS transform, it needs MORE layout space, not less. The visual scaling and layout space requirements are inversely related.

## The Correct Solution

### Core Principles

1. **Consistent Layout Height**: Always use `calc(100vh - 60px)` to account for header
2. **Visual Scaling Only**: Use CSS `transform: scale()` for visual scaling
3. **Proper Overflow Handling**: Enable scrolling through body/html classes
4. **No Math in Height**: Never use scale-factor in height calculations

### Implementation Strategy

#### 1. Scale Factor Calculation
```javascript
const scaleFactor = Math.min(containerWidth / baseWidth, 1);
// baseWidth = 1620px
// scaleFactor ranges from 0.1 to 1.0
```

#### 2. CSS Container Setup
```css
#media-container {
  width: 1620px; /* Fixed base width */
  height: calc(100vh - 60px); /* Consistent height, no scale-factor */
  min-height: calc(100vh - 60px);
  max-height: none;
  overflow: visible; /* Allow scaled content to be visible */
  transform: scale(var(--scale-factor, 1)); /* Visual scaling only */
  transform-origin: top left;
}
```

#### 3. Scrolling Enablement
```css
/* Enable scrolling for scaled pages */
body.scaling-page {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  height: auto !important;
}

html.scaling-page {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  height: auto !important;
}
```

#### 4. JavaScript Integration
```javascript
// Add scaling classes to enable scrolling
document.body.classList.add('scaling-page');
document.documentElement.classList.add('scaling-page');

// Cleanup on unmount
document.body.classList.remove('scaling-page');
document.documentElement.classList.remove('scaling-page');
```

## Why This Works

### The Math
- **Wide screens** (scale-factor = 1): Content at 100% scale, normal scrolling
- **Narrow screens** (scale-factor = 0.5): Content visually 50% size, but layout space remains 100vh-60px
- **Result**: Scaled content fits in viewport, excess content scrolls properly

### Key Insights
1. **Transform scaling is purely visual** - it doesn't affect layout calculations
2. **Layout space must remain constant** - don't divide by scale-factor
3. **Overflow handling is crucial** - body must be scrollable
4. **Header height matters** - always subtract 60px for header

## Implementation Checklist

### CSS Changes Required
- [ ] Use `calc(100vh - 60px)` for all media-container heights
- [ ] Never use `calc(100vh / var(--scale-factor))` or similar
- [ ] Add `overflow: visible` to media-containers
- [ ] Add `scaling-page` CSS classes for body/html
- [ ] Apply to all page types: maneuvers, timeseries, scatter, etc.
- [ ] Apply to all breakpoints: desktop, tablet, mobile

### JavaScript Changes Required
- [ ] Add `scaling-page` class to both body and html elements
- [ ] Remove classes on cleanup
- [ ] Apply to all scaling pages consistently

### Testing Scenarios
- [ ] Full screen (1920px+): No scaling, normal scrolling
- [ ] Desktop (1200px): Slight scaling, proper scrolling
- [ ] Tablet (768px): Medium scaling, proper scrolling
- [ ] Mobile (375px): Heavy scaling, proper scrolling
- [ ] Verify no content cutoff at any size
- [ ] Verify no empty scroll space

## Common Pitfalls to Avoid

### ❌ Wrong Approaches
```css
/* DON'T: Use scale-factor in height calculations */
height: calc(100vh / var(--scale-factor, 1));
height: calc(100vh * var(--scale-factor, 1));

/* DON'T: Forget header height */
height: 100vh; /* Should be calc(100vh - 60px) */

/* DON'T: Disable overflow */
overflow: hidden; /* Should be visible */

/* DON'T: Add padding to scroll containers */
body.scaling-page #main-content {
  padding-bottom: 100px; /* This breaks scroll calculation! */
}
```

**Note:** For details on scroll container padding issues, see [Maneuver TimeSeries Scroll Fix](./maneuver-timeseries-scroll-fix.md).

### ✅ Correct Approaches
```css
/* DO: Use consistent height with header offset */
height: calc(100vh - 60px);

/* DO: Enable overflow for scaled content */
overflow: visible;

/* DO: Use transform for visual scaling only */
transform: scale(var(--scale-factor, 1));
```

## Calculating Heights for Scaled Child Containers

### The Challenge

When you have a child container inside a parent that has `transform: scale()` applied, setting the child's height requires special consideration. The child container is visually scaled, but its layout space requirements are different.

### The Solution: Inverse Scale Factor Formula

**Key Formula:**
```
layoutHeight = desiredVisibleHeight / scaleFactor
```

When content is scaled down (e.g., scale = 0.556), you need MORE layout height to achieve the desired visible height.

**Example:**
- Desired visible height: 734px
- Scale factor: 0.556
- Required layout height: 734 / 0.556 = 1321px

### Implementation Pattern

```typescript
const updateContainerHeight = () => {
  if (!containerRef) return;
  
  // 1. Find the scaled parent container
  let parent = containerRef.parentElement;
  let scaledParent: HTMLElement | null = null;
  while (parent) {
    if (parent.id === 'media-container') { // or your scaled parent
      scaledParent = parent;
      break;
    }
    parent = parent.parentElement;
  }
  
  // 2. Extract scale factor from transform matrix
  let scaleFactor = 1;
  if (scaledParent) {
    const transform = getComputedStyle(scaledParent).transform;
    if (transform && transform !== 'none') {
      const matrix = transform.match(/matrix\(([^)]+)\)/);
      if (matrix) {
        const values = matrix[1].split(',').map(v => parseFloat(v.trim()));
        if (values.length >= 4) {
          scaleFactor = values[0]; // scaleX is first value
        }
      }
    }
  }
  
  // 3. Calculate desired visible height
  const headerHeight = 60;
  const otherElementsHeight = 100; // legend, padding, etc.
  const desiredVisibleHeight = window.innerHeight - headerHeight - otherElementsHeight;
  
  // 4. Calculate layout height (inverse of scale)
  const layoutHeight = desiredVisibleHeight / scaleFactor;
  
  // 5. Set height with !important to override CSS
  containerRef.style.setProperty('height', `${layoutHeight}px`, 'important');
  
  // 6. Ensure parent can accommodate (if needed)
  const parentContainer = document.getElementById('parent-container-id');
  if (parentContainer) {
    parentContainer.style.setProperty('min-height', `${layoutHeight}px`, 'important');
    parentContainer.style.setProperty('height', 'auto', 'important');
  }
};
```

### When to Use This Pattern

Use this approach when:
- ✅ Child container needs to fill viewport height
- ✅ Parent has `transform: scale()` applied
- ✅ Container height must be calculated dynamically
- ✅ Height needs to adapt to different scale factors

### Common Mistakes

❌ **Using viewport height directly**
```typescript
// WRONG: Doesn't account for scaling
containerRef.style.height = `${window.innerHeight}px`;
```

❌ **Multiplying by scale factor**
```typescript
// WRONG: This makes it even smaller!
containerRef.style.height = `${desiredHeight * scaleFactor}px`;
```

✅ **Dividing by scale factor**
```typescript
// CORRECT: Inverse relationship
containerRef.style.height = `${desiredHeight / scaleFactor}px`;
```

### Debugging

Add logging to verify calculations:

```typescript
console.log('Height calculation:', {
  windowInnerHeight: window.innerHeight,
  scaleFactor,
  desiredVisibleHeight,
  layoutHeight,
  actualRenderedHeight: containerRef.getBoundingClientRect().height
});
```

**Expected relationship:**
- `actualRenderedHeight ≈ layoutHeight * scaleFactor`
- If they don't match, check for parent constraints or CSS overrides

For a complete example, see [Maneuver TimeSeries Container Height Fix](./maneuver-timeseries-scroll-fix.md).

## Maintenance Notes

### When Adding New Scaling Pages
1. Copy the CSS pattern from existing pages
2. Use `calc(100vh - 60px)` for height
3. Add `scaling-page` class management in JavaScript
4. Test at multiple screen sizes

### When Modifying Header Height
1. Update the `60px` value in all height calculations
2. Update the header height constant in CSS
3. Test all scaling pages

### When Adding New Breakpoints
1. Apply the same height calculation pattern
2. Ensure `overflow: visible` is maintained
3. Test scaling behavior at the new breakpoint

## Performance Considerations

- **Transform scaling is GPU-accelerated** - very performant
- **ResizeObserver** handles dynamic scaling efficiently
- **CSS custom properties** provide smooth scaling updates
- **No layout recalculations** - only visual transforms

## Browser Compatibility

- **Modern browsers**: Full support for transform and calc()
- **IE11**: May need fallbacks for calc() in some contexts
- **Mobile browsers**: Excellent support for scaling transforms

## Split View Scaling

### The Problem

When components with `media-container` elements are opened in split view (using Ctrl+click to open in the right panel), they were not scaling properly because:

1. **Wrong Container Reference**: The scaling logic was looking for `#main-content` or `parentElement`, but in split view, components are rendered inside `.split-panel` containers
2. **Incorrect Width Calculation**: The scale factor was calculated based on the full window width instead of the split panel width
3. **Missing ResizeObserver Target**: The ResizeObserver was watching the wrong element, so it didn't update when split panels were resized

### The Solution

The scaling logic now detects and adapts to split view by checking for the correct container in order of priority:

```javascript
// Find the appropriate reference container:
// 1. In split view: use the split-panel
// 2. Otherwise: use #main-content or parentElement
const splitPanel = mediaContainer.closest('.split-panel');
const mainContent = mediaContainer.closest('#main-content');
const reference = splitPanel || mainContent || mediaContainer.parentElement;
```

#### Implementation Pattern

All components with `media-container` now use this pattern:

```javascript
const updateScale = () => {
  const mediaContainer = document.getElementById('media-container');
  if (!mediaContainer) return;
  
  // Find the appropriate reference container
  const splitPanel = mediaContainer.closest('.split-panel');
  const mainContent = mediaContainer.closest('#main-content');
  const reference = splitPanel || mainContent || mediaContainer.parentElement;
  if (!reference) return;
  
  const containerWidth = reference.clientWidth;
  const baseWidth = 1620;
  const scaleFactor = Math.min(containerWidth / baseWidth, 1);
  
  document.documentElement.style.setProperty('--scale-factor', scaleFactor);
};

// ResizeObserver must also observe the correct container
const resizeObserver = new ResizeObserver(() => {
  updateScale();
});

const mediaContainer = document.getElementById('media-container');
if (mediaContainer) {
  const splitPanel = mediaContainer.closest('.split-panel');
  const mainContent = mediaContainer.closest('#main-content');
  const reference = splitPanel || mainContent || mediaContainer.parentElement;
  if (reference) {
    resizeObserver.observe(reference); // Observe the correct container!
  }
}
```

### Components Updated

The following components have been updated with split view scaling support:

- `src/reports/ac75/dataset/reports/Performance.jsx`
- `src/reports/ac75/dataset/reports/Maneuvers.jsx`
- `src/reports/ac75/dataset/reports/ManeuverWindow.jsx`

### Key Points

1. **Priority Order**: Always check for `.split-panel` first, then fall back to `#main-content` or `parentElement`
2. **ResizeObserver Target**: Must observe the same reference container used for width calculation
3. **Automatic Adaptation**: Components automatically adapt to single view vs split view without additional configuration
4. **Panel Resizing**: When split panels are resized, the ResizeObserver automatically triggers scale updates

### Testing Split View Scaling

- [ ] Open component in single view - verify scaling works
- [ ] Open component in split view (Ctrl+click) - verify it scales to panel width
- [ ] Resize split panels - verify scaling updates dynamically
- [ ] Switch between single and split view - verify scaling adapts correctly
- [ ] Test with narrow split panels - verify content scales appropriately

## Future Enhancements

### Potential Improvements
1. **Dynamic header height detection** instead of hardcoded 60px
2. **Smooth scaling transitions** for resize events
3. **Scale factor limits** to prevent extreme scaling
4. **Accessibility considerations** for scaled content

### Monitoring
- Track scaling performance across devices
- Monitor scroll behavior on different screen sizes
- Validate content visibility at all scale factors
- Test split view scaling across different panel widths

## Performance and Fleet Performance Page Scroll

Performance and Fleet Performance use an **inner scroll** model: scroll happens only in `.performance-charts-scroll-inner`, not on `#main-content`. To avoid scrollbar overflow and miscalculated height:

1. **CSS:** Keep `overflow: hidden` on `#media-container.performance-page` and `#media-container.fleet-performance-page` at all breakpoints (including desktop media queries). Do not use `overflow: visible` for these pages.
2. **CSS:** Use minimal padding on the scroll container (e.g. `padding-bottom: 80px` on `.performance-charts-scroll-inner`); avoid large values (e.g. 400px) that break scroll calculation.
3. **JavaScript:** Set `.performance-charts-scroll-container` height in `setupMediaContainerScaling` using the same formula as TimeSeries: `layoutHeight = desiredVisibleHeight / scaleFactor`, where `desiredVisibleHeight` = viewport − header (60px) − legend height − padding. This gives an explicit bounded scroll viewport so the scrollbar stays within the page.

See [Performance Page Scroll Fix](./performance-page-scroll-fix.md) for the full problem, solution, and implementation details.

## Related Documentation

- [Performance Page Scroll Fix](./performance-page-scroll-fix.md) - How scrolling and scaling were fixed for Performance and Fleet Performance (overflow, padding, JS-driven scroll container height)
- [Maneuver TimeSeries Container Height Fix](./maneuver-timeseries-scroll-fix.md) - Detailed example of calculating heights for scaled containers (same inverse-scale formula)

---

**Last Updated**: January 2025  
**Author**: AI Assistant  
**Status**: Production Ready ✅
