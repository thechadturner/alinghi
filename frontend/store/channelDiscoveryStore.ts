/**
 * Channel Discovery Store
 * 
 * Pre-discovers and caches channels for dates/datasets to make them
 * immediately available when FileChannelPicker opens.
 */

import { createSignal } from 'solid-js';
import { debug, warn, log, error as logError } from '../utils/console';
import { persistantStore } from './persistantStore';
import type { WorkerMessage, WorkerResponse } from '../workers/types';

interface ChannelCache {
  channels: string[];
  timestamp: number;
  dataSource: 'FILE' | 'INFLUX';
}

// In-memory cache: key = `${date}_${sourceName}_${dataSource}`
const channelCache = new Map<string, ChannelCache>();

// Cache TTL: 1 hour (channels don't change frequently, so we can cache longer)
const CACHE_TTL_MS = 60 * 60 * 1000;

// Worker instance (singleton)
let channelDiscoveryWorker: Worker | null = null;
let workerInitialized = false;

/**
 * Initialize the channel discovery worker
 */
async function initializeWorker(): Promise<Worker | null> {
  if (workerInitialized && channelDiscoveryWorker) {
    return channelDiscoveryWorker;
  }

  if (typeof Worker === 'undefined') {
    warn('[ChannelDiscovery] Web Workers not supported, falling back to main thread');
    return null;
  }

  try {
    // Use dynamic import with ?worker suffix for Vite
    const { default: ChannelDiscoveryWorker } = await import('../workers/channel-discovery-worker.ts?worker');
    channelDiscoveryWorker = new ChannelDiscoveryWorker();
    workerInitialized = true;
    debug('[ChannelDiscovery] Worker initialized successfully');
    return channelDiscoveryWorker;
  } catch (error: any) {
    logError('[ChannelDiscovery] Failed to initialize worker:', error);
    return null;
  }
}

/**
 * Discover channels using web worker (non-blocking)
 */
