import { getData, postData, cleanQuotes } from '../utils/global';
import { debug, error as logError, warn } from '../utils/console';

// Define the structure of persistent settings
export interface PersistentSettings {
  'teamshare-theme': 'dark' | 'light' | 'medium';
  'defaultUnits'?: 'knots' | 'meters';
  colorType: string;
  selectedClassName: string;
  selectedDatasetId: number;
  selectedDate: string;
  selectedEvent: string;
  selectedMenu: string;
  selectedPage: string;
  selectedProjectId: number;
  selectedSourceId: number;
  selectedSourceName: string;
  selectedYear: string;
  // Map overlay settings
  mapOverlays?: {
    'bad-air'?: boolean;
    'boundaries'?: boolean;
    'wind-arrows'?: boolean;
    'current-arrows'?: boolean;
    'wind-contours'?: boolean;
    'maneuvers'?: boolean;
  };
  // Chart overlay positions (keyed by overlay/chart object name): persisted so drag position is reused
  overlayPositions?: Record<string, { position: { x: number; y: number }; orientation: string }>;
  // Performance highlights (persistent across sessions)
  performanceHighlights?: string;
  // Performance color preference (persistent across sessions)
  performanceColor?: string;
  // Performance target name (persistent across sessions)
  performanceTarget?: string;
  // Fleet performance sources (persistent across sessions)
  fleetPerformanceSources?: string[];
  // Maneuver filters (persistent across sessions)
  maneuverFilters?: {
    grades?: number[];
    states?: string[];
    races?: (number | string)[];
    legs?: number[];
    trainingRacing?: 'TRAINING' | 'RACING' | null;
  };
  // Performance filters (persistent across sessions)
  performanceFilters?: {
    grades?: string;
    year?: string;
    event?: string;
    config?: string;
    state?: string;
    trainingRacing?: 'TRAINING' | 'RACING' | null;
  };
  // Performance history date range (persistent across sessions)
  performanceHistoryDateRange?: {
    startDate?: string;
    endDate?: string;
  };
  // Last selected menu for each mode (dataset vs day)
  lastMenu_dataset?: string;
  lastMenu_day?: string;
  // Timeline visibility preference
  showTimeline?: boolean;
  // Channel picker data source preference
  channelPickerDataSource?: 'FILE' | 'INFLUX';
}

// Default settings values
const DEFAULT_SETTINGS: PersistentSettings = {
  'teamshare-theme': 'medium',
  colorType: 'DEFAULT',
  selectedClassName: '',
  selectedDatasetId: 0,
  selectedDate: '',
  selectedEvent: '',
  selectedMenu: 'Datasets',
  selectedPage: '',
  selectedProjectId: 0,
  selectedSourceId: 0,
  selectedSourceName: '',
  selectedYear: '',
  showTimeline: true,
  channelPickerDataSource: 'FILE'
};

class PersistentSettingsService {
  private saveTimeout: NodeJS.Timeout | null = null;
  /** Coalesce parallel loadSettings(userId, className, projectId) calls into one HTTP request. */
  private loadSettingsInflight = new Map<string, Promise<PersistentSettings | null>>();

  /**
   * Cache settings locally in both localStorage and HuniDB (per-class database)
   */
  private async cacheToLocalStores(
    userId: string,
    className: string,
    projectId: number,
    settings: Partial<PersistentSettings>
  ): Promise<void> {
    try {
      // LocalStorage cache (fast, global)
      this.applySettingsToLocalStorage(settings);
    } catch (err) {
      warn('[PersistentSettings] Failed to cache settings to localStorage:', err);
    }

    // HuniDB cache (per-class, structured)
    try {
      // Dynamic import to avoid heavy coupling / circular deps
      const { huniDBStore } = await import('../store/huniDBStore');
      const key = `user_settings_${userId}_${projectId}`;
      await huniDBStore.storeObject(className, key, settings);
      debug('[PersistentSettings] Cached settings to HuniDB', { key, className, projectId });
    } catch (err) {
      // HuniDB is an optimization; don't fail if it's not available
      warn('[PersistentSettings] Failed to cache settings to HuniDB (non-fatal):', err);
    }
  }

