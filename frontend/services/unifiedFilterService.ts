/**
 * Unified Filter Service
 * 
 * Handles class-specific filter configurations and data loading
 * Supports different data classes (AC40, etc.) with different filter sets
 */

import { getData } from '../utils/global';
import { apiEndpoints } from '@config/env';
import { warn, error as logError, log } from '../utils/console';
import { persistantStore } from '../store/persistantStore';
import { unifiedDataAPI } from '../store/unifiedDataAPI';

const { selectedClassName, selectedProjectId, selectedDatasetId } = persistantStore;

export interface FilterChannel {
  name: string;
  type: 'float' | 'int' | 'datetime' | 'string';
  display_name: string;
  description?: string;
}

export interface FilterTypeConfig {
  type: 'directional' | 'numeric' | 'categorical';
  options?: string[];
  ranges?: Record<string, { min: number; max: number }>;
}

// Filter types can be:
// - string[] for directional filters (e.g., Twa: ["upwind", "downwind", ...])
// - "numeric" for numeric filters (e.g., Grade: "numeric")
// - "string" for string filters (e.g., Config: "string")
// - FilterTypeConfig object with type, options, and ranges
export type FilterTypeValue = string[] | 'numeric' | 'string' | FilterTypeConfig;

export interface ClassFilterConfig {
  class_name: string;
  version?: string;
  filter_channels: FilterChannel[];
  default_filters: string[];
  filter_types: Record<string, FilterTypeValue>;
  required_for_filtering?: boolean;
  cache_duration?: number;
}

export type FilterContext = 'dataset' | 'day' | 'fleet' | 'source';

export interface FilterDataPoint {
  Datetime: string | Date;
  [key: string]: any;
}

class UnifiedFilterService {
  private static filterConfigs: Map<string, ClassFilterConfig> = new Map();
  private static filterData: Map<string, FilterDataPoint[]> = new Map();
  private static lastLoadTime: Map<string, number> = new Map();

  /**
   * Get filter configuration for a specific class and context
   * @param className - The class name (e.g., "AC40")
   * @param context - The filter context: 'dataset', 'day', 'fleet', or 'source'
   * @param projectId - Optional project ID (uses persistantStore if not provided)
   */
  static async getFilterConfig(
    className: string, 
    context?: FilterContext,
    projectId?: number
  ): Promise<ClassFilterConfig> {
    // Build cache key with context
    const cacheKey = context ? `${className}_${context}` : className;
    
    if (this.filterConfigs.has(cacheKey)) {
      return this.filterConfigs.get(cacheKey)!;
    }

    try {
      // Get project_id from parameter or persistantStore
      const { selectedProjectId } = persistantStore;
      const currentProjectId = projectId || selectedProjectId();
      
      if (!currentProjectId) {
        throw new Error('No project selected');
      }

      // Determine object name based on context
      // Default to filters_dataset since 'filters' no longer exists
      let objectName = 'filters_dataset';
      if (context === 'dataset') {
        objectName = 'filters_dataset';
      } else if (context === 'day') {
        objectName = 'filters_day';
      } else if (context === 'fleet') {
        objectName = 'filters_fleet';
      } else if (context === 'source') {
        objectName = 'filters_source';
      }

      // Try to get from HuniDB first (faster, cached)
      try {
        const { huniDBStore } = await import('../store/huniDBStore');
        const cachedConfig = await huniDBStore.getObject(className, objectName);
        if (cachedConfig) {
          const config = cachedConfig as ClassFilterConfig;
          this.filterConfigs.set(cacheKey, config);
          log(`UnifiedFilterService: Retrieved ${context || 'default'} filter config from cache for ${className}`);
          return config;
        }
      } catch (cacheError) {
        // Fall through to API call if cache fails
        log(`UnifiedFilterService: Cache miss for ${objectName}, fetching from API`);
      }

      // Fallback to API call
      const response = await getData(
        `${apiEndpoints.app.classes}/object?class_name=${encodeURIComponent(className)}&project_id=${currentProjectId}&object_name=${encodeURIComponent(objectName)}`
      );

      if (!response.success || !response.data) {
        throw new Error(`Failed to fetch filter config for class: ${className}, context: ${context || 'default'}`);
      }

      const config = response.data as ClassFilterConfig;
      if (!config) {
        throw new Error(`Filter config is null for class: ${className}, context: ${context || 'default'}`);
      }
      this.filterConfigs.set(cacheKey, config);
      
      // Also cache in HuniDB for future use
      try {
        const { huniDBStore } = await import('../store/huniDBStore');
        await huniDBStore.storeObject(className, objectName, config);
        
        // Pre-cache other filter objects in background (non-blocking)
        // This helps internal components access any filter config without additional API calls
        // Pre-cache all filter objects regardless of context to ensure complete caching
        setTimeout(async () => {
          const allFilterObjects = ['filters_fleet', 'filters_day', 'filters_dataset', 'filters_source'];
          for (const otherObjectName of allFilterObjects) {
            // Skip the one we just cached
            if (otherObjectName === objectName) {
              continue;
            }
            
            try {
              // Check if already cached
              const cached = await huniDBStore.getObject(className, otherObjectName);
              if (!cached) {
                // Try to fetch and cache (non-blocking, don't fail if it doesn't exist)
                const otherResponse = await getData(
                  `${apiEndpoints.app.classes}/object?class_name=${encodeURIComponent(className)}&project_id=${currentProjectId}&object_name=${encodeURIComponent(otherObjectName)}`
                );
                if (otherResponse.success && otherResponse.data) {
                  await huniDBStore.storeObject(className, otherObjectName, otherResponse.data);
                  log(`UnifiedFilterService: Pre-cached ${otherObjectName} for ${className}`);
                }
              }
            } catch (preCacheError) {
              // Non-fatal - just log and continue
              log(`UnifiedFilterService: Could not pre-cache ${otherObjectName}: ${(preCacheError as Error).message}`);
            }
          }
        }, 0); // Defer to next tick to avoid blocking
      } catch (storeError) {
        // Non-fatal - just log
        log(`UnifiedFilterService: Could not cache filter config: ${(storeError as Error).message}`);
      }
      
      return config;
    } catch (error) {
      logError('Error fetching filter config:', error);
      // Return default AC40 config as fallback
      log(`UnifiedFilterService: Using fallback filter config for ${className} (${context || 'default'}) due to API error`);
      const fallbackConfig = this.getDefaultAC40Config();
      this.filterConfigs.set(cacheKey, fallbackConfig);
      return fallbackConfig;
    }
  }

