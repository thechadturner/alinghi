import { createSignal, createEffect, createRoot, onCleanup, Accessor, Setter } from "solid-js";
import { persistentSettingsService } from "../services/persistentSettingsService";
import { user, isLoggedIn } from "./userStore";
import { debug, warn, log, error as logError } from "../utils/console";
import { getData } from "../utils/global";
import { apiEndpoints } from "@config/env";
import type { Theme } from "./themeStore";
import { normalizeSpeedDisplayUnit, readInitialSpeedDisplayUnitFromStorage, type SpeedDisplayUnit } from "../utils/speedUnits";

// Helper function to strip quotes from string values (handles double-stringification)
// This fixes cases where values were stored with extra quotes, e.g., "sourceName" instead of sourceName
const stripQuotes = (value: any): any => {
  if (typeof value === 'string' && value.length >= 2) {
    // Check if string starts and ends with matching quotes (potential double-stringification)
    const startsWithDoubleQuote = value.startsWith('"') && value.endsWith('"');
    const startsWithSingleQuote = value.startsWith("'") && value.endsWith("'");
    
    if (startsWithDoubleQuote || startsWithSingleQuote) {
      // Try to parse it as JSON first (handles escaped quotes properly)
      try {
        const parsed = JSON.parse(value);
        // If parsing succeeded and returned a string, check if it still has quotes
        // (indicating double-stringification: stored as "\"sourceName\"")
        if (typeof parsed === 'string') {
          // Recursively check if the parsed value also has quotes
          return stripQuotes(parsed);
        }
        // If it returned something else, return the original value
        return value;
      } catch {
        // If JSON.parse fails, manually strip the outer quotes
        // This handles cases where the value was stored as a raw string with quotes
        return value.slice(1, -1);
      }
    }
  }
  return value;
};

// Helper function to retrieve values from localStorage
const getStored = <T>(key: string, defaultValue: T): T => {
  // Check if localStorage is available (not available in Web Workers)
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return defaultValue;
  }
  
  const stored = localStorage.getItem(key);
  if (stored === null || stored === "undefined") {
    return defaultValue;
  }
  
  // Check for "[object Object]" which indicates an object was stored without JSON.stringify
  if (stored === "[object Object]") {
    warn(`[PersistentStore] Invalid stored value for ${key}: "[object Object]" - using default value`);
    // Clean up the invalid value
    try {
      localStorage.removeItem(key);
    } catch (e) {
      // Ignore cleanup errors
    }
    return defaultValue;
  }
  
  try {
    const parsed = JSON.parse(stored) as T;
    // Check if the parsed value is a string with quotes (double-stringification case)
    // This can happen if a value was stored as JSON.stringify(JSON.stringify(value))
    const cleaned = stripQuotes(parsed);
    return cleaned as T;
  } catch (error) {
    // If JSON parsing fails, check if we expected an object/array type
    // If defaultValue is an object/array, the stored value is likely corrupted
    if (typeof defaultValue === 'object' && defaultValue !== null) {
      warn(`[PersistentStore] Failed to parse stored value for ${key} (expected object/array):`, stored, '- using default value');
      // Clean up the invalid value
      try {
        localStorage.removeItem(key);
      } catch (e) {
        // Ignore cleanup errors
      }
      return defaultValue;
    }
    // For primitive types, try to strip quotes and return (for backward compatibility)
    const cleaned = stripQuotes(stored);
    return cleaned as T;
  }
};

// Function to create persistent signals with API sync
// Note: This function is called inside createRoot, so effects created here are properly tracked
const createPersistentSignal = <T>(key: string, defaultValue: T): [Accessor<T>, Setter<T>] => {
  const [value, setValue] = createSignal<T>(getStored(key, defaultValue));

  // Create effect inside the root context (this function is called within createRoot)
  createEffect(() => {
    const currentValue = value();
    // Check if localStorage is available (not available in Web Workers)
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(currentValue));
    } catch (error) {
      warn(`[PersistentStore] Failed to save ${key} to localStorage:`, error);
    }
  });

  return [value, setValue]; // Return both value and setter
};

// Function to save settings to API with debouncing
let saveTimeout: NodeJS.Timeout | null = null;
const saveToAPI = (settings: Partial<Record<string, any>>, className: string, projectId: number) => {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  
  saveTimeout = setTimeout(async () => {
    const currentUser = user();
    
    if (currentUser?.user_id) {
      try {
        await persistentSettingsService.saveSettings(
          currentUser.user_id,
          className, // Still pass for compatibility but not required by new API
          projectId, // Still pass for compatibility but not required by new API
          settings
        );
        debug('[PersistentStore] Settings saved to API:', settings);
      } catch (error) {
        warn('[PersistentStore] Failed to save settings to API:', error);
      }
    } else {
      debug('[PersistentStore] Cannot save settings - no user logged in');
    }
  }, 500);
};

