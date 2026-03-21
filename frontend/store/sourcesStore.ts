/**
 * Sources Store
 * 
 * Single source of truth for project sources (source_name, source_id, color, etc.)
 * Automatically initializes when a project is loaded and updates when project changes.
 * Components should use this store instead of fetching sources directly from the API.
 */

import { createRoot, createSignal, createEffect, Accessor } from 'solid-js';
import { fetchSources, Source, getSourceFallbackColor } from '../utils/colorScale';
import { persistantStore } from './persistantStore';
import { debug as logDebug, error as logError } from '../utils/console';
import { huniDBStore } from './huniDBStore';
import { isLoggedIn } from './userStore';

interface SourcesStore {
  /** Array of sources with source_name and color */
  sources: Accessor<Source[]>;
  /** Whether sources are loaded */
  isReady: Accessor<boolean>;
  /** Manually set sources (for live streaming mode) */
  setSources: (sources: Source[]) => void;
  /** Refresh sources from API (can be called manually if sources are missing). Pass true to always refetch (e.g. after add/remove on settings). */
  refresh: (forceRefresh?: boolean) => Promise<void>;
  /** Get source_id from source_name */
  getSourceId: (sourceName: string) => number | null;
  /** Get source_name from source_id */
  getSourceName: (sourceId: number) => string | null;
  /** Get source color from source_name */
  getSourceColor: (sourceName: string) => string | null;
}

// Track the current project key to detect changes
let currentProjectKey = '';
let initializationPromise: Promise<void> | null = null;

// Track if sources have been stored in hunidb for current project
let sourcesStoredInHuniDB = false;

