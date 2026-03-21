/**
 * Default Channels Store
 * 
 * Single source of truth for default channel names (bsp_name, tws_name, twd_name, etc.)
 * Automatically initializes when a project/class is loaded and updates when project/class changes.
 * Components should use this store instead of fetching default_channels directly from the API.
 */

import { createRoot, createSignal, createEffect, onCleanup, Accessor } from 'solid-js';
import { persistantStore } from './persistantStore';
import { debug as logDebug, warn as logWarn } from '../utils/console';
import { huniDBStore } from './huniDBStore';
import { apiEndpoints } from '@config/env';
import { getData } from '../utils/global';

export interface DefaultChannels {
  // Core navigation
  bsp_name?: string;
  sog_name?: string;
  cog_name?: string;
  // Wind
  tws_name?: string;
  twd_name?: string;
  twa_name?: string;
  // Position
  lat_name?: string;
  lng_name?: string;
  hdg_name?: string;
  // Performance
  vmg_name?: string;
  vmg_perc_name?: string;

  [key: string]: any; // Allow other channel names
}

interface DefaultChannelsStore {
  /** Default channels configuration for current class/project */
  defaultChannels: Accessor<DefaultChannels | null>;
  /** Whether default channels are loaded */
  isReady: Accessor<boolean>;
  /** Refresh default channels from API (can be called manually if channels need to be reloaded) */
  refresh: (signal?: AbortSignal) => Promise<void>;
  /** Generic method to get channel name with fallback (e.g., getChannelName('bsp_name', 'Bsp_kts')()) */
  getChannelName: (channelKey: string, fallback?: string) => Accessor<string>;
  /** Get channel name with fallback (e.g., bspName() returns bsp_name or 'Bsp_kts') */
  bspName: Accessor<string>;
  twsName: Accessor<string>;
  twdName: Accessor<string>;
  twaName: Accessor<string>;
  latName: Accessor<string>;
  lngName: Accessor<string>;
  hdgName: Accessor<string>;
  sogName: Accessor<string>;
  cogName: Accessor<string>;
  vmgName: Accessor<string>;
  vmgPercName: Accessor<string>;
}

// Track the current project key to detect changes
let currentProjectKey = '';
let initializationPromise: Promise<void> | null = null;

/**
 * Get class-specific fallback channel names
 * GP50 uses _kph (kilometers per hour)
 */
const getDefaultFallbacks = (className?: string): Record<string, string> => {
  const classLower = className?.toLowerCase() || '';
  const isGP50 = classLower === 'gp50';
  
  // GP50 uses _kph
  const speedUnit = isGP50 ? 'kph' : 'kts';
  
  return {
    bsp_name: `Bsp_${speedUnit}`,
    tws_name: `Tws_${speedUnit}`,
    twd_name: 'Twd_deg',  // Degrees are the same for all classes
    twa_name: 'Twa_deg',  // Degrees are the same for all classes
    lat_name: 'Lat_dd',
    lng_name: 'Lng_dd',
    hdg_name: 'Hdg_deg',  // Degrees are the same for all classes
    sog_name: `Sog_${speedUnit}`,
    cog_name: 'Cog_deg',  // Degrees are the same for all classes
    vmg_name: `Vmg_${speedUnit}`,
    vmg_perc_name: 'Vmg_perc'
  };
};

