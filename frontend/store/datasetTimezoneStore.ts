import { createSignal } from 'solid-js';
import { getData } from '../utils/global';
import { apiEndpoints } from '@config/env';
import { error, debug } from '../utils/console';

// Cache for dataset timezones by dataset_id
const timezoneCache = new Map<number, string | null>();

// Store for current dataset timezone
const [currentDatasetTimezone, setCurrentDatasetTimezone] = createSignal<string | null>(null);
const [currentDatasetId, setCurrentDatasetId] = createSignal<number | null>(null);

/**
 * Fetch dataset timezone from API
 * @param class_name - Class name (schema)
 * @param project_id - Project ID
 * @param dataset_id - Dataset ID
 * @returns Promise with timezone string or null
 */
export async function fetchDatasetTimezone(
  class_name: string,
  project_id: string | number,
  dataset_id: number
): Promise<string | null> {
  try {
    // Check cache first
    if (timezoneCache.has(dataset_id)) {
      const cached = timezoneCache.get(dataset_id);
      debug('[datasetTimezoneStore] Using cached timezone:', cached, 'for dataset:', dataset_id);
      return cached ?? null;
    }

    if (!dataset_id || dataset_id <= 0) {
      return null;
    }

    const controller = new AbortController();
    const response = await getData(
      `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(class_name)}&project_id=${encodeURIComponent(project_id)}&dataset_id=${encodeURIComponent(dataset_id)}`,
      controller.signal
    );

    if (response.success && response.data && response.data.timezone) {
      const tz = String(response.data.timezone).trim();
      if (tz && tz !== 'null' && tz !== 'undefined') {
        // Cache the timezone
        timezoneCache.set(dataset_id, tz);
        debug('[datasetTimezoneStore] Fetched and cached timezone:', tz, 'for dataset:', dataset_id);
        return tz;
      }
    }
    
    // Cache null to avoid repeated failed requests
    timezoneCache.set(dataset_id, null);
    return null;
  } catch (err: unknown) {
    error('datasetTimezoneStore: Error fetching dataset timezone:', err as any);
    // Cache null on error
    timezoneCache.set(dataset_id, null);
    return null;
  }
}

/**
 * Set the current dataset timezone (for reactive access)
 * @param class_name - Class name
 * @param project_id - Project ID
 * @param dataset_id - Dataset ID
 */
export async function setCurrentDataset(
  class_name: string,
  project_id: string | number,
  dataset_id: number | null
): Promise<void> {
  if (dataset_id === null) {
    setCurrentDatasetId(null);
    setCurrentDatasetTimezone(null);
    return;
  }

  setCurrentDatasetId(dataset_id);
  const timezone = await fetchDatasetTimezone(class_name, project_id, dataset_id);
  setCurrentDatasetTimezone(timezone);
}

/**
 * Get current dataset timezone (reactive)
 * @returns Current dataset timezone or null
 */
export function getCurrentDatasetTimezone(): string | null {
  return currentDatasetTimezone();
}

/**
 * Clear timezone cache (useful for testing or when datasets are updated)
 */
export function clearTimezoneCache(): void {
  timezoneCache.clear();
  setCurrentDatasetTimezone(null);
  setCurrentDatasetId(null);
}

/**
 * Clear timezone cache for a specific dataset
 */
export function clearTimezoneCacheForDataset(dataset_id: number): void {
  timezoneCache.delete(dataset_id);
  if (currentDatasetId() === dataset_id) {
    setCurrentDatasetTimezone(null);
  }
}

