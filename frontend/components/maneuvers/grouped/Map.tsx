import { createSignal, createEffect, onCleanup, onMount, untrack } from "solid-js";
import * as d3 from "d3";
import L from "leaflet"

import Loading from "../../utilities/Loading";

import { persistantStore } from "../../../store/persistantStore";
const { selectedClassIcon } = persistantStore;

import { filtered, tooltip, setTooltip, phase, color, normalized, eventType, tws, groupDisplayMode } from "../../../store/globalStore";
import { selectedGroupKeys, setSelectedGroupKeys, selectedEvents, triggerUpdate, setTriggerUpdate, triggerSelection, setTriggerSelection, isEventHidden } from "../../../store/selectionStore";
import { selectedGradesManeuvers, setSelectedGradesManeuvers, selectedStatesManeuvers, selectedRacesManeuvers, selectedLegsManeuvers, startDate, endDate, selectedSources } from "../../../store/filterStore";

import { putData } from "../../../utils/global";
import { error as logError, debug, log } from "../../../utils/console";
import { buildColorGrouping, getGroupKeyFromItem, groupKeyEquals } from "../../../utils/colorGrouping";
import { fetchMapData } from "../../../services/maneuversDataService";
import { getManeuversConfig } from "../../../utils/maneuversConfig";
import { isDark } from "../../../store/themeStore";
import { apiEndpoints } from "../../../config/env";
import { user } from "../../../store/userStore";
import { sourcesStore } from "../../../store/sourcesStore";

import "../../../styles/thirdparty/mapbox-gl.css";
import "leaflet/dist/leaflet.css"
import { logWarning } from "@/utils/logging";

// Helper function to sanitize time values for use in CSS selectors
// Replaces problematic characters (negative signs, dots, etc.) with safe alternatives
// CSS identifiers must start with a letter, underscore, or non-ASCII character
// and can contain letters, digits, hyphens, underscores, and non-ASCII characters
/** Boat positions are drawn every 5 seconds along the track */
const BOAT_INTERVAL_SEC = 5;

/** Returns [prevPoint, point] pairs for drawing boats at most every BOAT_INTERVAL_SEC, based on point.time (seconds). */
function getBoatPositionsByTime(points: { time?: string | number; LatLng?: unknown }[]): [typeof points[0], typeof points[0]][] {
  const result: [typeof points[0], typeof points[0]][] = [];
  if (!points?.length) return result;
  let lastBoatTime = -Infinity;
  for (let idx = 0; idx < points.length; idx++) {
    const d = points[idx];
    const t = typeof d?.time === "number" && Number.isFinite(d.time) ? d.time : (d?.time != null ? Number(d.time) : NaN);
    const timeSec = Number.isFinite(t) ? t : idx * 0.5; // fallback ~2Hz if time missing
    if (idx === 0 || timeSec >= lastBoatTime + BOAT_INTERVAL_SEC) {
      const prev = idx > 0 ? points[idx - 1] : d;
      result.push([prev, d]);
      lastBoatTime = timeSec;
    }
  }
  if (points.length > 0) {
    const last = points[points.length - 1];
    const secondLast = points.length > 1 ? points[points.length - 2] : last;
    if (result.length === 0 || result[result.length - 1][1] !== last) {
      result.push([secondLast, last]);
    }
  }
  return result;
}

const sanitizeTimeForId = (time: string | number | null | undefined): string => {
  // Handle null, undefined, or empty values
  if (time === null || time === undefined || time === '') {
    return '0';
  }
  
  const timeStr = String(time);
  
  // If the string is empty after conversion, return '0'
  if (timeStr.trim() === '') {
    return '0';
  }
  
  // Replace negative sign at the start with 'neg' prefix
  let sanitized = timeStr.startsWith('-') 
    ? 'neg' + timeStr.substring(1)
    : timeStr;
  
  // Replace dots with 'dot'
  sanitized = sanitized.replace(/\./g, 'dot');
  
  // Replace any remaining problematic characters (non-alphanumeric except underscore and hyphen) with underscore
  // But ensure we don't have consecutive hyphens or hyphens at the start
  sanitized = sanitized.replace(/[^a-zA-Z0-9_-]/g, '_');
  
  // Ensure it starts with a letter or underscore (CSS identifier requirement)
  // If it starts with a digit, prefix with 't'
  if (/^[0-9]/.test(sanitized)) {
    sanitized = 't' + sanitized;
  }
  
  // Replace consecutive hyphens with single hyphen
  sanitized = sanitized.replace(/-+/g, '-');
  
  // Remove leading/trailing hyphens
  sanitized = sanitized.replace(/^-+|-+$/g, '');
  
  // If empty after all processing, return '0'
  if (sanitized === '') {
    return '0';
  }
  
  return sanitized;
};

// Function to get boat path based on class icon type and zoom level
const getBoatPathForZoom = (zoomLevel: number): string => {
  const iconValue = selectedClassIcon();
  const iconType = (iconValue && typeof iconValue === 'string' && iconValue.trim() !== '') 
    ? iconValue.trim().toLowerCase() 
    : 'monohull';
  
  if (iconType === 'multihull') {
    // Multihull paths scaled for different zoom levels, centered at (0,0)
    if (zoomLevel > 18) {
      // Full size multihull (2x wider), centered at (0,0) - goes from y=-12 to y=12
      return "M0 12 L5.332 0 L5.332 6 L6.665 12 L8 6 L8 -12 L-8 -12 L-8 6 L-6.665 12 L-5.332 6 L-5.332 0 Z";
    } else if (zoomLevel > 14) {
      // Medium size multihull (58% scale), centered at (0,0)
      return "M0 7 L3.109 0 L3.109 3.5 L3.888 7 L4.666 3.5 L4.666 -7 L-4.666 -7 L-4.666 3.5 L-3.888 7 L-3.109 3.5 L-3.109 0 Z";
    } else if (zoomLevel > 10) {
      // Small size multihull (25% scale), centered at (0,0)
      return "M0 3 L1.333 0 L1.333 1.5 L1.666 3 L2 1.5 L2 -3 L-2 -3 L-2 1.5 L-1.666 3 L-1.333 1.5 L-1.333 0 Z";
    }
  }
  
  // Default monohull paths for different zoom levels
  if (zoomLevel > 18) {
    return "M0 -12 L-4 -12 L-4 0 L-2 8 L0 12 L2 8 L4 0 L4 -12 Z";
  } else if (zoomLevel > 14) {
    return "M0 -7 L-2 -7 L-2 0 L-1 4 L0 7 L1 4 L2 0 L2 -7 Z";
  } else if (zoomLevel > 10) {
    return "M0 -3 L-1 -3 L-1 0 L-0.5 1.5 L0 3 L0.5 1.5 L1 0 L1 -3 Z";
  }
  
  return ""; // Empty path for very low zoom
};