async function _discoverChannelsWithWorker(
  url: string,
  className: string,
  projectId: string,
  date: string,
  sourceName: string,
  dataSource: 'FILE' | 'INFLUX'
): Promise<string[]> {
  const worker = await initializeWorker();
  
  if (!worker) {
    // Fallback to main thread if worker is not available
    warn('[ChannelDiscovery] Worker not available, using main thread (may block UI)');
    return discoverChannelsMainThread(url);
  }

  // Get auth token to pass to worker (more reliable than cookies in worker context)
  let authToken: string | null = null;
  try {
    const { authManager } = await import('../utils/authManager');
    authToken = await authManager.getValidToken();
  } catch (error) {
    debug('[ChannelDiscovery] Could not get auth token for worker, will rely on cookies');
  }

  return new Promise((resolve, _reject) => {
    const messageId = `channel-discovery-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    // INFLUX queries can take longer due to database queries, so use longer timeout
    const timeout = dataSource === 'INFLUX' ? 120000 : 30000; // 120 seconds for INFLUX, 30 seconds for FILE
    let timeoutId: ReturnType<typeof setTimeout>;
    let resolved = false; // Prevent multiple resolutions

    const handleMessage = (event: MessageEvent<WorkerResponse<{ channels: string[] }>>) => {
      if (event.data.id === messageId && !resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);

        if (event.data.type === 'success' && event.data.result) {
          const discoveredChannels = event.data.result.channels;
          if (dataSource === 'INFLUX') {
            log(`[ChannelDiscovery] ✅ INFLUX worker completed in ${event.data.duration}ms, found ${discoveredChannels.length} channels (date: ${date}, source: ${sourceName})`);
          } else {
            debug(`[ChannelDiscovery] Worker completed in ${event.data.duration}ms, found ${discoveredChannels.length} channels`);
          }
          if (discoveredChannels.length === 0) {
            // Log when we get empty results from the API
            if (dataSource === 'INFLUX') {
              debug(`[ChannelDiscovery] ⚠️ INFLUX API returned empty channel list (date: ${date}, source: ${sourceName}, url: ${url}) - this may indicate no data available or an API issue`);
            } else {
              warn(`[ChannelDiscovery] API returned empty channel list for ${dataSource} (date: ${date}, source: ${sourceName}, url: ${url})`);
            }
          }
          resolve(discoveredChannels);
        } else {
          // Create error with more context from worker response
          const errorMessage = event.data.error || 'Channel discovery failed';
          const error = new Error(`Channel discovery failed: ${errorMessage}`);
          (error as any).source = 'worker';
          (error as any).dataSource = (event.data as any).dataSource || dataSource;
          (error as any).url = (event.data as any).url || url;
          if ((event.data as any).errorStack) {
            (error as any).stack = (event.data as any).errorStack;
          }
          // Log the error before resolving with empty array
          warn(`[ChannelDiscovery] Worker error for ${dataSource}: ${errorMessage}`);
          // Resolve with empty array instead of rejecting to avoid UI interruption
          // Error will be logged in the catch handler
          resolve([]);
        }
      }
    };

    const handleError = (error: ErrorEvent) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      // Log error asynchronously to avoid blocking
      setTimeout(() => {
        const workerError = new Error(`Worker error: ${error.message || 'Unknown worker error'}`);
        (workerError as any).source = 'worker-initialization';
        (workerError as any).dataSource = dataSource;
        (workerError as any).url = url;
        logError('[ChannelDiscovery] Worker error:', error, { dataSource, url });
      }, 0);
      // Resolve with empty array instead of rejecting to avoid UI interruption
      resolve([]);
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    // Set timeout
    timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      // Log timeout asynchronously and resolve with empty array to avoid UI interruption
      setTimeout(() => {
        if (dataSource === 'INFLUX') {
          logError(`[ChannelDiscovery] ❌ INFLUX channel discovery TIMEOUT after ${timeout}ms (${timeout / 1000}s) - this prevents channels from being cached in meta.channel_names. The InfluxDB query may be too slow or the server may be overloaded.`, {
            date,
            sourceName,
            dataSource,
            url,
            timeout: `${timeout}ms (${timeout / 1000}s)`,
            note: 'INFLUX queries can be slow - consider checking InfluxDB performance or increasing timeout further'
          });
        } else {
          warn(`[ChannelDiscovery] Channel discovery timeout after ${timeout}ms for ${dataSource}`);
        }
      }, 0);
      resolve([]);
    }, timeout);

    // Send message to worker with auth token
    const message: WorkerMessage<{ url: string; className?: string; projectId?: string; date: string; sourceName: string; dataSource: 'FILE' | 'INFLUX'; authToken?: string }, never> = {
      id: messageId,
      type: 'discover-channels',
      data: { url, className, projectId, date, sourceName, dataSource, authToken: authToken || undefined },
      timestamp: Date.now()
    };

    worker.postMessage(message);
  });
}

/**
 * Fallback: Discover channels on main thread (blocking)
 */
async function discoverChannelsMainThread(url: string): Promise<string[]> {
  try {
    const response = await fetch(url, {
      credentials: 'include'
    });
    if (!response.ok) {
      // Handle 404 gracefully - "Source not found" means no channels available, not an error
      if (response.status === 404) {
        try {
          const errorResult = await response.json();
          // If it's a "Source not found" or "Date not found" message, return empty array
          if (errorResult.message && (
            errorResult.message.includes('Source not found') ||
            errorResult.message.includes('Date not found') ||
            errorResult.message.includes('No files found')
          )) {
            // Source/date doesn't exist - return empty channels array (not an error)
            return [];
          }
        } catch (e) {
          // If we can't parse the response, still treat 404 as "no channels"
          return [];
        }
      }
      
      // For other errors, throw as before
      // Try to extract error message from response body
      let errorMessage = `HTTP error! status: ${response.status}`;
      try {
        const errorResult = await response.json();
        if (errorResult.message) {
          errorMessage = `${errorMessage}: ${errorResult.message}`;
        } else if (errorResult.error) {
          errorMessage = `${errorMessage}: ${errorResult.error}`;
        }
      } catch (e) {
        // If response is not JSON, try to get text
        try {
          const errorText = await response.text();
          if (errorText) {
            errorMessage = `${errorMessage}: ${errorText.substring(0, 200)}`;
          }
        } catch (textError) {
          // Ignore if we can't read the response
        }
      }
      throw new Error(errorMessage);
    }
    const result = await response.json();
    if (result.success && Array.isArray(result.data)) {
      return result.data;
    }
    throw new Error('Invalid response format');
  } catch (error: any) {
    logError('[ChannelDiscovery] Main thread fetch error:', error);
    throw error;
  }
}

/**
 * Discover channels for a date/source combination
 * @param date - Date in YYYYMMDD format (or YYYY-MM-DD, will be normalized)
 * @param sourceName - Source name
 * @param dataSource - 'FILE' or 'INFLUX'
 * @param forceRefresh - If true, bypass cache and query fresh
 * @returns Array of channel names
 */
export async function discoverChannels(
  date: string,
  sourceName: string,
  dataSource: 'FILE' | 'INFLUX' = 'FILE',
  forceRefresh: boolean = false
): Promise<string[]> {
  if (!date || !sourceName) {
    debug('[ChannelDiscovery] Missing date or sourceName, cannot discover channels');
    return [];
  }

  // Normalize date format (remove dashes)
  const normalizedDate = date.replace(/[-/]/g, '');
  
  // Check cache first
  const cacheKey = `${normalizedDate}_${sourceName}_${dataSource}`;
  if (!forceRefresh) {
    const cached = channelCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
      debug(`[ChannelDiscovery] Using cached channels for ${cacheKey}: ${cached.channels.length} channels`);
      
      // CRITICAL: Ensure channels are also cached in HuniDB even when returning from in-memory cache
      // This ensures meta.channel_names is populated even if discoverChannels() was called directly
      if (cached.channels.length > 0) {
        const className = persistantStore.selectedClassName();
        if (className) {
          // Cache to HuniDB in background (non-blocking)
          import('./huniDBStore').then(({ huniDBStore }) => {
            huniDBStore.cacheChannelNames(
              className,
              normalizedDate,
              dataSource,
              cached.channels
            ).then(() => {
              log(`[ChannelDiscovery] ✅ Cached ${cached.channels.length} channel names in HuniDB meta.channel_names from in-memory cache for ${dataSource} (className: ${className}, date: ${normalizedDate})`);
            }).catch((cacheErr) => {
              warn(`[ChannelDiscovery] ❌ Failed to cache channel names in HuniDB from in-memory cache for ${dataSource}:`, cacheErr);
            });
          }).catch((importErr) => {
            warn(`[ChannelDiscovery] ❌ Failed to import huniDBStore for caching ${dataSource} channels:`, importErr);
          });
        } else {
          warn(`[ChannelDiscovery] ⚠️ Skipping HuniDB cache from in-memory cache for ${dataSource} - missing className (date: ${normalizedDate}, source: ${sourceName})`);
        }
      }
      
      return cached.channels;
    }
  }

  // STEP 1: Check HuniDB cache first (primary cache - fast, local)
  const className = persistantStore.selectedClassName();
  const projectId = persistantStore.selectedProjectId();
  
  if (className && projectId) {
    try {
      const { huniDBStore } = await import('./huniDBStore');
      
      // Check hunidb for channels (for both FILE and INFLUX)
      const cachedChannels = await huniDBStore.getCachedChannelNames(className, dataSource);
      
      if (cachedChannels && cachedChannels.length > 0) {
        debug(`[ChannelDiscovery] ⚡ Found ${cachedChannels.length} channels in HuniDB cache for ${dataSource} (date: ${normalizedDate}, source: ${sourceName})`);
        
        // Update in-memory cache
        channelCache.set(cacheKey, {
          channels: cachedChannels,
          timestamp: Date.now(),
          dataSource
        });
        
        // Return cached channels immediately
        return cachedChannels;
      } else {
        debug(`[ChannelDiscovery] 🔍 No channels found in HuniDB cache for ${dataSource}, trying PostgreSQL API (date: ${normalizedDate}, source: ${sourceName})`);
      }
    } catch (err) {
      warn(`[ChannelDiscovery] Error checking HuniDB cache:`, err);
      // Continue with API discovery on error
    }
  } else {
    debug(`[ChannelDiscovery] ⚠️ Cannot check HuniDB cache - missing className or projectId (date: ${normalizedDate}, source: ${sourceName})`);
  }

  // STEP 2: If not found in hunidb, try PostgreSQL API endpoint (backend is source of truth)
  if (className && projectId) {
    try {
      const { getChannels } = await import('../services/channelsService');
      
      // Try to get channels from PostgreSQL API
      const apiChannels = await getChannels(className, projectId, normalizedDate, dataSource);
      
      if (apiChannels && apiChannels.length > 0) {
        log(`[ChannelDiscovery] ✅ Retrieved ${apiChannels.length} channels from PostgreSQL API for ${dataSource} (date: ${normalizedDate}, source: ${sourceName})`);
        
        // Cache in both in-memory and hunidb
        channelCache.set(cacheKey, {
          channels: apiChannels,
          timestamp: Date.now(),
          dataSource
        });
        
        // Cache to hunidb in background
        if (className) {
          const { huniDBStore } = await import('./huniDBStore');
          huniDBStore.cacheChannelNames(
            className,
            normalizedDate,
            dataSource,
            apiChannels
          ).then(() => {
            debug(`[ChannelDiscovery] ✅ Cached ${apiChannels.length} channels to HuniDB from PostgreSQL API`);
          }).catch((cacheErr) => {
            warn(`[ChannelDiscovery] Failed to cache channels to HuniDB:`, cacheErr);
          });
        }
        
        return apiChannels;
      } else {
        // Backend is source of truth - if PostgreSQL API returns no channels, return empty array
        // Don't fall back to file/influx discovery
        debug(`[ChannelDiscovery] No channels returned from PostgreSQL API for ${dataSource} (date: ${normalizedDate}, source: ${sourceName}) - returning empty array (backend is source of truth)`);
        return [];
      }
    } catch (err) {
      // Backend is source of truth - if PostgreSQL API fails, return empty array
      // Don't fall back to file/influx discovery
      warn(`[ChannelDiscovery] Error fetching channels from PostgreSQL API (backend is source of truth):`, err);
      return [];
    }
  }

  // If we don't have className or projectId, return empty array
  // Backend is source of truth, so we can't discover channels without proper context
  debug(`[ChannelDiscovery] Missing className or projectId, cannot query PostgreSQL API - returning empty array (backend is source of truth)`);
  return [];
}

/**
 * Discover channels for both FILE and INFLUX data sources
 * @param date - Date in YYYYMMDD format
 * @param sourceName - Source name
 * @returns Object with fileChannels and influxChannels
 */
export async function discoverAllChannels(
  date: string,
  sourceName: string
): Promise<{ fileChannels: string[]; influxChannels: string[] }> {
  const [fileChannels, influxChannels] = await Promise.all([
    discoverChannels(date, sourceName, 'FILE'),
    discoverChannels(date, sourceName, 'INFLUX')
  ]);

  return { fileChannels, influxChannels };
}

/**
 * Merge channels from FILE and INFLUX sources with case-insensitive deduplication
 * @param fileChannels - Channels from FILE source
 * @param influxChannels - Channels from INFLUX source
 * @returns Merged, deduplicated, and sorted array of unique channel names
 */
function mergeChannels(fileChannels: string[], influxChannels: string[]): string[] {
  const channelMap = new Map<string, string>(); // lowercase -> original casing
  
  // Add all channels (case-insensitive deduplication)
  [...fileChannels, ...influxChannels].forEach(ch => {
    if (!ch || typeof ch !== 'string') return;
    const lower = ch.toLowerCase();
    // Use first occurrence's casing
    if (!channelMap.has(lower)) {
      channelMap.set(lower, ch);
    }
  });
  
  // Return sorted array with original casing preserved
  return Array.from(channelMap.values()).sort();
}

/**
 * Discover unified channels from both FILE and INFLUX data sources
 * Returns an ordered, unique list of channels available in either source
 * @param date - Date in YYYYMMDD format (or YYYY-MM-DD, will be normalized)
 * @param sourceName - Source name
 * @param forceRefresh - If true, bypass cache and query fresh
 * @returns Array of unique, sorted channel names
 */
export async function discoverUnifiedChannels(
  date: string,
  sourceName: string,
  forceRefresh: boolean = false
): Promise<string[]> {
  if (!date || !sourceName) {
    debug('[ChannelDiscovery] Missing date or sourceName, cannot discover unified channels');
    return [];
  }

  // Normalize date format (remove dashes)
  const normalizedDate = date.replace(/[-/]/g, '');
  
  // Check cache first (use unified cache key)
  const cacheKey = `${normalizedDate}_${sourceName}_UNIFIED`;
  if (!forceRefresh) {
    const cached = channelCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
      debug(`[ChannelDiscovery] Using cached unified channels for ${cacheKey}: ${cached.channels.length} channels`);
      return cached.channels;
    }
  }

  try {
    // Query both sources in parallel and merge client-side
    // This is the reliable approach - query FILE and INFLUX separately, then merge
    log(`[ChannelDiscovery] Starting unified channel discovery for ${date}/${sourceName}`);
    const [fileChannels, influxChannels] = await Promise.all([
      discoverChannels(date, sourceName, 'FILE', forceRefresh).catch((err) => {
        warn(`[ChannelDiscovery] FILE channel discovery failed for ${date}/${sourceName}:`, err);
        return [];
      }),
      discoverChannels(date, sourceName, 'INFLUX', forceRefresh).catch((err) => {
        warn(`[ChannelDiscovery] INFLUX channel discovery failed for ${date}/${sourceName}:`, err);
        return [];
      })
    ]);

    log(`[ChannelDiscovery] FILE channels: ${fileChannels.length}, INFLUX channels: ${influxChannels.length}`);

    // Ensure FILE channels are arrays (defensive check)
    const safeFileChannels = Array.isArray(fileChannels) ? fileChannels : [];
    const safeInfluxChannels = Array.isArray(influxChannels) ? influxChannels : [];

    // Merge and deduplicate channels
    const unifiedChannels = mergeChannels(safeFileChannels, safeInfluxChannels);

    log(`[ChannelDiscovery] Unified channels: ${safeFileChannels.length} from FILE, ${safeInfluxChannels.length} from INFLUX, ${unifiedChannels.length} unique total`);

    // Always ensure FILE channels are included in the result
    if (safeFileChannels.length > 0 && unifiedChannels.length === 0) {
      logError(`[ChannelDiscovery] ERROR: FILE channels (${safeFileChannels.length}) were found but not included in unified result!`);
      // Fallback: return FILE channels directly if merge failed
      return safeFileChannels;
    }

    if (unifiedChannels.length === 0) {
      warn(`[ChannelDiscovery] WARNING: No channels found for ${date}/${sourceName} (FILE: ${safeFileChannels.length}, INFLUX: ${safeInfluxChannels.length})`);
    } else if (safeFileChannels.length > 0 && unifiedChannels.length < safeFileChannels.length) {
      warn(`[ChannelDiscovery] WARNING: Unified result (${unifiedChannels.length}) has fewer channels than FILE channels (${safeFileChannels.length}) - some may have been deduplicated with INFLUX`);
    }

    // Cache the unified result (even if empty, to avoid repeated queries)
    channelCache.set(cacheKey, {
      channels: unifiedChannels,
      timestamp: Date.now(),
      dataSource: 'FILE' // Use FILE as placeholder for unified cache
    });
    
    // CRITICAL: Cache FILE and INFLUX channels separately to HuniDB
    // This ensures meta.channel_names has both FILE and INFLUX entries, not just UNIFIED
    // Even if discoverChannels() returned from cache and didn't cache to HuniDB, we cache them here
    try {
      const { huniDBStore } = await import('./huniDBStore');
      const className = persistantStore.selectedClassName();
      
      if (className) {
        // Cache FILE channels separately
        if (safeFileChannels.length > 0) {
          try {
            await huniDBStore.cacheChannelNames(
              className,
              normalizedDate,
              'FILE',
              safeFileChannels
            );
            debug(`[ChannelDiscovery] Cached ${safeFileChannels.length} FILE channel names in HuniDB`);
          } catch (fileCacheErr) {
            debug('[ChannelDiscovery] Failed to cache FILE channel names in HuniDB:', fileCacheErr);
          }
        }
        
        // Cache INFLUX channels separately
        if (safeInfluxChannels.length > 0) {
          try {
            await huniDBStore.cacheChannelNames(
              className,
              normalizedDate,
              'INFLUX',
              safeInfluxChannels
            );
            debug(`[ChannelDiscovery] Cached ${safeInfluxChannels.length} INFLUX channel names in HuniDB`);
          } catch (influxCacheErr) {
            debug('[ChannelDiscovery] Failed to cache INFLUX channel names in HuniDB:', influxCacheErr);
          }
        }
        
        // Also cache unified channels for convenience
        if (unifiedChannels.length > 0) {
          try {
            await huniDBStore.cacheChannelNames(
              className,
              normalizedDate,
              'UNIFIED',
              unifiedChannels
            );
            debug(`[ChannelDiscovery] Cached ${unifiedChannels.length} unified channel names in HuniDB`);
          } catch (unifiedCacheErr) {
            debug('[ChannelDiscovery] Failed to cache unified channel names in HuniDB:', unifiedCacheErr);
          }
        }
      } else {
        debug('[ChannelDiscovery] Skipping HuniDB cache (missing className)');
      }
    } catch (cacheErr) {
      // Non-critical - continue even if cache fails
      debug('[ChannelDiscovery] Failed to cache channel names in HuniDB:', cacheErr);
    }

    return unifiedChannels;
  } catch (error: any) {
    // Final safety net - ensure we never throw, always return empty array
    setTimeout(() => {
      if (error.name !== 'AbortError') {
        logError(`[ChannelDiscovery] Unexpected error in discoverUnifiedChannels: ${error.message}`, error);
      }
    }, 0);
    
    return [];
  }
}

/**
 * Get cached channels (if available)
 * @param date - Date in YYYYMMDD format
 * @param sourceName - Source name
 * @param dataSource - 'FILE', 'INFLUX', or 'UNIFIED'
 * @returns Cached channels or empty array
 */
export function getCachedChannels(
  date: string,
  sourceName: string,
  dataSource: 'FILE' | 'INFLUX' | 'UNIFIED' = 'FILE'
): string[] {
  const normalizedDate = date.replace(/[-/]/g, '');
  const cacheKey = `${normalizedDate}_${sourceName}_${dataSource}`;
  const cached = channelCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.channels;
  }
  
  return [];
}

/**
 * Clear cache for a specific date/source combination
 */
export function clearChannelCache(date?: string, sourceName?: string): void {
  if (date && sourceName) {
    const normalizedDate = date.replace(/[-/]/g, '');
    channelCache.delete(`${normalizedDate}_${sourceName}_FILE`);
    channelCache.delete(`${normalizedDate}_${sourceName}_INFLUX`);
    debug(`[ChannelDiscovery] Cleared cache for ${normalizedDate}_${sourceName}`);
  } else {
    // Clear all cache
    channelCache.clear();
    debug('[ChannelDiscovery] Cleared all channel cache');
  }
}
