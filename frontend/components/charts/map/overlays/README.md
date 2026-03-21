# Map Overlay System

A modular, lazy-loading overlay system for the Map component that allows adding visual layers without bloating the main bundle.

## Architecture Overview

The overlay system consists of:

1. **Registry** (`registry.ts`) - Central registration and management of overlays
2. **Types** (`types.ts`) - TypeScript interfaces and types
3. **OverlayManager** (`OverlayManager.tsx`) - Renders and manages active overlays
4. **Overlay Components** - Individual overlay implementations (e.g., `BadAirOverlay.tsx`)

## How It Works

1. **Registration**: Overlays are registered in `overlays/index.ts` with a lazy loader
2. **Toggling**: Overlays can be enabled/disabled via signals in `MapContainer`
3. **Lazy Loading**: Overlay components are only loaded when first enabled
4. **Rendering**: OverlayManager creates an SVG layer and renders enabled overlays as SolidJS components

## Adding a New Overlay

### Step 1: Create the Overlay Component

```tsx
// src/components/charts/map/overlays/MyOverlay.tsx
import { createEffect, onCleanup } from "solid-js";
import * as d3 from "d3";
import { BaseOverlayProps } from "./types";

export default function MyOverlay(props: BaseOverlayProps) {
  let overlayGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any> | null = null;

  createEffect(() => {
    if (!props.enabled || !props.svg || !props.map) return;

    // Create group for this overlay
    overlayGroup = props.svg
      .append("g")
      .attr("class", "my-overlay");

    // Your rendering logic here
    // Use props.map.project([lng, lat]) to convert coordinates
    // Use props.data to access track data
  });

  onCleanup(() => {
    if (overlayGroup) {
      overlayGroup.remove();
    }
  });

  return <></>;
}
```

### Step 2: Register the Overlay

```ts
// src/components/charts/map/overlays/index.ts
export function initializeOverlays() {
  // ... existing registrations ...

  overlayRegistry.register({
    key: "my-overlay",
    label: "My Overlay",
    loader: () => import("./MyOverlay"),
    defaultEnabled: false
  });
}
```

### Step 3: Add Toggle in MapContainer

```jsx
// src/components/charts/map/MapContainer.jsx

// Add signal
const [myOverlayEnabled, setMyOverlayEnabled] = createSignal(false);

// Add to PageSettings displayOptions
{ key: 'overlay-my-overlay', label: 'My Overlay', type: 'toggle', 
  signal: [myOverlayEnabled, setMyOverlayEnabled], values: [true] }

// Add to OverlayManager enabledStates
enabledStates={{
  'bad-air': { get: badAirEnabled, set: setBadAirEnabled },
  'my-overlay': { get: myOverlayEnabled, set: setMyOverlayEnabled },
}}
```

## API Reference

### BaseOverlayProps

```typescript
interface BaseOverlayProps {
  map: any;                    // Mapbox map instance
  mapContainer: HTMLElement | null;  // Map container element
  svg: d3.Selection<SVGSVGElement> | null;  // SVG overlay element
  data: TrackPoint[];         // Track data points
  enabled: boolean;           // Whether overlay is enabled
  width: number;              // Container width
  height: number;             // Container height
}
```

### TrackPoint

```typescript
interface TrackPoint {
  Datetime: string;
  Lng: number;
  Lat: number;
  TWD?: number;   // True wind direction
  TWS?: number;   // True wind speed
  HDG?: number;   // Heading
  BS?: number;    // Boat speed
  [key: string]: any;
}
```

## Current Overlays

- **BadAirOverlay** - Visualizes "bad air" zones based on wind propagation from track history

## Best Practices

1. **Use SVG groups**: Create a dedicated group for your overlay for easy cleanup
2. **Handle map projection**: Always use `props.map.project([lng, lat])` to convert coordinates
3. **Clean up properly**: Remove event listeners and DOM elements in `onCleanup`
4. **Throttle updates**: For expensive computations, throttle updates on map movement
5. **Handle missing data**: Check for required fields (TWD, TWS, etc.) before processing

