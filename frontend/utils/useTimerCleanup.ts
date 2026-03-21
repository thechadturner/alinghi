/**
 * SolidJS Hook for Timer Cleanup
 * 
 * Automatically tracks and cleans up timers (setTimeout, setInterval)
 * when a component unmounts. This prevents memory leaks from timers
 * that aren't properly cleaned up.
 * 
 * Usage:
 * ```typescript
 * const { createTimeout, createInterval } = useTimerCleanup();
 * 
 * const timer = createTimeout(() => {
 *   console.log('Timer fired');
 * }, 1000);
 * 
 * // Timer will be automatically cleaned up on component unmount
 * ```
 */

import { onCleanup } from 'solid-js';

export interface TimerCleanupHook {
  createTimeout: (callback: () => void, delay: number) => number;
  createInterval: (callback: () => void, delay: number) => number;
  clearTimeout: (id: number) => void;
  clearInterval: (id: number) => void;
}

export function useTimerCleanup(componentName?: string): TimerCleanupHook {
  const timeouts: number[] = [];
  const intervals: number[] = [];

  const createTimeout = (callback: () => void, delay: number): number => {
    const id = window.setTimeout(callback, delay);
    timeouts.push(id);
    return id;
  };

  const createInterval = (callback: () => void, delay: number): number => {
    const id = window.setInterval(callback, delay);
    intervals.push(id);
    return id;
  };

  const clearTimeout = (id: number): void => {
    window.clearTimeout(id);
    const index = timeouts.indexOf(id);
    if (index > -1) {
      timeouts.splice(index, 1);
    }
  };

  const clearInterval = (id: number): void => {
    window.clearInterval(id);
    const index = intervals.indexOf(id);
    if (index > -1) {
      intervals.splice(index, 1);
    }
  };

  // Cleanup all timers on component unmount
  onCleanup(() => {
    timeouts.forEach(id => {
      window.clearTimeout(id);
    });
    intervals.forEach(id => {
      window.clearInterval(id);
    });
    timeouts.length = 0;
    intervals.length = 0;
  });

  return {
    createTimeout,
    createInterval,
    clearTimeout,
    clearInterval
  };
}

