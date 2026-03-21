import { createSignal, createEffect, onCleanup, onMount, untrack } from "solid-js";
import * as d3 from "d3";
import L from "leaflet"

import Loading from "../../utilities/Loading";

import { persistantStore } from "../../../store/persistantStore";
const { selectedClassIcon, selectedDate } = persistantStore;

import { filtered, tooltip, setTooltip, phase, color, normalized, eventType } from "../../../store/globalStore";
import { selectedEvents, setSelectedEvents, selection, triggerUpdate, setTriggerUpdate, triggerSelection, setTriggerSelection, setHasSelection, setSelection, cutEvents, isCut, isEventHidden, selectedRange } from "../../../store/selectionStore";
import { selectedGradesManeuvers, setSelectedGradesManeuvers, selectedStatesManeuvers, selectedRacesManeuvers, startDate, endDate, selectedSources } from "../../../store/filterStore";

import { getIndexColor, putData } from "../../../utils/global";
import { error as logError, debug, log } from "../../../utils/console";
import { buildColorGrouping } from "../../../utils/colorGrouping";
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

  // Using global color scale for consistency
  let myColorScale: any = d3.scaleLinear()
  let getItemColor: any = null; // Store getItemColor function for SOURCE coloring
  let minVal = 9999999
  let maxVal = -9999999

  const isEventSelected = (id) => selectedEvents().includes(id);
  const isFiltered = (id) => filtered().includes(id);
  const isSelected = (id) => selection().includes(id);

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
      
      // Log fetch attempt for fleet context
      if (context === 'fleet') {
        log(`[FleetManeuversHistory] fetchData called - filtered().length: ${currentFiltered?.length || 0}, hasEvents: ${hasEvents}, mapInitialized: ${mapInitialized()}, map exists: ${!!map}`);
      }
      
      // Map endpoint requires event_list to be non-empty, so we must have events
      if (!hasEvents) {
        // No events yet (e.g. table still loading or no events selected) – skip map fetch for now
        // Only log if map is initialized (to avoid spam during initial load)
        if (mapInitialized() && map) {
          if (context === 'fleet') {
            log(`[FleetManeuversHistory] Skipping fetch - no events in filtered list (length: ${currentFiltered?.length || 0})`);
          } else {
            debug('Map: Skipping fetch - no events in filtered list');
          }
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
        if (context === 'fleet') {
          log(`[FleetManeuversHistory] Cannot fetch data - description is not set. Phase: ${phase()}`);
        }
        logError('Map: Cannot fetch data - description is not set. Phase:', phase());
        return;
      }
      
      if (context === 'fleet') {
        log(`[FleetManeuversHistory] fetchData proceeding - description: ${desc}, phase: ${phase()}`);
      }
      
      // filtered() contains event IDs (numbers) - extract them safely
      const eventIds: number[] = currentFiltered.map((item: any) => {
        // Handle both cases: if item is a number, return it; if it's an object, extract event_id
        return typeof item === 'number' ? item : (item?.event_id ?? item);
      }).filter((id: any): id is number => typeof id === 'number' && id > 0);

      if (eventIds.length === 0) {
        if (context === 'fleet') {
          log(`[FleetManeuversHistory] No valid event IDs found in filtered list`);
        }
        debug('Map: No valid event IDs found in filtered list');
        return;
      }
      
      if (context === 'fleet') {
        log(`[FleetManeuversHistory] fetchData proceeding - eventIds.length: ${eventIds.length}`);
      }

      // Always use event_list so map data matches table filtering (same event set).
      // Service chunks when >100 events to avoid URL length limits.
      debug('Map: eventIds.length =', eventIds.length, 'using event_list endpoint');
      
      const fetchParams: any = {
        eventType: eventType(),
        description: desc,
        eventList: eventIds,
      };

      if (false) {
        debug('Map: Using time range endpoint because eventIds.length =', eventIds.length);
        
        // Extract time range from filterStore or use selectedDate
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

        // Extract filters from filterStore
        const filters: any = {};
        
        // GRADE filter
        const grades = selectedGradesManeuvers();
        if (grades.length > 0) {
          filters.GRADE = grades.map(g => Number(g)).filter(n => !isNaN(n));
        }

        // STATE filter
        const states = selectedStatesManeuvers();
        if (states.length > 0) {
          filters.STATE = states.map(s => String(s).trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
        }

        // SOURCE_NAME filter for fleet context - pass to API via sourceNames parameter
        if (context === 'fleet') {
          const selectedSourceNames = selectedSources(); // filterStore returns string[] of source names
          if (selectedSourceNames && Array.isArray(selectedSourceNames) && selectedSourceNames.length > 0) {
            fetchParams.sourceNames = selectedSourceNames;
            log(`[Map] fetchData - Passing sourceNames to API: ${JSON.stringify(selectedSourceNames)}`);
            // Also add to filters for consistency
            filters.SOURCE_NAME = selectedSourceNames.map(s => String(s).trim().toUpperCase()).filter(s => s.length > 0);
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
        debug('Map: Using regular event_list endpoint because eventIds.length =', eventIds.length);
        // Use regular event_list endpoint
        fetchParams.eventList = eventIds;
        // Explicitly do NOT set timeRange when using event_list
        fetchParams.timeRange = undefined;
      }

      if (context === 'fleet') {
        log(`[FleetManeuversHistory] fetchParams before calling fetchMapData:`, {
          hasEventList: !!fetchParams.eventList,
          eventListLength: fetchParams.eventList?.length || 0,
          hasTimeRange: !!fetchParams.timeRange,
          timeRange: fetchParams.timeRange,
          hasFilters: !!fetchParams.filters,
          filters: fetchParams.filters,
          description: fetchParams.description,
          eventType: fetchParams.eventType
        });
      } else {
        debug('Map: fetchParams before calling fetchMapData:', {
          hasEventList: !!fetchParams.eventList,
          eventListLength: fetchParams.eventList?.length || 0,
          hasTimeRange: !!fetchParams.timeRange,
          hasFilters: !!fetchParams.filters
        });
      }

      const json_data = await fetchMapData(context, fetchParams);

      // Always log for debugging - check context value
      log(`[Map] fetchData called - context: ${context}, json_data length: ${json_data?.length || 0}`);

      if (json_data && json_data.length > 0) {
        latlngarray = [];
        let dataArray: any[][] = [];
        
        let filtered_data = json_data.filter(function (d) {
          return isFiltered(d.event_id) && !isEventHidden(d.event_id);
        });

        // Log map data counts for fleet context
        if (context === 'fleet') {
          log(`[FleetManeuversHistory] Map data fetched: ${json_data.length} maneuvers from API, ${filtered_data.length} after filtering`);
        } else {
          debug(`[Map] Map data fetched: ${json_data.length} maneuvers from API, ${filtered_data.length} after filtering (context: ${context})`);
        }

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
        
        // Log final map data counts for fleet context
        if (context === 'fleet') {
          log(`[FleetManeuversHistory] Map data processed: ${dataArray.length} tracks, ${flat.length} total points`);
        } else {
          debug(`[Map] Map data processed: ${dataArray.length} tracks, ${flat.length} total points (context: ${context})`);
        }
        
        updateMinMaxRanges()

        return dataArray;
      } else {
        return [];
      }
    } catch (error: any) {
      logError("Error fetching data:", error);
      return [];
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
        myColorScale = d3.scaleThreshold()
        myColorScale.domain([12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5])
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
      let data: any[] = []
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
      let data: any[] = []
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
      let data: any[] = []
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
      let data: any[] = []
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
      let data: any[] = []
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
      let data: any[] = []
      mapdata().forEach(item => {
        data.push(item[0])
      })
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'CONFIG');
      myColorScale = scale;
      getItemColor = getItemColorFn; // Store the function for use in getColor
    }
    else if (color() === 'YEAR') //YEAR
    {
      // Use buildColorGrouping for consistency with DataTable and Scatter
      let data: any[] = []
      mapdata().forEach(item => {
        data.push(item[0])
      })
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'YEAR');
      myColorScale = scale;
      getItemColor = getItemColorFn; // Store the function for use in getColor
    }
    else if (color() === 'EVENT') //EVENT
    {
      // Use buildColorGrouping for consistency with DataTable and Scatter
      let data: any[] = []
      mapdata().forEach(item => {
        data.push(item[0])
      })
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'EVENT');
      myColorScale = scale;
      getItemColor = getItemColorFn; // Store the function for use in getColor
    }
    else
    {
      myColorScale = d3.scaleLinear()
      // myColorScale.domain([4, 8, 14, 18, 22])
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
          return "red"
        } else {
          return "#64ed64"
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
    else if (color() === 'YEAR') 
    {
      if (d != undefined && getItemColor) {
        // Use stored getItemColor function for consistent coloring
        return getItemColor(d);
      }
      return "grey";
    }
    else if (color() === 'EVENT') 
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
    const selected = selectedEvents();
    const hasMoreThan8Selections = selected.length > 8;
    
    // When > 8 selections, maintain original color for all points
    if (hasMoreThan8Selections) {
      return getOriginalColor(d);
    }
    
    // When <= 8 selections, use selection-based coloring for selected points
    if (selected.length > 0) {
      return getIndexColor(selected, d.event_id);
    }
    
    // No selections, use original color
    return getOriginalColor(d);
  }

  function DrawMap(maneuvers) {
    // Verify map is initialized before drawing
    if (!mapInitialized() || !map) {
      debug('🗺️ Map.jsx: DrawMap - Map is not initialized!');
      return;
    }
    
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
      const id = d.event_id || d.eventId;
      if (!id) return;
      
      event.stopPropagation();
      
      let newSelectedEvents;
      setSelectedEvents((prev) => {
        if (prev.includes(id)) {
          newSelectedEvents = prev.filter((e) => e !== id);
        } else {
          newSelectedEvents = [...prev, id];
        }
        return newSelectedEvents;
      });

      setTriggerSelection(true);

      // Use the new state to determine hasSelection
      if (newSelectedEvents.length > 0) {
        setHasSelection(true);
      } else {
        // Don't clear hasSelection when the other panel has a brush selection (e.g. map timeseries brushed in split view)
        const hasBrushRange = selectedRange() && selectedRange().length > 0;
        if (!hasBrushRange) {
          setHasSelection(false);
          setSelection([]);
        }
      }
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
    let maneuverPathsData = []
    let boatdataArray = []

    if (maneuvers != undefined) {
      // Convert maneuvers to single paths per maneuver
      const maneuverPaths = [];
      
      maneuvers.forEach(function(maneuver) {
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
      const selectedPaths: Array<{eventId: number, points: any[], firstPoint: any}> = [];
      const nonSelectedPaths: Array<{eventId: number, points: any[], firstPoint: any}> = [];
      
      maneuverPaths.forEach(maneuver => {
        if (isEventSelected(maneuver.eventId)) {
          selectedPaths.push(maneuver);
        } else {
          nonSelectedPaths.push(maneuver);
        }
      });
      
      // Render non-selected paths first, then selected paths on top
      const orderedPaths = [...nonSelectedPaths, ...selectedPaths];
      
      const hasSelection = selectedEvents().length > 0;
      
      // Bind to paths using eventId as key
      const pathsSelection = g.selectAll(".mapPath")
        .data(orderedPaths, d => d.eventId);
      
      pathsSelection
        .enter()
        .append("path")
        .attr("class", d => `mapPath ${getClass(d.firstPoint)}`)
        .attr("data-event-id", d => d.eventId) // Store eventId as attribute for lookup
        .merge(pathsSelection)
        .attr("data-event-id", d => d.eventId) // Ensure update selection also has the attribute
        .style("stroke", d => {
          const selected = selectedEvents();
          const hasMoreThan8Selections = selected.length > 8;
          const isColoredBySource = color() === 'SOURCE';
          
          if (!hasSelection) return getColor(d.firstPoint);
          const isSelected = isEventSelected(d.eventId);
          
          // When colored by SOURCE, always use original color (source name color) for all items
          // Selected items have full opacity, unselected have reduced opacity
          if (isColoredBySource) {
            return getOriginalColor(d.firstPoint);
          }
          
          if (hasMoreThan8Selections) {
            // When > 8 selections: maintain original color for all paths
            return getOriginalColor(d.firstPoint);
          } else {
            // When <= 8 selections: selected use getColor (selection colors), unselected use lightgrey
            return isSelected ? getColor(d.firstPoint) : "lightgrey";
          }
        })
        .style("stroke-width", d => {
          if (!hasSelection) return 1;
          const isSelected = isEventSelected(d.eventId);
          return isSelected ? 3 : 0.5;
        })
        .style("stroke-opacity", d => {
          if (!hasSelection) return 1;
          const isSelected = isEventSelected(d.eventId);
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
      if (hasSelection && selectedPaths.length > 0) {
        const parent = g.node();
        if (parent) {
          // Collect all path nodes with their selection status
          const pathNodes: { node: Element; isSelected: boolean }[] = [];
          pathsSelection.each(function(d) {
            const node = this;
            const isSelected = isEventSelected(d.eventId);
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
      
      // Add invisible circles for hover detection and tooltips
      orderedPaths.forEach(maneuver => {
        const hoverCircles = g.selectAll(`.hover-circle-${maneuver.eventId}`)
          .data(maneuver.points);
        
        hoverCircles.enter()
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
          .style("pointer-events", "all")
          .style("cursor", "pointer")
          .on("mouseover", mouseover)
          .on("mouseout", mouseout)
          .on("mousemove", mousemove)
          .on("click", click);
        
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

        const hasSelection = selectedEvents().length > 0;
        const darkMode = isDark();
        
        // Update all paths - select directly from DOM to ensure we get all paths
        if (!map || !g) return; // Ensure map is ready
        
        // Collect paths and reorder them so selected paths render on top
        const pathNodes: { node: Element; isSelected: boolean; eventId: number }[] = [];
        
        g.selectAll(".mapPath").each(function(d) {
          const node = this;
          
          // Get maneuver data - try from bound data first, fallback to lookup
          let maneuver = d;
          if (!maneuver || !maneuver.points) {
            // If data not bound, try to find it by eventId from stored data
            const eventIdAttr = d3.select(node).attr("data-event-id");
            if (eventIdAttr && maneuverPathsData.length > 0) {
              maneuver = maneuverPathsData.find(m => m.eventId == eventIdAttr);
            }
          }
          
          if (!maneuver || !maneuver.points) return;
          
          const eventId = maneuver.eventId;
          const isSelected = hasSelection && isEventSelected(eventId);
          const firstPoint = maneuver.firstPoint;
          
          if (!firstPoint) return;
          
          // Recalculate path coordinates for current zoom/pan
          const pathString = toMapLinePath(maneuver.points);
          // Validate path string doesn't contain NaN
          if (pathString && pathString !== 'M0,0' && !pathString.includes("NaN")) {
            d3.select(node).attr("d", pathString);
          }
          
          // Update styling
          const hasMoreThan8Selections = selectedEvents().length > 8;
          const isColoredBySource = color() === 'SOURCE';
          
          // When colored by SOURCE, always use original color (source name color) for all items
          // Selected items have full opacity, unselected have reduced opacity
          if (isColoredBySource) {
            node.style.setProperty("stroke", getOriginalColor(firstPoint), "important");
            node.style.setProperty("stroke-width", isSelected ? "3" : (hasSelection ? "0.5" : "1"), "important");
            node.style.setProperty("stroke-opacity", isSelected ? "1" : (hasSelection ? "0.2" : "1"), "important");
          } else if (hasMoreThan8Selections) {
            // When > 8 selections: maintain original color for all paths, adjust opacity
            node.style.setProperty("stroke", getOriginalColor(firstPoint), "important");
            node.style.setProperty("stroke-width", isSelected ? "3" : "0.5", "important");
            node.style.setProperty("stroke-opacity", isSelected ? "1" : "0.2", "important");
          } else {
            // When <= 8 selections: current behavior
            node.style.setProperty("stroke", isSelected ? getColor(firstPoint) : (hasSelection ? "lightgrey" : getColor(firstPoint)), "important");
            node.style.setProperty("stroke-width", isSelected ? "3" : (hasSelection ? "0.5" : "1"), "important");
            node.style.setProperty("stroke-opacity", isSelected ? "1" : (hasSelection ? "0.2" : "1"), "important");
          }
          
          // Store node for reordering
          pathNodes.push({ node, isSelected, eventId });
        });
        
        // Reorder paths in DOM so selected paths render on top
        // In SVG, elements that appear later in DOM are rendered on top
        if (hasSelection && pathNodes.length > 0) {
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
          
          // Bind the point data to the boat so click handler can access event_id
          const boatEventId = d.event_id;
          const isBoatSelected = hasSelection && boatEventId && isEventSelected(boatEventId);
          
          // Get track color for the circle - use same logic as tracks
          const selected = selectedEvents();
          const hasMoreThan8Selections = selected.length > 8;
          const isColoredBySource = color() === 'SOURCE';
          
          let trackColor: string;
          if (!hasSelection) {
            trackColor = getColor(d);
          } else if (isColoredBySource) {
            // When colored by SOURCE, always use original color (source name color)
            trackColor = getOriginalColor(d);
          } else if (hasMoreThan8Selections) {
            // When > 8 selections: maintain original color for all boats
            trackColor = getOriginalColor(d);
          } else {
            // When <= 8 selections: selected use getColor (selection colors), unselected use lightgrey
            trackColor = isBoatSelected ? getColor(d) : "lightgrey";
          }
          
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
          
          let boat: d3.Selection<SVGPathElement, any, null, undefined>;
          if (existingBoat.empty()) {
            // Get current phase to store on boat element
            const currentPhase = phase();
            
            // Create new boat
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
              .on("mouseover", mouseover)                  
              .on("mouseout", mouseout)
              .on("mousemove", mousemove)
              .on("click", click);
            
            let hdg = d.hdg - 180

            // Get boat path based on icon type and zoom level
            const boatPath = getBoatPathForZoom(zoom_level);
            boat.attr("d", boatPath);
            boat.attr("transform", "translate(" + x + "," + y + ") rotate(" + hdg + ")");
            
            // Create circle that will replace the boat (initially hidden)
            // Use the same sanitization as boatId for consistency
            const circleId = `boat-circle-${sanitizedEventId}-${sanitizedTime}`;
            const circle = g.append("circle")
              .datum(d) // Bind the point data so event handlers can access it
              .attr("id", circleId)
              .attr("class", "boat-circle")
              .attr("data-phase", currentPhase) // Store phase to verify it hasn't changed
              .attr("cx", x)
              .attr("cy", y)
              .attr("r", 1.5) // 3px diameter = 1.5px radius
              .style("fill", trackColor)
              .style("stroke", "none")
              .style("opacity", 0) // Start hidden
              .style("pointer-events", "visiblePainted")
              .on("mouseover", mouseover)                  
              .on("mouseout", mouseout)
              .on("mousemove", mousemove)
              .on("click", click);
            
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

    if (selectedEvents().length > 0) {
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

    const hasSelection = selectedEvents().length > 0;
    
    // Collect paths for reordering
    const pathNodes: { node: Element; isSelected: boolean; eventId: number }[] = [];
    
    // Update all paths
    g.selectAll(".mapPath").each(function(d) {
      if (!d) return;
      
      const node = this;
      const maneuver = d;
      const eventId = maneuver.eventId;
      const isSelected = hasSelection && isEventSelected(eventId);
      const firstPoint = maneuver.firstPoint;
      
      if (!firstPoint) return;
      
      // Update styling
      const selected = selectedEvents();
      const hasMoreThan8Selections = selected.length > 8;
      const isColoredBySource = color() === 'SOURCE';
      
      // When colored by SOURCE, always use original color (source name color) for all items
      // Selected items have full opacity, unselected have reduced opacity
      if (isColoredBySource) {
        node.style.setProperty("stroke", getOriginalColor(firstPoint), "important");
        node.style.setProperty("stroke-width", isSelected ? "3" : (hasSelection ? "0.5" : "1"), "important");
        node.style.setProperty("stroke-opacity", isSelected ? "1" : (hasSelection ? "0.2" : "1"), "important");
      } else if (hasMoreThan8Selections) {
        // When > 8 selections: maintain original color for all paths, adjust opacity
        node.style.setProperty("stroke", getOriginalColor(firstPoint), "important");
        node.style.setProperty("stroke-width", isSelected ? "3" : "0.5", "important");
        node.style.setProperty("stroke-opacity", isSelected ? "1" : "0.2", "important");
      } else {
        // When <= 8 selections: current behavior
        node.style.setProperty("stroke", isSelected ? getColor(firstPoint) : (hasSelection ? "lightgrey" : getColor(firstPoint)), "important");
        node.style.setProperty("stroke-width", isSelected ? "3" : (hasSelection ? "0.5" : "1"), "important");
        node.style.setProperty("stroke-opacity", isSelected ? "1" : (hasSelection ? "0.2" : "1"), "important");
      }
      
      // Remove any existing outlines (we don't want outlines)
      const outline = node.parentNode?.querySelector(`.mapPath-outline[data-event-id="${eventId}"]`);
      if (outline) {
        d3.select(outline).remove();
      }
      
      // Store node for reordering
      pathNodes.push({ node, isSelected, eventId });
    });
    
    // Reorder paths in DOM so selected paths render on top
    // In SVG, elements that appear later in DOM are rendered on top
    if (hasSelection && pathNodes.length > 0) {
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
    
    // Update boat opacity based on selection
    g.selectAll(".boat").each(function(d) {
      if (!d || !d.event_id) return;
      const node = this;
      const boatEventId = d.event_id;
      const isBoatSelected = hasSelection && boatEventId && isEventSelected(boatEventId);
      d3.select(node).style("opacity", hasSelection ? (isBoatSelected ? 1 : 0.2) : 1);
    });
    
    // Update boat circle opacity based on selection
    g.selectAll(".boat-circle").each(function(d) {
      if (!d || !d.event_id) return;
      const node = this;
      const boatEventId = d.event_id;
      const isBoatSelected = hasSelection && boatEventId && isEventSelected(boatEventId);
      d3.select(node).style("opacity", hasSelection ? (isBoatSelected ? 1 : 0.2) : 1);
    });

    setTriggerSelection(false);
    
    if (selectedEvents().length > 0) {
      setHasSelection(true);
    } else {
      // Don't clear hasSelection when the other panel has a brush selection (e.g. map timeseries brushed in split view)
      const hasBrushRange = selectedRange() && selectedRange().length > 0;
      if (!hasBrushRange) {
        setHasSelection(false);
        setSelection([]);
      }
    }
  }

  function getClass(d) {
    if (d.tack  == 'PORT') {
        return "map_dash_line"
    } else if (d.tack == 'STBD') {
      return "solid_line"
    } else if (d.tack == 'P - S') {
        return "map_dash_line"
    } else {
        return "solid_line"
    }
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
    if (context === 'fleet') {
      log(`[FleetManeuversHistory] updateMap() called - updateInProgress: ${updateInProgress}`);
    }
    // Guard: prevent concurrent updates
    if (updateInProgress) {
      if (context === 'fleet') {
        log(`[FleetManeuversHistory] updateMap() - update already in progress, returning`);
      }
      return;
    }
    
    // Guard: ensure map is initialized before updating
    if (!mapInitialized() || !map) {
      if (context === 'fleet') {
        log(`[FleetManeuversHistory] updateMap called but map is not initialized yet`);
      }
      debug('Map: updateMap called but map is not initialized yet');
      return;
    }
    
    // Guard: don't update if filtered data is not available yet
    const currentFiltered = filtered();
    if (!currentFiltered || !Array.isArray(currentFiltered) || currentFiltered.length === 0) {
      if (context === 'fleet') {
        log(`[FleetManeuversHistory] updateMap called but filtered data is not available yet - filtered().length: ${currentFiltered?.length || 0}`);
      }
      debug('Map: updateMap called but filtered data is not available yet');
      return;
    }
    
    if (context === 'fleet') {
      log(`[FleetManeuversHistory] updateMap proceeding - filtered().length: ${currentFiltered.length}`);
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
    fetchData().then((data) => {
      if (!map) return;
      DrawMap(data || []);
      updateSelection();
      setFirstLoad(false);
      updateInProgress = false;
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
    // Fallback init for maneuver window / popup: DOM may not be ready when createEffect first ran.
    // Run after the next frame so #maneuver-map is definitely in the document.
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

    // Fallback to window resize event
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
    // Watch triggerUpdate and mapInitialized - triggerUpdate might be set before map is ready
    const hasUpdate = triggerUpdate();
    const isReady = untrack(() => mapInitialized() && map);
    const inProgress = untrack(() => updateInProgress);

    if (!hasUpdate || !isReady) return;
    setTriggerUpdate(false);
    if (inProgress) return;
    // Defer so filtered() is committed before we read it (avoids race with setFiltered in applyFilters)
    queueMicrotask(() => {
      if (untrack(() => updateInProgress)) return;
      untrack(() => updateMap());
    });
  });

  // Watch for filtered data changes - update map when data becomes available and map is ready
  // This serves as a backup in case triggerUpdate doesn't fire or gets cleared
  // Use debouncing to handle rapid re-renders during initial load
  let lastFilteredCount = 0;
  let lastFilteredHash = '';
  let filteredUpdateTimeout: NodeJS.Timeout | null = null;
  createEffect(() => {
    const currentFiltered = filtered();
    const currentFilteredCount = currentFiltered?.length || 0;
    // For fleet context, also watch selectedSources to trigger refetch when sources change
    const sources = context === 'fleet' ? selectedSources() : [];
    const isReady = untrack(() => mapInitialized() && map);
    const hasTriggerUpdate = untrack(() => triggerUpdate());
    
    // Log for fleet context to debug why map isn't updating
    if (context === 'fleet') {
      log(`[FleetManeuversHistory] Map createEffect triggered - filteredCount: ${currentFilteredCount}, isReady: ${isReady}, hasTriggerUpdate: ${hasTriggerUpdate}, sources.length: ${sources?.length || 0}`);
    }
    
    // Use untrack to check updateInProgress to prevent reactive dependency
    const inProgress = untrack(() => updateInProgress);
    
    // Create a hash of filtered IDs to detect actual data changes (not just count)
    const filteredHash = Array.isArray(currentFiltered) && currentFiltered.length > 0
      ? currentFiltered.slice(0, 10).join(',') + `_${currentFilteredCount}` // Use first 10 IDs + count as hash
      : '';
    
    // Clear any pending timeout
    if (filteredUpdateTimeout) {
      clearTimeout(filteredUpdateTimeout);
      filteredUpdateTimeout = null;
    }
    
    // Reset when filtered data is cleared
    if (currentFilteredCount === 0) {
      if (context === 'fleet') {
        log(`[FleetManeuversHistory] Map createEffect - filtered data is empty, returning early`);
      }
      lastFilteredCount = 0;
      lastFilteredHash = '';
      return;
    }
    
    // Only update if:
    // 1. Map is ready
    // 2. We have filtered data
    // 3. Data actually changed (hash changed OR count changed from 0)
    // 4. triggerUpdate is not set (let that handle the update instead)
    // 5. Update is not already in progress
    const justGotData = lastFilteredCount === 0 && currentFilteredCount > 0;
    const dataChanged = filteredHash !== lastFilteredHash || justGotData;

    if (isReady && currentFilteredCount > 0 && dataChanged && !hasTriggerUpdate && !inProgress) {
      const delay = justGotData ? 50 : 100;
      filteredUpdateTimeout = setTimeout(() => {
        // Re-check conditions after timeout (they might have changed)
        const stillReady = untrack(() => mapInitialized() && map);
        const stillHasTrigger = untrack(() => triggerUpdate());
        const stillInProgress = untrack(() => updateInProgress);
        const currentHash = Array.isArray(filtered()) && filtered().length > 0
          ? filtered().slice(0, 10).join(',') + `_${filtered().length}`
          : '';
        
        if (stillReady && !stillHasTrigger && !stillInProgress && currentHash === filteredHash && currentHash !== lastFilteredHash) {
          if (context === 'fleet') {
            log(`[FleetManeuversHistory] Map createEffect - calling updateMap() - hash: ${currentHash}`);
          }
          // Use untrack to prevent this update from triggering reactive effects
          untrack(() => {
            updateMap();
          });
          lastFilteredHash = filteredHash;
        } else {
          if (context === 'fleet') {
            log(`[FleetManeuversHistory] Map createEffect - NOT calling updateMap - stillReady: ${stillReady}, stillHasTrigger: ${stillHasTrigger}, stillInProgress: ${stillInProgress}, currentHash: ${currentHash}, filteredHash: ${filteredHash}, lastFilteredHash: ${lastFilteredHash}`);
          }
        }
        
        filteredUpdateTimeout = null;
      }, delay);
    }
    
    lastFilteredCount = currentFilteredCount;
    if (filteredHash && !filteredUpdateTimeout) {
      lastFilteredHash = filteredHash;
    }
  });
  
  // Cleanup timeout on unmount
  onCleanup(() => {
    if (filteredUpdateTimeout) {
      clearTimeout(filteredUpdateTimeout);
      filteredUpdateTimeout = null;
    }
  });

  createEffect(() => {
    if (triggerSelection()) {
      // Use untrack to prevent updateSelection from creating reactive dependencies
      untrack(() => {
        updateSelection();
      });
    }
  });

  // Watch for selectedEvents changes (from cross-window sync) and update selection
  createEffect(() => {
    // Access selectedEvents to trigger effect when it changes
    const currentSelectedEvents = selectedEvents();
    const isReady = untrack(() => mapInitialized() && map && svg && g);
    
    // Update selection when selectedEvents changes and map is ready
    // Use untrack to prevent updateSelection from creating reactive dependencies
    if (isReady) {
      untrack(() => {
        updateSelection();
      });
    }
  });

  // Watch for cutEvents and isCut changes - update map when cuts are cleared or applied
  let lastCutEventsLength = 0;
  let lastIsCut = false;
  let lastFilteredLength = 0;
  let cutUpdateTimeout: NodeJS.Timeout | null = null;
  createEffect(() => {
    // Access cutEvents and isCut to trigger effect when they change
    const currentCutEvents = cutEvents();
    const currentIsCut = isCut();
    const currentCutEventsLength = currentCutEvents?.length || 0;
    const currentFiltered = filtered();
    const currentFilteredLength = currentFiltered?.length || 0;
    const isReady = untrack(() => mapInitialized() && map);
    const inProgress = untrack(() => updateInProgress);
    
    // Only update map when cut state actually changes (cuts cleared or applied)
    // This prevents unnecessary updates while ensuring the map redraws when cuts are cleared
    const cutsChanged = currentCutEventsLength !== lastCutEventsLength || currentIsCut !== lastIsCut;
    const cutsWereCleared = (lastCutEventsLength > 0 && currentCutEventsLength === 0) || (lastIsCut && !currentIsCut);
    
    if (isReady && !inProgress && cutsChanged) {
      debug('Map: cutEvents or isCut changed, triggering map update', {
        cutEventsLength: currentCutEventsLength,
        isCut: currentIsCut,
        previousCutEventsLength: lastCutEventsLength,
        previousIsCut: lastIsCut,
        cutsWereCleared,
        filteredLength: currentFilteredLength,
        previousFilteredLength: lastFilteredLength
      });
      
      // When cuts are cleared, wait for isCut to become false AND filtered() to be updated
      // Track the filtered length when cuts were active, so we can detect when it changes
      if (cutsWereCleared) {
        // Clear any pending timeout first
        if (cutUpdateTimeout) {
          clearTimeout(cutUpdateTimeout);
          cutUpdateTimeout = null;
        }
        
        const cutDataLength = lastFilteredLength > 0 ? lastFilteredLength : currentFilteredLength; // Remember the cut data size
        const checkForClearedState = (attempt: number, maxAttempts: number = 10) => {
          const checkIsCut = isCut();
          const checkCutEvents = cutEvents();
          const checkFiltered = filtered();
          const cutEventsEmpty = !checkCutEvents || checkCutEvents.length === 0;
          const isCutFalse = !checkIsCut;
          const filteredLength = checkFiltered?.length || 0;
          // filtered() is ready if it has more events than the cut data, OR if isCut is false and it's non-empty
          const filteredUpdated = isCutFalse && filteredLength > 0 && (filteredLength > cutDataLength || cutDataLength === 0);
          
          debug(`Map: Checking cleared state (attempt ${attempt}/${maxAttempts})`, {
            isCut: checkIsCut,
            isCutFalse,
            cutEventsLength: checkCutEvents?.length || 0,
            cutEventsEmpty,
            filteredLength: filteredLength,
            cutDataLength: cutDataLength,
            filteredUpdated
          });
          
          // Both isCut must be false AND cutEvents must be empty AND filtered() must be updated
          if (isCutFalse && cutEventsEmpty && filteredUpdated) {
            debug('Map: Cuts fully cleared, filtered() updated, triggering map update', {
              filteredLength: filteredLength,
              isCut: checkIsCut
            });
            // Use untrack to prevent updateMap from creating reactive dependencies
            untrack(() => {
              updateMap();
            });
            cutUpdateTimeout = null;
          } else if (attempt < maxAttempts) {
            // Not ready yet, wait and retry
            const delay = attempt <= 2 ? 100 : 200; // First 2 retries after 100ms, then 200ms intervals
            debug(`Map: Cuts not fully cleared yet (isCut: ${checkIsCut}, cutEvents: ${checkCutEvents?.length || 0}, filtered: ${filteredLength}), retrying in ${delay}ms...`);
            cutUpdateTimeout = setTimeout(() => {
              checkForClearedState(attempt + 1, maxAttempts);
            }, delay);
          } else {
            // Max attempts reached, force update anyway
            debug('Map: Max retry attempts reached, forcing map update');
            untrack(() => {
              updateMap();
            });
            cutUpdateTimeout = null;
          }
        };
        
        // Start checking after a short delay to allow state to propagate
        cutUpdateTimeout = setTimeout(() => {
          checkForClearedState(1);
        }, 100);
      } else {
        // Cuts were applied (not cleared), update immediately
        // Clear any pending timeout
        if (cutUpdateTimeout) {
          clearTimeout(cutUpdateTimeout);
          cutUpdateTimeout = null;
        }
        // Use untrack to prevent updateMap from creating reactive dependencies
        untrack(() => {
          updateMap();
        });
      }
    }
    
    // Update tracking variables
    lastCutEventsLength = currentCutEventsLength;
    lastIsCut = currentIsCut;
    lastFilteredLength = currentFilteredLength;
  });
  
  // Cleanup timeout on unmount
  onCleanup(() => {
    if (cutUpdateTimeout) {
      clearTimeout(cutUpdateTimeout);
      cutUpdateTimeout = null;
    }
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
    boatFadeTimeouts.forEach(timeout => clearTimeout(timeout));
    boatFadeTimeouts = [];
    
    // Clean up D3 selections and SVG elements
    if (g && g.node()) {
      try {
        g.selectAll("*").remove();
      } catch (error) {
        logError('Map: Error cleaning up D3 selections:', error);
      }
    }
    
    // Clean up SVG overlay
    try {
      d3.select("#maneuver-map").select("svg").selectAll("*").remove();
    } catch (error) {
      // SVG might not exist, ignore
    }
    
    // Remove Leaflet map
    if (map) {
      try {
        map.remove();
        map = null;
      } catch (error) {
        logError('Map: Error removing Leaflet map:', error);
      }
    }

    // Disconnect ResizeObserver
    if (resizeObserver && containerRef) {
      resizeObserver.unobserve(containerRef);
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    // Remove window resize event listener
    window.removeEventListener('resize', resizeChart);
    // Note: keydown listener is cleaned up in onMount return function
    
    // Clear data to free memory
    setMapData([]);
    setColorGroups([]);
    setGroupRepIds(new Set());
    latlngarray = [];
    
    debug('Map: Cleanup complete - all resources cleared');
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
