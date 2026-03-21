import { untrack } from 'solid-js';
import { debug, error as logError } from './console';
import { getData } from './global';
import { apiEndpoints } from '@config/env';
import { persistantStore } from '../store/persistantStore';

/**
 * Global color scale utility for consistent coloring across all components
 * 
 * EVENT COLOR SCALE:
 *    - Uses unique colors for first 8 event selections
 *    - Defaults to blue for selections beyond index 8
 *    - Use for coloring based on event IDs
 *    - Example: createD3EventColorScale([1, 2, 3, 4])
 * 
 * FLEET SOURCES:
 *    - fetchSources() - Fetches sources with colors from the API
 *    - Components should create their own D3 ordinal scales from sources
 *    - Example: d3.scaleOrdinal().domain(sourceNames).range(colors)
 * 
 * USAGE EXAMPLES:
 * 
 * // Event Color Scale
 * const eventIds = [1, 2, 3];
 * const eventScale = createD3EventColorScale(eventIds);
 * const color1 = eventScale(1); // Returns first color
 * const color2 = eventScale(2); // Returns second color
 * 
 * - Ensures consistent color assignment across map, charts, and maneuver pages
 */

// D3 color schemes for the first 8 unique colors
const S20_COLORS = [
  '#1f77b4', // Blue
  '#ff7f0e', // Orange  
  '#2ca02c', // Green
  '#d62728', // Red
  '#9467bd', // Purple
  '#8c564b', // Brown
  '#e377c2', // Pink
  '#7f7f7f'  // Gray
];

export const DEFAULT_COLOR = '#1f77b4'; // Blue for selections beyond index 8

/** First 7 S20 colors (no grey) - use for source fallback so no source gets grey when API returns no color */
const SOURCE_FALLBACK_COLORS = S20_COLORS.slice(0, 7);

/**
 * Deterministic color for a source name when API returns no color.
 * Same name always gets the same color across envs (dev/prod).
 */
export function getSourceFallbackColor(sourceName: string): string {
  if (!sourceName || typeof sourceName !== 'string') return DEFAULT_COLOR;
  let hash = 0;
  const str = sourceName.toLowerCase().trim();
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  const index = Math.abs(hash) % SOURCE_FALLBACK_COLORS.length;
  return SOURCE_FALLBACK_COLORS[index];
}

/**
 * Creates a consistent color scale for event IDs
 * @param eventIds - Array of unique event IDs to create colors for
 * @param maxUniqueColors - Maximum number of unique colors (default: 8)
 * @returns Object with domain (eventIds) and range (colors)
 */
export function createEventColorScale(eventIds: number[], maxUniqueColors: number = 8) {
  if (!eventIds || eventIds.length === 0) {
    debug('createEventColorScale: No event IDs provided');
    return { domain: [], range: [] };
  }

  // Use event IDs in the order they were provided (from selectedEvents order)
  // Don't sort them - the order matters for consistent color assignment
  const orderedEventIds = [...eventIds];
  
  // Create color range based on the order
  const colors = orderedEventIds.map((eventId, index) => {
    if (index < maxUniqueColors) {
      return S20_COLORS[index];
    } else {
      return DEFAULT_COLOR; // Blue for selections beyond index 8
    }
  });

  debug('createEventColorScale: Created color scale', {
    eventIds: orderedEventIds,
    colors: colors,
    maxUniqueColors,
    uniqueColorsUsed: Math.min(orderedEventIds.length, maxUniqueColors),
    defaultColorUsed: Math.max(0, orderedEventIds.length - maxUniqueColors)
  });

  return {
    domain: orderedEventIds,
    range: colors
  };
}

/**
 * Gets the color for a specific event ID
 * @param eventId - The event ID to get color for
 * @param eventIds - Array of all event IDs (for consistent ordering)
 * @param maxUniqueColors - Maximum number of unique colors (default: 8)
 * @returns Color string
 */
export function getEventColor(eventId: number, eventIds: number[], maxUniqueColors: number = 8): string {
  if (!eventIds || eventIds.length === 0) {
    return DEFAULT_COLOR;
  }

  // Use event IDs in the order they were provided (don't sort)
  const orderedEventIds = [...eventIds];
  const index = orderedEventIds.indexOf(eventId);
  
  if (index === -1) {
    return DEFAULT_COLOR;
  }

  if (index < maxUniqueColors) {
    return S20_COLORS[index];
  } else {
    return DEFAULT_COLOR;
  }
}

/**
 * Creates a D3 ordinal color scale for event IDs
 * @param eventIds - Array of unique event IDs
 * @param maxUniqueColors - Maximum number of unique colors (default: 8)
 * @returns D3 ordinal scale function
 */
export function createD3EventColorScale(eventIds: number[], maxUniqueColors: number = 8) {
  const colorScale = createEventColorScale(eventIds, maxUniqueColors);
  
  // Create a simple function that mimics D3's ordinal scale
  const scale = (eventId: number) => {
    return getEventColor(eventId, eventIds, maxUniqueColors);
  };
  
  // Add domain and range properties for compatibility
  scale.domain = colorScale.domain;
  scale.range = colorScale.range;
  
  return scale;
}

/**
 * Gets the color for a specific index (useful for consistent ordering)
 * @param index - The index (0-based)
 * @param maxUniqueColors - Maximum number of unique colors (default: 8)
 * @returns Color string
 */
export function getColorByIndex(index: number, maxUniqueColors: number = 8): string {
  if (index < maxUniqueColors) {
    return S20_COLORS[index];
  } else {
    return DEFAULT_COLOR;
  }
}

