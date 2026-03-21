# Performance Page Scroll and Scaling Fix

## Problem

The Performance and Fleet Performance report pages had scrolling and scaling issues:

1. **Scroll bar overflowing**: The scroll viewport height was miscalculated, so the scrollbar extended beyond the visible area or behaved incorrectly.
2. **Conflicting overflow in media queries**: Desktop media queries (`min-width: 1001px`) set `overflow: visible` on `#media-container.performance-page`, overriding the intended design where scroll happens only inside `.performance-charts-scroll-inner`.
3. **Excessive padding on scroll container**: `.performance-charts-scroll-inner` had `padding-bottom: 400px`, which the existing docs say breaks scroll calculation and creates too much empty space.

## Solution Overview

1. **Keep overflow hidden on the media-container** at all breakpoints so the only scroll viewport is `.performance-charts-scroll-inner`.
2. **Reduce scroll-inner padding** from 400px to 80px (minimal room to scroll to the end without breaking scroll range).
3. **Set the scroll container height in JavaScript** using the same formula as the TimeSeries page: `layoutHeight = desiredVisibleHeight / scaleFactor`, so the scroll viewport has an explicit bounded height and the scrollbar stays within the visible area.

## Root Cause: Why Height Was Wrong

Performance and Fleet Performance use the same layout chain as the TimeSeries fix:

- `#main-content` (height: calc(100vh - 60px))
- `#media-container.performance-page` (width 1620px, height 100%, transform scale, **overflow hidden**)
- `.container` (flex: 1 1 auto)
- `.performance-legend-section` (flex: 0 0 auto)
- `.performance-charts-scroll-container` (flex: 1 1 auto, **height set by JS**)
- `.performance-charts-scroll-inner` (height 100%, overflow-y: auto) ← actual scroll viewport

When the scroll container height was left to CSS only (flex + `height: 100%`), the height could resolve incorrectly inside the scaled `#media-container`, so the scroll area was too tall and the scrollbar overflowed. Setting an explicit height in JS using the inverse-scale formula fixes this.

## Implementation

### 1. CSS: Overflow and Padding

**File:** `frontend/styles/Styles.css`

- **Media queries (1001px–1699px and 1700px+):** For `#media-container.performance-page` and `#media-container.fleet-performance-page`, use `overflow: hidden !important` (not `overflow: visible`). This keeps scroll only in `.performance-charts-scroll-inner`.
- **Scroll-inner padding:** For `.performance-page .performance-charts-scroll-inner` and `.fleet-performance-page .performance-charts-scroll-inner`, set `padding-bottom: 80px !important` (reduced from 400px). Avoid larger padding on the scroll container; see [maneuver-timeseries-scroll-fix.md](./maneuver-timeseries-scroll-fix.md).

### 2. JavaScript: Scroll Container Height

**File:** `frontend/utils/global.ts` (inside `setupMediaContainerScaling`, in `updateScale`)

For **performance-page** and **fleet-performance-page** only (not scatter or targets), after computing `scaleFactor` and clearing main-content height:

1. **Measure legend height:**  
   `const legendEl = mediaContainer.querySelector('.performance-legend-section');`  
   `const legendHeight = legendEl ? (legendEl as HTMLElement).getBoundingClientRect().height : 50;`

2. **Desired visible height** (viewport minus header, legend, and small padding):  
   `desiredVisibleHeight = viewportHeight - headerHeight (60) - legendHeight - 20`  
   Use `window.visualViewport.height` on mobile when available. Clamp to a minimum (e.g. 200px).

3. **Layout height (inverse of scale):**  
   `layoutHeight = desiredVisibleHeight / scaleFactor`  
   Same formula as [maneuver-timeseries-scroll-fix.md](./maneuver-timeseries-scroll-fix.md).

4. **Apply to scroll container:**  
   Set `.performance-charts-scroll-container` `height` and `max-height` to `layoutHeight` with `!important` so the scroll viewport is bounded and the scrollbar stays within the page.

Resize and scale updates are already handled by the existing `ResizeObserver` and `updateScale` calls, so the scroll area height stays correct when the window or scale factor changes.

## Key Formula (Same as TimeSeries)

```
layoutHeight = desiredVisibleHeight / scaleFactor
```

When the parent has `transform: scale(scaleFactor)`, a child that should occupy `desiredVisibleHeight` pixels on screen must be given **layout** height `desiredVisibleHeight / scaleFactor` so that after scaling it renders at the desired visible height.

## Files Touched

| File | Change |
|------|--------|
| `frontend/styles/Styles.css` | Overflow `hidden` for Performance/FleetPerformance in desktop media queries; `padding-bottom: 80px` on `.performance-charts-scroll-inner` (and fleet equivalent). |
| `frontend/utils/global.ts` | In `updateScale`, for performance-page and fleet-performance-page: measure legend, compute `desiredVisibleHeight` and `layoutHeight`, set `.performance-charts-scroll-container` height/max-height. |

## Testing

- [ ] Open Performance report (dataset-level) at 1200px, 1600px, 1920px width; only the charts area scrolls; scrollbar stays within the page; can scroll to the last chart without a large gap.
- [ ] Same for Fleet Performance (day-level).
- [ ] Resize window; scroll container height updates and scrollbar behavior remains correct.
- [ ] Scale factor changes (narrow/wide) do not cause scrollbar overflow.

## Related Documentation

- [Page Scaling Strategy](./page-scaling-strategy.md) – Overall scaling approach and inverse-scale formula.
- [Maneuver TimeSeries Container Height Fix](./maneuver-timeseries-scroll-fix.md) – Same `layoutHeight = desiredVisibleHeight / scaleFactor` pattern for TimeSeries; Performance/Fleet Performance reuse it for `.performance-charts-scroll-container`.

---

**Last Updated:** January 2025  
**Status:** Production Ready
