import { createSignal, createEffect, createMemo, onMount, onCleanup, untrack } from "solid-js";
import Map from "../../../../components/charts/Map";
import { setIsPlaying, setPlaybackSpeed } from "../../../../store/playbackStore";
import { persistantStore } from "../../../../store/persistantStore";
const { selectedClassName, selectedProjectId } = persistantStore;
import { debug, warn, error as logError } from "../../../../utils/console";
import { sourcesStore } from "../../../../store/sourcesStore";
import { liveSourcesStore } from "../../../../store/liveSourcesStore";
import { streamingStore } from "../../../../store/streamingStore";
import { liveConfigStore } from "../../../../store/liveConfigStore";
import { getData, postData } from "../../../../utils/global";
import { apiEndpoints, config } from "../../../../config/env";
import { user } from "../../../../store/userStore";
import * as d3 from "d3";

/** Storage key for local persistence; same as user object name for consistency. */
const LIVE_SOURCES_KEY = 'live_sources';
const LIVE_SOURCES_PARENT = 'live';

function getStoredLiveSources(): Record<string, number[]> {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return {};
  try {
    let raw = localStorage.getItem(LIVE_SOURCES_KEY);
    if (!raw) {
      const legacy = localStorage.getItem('liveMapSelectedSourceIds');
      if (legacy) {
        const parsed = JSON.parse(legacy);
        const data = typeof parsed === 'object' && parsed !== null ? parsed : {};
        setStoredLiveSources(data);
        return data;
      }
      return {};
    }
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function setStoredLiveSources(data: Record<string, number[]>) {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LIVE_SOURCES_KEY, JSON.stringify(data));
  } catch (err) {
    debug('[LiveMap] Could not persist selected sources to localStorage', err);
  }
}

/** Load live source IDs from user settings (cross-device). Returns null if not found or error. */
async function loadLiveSourcesFromUser(): Promise<number[] | null> {
  const cls = selectedClassName?.() ?? '';
  const proj = selectedProjectId?.() ?? 0;
  const currentUser = user();
  if (!cls || proj == null || !currentUser?.user_id) return null;
  try {
    const url = `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(cls)}&project_id=${encodeURIComponent(proj)}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=${encodeURIComponent(LIVE_SOURCES_PARENT)}&object_name=${encodeURIComponent(LIVE_SOURCES_KEY)}`;
    const response = await getData(url);
    if (!response.success || response.data == null) return null;
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    const ids = data?.source_ids;
    return Array.isArray(ids) ? ids.map((id: unknown) => Number(id)).filter((id) => Number.isFinite(id)) : null;
  } catch {
    return null;
  }
}

/** Save live source IDs to user settings (cross-device). */
async function saveLiveSourcesToUser(ids: number[]) {
  const cls = selectedClassName?.() ?? '';
  const proj = selectedProjectId?.() ?? 0;
  const currentUser = user();
  if (!cls || proj == null || !currentUser?.user_id) return;
  try {
    const payload = {
      class_name: cls,
      project_id: Number(proj),
      user_id: currentUser.user_id,
      parent_name: LIVE_SOURCES_PARENT,
      object_name: LIVE_SOURCES_KEY,
      json: JSON.stringify({ source_ids: ids })
    };
    await postData(`${apiEndpoints.app.users}/object`, payload);
  } catch (err) {
    debug('[LiveMap] Could not save live sources to user settings', err);
  }
}

