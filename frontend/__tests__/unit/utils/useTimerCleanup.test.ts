/**
 * useTimerCleanup Hook Unit Tests
 * 
 * Tests for the SolidJS timer cleanup hook
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { useTimerCleanup } from '../../../utils/useTimerCleanup';

describe('useTimerCleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it('should create and track timeouts', () => {
    const callback = vi.fn();
    
    createRoot((dispose) => {
      const { createTimeout } = useTimerCleanup('TestComponent');
      createTimeout(callback, 1000);
      
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);
      
      dispose();
    });
  });

  it('should create and track intervals', () => {
    const callback = vi.fn();
    
    createRoot((dispose) => {
      const { createInterval } = useTimerCleanup('TestComponent');
      createInterval(callback, 500);
      
      vi.advanceTimersByTime(1500);
      expect(callback).toHaveBeenCalledTimes(3);
      
      dispose();
    });
  });

  it('should clean up timeouts on component unmount', () => {
    const callback = vi.fn();
    
    createRoot((dispose) => {
      const { createTimeout } = useTimerCleanup('TestComponent');
      createTimeout(callback, 1000);
      
      // Dispose before timeout fires
      dispose();
      
      vi.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  it('should clean up intervals on component unmount', () => {
    const callback = vi.fn();
    
    createRoot((dispose) => {
      const { createInterval } = useTimerCleanup('TestComponent');
      createInterval(callback, 500);
      
      vi.advanceTimersByTime(250);
      expect(callback).not.toHaveBeenCalled();
      
      // Dispose before interval fires
      dispose();
      
      vi.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  it('should clean up multiple timers', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const callback3 = vi.fn();
    
    createRoot((dispose) => {
      const { createTimeout, createInterval } = useTimerCleanup('TestComponent');
      
      createTimeout(callback1, 1000);
      createTimeout(callback2, 2000);
      createInterval(callback3, 500);
      
      dispose();
      
      vi.advanceTimersByTime(3000);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
      expect(callback3).not.toHaveBeenCalled();
    });
  });

  it('should allow manual clearing of timeouts', () => {
    const callback = vi.fn();
    
    createRoot((dispose) => {
      const { createTimeout, clearTimeout: clearTimer } = useTimerCleanup('TestComponent');
      const timerId = createTimeout(callback, 1000);
      
      clearTimer(timerId);
      
      vi.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
      
      dispose();
    });
  });

  it('should allow manual clearing of intervals', () => {
    const callback = vi.fn();
    
    createRoot((dispose) => {
      const { createInterval, clearInterval: clearTimer } = useTimerCleanup('TestComponent');
      const intervalId = createInterval(callback, 500);
      
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(2);
      
      clearTimer(intervalId);
      
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(2); // No more calls
      
      dispose();
    });
  });

  it('should handle rapid timer creation and cleanup', () => {
    const callbacks = Array.from({ length: 10 }, () => vi.fn());
    
    createRoot((dispose) => {
      const { createTimeout } = useTimerCleanup('TestComponent');
      
      // Create many timers
      callbacks.forEach((callback, i) => {
        createTimeout(callback, (i + 1) * 100);
      });
      
      // Dispose before any fire
      dispose();
      
      vi.advanceTimersByTime(2000);
      callbacks.forEach(callback => {
        expect(callback).not.toHaveBeenCalled();
      });
    });
  });
});

