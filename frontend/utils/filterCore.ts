/**
 * Unified Filter Core
 * 
 * Centralized filtering logic used by:
 * - IndexedDB queries (basic filtering)
 * - In-memory filtering (complex logic)
 * - Worker-based filtering (large datasets)
 * 
 * This eliminates code duplication and ensures consistency.
 * 
 * FILTER SEPARATION:
 * - API Filters (applied server-side): events, configs, grades (if in API filters)
 * - Client Filters (applied client-side): states, raceNumbers, legNumbers, grades (if client-side)
 * 
 * The passesBasicFilters function handles client-side filtering only.
 * API filters are applied by the backend before data reaches the client.
 */

import { defaultChannelsStore } from '../store/defaultChannelsStore';

export interface FilterConfig {
  twaStates?: string[];
  raceNumbers?: (number | string)[]; // Allow strings for 'TRAINING' - CLIENT-SIDE ONLY
  legNumbers?: number[]; // CLIENT-SIDE ONLY
  grades?: number[]; // CLIENT-SIDE if not in API filters, otherwise API-side
  events?: string[]; // API filter (but can be used client-side as safeguard)
  configs?: string[]; // API filter (but can be used client-side as safeguard)
  states?: string[]; // State field filter (e.g., H0, H1, H2) - CLIENT-SIDE ONLY - different from twaStates
  timeRange?: { start: number; end: number };
}

export interface TwaFilterState {
  upwind?: boolean;
  downwind?: boolean;
  reaching?: boolean;
  port?: boolean;
  stbd?: boolean;
}

/**
 * Convert TWA filter states to ranges for efficient filtering
 */
export function convertTwaStatesToRanges(states: string[]): { min: number; max: number }[] {
  const ranges: { min: number; max: number }[] = [];
  const lowerStates = states.map(s => s.toLowerCase());
  
  // Direction filters
  if (lowerStates.includes('upwind')) {
    ranges.push({ min: 30, max: 75 });
  }
  if (lowerStates.includes('downwind')) {
    ranges.push({ min: 105, max: 150 });
  }
  if (lowerStates.includes('reaching')) {
    ranges.push({ min: 75, max: 115 });
  }
  
  // Port/Stbd filters
  if (lowerStates.includes('port') && lowerStates.includes('stbd')) {
    // Both selected - no additional range needed
  } else if (lowerStates.includes('port')) {
    // Only port - filter for negative TWA
    ranges.push({ min: -180, max: 0 });
  } else if (lowerStates.includes('stbd')) {
    // Only stbd - filter for positive TWA
    ranges.push({ min: 0, max: 180 });
  }
  
  return ranges;
}

/**
 * Check if a data point passes TWA filters using the working logic
 */
export function passesTwaRanges(twa: number, states: string[]): boolean {
  if (!states || states.length === 0) return true;
  
  if (typeof twa !== 'number') return false;
  
  // Convert filters to lowercase once for efficiency
  const lowerFilters = states.map(f => typeof f === 'string' ? f.toLowerCase() : f);
  
  // Pre-calculate filter conditions for efficiency
  const hasDirectionFilter = lowerFilters.includes("upwind") || lowerFilters.includes("downwind") || lowerFilters.includes("reaching");
  const hasUpwind = lowerFilters.includes("upwind");
  const hasDownwind = lowerFilters.includes("downwind");
  const hasReaching = lowerFilters.includes("reaching");
  const hasPort = lowerFilters.includes("port");
  const hasStbd = lowerFilters.includes("stbd");
  
  let passesDirectionFilter = true;
  let passesPortStbdFilter = true;
  
  // Check direction filters: upwind, downwind, reaching
  if (hasDirectionFilter) {
    passesDirectionFilter = false;
    const absTwa = Math.abs(twa);
    
    // Upwind: 30-75 (exclusive boundaries: > 30 and < 75)
    if (hasUpwind && absTwa > 30 && absTwa < 75) passesDirectionFilter = true;
    // Downwind: 105-150 (exclusive boundaries: > 105 and < 150)
    if (hasDownwind && absTwa > 105 && absTwa < 150) passesDirectionFilter = true;
    // Reaching: 75-115 (exclusive boundaries: > 75 and < 115)
    if (hasReaching && absTwa > 75 && absTwa < 115) passesDirectionFilter = true;
  }
  
  // Check port/stbd filters
  if (hasPort || hasStbd) {
    if (hasPort && hasStbd) {
      passesPortStbdFilter = true;
    } else {
      passesPortStbdFilter = false;
      if (hasPort && twa < 0) passesPortStbdFilter = true;
      if (hasStbd && twa > 0) passesPortStbdFilter = true;
    }
  }
  
  return passesDirectionFilter && passesPortStbdFilter;
}

