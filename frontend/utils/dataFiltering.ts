/**
 * Centralized Data Filtering Utility
 * 
 * Provides consistent data filtering logic across all chart components based on:
 * 1. Active selection (highest priority)
 * 2. Cut data (if no active selection)
 * 3. Applied filters (if no cut data)
 * 4. All data (default)
 * 
 * RACE_NUMBER DUAL-ROLE HANDLING:
 * - extractFilterOptions() converts backend -1 → 'TRAINING' for UI display
 * - Uses formatRaceForDisplay() from raceValueUtils.ts
 * - Filter matching happens in filterCore.ts createFilterConfig()
 * 
 * See: frontend/utils/raceValueUtils.ts for centralized race value handling
 */

import { error as logError, debug, log } from './console';
import { 
  selection, 
  selectedRange, 
  selectedRanges,
  hasSelection, 
  cutEvents, 
  selectedEvents
} from '../store/selectionStore';
import {
  getCurrentFilterStateForContext,
  type FilterContext
} from '../store/filterStore';
import {
  selectedStates,
  selectedRaces,
  selectedLegs,
  selectedGrades,
  setRaceOptions,
  setLegOptions,
  setGradeOptions,
  setHeadsailCodeOptions,
  setMainsailCodeOptions
} from '../store/filterStore';
import { persistantStore } from '../store/persistantStore';

import { createFilterConfig, getTimestamp as getTimestampCore, passesBasicFilters } from './filterCore';
import { formatRaceForDisplay, sortRaceValues, normalizeRaceValue } from './raceValueUtils';

// Helper function to get timestamp from data point (use unified core)
export const getTimestamp = getTimestampCore;

// Helper function to apply TWA & basic filters (states / races / legs / grades)
export const filterByTwa = (data: any[], states: any[], races: any[], legs: any[], grades: any[]) => {
  if (!data || data.length === 0) return data;

  // If grade filters are active but the data doesn't contain ANY grade-like field,
  // skip the grade filter entirely so we don't silently drop all points.
  let effectiveGrades = grades;
  if (grades && grades.length > 0) {
    const hasAnyGradeField = data.some(d => {
      if (d == null) return false;
      return (
        'GRADE' in d ||
        'Grade' in d ||
        'grade' in d ||
        'data_grade' in d ||
        'quality_grade' in d
      );
    });

    if (!hasAnyGradeField) {
      // No grade information in this dataset – ignore grade filters
      effectiveGrades = [];
    }
  }

  // Use unified filter core for consistency
  const filterConfig = createFilterConfig(states, races, legs, effectiveGrades);

  const filtered = data.filter(item => {
    const passes = passesBasicFilters(item, filterConfig);
    return passes;
  });

  return filtered;
};

// Helper function to process selection data
export const processSelection = (currentSelection: any[], currentValues: any[]) => {
  if (!currentValues || currentValues.length === 0) {
    return currentValues;
  }
  
  if (currentSelection.length === 0) {
    // If selection is empty, quickly mark all as unselected
    return currentValues.map(item => ({ ...item, event_id: 0 }));
  } else {
    // Create a lookup map for quick selection checking
    const selectionMap = new Map();
    
    // Populate the map with timestamp ranges for O(1) lookup
    currentSelection.forEach((selItem, index) => {
      if (selItem.start_time && selItem.end_time) {
        const startDate = new Date(selItem.start_time);
        const endDate = new Date(selItem.end_time);
        const event_id = selItem.event_id;
        
        // Store the time range with its timestamp values
        selectionMap.set(`range_${index}`, {
          isRange: true,
          start: startDate.getTime(),
          end: endDate.getTime(),
          event_id: event_id
        });
      }
    });
    
    // Apply selections in a single pass through the data
    const updatedValues = currentValues.map(item => {
      const time = getTimestamp(item);
      
      // Check if the time falls within any selected range
      for (let [_, value] of selectionMap.entries()) {
        if (value.isRange && time >= value.start && time <= value.end) {
          return { ...item, event_id: value.event_id };
        }
      }
      
      // If no selection matches, mark as unselected
      return { ...item, event_id: 0 };
    });
    
    return updatedValues;
  }
};

/** When true, apply selection/range/cut filtering regardless of page setting (e.g. map and explore TimeSeries). */
export interface ApplyDataFilterOptions {
  forceSelection?: boolean;
}

