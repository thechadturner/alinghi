/**
 * Filter Separation Utility
 * 
 * Separates filters into API-level (server-side SQL filtering) and client-side
 * (JavaScript filtering) categories for optimal performance and cache efficiency.
 * 
 * API Filters (reduce dataset size before transfer):
 * - YEAR: Filter by dataset year
 * - EVENT: Filter by event name
 * - CONFIG: Filter by configuration
 * - SOURCE_NAME: Filter by source name
 * - GRADE: Optional, only for HistoricalPerformance pages
 * 
 * Client Filters (applied after data retrieval):
 * - STATE: Filter by foiling state (H0, H1, H2, etc.)
 * - RACE: Filter by race number
 * - LEG: Filter by leg number
 * - GRADE: Default client-side (unless explicitly included in API filters)
 */

export interface SplitFilters {
  apiFilters: {
    YEAR?: number[];
    EVENT?: string[];
    CONFIG?: string[];
    SOURCE_NAME?: string[];
    GRADE?: number[]; // Optional, only for HistoricalPerformance
  };
  clientFilters: {
    STATE?: string[];
    RACE?: (number | string)[];
    LEG?: number[];
    GRADE?: number[]; // Always client-side unless in apiFilters
  };
}

/**
 * Split filters into API and client categories
 * 
 * @param allFilters - Combined filters object from UI
 * @param includeGradeInAPI - If true, include GRADE in API filters (for HistoricalPerformance)
 * @returns Split filters object with apiFilters and clientFilters
 */
export function splitFilters(
  allFilters: Record<string, any[]>,
  includeGradeInAPI: boolean = false
): SplitFilters {
  const apiFilters: SplitFilters['apiFilters'] = {};
  const clientFilters: SplitFilters['clientFilters'] = {};

  // YEAR - Always API filter
  if (allFilters.YEAR && Array.isArray(allFilters.YEAR) && allFilters.YEAR.length > 0) {
    apiFilters.YEAR = allFilters.YEAR.map(y => typeof y === 'number' ? y : parseInt(String(y))).filter(y => !isNaN(y));
  }

  // EVENT - Always API filter
  if (allFilters.EVENT && Array.isArray(allFilters.EVENT) && allFilters.EVENT.length > 0) {
    apiFilters.EVENT = allFilters.EVENT.map(e => String(e).trim()).filter(e => e.length > 0);
  }

  // CONFIG - Always API filter
  if (allFilters.CONFIG && Array.isArray(allFilters.CONFIG) && allFilters.CONFIG.length > 0) {
    apiFilters.CONFIG = allFilters.CONFIG.map(c => String(c).trim()).filter(c => c.length > 0);
  }

  // SOURCE_NAME - Always API filter
  if (allFilters.SOURCE_NAME && Array.isArray(allFilters.SOURCE_NAME) && allFilters.SOURCE_NAME.length > 0) {
    apiFilters.SOURCE_NAME = allFilters.SOURCE_NAME.map(s => String(s).trim()).filter(s => s.length > 0);
  }

  // GRADE - API filter only if explicitly requested (HistoricalPerformance), otherwise client-side
  if (allFilters.GRADE && Array.isArray(allFilters.GRADE) && allFilters.GRADE.length > 0) {
    const grades = allFilters.GRADE.map(g => typeof g === 'number' ? g : parseInt(String(g))).filter(g => !isNaN(g) && g >= 0 && g <= 5);
    if (grades.length > 0) {
      if (includeGradeInAPI) {
        apiFilters.GRADE = grades;
      } else {
        clientFilters.GRADE = grades;
      }
    }
  }

  // STATE - Always client-side filter
  if (allFilters.STATE && Array.isArray(allFilters.STATE) && allFilters.STATE.length > 0) {
    clientFilters.STATE = allFilters.STATE.map(s => String(s).trim()).filter(s => s.length > 0);
  }

  // RACE - Always client-side filter
  if (allFilters.RACE && Array.isArray(allFilters.RACE) && allFilters.RACE.length > 0) {
    clientFilters.RACE = allFilters.RACE.map(r => {
      // Handle 'TRAINING' string
      if (r === 'TRAINING' || r === 'training' || r === -1 || r === '-1') {
        return 'TRAINING';
      }
      return typeof r === 'number' ? r : parseInt(String(r));
    }).filter(r => !isNaN(r as number) || r === 'TRAINING');
  }

  // LEG - Always client-side filter
  if (allFilters.LEG && Array.isArray(allFilters.LEG) && allFilters.LEG.length > 0) {
    clientFilters.LEG = allFilters.LEG.map(l => typeof l === 'number' ? l : parseInt(String(l))).filter(l => !isNaN(l));
  }

  return { apiFilters, clientFilters };
}

/**
 * Convert split filters back to combined format (for backward compatibility)
 */
export function combineFilters(splitFilters: SplitFilters): Record<string, any[]> {
  const combined: Record<string, any[]> = {};

  if (splitFilters.apiFilters.YEAR) combined.YEAR = splitFilters.apiFilters.YEAR;
  if (splitFilters.apiFilters.EVENT) combined.EVENT = splitFilters.apiFilters.EVENT;
  if (splitFilters.apiFilters.CONFIG) combined.CONFIG = splitFilters.apiFilters.CONFIG;
  if (splitFilters.apiFilters.SOURCE_NAME) combined.SOURCE_NAME = splitFilters.apiFilters.SOURCE_NAME;
  if (splitFilters.apiFilters.GRADE) combined.GRADE = splitFilters.apiFilters.GRADE;
  if (splitFilters.clientFilters.STATE) combined.STATE = splitFilters.clientFilters.STATE;
  if (splitFilters.clientFilters.RACE) combined.RACE = splitFilters.clientFilters.RACE;
  if (splitFilters.clientFilters.LEG) combined.LEG = splitFilters.clientFilters.LEG;
  // Client GRADE only if not in API filters
  if (splitFilters.clientFilters.GRADE && !splitFilters.apiFilters.GRADE) {
    combined.GRADE = splitFilters.clientFilters.GRADE;
  }

  return combined;
}