/**
 * Check if a data point passes basic filters
 * 
 * This function handles CLIENT-SIDE filtering only:
 * - states: State field filter (H0, H1, H2, etc.) - always client-side
 * - raceNumbers: Race number filter - always client-side
 * - legNumbers: Leg number filter - always client-side
 * - grades: Grade filter - client-side by default (unless included in API filters)
 * - events/configs: These are primarily API filters, but can be used client-side as a safeguard
 * 
 * API filters (YEAR, EVENT, CONFIG, SOURCE_NAME) are applied server-side before data reaches the client.
 * This function should only receive data that has already been filtered by API filters.
 */
export function passesBasicFilters(dataPoint: any, config: FilterConfig): boolean {
  // TWA filtering
  if (config.twaStates && config.twaStates.length > 0) {
    // Get default TWA channel name (e.g., 'Twa_deg') from defaultChannelsStore
    const defaultTwaName = defaultChannelsStore.twaName();
    
    // Check TWA using defaultTwaName first (as user specified: dataPoint[defaultTwaName])
    // Then fallback to common variations for backward compatibility
    // This matches the data processing logic in Scatter.tsx
    const twa = dataPoint[defaultTwaName] !== undefined ? dataPoint[defaultTwaName] :
                dataPoint.Twa !== undefined ? dataPoint.Twa :
                dataPoint.twa !== undefined ? dataPoint.twa :
                dataPoint.TWA !== undefined ? dataPoint.TWA :
                dataPoint[defaultTwaName.toLowerCase()] !== undefined ? dataPoint[defaultTwaName.toLowerCase()] :
                undefined;
    
    if (twa !== undefined && twa !== null) {
      const passesTwa = passesTwaRanges(twa, config.twaStates);
      if (!passesTwa) {
        return false;
      }
    } else {
      // If TWA is required for filtering but not found in data point, exclude it
      return false;
    }
  }
  
  // Race number filtering - use normalized field name (race_number)
  // TRAINING can be stored as 0, -1, or 'TRAINING' in data
  if (config.raceNumbers && config.raceNumbers.length > 0) {
    const raceNumber = dataPoint.race_number ?? dataPoint.Race_number; // Prefer normalized
    if (raceNumber !== undefined) {
      if (raceNumber === 'TRAINING' || raceNumber === 'training') {
        if (!config.raceNumbers.includes(-1) && !config.raceNumbers.includes('TRAINING') && !config.raceNumbers.includes('training') && !config.raceNumbers.includes(0)) {
          return false;
        }
      } else {
        const raceNum = typeof raceNumber === 'number' ? raceNumber : Number(raceNumber);
        // 0 and -1 both represent TRAINING
        if (raceNum === -1 || raceNum === 0) {
          if (!config.raceNumbers.includes(-1) && !config.raceNumbers.includes('TRAINING') && !config.raceNumbers.includes('training') && !config.raceNumbers.includes(0)) {
            return false;
          }
        } else if (isNaN(raceNum) || !config.raceNumbers.includes(raceNum)) {
          return false;
        }
      }
    }
  }
  
  // Leg number filtering - use normalized field name (leg_number)
  if (config.legNumbers && config.legNumbers.length > 0) {
    const legNumber = dataPoint.leg_number ?? dataPoint.Leg_number; // Prefer normalized
    if (legNumber !== undefined) {
      const legNum = typeof legNumber === 'number' ? legNumber : Number(legNumber);
      if (isNaN(legNum) || !config.legNumbers.includes(legNum)) {
        return false;
      }
    }
  }
  
  // Grade filtering - use normalized field name (grade)
  if (config.grades && config.grades.length > 0) {
    // Prefer normalized field name first
    const grade = dataPoint.grade ?? dataPoint.Grade ?? dataPoint.GRADE;
    // If grade is undefined/null, exclude this entry when grade filters are active
    if (grade === undefined || grade === null) {
      return false;
    }
    const gradeNum = typeof grade === 'number' ? grade : Number(grade);
    if (isNaN(gradeNum) || !config.grades.includes(gradeNum)) {
      return false;
    }
  }
  
  // Event name filtering (case-insensitive) - use normalized field name (event)
  if (config.events && config.events.length > 0) {
    const eventName = dataPoint.event ?? dataPoint.event_name ?? dataPoint.Event_name ?? dataPoint.EVENT_NAME;
    if (eventName !== undefined && eventName !== null) {
      const eventNameLower = String(eventName).toLowerCase();
      const filterEventsLower = config.events.map(e => String(e).toLowerCase());
      if (!filterEventsLower.includes(eventNameLower)) {
        return false;
      }
    }
  }
  
  // Config filtering (case-insensitive) - use normalized field name (config)
  if (config.configs && config.configs.length > 0) {
    const configValue = dataPoint.config ?? dataPoint.Config ?? dataPoint.CONFIG; // Prefer normalized
    if (configValue !== undefined && configValue !== null) {
      const configValueLower = String(configValue).toLowerCase();
      const filterConfigsLower = config.configs.map(c => String(c).toLowerCase());
      if (!filterConfigsLower.includes(configValueLower)) {
        return false;
      }
    }
  }
  
  // State filtering (case-insensitive) - filter by State field (e.g., H0, H1, H2)
  // This is different from twaStates which filters by TWA ranges
  // Use normalized field name (state)
  if (config.states && config.states.length > 0) {
    const stateValue = dataPoint.state ?? dataPoint.State ?? dataPoint.STATE; // Prefer normalized
    if (stateValue !== undefined && stateValue !== null) {
      const stateValueStr = String(stateValue);
      const filterStatesLower = config.states.map(s => String(s).toLowerCase());
      if (!filterStatesLower.includes(stateValueStr.toLowerCase())) {
        return false;
      }
    } else {
      // If State filter is active but data point has no State value, exclude it
      return false;
    }
  }
  
  // Time range filtering
  if (config.timeRange && dataPoint.timestamp !== undefined) {
    const timestamp = dataPoint.timestamp;
    if (timestamp < config.timeRange.start || timestamp > config.timeRange.end) {
      return false;
    }
  }
  
  return true;
}