/**
 * Debug utility to log color scale information
 * @param component - Name of the component using the color scale
 * @param eventIds - Array of event IDs
 * @param colorScale - The color scale object
 */
export function debugColorScale(component: string, eventIds: number[], colorScale: any) {
  debug(`${component}: Color scale created`, {
    eventIds: eventIds,
    domain: colorScale.domain,
    range: colorScale.range,
    maxUniqueColors: 8,
    uniqueColorsUsed: Math.min(eventIds.length, 8),
    defaultColorUsed: Math.max(0, eventIds.length - 8)
  });
}

// ============================================================================
// Fleet Sources Functions
// ============================================================================

/**
 * Source type from API
 */
export interface Source {
  source_id: number;
  source_name: string;
  color: string;
  fleet?: number;
  visible?: number;
}

// Cache for sources to prevent duplicate API calls
let sourcesCache: { key: string; sources: Source[]; timestamp: number } | null = null;
const CACHE_TTL = 60000; // 1 minute cache TTL

/**
 * Fetches sources from the API for the current project
 * Uses caching to prevent duplicate API calls
 * 
 * @deprecated Internal use only - Components should use sourcesStore instead of calling this directly
 * This function is kept for internal use by sourcesStore only.
 * 
 * @param className - Optional class name (if not provided, uses persistantStore)
 * @param projectId - Optional project ID (if not provided, uses persistantStore)
 * @returns Promise resolving to array of sources
 */
export async function fetchSources(
  className?: string,
  projectId?: number
): Promise<Source[]> {
  // Check if user is logged in before making API requests
  // Use dynamic import to avoid circular dependencies
  try {
    const { isLoggedIn } = await import('../store/userStore');
    if (!isLoggedIn()) {
      debug('fetchSources: User not logged in, skipping API request');
      return [];
    }
  } catch (err) {
    // If import fails, assume not logged in to avoid making unauthorized requests
    debug('fetchSources: Could not check login status, skipping API request');
    return [];
  }
  
  const { selectedClassName, selectedProjectId } = persistantStore;
  // Use provided values if available, otherwise read from store (wrapped in untrack to avoid reactive issues)
  // IMPORTANT: If className/projectId are explicitly provided (even if falsy), use them
  // Only fall back to store if they're undefined
  const finalClassName = className !== undefined ? className : untrack(() => selectedClassName());
  const finalProjectId = projectId !== undefined ? projectId : untrack(() => selectedProjectId());

  if (!finalClassName || !finalProjectId) {
    debug('fetchSources: Missing className or projectId', {
      className: finalClassName,
      projectId: finalProjectId
    });
    return [];
  }

  // Check cache first
  const cacheKey = `${finalClassName}:${finalProjectId}`;
  const now = Date.now();
  if (sourcesCache && sourcesCache.key === cacheKey && (now - sourcesCache.timestamp) < CACHE_TTL) {
    debug('fetchSources: Using cached sources', {
      count: sourcesCache.sources.length,
      age: now - sourcesCache.timestamp
    });
    return sourcesCache.sources;
  }

  try {
    const response = await getData(
      `${apiEndpoints.app.sources}?class_name=${encodeURIComponent(finalClassName)}&project_id=${encodeURIComponent(finalProjectId)}`
    );

    if (response.success && response.data && Array.isArray(response.data)) {
      debug('fetchSources: Fetched sources from API', {
        count: response.data.length,
        sources: response.data.map((s: Source) => ({
          source_id: s.source_id,
          source_name: s.source_name,
          color: s.color,
          fleet: s.fleet,
          visible: s.visible
        }))
      });
      
      // Update cache
      sourcesCache = {
        key: cacheKey,
        sources: response.data,
        timestamp: now
      };
      
      return response.data;
    }

    debug('fetchSources: Invalid response structure', response);
    return [];
  } catch (error) {
    logError('❌ fetchSources: Error fetching sources', error);
    debug('fetchSources: Error fetching sources', error);
    return [];
  }
}


/**
 * Map display/uppercase and filter-object field names to normalized (lowercase) data keys.
 * Used when exact/key lookup fails so consumers with only lowercase data still get a value.
 */
const DISPLAY_TO_NORMALIZED: Record<string, string> = {
    RACE: 'race_number',
    LEG: 'leg_number',
    GRADE: 'grade',
    STATE: 'state',
    CONFIG: 'config',
    SOURCE_NAME: 'source_name',
    EVENT: 'event',
    YEAR: 'year',
    TACK: 'tack',
    // Filter-object names (e.g. from filters_dataset) -> normalized keys
    Race_number: 'race_number',
    Leg_number: 'leg_number',
    Grade: 'grade',
    State: 'state',
    Config: 'config',
    Event: 'event',
    Year: 'year',
    Source_name: 'source_name'
};

/**
 * Helper to resolve data field value handling case sensitivity
 * @param item The data item object
 * @param field The field name to look for (e.g. 'GRADE', 'TACK', 'RACE')
 * @returns The value found or undefined
 */
export const resolveDataField = (item: any, field: string): any => {
    if (!item || !field) return undefined;
    
    // 1. Try exact match (API returns fields in consistent case)
    if (item[field] !== undefined) return item[field];
    
    // 2. Try lowercase match (fallback for legacy data)
    const lowerField = field.toLowerCase();
    if (item[lowerField] !== undefined) return item[lowerField];
    
    // 3. Map display names to normalized field names (e.g. RACE -> race_number)
    const normalizedKey = DISPLAY_TO_NORMALIZED[field];
    if (normalizedKey !== undefined && item[normalizedKey] !== undefined) {
        return item[normalizedKey];
    }
    
    return undefined;
};