  /**
   * Load settings from HuniDB cache (per-class objects table)
   */
  private async loadFromHuniDB(
    userId: string,
    className: string,
    projectId: number
  ): Promise<PersistentSettings | null> {
    try {
      const { huniDBStore } = await import('../store/huniDBStore');
      const key = `user_settings_${userId}_${projectId}`;
      const cached = await huniDBStore.getObject(className, key);

      if (cached && typeof cached === 'object') {
        debug('[PersistentSettings] Loaded settings from HuniDB cache', { key, className, projectId });
        return { ...DEFAULT_SETTINGS, ...(cached as Partial<PersistentSettings>) };
      }

      debug('[PersistentSettings] No settings found in HuniDB cache', { key, className, projectId });
      return null;
    } catch (err) {
      // Log error and fall back to API
      debug('[PersistentSettings] Failed to load settings from HuniDB (falling back to API):', err);
      return null;
    }
  }

  /**
   * Load settings from API, fallback to localStorage if API fails
   * If no settings exist, return null to indicate initialization needed
   * Includes retry logic for network failures
   */
  async loadSettings(userId: string, className: string, projectId: number, retries: number = 3): Promise<PersistentSettings | null> {
    const key = `${userId}\0${className}\0${String(projectId)}`;
    const inflight = this.loadSettingsInflight.get(key);
    if (inflight) {
      debug('[PersistentSettings] Coalescing in-flight loadSettings', { userId, className, projectId });
      return inflight;
    }
    const promise = this.loadSettingsOnce(userId, className, projectId, retries).finally(() => {
      this.loadSettingsInflight.delete(key);
    });
    this.loadSettingsInflight.set(key, promise);
    return promise;
  }

