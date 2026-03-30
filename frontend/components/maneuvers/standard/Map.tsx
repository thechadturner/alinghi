import { createSignal, createEffect, onCleanup, onMount, untrack, on } from "solid-js";
import * as d3 from "d3";
import L from "leaflet";

import Loading from "../../utilities/Loading";

import { persistantStore } from "../../../store/persistantStore";
const { selectedClassIcon, selectedDate } = persistantStore;

import { filtered, tooltip, setTooltip, phase, color, normalized, eventType } from "../../../store/globalStore";
import { selectedEvents, setSelectedEvents, triggerUpdate, setTriggerUpdate, triggerSelection, setTriggerSelection, setHasSelection, setSelection, cutEvents, isCut, isEventHidden, selectedRange } from "../../../store/selectionStore";
import { selectedGradesManeuvers, setSelectedGradesManeuvers, selectedStatesManeuvers, selectedRacesManeuvers, startDate, endDate, selectedSources } from "../../../store/filterStore";

import { getIndexColor, putData } from "../../../utils/global";
import { error as logError, debug, log, warn } from "../../../utils/console";
import { buildColorGrouping } from "../../../utils/colorGrouping";
import { fetchMapData } from "../../../services/maneuversDataService";
import { getManeuversConfig } from "../../../utils/maneuversConfig";
import { apiEndpoints } from "../../../config/env";
import { user } from "../../../store/userStore";
import { sourcesStore } from "../../../store/sourcesStore";

import "../../../styles/thirdparty/mapbox-gl.css";
import "leaflet/dist/leaflet.css";

function escapeSelectorId(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(id);
  }
  return id.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

export interface ManeuverMapProps {
  context?: "dataset" | "historical" | "fleet";
  onDataUpdate?: () => void;
  /** Solo ManeuverWindow / multi-window: unique Leaflet root id and scoped D3 (avoids duplicate #maneuver-map). */
  instanceId?: string;
}

/** Point along a maneuver track (map + metadata). */
export interface MapTrackPoint {
  event_id?: number;
  time?: number;
  LatLng?: { lat: number; lng: number };
  tws_bin?: number;
  vmg_perc_avg?: number;
  tack?: string;
  State?: string;
  Config?: string;
  source_name?: string;
  race?: string | number;
  date?: string;
  hdg?: number;
  lat?: number;
  lng?: number;
  twa?: number;
  json?: { values: Record<string, unknown>[] };
  [key: string]: unknown;
}

type ManeuverPathRecord = {
  eventId: number;
  firstPoint: MapTrackPoint;
  points: MapTrackPoint[];
};

type LeafletMap = {
  getContainer(): HTMLElement;
  getPanes(): { overlayPane: HTMLElement };
  latLngToLayerPoint(latlng: { lat: number; lng: number }): { x: number; y: number };
  getZoom(): number;
  fitBounds(bounds: unknown): void;
  on(type: string, fn: (e: unknown) => void): unknown;
  once(type: string, fn: (e: unknown) => void): unknown;
  remove(): void;
  invalidateSize(): void;
  getBounds(): {
    getSouth(): number;
    getNorth(): number;
    getWest(): number;
    getEast(): number;
  };
  _loaded?: boolean;
  _container?: HTMLElement | null;
  _crosstrackListenersAttached?: boolean;
};

type GetItemColorFn = (item: MapTrackPoint) => string;

// Helper function to sanitize time values for use in CSS selectors
// Replaces problematic characters (negative signs, dots, etc.) with safe alternatives
// CSS identifiers must start with a letter, underscore, or non-ASCII character
// and can contain letters, digits, hyphens, underscores, and non-ASCII characters
/** Boat positions are drawn every 5 seconds along the track */
const BOAT_INTERVAL_SEC = 5;

