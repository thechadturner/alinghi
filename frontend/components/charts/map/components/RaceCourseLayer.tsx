// @ts-nocheck
import { createEffect, onMount, onCleanup, untrack } from "solid-js";
import * as d3 from "d3";
import { selectedTime, isPlaying, liveMode } from "../../../../store/playbackStore";
import { persistantStore } from "../../../../store/persistantStore";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { apiEndpoints } from "../../../../config/env";
import { getData } from "../../../../utils/global";
import { error as logError, debug as logDebug } from "../../../../utils/console";
import { setTooltip } from "../../../../store/globalStore";

export interface RaceCourseLayerProps {
  map: any;
  visible?: boolean; // Control visibility without unmounting
}

interface BoundaryData {
  ID: string;
  DATETIME: string;
  TYPE?: string;
  LENGTH?: string;
  AXIS?: string;
  BOUNDARIES: Array<{
    LAT: string;
    LON: string;
  }>;
}

interface MarkData {
  DATETIME: string;
  MARKS: Array<{
    POSITION: string;
    NAME: string;
    LAT: string;
    LON: string;
    TWS?: string;
    TWD?: string;
  }>;
}

export default function RaceCourseLayer(props: RaceCourseLayerProps) {
  
  let svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, any> | null = null;
  let raceCourseOverlay: d3.Selection<SVGGElement, unknown, HTMLElement, any> | null = null;
  let overlayContainer: HTMLElement | null = null;
  let isDrawing = false;
  let boundaryData: BoundaryData[] = [];
  let marksData: MarkData[] = [];
  let isMarkwind = false;
  let abortController: AbortController | null = null;
  let currentBoundary: BoundaryData | null = null;
  let currentMarks: MarkData | null = null;
  let lastUpdateTime: number = 0;
  let isInitialRender: boolean = true;
  let lastSelectedTime: Date | null = null;
  let lastBoundaryMinute: number | null = null; // Track last minute used for boundary update in live mode
  const UPDATE_INTERVAL_MS = 2000; // Update every 2 seconds during animation
  const LIVE_MODE_BOUNDARY_UPDATE_INTERVAL_MS = 60000; // Update boundaries once per minute in live mode
  let mapEventListenersCleanup: (() => void) | null = null;
  let isDataLoaded: boolean = false; // Track when data has been loaded
  let renderThrottleTimer: number | null = null;
  const RENDER_THROTTLE_MS = 100; // Throttle render calls to max once per 100ms
  let activeTimeouts: Set<ReturnType<typeof setTimeout>> = new Set(); // Track all active timeouts for cleanup
  let isMounted = true; // Track if component is still mounted
  let lastEffectiveDateStr: string | null = null; // Track date used for boundaries so we refetch when it changes

  // Persistent mark tracking by name - keeps marks visible even when data is missing
  let persistentMarks: Map<string, {
    name: string;
    x: number;
    y: number;
    lat: number;
    lon: number;
    tws: number | null;
    twd: number | null;
    hasWindData: boolean;
  }> = new Map();

  // Project lat/lng to pixel coordinates
  // Use mapboxgl.LngLat for proper coordinate handling (like the old code)
  const project = (lng: number, lat: number): [number, number] => {
    if (!props.map) return [0, 0];
    try {
      // Use map.project() directly - it returns screen pixel coordinates
      const point = props.map.project([lng, lat]);
      if (!point || isNaN(point.x) || isNaN(point.y)) {
        return [0, 0];
      }
      return [point.x, point.y];
    } catch (e) {
      logError('RaceCourseLayer: Projection error', e);
      return [0, 0];
    }
  };

  // Binary search to find nearest entry by datetime
  const findNearestByTime = <T extends { DATETIME?: string; Datetime?: string; datetime?: string }>(
    data: T[],
    targetTime: Date
  ): T | null => {
    if (!data || data.length === 0) {
      return null;
    }

    const targetTimestamp = targetTime.getTime();
    if (isNaN(targetTimestamp)) {
      return null;
    }

    // Detect datetime field from first valid record (not just index 0)
    const datetimeField = (() => {
      for (const item of data) {
        if (item && (item as any).DATETIME != null) return 'DATETIME';
        if (item && (item as any).Datetime != null) return 'Datetime';
        if (item && (item as any).datetime != null) return 'datetime';
      }
      return null;
    })();
    
    // If no datetime field exists, keep layer stable by falling back to the latest entry
    // instead of returning null (which clears boundaries/marks until a toggle/remount).
    if (!datetimeField) {
      return data[data.length - 1] || null;
    }

    // Keep only records with valid timestamps, then sort by time
    const sortedData = data
      .filter((item) => {
        const ts = new Date((item as any)[datetimeField]).getTime();
        return Number.isFinite(ts);
      })
      .sort((a, b) => {
        const timeA = new Date((a as any)[datetimeField]).getTime();
        const timeB = new Date((b as any)[datetimeField]).getTime();
        return timeA - timeB;
      });

    if (sortedData.length === 0) {
      return data[data.length - 1] || null;
    }

    // First, try to find the last available boundary at or before the target time
    // This is important for live mode where current time may be beyond all boundaries
    let lastAvailableBefore: T | null = null;
    let lastAvailableTime = -Infinity;

    for (let i = sortedData.length - 1; i >= 0; i--) {
      const item = sortedData[i];
      const itemTime = new Date((item as any)[datetimeField]).getTime();
      
      if (isNaN(itemTime)) {
        continue;
      }

      // Exact match
      if (itemTime === targetTimestamp) {
        return item;
      }

      // If this boundary is at or before target time, it's a candidate
      if (itemTime <= targetTimestamp && itemTime > lastAvailableTime) {
        lastAvailableBefore = item;
        lastAvailableTime = itemTime;
      }
    }

    // If we found a boundary at or before the target time, use it
    if (lastAvailableBefore) {
      return lastAvailableBefore;
    }

    // If no boundary exists at or before target time, use the last available boundary
    // This ensures we always show something in live mode when current time is beyond all boundaries
    if (sortedData.length > 0) {
      const lastItem = sortedData[sortedData.length - 1];
      const lastTime = new Date((lastItem as any)[datetimeField]).getTime();
      if (!isNaN(lastTime)) {
        return lastItem;
      }
    }

    // Fallback: find closest by absolute difference (original behavior)
    let closest: T | null = null;
    let minDiff = Infinity;

    for (const item of sortedData) {
      const itemTime = new Date((item as any)[datetimeField]).getTime();
      if (isNaN(itemTime)) {
        continue;
      }

      const diff = Math.abs(itemTime - targetTimestamp);
      if (diff < minDiff) {
        minDiff = diff;
        closest = item;
      }
    }

    return closest;
  };

  // Round time to nearest minute for boundary lookup
  const roundToNearestMinute = (date: Date): Date => {
    const rounded = new Date(date);
    rounded.setSeconds(0, 0);
    return rounded;
  };

  // Helper function to format date as YYYY-MM-DD
  const formatDateForAPI = (date: string | number | null | undefined): string | null => {
    if (!date) {
      return null;
    }
    
    const dateStr = String(date);
    // If already in YYYY-MM-DD format, return as is
    if (dateStr.includes('-')) {
      return dateStr;
    }
    
    // If in YYYYMMDD format, convert to YYYY-MM-DD
    if (dateStr.length === 8) {
      return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    }
    
    return null;
  };

  // Helper function to get date for a dataset_id
  const getDateForDataset = async (datasetId: number): Promise<string | null> => {
    if (!datasetId || datasetId <= 0) {
      return null;
    }

    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();

    if (!className || !projectId) {
      return null;
    }

    try {
      const url = `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`;
      
      abortController = new AbortController();
      const response = await getData(url, abortController.signal);

      // Check if request was aborted (handled gracefully)
      if (response?.type === 'AbortError') {
        return null;
      }

      if (response.success && response.data?.date) {
        let dateStr = response.data.date;
        // If date is in YYYYMMDD format, convert to YYYY-MM-DD
        if (dateStr.length === 8 && !dateStr.includes('-')) {
          dateStr = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
        }
        return dateStr;
      }
      return null;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return null;
      }
      logError('RaceCourseLayer: Error fetching date for dataset:', err);
      return null;
    }
  };

  // Helper function to get the date to use (prioritize dataset_id, then selectedDate, then today's date)
  const getDateToUse = async (): Promise<string | null> => {
    const datasetId = persistantStore.selectedDatasetId();
    
    // First priority: if selectedDatasetId > 0, get date from dataset
    if (datasetId && datasetId > 0) {
      const dateFromDataset = await getDateForDataset(datasetId);
      if (dateFromDataset) {
        return dateFromDataset;
      }
    }

    // Second priority: use selectedDate if it exists
    const selectedDate = persistantStore.selectedDate();
    if (selectedDate) {
      return formatDateForAPI(selectedDate);
    }

    // Third priority: use today's date as fallback (for live mode when no date is set)
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Fetch boundary data
  const fetchBoundaryData = async (): Promise<BoundaryData[]> => {
    if (!isMounted) return []; // Don't fetch if unmounted
    
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();

    if (!className || !projectId) {
      return [];
    }

    // Get date to use (prioritize dataset_id, then selectedDate)
    const dateStr = await getDateToUse();
    if (!dateStr || !isMounted) {
      return [];
    }

    try {
      // Check cache first
      // NOTE: Using "boundary" (singular) for cache key to match existing cache
      const cacheKey = `boundary_${className}_${dateStr}`;
      const cached = await unifiedDataStore.getObject(className, cacheKey);
      if (cached) {
        // Validate cached data structure
        if (Array.isArray(cached) && cached.length > 0 && cached[0] && typeof cached[0] === 'object' && !Array.isArray(cached[0])) {
          // Valid cached data
          return cached;
        } else {
          // Corrupted cache, clear it and fetch fresh
          await unifiedDataStore.storeObject(className, cacheKey, null);
        }
      }

      // Fetch from API using projects endpoint
      // NOTE: object_name is "boundaries" (plural) as stored by the Python script
      const url = `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateStr)}&object_name=boundaries`;
      
      abortController = new AbortController();
      const response = await getData(url, abortController.signal);

      // Check if request was aborted (handled gracefully)
      if (response?.type === 'AbortError') {
        return [];
      }

      // Check if response has data - an empty object {} should be treated as no data
      const hasValidData = response.success && response.data && 
                          (Object.keys(response.data).length > 0 || Array.isArray(response.data));
      
      if (hasValidData) {
        // Parse the JSON data (response.data should be the JSON value from the database)
        let data: BoundaryData[] = [];
        
        // The API returns { value: <json> } where value is the JSONB column
        if ((response.data as any)?.value) {
          const jsonValue = (response.data as any).value;
          if (Array.isArray(jsonValue)) {
            data = jsonValue;
          } else if (typeof jsonValue === 'string') {
            try {
              data = JSON.parse(jsonValue);
            } catch (e) {
              logError('RaceCourseLayer: fetchBoundaryData - JSON parse error', e);
              data = [];
            }
          } else {
            // If value is an object, it might already be parsed
            data = Array.isArray(jsonValue) ? jsonValue : [jsonValue];
          }
        } else if (Array.isArray(response.data)) {
          data = response.data;
        } else if (typeof response.data === 'string') {
          try {
            data = JSON.parse(response.data);
          } catch (e) {
            logError('RaceCourseLayer: fetchBoundaryData - JSON parse error', e);
            data = [];
          }
        } else {
          data = [];
        }

        // Cache the data
        await unifiedDataStore.storeObject(className, cacheKey, data);
        
        return data;
      } else {
        return [];
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return [];
      }
      logError('RaceCourseLayer: Error fetching boundary data:', err);
      return [];
    }
  };

  // Fetch marks data (prefer markwind if exists)
  const fetchMarksData = async (): Promise<{ data: MarkData[]; isMarkwind: boolean }> => {
    if (!isMounted) return { data: [], isMarkwind: false }; // Don't fetch if unmounted
    
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();

    if (!className || !projectId) {
      return { data: [], isMarkwind: false };
    }

    // Get date to use (prioritize dataset_id, then selectedDate)
    const dateStr = await getDateToUse();
    if (!dateStr || !isMounted) {
      return { data: [], isMarkwind: false };
    }

    try {
      // Try markwind first
      const markwindCacheKey = `markwind_${className}_${dateStr}`;
      let cached = await unifiedDataStore.getObject(className, markwindCacheKey);
      
      if (cached) {
        // Validate cached data structure
        if (Array.isArray(cached) && cached.length > 0 && cached[0] && typeof cached[0] === 'object' && !Array.isArray(cached[0])) {
          // Valid cached data
          return { data: cached, isMarkwind: true };
        } else {
          // Corrupted cache, clear it and fetch fresh
          await unifiedDataStore.storeObject(className, markwindCacheKey, null);
        }
      }

      const markwindUrl = `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateStr)}&object_name=markwind`;
      
      abortController = new AbortController();
      let response = await getData(markwindUrl, abortController.signal);

      // Check if request was aborted (handled gracefully)
      if (response?.type === 'AbortError') {
        return { data: [], isMarkwind: false };
      }

      if (response.success && response.data) {
        let data: MarkData[] = [];
        
        // The API returns { value: <json> } where value is the JSONB column
        if ((response.data as any)?.value) {
          const jsonValue = (response.data as any).value;
          if (Array.isArray(jsonValue)) {
            data = jsonValue;
          } else if (typeof jsonValue === 'string') {
            data = JSON.parse(jsonValue);
          } else {
            data = Array.isArray(jsonValue) ? jsonValue : [jsonValue];
          }
        } else if (Array.isArray(response.data)) {
          data = response.data;
        } else if (typeof response.data === 'string') {
          data = JSON.parse(response.data);
        } else {
          data = [];
        }

        await unifiedDataStore.storeObject(className, markwindCacheKey, data);
        return { data, isMarkwind: true };
      }

      // Fallback to marks
      const marksCacheKey = `marks_${className}_${dateStr}`;
      cached = await unifiedDataStore.getObject(className, marksCacheKey);
      
      if (cached) {
        // Validate cached data structure
        if (Array.isArray(cached) && cached.length > 0 && cached[0] && typeof cached[0] === 'object' && !Array.isArray(cached[0])) {
          // Valid cached data
          return { data: cached, isMarkwind: false };
        } else {
          // Corrupted cache, clear it and fetch fresh
          await unifiedDataStore.storeObject(className, marksCacheKey, null);
        }
      }

      const marksUrl = `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateStr)}&object_name=marks`;
      
      abortController = new AbortController();
      response = await getData(marksUrl, abortController.signal);

      // Check if request was aborted (handled gracefully)
      if (response?.type === 'AbortError') {
        return { data: [], isMarkwind: false };
      }

      if (response.success && response.data) {
        let data: MarkData[] = [];
        
        // The API returns { value: <json> } where value is the JSONB column
        if ((response.data as any)?.value) {
          const jsonValue = (response.data as any).value;
          if (Array.isArray(jsonValue)) {
            data = jsonValue;
          } else if (typeof jsonValue === 'string') {
            data = JSON.parse(jsonValue);
          } else {
            data = Array.isArray(jsonValue) ? jsonValue : [jsonValue];
          }
        } else if (Array.isArray(response.data)) {
          data = response.data;
        } else if (typeof response.data === 'string') {
          data = JSON.parse(response.data);
        } else {
          data = [];
        }

        await unifiedDataStore.storeObject(className, marksCacheKey, data);
        return { data, isMarkwind: false };
      }

      return { data: [], isMarkwind: false };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { data: [], isMarkwind: false };
      }
      logError('RaceCourseLayer: Error fetching marks data:', err);
      return { data: [], isMarkwind: false };
    }
  };

  // Create SVG overlay
  const createOverlay = (retryCount: number = 0): Promise<void> => {
    const MAX_RETRIES = 50; // Maximum 5 seconds of retries (50 * 100ms)
    
    return new Promise((resolve) => {
      if (!props.map) {
        resolve();
        return;
      }

      // Wait for map to be fully loaded (not just style loaded)
      if (!props.map.loaded()) {
        const loadHandler = () => {
          if (!isMounted) {
            resolve();
            return;
          }
          // Add a small delay to ensure container dimensions are calculated
          const timeoutId = setTimeout(() => {
            activeTimeouts.delete(timeoutId);
            if (!isMounted) {
              resolve();
              return;
            }
            createOverlay(0).then(resolve);
          }, 50);
          activeTimeouts.add(timeoutId);
        };
        props.map.once('load', loadHandler);
        return;
      }

      // Also check if style is loaded
      if (!props.map.isStyleLoaded()) {
        props.map.once('styledata', () => {
          createOverlay(0).then(resolve);
        });
        return;
      }

      // Remove existing overlay only within this map instance
      const existingContainer = overlayContainer || props.map.getCanvasContainer?.();
      if (existingContainer) {
        d3.select(existingContainer).selectAll(".race-course-overlay").remove();
      }

      // Create SVG overlay - use map.getCanvasContainer() like the old code
      let container: HTMLElement | null = null;
      try {
        container = props.map.getCanvasContainer() as HTMLElement;
      } catch (e) {
        // Fallback handled below
      }
      
      if (!container) {
        try {
          container = props.map.getContainer() as HTMLElement;
        } catch (e) {
          // Keep null and retry below
        }
      }
      
      if (!container) {
        if (retryCount >= MAX_RETRIES) {
          resolve();
          return;
        }
        const timeoutId = setTimeout(() => {
          activeTimeouts.delete(timeoutId);
          if (!isMounted) {
            resolve();
            return;
          }
          createOverlay(retryCount + 1).then(resolve);
        }, 100);
        activeTimeouts.add(timeoutId);
        return;
      }

      // Try multiple methods to get dimensions
      const mapRect = container.getBoundingClientRect();
      const clientWidth = container.clientWidth || mapRect.width;
      const clientHeight = container.clientHeight || mapRect.height;
      
      // Use width/height from getBoundingClientRect, or fallback to clientWidth/clientHeight
      const width = mapRect.width || clientWidth || 0;
      const height = mapRect.height || clientHeight || 0;
      
      // If we have at least a width, proceed (height will be handled by CSS 100%)
      // Only retry if both width and height are 0
      if (width === 0 && height === 0) {
        if (retryCount >= MAX_RETRIES) {
          // Use a default size if dimensions are still 0
          const defaultWidth = 800;
          const defaultHeight = 600;
          
          svg = d3.select(container)
            .append("svg")
            .attr("class", "race-course-overlay")
            .attr("width", defaultWidth)
            .attr("height", defaultHeight)
            .style("position", "absolute")
            .style("top", "0")
            .style("left", "0")
            .style("width", "100%")
            .style("height", "100%")
            .style("pointer-events", "none")
            .style("z-index", "50")
            .style("display", props.visible !== false ? "block" : "none"); // Control visibility

          raceCourseOverlay = svg.append("g").attr("class", "race-course-layer");
          resolve();
          return;
        }
        const timeoutId = setTimeout(() => {
          activeTimeouts.delete(timeoutId);
          if (!isMounted) {
            resolve();
            return;
          }
          createOverlay(retryCount + 1).then(resolve);
        }, 100);
        activeTimeouts.add(timeoutId);
        return;
      }
      
      // Use the actual dimensions we found, or fallback to a reasonable default
      const finalWidth = width || 800;
      const finalHeight = height || 600;

      // Remove existing overlay
      d3.select(container).select(".race-course-overlay").remove();

      overlayContainer = container;
      svg = d3.select(container)
        .append("svg")
        .attr("class", "race-course-overlay")
        .attr("width", finalWidth)
        .attr("height", finalHeight)
        .style("position", "absolute")
        .style("top", "0")
        .style("left", "0")
        .style("width", "100%")
        .style("height", "100%")
        .style("pointer-events", "none")
        .style("z-index", "50")
        .style("display", props.visible !== false ? "block" : "none"); // Control visibility

      raceCourseOverlay = svg.append("g").attr("class", "race-course-layer");

      // Add resize handler
      const resizeHandler = () => {
        const newRect = container.getBoundingClientRect();
        if (svg) {
          svg.attr("width", newRect.width).attr("height", newRect.height);
        }
      };

      window.addEventListener('resize', resizeHandler);
      
      // Store cleanup function
      (window as any).raceCourseLayerResizeHandler = resizeHandler;

      resolve();
    });
  };

  // Check if any racecourse data (boundaries or marks) is in the current viewport
  // Returns false if nothing is in view, allowing us to skip all computation
  // When zoom > 12, uses expanded viewport (2x) to keep showing racecourse when zoomed in
  const isRacecourseInView = (): boolean => {
    // Check visibility prop first
    if (props.visible === false) {
      return false;
    }
    
    // Check if map is available
    if (!props.map) {
      return false;
    }
    
    try {
      const currentZoom = props.map.getZoom();
      const mapBounds = props.map.getBounds();
      const mapSize = props.map.getContainer().getBoundingClientRect();
      
      // When zoom > 12, expand viewport by 2x to keep showing racecourse when zoomed in
      // When zoom <= 12, use normal viewport (only show if actually in view)
      const viewportExpansion = currentZoom > 12 ? 2 : 1;
      const expandedWidth = mapSize.width * viewportExpansion;
      const expandedHeight = mapSize.height * viewportExpansion;
      const offsetX = (expandedWidth - mapSize.width) / 2;
      const offsetY = (expandedHeight - mapSize.height) / 2;
      
      // Get the viewport bounds in screen coordinates (expanded when zoom > 12)
      const viewportBounds = {
        minX: -offsetX,
        maxX: mapSize.width + offsetX,
        minY: -offsetY,
        maxY: mapSize.height + offsetY
      };
      
      // Expand geographic bounds when zoom > 12 (2x expansion)
      let expandedSouth = mapBounds.getSouth();
      let expandedNorth = mapBounds.getNorth();
      let expandedWest = mapBounds.getWest();
      let expandedEast = mapBounds.getEast();
      
      if (currentZoom > 12) {
        const latRange = mapBounds.getNorth() - mapBounds.getSouth();
        const lonRange = mapBounds.getEast() - mapBounds.getWest();
        const latExpansion = latRange * 0.5; // 50% expansion = 2x total area
        const lonExpansion = lonRange * 0.5;
        expandedSouth = mapBounds.getSouth() - latExpansion;
        expandedNorth = mapBounds.getNorth() + latExpansion;
        expandedWest = mapBounds.getWest() - lonExpansion;
        expandedEast = mapBounds.getEast() + lonExpansion;
      }
      
      // Check boundaries - sample points to see if any are in view
      if (boundaryData.length > 0) {
        for (const boundary of boundaryData) {
          if (!boundary.BOUNDARIES || boundary.BOUNDARIES.length === 0) continue;
          
          // Sample boundary points (check up to 20 points per boundary)
          const sampleSize = Math.min(20, boundary.BOUNDARIES.length);
          const step = Math.max(1, Math.floor(boundary.BOUNDARIES.length / sampleSize));
          
          for (let i = 0; i < boundary.BOUNDARIES.length; i += step) {
            const b = boundary.BOUNDARIES[i];
            try {
              const lat = parseFloat(b.LAT);
              const lon = parseFloat(b.LON);
              
              if (isNaN(lat) || isNaN(lon)) continue;
              
              // Check if point is within expanded map bounds (geographic check)
              if (lat >= expandedSouth && lat <= expandedNorth &&
                  lon >= expandedWest && lon <= expandedEast) {
                // Also check screen coordinates
                const [x, y] = project(lon, lat);
                if (!isNaN(x) && !isNaN(y) &&
                    x >= viewportBounds.minX && x <= viewportBounds.maxX &&
                    y >= viewportBounds.minY && y <= viewportBounds.maxY) {
                  return true; // Found at least one boundary point in view
                }
              }
            } catch (e) {
              continue;
            }
          }
        }
      }
      
      // Check marks - check all marks in persistent map
      if (persistentMarks.size > 0) {
        for (const markData of persistentMarks.values()) {
          const [x, y] = project(markData.lon, markData.lat);
          if (!isNaN(x) && !isNaN(y) &&
              x >= viewportBounds.minX && x <= viewportBounds.maxX &&
              y >= viewportBounds.minY && y <= viewportBounds.maxY) {
            return true; // Found at least one mark in view
          }
        }
      }
      
      // Check marks data (if not yet in persistent map)
      if (marksData.length > 0) {
        for (const markEntry of marksData) {
          if (!markEntry.MARKS || markEntry.MARKS.length === 0) continue;
          
          for (const mark of markEntry.MARKS) {
            try {
              const lat = parseFloat(mark.LAT);
              const lon = parseFloat(mark.LON);
              
              if (isNaN(lat) || isNaN(lon)) continue;
              
              // Check if point is within expanded map bounds (geographic check)
              if (lat >= expandedSouth && lat <= expandedNorth &&
                  lon >= expandedWest && lon <= expandedEast) {
                // Also check screen coordinates
                const [x, y] = project(lon, lat);
                if (!isNaN(x) && !isNaN(y) &&
                    x >= viewportBounds.minX && x <= viewportBounds.maxX &&
                    y >= viewportBounds.minY && y <= viewportBounds.maxY) {
                  return true; // Found at least one mark in view
                }
              }
            } catch (e) {
              continue;
            }
          }
        }
      }
      
      return false; // Nothing is in view
    } catch (e) {
      // If we can't determine visibility, assume not in view to skip computation
      return false;
    }
  };

  // Check if boundary is visible based on visibility prop and zoom state
  const isBoundaryVisible = (boundary: BoundaryData | null): boolean => {
    // Check visibility prop first
    if (props.visible === false) {
      return false;
    }
    
    // If no boundary data, consider it not visible
    if (!boundary || !boundary.BOUNDARIES || boundary.BOUNDARIES.length === 0) {
      return false;
    }
    
    // Check if map is available
    if (!props.map) {
      return false;
    }
    
    // Check if boundary is within visible map bounds (zoom state check)
    try {
      const mapBounds = props.map.getBounds();
      const mapSize = props.map.getContainer().getBoundingClientRect();
      
      // Get the actual viewport bounds in screen coordinates
      const viewportBounds = {
        minX: 0,
        maxX: mapSize.width,
        minY: 0,
        maxY: mapSize.height
      };
      
      // Check if any boundary point would be within the visible viewport
      // We do a quick check by converting a few boundary points to screen coordinates
      // If none are visible, skip the computation
      let hasVisiblePoint = false;
      const sampleSize = Math.min(10, boundary.BOUNDARIES.length); // Check up to 10 points as a sample
      const step = Math.max(1, Math.floor(boundary.BOUNDARIES.length / sampleSize));
      
      for (let i = 0; i < boundary.BOUNDARIES.length; i += step) {
        const b = boundary.BOUNDARIES[i];
        try {
          const lat = parseFloat(b.LAT);
          const lon = parseFloat(b.LON);
          
          // Check if point is within map bounds (geographic check)
          if (lat >= mapBounds.getSouth() && lat <= mapBounds.getNorth() &&
              lon >= mapBounds.getWest() && lon <= mapBounds.getEast()) {
            // Also check screen coordinates
            const [x, y] = project(lon, lat);
            if (!isNaN(x) && !isNaN(y) &&
                x >= viewportBounds.minX && x <= viewportBounds.maxX &&
                y >= viewportBounds.minY && y <= viewportBounds.maxY) {
              hasVisiblePoint = true;
              break;
            }
          }
        } catch (e) {
          // Continue to next point if this one fails
          continue;
        }
      }
      
      return hasVisiblePoint;
    } catch (e) {
      // If we can't determine visibility, assume visible to be safe
      return true;
    }
  };

  // Render boundary polygon
  const renderBoundary = (boundary: BoundaryData | null) => {
    // Reduced logging - only log at trace level for detailed debugging
    // logDebug('[RaceCourseLayer] renderBoundary called', {
    //   hasBoundary: !!boundary,
    //   boundaryId: boundary?.ID,
    //   boundariesCount: boundary?.BOUNDARIES?.length || 0,
    //   hasOverlay: !!raceCourseOverlay,
    //   hasMap: !!props.map
    // });
    
    if (!raceCourseOverlay || !props.map) {
      currentBoundary = null;
      return;
    }
    
    if (!boundary) {
      currentBoundary = null;
      // Remove existing boundary when no data
      raceCourseOverlay.selectAll(".boundary-polygon").remove();
      return;
    }

    // Always remove existing boundary first when time changes (even if new boundary won't be visible)
    // This ensures old boundaries are cleared when selectedTime changes
    raceCourseOverlay.selectAll(".boundary-polygon").remove();

    // Check if boundary is visible before rendering
    if (!isBoundaryVisible(boundary)) {
      // Don't render new boundary if not visible, but old boundary is already removed above
      currentBoundary = null;
      return;
    }

    currentBoundary = boundary;

    if (!boundary.BOUNDARIES || boundary.BOUNDARIES.length === 0) {
      return;
    }
    

    // Get current zoom level
    const currentZoom = props.map.getZoom();
    
    // Convert boundaries to pixel coordinates
    // NOTE: LAT and LON are NOT swapped in the new format (matches marks format)
    // When zoom > 12, draw all coordinates. When zoom <= 12, filter to viewport only
    const points = boundary.BOUNDARIES
      .map(b => {
        try {
          // Use LAT and LON directly (no swap) - matches marks format
          const lat = parseFloat(b.LAT);
          const lon = parseFloat(b.LON);
          const [x, y] = project(lon, lat);
          if (isNaN(x) || isNaN(y)) {
            return null;
          }
          
          // When zoom > 12, include all points. When zoom <= 12, filter to viewport
          if (currentZoom > 12) {
            return [x, y] as [number, number];
          } else {
            // Filter to viewport when zoomed out
            const mapSize = props.map.getContainer().getBoundingClientRect();
            const viewportBounds = {
              minX: 0,
              maxX: mapSize.width,
              minY: 0,
              maxY: mapSize.height
            };
            if (x >= viewportBounds.minX && x <= viewportBounds.maxX && 
                y >= viewportBounds.minY && y <= viewportBounds.maxY) {
              return [x, y] as [number, number];
            }
            return null;
          }
        } catch (e) {
          return null;
        }
      })
      .filter(p => p !== null) as [number, number][];

    // If no points, don't draw anything
    if (points.length === 0) {
      return;
    }
    
    // Create polygon path using d3.line()
    // Use curveLinear to ensure straight lines between points
    const lineGenerator = d3.line<[number, number]>()
      .x(d => d[0])
      .y(d => d[1])
      .curve(d3.curveLinear);

    const pathData = lineGenerator(points);
    if (!pathData) {
      return;
    }

    // Close the path - ensure the last point connects back to the first
    // Check if path already ends at first point, if not, add closing line
    let closedPath = pathData;
    if (points.length > 0) {
      const firstPoint = points[0];
      const lastPoint = points[points.length - 1];
      // If first and last points are different, close the path
      if (firstPoint[0] !== lastPoint[0] || firstPoint[1] !== lastPoint[1]) {
        closedPath = pathData + ` L${firstPoint[0]},${firstPoint[1]} Z`;
      } else {
        closedPath = pathData + ' Z';
      }
    }

    const boundaryLabel = boundary.ID || boundary.TYPE || "Race boundary";
    const pathElement = raceCourseOverlay
      .append("path")
      .attr("class", "boundary-polygon boundary")
      .attr("d", closedPath)
      .style("pointer-events", "stroke") // Allow hover on stroke for tooltip
      .style("fill", "#ebedeb")
      .style("fill-opacity", 0.1)
      .style("stroke", "lightgray")
      .style("stroke-width", "1px")
      .style("cursor", "pointer")
      .on("mouseover", function (event: MouseEvent) {
        setTooltip({
          visible: true,
          content: boundaryLabel,
          x: event.clientX,
          y: event.clientY,
        });
      })
      .on("mouseout", function () {
        setTooltip({ visible: false, content: "", x: 0, y: 0 });
      });
  };

  // Render marks as circles
  // Render marks as circles (or arrows if wind data exists)
  // Uses persistent tracking by name so marks don't disappear when data is missing
  const renderMarks = (marks: MarkData | null) => {
    if (!raceCourseOverlay || !props.map) {
      currentMarks = null;
      return;
    }

    currentMarks = marks;

    // Update persistent marks map with current data (if available)
    // Only update marks that appear in current data - others keep their last known state
    if (marks && marks.MARKS && marks.MARKS.length > 0) {
      marks.MARKS.forEach(mark => {
        const markName = mark.NAME || mark.POSITION || String(Math.random());
        const lat = parseFloat(mark.LAT);
        const lon = parseFloat(mark.LON);
        
        if (!isNaN(lat) && !isNaN(lon)) {
          const [x, y] = project(lon, lat);
          if (!isNaN(x) && !isNaN(y)) {
            // Check for wind data
            const tws = (mark as any).tws !== undefined ? (typeof (mark as any).tws === 'string' ? parseFloat((mark as any).tws) : (mark as any).tws) :
                       mark.TWS !== undefined ? (typeof mark.TWS === 'string' ? parseFloat(mark.TWS) : mark.TWS) :
                       (mark as any).Tws !== undefined ? (typeof (mark as any).Tws === 'string' ? parseFloat((mark as any).Tws) : (mark as any).Tws) :
                       null;
            const twd = (mark as any).twd !== undefined ? (typeof (mark as any).twd === 'string' ? parseFloat((mark as any).twd) : (mark as any).twd) :
                       mark.TWD !== undefined ? (typeof mark.TWD === 'string' ? parseFloat(mark.TWD) : mark.TWD) :
                       (mark as any).Twd !== undefined ? (typeof (mark as any).Twd === 'string' ? parseFloat((mark as any).Twd) : (mark as any).Twd) :
                       null;
            
            // Get existing mark data to preserve last known state if new data is missing
            const existingMark = persistentMarks.get(markName);
            
            // Update with new data, but preserve last known values if new ones are missing
            persistentMarks.set(markName, {
              name: markName,
              x,
              y,
              lat,
              lon,
              // Use new wind data if available, otherwise keep last known values
              tws: (tws !== null && !isNaN(tws)) ? tws : (existingMark?.tws ?? null),
              twd: (twd !== null && !isNaN(twd)) ? twd : (existingMark?.twd ?? null),
              hasWindData: (twd !== null && !isNaN(twd)) ? true : (existingMark?.hasWindData ?? false)
            });
          }
        }
      });
    }

    // Get current zoom level
    const currentZoom = props.map.getZoom();

    // ALWAYS update positions for all persistent marks (in case map moved/zoomed)
    // This ensures marks stay visible even when current data is missing
    persistentMarks.forEach((markData, name) => {
      const [x, y] = project(markData.lon, markData.lat);
      if (!isNaN(x) && !isNaN(y)) {
        markData.x = x;
        markData.y = y;
      }
    });

    // Use D3 data join pattern to update marks by name
    const marksGroup = raceCourseOverlay.select(".marks-group");
    const marksGroupSelection = marksGroup.empty() 
      ? raceCourseOverlay.append("g").attr("class", "marks-group")
      : marksGroup;

    // Create arrow marker definition if wind data exists
    let hasWindData = false;
    persistentMarks.forEach(markData => {
      if (markData.hasWindData) {
        hasWindData = true;
      }
    });

    if (hasWindData && svg) {
      const defs = svg.select("defs");
      if (defs.empty()) {
        svg.append("defs");
      }
      const defsSelection = svg.select("defs");
      if (defsSelection.select("#arrowhead").empty()) {
        defsSelection
          .append("marker")
          .attr("id", "arrowhead")
          .attr("viewBox", "0 0 10 10")
          .attr("refX", 8)
          .attr("refY", 5)
          .attr("markerWidth", 6)
          .attr("markerHeight", 6)
          .attr("orient", "auto")
          .append("path")
          .attr("d", "M 0 0 L 10 5 L 0 10 z")
          .attr("fill", "white")
          .attr("stroke", "white")
          .attr("stroke-width", "0.5");
      }
    }

    // Convert persistent marks map to array for D3 data join
    // When zoom > 12, include all marks. When zoom <= 12, filter to viewport only
    let marksArray = Array.from(persistentMarks.values());
    if (currentZoom <= 12) {
      // Filter to viewport when zoomed out
      const mapSize = props.map.getContainer().getBoundingClientRect();
      const viewportBounds = {
        minX: 0,
        maxX: mapSize.width,
        minY: 0,
        maxY: mapSize.height
      };
      marksArray = marksArray.filter(markData => {
        return markData.x >= viewportBounds.minX && markData.x <= viewportBounds.maxX &&
               markData.y >= viewportBounds.minY && markData.y <= viewportBounds.maxY;
      });
    }

    if (marksArray.length === 0) {
      return;
    }

    // Use D3 data join to update marks by name
    // Key function uses mark name to match existing elements
    const markGroups = marksGroupSelection
      .selectAll<SVGGElement, typeof marksArray[0]>("g.mark-group")
      .data(marksArray, (d) => d.name);

    // Exit: remove marks that are no longer in persistent map
    markGroups.exit().remove();

    // Enter: create new mark groups
    const markGroupsEnter = markGroups.enter()
      .append("g")
      .attr("class", "mark-group")
      .attr("data-mark-name", (d) => d.name);

    // Update: merge enter and update selections
    const markGroupsUpdate = markGroupsEnter.merge(markGroups);

    // Update each mark group
    markGroupsUpdate.each(function(markData) {
      const group = d3.select(this);
      
      // Update circle position
      let circle = group.select("circle.mark-circle");
      if (circle.empty()) {
        circle = group.append("circle")
          .attr("class", "mark-circle")
          .attr("r", 3)
          .attr("fill", "none")
          .attr("stroke", "white")
          .attr("stroke-width", 1.5)
          .style("opacity", 1);
      }
      circle
        .attr("cx", markData.x)
        .attr("cy", markData.y);

      // Invisible larger circle for easier hover and tooltip
      let hoverCircle = group.select("circle.mark-hover");
      if (hoverCircle.empty()) {
        hoverCircle = group.append("circle")
          .attr("class", "mark-hover")
          .attr("r", 10)
          .attr("fill", "transparent")
          .style("pointer-events", "all")
          .style("cursor", "pointer");
      }
      hoverCircle.attr("cx", markData.x).attr("cy", markData.y);

      // Update or create arrow if wind data exists (angle accounts for map bearing so arrow rotates with map)
      if (markData.hasWindData && markData.twd !== null) {
        const mapBearing = props.map.getBearing ? props.map.getBearing() : 0;
        const angle = (markData.twd + 180 - 90 - mapBearing) * (Math.PI / 180);
        const arrowLength = 20;
        const endX = markData.x + Math.cos(angle) * arrowLength;
        const endY = markData.y + Math.sin(angle) * arrowLength;

        let arrow = group.select("line.markwind-arrow");
        if (arrow.empty()) {
          arrow = group.append("line")
            .attr("class", "markwind-arrow")
            .attr("stroke", "white")
            .attr("stroke-width", 1.5)
            .attr("marker-end", "url(#arrowhead)");
        }
        arrow
          .attr("x1", markData.x)
          .attr("y1", markData.y)
          .attr("x2", endX)
          .attr("y2", endY);

        // Update or create label - show TWS value
        if (markData.tws !== null && !isNaN(markData.tws)) {
          let label = group.select("text.markwind-label");
          if (label.empty()) {
            label = group.append("text")
              .attr("class", "markwind-label")
              .attr("fill", "white")
              .attr("font-size", "8px")
              .attr("font-family", "Arial, sans-serif");
          }
          
          // Position label on the opposite side of the arrow so it doesn't run in the same direction as the arrow
          const perpendicularAngle = angle - Math.PI / 2;
          const labelOffset = 10; // Distance from arrow end
          const labelX = endX + Math.cos(perpendicularAngle) * labelOffset;
          const labelY = endY + Math.sin(perpendicularAngle) * labelOffset;
          
          label
            .attr("x", labelX)
            .attr("y", labelY)
            .text(markData.tws.toFixed(1)); // Show TWS value with 1 decimal place
        } else {
          group.select("text.markwind-label").remove();
        }
      } else {
        // Remove arrow and label if no wind data
        group.select("line.markwind-arrow").remove();
        group.select("text.markwind-label").remove();
      }
    });

    // Tooltip: show mark name on hover
    markGroupsUpdate
      .on("mouseover", function (event: MouseEvent, d: typeof marksArray[0]) {
        setTooltip({
          visible: true,
          content: d.name,
          x: event.clientX,
          y: event.clientY,
        });
      })
      .on("mouseout", function () {
        setTooltip({ visible: false, content: "", x: 0, y: 0 });
      });
  };

  // Render markwind as arrows with TWS labels
  // Uses persistent tracking by name so marks don't disappear when data is missing
  const renderMarkwind = (marks: MarkData | null) => {
    if (!raceCourseOverlay || !props.map) {
      currentMarks = null;
      return;
    }

    currentMarks = marks;

    // Update persistent marks map with current data (if available)
    // Only update marks that appear in current data - others keep their last known state
    if (marks && marks.MARKS && marks.MARKS.length > 0) {
      marks.MARKS.forEach(mark => {
        const markName = mark.NAME || mark.POSITION || String(Math.random());
        const lat = parseFloat(mark.LAT);
        const lon = parseFloat(mark.LON);
        
        if (!isNaN(lat) && !isNaN(lon)) {
          const [x, y] = project(lon, lat);
          if (!isNaN(x) && !isNaN(y)) {
            // Check for wind data
            const tws = (mark as any).tws !== undefined ? (typeof (mark as any).tws === 'string' ? parseFloat((mark as any).tws) : (mark as any).tws) :
                       mark.TWS !== undefined ? (typeof mark.TWS === 'string' ? parseFloat(mark.TWS) : mark.TWS) :
                       (mark as any).Tws !== undefined ? (typeof (mark as any).Tws === 'string' ? parseFloat((mark as any).Tws) : (mark as any).Tws) :
                       null;
            const twd = (mark as any).twd !== undefined ? (typeof (mark as any).twd === 'string' ? parseFloat((mark as any).twd) : (mark as any).twd) :
                       mark.TWD !== undefined ? (typeof mark.TWD === 'string' ? parseFloat(mark.TWD) : mark.TWD) :
                       (mark as any).Twd !== undefined ? (typeof (mark as any).Twd === 'string' ? parseFloat((mark as any).Twd) : (mark as any).Twd) :
                       null;
            
            // Get existing mark data to preserve last known state if new data is missing
            const existingMark = persistentMarks.get(markName);
            
            // Update with new data, but preserve last known values if new ones are missing
            persistentMarks.set(markName, {
              name: markName,
              x,
              y,
              lat,
              lon,
              // Use new wind data if available, otherwise keep last known values
              tws: (tws !== null && !isNaN(tws)) ? tws : (existingMark?.tws ?? null),
              twd: (twd !== null && !isNaN(twd)) ? twd : (existingMark?.twd ?? null),
              hasWindData: (twd !== null && !isNaN(twd)) ? true : (existingMark?.hasWindData ?? false)
            });
          }
        }
      });
    }

    // Get current zoom level
    const currentZoom = props.map.getZoom();

    // ALWAYS update positions for all persistent marks (in case map moved/zoomed)
    // This ensures marks stay visible even when current data is missing
    persistentMarks.forEach((markData, name) => {
      const [x, y] = project(markData.lon, markData.lat);
      if (!isNaN(x) && !isNaN(y)) {
        markData.x = x;
        markData.y = y;
      }
    });

    // Use D3 data join pattern to update marks by name (same as renderMarks)
    const markwindGroup = raceCourseOverlay.select(".markwind-group");
    const markwindGroupSelection = markwindGroup.empty() 
      ? raceCourseOverlay.append("g").attr("class", "markwind-group")
      : markwindGroup;

    // Create arrow marker definition
    if (!svg) {
      return;
    }
    
    const defs = svg.select("defs");
    if (defs.empty()) {
      svg.append("defs");
    }

    const defsSelection = svg.select("defs");
    if (defsSelection.select("#arrowhead").empty()) {
      defsSelection
        .append("marker")
        .attr("id", "arrowhead")
        .attr("viewBox", "0 0 10 10")
        .attr("refX", 8)
        .attr("refY", 5)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M 0 0 L 10 5 L 0 10 z")
        .attr("fill", "white")
        .attr("stroke", "white")
        .attr("stroke-width", "0.5");
    }

    // Convert persistent marks map to array for D3 data join
    // When zoom > 12, include all marks. When zoom <= 12, filter to viewport only
    let marksArray = Array.from(persistentMarks.values());
    if (currentZoom <= 12) {
      // Filter to viewport when zoomed out
      const mapSize = props.map.getContainer().getBoundingClientRect();
      const viewportBounds = {
        minX: 0,
        maxX: mapSize.width,
        minY: 0,
        maxY: mapSize.height
      };
      marksArray = marksArray.filter(markData => {
        return markData.x >= viewportBounds.minX && markData.x <= viewportBounds.maxX &&
               markData.y >= viewportBounds.minY && markData.y <= viewportBounds.maxY;
      });
    }

    if (marksArray.length === 0) {
      return;
    }

    // Use D3 data join to update marks by name
    const markGroups = markwindGroupSelection
      .selectAll<SVGGElement, typeof marksArray[0]>("g.mark-group")
      .data(marksArray, (d) => d.name);

    // Exit: remove marks that are no longer in persistent map
    markGroups.exit().remove();

    // Enter: create new mark groups
    const markGroupsEnter = markGroups.enter()
      .append("g")
      .attr("class", "mark-group")
      .attr("data-mark-name", (d) => d.name);

    // Update: merge enter and update selections
    const markGroupsUpdate = markGroupsEnter.merge(markGroups);

    let validArrows = 0;
    let validLabels = 0;
    let fallbackCircles = 0;

    // Update each mark group
    markGroupsUpdate.each(function(markData) {
      const group = d3.select(this);
      
      // Always draw the mark circle first
      let circle = group.select("circle.mark-circle");
      if (circle.empty()) {
        circle = group.append("circle")
          .attr("class", "mark-circle")
          .attr("r", 3)
          .attr("fill", "none")
          .attr("stroke", "white")
          .attr("stroke-width", 1.5)
          .style("opacity", 1);
      }
      circle
        .attr("cx", markData.x)
        .attr("cy", markData.y);

      // Invisible larger circle for easier hover and tooltip
      let hoverCircle = group.select("circle.mark-hover");
      if (hoverCircle.empty()) {
        hoverCircle = group.append("circle")
          .attr("class", "mark-hover")
          .attr("r", 10)
          .attr("fill", "transparent")
          .style("pointer-events", "all")
          .style("cursor", "pointer");
      }
      hoverCircle.attr("cx", markData.x).attr("cy", markData.y);

      // Then draw wind arrow if wind direction is available (angle accounts for map bearing so arrow rotates with map)
      if (markData.hasWindData && markData.twd !== null) {
        const mapBearing = props.map.getBearing ? props.map.getBearing() : 0;
        const angle = (markData.twd + 180 - 90 - mapBearing) * (Math.PI / 180);
        const arrowLength = 20;
        const endX = markData.x + Math.cos(angle) * arrowLength;
        const endY = markData.y + Math.sin(angle) * arrowLength;

        let arrow = group.select("line.markwind-arrow");
        if (arrow.empty()) {
          arrow = group.append("line")
            .attr("class", "markwind-arrow")
            .attr("stroke", "white")
            .attr("stroke-width", 1.5)
            .attr("marker-end", "url(#arrowhead)");
        }
        arrow
          .attr("x1", markData.x)
          .attr("y1", markData.y)
          .attr("x2", endX)
          .attr("y2", endY);

        validArrows++;

        // Add label - show TWS value
        if (markData.tws !== null && !isNaN(markData.tws)) {
          let label = group.select("text.markwind-label");
          if (label.empty()) {
            label = group.append("text")
              .attr("class", "markwind-label")
              .attr("fill", "white")
              .attr("font-size", "8px")
              .attr("font-family", "Arial, sans-serif");
          }
          
          // Position label on the opposite side of the arrow so it doesn't run in the same direction as the arrow
          const perpendicularAngle = angle - Math.PI / 2;
          const labelOffset = 10; // Distance from arrow end
          const labelX = endX + Math.cos(perpendicularAngle) * labelOffset;
          const labelY = endY + Math.sin(perpendicularAngle) * labelOffset;
          
          label
            .attr("x", labelX)
            .attr("y", labelY)
            .text(markData.tws.toFixed(1)); // Show TWS value with 1 decimal place
          
          validLabels++;
        } else {
          group.select("text.markwind-label").remove();
        }
      } else {
        // No wind direction available, just circle (already drawn above)
        group.select("line.markwind-arrow").remove();
        group.select("text.markwind-label").remove();
        fallbackCircles++;
      }
    });

    // Tooltip: show mark name on hover
    markGroupsUpdate
      .on("mouseover", function (event: MouseEvent, d: typeof marksArray[0]) {
        setTooltip({
          visible: true,
          content: d.name,
          x: event.clientX,
          y: event.clientY,
        });
      })
      .on("mouseout", function () {
        setTooltip({ visible: false, content: "", x: 0, y: 0 });
      });
  };

  // Render marks only (used in live mode when boundary doesn't need to update)
  const renderMarksOnly = () => {
    if (!raceCourseOverlay || !svg || !props.map || isDrawing) {
      return;
    }

    // Don't render if data hasn't been loaded yet
    if (!isDataLoaded) {
      return;
    }
    
    // Check if we have marks data or persistent marks
    const hasMarksData = marksData.length > 0;
    const hasPersistentMarks = persistentMarks.size > 0;
    
    if (!hasMarksData && !hasPersistentMarks) {
      isDrawing = false;
      return;
    }

    // Skip all rendering if racecourse is not in view
    if (!isRacecourseInView()) {
      // Remove existing rendered marks since they're not in view
      raceCourseOverlay.selectAll(".marks-group").remove();
      raceCourseOverlay.selectAll(".markwind-group").remove();
      isDrawing = false;
      return;
    }

    isDrawing = true;

    try {
      const currentTime = selectedTime();
      if (!currentTime) {
        isDrawing = false;
        return;
      }

      // Find nearest marks/markwind (may be null if no data for this timestep)
      const nearestMarks = findNearestByTime(marksData, currentTime);
      // Always render marks (even if nearestMarks is null, persistent marks will be shown)
      if (isMarkwind) {
        renderMarkwind(nearestMarks);
      } else {
        renderMarks(nearestMarks);
      }
    } catch (err) {
      logError('RaceCourseLayer: Error rendering marks:', err);
    } finally {
      isDrawing = false;
    }
  };

  // Main render function
  const render = () => {
    if (!raceCourseOverlay || !svg || !props.map || isDrawing) {
      return;
    }

    // Don't render if data hasn't been loaded yet
    if (!isDataLoaded) {
      return;
    }
    
    // Double-check that at least some data is actually available (defense against race conditions)
    // We can render if we have boundary data, marks data, or persistent marks
    const hasBoundaryData = boundaryData.length > 0;
    const hasMarksData = marksData.length > 0;
    const hasPersistentMarks = persistentMarks.size > 0;
    
    if (!hasBoundaryData && !hasMarksData && !hasPersistentMarks) {
      isDrawing = false;
      return;
    }

    // Skip rendering if racecourse is not in view (map bounds may not include boundaries/marks).
    // On initial render always draw when we have data so boundaries/marks show when first enabled
    // without requiring a toggle; after that respect in-view check for pan/zoom updates.
    if (!isInitialRender && !isRacecourseInView()) {
      // Remove existing rendered elements since they're not in view
      raceCourseOverlay.selectAll(".boundary-polygon").remove();
      raceCourseOverlay.selectAll(".marks-group").remove();
      raceCourseOverlay.selectAll(".markwind-group").remove();
      isDrawing = false;
      return;
    }

    isDrawing = true;

    try {
      const currentTime = selectedTime();
      if (!currentTime) {
        isDrawing = false;
        return;
      }

      // Find nearest boundary (round to nearest minute)
      const roundedTime = roundToNearestMinute(currentTime);
      const nearestBoundary = findNearestByTime(boundaryData, roundedTime);
      renderBoundary(nearestBoundary);

      // Find nearest marks/markwind (may be null if no data for this timestep)
      const nearestMarks = findNearestByTime(marksData, currentTime);
      // Always render marks (even if nearestMarks is null, persistent marks will be shown)
      if (isMarkwind) {
        renderMarkwind(nearestMarks);
      } else {
        renderMarks(nearestMarks);
      }
      isInitialRender = false; // After first successful draw, use in-view check on later renders
    } catch (err) {
      logError('RaceCourseLayer: Error rendering:', err);
    } finally {
      isDrawing = false;
    }
  };

  // Load data on mount
  onMount(async () => {
    // Reset state variables on mount to ensure clean initialization
    isDataLoaded = false;
    isInitialRender = true;
    lastUpdateTime = 0;
    lastSelectedTime = null;
    lastBoundaryMinute = null; // Reset boundary minute tracking
    raceCourseOverlay = null;
    svg = null;
    boundaryData = [];
    marksData = [];
    currentBoundary = null;
    currentMarks = null;
    persistentMarks.clear();
    
    if (!props.map) {
      return;
    }

    // Wait for map to be fully loaded before proceeding
    if (!props.map.loaded()) {
      const loadHandler = async () => {
        if (!isMounted) return; // Don't proceed if unmounted
        // Add a small delay to ensure everything is ready
        const timeoutId = setTimeout(async () => {
          activeTimeouts.delete(timeoutId);
          if (!isMounted) return; // Check again after timeout
          await initializeLayer();
        }, 100);
        activeTimeouts.add(timeoutId);
      };
      props.map.once('load', loadHandler);
      // Store cleanup for this listener
      onCleanup(() => {
        if (props.map) {
          props.map.off('load', loadHandler);
        }
      });
      return;
    }

    await initializeLayer();
  });

  // Set up map event listeners for zoom/pan updates
  const setupMapEventListeners = () => {
    if (!props.map || !raceCourseOverlay) return;

    // Clean up existing listeners if any
    if (mapEventListenersCleanup) {
      mapEventListenersCleanup();
      mapEventListenersCleanup = null;
    }

    const updatePositions = () => {
      // Skip completely if racecourse is not in view
      if (!isRacecourseInView()) {
        // Remove existing rendered elements since they're not in view
        if (raceCourseOverlay) {
          raceCourseOverlay.selectAll(".boundary-polygon").remove();
          raceCourseOverlay.selectAll(".marks-group").remove();
          raceCourseOverlay.selectAll(".markwind-group").remove();
        }
        return;
      }
      
      // Throttle render calls to avoid excessive re-rendering during map movements
      if (renderThrottleTimer !== null) {
        return; // Skip if already scheduled
      }
      
      renderThrottleTimer = window.setTimeout(() => {
        renderThrottleTimer = null;
        if (!isMounted) return; // Don't render if unmounted
        
        // Check again if racecourse is still in view (viewport may have changed)
        if (!isRacecourseInView()) {
          if (raceCourseOverlay) {
            raceCourseOverlay.selectAll(".boundary-polygon").remove();
            raceCourseOverlay.selectAll(".marks-group").remove();
            raceCourseOverlay.selectAll(".markwind-group").remove();
          }
          return;
        }
        
        if (raceCourseOverlay && props.map) {
          // Re-render boundary and marks with updated coordinates
          // Find nearest boundary based on current selectedTime (not cached currentBoundary)
          // This ensures only the boundary nearest to the selected time is shown
          const currentTime = selectedTime();
          if (currentTime && boundaryData.length > 0 && (props.visible !== false)) {
            const roundedTime = roundToNearestMinute(currentTime);
            const nearestBoundary = findNearestByTime(boundaryData, roundedTime);
            renderBoundary(nearestBoundary);
          } else if (!currentTime || boundaryData.length === 0) {
            // No time or no boundary data - remove existing boundary
            renderBoundary(null);
          }
          
          // Always render marks (persistent marks will be shown even if currentMarks is null)
          // This ensures marks stay visible when map moves/zooms
          if (currentMarks) {
            if (isMarkwind) {
              renderMarkwind(currentMarks);
            } else {
              renderMarks(currentMarks);
            }
          } else {
            // If currentMarks is null, still render persistent marks
            // Try to find marks for current time first, but render persistent marks regardless
            if (currentTime && marksData.length > 0) {
              const nearestMarks = findNearestByTime(marksData, currentTime);
              if (nearestMarks) {
                if (isMarkwind) {
                  renderMarkwind(nearestMarks);
                } else {
                  renderMarks(nearestMarks);
                }
              } else {
                // No marks for current time, but render persistent marks anyway
                if (isMarkwind) {
                  renderMarkwind(null);
                } else {
                  renderMarks(null);
                }
              }
            } else {
              // No marks data at all, but render persistent marks if they exist
              if (persistentMarks.size > 0) {
                if (isMarkwind) {
                  renderMarkwind(null);
                } else {
                  renderMarks(null);
                }
              }
            }
          }
        }
      }, RENDER_THROTTLE_MS);
    };

    // Use 'render' event for smooth, frame-synced updates during map movements (throttled)
    props.map.on('render', updatePositions);
    
    // Also listen to end events for final positioning (no throttling needed for end events)
    props.map.on('moveend', () => {
      if (renderThrottleTimer !== null) {
        clearTimeout(renderThrottleTimer);
        renderThrottleTimer = null;
      }
      updatePositions();
    });
    props.map.on('zoomend', () => {
      if (renderThrottleTimer !== null) {
        clearTimeout(renderThrottleTimer);
        renderThrottleTimer = null;
      }
      updatePositions();
    });
    props.map.on('rotateend', updatePositions);
    props.map.on('pitchend', updatePositions);
    props.map.on('viewreset', updatePositions);

    // Store cleanup function
    mapEventListenersCleanup = () => {
      if (renderThrottleTimer !== null) {
        clearTimeout(renderThrottleTimer);
        renderThrottleTimer = null;
      }
      if (props.map) {
        props.map.off('render', updatePositions);
        props.map.off('moveend', updatePositions);
        props.map.off('zoomend', updatePositions);
        props.map.off('rotateend', updatePositions);
        props.map.off('pitchend', updatePositions);
        props.map.off('viewreset', updatePositions);
      }
    };
  };

  // Separate initialization function to avoid code duplication
  const initializeLayer = async () => {
    if (!isMounted) {
      return;
    }
    
    // Create overlay first and wait for it
    await createOverlay();
    if (!isMounted) return; // Check after async operation

    // Set up map event listeners after overlay is created
    setupMapEventListeners();

    // Fetch boundary data first
    boundaryData = await fetchBoundaryData();
    if (!isMounted) return; // Check after async operation
    
    // Check if any boundaries are in view before fetching marks
    // If nothing is in view, skip fetching marks entirely
    if (!isRacecourseInView()) {
      marksData = [];
      isMarkwind = false;
    } else {
      // Fetch marks data only if boundaries are in view
      const marksResult = await fetchMarksData();
      if (!isMounted) return; // Check after async operation
      
      marksData = marksResult.data;
      isMarkwind = marksResult.isMarkwind;
    }

    // Mark data as loaded ONLY after both boundary and marks data are fetched
    // This ensures boundaryData and marksData are populated before render() can use them
    isDataLoaded = true;

    // Reset initial render flag when data is loaded
    isInitialRender = true;
    lastUpdateTime = 0;

    // Initial render - ensure we have overlay, svg, map, and data
    if (raceCourseOverlay && svg && props.map && (boundaryData.length > 0 || marksData.length > 0)) {
      // Try to render - if selectedTime is not available, the createEffect will handle it
      const currentTime = selectedTime();
      
      if (currentTime) {
        // Small delay to ensure everything is fully ready
        const timeoutId = setTimeout(() => {
          activeTimeouts.delete(timeoutId);
          if (!isMounted) return; // Don't render if unmounted
          if (raceCourseOverlay && svg && props.map && isDataLoaded) {
            render();
            // Mark that initial render is complete
            isInitialRender = false;
            lastUpdateTime = Date.now();
          }
        }, 100);
        activeTimeouts.add(timeoutId);
      } else {
        // The createEffect watching selectedTime will trigger render when it becomes available
        isInitialRender = true;
      }
    } else {
      // Retry overlay creation if it failed
      const timeoutId = setTimeout(async () => {
        activeTimeouts.delete(timeoutId);
        if (!isMounted) return; // Don't proceed if unmounted
        await createOverlay();
        if (!isMounted) return; // Check again after async operation
        setupMapEventListeners(); // Set up listeners after retry
        if (raceCourseOverlay && props.map) {
          const currentTime = selectedTime();
          if (currentTime) {
            render();
            isInitialRender = false;
            lastUpdateTime = Date.now();
          } else {
            isInitialRender = true;
          }
        }
      }, 500);
    }
  };

  // React to selectedTime changes
  // - Manual updates: update immediately
  // - Animation: throttle to every 2 seconds
  // - Live mode: update boundaries only once per minute (not on every selectedTime change)
  createEffect(() => {
    const time = selectedTime();
    if (!time) {
      return;
    }
    
    const playing = isPlaying();
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateTime;
    const isLive = liveMode();
    
    // Detect if this is a manual time change (large jump) or animation (small increment)
    const isManualUpdate = lastSelectedTime === null || 
                           Math.abs(time.getTime() - lastSelectedTime.getTime()) > 5000; // More than 5 seconds difference = manual
    
    // In live mode, check if the minute has changed for boundary updates
    let shouldUpdateBoundary = true;
    if (isLive) {
      const currentMinute = Math.floor(time.getTime() / LIVE_MODE_BOUNDARY_UPDATE_INTERVAL_MS);
      if (lastBoundaryMinute !== null && lastBoundaryMinute === currentMinute) {
        // Same minute, don't update boundary
        shouldUpdateBoundary = false;
      } else {
        // Minute changed, update boundary
        lastBoundaryMinute = currentMinute;
      }
    }
    
    // Always update on initial render
    // Manual updates: update immediately
    // Animation: throttle to every 2 seconds
    // In live mode: only update boundary when minute changes
    const shouldUpdate = isInitialRender || 
                        isManualUpdate || 
                        (!playing) || 
                        (playing && timeSinceLastUpdate >= UPDATE_INTERVAL_MS);
    
    if (shouldUpdate) {
      // Always render if we have overlay and data is loaded
      // In live mode, only update boundary when minute changes
      if (raceCourseOverlay && isDataLoaded) {
        lastUpdateTime = now;
        lastSelectedTime = time;
        isInitialRender = false;
        
        // In live mode, only update boundary if minute changed
        // Marks can still update on every time change
        if (isLive && !shouldUpdateBoundary) {
          // Only render marks, skip boundary update
          renderMarksOnly();
        } else {
          // Render both boundary and marks
          render();
        }
      }
    }
  });

  // Control visibility based on prop - show/hide SVG without unmounting
  createEffect(() => {
    const visible = props.visible !== false; // Default to visible if not specified
    if (svg) {
      svg.style("display", visible ? "block" : "none");
      
      // If becoming visible and we have data, trigger a render to update positions
      if (visible && isDataLoaded && (boundaryData.length > 0 || marksData.length > 0)) {
        const currentTime = selectedTime();
        if (currentTime) {
          // Small delay to ensure map is ready
          const timeoutId = setTimeout(() => {
            activeTimeouts.delete(timeoutId);
            if (!isMounted) return; // Don't render if unmounted
            if (raceCourseOverlay && svg && props.map && isDataLoaded) {
              render();
            }
          }, 100);
          activeTimeouts.add(timeoutId);
        }
      }
    }
  });

  // Refetch boundaries and marks when the effective date changes (e.g. user changes selectedDate on fleet map)
  createEffect(() => {
    const _date = persistantStore.selectedDate?.();
    const _datasetId = persistantStore.selectedDatasetId?.();
    getDateToUse().then((currentDateStr) => {
      if (!isMounted || currentDateStr == null) return;
      if (lastEffectiveDateStr !== null && lastEffectiveDateStr !== currentDateStr) {
        isDataLoaded = false;
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        fetchBoundaryData()
          .then((data) => {
            if (!isMounted) return;
            boundaryData = data;
            if (!isRacecourseInView()) {
              marksData = [];
              isMarkwind = false;
              isDataLoaded = true;
              lastEffectiveDateStr = currentDateStr;
              if (raceCourseOverlay && svg && props.map) render();
            } else {
              fetchMarksData()
                .then((result) => {
                  if (!isMounted) return;
                  marksData = result.data;
                  isMarkwind = result.isMarkwind;
                  isDataLoaded = true;
                  lastEffectiveDateStr = currentDateStr;
                  if (raceCourseOverlay && svg && props.map) render();
                })
                .catch(() => {
                  if (!isMounted) return;
                  isDataLoaded = true;
                  lastEffectiveDateStr = currentDateStr;
                  if (raceCourseOverlay && svg && props.map) render();
                });
            }
          })
          .catch(() => {
            if (!isMounted) return;
            isDataLoaded = true;
            lastEffectiveDateStr = currentDateStr;
            if (raceCourseOverlay && svg && props.map) render();
          });
      } else if (lastEffectiveDateStr === null) {
        lastEffectiveDateStr = currentDateStr;
      }
    });
  });

  // React to map move/zoom to update positions - use Mapbox's render event for smooth updates
  // This effect ensures listeners are set up when map becomes available
  createEffect(() => {
    if (!props.map) return;

    // If overlay exists, set up listeners (they may have been set up in initializeLayer already)
    // This is a fallback in case the overlay is created after this effect runs
    if (raceCourseOverlay && !mapEventListenersCleanup) {
      setupMapEventListeners();
    }

    // Cleanup on unmount
    return () => {
      if (mapEventListenersCleanup) {
        mapEventListenersCleanup();
        mapEventListenersCleanup = null;
      }
    };
  });

  // Effect to ensure rendering happens when component is re-mounted after being unmounted
  // This handles the case where zoom goes below threshold (unmount) then back above (remount)
  // Watch for overlay creation and data loading to trigger render
  createEffect(() => {
    const currentMap = props.map;
    const hasOverlay = !!raceCourseOverlay;
    const hasSvg = !!svg;
    const dataLoaded = isDataLoaded;
    const currentTime = selectedTime();
    
    // If we have map, overlay, svg, data loaded, and selectedTime, ensure we render
    if (currentMap && hasOverlay && hasSvg && dataLoaded && currentTime && (boundaryData.length > 0 || marksData.length > 0)) {
      // Use a small delay to ensure everything is ready and avoid race conditions
      const timeoutId = setTimeout(() => {
        activeTimeouts.delete(timeoutId);
        if (!isMounted) return; // Don't render if unmounted
        if (raceCourseOverlay && svg && props.map && isDataLoaded) {
          render();
        }
      }, 200);
      activeTimeouts.add(timeoutId);
      
      return () => {
        clearTimeout(timeoutId);
        activeTimeouts.delete(timeoutId);
      };
    }
  });

  // Cleanup
  onCleanup(() => {
    // Mark as unmounted to prevent any further operations
    isMounted = false;
    
    // Abort any pending fetch requests
    if (abortController) {
      abortController.abort();
      abortController = null;
    }

    // Clear all active timeouts
    activeTimeouts.forEach(timeoutId => {
      clearTimeout(timeoutId);
    });
    activeTimeouts.clear();

    // Clear render throttle timer
    if (renderThrottleTimer !== null) {
      clearTimeout(renderThrottleTimer);
      renderThrottleTimer = null;
    }

    // Clean up map event listeners
    if (mapEventListenersCleanup) {
      mapEventListenersCleanup();
      mapEventListenersCleanup = null;
    }

    if ((window as any).raceCourseLayerResizeHandler) {
      window.removeEventListener('resize', (window as any).raceCourseLayerResizeHandler);
      delete (window as any).raceCourseLayerResizeHandler;
    }

    // Clean up D3 overlays for this map instance only
    if (overlayContainer) {
      d3.select(overlayContainer).selectAll(".race-course-overlay").remove();
      overlayContainer = null;
    }
  });

  return null; // This component doesn't render JSX, it uses D3
}

