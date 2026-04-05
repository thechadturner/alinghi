// @ts-nocheck
import { createSignal, createEffect, onMount, onCleanup, Show, untrack, createMemo, lazy, Suspense } from "solid-js";
import { createStore } from "solid-js/store";

// Using dynamic import for mapboxgl to avoid module resolution issues
let mapboxgl: any = null;

import Loading from "../../utilities/Loading";
import PlayPause from "../../utilities/PlayPause";
import Overlay from "../Overlay";
import MapSettings from "../../menus/MapSettings";
import MapTimeSeries from "./MapTimeSeries";
import MultiMapTimeSeries from "./MultiMapTimeSeries";
import LiveMapTimeSeries from "./LiveMapTimeSeries";
import { error as logError, debug as logDebug, warn as logWarn } from "../../../utils/console";
import { waitForPaint } from "../../../utils/waitForRender";
import { registerActiveComponent, unregisterActiveComponent } from "../../../pages/Dashboard";

// New component architecture
import TrackLayer from "../map/components/TrackLayer";
import BoatLayer from "../map/components/BoatLayer";
import SelectionLayer from "../map/components/SelectionLayer";
import MultiTrackLayer from "../map/components/MultiTrackLayer";
import LiveTrackLayer from "../map/components/LiveTrackLayer";
import MultiBoatLayer from "../map/components/MultiBoatLayer";
import LiveMultiBoatLayer from "../map/components/LiveMultiBoatLayer";
import RaceCourseLayer from "../map/components/RaceCourseLayer";
import WindArrow from "../map/components/WindArrow";

// Overlay system
import { initializeOverlays, overlayRegistry } from "./overlays";
import OverlayManager from "./overlays/OverlayManager";
const FleetDataTable = lazy(() => import("../guages/FleetDataTable"));

import { unifiedDataStore } from "../../../store/unifiedDataStore";
import { unifiedDataAPI } from "../../../store/unifiedDataAPI";
import { streamingStore } from "../../../store/streamingStore";
import { streamingService } from "../../../services/streamingService";
import { sourcesStore } from "../../../store/sourcesStore";
import { defaultChannelsStore } from "../../../store/defaultChannelsStore";
import { speedUnitSuffix, twsMagnitudeInDisplayUnit } from "../../../utils/speedUnits";
import { tooltip, setTooltip } from "../../../store/globalStore";
import { persistantStore } from "../../../store/persistantStore";
import { initializeSourceSelections } from "../../../utils/sourceInitialization";
import { apiEndpoints, config } from "@config/env";
import { getData, getTimezoneForDate } from "../../../utils/global";
import { extractFilterOptions, applyDataFilter } from "../../../utils/dataFiltering";

import { 
  triggerUpdate, 
  setTriggerUpdate, 
  selection, 
  selectedEvents, 
  setHasSelection, 
  hasSelection, 
  setSelection, 
  setIsCut, 
  setCutEvents, 
  selectedRange, 
  setSelectedRange, 
  selectedRanges,
  cutEvents,
  selectedDate as selectionSelectedDate, 
  isCut
} from "../../../store/selectionStore";
import {
  selectedStatesTimeseries,
  setSelectedStatesTimeseries,
  selectedRacesTimeseries,
  setSelectedRacesTimeseries,
  selectedLegsTimeseries,
  setSelectedLegsTimeseries,
  selectedGradesTimeseries,
  setSelectedGradesTimeseries,
  raceOptions,
  setRaceOptions,
  setIsTrainingHourMode,
  legOptions,
  setLegOptions,
  gradeOptions,
  setGradeOptions,
  setHasChartsWithOwnFilters,
  isTrainingHourMode,
  selectedSources as filterStoreSelectedSources,
  setSelectedSources as filterStoreSetSelectedSources
} from "../../../store/filterStore";
import { showPlayback, selectedTime, setSelectedTime, isPlaying, setIsPlaying, playbackSpeed, timeWindow, smoothPlaybackTimeForTrack, syncSelectedTimeManual, startPeriodicSync, setIsManualTimeChange, requestTimeControl, releaseTimeControl, setLiveMode } from "../../../store/playbackStore";
import { logPageLoad } from "../../../utils/logging";
import { processMapDataWithWorker } from "../../../utils/workerManager";
import { persistentSettingsService } from "../../../services/persistentSettingsService";
import { user } from "../../../store/userStore";
import { isSameRace } from "../../../utils/raceValueUtils";

import "../../../styles/thirdparty/mapbox-gl.css";

interface MapContainerProps {
  objectName?: string;
  enableTimeWindow?: boolean;
  sourceMode?: string;
  mapFilterScope?: 'full' | 'raceLegOnly';
  liveMode?: boolean;
  dataSourcesOptions?: any[] | (() => any[]);
  [key: string]: any;
}

interface XRange {
  min: number;
  max: number;
}