/** Returns [prevPoint, point] pairs for drawing boats at most every BOAT_INTERVAL_SEC, based on point.time (seconds). */
function getBoatPositionsByTime(points: MapTrackPoint[]): [MapTrackPoint, MapTrackPoint][] {
  const result: [MapTrackPoint, MapTrackPoint][] = [];
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

export default function ManeuverMap(props: ManeuverMapProps) {
  // Get context from props, default to 'dataset' for backward compatibility
  const context = props?.context || 'dataset';
  const maneuverMapElementId = () =>
    props.instanceId ? `${props.instanceId}-maneuver-map` : "maneuver-map";
  const d3MapPane = () => d3.select(`#${escapeSelectorId(maneuverMapElementId())}`);
  void getManeuversConfig(context);
  const [mapdata, setMapData] = createSignal<MapTrackPoint[][]>([]);
  type ColorGroup = { key: string | number; items: MapTrackPoint[] };
  const [, setColorGroups] = createSignal<ColorGroup[]>([]);
  const [, setGroupRepIds] = createSignal<Set<number>>(new Set<number>());
  const [description, setDescription] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [firstload, setFirstLoad] = createSignal(true);
  const [mapInitialized, setMapInitialized] = createSignal(false);

  let map: LeafletMap | null = null;
  let svg: d3.Selection<SVGSVGElement, unknown, any, any> | undefined;
  let g: d3.Selection<SVGGElement, unknown, any, any> | undefined;
  let updateInProgress = false;
  let zoom_level = 13;
  let latlngarray: { lat: number; lng: number }[] = [];
  let firstDraw = true;
  let lastEventType: string | null = null;
  let lastPhase: string | null = null;
  let shouldCenterOnNextDraw = false;
  // Track all boat fade timeouts so we can clear them on phase change
  let boatFadeTimeouts: NodeJS.Timeout[] = [];

  let mapWidth = 910;
  let mapHeight = 600; // Default height, will be updated to fill container 
  let maneuverPathsData: ManeuverPathRecord[] = [];

  // Using global color scale for consistency
  let myColorScale: any = d3.scaleLinear();
  let getItemColor: GetItemColorFn | null = null; // Store getItemColor function for SOURCE coloring
  let minVal = 9999999
  let maxVal = -9999999

  const isEventSelected = (id: number) => selectedEvents().includes(id);
  const isFiltered = (id: number) => (filtered() as unknown[]).includes(id);

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
        if ((props?.context ?? "dataset") === "fleet") {
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
                warn(`[Map] fetchData - No sources available in sourcesStore for fleet context`);
              }
            } else {
              warn(`[Map] fetchData - sourcesStore not ready, cannot get source names for fleet context`);
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
            const src = sources.find((s: { source_id?: number; source_name?: string }) => s.source_id === sourceId);
            const srcName = src?.source_name;
            if (srcName) {
              fetchParams.sourceNames = [srcName];
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
        const dataArray: MapTrackPoint[][] = [];

        let filtered_data = json_data.filter(function (d: { event_id: number }) {
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
          const processedData = item.json.values.map((d: Record<string, string | undefined>) => {
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

            const newItem: MapTrackPoint = {
              event_id: item.event_id,
              tws_bin: item.tws_bin,
              tack: tackValue,
              vmg_perc_avg: item.vmg_perc_avg,
              race: convertedRace,
              source_name: item.source_name || '',
              State: item.State,
              Config: item.Config,
              time: parseFloat(String(d.time)),
              hdg: parseFloat(String(d.hdg)),
              lat: parseFloat(String(d.lat)),
              lng: parseFloat(String(d.lng)),
              twa: parseFloat(String(d.twa)),
              LatLng: new L.LatLng(parseFloat(String(d.lng)), parseFloat(String(d.lat))),
            };

            if (newItem.LatLng) latlngarray.push(newItem.LatLng);
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
        const reps = new Set<number>();
        groups.forEach((grp: ColorGroup) => {
          const first = grp.items && grp.items.length > 0 ? grp.items[0] : null;
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
      if (!map) return;
      const mc = map.getContainer() as HTMLElement | null;
      const layoutEl =
        (mc && mc.closest(".maneuver-map-container")) ||
        d3.select("#map-area").node() ||
        mc;
      if (!layoutEl || typeof (layoutEl as Element).getBoundingClientRect !== "function") return;
      const mapAreaRect = (layoutEl as HTMLElement).getBoundingClientRect();
      mapWidth = mapAreaRect.width;
      mapHeight = mapAreaRect.height;

      const root = mc?.closest(".maneuver-map-container");
      if (root) {
        d3.select(root)
          .style("width", "100%")
          .style("height", "100%");
        if (mc) d3.select(mc).style("width", "100%").style("height", "100%");
      } else {
        d3.selectAll(".maneuver-map-container")
          .style("width", "100%")
          .style("height", "100%");
        d3.selectAll(".maneuver-map")
          .style("width", "100%")
          .style("height", "100%");
      }

      svg = d3.select(map.getPanes().overlayPane).select("svg");
      svg.selectAll("g").remove();

      g = svg.append("g").attr("width", mapWidth).attr("height", mapHeight);
    } catch (error: any) {
      logError('🗺️ Map.jsx: reinitMap error', error);
    }
  }

  function initMap() {
    try {
      const elId = maneuverMapElementId();
      const maneuverMapElement = document.getElementById(elId);
      if (!maneuverMapElement) return;

      const layoutEl =
        maneuverMapElement.closest(".maneuver-map-container") ||
        d3.select("#map-area").node() ||
        maneuverMapElement;
      const containerRect = (layoutEl as HTMLElement).getBoundingClientRect();
      mapWidth = containerRect.width;
      mapHeight = containerRect.height;

      const mapboxTiles = L.tileLayer('', {
        attribution: ''
      });

      const root = maneuverMapElement.closest(".maneuver-map-container");
      if (root) {
        d3.select(root)
          .style("width", "100%")
          .style("height", "100%");
        d3.select(maneuverMapElement)
          .style("width", "100%")
          .style("height", "100%");
      } else {
        d3.selectAll(".maneuver-map-container")
          .style("width", "100%")
          .style("height", "100%");
        d3.selectAll(".maneuver-map")
          .style("width", "100%")
          .style("height", "100%");
      }

      map = L.map(elId, { minZoom: 0, maxZoom: 24, zoomControl: true })
        .addLayer(mapboxTiles)
        .setView([0, 0], zoom_level) as unknown as LeafletMap;

      L.svg({ interactive: true }).addTo(map);

      svg = d3.select(map.getPanes().overlayPane).select("svg");

      svg.attr("pointer-events", "auto")
        .attr("z-index", 900);

      svg.selectAll("g").remove();
      g = svg.append("g").attr("width", mapWidth).attr("height", mapHeight)
        .attr("z-index", 1000);

      d3.selectAll(".leaflet-attribution-flag").remove();

      map.on("dblclick", function (_e: unknown) {
        centerMap(latlngarray);
      });
    } catch (error: any) {
    }
  }

  const toMapLinePath = d3
    .line<MapTrackPoint>()
    .defined(function (d) {
      if (!d || !d.LatLng) return false;
      if (!map) return false;
      try {
        const point = map.latLngToLayerPoint(d.LatLng);
        return point && !isNaN(point.x) && !isNaN(point.y) && isFinite(point.x) && isFinite(point.y);
      } catch {
        return false;
      }
    })
    .x(function (d) {
      if (!map || !d || !d.LatLng) return 0;
      try {
        const point = map.latLngToLayerPoint(d.LatLng);
        return isNaN(point.x) ? 0 : point.x;
      } catch {
        return 0;
      }
    })
    .y(function (d) {
      if (!map || !d || !d.LatLng) return 0;
      try {
        const point = map.latLngToLayerPoint(d.LatLng);
        return isNaN(point.y) ? 0 : point.y;
      } catch {
        return 0;
      }
    });

  function applyLatLngToLayer(d: { lat: number; lng: number }) {
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

  function centerMap(arr: { lat: number; lng: number }[]) {
    try {
      if (arr != undefined && arr.length > 0 && map) {
        const bounds = new L.LatLngBounds(arr);
        map.fitBounds(bounds);
      }
    } catch {
      // ignore invalid bounds
    }
  }

  function updateMinMaxRanges() {
    let channel = 'tws_bin'
    if (color() == 'VMG') {
      channel = 'vmg_perc_avg'
    }

    minVal = 9999999
    maxVal = -9999999
    mapdata().forEach(function (item: MapTrackPoint[]) {
      try {
        const d = item[0];
        const val = parseFloat(String(d[channel as keyof MapTrackPoint] ?? ""));
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
      const data: MapTrackPoint[] = [];
      mapdata().forEach((item) => {
        data.push(item[0]);
      });
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'MAINSAIL');
      myColorScale = scale;
      getItemColor = getItemColorFn as GetItemColorFn;
    }
    else if (color() === 'HEADSAIL') //HEADSAIL
    {
      const data: MapTrackPoint[] = [];
      mapdata().forEach((item) => {
        data.push(item[0]);
      });
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'HEADSAIL');
      myColorScale = scale;
      getItemColor = getItemColorFn as GetItemColorFn;
    }
    else if (color() === 'RACE') //RACE
    {
      const data: MapTrackPoint[] = [];
      mapdata().forEach((item) => {
        data.push(item[0]);
      });
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'RACE');
      myColorScale = scale;
      getItemColor = getItemColorFn as GetItemColorFn;
    }
    else if (color() === 'SOURCE') //SOURCE (fleet context)
    {
      const data: MapTrackPoint[] = [];
      mapdata().forEach((item) => {
        data.push(item[0]);
      });
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'SOURCE');
      myColorScale = scale;
      getItemColor = getItemColorFn as GetItemColorFn;
    }
    else if (color() === 'STATE') //STATE
    {
      const data: MapTrackPoint[] = [];
      mapdata().forEach((item) => {
        data.push(item[0]);
      });
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'STATE');
      myColorScale = scale;
      getItemColor = getItemColorFn as GetItemColorFn;
    }
    else if (color() === 'CONFIG') //CONFIG
    {
      const data: MapTrackPoint[] = [];
      mapdata().forEach((item) => {
        data.push(item[0]);
      });
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'CONFIG');
      myColorScale = scale;
      getItemColor = getItemColorFn as GetItemColorFn;
    }
    else if (color() === 'YEAR') //YEAR
    {
      const data: MapTrackPoint[] = [];
      mapdata().forEach((item) => {
        data.push(item[0]);
      });
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'YEAR');
      myColorScale = scale;
      getItemColor = getItemColorFn as GetItemColorFn;
    }
    else if (color() === 'EVENT') //EVENT
    {
      const data: MapTrackPoint[] = [];
      mapdata().forEach((item) => {
        data.push(item[0]);
      });
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, 'EVENT');
      myColorScale = scale;
      getItemColor = getItemColorFn as GetItemColorFn;
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
  function getOriginalColor(d: MapTrackPoint | undefined): string {
    if (color() === 'TWS') {
      if (d != undefined) {
        const val = d.tws_bin;
        return (myColorScale as (v: number) => string)(Number(val));
      }
      return "grey";
    }
    if (color() === 'VMG') {
      if (d != undefined) {
        const val = d.vmg_perc_avg;
        return (myColorScale as (v: number) => string)(Number(val));
      }
      return "grey";
    }
    if (color() === 'TACK') {
      if (d != undefined) {
        if (d.tack == 'PORT') {
          return "red";
        } else if (d.tack == 'STBD') {
          return "#64ed64";
        } else if (d.tack == 'P - S') {
          return "red";
        }
        return "#64ed64";
      }
      return "grey";
    }
    if (color() === 'MAINSAIL') {
      if (d != undefined && getItemColor) {
        return getItemColor(d);
      }
      return "grey";
    }
    if (color() === 'HEADSAIL') {
      if (d != undefined && getItemColor) {
        return getItemColor(d);
      }
      return "grey";
    }
    if (color() === 'RACE') {
      if (d != undefined && getItemColor) {
        return getItemColor(d);
      }
      return "grey";
    }
    if (color() === 'SOURCE') {
      if (d != undefined && getItemColor) {
        return getItemColor(d);
      }
      return "grey";
    }
    if (color() === 'STATE') {
      if (d != undefined && getItemColor) {
        return getItemColor(d);
      }
      return "grey";
    }
    if (color() === 'CONFIG') {
      if (d != undefined && getItemColor) {
        return getItemColor(d);
      }
      return "grey";
    }
    if (color() === 'YEAR') {
      if (d != undefined && getItemColor) {
        return getItemColor(d);
      }
      return "grey";
    }
    if (color() === 'EVENT') {
      if (d != undefined && getItemColor) {
        return getItemColor(d);
      }
      return "grey";
    }
    return "grey";
  }

  function getColor(d: MapTrackPoint | undefined): string {
    const selected = selectedEvents();
    const hasMoreThan8Selections = selected.length > 8;
    
    // When > 8 selections, maintain original color for all points
    if (hasMoreThan8Selections) {
      return getOriginalColor(d);
    }
    
    // When <= 8 selections, use selection-based coloring for selected points
    if (selected.length > 0 && d?.event_id != null) {
      return getIndexColor(selected, d.event_id) ?? getOriginalColor(d);
    }
    
    // No selections, use original color
    return getOriginalColor(d);
  }

  /** Same stroke color as .mapPath — boats use this so fill always matches the track */
  function standardTrackStrokeColor(firstPoint: MapTrackPoint | undefined, eventId: number): string {
    const selected = selectedEvents();
    const hasSel = selected.length > 0;
    const hasMoreThan8Selections = selected.length > 8;
    const isColoredBySource = color() === 'SOURCE';
    const isSelected = hasSel && isEventSelected(eventId);
    if (!hasSel) return getColor(firstPoint);
    if (isColoredBySource) return getOriginalColor(firstPoint);
    if (hasMoreThan8Selections) return getOriginalColor(firstPoint);
    return isSelected ? getColor(firstPoint) : "lightgrey";
  }

  function DrawMap(maneuvers: MapTrackPoint[][]) {
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

    if (!g) {
      logError('🗺️ Map.jsx: DrawMap - G element is missing');
      return;
    }
    const plotG = g;

    // Clear all pending boat fade timeouts when starting a new draw
    boatFadeTimeouts.forEach(timeout => clearTimeout(timeout));
    boatFadeTimeouts = [];
    
    d3MapPane().select("svg").selectAll(".line").remove()
    d3MapPane().select("svg").selectAll(".solid_line").remove()
    d3MapPane().select("svg").selectAll(".map_dash_line").remove()
    d3MapPane().select("svg").selectAll(".mapPath").remove()
    d3MapPane().select("svg").selectAll(".boat").interrupt().remove()
    d3MapPane().select("svg").selectAll(".boat-circle").interrupt().remove()
    d3MapPane().select("svg").selectAll(".hover-circle").remove()

    const click = function (event: MouseEvent, d: MapTrackPoint) {
      if (!d) return;

      const id = d.event_id ?? (d.eventId as number | undefined);
      if (id == null) return;

      event.stopPropagation();

      let newSelectedEvents: number[] = [];
      setSelectedEvents((prev) => {
        newSelectedEvents = prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id];
        return newSelectedEvents;
      });

      setTriggerSelection(true);

      if (newSelectedEvents.length > 0) {
        setHasSelection(true);
      } else {
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
    const mouseover = (event: MouseEvent, d: MapTrackPoint) => {
      const tooltipContent = getTooltipContent(d); 

      setTooltip({
        visible: true,
        content: tooltipContent,
        x: event.pageX - TOOLTIP_LEFT_OFFSET_PX,
        y: event.pageY - 100
      });
    };

    const mousemove = (event: MouseEvent, d: MapTrackPoint) => {
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

    const getTooltipContent = (point: MapTrackPoint | undefined) => {
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
      if (point.time !== undefined && point.time !== null && String(point.time) !== '') {
        tooltipRows += `
              <tr><td>TIME:</td><td>${point.time}</td></tr>`;
      }
      
      tooltipRows += `
              <tr><td>TWA:</td><td>${point.twa ?? ''}</td></tr>
              <tr><td>VMG_PERCENT:</td><td>${point.vmg_perc_avg ?? ''}</td></tr>`;
      
      return `<table class='table-striped'>${tooltipRows}</table>`;  
    };

    maneuverPathsData = [];
    let boatdataArray: [MapTrackPoint, MapTrackPoint][] = [];

    if (maneuvers != undefined) {
      const maneuverPaths: ManeuverPathRecord[] = [];

      maneuvers.forEach(function (maneuver: MapTrackPoint[]) {
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
      const selectedPaths: ManeuverPathRecord[] = [];
      const nonSelectedPaths: ManeuverPathRecord[] = [];

      maneuverPaths.forEach((maneuver) => {
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
      const pathsSelection = plotG
        .selectAll(".mapPath")
        .data(orderedPaths, (d: unknown) => (d as ManeuverPathRecord).eventId);

      pathsSelection
        .enter()
        .append("path")
        .attr("class", (d: ManeuverPathRecord) => `mapPath ${getClass(d.firstPoint)}`)
        .attr("data-event-id", (d: ManeuverPathRecord) => d.eventId) // Store eventId as attribute for lookup
        .merge(pathsSelection as unknown as d3.Selection<SVGPathElement, ManeuverPathRecord, SVGGElement, unknown>)
        .attr("data-event-id", (d: ManeuverPathRecord) => d.eventId) // Ensure update selection also has the attribute
        .style("stroke", (d: ManeuverPathRecord) => standardTrackStrokeColor(d.firstPoint, d.eventId))
        .style("stroke-width", (d: ManeuverPathRecord) => {
          if (!hasSelection) return 1;
          const isSelected = isEventSelected(d.eventId);
          return isSelected ? 3 : 0.5;
        })
        .style("stroke-opacity", (d: ManeuverPathRecord) => {
          if (!hasSelection) return 1;
          const isSelected = isEventSelected(d.eventId);
          return isSelected ? 1 : 0.3;
        })
        .style("stroke-linecap", "round")
        .style("fill", "none")
        .style("pointer-events", "none") // Disable pointer events on path, circles will handle it
        .attr("d", (d: ManeuverPathRecord) => {
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
        const parent = plotG.node();
        if (parent) {
          // Collect all path nodes with their selection status
          const pathNodes: { node: Element; isSelected: boolean }[] = [];
          pathsSelection.each(function (d: unknown) {
            const rec = d as ManeuverPathRecord;
            const node = this as SVGPathElement;
            const isSelected = isEventSelected(rec.eventId);
            pathNodes.push({ node, isSelected });
          });

          // Separate selected and non-selected
          const nonSelected = pathNodes.filter((p) => !p.isSelected);
          const selected = pathNodes.filter((p) => p.isSelected);

          // Reorder: non-selected first, then selected (selected will render on top)
          [...nonSelected, ...selected].forEach(({ node }) => {
            parent.appendChild(node);
          });
        }
      }

      // Store path data for updates
      maneuverPathsData = orderedPaths;

      // Remove any existing outlines (we don't want outlines)
      plotG.selectAll(".mapPath-outline").remove();

      // Add invisible circles for hover detection and tooltips
      orderedPaths.forEach((maneuver) => {
        const hoverCircles = plotG.selectAll(`.hover-circle-${maneuver.eventId}`).data(maneuver.points);

        hoverCircles
          .enter()
          .append("circle")
          .attr("class", `hover-circle hover-circle-${maneuver.eventId}`)
          .merge(hoverCircles as unknown as d3.Selection<SVGCircleElement, MapTrackPoint, SVGGElement, unknown>)
          .attr("cx", (d: MapTrackPoint) => {
            if (!d || !d.LatLng || !map) return 0;
            const point = applyLatLngToLayer(d.LatLng);
            return isNaN(point.x) ? 0 : point.x;
          })
          .attr("cy", (d: MapTrackPoint) => {
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
        if (!map) return;
        zoom_level = map.getZoom();

        // Verify g still exists and is in DOM before drawing
        const currentGNode = g && g.node ? g.node() : null;

        if (!g || !currentGNode) {
          logError('🗺️ Map.jsx: doUpdates - G element is missing!');
          return;
        }

        const layer = g;
        const hasSelection = selectedEvents().length > 0;

        // Collect paths and reorder them so selected paths render on top
        const pathNodes: { node: Element; isSelected: boolean; eventId: number }[] = [];

        layer.selectAll(".mapPath").each(function (d: unknown) {
          const node = this as SVGPathElement;

          let maneuver: ManeuverPathRecord | undefined = d as ManeuverPathRecord | undefined;
          if (!maneuver || !maneuver.points) {
            const eventIdAttr = d3.select(node).attr("data-event-id");
            if (eventIdAttr && maneuverPathsData.length > 0) {
              maneuver = maneuverPathsData.find((m) => String(m.eventId) === eventIdAttr);
            }
          }

          if (!maneuver || !maneuver.points) return;

          const eventId = maneuver.eventId;
          const isSelected = hasSelection && isEventSelected(eventId);
          const firstPoint = maneuver.firstPoint;

          if (!firstPoint) return;

          const pathString = toMapLinePath(maneuver.points);
          if (pathString && pathString !== 'M0,0' && !pathString.includes("NaN")) {
            d3.select(node).attr("d", pathString);
          }

          const hasMoreThan8Selections = selectedEvents().length > 8;
          const isColoredBySource = color() === 'SOURCE';
          node.style.setProperty("stroke", standardTrackStrokeColor(firstPoint, eventId), "important");
          if (isColoredBySource) {
            node.style.setProperty("stroke-width", isSelected ? "3" : (hasSelection ? "0.5" : "1"), "important");
            node.style.setProperty("stroke-opacity", isSelected ? "1" : (hasSelection ? "0.2" : "1"), "important");
          } else if (hasMoreThan8Selections) {
            node.style.setProperty("stroke-width", isSelected ? "3" : "0.5", "important");
            node.style.setProperty("stroke-opacity", isSelected ? "1" : "0.2", "important");
          } else {
            node.style.setProperty("stroke-width", isSelected ? "3" : (hasSelection ? "0.5" : "1"), "important");
            node.style.setProperty("stroke-opacity", isSelected ? "1" : (hasSelection ? "0.2" : "1"), "important");
          }

          pathNodes.push({ node, isSelected, eventId });
        });

        if (hasSelection && pathNodes.length > 0) {
          const parent = layer.node();
          if (parent) {
            const nonSelected = pathNodes.filter((p) => !p.isSelected);
            const selected = pathNodes.filter((p) => p.isSelected);

            [...nonSelected, ...selected].forEach(({ node }) => {
              parent.appendChild(node);
            });
          }
        }

        //DRAW BOATS
        layer.selectAll(".boat").interrupt().remove();
        layer.selectAll(".boat-circle").interrupt().remove();

        boatdataArray.forEach(function (boatData) {
          if (!boatData || boatData.length < 2) return;

          const d = boatData[1];
          if (!d || !d.LatLng || !map) return;

          const testPoint = applyLatLngToLayer(d.LatLng);
          if (isNaN(testPoint.x) || isNaN(testPoint.y)) return;

          const boatEventId = d.event_id;
          const isBoatSelected = hasSelection && boatEventId != null && isEventSelected(boatEventId);
          const maneuverForBoat =
            boatEventId != null
              ? maneuverPathsData.find((m) => m.eventId === boatEventId)
              : undefined;
          const trackFirstPoint = maneuverForBoat?.firstPoint ?? d;
          const trackColor = standardTrackStrokeColor(trackFirstPoint, boatEventId ?? 0);

          const x = applyLatLngToLayer(d.LatLng).x;
          const y = applyLatLngToLayer(d.LatLng).y;

          const sanitizedTime = sanitizeTimeForId(d.time);
          const sanitizedEventId = String(d.event_id || '0').replace(/[^a-zA-Z0-9_-]/g, '_');
          let boatId = `boat-${sanitizedEventId}-${sanitizedTime}`;

          boatId = boatId
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');

          if (/^[0-9_-]/.test(boatId)) {
            boatId = 'b' + boatId;
          }

          const existingBoat = layer.select(`#${escapeSelectorId(boatId)}`);

          let boat: d3.Selection<SVGPathElement, MapTrackPoint, SVGGElement, unknown>;
          if (existingBoat.empty()) {
            const currentPhase = phase();

            boat = layer
              .append("path")
              .datum(d)
              .attr("id", boatId)
              .attr("class", "boat")
              .attr("data-phase", currentPhase)
              .attr("data-fade-started", "false")
              .style("stroke", "black")
              .style("fill", trackColor)
              .style("opacity", hasSelection ? (isBoatSelected ? 1 : 0.2) : 1)
              .style("pointer-events", "visiblePainted")
              .on("mouseover", mouseover)
              .on("mouseout", mouseout)
              .on("mousemove", mousemove)
              .on("click", click);

            const hdg = Number(d.hdg ?? 0) - 180;

            const boatPath = getBoatPathForZoom(zoom_level);
            boat.attr("d", boatPath);
            boat.attr("transform", "translate(" + x + "," + y + ") rotate(" + hdg + ")");

            const circleId = `boat-circle-${sanitizedEventId}-${sanitizedTime}`;
            layer
              .append("circle")
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
              .on("mouseover", mouseover)
              .on("mouseout", mouseout)
              .on("mousemove", mousemove)
              .on("click", click);

            const timeoutId = setTimeout(() => {
              const boatNode = boat.node();
              if (!boatNode || !boatNode.parentNode) return;

              const boatPhase = boat.attr("data-phase");
              const currentPhaseNow = phase();
              if (boatPhase !== currentPhaseNow) {
                d3.select(boatNode).remove();
                const circleNode = layer.select(`#${escapeSelectorId(circleId)}`).node();
                if (circleNode) d3.select(circleNode).remove();
                return;
              }

              const fadeStarted = boat.attr("data-fade-started") === "true";
              if (fadeStarted) return;

              boat.attr("data-fade-started", "true");

              boat
                .interrupt()
                .transition()
                .duration(1000)
                .style("opacity", 0)
                .on("end", function (this: SVGPathElement) {
                  const boatPhaseEnd = d3.select(this).attr("data-phase");
                  const currentPhaseEnd = phase();
                  if (boatPhaseEnd !== currentPhaseEnd) {
                    d3.select(this).remove();
                    const circleNode = layer.select(`#${escapeSelectorId(circleId)}`).node();
                    if (circleNode) d3.select(circleNode).remove();
                    return;
                  }

                  const endedBoatNode = this;
                  if (endedBoatNode && endedBoatNode.parentNode) {
                    d3.select(endedBoatNode).remove();
                  }

                  const circleNode = layer.select(`#${escapeSelectorId(circleId)}`).node();
                  if (circleNode instanceof Element && circleNode.parentNode) {
                    const circlePhase = d3.select(circleNode).attr("data-phase");
                    const currentPhaseCircle = phase();
                    if (circlePhase !== currentPhaseCircle) {
                      d3.select(circleNode).remove();
                      return;
                    }

                    d3.select(circleNode)
                      .interrupt()
                      .transition()
                      .duration(500)
                      .style("opacity", hasSelection ? (isBoatSelected ? 1 : 0.2) : 1);
                  }
                });
            }, 2000);

            boatFadeTimeouts.push(timeoutId);
          } else {
            existingBoat.each(function () {
              const existingBoatSel = d3.select(this);
              const hdg = Number(d.hdg ?? 0) - 180;
              const boatPath = getBoatPathForZoom(zoom_level);
              existingBoatSel.attr("d", boatPath);
              existingBoatSel.attr("transform", "translate(" + x + "," + y + ") rotate(" + hdg + ")");
              existingBoatSel.style("fill", trackColor);
            });

            const circleSanitizedTime = sanitizeTimeForId(d.time);
            const circleSanitizedEventId = String(d.event_id || '0').replace(/[^a-zA-Z0-9_-]/g, '_');
            let circleId = `boat-circle-${circleSanitizedEventId}-${circleSanitizedTime}`;

            circleId = circleId
              .replace(/[^a-zA-Z0-9_-]/g, '_')
              .replace(/-+/g, '-')
              .replace(/^-+|-+$/g, '');

            if (/^[0-9_-]/.test(circleId)) {
              circleId = 'b' + circleId;
            }

            const existingCircle = layer.select(`#${escapeSelectorId(circleId)}`);

            if (existingCircle.empty()) {
              layer
                .append("circle")
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
              existingCircle.attr("cx", x).attr("cy", y).style("fill", trackColor);
            }
          }
        });

        layer.selectAll(".hover-circle").each(function (d: unknown) {
          const pt = d as MapTrackPoint;
          if (pt && pt.LatLng && map) {
            const point = applyLatLngToLayer(pt.LatLng);
            if (!isNaN(point.x) && !isNaN(point.y)) {
              d3.select(this as SVGCircleElement).attr("cx", point.x).attr("cy", point.y);
            }
          }
        });

        layer.selectAll(".boat-circle").each(function (d: unknown) {
          const pt = d as MapTrackPoint;
          if (pt && pt.LatLng && map) {
            const point = applyLatLngToLayer(pt.LatLng);
            if (!isNaN(point.x) && !isNaN(point.y)) {
              d3.select(this as SVGCircleElement).attr("cx", point.x).attr("cy", point.y);
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

    const ug = g;
    const hasSelection = selectedEvents().length > 0;

    // Collect paths for reordering
    const pathNodes: { node: Element; isSelected: boolean; eventId: number }[] = [];

    ug.selectAll(".mapPath").each(function (d: unknown) {
      if (!d) return;

      const node = this as SVGPathElement;
      const maneuver = d as ManeuverPathRecord;
      const eventId = maneuver.eventId;
      const isSelected = hasSelection && isEventSelected(eventId);
      const firstPoint = maneuver.firstPoint;

      if (!firstPoint) return;

      const selected = selectedEvents();
      const hasMoreThan8Selections = selected.length > 8;
      const isColoredBySource = color() === 'SOURCE';
      node.style.setProperty("stroke", standardTrackStrokeColor(firstPoint, eventId), "important");
      if (isColoredBySource) {
        node.style.setProperty("stroke-width", isSelected ? "3" : (hasSelection ? "0.5" : "1"), "important");
        node.style.setProperty("stroke-opacity", isSelected ? "1" : (hasSelection ? "0.2" : "1"), "important");
      } else if (hasMoreThan8Selections) {
        node.style.setProperty("stroke-width", isSelected ? "3" : "0.5", "important");
        node.style.setProperty("stroke-opacity", isSelected ? "1" : "0.2", "important");
      } else {
        node.style.setProperty("stroke-width", isSelected ? "3" : (hasSelection ? "0.5" : "1"), "important");
        node.style.setProperty("stroke-opacity", isSelected ? "1" : (hasSelection ? "0.2" : "1"), "important");
      }

      const outline = node.parentNode?.querySelector(`.mapPath-outline[data-event-id="${eventId}"]`);
      if (outline) {
        d3.select(outline as Element).remove();
      }

      pathNodes.push({ node, isSelected, eventId });
    });
    
    // Reorder paths in DOM so selected paths render on top
    // In SVG, elements that appear later in DOM are rendered on top
    if (hasSelection && pathNodes.length > 0) {
      const parent = ug.node();
      if (parent) {
        const nonSelected = pathNodes.filter((p) => !p.isSelected);
        const selected = pathNodes.filter((p) => p.isSelected);

        [...nonSelected, ...selected].forEach(({ node }) => {
          parent.appendChild(node);
        });
      }
    }

    ug.selectAll(".boat").each(function (d: unknown) {
      const pt = d as MapTrackPoint;
      if (!pt || !pt.event_id) return;
      const boatEventId = pt.event_id;
      const isBoatSelected = hasSelection && boatEventId && isEventSelected(boatEventId);
      const fp = maneuverPathsData.find((m) => m.eventId === boatEventId)?.firstPoint ?? pt;
      const tc = standardTrackStrokeColor(fp, boatEventId);
      d3.select(this)
        .style("fill", tc)
        .style("opacity", hasSelection ? (isBoatSelected ? 1 : 0.2) : 1);
    });

    ug.selectAll(".boat-circle").each(function (d: unknown) {
      const pt = d as MapTrackPoint;
      if (!pt || !pt.event_id) return;
      const boatEventId = pt.event_id;
      const isBoatSelected = hasSelection && boatEventId && isEventSelected(boatEventId);
      const fp = maneuverPathsData.find((m) => m.eventId === boatEventId)?.firstPoint ?? pt;
      const tc = standardTrackStrokeColor(fp, boatEventId);
      d3.select(this)
        .style("fill", tc)
        .style("opacity", hasSelection ? (isBoatSelected ? 1 : 0.2) : 1);
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

  function getClass(d: MapTrackPoint) {
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

  let containerRef: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;

  function resizeChart() {
    if (!map) return;
    reinitMap();
    map.invalidateSize();
    drawFeatures();
    // Do not call updateMap() here — ResizeObserver/layout after a draw would refetch in a loop.
    if (updateInProgress) return;
    const cached = mapdata();
    if (cached && cached.length > 0) {
      untrack(() => {
        DrawMap(cached);
        updateSelection();
      });
    }
  }

  /** Clears triggerUpdate, syncs filtered hash tracking, queues updateMap — shared by trigger effect and post-fetch retry. */
  let consumeTriggerAndQueueUpdateMap: (() => void) | undefined;

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
      d3MapPane().select("svg").selectAll(".boat").interrupt().remove();
      d3MapPane().select("svg").selectAll(".boat-circle").interrupt().remove();
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
      if (props.instanceId) {
        setLoading(false);
      } else {
        setTimeout(() => {
          if (!map) return;
          setLoading(false);
        }, 500);
      }
      if (triggerUpdate()) {
        consumeTriggerAndQueueUpdateMap?.();
      }
    }).catch((error) => {
      if (map) {
        logError('🗺️ Map.jsx: Error in updateMap fetchData', error);
        setLoading(false);
      }
      updateInProgress = false;
      if (triggerUpdate()) {
        consumeTriggerAndQueueUpdateMap?.();
      }
    });
  };

  // Use createEffect to ensure DOM is ready before initializing
  createEffect(() => {
    // Only initialize once
    if (mapInitialized()) return;
    
    const maneuverMapElement = document.getElementById(maneuverMapElementId());
    
    if (maneuverMapElement && !map) {
      // DOM is ready, initialize map
      initMap();
      
      // Only call drawFeatures and updateMap if map was successfully initialized
      if (map) {
        setMapInitialized(true);
        // Small delay to ensure Leaflet has fully initialized
        setTimeout(() => {
          drawFeatures();
          // First data fetch is driven by triggerUpdate / filtered createEffects only — avoids duplicate fetchMapData with init + debounced watcher.
        }, 100);
      }
    }
  });

  // Function to perform the GRADE update
  const performGradeUpdate = async (gradeValue: string, selected: number[]) => {
    // Get required values from persistent store
    const { selectedClassName, selectedProjectId } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    
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
    requestAnimationFrame(() => {
      if (mapInitialized() || map) return;
      const el = document.getElementById(maneuverMapElementId());
      if (!el) return;
      initMap();
      if (!map) return;
      setMapInitialized(true);
      drawFeatures();
    });

    resizeObserver = new ResizeObserver((_entries) => {
      resizeChart();
    });

    if (containerRef) {
      resizeObserver.observe(containerRef);
    }

    // Fallback to window resize event
    window.addEventListener('resize', resizeChart);
    
    // Add keyboard listener for GRADE updates (0-5 keys)
    const handleKeyPress = (event: KeyboardEvent) => {
      try {
        // Don't trigger if user is typing in an input field or textarea
        const target = event.target as HTMLElement | null;
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
          performGradeUpdate(String(gradeValue), selected).catch((error) => {
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

  let lastFilteredCount = 0;
  let lastFilteredHash = '';
  let filteredUpdateTimeout: ReturnType<typeof setTimeout> | null = null;

  const getMapFilteredHash = (currentFiltered: unknown): string => {
    if (!Array.isArray(currentFiltered) || currentFiltered.length === 0) return '';
    const nums = currentFiltered
      .map((item: unknown) =>
        typeof item === 'number' ? item : (item as { event_id?: number })?.event_id ?? item
      )
      .filter((id): id is number => typeof id === 'number' && id > 0);
    if (nums.length === 0) return '';
    const sorted = [...nums].sort((a, b) => a - b);
    return `${sorted.length}:${sorted.join(',')}`;
  };

  consumeTriggerAndQueueUpdateMap = () => {
    setTriggerUpdate(false);
    if (filteredUpdateTimeout) {
      clearTimeout(filteredUpdateTimeout);
      filteredUpdateTimeout = null;
    }
    const arr = filtered();
    const n = Array.isArray(arr) ? arr.length : 0;
    if (n > 0) {
      lastFilteredHash = getMapFilteredHash(arr);
      lastFilteredCount = n;
    }
    queueMicrotask(() => {
      if (untrack(() => updateInProgress)) return;
      untrack(() => updateMap());
    });
  };

  createEffect(() => {
    const hasUpdate = triggerUpdate();
    const isReady = untrack(() => mapInitialized() && map);
    const inProgress = untrack(() => updateInProgress);

    if (!hasUpdate || !isReady) return;
    if (inProgress) {
      return;
    }
    consumeTriggerAndQueueUpdateMap();
  });

  // Watch for filtered data changes - update map when data becomes available and map is ready
  // This serves as a backup in case triggerUpdate doesn't fire or gets cleared
  // Use debouncing to handle rapid re-renders during initial load
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
    
    const filteredHash = getMapFilteredHash(currentFiltered);
    
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
        const currentHash = getMapFilteredHash(filtered());
        
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
    void selectedEvents();
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

  // Only react to color() — not mapdata (every fetch would re-run and log "Color changed" while scales already refresh in fetchData/DrawMap).
  createEffect(
    on(
      color,
      () => {
        const isReady = untrack(() => mapInitialized() && map && svg && g);
        if (isReady && untrack(() => mapdata().length > 0)) {
          debug('Map: Color changed, rebuilding color scale and updating selection');
          untrack(() => {
            InitScales();
            updateSelection();
          });
        }
      },
      { defer: true }
    )
  );

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
      d3MapPane().select("svg").selectAll("*").remove();
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
      resizeObserver = undefined;
    }

    // Remove window resize event listener
    window.removeEventListener('resize', resizeChart);
    // Note: keydown listener is cleaned up in onMount return function
    
    // Clear data to free memory
    setMapData([]);
    setColorGroups([]);
    setGroupRepIds(new Set<number>());
    latlngarray = [];
    
    debug('Map: Cleanup complete - all resources cleared');
  });

  return (
    <>
      {firstload() && <Loading />}
      <div ref={(el) => { containerRef = el ?? undefined; }} class="maneuver-map-container" style={{
          "opacity": loading() ? 0.2 : 1, 
          "pointer-events": loading() ? "none" : "auto", 
          "transition": "opacity 0.5s ease",
          "width": "100%",
          "height": "100%",
          "display": "flex",
          "flex-direction": "column",
          "padding-right": "25px",
        }}>
        <div id={maneuverMapElementId()} class="maneuver-map" style={{
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