// Main filtering function that all components should use. Pass context when not passing explicit states/races/legs/grades.
export const applyDataFilter = (
  sourceData: any[],
  states?: any[],
  races?: any[],
  legs?: any[],
  grades?: any[],
  context?: FilterContext,
  options?: ApplyDataFilterOptions
) => {
  if (!sourceData || sourceData.length === 0) {
    return [];
  }

  const fromContext = context ? getCurrentFilterStateForContext(context) : null;
  const filterStates = states ?? fromContext?.selectedStates ?? selectedStates();
  const filterRaces = races ?? fromContext?.selectedRaces ?? selectedRaces();
  const filterLegs = legs ?? fromContext?.selectedLegs ?? selectedLegs();
  const filterGrades = grades ?? fromContext?.selectedGrades ?? selectedGrades();

  let filtered = [...sourceData];

  // Apply TWA filters first
  filtered = filterByTwa(
    filtered,
    filterStates,
    filterRaces,
    filterLegs,
    filterGrades
  );

  // Apply selection/range/cut when: forceSelection (map, TimeSeries) OR user enabled "Selection only" in page settings (scatter, etc.)
  if (options?.forceSelection || persistantStore.filterChartsBySelection()) {
    // Hierarchical data filtering:
    // 1. Active selection (highest priority) - selectedRanges first
    // 2. Cut data (if no active selection)
    // 3. All data (default)
    const currentSelectedRanges = selectedRanges();
    if (currentSelectedRanges && currentSelectedRanges.length > 0) {
      const beforeFilter = filtered.length;
      filtered = filtered.filter((d) => {
        const timestamp = getTimestamp(d);
        return currentSelectedRanges.some(range => {
          const startTime = new Date(range.start_time).getTime();
          const endTime = new Date(range.end_time).getTime();
          return timestamp >= startTime && timestamp <= endTime;
        });
      });
      debug(`🔍 applyDataFilter: selectedRanges filtering applied. Before: ${beforeFilter}, After: ${filtered.length}, Ranges:`, currentSelectedRanges);
    } else if (hasSelection() && selectedRange().length > 0) {
      const rangeItem = selectedRange()[0];
      const startTime = new Date(rangeItem.start_time);
      const endTime = new Date(rangeItem.end_time);
      filtered = filtered.filter((d) => getTimestamp(d) >= startTime.getTime() && getTimestamp(d) <= endTime.getTime());
    } else if (selection().length > 0) {
      filtered = processSelection(selection(), filtered);
    } else if (cutEvents().length > 0) {
      const currentCutEvents = cutEvents();
      const beforeFilter = filtered.length;
      filtered = filtered.filter((d) => {
        const timestamp = getTimestamp(d);
        return currentCutEvents.some(range => {
          if (typeof range === 'number') {
            debug(`🔍 applyDataFilter: cutEvents contains event ID (${range}) instead of time range - skipping`);
            return false;
          }
          if (range.start_time && range.end_time) {
            const startTime = new Date(range.start_time).getTime();
            const endTime = new Date(range.end_time).getTime();
            return timestamp >= startTime && timestamp <= endTime;
          }
          return false;
        });
      });
      debug(`🔍 applyDataFilter: cutEvents filtering applied. Before: ${beforeFilter}, After: ${filtered.length}, Cut Ranges: ${currentCutEvents.length}`);
    }
  }

  return filtered;
};

// Timeline-specific filtering function that doesn't apply range filtering
// Used by MapTimeSeries to show full timeline for navigation
export const applyTimelineFilter = (
  sourceData: any[],
  states?: any[],
  races?: any[],
  legs?: any[],
  grades?: any[],
  context?: FilterContext
) => {
  if (!sourceData || sourceData.length === 0) {
    return [];
  }

  const fromContext = context ? getCurrentFilterStateForContext(context) : null;
  const filterStates = states ?? fromContext?.selectedStates ?? selectedStates();
  const filterRaces = races ?? fromContext?.selectedRaces ?? selectedRaces();
  const filterLegs = legs ?? fromContext?.selectedLegs ?? selectedLegs();
  const filterGrades = grades ?? fromContext?.selectedGrades ?? selectedGrades();

  let filtered = [...sourceData];

  // Apply TWA filters only (no range filtering for timeline)
  filtered = filterByTwa(
    filtered, 
    filterStates, 
    filterRaces, 
    filterLegs, 
    filterGrades
  );

  // Apply selection processing but not range filtering
  // Use selectedEvents() instead of selection() to preserve event_id assignments
  const currentSelectedEvents = selectedEvents();
  if (currentSelectedEvents.length > 0) {
    filtered = processSelection(currentSelectedEvents, filtered);
  }
  
  // NOTE: Do NOT apply selectedRanges filtering here
  // The map timeline should always show the full dataset
  // The ContinuousTrackRenderer will handle the selection overlay using selectedRanges

  return filtered;
};

