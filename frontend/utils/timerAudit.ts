/**
 * Timer Audit Utility
 * 
 * Tracks all active timers (setTimeout, setInterval) to help identify
 * potential memory leaks from timers that aren't cleaned up.
 * 
 * This is a development/debugging tool. In production, components should
 * use the useTimerCleanup hook for automatic cleanup.
 */

import { warn, error as logError } from './console';

export interface TimerInfo {
  id: string;
  type: 'timeout' | 'interval';
  cleanup: () => void;
  component?: string;
  createdAt: number;
}

class TimerAuditManager {
  private timers: Map<string, TimerInfo> = new Map();
  private isEnabled: boolean = false;

  /**
   * Enable timer tracking
   */
  enable(): void {
    this.isEnabled = true;
  }

  /**
   * Disable timer tracking
   */
  disable(): void {
    this.isEnabled = false;
  }

  /**
   * Register a timer for tracking
   * @param id Unique identifier for the timer
   * @param type Type of timer (timeout or interval)
   * @param cleanup Function to call to clean up the timer
   * @param component Optional component name for context
   */
  registerTimer(
    id: string,
    type: 'timeout' | 'interval',
    cleanup: () => void,
    component?: string
  ): void {
    if (!this.isEnabled) return;

    if (this.timers.has(id)) {
      warn(`[TimerAudit] Timer ${id} already registered, overwriting`);
    }

    this.timers.set(id, {
      id,
      type,
      cleanup,
      component,
      createdAt: Date.now()
    });
  }

  /**
   * Unregister a timer
   * @param id Timer identifier
   */
  unregisterTimer(id: string): void {
    if (!this.isEnabled) return;
    this.timers.delete(id);
  }

  /**
   * Get all active timers
   * @returns Array of timer information
   */
  getActiveTimers(): TimerInfo[] {
    return Array.from(this.timers.values());
  }

  /**
   * Get active timers for a specific component
   * @param component Component name
   * @returns Array of timer information
   */
  getTimersForComponent(component: string): TimerInfo[] {
    return Array.from(this.timers.values()).filter(
      timer => timer.component === component
    );
  }

  /**
   * Clean up all registered timers
   * WARNING: This will actually call cleanup functions - use with caution
   */
  cleanupAllTimers(): void {
    const timers = Array.from(this.timers.values());
    timers.forEach(timer => {
      try {
        timer.cleanup();
      } catch (error) {
        logError(`[TimerAudit] Error cleaning up timer ${timer.id}:`, error);
      }
    });
    this.timers.clear();
  }

  /**
   * Get summary statistics
   */
  getStats(): {
    total: number;
    byType: { timeout: number; interval: number };
    byComponent: Record<string, number>;
    oldest: TimerInfo | null;
  } {
    const timers = Array.from(this.timers.values());
    const byType = {
      timeout: timers.filter(t => t.type === 'timeout').length,
      interval: timers.filter(t => t.type === 'interval').length
    };

    const byComponent: Record<string, number> = {};
    timers.forEach(timer => {
      const comp = timer.component || 'unknown';
      byComponent[comp] = (byComponent[comp] || 0) + 1;
    });

    const oldest = timers.length > 0
      ? timers.reduce((oldest, current) =>
          current.createdAt < oldest.createdAt ? current : oldest
        )
      : null;

    return {
      total: timers.length,
      byType,
      byComponent,
      oldest
    };
  }

  /**
   * Clear all timer registrations (without calling cleanup)
   */
  clear(): void {
    this.timers.clear();
  }
}

// Singleton instance
export const timerAudit = new TimerAuditManager();

// Enable in development mode
if (import.meta.env.DEV) {
  timerAudit.enable();
  
  // Expose to window for debugging
  if (typeof window !== 'undefined') {
    (window as any).timerAudit = timerAudit;
  }
}

