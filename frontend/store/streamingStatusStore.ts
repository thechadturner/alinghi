import { createSignal, onCleanup } from 'solid-js';
import { getData } from '../utils/global';
import { apiEndpoints } from '@config/env';
import { debug, warn, error as logError } from '../utils/console';

/**
 * Global Streaming Status Store
 * 
 * Maintains a global streaming status that refreshes every minute in the background.
 * Components can check this store instead of making API calls on every page load.
 */
class StreamingStatusStore {
  private statusSignal = createSignal<{
    isStreamingActive: boolean;
    hasStreaming: boolean;
    streamingStarted: boolean;
    sourceNames: string[];
    lastUpdated: number;
  }>({
    isStreamingActive: false,
    hasStreaming: false,
    streamingStarted: false,
    sourceNames: [],
    lastUpdated: 0,
  });

  private refreshInterval: number | null = null;
  private isRefreshing = false;
  private refreshIntervalMs = 60 * 1000; // 1 minute

  /**
   * Initialize the store and start background refresh
   */
  initialize(): void {
    if (this.refreshInterval !== null) {
      debug('[StreamingStatusStore] Already initialized');
      return;
    }

    debug('[StreamingStatusStore] Initializing streaming status store');
    
    // Do an initial refresh immediately
    this.refreshStatus();

    // Set up periodic refresh
    this.refreshInterval = window.setInterval(() => {
      this.refreshStatus();
    }, this.refreshIntervalMs);

    debug('[StreamingStatusStore] Started background refresh every', this.refreshIntervalMs, 'ms');
  }

  /**
   * Refresh the streaming status from the API
   */
  private async refreshStatus(): Promise<void> {
    // Prevent concurrent refreshes
    if (this.isRefreshing) {
      debug('[StreamingStatusStore] Refresh already in progress, skipping');
      return;
    }

    this.isRefreshing = true;

    try {
      const statusResponse = await getData(apiEndpoints.stream.status);
      
      const hasStreaming = statusResponse?.data?.hasStreaming === true;
      const streamingStarted = statusResponse?.data?.streamingStarted === true;
      const isStreamingActive = hasStreaming && streamingStarted;

      let sourceNames: string[] = [];

      // If streaming is active, fetch source names
      if (isStreamingActive && statusResponse?.success) {
        try {
          debug('[StreamingStatusStore] Streaming active, fetching source names');
          const sourcesResponse = await getData(apiEndpoints.stream.sources);
          
          if (sourcesResponse?.success && Array.isArray(sourcesResponse.data)) {
            sourceNames = sourcesResponse.data
              .map((s: any) => s.source_name)
              .filter((name: string) => name)
              .sort();
          }
        } catch (err) {
          warn('[StreamingStatusStore] Error fetching source names:', err);
          // Continue with empty source names - status is still active
        }
      }

      // Update the signal
      this.statusSignal[1]({
        isStreamingActive,
        hasStreaming,
        streamingStarted,
        sourceNames,
        lastUpdated: Date.now(),
      });
    } catch (err) {
      logError('[StreamingStatusStore] Error refreshing status:', err);
      
      // On error, assume no streaming (fail closed)
      this.statusSignal[1]({
        isStreamingActive: false,
        hasStreaming: false,
        streamingStarted: false,
        sourceNames: [],
        lastUpdated: Date.now(),
      });
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Get the current streaming status (reactive signal)
   */
  status() {
    return this.statusSignal[0];
  }

  /**
   * Check if streaming is currently active
   */
  isActive(): boolean {
    return this.statusSignal[0]().isStreamingActive;
  }

  /**
   * Get source names for active streaming
   */
  getSourceNames(): string[] {
    return this.statusSignal[0]().sourceNames;
  }

  /**
   * Manually trigger a refresh (useful for immediate updates)
   */
  async refresh(): Promise<void> {
    await this.refreshStatus();
  }

  /**
   * Cleanup - stop background refresh
   */
  cleanup(): void {
    if (this.refreshInterval !== null) {
      window.clearInterval(this.refreshInterval);
      this.refreshInterval = null;
      debug('[StreamingStatusStore] Cleaned up background refresh');
    }
  }
}

// Singleton instance
export const streamingStatusStore = new StreamingStatusStore();

// Initialize on module load
streamingStatusStore.initialize();

// Cleanup on page unload (if in browser)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    streamingStatusStore.cleanup();
  });
}