/**
 * Extract filter options from data and save to IndexedDB
 * Queries directly from IndexedDB map.data table instead of extracting from in-memory data
 * Only extracts filters that are defined in the filter configuration for the class/context
 */
export const extractFilterOptions = async (data: any[], context?: 'dataset' | 'day' | 'fleet' | 'source'): Promise<void> => {
  debug('🔍 extractFilterOptions: Function called with context:', context);
  
  // Get the filter configuration for the current class and context
  // This tells us which filters are actually available for this class
  let filterConfig: any = null;
  try {
    const UnifiedFilterService = (await import('../services/unifiedFilterService')).default;
    const { persistantStore } = await import('../store/persistantStore');
    const className = persistantStore.selectedClassName?.() || 'ac40';
    const filterContext = context || 'dataset'; // Default to dataset context
    filterConfig = await UnifiedFilterService.getFilterConfig(className, filterContext);
    debug('🔍 extractFilterOptions: Retrieved filter config:', { 
      className, 
      context: filterContext,
      filterTypes: Object.keys(filterConfig?.filter_types || {})
    });
  } catch (error) {
    logError('extractFilterOptions: Error fetching filter config:', error);
    // Continue with extraction but only include common filters
  }
  
  // Get the list of available filter types from the config
  const availableFilterTypes = filterConfig?.filter_types ? Object.keys(filterConfig.filter_types) : [];
  debug('🔍 extractFilterOptions: Available filter types from config:', availableFilterTypes);
  
  // Helper function to check if a filter is available
  const isFilterAvailable = (filterName: string): boolean => {
    // Normalize filter name - check various case variations
    const normalized = filterName.toLowerCase();
    return availableFilterTypes.some(ft => ft.toLowerCase() === normalized);
  };
  
  // Query race numbers: for dataset context use agg.events (dataset_events) first; else map.data
  let races: (number | string)[] = [];
  if (isFilterAvailable('Race_number')) {
    try {
      const { persistantStore } = await import('../store/persistantStore');
      const { huniDBStore } = await import('../store/huniDBStore');
      const { TableNames, escapeTableName } = await import('../store/huniDBTypes');
      
      const className = persistantStore.selectedClassName?.() || 'ac40';
      const projectId = persistantStore.selectedProjectId?.();
      const datasetId = persistantStore.selectedDatasetId?.();
      const sourceId = persistantStore.selectedSourceId?.();
      const date = persistantStore.selectedDate?.();
      
      if (!className || !projectId) {
        debug('🔍 extractFilterOptions: Missing className or projectId, skipping race query');
      } else {
        const db = await huniDBStore.getDatabase(className.toLowerCase());
        const filterContext = context || 'dataset';

        // Dataset context: prefer agg.events (dataset_events) where event_type = 'RACE' and Race_number in tags
        if (filterContext === 'dataset' && datasetId && Number(datasetId) > 0) {
          try {
            const eventsTable = escapeTableName(TableNames.events);
            const eventsSql = `
              SELECT DISTINCT json_extract(tags, '$.Race_number') AS race_number
              FROM ${eventsTable}
              WHERE event_type IN ('RACE', 'race')
                AND dataset_id = ?
                AND json_extract(tags, '$.Race_number') IS NOT NULL
                AND trim(cast(json_extract(tags, '$.Race_number') AS TEXT)) != ''
            `;
            const eventRaceRows = await db.query<any>(eventsSql, [String(datasetId)]);
            if (eventRaceRows && eventRaceRows.length > 0) {
              races = eventRaceRows
                .map((r: any) => {
                  const raceNum = r.race_number;
                  if (raceNum === 'TRAINING' || raceNum === 'training' || raceNum === '-1' || raceNum === -1) return 'TRAINING';
                  const num = Number(raceNum);
                  return isNaN(num) ? raceNum : num;
                })
                .filter((v: any) => v !== null && v !== undefined && (v === 'TRAINING' || typeof v === 'number'))
                .sort((a: any, b: any) => {
                  if (a === 'TRAINING') return -1;
                  if (b === 'TRAINING') return 1;
                  if (typeof a === 'number' && typeof b === 'number') return a - b;
                  return String(a).localeCompare(String(b));
                });
              races = [...new Set(races)];
              debug('🔍 extractFilterOptions: Extracted races from agg.events (dataset_events):', races);
            }
          } catch (eventsErr: any) {
            // Table may not exist yet; fall through to map.data or data
            debug('🔍 extractFilterOptions: agg.events query failed (table may not exist), trying map.data:', (eventsErr as Error)?.message);
          }
        }

        // Day context: query agg.events by project_id and date (start_time/end_time) for races
        // Use dataset timezone so the day range is local calendar day, not UTC
        if (filterContext === 'day' && date && date.trim() !== '') {
          try {
            const eventsTable = escapeTableName(TableNames.events);
            const dateNorm = String(date).replace(/[-/]/g, '');
            const dateStr = dateNorm.length === 8
              ? `${dateNorm.slice(0, 4)}-${dateNorm.slice(4, 6)}-${dateNorm.slice(6, 8)}`
              : String(date);
            const { getTimezoneForDate, getDayBoundsInTimezone } = await import('./global');
            const timezone = await getTimezoneForDate(className, Number(projectId), dateStr);
            const { startMs, endMs } = getDayBoundsInTimezone(dateStr, timezone);
            const eventsSql = `
                SELECT DISTINCT COALESCE(json_extract(tags, '$.Race_number'), json_extract(tags, '$.race_number')) AS race_number
                FROM ${eventsTable}
                WHERE project_id = ?
                  AND start_time >= ?
                  AND start_time <= ?
                  AND (json_extract(tags, '$.Race_number') IS NOT NULL OR json_extract(tags, '$.race_number') IS NOT NULL)
              `;
              const eventRaceRows = await db.query<any>(eventsSql, [String(projectId), startMs, endMs]);
              if (eventRaceRows && eventRaceRows.length > 0) {
                races = eventRaceRows
                  .map((r: any) => {
                    const raceNum = r.race_number;
                    if (raceNum === 'TRAINING' || raceNum === 'training' || raceNum === '-1' || raceNum === -1) return 'TRAINING';
                    const num = Number(raceNum);
                    return isNaN(num) ? raceNum : num;
                  })
                  .filter((v: any) => v !== null && v !== undefined && (v === 'TRAINING' || typeof v === 'number'))
                  .sort((a: any, b: any) => {
                    if (a === 'TRAINING') return -1;
                    if (b === 'TRAINING') return 1;
                    if (typeof a === 'number' && typeof b === 'number') return a - b;
                    return String(a).localeCompare(String(b));
                  });
                races = [...new Set(races)];
                debug('🔍 extractFilterOptions: Extracted races from agg.events (day context):', races);
              }
          } catch (eventsErr: any) {
            debug('🔍 extractFilterOptions: agg.events day query failed:', (eventsErr as Error)?.message);
          }
        }

        // If no races from events, use in-memory data (map.data no longer cached in HuniDB)
        if (races.length === 0 && data && data.length > 0) {
          races = [...new Set(data.map((d: any) => d.race_number ?? d.Race_number ?? d.RACE).filter((r: any) => r != null && r !== undefined))]
            .map((r: any) => formatRaceForDisplay(r)) // Use centralized formatting: -1 → 'TRAINING'
            .filter((v: any) => v === 'TRAINING' || typeof v === 'number')
            .sort(sortRaceValues); // Use centralized sorting
          debug('🔍 extractFilterOptions: Extracted races from data array:', races);
        } else if (races.length > 0 && data && data.length > 0) {
          // Backend uses -1 for training; events table may not have a RACE event for training.
          // Merge in any race values from the actual data so -1 (TRAINING) appears when present in data.
          const fromData = [...new Set(data.map((d: any) => d.race_number ?? d.Race_number ?? d.RACE).filter((r: any) => r != null && r !== undefined))]
            .map((r: any) => formatRaceForDisplay(r)) // Use centralized formatting: -1 → 'TRAINING'
            .filter((v: any) => v === 'TRAINING' || typeof v === 'number');
          const combined = [...new Set([...races, ...fromData])].sort(sortRaceValues); // Use centralized sorting
          races = combined;
          debug('🔍 extractFilterOptions: Merged races from data (backend -1 = TRAINING):', races);
        }
      }
    } catch (error: any) {
      // Handle mobile device error gracefully
      if (error?.message?.includes('mobile devices')) {
        debug('extractFilterOptions: HuniDB disabled on mobile device - will use data array fallback');
      } else {
        logError('extractFilterOptions: Error querying races from IndexedDB:', error);
      }
      // Fallback to extracting from data array if query fails
      // Use normalized field name (race_number) with fallback to old names; backend uses -1 for training
      if (data && data.length > 0) {
        races = [...new Set(data.map((d: any) => d.race_number ?? d.Race_number ?? d.RACE).filter((r: any) => r != null && r !== undefined))]
          .map((r: any) => formatRaceForDisplay(r)) // Use centralized formatting: -1 → 'TRAINING'
          .filter((v: any) => v === 'TRAINING' || typeof v === 'number')
          .sort(sortRaceValues); // Use centralized sorting
        debug('🔍 extractFilterOptions: Fallback - extracted races from data array:', races);
      }
    }
  }
  
  // Grades: extract from passed-in data (map.data no longer cached in HuniDB)
  let grades: number[] = [];
  if (isFilterAvailable('Grade')) {
    // Fallback to passed-in data
    if (data && data.length > 0) {
      grades = [...new Set(data.map((d: any) => d.grade ?? d.Grade ?? d.GRADE).filter((g: any) => g != null && g !== undefined))].sort((a, b) => a - b);
      const possibleGradeFields = ['data_grade', 'quality_grade'];
      for (const field of possibleGradeFields) {
        if (grades.length > 0) break;
        const fieldGrades = [...new Set(data.map((d: any) => d[field]).filter((g: any) => g != null && g !== undefined))].sort((a, b) => a - b);
        if (fieldGrades.length > 0) {
          grades = fieldGrades;
          break;
        }
      }
      debug('🔍 extractFilterOptions: Fallback - extracted grades from data array:', grades);
    }
  }

  // Legs: will be set from raceToLegsMap (full dataset) after that query runs; placeholder until then
  let legs: number[] = [];
  
  debug('🔍 extractFilterOptions: Extracted values (filtered by config):', { 
    races, 
    grades, 
    legs, 
    availableFilterTypes 
  });
  
  // Build race -> legs mapping from agg.events (map.data no longer cached in HuniDB)
  const raceToLegsMap: Record<number | string, number[]> = {} as any;
  if (isFilterAvailable('Race_number') && isFilterAvailable('Leg_number')) {
    try {
      const { persistantStore } = await import('../store/persistantStore');
      const { huniDBStore } = await import('../store/huniDBStore');
      const { TableNames, escapeTableName } = await import('../store/huniDBTypes');

      const className = persistantStore.selectedClassName?.() || 'ac40';
      const projectId = persistantStore.selectedProjectId?.();
      const datasetId = persistantStore.selectedDatasetId?.();
      const sourceId = persistantStore.selectedSourceId?.();
      const date = persistantStore.selectedDate?.();

      if (className && projectId) {
        const db = await huniDBStore.getDatabase(className.toLowerCase());
        const eventsTable = escapeTableName(TableNames.events);
        const whereConditions: string[] = ['project_id = ?'];
        const params: any[] = [String(projectId)];

        if (datasetId && datasetId > 0) {
          whereConditions.push('dataset_id = ?');
          params.push(String(datasetId));
        }
        if (sourceId && sourceId > 0) {
          whereConditions.push('source_id = ?');
          params.push(String(sourceId));
        }
        if (date && date.trim() !== '') {
          try {
            const dateObj = new Date(date);
            if (!isNaN(dateObj.getTime())) {
              const startOfDay = new Date(dateObj);
              startOfDay.setHours(0, 0, 0, 0);
              const endOfDay = new Date(dateObj);
              endOfDay.setHours(23, 59, 59, 999);
              whereConditions.push('start_time >= ?', 'start_time <= ?');
              params.push(startOfDay.getTime(), endOfDay.getTime());
            }
          } catch (_) {}
        }
        const whereClause = whereConditions.join(' AND ');
        const raceLegSql = `
          SELECT DISTINCT
            COALESCE(json_extract(tags, '$.Race_number'), json_extract(tags, '$.race_number')) AS race_number,
            CAST(COALESCE(json_extract(tags, '$.Leg_number'), json_extract(tags, '$.leg_number')) AS INTEGER) AS leg_number
          FROM ${eventsTable}
          WHERE ${whereClause}
            AND (json_extract(tags, '$.Race_number') IS NOT NULL OR json_extract(tags, '$.race_number') IS NOT NULL)
            AND (json_extract(tags, '$.Leg_number') IS NOT NULL OR json_extract(tags, '$.leg_number') IS NOT NULL)
        `;
        const raceLegRows = await db.query<any>(raceLegSql, params);
        for (const row of raceLegRows) {
          const race = row.race_number;
          const leg = row.leg_number;
          if (race != null && leg != null && !isNaN(leg)) {
            const raceKey = (race === 'TRAINING' || race === 'training' || race === '-1' || race === -1) ? 'TRAINING' : Number(race);
            if (!raceToLegsMap[raceKey]) {
              raceToLegsMap[raceKey] = [];
            }
            if (!raceToLegsMap[raceKey].includes(leg)) {
              raceToLegsMap[raceKey].push(leg);
            }
          }
        }
        Object.entries(raceToLegsMap).forEach(([raceKey, legsArray]) => {
          if (legsArray && Array.isArray(legsArray)) {
            raceToLegsMap[raceKey] = legsArray.sort((a, b) => a - b);
          }
        });
        debug('🔍 extractFilterOptions: Built raceToLegs mapping from agg.events:', raceToLegsMap);
      }
    } catch (error: any) {
      // Handle mobile device error gracefully
      if (error?.message?.includes('mobile devices')) {
        debug('extractFilterOptions: HuniDB disabled on mobile device - will use data array fallback');
      } else {
        logError('extractFilterOptions: Error querying race-leg mapping from IndexedDB:', error);
      }
      // Fallback to extracting from data array if query fails
      if (data && data.length > 0) {
        for (const item of data) {
          const race = item?.Race_number;
          const leg = item?.Leg_number;
          if (race != null && leg != null) {
            const raceKey = (race === 'TRAINING' || race === 'training' || race === -1) ? 'TRAINING' : race;
            if (!raceToLegsMap[raceKey]) {
              raceToLegsMap[raceKey] = [];
            }
            if (!raceToLegsMap[raceKey].includes(leg)) {
              raceToLegsMap[raceKey].push(leg);
            }
          }
        }
        // Ensure legs for each race are sorted
        Object.entries(raceToLegsMap).forEach(([raceKey, legsArray]) => {
          if (legsArray && Array.isArray(legsArray)) {
            raceToLegsMap[raceKey] = legsArray.sort((a, b) => a - b);
          }
        });
        debug('🔍 extractFilterOptions: Fallback - built raceToLegs mapping from data array');
      }
    }
  }

  // Legs from full dataset: use all unique legs from raceToLegsMap (IndexedDB), not from filtered data
  if (isFilterAvailable('Leg_number')) {
    const allLegsFromMap = Object.values(raceToLegsMap).flat();
    if (allLegsFromMap.length > 0) {
      legs = [...new Set(allLegsFromMap)].filter((l: number) => l != null && !isNaN(l)).sort((a, b) => a - b);
      debug('🔍 extractFilterOptions: Extracted legs from IndexedDB (full dataset):', legs);
    } else if (data && data.length > 0) {
      legs = [...new Set(data.map((d: any) => d.leg_number ?? d.Leg_number ?? d.LEG).filter((l: any) => l != null && l !== undefined))].sort((a, b) => a - b);
      debug('🔍 extractFilterOptions: Fallback - extracted legs from data array:', legs);
    }
  }

  // Create filter options object - only include filters that are available
  const filterOptions: any = {
    races,
    grades,
    legs,
    raceToLegs: raceToLegsMap,
    extractedAt: Date.now()
  };
  
  // Save to IndexedDB using simple object storage
  try {
    const { unifiedDataStore } = await import('../store/unifiedDataStore');
    await unifiedDataStore.storeObject('filters', filterOptions);
    debug('🔍 extractFilterOptions: Successfully stored filter options:', filterOptions);
    
    // Also update the global state for immediate use
    setRaceOptions(races);
    setGradeOptions(grades);
    setLegOptions(legs);

    debug('🔍 extractFilterOptions: Updated global state with:', { races, grades, legs });
  } catch (error) {
    logError('extractFilterOptions: Error saving to IndexedDB:', error);
    // Fallback to just updating global state
    setRaceOptions(races);
    setGradeOptions(grades);
    setLegOptions(legs);

    debug('🔍 extractFilterOptions: Fallback - Updated global state with:', { races, grades, legs });
  }
};