  private async loadSettingsOnce(userId: string, className: string, projectId: number, retries: number = 3): Promise<PersistentSettings | null> {
    const url = `/api/users/settings?user_id=${encodeURIComponent(userId)}`;
    

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        debug(`[PersistentSettings] Loading settings from API (attempt ${attempt}/${retries})`, { userId, className, projectId });
        
        const response = await getData(url);
        
        debug('[PersistentSettings] API response:', { 
          success: response.success, 
          status: response.status, 
          hasData: !!response.data,
          dataType: typeof response.data,
          dataValue: response.data,
          message: response.message,
          error: response.error
        });
        
        // Check if response indicates no settings found
        // The API returns success: true with message but no data field when settings don't exist
        if (!response.success || response.data === null || response.data === undefined) {
          // Check if it's a 404 (not found) vs an actual error
          if (response.status === 404 || (response.message && response.message.includes('No settings found'))) {
            debug('[PersistentSettings] No settings found in API (404), returning null for initialization');
          } else if (response.success && !response.data && response.message) {
            // API returned success but no data - this means no settings exist
            debug('[PersistentSettings] API returned success but no data field, returning null for initialization');
          } else {
            debug('[PersistentSettings] Error loading settings from API:', response.message || response.error);
          }
          return null; // Indicate no settings exist, need to initialize
        }
        
        // Settings found - parse them
        debug('[PersistentSettings] Settings loaded from API', response.data);
        
        // Parse the JSON if it's a string, otherwise use it directly
        let parsedSettings: Partial<PersistentSettings>;
        if (typeof response.data === 'string') {
          try {
            parsedSettings = JSON.parse(response.data);
          } catch (parseError) {
            warn('[PersistentSettings] Failed to parse settings JSON string:', parseError);
            return null;
          }
        } else {
          // response.data is already an object (JSONB from PostgreSQL)
          parsedSettings = response.data;
        }
        
        // Ensure fleetPerformanceSources is properly parsed as an array
        if (parsedSettings.fleetPerformanceSources) {
          if (typeof parsedSettings.fleetPerformanceSources === 'string') {
            try {
              parsedSettings.fleetPerformanceSources = JSON.parse(parsedSettings.fleetPerformanceSources);
            } catch (parseError) {
              warn('[PersistentSettings] Failed to parse fleetPerformanceSources as array:', parseError);
              parsedSettings.fleetPerformanceSources = undefined;
            }
          }
          // Ensure it's an array
          if (!Array.isArray(parsedSettings.fleetPerformanceSources)) {
            warn('[PersistentSettings] fleetPerformanceSources is not an array, clearing it');
            parsedSettings.fleetPerformanceSources = undefined;
          }
        }
        
        // Clean string values that may have quotes
        const cleanedSettings = this.cleanSettingsStrings(parsedSettings);
        
        const merged = { ...DEFAULT_SETTINGS, ...cleanedSettings };

        // When caching, preserve selectedDatasetId and selectedDate from existing localStorage
        // if API has defaults (0 / ""). They should only be cleared when the user changes project,
        // not on refresh or initialization.
        try {
          if (typeof localStorage !== 'undefined') {
            if (merged.selectedDatasetId === 0) {
              const stored = localStorage.getItem('selectedDatasetId');
              if (stored !== null && stored !== 'undefined') {
                try {
                  const parsed = parseInt(JSON.parse(stored), 10);
                  if (!isNaN(parsed) && parsed > 0) {
                    merged.selectedDatasetId = parsed;
                    debug('[PersistentSettings] Preserving selectedDatasetId from localStorage when caching API load:', parsed);
                  }
                } catch {
                  // keep merged.selectedDatasetId 0
                }
              }
            }
            if (!merged.selectedDate || String(merged.selectedDate).trim() === '') {
              const stored = localStorage.getItem('selectedDate');
              if (stored !== null && stored !== 'undefined') {
                try {
                  const parsed = JSON.parse(stored);
                  if (typeof parsed === 'string' && parsed.trim() !== '') {
                    merged.selectedDate = parsed.trim();
                    debug('[PersistentSettings] Preserving selectedDate from localStorage when caching API load:', merged.selectedDate);
                  }
                } catch {
                  // keep merged.selectedDate ''
                }
              }
            }
          }
        } catch (e) {
          warn('[PersistentSettings] Error preserving dataset/date from localStorage:', e);
        }

        // Cache API-derived state so future reads (e.g. restoreLastMenuForMode) prefer server state over stale local
        void this.cacheToLocalStores(userId, className, projectId, merged);

        return merged;
      } catch (error) {
        const isLastAttempt = attempt === retries;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        if (isLastAttempt) {
          warn(`[PersistentSettings] Failed to load settings from API after ${retries} attempts, falling back to local caches:`, errorMessage);

          // Prefer HuniDB cache, then localStorage
          const huniCached = await this.loadFromHuniDB(userId, className, projectId);
          if (huniCached) {
            return huniCached;
          }

          return this.loadFromLocalStorage();
        } else {
          // Wait before retrying (exponential backoff)
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          debug(`[PersistentSettings] API load failed (attempt ${attempt}/${retries}), retrying in ${delay}ms:`, errorMessage);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    // Should never reach here, but TypeScript needs it
    return this.loadFromLocalStorage();
  }

  /**
   * Save settings to API with debouncing and retry logic
   * Merges new settings with existing settings to avoid overwriting other settings
   */
  async saveSettings(userId: string, className: string, projectId: number, settings: Partial<PersistentSettings>, retries: number = 3): Promise<void> {
    // Clear existing timeout
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    // Debounce saves by 500ms
    this.saveTimeout = setTimeout(async () => {
      // Load existing settings from cache first (fast, local) to merge with new settings
      // Prefer HuniDB cache, then localStorage, only fallback to API if both fail
      let existingSettings: PersistentSettings | null = null;
      
      try {
        // Try HuniDB cache first (fastest, per-class)
        existingSettings = await this.loadFromHuniDB(userId, className, projectId);
        
        // If not in HuniDB, try localStorage (also fast)
        if (!existingSettings) {
          existingSettings = this.loadFromLocalStorage();
          debug('[PersistentSettings] Using localStorage cache for merge');
        } else {
          debug('[PersistentSettings] Using HuniDB cache for merge');
        }
      } catch (error) {
        debug('[PersistentSettings] Could not load cached settings for merge, will use defaults:', error);
        // Fallback to localStorage if HuniDB fails
        try {
          existingSettings = this.loadFromLocalStorage();
        } catch (localError) {
          debug('[PersistentSettings] Could not load from localStorage either, will create new');
        }
      }
      
      // Merge existing settings with new settings (new settings override existing)
      const mergedSettings: Partial<PersistentSettings> = existingSettings 
        ? { ...existingSettings, ...settings }
        : { ...DEFAULT_SETTINGS, ...settings };

      // Immediately cache merged settings locally (localStorage + HuniDB) for faster access
      // even if API save fails or is delayed.
      void this.cacheToLocalStores(userId, className, projectId, mergedSettings);
      
      const payload = {
        user_id: userId,
        json: JSON.stringify(mergedSettings)
      };

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          debug(`[PersistentSettings] Saving settings to API (attempt ${attempt}/${retries})`, { userId, className, projectId, newSettings: settings, mergedSettings: mergedSettings });
          
          const response = await postData('/api/users/settings', payload);
          
          if (response.success) {
            debug('[PersistentSettings] Settings saved successfully to API');
            return; // Success, exit retry loop
          } else {
            const isLastAttempt = attempt === retries;
            if (isLastAttempt) {
              warn(`[PersistentSettings] Failed to save settings to API after ${retries} attempts:`, response.message);
            } else {
              const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
              debug(`[PersistentSettings] API save failed (attempt ${attempt}/${retries}), retrying in ${delay}ms:`, response.message);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        } catch (error) {
          const isLastAttempt = attempt === retries;
          const errorMessage = error instanceof Error ? error.message : String(error);
          
          if (isLastAttempt) {
            logError(`[PersistentSettings] Error saving settings to API after ${retries} attempts:`, errorMessage);
          } else {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            debug(`[PersistentSettings] API save error (attempt ${attempt}/${retries}), retrying in ${delay}ms:`, errorMessage);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
    }, 500);
  }

  /**
   * Clean string values in settings to remove quotes
   */
  private cleanSettingsStrings(settings: Partial<PersistentSettings>): Partial<PersistentSettings> {
    const cleaned: Partial<PersistentSettings> = { ...settings };
    
    // Clean string fields
    if (cleaned.selectedClassName && typeof cleaned.selectedClassName === 'string') {
      cleaned.selectedClassName = cleanQuotes(cleaned.selectedClassName);
    }
    if (cleaned.selectedDate && typeof cleaned.selectedDate === 'string') {
      cleaned.selectedDate = cleanQuotes(cleaned.selectedDate);
    }
    if (cleaned.selectedEvent && typeof cleaned.selectedEvent === 'string') {
      cleaned.selectedEvent = cleanQuotes(cleaned.selectedEvent);
    }
    if (cleaned.selectedMenu && typeof cleaned.selectedMenu === 'string') {
      cleaned.selectedMenu = cleanQuotes(cleaned.selectedMenu);
    }
    if (cleaned.selectedPage && typeof cleaned.selectedPage === 'string') {
      cleaned.selectedPage = cleanQuotes(cleaned.selectedPage);
    }
    if (cleaned.selectedSourceName && typeof cleaned.selectedSourceName === 'string') {
      cleaned.selectedSourceName = cleanQuotes(cleaned.selectedSourceName);
    }
    if (cleaned.selectedYear && typeof cleaned.selectedYear === 'string') {
      cleaned.selectedYear = cleanQuotes(cleaned.selectedYear);
    }
    if (cleaned.performanceColor && typeof cleaned.performanceColor === 'string') {
      cleaned.performanceColor = cleanQuotes(cleaned.performanceColor);
    }
    if (cleaned.performanceHighlights && typeof cleaned.performanceHighlights === 'string') {
      cleaned.performanceHighlights = cleanQuotes(cleaned.performanceHighlights);
    }
    if (cleaned.performanceTarget && typeof cleaned.performanceTarget === 'string') {
      cleaned.performanceTarget = cleanQuotes(cleaned.performanceTarget);
    }

    // Clean performanceFilters object
    if (cleaned.performanceFilters) {
      const filters = { ...cleaned.performanceFilters };
      if (filters.grades && typeof filters.grades === 'string') {
        filters.grades = cleanQuotes(filters.grades);
      }
      if (filters.year && typeof filters.year === 'string') {
        filters.year = cleanQuotes(filters.year);
      }
      if (filters.event && typeof filters.event === 'string') {
        filters.event = cleanQuotes(filters.event);
      }
      if (filters.config && typeof filters.config === 'string') {
        filters.config = cleanQuotes(filters.config);
      }
      if (filters.state && typeof filters.state === 'string') {
        filters.state = cleanQuotes(filters.state);
      }
      cleaned.performanceFilters = filters;
    }
    
    // Clean performanceHistoryDateRange object
    if (cleaned.performanceHistoryDateRange) {
      const dateRange = { ...cleaned.performanceHistoryDateRange };
      if (dateRange.startDate && typeof dateRange.startDate === 'string') {
        dateRange.startDate = cleanQuotes(dateRange.startDate);
      }
      if (dateRange.endDate && typeof dateRange.endDate === 'string') {
        dateRange.endDate = cleanQuotes(dateRange.endDate);
      }
      cleaned.performanceHistoryDateRange = dateRange;
    }
    
    return cleaned;
  }

  /**
   * Load settings from localStorage as fallback
   */
  private loadFromLocalStorage(): PersistentSettings {
    debug('[PersistentSettings] Loading settings from localStorage');
    
    const settings: Partial<PersistentSettings> = {};
    
    // Load each setting from localStorage
    const keys: (keyof PersistentSettings)[] = [
      'teamshare-theme', 'defaultUnits', 'colorType', 'selectedClassName', 'selectedDatasetId',
      'selectedDate', 'selectedEvent', 'selectedMenu', 'selectedPage',
      'selectedProjectId', 'selectedSourceId', 'selectedSourceName', 'selectedYear'
    ];
    
    // Also load defaultUnits from 'teamshare-units' localStorage key for backward compatibility
    try {
      const unitsValue = localStorage.getItem('teamshare-units');
      if (unitsValue === 'knots' || unitsValue === 'meters') {
        settings['defaultUnits'] = unitsValue;
      }
    } catch (error) {
      // Ignore error
    }

    keys.forEach(key => {
      try {
        const value = localStorage.getItem(key);
        if (value !== null) {
          // Parse JSON for complex values, clean quotes from strings
          if (key === 'selectedDatasetId' || key === 'selectedProjectId' || key === 'selectedSourceId') {
            settings[key] = parseInt(value) || 0;
          } else {
            // Clean quotes from string values
            settings[key] = cleanQuotes(value) as any;
          }
        }
      } catch (error) {
        warn(`[PersistentSettings] Error loading ${key} from localStorage:`, error);
      }
    });

    // Load overlayPositions from localStorage (object keyed by overlay name)
    try {
      const overlayPositionsValue = localStorage.getItem('overlayPositions');
      if (overlayPositionsValue !== null) {
        try {
          const parsed = JSON.parse(overlayPositionsValue);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            settings.overlayPositions = parsed;
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    // Load fleetPerformanceSources from localStorage (array needs JSON parsing)
    try {
      const fleetSourcesValue = localStorage.getItem('fleetPerformanceSources');
      if (fleetSourcesValue !== null) {
        try {
          const parsed = JSON.parse(fleetSourcesValue);
          if (Array.isArray(parsed)) {
            settings.fleetPerformanceSources = parsed;
          }
        } catch (parseError) {
          // If parsing fails, try to treat it as a single string (backward compatibility)
          warn('[PersistentSettings] Failed to parse fleetPerformanceSources, treating as single value');
        }
      }
    } catch (error) {
      warn('[PersistentSettings] Error loading fleetPerformanceSources from localStorage:', error);
    }

    const result = { ...DEFAULT_SETTINGS, ...settings };
    // Clean string values that may have quotes
    return this.cleanSettingsStrings(result) as PersistentSettings;
  }

  /**
   * Get current settings from localStorage (for immediate access)
   */
  getCurrentSettings(): PersistentSettings {
    return this.loadFromLocalStorage();
  }

  /**
   * Apply settings to localStorage (for caching)
   */
  applySettingsToLocalStorage(settings: Partial<PersistentSettings>): void {
    debug('[PersistentSettings] Applying settings to localStorage', settings);
    
    Object.entries(settings).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        // Properly serialize objects and arrays to JSON, keep primitives as strings
        if (typeof value === 'object') {
          try {
            localStorage.setItem(key, JSON.stringify(value));
          } catch (error) {
            warn(`[PersistentSettings] Failed to serialize ${key} to localStorage:`, error);
          }
        } else {
          localStorage.setItem(key, String(value));
        }
      }
    });
  }
}

// Export singleton instance
export const persistentSettingsService = new PersistentSettingsService();