export default function MapComponent(props) {
  const [selectedSourceIds, setSelectedSourceIds] = createSignal(new Set());
  let hasInitializedTime = false;
  let checkInterval = null;
  let hasReceivedFirstWebSocketData = false;
  let lastInitializedSourceIds = new Set(); // Track initialized sources for updateSelectedSources
  let abortController: AbortController | null = null; // Track abort controller for all async operations
  let isMounted = true; // Track if component is still mounted

  // Check if timeline is drawn (has SVG with x-axis)
  const isTimelineDrawn = () => {
    try {
      const chartContainer = document.querySelector('.map-container .chart-container');
      if (!chartContainer) return false;
      
      const svg = d3.select(chartContainer).select('svg');
      if (svg.empty()) return false;
      
      const xAxisGroup = svg.select('.x-axis');
      if (xAxisGroup.empty()) return false;
      
      // Check if axis has ticks (indicating it's fully drawn)
      const ticks = xAxisGroup.selectAll('.tick');
      return !ticks.empty();
    } catch (error) {
      return false;
    }
  };

  // Function to enable play once timeline is drawn
  // MultiMapTimeSeries will handle querying data, drawing timeline, and passing data to map
  const checkTimelineReady = () => {
    if (hasInitializedTime) return;

    // Check if timeline is drawn - if so, enable play
    // MultiMapTimeSeries will handle time initialization and data flow
    if (isTimelineDrawn()) {
      hasInitializedTime = true;
      // Enable play once map finishes initialization
      setIsPlaying(true);
      debug('LiveMap: Timeline drawn - MultiMapTimeSeries will handle data querying and map updates, play enabled');
    }
  };

  // Fetch last 30 minutes from Redis and store in IndexedDB
  // MultiMapTimeSeries will query this data and pass it to the map
  const fetchRedisData = async () => {
    debug('[LiveMap] 🚀 fetchRedisData STARTED - storing data in IndexedDB for MultiMapTimeSeries');
    
    // Check if component is still mounted before starting
    if (!isMounted || abortController?.signal.aborted) {
      debug('[LiveMap] ⚠️ Component unmounted or aborted, skipping fetchRedisData');
      return;
    }
    
    try {
      // Wait for sourcesStore to be ready (with abort check)
      let attempts = 0;
      const maxAttempts = 50;
      while (!sourcesStore.isReady() && attempts < maxAttempts && isMounted && !abortController?.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      
      // Check if aborted or unmounted
      if (!isMounted || abortController?.signal.aborted) {
        debug('[LiveMap] ⚠️ fetchRedisData aborted during sourcesStore wait');
        return;
      }
      
      if (!sourcesStore.isReady()) {
        debug('[LiveMap] ❌ sourcesStore not ready after waiting');
        return;
      }
      
      const projectSources = sourcesStore.sources();
      if (!projectSources || projectSources.length === 0) {
        debug('[LiveMap] ❌ No sources available');
        return;
      }
      
      // Get source names for Redis fetch
      const sourceNames = projectSources
        .map(s => s.source_name)
        .filter(name => name);
      
      if (sourceNames.length === 0) {
        debug('[LiveMap] ❌ No valid source names found');
        return;
      }
      
      // First, get the latest timestamp from Redis to determine the simulation time
      // This ensures we fetch data relative to the actual simulation time, not browser time
      let latestTimestamp = Date.now(); // Default to current time
      let foundLatestTimestamp = false;
      
      for (const sourceName of sourceNames) {
        // Check if aborted before each API call
        if (!isMounted || abortController?.signal.aborted) {
          debug('[LiveMap] ⚠️ fetchRedisData aborted during source status checks');
          return;
        }
        
        try {
          const statusResponse = await getData(apiEndpoints.stream.sourceStatus(sourceName), abortController?.signal);
          if (statusResponse.success && statusResponse.data?.latest_timestamp) {
            const ts = statusResponse.data.latest_timestamp;
            if (ts && (!foundLatestTimestamp || ts > latestTimestamp)) {
              latestTimestamp = ts;
              foundLatestTimestamp = true;
            }
          }
        } catch (err: any) {
          // Ignore abort errors
          if (err?.name === 'AbortError' || abortController?.signal.aborted) {
            debug('[LiveMap] ⚠️ fetchRedisData aborted during source status fetch');
            return;
          }
          debug(`[LiveMap] Error checking status for source ${sourceName}:`, err);
        }
      }
      
      // Use latest timestamp from Redis (or current time if not found) as the reference point
      const endTime = latestTimestamp;
      const windowMinutes = 30;
      const windowMs = windowMinutes * 60 * 1000;
      const startTime = endTime - windowMs;
      
      // Log the last datetime found in Redis on page reload
      if (foundLatestTimestamp) {
        const lastDatetime = new Date(latestTimestamp);
        debug('[LiveMap] 🕐 Last datetime found in Redis on page reload:', {
          timestamp: latestTimestamp,
          datetime: lastDatetime.toISOString(),
          localTime: lastDatetime.toLocaleString(),
          sourceCount: sourceNames.length
        });
        debug('[LiveMap] 🕐 Last datetime found in Redis:', lastDatetime.toISOString(), `(${lastDatetime.toLocaleString()})`);
      } else {
        debug('[LiveMap] ⚠️ No latest timestamp found in Redis, using current time');
        warn('[LiveMap] ⚠️ No latest timestamp found in Redis, using current time');
      }
      
      debug('[LiveMap] 📡 Fetching Redis data and storing in IndexedDB (dataset_id 0)', {
        sourceNames,
        sourceCount: sourceNames.length,
        latestTimestamp: new Date(latestTimestamp).toISOString(),
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        foundLatestTimestamp
      });
      
      // DISABLED: Fetch and store in IndexedDB - temporarily disabled for live mode testing
      // await unifiedDataStore.fetchRedisHistoricalData(sourceNames, startTime, endTime);
      debug('[LiveMap] ⚠️ IndexedDB fetch disabled - skipping fetchRedisHistoricalData');
    } catch (err: any) {
      // Ignore abort errors
      if (err?.name === 'AbortError' || abortController?.signal.aborted) {
        debug('[LiveMap] ⚠️ fetchRedisData aborted');
        return;
      }
      debug('[LiveMap] ❌ ERROR in fetchRedisData:', err);
      logError('[LiveMap] Full error details:', err);
    }
  };

  // Initialize WebSocket subscriptions when selectedSourceIds change
  createEffect(() => {
    const sourceIds = selectedSourceIds();
    if (!sourceIds || sourceIds.size === 0) {
      return; // Wait for sources to be selected
    }

    if (!sourcesStore.isReady()) {
      return; // Wait for sourcesStore to be ready
    }

    // Check if WebSockets are enabled
    if (!config.ENABLE_WEBSOCKETS) {
      debug('[LiveMap] WebSockets are disabled, skipping streaming store initialization');
      return;
    }

    // Check if sources changed
    const sourceIdsArray = Array.from(sourceIds);
    const sourcesChanged = 
      lastInitializedSourceIds.size !== sourceIds.size ||
      sourceIdsArray.some(id => !lastInitializedSourceIds.has(id)) ||
      Array.from(lastInitializedSourceIds).some(id => !sourceIds.has(id));

    // Initialize streaming store if not already initialized
    if (!streamingStore.isInitialized) {
      debug('[LiveMap] 🚀 Initializing streaming store for WebSocket subscriptions', {
        sourceIds: sourceIdsArray,
        sourceCount: sourceIds.size
      });
      streamingStore.initialize(sourceIds).catch(err => {
        debug('[LiveMap] ❌ Failed to initialize streaming store:', err);
        logError('[LiveMap] ❌ Failed to initialize streaming store:', err);
      }).then(() => {
        // Track initialized sources
        lastInitializedSourceIds = new Set(sourceIds);
      });
    } else if (sourcesChanged) {
      // Update subscriptions if sources changed
      debug('[LiveMap] 📡 Updating WebSocket subscriptions', {
        previousSourceIds: Array.from(lastInitializedSourceIds),
        newSourceIds: sourceIdsArray
      });
      streamingStore.updateSelectedSources(sourceIds, lastInitializedSourceIds).catch(err => {
        debug('[LiveMap] ❌ Failed to update selected sources:', err);
        logError('[LiveMap] ❌ Failed to update selected sources:', err);
      });
      lastInitializedSourceIds = new Set(sourceIds);
    }
  });

  // Poll for timeline to be ready and initialize time
  onMount(() => {
    debug('[LiveMap] 🎬 onMount called');
    
    // Create abort controller for this component instance
    abortController = new AbortController();
    isMounted = true;
    
    // Fetch live stream config (poll interval, buffer) for playback and buffering
    liveConfigStore.fetchLiveConfig().catch(() => {});
    
    // Initialize playback to pause and 1x speed for live mode
    setIsPlaying(false);
    setPlaybackSpeed(1);
    debug('[LiveMap] Initialized playback: paused, 1x speed');
    
    // Fetch Redis data and store in IndexedDB - MultiMapTimeSeries will query it
    debug('[LiveMap] 📞 Calling fetchRedisData() to store data in IndexedDB...');
    fetchRedisData().catch(err => {
      // Ignore abort errors
      if (err?.name === 'AbortError' || abortController?.signal.aborted) {
        debug('[LiveMap] ⚠️ fetchRedisData aborted');
        return;
      }
      debug('[LiveMap] ❌ Error in fetchRedisData:', err);
      logError('[LiveMap] Full error:', err);
    });
    
    // Poll for timeline to be ready (same as FleetMap)
    let attempts = 0;
    const maxAttempts = 50; // Try for up to 5 seconds (50 * 100ms)
    
    checkInterval = setInterval(() => {
      // Check if component is unmounted or aborted
      if (!isMounted || abortController?.signal.aborted) {
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
        return;
      }
      
      attempts++;
      
      if (hasInitializedTime) {
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
        return;
      }
      
      if (attempts > maxAttempts) {
        debug('LiveMap: Max attempts reached waiting for timeline');
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
        return;
      }

      // Check if timeline is ready (MultiMapTimeSeries handles data querying and map updates)
      checkTimelineReady();
    }, 100); // Check every 100ms
  });

  onCleanup(() => {
    debug('[LiveMap] 🧹 onCleanup called - aborting all operations');
    
    // Mark as unmounted immediately to stop all operations
    isMounted = false;
    
    // Abort all pending async operations
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    
    // Clear polling interval
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
    
    // Clean up WebSocket subscriptions when leaving this page
    // Do this immediately and synchronously to prevent blocking
    if (streamingStore.isInitialized) {
      debug('[LiveMap] 🧹 Cleaning up streaming store (unsubscribing from WebSocket)');
      try {
        streamingStore.cleanup();
      } catch (err) {
        debug('[LiveMap] Error during streaming store cleanup:', err);
      }
    }
    
    liveSourcesStore.clear();
    debug('[LiveMap] ✅ Cleanup complete');
  });

  // Build dataSourcesOptions from sourcesStore
  const dataSourcesOptions = createMemo(() => {
    if (!sourcesStore.isReady()) {
      return [];
    }
    
    const projectSources = sourcesStore.sources();
    if (!projectSources || projectSources.length === 0) {
      return [];
    }
    
    // Create signal getters - use untrack to prevent memo from tracking selectedSourceIds
    const options = untrack(() => {
      return projectSources
        .map((s) => {
          const id = Number(s.source_id);
          if (!Number.isFinite(id)) {
            return null;
          }
          
          const getter = () => selectedSourceIds().has(id);
          const setter = (value) => {
            if (value instanceof Set) {
              setSelectedSourceIds(new Set(Array.from(value).map(Number)));
              return;
            }
            const next = new Set(selectedSourceIds());
            const on = typeof value === 'function' ? value(next.has(id)) : value;
            if (on) next.add(id); else next.delete(id);
            setSelectedSourceIds(next);
          };
          
          return {
            key: `source-${id}`,
            label: s.source_name || `Source ${id}`,
            type: 'toggle',
            signal: [getter, setter]
          };
        })
        .filter(opt => opt !== null);
    });
    
    return options;
  });
  
  // Restore persisted selection: user settings (cross-device) first, then localStorage, then all
  let hasRestoredOrAutoSelected = false;
  createEffect(() => {
    const options = dataSourcesOptions();
    if (options.length === 0) return;
    if (hasRestoredOrAutoSelected) return;

    untrack(() => {
      if (selectedSourceIds().size > 0) return; // User already selected
      hasRestoredOrAutoSelected = true;

      const validIds = new Set(options.map(opt => {
        const match = opt.key.match(/source-(\d+)/);
        return match ? Number(match[1]) : null;
      }).filter((id): id is number => id !== null));

      if (validIds.size === 0) return;

      // Select all immediately so streaming store initializes and chart/map show something (no empty first paint)
      setSelectedSourceIds(validIds);
      debug('[LiveMap] Defaulting to select all sources for initial display', { count: validIds.size });

      const cls = selectedClassName?.() || '';
      const proj = selectedProjectId?.() || 0;
      const storeKey = `${cls}_${proj}_live`;

      (async () => {
        // 1) User settings (persistent across devices)
        const fromUser = await loadLiveSourcesFromUser();
        if (fromUser && fromUser.length > 0) {
          const restored = new Set(fromUser.filter((id) => validIds.has(id)));
          if (restored.size > 0) {
            setSelectedSourceIds(restored);
            const saved = getStoredLiveSources();
            saved[storeKey] = Array.from(restored);
            setStoredLiveSources(saved);
            debug('[LiveMap] Restored live sources from user settings', { count: restored.size });
            return;
          }
        }
        // 2) LocalStorage (same browser)
        try {
          const saved = getStoredLiveSources();
          const savedIds = saved[storeKey];
          if (Array.isArray(savedIds) && savedIds.length > 0) {
            const restored = new Set(savedIds.map((id) => Number(id)).filter((id) => validIds.has(id)));
            if (restored.size > 0) {
              setSelectedSourceIds(restored);
              debug('[LiveMap] Restored live sources from localStorage', { count: restored.size });
              return;
            }
          }
        } catch (err) {
          debug('[LiveMap] Could not restore from localStorage', err);
        }
        // 3) Keep select-all (already set above); persist it
        const saved = getStoredLiveSources();
        saved[storeKey] = Array.from(validIds);
        setStoredLiveSources(saved);
      })();
    });
  });

  // Persist selected sources to localStorage and user settings (cross-device)
  createEffect(() => {
    const ids = selectedSourceIds();
    if (ids.size === 0) return;

    const cls = selectedClassName?.() || '';
    const proj = selectedProjectId?.() || 0;
    if (!cls || !proj) return;

    const idArray = Array.from(ids);
    const saved = getStoredLiveSources();
    const storeKey = `${cls}_${proj}_live`;
    saved[storeKey] = idArray;
    setStoredLiveSources(saved);
    saveLiveSourcesToUser(idArray);
  });

  // Sync selectedSourceIds to liveSourcesStore whenever it changes (for RealtimeDataTable)
  createEffect(() => {
    const ids = selectedSourceIds();
    liveSourcesStore.setSelectedSourceIds(ids);
  });

  // Watch for first WebSocket data and enable play
  createEffect(() => {
    if (hasReceivedFirstWebSocketData) return; // Only trigger once
    
    const newDataMap = streamingStore.getNewData()();
    if (newDataMap && newDataMap.size > 0) {
      // Check if we have any data points
      let hasData = false;
      for (const [sourceId, points] of newDataMap.entries()) {
        if (points && points.length > 0) {
          hasData = true;
          break;
        }
      }
      
      if (hasData && !hasReceivedFirstWebSocketData) {
        hasReceivedFirstWebSocketData = true;
        debug('[LiveMap] 🎬 First WebSocket data received, enabling play');
        setIsPlaying(true);
      }
    }
  });

  return (
    <div style="position: relative; width: 100%; height: 100%;">
      <Map 
        objectName={props?.objectName} 
        sourceMode={'multi'} 
        liveMode={true}
        dataSourcesOptions={dataSourcesOptions}
      />
    </div>
  );
}