export const defaultChannelsStore = createRoot<DefaultChannelsStore>(() => {
  const [defaultChannels, setDefaultChannels] = createSignal<DefaultChannels | null>(null);
  const [isReady, setIsReady] = createSignal(false);

  /**
   * Fetch default channels from API for the current project/class
   * First checks HuniDB cache, then falls back to API
   */
  const initializeDefaultChannels = async (signal?: AbortSignal): Promise<void> => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    
    if (!className || !projectId) {
      logDebug('DefaultChannelsStore: No className or projectId, skipping initialization', { className, projectId });
      setDefaultChannels(null);
      setIsReady(false);
      currentProjectKey = '';
      return;
    }

    const projectKey = `${className}:${projectId}`;
    
    // If we already have channels for this project, don't refetch
    if (currentProjectKey === projectKey && defaultChannels() !== null) {
      logDebug('DefaultChannelsStore: Default channels already loaded for this project');
      setIsReady(true);
      return;
    }

    try {
      // First, try to get from HuniDB cache
      logDebug('DefaultChannelsStore: Checking HuniDB cache', { className, projectId });
      const cached = await huniDBStore.getObject(className, 'default_channels');
      
      if (cached) {
        setDefaultChannels(cached);
        setIsReady(true);
        currentProjectKey = projectKey;
        
        logDebug('DefaultChannelsStore: Default channels loaded from HuniDB cache', {
          channels: cached,
          bsp_name: cached.bsp_name,
          tws_name: cached.tws_name,
          twd_name: cached.twd_name,
          twa_name: cached.twa_name,
          lat_name: cached.lat_name,
          lng_name: cached.lng_name,
          hdg_name: cached.hdg_name
        });
        return;
      }

      // Cache miss - fetch from API
      // Check if user is logged in before making API request
      const { isLoggedIn } = await import('./userStore');
      if (!isLoggedIn()) {
        logDebug('DefaultChannelsStore: User not logged in, skipping API request');
        return;
      }
      
      logDebug('DefaultChannelsStore: Cache miss, fetching default channels from API', { className, projectId });
      const apiUrl = `${apiEndpoints.app.classes}/object?class_name=${encodeURIComponent(className)}&project_id=${projectId}&object_name=default_channels`;
      logDebug('DefaultChannelsStore: API URL', { apiUrl });
      
      const response = await getData(apiUrl, signal);

      logDebug('DefaultChannelsStore: API response', {
        success: response?.success,
        hasData: !!response?.data,
        dataType: typeof response?.data,
        dataKeys: response?.data ? Object.keys(response.data) : [],
        status: response?.status,
        message: response?.message,
        rawData: response?.data
      });

      if (!response.success || !response.data) {
        // API fetch failed - this is expected if default_channels object doesn't exist yet
        // We'll use fallback values, which is fine for most use cases
        const classFallbacks = getDefaultFallbacks(className);
        logDebug('DefaultChannelsStore: default_channels not found in API, will use fallback values', {
          className,
          projectId,
          apiUrl,
          responseSuccess: response?.success,
          responseData: response?.data,
          responseStatus: response?.status,
          responseMessage: response?.message,
          fallbacks: Object.keys(classFallbacks)
        });
        // Set to empty object so isReady() returns true and fallbacks are used
        setDefaultChannels({} as DefaultChannels);
        setIsReady(true);
        currentProjectKey = projectKey;
        return;
      }

      // Handle case where data might be a JSON string that needs parsing
      let fetchedChannels = response.data;
      if (typeof fetchedChannels === 'string') {
        try {
          fetchedChannels = JSON.parse(fetchedChannels);
          logDebug('DefaultChannelsStore: Parsed JSON string from API response');
        } catch (parseError) {
          logWarn('DefaultChannelsStore: Failed to parse JSON string from API response', parseError);
          // Set to empty object and use fallbacks
          setDefaultChannels({} as DefaultChannels);
          setIsReady(true);
          currentProjectKey = projectKey;
          return;
        }
      }
      
      // Store in HuniDB for future use
      try {
        await huniDBStore.storeObject(className, 'default_channels', fetchedChannels);
        logDebug('DefaultChannelsStore: Stored default_channels in HuniDB cache');
      } catch (cacheError) {
        logWarn('DefaultChannelsStore: Error storing default_channels in cache', cacheError);
        // Continue anyway - don't fail if cache write fails
      }
      
      setDefaultChannels(fetchedChannels);
      setIsReady(true);
      currentProjectKey = projectKey;
      
      logDebug('DefaultChannelsStore: Default channels loaded from API', {
        channels: fetchedChannels,
        bsp_name: fetchedChannels.bsp_name,
        tws_name: fetchedChannels.tws_name,
        twd_name: fetchedChannels.twd_name,
        twa_name: fetchedChannels.twa_name,
        lat_name: fetchedChannels.lat_name,
        lng_name: fetchedChannels.lng_name,
        hdg_name: fetchedChannels.hdg_name
      });
    } catch (error) {
      // Error fetching from API - use fallback values
      // This is expected if default_channels doesn't exist or API is unavailable
      logDebug('DefaultChannelsStore: Error fetching default channels, will use fallback values', {
        error: error instanceof Error ? error.message : String(error),
        className,
        projectId
      });
      // Set to empty object so isReady() returns true and fallbacks are used
      setDefaultChannels({} as DefaultChannels);
      setIsReady(true);
      currentProjectKey = projectKey;
    }
  };

  /**
   * Refresh default channels (called when project/class changes)
   */
  const refresh = async (signal?: AbortSignal): Promise<void> => {
    // If there's already an initialization in progress, wait for it
    if (initializationPromise) {
      await initializationPromise;
      return;
    }

    initializationPromise = initializeDefaultChannels(signal);
    try {
      await initializationPromise;
    } finally {
      initializationPromise = null;
    }
  };

  // Watch for project/className changes and fetch default channels
  // This effect will run immediately when the store is created if className/projectId are available
  createEffect(() => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    
    const projectKey = `${className}:${projectId}`;
    const abortController = new AbortController();
    
    // Only fetch if project changed or channels not ready
    if (currentProjectKey !== projectKey || !isReady()) {
      if (className && projectId) {
        // Call refresh with abort signal
        refresh(abortController.signal).catch(() => {
          // Ignore errors from cancelled requests
        });
      } else {
        // Clear channels if no valid project
        setDefaultChannels(null);
        setIsReady(false);
        currentProjectKey = '';
      }
    }
    
    // Cleanup: abort request when effect re-runs or is disposed
    onCleanup(() => {
      abortController.abort();
    });
  });

  /**
   * Generic helper to get channel name with fallback
   * Logs a warning if using fallback when store is ready (indicates missing data)
   * This is the dynamic version that can be used for any channel key
   */
  const getChannelNameGeneric = (channelKey: string, fallback?: string): Accessor<string> => {
    return () => {
      const className = persistantStore.selectedClassName();
      const classFallbacks = getDefaultFallbacks(className);
      const defaultFallback = fallback || classFallbacks[channelKey] || channelKey;
      
      const channels = defaultChannels();
      const isStoreReady = isReady();
      const value = channels?.[channelKey] || defaultFallback;
      
      // Log warning if store is ready and API returned data but specific channel is missing
      // Don't warn if channels object is empty (API didn't return default_channels - using fallbacks is expected)
      // Skip warning for vmg_perc_name - it's not in API default_channels but fallback (VMG_PERC) is correct for HuniDB storage
      const hasChannelsFromAPI = channels && Object.keys(channels).length > 0;
      if (isStoreReady && hasChannelsFromAPI && !channels[channelKey] && channelKey !== 'vmg_perc_name') {
        logWarn(`DefaultChannelsStore: Channel ${channelKey} not found in database, using fallback: ${defaultFallback}`, {
          availableChannels: Object.keys(channels),
          projectKey: currentProjectKey,
          className
        });
      }
      
      // Log debug when store initializes and we have actual values
      if (isStoreReady && channels && channels[channelKey] && channels[channelKey] !== defaultFallback) {
        logDebug(`DefaultChannelsStore: Using actual channel name for ${channelKey}: ${channels[channelKey]}`);
      }
      
      return value;
    };
  };


  // Get class-aware fallbacks for the current class
  const getClassFallbacks = (): Record<string, string> => {
    const className = persistantStore.selectedClassName();
    return getDefaultFallbacks(className);
  };

  return {
    defaultChannels,
    isReady,
    refresh,
    getChannelName: getChannelNameGeneric,
    bspName: () => {
      const fallbacks = getClassFallbacks();
      return getChannelNameGeneric('bsp_name', fallbacks.bsp_name)();
    },
    twsName: () => {
      const fallbacks = getClassFallbacks();
      return getChannelNameGeneric('tws_name', fallbacks.tws_name)();
    },
    twdName: () => {
      const fallbacks = getClassFallbacks();
      return getChannelNameGeneric('twd_name', fallbacks.twd_name)();
    },
    twaName: () => {
      const fallbacks = getClassFallbacks();
      return getChannelNameGeneric('twa_name', fallbacks.twa_name)();
    },
    latName: () => {
      const fallbacks = getClassFallbacks();
      return getChannelNameGeneric('lat_name', fallbacks.lat_name)();
    },
    lngName: () => {
      const fallbacks = getClassFallbacks();
      return getChannelNameGeneric('lng_name', fallbacks.lng_name)();
    },
    hdgName: () => {
      const fallbacks = getClassFallbacks();
      return getChannelNameGeneric('hdg_name', fallbacks.hdg_name)();
    },
    sogName: () => {
      const fallbacks = getClassFallbacks();
      return getChannelNameGeneric('sog_name', fallbacks.sog_name)();
    },
    cogName: () => {
      const fallbacks = getClassFallbacks();
      return getChannelNameGeneric('cog_name', fallbacks.cog_name)();
    },
    vmgName: () => {
      const fallbacks = getClassFallbacks();
      return getChannelNameGeneric('vmg_name', fallbacks.vmg_name)();
    },
    vmgPercName: () => {
      const fallbacks = getClassFallbacks();
      return getChannelNameGeneric('vmg_perc_name', fallbacks.vmg_perc_name)();
    }
  };
});