// Helper function to process selection data and mark data points with event_id
const processSelectionInData = async (data: any[], selectionData: any[]): Promise<any[]> => {
  if (!data || data.length === 0) {
    return data;
  }
  
  if (selectionData.length === 0) {
    // If no selection data, mark all as unselected
    return data.map(item => ({ ...item, event_id: 0 }));
  }
  
  // For small datasets, process synchronously
  if (data.length < 1000) {
    return processSelectionInDataSync(data, selectionData);
  }
  
  // For large datasets, process asynchronously
  return processSelectionInDataAsync(data, selectionData);
};

// Synchronous version for small datasets
const processSelectionInDataSync = (data: any[], selectionData: any[]): any[] => {
  // Create a lookup map for quick selection checking
  const selectionMap = new Map();
  
  // Populate the map with timestamp ranges for O(1) lookup
  selectionData.forEach((selItem, index) => {
    if (selItem.start_time && selItem.end_time) {
      const startDate = new Date(selItem.start_time);
      const endDate = new Date(selItem.end_time);
      const event_id = selItem.event_id;
      
      selectionMap.set(`range_${index}`, {
        isRange: true,
        start: startDate.getTime(),
        end: endDate.getTime(),
        event_id: event_id
      });
    }
  });
  
  // Mark data points with event_id based on selection
  return data.map(item => {
    const timestamp = getTimestamp(item);
    let event_id = 0; // Default to unselected
    
    // Check if this data point falls within any selection range
    for (const [key, range] of selectionMap) {
      if (range.isRange && timestamp >= range.start && timestamp <= range.end) {
        event_id = range.event_id;
        break; // Use the first matching range
      }
    }
    
    return { ...item, event_id };
  });
};