// Define the structure of the persistent store
interface PersistentStore {
  projects: Accessor<any[]>;
  setProjects: Setter<any[]>;
  selectedClassName: Accessor<string>;
  setSelectedClassName: (value: string | ((prev: string) => string)) => void;
  selectedClassIcon: Accessor<string | null>;
  setSelectedClassIcon: (value: string | null | ((prev: string | null) => string | null)) => void;
  selectedClassSizeM: Accessor<number | null>;
  setSelectedClassSizeM: (value: number | null | ((prev: number | null) => number | null)) => void;
  selectedClassObject: Accessor<{ class_name: string; icon?: string | null; size_m?: number | null } | null>;
  setSelectedClassObject: (value: { class_name: string; icon?: string | null; size_m?: number | null } | null | ((prev: { class_name: string; icon?: string | null; size_m?: number | null } | null) => { class_name: string; icon?: string | null; size_m?: number | null } | null)) => void;
  selectedProjectId: Accessor<number>;
  setSelectedProjectId: (value: number | ((prev: number) => number)) => void;
  projectHeader: Accessor<string>;
  setProjectHeader: (value: string | ((prev: string) => string)) => void;
  selectedSourceId: Accessor<number>;
  setSelectedSourceId: (value: number | ((prev: number) => number)) => void;
  selectedSourceName: Accessor<string>;
  setSelectedSourceName: (value: string | ((prev: string) => string)) => void;
  selectedDatasetId: Accessor<number>;
  setSelectedDatasetId: (value: number | ((prev: number) => number)) => void;
  selectedDate: Accessor<string>;
  setSelectedDate: (value: string | ((prev: string) => string)) => void;
  selectedYear: Accessor<string>;
  setSelectedYear: (value: string | ((prev: string) => string)) => void;
  selectedEvent: Accessor<string>;
  setSelectedEvent: (value: string | ((prev: string) => string)) => void;
  selectedMenu: Accessor<string>;
  setSelectedMenu: (value: string | ((prev: string) => string)) => void;
  selectedPage: Accessor<string>;
  setSelectedPage: (value: string | ((prev: string) => string)) => void;
  colorType: Accessor<string>;
  setColorType: (value: string | ((prev: string) => string)) => void;
  filterChartsBySelection: Accessor<boolean>;
  setFilterChartsBySelection: (value: boolean | ((prev: boolean) => boolean)) => void;
  defaultUnits: Accessor<SpeedDisplayUnit>;
  setDefaultUnits: (value: SpeedDisplayUnit | ((prev: SpeedDisplayUnit) => SpeedDisplayUnit)) => void;
  // Map overlay settings
  mapOverlays: Accessor<Record<string, boolean>>;
  setMapOverlays: (value: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void;
  // Chart overlay positions (keyed by overlay/chart object name)
  overlayPositions: Accessor<Record<string, { position: { x: number; y: number }; orientation: string }>>;
  setOverlayPositions: (value: Record<string, { position: { x: number; y: number }; orientation: string }> | ((prev: Record<string, { position: { x: number; y: number }; orientation: string }>) => Record<string, { position: { x: number; y: number }; orientation: string }>)) => void;
  // API sync functions
  loadPersistentSettings: () => Promise<boolean>;
  savePersistentSettings: () => void;
  initializeAndSaveSettings: (userId: string, className: string, projectId: number) => Promise<void>;
  // Cache initialization tracking
  isCacheInitialized: Accessor<boolean>;
  setIsCacheInitialized: (value: boolean | ((prev: boolean) => boolean)) => void;
  initializeApplicationCache: () => Promise<void>;
}

// Create the persistent store inside createRoot
export const persistantStore = createRoot<PersistentStore>(() => {
  const [projects, setProjects] = createPersistentSignal<any[]>("projects", []);
  const [selectedClassObject, setSelectedClassObjectBase] = createPersistentSignal<{ class_name: string; icon?: string | null; size_m?: number | null } | null>("selectedClassObject", null);
  
  // selectedClassName is derived from selectedClassObject
  const selectedClassName = () => {
    const classObject = selectedClassObject();
    if (classObject && classObject.class_name) {
      return classObject.class_name.toLowerCase().replace(/^hunico_/i, '');
    }
    return '';
  };
  
  // Keep selectedClassIcon and selectedClassSizeM for backward compatibility, but they're also in selectedClassObject
  const [selectedClassIcon, setSelectedClassIconBase] = createPersistentSignal<string | null>("selectedClassIcon", null);
  const [selectedClassSizeM, setSelectedClassSizeMBase] = createPersistentSignal<number | null>("selectedClassSizeM", null);
  const [selectedProjectId, setSelectedProjectIdBase] = createPersistentSignal<number>("selectedProjectId", 0);
  const [projectHeader, setProjectHeaderBase] = createPersistentSignal<string>("projectHeader", "RACESIGHT");
  const [selectedSourceId, setSelectedSourceIdBase] = createPersistentSignal<number>("selectedSourceId", 0);
  const [selectedSourceName, setSelectedSourceNameBase] = createPersistentSignal<string>("selectedSourceName", "");
  const [selectedDatasetId, setSelectedDatasetIdBase] = createPersistentSignal<number>("selectedDatasetId", 0);
  const [selectedDate, setSelectedDateBase] = createPersistentSignal<string>("selectedDate", "");
  const [selectedYear, setSelectedYearBase] = createPersistentSignal<string>("selectedYear", "");
  const [selectedEvent, setSelectedEventBase] = createPersistentSignal<string>("selectedEvent", "");
  const [selectedMenu, setSelectedMenuBase] = createPersistentSignal<string>("selectedMenu", "Datasets");
  const [selectedPage, setSelectedPageBase] = createPersistentSignal<string>("selectedPage", "");
  const [colorType, setColorTypeBase] = createPersistentSignal<string>("colorType", "DEFAULT");
  const [filterChartsBySelection, setFilterChartsBySelectionBase] = createPersistentSignal<boolean>("filterChartsBySelection", false);

  // Speed display: kts | kph (persisted). Legacy knots/meters normalized via effect below.
  const [defaultUnits, setDefaultUnitsBase] = createPersistentSignal<SpeedDisplayUnit>(
    "defaultUnits",
    readInitialSpeedDisplayUnitFromStorage()
  );

  createEffect(() => {
    const u = defaultUnits();
    const normalized = normalizeSpeedDisplayUnit(u);
    if (normalized !== u) {
      setDefaultUnitsBase(normalized);
      debug('[PersistentStore] Migrated defaultUnits to speed display:', u, '→', normalized);
    }
  });

  const setDefaultUnits = (value: SpeedDisplayUnit | ((prev: SpeedDisplayUnit) => SpeedDisplayUnit)) => {
    const next = typeof value === 'function' ? value(defaultUnits()) : value;
    setDefaultUnitsBase(normalizeSpeedDisplayUnit(next));
  };
  const [mapOverlays, setMapOverlaysBase] = createPersistentSignal<Record<string, boolean>>("mapOverlays", {});
  const [overlayPositions, setOverlayPositionsBase] = createPersistentSignal<Record<string, { position: { x: number; y: number }; orientation: string }>>("overlayPositions", {});
  const [isCacheInitialized, setIsCacheInitialized] = createPersistentSignal<boolean>("cacheInitialized", false);

  // Helper function to determine current mode (dataset or day)
  const getCurrentMode = (): 'dataset' | 'day' | null => {
    const datasetId = selectedDatasetId();
    const date = selectedDate();
    
    if (datasetId > 0) {
      return 'dataset';
    } else if (typeof date === 'string' && date.trim() !== '') {
      return 'day';
    }
    return null;
  };

  // Helper function to check if menu is a history page
  const isHistoryMenu = (menuName: string): boolean => {
    if (!menuName) return false;
    const upperMenu = menuName.toUpperCase();
    return upperMenu.includes('HISTORY');
  };

  // Helper: load settings from API and apply menu + selectedPage to store (so submenu state is from API, not localStorage).
  // Returns the last menu name for the mode, or null. Call this when entering dataset/day mode so restoration uses user settings.
  const restoreLastMenuForMode = async (mode: 'dataset' | 'day'): Promise<string | null> => {
    const currentUser = user();
    if (!currentUser?.user_id) {
      return null;
    }

    try {
      const settings = await persistentSettingsService.loadSettings(
        currentUser.user_id,
        '',
        0
      );

      if (settings) {
        let menuToRestore: string | null = null;
        if (mode === 'dataset' && settings.lastMenu_dataset && !isHistoryMenu(settings.lastMenu_dataset)) {
          menuToRestore = settings.lastMenu_dataset;
          debug('[PersistentStore] Restoring last dataset menu from API:', menuToRestore);
        } else if (mode === 'day' && settings.lastMenu_day && !isHistoryMenu(settings.lastMenu_day)) {
          menuToRestore = settings.lastMenu_day;
          debug('[PersistentStore] Restoring last day menu from API:', menuToRestore);
        }
        if (menuToRestore) {
          setSelectedMenuBase(menuToRestore);
          if (settings.selectedPage !== undefined && typeof settings.selectedPage === 'string') {
            setSelectedPageBase(settings.selectedPage);
            debug('[PersistentStore] Restored selectedPage from API:', settings.selectedPage);
          }
          return menuToRestore;
        }
      }
    } catch (error) {
      warn('[PersistentStore] Failed to load settings for menu restoration:', error);
    }

    return null;
  };

  // Helper function to save all current settings to API
  const saveAllSettingsToAPI = () => {
    const allSettings: any = {
      colorType: colorType(),
      filterChartsBySelection: filterChartsBySelection(),
      selectedClassName: selectedClassName(),
      selectedClassIcon: selectedClassIcon(),
      selectedClassSizeM: selectedClassSizeM(),
      selectedDatasetId: selectedDatasetId(),
      selectedDate: selectedDate(),
      selectedEvent: selectedEvent(),
      selectedMenu: selectedMenu(),
      selectedPage: selectedPage(),
      selectedProjectId: selectedProjectId(),
      selectedSourceId: selectedSourceId(),
      selectedSourceName: selectedSourceName(),
      selectedYear: selectedYear(),
      defaultUnits: defaultUnits(),
      mapOverlays: mapOverlays(),
      overlayPositions: overlayPositions()
    };
    
    // Save last menu for current mode (if not a history page)
    const currentMenu = selectedMenu();
    const currentMode = getCurrentMode();
    if (currentMode && currentMenu && !isHistoryMenu(currentMenu)) {
      if (currentMode === 'dataset') {
        allSettings.lastMenu_dataset = currentMenu;
      } else if (currentMode === 'day') {
        allSettings.lastMenu_day = currentMenu;
      }
    }
    
    saveToAPI(allSettings, selectedClassName(), selectedProjectId());
  };

  // Function to load project header from API using project_objects
  // Only sets header to "RACESIGHT" if project is invalid or header cannot be loaded
  // Preserves existing header during loading to prevent unnecessary toggles
  const loadProjectHeader = async (projectId: number, signal?: AbortSignal) => {
    if (!projectId || projectId === 0) {
      // Only reset to RACESIGHT if we're actually on index page or no project
      // Check if we're on index page by checking window location
      if (typeof window !== 'undefined' && window.location.pathname === '/') {
        setProjectHeaderBase("RACESIGHT");
      }
      return;
    }

    try {
      const controller = signal ? null : new AbortController();
      const abortSignal = signal || controller!.signal;
      
      // First, get project data to retrieve class_name
      const projectResponse = await getData(`${apiEndpoints.app.projects}/id?project_id=${projectId}`, abortSignal);
      
      if (!projectResponse.success || !projectResponse.data) {
        // Don't reset to RACESIGHT here - preserve current header if project fetch fails
        debug('[PersistentStore] Failed to fetch project data, preserving current header');
        return;
      }

      const class_name = projectResponse.data.class_name?.toLowerCase();
      if (!class_name) {
        // Don't reset to RACESIGHT here - preserve current header if class_name is missing
        debug('[PersistentStore] No class_name in project data, preserving current header');
        return;
      }

      // Retrieve project header from project_objects
      // Use '1970-01-01' as the date since headers are stored with this date
      const headerDate = '1970-01-01'; // YYYY-MM-DD format
      const headerResponse = await getData(
        `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(class_name)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(headerDate)}&object_name=header`,
        abortSignal
      );

      if (headerResponse.success && headerResponse.data) {
        // Parse JSON and extract header field
        const headerObj = typeof headerResponse.data === 'string' ? JSON.parse(headerResponse.data) : headerResponse.data;
        const header = headerObj?.header || "RACESIGHT";
        setProjectHeaderBase(header);
        debug('[PersistentStore] Project header loaded from project_objects:', header);
      } else {
        // If no header object found, set to RACESIGHT (project without a header)
        setProjectHeaderBase("RACESIGHT");
        debug('[PersistentStore] No project header object found, using default RACESIGHT');
      }
    } catch (error) {
      // Silently ignore AbortErrors - they're expected when requests are cancelled
      if ((error as Error)?.name !== 'AbortError') {
        debug('[PersistentStore] Error loading project header:', error);
        // Don't reset to RACESIGHT on error - preserve current header
      }
    }
  };

  // Enhanced setters that trigger API sync for key fields
  const setSelectedProjectId = (value: number | ((prev: number) => number)) => {
    const oldValue = selectedProjectId();
    const newValue = typeof value === 'function' ? value(oldValue) : value;
    
    // Only clear menu/dataset/date when *switching* from one project to another (both > 0).
    // Do not clear when initializing project on load (oldValue === 0) so that after a hard
    // refresh, selectedDatasetId/selectedDate from persistence are preserved.
    if (oldValue !== newValue && newValue > 0 && oldValue > 0) {
      debug('[PersistentStore] Project changed, clearing menu/dataset/date state', {
        oldProjectId: oldValue,
        newProjectId: newValue
      });
      setSelectedMenuBase('');
      setSelectedPageBase('');
      setSelectedDatasetIdBase(0);
      setSelectedDateBase('');
    }
    
    setSelectedProjectIdBase(newValue);
    saveAllSettingsToAPI();
    // Note: loadProjectHeader is called automatically by the createEffect below when selectedProjectId changes
  };

  // Watch for selectedProjectId changes and load header
  createEffect(() => {
    const projectId = selectedProjectId();
    const abortController = new AbortController();
    
    // Only make API requests if user is logged in
    if (projectId && projectId > 0 && isLoggedIn()) {
      // Load header with abort signal
      loadProjectHeader(projectId, abortController.signal).catch(() => {
        // Ignore errors from aborted requests
      });

      // Validate dataset cache when project changes
      // Use dynamic import to avoid circular dependency
      const className = selectedClassName();
      if (className) {
        import('./unifiedDataStore.js').then(({ unifiedDataStore }) => {
          debug('[PersistentStore] Validating dataset cache on project change');
          unifiedDataStore.validateDatasetCache(className, projectId).catch((err) => {
            // Log but don't block - validation failures shouldn't prevent project switching
            if (!err?.message?.includes('AbortError')) {
              warn('[PersistentStore] Error validating dataset cache on project change:', err);
            }
          });
        });
      }
    } else {
      // Only reset to RACESIGHT if we're on the index page
      // This prevents unnecessary resets when logging in or during initialization
      if (typeof window !== 'undefined' && window.location.pathname === '/') {
        setProjectHeaderBase("RACESIGHT");
      }
    }
    
    // Cleanup: abort any pending requests when effect re-runs or is disposed
    onCleanup(() => {
      abortController.abort();
    });
  });

  const setSelectedDatasetId = (value: number | ((prev: number) => number)) => {
    const newValue = typeof value === 'function' ? value(selectedDatasetId()) : value;
    const wasDatasetMode = selectedDatasetId() > 0;
    const isEnteringDatasetMode = newValue > 0 && !wasDatasetMode;
    
    setSelectedDatasetIdBase(newValue);
    saveAllSettingsToAPI();
    
    // Update last_viewed_date in HuniDB when dataset is selected
    if (newValue > 0) {
      // Use dynamic import to avoid circular dependency
      import('./huniDBStore.js').then(({ huniDBStore }) => {
        huniDBStore.updateDatasetLastViewed(selectedClassName(), newValue.toString()).catch(err => {
          // Silently fail - mobile devices will error, that's expected
          if (!err?.message?.includes('mobile devices')) {
            warn('[PersistentStore] Failed to update dataset last viewed:', err);
          }
        });
      });

      // Validate dataset cache when dataset changes
      // Use dynamic import to avoid circular dependency
      const className = selectedClassName();
      const projectId = selectedProjectId();
      const sourceName = selectedSourceName();
      
      if (className && projectId && projectId > 0) {
        import('./unifiedDataStore.js').then(({ unifiedDataStore }) => {
          debug('[PersistentStore] Validating dataset cache on dataset change');
          unifiedDataStore.validateDatasetCache(className, projectId).catch((err) => {
            // Log but don't block - validation failures shouldn't prevent dataset switching
            if (!err?.message?.includes('AbortError')) {
              warn('[PersistentStore] Error validating dataset cache on dataset change:', err);
            }
          });
          
          // Load map data for the dataset (non-blocking background operation)
          debug('[PersistentStore] Loading map data for dataset initialization');
          unifiedDataStore.loadMapDataForDataset(className, projectId, newValue).catch((err) => {
            // Log but don't block - map data loading failures shouldn't prevent dataset switching
            if (!err?.message?.includes('AbortError')) {
              warn('[PersistentStore] Error loading map data for dataset:', err);
            }
          });
        });

        // Discover channels for the dataset (non-blocking background operation)
        if (sourceName) {
          import('./channelDiscoveryStore.js').then(({ discoverChannels }) => {
            // Check if we already have a date set
            const currentDate = selectedDate();
            if (typeof currentDate === 'string' && currentDate.trim() !== '') {
              // Use existing date
              debug('[PersistentStore] Discovering channels for dataset initialization (using existing date)');
              Promise.all([
                discoverChannels(currentDate, sourceName, 'FILE'),
                discoverChannels(currentDate, sourceName, 'INFLUX')
              ]).then(([fileChannels, influxChannels]) => {
                debug(`[PersistentStore] Discovered ${fileChannels.length} FILE channels and ${influxChannels.length} INFLUX channels for dataset ${newValue}`);
              }).catch(err => {
                if (!err?.message?.includes('AbortError')) {
                  warn('[PersistentStore] Error discovering channels for dataset:', err);
                }
              });
            } else {
              // Fetch dataset info to get the date
              import('../utils/global.js').then(({ getData }) => {
                import('@config/env').then(({ apiEndpoints }) => {
                  const controller = new AbortController();
                  getData(
                    `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(newValue)}`,
                    controller.signal
                  ).then(response => {
                    if (response.success && response.data?.date) {
                      const dateStr = response.data.date;
                      debug('[PersistentStore] Discovering channels for dataset initialization (fetched date from dataset)');
                      // Discover both FILE and INFLUX channels in parallel
                      Promise.all([
                        discoverChannels(dateStr, sourceName, 'FILE'),
                        discoverChannels(dateStr, sourceName, 'INFLUX')
                      ]).then(([fileChannels, influxChannels]) => {
                        debug(`[PersistentStore] Discovered ${fileChannels.length} FILE channels and ${influxChannels.length} INFLUX channels for dataset ${newValue}`);
                      }).catch(err => {
                        if (!err?.message?.includes('AbortError')) {
                          warn('[PersistentStore] Error discovering channels for dataset:', err);
                        }
                      });
                    }
                  }).catch(err => {
                    if (!err?.message?.includes('AbortError')) {
                      debug('[PersistentStore] Could not fetch dataset date for channel discovery:', err);
                    }
                  });
                });
              });
            }
          });
        }
      }
      
      // When entering dataset mode, clear menu/page; Sidebar will call restoreLastMenuForMode('dataset') and apply from API
      if (isEnteringDatasetMode) {
        setSelectedMenuBase('');
        setSelectedPageBase('');
      }
    }
  };

  const setSelectedDate = (value: string | ((prev: string) => string)) => {
    const prevDate = selectedDate();
    const newValue = typeof value === 'function' ? value(typeof prevDate === 'string' ? prevDate : '') : value;
    const safeNewValue = typeof newValue === 'string' ? newValue : '';
    const wasDayMode = typeof prevDate === 'string' && prevDate.trim() !== '';
    const isEnteringDayMode = safeNewValue.trim() !== '' && !wasDayMode && selectedDatasetId() === 0;
    
    setSelectedDateBase(safeNewValue);
    saveAllSettingsToAPI();
    
    // Discover channels when date is set (non-blocking background operation)
    if (safeNewValue.trim() !== '' && selectedDatasetId() === 0) {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      const sourceName = selectedSourceName();
      
      if (className && projectId && projectId > 0 && sourceName) {
        import('./channelDiscoveryStore.js').then(({ discoverChannels }) => {
          debug('[PersistentStore] Discovering channels for date initialization');
          // Discover both FILE and INFLUX channels in parallel
          Promise.all([
            discoverChannels(safeNewValue, sourceName, 'FILE'),
            discoverChannels(safeNewValue, sourceName, 'INFLUX')
          ]).then(([fileChannels, influxChannels]) => {
            debug(`[PersistentStore] Discovered ${fileChannels.length} FILE channels and ${influxChannels.length} INFLUX channels for date ${safeNewValue}`);
          }).catch(err => {
            if (!err?.message?.includes('AbortError')) {
              warn('[PersistentStore] Error discovering channels for date:', err);
            }
          });
        });
      }
    }
    
    // When entering day mode, clear menu/page; Sidebar will call restoreLastMenuForMode('day') and apply from API
    if (isEnteringDayMode && selectedDatasetId() === 0) {
      setSelectedMenuBase('');
      setSelectedPageBase('');
    }
  };

  const setColorType = (value: string | ((prev: string) => string)) => {
    const newValue = typeof value === 'function' ? value(colorType()) : value;
    setColorTypeBase(newValue);
    saveAllSettingsToAPI();
  };

  const setFilterChartsBySelection = (value: boolean | ((prev: boolean) => boolean)) => {
    const newValue = typeof value === 'function' ? value(filterChartsBySelection()) : value;
    setFilterChartsBySelectionBase(newValue);
    saveAllSettingsToAPI();
  };

  const setMapOverlays = (value: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => {
    const newValue = typeof value === 'function' ? value(mapOverlays()) : value;
    setMapOverlaysBase(newValue);
    saveAllSettingsToAPI();
  };

  const setOverlayPositions = (value: Record<string, { position: { x: number; y: number }; orientation: string }> | ((prev: Record<string, { position: { x: number; y: number }; orientation: string }>) => Record<string, { position: { x: number; y: number }; orientation: string }>)) => {
    const newValue = typeof value === 'function' ? value(overlayPositions()) : value;
    setOverlayPositionsBase(newValue);
    saveAllSettingsToAPI();
  };

  // Enhanced setters for remaining fields
  const setSelectedClassName = (value: string | ((prev: string) => string)) => {
    // For backward compatibility: if a string is passed, create a classObject from it
    const currentClassName = selectedClassName();
    const newClassName = typeof value === 'function' ? value(currentClassName) : value;
    
    if (typeof newClassName === 'string' && newClassName.trim() !== '') {
      // Create or update classObject with just the class_name
      const currentObject = selectedClassObject();
      setSelectedClassObjectBase({
        class_name: newClassName.toLowerCase().replace(/^hunico_/i, ''),
        icon: currentObject?.icon || null,
        size_m: currentObject?.size_m || null
      });
    } else {
      // If empty string, clear the object
      setSelectedClassObjectBase(null);
    }
    saveAllSettingsToAPI();
  };

  const setSelectedClassIcon = (value: string | null | ((prev: string | null) => string | null)) => {
    const newValue = typeof value === 'function' ? value(selectedClassIcon()) : value;
    setSelectedClassIconBase(newValue);
    saveAllSettingsToAPI();
  };

  const setSelectedClassSizeM = (value: number | null | ((prev: number | null) => number | null)) => {
    const newValue = typeof value === 'function' ? value(selectedClassSizeM()) : value;
    setSelectedClassSizeMBase(newValue);
    saveAllSettingsToAPI();
  };

  const setSelectedClassObject = (value: { class_name: string; icon?: string | null; size_m?: number | null } | null | ((prev: { class_name: string; icon?: string | null; size_m?: number | null } | null) => { class_name: string; icon?: string | null; size_m?: number | null } | null)) => {
    const newValue = typeof value === 'function' ? value(selectedClassObject()) : value;
    setSelectedClassObjectBase(newValue);
    saveAllSettingsToAPI();
  };

  const setSelectedSourceId = (value: number | ((prev: number) => number)) => {
    const newValue = typeof value === 'function' ? value(selectedSourceId()) : value;
    setSelectedSourceIdBase(newValue);
    saveAllSettingsToAPI();
  };

  const setSelectedSourceName = (value: string | ((prev: string) => string)) => {
    const newValue = typeof value === 'function' ? value(selectedSourceName()) : value;
    setSelectedSourceNameBase(newValue);
    saveAllSettingsToAPI();
  };

  const setSelectedYear = (value: string | ((prev: string) => string)) => {
    const newValue = typeof value === 'function' ? value(selectedYear()) : value;
    setSelectedYearBase(newValue);
    saveAllSettingsToAPI();
  };

  const setSelectedEvent = (value: string | ((prev: string) => string)) => {
    const newValue = typeof value === 'function' ? value(selectedEvent()) : value;
    setSelectedEventBase(newValue);
    saveAllSettingsToAPI();
  };

  const setSelectedMenu = (value: string | ((prev: string) => string)) => {
    const newValue = typeof value === 'function' ? value(selectedMenu()) : value;
    setSelectedMenuBase(newValue);
    
    // Save last menu for current mode (if not a history page)
    const currentMode = getCurrentMode();
    if (currentMode && newValue && !isHistoryMenu(newValue)) {
      const settingsToSave: any = {};
      if (currentMode === 'dataset') {
        settingsToSave.lastMenu_dataset = newValue;
      } else if (currentMode === 'day') {
        settingsToSave.lastMenu_day = newValue;
      }
      if (Object.keys(settingsToSave).length > 0) {
        saveToAPI(settingsToSave, selectedClassName(), selectedProjectId());
      }
    }
    
    saveAllSettingsToAPI();
  };

  const setSelectedPage = (value: string | ((prev: string) => string)) => {
    const newValue = typeof value === 'function' ? value(selectedPage()) : value;
    setSelectedPageBase(newValue);
    saveAllSettingsToAPI();
  };

  // Function to load settings from API
  const loadPersistentSettings = async (): Promise<boolean> => {
    const currentUser = user();
    
    if (!currentUser?.user_id) {
      debug('[PersistentStore] Cannot load settings - missing user');
      return false;
    }

    try {
      debug('[PersistentStore] Loading settings from API');
      const settings = await persistentSettingsService.loadSettings(
        currentUser.user_id,
        '', // className not needed for new API
        0   // projectId not needed for new API
      );

      if (settings) {
        // On refresh, prefer current store (localStorage) for selection state so the user
        // returns to where they were. Only overwrite with API when current value is default/empty.
        const currentMenu = selectedMenu();
        const currentPage = selectedPage();
        const currentDatasetId = selectedDatasetId();
        const currentDate = selectedDate();
        const currentSourceId = selectedSourceId();
        const currentSourceName = selectedSourceName();
        const shouldPreserveMenu = currentMenu && currentMenu !== '' && currentMenu !== 'Datasets';
        
        // Apply settings to signals (this will also update localStorage)
        if (settings.colorType !== undefined) setColorTypeBase(settings.colorType);
        if (settings.filterChartsBySelection !== undefined) setFilterChartsBySelectionBase(settings.filterChartsBySelection);
        // Migrate old selectedClassName to selectedClassObject if needed
        if (settings.selectedClassName !== undefined && typeof settings.selectedClassName === 'string') {
          setSelectedClassObjectBase({
            class_name: settings.selectedClassName.toLowerCase().replace(/^hunico_/i, ''),
            icon: settings.selectedClassIcon || null,
            size_m: settings.selectedClassSizeM || null
          });
        } else if (settings.selectedClassObject !== undefined) {
          setSelectedClassObjectBase(settings.selectedClassObject);
        }
        if (settings.selectedClassIcon !== undefined) setSelectedClassIconBase(settings.selectedClassIcon);
        if (settings.selectedClassSizeM !== undefined) setSelectedClassSizeMBase(settings.selectedClassSizeM);
        // Restore dataset, date, event only when current value is default (so refresh remembers where user was).
        // selectedDatasetId/selectedDate are only cleared when the user changes projectId, not on refresh/init.
        if (settings.selectedDatasetId !== undefined && currentDatasetId === 0) {
          setSelectedDatasetIdBase(settings.selectedDatasetId);
        } else if (currentDatasetId > 0) {
          debug('[PersistentStore] Preserving selectedDatasetId from localStorage on load:', currentDatasetId);
          // Ensure localStorage stays correct for next refresh (service may have cached API defaults)
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem('selectedDatasetId', JSON.stringify(currentDatasetId));
            }
          } catch (_) { /* ignore */ }
        }
        const dateEmpty = typeof currentDate !== 'string' ? true : currentDate.trim() === '';
        if (settings.selectedDate !== undefined && dateEmpty) {
          setSelectedDateBase(typeof settings.selectedDate === 'string' ? settings.selectedDate : '');
        } else if (typeof currentDate === 'string' && currentDate.trim() !== '') {
          debug('[PersistentStore] Preserving selectedDate from localStorage on load:', currentDate);
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem('selectedDate', JSON.stringify(currentDate));
            }
          } catch (_) { /* ignore */ }
        }
        if (settings.selectedEvent !== undefined) setSelectedEventBase(settings.selectedEvent);
        
        // Only apply selectedMenu from API if current menu is empty/default (preserve user navigation / refresh state)
        if (settings.selectedMenu !== undefined && !shouldPreserveMenu) {
          // Check if we should restore mode-specific last menu
          const currentMode = getCurrentMode();
          let menuToRestore = settings.selectedMenu;
          
          if (currentMode === 'dataset' && settings.lastMenu_dataset && !isHistoryMenu(settings.lastMenu_dataset)) {
            menuToRestore = settings.lastMenu_dataset;
            debug('[PersistentStore] Restoring last dataset menu:', menuToRestore);
          } else if (currentMode === 'day' && settings.lastMenu_day && !isHistoryMenu(settings.lastMenu_day)) {
            menuToRestore = settings.lastMenu_day;
            debug('[PersistentStore] Restoring last day menu:', menuToRestore);
          }
          
          setSelectedMenuBase(menuToRestore);
        } else if (shouldPreserveMenu) {
          debug('[PersistentStore] Preserving current menu from localStorage on load:', currentMenu);
        }
        // Apply selectedPage from API only when not preserving selection state
        if (settings.selectedPage !== undefined) {
          if (!shouldPreserveMenu) {
            setSelectedPageBase(settings.selectedPage);
            debug('[PersistentStore] Restoring page from API:', settings.selectedPage);
          } else if (!currentPage || currentPage === '') {
            setSelectedPageBase(settings.selectedPage);
            debug('[PersistentStore] Restoring page from API on reload (menu preserved, page was empty):', settings.selectedPage);
          } else {
            debug('[PersistentStore] Preserving current page from localStorage on load:', currentPage);
          }
        }
        const projectList = projects();
        const sessionProjectId = Number(selectedProjectId());
        const pidInProjectList = (list: any[], pid: number): boolean => {
          if (!Array.isArray(list) || !Number.isFinite(pid) || pid <= 0) return false;
          return list.some((p) => Number(p?.project_id) === pid);
        };

        if (settings.selectedProjectId !== undefined) {
          const apiProjectId = Number(settings.selectedProjectId);
          if (apiProjectId > 0 && pidInProjectList(projectList, apiProjectId)) {
            setSelectedProjectIdBase(apiProjectId);
            debug('[PersistentStore] Restored selectedProjectId from API:', apiProjectId);
          } else if (apiProjectId > 0 && projectList.length > 0) {
            const firstId = projectList[0]?.project_id;
            if (firstId && firstId > 0) {
              warn('[PersistentStore] API selectedProjectId not in current project list; using first project:', firstId);
              setSelectedProjectIdBase(firstId);
            }
          } else {
            // API stored 0 or invalid — do not clear a valid selection Sidebar/init just set (same idea as preserving datasetId)
            if (sessionProjectId > 0 && (projectList.length === 0 || pidInProjectList(projectList, sessionProjectId))) {
              debug('[PersistentStore] Preserving selectedProjectId from session; API had none/0:', sessionProjectId);
            } else if (projectList.length > 0) {
              const firstProjectId = projectList[0]?.project_id;
              if (firstProjectId && firstProjectId > 0) {
                debug('[PersistentStore] No valid selectedProjectId from API; selecting first project:', firstProjectId);
                setSelectedProjectIdBase(firstProjectId);
              }
            } else {
              setSelectedProjectIdBase(0);
            }
          }
        } else {
          // No projectId in settings - select first project if available
          if (projectList && projectList.length > 0) {
            const firstProjectId = projectList[0]?.project_id;
            if (firstProjectId && firstProjectId > 0) {
              debug('[PersistentStore] No projectId in settings, selecting first project:', firstProjectId);
              setSelectedProjectIdBase(firstProjectId);
            }
          }
        }
        if (settings.selectedSourceId !== undefined && currentSourceId === 0) {
          setSelectedSourceIdBase(settings.selectedSourceId);
        } else if (currentSourceId > 0) {
          debug('[PersistentStore] Preserving selectedSourceId from localStorage on load:', currentSourceId);
        }
        const sourceNameEmpty = typeof currentSourceName !== 'string' ? true : currentSourceName.trim() === '';
        if (settings.selectedSourceName !== undefined && sourceNameEmpty) {
          setSelectedSourceNameBase(typeof settings.selectedSourceName === 'string' ? settings.selectedSourceName : '');
        } else if (typeof currentSourceName === 'string' && currentSourceName.trim() !== '') {
          debug('[PersistentStore] Preserving selectedSourceName from localStorage on load:', currentSourceName);
        }
        if (settings.selectedYear !== undefined) setSelectedYearBase(settings.selectedYear);
        if (settings.mapOverlays !== undefined) setMapOverlaysBase(settings.mapOverlays);
        if (settings.overlayPositions !== undefined) setOverlayPositionsBase(settings.overlayPositions);

        // Apply theme setting from API
        if (settings['teamshare-theme'] !== undefined) {
          // Import themeStore dynamically to avoid circular dependency
          const { themeStore } = await import('./themeStore');
          themeStore.setTheme(settings['teamshare-theme']);
          debug('[PersistentStore] Theme loaded from API:', settings['teamshare-theme']);
        }

        // Apply defaultUnits setting from API (normalize legacy knots/meters)
        if (settings['defaultUnits'] !== undefined) {
          const nu = normalizeSpeedDisplayUnit(settings['defaultUnits']);
          setDefaultUnitsBase(nu);
          debug('[PersistentStore] DefaultUnits loaded from API:', settings['defaultUnits'], '→', nu);
        }

        debug('[PersistentStore] Settings loaded and applied from API');
        return true;
      } else {
        // No settings exist in API, we'll initialize them after we have className and projectId
        debug('[PersistentStore] No settings found in API, will initialize after className and projectId are set');
        return false;
      }
    } catch (error) {
      warn('[PersistentStore] Failed to load settings from API:', error);
      return false;
    }
  };

  // Function to initialize settings with current values and save to API
  const initializeAndSaveSettings = async (userId: string, className: string, projectId: number): Promise<void> => {
    try {
      // Get current theme from localStorage or default to 'medium'
      // Check if localStorage is available (not available in Web Workers)
      const themeValue = (typeof window !== 'undefined' && typeof localStorage !== 'undefined') 
        ? localStorage.getItem('teamshare-theme') || 'medium'
        : 'medium';
      // Support all three theme values: 'light', 'medium', 'dark'
      const currentTheme: Theme = (themeValue === 'light' || themeValue === 'medium' || themeValue === 'dark') 
        ? themeValue as Theme 
        : 'medium';
      
      const currentUnits: SpeedDisplayUnit = normalizeSpeedDisplayUnit(defaultUnits());
      
      const currentSettings = {
        'teamshare-theme': currentTheme,
        'defaultUnits': currentUnits,
        colorType: colorType(),
        filterChartsBySelection: filterChartsBySelection(),
        selectedClassName: className,
        selectedDatasetId: selectedDatasetId(),
        selectedDate: selectedDate(),
        selectedEvent: selectedEvent(),
        selectedMenu: selectedMenu(),
        selectedPage: selectedPage(),
        selectedProjectId: projectId,
        selectedSourceId: selectedSourceId(),
        selectedSourceName: selectedSourceName(),
        selectedYear: selectedYear(),
        mapOverlays: mapOverlays(),
        overlayPositions: overlayPositions()
      };

      // Save the initialized settings to API
      await persistentSettingsService.saveSettings(userId, className, projectId, currentSettings);
      
      // Apply theme from localStorage to ensure consistency
      // Import themeStore dynamically to avoid circular dependency
      const { themeStore } = await import('./themeStore');
      themeStore.setTheme(currentSettings['teamshare-theme']);

      if (currentSettings['defaultUnits'] !== undefined) {
        setDefaultUnitsBase(normalizeSpeedDisplayUnit(currentSettings['defaultUnits']));
      }

      debug('[PersistentStore] Settings initialized and saved to API');
    } catch (error) {
      warn('[PersistentStore] Failed to initialize settings:', error);
    }
  };

  // Function to save all current settings to API
  const savePersistentSettings = (): void => {
    const settings = {
      colorType: colorType(),
      filterChartsBySelection: filterChartsBySelection(),
      selectedClassName: selectedClassName(),
      selectedDatasetId: selectedDatasetId(),
      selectedDate: selectedDate(),
      selectedEvent: selectedEvent(),
      selectedMenu: selectedMenu(),
      selectedPage: selectedPage(),
      selectedProjectId: selectedProjectId(),
      selectedSourceId: selectedSourceId(),
      selectedSourceName: selectedSourceName(),
      selectedYear: selectedYear(),
      mapOverlays: mapOverlays(),
      overlayPositions: overlayPositions()
    };
    
    saveToAPI(settings, selectedClassName(), selectedProjectId());
  };

  // Helper function to fetch class info from API
  const fetchClassInfo = async (projectId: number): Promise<void> => {
    try {
      if (!projectId || projectId <= 0) {
        debug('[PersistentStore] fetchClassInfo: Invalid projectId:', projectId);
        return;
      }

      const controller = new AbortController();
      const url = `${apiEndpoints.app.projects}/class?project_id=${encodeURIComponent(projectId)}`;
      debug('[PersistentStore] fetchClassInfo URL:', url);

      const response = await getData(url, controller.signal);

      if (response.success && response.data) {
        let className: string;
        let icon: string | null = null;
        let sizeM: number | null = null;
        let classObject: { class_name: string; icon?: string | null; size_m?: number | null } | null = null;

        if (typeof response.data === 'string') {
          className = response.data.toLowerCase();
          classObject = { class_name: className };
        } else if (response.data && typeof response.data === 'object') {
          className = (response.data.class_name || '').toLowerCase();
          const iconValue = response.data.icon || response.data.Icon || null;
          icon = (iconValue && typeof iconValue === 'string' && iconValue.trim() !== '') ? iconValue.trim() : null;
          const sizeMValue = response.data.size_m !== null && response.data.size_m !== undefined
            ? Number(response.data.size_m)
            : null;
          sizeM = (!isNaN(sizeMValue as number) && sizeMValue !== null) ? sizeMValue : null;
          classObject = {
            class_name: className,
            icon: icon,
            size_m: sizeM
          };
        } else {
          logError('[PersistentStore] fetchClassInfo: Unexpected response data format:', response.data);
          return;
        }

        setSelectedClassObjectBase(classObject);
        setSelectedClassIconBase(icon);
        setSelectedClassSizeMBase(sizeM);
        debug('[PersistentStore] Class info fetched:', { className, icon, sizeM });
      } else {
        // Try to get className from projects data as fallback
        const currentProject = projects()?.find(p => p.project_id === projectId);
        if (currentProject && currentProject.class_name) {
          const fallbackClassName = currentProject.class_name.toLowerCase();
          warn('[PersistentStore] Using className from project data as fallback:', fallbackClassName);
          setSelectedClassObjectBase({ class_name: fallbackClassName });
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        debug('[PersistentStore] fetchClassInfo aborted');
      } else {
        logError('[PersistentStore] Error fetching class info:', error);
      }
    }
  };

  // Centralized function to initialize application cache
  const initializeApplicationCache = async (): Promise<void> => {
    // Check if already initialized
    if (isCacheInitialized()) {
      debug('[PersistentStore] Cache already initialized, skipping');
      return;
    }

    log('[PersistentStore] Starting application cache initialization...');

    try {
      // 1. Ensure projects are loaded
      let attempts = 0;
      const maxAttempts = 20; // Wait up to 2 seconds
      while ((!projects() || projects().length === 0) && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }

      if (!projects() || projects().length === 0) {
        warn('[PersistentStore] No projects available for initialization');
        // Set initialized anyway to prevent infinite retry
        setIsCacheInitialized(true);
        return;
      }

      debug('[PersistentStore] Projects loaded:', projects().length);

      // 2. Load user settings
      try {
        const settingsLoaded = await loadPersistentSettings();
        if (settingsLoaded) {
          debug('[PersistentStore] User settings loaded');
        } else {
          debug('[PersistentStore] No user settings found (will be initialized later)');
        }
      } catch (error) {
        logError('[PersistentStore] Error loading user settings:', error);
      }

      // 3. Ensure we have a project selected
      let currentProjectId = selectedProjectId();
      if (!currentProjectId || currentProjectId <= 0) {
        const firstProject = projects()[0];
        if (firstProject && firstProject.project_id) {
          currentProjectId = firstProject.project_id;
          setSelectedProjectIdBase(currentProjectId);
          debug('[PersistentStore] Selected first project:', currentProjectId);
        }
      }

      if (currentProjectId && currentProjectId > 0) {
        // 4. Fetch class info
        try {
          await fetchClassInfo(currentProjectId);
          debug('[PersistentStore] Class info fetched');
          
          // Wait a bit for className to be set (it's derived from selectedClassObject)
          // Give it a few attempts to ensure className is available
          let classNameAttempts = 0;
          let className = selectedClassName();
          while (!className && classNameAttempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 50));
            className = selectedClassName();
            classNameAttempts++;
          }
          
          if (!className) {
            warn('[PersistentStore] className not available after fetchClassInfo, will retry later');
          }
        } catch (error) {
          logError('[PersistentStore] Error fetching class info:', error);
        }

        // 5. Load project header
        // Note: loadProjectHeader is called automatically by the createEffect when selectedProjectId changes
        // No need to call it directly here to avoid duplicate calls

        // 6. Initialize sources (if className and projectId are available)
        // Re-check className after fetchClassInfo completes
        // Also ensure user is authenticated before initializing sources
        let className = selectedClassName();
        if (className && currentProjectId) {
          // Wait for user authentication if not already authenticated (handles hard refresh)
          try {
            const { isLoggedIn } = await import('./userStore');
            let loggedIn = isLoggedIn();
            if (!loggedIn) {
              debug('[PersistentStore] User not authenticated yet, waiting for authentication before initializing sources...');
              // Wait up to 5 seconds for authentication
              let authAttempts = 0;
              const maxAuthAttempts = 50; // 50 * 100ms = 5 seconds
              while (!loggedIn && authAttempts < maxAuthAttempts) {
                await new Promise(resolve => setTimeout(resolve, 100));
                loggedIn = isLoggedIn();
                authAttempts++;
              }
              
              if (!loggedIn) {
                debug('[PersistentStore] User still not authenticated after waiting, sources will initialize when authenticated');
                // Don't fail - the sourcesStore auth effect will handle retry
              } else {
                debug('[PersistentStore] User authenticated after waiting', { attempts: authAttempts });
              }
            }
            
            if (loggedIn) {
              const { sourcesStore } = await import('./sourcesStore');
              await sourcesStore.refresh();
              debug('[PersistentStore] Sources initialized', { className, projectId: currentProjectId });
            }
          } catch (error) {
            logError('[PersistentStore] Error initializing sources:', error);
          }

          // 7. Initialize default channels
          try {
            const { defaultChannelsStore } = await import('./defaultChannelsStore');
            await defaultChannelsStore.refresh();
            debug('[PersistentStore] Default channels initialized');
          } catch (error) {
            logError('[PersistentStore] Error initializing default channels:', error);
          }
        } else {
          debug('[PersistentStore] Skipping sources and channels initialization - missing className or projectId', {
            className,
            projectId: currentProjectId,
            classNameAvailable: !!selectedClassName(),
            classObjectAvailable: !!selectedClassObject()
          });
          
          // Set up a fallback: if className becomes available later, initialize sources
          // This handles the case where className is set asynchronously after initialization
          if (currentProjectId && !className) {
            debug('[PersistentStore] Setting up fallback sources initialization');
            // Use a small delay to allow className to be set, then check again
            setTimeout(async () => {
              const retryClassName = selectedClassName();
              if (retryClassName && currentProjectId) {
                try {
                  const { sourcesStore } = await import('./sourcesStore');
                  await sourcesStore.refresh();
                  debug('[PersistentStore] Sources initialized via fallback', { className: retryClassName, projectId: currentProjectId });
                } catch (error) {
                  logError('[PersistentStore] Error initializing sources via fallback:', error);
                }
              }
            }, 500);
          }
        }
      } else {
        debug('[PersistentStore] No project ID available, skipping project-specific initialization');
      }

      // Mark as initialized even if some components failed (to prevent infinite retry loops)
      setIsCacheInitialized(true);
      log('[PersistentStore] Application cache initialization completed');
    } catch (error) {
      logError('[PersistentStore] Error during cache initialization:', error);
      // Set initialized anyway to prevent infinite retry
      setIsCacheInitialized(true);
    }
  };

  // Cross-window synchronization for persistent store
  let _isUpdatingFromCrossWindow = false;

  if (typeof window !== 'undefined') {
    const handleCrossWindowUpdate = (event: CustomEvent) => {
      const payload = event.detail;
      if (!payload) return;
      
      _isUpdatingFromCrossWindow = true;
      
      // Update persistent store fields from cross-window sync
      // Use base setters to avoid triggering API sync during cross-window updates
      if (payload.selectedSourceId !== undefined) {
        setSelectedSourceIdBase(payload.selectedSourceId);
      }
      if (payload.selectedSourceName !== undefined) {
        setSelectedSourceNameBase(typeof payload.selectedSourceName === 'string' ? payload.selectedSourceName : '');
      }
      if (payload.selectedDatasetId !== undefined) {
        setSelectedDatasetIdBase(payload.selectedDatasetId);
      }
      if (payload.selectedDate !== undefined) {
        setSelectedDateBase(typeof payload.selectedDate === 'string' ? payload.selectedDate : '');
      }
      if (payload.selectedClassName !== undefined) {
        // Migrate old selectedClassName to selectedClassObject if needed
        if (payload.selectedClassName !== undefined && typeof payload.selectedClassName === 'string') {
          setSelectedClassObjectBase({
            class_name: payload.selectedClassName.toLowerCase().replace(/^hunico_/i, ''),
            icon: payload.selectedClassIcon || null,
            size_m: payload.selectedClassSizeM || null
          });
        } else if (payload.selectedClassObject !== undefined) {
          setSelectedClassObjectBase(payload.selectedClassObject);
        }
      }
      if (payload.selectedClassIcon !== undefined) {
        setSelectedClassIconBase(payload.selectedClassIcon);
      }
      if (payload.selectedClassSizeM !== undefined) {
        setSelectedClassSizeMBase(payload.selectedClassSizeM);
      }
      if (payload.selectedProjectId !== undefined) {
        setSelectedProjectIdBase(payload.selectedProjectId);
      }
      
      _isUpdatingFromCrossWindow = false;
    };
    
    window.addEventListener('persistentStoreUpdate', handleCrossWindowUpdate as EventListener);
  }

  // Return an object with both signals and their setters
  return {
    projects, setProjects,
    selectedClassName, setSelectedClassName,
    selectedClassIcon, setSelectedClassIcon,
    selectedClassSizeM, setSelectedClassSizeM,
    selectedClassObject, setSelectedClassObject,
    selectedProjectId, setSelectedProjectId,
    projectHeader, setProjectHeader: setProjectHeaderBase,
    selectedSourceId, setSelectedSourceId,
    selectedSourceName, setSelectedSourceName,
    selectedDatasetId, setSelectedDatasetId,
    selectedDate, setSelectedDate,
    selectedYear, setSelectedYear,
    selectedEvent, setSelectedEvent,
    selectedMenu, setSelectedMenu,
    selectedPage, setSelectedPage,
    colorType, setColorType,
    filterChartsBySelection, setFilterChartsBySelection,
    defaultUnits, setDefaultUnits,
    mapOverlays, setMapOverlays,
    overlayPositions, setOverlayPositions,
    loadPersistentSettings,
    savePersistentSettings,
    initializeAndSaveSettings,
    isCacheInitialized,
    setIsCacheInitialized,
    initializeApplicationCache,
    restoreLastMenuForMode
  };
});