  /**
   * Get required filter channels for a class and context
   * @param className - The class name (e.g., "AC40")
   * @param context - Optional filter context: 'dataset', 'day', 'fleet', or 'source'
   * @param projectId - Optional project ID (uses persistantStore if not provided)
   */
  static async getRequiredFilterChannels(
    className: string, 
    context?: FilterContext,
    projectId?: number
  ): Promise<string[]> {
    const config = await this.getFilterConfig(className, context, projectId);
    // Merge explicitly set defaults with all declared filter channel names
    const declaredChannelNames = (config.filter_channels || []).map(ch => ch.name).filter(Boolean);
    const defaults = Array.isArray(config.default_filters) ? config.default_filters : [];
    // Ensure uniqueness and preserve order: defaults first, then any extras
    const merged = [...defaults, ...declaredChannelNames.filter(name => !defaults.includes(name))];
    return merged;
  }

  /**
   * Get optional filter channels that may not be available in all datasets
   */
  static getOptionalFilterChannels(): string[] {
    return ['Grade'];
  }

  /**
   * Load filter data for the current session
   */
  static async loadFilterData(): Promise<FilterDataPoint[]> {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const datasetId = selectedDatasetId();

    if (!className || !projectId || !datasetId) {
      warn('Missing required parameters for filter data loading');
      return [];
    }

    const cacheKey = `${className}-${projectId}-${datasetId}`;
    const now = Date.now();
    const lastLoad = this.lastLoadTime.get(cacheKey) || 0;
    const config = await this.getFilterConfig(className);
    const cacheDuration = (config.cache_duration ?? 3600) * 1000; // Convert to milliseconds, default 1 hour

    // Check if we have cached data that's still valid
    if (this.filterData.has(cacheKey) && (now - lastLoad) < cacheDuration) {
      return this.filterData.get(cacheKey)!;
    }

    try {
      // Request all required channels (defaults + declared)
      const filterChannels = await this.getRequiredFilterChannels(className);
      
      // Use unified data API to get filter data
      const result = await unifiedDataAPI.getDataByChannels(filterChannels, {
        projectId: projectId.toString(),
        className: className,
        datasetId: datasetId.toString(),
        sourceName: 'default', // You might want to make this configurable
        date: new Date().toISOString().split('T')[0]
      });

      // Gracefully handle missing channels by logging and proceeding with available data
      if (Array.isArray(result?.missingChannels) && result.missingChannels.length > 0) {
        warn(`UnifiedFilterService: Skipping missing filter channels`, { missing: result.missingChannels });
      }

      if (!result || !Array.isArray(result.data) || result.data.length === 0) {
        warn('No filter data available from unified data store');
        return [];
      }

      // Process the data to match FilterDataPoint format
      const filterData = result.data.map(item => ({
        ...item,
        // Ensure Datetime is a valid Date, fallback to current time to avoid crashes
        Datetime: (() => {
          const d = new Date(item?.Datetime || item?.timestamp || Date.now());
          return isNaN(d.getTime()) ? new Date() : d;
        })()
      }));
      
      this.filterData.set(cacheKey, filterData);
      this.lastLoadTime.set(cacheKey, now);
      
      return filterData;
    } catch (error) {
      logError('Error loading filter data:', error);
      return [];
    }
  }

