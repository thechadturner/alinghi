/**
 * Common Filtering Utilities
 *
 * Centralized filtering logic for all components.
 * Supports context-specific filter state (maneuvers / aggregates / timeseries).
 */

import {
  getCurrentFilterStateForContext as getFilterStateFromStore,
  type FilterContext
} from '../store/filterStore';
import { selectedStates, selectedRaces, selectedLegs, selectedGrades } from '../store/filterStore';
import { defaultChannelsStore } from '../store/defaultChannelsStore';

// Filter state interface
export interface FilterState {
  selectedStates: string[];
  selectedRaces: string[];
  selectedLegs: string[];
  selectedGrades: string[];
}

export type { FilterContext };

/** Get filter state for a specific context (maneuvers, aggregates, timeseries). */
export const getCurrentFilterStateForContext = (context: FilterContext): FilterState =>
  getFilterStateFromStore(context);

/** Get current filter state. Prefer getCurrentFilterStateForContext(context) so callers pass context. */
export const getCurrentFilterState = (context?: FilterContext): FilterState =>
  context ? getFilterStateFromStore(context) : {
    selectedStates: selectedStates(),
    selectedRaces: selectedRaces(),
    selectedLegs: selectedLegs(),
    selectedGrades: selectedGrades()
  };

// TWA filtering logic (centralized)
export const filterByTwa = (
  data: any[], 
  filters: string[], 
  races: string[] = [], 
  legs: string[] = [], 
  grades: string[] = []
): any[] => {
  if (!data || data.length === 0) return data;
  
  // Get default TWA channel name (typically 'Twa_deg')
  const twaChannelName = defaultChannelsStore.twaName();
  
  return data.filter((d) => {
    // Race filtering (use original case field names)
    if (races.length > 0 && !races.includes(d.Race_number)) {
      return false;
    }
    
    // Leg filtering (use original case field names)
    if (legs.length > 0 && !legs.includes(d.Leg_number)) {
      return false;
    }
    
    // Grade filtering - handle GRADE, Grade, or grade (case-insensitive)
    if (grades.length > 0) {
      const grade = d.GRADE ?? d.Grade ?? d.grade;
      if (grade === undefined || grade === null || !grades.includes(grade)) {
        return false;
      }
    }
    
    // TWA filtering (use default TWA channel name, fallback to 'Twa' for backward compatibility)
    if (!filters || filters.length === 0) return true; // No TWA filters
    
    // Get TWA value from default channel name, with fallback to 'Twa' for backward compatibility
    const twaValue = d[twaChannelName] ?? d.Twa;
    if (typeof twaValue !== "number") return false;
    
    // Convert filters to lowercase once for efficiency
    const lowerFilters = filters.map(f => typeof f === 'string' ? f.toLowerCase() : f);
    
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
      const absTwa = Math.abs(twaValue);
      
      // Upwind: 30-75 (exclusive boundaries: > 30 and < 75)
      if (hasUpwind && absTwa > 30 && absTwa < 75) passesDirectionFilter = true;
      // Downwind: 105-150 (exclusive boundaries: > 105 and < 150)
      if (hasDownwind && absTwa > 105 && absTwa < 150) passesDirectionFilter = true;
      // Reaching: 75-115 (exclusive boundaries: > 75 and < 115)
      if (hasReaching && absTwa > 75 && absTwa < 115) passesDirectionFilter = true;
    }
    
    // Check port/stbd filters
    if (hasPort || hasStbd) {
      passesPortStbdFilter = false;
      if (hasPort && twaValue < 0) passesPortStbdFilter = true;
      if (hasStbd && twaValue > 0) passesPortStbdFilter = true;
    }
    
    return passesDirectionFilter && passesPortStbdFilter;
  });
};

// Apply all common filters
export const applyCommonFilters = (data: any[], filterState?: FilterState): any[] => {
  const filters = filterState || getCurrentFilterState();
  return filterByTwa(
    data, 
    filters.selectedStates, 
    filters.selectedRaces, 
    filters.selectedLegs, 
    filters.selectedGrades
  );
};

// Time range filtering
export const filterByTimeRange = (data: any[], startTime: Date, endTime: Date): any[] => {
  return data.filter(item => {
    const timestamp = item.timestamp || item.datetime?.getTime() || new Date(item.datetime).getTime();
    return timestamp >= startTime.getTime() && timestamp <= endTime.getTime();
  });
};

// Channel filtering for sensor data
export const filterByChannels = (data: any[], channels: string[]): any[] => {
  if (!channels || channels.length === 0) return data;
  
  return data.filter(item => 
    channels.includes(item.channel) || 
    channels.some(ch => item[ch] !== undefined)
  );
};

// Combined filtering function
export const applyAllFilters = (
  data: any[], 
  options: {
    filterState?: FilterState;
    timeRange?: { start: Date; end: Date };
    channels?: string[];
  } = {}
): any[] => {
  let filteredData = data;
  
  // Apply common filters (TWA, race, leg, grade)
  if (options.filterState) {
    filteredData = applyCommonFilters(filteredData, options.filterState);
  }
  
  // Apply time range filter
  if (options.timeRange) {
    filteredData = filterByTimeRange(filteredData, options.timeRange.start, options.timeRange.end);
  }
  
  // Apply channel filter
  if (options.channels) {
    filteredData = filterByChannels(filteredData, options.channels);
  }
  
  return filteredData;
};

// Filter options for UI components
export const TWA_FILTER_OPTIONS = [
  "Upwind",
  "Downwind", 
  "Reaching",
  "Port",
  "Stbd"
];

// Export filter utilities
export default {
  filterByTwa,
  applyCommonFilters,
  filterByTimeRange,
  filterByChannels,
  applyAllFilters,
  getCurrentFilterState,
  TWA_FILTER_OPTIONS
};