export const sourcesStore = createRoot<SourcesStore>(() => {
  const [sources, setSources] = createSignal<Source[]>([]);
  const [isReady, setIsReady] = createSignal(false);

  /**
   * Fetch sources from API for the current project
   * First checks meta.sources cache, then falls back to API
   */
  const initializeSources = async (forceRefresh = false): Promise<void> => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();

    if (!className || !projectId) {
      logDebug('SourcesStore: No className or projectId, skipping initialization');
      setSources([]);
      setIsReady(false);
      currentProjectKey = '';
      return;
    }

    const projectKey = `${className}:${projectId}`;
    
    // If we already have sources for this project, don't refetch
    // But ensure they're stored in hunidb if they weren't before
    if (!forceRefresh && currentProjectKey === projectKey && sources().length > 0) {
      logDebug('SourcesStore: Sources already loaded for this project');
      // If sources weren't stored in hunidb yet, try to store them now
      if (!sourcesStoredInHuniDB && sources().length > 0) {
        try {
          await Promise.all(
            sources().map(source =>
              huniDBStore.trackSourceMetadata(
                className,
                projectId,
                source.source_id,
                source.source_name,
                source.color,
                source.fleet,
                source.visible
              )
            )
          );
          sourcesStoredInHuniDB = true;
          logDebug('SourcesStore: Stored existing sources in meta.sources cache (retry)', {
            count: sources().length
          });
        } catch (cacheError) {
          logError('SourcesStore: Error storing existing sources in cache (retry)', cacheError);
        }
      }
      setIsReady(true);
      return;
    }

    // Check if user is authenticated before attempting to fetch
    // If not authenticated, wait a bit and retry (handles hard refresh scenario)
    let loggedIn = isLoggedIn();
    if (!loggedIn) {
      logDebug('SourcesStore: User not authenticated yet, waiting for authentication...', {
        className,
        projectId
      });
      // Wait up to 5 seconds for authentication to complete (handles hard refresh)
      let attempts = 0;
      const maxAttempts = 50; // 50 * 100ms = 5 seconds
      while (!loggedIn && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 100));
        loggedIn = isLoggedIn();
        attempts++;
      }
      
      if (!loggedIn) {
        logDebug('SourcesStore: User still not authenticated after waiting, will retry when authenticated', {
          className,
          projectId,
          attempts
        });
        // Don't set isReady to false - let the auth effect handle retry
        return;
      }
      logDebug('SourcesStore: User authenticated after waiting', {
        className,
        projectId,
        attempts
      });
    }

    try {
      // Always fetch from API to ensure we have the complete list of sources
      // The cache might only contain sources that have been tracked (have data),
      // so we need to fetch from API to get all sources including new ones
      logDebug('SourcesStore: Fetching sources from API', { className, projectId, loggedIn });
      const fetchedSources = await fetchSources(className, projectId, forceRefresh);
      
      // Also check cache for any additional metadata (though API should be authoritative)
      const cachedSources = await huniDBStore.getSourcesFromCache(className, String(projectId));
      if (cachedSources && cachedSources.length > 0) {
        logDebug('SourcesStore: Found cached sources for metadata comparison', {
          cachedCount: cachedSources.length,
          apiCount: fetchedSources.length
        });
      }
      
      // Store sources in meta.sources cache
      if (fetchedSources.length > 0) {
        try {
          // Use Promise.all to ensure all sources are tracked before continuing
          // This ensures sources are consistently populated in hunidb after hard refresh
          await Promise.all(
            fetchedSources.map(source =>
              huniDBStore.trackSourceMetadata(
                className,
                projectId, // Pass as number, trackSourceMetadata will handle conversion
                source.source_id, // Pass as number, trackSourceMetadata will handle conversion
                source.source_name,
                source.color,
                source.fleet,
                source.visible
              )
            )
          );
          sourcesStoredInHuniDB = true;
          logDebug('SourcesStore: Stored sources in meta.sources cache', {
            count: fetchedSources.length,
            projectKey
          });
        } catch (cacheError) {
          logError('SourcesStore: Error storing sources in cache', cacheError);
          sourcesStoredInHuniDB = false;
          // Continue anyway - don't fail if cache write fails
          // But log the error so we can debug production issues
        }
      } else {
        sourcesStoredInHuniDB = false;
      }
      
      setSources(fetchedSources);
      setIsReady(true);
      
      // Reset hunidb tracking flag when project changes
      const projectChanged = currentProjectKey !== projectKey;
      currentProjectKey = projectKey;
      
      if (projectChanged) {
        sourcesStoredInHuniDB = false;
      }
      
      logDebug('SourcesStore: Sources loaded from API', {
        count: fetchedSources.length,
        sources: fetchedSources.map(s => ({ name: s.source_name, color: s.color }))
      });
    } catch (error) {
      logError('SourcesStore: Error fetching sources', error);
      setSources([]);
      setIsReady(false);
      currentProjectKey = '';
    }
  };

  /**
   * Refresh sources (called when project changes)
   */
  const refresh = async (forceRefresh = false): Promise<void> => {
    // If there's already an initialization in progress, wait for it
    if (initializationPromise) {
      await initializationPromise;
      if (!forceRefresh) {
        return;
      }
    }

    initializationPromise = initializeSources(forceRefresh);
    try {
      await initializationPromise;
    } finally {
      initializationPromise = null;
    }
  };

  // Watch for project/className changes and fetch sources
  createEffect(() => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    
    const projectKey = `${className}:${projectId}`;
    
    // Only fetch if project changed or sources not ready
    if (currentProjectKey !== projectKey || !isReady()) {
      if (className && projectId) {
        logDebug('SourcesStore: Project detected, initializing sources', { className, projectId, currentProjectKey, projectKey, isReady: isReady() });
        refresh();
      } else {
        // Clear sources if no valid project
        logDebug('SourcesStore: No valid project, clearing sources', { className, projectId });
        setSources([]);
        setIsReady(false);
        currentProjectKey = '';
      }
    }
  });
  
  // Explicit initialization check - ensure sources are loaded if project is already set
  // This handles the case where the store is created after the project is already selected
  // Also handles hard refresh scenarios where className might be set asynchronously
  createEffect(() => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    
    // If we have a project but sources aren't ready and no initialization is in progress
    if (className && projectId && !isReady() && !initializationPromise) {
      const projectKey = `${className}:${projectId}`;
      // Only initialize if we don't have sources for this project
      if (currentProjectKey !== projectKey || sources().length === 0) {
        logDebug('SourcesStore: Explicit initialization check - triggering refresh', { className, projectId });
        refresh();
      }
    }
  });
  
  // Additional fallback: periodically check if we need to initialize sources
  // This catches cases where className is set after the effects have run
  // Only runs if sources aren't ready and we have a valid project
  createEffect(() => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    
    // If we have both but sources aren't ready, set up a delayed check
    if (className && projectId && !isReady() && !initializationPromise) {
      const projectKey = `${className}:${projectId}`;
      if (currentProjectKey !== projectKey || sources().length === 0) {
        // Use a small delay to allow other initialization to complete first
        const timeoutId = setTimeout(() => {
          // Re-check conditions before initializing
          const currentClassName = persistantStore.selectedClassName();
          const currentProjectId = persistantStore.selectedProjectId();
          const currentProjectKey = `${currentClassName}:${currentProjectId}`;
          
          if (currentClassName && currentProjectId && !isReady() && !initializationPromise) {
            if (currentProjectKey !== projectKey || sources().length === 0) {
              logDebug('SourcesStore: Fallback initialization check - triggering refresh', { 
                className: currentClassName, 
                projectId: currentProjectId 
              });
              refresh();
            }
          }
        }, 1000); // Wait 1 second for other initialization to complete
        
        // Cleanup timeout on cleanup
        return () => clearTimeout(timeoutId);
      }
    }
  });
  
  // Watch for user authentication - retry sources initialization when user logs in
  // This handles the case where sourcesStore tries to initialize before user is authenticated
  // Access isLoggedIn signal to make this effect reactive to auth changes
  createEffect(() => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    const loggedIn = isLoggedIn(); // Track isLoggedIn signal reactively
    
    // Only retry if we have a project, user is logged in, but sources aren't ready
    if (className && projectId && loggedIn && !isReady() && !initializationPromise) {
      const projectKey = `${className}:${projectId}`;
      // Only retry if we don't have sources for this project
      if (currentProjectKey !== projectKey || sources().length === 0) {
        logDebug('SourcesStore: User authenticated, retrying sources initialization', {
          className,
          projectId,
          loggedIn
        });
        refresh();
      }
    }
  });

  /**
   * Manually set sources (for live streaming mode)
   */
  const setSourcesManually = (newSources: Source[]): void => {
    logDebug('SourcesStore: Manually setting sources', {
      count: newSources.length,
      sources: newSources.map(s => ({ name: s.source_name, color: s.color }))
    });
    setSources(newSources);
    setIsReady(true);
    // Clear project key to indicate these are manually set
    currentProjectKey = '';
  };

  /**
   * Get source_id from source_name (case-insensitive)
   */
  const getSourceId = (sourceName: string): number | null => {
    if (!sourceName) return null;
    const currentSources = sources();
    const sourceNameLower = String(sourceName).toLowerCase().trim();
    
    for (const source of currentSources) {
      if (source.source_name && String(source.source_name).toLowerCase().trim() === sourceNameLower) {
        return source.source_id;
      }
    }
    
    return null;
  };

  /**
   * Get source_name from source_id
   */
  const getSourceName = (sourceId: number): string | null => {
    if (!Number.isFinite(sourceId)) return null;
    const currentSources = sources();
    
    for (const source of currentSources) {
      if (source.source_id === sourceId) {
        return source.source_name;
      }
    }
    
    return null;
  };

  /**
   * Get source color from source_name (case-insensitive).
   * If the source is in the store but has no color (API returned null/empty), returns a deterministic
   * fallback color so dev and prod match (and no source gets grey from the 8th palette slot).
   */
  const getSourceColor = (sourceName: string): string | null => {
    if (!sourceName) return null;
    const currentSources = sources();
    const sourceNameLower = String(sourceName).toLowerCase().trim();
    
    for (const source of currentSources) {
      if (source.source_name && String(source.source_name).toLowerCase().trim() === sourceNameLower) {
        const color = source.color;
        if (color != null && String(color).trim() !== '') return color;
        return getSourceFallbackColor(sourceName);
      }
    }
    
    return null;
  };

  return {
    sources,
    isReady,
    setSources: setSourcesManually,
    refresh,
    getSourceId,
    getSourceName,
    getSourceColor
  };
});

