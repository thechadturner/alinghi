# D3 TypeScript Conversion Guide

This document outlines the key learnings and patterns for converting D3.js code to TypeScript, based on the conversion of PerfScatter.tsx, FleetScatter.tsx, and ManeuverScatter.tsx.

## Type Declarations

### d3-regression Module

The `d3-regression` library requires a custom type declaration file. Create `frontend/types/d3-regression.d.ts`:

```typescript
declare module 'd3-regression' {
  import { Accessor } from 'd3';

  export interface RegressionResult {
    a?: number;
    b?: number;
    c?: number;
    r2?: number;
    points: Array<[number, number]>;
  }

  export interface Regression {
    x(accessor: Accessor<number, any>): this;
    y(accessor: Accessor<number, any>): this;
    bandwidth(value: number): this;
    (data: any[]): Array<[number, number]>; // Returns array directly, not object
  }

  export function regressionLog(): Regression;
  export function regressionLoess(): Regression;
}
```

**Key Point**: The regression functions return `Array<[number, number]>` directly, NOT an object with a `.points` property. Use `.map(([x, y]) => ({ x, y }))` directly on the result.

## Common TypeScript Issues and Solutions

### 1. Implicit `any` Types

**Problem**: TypeScript requires explicit types for all function parameters.

**Solution**: Add explicit types to all function parameters:

```typescript
// Before
function reduceData(collection, x, y) { ... }

// After
function reduceData(collection: any[], x: string, y: string): any[] { ... }
```

### 2. D3 Axis tickFormat

**Problem**: D3's `tickFormat` expects either `null` or a function, not an empty string.

**Solution**: Use a function that returns an empty string:

```typescript
// For grid lines without labels
.call(d3.axisBottom(xScale)
  .ticks(5)
  .tickSize(-chartHeight)
  .tickFormat(() => "")  // Function, not string
)
```

### 3. CSS Properties in JSX Style Objects

**Problem**: React/SolidJS style objects require kebab-case properties to be quoted.

**Solution**: Use quoted kebab-case for CSS properties:

```typescript
// Before
style={{
  borderRadius: "4px",
  fontSize: "14px",
  zIndex: 1000
}}

// After
style={{
  "border-radius": "4px",
  "font-size": "14px",
  "z-index": 1000,
  "pointer-events": "none"
}}
```

### 4. Window.resizeTimeout

**Problem**: `window.resizeTimeout` doesn't exist on the Window type.

**Solution**: Use a local variable with proper typing:

```typescript
// Before
clearTimeout(window.resizeTimeout);
window.resizeTimeout = setTimeout(() => { ... }, 150);

// After
let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
if (resizeTimeout) {
  clearTimeout(resizeTimeout);
}
resizeTimeout = setTimeout(() => { ... }, 150);
```

### 5. Event Target Type Casting

**Problem**: `event.target` is typed as `EventTarget`, which doesn't have properties like `tagName` or `isContentEditable`.

**Solution**: Cast to `HTMLElement`:

```typescript
// Before
const target = event.target;
if (target && target.tagName === 'INPUT') { ... }

// After
const target = event.target as HTMLElement | null;
if (target && target.tagName === 'INPUT') { ... }
```

### 6. D3 ScaleLinear with String Ranges

**Problem**: D3's `scaleLinear` with string ranges (for colors) doesn't match TypeScript's strict typing.

**Solution**: Use `@ts-ignore` comment or proper type annotation:

```typescript
let color: d3.ScaleLinear<number, string, never>;
if (isDark()) {
  // @ts-ignore - D3 scaleLinear accepts string ranges for color scales
  color = d3.scaleLinear<number, string, never>()
    .domain([dExtent[0] || 0, (dExtent[1] || 0) * 0.6])
    .range(["#9ca3af", "#ffffff"]);
}
```

### 7. Undefined Function Types

**Problem**: Functions that might be undefined need optional chaining.

**Solution**: Use optional chaining when calling potentially undefined functions:

```typescript
// Before
.style("stroke", (d) => getStrokeColor(d))

// After
.style("stroke", (d: any) => getStrokeColor?.(d) || "black")
```

### 8. D3 Selection Data Types

**Problem**: D3 selections return `unknown` type for data.

**Solution**: Type cast in callbacks:

```typescript
// Before
d3.selectAll(".scatter").each(function(d) {
  if (selected.includes(d.ID)) { ... }
});

// After
d3.selectAll(".scatter").each(function(d: any) {
  if (selected.includes(d.ID)) { ... }
});
```

### 9. Chart Reference Types

**Problem**: Chart refs might be `HTMLDivElement` but typed as `SVGSVGElement`.

**Solution**: Use proper type casting:

```typescript
// Before
let chartRef: SVGSVGElement | null = null;
ref={(el) => { chartRef = el }}

// After
let chartRef: HTMLDivElement | null = null;
ref={(el) => { chartRef = el as HTMLDivElement }}
```

### 10. Regression Function Usage

**Problem**: Regression functions return arrays directly, not objects.

**Solution**: Map directly on the result:

```typescript
// Before (WRONG)
fitValues = loess(xyValues).points.map(([x, y]) => ({ x, y }));

// After (CORRECT)
fitValues = loess(xyValues).map(([x, y]: [number, number]) => ({ x, y }));
```

## Best Practices

1. **Remove Unused Imports**: Clean up imports that are no longer used after type fixes.

2. **Explicit Return Types**: Always specify return types for functions to catch errors early.

3. **Type Guards**: Use type guards or optional chaining for potentially undefined values.

4. **Consistent Naming**: Use consistent naming for data types (e.g., `any[]` for data arrays).

5. **Error Handling**: Wrap D3 operations in try-catch blocks where appropriate.

6. **Cleanup**: Always clean up timers, workers, and event listeners in `onCleanup`.

## Common Patterns

### Grid Lines Without Labels

```typescript
chart.append("g")
  .attr("class","grid")
  .attr("transform","translate(0," + chartHeight + ")")
  .style("stroke-dasharray",("3,3"))
  .call(d3.axisBottom(xScale)
    .ticks(5)
    .tickSize(-chartHeight)
    .tickFormat(() => "")  // Empty function to hide labels
  )
```

### Axis Labels Positioning

```typescript
// Remove existing labels first
svg.selectAll(".x-label, .y-label").remove();

// Add labels to SVG (not chart group) with margin offsets
svg.append("text")
  .attr("class", "y-label chart-element")
  .attr("text-anchor", "left")
  .attr("transform", `translate(${margin.left + 30},${margin.top + 10})`)
  .attr("font-size", "16px")
  .text(yaxis.toUpperCase())
```

### Worker Cleanup

```typescript
onCleanup(() => {
  if (lassoWorker) {
    lassoWorker.terminate();
    lassoWorker = null;
  }
  // ... other cleanup
});
```

## Testing Checklist

After conversion, verify:
- [ ] No TypeScript errors (only intentional warnings)
- [ ] Chart renders correctly
- [ ] Grid lines display without labels
- [ ] Axis labels appear only once
- [ ] Regression lines work correctly
- [ ] Lasso selection works
- [ ] Hover effects work
- [ ] Click selection works
- [ ] Resize handling works
- [ ] Cleanup prevents memory leaks