export default function ManeuverMap(props) {
  // Get context from props, default to 'dataset' for backward compatibility
  const context = props?.context || 'dataset';
  const config = getManeuversConfig(context);
  const [mapdata, setMapData] = createSignal([]);
  const [colorGroups, setColorGroups] = createSignal([]);
  const [groupRepIds, setGroupRepIds] = createSignal(new Set());
  const [description, setDescription] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [firstload, setFirstLoad] = createSignal(true);
  const [mapInitialized, setMapInitialized] = createSignal(false);

  let map, tt, svg, g;
  let updateInProgress = false;
  let zoom_level = 13
  let latlngarray = []
  let firstDraw = true;
  let lastEventType = null;
  let lastPhase = null;
  let shouldCenterOnNextDraw = false;
  // Track all boat fade timeouts so we can clear them on phase change
  let boatFadeTimeouts: NodeJS.Timeout[] = [];

  let mapWidth = 910;
  let mapHeight = 600; // Default height, will be updated to fill container
  let maneuverPathsData: { eventId: number; firstPoint: any; points: any[] }[] = [];

  // Using global color scale for consistency
  let myColorScale: any = d3.scaleLinear()
  let getItemColor = null; // Store getItemColor function for SOURCE coloring
  let minVal = 9999999
  let maxVal = -9999999

  const isFiltered = (id) => filtered().includes(id);
  const getPathGroupKey = (firstPoint) => firstPoint ? getGroupKeyFromItem(firstPoint, color()) : null;
  const isPathSelected = (firstPoint) => {
    const pathKey = getPathGroupKey(firstPoint);
    return pathKey != null && selectedGroupKeys().some((k) => groupKeyEquals(k, pathKey));
  };

  const getDescription = () => {
    const currentPhase = phase();
    const isNormalized = normalized();
    
    if (currentPhase == 'FULL') {
      if (isNormalized) {
        setDescription('0_Normalized')
      } else {
        setDescription('0_Standard')
      }
    } else if (currentPhase == 'INVESTMENT') {
      if (isNormalized) {
        setDescription('1_Normalized')
      } else {
        setDescription('1_Standard')
      }
    } else if (currentPhase == 'TURN') {
      if (isNormalized) {
        setDescription('2_Normalized')
      } else {
        setDescription('2_Standard')
      }
    } else if (currentPhase == 'ACCELERATION') {
      if (isNormalized) {
        setDescription('3_Normalized')
      } else {
        setDescription('3_Standard')
      }
    } else {
      // Default fallback - use FULL phase description if phase is not set or unknown
      if (isNormalized) {
        setDescription('0_Normalized')
      } else {
        setDescription('0_Standard')
      }
    }
  }

  // Async function to fetch data
  const fetchData = async () => {
    try {
      // Get the current filtered event list - map endpoint requires non-empty event_list
      const currentFiltered = filtered();
      const hasEvents = currentFiltered && Array.isArray(currentFiltered) && currentFiltered.length > 0;
      
      log(`[Map] fetchData called - filtered() has ${currentFiltered?.length || 0} event_ids, hasEvents: ${hasEvents}`);
      
      // Map endpoint requires event_list to be non-empty, so we must have events
      if (!hasEvents) {
        // No events yet (e.g. table still loading or no events selected) – skip map fetch for now
        // Only log if map is initialized (to avoid spam during initial load)
        if (mapInitialized() && map) {
          log('Map: Skipping fetch - no events in filtered list');
        }
        return;
      }
      
      // Validate dataset_id when required (for dataset context, we still want to validate dataset_id exists)
      if (context === 'dataset') {
        const { selectedDatasetId } = persistantStore;
        const datasetId = selectedDatasetId();
        if (!datasetId || datasetId <= 0) {
          logError('Map: Cannot fetch data - invalid dataset_id:', datasetId);
          return;
        }
      }
      
      // Ensure description is set before making API call
      getDescription();
      const desc = description();
      
      // Validate that we have a description before making the API call
      if (!desc || desc.trim() === '') {
        logError('Map: Cannot fetch data - description is not set. Phase:', phase());
        return;
      }
      
      // filtered() contains event IDs (numbers) - extract them safely
      const eventIds: number[] = currentFiltered.map((item: any) => {
        // Handle both cases: if item is a number, return it; if it's an object, extract event_id
        return typeof item === 'number' ? item : (item?.event_id ?? item);
      }).filter((id: any): id is number => typeof id === 'number' && id > 0);

      if (eventIds.length === 0) {
        debug('Map: No valid event IDs found in filtered list');
        return;
      }

      // Use time range only when many events and NOT fleet. For fleet, always pass eventList so map data matches table (service batches in chunks of 100).
      const useTimeRange = eventIds.length > 100 && context !== 'fleet';
      log(`[Map] fetchData - eventIds.length = ${eventIds.length}, useTimeRange = ${useTimeRange}, context = ${context}`);
      
      let fetchParams: any = {
        eventType: eventType(),
        description: desc,
      };

      if (useTimeRange) {
        log(`[Map] fetchData - Using time range endpoint because eventIds.length = ${eventIds.length}`);
        
        // Extract time range from filterStore or use selectedDate
        const { selectedDate } = persistantStore;
        const filterStoreStart = startDate();
        const filterStoreEnd = endDate();
        const date = selectedDate();
        
        let startDateValue: string;
        let endDateValue: string;
        
        if (filterStoreStart && filterStoreEnd) {
          startDateValue = filterStoreStart;
          endDateValue = filterStoreEnd;
        } else if (date) {
          startDateValue = date;
          endDateValue = date;
        } else {
          // Fallback to wide range - always provide dates when using by-range endpoint
          startDateValue = '2020-01-01';
          endDateValue = '2099-12-31';
        }

        fetchParams.timeRange = {
          startDate: startDateValue,
          endDate: endDateValue
        };

        // Extract filters from filterStore and props
        const filters: any = {};
        
        // GRADE filter - CRITICAL: This must match the table's GRADE filter
        // FleetManeuversHistory uses local selectedGrades (not synced to filterStore) with default [2, 3]
        // So we need to use default [2, 3] if filterStore is empty to match table behavior
        let grades = selectedGradesManeuvers();
        log(`[Map] fetchData - selectedGradesManeuvers() from filterStore: ${JSON.stringify(grades)}, length: ${grades.length}`);
        
        // If filterStore grades are empty, use default [2, 3] to match FleetManeuversHistory table default
        if (!grades || grades.length === 0) {
          grades = ['2', '3']; // Default to match table's default
          log(`[Map] fetchData - Using default grades [2, 3] to match table behavior`);
        }
        
        if (grades && grades.length > 0) {
          const gradeNumbers = grades.map((g: any) => Number(g)).filter((n: number) => !isNaN(n));
          if (gradeNumbers.length > 0) {
            filters.GRADE = gradeNumbers;
            log(`[Map] fetchData - Added GRADE filter: ${JSON.stringify(filters.GRADE)}`);
          } else {
            log(`[Map] fetchData - WARNING: selectedGradesManeuvers() had values but none converted to valid numbers`);
          }
        }

        // YEAR filter (from props)
        const filterYearValue = props?.filterYear ? (typeof props.filterYear === 'function' ? props.filterYear() : props.filterYear) : '';
        log(`[Map] fetchData - filterYear prop value: "${filterYearValue}"`);
        if (filterYearValue && filterYearValue.trim()) {
          const years = filterYearValue.split(',').map(y => parseInt(y.trim())).filter(y => !isNaN(y));
          if (years.length > 0) {
            filters.YEAR = years;
            log(`[Map] fetchData - Added YEAR filter: ${JSON.stringify(filters.YEAR)}`);
          }
        }

        // EVENT filter (from props)
        const filterEventValue = props?.filterEvent ? (typeof props.filterEvent === 'function' ? props.filterEvent() : props.filterEvent) : '';
        log(`[Map] fetchData - filterEvent prop value: "${filterEventValue}"`);
        if (filterEventValue && filterEventValue.trim()) {
          const events = filterEventValue.split(',').map(e => e.trim()).filter(e => e.length > 0);
          if (events.length > 0) {
            filters.EVENT = events;
            log(`[Map] fetchData - Added EVENT filter: ${JSON.stringify(filters.EVENT)}`);
          }
        }

        // CONFIG filter (from props)
        const filterConfigValue = props?.filterConfig ? (typeof props.filterConfig === 'function' ? props.filterConfig() : props.filterConfig) : '';
        log(`[Map] fetchData - filterConfig prop value: "${filterConfigValue}"`);
        if (filterConfigValue && filterConfigValue.trim()) {
          const configs = filterConfigValue.split(',').map(c => c.trim()).filter(c => c.length > 0);
          if (configs.length > 0) {
            filters.CONFIG = configs;
            log(`[Map] fetchData - Added CONFIG filter: ${JSON.stringify(filters.CONFIG)}`);
          }
        }

        // STATE filter (from props first, then filterStore as fallback)
        const filterStateValue = props?.filterState ? (typeof props.filterState === 'function' ? props.filterState() : props.filterState) : '';
        log(`[Map] fetchData - filterState prop value: "${filterStateValue}"`);
        if (filterStateValue && filterStateValue.trim()) {
          const states = filterStateValue.split(',').map(s => s.trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
          if (states.length > 0) {
            filters.STATE = states;
            log(`[Map] fetchData - Added STATE filter from props: ${JSON.stringify(filters.STATE)}`);
          }
        } else {
          // Fallback to filterStore STATE filter
          const states = selectedStatesManeuvers();
          log(`[Map] fetchData - selectedStatesManeuvers() from filterStore: ${JSON.stringify(states)}`);
          if (states.length > 0) {
            filters.STATE = states.map(s => String(s).trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
            log(`[Map] fetchData - Added STATE filter from filterStore: ${JSON.stringify(filters.STATE)}`);
          }
        }

        // SOURCE_NAME filter for fleet context - pass to API via sourceNames parameter
        if (context === 'fleet') {
          const selectedSourceNames = selectedSources(); // filterStore returns string[] of source names
          if (selectedSourceNames && Array.isArray(selectedSourceNames) && selectedSourceNames.length > 0) {
            fetchParams.sourceNames = selectedSourceNames;
            log(`[Map] fetchData - Passing sourceNames to API: ${JSON.stringify(selectedSourceNames)}`);
          } else {
            // Fallback: if no sources selected, use all available sources from sourcesStore
            if (sourcesStore.isReady()) {
              const allSources = sourcesStore.sources();
              if (allSources && allSources.length > 0) {
                fetchParams.sourceNames = allSources.map((s: any) => s.source_name).filter((name: string) => name);
                log(`[Map] fetchData - No sources selected, using all available sources: ${JSON.stringify(fetchParams.sourceNames)}`);
              } else {
                logWarning(`[Map] fetchData - No sources available in sourcesStore for fleet context`);
              }
            } else {
              logWarning(`[Map] fetchData - sourcesStore not ready, cannot get source names for fleet context`);
            }
          }
        }

        // RACE filter (convert to YEAR/EVENT if needed, or use as-is)
        const races = selectedRacesManeuvers();
        if (races.length > 0) {
          // For now, we'll need to extract YEAR and EVENT from the data
          // But since we don't have access to the full data here, we'll skip RACE filter
          // The parent component should handle this
        }

        // LEG filter - not directly supported by by-range endpoint, skip for now

        if (Object.keys(filters).length > 0) {
          fetchParams.filters = filters;
          log(`[Map] fetchData - Built filters: ${JSON.stringify(filters)}`);
        } else {
          log(`[Map] fetchData - No filters built (empty filters object)`);
        }

        // For historical context, we need to get source names from the selected source
        if (context === 'historical') {
          const { selectedSourceId } = persistantStore;
          const sourceId = selectedSourceId();
          if (sourceId && sourceId > 0) {
            // Get source name from sourcesStore
            const sources = sourcesStore.sources();
            const source = sources.find((s: any) => s.source_id === sourceId);
            if (source && source.source_name) {
              fetchParams.sourceNames = [source.source_name];
            }
          }
        }
        
        // IMPORTANT: Do NOT include eventList when using time range endpoint
        // This ensures we use the by-range endpoint
        // Explicitly set to undefined to prevent any accidental usage
        fetchParams.eventList = undefined;
      } else {
        log(`[Map] fetchData - Using regular event_list endpoint because eventIds.length = ${eventIds.length}`);
        // Use regular event_list endpoint
        fetchParams.eventList = eventIds;
        // Explicitly do NOT set timeRange when using event_list
        fetchParams.timeRange = undefined;
      }

      const json_data = await fetchMapData(context, fetchParams);

      if (json_data && json_data.length > 0) {
        latlngarray = [];
        let dataArray: any[][] = [];
        
        // Log map data counts for debugging
        const uniqueEventIds = new Set(json_data.map((d: any) => d.event_id));
        log(`[Map] fetchData - API returned ${json_data.length} records, ${uniqueEventIds.size} unique event_ids`);
        
        // Start with all data from API - apply client-side filters to match table exactly
        // Note: SOURCE_NAME filtering is now done server-side via sourceNames parameter
        let filtered_data = json_data;
        
        // Apply TWS filter (same logic as FleetManeuversHistory.tsx filterData)
        const selectedTws = Number(tws());
        if (!isNaN(selectedTws)) {
          const beforeTwsCount = filtered_data.length;
          filtered_data = filtered_data.filter((item: any) => {
            const itemTws = item.tws_bin ?? item.tws_avg;
            if (itemTws === null || itemTws === undefined || isNaN(Number(itemTws))) {
              return false;
            }
            const itemTwsNum = Number(itemTws);
            // Filter within ±2.5 of the selected bin value
            // Bin 10 includes values from 7.5 to 12.5 (exclusive on upper bound to avoid overlap)
            const minTws = selectedTws - 2.5;
            const maxTws = selectedTws + 2.5;
            return itemTwsNum >= minTws && itemTwsNum < maxTws;
          });
          const afterTwsCount = filtered_data.length;
          log(`[Map] fetchData - After TWS filter (${selectedTws}): ${beforeTwsCount} -> ${afterTwsCount} records`);
        } else {
          log(`[Map] fetchData - No TWS filter applied (tws() is not a valid number: ${tws()})`);
        }
        
        // Apply RACE filter (same logic as FleetManeuversHistory.tsx filterData)
        const races = selectedRacesManeuvers();
        if (races.length > 0) {
          const beforeRaceCount = filtered_data.length;
          filtered_data = filtered_data.filter((item: any) => {
            const raceValue = item.Race_number ?? item.race_number ?? item.race ?? item.Race;
            if (raceValue == null || raceValue === undefined) return false;
            // Handle TRAINING case
            if (raceValue === -1 || raceValue === '-1') {
              return races.includes('TRAINING') || races.includes('training');
            }
            return races.some(selectedRace => {
              if (selectedRace === 'TRAINING' || selectedRace === 'training') return false;
              return Number(raceValue) === Number(selectedRace);
            });
          });
          const afterRaceCount = filtered_data.length;
          log(`[Map] fetchData - After RACE filter: ${beforeRaceCount} -> ${afterRaceCount} records`);
        }
        
        // Apply LEG filter (same logic as FleetManeuversHistory.tsx filterData)
        const legs = selectedLegsManeuvers();
        if (legs.length > 0) {
          const beforeLegCount = filtered_data.length;
          filtered_data = filtered_data.filter((item: any) => {
            const legValue = item.leg_number ?? item.Leg_number ?? item.LEG;
            if (legValue == null || legValue === undefined) return false;
            return legs.includes(Number(legValue));
          });
          const afterLegCount = filtered_data.length;
          log(`[Map] fetchData - After LEG filter: ${beforeLegCount} -> ${afterLegCount} records`);
        }
        
        // Apply isFiltered() check as final validation to ensure consistency with table (exclude hidden events)
        const beforeIsFilteredCount = filtered_data.length;
        filtered_data = filtered_data.filter(function (d) {
          return isFiltered(d.event_id) && !isEventHidden(d.event_id);
        });
        const afterIsFilteredCount = filtered_data.length;
        
        const filteredUniqueEventIds = new Set(filtered_data.map((d: any) => d.event_id));
        log(`[Map] fetchData - After isFiltered check: ${beforeIsFilteredCount} -> ${afterIsFilteredCount} records, ${filteredUniqueEventIds.size} unique event_ids`);
        
        // Also log what filtered() contains for comparison
        const currentFiltered = filtered();
        log(`[Map] fetchData - filtered() contains ${currentFiltered.length} event_ids`);

        const evt = (eventType() || '').toUpperCase();
        const usePortStbd = evt === 'TAKEOFF' || evt === 'BEARAWAY' || evt === 'ROUNDUP';
        filtered_data.forEach((item) => {
          const processedData = item.json.values.map((d) => {
            let tackValue: string | undefined;
            if (usePortStbd) {
              const twa = item.twa_entry ?? item.twa_build ?? item.Twa_start ?? 0;
              tackValue = Number(twa) > 0 ? 'STBD' : 'PORT';
            } else if (phase() == 'FULL' || phase() == 'TURN') {
              tackValue = item.twa_entry > 0 ? 'S - P' : 'P - S';
            } else if (phase() == 'INVESTMENT') {
              tackValue = item.twa_entry > 0 ? 'STBD' : 'PORT';
            } else {
              tackValue = item.twa_entry > 0 ? 'PORT' : 'STBD';
            }

            // Convert race_number -1 to 'TRAINING'
            const raceValue = item.Race_number ?? item.race_number ?? item.race ?? item.Race;
            const convertedRace = (raceValue === -1 || raceValue === '-1') ? 'TRAINING' : raceValue;

            const newItem = {
              event_id: item.event_id,
              tws_bin: item.tws_bin,
              tack: tackValue, 
              vmg_perc_avg: item.vmg_perc_avg,
              race: convertedRace,
              source_name: item.source_name || '', 
              State: item.State, 
              Config: item.Config, 
              time: parseFloat(d.time),
              hdg: parseFloat(d.hdg),
              lat: parseFloat(d.lat),
              lng: parseFloat(d.lng),
              twa: parseFloat(d.twa),
              LatLng: new L.LatLng(parseFloat(d.lng), parseFloat(d.lat))
            };

            latlngarray.push(newItem.LatLng);
            return newItem; 
          });
        
          dataArray.push(processedData); 
        });

        setMapData(dataArray);
        // Flatten to points and build color grouping for downstream consumers
        const flat = dataArray.flat();
        const { groups } = buildColorGrouping(flat, color());
        setColorGroups(groups);
        // Compute representative event_id per group for grouped rendering
        const reps = new Set();
        groups.forEach(g => {
          const first = g.items && g.items.length > 0 ? g.items[0] : null;
          if (first && first.event_id !== undefined && first.event_id !== null) reps.add(first.event_id);
        });
        setGroupRepIds(reps);
        
        updateMinMaxRanges()

        return { dataArray, reps };
      } else {
        return { dataArray: [], reps: new Set() };
      }
    } catch (error: any) {
      logError("Error fetching data:", error);
      return { dataArray: [], reps: new Set() };
    }
  };

  function reinitMap() {
    try {
      if (d3.select('#map-area') != undefined) {
        const mapArea = d3.select('#map-area').node();
        const mapAreaRect = mapArea.getBoundingClientRect();
        mapWidth = mapAreaRect.width;
        mapHeight = mapAreaRect.height; // Use full container height

        d3.selectAll(".maneuver-map-container")
          .style("width", "100%")
          .style("height", "100%");

        d3.selectAll(".maneuver-map")
          .style("width", "100%")
          .style("height", "100%");
      
        svg = d3.select(map.getPanes().overlayPane).select("svg");
        svg.selectAll("g").remove();

        g = svg.append("g").attr("width", mapWidth).attr("height", mapHeight)
      }
    } catch (error: any) {
      logError('🗺️ Map.jsx: reinitMap error', error);
    }
  }

  function initMap() {
    try {
      // Try to find either #map-area (for full Maneuvers page) or #maneuver-map (for ManeuverWindow)
      const mapAreaSelector = d3.select('#map-area');
      const maneuverMapSelector = d3.select('#maneuver-map');
      
      let containerElement = null;
      if (mapAreaSelector.node()) {
        containerElement = mapAreaSelector.node();
      } else if (maneuverMapSelector.node()) {
        containerElement = maneuverMapSelector.node();
      }
      
      if (containerElement) {
        const containerRect = containerElement.getBoundingClientRect();
        mapWidth = containerRect.width;
        mapHeight = containerRect.height; // Use full container height
    
        const mapboxTiles = L.tileLayer('', {
          attribution: ''
        });
    
        d3.selectAll(".maneuver-map-container")
          .style("width", "100%")
          .style("height", "100%");
    
        d3.selectAll(".maneuver-map")
          .style("width", "100%")
          .style("height", "100%");
      
        // Check if #maneuver-map exists before initializing
        const maneuverMapElement = document.getElementById('maneuver-map');
        if (!maneuverMapElement) {
          return;
        }
      
        map = L.map('maneuver-map', { minZoom: 0, maxZoom: 24, zoomControl: true })
          .addLayer(mapboxTiles)
          .setView([0, 0], zoom_level);
      
        L.svg({ interactive: true }).addTo(map);
    
        svg = d3.select(map.getPanes().overlayPane).select("svg");
        
        svg.attr("pointer-events", "auto")
          .attr("z-index", 900);
    
        svg.selectAll("g").remove();
        g = svg.append("g").attr("width", mapWidth).attr("height", mapHeight)
          .attr("z-index", 1000);
    
        d3.selectAll(".leaflet-attribution-flag").remove();
    
        map.on("dblclick", function(e) {
          centerMap(latlngarray)
        });
      }
    } catch (error: any) {
    }
  }

  let toMapLinePath = d3.line()
    .defined(function(d) {
      if (!d || !d.LatLng) return false;
      if (!map) return false;
      try {
        const point = map.latLngToLayerPoint(d.LatLng);
        return point && !isNaN(point.x) && !isNaN(point.y) && isFinite(point.x) && isFinite(point.y);
      } catch {
        return false;
      }
    })
    .x(function(d) {
      if (!map || !d || !d.LatLng) return 0;
      try {
        const point = map.latLngToLayerPoint(d.LatLng);
        return isNaN(point.x) ? 0 : point.x;
      } catch {
        return 0;
      }
    })
    .y(function(d) {
      if (!map || !d || !d.LatLng) return 0;
      try {
        const point = map.latLngToLayerPoint(d.LatLng);
        return isNaN(point.y) ? 0 : point.y;
      } catch {
        return 0;
      }
  });

  function applyLatLngToLayer(d) {
    if (!map || !d) {
      return { x: 0, y: 0 };
    }
    try {
      const point = map.latLngToLayerPoint(d);
      if (isNaN(point.x) || isNaN(point.y) || !isFinite(point.x) || !isFinite(point.y)) {
        return { x: 0, y: 0 };
      }
      return point;
    } catch {
      return { x: 0, y: 0 };
    }
  }

  function centerMap(arr) {
    try {
      if (arr != undefined && arr.length > 0) {
        var bounds = new L.LatLngBounds(arr)
        map.fitBounds(bounds)
      }
    }
    catch(err) {
    }
  }

  function updateMinMaxRanges() {
    let channel = 'tws_bin'
    if (color() == 'VMG') {
      channel = 'vmg_perc_avg'
    }

    minVal = 9999999
    maxVal = -9999999
    mapdata().forEach(function(item) {
      try {
        let d = item[0]
        let val = parseFloat(d[channel])
        if (val > maxVal) {maxVal = val}
        if (val < minVal) {minVal = val} 
      } catch {
      }
    })

    InitScales()  
  }

  function InitScales() {
    if (color() === 'TWS') //TWS
    {
        // Fixed TWS bins: 10, 15, 20, 25, 30, 35, 40, 45, 50
        // Use scaleThreshold with 8 thresholds to create 9 color ranges (one for each bin)
        myColorScale = d3.scaleThreshold()
        myColorScale.domain([12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5]);
        myColorScale.range(["blue","lightblue","cyan","lightgreen","yellow","orange","red","darkred","purple"])
    }
    else if (color() === 'VMG') //VMG
    {
        myColorScale = d3.scaleLinear()
        myColorScale.domain([minVal, (minVal + maxVal) / 2, maxVal])
        myColorScale.range(["blue","lightgrey","red"])
    }
    else if (color() === 'TACK') //TACK
    {
        myColorScale = d3.scaleThreshold()
        myColorScale.domain([-180,-1,1,180])
        myColorScale.range(["red","red","#64ed64","#64ed64"])
    }
    else if (color() === 'MAINSAIL') //MAINSAIL
    {
      // Use buildColorGrouping for consistency with DataTable and Scatter
      let data = []
      mapdata().forEach(item => {
        data.push(item[0])
      })
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'MAINSAIL');
      myColorScale = scale;
      getItemColor = getItemColorFn; // Store the function for use in getColor
    }
    else if (color() === 'HEADSAIL') //HEADSAIL
    {
      // Use buildColorGrouping for consistency with DataTable and Scatter
      let data = []
      mapdata().forEach(item => {
        data.push(item[0])
      })
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'HEADSAIL');
      myColorScale = scale;
      getItemColor = getItemColorFn; // Store the function for use in getColor
    }
    else if (color() === 'RACE') //RACE
    {
      // Use buildColorGrouping for consistency with DataTable and Scatter
      let data = []
      mapdata().forEach(item => {
        data.push(item[0])
      })
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'RACE');
      myColorScale = scale;
      getItemColor = getItemColorFn; // Store the function for use in getColor
    }
    else if (color() === 'SOURCE') //SOURCE (fleet context)
    {
      // Use buildColorGrouping for SOURCE to get fleet colors
      let data = []
      mapdata().forEach(item => {
        data.push(item[0])
      })
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'SOURCE');
      myColorScale = scale;
      getItemColor = getItemColorFn; // Store the function for use in getColor
    }
    else if (color() === 'STATE') //STATE
    {
      // Use buildColorGrouping for consistency with DataTable and Scatter
      let data = []
      mapdata().forEach(item => {
        data.push(item[0])
      })
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'STATE');
      myColorScale = scale;
      getItemColor = getItemColorFn; // Store the function for use in getColor
    }
    else if (color() === 'CONFIG') //CONFIG
    {
      // Use buildColorGrouping for consistency with DataTable and Scatter
      let data = []
      mapdata().forEach(item => {
        data.push(item[0])
      })
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'CONFIG');
      myColorScale = scale;
      getItemColor = getItemColorFn; // Store the function for use in getColor
    }
    else
    {
      myColorScale = d3.scaleLinear()
      //myColorScale.domain([4, 8, 14, 18, 22])
      myColorScale.domain([8, 16, 28, 36, 44]);
      myColorScale.range(["yellow","orange","red"])
    }
  }

  // Get the original color based on current color-by setting (without selection-based coloring)
  function getOriginalColor(d) {
    if (color() === 'TWS') 
    {
      if (d != undefined) {
        let val = d.tws_bin;
        return myColorScale(val);
      }
    }
    else if (color() === 'VMG') 
    {
      if (d != undefined) {
        let val = d.vmg_perc_avg
        return myColorScale(val)
      }
    }
    else if (color() === 'TACK') 
    {
      if (d != undefined) {
        if (d.tack == 'PORT') {
          return "red"
        } else if (d.tack == 'STBD') {
          return "#64ed64"
        } else if (d.tack == 'P - S') {
          return "#64ed64"
        } else {
          return "red"
        }
      }
    }
    else if (color() === 'MAINSAIL') 
    {
      if (d != undefined && getItemColor) {
        // Use stored getItemColor function for consistent coloring
        return getItemColor(d);
      }
      return "grey";
    }
    else if (color() === 'HEADSAIL') 
    {
      if (d != undefined && getItemColor) {
        // Use stored getItemColor function for consistent coloring
        return getItemColor(d);
      }
      return "grey";
    }
    else if (color() === 'RACE') 
    {
      if (d != undefined && getItemColor) {
        // Use stored getItemColor function for consistent coloring
        return getItemColor(d);
      }
      return "grey";
    }
    else if (color() === 'SOURCE') 
    {
      if (d != undefined && getItemColor) {
        // Use stored getItemColor function for efficient coloring
        return getItemColor(d);
      }
      return "grey";
    }
    else if (color() === 'STATE') 
    {
      if (d != undefined && getItemColor) {
        // Use stored getItemColor function for consistent coloring
        return getItemColor(d);
      }
      return "grey";
    }
    else if (color() === 'CONFIG') 
    {
      if (d != undefined && getItemColor) {
        // Use stored getItemColor function for consistent coloring
        return getItemColor(d);
      }
      return "grey";
    }
    else
    {
      return "grey"
    }
  }

  function getColor(d) {
    return getOriginalColor(d);
  }

  function DrawMap(maneuvers, groupedManeuvers = null) {
    // Verify map is initialized before drawing
    if (!mapInitialized() || !map) {
      debug('🗺️ Map.jsx: DrawMap - Map is not initialized!');
      return;
    }
    
    const mixMode = groupedManeuvers !== null;
    
    // Verify g element exists and is attached, recreate if missing
    const gNode = g && g.node ? g.node() : null;
    const gInDom = gNode && gNode.parentNode;
    
    if (!g || !gNode || !gInDom) {
      // Try to recreate the g element if it's missing
      try {
        svg = d3.select(map.getPanes().overlayPane).select("svg");
        if (svg.node()) {
          // Remove any existing g elements
          svg.selectAll("g").remove();
          // Recreate the g element
          g = svg.append("g").attr("width", mapWidth).attr("height", mapHeight)
            .attr("z-index", 1000);
          debug('🗺️ Map.jsx: DrawMap - Recreated G element');
        } else {
          logError('🗺️ Map.jsx: DrawMap - SVG element is missing, cannot recreate G element!');
          return;
        }
      } catch (error: any) {
        logError('🗺️ Map.jsx: DrawMap - Failed to recreate G element:', error);
        return;
      }
    }
    
    // Clear all pending boat fade timeouts when starting a new draw
    boatFadeTimeouts.forEach(timeout => clearTimeout(timeout));
    boatFadeTimeouts = [];
    
    d3.select("#maneuver-map").select("svg").selectAll(".line").remove()
    d3.select("#maneuver-map").select("svg").selectAll(".solid_line").remove()  
    d3.select("#maneuver-map").select("svg").selectAll(".map_dash_line").remove()
    d3.select("#maneuver-map").select("svg").selectAll(".mapPath").remove()
    d3.select("#maneuver-map").select("svg").selectAll(".boat").interrupt().remove()
    d3.select("#maneuver-map").select("svg").selectAll(".boat-circle").interrupt().remove()
    d3.select("#maneuver-map").select("svg").selectAll(".hover-circle").remove()

    let click = function(event, d) {
      // Handle case where d might be undefined or doesn't have event_id
      if (!d) return;
      
      // Try to get event_id from the data point
      event.stopPropagation();
      const groupKey = getGroupKeyFromItem(d, color());
      setSelectedGroupKeys((prev) =>
        prev.includes(groupKey) ? prev.filter((k) => k !== groupKey) : [...prev, groupKey]
      );
      setTriggerSelection(true);
    };

    // Mouse event handlers
    // Offset tooltip left of cursor so it stays left on any monitor (e.g. big display)
    const TOOLTIP_LEFT_OFFSET_PX = 500;
    const mouseover = (event, d) => {
      const tooltipContent = getTooltipContent(d); 

      setTooltip({
        visible: true,
        content: tooltipContent,
        x: event.pageX - TOOLTIP_LEFT_OFFSET_PX,
        y: event.pageY - 100
      });
    };

    const mousemove = (event, d) => {
      const tooltipContent = getTooltipContent(d); 

      setTooltip({
        visible: true,
        content: tooltipContent,
        x: event.pageX - TOOLTIP_LEFT_OFFSET_PX,
        y: event.pageY - 100
      });
    };

    const mouseout = () => {
      setTooltip({
        visible: false,
        content: "",
        x: 0,
        y: 0
      });
    }; 

    const getTooltipContent = (point) => {
      if (!point) return "";
  
      // Check if we have State/Config (GP50)
      const hasStateConfig = point.State !== undefined || point.Config !== undefined;
      
      // Use template literals to build an HTML table dynamically
      let tooltipRows = `
              <tr><td>EVENT ID:</td><td>${point.event_id}</td></tr>`;
      
      // Add source_name if available (for fleet/historical contexts)
      if (point.source_name) {
        tooltipRows += `
              <tr><td>SOURCE:</td><td>${point.source_name}</td></tr>`;
      }
      
      tooltipRows += `
              <tr><td>TWS BIN:</td><td>${point.tws_bin}</td></tr>`;
      
      if (hasStateConfig) {
        // GP50: Show State and Config
        tooltipRows += `
              <tr><td>STATE:</td><td>${point.State ?? ''}</td></tr>
              <tr><td>CONFIG:</td><td>${point.Config ?? ''}</td></tr>`;
      }
      
      tooltipRows += `
              <tr><td>RACE:</td><td>${point.race ?? ''}</td></tr>`;
      
      // Only show DATE if it exists in the data
      if (point.date !== undefined && point.date !== null && point.date !== '') {
        tooltipRows += `
              <tr><td>DATE:</td><td>${point.date}</td></tr>`;
      }
      
      // TIME should be in the data - use it directly
      if (point.time !== undefined && point.time !== null && point.time !== '') {
        tooltipRows += `
              <tr><td>TIME:</td><td>${point.time}</td></tr>`;
      }
      
      tooltipRows += `
              <tr><td>TWA:</td><td>${point.twa ?? ''}</td></tr>
              <tr><td>VMG_PERCENT:</td><td>${point.vmg_perc_avg ?? ''}</td></tr>`;
      
      return `<table class='table-striped'>${tooltipRows}</table>`;  
    };

    let linePaths = []
    maneuverPathsData = []
    let boatdataArray = []

    // MIX MODE: First draw individual tracks as background layer (dimmed, no events)
    if (mixMode && maneuvers != undefined) {
      const individualPaths = [];
      
      maneuvers.forEach(function(maneuver) {
        if (!maneuver || maneuver.length === 0) return;
        const eventId = maneuver[0].event_id;
        if (!eventId) return;
        
        const validPoints = maneuver.filter(d => {
          if (!d || !d.LatLng) return false;
          if (d.LatLng.lat !== undefined && d.LatLng.lng !== undefined) {
            const lat = d.LatLng.lat;
            const lng = d.LatLng.lng;
            return !isNaN(lat) && !isNaN(lng) && isFinite(lat) && isFinite(lng);
          }
          return false;
        });
        if (validPoints.length < 2) return;
        
        individualPaths.push({
          eventId: eventId,
          points: validPoints,
          firstPoint: validPoints[0]
        });
      });
      
      // Individual (ungrouped) tracks in MIX mode: always light grey. Use literal so initial draw when switching to mix mode is never undefined.
      const individualSelection = g.selectAll(".mapPath-individual")
        .data(individualPaths, d => d.eventId);
      
      individualSelection
        .enter()
        .append("path")
        .attr("class", "mapPath-individual")
        .attr("data-event-id", d => d.eventId)
        .style("stroke", "lightgrey")
        .merge(individualSelection)
        .attr("data-event-id", d => d.eventId)
        .style("stroke", "lightgrey")
        .style("stroke-width", 0.5)
        .style("stroke-opacity", 0.3)
        .style("stroke-linecap", "round")
        .style("fill", "none")
        .style("pointer-events", "none")
        .attr("d", d => {
          if (!map || !d || !d.points) return "";
          const pathString = toMapLinePath(d.points);
          if (pathString && !pathString.includes("NaN")) {
            return pathString;
          }
          return "";
        });
      
      individualSelection.exit().remove();
      
      // Draw small circles for individual tracks (no boats, no events) — every 5 seconds
      individualPaths.forEach(maneuver => {
        const boatPairs = getBoatPositionsByTime(maneuver.points);
        const circleData = boatPairs.map(([, p]) => p);
        
        const circles = g.selectAll(`.individual-circle-${maneuver.eventId}`)
          .data(circleData);
        
        circles.enter()
          .append("circle")
          .attr("class", `individual-circle individual-circle-${maneuver.eventId}`)
          .merge(circles)
          .attr("cx", d => {
            if (!d || !d.LatLng || !map) return 0;
            const point = applyLatLngToLayer(d.LatLng);
            return isNaN(point.x) ? 0 : point.x;
          })
          .attr("cy", d => {
            if (!d || !d.LatLng || !map) return 0;
            const point = applyLatLngToLayer(d.LatLng);
            return isNaN(point.y) ? 0 : point.y;
          })
          .attr("r", 1.5)
          .style("fill", "lightgrey")
          .style("stroke", "none")
          .style("opacity", 0.3)
          .style("pointer-events", "none");
        
        circles.exit().remove();
      });
    } else {
      // ON mode: remove individual layer so only grouped tracks show
      g.selectAll(".mapPath-individual").remove();
      g.selectAll(".individual-circle").remove();
    }

    // Now draw grouped tracks (or all tracks in ON mode)
    const tracksToDrawAsGrouped = mixMode ? groupedManeuvers : maneuvers;
    
    if (tracksToDrawAsGrouped != undefined) {
      // Convert maneuvers to single paths per maneuver
      const maneuverPaths = [];
      
      tracksToDrawAsGrouped.forEach(function(maneuver) {
        if (!maneuver || maneuver.length === 0) return;
        
        const eventId = maneuver[0].event_id;
        if (!eventId) return;
        
        // Filter points to remove null/invalid LatLng and validate coordinates
        const validPoints = maneuver.filter(d => {
          if (!d || !d.LatLng) return false;
          // Validate LatLng is a valid Leaflet LatLng object or has lat/lng properties
          if (d.LatLng.lat !== undefined && d.LatLng.lng !== undefined) {
            const lat = d.LatLng.lat;
            const lng = d.LatLng.lng;
            return !isNaN(lat) && !isNaN(lng) && isFinite(lat) && isFinite(lng);
          }
          return false;
        });
        if (validPoints.length < 2) return; // Need at least 2 points for a line
        
        maneuverPaths.push({
          eventId: eventId,
          points: validPoints,
          firstPoint: validPoints[0]
        });
      });
      
      // Separate selected and non-selected paths
      const selectedPaths = [];
      const nonSelectedPaths = [];
      
      maneuverPaths.forEach(maneuver => {
        if (isPathSelected(maneuver.firstPoint)) {
          selectedPaths.push(maneuver);
        } else {
          nonSelectedPaths.push(maneuver);
        }
      });

      const orderedPaths = [...nonSelectedPaths, ...selectedPaths];
      const hasSelection = selectedGroupKeys().length > 0;
      const mixMode = groupDisplayMode() === 'MIX';
      // In MIX mode treat all tracks as having "selection" for styling: unselected = dimmed, selected = normal
      const hasSelectionForStyle = hasSelection || mixMode;
      const darkMode = isDark();
      
      // Bind to paths using eventId as key
      const pathsSelection = g.selectAll(".mapPath")
        .data(orderedPaths, d => d.eventId);
      
      pathsSelection
        .enter()
        .append("path")
        .attr("class", "mapPath solid_line") // Grouped mode: draw all maneuvers as solid lines
        .attr("data-event-id", d => d.eventId) // Store eventId as attribute for lookup
        .merge(pathsSelection)
        .attr("class", "mapPath solid_line") // Grouped mode: all maneuvers solid
        .attr("data-event-id", d => d.eventId) // Ensure update selection also has the attribute
        .style("stroke", d => {
          if (!hasSelectionForStyle) return getColor(d.firstPoint);
          const isSelected = isPathSelected(d.firstPoint);
          if (isSelected) return getColor(d.firstPoint);
          // MIX: always use group color for grouped layer (so first render shows colored tracks)
          // ON with selection: unselected dimmed as lightgrey
          return mixMode ? getColor(d.firstPoint) : "lightgrey";
        })
        .style("stroke-width", d => {
          if (!hasSelectionForStyle) return 1;
          // MIX with no selection: full width so grouped tracks are visible
          if (mixMode && !hasSelection) return 1;
          const isSelected = isPathSelected(d.firstPoint);
          return isSelected ? 3 : 0.5;
        })
        .style("stroke-opacity", d => {
          if (!hasSelectionForStyle) return 1;
          // MIX with no selection: full opacity so grouped tracks are visible
          if (mixMode && !hasSelection) return 1;
          const isSelected = isPathSelected(d.firstPoint);
          return isSelected ? 1 : 0.3;
        })
        .style("stroke-linecap", "round")
        .style("fill", "none")
        .style("pointer-events", "none") // Disable pointer events on path, circles will handle it
        .attr("d", d => {
          if (!map || !d || !d.points) return "";
          const pathString = toMapLinePath(d.points);
          // Validate path string doesn't contain NaN
          if (pathString && !pathString.includes("NaN")) {
            return pathString;
          }
          return "";
        });
      
      // Reorder paths in DOM so selected paths render on top
      // In SVG, elements that appear later in DOM are rendered on top
      if (hasSelectionForStyle && selectedPaths.length > 0) {
        const parent = g.node();
        if (parent) {
          // Collect all path nodes with their selection status
          const pathNodes: { node: Element; isSelected: boolean }[] = [];
          pathsSelection.each(function(d) {
            const node = this;
            const isSelected = isPathSelected(d.firstPoint);
            pathNodes.push({ node, isSelected });
          });
          
          // Separate selected and non-selected
          const nonSelected = pathNodes.filter(p => !p.isSelected);
          const selected = pathNodes.filter(p => p.isSelected);
          
          // Reorder: non-selected first, then selected (selected will render on top)
          [...nonSelected, ...selected].forEach(({ node }) => {
            parent.appendChild(node);
          });
        }
      }
      
      // Store path data for updates
      maneuverPathsData = orderedPaths;
      linePaths = pathsSelection;
      
      // Remove any existing outlines (we don't want outlines)
      g.selectAll(".mapPath-outline").remove();
      
      // Add invisible circles for hover detection and tooltips (MIX: no mouse events on unselected)
      orderedPaths.forEach(maneuver => {
        const isSelected = isPathSelected(maneuver.firstPoint);
        const noPointerEvents = mixMode && !isSelected;
        const hoverCircles = g.selectAll(`.hover-circle-${maneuver.eventId}`)
          .data(maneuver.points);
        
        const circlesMerge = hoverCircles.enter()
          .append("circle")
          .attr("class", `hover-circle hover-circle-${maneuver.eventId}`)
          .merge(hoverCircles)
          .attr("cx", d => {
            if (!d || !d.LatLng || !map) return 0;
            const point = applyLatLngToLayer(d.LatLng);
            return isNaN(point.x) ? 0 : point.x;
          })
          .attr("cy", d => {
            if (!d || !d.LatLng || !map) return 0;
            const point = applyLatLngToLayer(d.LatLng);
            return isNaN(point.y) ? 0 : point.y;
          })
          .attr("r", 5) // Hover detection radius
          .style("fill", "transparent")
          .style("stroke", "none")
          .style("pointer-events", noPointerEvents ? "none" : "all")
          .style("cursor", noPointerEvents ? "default" : "pointer");
        if (!noPointerEvents) {
          circlesMerge
            .on("mouseover", mouseover)
            .on("mouseout", mouseout)
            .on("mousemove", mousemove)
            .on("click", click);
        } else {
          circlesMerge.on("mouseover", null).on("mouseout", null).on("mousemove", null).on("click", null);
        }
        
        hoverCircles.exit().remove();
      });
      
      // Handle boats — draw every 5 seconds along each track
      orderedPaths.forEach(maneuver => {
        const boatPairs = getBoatPositionsByTime(maneuver.points);
        boatdataArray.push(...boatPairs);
      });

      // Boats will be drawn in doUpdates function

      function doUpdates() {
        zoom_level = map.getZoom()

        // Verify g still exists and is in DOM before drawing
        const currentGNode = g && g.node ? g.node() : null;
        
        if (!g || !currentGNode) {
          logError('🗺️ Map.jsx: doUpdates - G element is missing!');
          return;
        }

        const hasSelection = selectedGroupKeys().length > 0;
        const mixModeDoUpdates = groupDisplayMode() === 'MIX';
        const hasSelectionForStyle = hasSelection || mixModeDoUpdates;
        
        // Update all paths - select directly from DOM to ensure we get all paths
        if (!map || !g) return; // Ensure map is ready
        
        const pathNodes: { node: Element; isSelected: boolean }[] = [];
        
        g.selectAll(".mapPath").each(function(d) {
          const node = this;
          
          let maneuver = d;
          if (!maneuver || !maneuver.points) {
            const eventIdAttr = d3.select(node).attr("data-event-id");
            if (eventIdAttr && maneuverPathsData.length > 0) {
              maneuver = maneuverPathsData.find(m => m.eventId == eventIdAttr);
            }
          }
          
          if (!maneuver || !maneuver.points) return;
          
          const firstPoint = maneuver.firstPoint;
          const isSelected = hasSelectionForStyle && isPathSelected(firstPoint);
          
          if (!firstPoint) return;
          
          const pathString = toMapLinePath(maneuver.points);
          if (pathString && pathString !== 'M0,0' && !pathString.includes("NaN")) {
            d3.select(node).attr("d", pathString);
          }
          
          // MIX with no selection: show all grouped tracks in group color; MIX with selection / ON with selection: dim unselected
          const unselectedStroke = !hasSelectionForStyle ? getColor(firstPoint) : (mixModeDoUpdates && !hasSelection ? getColor(firstPoint) : "lightgrey");
          node.style.setProperty("stroke", isSelected ? getColor(firstPoint) : unselectedStroke, "important");
          const unselectedWidth = hasSelectionForStyle && !(mixModeDoUpdates && !hasSelection) ? "0.5" : "1";
          const unselectedOpacity = hasSelectionForStyle && !(mixModeDoUpdates && !hasSelection) ? "0.2" : "1";
          node.style.setProperty("stroke-width", isSelected ? "3" : unselectedWidth, "important");
          node.style.setProperty("stroke-opacity", isSelected ? "1" : unselectedOpacity, "important");
          
          pathNodes.push({ node, isSelected });
        });
        
        // Reorder paths in DOM so selected paths render on top
        // In SVG, elements that appear later in DOM are rendered on top
        if (hasSelectionForStyle && pathNodes.length > 0) {
          const parent = g.node();
          if (parent) {
            // Separate selected and non-selected
            const nonSelected = pathNodes.filter(p => !p.isSelected);
            const selected = pathNodes.filter(p => p.isSelected);
            
            // Reorder: non-selected first, then selected
            [...nonSelected, ...selected].forEach(({ node }) => {
              parent.appendChild(node);
            });
          }
        }

        //DRAW BOATS
        // Always remove all boats and circles first to ensure clean state (especially when phase changes)
        g.selectAll(".boat").interrupt().remove();
        g.selectAll(".boat-circle").interrupt().remove();
        
        boatdataArray.forEach(function(boatData) {
          if (!boatData || boatData.length < 2) return;
          
          let d = boatData[1]
          if (!d || !d.LatLng || !map) return;
          
          // Validate coordinates before drawing boat
          const testPoint = applyLatLngToLayer(d.LatLng);
          if (isNaN(testPoint.x) || isNaN(testPoint.y)) return;
          
          const boatGroupKey = getGroupKeyFromItem(d, color());
          const isBoatSelected = hasSelection && selectedGroupKeys().some((k) => groupKeyEquals(k, boatGroupKey));
          const mixModeBoat = groupDisplayMode() === 'MIX';
          const trackColor = !hasSelection ? getColor(d) : (isBoatSelected ? getColor(d) : (mixModeBoat && hasSelection ? getColor(d) : "lightgrey"));
          // Grouped tracks layer always shows boat icons (same as ON mode); selection only affects opacity and pointer-events
          const noBoatEvents = false;
          
          let x = applyLatLngToLayer(d.LatLng).x
          let y = applyLatLngToLayer(d.LatLng).y
          
          // Create a unique ID for this boat based on event_id and time
          // Sanitize the time value to ensure it's valid for CSS selectors (handles negative numbers, dots, etc.)
          const sanitizedTime = sanitizeTimeForId(d.time);
          const sanitizedEventId = String(d.event_id || '0').replace(/[^a-zA-Z0-9_-]/g, '_');
          let boatId = `boat-${sanitizedEventId}-${sanitizedTime}`;
          
          // Final safety check: ensure boatId is a valid CSS identifier
          // Remove any remaining invalid characters, consecutive hyphens, and ensure it starts with a letter
          boatId = boatId
            .replace(/[^a-zA-Z0-9_-]/g, '_') // Remove any remaining invalid chars
            .replace(/-+/g, '-') // Replace consecutive hyphens with single hyphen
            .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
          
          // Ensure it starts with a letter (CSS identifier requirement)
          if (/^[0-9_-]/.test(boatId)) {
            boatId = 'b' + boatId;
          }
          
          // Check if boat already exists
          const existingBoat = g.select(`#${boatId}`);
          
          // MIX unselected: draw only a circle (no boat icon), no mouse events
          if (noBoatEvents) {
            const circleId = `boat-circle-${sanitizedEventId}-${sanitizedTime}`;
            const existingCircle = g.select(`#${circleId}`);
            if (existingCircle.empty()) {
              g.append("circle")
                .datum(d)
                .attr("id", circleId)
                .attr("class", "boat-circle boat-circle-unselected")
                .attr("cx", x)
                .attr("cy", y)
                .attr("r", 2) // Slightly larger for visibility along path
                .style("fill", trackColor)
                .style("stroke", "none")
                .style("opacity", 0.2)
                .style("pointer-events", "none");
            } else {
              existingCircle.attr("cx", x).attr("cy", y).style("fill", trackColor).style("opacity", 0.2);
            }
            return;
          }
          
          let boat;
          if (existingBoat.empty()) {
            // Get current phase to store on boat element
            const currentPhase = phase();
            
            // Create new boat (grouped selected tracks only when not MIX unselected)
            boat = g.append("path")
              .datum(d) // Bind the point data so event handlers can access it
              .attr("id", boatId)
              .attr("class", "boat")
              .attr("data-phase", currentPhase) // Store phase to verify it hasn't changed
              .attr("data-fade-started", "false") // Flag to track if fade has started
              .style("stroke", "black")
              .style("fill", trackColor)
              .style("opacity", hasSelection ? (isBoatSelected ? 1 : 0.2) : 1)
              .style("pointer-events", "visiblePainted")
              .on("mouseover", mouseover).on("mouseout", mouseout).on("mousemove", mousemove).on("click", click);
            
            let hdg = d.hdg - 180

            // Get boat path based on icon type and zoom level
            const boatPath = getBoatPathForZoom(zoom_level);
            boat.attr("d", boatPath);
            boat.attr("transform", "translate(" + x + "," + y + ") rotate(" + hdg + ")");
            
            // Create circle that will replace the boat (initially hidden)
            const circleId = `boat-circle-${sanitizedEventId}-${sanitizedTime}`;
            const circle = g.append("circle")
              .datum(d)
              .attr("id", circleId)
              .attr("class", "boat-circle")
              .attr("data-phase", currentPhase)
              .attr("cx", x)
              .attr("cy", y)
              .attr("r", 1.5)
              .style("fill", trackColor)
              .style("stroke", "none")
              .style("opacity", 0)
              .style("pointer-events", "visiblePainted")
              .on("mouseover", mouseover).on("mouseout", mouseout).on("mousemove", mousemove).on("click", click);
            
            // Start fade transition after delay
            const timeoutId = setTimeout(() => {
              const boatNode = boat.node();
              if (!boatNode || !boatNode.parentNode) return;
              
              // Check if phase has changed - if so, don't start fade
              const boatPhase = boat.attr("data-phase");
              const currentPhaseNow = phase();
              if (boatPhase !== currentPhaseNow) {
                // Phase changed, remove boat and circle
                d3.select(boatNode).remove();
                const circleNode = g.select(`#${circleId}`).node();
                if (circleNode) d3.select(circleNode).remove();
                return;
              }
              
              // Check if fade has already started
              const fadeStarted = boat.attr("data-fade-started") === "true";
              if (fadeStarted) return;
              
              // Mark fade as started
              boat.attr("data-fade-started", "true");
              
              boat
                .interrupt() // Interrupt any existing transition
                .transition()
                .duration(1000) // Fade out over 1 second
                .style("opacity", 0)
                .on("end", function() {
                  // Check phase again before completing fade
                  const boatPhaseEnd = d3.select(this).attr("data-phase");
                  const currentPhaseEnd = phase();
                  if (boatPhaseEnd !== currentPhaseEnd) {
                    // Phase changed during fade, just remove
                    d3.select(this).remove();
                    const circleNode = g.select(`#${circleId}`).node();
                    if (circleNode) d3.select(circleNode).remove();
                    return;
                  }
                  
                  // Remove boat after fade completes
                  const boatNode = this;
                  if (boatNode && boatNode.parentNode) {
                    d3.select(boatNode).remove();
                  }
                  
                  // Fade in circle
                  const circleNode = g.select(`#${circleId}`).node();
                  if (circleNode && circleNode.parentNode) {
                    // Check phase one more time
                    const circlePhase = d3.select(circleNode).attr("data-phase");
                    const currentPhaseCircle = phase();
                    if (circlePhase !== currentPhaseCircle) {
                      d3.select(circleNode).remove();
                      return;
                    }
                    
                    d3.select(circleNode)
                      .interrupt() // Interrupt any existing transition
                      .transition()
                      .duration(500) // Fade in over 0.5 seconds
                      .style("opacity", hasSelection ? (isBoatSelected ? 1 : 0.2) : 1);
                  }
                });
            }, 2000); // Wait 2 seconds before starting fade
            
            // Track the timeout so we can clear it on phase change
            boatFadeTimeouts.push(timeoutId);
          } else {
            // Boat already exists, just update its position, transform, and color
            existingBoat.each(function() {
              const existingBoatSel = d3.select(this);
              let hdg = d.hdg - 180;
              const boatPath = getBoatPathForZoom(zoom_level);
              existingBoatSel.attr("d", boatPath);
              existingBoatSel.attr("transform", "translate(" + x + "," + y + ") rotate(" + hdg + ")");
              existingBoatSel.style("fill", trackColor);
            });
            
            // Update or create circle for existing boat
            // Use the same sanitization as boatId for consistency
            const circleSanitizedTime = sanitizeTimeForId(d.time);
            const circleSanitizedEventId = String(d.event_id || '0').replace(/[^a-zA-Z0-9_-]/g, '_');
            let circleId = `boat-circle-${circleSanitizedEventId}-${circleSanitizedTime}`;
            
            // Final safety check: ensure circleId is a valid CSS identifier
            circleId = circleId
              .replace(/[^a-zA-Z0-9_-]/g, '_')
              .replace(/-+/g, '-')
              .replace(/^-+|-+$/g, '');
            
            if (/^[0-9_-]/.test(circleId)) {
              circleId = 'b' + circleId;
            }
            
            const existingCircle = g.select(`#${circleId}`);
            
            if (existingCircle.empty()) {
              const circle = g.append("circle")
                .datum(d)
                .attr("id", circleId)
                .attr("class", "boat-circle")
                .attr("cx", x)
                .attr("cy", y)
                .attr("r", 1.5)
                .style("fill", trackColor)
                .style("stroke", "none")
                .style("opacity", 0)
                .style("pointer-events", "visiblePainted")
                .on("mouseover", mouseover)                  
                .on("mouseout", mouseout)
                .on("mousemove", mousemove)
                .on("click", click);
            } else {
              existingCircle
                .attr("cx", x)
                .attr("cy", y)
                .style("fill", trackColor);
            }
          }
        });

        // MIX mode: move unselected circles behind all paths so grouped (selected) tracks draw on top
        if (mixModeDoUpdates) {
          const firstPath = g.select(".mapPath").node();
          const unselectedCircleNodes = g.selectAll(".boat-circle-unselected").nodes();
          if (firstPath && unselectedCircleNodes.length > 0) {
            unselectedCircleNodes.reverse().forEach((node: Element) => {
              g.node().insertBefore(node, firstPath);
            });
          }
        }
        
        // Update hover circle positions on zoom/pan
        g.selectAll(".hover-circle").each(function(d) {
          if (d && d.LatLng && map) {
            const point = applyLatLngToLayer(d.LatLng);
            if (!isNaN(point.x) && !isNaN(point.y)) {
              d3.select(this)
                .attr("cx", point.x)
                .attr("cy", point.y);
            }
          }
        });
        
        // Update boat circle positions on zoom/pan
        g.selectAll(".boat-circle").each(function(d) {
          if (d && d.LatLng && map) {
            const point = applyLatLngToLayer(d.LatLng);
            if (!isNaN(point.x) && !isNaN(point.y)) {
              d3.select(this)
                .attr("cx", point.x)
                .attr("cy", point.y);
            }
          }
        });
        
        // Update individual circle positions on zoom/pan (MIX mode)
        g.selectAll(".individual-circle").each(function(d) {
          if (d && d.LatLng && map) {
            const point = applyLatLngToLayer(d.LatLng);
            if (!isNaN(point.x) && !isNaN(point.y)) {
              d3.select(this)
                .attr("cx", point.x)
                .attr("cy", point.y);
            }
          }
        });
      } 

      map.on("zoomend", doUpdates);
      doUpdates();
      
      // Center and zoom to extents after drawing completes
      // This happens on first draw and when content changes (eventType or phase)
      if (shouldCenterOnNextDraw || firstDraw) {
        // Use setTimeout to ensure all drawing is complete before centering
        setTimeout(() => {
          if (latlngarray.length > 0 && map) {
            centerMap(latlngarray);
            shouldCenterOnNextDraw = false;
            if (firstDraw) {
              firstDraw = false;
            }
          }
        }, 100);
      }
      } 

    if (selectedGroupKeys().length > 0) {
      updateSelection();
    }
  }

  function drawFeatures() {
    if (!map || !svg || !g) {
      return;
    }
    
    function doUpdates() {
      if (!map || !svg || !g) return;
      
      // Check if map is fully loaded before accessing bounds
      if (!map._loaded || !map._container) return;
      
      svg.selectAll("line.crosstrack").remove()

      let zoom_level;
      try {
        zoom_level = map.getZoom();
      } catch (e) {
        // Map not ready yet
        return;
      }

      if (zoom_level > 2) {
        // Get current map bounds with a buffer
        let bounds;
        try {
          bounds = map.getBounds();
          // Check if bounds is valid by checking if it has required methods
          if (!bounds || typeof bounds.getSouth !== 'function' || 
              typeof bounds.getNorth !== 'function' || 
              typeof bounds.getWest !== 'function' || 
              typeof bounds.getEast !== 'function') {
            return;
          }
        } catch (e) {
          // Map bounds not available yet
          return;
        }
        
        const buffer = 0.01; // ~1km buffer in degrees
        const minLat = bounds.getSouth() - buffer;
        const maxLat = bounds.getNorth() + buffer;
        const minLon = bounds.getWest() - buffer;
        const maxLon = bounds.getEast() + buffer;
        
        const baseLat = 39.476984;
        const baseLon = -0.291140;
        // const latint = 0.000224956; //25m increments
        const latint = 0.000899872; //100m increments

        // Calculate start and end indices based on visible bounds
        const startIndexNorth = Math.max(0, Math.floor((minLat - baseLat) / latint));
        const endIndexNorth = Math.ceil((maxLat - baseLat) / latint);
        
        const startIndexSouth = Math.max(0, Math.floor((baseLat - maxLat) / latint));
        const endIndexSouth = Math.ceil((baseLat - minLat) / latint);

        // Draw northward lines (only those in visible range)
        for (let i = startIndexNorth; i <= endIndexNorth && i < 1000; i++) {
          if (i < 0) continue;
          
          let lat = baseLat + (i * latint);
          
          // Only draw if line is within visible bounds
          if (lat >= minLat && lat <= maxLat) {
            let fromLatLng = new L.LatLng(lat, baseLon - 0.2)
            let toLatLng = new L.LatLng(lat, baseLon + 0.2)
            
            // Check if line endpoints are within visible longitude range
            if ((baseLon - 0.2 <= maxLon && baseLon - 0.2 >= minLon) || 
                (baseLon + 0.2 <= maxLon && baseLon + 0.2 >= minLon) ||
                (baseLon - 0.2 <= minLon && baseLon + 0.2 >= maxLon)) {
              
              g.append('line')
                .attr("class", "crosstrack")
                .style("stroke", "lightgray")
                .style("stroke-width", 1)
                .attr("x1", applyLatLngToLayer(fromLatLng).x)
                .attr("y1", applyLatLngToLayer(fromLatLng).y)
                .attr("x2", applyLatLngToLayer(toLatLng).x)
                .attr("y2", applyLatLngToLayer(toLatLng).y)
            }
          }
        }

        // Draw southward lines (only those in visible range)
        for (let i = startIndexSouth; i <= endIndexSouth && i < 1000; i++) {
          if (i < 0) continue;
          
          let lat = baseLat - (i * latint);
          
          // Only draw if line is within visible bounds
          if (lat >= minLat && lat <= maxLat) {
            let fromLatLng = new L.LatLng(lat, baseLon - 0.2)
            let toLatLng = new L.LatLng(lat, baseLon + 0.2)
            
            // Check if line endpoints are within visible longitude range
            if ((baseLon - 0.2 <= maxLon && baseLon - 0.2 >= minLon) || 
                (baseLon + 0.2 <= maxLon && baseLon + 0.2 >= minLon) ||
                (baseLon - 0.2 <= minLon && baseLon + 0.2 >= maxLon)) {
              
              g.append('line')
                .attr("class", "crosstrack")
                .style("stroke", "lightgray")
                .style("stroke-width", 1)
                .attr("x1", applyLatLngToLayer(fromLatLng).x)
                .attr("y1", applyLatLngToLayer(fromLatLng).y)
                .attr("x2", applyLatLngToLayer(toLatLng).x)
                .attr("y2", applyLatLngToLayer(toLatLng).y)
            }
          }
        }
      }
    } 

    if (map) {
      // Wait for map to be fully loaded before attaching listeners
      const setupListeners = () => {
        // Check if map is ready
        if (!map || !map._loaded || !map._container) {
          return;
        }
        
        // Map is loaded, attach event listeners (only once)
        // Check if listeners are already attached to avoid duplicates
        if (!map._crosstrackListenersAttached) {
          map.on("zoomend", doUpdates);
          map.on("load", doUpdates); // Also update when map loads/reloads
          map._crosstrackListenersAttached = true;
        }
        
        // Call doUpdates once map is ready
        doUpdates();
      };
      
      // Start setup - will wait for load if needed
      if (map._loaded && map._container) {
        // Map already loaded, setup immediately
        setupListeners();
      } else {
        // Wait for map to load
        map.once("load", setupListeners);
        // Also try after a short delay in case load event already fired
        setTimeout(() => {
          if (map && map._loaded && map._container && !map._crosstrackListenersAttached) {
            setupListeners();
          }
        }, 100);
      }
    }
  }

  function updateSelection() {
    // Use untrack to prevent updateMinMaxRanges from creating reactive dependencies
    untrack(() => {
      updateMinMaxRanges();
    });

    if (!g || !g.node()) {
      return;
    }

    const hasSelection = selectedGroupKeys().length > 0;
    const mixModeUpdate = groupDisplayMode() === 'MIX';
    const pathNodes: { node: Element; isSelected: boolean }[] = [];
    
    g.selectAll(".mapPath").each(function(d) {
      if (!d) return;
      const node = this;
      const maneuver = d;
      const firstPoint = maneuver.firstPoint;
      const isSelected = hasSelection && isPathSelected(firstPoint);
      if (!firstPoint) return;
      
      // With selection: dim unselected paths (MIX and ON); with no selection: use group color
      const unselectedStroke = hasSelection ? "lightgrey" : getColor(firstPoint);
      node.style.setProperty("stroke", isSelected ? getColor(firstPoint) : unselectedStroke, "important");
      node.style.setProperty("stroke-width", isSelected ? "3" : (hasSelection ? "0.5" : "1"), "important");
      node.style.setProperty("stroke-opacity", isSelected ? "1" : (hasSelection ? "0.2" : "1"), "important");
      pathNodes.push({ node, isSelected });
    });
    
    if (hasSelection && pathNodes.length > 0) {
      const parent = g.node();
      if (parent) {
        const nonSelected = pathNodes.filter(p => !p.isSelected);
        const selected = pathNodes.filter(p => p.isSelected);
        [...nonSelected, ...selected].forEach(({ node }) => {
          parent.appendChild(node);
        });
      }
    }

    // MIX mode: individual layer is always light grey
    if (mixModeUpdate) {
      g.selectAll(".mapPath-individual").each(function() {
        this.style.setProperty("stroke", "lightgrey", "important");
      });
      g.selectAll(".individual-circle").each(function() {
        this.style.setProperty("fill", "lightgrey", "important");
      });
    }
    
    g.selectAll(".boat").each(function(d) {
      if (!d) return;
      const node = this;
      const boatGroupKey = getGroupKeyFromItem(d, color());
      const isBoatSelected = hasSelection && selectedGroupKeys().some((k) => groupKeyEquals(k, boatGroupKey));
      const noBoatEvents = groupDisplayMode() === 'MIX' && !isBoatSelected;
      d3.select(node)
        .style("opacity", hasSelection ? (isBoatSelected ? 1 : 0.2) : 1)
        .style("pointer-events", noBoatEvents ? "none" : "visiblePainted");
      if (noBoatEvents) {
        d3.select(node).on("mouseover", null).on("mouseout", null).on("mousemove", null).on("click", null);
      }
    });
    
    g.selectAll(".boat-circle").each(function(d) {
      if (!d) return;
      const node = this;
      const boatGroupKey = getGroupKeyFromItem(d, color());
      const isBoatSelected = hasSelection && selectedGroupKeys().some((k) => groupKeyEquals(k, boatGroupKey));
      const noBoatEvents = groupDisplayMode() === 'MIX' && !isBoatSelected;
      d3.select(node)
        .style("opacity", hasSelection ? (isBoatSelected ? 1 : 0.2) : 1)
        .style("pointer-events", noBoatEvents ? "none" : "visiblePainted");
      if (noBoatEvents) {
        d3.select(node).on("mouseover", null).on("mouseout", null).on("mousemove", null).on("click", null);
      }
    });

    // MIX mode: update hover circles pointer-events and remove handlers when non-interactive
    const mixMode = groupDisplayMode() === 'MIX';
    if (maneuverPathsData && maneuverPathsData.length > 0) {
      maneuverPathsData.forEach((maneuver: { eventId: number; firstPoint: any }) => {
        const isSelected = isPathSelected(maneuver.firstPoint);
        const noPointerEvents = mixMode && !isSelected;
        const sel = g.selectAll(`.hover-circle-${maneuver.eventId}`);
        sel.style("pointer-events", noPointerEvents ? "none" : "all").style("cursor", noPointerEvents ? "default" : "pointer");
        if (noPointerEvents) {
          sel.on("mouseover", null).on("mouseout", null).on("mousemove", null).on("click", null);
        }
      });
    }

    setTriggerSelection(false);
  }

  let containerRef;
  let resizeObserver;

  function resizeChart() {
    if (map) {
      reinitMap();
      map.invalidateSize(); // Notify Leaflet to adjust the map size
      drawFeatures();
      updateMap();
    }
  }

  const updateMap = () => {
    log(`[Map] updateMap called - updateInProgress: ${updateInProgress}, mapInitialized: ${mapInitialized()}, map exists: ${!!map}`);
    
    // Guard: prevent concurrent updates
    if (updateInProgress) {
      log('[Map] updateMap - Skipping because updateInProgress is true');
      return;
    }
    
    // Guard: ensure map is initialized before updating
    if (!mapInitialized() || !map) {
      log('Map: updateMap called but map is not initialized yet');
      return;
    }
    
    // Guard: don't update if filtered data is not available yet
    const currentFiltered = filtered();
    log(`[Map] updateMap - filtered() has ${currentFiltered?.length || 0} event_ids`);
    if (!currentFiltered || !Array.isArray(currentFiltered) || currentFiltered.length === 0) {
      log('Map: updateMap called but filtered data is not available yet');
      return;
    }
    
    // Check if eventType or phase has changed - if so, center map on next draw and clear boats
    const currentEventType = eventType();
    const currentPhase = phase();
    if (lastEventType !== null && (lastEventType !== currentEventType || lastPhase !== currentPhase)) {
      shouldCenterOnNextDraw = true;
      
      // Clear all pending boat fade timeouts
      boatFadeTimeouts.forEach(timeout => clearTimeout(timeout));
      boatFadeTimeouts = [];
      
      // Completely remove all boats and boat circles when phase/eventType changes
      // Use direct SVG selection to ensure clearing works even if g is not available
      d3.select("#maneuver-map").select("svg").selectAll(".boat").interrupt().remove();
      d3.select("#maneuver-map").select("svg").selectAll(".boat-circle").interrupt().remove();
      // Also clear via g if available
      if (g && g.node()) {
        g.selectAll(".boat").interrupt().remove();
        g.selectAll(".boat-circle").interrupt().remove();
      }
    }
    lastEventType = currentEventType;
    lastPhase = currentPhase;
    
    updateInProgress = true;
    setLoading(true);
    fetchData().then((result) => {
      if (result == null || !map) return;
      const data = Array.isArray(result) ? result : result.dataArray;
      const mixMode = groupDisplayMode() === 'MIX';
      let allTracks = data || [];
      let groupedTracks: any[][] | null = null;

      const groupKey = color() === 'SOURCE' ? 'source_name' : color() === 'CONFIG' ? 'Config' : color() === 'STATE' ? 'State' : 'tws_bin';
      if (data && data.length > 0) {
        const byGroup = new Map<any, any[]>();
        data.forEach((track: any[]) => {
          if (!track || track.length === 0) return;
          const gval = track[0][groupKey];
          if (gval === undefined || gval === null) return;
          if (!byGroup.has(gval)) byGroup.set(gval, track);
        });
        const onePerGroup = Array.from(byGroup.values());
        if (onePerGroup.length > 0) {
          if (mixMode) {
            groupedTracks = onePerGroup;
          } else {
            allTracks = onePerGroup;
          }
        }
      }

      DrawMap(allTracks, groupedTracks);
      updateSelection();
      setFirstLoad(false);
      updateInProgress = false;
      if (triggerUpdate()) {
        setTriggerUpdate(false);
        queueMicrotask(() => setTriggerUpdate(true));
      }
      setTimeout(() => {
        if (!map) return;
        setLoading(false);
      }, 500);
    }).catch((error) => {
      if (map) {
        logError('🗺️ Map.jsx: Error in updateMap fetchData', error);
        setLoading(false);
      }
      updateInProgress = false;
    });
  };

  // Use createEffect to ensure DOM is ready before initializing
  createEffect(() => {
    // Only initialize once
    if (mapInitialized()) return;
    
    // Wait for the maneuver-map element to exist in the DOM
    const maneuverMapElement = document.getElementById('maneuver-map');
    
    if (maneuverMapElement && !map) {
      // DOM is ready, initialize map
      initMap();
      
      // Only call drawFeatures and updateMap if map was successfully initialized
      if (map) {
        setMapInitialized(true);
        // Small delay to ensure Leaflet has fully initialized
        setTimeout(() => {
          drawFeatures();
          const hasData = filtered().length > 0;
          const hasTrigger = triggerUpdate();
          if (!hasData && !hasTrigger) return;
          const inProgress = untrack(() => updateInProgress);
          if (hasTrigger) setTriggerUpdate(false);
          if (inProgress) return;
          if (hasTrigger) {
            queueMicrotask(() => {
              if (untrack(() => updateInProgress)) return;
              untrack(() => updateMap());
            });
          } else {
            untrack(() => updateMap());
          }
        }, 100);
      }
    }
  });

  // Function to perform the GRADE update
  const performGradeUpdate = async (gradeValue, selected) => {
    // Get required values from persistent store
    const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const datasetId = selectedDatasetId();
    const sourceId = selectedSourceId();
    
    if (!className || !projectId) {
      logError('Cannot update GRADE: missing class_name or project_id');
      return;
    }
    
    // Get current event type for maneuvers (TACK, GYBE, etc.)
    const currentEventType = eventType();
    const eventTypes = currentEventType ? [currentEventType] : ['TACK', 'GYBE', 'BEARAWAY', 'ROUNDUP']; // Fallback to common maneuver types
    
    try {
      // Call admin API to update GRADE for selected events
      const response = await putData(`${apiEndpoints.admin.events}/tags`, {
        class_name: className,
        project_id: projectId,
        events: selected,
        event_types: eventTypes,
        key: 'GRADE',
        value: gradeValue
      });
      
      if (response.success) {
        debug(`Successfully updated GRADE to ${gradeValue} for ${selected.length} event(s)`);
        
        // Grade update in HuniDB will be implemented when available
        // Currently grade updates are handled on next data fetch
        
        // Update grade filter to include the newly graded value
        const currentGrades = selectedGradesManeuvers();
        const gradeValueStr = String(gradeValue);
        if (!currentGrades.includes(gradeValueStr)) {
          setSelectedGradesManeuvers([...currentGrades, gradeValueStr]);
          debug(`Added grade ${gradeValue} to selectedGrades filter`);
        }
        
        // Clear selected events after successful grade update
        setSelectedEvents([]);
        setHasSelection(false);
        setSelection([]);
        setTriggerSelection(true);
        
        // Trigger parent component to refetch data
        if (props.onDataUpdate && typeof props.onDataUpdate === 'function') {
          props.onDataUpdate();
        } else {
          // Fallback: trigger update
          setTriggerUpdate(true);
        }
      } else {
        logError('Failed to update GRADE:', response.message || 'Unknown error');
      }
    } catch (error: any) {
      logError('Error updating GRADE:', error);
    }
  };

  onMount(() => {
    requestAnimationFrame(() => {
      if (mapInitialized() || map) return;
      const el = document.getElementById('maneuver-map');
      if (!el) return;
      initMap();
      if (!map) return;
      setMapInitialized(true);
      drawFeatures();
      const hasData = filtered().length > 0;
      const hasTrigger = triggerUpdate();
      if (hasData || hasTrigger) {
        if (hasTrigger) setTriggerUpdate(false);
        if (!untrack(() => updateInProgress)) {
          queueMicrotask(() => {
            if (untrack(() => updateInProgress)) return;
            untrack(() => updateMap());
          });
        }
      }
    });

    resizeObserver = new ResizeObserver((entries) => {
      resizeChart();
    });

    if (containerRef) {
      resizeObserver.observe(containerRef);
    }

    window.addEventListener('resize', resizeChart);
    
    // Add keyboard listener for GRADE updates (0-5 keys)
    const handleKeyPress = (event) => {
      try {
        // Don't trigger if user is typing in an input field or textarea
        const target = event.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        
        // Only handle if there are selected events
        const selected = selectedEvents();
        if (!selected || selected.length === 0) {
          return;
        }
        
        // Check if key is 0, 1, 2, 3, 4, or 5
        const key = event.key;
        if (!['0', '1', '2', '3', '4', '5'].includes(key)) {
          return;
        }
        
        // Check if user is NOT a reader (readers cannot grade)
        const currentUser = user();
        if (!currentUser) {
          return;
        }
        
        // Superusers can always grade
        if (currentUser.is_super_user) {
          // Allow grading
        } else {
          // Check if user is a reader - readers cannot grade
          const userPermissions = currentUser.permissions;
          let isReader = false;
          
          if (typeof userPermissions === 'string') {
            isReader = userPermissions === 'reader';
          } else if (typeof userPermissions === 'object' && userPermissions !== null) {
            const permissionValues = Object.values(userPermissions);
            // User is a reader if ALL their permissions are 'reader'
            isReader = permissionValues.length > 0 && permissionValues.every(p => p === 'reader');
          }
          
          if (isReader) {
            return; // Readers cannot grade
          }
        }
        
        // Prevent default behavior and stop propagation
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        
        // Get the grade value from the key
        const gradeValue = parseInt(key, 10);
        
        // Show confirmation dialog before proceeding
        const message = `Are you sure you want to update GRADE to ${gradeValue} for ${selected.length} selected event(s)?\n\nThis action will modify the data and cannot be easily undone.`;
        
        // Use window.confirm - it automatically closes when user clicks OK or Cancel
        const confirmed = window.confirm(message);
        if (!confirmed) {
          // User cancelled - dialog is already closed
          return;
        }
        
        // User confirmed - proceed with the update
        // Call asynchronously to avoid blocking the keydown handler
        setTimeout(() => {
          performGradeUpdate(gradeValue, selected).catch(error => {
            logError('Error in performGradeUpdate:', error);
          });
        }, 0);
      } catch (error: any) {
        logError('Error in handleKeyPress:', error);
        event.preventDefault();
        event.stopPropagation();
      }
    };
    
    window.addEventListener('keydown', handleKeyPress);
    
    // Cleanup function
    return () => {
      window.removeEventListener('resize', resizeChart);
      window.removeEventListener('keydown', handleKeyPress);
      if (resizeObserver && containerRef) {
        resizeObserver.unobserve(containerRef);
        resizeObserver.disconnect();
      }
    };
  });

  createEffect(() => {
    const hasUpdate = triggerUpdate();
    const isReady = untrack(() => mapInitialized() && map);
    const inProgress = untrack(() => updateInProgress);

    if (!hasUpdate || !isReady) return;
    setTriggerUpdate(false);
    if (inProgress) return;
    queueMicrotask(() => {
      if (untrack(() => updateInProgress)) return;
      untrack(() => updateMap());
    });
  });

  // Watch for filtered data changes - update map when data becomes available and map is ready
  // This serves as a backup in case triggerUpdate doesn't fire or gets cleared
  // BUT: Only use this if triggerUpdate is NOT set, to avoid duplicate updates
  let lastFilteredCount = 0;
  let filteredWatcherTriggered = false;
  createEffect(() => {
    const currentFilteredCount = filtered().length;
    const isReady = untrack(() => mapInitialized() && map);
    const hasTriggerUpdate = untrack(() => triggerUpdate());
    
    // Use untrack to check updateInProgress to prevent reactive dependency
    const inProgress = untrack(() => updateInProgress);
    
    // Reset the trigger flag when filtered count goes to 0 (data cleared)
    if (currentFilteredCount === 0) {
      filteredWatcherTriggered = false;
    }
    
    // Only update if filtered count changed from 0 to non-zero (data just loaded)
    // and we haven't already processed this data
    // AND triggerUpdate is not set (let that handle the update instead)
    // AND update is not already in progress
    if (isReady && currentFilteredCount > 0 && lastFilteredCount === 0 && !hasTriggerUpdate && !filteredWatcherTriggered && !inProgress) {
      filteredWatcherTriggered = true;
      // Use untrack to prevent this update from triggering reactive effects
      untrack(() => {
        updateMap();
      });
    }
    
    lastFilteredCount = currentFilteredCount;
  });

  createEffect(() => {
    if (triggerSelection()) {
      // Use untrack to prevent updateSelection from creating reactive dependencies
      untrack(() => {
        updateSelection();
      });
    }
  });

  // Watch for selectedGroupKeys changes (from cross-window sync or table/timeseries) and update selection
  createEffect(() => {
    selectedGroupKeys();
    const isReady = untrack(() => mapInitialized() && map && svg && g);
    
    // Update selection when selectedGroupKeys changes and map is ready
    // Use untrack to prevent updateSelection from creating reactive dependencies
    if (isReady) {
      untrack(() => {
        updateSelection();
      });
    }
  });

  // Watch for groupDisplayMode changes (OFF/ON/MIX) — redraw so hover circles and boats get correct pointer-events and handlers
  // Trigger on actual mode change; also on initial run when mode is MIX so first paint is correct (fix 3)
  let prevGroupDisplayMode: string | undefined;
  createEffect(() => {
    const mode = groupDisplayMode();
    const isReady = untrack(() => mapInitialized() && map);
    const isModeChange = prevGroupDisplayMode !== undefined && prevGroupDisplayMode !== mode;
    const isInitialMIX = prevGroupDisplayMode === undefined && mode === 'MIX';
    if (isReady && (isModeChange || isInitialMIX)) {
      untrack(() => setTriggerUpdate(true));
    }
    prevGroupDisplayMode = mode;
  });

  // Watch for sourcesStore changes when using SOURCE coloring - rebuild color scale when sources load
  createEffect(() => {
    const currentColor = color();
    if (currentColor !== 'SOURCE') {
      return; // Only react when coloring by SOURCE
    }
    
    // Access sourcesStore to trigger effect when sources load
    const sources = sourcesStore.sources();
    const isReady = sourcesStore.isReady();
    
    // If sources just loaded and we have data, rebuild the color scale
    if (isReady && sources.length > 0 && mapdata().length > 0) {
      debug('Map: Sources loaded, rebuilding color scale for SOURCE coloring');
      // Use untrack to prevent InitScales from creating reactive dependencies
      untrack(() => {
        InitScales();
      });
      // Trigger a redraw to apply new colors - use untrack to prevent reactive loop
      const isMapReady = untrack(() => mapInitialized() && map);
      if (isMapReady) {
        untrack(() => {
          updateSelection();
        });
      }
    }
  });

  // Watch for color changes (all color types) - update map when color changes
  // This ensures the maneuver window updates when color changes in the main window
  createEffect(() => {
    const currentColor = color();
    const isReady = untrack(() => mapInitialized() && map && svg && g);
    
    // Update selection and rebuild color scale when color changes and map is ready
    if (isReady && mapdata().length > 0) {
      debug('Map: Color changed, rebuilding color scale and updating selection');
      // Use untrack to prevent InitScales and updateSelection from creating reactive dependencies
      untrack(() => {
        InitScales();
        updateSelection();
      });
    }
  });

  onCleanup(() => {
    setMapInitialized(false);
    if (map) {
      try {
        map.remove();
      } finally {
        map = null;
      }
    }
    if (resizeObserver && containerRef) {
      resizeObserver.unobserve(containerRef);
      resizeObserver.disconnect();
    }

    // Remove window resize event listener
    window.removeEventListener('resize', resizeChart);
    // Note: keydown listener is cleaned up in onMount return function
  });

  return (
    <>
      {firstload() && <Loading />}
      <div ref={el => containerRef = el} class="maneuver-map-container" style={{
          "opacity": loading() ? 0.2 : 1, 
          "pointer-events": loading() ? "none" : "auto", 
          "transition": "opacity 0.5s ease",
          "width": "100%",
          "height": "100%",
          "display": "flex",
          "flex-direction": "column",
          "padding-right": "25px",
        }}>
        <div id="maneuver-map" class="maneuver-map" style={{
            "flex": "1",
            "width": "100%",
            "height": "100%",
          }}></div>
        {/* <p class="flex justify-end mt-2">Lines are separated by 25m</p> */}
        <p class="flex justify-end mt-2">Lines are separated by 100m</p>
        <div id="tt" class="tooltip" style={{
            opacity: tooltip().visible ? 1 : 0, 
            left: `${tooltip().x}px`,
            top: `${tooltip().y}px`,
            position: "fixed",
            "pointer-events": "none",
            "z-index": 9999,
          }} innerHTML={tooltip().content}>
        </div>
      </div>
    </>
  );
}