export default function MapContainer(props: MapContainerProps) {
  // Guard: don't render map until sourcesStore is ready (prevents empty selectedSourceIds in splitscreen/production)
  const [isSourcesReady, setIsSourcesReady] = createSignal(false);
  const [hasShownMapOnce, setHasShownMapOnce] = createSignal(false);
  createEffect(() => {
    if (sourcesStore.isReady()) {
      setIsSourcesReady(true);
    }
  });

  // Register map as active when this component is in the tree.
  createEffect(() => {
    registerActiveComponent('map');
    return () => unregisterActiveComponent('map');
  });

  const [mapContainer, setMapContainer] = createSignal<HTMLDivElement | null>(null);
  let chartContainer: HTMLElement | null = null;
  const [map, setMap] = createSignal<mapboxgl.Map | null>(null);
  const [tilesAvailable, setTilesAvailable] = createSignal(true);
  const [currentZoom, setCurrentZoom] = createSignal<number>(14);
  
  // Zoom settings from class object
  const [zoomSettings, setZoomSettings] = createSignal<{
    race_course?: number;
    boats?: number;
    maneuvers?: number;
  } | null>(null);
  
  // Default zoom threshold if zoom_settings object is not found
  const DEFAULT_ZOOM_THRESHOLD = 16;
  
  // Reactive zoom thresholds - these will update when zoomSettings changes
  const boatsZoomThreshold = createMemo(() => {
    const settings = zoomSettings();
    const threshold = (settings && settings.boats !== undefined) ? settings.boats : DEFAULT_ZOOM_THRESHOLD;
    logDebug('MapContainer: boatsZoomThreshold computed', { 
      settings, 
      boatsValue: settings?.boats, 
      threshold, 
      default: DEFAULT_ZOOM_THRESHOLD 
    });
    return threshold;
  });
  
  const maneuversZoomThreshold = createMemo(() => {
    const settings = zoomSettings();
    const threshold = (settings && settings.maneuvers !== undefined) ? settings.maneuvers : DEFAULT_ZOOM_THRESHOLD;
    logDebug('MapContainer: maneuversZoomThreshold computed', { 
      settings, 
      maneuversValue: settings?.maneuvers, 
      threshold, 
      default: DEFAULT_ZOOM_THRESHOLD 
    });
    return threshold;
  });
  
  const raceCourseZoomThreshold = createMemo(() => {
    const settings = zoomSettings();
    const threshold = (settings && settings.race_course !== undefined) ? settings.race_course : DEFAULT_ZOOM_THRESHOLD;
    logDebug('MapContainer: raceCourseZoomThreshold computed', { 
      settings, 
      raceCourseValue: settings?.race_course, 
      threshold, 
      default: DEFAULT_ZOOM_THRESHOLD 
    });
    return threshold;
  });
  
  // Get zoom threshold for a specific feature (for logging/debugging)
  const getZoomThreshold = (feature: 'race_course' | 'boats' | 'maneuvers'): number => {
    if (feature === 'boats') return boatsZoomThreshold();
    if (feature === 'maneuvers') return maneuversZoomThreshold();
    if (feature === 'race_course') return raceCourseZoomThreshold();
    return DEFAULT_ZOOM_THRESHOLD;
  };
  
  // Computed signals for visibility based on zoom level - these are now fully reactive
  // Allow boats to show when zoomed out (zoom <= 12) or when zoomed in past threshold
  const showBoats = createMemo(() => currentZoom() <= 12 || currentZoom() >= boatsZoomThreshold());
  const showManeuvers = createMemo(() => currentZoom() >= maneuversZoomThreshold());
  const showRaceCourse = createMemo(() => currentZoom() >= raceCourseZoomThreshold());
  
  // Legacy computed signal for backward compatibility (uses boats threshold)
  const showManeuversAndBoats = createMemo(() => showBoats() && showManeuvers());
  
  // Track zoom changes and log visibility state changes (only when visibility actually changes)
  let lastBoatsVisible = showBoats();
  let lastManeuversVisible = showManeuvers();
  let lastRaceCourseVisible = showRaceCourse();
  
  createEffect(() => {
    const zoom = currentZoom();
    const boatsVisible = showBoats();
    const maneuversVisible = showManeuvers();
    const raceCourseVisible = showRaceCourse();
    
    // Only log when visibility states actually change
    if (boatsVisible !== lastBoatsVisible || 
        maneuversVisible !== lastManeuversVisible || 
        raceCourseVisible !== lastRaceCourseVisible) {
      logDebug('MapContainer: Zoom visibility changed', {
        zoom,
        boatsThreshold: getZoomThreshold('boats'),
        maneuversThreshold: getZoomThreshold('maneuvers'),
        raceCourseThreshold: getZoomThreshold('race_course'),
        boatsVisible,
        maneuversVisible,
        raceCourseVisible,
        boatsChanged: boatsVisible !== lastBoatsVisible,
        maneuversChanged: maneuversVisible !== lastManeuversVisible,
        raceCourseChanged: raceCourseVisible !== lastRaceCourseVisible
      });
      
      lastBoatsVisible = boatsVisible;
      lastManeuversVisible = maneuversVisible;
      lastRaceCourseVisible = raceCourseVisible;
    }
  });
  
  // Get object name from props or use default (e.g. "basics" when opened from explore sidebar)
  const objectName = props?.objectName || 'map_default';
  // Effective overlay: if user has ever applied a choice (including NONE), use stored; else fall back to objectName from sidebar
  const effectiveDataOverlay = (): string => {
    const stored = dataOverlayName();
    const choiceApplied = getStoredOverlayState('dataOverlayChoiceApplied', false);
    if (choiceApplied) return stored ?? '';
    return (stored && stored.trim()) || (sourceMode === 'single' && objectName && objectName !== 'map_default' ? objectName : '');
  };
  const enableTimeWindow = props?.enableTimeWindow || false;
  const sourceMode = props?.sourceMode || 'single';
  const mapFilterScope = props?.mapFilterScope || 'full';
  const liveMode = props?.liveMode || false;
  // Historical data lives in IndexedDB - we query it directly, not through props
  let hasQueriedHistoricalData = false; // Track if we've queried historical data once
  let historicalDataCache: any[] = []; // Cache for historical data (not reactive)
  let lastQueriedSourceIds = new Set<number>(); // Track last queried sources to detect changes
  // Make liveDataSourcesOptions reactive - use filterStore sources when not provided, ordered by source_id
  const liveDataSourcesOptions = createMemo(() => {
    const options = props?.dataSourcesOptions;
    // If provided from props (e.g., live mode), use it
    if (options) {
      return typeof options === 'function' ? options() : options;
    }
    
    // Otherwise, build from filterStore sources (same as PerfSettings uses)
    if (!sourcesStore.isReady()) {
      return [];
    }
    
    const projectSources = sourcesStore.sources();
    if (!projectSources || projectSources.length === 0) {
      return [];
    }
    
    // Sort sources by source_id
    const sortedSources = [...projectSources].sort((a, b) => {
      const aId = Number(a.source_id) || 0;
      const bId = Number(b.source_id) || 0;
      return aId - bId;
    });
    
    // Create options with same structure as live mode
    return sortedSources.map((s) => {
      const id = Number(s.source_id);
      if (!Number.isFinite(id)) {
        return null;
      }
      
      const sourceName = String(s.source_name || '').trim();
      const sourceNameLower = sourceName.toLowerCase().trim();
      
      // Make getter reactive to filterStore changes
      const getter = () => {
        const currentSelected = filterStoreSelectedSources();
        const currentSelectedLower = currentSelected.map((s: any) => String(s).toLowerCase().trim());
        return currentSelectedLower.includes(sourceNameLower);
      };
      const setter = (value: boolean | Set<number>) => {
        const currentSelected = filterStoreSelectedSources();
        const currentSelectedLower = currentSelected.map((s: any) => String(s).toLowerCase().trim());
        const isCurrentlySelected = currentSelectedLower.includes(sourceNameLower);
        
        // Handle Set input (for Select All/None buttons)
        let shouldSelect: boolean;
        if (value instanceof Set) {
          shouldSelect = value.has(id);
        } else {
          shouldSelect = typeof value === 'boolean' ? value : true;
        }
        
        let newSelected: string[];
        if (shouldSelect && !isCurrentlySelected) {
          // Add source
          newSelected = [...currentSelected, sourceName];
        } else if (!shouldSelect && isCurrentlySelected) {
          // Remove source
          newSelected = currentSelected.filter((s: any) => String(s).toLowerCase().trim() !== sourceNameLower);
        } else {
          // No change
          return;
        }
        
        filterStoreSetSelectedSources(newSelected);
        
        // Save to persistent settings immediately (same as PerfSettings)
        const currentUser = user();
        if (currentUser?.user_id) {
          try {
            const { selectedClassName, selectedProjectId } = persistantStore;
            const className = selectedClassName();
            const projectId = selectedProjectId();
            
            if (className && projectId && newSelected.length > 0) {
              persistentSettingsService.saveSettings(
                currentUser.user_id,
                className,
                projectId,
                { fleetPerformanceSources: newSelected }
              ).catch((err: any) => {
                logDebug('MapContainer: Error saving sources to persistent settings:', err);
              });
            }
          } catch (error: unknown) {
            logDebug('MapContainer: Error saving sources to persistent settings:', error as any);
          }
        }
      };
      
      return {
        key: `source-${id}`,
        label: s.source_name || `Source ${id}`,
        type: 'toggle',
        signal: [getter, setter]
      };
    }).filter(opt => opt !== null);
  });

  // Move AbortController inside component scope with better lifecycle management
  let abortController: AbortController = new AbortController();
  let isInitializing = false;
  
  // Flag to prevent brush restoration from triggering brushed function
  let isRestoringBrush = false;
  
  // Flag to prevent infinite loops in handleDataUpdate
  let isUpdatingFromEffect = false;
  
  // Flag to prevent infinite loops when syncing selectedSourceIds from live options
  let isSyncingFromLiveOptions = false;
  let lastSyncedOptionsLength = 0;
  
  // Flag to track if filterStore sources have been initialized (prevents repeated initialization)
  let hasInitializedFilterStoreSources = false;
  let lastProjectId: string | undefined = undefined;

  // Track if initial data has been received
  let hasReceivedInitialData = false;

  // Set initial loading state
  unifiedDataStore.setLoading('map', true);
  
  // Fallback timeout to clear loading state if map fails to load
  let loadingTimeout: ReturnType<typeof setTimeout> | null = null;
  loadingTimeout = setTimeout(() => {
    if (unifiedDataStore.getLoading('map')) {
      logError('Map loading timeout - clearing loading state');
      unifiedDataStore.setLoading('map', false);
    }
    loadingTimeout = null;
  }, 30000); // 30 second timeout

  const [xRange, setRange] = createStore<XRange>({ min: 0, max: 100 });
  const [maptypes] = createSignal<string[]>(["DEFAULT", "GRADE", "WIND", "VMG%", "VMG", "STATE", "PHASE"]);
  
  // Use persistantStore.colorType instead of local signal for consistency across pages
  const { colorType: maptype, setColorType: setMaptype } = persistantStore;
  const { selectedClassName, selectedProjectId, selectedDate, selectedSourceId, setSelectedSourceId, setSelectedSourceName } = persistantStore;

  // Use defaultChannelsStore for channel names (automatically updates when class/project changes)
  const { bspName, twsName, twdName, twaName, latName, lngName, hdgName, sogName, cogName, isReady: defaultChannelsReady } = defaultChannelsStore;
  
  // Log when default channels become ready
  createEffect(() => {
    const ready = defaultChannelsReady();
    const channels = defaultChannelsStore.defaultChannels();
    if (ready && channels) {
      logDebug('MapContainer: Default channels ready', {
        bsp: bspName(),
        tws: twsName(),
        twd: twdName(),
        twa: twaName(),
        lat: latName(),
        lng: lngName(),
        hdg: hdgName(),
        allChannels: channels
      });
    }
  });

  // Fetch zoom settings from class object
  createEffect(async () => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    
    if (!className || !projectId) {
      setZoomSettings(null);
      return;
    }
    
    try {
      // Always fetch from API first to get the latest data (cache might be stale)
      logDebug('MapContainer: Fetching zoom_settings from API', { className, projectId });
      const response = await getData(
        `${apiEndpoints.app.classes}/object?class_name=${encodeURIComponent(className)}&project_id=${projectId}&object_name=zoom_settings`
      );
      
      if (response.success && response.data) {
        logDebug('MapContainer: Loaded zoom_settings from API', {
          rawData: response.data,
          boats: response.data.boats,
          maneuvers: response.data.maneuvers,
          race_course: response.data.race_course
        });
        
        // Handle case where API returns the value directly (not nested)
        let zoomSettingsData: { race_course?: number; boats?: number; maneuvers?: number };
        if (response.data.boats !== undefined || response.data.maneuvers !== undefined || response.data.race_course !== undefined) {
          // Data is already in the expected format
          zoomSettingsData = response.data;
        } else if (response.data.value) {
          // API might return { value: { boats: 12, ... } }
          zoomSettingsData = typeof response.data.value === 'string' ? JSON.parse(response.data.value) : response.data.value;
        } else {
          // Try parsing if it's a string
          zoomSettingsData = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        }
        
        logDebug('MapContainer: Parsed zoom_settings', zoomSettingsData);
        setZoomSettings(zoomSettingsData as { race_course?: number; boats?: number; maneuvers?: number });
        
        // Cache it for future use (non-blocking)
        (async () => {
          try {
            const { huniDBStore } = await import("../../../store/huniDBStore");
            await huniDBStore.storeObject(className, 'zoom_settings', zoomSettingsData);
          } catch (cacheError) {
            logWarn('MapContainer: Failed to cache zoom_settings', cacheError);
          }
        })();
      } else {
        logDebug('MapContainer: zoom_settings not found in API, checking cache', { 
          success: response.success, 
          hasData: !!response.data 
        });
        
        // Fallback to cache if API doesn't have it
        const { huniDBStore } = await import("../../../store/huniDBStore");
        const cached = await huniDBStore.getObject(className, 'zoom_settings');
        
        if (cached && typeof cached === 'object') {
          logDebug('MapContainer: Loaded zoom_settings from HuniDB cache (fallback)', cached);
          setZoomSettings(cached as { race_course?: number; boats?: number; maneuvers?: number });
        } else {
          logDebug('MapContainer: zoom_settings not found in cache either, using defaults');
          setZoomSettings(null);
        }
      }
    } catch (error) {
      logWarn('MapContainer: Error fetching zoom_settings, checking cache', error);
      
      // Fallback to cache on error
      try {
        const { huniDBStore } = await import("../../../store/huniDBStore");
        const cached = await huniDBStore.getObject(className, 'zoom_settings');
        
        if (cached && typeof cached === 'object') {
          logDebug('MapContainer: Loaded zoom_settings from HuniDB cache (error fallback)', cached);
          setZoomSettings(cached as { race_course?: number; boats?: number; maneuvers?: number });
        } else {
          logWarn('MapContainer: Error fetching zoom_settings, using defaults', error);
          setZoomSettings(null);
        }
      } catch (cacheError) {
        logWarn('MapContainer: Error fetching zoom_settings and cache check failed, using defaults', error);
        setZoomSettings(null);
      }
    }
  });

  // Multi-mode: data sources (fleet) selection
  const [availableSources, setAvailableSources] = createSignal<Array<{ source_id: number; source_name: string }>>([]); // [{source_id, source_name}]
  
  // Use filterStore for source selection (consistent with PerfSettings)
  // Convert between source names (filterStore) and source IDs (for API calls)
  const selectedSourceIds = createMemo(() => {
    // In live mode, use selected sources from map settings (liveDataSourcesOptions toggles)
    // This ensures map and table show only the sources the user has selected
    if (liveMode) {
      const liveOptions = liveDataSourcesOptions();
      const ids = new Set<number>();
      for (const opt of liveOptions) {
        if (opt.signal?.[0]?.()) {
          const m = opt.key?.match(/source-(\d+)/);
          if (m) ids.add(Number(m[1]));
        }
      }
      logDebug('[MapContainer] selectedSourceIds (live mode from map settings)', {
        sourceCount: ids.size,
        sourceIds: Array.from(ids)
      });
      return ids;
    }
    
    // In non-live mode, use filterStore (existing behavior)
    const sourceNames = filterStoreSelectedSources();
    const available = availableSources();
    const ids = sourceNames
      .map((name: string) => {
        const source = available.find((s: any) => 
          String(s.source_name).toLowerCase().trim() === String(name).toLowerCase().trim()
        );
        return source?.source_id ? Number(source.source_id) : null;
      })
      .filter((id: number | null): id is number => id !== null && Number.isFinite(id));
    // When no sources are selected but we have sources for the day, default to all so the map shows data (same as races: one "segment" selected)
    if (ids.length === 0 && available.length > 0) {
      const allIds = new Set(available.map((s: any) => Number(s.source_id)).filter((id: number) => Number.isFinite(id)));
      logDebug('[MapContainer] selectedSourceIds empty — defaulting to all sources for map', { count: allIds.size });
      return allIds;
    }
    const result = new Set(ids);
    logDebug('[MapContainer] selectedSourceIds computed (from filterStore)', {
      sourceNames,
      availableCount: available.length,
      mappedIds: Array.from(result),
      resultCount: result.size
    });
    if (result.size === 0 && available.length === 0) {
      logDebug('[MapContainer] selectedSourceIds is empty (no sources loaded yet)', { availableCount: available.length });
    }
    return result;
  });
  
  const setSelectedSourceIds = (ids: Set<number>) => {
    const available = availableSources();
    const sourceNames = Array.from(ids)
      .map((sourceId: number) => {
        const source = available.find((s: any) => Number(s.source_id) === sourceId);
        if (source?.source_name) return source.source_name;
        if (sourcesStore.isReady()) return sourcesStore.getSourceName(sourceId);
        return null;
      })
      .filter((name: string | null | undefined): name is string => !!name);
    filterStoreSetSelectedSources(sourceNames);
  };
  // Multi-only filters (race/leg) to avoid mutating global filterStore
  const [multiSelectedRaces, setMultiSelectedRaces] = createSignal<string[]>([]);
  const [multiSelectedLegs, setMultiSelectedLegs] = createSignal<string[]>([]);
  const normalizeRaceSelection = (races: (number | string)[]): string[] =>
    (Array.isArray(races) ? races : [])
      .filter((race) => race !== null && race !== undefined && String(race).trim() !== '')
      .map((race) => String(race));
  const setNormalizedSelectedRaces = (races: (number | string)[]) => {
    const normalized = normalizeRaceSelection(races);
    if (sourceMode === 'multi') {
      setMultiSelectedRaces(normalized);
    }
    setSelectedRacesTimeseries(normalized);
  };
  // Hovered boat source id (when animation stopped) for path highlight and boat label emphasis
  const [hoveredSourceId, setHoveredSourceId] = createSignal<number | null>(null);
  // Combined highlight: selected boats (from FleetMap click) + hovered when animation stopped
  const highlightedSourceIds = createMemo(() => {
    const selected = props.selectedBoatIds ?? new Set<number>();
    const hovered = hoveredSourceId();
    const playing = isPlaying();
    const addHover = hovered != null && !playing;
    return addHover ? new Set<number>([...selected, hovered]) : new Set<number>(selected);
  });

  /** Key for non-live multi mode track/boat block; when selection changes, keyed Show remounts so layers re-init with correct sources. */
  const multiModeLayersKey = createMemo(() => {
    if (sourceMode !== 'multi' || liveMode) return null;
    return Array.from(selectedSourceIds()).sort().join(',');
  });

  // When selected sources change in fleet map, clear all D3 boat overlays so the keyed block redraws only selected boats
  createEffect(() => {
    if (sourceMode !== 'multi' || liveMode) return;
    const ids = selectedSourceIds();
    // Defer clear so it runs after Apply has committed; clear from document to catch all boat overlays
    requestAnimationFrame(() => {
      try {
        const boats = document.querySelectorAll('[class*="boat-overlay-"]');
        boats.forEach((el) => el.remove());
        if (boats.length > 0) {
          logDebug('MapContainer: Cleared D3 boat overlays on source change', { removed: boats.length, selectedCount: ids.size });
        }
      } catch (e) {
        logDebug('MapContainer: Clear boats skipped', e);
      }
    });
  });

  // Set liveMode flag in playbackStore
  createEffect(() => {
    setLiveMode(liveMode);
  });

  // Track last initialized source IDs to detect changes
  let lastInitializedSourceIds = new Set();
  
  // Initialize streaming store when in live mode with selected sources
  createEffect(() => {
    if (!liveMode) {
      // Clean up streaming store when leaving live mode
      if (streamingStore.isInitialized) {
        logDebug('[MapContainer] Leaving live mode, cleaning up streaming store');
        streamingStore.cleanup();
        lastInitializedSourceIds = new Set();
      }
      return;
    }
    
    if (!config.ENABLE_WEBSOCKETS) {
      const msg = '[MapContainer] WebSockets are disabled in config, skipping streaming store initialization';
      logDebug(msg);
      return;
    }
    
    const sourceIds = selectedSourceIds();
    if (!sourceIds || sourceIds.size === 0) {
      const msg = '[MapContainer] No sources selected, skipping streaming store initialization';
      logDebug(msg);
      return;
    }
    
    // Check if sources changed
    const sourceIdsArray = Array.from(sourceIds);
    const sourcesChanged = 
      lastInitializedSourceIds.size !== sourceIds.size ||
      sourceIdsArray.some(id => !lastInitializedSourceIds.has(id)) ||
      Array.from(lastInitializedSourceIds).some(id => !sourceIds.has(id));
    
    // Initialize or re-initialize if needed
    if (!streamingStore.isInitialized || sourcesChanged) {
      logDebug('[MapContainer] Initializing streaming store for live mode', {
        sourceCount: sourceIds.size,
        sourceIds: sourceIdsArray,
        wasInitialized: streamingStore.isInitialized,
        sourcesChanged
      });
      streamingStore.initialize(sourceIds).catch(err => {
        logError('[MapContainer] Failed to initialize streaming store:', err);
      }).then(() => {
        // Track initialized sources
        lastInitializedSourceIds = new Set(sourceIds);
      });
    }
  });

  // Update availableSources from sourcesStore when project changes (non-live mode only)
  // Multi mode: sync sources so selectedSourceIds and map data work
  createEffect(() => {
    if (liveMode || sourceMode !== 'multi') return;
    
    // Wait for sourcesStore to be ready
    if (!sourcesStore.isReady()) return;
    
    // Track project changes to reset initialization flag
    const currentProjectId = untrack(() => persistantStore.selectedProjectId());
    if (currentProjectId !== lastProjectId) {
      hasInitializedFilterStoreSources = false;
      lastProjectId = currentProjectId;
    }
    
    const projectSources = sourcesStore.sources();
    if (projectSources.length === 0) return;
    
    // Map to format expected by MapContainer and sort by source_id (consistent with FleetPerformanceHistory)
    const sources = projectSources
      .map(s => ({
        source_id: s.source_id,
        source_name: s.source_name,
        dataset_id: null // Will be determined per-date when querying
      }))
      .sort((a, b) => {
        const aId = Number(a.source_id) || 0;
        const bId = Number(b.source_id) || 0;
        return aId - bId;
      });
    
    // Use untrack to read availableSources without creating a reactive dependency
    // This prevents the effect from re-running when availableSources changes
    const currentSources = untrack(() => availableSources());
    const currentIds = new Set(currentSources.map(s => s.source_id));
    const newIds = new Set(sources.map(s => s.source_id));
    
    if (currentIds.size !== newIds.size || 
        Array.from(newIds).some(id => !currentIds.has(id))) {
      logDebug('MapContainer: Updating availableSources from sourcesStore', { 
        count: sources.length,
        sources: sources.map(s => ({ id: s.source_id, name: s.source_name }))
      });
      setAvailableSources(sources);
      
      // Do not default filterStore to "all" when empty — let async onMount load from API (initializeSourceSelections)
      // so persisted fleetPerformanceSources is restored on reload. Only mark initialized when filterStore already has value.
      if (!hasInitializedFilterStoreSources) {
        const filterStoreSources = untrack(() => filterStoreSelectedSources());
        if (filterStoreSources.length > 0) {
          hasInitializedFilterStoreSources = true;
          logDebug('MapContainer: filterStore already has sources, marked initialized', { count: filterStoreSources.length });
        }
      }
    }
  });

  // Single mode (explore map): sync availableSources from sourcesStore so selectedSourceIds and track data work in splitscreen
  createEffect(() => {
    if (liveMode || sourceMode !== 'single') return;
    if (!sourcesStore.isReady()) return;
    const projectSources = sourcesStore.sources();
    if (projectSources.length === 0) return;
    const sources = projectSources
      .map(s => ({ source_id: s.source_id, source_name: s.source_name, dataset_id: null as number | null }))
      .sort((a, b) => (Number(a.source_id) || 0) - (Number(b.source_id) || 0));
    const current = availableSources();
    const same = current.length === sources.length && sources.every((s, i) => current[i]?.source_id === s.source_id);
    if (!same) {
      logDebug('MapContainer: Updating availableSources (single mode) from sourcesStore', { count: sources.length });
      setAvailableSources(sources);
      const filterStoreSources = untrack(() => filterStoreSelectedSources());
      if (filterStoreSources.length === 0) {
        filterStoreSetSelectedSources(sources.map(s => s.source_name));
        logDebug('MapContainer: Initialized filterStore (single mode) with all sources', { count: sources.length });
      }
    }
  });

  // Once we've passed the guard and shown the map, never show Loading again (prevents flash and track loss on re-renders in split view). Must be after availableSources and sourceMode are defined.
  createEffect(() => {
    if (isSourcesReady() && (sourceMode === 'multi' || availableSources().length > 0)) {
      setHasShownMapOnce(true);
    }
  });

  // Note: We do NOT continuously sync from filterStore to selectedSourceIds
  // The initial sync happens when sources are loaded (in the availableSources effect above)
  // After that, selectedSourceIds is managed independently via MapSettings modal
  // This prevents infinite loops between the two stores

  // Sync selectedSourceIds with live options when in live mode
  // Use untrack to prevent reactive loops - we only want to sync when options array changes, not when selectedSourceIds changes
  createEffect(() => {
    if (!liveMode || sourceMode !== 'multi') return;
    if (isSyncingFromLiveOptions) return; // Prevent re-entry
    
    const liveOptions = liveDataSourcesOptions();
    if (liveOptions.length === 0) {
      // If options are empty, don't sync (might be initializing)
      if (lastSyncedOptionsLength === 0) return;
      // If options were cleared, clear selection
      if (lastSyncedOptionsLength > 0) {
        isSyncingFromLiveOptions = true;
        untrack(() => setSelectedSourceIds(new Set()));
        lastSyncedOptionsLength = 0;
        isSyncingFromLiveOptions = false;
      }
      return;
    }
    
    // Only sync if options array length changed (new options added/removed)
    // Don't sync on every selectedSourceIds change
    if (liveOptions.length === lastSyncedOptionsLength) {
      return; // Options haven't changed, skip sync
    }
    
    isSyncingFromLiveOptions = true;
    
    // Extract selected source IDs from live options
    // Use untrack to read signal getters without creating reactive dependencies
    const selectedIds = new Set();
    untrack(() => {
      liveOptions.forEach(option => {
        if (option.signal && option.signal[0]) {
          const isSelected = option.signal[0](); // This reads LiveMap's selectedSourceIds - use untrack to avoid loop
          if (isSelected) {
            // Extract numeric ID from key like "source-1"
            const match = option.key.match(/source-(\d+)/);
            if (match) {
              selectedIds.add(Number(match[1]));
            }
          }
        }
      });
    });
    
    // Update MapContainer's selectedSourceIds if different
    const current = untrack(() => selectedSourceIds());
    if (current.size !== selectedIds.size || !Array.from(selectedIds).every(id => current.has(id))) {
      logDebug('MapContainer: Syncing selectedSourceIds from live options', { 
        oldSize: current.size, 
        newSize: selectedIds.size,
        selectedIds: Array.from(selectedIds),
        optionsLength: liveOptions.length
      });
      untrack(() => setSelectedSourceIds(selectedIds));
    }
    
    lastSyncedOptionsLength = liveOptions.length;
    isSyncingFromLiveOptions = false;
  });
  
  const dataSourcesOptions = createMemo(() => {
    if (sourceMode !== 'multi') return [];
    
    // Use live sources if in live mode and provided
    const liveOptions = liveDataSourcesOptions();
    if (liveMode && liveOptions.length > 0) {
      logDebug('MapContainer: Using live dataSourcesOptions', { count: liveOptions.length });
      return liveOptions;
    }
    
    const setRef = selectedSourceIds();
    logDebug('MapContainer: dataSourcesOptions build', { availableCount: availableSources().length, selected: Array.from(setRef), liveMode });
    return availableSources().map((s) => {
      const id = Number(s.source_id);
      return {
        key: `source-${id}`,
        label: s.source_name,
        type: 'toggle',
        signal: [
          () => selectedSourceIds().has(id),
          (value) => {
            // Support Set input (Select All/None) and boolean toggles
            if (value instanceof Set) {
              setSelectedSourceIds(new Set(Array.from(value).map(Number)));
              return;
            }
            const next = new Set(selectedSourceIds());
            const on = typeof value === 'function' ? value(next.has(id)) : value;
            if (on) next.add(id); else next.delete(id);
            setSelectedSourceIds(next);
          }
        ]
      };
    });
  });
  
  const [twaFilterOptions] = createSignal(["Upwind", "Downwind", "Reaching", "Port", "Stbd"]);

  // Overlay system - initialize on mount
  const [overlaysInitialized, setOverlaysInitialized] = createSignal(false);
  
  // Overlay enabled states - create persistent signals for each overlay
  // Use localStorage to persist overlay preferences
  // Get overlay state from persistent settings or localStorage fallback
  const getStoredOverlayState = (key, defaultValue) => {
    try {
      // First try to get from persistent settings (loaded from API)
      const mapOverlays = persistantStore.mapOverlays?.();
      if (mapOverlays && mapOverlays[key] !== undefined) {
        return mapOverlays[key];
      }
      // Fallback to localStorage for backward compatibility
      const stored = localStorage.getItem(`overlay_${key}`);
      if (stored === null) return defaultValue;
      return JSON.parse(stored);
    } catch {
      return defaultValue;
    }
  };

  // Save overlay state to persistent settings (which syncs to API)
  const setStoredOverlayState = (key, value) => {
    try {
      // Update persistent settings
      const currentOverlays = persistantStore.mapOverlays?.() || {};
      persistantStore.setMapOverlays?.({ ...currentOverlays, [key]: value });
      // Also update localStorage for immediate access
      localStorage.setItem(`overlay_${key}`, JSON.stringify(value));
    } catch (e) {
      logWarn(`Failed to store overlay state for ${key}:`, e);
    }
  };

  // Create signals with initial values from localStorage
  const [tracksEnabled, setTracksEnabledBase] = createSignal(getStoredOverlayState('tracks', true));
  // Track if we're updating from local toggle to prevent feedback loop
  let isTracksLocalUpdate = false;
  const setTracksEnabled = (value) => {
    const newValue = typeof value === 'function' ? value(tracksEnabled()) : value;
    isTracksLocalUpdate = true;
    setTracksEnabledBase(newValue);
    setStoredOverlayState('tracks', newValue);
    // When tracks are disabled, also disable bad air
    if (!newValue && badAirEnabled()) {
      setBadAirEnabledBase(false);
      setStoredOverlayState('bad-air', false);
    }
    // Reset flag after a tick to allow effect to run for external changes
    setTimeout(() => { isTracksLocalUpdate = false; }, 0);
  };

  const [badAirEnabled, setBadAirEnabledBase] = createSignal(getStoredOverlayState('bad-air', false));
  // Track if we're updating from local toggle to prevent feedback loop
  let isBadAirLocalUpdate = false;
  const setBadAirEnabled = (value) => {
    const newValue = typeof value === 'function' ? value(badAirEnabled()) : value;
    // Don't allow enabling bad air if tracks are disabled
    if (newValue && !tracksEnabled()) {
      return;
    }
    isBadAirLocalUpdate = true;
    setBadAirEnabledBase(newValue);
    setStoredOverlayState('bad-air', newValue);
    // Reset flag after a tick to allow effect to run for external changes
    setTimeout(() => { isBadAirLocalUpdate = false; }, 0);
  };

  const [markWindEnabled, setMarkWindEnabledBase] = createSignal(getStoredOverlayState('mark-wind', false));
  let isMarkWindLocalUpdate = false;
  const setMarkWindEnabled = (value) => {
    const newValue = typeof value === 'function' ? value(markWindEnabled()) : value;
    isMarkWindLocalUpdate = true;
    setMarkWindEnabledBase(newValue);
    setStoredOverlayState('mark-wind', newValue);
    setTimeout(() => { isMarkWindLocalUpdate = false; }, 0);
  };

  // Track if persistent settings have been loaded to force re-mount of RaceCourseLayer
  // Declared early so it can be used in createEffect below
  const [persistentSettingsLoaded, setPersistentSettingsLoaded] = createSignal(false);

  // Update tracksEnabled when persistent settings load (but not from local updates)
  createEffect(() => {
    const mapOverlays = persistantStore.mapOverlays?.();
    if (mapOverlays === undefined) return;
    
    // Skip if this is a local update to prevent feedback loop
    if (isTracksLocalUpdate) return;
    
    // Update tracksEnabled if it's defined in persistent settings
    if (mapOverlays['tracks'] !== undefined) {
      const currentValue = tracksEnabled();
      const storedValue = mapOverlays['tracks'];
      if (currentValue !== storedValue) {
        setTracksEnabledBase(storedValue);
        // When tracks are disabled, also disable bad air
        if (!storedValue && badAirEnabled()) {
          setBadAirEnabledBase(false);
          setStoredOverlayState('bad-air', false);
        }
      }
    }
    
    // Mark that persistent settings have been loaded (if not already marked)
    if (!persistentSettingsLoaded()) {
      setPersistentSettingsLoaded(true);
    }
  });

  // Ensure bad air is disabled when tracks are disabled
  createEffect(() => {
    if (!tracksEnabled() && badAirEnabled()) {
      setBadAirEnabledBase(false);
      setStoredOverlayState('bad-air', false);
    }
  });

  // Update badAirEnabled when persistent settings load (but not from local updates)
  createEffect(() => {
    const mapOverlays = persistantStore.mapOverlays?.();
    if (mapOverlays === undefined) return;
    
    // Skip if this is a local update to prevent feedback loop
    if (isBadAirLocalUpdate) return;
    
    // Update badAirEnabled if it's defined in persistent settings
    // But only if tracks are enabled (bad air requires tracks)
    if (mapOverlays['bad-air'] !== undefined && tracksEnabled()) {
      const currentValue = badAirEnabled();
      const storedValue = mapOverlays['bad-air'];
      if (currentValue !== storedValue) {
        setBadAirEnabledBase(storedValue);
      }
    }
    
    // Mark that persistent settings have been loaded (if not already marked)
    if (!persistentSettingsLoaded()) {
      setPersistentSettingsLoaded(true);
    }
  });

  // Update markWindEnabled when persistent settings load (but not from local updates)
  createEffect(() => {
    const mapOverlays = persistantStore.mapOverlays?.();
    if (mapOverlays === undefined) return;
    if (isMarkWindLocalUpdate) return;
    if (mapOverlays['mark-wind'] !== undefined) {
      const currentValue = markWindEnabled();
      const storedValue = mapOverlays['mark-wind'];
      if (currentValue !== storedValue) {
        setMarkWindEnabledBase(storedValue);
      }
    }
  });

  const [boundariesEnabled, setBoundariesEnabledBase] = createSignal(getStoredOverlayState('boundaries', true));
  // Track if we're updating from local toggle to prevent feedback loop
  let isLocalUpdate = false;
  const setBoundariesEnabled = (value) => {
    const newValue = typeof value === 'function' ? value(boundariesEnabled()) : value;
    isLocalUpdate = true;
    setBoundariesEnabledBase(newValue);
    setStoredOverlayState('boundaries', newValue);
    // Reset flag after a tick to allow effect to run for external changes
    setTimeout(() => { isLocalUpdate = false; }, 0);
  };
  
  // Update boundariesEnabled when persistent settings load (but not from local updates)
  createEffect(() => {
    const mapOverlays = persistantStore.mapOverlays?.();
    if (mapOverlays === undefined) return;
    
    // Skip if this is a local update to prevent feedback loop
    if (isLocalUpdate) return;
    
    // Update boundariesEnabled if it's defined in persistent settings
    if (mapOverlays['boundaries'] !== undefined) {
      const currentValue = boundariesEnabled();
      const storedValue = mapOverlays['boundaries'];
      if (currentValue !== storedValue) {
        logDebug('MapContainer: Updating boundariesEnabled from persistent settings', { currentValue, storedValue });
        setBoundariesEnabledBase(storedValue);
      }
    }
    
    // Mark that persistent settings have been loaded (mapOverlays exists means store is initialized)
    if (!persistentSettingsLoaded()) {
      setPersistentSettingsLoaded(true);
    }
  });

  const [windArrowsEnabled, setWindArrowsEnabledBase] = createSignal(getStoredOverlayState('wind-arrows', false));
  const setWindArrowsEnabled = (value) => {
    const newValue = typeof value === 'function' ? value(windArrowsEnabled()) : value;
    setWindArrowsEnabledBase(newValue);
    setStoredOverlayState('wind-arrows', newValue);
  };

  const [currentArrowsEnabled, setCurrentArrowsEnabledBase] = createSignal(getStoredOverlayState('current-arrows', false));
  const setCurrentArrowsEnabled = (value) => {
    const newValue = typeof value === 'function' ? value(currentArrowsEnabled()) : value;
    setCurrentArrowsEnabledBase(newValue);
    setStoredOverlayState('current-arrows', newValue);
  };

  const [windContoursEnabled, setWindContoursEnabledBase] = createSignal(getStoredOverlayState('wind-contours', false));
  const setWindContoursEnabled = (value) => {
    const newValue = typeof value === 'function' ? value(windContoursEnabled()) : value;
    setWindContoursEnabledBase(newValue);
    setStoredOverlayState('wind-contours', newValue);
  };

  const [maneuversEnabled, setManeuversEnabledBase] = createSignal(getStoredOverlayState('maneuvers', true));
  const setManeuversEnabled = (value) => {
    const newValue = typeof value === 'function' ? value(maneuversEnabled()) : value;
    setManeuversEnabledBase(newValue);
    setStoredOverlayState('maneuvers', newValue);
  };

  // Memo for combined maneuvers enabled state (maneuversEnabled && zoom threshold)
  // This prevents creating computations outside reactive context when accessed in setTimeout callbacks
  const maneuversEnabledComputed = createMemo(() => maneuversEnabled() && showManeuvers());

  // Data overlay name (from Data Overlay combo in MapSettings). Empty = NONE; otherwise overlay object_name from user_objects (parent_name 'overlay').
  const [dataOverlayName, setDataOverlayNameBase] = createSignal(getStoredOverlayState('dataOverlayName', ''));
  const setDataOverlayName = (value: string) => {
    const name = typeof value === 'string' ? value.trim() : '';
    setDataOverlayNameBase(name);
    setStoredOverlayState('dataOverlayName', name);
    setStoredOverlayState('dataOverlayChoiceApplied', true);
  };

  // Map dimensions for overlays
  const [mapDimensions, setMapDimensions] = createStore({ width: 1400, height: 900 });
  
  // Track if we're in split view for proper height calculation
  const [isInSplitView, setIsInSplitView] = createSignal(false);
  // Track hover over map area for show-on-hover play/pause controls
  const [isHoveringMap, setIsHoveringMap] = createSignal(false);
  const [isHoveringTimeline, setIsHoveringTimeline] = createSignal(false);
  
  // Check for split view on mount and when component updates.
  // Only update signal when value changes to avoid redundant effect re-runs (reduces stall when split view is open).
  createEffect(() => {
    const checkSplitView = () => {
      const hasSplitViewContent = document.querySelector('.split-view-content') !== null;
      const hasSplitPanel = document.querySelector('.split-panel') !== null;
      const splitViewExists = hasSplitViewContent || hasSplitPanel;
      untrack(() => {
        if (splitViewExists !== isInSplitView()) setIsInSplitView(splitViewExists);
      });
    };

    checkSplitView();
    const rafId = requestAnimationFrame(() => checkSplitView());
    const interval = setInterval(checkSplitView, 1000);
    return () => {
      cancelAnimationFrame(rafId);
      clearInterval(interval);
    };
  });

  // Trigger map resize when split view is detected
  createEffect(() => {
    if (isInSplitView()) {
      const currentMap = map();
      if (currentMap) {
        logDebug('MapContainer: Split view detected, triggering map resize');
        setTimeout(() => {
          triggerMapResize();
        }, 100);
      }
    }
  });
  
  const [values, setValues] = createSignal([]);
  
  // Query IndexedDB for historical data (one-time initialization)
  // Historical data lives in IndexedDB, not in reactive signals
  const queryHistoricalDataFromIndexedDB = async () => {
    if (!liveMode) {
      return; // Only query in live mode
    }
    
    const selected = selectedSourceIds();
    if (selected.size === 0) {
      logDebug('[MapContainer] No sources selected, skipping IndexedDB query');
      return;
    }
    
    // Check if sources have changed - if so, allow re-query
    const sourcesChanged = 
      selected.size !== lastQueriedSourceIds.size ||
      Array.from(selected).some(id => !lastQueriedSourceIds.has(id)) ||
      Array.from(lastQueriedSourceIds).some(id => !selected.has(id));
    
    // Only skip if we've queried AND sources haven't changed
    if (hasQueriedHistoricalData && !sourcesChanged) {
      logDebug('[MapContainer] Historical data already queried for these sources, skipping (historical data lives in IndexedDB)');
      return;
    }

    try {
      const className = untrack(() => persistantStore.selectedClassName());
      const projectId = untrack(() => persistantStore.selectedProjectId());
      // In live mode, always use dataset_id = 0 for queries
      const datasetId = '0';
      
      if (!className) {
        logWarn('[MapContainer] Cannot query IndexedDB without className');
        return;
      }

      logDebug('[MapContainer] Querying IndexedDB mapdata for historical data (one-time initialization)', {
        sourceCount: selected.size,
        className,
        projectId,
        datasetId
      });

      const allMapData = [];
      const selectedArray = Array.from(selected);
      // Get channel names from store (with fallbacks)
      const lat = latName() || 'Lat_dd';
      const lng = lngName() || 'Lng_dd';
      const hdg = hdgName() || 'Hdg';
      const bsp = bspName() || `Bsp_${speedUnitSuffix(persistantStore.defaultUnits())}`;
      const requiredChannels = ['timestamp', 'Datetime', lat, lng, hdg, bsp, 'Maneuver_type'];
      logDebug(`[MapContainer] Using channel names: lat=${lat}, lng=${lng}, hdg=${hdg}, bsp=${bsp}`);

      // Query data for each selected source in parallel for better performance
      const queryPromises = selectedArray.map(async (sourceId) => {
        const sourceName = sourcesStore.getSourceName(sourceId);
        
        if (!sourceName) {
          logDebug(`[MapContainer] Could not get source_name for source_id ${sourceId}, skipping`);
          return [];
        }

        try {
          // Query IndexedDB using fetchDataWithChannelCheckingFromFile which validates channels against file server
          // IMPORTANT: Map uses raw file data, so validate channels against file server
          const sourceData = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
            'map',
            className,
            Number(sourceId || 0),
            requiredChannels,
            {
              projectId: Number(projectId || 0),
              className: className,
              datasetId: Number(datasetId || 0),
              sourceName: sourceName,
              applyGlobalFilters: false // Get all data, no filtering
            },
            'mapdata' // Explicitly request mapdata
          );

          if (sourceData && Array.isArray(sourceData) && sourceData.length > 0) {
            // Sort by datetime (CRITICAL for map rendering)
            const sortedData = [...sourceData].sort((a, b) => {
              const tsA = a.timestamp || (a.Datetime instanceof Date ? a.Datetime.getTime() : new Date(a.Datetime).getTime());
              const tsB = b.timestamp || (b.Datetime instanceof Date ? b.Datetime.getTime() : new Date(b.Datetime).getTime());
              return tsA - tsB;
            });

            // Ensure source_id and source_name are set on each point
            const dataWithSource = sortedData.map(point => ({
              ...point,
              source_id: sourceId,
              source_name: sourceName
            }));

            logDebug(`[MapContainer] Queried ${sortedData.length} points for source "${sourceName}" (source_id: ${sourceId})`);
            return dataWithSource;
          } else {
            logDebug(`[MapContainer] No data found in IndexedDB for source "${sourceName}" (source_id: ${sourceId})`);
            return [];
          }
        } catch (err) {
          logError(`[MapContainer] Error querying IndexedDB for source "${sourceName}" (source_id: ${sourceId}):`, err);
          return [];
        }
      });

      // Wait for all parallel queries to complete
      const queryResults = await Promise.all(queryPromises);
      
      // Combine all results
      for (const result of queryResults) {
        if (Array.isArray(result) && result.length > 0) {
          allMapData.push(...result);
        }
      }

      // Sort all combined data by datetime (CRITICAL)
      allMapData.sort((a, b) => {
        const tsA = a.timestamp || (a.Datetime instanceof Date ? a.Datetime.getTime() : new Date(a.Datetime).getTime());
        const tsB = b.timestamp || (b.Datetime instanceof Date ? b.Datetime.getTime() : new Date(b.Datetime).getTime());
        return tsA - tsB;
      });

      // Store in cache (not reactive signal)
      historicalDataCache = allMapData;
      hasQueriedHistoricalData = true;
      lastQueriedSourceIds = new Set(selected); // Track queried sources
      
      logDebug('[MapContainer] IndexedDB query complete (historical data cached)', {
        totalPoints: allMapData.length,
        sourceCount: selected.size
      });
    } catch (err) {
      logError('[MapContainer] Error querying IndexedDB mapdata:', err);
    }
  };

  // In live mode, MapContainer does NOT query IndexedDB directly
  // MultiMapTimeSeries handles IndexedDB queries and sends data via onMapUpdate
  // No need to watch for source changes here - MultiMapTimeSeries will handle it
  
  // For live mode, data comes from MultiMapTimeSeries via handleDataUpdate (which updates values())
  // MultiMapTimeSeries queries IndexedDB and sends data to MapContainer via onMapUpdate
  const liveValues = createMemo(() => {
    if (!liveMode) return [];
    
    // In live mode, values() is updated by handleDataUpdate when MultiMapTimeSeries sends data
    // MultiMapTimeSeries handles all filtering (sources, races, legs, time window) before sending
    return values();
  });
  
  // Computed values that switches between static and live
  const computedValues = createMemo(() => {
    return liveMode ? liveValues() : values();
  });
  
  // Preserve the last known full-range dataset so we can restore on clear
  const [baseValues, setBaseValues] = createSignal([]);
  
  // Flag to track if filter options have been extracted
  let hasExtractedFilters = false;
  let hasPerformedInitialFit = false; // Track if we've done the initial fit bounds
  let lastHandledFilterSignature: string | undefined = undefined; // Track race/leg filter for zoom-on-filter-change (declared early for createEffect below)
  
  // Compute sampling frequency: fixed 1Hz for non-live data, calculated from timesteps for live data
  const samplingFrequency = createMemo(() => {
    if (liveMode) {
      // For live data: compute from previous timesteps
      const data = computedValues();
      if (data && data.length >= 2) {
        // Get last 2 points to calculate interval
        const last = data[data.length - 1];
        const prev = data[data.length - 2];
        if (last?.Datetime && prev?.Datetime) {
          const intervalMs = new Date(last.Datetime).getTime() - new Date(prev.Datetime).getTime();
          if (intervalMs > 0 && intervalMs < 60000) {
            return 1000 / intervalMs; // Convert ms to Hz
          }
        }
      }
      return 1; // Default fallback for live mode
    } else {
      // Non-live data: fixed at 1Hz
      return 1;
    }
  });
  
  // Store map state for persistence
  const [mapState, setMapState] = createSignal({
    center: [0, 0],
    zoom: 14,
    bearing: 0
  });
  
  // Flag to track if this is the initial map draw
  let isInitialMapDraw = true;
  
  // Track the last data length to detect significant data changes
  let lastDataLength = 0;

  // Add a signal to track map interaction state
  const [isMapMoving, setIsMapMoving] = createSignal(false);
  const [mapMovementTimeout, setMapMovementTimeout] = createSignal(null);
  const [isProgrammaticMovement, setIsProgrammaticMovement] = createSignal(false);

  // Add signal to track playback state before map movement
  const [wasPlayingBeforeMapMove, setWasPlayingBeforeMapMove] = createSignal(false);

  // Add a signal to track the "true" selected time that won't be affected by map operations
  const [stableSelectedTime, setStableSelectedTime] = createSignal(null);

  // Add comprehensive resize detection for responsive map sizing
  let resizeTimeout;
  let resizeObserver = null;
  let mutationObserver = null;
  let tilesAvailabilityTimeout = null; // For cleanup in onCleanup
  
  const triggerMapResize = () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      const currentMap = map();
      const container = mapContainer();
      
      if (currentMap && container) {
        logDebug('🔍 MapContainer: Triggering map resize');
        logDebug('🔍 MapContainer: Container dimensions:', {
          width: container.offsetWidth,
          height: container.offsetHeight,
          clientWidth: container.clientWidth,
          clientHeight: container.clientHeight
        });
        
        // Force map to recalculate its size
        currentMap.resize();
        
        // Log map dimensions after resize
        logDebug('🔍 MapContainer: Map dimensions after resize:', {
          width: currentMap.getContainer().offsetWidth,
          height: currentMap.getContainer().offsetHeight
        });
      }
    }, 100); // Shorter debounce for better responsiveness
  };

  const handleResize = () => {
    triggerMapResize();
  };

  const setupResizeObservers = () => {
    const container = mapContainer();
    if (!container) return;

    // ResizeObserver to watch for container size changes
    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver((entries) => {
        logDebug('🔍 MapContainer: ResizeObserver triggered');
        triggerMapResize();
      });
      resizeObserver.observe(container);
      
      // Also observe split-panel if we're in split view
      const splitPanel = container.closest('.split-panel');
      if (splitPanel) {
        logDebug('🔍 MapContainer: Observing split-panel for resize');
        resizeObserver.observe(splitPanel);
      }
    }

    // MutationObserver to watch for sidebar class changes
    const sidebar = document.querySelector('.sidebar');
    if (sidebar && window.MutationObserver) {
      mutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
            logDebug('🔍 MapContainer: Sidebar class changed, triggering map resize');
            // Add a small delay to allow CSS transition to complete
            setTimeout(triggerMapResize, 350);
          }
        });
      });
      mutationObserver.observe(sidebar, {
        attributes: true,
        attributeFilter: ['class']
      });
    }

    // Fallback: Periodic check for container size changes (every 2 seconds)
    // This ensures we catch any resize events that the observers might miss
    const periodicCheck = setInterval(() => {
      const currentMap = map();
      const currentContainer = mapContainer();
      
      if (currentMap && currentContainer) {
        const mapContainer = currentMap.getContainer();
        const containerWidth = currentContainer.offsetWidth;
        const containerHeight = currentContainer.offsetHeight;
        const mapWidth = mapContainer.offsetWidth;
        const mapHeight = mapContainer.offsetHeight;
        
        // If container size doesn't match map size, trigger resize
        if (Math.abs(containerWidth - mapWidth) > 5 || Math.abs(containerHeight - mapHeight) > 5) {
          logDebug('🔍 MapContainer: Periodic check detected size mismatch, triggering resize');
          triggerMapResize();
        }
      }
    }, 2000);

    // Store interval ID for cleanup
    window.mapPeriodicCheck = periodicCheck;
  };

  // Helper function to create event ID signature for data change detection
  const getEventIdSignature = (data) => {
    if (!data || data.length === 0) return 'empty';
    
    // Count event_id occurrences
    const eventIdCounts = {};
    data.forEach(point => {
      const eventId = point.event_id || 0;
      eventIdCounts[eventId] = (eventIdCounts[eventId] || 0) + 1;
    });
    
    // Create sorted signature of unique event IDs
    const uniqueEventIds = Object.keys(eventIdCounts)
      .filter(id => parseInt(id) > 0)
      .sort((a, b) => parseInt(a) - parseInt(b));
    
    return uniqueEventIds.length > 0 ? uniqueEventIds.join(',') : '0';
  };

  // Smart memo for track data with intelligent update logic
  let lastTrackData = null;
  let lastTrackDataTime = 0;
  let lastDataHash = null;
  let forceTrackDataUpdate = false; // Flag to force track data update
  
  const trackData = createMemo(() => {
    const currentTimeWindow = timeWindow();
    const currentValues = computedValues();
    const now = Date.now();
    
    // Removed frequent trackData memo log - fires on every reactive update
    
    // Always return a new array reference to ensure reactivity
    // This ensures overlays and other consumers get fresh data even if content is similar
    const nextValues = Array.isArray(currentValues) ? [...currentValues] : currentValues;
    
    // If timeWindow is 0 (full timeline), use intelligent update logic
    if (currentTimeWindow === 0) {
      // Create a hash that includes event_id assignments to detect selection changes
      const dataHash = currentValues.length > 0 ? 
        `${currentValues.length}_${currentValues[0]?.Datetime}_${currentValues[currentValues.length - 1]?.Datetime}_${getEventIdSignature(currentValues)}` : 
        'empty';
      
      // Check if data has really changed
      const dataChanged = dataHash !== lastDataHash;
      
      // Check if enough time has passed (2 seconds)
      const timePassed = now - lastTrackDataTime > 2000;
      
      // Removed frequent caching decision log
      
      // In multi-mode, MultiMapTimeSeries already applies race filtering before calling onMapUpdate
      // so we don't need to filter again here - just use the data as-is

      // Update if data really changed OR if 2+ seconds have passed OR if forced
      if (dataChanged || timePassed || forceTrackDataUpdate || !lastTrackData) {
        lastTrackData = nextValues;
        lastTrackDataTime = now;
        lastDataHash = dataHash;
        forceTrackDataUpdate = false; // Reset force flag
        // Only log when data actually changes (not on every memo call)
        if (dataChanged) {
          logDebug('MapContainer: Track data updated', { length: nextValues.length });
        }
        return nextValues;
      }
      
      // Return fresh array reference even if content is the same (ensures reactivity)
      return Array.isArray(lastTrackData) ? [...lastTrackData] : (lastTrackData || nextValues);
    }
    
    // For time windows > 0, follow values changes normally
    // In multi-mode, MultiMapTimeSeries already applies race filtering
    lastTrackData = nextValues;
    lastTrackDataTime = now;
    lastDataHash = nextValues.length > 0 ? 
      `${nextValues.length}_${nextValues[0]?.Datetime}_${nextValues[nextValues.length - 1]?.Datetime}` : 
      'empty';
    return nextValues;
  });

  // When playing with time window, use throttled smooth time for track/wind/bad air (~10fps) to avoid 60fps recompute.
  // Boat uses smoothPlaybackTime() directly at 60fps; track/wind/bad air use this.
  const effectivePlaybackTime = createMemo(() => {
    const currentTimeWindow = timeWindow();
    const currentlyPlaying = isPlaying();
    if (currentTimeWindow === 0 || !currentlyPlaying) return null;
    return smoothPlaybackTimeForTrack();
  });

  // Get time range from cut or brush selection for zoom-to-selection (declared before createEffect that uses getDataForBounds/calculateBounds)
  const getSelectionTimeRange = (): { start: Date; end: Date } | null => {
    const cuts = cutEvents();
    if (Array.isArray(cuts) && cuts.length > 0) {
      const first = cuts[0];
      if (first && typeof first === 'object' && 'start_time' in first && 'end_time' in first) {
        return { start: new Date(first.start_time), end: new Date(first.end_time) };
      }
    }
    const range = selectedRange();
    if (Array.isArray(range) && range.length > 0) {
      const first = range[0];
      if (first && typeof first === 'object' && 'start_time' in first && 'end_time' in first) {
        return { start: new Date(first.start_time), end: new Date(first.end_time) };
      }
    }
    return null;
  };

  const getDataForBounds = (data: any[]): any[] => {
    if (!data || data.length === 0) return data;
    const range = getSelectionTimeRange();
    if (!range) return data;
    const startMs = range.start.getTime();
    const endMs = range.end.getTime();
    return data.filter((point: any) => {
      const dt = point.Datetime;
      if (!dt) return false;
      const t = dt instanceof Date ? dt.getTime() : new Date(dt).getTime();
      return t >= startMs && t <= endMs;
    });
  };

  const calculateBounds = (data: any): [[number, number], [number, number]] | null => {
    if (!data || data.length === 0) {
      logDebug('MapContainer: calculateBounds - no data');
      return null;
    }
    const latField = latName();
    const lngField = lngName();
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    let validPoints = 0;
    data.forEach((point: any) => {
      const lat = point[latField] ?? point[latField?.toLowerCase()] ?? point[latField?.toUpperCase()] ?? point.Lat ?? point.lat ?? point.LAT;
      const lng = point[lngField] ?? point[lngField?.toLowerCase()] ?? point[lngField?.toUpperCase()] ?? point.Lng ?? point.lng ?? point.LNG;
      if (lat != null && lng != null) {
        const latNum = Number(lat);
        const lngNum = Number(lng);
        if (!isNaN(latNum) && !isNaN(lngNum)) {
          minLng = Math.min(minLng, lngNum);
          maxLng = Math.max(maxLng, lngNum);
          minLat = Math.min(minLat, latNum);
          maxLat = Math.max(maxLat, latNum);
          validPoints++;
        }
      }
    });
    logDebug('MapContainer: calculateBounds', { totalPoints: data.length, validPoints, latField, lngField });
    if (minLng === Infinity || maxLng === -Infinity || minLat === Infinity || maxLat === -Infinity || validPoints === 0) {
      logDebug('MapContainer: calculateBounds - no valid coordinates found');
      return null;
    }
    return [[minLng, minLat], [maxLng, maxLat]];
  };

  // Reset initial fit flag and filter signature when class/project/dataset changes
  createEffect(() => {
    const className = persistantStore.selectedClassName?.();
    const projectId = persistantStore.selectedProjectId?.();
    const datasetId = persistantStore.selectedDatasetId?.();
    
    // Reset flag when selection changes so we can fit bounds for new data
    hasPerformedInitialFit = false;
    lastHandledFilterSignature = undefined;
    logDebug('MapContainer: Reset initial fit flag', { className, projectId, datasetId });
  });

  // Auto-fit bounds when map data is first loaded (zoom to selection when cut/brush is active)
  createEffect(() => {
    const currentMap = map();
    const data = trackData();
    const dataForBounds = getDataForBounds(data || []);
    
    // Only fit bounds on first data load when map is ready
    if (currentMap && data && data.length > 0 && !hasPerformedInitialFit) {
      const boundsData = dataForBounds.length > 0 ? dataForBounds : data;
      // Wait for map to be fully loaded
      if (currentMap.loaded()) {
        const bounds = calculateBounds(boundsData);
        if (bounds) {
          logDebug('MapContainer: Auto-fitting bounds on first data load', {
            dataLength: data.length,
            selectionDataLength: dataForBounds.length,
            bounds
          });
          hasPerformedInitialFit = true;
          setIsProgrammaticMovement(true);
          fitBoundsPreservingOrientation(currentMap, bounds, { duration: 1000 });
          setTimeout(() => setIsProgrammaticMovement(false), 1100);
        } else {
          logDebug('MapContainer: Auto-fit failed - calculateBounds returned null');
        }
      } else {
        logDebug('MapContainer: Map not loaded yet, waiting for load event');
        // Wait for map to load
        currentMap.once('load', () => {
          const bounds = calculateBounds(boundsData);
          if (bounds && !hasPerformedInitialFit) {
            logDebug('MapContainer: Auto-fitting bounds after map load', {
              dataLength: data.length,
              selectionDataLength: dataForBounds.length,
              bounds
            });
            hasPerformedInitialFit = true;
            setIsProgrammaticMovement(true);
            fitBoundsPreservingOrientation(currentMap, bounds, { duration: 1000 });
            setTimeout(() => setIsProgrammaticMovement(false), 1100);
          } else if (!bounds) {
            logDebug('MapContainer: Auto-fit after load failed - calculateBounds returned null');
          }
        });
      }
    }
  });

  // Calculate average TWD and TWS for wind arrow
  // Reacts to trackData and selectedTime changes
  const windData = createMemo(() => {
    const data = trackData();
    const currentTime = selectedTime();
    const effectiveTime = effectivePlaybackTime();
    // Use effective time (boat position) when available so wind is at boat, not ahead
    const timeRef = effectiveTime ?? currentTime;

    if (!data || data.length === 0) {
      logDebug('WindArrow: No trackData available');
      return { tws: undefined, twd: undefined };
    }

    // Filter data to points at or before timeRef (never include future points)
    let filteredData = data;
    if (timeRef) {
      // Use a 10 second window ending at timeRef for averaging (past only, no future)
      const windowEnd = timeRef;
      const windowStart = new Date(timeRef.getTime() - 10000); // 10 seconds before

      filteredData = data.filter((point: any) => {
        const pointTime = point.Datetime;
        if (!pointTime) return false;

        const pointDate = pointTime instanceof Date ? pointTime : new Date(pointTime);
        return pointDate >= windowStart && pointDate <= windowEnd;
      });

      // If no data in window, use all data up to timeRef
      if (filteredData.length === 0) {
        filteredData = data.filter((point: any) => {
          const pointTime = point.Datetime;
          if (!pointTime) return false;
          const pointDate = pointTime instanceof Date ? pointTime : new Date(pointTime);
          return pointDate <= timeRef;
        });
      }
    }

    if (filteredData.length === 0) {
      logDebug('WindArrow: No data after filtering', { 
        totalDataLength: data.length, 
        timeRef: timeRef?.toISOString(),
        hasTimeRef: !!timeRef
      });
      return { tws: undefined, twd: undefined };
    }

    // Collect valid TWD and TWS values
    const twdValues: number[] = [];
    const twsValues: number[] = [];
    const twdField = twdName();
    const twsField = twsName();

    filteredData.forEach((point: any) => {
      // TWD: dynamic channel + common variants. TWS: resolve Tws_kts vs Tws_kph like twsValueFromRow, convert to display unit for WindArrow.
      const twd = point[twdField] ?? point[twdField.toLowerCase()] ?? point[twdField.toUpperCase()] ?? point.Twd ?? point.twd ?? point.TWD;
      const tws = twsMagnitudeInDisplayUnit(point as Record<string, unknown>, twsField, persistantStore.defaultUnits());

      if (twd !== undefined && twd !== null && !isNaN(Number(twd))) {
        twdValues.push(Number(twd));
      }
      if (Number.isFinite(tws)) {
        twsValues.push(tws);
      }
    });

    if (twdValues.length === 0 || twsValues.length === 0) {
      // Sample first point to see what fields are available
      const samplePoint = filteredData[0];
      logDebug('WindArrow: No valid TWD/TWS values found', { 
        twdField, 
        twsField,
        filteredDataLength: filteredData.length,
        twdValuesFound: twdValues.length,
        twsValuesFound: twsValues.length,
        samplePointKeys: samplePoint ? Object.keys(samplePoint).filter(k => k.toLowerCase().includes('tw')) : null,
        sampleTwd: samplePoint ? (samplePoint[twdField] ?? samplePoint[twdField.toLowerCase()] ?? samplePoint[twdField.toUpperCase()] ?? samplePoint.Twd ?? samplePoint.twd ?? samplePoint.TWD) : null,
        sampleTws: samplePoint
          ? twsMagnitudeInDisplayUnit(samplePoint as Record<string, unknown>, twsField, persistantStore.defaultUnits())
          : null
      });
      return { tws: undefined, twd: undefined };
    }

    // Calculate mean TWD (circular mean for angles)
    const meanTWD = (() => {
      const sinSum = twdValues.reduce((sum, angle) => sum + Math.sin(angle * (Math.PI / 180)), 0);
      const cosSum = twdValues.reduce((sum, angle) => sum + Math.cos(angle * (Math.PI / 180)), 0);
      const meanAngle = Math.atan2(sinSum, cosSum) * (180 / Math.PI);
      return ((meanAngle % 360) + 360) % 360; // Normalize to 0-360
    })();

    // Calculate mean TWS (linear mean)
    const meanTWS = twsValues.reduce((sum, val) => sum + val, 0) / twsValues.length;

    return { tws: meanTWS, twd: meanTWD };
  });

  // Bearing from saved wind-arrow index (0–4) + current TWD. Index is the single source of truth; we never use saved bearing for orientation.
  const WIND_ROTATION_STORAGE_KEY = 'map_wind_rotation_preference';
  const getBearingFromWindRotationIndex = (twd: number | undefined): number => {
    if (twd === undefined) return 0;
    let index = 0;
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(WIND_ROTATION_STORAGE_KEY);
        if (saved !== null) {
          const v = parseInt(saved, 10);
          if (v >= 0 && v <= 4) index = v;
        }
      }
    } catch {
      // ignore
    }
    let bearing = 0;
    if (index === 1) bearing = twd;
    else if (index === 2) bearing = twd + 90;
    else if (index === 3) bearing = twd + 180;
    else if (index === 4) bearing = twd + 270;
    while (bearing > 180) bearing -= 360;
    while (bearing < -180) bearing += 360;
    return bearing;
  };

  // Apply initial bearing from saved wind-arrow index + current TWD when map and wind are ready.
  let hasAppliedInitialBearing = false;
  createEffect(() => {
    const currentMap = map();
    const wind = windData();
    
    if (hasAppliedInitialBearing || !currentMap || !wind || wind.twd === undefined) {
      return;
    }
    
    try {
      const targetBearing = getBearingFromWindRotationIndex(wind.twd);
      if (targetBearing !== 0) {
        currentMap.easeTo({
          bearing: targetBearing,
          duration: 1000
        });
        logDebug('MapContainer: Applied initial bearing from wind rotation index', {
          twd: wind.twd,
          bearing: targetBearing
        });
      }
      hasAppliedInitialBearing = true;
    } catch (error) {
      logDebug('MapContainer: Error applying initial bearing', error);
    }
  });

  // Separate accumulator for WebSocket data in live mode (for overlays)
  // This avoids modifying values() which triggers many effects
  // Accumulates all WebSocket data points with TWD, TWS, Lat, Lng, Datetime for bad air overlay
  const [accumulatedLiveData, setAccumulatedLiveData] = createSignal([]);
  
  // Subscribe directly to streamingService to accumulate data immediately
  // This ensures we get data before other components clear it from streamingStore
  let accumulatorUnsubscribe = null;
  
  // Set up accumulator subscription when entering live mode
  createEffect(() => {
    // Clean up previous subscription if switching modes
    if (accumulatorUnsubscribe) {
      accumulatorUnsubscribe();
      accumulatorUnsubscribe = null;
    }
    
    // Track logged sources to avoid spam
    const loggedSources = new Set<string>();
    
    if (liveMode) {
      // Subscribe to streamingService directly to get data immediately
      accumulatorUnsubscribe = streamingService.onData((dataPoint) => {
        if (!liveMode) return;
        
        // Extract sourceName and sourceId first (needed for logging and processing)
        const sourceName = dataPoint.source_name || dataPoint.data?.source_name;
        const sourceId = dataPoint.source_id;
        
        // Only log first few data points per source to avoid spam
        if (sourceName && !loggedSources.has(sourceName)) {
          logDebug('[MapContainer] Received first WebSocket data point', {
            source_id: sourceId,
            source_name: sourceName,
            dataKeys: Object.keys(dataPoint.data || {}),
            sampleData: Object.fromEntries(Object.entries(dataPoint.data || {}).slice(0, 5))
          });
          loggedSources.add(sourceName);
        }
        
        // Accumulate data for all sources - filtering by selected sources happens in filteredLiveOverlayData
        // This ensures we have historical data available when sources are selected
        if (!sourceId) {
          logWarn('[MapContainer] Skipping data point: missing source_id', {
            source_name: sourceName,
            dataKeys: Object.keys(dataPoint.data || {})
          });
          return;
        }
        if (!sourceName) {
          logWarn('[MapContainer] Skipping data point: missing source_name', {
            source_id: sourceId,
            dataKeys: Object.keys(dataPoint.data || {})
          });
          return;
        }
        
        // Previous point for this source (carry forward missing channels - no flashing)
        const accData = accumulatedLiveData();
        const prevForSource = accData.filter((p: any) => (p.source_id ?? p.source_name) === sourceId);
        const previousPoint = prevForSource.length > 0
          ? prevForSource.sort((a: any, b: any) => (b.timestamp ?? (b.Datetime?.getTime?.() ?? 0)) - (a.timestamp ?? (a.Datetime?.getTime?.() ?? 0)))[0]
          : null;
        const metaKeys = new Set(['timestamp', 'source_name', 'source_id', 'Datetime', 'datetime']);

        // Create merged point: new values override, missing channels keep previous value
        const mergedPoint: Record<string, unknown> = {
          timestamp: dataPoint.timestamp,
          Datetime: new Date(dataPoint.timestamp),
          datetime: new Date(dataPoint.timestamp),
          source_name: sourceName,
          source_id: sourceId
        };

        for (const [channel, value] of Object.entries(dataPoint.data || {})) {
          if (!metaKeys.has(channel) && value !== undefined && value !== null) {
            mergedPoint[channel] = value;
          }
        }
        if (previousPoint && typeof previousPoint === 'object') {
          for (const [channel, value] of Object.entries(previousPoint)) {
            if (!metaKeys.has(channel) && mergedPoint[channel] === undefined && value !== undefined && value !== null) {
              mergedPoint[channel] = value;
            }
          }
        }
        
        // Ensure Datetime is a Date object
        if (mergedPoint.Datetime && typeof mergedPoint.Datetime === 'string') {
          mergedPoint.Datetime = new Date(mergedPoint.Datetime);
          mergedPoint.datetime = mergedPoint.Datetime;
        }
        
        // Only accumulate if point has Lat/Lng (required for bad air)
        // Check for default channel names (Lat_dd, Lng_dd) - processor outputs these directly
        const latFieldName = latName() || 'Lat_dd';
        const lngFieldName = lngName() || 'Lng_dd';
        const hasLat = !!(mergedPoint[latFieldName] !== undefined && mergedPoint[latFieldName] !== null);
        const hasLng = !!(mergedPoint[lngFieldName] !== undefined && mergedPoint[lngFieldName] !== null);
        
        if (!hasLat || !hasLng) {
          return; // Skip points without coordinates
        }
        
        // Add to accumulator
        const currentData = accumulatedLiveData();
        const existingMap = new Map();
        currentData.forEach(p => {
          const key = `${p.timestamp || (p.Datetime?.getTime?.() || new Date(p.Datetime).getTime())}_${p.source_id || p.source_name}`;
          existingMap.set(key, p);
        });
        
        // Add new point (will replace if duplicate)
        const key = `${mergedPoint.timestamp}_${mergedPoint.source_id || mergedPoint.source_name}`;
        existingMap.set(key, mergedPoint);
        
        // Convert back to array and sort by timestamp
        const merged = Array.from(existingMap.values()).sort((a, b) => {
          const tsA = a.timestamp || (a.Datetime instanceof Date ? a.Datetime.getTime() : new Date(a.Datetime).getTime());
          const tsB = b.timestamp || (b.Datetime instanceof Date ? b.Datetime.getTime() : new Date(b.Datetime).getTime());
          return tsA - tsB;
        });
        
        // Only log summary every 50 points to avoid spam
        if (merged.length % 50 === 0) {
          logDebug('[MapContainer] Accumulated live data', {
            source_name: sourceName,
            totalPoints: merged.length
          });
        }
        
        setAccumulatedLiveData(merged);
      });
    } else {
      // Clear accumulated data when not in live mode
      setAccumulatedLiveData([]);
    }
  });

  onCleanup(() => {
    if (accumulatorUnsubscribe) {
      accumulatorUnsubscribe();
      accumulatorUnsubscribe = null;
    }
    // Clear accumulated data on cleanup
    setAccumulatedLiveData([]);
  });

  // Get live track data for overlays - uses accumulated WebSocket data
  // This is separate from values() to avoid triggering effects
  // NOTE: Must be defined AFTER trackData() to avoid circular dependency
  // Always return a new array reference to ensure SolidJS reactivity
  // Only used in live mode - returns empty array otherwise
  const liveTrackData = createMemo(() => {
    // Early return if not in live mode - don't access accumulatedLiveData at all
    if (!liveMode) {
      return [];
    }
    
    // Access the signal to ensure reactivity - this will track changes
    const data = accumulatedLiveData();
    const selected = selectedSourceIds();
    
    // Force memo to track selectedSourceIds changes too
    Array.from(selected); // Access to track the signal
    
    // Return all accumulated data - no filtering here
    // This ensures we have all the data that LiveTrackLayer has
    // Always return a new array reference (even if empty) to ensure reactivity
    return Array.from(data);
  });

  // Filtered data for overlays in LIVE MODE ONLY
  // Applies same filters as MultiTrackLayer to ensure bad air matches visible tracks
  // Uses untrack to avoid triggering effects when not in live mode
  const filteredLiveOverlayData = createMemo(() => {
    // Only apply filtering in live mode - early return to avoid tracking dependencies
    if (!liveMode) {
      return []; // Return empty in non-live mode (won't be used)
    }

    // Only access live data when in live mode
    const data = liveTrackData();
    if (!data || data.length === 0) {
      return [];
    }

    // Helper to get timestamp from data point
    const getTimestamp = (d) => {
      if (!d) return new Date(0);
      const timestamp = d.Datetime || d.timestamp || d.time || d.datetime;
      if (!timestamp) return new Date(0);
      if (timestamp instanceof Date) return timestamp;
      if (typeof timestamp === 'number') return new Date(timestamp);
      if (typeof timestamp === 'string') {
        const parsed = new Date(timestamp);
        if (!isNaN(parsed.getTime())) return parsed;
      }
      return new Date(0);
    };

    // Helper to get source ID from data point
    const sourceKey = (d) => d?.source_id ?? d?.Source_id ?? d?.sourceId ?? d?.sourceID;

    let filtered = [...data];

    // Apply brush selection filtering first (if active) - same as MultiTrackLayer
    const ranges = selectedRanges();
    const singleRange = selectedRange();
    const hasBrushSelection = (Array.isArray(ranges) && ranges.length > 0) || 
                            (Array.isArray(singleRange) && singleRange.length > 0);
    
    if (hasBrushSelection) {
      const activeRanges = [];
      if (Array.isArray(ranges) && ranges.length > 0) {
        activeRanges.push(...ranges);
      }
      if (activeRanges.length === 0 && Array.isArray(singleRange) && singleRange.length > 0) {
        activeRanges.push(...singleRange);
      }
      
      if (activeRanges.length > 0) {
        filtered = filtered.filter(d => {
          const timestamp = getTimestamp(d);
          const timestampMs = timestamp.getTime();
          
          return activeRanges.some(range => {
            const startTime = range.start_time instanceof Date 
              ? range.start_time.getTime() 
              : new Date(range.start_time).getTime();
            const endTime = range.end_time instanceof Date 
              ? range.end_time.getTime() 
              : new Date(range.end_time).getTime();
            
            return timestampMs >= startTime && timestampMs <= endTime;
          });
        });
      }
    }
    
    // Apply time window filtering (only if no brush selection) - same as MultiTrackLayer
    // NOTE: For bad air overlay in live mode, we need historical data (up to 180 seconds) for wind propagation
    // So we skip time window filtering in live mode - use all accumulated data
    // The bad air overlay will filter by time separation internally (0-180 seconds from origin)
    // In non-live mode, time window filtering is applied by MultiTrackLayer, so we match that behavior
    // But in live mode, we need all accumulated data for bad air calculations
    const currentTime = selectedTime();
    const currentTimeWindow = timeWindow();
    // Skip time window filtering in live mode - bad air needs historical data points
    // (Time window filtering is handled by the overlay itself based on time separation)
    if (false && currentTimeWindow > 0 && currentTime && !hasBrushSelection) {
      // Disabled: Don't apply time window filtering in live mode for overlays
      // Bad air needs up to 180 seconds of historical data for wind propagation calculations
    }

    // Filter by selected sources (same logic as MultiTrackLayer)
    let selected = selectedSourceIds() || new Set();
    
    // If no sources are selected but we have data, default to all sources in the data
    if (selected.size === 0 && filtered.length > 0) {
      const sourcesInData = new Set();
      for (const pt of filtered) {
        const sid = Number(sourceKey(pt));
        if (Number.isFinite(sid)) {
          sourcesInData.add(sid);
        }
      }
      if (sourcesInData.size > 0) {
        selected = sourcesInData;
      } else {
        return [];
      }
    } else if (selected.size === 0) {
      return [];
    }
    
    // Apply source filtering
    if (selected && selected.size > 0) {
      filtered = filtered.filter(pt => {
        const sid = Number(sourceKey(pt));
        return Number.isFinite(sid) && selected.has(sid);
      });
    }

    // Filter out invalid data points (must have coordinates) - same as MultiTrackLayer
    filtered = filtered.filter(d => {
      const lngField = lngName();
      const latField = latName();
      const lng = d[lngField] ?? d[lngField.toLowerCase()] ?? d.Lng_dd;
      const lat = d[latField] ?? d[latField.toLowerCase()] ?? d.Lat_dd;
      return Number.isFinite(lng) && Number.isFinite(lat);
    });

    // Sort data by timestamp to ensure proper chronological order - same as MultiTrackLayer
    filtered.sort((a, b) => {
      const aTime = getTimestamp(a).getTime();
      const bTime = getTimestamp(b).getTime();
      return aTime - bTime;
    });

    return filtered;
  });


  // Helper function to create new abort controller - only reset if not initializing
  const resetAbortController = () => {
    if (!isInitializing) {
      abortController.abort();
      abortController = new AbortController();
    }
  };

  // Data fetching removed - MapTimeSeries is the data controller

  // Initialize map
  const initMap = async () => {
    try {
      logDebug('=== CACHE BUST v6 - initMap called ===');
      
      try {
        logDebug('Attempting to import mapbox-gl...');
        const mapboxModule = await import("mapbox-gl");
        mapboxgl = mapboxModule.default || mapboxModule;
        logDebug('SUCCESS: mapboxgl imported, type:', typeof mapboxgl);
      } catch (importError) {
        logError('FAILED to import mapbox-gl:', importError);
        return;
      }
      
      if (!mapboxgl) {
        logError('mapboxgl is null/undefined after import');
        return;
      }
      
      logDebug('Setting mapbox access token...');
      if (!config.MAPBOX_TOKEN || config.MAPBOX_TOKEN.trim() === '') {
        logError('Mapbox access token is not configured. Please set VITE_MAPBOX_TOKEN in your environment variables.');
        return;
      }
      mapboxgl.accessToken = config.MAPBOX_TOKEN;
      logDebug('Mapbox token set:', config.MAPBOX_TOKEN.substring(0, 10) + '...');
      logDebug('Mapbox style:', config.MAPBOX_STYLE);
      logDebug('Access token set');

      // Wait for mapContainer to be available
      let attempts = 0;
      while (!mapContainer() && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      
      if (!mapContainer()) {
        logError("mapContainer is not set after waiting");
        return;
      }
      
      logDebug('mapContainer is available');

      // Try to restore saved map state from localStorage
      const savedStateKey = `mapState_${objectName}`;
      let savedState = null;
      try {
        const saved = localStorage.getItem(savedStateKey);
        if (saved) {
          savedState = JSON.parse(saved);
        }
      } catch (e) {
        logWarn('Could not parse saved map state:', e);
      }
      logDebug('Saved state:', savedState);

      logDebug('Creating mapbox map...');
      logDebug('Map container element:', mapContainer());
      logDebug('Map container dimensions:', {
        width: mapContainer()?.offsetWidth,
        height: mapContainer()?.offsetHeight,
        clientWidth: mapContainer()?.clientWidth,
        clientHeight: mapContainer()?.clientHeight
      });
      logDebug('Using Mapbox style:', config.MAPBOX_STYLE);
      logDebug('Style check - config.MAPBOX_STYLE:', config.MAPBOX_STYLE);
      logDebug('Style check - trim result:', config.MAPBOX_STYLE?.trim());
      logDebug('Style check - condition result:', (config.MAPBOX_STYLE && config.MAPBOX_STYLE.trim() !== ''));
      
      // Use satellite style without roads for marine/sailing applications
      const customStyle = config.MAPBOX_STYLE && config.MAPBOX_STYLE.trim() !== '' ? config.MAPBOX_STYLE : 'mapbox://styles/mapbox/satellite-v9';
      const selectedStyle = customStyle;
      logDebug('Selected style:', selectedStyle);
      
      // Clear the container before initializing the map (Mapbox requires empty container)
      const container = mapContainer();
      if (container) {
        // Remove all child elements to ensure container is empty
        while (container.firstChild) {
          container.removeChild(container.firstChild);
        }
      }
      
      try {
        const newMap = new mapboxgl.Map({
          container: container,
          // Use user-provided style when available; fall back to default
          style: selectedStyle,
          center: savedState?.center || [-74.006, 40.7128], // Default to New York City
          zoom: savedState?.zoom || 14,
          bearing: 0, // Orientation from wind-arrow index + current TWD (createEffect), not from saved bearing
          pitch: 0,
          antialias: true,
          attributionControl: true
        });

        logDebug('Map created successfully');
        setMap(newMap);

        // Store map reference globally for compatibility
        window.map = newMap;

        // Ensure attribution control is visible (in case style suppressed defaults)
        try {
          newMap.addControl(new mapboxgl.AttributionControl({ compact: false }));
        } catch (e) {
          logWarn('Could not add attribution control explicitly:', e);
        }

        // Add map event listeners
        newMap.on('load', () => {
          logDebug('Map loaded successfully');
          logDebug('Map loaded successfully - tiles should be visible now');
          
          // Enable all map interactions (without visible controls)
          // Disable built-in doubleClickZoom - we use custom handler to fit bounds to data
          newMap.doubleClickZoom.disable();
          newMap.scrollZoom.enable();
          newMap.boxZoom.enable();
          newMap.dragPan.enable();
          newMap.dragRotate.enable();
          newMap.keyboard.enable();
          newMap.touchZoomRotate.enable();
          
          // Setup resize observers after map is loaded
          setupResizeObservers();
          
          // Trigger initial resize to ensure correct sizing, especially in split view
          // Use a small delay to allow DOM to settle
          setTimeout(() => {
            triggerMapResize();
          }, 100);
          
          // Don't clear loading here - wait for data to be received via handleDataUpdate
          // Loading will be cleared when initial data is received
          logDebug('MapContainer: Map initialized, waiting for data...');
          
          // After fitBounds, only clear programmatic flag. Bearing is applied by createEffect from wind-arrow index + current TWD.
          const clearProgrammaticFlag = () => setTimeout(() => setIsProgrammaticMovement(false), 100);

          // Check if we have data to center on immediately after map loads
          const currentValues = values();
          if (currentValues && currentValues.length > 0) {
            logDebug('MapContainer: Map loaded with existing data, centering immediately');
            const boundsData = getDataForBounds(currentValues);
            const dataToFit = boundsData.length > 0 ? boundsData : currentValues;
            const bounds = calculateBounds(dataToFit);
            if (bounds) {
              setIsProgrammaticMovement(true);
              fitBoundsPreservingOrientation(newMap, bounds);
              newMap.once('moveend', clearProgrammaticFlag);
              setTimeout(clearProgrammaticFlag, 200);
            } else {
              clearProgrammaticFlag();
            }
          } else {
            clearProgrammaticFlag();
          }
        });

        // Add double-click handler to fit bounds to all data
        newMap.on('dblclick', (e) => {
          // Stop event propagation to prevent conflicts in split view
          if (e.originalEvent) {
            e.originalEvent.stopPropagation();
            e.originalEvent.preventDefault();
          }
          
          logDebug('MapContainer: Double-click detected');
          
          // Use trackData() instead of values() to get all track data
          const data = trackData();
          logDebug('MapContainer: Double-click - trackData', {
            dataLength: data?.length || 0,
            hasData: !!(data && data.length > 0)
          });
          
          if (data && data.length > 0) {
            const bounds = calculateBounds(data);
            logDebug('MapContainer: Double-click - calculated bounds', { bounds });
            
            if (bounds) {
              logDebug('MapContainer: Double-click - fitting bounds to all track data', {
                bounds,
                padding: 50,
                maxZoom: 16
              });
              setIsProgrammaticMovement(true);
              fitBoundsPreservingOrientation(newMap, bounds, { duration: 1000 });
              setTimeout(() => setIsProgrammaticMovement(false), 1100);
            } else {
              logDebug('MapContainer: Double-click - calculateBounds returned null, cannot fit bounds');
            }
          } else {
            logDebug('MapContainer: Double-click - no track data available');
          }
        });

        newMap.on('error', (e) => {
          logError('Map error:', e);
          logError('Mapbox error details:', e);
        });

        // Track zoom level for visibility control and trigger updates
        // Always update on zoom events - SolidJS signals handle deduplication automatically
        newMap.on('zoom', () => {
          const zoom = newMap.getZoom();
          setCurrentZoom(zoom);
        });

        newMap.on('zoomend', () => {
          const zoom = newMap.getZoom();
          setCurrentZoom(zoom);
          scheduleResumeIfUserMove();
          // Log visibility state after zoom ends for debugging
          logDebug('MapContainer: Zoom ended at', zoom, {
            boatsThreshold: boatsZoomThreshold(),
            maneuversThreshold: maneuversZoomThreshold(),
            raceCourseThreshold: raceCourseZoomThreshold(),
            showBoats: zoom >= boatsZoomThreshold(),
            showManeuvers: zoom >= maneuversZoomThreshold(),
            showRaceCourse: zoom >= raceCourseZoomThreshold()
          });
        });

        // Initialize zoom level
        const initialZoom = newMap.getZoom();
        setCurrentZoom(initialZoom);

        // Helper to compute whether tiles are available (any sources present)
        // Only update if value actually changed to prevent unnecessary re-renders
        let lastTilesAvailable = true;
        const computeTilesAvailability = () => {
          // Debounce to prevent rapid successive calls
          if (tilesAvailabilityTimeout) {
            clearTimeout(tilesAvailabilityTimeout);
          }
          tilesAvailabilityTimeout = setTimeout(() => {
            try {
              const styleObj = newMap.getStyle();
              if (!styleObj || !styleObj.sources) {
                if (lastTilesAvailable !== false) {
                  setTilesAvailable(false);
                  lastTilesAvailable = false;
                }
                return;
              }
              const sourceIds = Object.keys(styleObj.sources || {});
              const available = sourceIds.length > 0;
              // Only update signal if value actually changed
              if (lastTilesAvailable !== available) {
                setTilesAvailable(available);
                lastTilesAvailable = available;
                logDebug('Tiles availability check:', { available, sourceIds });
              }
            } catch (e) {
              if (lastTilesAvailable !== false) {
                setTilesAvailable(false);
                lastTilesAvailable = false;
              }
            }
          }, 100); // Debounce by 100ms
        };

        // Add style load error handler
        newMap.on('style.load', () => {
          logDebug('Map style loaded successfully');
          logDebug('Style name:', newMap.getStyle().name);
          logDebug('Style sources:', Object.keys(newMap.getStyle().sources));
          logDebug('Map center:', newMap.getCenter());
          logDebug('Map zoom:', newMap.getZoom());
          
          // Check style type and provide feedback
          const styleName = newMap.getStyle().name;
          if (styleName === 'Blank') {
            logWarn('⚠️ Blank style detected - switching to satellite style (no roads)');
            newMap.setStyle('mapbox://styles/mapbox/satellite-v9');
          } else if (styleName.includes('Satellite') || styleName.includes('satellite')) {
            logDebug('✅ Satellite style loaded - showing satellite imagery without roads');
          } else {
            logDebug('✅ Style loaded:', styleName);
          }
          
          computeTilesAvailability();
        });

        newMap.on('style.error', (e) => {
          logError('Map style error:', e);
          try {
            const el = mapContainer();
            if (el) el.style.background = '#e5e7eb'; // Tailwind gray-200
          } catch (_) {}
          setTilesAvailable(false);
        });

        // Add data load handler to see when tiles are loaded
        // Note: 'data' event fires very frequently - only log occasionally to avoid spam
        let dataEventCount = 0;
        newMap.on('data', () => {
          dataEventCount++;
          // Only log every 10th event to reduce console spam
          if (dataEventCount % 10 === 0) {
            logDebug('Map data loaded (event #' + dataEventCount + ')');
          }
        });

        // Only check tiles availability when a source actually finishes loading
        // This prevents the infinite loop caused by checking on every intermediate load event
        newMap.on('sourcedata', (e) => {
          // Only log and check when source finishes loading, not on every intermediate event
          if (e.isSourceLoaded) {
            logDebug('Source data loaded:', e.sourceId, e.isSourceLoaded);
            computeTilesAvailability();
          }
        });

        // Debounce resume after zoom/pan so we don't resume on every scroll tick (avoids endless loop)
        let resumeAfterMoveTimeout: ReturnType<typeof setTimeout> | null = null;
        const RESUME_DEBOUNCE_MS = 400;

        const clearResumeTimeout = () => {
          if (resumeAfterMoveTimeout != null) {
            clearTimeout(resumeAfterMoveTimeout);
            resumeAfterMoveTimeout = null;
          }
        };
        (newMap as any)._clearResumeTimeout = clearResumeTimeout;

        const scheduleResumeIfUserMove = () => {
          if (!wasPlayingBeforeMapMove() || isProgrammaticMovement()) return;
          clearResumeTimeout();
          resumeAfterMoveTimeout = setTimeout(() => {
            resumeAfterMoveTimeout = null;
            if (wasPlayingBeforeMapMove() && !isProgrammaticMovement()) {
              setWasPlayingBeforeMapMove(false);
              setIsPlaying(true);
              logDebug('MapContainer: Resuming playback after zoom/pan debounce');
            }
          }, RESUME_DEBOUNCE_MS);
        };

        // Pause playback on any user zoom or pan so animation doesn't fight with interaction
        const pausePlaybackIfUserMove = () => {
          if (isPlaying() && !isProgrammaticMovement()) {
            setWasPlayingBeforeMapMove(true);
            setIsPlaying(false);
            logDebug('MapContainer: Paused playback for zoom/pan');
          }
        };

        newMap.on('movestart', () => {
          setIsMapMoving(true);
          clearResumeTimeout();
          pausePlaybackIfUserMove();
        });

        newMap.on('zoomstart', () => {
          clearResumeTimeout();
          pausePlaybackIfUserMove();
        });

        newMap.on('moveend', () => {
          setIsMapMoving(false);
          scheduleResumeIfUserMove();

          // Don't overwrite saved state when we're programmatically fitting bounds (bearing would be 0)
          if (isProgrammaticMovement()) return;

          // Save map state
          const center = newMap.getCenter();
          const zoom = newMap.getZoom();
          const bearing = newMap.getBearing();
          const mapState = {
            center: [center.lng, center.lat],
            zoom: zoom,
            bearing: bearing
          };
          
          try {
            localStorage.setItem(savedStateKey, JSON.stringify(mapState));
          } catch (e) {
            logWarn('Could not save map state:', e);
          }
        });

        // Note: Double-click handler is already set up above (line ~1752)
        // Removed duplicate handler to avoid conflicts

      } catch (mapError) {
        logError('Error creating map:', mapError);
        // Clear timeout and set loading to false even if map creation fails
        if (loadingTimeout) {
          clearTimeout(loadingTimeout);
          loadingTimeout = null;
        }
        unifiedDataStore.setLoading('map', false);
      }
    } catch (error: any) {
      logError('Error in initMap:', error);
      // Clear timeout and set loading to false even if map initialization fails
      if (loadingTimeout) {
        clearTimeout(loadingTimeout);
        loadingTimeout = null;
      }
      unifiedDataStore.setLoading('map', false);
    }
  };

  // Initialize time synchronization
  const initTime = () => {
    try {
      // Start periodic sync for selectedTime
      startPeriodicSync();
      
      // Set up manual sync
      syncSelectedTimeManual();
      
      logDebug('Time initialization completed');
    } catch (error: any) {
      logError('Error in initTime:', error);
    }
  };

  // Handle data updates from MapTimeSeries
  let lastHandledSignature = null; // Prevent redundant handleDataUpdate loops
  let forceNextUpdate = false; // Bypass dedupe once when needed
  const handleDataUpdate = async (payload) => {
    // MapTimeSeries now consistently sends actual data arrays with event_id already assigned
    const filteredData = Array.isArray(payload) ? payload : [];
    
    if (!Array.isArray(payload)) {
      logWarn('⚠️ MapContainer: Received non-array payload from MapTimeSeries:', payload);
      return;
    }
    
    // CRITICAL: Normalize source_id field before processing to ensure consistency
    // This ensures MultiTrackLayer can properly group tracks by source
    const normalizedData = filteredData.map(pt => {
      // Normalize source_id field name - ensure it's always 'source_id' (lowercase)
      if (pt.sourceId !== undefined && pt.source_id === undefined) {
        pt.source_id = Number(pt.sourceId);
      } else if (pt.Source_id !== undefined && pt.source_id === undefined) {
        pt.source_id = Number(pt.Source_id);
      } else if (pt.sourceID !== undefined && pt.source_id === undefined) {
        pt.source_id = Number(pt.sourceID);
      }
      // Ensure source_id is a number
      if (pt.source_id !== undefined) {
        pt.source_id = Number(pt.source_id);
      }
      return pt;
    });
    
    // Validate that all data points have source_id (for multi-mode track rendering)
    if (sourceMode === 'multi' && normalizedData.length > 0) {
      const pointsWithoutSourceId = normalizedData.filter(pt => 
        !pt.source_id && pt.sourceId === undefined && pt.Source_id === undefined && pt.sourceID === undefined
      );
      
      if (pointsWithoutSourceId.length > 0) {
        logWarn('⚠️ MapContainer: Some data points missing source_id field (multi-mode)', {
          totalPoints: normalizedData.length,
          pointsWithoutSourceId: pointsWithoutSourceId.length,
          sampleMissing: pointsWithoutSourceId[0] ? Object.keys(pointsWithoutSourceId[0]).slice(0, 10) : []
        });
        // Filter out points without source_id to prevent rendering issues
        const validData = normalizedData.filter(pt => 
          pt.source_id !== undefined || pt.sourceId !== undefined || pt.Source_id !== undefined || pt.sourceID !== undefined
        );
        
        if (validData.length !== normalizedData.length) {
          logDebug('MapContainer: Filtered out points without source_id', {
            before: normalizedData.length,
            after: validData.length
          });
        }
        
        // Use validated data for the rest of the function
        // Replace normalizedData with validated data
        normalizedData.length = 0;
        normalizedData.push(...validData);
      }
    }
    
    // Use normalizedData for the rest of the function (or filteredData if no normalization was needed)
    const dataToProcess = (normalizedData && normalizedData.length > 0) ? normalizedData : filteredData;
    
    // Debug: Check if data has event_id assignments
    let eventIdCounts = {};
    if (dataToProcess && dataToProcess.length > 0) {
      dataToProcess.forEach(point => {
        const eventId = point.event_id || 0;
        eventIdCounts[eventId] = (eventIdCounts[eventId] || 0) + 1;
      });
      
      // Only log event_id info if there are points with event_id > 0 (unusual case worth noting)
      const pointsWithEventId = dataToProcess.filter(p => p.event_id > 0);
      if (pointsWithEventId.length > 0) {
        logDebug('🔍 MapContainer: Points with event_id > 0:', pointsWithEventId.length, 'out of', dataToProcess.length);
        logDebug('🔍 MapContainer: Sample points with event_id > 0:', pointsWithEventId.slice(0, 3).map(p => ({ 
          Datetime: p.Datetime, 
          event_id: p.event_id 
        })));
      }
      
      // Extract filter options to populate global filter dropdowns (only on first data load)
      if (!hasExtractedFilters) {
        // Determine the current filter context based on selected state
        const { selectedDatasetId, selectedSourceId, selectedDate } = persistantStore;
        const datasetId = selectedDatasetId?.();
        const sourceId = selectedSourceId?.();
        const date = selectedDate?.();
        
        // Use the same logic as determineFilterContext in unifiedDataStore
        let filterContext: 'dataset' | 'day' | 'fleet' | 'source' = 'fleet';
        if (datasetId && datasetId > 0) {
          filterContext = 'dataset';
        } else if (date && date !== '' && date !== '0' && (!datasetId || datasetId <= 0)) {
          filterContext = 'day';
        } else if (sourceId && sourceId > 0 && (!datasetId || datasetId <= 0)) {
          filterContext = 'source';
        }
        
        logDebug('MapContainer: Extracting filter options with context:', filterContext);
        await extractFilterOptions(dataToProcess, filterContext);
        hasExtractedFilters = true;
      }
      
      // Check if we're showing full timeline (time window = 0)
      const currentTimeWindow = timeWindow();
      const isFullTimeline = currentTimeWindow === 0;
      
      // Center map on initial load, or when there is a cut/brush selection, or when race/leg filter changes (zoom to data)
      const hasRange = Array.isArray(selectedRange()) && selectedRange().length > 0;
      const hasCut = Array.isArray(cutEvents()) && cutEvents().length > 0;
      const hasSelection = hasCut || hasRange;
      const currentFilterSig = sourceMode === 'multi'
        ? JSON.stringify([multiSelectedRaces(), multiSelectedLegs()])
        : JSON.stringify([selectedRacesTimeseries(), selectedLegsTimeseries()]);
      const filterSignatureChanged = lastHandledFilterSignature !== undefined && currentFilterSig !== lastHandledFilterSignature;
      const dataForBounds = getDataForBounds(dataToProcess);
      const boundsData = dataForBounds.length > 0 ? dataForBounds : dataToProcess;
      
      if ((!hasExtractedFilters || hasSelection || filterSignatureChanged) && dataToProcess.length > 0) {
        const bounds = calculateBounds(boundsData);
        if (bounds && map()) {
          const reason = !hasExtractedFilters ? 'on initial data load' : hasSelection ? 'to selection (cut/brush)' : 'to filter (race/leg)';
          logDebug(`MapContainer: Centering map ${reason}`, { boundsDataLength: boundsData.length });
          // Set flag to prevent map movement handlers from interfering with playback
          setIsProgrammaticMovement(true);
          fitBoundsPreservingOrientation(map(), bounds);
          logDebug('Map bounds fitted to track data');
          // Reset flag after a short delay
          setTimeout(() => setIsProgrammaticMovement(false), 100);
          
          // Add a fallback centering attempt in case the first one fails
          setTimeout(() => {
            const currentMap = map();
            if (currentMap && !isInitialMapDraw) {
              const currentCenter = currentMap.getCenter();
              // Check if map is still at default coordinates (New York)
              const isAtDefaultLocation = Math.abs(currentCenter.lng - (-74.006)) < 0.1 && 
                                        Math.abs(currentCenter.lat - 40.7128) < 0.1;
              
                if (isAtDefaultLocation && boundsData.length > 0) {
                logDebug('MapContainer: Fallback centering - map still at default location');
                const fallbackBounds = calculateBounds(boundsData);
                if (fallbackBounds) {
                  setIsProgrammaticMovement(true);
                  fitBoundsPreservingOrientation(currentMap, fallbackBounds);
                  setTimeout(() => setIsProgrammaticMovement(false), 100);
                }
              }
            }
          }, 1000); // 1 second delay for fallback
        }
      } else if (isFullTimeline) {
        // Don't auto-fit bounds for subsequent full timeline updates - let user control map view
      } else {
        // For time windows, fit bounds on first load using selection when present
        if (!hasExtractedFilters) {
          const bounds = calculateBounds(boundsData);
          if (bounds && map()) {
            // Set flag to prevent map movement handlers from interfering with playback
            setIsProgrammaticMovement(true);
            fitBoundsPreservingOrientation(map(), bounds);
            logDebug('Map bounds fitted to track data');
            // Reset flag after a short delay
            setTimeout(() => setIsProgrammaticMovement(false), 100);
          }
        }
      }
      if (dataToProcess.length > 0) {
        lastHandledFilterSignature = currentFilterSig;
      }
    }
    
    // Dedupe: avoid processing identical datasets repeatedly
    // Include event_id distribution, brush state, timeWindow, selectedTime, and source distribution in signature
    // to detect when any of these change (even if data content is the same)
    const eventIdSignature = dataToProcess && dataToProcess.length > 0
      ? Object.keys(eventIdCounts).sort().join(',')
      : '0';
    
    // Include source distribution in signature to detect when data for different sources changes
    let sourceSignature = 'src0';
    if (dataToProcess && dataToProcess.length > 0) {
      const sourceIds = new Set();
      const sourceCounts = new Map();
      for (const d of dataToProcess) {
        const sourceId = d.source_id || d.sourceId;
        if (sourceId !== undefined && sourceId !== null) {
          const sid = Number(sourceId);
          if (Number.isFinite(sid)) {
            sourceIds.add(sid);
            sourceCounts.set(sid, (sourceCounts.get(sid) || 0) + 1);
          }
        }
      }
      // Create signature from sorted source IDs and their counts
      const sortedSourceIds = Array.from(sourceIds).sort((a, b) => a - b);
      const sourceCountsStr = sortedSourceIds.map(sid => `${sid}:${sourceCounts.get(sid)}`).join(',');
      sourceSignature = sortedSourceIds.length > 0 ? `src${sortedSourceIds.join(',')}_cnt${sourceCountsStr}` : 'src0';
    }
    
    // Include brush state in signature so that brush clearing triggers update even if data is the same
    const currentRange = selectedRange();
    const currentRanges = selectedRanges();
    const hasBrushSelection = (Array.isArray(currentRanges) && currentRanges.length > 0) ||
                              (Array.isArray(currentRange) && currentRange.length > 0);
    const brushSignature = hasBrushSelection ? 'brush' : 'nobrush';
    
    // Include timeWindow and selectedTime in signature so that time window changes trigger updates
    const currentTimeWindow = timeWindow();
    const currentSelectedTime = selectedTime();
    const timeWindowSignature = `tw${currentTimeWindow}`;
    const selectedTimeSignature = currentSelectedTime ? `st${currentSelectedTime.getTime()}` : 'st0';
    
    // Check for special timestamp fields that indicate forced updates (brush clear, brush selection, etc.)
    const hasClearTimestamp = dataToProcess && dataToProcess.length > 0 && dataToProcess.some(d => d._clearTimestamp);
    const hasBrushTimestamp = dataToProcess && dataToProcess.length > 0 && dataToProcess.some(d => d._brushTimestamp);
    const forceUpdateFlag = hasClearTimestamp ? '_clear' : hasBrushTimestamp ? '_brush' : '';
    
    const sig = dataToProcess && dataToProcess.length > 0
      ? `${dataToProcess.length}_${dataToProcess[0]?.Datetime}_${dataToProcess[dataToProcess.length - 1]?.Datetime}_${eventIdSignature}_${brushSignature}_${timeWindowSignature}_${selectedTimeSignature}_${sourceSignature}${forceUpdateFlag}`
      : `0_${brushSignature}_${timeWindowSignature}_${selectedTimeSignature}_${sourceSignature}${forceUpdateFlag}`;
    
    if (!forceNextUpdate && sig === lastHandledSignature) {
      return;
    }
    // Reset force flag after bypassing once
    if (forceNextUpdate) {
      forceNextUpdate = false;
    }
    lastHandledSignature = sig;

    // Update local values for chart only if not called from effect to prevent infinite loop
    if (!isUpdatingFromEffect) {
      // Data from MapTimeSeries already has event_id assigned - use it directly
      setValues(dataToProcess);
      
      // If there is no active selection or cut, treat this as the full-range dataset
      const hasRange = Array.isArray(selectedRange()) && selectedRange().length > 0;
      const hasCut = Array.isArray(cutEvents()) && cutEvents().length > 0;
      if (!hasRange && !hasCut) {
        setBaseValues(dataToProcess);
      }
    }
    
    // Clear loading state when we receive initial data (or when data fetch completes, even if empty)
    if (!hasReceivedInitialData) {
      hasReceivedInitialData = true;
      logDebug('MapContainer: Initial data received, waiting for rendering to complete', {
        dataLength: dataToProcess.length,
        hasMap: !!map()
      });
      
      // Clear the loading timeout since data was received
      if (loadingTimeout) {
        clearTimeout(loadingTimeout);
        loadingTimeout = null;
      }
      
      // Wait for simple paint to ensure content is visible before clearing loading state
      // Use simple paint detection instead of complex multi-step wait to avoid blocking
      waitForPaint(2).then(() => {
        logDebug('MapContainer: Paint complete, clearing loading state');
        unifiedDataStore.setLoading('map', false);
      }).catch((error) => {
        logError('MapContainer: Error waiting for paint, clearing loading anyway:', error);
        unifiedDataStore.setLoading('map', false);
      });
    }
  };

  // Effect to center map when data becomes available after map is loaded
  createEffect(() => {
    const currentMap = map();
    const currentValues = values();
    const dataForBounds = getDataForBounds(currentValues || []);
    const boundsData = dataForBounds.length > 0 ? dataForBounds : currentValues;
    
    if (currentMap && currentValues && currentValues.length > 0) {
      // Only center if this is the first data load (hasExtractedFilters is false)
      if (!hasExtractedFilters && boundsData && boundsData.length > 0) {
        logDebug('MapContainer: Data available, centering map on track data');
        const bounds = calculateBounds(boundsData);
        if (bounds) {
          setIsProgrammaticMovement(true);
          fitBoundsPreservingOrientation(currentMap, bounds);
          setTimeout(() => setIsProgrammaticMovement(false), 100);
        }
      }
    }
  });

  // Multi mode: default race selection and keyboard navigation
  // Track the last date and race options to detect changes
  let lastDate = null;
  let lastRaceOptions = null;
  createEffect(() => {
    if (sourceMode !== 'multi') return;
    
    // Use selectedDate from persistantStore as the source of truth for the current date
    // This is the persistent date that's saved and synced across the app
    const currentDate = selectedDate && selectedDate();
    const races = raceOptions();
    
    // Check if date changed or race options changed
    const dateChanged = currentDate !== lastDate;
    const raceOptionsChanged = JSON.stringify(races) !== JSON.stringify(lastRaceOptions);
    
    // If date changed, clear race selection to force re-selection when new races are loaded
    if (dateChanged && lastDate !== null) {
      logDebug('MapContainer: Date changed, clearing race selection', {
        oldDate: lastDate,
        newDate: currentDate
      });
      setMultiSelectedRaces([]);
    }
    
    // Update selected race if:
    // 1. No race is selected, OR
    // 2. Date changed (new day loaded), OR
    // 3. Race options changed and current selection is not in the new options
    if (Array.isArray(races) && races.length > 0) {
      const currentSelected = multiSelectedRaces();
      const currentRace = currentSelected && currentSelected.length > 0 ? currentSelected[0] : null;
      const isCurrentRaceValid = currentRace !== null && races.some((raceOption) => isSameRace(raceOption, currentRace));
      
      if (!currentRace || dateChanged || (raceOptionsChanged && !isCurrentRaceValid)) {
        logDebug('MapContainer: Updating race selection', {
          dateChanged,
          raceOptionsChanged,
          currentDate,
          currentRace,
          isCurrentRaceValid,
          availableRaces: races,
          newSelection: races[0]
        });
        setMultiSelectedRaces([races[0]]);
      }
    }
    
    // Update tracking variables
    lastDate = currentDate;
    lastRaceOptions = races;
  });

  // Persist selected sources whenever they change (multi mode)
  createEffect(async () => {
    if (sourceMode !== 'multi') return;
    const cls = selectedClassName && selectedClassName();
    const proj = selectedProjectId && selectedProjectId();
    const dateStr = selectedDate && selectedDate();
    const setRef = selectedSourceIds();
    if (!cls || !proj || !dateStr || !(setRef instanceof Set)) return;
    try {
      const storeKey = `${cls}_${proj}_${dateStr}`;
      const saved = (await unifiedDataStore.getObject('multi_selected_sources')) || {};
      saved[storeKey] = Array.from(setRef);
      // Store in background (non-blocking)
      unifiedDataStore.storeObject('multi_selected_sources', saved).catch(() => {
        // Ignore errors for non-critical caching
      });
    } catch (_) {}
  });

  onMount(() => {
    if (sourceMode !== 'multi') return;
    const handler = (e) => {
      if (!raceOptions() || raceOptions().length === 0) return;
      const races = raceOptions();
      const current = (multiSelectedRaces() && multiSelectedRaces().length > 0) ? multiSelectedRaces()[0] : races[0];
      const idx = races.findIndex((raceOption) => isSameRace(raceOption, current));
      const resolvedIdx = idx >= 0 ? idx : 0;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        const nextIdx = Math.max(0, resolvedIdx - 1);
        setMultiSelectedRaces([races[nextIdx]]);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const nextIdx = Math.min(races.length - 1, resolvedIdx + 1);
        setMultiSelectedRaces([races[nextIdx]]);
      }
    };
    window.addEventListener('keydown', handler);
    onCleanup(() => window.removeEventListener('keydown', handler));
  });

  // REMOVED: Complex consolidated update effects - MapTimeSeries handles all reactive updates internally

  // Note: triggerUpdate is now handled by MapTimeSeries as the data controller
  // MapContainer receives data updates via onMapUpdate callback

  // Handle point click from map interactions
  const handlePointClick = (point) => {
    if (point && point.Datetime) {
      const time = new Date(point.Datetime);
      logDebug('MapContainer: Map point click - requesting time control');
      
      // Request control of selectedTime
      if (requestTimeControl('map')) {
        setIsManualTimeChange(true); // Set manual change flag for boat animation
        setSelectedTime(time, 'map');
        setStableSelectedTime(time);
        
        // Release time control after setting the time
        setTimeout(() => {
          logDebug('MapContainer: Releasing time control after point click');
          releaseTimeControl('map');
        }, 100);
      } else {
        logDebug('MapContainer: Time control denied - another component has higher priority');
      }
    }
  };

  // Handle range selection from map interactions
  const handleRangeSelect = (startPoint, endPoint) => {
    if (startPoint && endPoint) {
      const startTime = new Date(startPoint.Datetime);
      const endTime = new Date(endPoint.Datetime);
      
      const range = {
        type: "range",
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString()
      };
      
      
      setSelectedRange([range]);
      setHasSelection(true);
      setIsCut(false);
      
      // Filter data for the selected range
      const filteredData = values().filter(d => {
        const timestamp = new Date(d.Datetime);
        return timestamp >= startTime && timestamp <= endTime;
      });
      
      handleDataUpdate(filteredData);
    }
  };

  // Handle boat click: in FleetMap multi mode, click only toggles boat highlight (no time change); otherwise seek time
  const handleBoatClick = (point) => {
    if (sourceMode === 'multi' && props.onToggleBoatSelection && point) {
      const sid = point.source_id ?? point.Source_id ?? point.sourceId;
      if (sid != null && sid !== undefined) {
        props.onToggleBoatSelection(Number(sid));
        return; // only toggle highlight, do not move playhead
      }
    }
    handlePointClick(point);
  };

  // Apply wind-arrow orientation after programmatic fitBounds: bearing from saved index + current TWD.
  const restoreSavedBearing = () => {
    const currentMap = map();
    if (!currentMap) return;
    const apply = () => {
      const m = map();
      if (!m) return;
      const wind = windData();
      const bearing = getBearingFromWindRotationIndex(wind?.twd);
      if (bearing !== 0) {
        m.setBearing(bearing);
      }
    };
    currentMap.once('moveend', apply);
    setTimeout(apply, 150);
  };

  // Fit bounds to selection/data while keeping current map orientation (no rotation).
  // Uses duration: 0 so the map never animates to north-up; we restore bearing/pitch immediately.
  const fitBoundsPreservingOrientation = (
    m: mapboxgl.Map,
    bounds: [[number, number], [number, number]],
    options?: { padding?: number; maxZoom?: number }
  ) => {
    const savedBearing = m.getBearing();
    const savedPitch = m.getPitch();
    m.fitBounds(bounds, { padding: 50, maxZoom: 16, ...options, duration: 0 });
    // Restore orientation next frame so the map never visibly rotates
    requestAnimationFrame(() => {
      m.setBearing(savedBearing);
      m.setPitch(savedPitch);
    });
  };

  onMount(async () => {
    logDebug('MapContainer onMount called');
    
    // Map is registered as active in createEffect above so Dashboard sees it on first render
    // Set that this page uses global filters, not its own filters
    setHasChartsWithOwnFilters(false);
    
    // Default channels are automatically loaded by defaultChannelsStore when class/project changes
    // No need to fetch here - the store handles it reactively
    
    // Initialize overlay system
    initializeOverlays();
    setOverlaysInitialized(true);
    
    // Add resize listener for responsive map sizing
    window.addEventListener('resize', handleResize);
    
    try {
      // Initialize map and time in parallel
      await Promise.all([
        initMap(),
        initTime()
      ]);
      
      logDebug('initMap completed');
      logDebug('initTime completed');
      
      // In live mode, MapContainer does NOT query IndexedDB directly
      // MultiMapTimeSeries queries IndexedDB and sends data to MapContainer via onMapUpdate
      // Historical data flow: LiveMap -> IndexedDB -> MultiMapTimeSeries -> MapContainer
      
      // Update map dimensions after map is initialized
      const container = mapContainer();
      if (container) {
        const canvasContainer = container.querySelector('.mapboxgl-canvas-container');
        if (canvasContainer) {
          const el = canvasContainer;
          setMapDimensions({
            width: el.offsetWidth || 1400,
            height: el.offsetHeight || 900
          });
        }
      }
      
      // Multi mode setup: hide selection banner by setting selectedSourceId=0 and fetch sources list (single-view only).
      // In split view, do NOT run this: the user may brush the map timeseries and we must show the selection banner.
      // Skip source fetching in live mode (sources come from streaming service)
      const inSplitViewNow = typeof document !== 'undefined' && document.querySelector('.split-view-content') != null;
      if (sourceMode === 'multi' && !liveMode && !inSplitViewNow) {
        try {
          // Ensure banner hides while multi-map is active (single view only)
          setSelectedSourceId(0);
          try { setSelectedSourceName('ALL'); } catch (_) {}
        } catch (_) {}

        // Get sources from sourcesStore (single source of truth for project sources)
        try {
          const cls = selectedClassName && selectedClassName();
          const proj = selectedProjectId && selectedProjectId();
          // Use selectedDate from persistantStore as the source of truth
          let dateStr = selectedDate && selectedDate();
          if (!dateStr && typeof window !== 'undefined' && window.datasetDate) {
            const m = String(window.datasetDate).match(/(\d{4})-(\d{2})-(\d{2})|(\d{8})/);
            if (m) {
              if (m[1]) dateStr = `${m[1]}-${m[2]}-${m[3]}`; else dateStr = String(window.datasetDate);
            }
          }
          
          if (cls && proj && dateStr) {
            // Wait for sourcesStore to be ready
            let attempts = 0;
            while (!sourcesStore.isReady() && attempts < 20) {
              await new Promise(resolve => setTimeout(resolve, 100));
              attempts++;
            }
            
            if (sourcesStore.isReady()) {
              const projectSources = sourcesStore.sources();
              // Map to format expected by MapContainer (with dataset_id if needed)
              // Note: dataset_id will be determined when querying data for a specific date
              const sources = projectSources.map(s => ({
                source_id: s.source_id,
                source_name: s.source_name,
                dataset_id: null // Will be determined per-date when querying
              }));
              
              setAvailableSources(sources);
              logDebug('MapContainer: Loaded sources from sourcesStore', { 
                count: sources.length,
                sources: sources.map(s => ({ id: s.source_id, name: s.source_name }))
              });
              
              // Only apply API/default source selection if filterStore is still empty.
              // The multi-mode effect may have already set "all sources" (so FleetDataTable shows all boats).
              // Overwriting that with API (e.g. one saved source) would make the table jump to one source without user action.
              const alreadySet = filterStoreSelectedSources();
              if (alreadySet.length > 0) {
                logDebug('MapContainer: Skipping API source init — filterStore already has selection (e.g. all sources from multi effect)', { count: alreadySet.length });
              } else {
                try {
                  const initialSourceNames = await initializeSourceSelections();
                  const initialIds = initialSourceNames.map(name => {
                    const source = sources.find(s =>
                      String(s.source_name).toLowerCase() === String(name).toLowerCase()
                    );
                    return source ? Number(source.source_id) : null;
                  }).filter((id): id is number => id !== null);
                  if (initialIds.length > 0) {
                    setSelectedSourceIds(new Set(initialIds));
                    hasInitializedFilterStoreSources = true;
                    logDebug('MapContainer: Initialized sources from API', { count: initialIds.length, ids: initialIds });
                  }
                } catch (error) {
                  logWarn('MapContainer: Error initializing sources', error);
                  const firstSix = sources.slice(0, 6).map(s => Number(s.source_id));
                  setSelectedSourceIds(new Set(firstSix));
                  hasInitializedFilterStoreSources = true;
                  logDebug('MapContainer: Defaulted to first 6 sources (error case)', { count: firstSix.length, ids: firstSix });
                }
              }
            } else {
              logWarn('MapContainer: sourcesStore not ready after waiting');
            }
          }
        } catch (e) {
          logWarn('MapContainer: Failed to load sources from sourcesStore', e);
        }

        // Fetch races for multi-mode from /api/datasets/date/races
        try {
          const cls = selectedClassName && selectedClassName();
          const proj = selectedProjectId && selectedProjectId();
          // Use selectedDate from persistantStore as the source of truth
          let dateStr = selectedDate && selectedDate();
          if (!dateStr && typeof window !== 'undefined' && window.datasetDate) {
            const m = String(window.datasetDate).match(/(\d{4})-(\d{2})-(\d{2})|(\d{8})/);
            if (m) {
              if (m[1]) dateStr = `${m[1]}-${m[2]}-${m[3]}`; else dateStr = String(window.datasetDate);
            }
          }
          
          // Normalize date format: convert YYYYMMDD to YYYY-MM-DD if needed
          if (dateStr && dateStr.length === 8 && !dateStr.includes('-')) {
            dateStr = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
          }
          
          if (cls && proj && dateStr) {
            // Preload events for the day into agg.events so MapSettings and filters see races/legs (non-blocking)
            unifiedDataStore.preloadEventsForDate(cls, Number(proj), dateStr).catch(() => {});
            // Clear race options first to prevent using stale data
            setRaceOptions([]);
            setMultiSelectedRaces([]);
            setSelectedRacesTimeseries([]);
            setIsTrainingHourMode(false);
            const timezone = await getTimezoneForDate(cls, Number(proj), dateStr);
            let racesUrl = `${apiEndpoints.app.datasets}/date/races?class_name=${encodeURIComponent(cls)}&project_id=${encodeURIComponent(proj)}&date=${encodeURIComponent(dateStr)}`;
            if (timezone) racesUrl += `&timezone=${encodeURIComponent(timezone)}`;
            logDebug('MapContainer: Fetching races from', racesUrl, 'for date:', dateStr);
            const racesResp = await getData(racesUrl);
            logDebug('MapContainer: Full races response', { success: racesResp?.success, data: racesResp?.data, raw: racesResp, date: dateStr });
            
            const racesList = (racesResp && (racesResp.data || racesResp)) || [];
            logDebug('MapContainer: Races list extracted', { count: racesList.length, sample: racesList[0], all: racesList, date: dateStr });
            
            const hasHour = Array.isArray(racesList) && racesList.some((r: { HOUR?: number | null }) => r?.HOUR !== undefined && r?.HOUR !== null);
            if (hasHour) {
              // Training bins by hour (same as FleetMap and Training Summary)
              const hourKeys = racesList
                .map((r: { HOUR?: number; Race_number?: number }) => (r?.HOUR != null ? String(r.HOUR) : r?.Race_number != null ? String(r.Race_number) : null))
                .filter((k: string | null): k is string => k != null && k !== "");
              const uniqueHours = [...new Set(hourKeys)].sort((a, b) => Number(a) - Number(b));
              logDebug('MapContainer: Training hour options for date', dateStr, { uniqueHours });
              setIsTrainingHourMode(true);
              if (uniqueHours.length > 0) {
                setRaceOptions(uniqueHours);
                if (multiSelectedRaces().length === 0) {
                  const initial = uniqueHours.slice(0, 1);
                  setMultiSelectedRaces(initial);
                  setSelectedRacesTimeseries(initial);
                }
              } else {
                setRaceOptions([]);
              }
            } else {
              // Extract unique race numbers - try all possible field name variations
              const extracted = racesList.map((r: { race_number?: number; Race_number?: number; [key: string]: unknown }) => {
                const raceNum = r.race_number ?? r.Race_number ?? r.racenumber ?? r.RaceNumber ?? r['Race_number'] ?? r.raceNumber;
                if (raceNum === -1 || raceNum === '-1') return 'TRAINING';
                return Number(raceNum);
              }).filter((n: unknown) => n === 'TRAINING' || (Number.isFinite(n) && (n as number) >= -1));
              const uniqueRaces = [...new Set(extracted)].sort((a: unknown, b: unknown) => {
                if (a === 'TRAINING') return -1;
                if (b === 'TRAINING') return 1;
                if (typeof a === 'number' && typeof b === 'number') return a - b;
                return String(a).localeCompare(String(b));
              });
              logDebug('MapContainer: Final race options for date', dateStr, { extracted, uniqueRaces, firstRace: uniqueRaces[0] });
              setIsTrainingHourMode(false);
              if (uniqueRaces.length > 0) {
                setRaceOptions(uniqueRaces.map((r) => (typeof r === 'number' ? String(r) : r)));
                if (multiSelectedRaces().length === 0) {
                  const initial = [(typeof uniqueRaces[0] === 'number' ? String(uniqueRaces[0]) : uniqueRaces[0])];
                  setMultiSelectedRaces(initial);
                  setSelectedRacesTimeseries(initial);
                }
              } else {
                logDebug('MapContainer: No valid races found for date', dateStr);
                setRaceOptions([]);
              }
            }
          } else {
            logDebug('MapContainer: Cannot fetch races - missing params', { cls, proj, dateStr });
          }
        } catch (e) {
          logWarn('MapContainer: Failed to fetch races for multi mode', e);
          setRaceOptions([]);
          setMultiSelectedRaces([]);
          setSelectedRacesTimeseries([]);
          setIsTrainingHourMode(false);
        }

        // In multi mode, defer initial data rendering to MultiMapTimeSeries so race filters apply on first draw
      }

      // Map initialization complete - data will come from MapTimeSeries
      logDebug('Map ready, waiting for data from MapTimeSeries...');
    } catch (error: any) {
      logError('Error in map initialization:', error);
    }
  });

  onCleanup(() => {
    // Unregister is handled by createEffect cleanup; keep releaseTimeControl etc. here
    // Clear resume-after-zoom timeout so it doesn't fire after unmount
    const m = map();
    if (m && (m as any)._clearResumeTimeout) (m as any)._clearResumeTimeout();
    
    // Release time control when component unmounts
    logDebug('🗺️ MapContainer: Releasing time control on cleanup');
    releaseTimeControl('map');
    
    // Do NOT stop playback on unmount: when switching to split view the single map unmounts
    // before the split DOM exists, so we would always stop the timer. Let playback keep
    // running; the panel map will continue to receive updates. Playback is stopped when
    // the user pauses or when the app leaves live/map context elsewhere.
    
    // Clean up loading timeout
    if (loadingTimeout) {
      clearTimeout(loadingTimeout);
      loadingTimeout = null;
      unifiedDataStore.setLoading('map', false);
    }
    
    
    // Clean up resize listener
    window.removeEventListener('resize', handleResize);
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }
    
    // Clean up observers
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    
    // Clean up periodic check
    if (window.mapPeriodicCheck) {
      clearInterval(window.mapPeriodicCheck);
      delete window.mapPeriodicCheck;
    }
    
    // Clean up tiles availability timeout
    if (tilesAvailabilityTimeout) {
      clearTimeout(tilesAvailabilityTimeout);
      tilesAvailabilityTimeout = null;
    }
    
    // Clean up abort controller
    if (abortController) {
      abortController.abort();
    }
    
    // Clean up map
    const currentMap = map();
    if (currentMap) {
      currentMap.remove();
    }
    
    // Clean up global map reference
    if (window.map) {
      delete window.map;
    }
    
    // Clean up global boat icon reference
    if (window.mapBoatIcon) {
      delete window.mapBoatIcon;
    }
    
    // Restore selectedSourceId if we forced it to 0 in multi mode
    try {
      if (sourceMode === 'multi' && typeof selectedSourceId === 'function' && selectedSourceId() === 0) {
        // No-op: let navigation choose new context; do not persist 0 beyond this map
      }
    } catch (_) {}

    // Reset the hasChartsWithOwnFilters flag when leaving the map page
    setHasChartsWithOwnFilters(false);
  })

  return (
    <Show when={hasShownMapOnce() || (isSourcesReady() && (sourceMode === 'multi' || availableSources().length > 0))} fallback={<Loading message="Initializing map..." />}>
    <div class="map-container" style={`display: flex; flex-direction: column; width: 100%; height: 100%; position: relative;`}>
      <MapSettings
        useIconTrigger={true}
        hideAllFilters={liveMode}
        hideColorOptions={sourceMode === 'multi'}
        hideOverlayOptionsLabel={liveMode}
        showRaceAllOption={sourceMode === 'single' && !liveMode}
        useUnfilteredOptions={true}
        filterConfig={mapFilterScope === 'raceLegOnly' ? { showGrades: false, showTWA: false, showRaces: true, showLegs: true } : undefined}
        colorOptions={maptypes()}
        dataSourcesOptions={dataSourcesOptions()}
        displayOptions={[
          // Overlay toggles - connected to overlay registry (Data Overlay is in separate combo below)
          { key: 'overlay-tracks', label: 'Tracks', type: 'toggle', signal: [tracksEnabled, setTracksEnabled], values: [true] },
          { key: 'overlay-maneuvers', label: 'Maneuvers', type: 'toggle', signal: [maneuversEnabled, setManeuversEnabled], values: [true] },
          { key: 'overlay-boundaries', label: 'Marks & Boundaries', type: 'toggle', signal: [boundariesEnabled, setBoundariesEnabled], values: [true] },
          { key: 'overlay-bad-air', label: 'Bad Air', type: 'toggle', signal: [badAirEnabled, setBadAirEnabled], values: [true] },
          { key: 'overlay-mark-wind', label: 'Mark Wind', type: 'toggle', signal: [markWindEnabled, setMarkWindEnabled], values: [true] },
        ]}
        selectedDataOverlay={effectiveDataOverlay}
        onDataOverlayChange={setDataOverlayName}
        isFleetMap={sourceMode === 'multi'}
        dataOverlayParentName={sourceMode === 'multi' ? 'fleet_map' : 'overlay'}
        options={liveMode ? [] : twaFilterOptions()}
        selectedStatesTimeseries={liveMode ? [] : selectedStatesTimeseries()}
        setSelectedStatesTimeseries={liveMode ? () => {} : setSelectedStatesTimeseries}
        raceOptions={liveMode ? [] : raceOptions()}
        setRaceOptions={liveMode ? () => {} : setRaceOptions}
        legOptions={liveMode ? [] : legOptions()}
        setLegOptions={liveMode ? () => {} : setLegOptions}
        gradeOptions={liveMode ? [] : gradeOptions()}
        setGradeOptions={liveMode ? () => {} : setGradeOptions}
        selectedRacesTimeseries={liveMode ? [] : (sourceMode === 'multi' ? multiSelectedRaces() : selectedRacesTimeseries())}
        setSelectedRacesTimeseries={liveMode ? () => {} : setNormalizedSelectedRaces}
        selectedRaces={liveMode ? [] : (sourceMode === 'multi' ? multiSelectedRaces() : selectedRacesTimeseries())}
        setSelectedRaces={liveMode ? () => {} : setNormalizedSelectedRaces}
        selectedLegsTimeseries={liveMode ? [] : (sourceMode === 'multi' ? multiSelectedLegs() : selectedLegsTimeseries())}
        setSelectedLegsTimeseries={liveMode ? () => {} : (sourceMode === 'multi' ? setMultiSelectedLegs : setSelectedLegsTimeseries)}
        selectedLegs={liveMode ? [] : (sourceMode === 'multi' ? multiSelectedLegs() : selectedLegsTimeseries())}
        selectedGradesTimeseries={liveMode ? [] : selectedGradesTimeseries()}
        toggleFilter={(groupIndex, chartIndex, filter) => {
          const currentFilters = selectedStatesTimeseries();
          let newFilters;
          if (currentFilters.includes(filter)) {
            newFilters = currentFilters.filter(f => f !== filter);
          } else {
            newFilters = [...currentFilters, filter];
          }
          setSelectedStatesTimeseries(newFilters);
        }}
        toggleRaceFilter={(race) => {
          const normalizedRace = String(race);
          if (sourceMode === 'multi') {
            setMultiSelectedRaces([normalizedRace]);
            setSelectedRacesTimeseries([normalizedRace]);
          } else {
            const currentRaces = normalizeRaceSelection(selectedRacesTimeseries());
            let newRaces;
            if (currentRaces.some((r) => isSameRace(r, normalizedRace))) {
              newRaces = currentRaces.filter((r) => !isSameRace(r, normalizedRace));
            } else {
              newRaces = [...currentRaces, normalizedRace];
            }
            setSelectedRacesTimeseries(newRaces);
          }
        }}
        toggleLegFilter={(leg) => {
          // Legs are multi-select: toggle in/out. Normalize to string for store consistency.
          const legStr = typeof leg === 'number' ? String(leg) : leg;
          if (sourceMode === 'multi') {
            const current = multiSelectedLegs();
            const exists = current.includes(legStr);
            const next = exists ? current.filter((l) => l !== legStr) : [...current, legStr];
            setMultiSelectedLegs(next);
          } else {
            const currentLegs = selectedLegsTimeseries();
            const exists = currentLegs.includes(legStr);
            const newLegs = exists ? currentLegs.filter((l) => l !== legStr) : [...currentLegs, legStr];
            setSelectedLegsTimeseries(newLegs);
          }
        }}
        toggleGradeFilter={(grade) => {
          const currentGrades = selectedGradesTimeseries();
          let newGrades;
          if (currentGrades.includes(grade)) {
            newGrades = currentGrades.filter(g => g !== grade);
          } else {
            newGrades = [...currentGrades, grade];
          }
          setSelectedGradesTimeseries(newGrades);
        }}
        builderRoute="/overlay-builder"
      />

      {/* Map area: wrapper so overlay controls are not removed when Mapbox clears its container */}
      <div 
        class="map" 
        style="flex: 1; width: 100%; position: relative; min-height: 400px; overflow: hidden;"
        onMouseEnter={() => setIsHoveringMap(true)}
        onMouseLeave={() => setIsHoveringMap(false)}
      >
        {/* Mapbox target: this div is cleared on map init (all children removed); keep nothing else here */}
        <div 
          ref={(el) => {
            setMapContainer(el);
            logDebug('🗺️ Map container ref callback called', { 
              hasElement: !!el, 
              width: el?.offsetWidth, 
              height: el?.offsetHeight,
              sourceMode 
            });
            try {
              if (el) el.style.background = 'var(--color-bg-primary)'; // Use theme-aware background
            } catch (_) {}
          }}
          style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; width: 100%; height: 100%;"
        />
        {/* Overlay: not cleared by Mapbox; stays on top for loading. PlayPause is in the bar above the timeline. */}
        <div class="map-controls-overlay">
          <Show when={unifiedDataStore.getLoading('map') && !liveMode}>
            <Loading message="Loading map data..." />
          </Show>
        </div>
        {/* Debug overlay disabled to reduce console noise during playback */}
        {false && logDebug('🗺️ MapContainer render state:', {
          hasMap: !!map(), 
          valuesLength: values().length,
          sourceMode,
          selectedSourceIdsSize: selectedSourceIds().size,
          multiRaces: multiSelectedRaces(),
          tilesAvailable: tilesAvailable()
        })}
      </div>
      
      {/* Debug loading state - disabled to reduce console noise during playback */}
      {false && logDebug('MapContainer render - loading state:', unifiedDataStore.getLoading('map'))}

      {/* Data Overlay (from MapSettings combo or props when opened from sidebar) - single-source map only; hidden in split view. when=name so keyed callback receives the overlay name; remounts when name changes. */}
      <Show when={sourceMode !== 'multi' && !liveMode && !isInSplitView() && effectiveDataOverlay() ? effectiveDataOverlay() : undefined} keyed>
        {(overlayName) => (
          <Overlay 
            objectName={typeof overlayName === 'function' ? overlayName() : overlayName}
            onDataUpdate={handleDataUpdate}
          />
        )}
      </Show>

      {/* Fleet Data Table overlay - multi (Fleet Map) only; hidden in split view. when=name so keyed callback receives the overlay name; remounts when name changes. */}
      <Show when={sourceMode === 'multi' && !liveMode && !isInSplitView() && effectiveDataOverlay() ? effectiveDataOverlay() : undefined} keyed>
        {(overlayName) => (
          <Suspense fallback={null}>
            <FleetDataTable
              selectedSourceIds={selectedSourceIds}
              objectName={typeof overlayName === 'function' ? overlayName() : overlayName}
              cachedMapData={values}
            />
          </Suspense>
        )}
      </Show>

      {/* Timeline section: chart in its own container; play/pause overlay as sibling so chart SVG rules don't affect control icons */}
      <div
        class="map-timeline-section map-timeline-section-compact"
        style="flex-shrink: 0; width: 100%; display: flex; flex-direction: column; border-top: 1px solid var(--color-border-primary); position: relative; z-index: 20;"
        onMouseEnter={() => setIsHoveringTimeline(true)}
        onMouseLeave={() => setIsHoveringTimeline(false)}
      >
        <div
          ref={(el) => (chartContainer = el)}
          class="chart-container chart-container-compact map-timeline-chart-wrap"
          style="flex-shrink: 0; width: 100%; height: 120px; background: var(--color-bg-card); position: relative;"
        >
          <Show when={sourceMode === 'multi'} fallback={
            <MapTimeSeries
              maptype={maptype()}
              samplingFrequency={samplingFrequency()}
              onMapUpdate={handleDataUpdate}
              onStableSelectedTimeChange={setStableSelectedTime}
              liveMode={liveMode}
              liveData={liveMode ? liveValues : undefined}
              mapFilterScope={mapFilterScope}
            />
          }>
            {liveMode ? (
              <LiveMapTimeSeries
                samplingFrequency={samplingFrequency()}
                onMapUpdate={handleDataUpdate}
                onStableSelectedTimeChange={setStableSelectedTime}
                selectedSourceIds={selectedSourceIds()}
              />
            ) : (
              <MultiMapTimeSeries
                maptype={sourceMode === 'multi' ? 'DEFAULT' : maptype()}
                samplingFrequency={samplingFrequency()}
                onMapUpdate={handleDataUpdate}
                onStableSelectedTimeChange={setStableSelectedTime}
                cachedData={values() || []}
                selectedSourceIds={selectedSourceIds}
                selectedRacesTimeseries={multiSelectedRaces()}
                selectedLegsTimeseries={multiSelectedLegs()}
                highlightedSourceIds={highlightedSourceIds()}
              />
            )}
          </Show>
        </div>
        <div class={`timeline-controls-overlay${isHoveringTimeline() ? " timeline-controls-overlay-visible" : ""}`}>
          <PlayPause position="timeline-overlay" allowFastFwd={true} allowTimeWindow={true} hideFullTimeWindow={sourceMode === 'multi' && isTrainingHourMode()} />
        </div>
      </div>

      {/* New Component Architecture */}
      {/* In live mode, show map even if no data yet (data will stream in) - debug log disabled to reduce playback noise */}
      {false && logDebug('MapContainer: Checking map render condition', {
        hasMap: !!map(),
        liveMode: liveMode,
        computedValuesLength: computedValues().length,
        willRender: !!(map() && (liveMode || computedValues().length > 0))
      })}
      <Show when={map() && (liveMode || computedValues().length > 0) && tracksEnabled()}>
        {sourceMode === 'multi' ? (
          <>
            {liveMode ? (
              <>
                <LiveTrackLayer
                  map={map()}
                  selectedSourceIds={(() => {
                    const ids = selectedSourceIds();
                    logDebug('[MapContainer] Passing selectedSourceIds to LiveTrackLayer', {
                      sourceIds: Array.from(ids),
                      count: ids.size,
                      liveMode,
                      filterStoreSources: filterStoreSelectedSources()
                    });
                    return ids;
                  })()}
                  onPointClick={handlePointClick}
                  pointRadius={4}
                  historicalData={liveMode ? computedValues() : undefined}
                  effectivePlaybackTime={effectivePlaybackTime()}
                  inSplitView={isInSplitView()}
                />
              </>
            ) : (
              <Show when={multiModeLayersKey()} keyed>
                {(_) => (
                  <>
                    <MultiTrackLayer
                      data={trackData()}
                      map={map()}
                      maptype={maptype()}
                      samplingFrequency={samplingFrequency()}
                      tilesAvailable={tilesAvailable()}
                      onPointClick={handlePointClick}
                      onRangeSelect={handleRangeSelect}
                      selectedSourceIds={selectedSourceIds()}
                      enableWebSocketUpdates={false}
                      highlightedSourceIds={highlightedSourceIds()}
                      effectivePlaybackTime={effectivePlaybackTime()}
                    />
                    {/* Only render boats when map and mapContainer are available and zoom level is sufficient */}
                    <Show when={map() && mapContainer() && showBoats()}>
                      <MultiBoatLayer
                        key={`multi-boat-${showBoats()}-${Array.from(selectedSourceIds()).sort().join(',')}`}
                        data={trackData()}
                        map={map()}
                        mapContainer={mapContainer()}
                        samplingFrequency={samplingFrequency()}
                        onBoatClick={handleBoatClick}
                        selectedSourceIds={selectedSourceIds}
                        hoveredSourceId={hoveredSourceId()}
                        onBoatHover={setHoveredSourceId}
                        highlightedSourceIds={highlightedSourceIds()}
                      />
                    </Show>
                  </>
                )}
              </Show>
            )}
            {/* Live multi: boats (track layer already rendered above) */}
            <Show when={liveMode && map() && mapContainer() && showBoats()}>
              <LiveMultiBoatLayer
                key={`live-multi-boat-${showBoats()}`}
                map={map()}
                mapContainer={mapContainer()}
                samplingFrequency={samplingFrequency()}
                onBoatClick={handleBoatClick}
                selectedSourceIds={selectedSourceIds()}
                inSplitView={isInSplitView()}
              />
            </Show>
          </>
        ) : (
          <>
            {/* Only render TrackLayer when sourcesStore is ready to prevent color flickering */}
            <Show when={tracksEnabled() && sourcesStore.isReady()}>
              <TrackLayer
                key={`track-${maneuversEnabledComputed()}-${showManeuvers()}`}
                data={trackData()}
                map={map()}
                maptype={maptype()}
                samplingFrequency={samplingFrequency()}
                tilesAvailable={tilesAvailable()}
                onPointClick={handlePointClick}
                onRangeSelect={handleRangeSelect}
                showGaps={true}
                maneuversEnabled={maneuversEnabledComputed()}
                zoomLevel={currentZoom()}
                effectivePlaybackTime={effectivePlaybackTime()}
              />
            </Show>
            <Show when={map() && mapContainer() && showBoats()}>
              <BoatLayer
                key={`boat-${showBoats()}`}
                data={trackData()}
                map={map()}
                mapContainer={mapContainer()}
                samplingFrequency={samplingFrequency()}
                onBoatClick={handleBoatClick}
              />
            </Show>
          </>
        )}

        {/* Selection Layer - Handles click-between-points selection */}
        <SelectionLayer
          data={trackData()}
          map={map()}
          onRangeSelect={handleRangeSelect}
          onPointClick={handlePointClick}
          showSelectionFeedback={true}
        />
      </Show>

      {/* Race Course Layer - Renders boundaries and marks */}
      {/* Use key to force re-mount when boundariesEnabled or context changes; do NOT include persistentSettingsLoaded
          so we don't remount when settings load from API (which would kill the layer mid-init and require toggle to see it) */}
      {/* Only mount when map, boundariesEnabled, and required parameters are available */}
      {/* In single mode: requires className, projectId, and (datasetId OR selectedDate) */}
      {/* In multi mode: datasetId is 0, so RaceCourseLayer will find the correct dataset_id by date */}
      {/* In live mode: allow mounting even without datasetId or selectedDate (will use today's date as fallback) */}
      {/* RaceCourseLayer - keep mounted, control visibility via prop */}
      {map() && 
       boundariesEnabled() && 
       persistantStore.selectedClassName?.() && 
       persistantStore.selectedProjectId?.() !== undefined && 
       persistantStore.selectedProjectId?.() !== null &&
       (liveMode || persistantStore.selectedDatasetId?.() || persistantStore.selectedDate?.()) && (
        <>
          <RaceCourseLayer 
            key={`race-course-${boundariesEnabled()}-${persistantStore.selectedClassName?.() || ''}-${persistantStore.selectedProjectId?.() || 0}-${persistantStore.selectedDatasetId?.() || 0}-${(persistantStore.selectedDate?.() || '').toString().replace(/[-/]/g, '')}`} 
            map={map()}
            visible={showRaceCourse()}
          />
        </>
      )}

      {/* Wind Arrow - Shows wind direction and speed; color bar matches track maptype (same as TrackLayer / MultiTrackLayer) */}
      <Show when={map()}>
        <WindArrow
          map={map()}
          tws={windData().tws}
          twd={windData().twd}
          maptype={maptype()}
          trackData={trackData()}
          selectedTime={selectedTime()}
          objectName={objectName}
        />
      </Show>

      {/* Overlay Manager - Manages all overlay layers (enabled in both live and non-live mode) */}
      <Show when={map() && overlaysInitialized() && mapContainer()}>
        <OverlayManager
          map={map()}
          mapContainer={mapContainer()}
          data={liveMode ? filteredLiveOverlayData() : (trackData() || [])}
          liveMode={liveMode}
          width={mapDimensions.width}
          height={mapDimensions.height}
          effectivePlaybackTime={effectivePlaybackTime()}
          samplingFrequency={samplingFrequency()}
          enabledStates={{
            'bad-air': { get: badAirEnabled, set: setBadAirEnabled },
            'mark-wind': { get: markWindEnabled, set: setMarkWindEnabled },
          }}
        />
      </Show>

      {/* Tooltip - Positioned relative to viewport */}
      <div
        id="tt"
        class="tooltip map-tooltip"
        style={{
          position: 'fixed',
          opacity: tooltip().visible ? 1 : 0,
          left: `${tooltip().x + 10}px`,
          top: `${tooltip().y - 10}px`,
          pointerEvents: 'none',
          zIndex: 9999
        }}
        innerHTML={tooltip().content}
      ></div>
    </div>
    </Show>
  );
}