  /**
   * Get cached filter data
   */
  static getFilterData(): FilterDataPoint[] {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const datasetId = selectedDatasetId();
    
    if (!className || !projectId || !datasetId) {
      return [];
    }

    const cacheKey = `${className}-${projectId}-${datasetId}`;
    return this.filterData.get(cacheKey) || [];
  }

  /**
   * Clear filter data cache
   */
  static clearFilterData(): void {
    this.filterData.clear();
    this.lastLoadTime.clear();
  }


  /**
   * Get available color by options for a class and context
   * Returns an array of field names that can be used for coloring data points
   * @param className - The class name (e.g., "AC40")
   * @param context - Optional filter context: 'dataset', 'day', 'fleet', or 'source'
   * @param projectId - Optional project ID (uses persistantStore if not provided)
   * @returns Array of color option names in uppercase (e.g., ['TACK', 'GRADE', 'EVENT'])
   */
  static async getColorOptions(
    className: string,
    context?: FilterContext,
    projectId?: number
  ): Promise<string[]> {
    try {
      const config = await this.getFilterConfig(className, context, projectId);
      
      // Return empty array if config is null or undefined
      if (!config) {
        warn(`[UnifiedFilterService] getColorOptions: No filter config found for ${className}, context: ${context}`);
        return [];
      }
      
      // TACK should only be available for 'dataset' and 'source' contexts, not 'day' or 'fleet'
      const includeTack = context === 'dataset' || context === 'source';
      
      // First, check if default_groups exists in the config (for filters_fleet)
      // This is the preferred source for color options
      if ((config as any).default_groups && Array.isArray((config as any).default_groups)) {
        const defaultGroups = (config as any).default_groups as string[];
        const colorOptions: string[] = [];
        
        // Only include TACK for dataset and source contexts
        if (includeTack) {
          colorOptions.push('TACK');
        }
        
        // Map default_groups values to uppercase format
        for (const groupName of defaultGroups) {
          if (typeof groupName === 'string' && groupName.trim().length > 0) {
            // Map field names to expected uppercase format
            let colorName = groupName.toUpperCase();
            if (groupName.toLowerCase() === 'source_name' || groupName.toLowerCase() === 'source name') {
              colorName = 'SOURCE_NAME';
            } else if (groupName.toLowerCase() === 'grade') {
              colorName = 'GRADE';
            } else if (groupName.toLowerCase() === 'year') {
              colorName = 'YEAR';
            } else if (groupName.toLowerCase() === 'event') {
              colorName = 'EVENT';
            } else if (groupName.toLowerCase() === 'config') {
              colorName = 'CONFIG';
            } else if (groupName.toLowerCase() === 'race_number' || groupName.toLowerCase() === 'race number') {
              colorName = 'RACE';
            } else if (groupName.toLowerCase() === 'leg_number' || groupName.toLowerCase() === 'leg number') {
              colorName = 'LEG';
            }
            
            if (!colorOptions.includes(colorName)) {
              colorOptions.push(colorName);
            }
          }
        }
        
        // Return color options from default_groups if we have any
        if (colorOptions.length > 0) {
          return colorOptions;
        }
      }
      
      // Fallback to existing logic using filter_channels
      // Extract color-capable fields from filter_channels
      // These are typically categorical fields that can be used for grouping/coloring
      const colorOptions: string[] = [];
      
      // Only include TACK for dataset and source contexts
      if (includeTack) {
        colorOptions.push('TACK');
      }
      
      // Add fields from filter_channels that are suitable for coloring
      // These are typically string/categorical fields or fields with distinct values
      const colorCapableFields = [
        'Race_number', 'Leg_number',
        'Grade', 'Event', 'Config', 'Year', 'Source_name'
      ];
      
      for (const channel of config.filter_channels) {
        const channelName = channel.name;
        const upperName = channelName.toUpperCase();
        
        // Check if this field is color-capable
        // Match by name (case-insensitive) or check if it's a categorical type
        const isColorCapable = colorCapableFields.some(field => 
          field.toLowerCase() === channelName.toLowerCase() ||
          field.replace('_', '').toLowerCase() === channelName.replace('_', '').toLowerCase()
        );
        
        if (isColorCapable) {
          // Map to expected uppercase format
          let colorName = upperName;
          if (channelName.toLowerCase() === 'race_number') colorName = 'RACE';
          else if (channelName.toLowerCase() === 'leg_number') colorName = 'LEG';
          else if (channelName.toLowerCase() === 'source_name') colorName = 'SOURCE_NAME';
          
          if (!colorOptions.includes(colorName)) {
            colorOptions.push(colorName);
          }
        }
      }
      
      // Also check filter_types for categorical fields
      for (const [fieldName, filterType] of Object.entries(config.filter_types)) {
        const upperName = fieldName.toUpperCase();
        // If it's categorical or has options, it might be color-capable
        // Check if it's an object (not an array) with a type property
        if (typeof filterType === 'object' && !Array.isArray(filterType) && 'type' in filterType && (filterType as any).type === 'categorical') {
          if (!colorOptions.includes(upperName)) {
            colorOptions.push(upperName);
          }
        }
      }
      
      // Default fallback if no options found
      if (colorOptions.length === 0) {
        // Return context-appropriate fallback
        if (includeTack) {
          return ['TACK', 'GRADE'];
        } else {
          return ['GRADE'];
        }
      }
      
      return colorOptions;
    } catch (error) {
      logError('Error getting color options:', error);
      // Return context-appropriate fallback
      const includeTack = context === 'dataset' || context === 'source';
      if (includeTack) {
        return ['TACK', 'GRADE'];
      } else {
        return ['GRADE'];
      }
    }
  }