// Asynchronous version for large datasets
const processSelectionInDataAsync = async (data: any[], selectionData: any[]): Promise<any[]> => {
  return new Promise((resolve) => {
    // Create a lookup map for quick selection checking
    const selectionMap = new Map();
    
    // Populate the map with timestamp ranges for O(1) lookup
    selectionData.forEach((selItem, index) => {
      if (selItem.start_time && selItem.end_time) {
        const startDate = new Date(selItem.start_time);
        const endDate = new Date(selItem.end_time);
        const event_id = selItem.event_id;
        
        selectionMap.set(`range_${index}`, {
          isRange: true,
          start: startDate.getTime(),
          end: endDate.getTime(),
          event_id: event_id
        });
      }
    });
    
    // Process data in chunks
    const result: any[] = [];
    const chunkSize = 1000;
    let index = 0;
    
    const processChunk = () => {
      const endIndex = Math.min(index + chunkSize, data.length);
      
      for (let i = index; i < endIndex; i++) {
        const item = data[i];
        const timestamp = getTimestamp(item);
        let event_id = 0; // Default to unselected
        
        // Check if this data point falls within any selection range
        for (const [key, range] of selectionMap) {
          if (range.isRange && timestamp >= range.start && timestamp <= range.end) {
            event_id = range.event_id;
            break; // Use the first matching range
          }
        }
        
        result.push({ ...item, event_id });
      }
      
      index = endIndex;
      
      if (index < data.length) {
        // Yield control and continue processing
        setTimeout(processChunk, 0);
      } else {
        resolve(result);
      }
    };
    
    processChunk();
  });
};

// Worker-based data filtering for large datasets
export const applyDataFilterWithWorker = async (
  sourceData: any[], 
  states?: any[], 
  races?: any[], 
  legs?: any[], 
  grades?: any[],
  timeRange?: { startTime: string | Date; endTime: string | Date },
  mapOperation: boolean = false,
  selectionData?: any[]
) => {
  if (!sourceData || sourceData.length === 0) {
    return [];
  }

  // Use synchronous filtering for small datasets
  const filtered = applyDataFilter(sourceData, states, races, legs, grades);
  return await processSelectionInData(filtered, selectionData || []);
};
