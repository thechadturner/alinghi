/**
 * Live Config Store
 *
 * Fetches stream config (poll interval, buffer) from GET /api/stream/config
 * and exposes pollIntervalMs / bufferMs for InfluxDB poll, WebSocket broadcast,
 * frontend buffer, and local timer. Fetched once when entering live mode or on first access.
 */

import { createSignal } from 'solid-js';
import { apiEndpoints } from '@config/env';
import { getData } from '../utils/global';
import { debug, warn } from '../utils/console';

const DEFAULT_POLL_INTERVAL_MS = 5000;

const [pollIntervalMs, setPollIntervalMs] = createSignal(DEFAULT_POLL_INTERVAL_MS);
const [bufferMs, setBufferMs] = createSignal(DEFAULT_POLL_INTERVAL_MS);
const [isLoaded, setIsLoaded] = createSignal(false);
let fetchPromise: Promise<void> | null = null;

/**
 * Fetch stream config from server. Safe to call multiple times; only one request in flight.
 */
export async function fetchLiveConfig(): Promise<void> {
  if (fetchPromise) {
    return fetchPromise;
  }
  fetchPromise = (async () => {
    try {
      const response = await getData(apiEndpoints.stream.config);
      if (response?.success && response?.data) {
        const data = response.data as { pollIntervalMs?: number; bufferMs?: number };
        const poll = typeof data.pollIntervalMs === 'number' && data.pollIntervalMs > 0
          ? data.pollIntervalMs
          : DEFAULT_POLL_INTERVAL_MS;
        const buf = typeof data.bufferMs === 'number' && data.bufferMs > 0
          ? data.bufferMs
          : poll;
        setPollIntervalMs(poll);
        setBufferMs(buf);
        setIsLoaded(true);
        debug('[LiveConfigStore] Config loaded', { pollIntervalMs: poll, bufferMs: buf });
      } else {
        debug('[LiveConfigStore] Config response missing data, using defaults');
      }
    } catch (err) {
      warn('[LiveConfigStore] Failed to fetch stream config, using defaults', err);
    } finally {
      fetchPromise = null;
    }
  })();
  return fetchPromise;
}

export const liveConfigStore = {
  /** Poll interval in ms (InfluxDB / WebSocket). Default 5000 until loaded. */
  pollIntervalMs,
  /** Buffer delay in ms (display time = now - bufferMs). Default 5000 until loaded. */
  bufferMs,
  /** Whether config has been loaded from API. */
  isLoaded,
  /** Fetch config from server. Call when entering live mode or on first use. */
  fetchLiveConfig,
};