  /**
   * Get default AC40 configuration as fallback
   */
  private static getDefaultAC40Config(): ClassFilterConfig {
    return {
      class_name: "AC40",
      version: "1.0",
      filter_channels: [
        {
          name: "Twa_deg",
          type: "float",
          display_name: "True Wind Angle",
          description: "Wind angle relative to boat heading"
        },
        {
          name: "Race_number",
          type: "int",
          display_name: "Race Number",
          description: "Race identifier"
        },
        {
          name: "Leg_number",
          type: "int",
          display_name: "Leg Number",
          description: "Leg identifier within race"
        },
        {
          name: "Grade",
          type: "int",
          display_name: "Grade",
          description: "Data quality grade"
        },
        {
          name: "State",
          type: "string",
          display_name: "State",
          description: "Foiling state (H0, H1, H2)"
        }
      ],
      default_filters: ["Twa_deg", "Race_number", "Leg_number", "Grade", "State"],
      filter_types: {
        "Twa_deg": {
          type: "directional",
          options: ["upwind", "downwind", "reaching", "port", "stbd"],
          ranges: {
            "upwind": { min: 0, max: 75 },
            "downwind": { min: 125, max: 180 },
            "reaching": { min: 75, max: 125 }
          }
        },
        "Race_number": {
          type: "numeric",
          options: []
        },
        "Leg_number": {
          type: "numeric",
          options: []
        },
        "Grade": {
          type: "numeric",
          options: []
        },
        "State": {
          type: "categorical",
          options: ["H0", "H1", "H2"]
        }
      },
      required_for_filtering: true,
      cache_duration: 3600
    };
  }
}

export default UnifiedFilterService;