/**
 * Convert unified filter states to FilterConfig
 * 
 * RACE_NUMBER DUAL-ROLE TRANSLATION POINT:
 * This is the central translation layer between UI filter values and data values.
 * 
 * When user selects 'TRAINING' in the UI:
 * - Filter store contains: ['TRAINING'] (string)
 * - This function expands to: [-1, 'TRAINING', 0] for data matching
 * - Data contains: Race_number: -1 (numeric)
 * - Filtering works via: config.raceNumbers.includes(-1) ✓
 * 
 * Design principle: "Whenever a user requests 'TRAINING' data, 
 * the internal code automatically uses -1 for Race_number filtering."
 * 
 * See: frontend/utils/raceValueUtils.ts for centralized race value handling
 */
export function createFilterConfig(
  states: string[] = [],
  races: (string | number)[] = [],
  legs: (string | number)[] = [],
  grades: (string | number)[] = [],
  timeRange?: { start: number; end: number }
): FilterConfig {
  // Convert races, legs, and grades to numbers (handle both string and number inputs)
  // Handle 'TRAINING' specially - include 0, -1 and 'TRAINING' (data may use 0 or -1 for training)
  const raceNumbers: (number | string)[] = [];
  races.forEach(r => {
    // TRAINING translation: UI 'TRAINING' → data -1, 0, 'TRAINING' (all equivalent)
    if (r === 'TRAINING' || r === 'training' || r === -1 || r === 0 || r === '-1') {
      if (!raceNumbers.includes(-1)) raceNumbers.push(-1);
      if (!raceNumbers.includes('TRAINING')) raceNumbers.push('TRAINING');
      if (!raceNumbers.includes(0)) raceNumbers.push(0);
    } else {
      const num = typeof r === 'string' ? Number(r) : r;
      if (!isNaN(num)) {
        raceNumbers.push(num);
      }
    }
  });
  const legNumbers = legs.map(l => typeof l === 'string' ? Number(l) : l).filter(n => !isNaN(n));
  const gradeNumbers = grades.map(g => typeof g === 'string' ? Number(g) : g).filter(n => !isNaN(n));
  
  return {
    twaStates: states,
    raceNumbers: raceNumbers,
    legNumbers: legNumbers,
    grades: gradeNumbers,
    timeRange: timeRange
  };
}

/**
 * Get timestamp from data point (unified across all systems)
 */
export function getTimestamp(dataPoint: any): number {
  const timestamp = dataPoint.timestamp || dataPoint.datetime || dataPoint.Datetime;
  if (timestamp instanceof Date) {
    return timestamp.getTime();
  }
  return new Date(timestamp).getTime();
}
