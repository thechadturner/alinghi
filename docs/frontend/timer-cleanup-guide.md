# Timer Cleanup Guide

## Overview

This guide covers best practices for managing timers (setTimeout, setInterval) in SolidJS components to prevent memory leaks.

## The Problem

Timers that aren't cleaned up can cause:
- **Memory leaks**: Timer callbacks hold references to component state
- **Performance issues**: Timers continue running after component unmount
- **Unexpected behavior**: Callbacks execute on unmounted components

## Best Practices

### 1. Always Store Timer IDs

```typescript
// ❌ BAD - No way to clean up
setTimeout(() => {
  doSomething();
}, 1000);

// ✅ GOOD - Store ID for cleanup
let timerId: ReturnType<typeof setTimeout> | null = null;
timerId = setTimeout(() => {
  doSomething();
}, 1000);
```

### 2. Clean Up in onCleanup

```typescript
import { onCleanup } from 'solid-js';

const MyComponent = () => {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  
  timerId = setTimeout(() => {
    // Do something
  }, 1000);
  
  onCleanup(() => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  });
};
```

### 3. Use the useTimerCleanup Hook (Recommended)

The `useTimerCleanup` hook automatically tracks and cleans up all timers:

```typescript
import { useTimerCleanup } from '../../utils/useTimerCleanup';

const MyComponent = () => {
  const { createTimeout, createInterval } = useTimerCleanup('MyComponent');
  
  // Timers are automatically cleaned up on unmount
  createTimeout(() => {
    console.log('This will be cleaned up automatically');
  }, 1000);
  
  const intervalId = createInterval(() => {
    console.log('This interval will be cleaned up automatically');
  }, 5000);
  
  // Can still manually clear if needed
  // clearInterval(intervalId);
};
```

## Common Patterns

### Debouncing

```typescript
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const handleInput = (value: string) => {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    processInput(value);
  }, 300);
};

onCleanup(() => {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
});
```

### Periodic Checks

```typescript
let checkInterval: ReturnType<typeof setInterval> | null = null;

onMount(() => {
  checkInterval = setInterval(() => {
    checkSomething();
  }, 1000);
});

onCleanup(() => {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
});
```

### Animation Frames

```typescript
let animationFrameId: number | null = null;

const animate = () => {
  // Animation logic
  animationFrameId = requestAnimationFrame(animate);
};

onMount(() => {
  animate();
});

onCleanup(() => {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
});
```

## Audit Checklist

When reviewing components for timer cleanup:

- [ ] All `setTimeout` calls store the timer ID
- [ ] All `setInterval` calls store the timer ID
- [ ] All `requestAnimationFrame` calls store the frame ID
- [ ] All timer IDs are cleared in `onCleanup`
- [ ] Timer IDs are set to `null` after clearing
- [ ] No timers are created in effects without cleanup
- [ ] Debounce timers are cleared before creating new ones

## Timer Audit Utility

For debugging, use the timer audit utility:

```typescript
import { timerAudit } from '../../utils/timerAudit';

// Enable tracking (automatically enabled in dev mode)
timerAudit.enable();

// Register a timer
timerAudit.registerTimer(
  'my-timer',
  'timeout',
  () => clearTimeout(timerId),
  'MyComponent'
);

// Get active timers
const activeTimers = timerAudit.getActiveTimers();
console.log('Active timers:', activeTimers);

// Get stats
const stats = timerAudit.getStats();
console.log('Timer stats:', stats);
```

In development, the audit utility is available on `window.timerAudit`:

```javascript
// In browser console
window.timerAudit.getActiveTimers();
window.timerAudit.getStats();
```

## Component Audit Results

### TimeSeries Component
- ✅ `chartEffectTimeout` - Cleaned up
- ✅ `mapFilterEffectTimeout` - Cleaned up
- ✅ `selectedRangeReloadTimeout` - Cleaned up
- ✅ `cutEventsReloadTimeout` - Cleaned up
- ✅ `resizeTimeout` - Cleaned up
- ✅ `animationFrameId` - Cleaned up
- ✅ `window.timeSeriesPeriodicCheck` - Cleaned up
- ⚠️ Multiple fire-and-forget `setTimeout` calls (acceptable for one-time delays)

### MapContainer Component
- ✅ `loadingTimeout` - Cleaned up
- ✅ `resizeTimeout` - Cleaned up
- ✅ `tilesAvailabilityTimeout` - Cleaned up
- ✅ `window.mapPeriodicCheck` - Cleaned up
- ✅ `setInterval` in effect has cleanup return function
- ⚠️ Multiple fire-and-forget `setTimeout` calls (acceptable for one-time delays)

## Fire-and-Forget Timers

Some timers are intentionally fire-and-forget (one-time delays that don't need cleanup):

```typescript
// Acceptable - one-time delay, callback doesn't reference component state
setTimeout(() => {
  window.someGlobalFunction();
}, 100);
```

However, if the callback references component state or could execute after unmount, it should be tracked:

```typescript
// ❌ BAD - References component state
setTimeout(() => {
  setSomeState(newValue); // Could execute after unmount
}, 100);

// ✅ GOOD - Tracked and cleaned up
let timerId = setTimeout(() => {
  setSomeState(newValue);
}, 100);
onCleanup(() => {
  if (timerId) clearTimeout(timerId);
});
```

## Troubleshooting

### Timer Still Running After Unmount

1. Check if timer ID is stored
2. Verify cleanup is called in `onCleanup`
3. Use timer audit utility to find active timers
4. Check browser DevTools Performance tab for active timers

### Memory Leak Suspected

1. Enable timer audit: `timerAudit.enable()`
2. Navigate through components
3. Check `timerAudit.getActiveTimers()` for orphaned timers
4. Review component cleanup code

### Performance Issues

1. Check for too many active timers: `timerAudit.getStats()`
2. Look for timers with very short intervals
3. Consider debouncing or throttling
4. Use `requestAnimationFrame` for visual updates instead of `setInterval`

## Related Documentation

- [SolidJS onCleanup](https://www.solidjs.com/docs/latest/api#oncleanup)
- [Frontend Architecture](./frontend-architecture.md)
- [Performance Review](../optimization/ARCHITECTURE_PERFORMANCE_REVIEW.md)

