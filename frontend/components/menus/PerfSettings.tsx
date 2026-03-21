import { createSignal, createEffect, Show, onMount, For, createMemo } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import { FiSettings } from "solid-icons/fi";
import { sidebarState } from "../../store/globalStore";
import { startDate, endDate, setStartDate, setEndDate, initializeDateRange, raceOptions, legOptions, selectedRacesAggregates, selectedLegsAggregates, setSelectedRacesAggregates, setSelectedLegsAggregates, setSelectedStatesAggregates, setSelectedGradesAggregates } from "../../store/filterStore";
import { info, log, debug as logDebug, error as logError } from "../../utils/console";
import { getData, postData } from "../../utils/global";
import { apiEndpoints } from "@config/env";
import { user } from "../../store/userStore";
import { persistantStore } from "../../store/persistantStore";
import { persistentSettingsService } from "../../services/persistentSettingsService";
import { defaultChannelsStore } from "../../store/defaultChannelsStore";
import { sourcesStore } from "../../store/sourcesStore";
import { huniDBStore } from "../../store/huniDBStore";
import { unifiedDataStore } from "../../store/unifiedDataStore";
import { escapeTableName, TableNames } from "../../store/huniDBTypes";
import { setRaceOptions, setLegOptions } from "../../store/filterStore";
import { getRaceAndLegOptions } from "../../services/raceLegOptionsService";
import { isSameRace, formatRaceForDisplay } from "../../utils/raceValueUtils";

interface PerfSettingsProps {
  colorOptions?: string[];
  selectedColor?: string | (() => string);
  selectedXAxis?: string | (() => string);
  selectedCloudData?: string | (() => string);
  selectedPlotType?: string | (() => string);
  showDataTable?: boolean; // Show "Data Table" option in plot type (for fleet pages)
  filterGrades?: string | (() => string);
  filterYear?: string | (() => string);
  filterEvent?: string | (() => string);
  filterConfig?: string | (() => string);
  filterState?: string | (() => string);
  // Legacy props - kept for backward compatibility but deprecated
  sources?: any[];
  filterSources?: number[] | (() => number[]);
  onFilterSourcesChange?: (sources: number[]) => void;
  // New dataSourcesOptions pattern (preferred)
  dataSourcesOptions?: Array<{
    key?: string;
    label?: string;
    name?: string;
    signal?: [() => boolean, (value: boolean) => void];
  }>;
  onColorChange?: (color: string) => void;
  onXAxisChange?: (axis: string) => void;
  onCloudDataChange?: (data: string) => void;
  onPlotTypeChange?: (plotType: string) => void;
  onFilterGradesChange?: (grades: string) => void;
  onFilterYearChange?: (year: string) => void;
  onFilterEventChange?: (event: string) => void;
  onFilterConfigChange?: (config: string) => void;
  onFilterStateChange?: (state: string) => void;
  setRaceOptions?: (races: (string | number)[]) => void;
  setLegOptions?: (legs: number[]) => void;
  // Local TRAINING/RACING filter callbacks (for history mode) - these filters are local to the page, not in filterStore
  selectedTrainingRacing?: 'TRAINING' | 'RACING' | null | (() => 'TRAINING' | 'RACING' | null);
  onTrainingRacingFilterChange?: (type: 'TRAINING' | 'RACING' | null) => void;
  // Timeline visibility
  showTimeline?: () => boolean;
  onTimelineChange?: (value: boolean) => void;
  [key: string]: any;
}

export default function PerfSettings(props: PerfSettingsProps) {
  const [showPopup, setShowPopup] = createSignal(false);
  let navigate: (path: string) => void;
  
  try {
    navigate = useNavigate();
  } catch (error: any) {
    // Router not available, use fallback
    navigate = () => {
      log('PerfSettings: Router not available - navigation disabled');
    };
  }

  // Use defaultChannelsStore for channel names
  const { twsName, bspName } = defaultChannelsStore;
  
  // Helper to check if user is a reader
  const isReader = (): boolean => {
    const currentUser = user();
    if (!currentUser) return false;
    
    const userPermissions = currentUser.permissions;
    const permission = Array.isArray(userPermissions) ? userPermissions[0] : userPermissions;
    return permission === 'reader';
  };
  
  // Get current values from props or use defaults
  const colorOptions = (): string[] => props.colorOptions || ['TACK', 'MAINSAIL', 'HEADSAIL', 'GRADE'];
  const selectedColor = (): string => {
    const value = (props.selectedColor && typeof props.selectedColor === 'function') ? props.selectedColor() : (props.selectedColor || 'TACK');
    return value;
  };
  // Normalize X-Axis to capitalized form for comparison (stored as lowercase in state)
  const selectedXAxis = (): string => {
    const value = (props.selectedXAxis && typeof props.selectedXAxis === 'function') ? props.selectedXAxis() : (props.selectedXAxis || twsName());
    // Normalize: convert to match store values
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      const twsLower = twsName().toLowerCase();
      const bspLower = bspName().toLowerCase();
      if (lower === twsLower) return twsName();
      if (lower === bspLower) return bspName();
      // Fallback to original normalization for other values
      return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    }
    return value;
  };
  // Use a signal to track the selected cloud data value, updated via effect
  // Initialize with the current prop value
  const getInitialValue = (): string => {
    const value = (props.selectedCloudData && typeof props.selectedCloudData === 'function') ? props.selectedCloudData() : (props.selectedCloudData || '1Hz Scatter');
    return value === 'Latest' ? '1Hz Scatter' : value;
  };
  const [selectedCloudDataValue, setSelectedCloudDataValue] = createSignal<string>(getInitialValue());
  
  // Update the signal when the prop changes
  // We need to call the prop function inside the effect to track the signal it reads
  createEffect(() => {
    if (props.selectedCloudData && typeof props.selectedCloudData === 'function') {
      // Call the prop function - this will track the cloudType() signal in Performance.jsx
      const value = props.selectedCloudData();
      // Map "Latest" to "1Hz Scatter" for comparison
      const result = value === 'Latest' ? '1Hz Scatter' : value;
      logDebug('PerfSettings: createEffect - selectedCloudData updated:', result, 'from prop value:', value);
      setSelectedCloudDataValue(result);
    } else {
      const value = props.selectedCloudData || '1Hz Scatter';
      const result = value === 'Latest' ? '1Hz Scatter' : value;
      setSelectedCloudDataValue(result);
    }
  });
  
  // Use the signal as the reactive accessor
  const selectedCloudData = (): string => selectedCloudDataValue();
  
  // Plot Type state
  const getInitialPlotType = (): string => {
    const value = (props.selectedPlotType && typeof props.selectedPlotType === 'function') ? props.selectedPlotType() : (props.selectedPlotType || 'Scatter');
    return value;
  };
  const [selectedPlotTypeValue, setSelectedPlotTypeValue] = createSignal<string>(getInitialPlotType());
  
  // Update the signal when the prop changes
  createEffect(() => {
    if (props.selectedPlotType && typeof props.selectedPlotType === 'function') {
      const value = props.selectedPlotType();
      setSelectedPlotTypeValue(value);
    } else {
      const value = props.selectedPlotType || 'Scatter';
      setSelectedPlotTypeValue(value);
    }
  });
  
  const selectedPlotType = (): string => selectedPlotTypeValue();

  // Use date range from filterStore (not props)
  const currentStartDate = (): string => startDate() || '';
  const currentEndDate = (): string => endDate() || '';

  // Filter and highlight state
  const getFilterGrades = (): string => {
    const value = (props.filterGrades && typeof props.filterGrades === 'function') ? props.filterGrades() : (props.filterGrades || '');
    return value;
  };
  const [filterGradesValue, setFilterGradesValue] = createSignal<string>(getFilterGrades());

  // Project-specific filter state (Year, Event, Config)
  const getFilterYear = (): string => {
    const value = (props.filterYear && typeof props.filterYear === 'function') ? props.filterYear() : (props.filterYear || '');
    return value;
  };
  const [filterYearValue, setFilterYearValue] = createSignal<string>(getFilterYear());

  const getFilterEvent = (): string => {
    const value = (props.filterEvent && typeof props.filterEvent === 'function') ? props.filterEvent() : (props.filterEvent || '');
    return value;
  };
  const [filterEventValue, setFilterEventValue] = createSignal<string>(getFilterEvent());

  const getFilterConfig = (): string => {
    const value = (props.filterConfig && typeof props.filterConfig === 'function') ? props.filterConfig() : (props.filterConfig || '');
    return value;
  };
  const [filterConfigValue, setFilterConfigValue] = createSignal<string>(getFilterConfig());

  const getFilterState = (): string => {
    const value = (props.filterState && typeof props.filterState === 'function') ? props.filterState() : (props.filterState || '');
    return value;
  };
  const [filterStateValue, setFilterStateValue] = createSignal<string>(getFilterState());

  // Helper to get all source IDs from props.sources
  const getAllSourceIds = (): number[] => {
    if (!props.sources || !Array.isArray(props.sources)) return [];
    return props.sources
      .map(source => {
        if (typeof source === 'object' && source?.source_id) {
          return source.source_id;
        }
        return null;
      })
      .filter((id): id is number => id !== null && typeof id === 'number');
  };

  // Source filter state (for fleet performance pages)
  // Default to all sources if filterSources is empty
  const getFilterSources = (): number[] => {
    const value = (props.filterSources && typeof props.filterSources === 'function') ? props.filterSources() : (props.filterSources || []);
    const sourceIds = Array.isArray(value) ? value : [];
    // If empty, default to all sources
    if (sourceIds.length === 0) {
      return getAllSourceIds();
    }
    return sourceIds;
  };
  const [filterSourcesValue, setFilterSourcesValue] = createSignal<number[]>(getFilterSources());

  // Update signals when props change
  createEffect(() => {
    if (props.filterGrades && typeof props.filterGrades === 'function') {
      setFilterGradesValue(props.filterGrades());
    } else {
      setFilterGradesValue(props.filterGrades || '');
    }
  });

  createEffect(() => {
    if (props.filterYear && typeof props.filterYear === 'function') {
      setFilterYearValue(props.filterYear());
    } else {
      setFilterYearValue(props.filterYear || '');
    }
  });

  createEffect(() => {
    if (props.filterEvent && typeof props.filterEvent === 'function') {
      setFilterEventValue(props.filterEvent());
    } else {
      setFilterEventValue(props.filterEvent || '');
    }
  });

  createEffect(() => {
    if (props.filterConfig && typeof props.filterConfig === 'function') {
      setFilterConfigValue(props.filterConfig());
    } else {
      setFilterConfigValue(props.filterConfig || '');
    }
  });

  createEffect(() => {
    if (props.filterState && typeof props.filterState === 'function') {
      setFilterStateValue(props.filterState());
    } else {
      setFilterStateValue(props.filterState || '');
    }
  });

  createEffect(() => {
    let sourceIds: number[];
    if (props.filterSources && typeof props.filterSources === 'function') {
      sourceIds = props.filterSources();
    } else {
      sourceIds = Array.isArray(props.filterSources) ? props.filterSources : [];
    }
    // If empty, default to all sources
    if (sourceIds.length === 0) {
      sourceIds = getAllSourceIds();
    }
    setFilterSourcesValue(sourceIds);
  });

  // Sort sources by source_id for display
  const sortedSources = createMemo(() => {
    if (!props.sources || !Array.isArray(props.sources)) return [];
    return [...props.sources].sort((a, b) => {
      const aId = typeof a === 'object' && a?.source_id ? a.source_id : 0;
      const bId = typeof b === 'object' && b?.source_id ? b.source_id : 0;
      return aId - bId;
    });
  });

  // Track initial date values when modal opens (for detecting changes)
  const [initialStartDate, setInitialStartDate] = createSignal('');
  const [initialEndDate, setInitialEndDate] = createSignal('');
  
  // Track initial filter and highlight values when modal opens
  const [initialFilterGrades, setInitialFilterGrades] = createSignal('');
  const [initialFilterYear, setInitialFilterYear] = createSignal('');
  const [initialFilterEvent, setInitialFilterEvent] = createSignal('');
  const [initialFilterConfig, setInitialFilterConfig] = createSignal('');
  const [initialFilterState, setInitialFilterState] = createSignal('');
  const [initialFilterSources, setInitialFilterSources] = createSignal<number[]>([]);

  // Local state for source selections (deferred until Apply is clicked) - for dataSourcesOptions pattern
  const [localSourceSelections, setLocalSourceSelections] = createSignal<Set<number>>(new Set());
  const [initialSourceSelections, setInitialSourceSelections] = createSignal<Set<number>>(new Set());

  // Local state for race/leg filter selections (deferred until Apply is clicked) - for day/dataset mode
  const [localRaceSelections, setLocalRaceSelections] = createSignal<Set<string | number>>(new Set());
  const [localLegSelections, setLocalLegSelections] = createSignal<Set<number>>(new Set());
  const [localGradeSelections, setLocalGradeSelections] = createSignal<Set<number>>(new Set());
  const [localStateSelections, setLocalStateSelections] = createSignal<Set<string>>(new Set());
  const [initialRaceSelections, setInitialRaceSelections] = createSignal<Set<string | number>>(new Set());
  const [initialLegSelections, setInitialLegSelections] = createSignal<Set<number>>(new Set());
  const [initialGradeSelections, setInitialGradeSelections] = createSignal<Set<number>>(new Set());
  const [initialStateSelections, setInitialStateSelections] = createSignal<Set<string>>(new Set());

  // Local state for TRAINING/RACING filter (deferred until Apply is clicked) - for history mode
  const [localTrainingRacingSelection, setLocalTrainingRacingSelection] = createSignal<'TRAINING' | 'RACING' | null>(null);
  const [initialTrainingRacingSelection, setInitialTrainingRacingSelection] = createSignal<'TRAINING' | 'RACING' | null>(null);

  // Timeline visibility state
  const getInitialTimeline = (): boolean => {
    const value = (props.showTimeline && typeof props.showTimeline === 'function') ? props.showTimeline() : true;
    return value;
  };
  const [showTimelineValue, setShowTimelineValue] = createSignal<boolean>(getInitialTimeline());

  // Update timeline signal when prop changes
  createEffect(() => {
    if (props.showTimeline && typeof props.showTimeline === 'function') {
      setShowTimelineValue(props.showTimeline());
    } else {
      setShowTimelineValue(true);
    }
  });

  const showTimeline = (): boolean => showTimelineValue();

  // Determine mode: day/dataset vs history
  const { selectedDatasetId, selectedDate } = persistantStore;
  const isDayDatasetMode = createMemo(() => {
    const datasetId = selectedDatasetId?.();
    const date = selectedDate?.();
    return (datasetId && datasetId > 0) || (date && date.trim() !== '');
  });

  // Check if dates have changed from initial values
  // Make sure to access all signals to ensure reactivity
  const hasDateChanges = createMemo(() => {
    // Access showPopup and sidebarState to track them
    const isOpen = showPopup();
    const isProject = sidebarState() === 'project';
    
    if (!isProject || !isOpen) return false;
    
    // Access the signals to make this reactive - these read from filterStore
    const currentStart = currentStartDate();
    const currentEnd = currentEndDate();
    const initialStart = initialStartDate();
    const initialEnd = initialEndDate();
    
    // Compare values - handle empty strings properly
    const startChanged = currentStart !== initialStart;
    const endChanged = currentEnd !== initialEnd;
    const hasChanges = startChanged || endChanged;
    
    logDebug('PerfSettings: hasDateChanges check', {
      isOpen,
      isProject,
      currentStart,
      currentEnd,
      initialStart,
      initialEnd,
      startChanged,
      endChanged,
      hasChanges
    });
    
    return hasChanges;
  });

  // Check if filters or highlights have changed from initial values
  // Track last logged state to prevent duplicate logs
  let lastLoggedChangeState = '';
  const hasFilterOrHighlightChanges = createMemo(() => {
    const isOpen = showPopup();
    if (!isOpen) return false;
    
    // Access all filter and highlight signals to make this reactive
    const currentFilterGrades = filterGradesValue();
    const currentFilterYear = filterYearValue();
    const currentFilterEvent = filterEventValue();
    const currentFilterConfig = filterConfigValue();
    const currentFilterState = filterStateValue();
    const currentFilterSources = filterSourcesValue();
    
    const initialGrades = initialFilterGrades();
    const initialYear = initialFilterYear();
    const initialEvent = initialFilterEvent();
    const initialConfig = initialFilterConfig();
    const initialState = initialFilterState();
    const initialSources = initialFilterSources();
    
    // Compare values - handle empty strings properly
    const gradesChanged = currentFilterGrades !== initialGrades;
    const yearChanged = currentFilterYear !== initialYear;
    const eventChanged = currentFilterEvent !== initialEvent;
    const configChanged = currentFilterConfig !== initialConfig;
    const stateChanged = currentFilterState !== initialState;
    const sourcesChanged = JSON.stringify(currentFilterSources.sort()) !== JSON.stringify(initialSources.sort());
    
    // Check race/leg filter changes (for day/dataset mode)
    const dayDatasetMode = isDayDatasetMode();
    let raceLegChanged = false;
    if (dayDatasetMode) {
      const currentRaces = localRaceSelections();
      const currentLegs = localLegSelections();
      const initialRaces = initialRaceSelections();
      const initialLegs = initialLegSelections();
      
      if (currentRaces.size !== initialRaces.size || currentLegs.size !== initialLegs.size) {
        raceLegChanged = true;
      } else {
        for (const race of currentRaces) {
          if (!initialRaces.has(race)) {
            raceLegChanged = true;
            break;
          }
        }
        if (!raceLegChanged) {
          for (const leg of currentLegs) {
            if (!initialLegs.has(leg)) {
              raceLegChanged = true;
              break;
            }
          }
        }
      }
    }
    
    // Check grade/state filter changes (button selections)
    const currentGradeSelections = localGradeSelections();
    const currentStateSelections = localStateSelections();
    const initialGradeSelectionsSet = initialGradeSelections();
    const initialStateSelectionsSet = initialStateSelections();
    
    let gradeSelectionsChanged = false;
    let stateSelectionsChanged = false;
    
    if (currentGradeSelections.size !== initialGradeSelectionsSet.size) {
      gradeSelectionsChanged = true;
    } else {
      for (const grade of currentGradeSelections) {
        if (!initialGradeSelectionsSet.has(grade)) {
          gradeSelectionsChanged = true;
          break;
        }
      }
    }
    
    if (currentStateSelections.size !== initialStateSelectionsSet.size) {
      stateSelectionsChanged = true;
    } else {
      for (const state of currentStateSelections) {
        const exists = Array.from(initialStateSelectionsSet).some((val: any) => String(val).trim().toLowerCase() === String(state).trim().toLowerCase());
        if (!exists) {
          stateSelectionsChanged = true;
          break;
        }
      }
    }
    
    // Check TRAINING/RACING filter changes (for both day/dataset and history mode)
    const currentTR = localTrainingRacingSelection();
    const initialTR = initialTrainingRacingSelection();
    const trainingRacingChanged = currentTR !== initialTR;
    
    const hasChanges = gradesChanged || yearChanged || eventChanged || configChanged || stateChanged || sourcesChanged || raceLegChanged || trainingRacingChanged || gradeSelectionsChanged || stateSelectionsChanged;
    
    // Only log if the change state actually changed (prevents duplicate logs from memo recomputes)
    const changeSignature = `${gradesChanged}-${yearChanged}-${eventChanged}-${configChanged}-${stateChanged}-${sourcesChanged}-${raceLegChanged}-${trainingRacingChanged}-${hasChanges}`;
    if (changeSignature !== lastLoggedChangeState) {
      lastLoggedChangeState = changeSignature;
      logDebug('PerfSettings: hasFilterOrHighlightChanges check', {
        isOpen,
        gradeSelectionsChanged,
        yearChanged,
        eventChanged,
        configChanged,
        sourcesChanged,
        raceLegChanged,
        trainingRacingChanged,
        hasChanges
      });
    }
    
    return hasChanges;
  });

  // Initialize date range when component mounts (only if sidebarState is 'project')
  onMount(() => {
    // Initialize date range immediately if needed (non-blocking)
    if (sidebarState() === 'project') {
      initializeDateRange().catch(err => logDebug('PerfSettings: Error initializing date range:', err));
    }
    
    // Load timeline preference from persistent settings in background
    (async () => {
      try {
        const currentUser = user();
        if (currentUser?.user_id) {
          const { selectedClassName, selectedProjectId } = persistantStore;
          const className = selectedClassName();
          const projectId = selectedProjectId();
          
          if (className && projectId) {
            const settings = await persistentSettingsService.loadSettings(
              currentUser.user_id,
              className,
              projectId
            );
            
            if (settings?.showTimeline !== undefined) {
              setShowTimelineValue(settings.showTimeline);
              if (props.onTimelineChange) {
                props.onTimelineChange(settings.showTimeline);
              }
              logDebug('PerfSettings: Loaded timeline preference from persistent settings', settings.showTimeline);
            }
          }
        }
      } catch (error) {
        logDebug('PerfSettings: Error loading timeline preference from persistent settings:', error);
      }
    })();
  });

  // Re-initialize date range when sidebarState changes to 'project'
  createEffect(async () => {
    if (sidebarState() === 'project') {
      await initializeDateRange();
    }
  });

  // Track when filters are cleared to trigger filter option refresh
  // When all filters are cleared, we need to repopulate filter options from full unfiltered dataset
  const filtersCleared = createMemo(() => {
    const grades = filterGradesValue().trim();
    const year = filterYearValue().trim();
    const event = filterEventValue().trim();
    const config = filterConfigValue().trim();
    const state = filterStateValue().trim();
    const gradeSelections = localGradeSelections().size;
    const stateSelections = localStateSelections().size;
    const raceSelections = localRaceSelections().size;
    const legSelections = localLegSelections().size;
    
    // Check if all filters are empty/cleared
    return !grades && !year && !event && !config && !state && 
           gradeSelections === 0 && stateSelections === 0 && 
           raceSelections === 0 && legSelections === 0;
  });

  // Track previous cleared state to detect when filters transition from set to cleared
  const [prevFiltersCleared, setPrevFiltersCleared] = createSignal<boolean>(filtersCleared());
  createEffect(() => {
    const cleared = filtersCleared();
    const wasCleared = prevFiltersCleared();
    
    // If filters just transitioned from set to cleared, trigger refresh
    if (cleared && !wasCleared) {
      logDebug('PerfSettings: Filters cleared, will refresh filter options from full dataset');
    }
    
    setPrevFiltersCleared(cleared);
  });

  // Query races and legs from hunidb agg.events (tags JSON)
  // Re-run when filters are cleared to refresh options from full dataset
  // When filters are cleared, also fetch a small unfiltered sample from API to ensure we get all options
  createEffect(async () => {
    // Only fetch when modal is open - don't fetch on project change if modal is closed
    const modalOpen = showPopup();
    if (!modalOpen) return;
    
    const { selectedClassName, selectedProjectId, selectedSourceId, selectedDate, selectedDatasetId } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const sourceId = selectedSourceId();
    
    // Access filtersCleared to make this reactive to filter clearing
    const cleared = filtersCleared();
    const wasCleared = prevFiltersCleared();
    
    if (!className || !projectId) return;
    
    // Day/dataset context: use shared service (preload + HuniDB + date/races API fallback)
    const isDayMode = isDayDatasetMode();
    if (isDayMode) {
      const date = selectedDate?.();
      const datasetId = selectedDatasetId?.();
      const hasDate = date && String(date).trim() !== "";
      const hasDataset = datasetId && Number(datasetId) > 0;
      if (hasDate || hasDataset) {
        try {
          const context = hasDataset ? ("dataset" as const) : ("day" as const);
          const result = await getRaceAndLegOptions({
            context,
            className,
            projectId: Number(projectId),
            date: hasDate ? String(date) : undefined,
            datasetId: hasDataset ? Number(datasetId) : undefined,
            ensureEventsLoaded: true,
          });
          setRaceOptions(result.races.map((r) => String(r)));
          setLegOptions(result.legs.map((l) => String(l)));
          if (props.setRaceOptions) props.setRaceOptions(result.races);
          if (props.setLegOptions) props.setLegOptions(result.legs);
          if (result.races.length > 0 || result.legs.length > 0) {
            logDebug("PerfSettings: Set race/leg options from shared service (day/dataset)", { races: result.races.length, legs: result.legs.length, context });
          }
          return;
        } catch (err) {
          logDebug("PerfSettings: getRaceAndLegOptions failed in day/dataset mode", err);
        }
      }
    }
    
    // Project/source context: HuniDB first, then performance-data API fallback when empty
    try {
      const db = await huniDBStore.getDatabase(className.toLowerCase());
      const escapedEventsTable = escapeTableName(TableNames.events);
      
      // Build WHERE clause - filter by project_id, and by date/dataset_id if in day/dataset mode
      // In day/dataset mode, we should only show races for that specific day, not all days in the project
      const isDayMode = isDayDatasetMode();
      const whereConditions = [`project_id = ?`];
      const params: any[] = [String(projectId)];
      
      // Add date/dataset filter if in day/dataset mode
      if (isDayMode) {
        const { selectedDatasetId, selectedDate } = persistantStore;
        const datasetId = selectedDatasetId?.();
        const date = selectedDate?.();
        
        if (datasetId && Number(datasetId) > 0) {
          // Filter by dataset_id (most precise)
          whereConditions.push(`dataset_id = ?`);
          params.push(String(datasetId));
        } else if (date && date.trim() !== '') {
          // Filter by date via meta.datasets (agg.events has no date column)
          const normalizedDate = date.includes('-') ? date : `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}`;
          whereConditions.push(`dataset_id IN (SELECT dataset_id FROM "meta.datasets" WHERE project_id = ? AND date = ?)`);
          params.push(String(projectId), normalizedDate);
        }
      }
      
      const whereClause = whereConditions.join(' AND ');
      
      // Query distinct race numbers from agg.events (tags.race_number)
      try {
        const racesSql = `
          SELECT DISTINCT normalized_race_number
          FROM (
            SELECT 
              CASE 
                WHEN UPPER(TRIM(COALESCE(CAST(json_extract(tags, '$.race_number') AS TEXT), ''))) = 'TRAINING' THEN 'TRAINING'
                WHEN CAST(json_extract(tags, '$.race_number') AS REAL) = -1 THEN 'TRAINING'
                WHEN json_extract(tags, '$.race_number') IS NOT NULL AND TRIM(COALESCE(CAST(json_extract(tags, '$.race_number') AS TEXT), '')) != '' THEN TRIM(CAST(json_extract(tags, '$.race_number') AS TEXT))
                ELSE NULL
              END AS normalized_race_number
            FROM ${escapedEventsTable}
            WHERE ${whereClause}
              AND json_extract(tags, '$.race_number') IS NOT NULL
          )
          WHERE normalized_race_number IS NOT NULL
          ORDER BY 
            CASE WHEN normalized_race_number = 'TRAINING' THEN 0 ELSE 1 END,
            CASE 
              WHEN normalized_race_number = 'TRAINING' THEN -1
              WHEN CAST(normalized_race_number AS REAL) IS NOT NULL THEN CAST(normalized_race_number AS REAL)
              ELSE 999999
            END ASC
        `;
        const raceRows = await db.query<any>(racesSql, params);
        
        const racesFromHuniDB = raceRows
          .map((r: any) => {
            const raceNum = r.normalized_race_number;
            // Keep 'TRAINING' as string, convert numbers to Number
            if (raceNum === 'TRAINING' || raceNum === 'training' || raceNum === '-1' || raceNum === -1) {
              return 'TRAINING';
            }
            // Try to convert to number, but keep as string if it fails
            const num = Number(raceNum);
            return isNaN(num) ? raceNum : num;
          })
          .filter((v: any) => v !== null && v !== undefined && (v === 'TRAINING' || typeof v === 'number'))
          .sort((a: any, b: any) => {
            // Sort with 'TRAINING' first, then numeric races
            if (a === 'TRAINING') return -1;
            if (b === 'TRAINING') return 1;
            if (typeof a === 'number' && typeof b === 'number') return a - b;
            return String(a).localeCompare(String(b));
          });
        
        // Only fetch from API if HuniDB returned no results AND modal is open AND NOT in day/dataset mode
        // In day/dataset mode, if there are no races for that day, don't fall back to API (which would return races from other days)
        let finalRaces = racesFromHuniDB;
        if (racesFromHuniDB.length === 0 && showPopup() && !isDayMode) {
          try {
            const { getData } = await import('../../utils/global');
            const { apiEndpoints } = await import('@config/env');
            const { performanceDataService } = await import('../../services/performanceDataService');
            const { twaName, twsName, bspName } = defaultChannelsStore;
            
            // Fetch a small unfiltered sample (no filters) to extract all distinct races
            // Use fetchDatasetDate for dataset pages, or use a wide date range for source pages
            const channels = [twaName(), twsName(), bspName()];
            let startDate = '';
            let endDate = '';
            try {
              const { selectedDatasetId, selectedSourceId } = persistantStore;
              const hasDatasetId = typeof selectedDatasetId === 'function' && Number(selectedDatasetId()) > 0;
              if (hasDatasetId) {
                const date = await performanceDataService.fetchDatasetDate();
                startDate = date;
                endDate = date;
              } else {
                // For source/project pages, use a wide date range (last 30 days) to get all filter options
                const { getData } = await import('../../utils/global');
                const { apiEndpoints } = await import('@config/env');
                const result = await getData(`${apiEndpoints.app.datasets}/last_date?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}`);
                if (result.success && result.data) {
                  const end = new Date(result.data);
                  // Cap end date to today to prevent future dates
                  const today = new Date();
                  if (end > today) {
                    logDebug('PerfSettings: last_date returned future date, capping to today', { returnedDate: result.data, today: today.toISOString() });
                    end.setTime(today.getTime());
                  }
                  const start = new Date(end.getTime());
                  start.setDate(start.getDate() - 30);
                  startDate = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;
                  endDate = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
                } else {
                  // Fallback to last 30 days from today
                  const end = new Date();
                  const start = new Date();
                  start.setDate(start.getDate() - 30);
                  startDate = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;
                  endDate = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
                }
              }
            } catch (dateErr) {
              logDebug('PerfSettings: Error resolving date range for API fallback', dateErr);
              // Use a wide date range as fallback
              const end = new Date();
              const start = new Date();
              start.setDate(start.getDate() - 30);
              startDate = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;
              endDate = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
            }
            // Validate className before making API call
            if (!className || className.toLowerCase() !== 'gp50') {
              logDebug('PerfSettings: Skipping API call - invalid className', { className, projectId });
              return;
            }
            
            // Use fleet-performance-data endpoint for fleet-level requests (source_id=0)
            const isFleetRequest = Number(sourceId) === 0;
            const url = isFleetRequest
              ? `${apiEndpoints.app.data}/fleet-performance-data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&event_type=BIN%2010&agr_type=AVG&channels=${encodeURIComponent(JSON.stringify(channels))}`
              : `${apiEndpoints.app.data}/performance-data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&event_type=BIN%2010&agr_type=AVG&channels=${encodeURIComponent(JSON.stringify(channels))}`;
            
            const response = await getData(url);
            if (response.success && Array.isArray(response.data) && response.data.length > 0) {
              const { extractAndNormalizeMetadata } = await import('../../utils/dataNormalization');
              const racesFromAPI = new Set<string | number>();
              
              response.data.forEach((item: any) => {
                const normalized = extractAndNormalizeMetadata(item);
                const raceNum = normalized.race_number;
                if (raceNum !== null && raceNum !== undefined) {
                  if (raceNum === -1 || raceNum === '-1' || raceNum === 'TRAINING') {
                    racesFromAPI.add('TRAINING');
                  } else {
                    const num = Number(raceNum);
                    racesFromAPI.add(isNaN(num) ? raceNum : num);
                  }
                }
              });
              
              const allRaces = Array.from(racesFromAPI).sort((a: any, b: any) => {
                if (a === 'TRAINING') return -1;
                if (b === 'TRAINING') return 1;
                if (typeof a === 'number' && typeof b === 'number') return a - b;
                return String(a).localeCompare(String(b));
              });
              
              if (allRaces.length > finalRaces.length) {
                logDebug('PerfSettings: API returned more races than database after filter clear, using API results', {
                  dbRaces: finalRaces.length,
                  apiRaces: allRaces.length,
                  races: allRaces
                });
                finalRaces = allRaces;
              }
            }
          } catch (apiErr) {
            logDebug('PerfSettings: Failed to fetch races from API after filter clear', apiErr);
          }
        }
        
        // Convert to string[] for filterStore (races can be 'TRAINING' string or numbers)
        const raceOptionsAsStrings = finalRaces.map(r => String(r));
        setRaceOptions(raceOptionsAsStrings);
        
        // Also call prop function if provided (for backward compatibility)
        if (props.setRaceOptions) {
          props.setRaceOptions(finalRaces);
        }
        
        if (finalRaces.length > 0) {
          logDebug('PerfSettings: Set race options from hunidb agg.events', { 
            count: finalRaces.length, 
            races: finalRaces,
            fetchedFromAPI: racesFromHuniDB.length === 0 && finalRaces.length > 0
          });
        } else {
          logDebug('PerfSettings: No races found in hunidb agg.events');
        }
      } catch (raceErr) {
        logDebug('PerfSettings: Failed fetching races from hunidb', raceErr);
      }
      
      // Query distinct leg numbers from agg.events (tags.leg_number, same WHERE as races)
      try {
        const legsSql = `
          SELECT DISTINCT CAST(json_extract(tags, '$.leg_number') AS INTEGER) AS leg_number
          FROM ${escapedEventsTable}
          WHERE ${whereClause}
            AND json_extract(tags, '$.leg_number') IS NOT NULL
            AND CAST(json_extract(tags, '$.leg_number') AS REAL) > 0
          ORDER BY leg_number ASC
        `;
        const legRows = await db.query<any>(legsSql, params);
        const legsFromHuniDB = legRows
          .map((l: any) => l.leg_number)
          .filter((v: any) => v !== null && v !== undefined && !isNaN(v))
          .map((v: any) => Number(v))
          .sort((a: number, b: number) => a - b);
        
        // Always include leg 0 by default; merge with DB results and sort
        let finalLegs = [...new Set([0, ...legsFromHuniDB])].sort((a: number, b: number) => a - b);
        if (legsFromHuniDB.length === 0 && showPopup() && !isDayMode) {
          try {
            const { getData } = await import('../../utils/global');
            const { apiEndpoints } = await import('@config/env');
            const { performanceDataService } = await import('../../services/performanceDataService');
            const { twaName, twsName, bspName } = defaultChannelsStore;
            
            // Fetch a small unfiltered sample (no filters) to extract all distinct legs
            // Use fetchDatasetDate for dataset pages, or use a wide date range for source pages
            const channels = [twaName(), twsName(), bspName()];
            let startDate = '';
            let endDate = '';
            try {
              const { selectedDatasetId, selectedSourceId } = persistantStore;
              const hasDatasetId = typeof selectedDatasetId === 'function' && Number(selectedDatasetId()) > 0;
              if (hasDatasetId) {
                const date = await performanceDataService.fetchDatasetDate();
                startDate = date;
                endDate = date;
              } else {
                // For source/project pages, use a wide date range (last 30 days) to get all filter options
                const { getData } = await import('../../utils/global');
                const { apiEndpoints } = await import('@config/env');
                const result = await getData(`${apiEndpoints.app.datasets}/last_date?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}`);
                if (result.success && result.data) {
                  const end = new Date(result.data);
                  // Cap end date to today to prevent future dates
                  const today = new Date();
                  if (end > today) {
                    logDebug('PerfSettings: last_date returned future date, capping to today', { returnedDate: result.data, today: today.toISOString() });
                    end.setTime(today.getTime());
                  }
                  const start = new Date(end.getTime());
                  start.setDate(start.getDate() - 30);
                  startDate = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;
                  endDate = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
                } else {
                  // Fallback to last 30 days from today
                  const end = new Date();
                  const start = new Date();
                  start.setDate(start.getDate() - 30);
                  startDate = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;
                  endDate = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
                }
              }
            } catch (dateErr) {
              logDebug('PerfSettings: Error resolving date range for API fallback', dateErr);
              // Use a wide date range as fallback
              const end = new Date();
              const start = new Date();
              start.setDate(start.getDate() - 30);
              startDate = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;
              endDate = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
            }
            // Validate className before making API call
            if (!className || className.toLowerCase() !== 'gp50') {
              logDebug('PerfSettings: Skipping API call - invalid className', { className, projectId });
              return;
            }
            
            // Use fleet-performance-data endpoint for fleet-level requests (source_id=0)
            const isFleetRequest = Number(sourceId) === 0;
            const url = isFleetRequest
              ? `${apiEndpoints.app.data}/fleet-performance-data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&event_type=BIN%2010&agr_type=AVG&channels=${encodeURIComponent(JSON.stringify(channels))}`
              : `${apiEndpoints.app.data}/performance-data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&event_type=BIN%2010&agr_type=AVG&channels=${encodeURIComponent(JSON.stringify(channels))}`;
            
            const response = await getData(url);
            if (response.success && Array.isArray(response.data) && response.data.length > 0) {
              const { extractAndNormalizeMetadata } = await import('../../utils/dataNormalization');
              const legsFromAPI = new Set<number>();
              
              response.data.forEach((item: any) => {
                const normalized = extractAndNormalizeMetadata(item);
                const legNum = normalized.leg_number;
                if (legNum !== null && legNum !== undefined && !isNaN(legNum) && legNum >= 0) {
                  legsFromAPI.add(Number(legNum));
                }
              });
              
              const allLegs = Array.from(legsFromAPI).sort((a, b) => a - b);
              
              const apiLegsWithZero = [...new Set([0, ...allLegs])].sort((a, b) => a - b);
              if (apiLegsWithZero.length > finalLegs.length) {
                logDebug('PerfSettings: API returned more legs than database after filter clear, using API results', {
                  dbLegs: finalLegs.length,
                  apiLegs: apiLegsWithZero.length,
                  legs: apiLegsWithZero
                });
                finalLegs = apiLegsWithZero;
              }
            }
          } catch (apiErr) {
            logDebug('PerfSettings: Failed to fetch legs from API after filter clear', apiErr);
          }
        }
        
        // Convert to string[] for filterStore (legs are numbers)
        const legOptionsAsStrings = finalLegs.map(l => String(l));
        setLegOptions(legOptionsAsStrings);
        
        // Also call prop function if provided (for backward compatibility)
        if (props.setLegOptions) {
          props.setLegOptions(finalLegs);
        }
        
        if (finalLegs.length > 0) {
          logDebug('PerfSettings: Set leg options from hunidb agg.events', { 
            count: finalLegs.length, 
            legs: finalLegs,
            fetchedFromAPI: legsFromHuniDB.length === 0 && finalLegs.length > 0
          });
        } else {
          logDebug('PerfSettings: No legs found in hunidb agg.events');
        }
      } catch (legErr) {
        logDebug('PerfSettings: Failed fetching legs from hunidb', legErr);
      }
    } catch (huniDBErr: any) {
      // Log error and continue (will use API fallback if needed)
      logDebug('PerfSettings: Failed querying hunidb for races/legs', huniDBErr);
    }
  });

  // Grade options: 0 = ignore/exclude from analysis, 1–3 = normal grades
  const gradeOptions = () => [0, 1, 2, 3];

  // Fixed state options: always ['H0', 'H1', 'H2']
  const stateOptions = () => ['H0', 'H1', 'H2'];

  // Update initial dates when modal opens
  // Track showPopup to capture initial state when modal first opens
  let hasCapturedInitialDates = false;
  let hasCapturedInitialFilters = false;
  createEffect(() => {
    const isOpen = showPopup();
    const isProject = sidebarState() === 'project';
    
    if (isOpen && isProject && !hasCapturedInitialDates) {
      // Capture dates when modal first opens
      // Use a small delay to ensure dates are available (they might be set asynchronously)
      const captureInitial = () => {
        const start = currentStartDate();
        const end = currentEndDate();
        setInitialStartDate(start);
        setInitialEndDate(end);
        hasCapturedInitialDates = true;
        logDebug('PerfSettings: Captured initial dates on modal open', { start, end });
      };
      
      // Try immediately, and also after a short delay in case dates are set asynchronously
      captureInitial();
      setTimeout(captureInitial, 100);
    } else if (!isOpen) {
      // Reset when modal closes so they're recaptured next time
      hasCapturedInitialDates = false;
      setInitialStartDate('');
      setInitialEndDate('');
    }
  });

  // Update initial filter and highlight values when modal opens
  createEffect(() => {
    const isOpen = showPopup();
    
    if (isOpen && !hasCapturedInitialFilters) {
      // Capture filter and highlight values when modal first opens
      const captureInitial = () => {
        setInitialFilterGrades(filterGradesValue());
        setInitialFilterYear(filterYearValue());
        setInitialFilterEvent(filterEventValue());
        setInitialFilterConfig(filterConfigValue());
        setInitialFilterState(filterStateValue());
        setInitialFilterSources([...filterSourcesValue()]);
        
        // Initialize TRAINING/RACING selection from props (for both day/dataset and history mode)
        const currentTR = typeof props.selectedTrainingRacing === 'function' ? props.selectedTrainingRacing() : (props.selectedTrainingRacing || null);
        setLocalTrainingRacingSelection(currentTR);
        setInitialTrainingRacingSelection(currentTR);
        
        // Capture race/leg selections for day/dataset mode (from filterStore, like grade/state)
        if (isDayDatasetMode()) {
          const currentRaces = selectedRacesAggregates().map(r => {
            if (r === 'TRAINING' || r === 'training') return 'TRAINING';
            const num = Number(r);
            return isNaN(num) ? r : num;
          });
          const currentLegs = selectedLegsAggregates().map(l => Number(l)).filter(l => !isNaN(l));
          const racesSet = new Set<string | number>(currentRaces);
          const legsSet = new Set<number>(currentLegs);
          setLocalRaceSelections(racesSet);
          setLocalLegSelections(legsSet);
          setInitialRaceSelections(new Set<string | number>(racesSet));
          setInitialLegSelections(new Set<number>(legsSet));
        }
        
        // Capture grade/state selections from current filter values
        // Parse grades: split by comma, trim, parse as int, filter valid grades (0, 1, 2, 3)
        const currentGrades = filterGradesValue()
          .split(',')
          .map(g => parseInt(g.trim()))
          .filter(g => !isNaN(g) && (g === 0 || g === 1 || g === 2 || g === 3));
        // Parse states: split by comma, trim, filter valid states (H0, H1, H2) - case insensitive
        const currentStates = filterStateValue()
          .split(',')
          .map(s => s.trim().toUpperCase())
          .filter(s => s === 'H0' || s === 'H1' || s === 'H2');
        const gradesSet = new Set<number>(currentGrades);
        const statesSet = new Set<string>(currentStates);
        setLocalGradeSelections(gradesSet);
        setLocalStateSelections(statesSet);
        setInitialGradeSelections(new Set<number>(gradesSet));
        setInitialStateSelections(new Set<string>(statesSet));
        
        hasCapturedInitialFilters = true;
        logDebug('PerfSettings: Captured initial filters on modal open', {
          grades: filterGradesValue(),
          year: filterYearValue(),
          event: filterEventValue(),
          config: filterConfigValue(),
          state: filterStateValue(),
          isDayDatasetMode: isDayDatasetMode()
        });
      };
      
      // Try immediately, and also after a short delay
      captureInitial();
      setTimeout(captureInitial, 100);
    } else if (!isOpen) {
      // Reset when modal closes so they're recaptured next time
      hasCapturedInitialFilters = false;
      setInitialFilterGrades('');
      setInitialFilterYear('');
      setInitialFilterEvent('');
      setInitialFilterConfig('');
      setInitialFilterState('');
      setInitialFilterSources([]);
      setLocalRaceSelections(new Set<string | number>());
      setLocalLegSelections(new Set<number>());
      setLocalGradeSelections(new Set<number>());
      setLocalStateSelections(new Set<string>());
      setInitialRaceSelections(new Set<string | number>());
      setInitialLegSelections(new Set<number>());
      setInitialGradeSelections(new Set<number>());
      setInitialStateSelections(new Set<string>());
      setLocalTrainingRacingSelection(null);
      setInitialTrainingRacingSelection(null);
    }
  });

  // Initialize local source selections when modal opens (for dataSourcesOptions pattern)
  // Track the last popup state to detect when it opens
  let lastPopupState = false;
  createEffect(() => {
    const isOpen = showPopup();
    const options = props.dataSourcesOptions;
    const hasOptions = Array.isArray(options) && options.length > 0;
    
    // When modal opens, check if sources are ready - if not, trigger refresh
    if (isOpen && !lastPopupState) {
      if (!sourcesStore.isReady()) {
        logDebug('PerfSettings: Modal opened but sources not ready, triggering refresh');
        sourcesStore.refresh().catch((error) => {
          logDebug('PerfSettings: Failed to refresh sources', error);
        });
      }
    }
    
    // When modal opens (transitions from closed to open), initialize from current signals.
    // Only run when modal has *just* opened (!lastPopupState). Do not re-initialize when
    // localSourceSelections().size === 0, or the "None" button would be overwritten by the effect.
    if (isOpen && hasOptions) {
      const shouldInitialize = !lastPopupState;

      if (shouldInitialize) {
        // Capture current source selections from signals
        const currentSelections = new Set<number>();
        options.forEach((opt) => {
          if (opt.key?.startsWith('source-')) {
            const match = opt.key.match(/source-(\d+)/);
            if (match) {
              const sourceId = Number(match[1]);
              try {
                const isSelected = opt.signal?.[0]?.() ?? false;
                if (isSelected) {
                  currentSelections.add(sourceId);
                }
              } catch {
                // Ignore errors
              }
            }
          }
        });
        const currentSet = new Set<number>(Array.from(currentSelections));
        setLocalSourceSelections(currentSet);
        setInitialSourceSelections(new Set<number>(currentSet));
        logDebug('PerfSettings: Initialized local source selections', {
          selections: Array.from(currentSelections),
          count: currentSelections.size,
          reason: 'modal opened'
        });
      }
    } else if (!isOpen && lastPopupState) {
      // Modal just closed - reset state
      setLocalSourceSelections(new Set<number>());
      setInitialSourceSelections(new Set<number>());
      logDebug('PerfSettings: Reset local source selections on modal close');
    }
    
    // Update tracked state
    lastPopupState = isOpen;
  });

  // Check if source selections have changed (for dataSourcesOptions pattern)
  const hasSourceChanges = createMemo(() => {
    if (!showPopup() || !Array.isArray(props.dataSourcesOptions) || props.dataSourcesOptions.length === 0) {
      return false;
    }
    const current = localSourceSelections();
    const initial = initialSourceSelections();
    
    if (current.size !== initial.size) return true;
    for (const id of current) {
      if (!initial.has(id)) return true;
    }
    for (const id of initial) {
      if (!current.has(id)) return true;
    }
    return false;
  });

  // Apply source changes (for dataSourcesOptions pattern)
  const handleApplySourceChanges = async () => {
    const selections = localSourceSelections();
    logDebug('PerfSettings: Applying source changes', { selections: Array.from(selections) });
    
    // Convert source IDs to source names for persistence
    const sourceNames = Array.from(selections).map((sourceId: number) => {
      const source = sourcesStore.sources().find(s => s.source_id === sourceId);
      return source?.source_name || '';
    }).filter(Boolean);
    
    // Update filterStore directly with the final state FIRST
    // This ensures filterStore has the correct state before individual signals update
    // Import filterStore functions
    const { setSelectedSources } = await import('../../store/filterStore');
    setSelectedSources(sourceNames);
    logDebug('PerfSettings: Updated filterStore with sources', sourceNames);
    
    // Save to persistent settings API (always save, even if empty array)
    // This ensures user's source selection is persisted, including when all sources are deselected
    const currentUser = user();
    if (currentUser?.user_id) {
      const { selectedClassName, selectedProjectId } = persistantStore;
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (className && projectId) {
        try {
          await persistentSettingsService.saveSettings(
            currentUser.user_id,
            className,
            projectId,
            { fleetPerformanceSources: sourceNames } // Save even if empty array
          );
          logDebug('PerfSettings: Saved sources to persistent settings API', { 
            sourceNames, 
            count: sourceNames.length,
            className,
            projectId
          });
        } catch (error) {
          logDebug('PerfSettings: Error saving sources to persistent settings API', error);
        }
      } else {
        logDebug('PerfSettings: Cannot save sources - missing className or projectId', { className, projectId });
      }
    } else {
      logDebug('PerfSettings: Cannot save sources - missing user');
    }
    
    // Apply changes to all source options to keep signals in sync
    // Since filterStore is already updated with the final state above,
    // the signal setters will see the correct state and won't make unnecessary updates
    // (they check if sources are already selected before updating)
    if (Array.isArray(props.dataSourcesOptions)) {
      props.dataSourcesOptions.forEach((opt: any) => {
        if (opt.key?.startsWith('source-') && opt.signal?.[1]) {
          const match = opt.key.match(/source-(\d+)/);
          if (match) {
            const sourceId = Number(match[1]);
            const shouldBeSelected = selections.has(sourceId);
            // Update signal - the setter will check filterStore state and only update if needed
            opt.signal[1](shouldBeSelected);
          }
        }
      });
    }
    
    // Update initial selections to current
    setInitialSourceSelections(new Set(selections));
  };

  // ESC key handler removed - modal should only close via Apply/Close buttons

  // Outside click handler removed - modal should only close via Apply/Close buttons
  let modalContentRef;

  const handleXAxisChange = (value: string) => {
    try { info('PerfSettings.jsx: X-Axis changed', { value }); } catch { log('PerfSettings.jsx: X-Axis changed', { value }); }
    if (props.onXAxisChange) {
      props.onXAxisChange(value);
    }
  };

  const handleCloudDataChange = (value: string) => {
    try { info('PerfSettings.jsx: Cloud Data changed', { value }); } catch { log('PerfSettings.jsx: Cloud Data changed', { value }); }
    // Always update local signal for immediate UI feedback
    const result = value === 'Latest' ? '1Hz Scatter' : value;
    logDebug('PerfSettings: handleCloudDataChange - immediately updating local signal to:', result);
    setSelectedCloudDataValue(result);
    // Call the callback if provided
    if (props.onCloudDataChange) {
      props.onCloudDataChange(value);
    }
  };

  const handleStartDateChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    try { info('PerfSettings.jsx: Start date changed', { value }); } catch { log('PerfSettings.jsx: Start date changed', { value }); }
    setStartDate(value);
    logDebug('PerfSettings: Start date updated in filterStore', { value, currentStartDate: currentStartDate() });
    // Also call prop handler if provided for backward compatibility
    if (props.onStartDateChange) {
      props.onStartDateChange(value);
    }
  };

  const handleEndDateChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    try { info('PerfSettings.jsx: End date changed', { value }); } catch { log('PerfSettings.jsx: End date changed', { value }); }
    setEndDate(value);
    logDebug('PerfSettings: End date updated in filterStore', { value, currentEndDate: currentEndDate() });
    // Also call prop handler if provided for backward compatibility
    if (props.onEndDateChange) {
      props.onEndDateChange(value);
    }
  };

  // handleFilterGradesChange removed - grades now use button clicks instead of text input

  const handleFilterYearChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    try { info('PerfSettings.jsx: Filter Year changed', { value }); } catch { log('PerfSettings.jsx: Filter Year changed', { value }); }
    // Only update local state, don't call parent callback yet (wait for Apply)
    setFilterYearValue(value);
  };

  const handleFilterEventChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    try { info('PerfSettings.jsx: Filter Event changed', { value }); } catch { log('PerfSettings.jsx: Filter Event changed', { value }); }
    // Only update local state, don't call parent callback yet (wait for Apply)
    setFilterEventValue(value);
  };

  const handleFilterConfigChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    try { info('PerfSettings.jsx: Filter Config changed', { value }); } catch { log('PerfSettings.jsx: Filter Config changed', { value }); }
    // Only update local state, don't call parent callback yet (wait for Apply)
    setFilterConfigValue(value);
  };

  const handleFilterStateChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    try { info('PerfSettings.jsx: Filter State changed', { value }); } catch { log('PerfSettings.jsx: Filter State changed', { value }); }
    // Only update local state, don't call parent callback yet (wait for Apply)
    setFilterStateValue(value);
  };

  // Use centralized race comparison from raceValueUtils

  // Handler for race filter clicks (day/dataset mode)
  const handleRaceClick = (race: string | number) => {
    try { info('PerfSettings: Race clicked', { race }); } catch {}
    const current = localRaceSelections();
    const next = new Set(current);
    // Check if race already exists (using isSameRace helper)
    const exists = Array.from(next).some(r => isSameRace(r, race));
    if (exists) {
      // Remove by finding the matching value
      const toRemove = Array.from(next).find(r => isSameRace(r, race));
      if (toRemove !== undefined) {
        next.delete(toRemove);
      }
    } else {
      // Normalize race value
      if (race === 'TRAINING' || race === 'training' || race === -1 || race === '-1') {
        next.add('TRAINING');
      } else {
        const num = Number(race);
        next.add(isNaN(num) ? race : num);
      }
    }
    setLocalRaceSelections(next);
    logDebug('PerfSettings: Race toggle - updated local state', { race, selected: !exists, localSelections: Array.from(next) });
  };

  // Handler for leg filter clicks (day/dataset mode)
  const handleLegClick = (leg: number) => {
    try { info('PerfSettings: Leg clicked', { leg }); } catch {}
    const current = localLegSelections();
    const next = new Set(current);
    const legNum = Number(leg);
    if (next.has(legNum)) {
      next.delete(legNum);
    } else {
      next.add(legNum);
    }
    setLocalLegSelections(next);
    logDebug('PerfSettings: Leg toggle - updated local state', { leg, selected: next.has(legNum), localSelections: Array.from(next) });
  };

  // Handler for TRAINING/RACING filter clicks (history mode)
  const handleTrainingRacingClick = (type: 'TRAINING' | 'RACING') => {
    try { info('PerfSettings: Training/Racing clicked', { type }); } catch {}
    const current = localTrainingRacingSelection();
    // Toggle: if same type is clicked, deselect; otherwise select new type
    if (current === type) {
      setLocalTrainingRacingSelection(null);
    } else {
      setLocalTrainingRacingSelection(type);
    }
    logDebug('PerfSettings: Training/Racing toggle - updated local state', { type, selected: current !== type });
  };

  // Handler for grade filter clicks
  const handleGradeClick = (grade: number) => {
    try { info('PerfSettings: Grade clicked', { grade }); } catch {}
    const current = localGradeSelections();
    const next = new Set(current);
    const gradeNum = Number(grade);
    // Validate grade (0 = ignore, 1–3 = normal)
    if (gradeNum !== 0 && gradeNum !== 1 && gradeNum !== 2 && gradeNum !== 3) {
      logDebug('PerfSettings: Invalid grade clicked, ignoring', { grade, gradeNum });
      return;
    }
    if (next.has(gradeNum)) {
      next.delete(gradeNum);
    } else {
      next.add(gradeNum);
    }
    setLocalGradeSelections(next);
    logDebug('PerfSettings: Grade toggle - updated local state', { grade, selected: next.has(gradeNum), localSelections: Array.from(next) });
  };

  // Handler for state filter clicks
  const handleStateClick = (state: string) => {
    try { info('PerfSettings: State clicked', { state }); } catch {}
    const current = localStateSelections();
    const next = new Set(current);
    // Normalize state to uppercase and validate (only H0, H1, H2 are valid)
    const stateStr = String(state).trim().toUpperCase();
    if (stateStr !== 'H0' && stateStr !== 'H1' && stateStr !== 'H2') {
      logDebug('PerfSettings: Invalid state clicked, ignoring', { state, stateStr });
      return;
    }
    // Check if state exists (case-insensitive)
    const exists = Array.from(next).some((val: any) => String(val).trim().toUpperCase() === stateStr);
    if (exists) {
      // Remove by finding the matching value (handles case differences)
      const toRemove = Array.from(next).find((val: any) => String(val).trim().toUpperCase() === stateStr);
      if (toRemove !== undefined) {
        next.delete(toRemove);
      }
    } else {
      // Add state (normalized to uppercase)
      next.add(stateStr);
    }
    setLocalStateSelections(next);
    logDebug('PerfSettings: State toggle - updated local state', { state, stateStr, selected: !exists, localSelections: Array.from(next) });
  };

  // Handler for timeline toggle
  const handleTimelineToggle = async () => {
    const newValue = !showTimelineValue();
    setShowTimelineValue(newValue);
    
    // Save to persistent settings
    try {
      const currentUser = user();
      if (currentUser?.user_id) {
        const { selectedClassName, selectedProjectId } = persistantStore;
        const className = selectedClassName();
        const projectId = selectedProjectId();
        
        if (className && projectId) {
          await persistentSettingsService.saveSettings(
            currentUser.user_id,
            className,
            projectId,
            { showTimeline: newValue }
          );
          logDebug('PerfSettings: Saved timeline preference to persistent settings', newValue);
        }
      }
    } catch (error) {
      logDebug('PerfSettings: Error saving timeline preference to persistent settings:', error);
    }
    
    // Call parent callback if provided
    if (props.onTimelineChange) {
      props.onTimelineChange(newValue);
    }
  };

  // Save sources to persistent settings
  const saveSourcesToPersistentSettings = async (sourceIds: number[]): Promise<void> => {
    const currentUser = user();
    if (currentUser?.user_id) {
      try {
        const { selectedClassName, selectedProjectId } = persistantStore;
        const className = selectedClassName();
        const projectId = selectedProjectId();
        
        if (className && projectId) {
          // Convert source IDs to source names
          const sources = sourcesStore.sources();
          const sourceNames = sourceIds.map((id: number) => {
            const source = sources.find((s: any) => s.source_id === id);
            return source?.source_name || '';
          }).filter((name: string) => name.length > 0);
          
          if (sourceNames.length > 0) {
            await persistentSettingsService.saveSettings(
              currentUser.user_id,
              className,
              projectId,
              { fleetPerformanceSources: sourceNames }
            );
            logDebug('PerfSettings: Saved sources to persistent settings', sourceNames);
          }
        }
      } catch (error: unknown) {
        logDebug('PerfSettings: Error saving sources to persistent settings:', error as any);
      }
    }
  };

  const handleSourceToggle = (sourceName: string, event?: Event) => {
    // Prevent event propagation to avoid closing modal
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    
    // Find the source object to get its ID
    const sources = props.sources || [];
    const source = sources.find(s => {
      const name = typeof s === 'string' ? s : (s?.source_name || s?.name || '');
      return String(name).toLowerCase() === String(sourceName).toLowerCase();
    });
    
    if (!source) {
      logDebug('PerfSettings: handleSourceToggle - source not found:', sourceName);
      return;
    }
    
    const sourceId = typeof source === 'object' && source?.source_id ? source.source_id : null;
    if (sourceId === null || typeof sourceId !== 'number') {
      logDebug('PerfSettings: handleSourceToggle - source ID not found for:', sourceName);
      return;
    }
    
    const currentSources = filterSourcesValue();
    const isSelected = currentSources.includes(sourceId);
    
    let newSources: number[];
    if (isSelected) {
      // Remove source
      newSources = currentSources.filter(id => id !== sourceId);
    } else {
      // Add source
      newSources = [...currentSources, sourceId];
    }
    
    setFilterSourcesValue(newSources);
    
    // Note: Do NOT update filterStore or save to persistent settings here
    // Wait for Apply button to be clicked - changes will be applied in handleApplyFilters
    // This prevents immediate page updates and allows multiple source toggles before applying
  };

  // Clear all filters - update local state
  const handleClearAll = () => {
    setFilterGradesValue('');
    setFilterYearValue('');
    setFilterEventValue('');
    setFilterConfigValue('');
    setFilterStateValue('');
    setLocalRaceSelections(new Set<string | number>());
    setLocalLegSelections(new Set<number>());
    setLocalGradeSelections(new Set<number>());
    setLocalStateSelections(new Set<string>());
    setLocalTrainingRacingSelection(null);
    // Also clear date range if in project mode
    if (sidebarState() === 'project') {
      setStartDate('');
      setEndDate('');
    }
    // Clear sessionStorage to prevent old filters from being loaded
    try {
      sessionStorage.removeItem('performanceFilters');
      logDebug('PerfSettings: Cleared performanceFilters from sessionStorage');
    } catch (error) {
      logDebug('PerfSettings: Error clearing sessionStorage:', error);
    }
    logDebug('PerfSettings: Clear All - updated local state and cleared sessionStorage');
  };

  // Handle Apply button - apply all filter changes and trigger refetch
  const handleApplyFilters = async () => {
    try { info('PerfSettings.jsx: Apply filters', {
      grades: filterGradesValue(),
      year: filterYearValue(),
      event: filterEventValue(),
      config: filterConfigValue()
    }); } catch { log('PerfSettings.jsx: Apply filters'); }
    
    // Save filters to sessionStorage (session only)
    try {
      const filterData = {
        filterGrades: filterGradesValue(),
        filterYear: filterYearValue(),
        filterEvent: filterEventValue(),
        filterConfig: filterConfigValue(),
        filterState: filterStateValue()
      };
      sessionStorage.setItem('performanceFilters', JSON.stringify(filterData));
      logDebug('PerfSettings: Saved filters to sessionStorage');
    } catch (error) {
      logDebug('PerfSettings: Error saving filters to sessionStorage:', error);
    }
    
    // Apply TRAINING/RACING filter (via callback, for both day/dataset and history mode)
    const trSelection = localTrainingRacingSelection();
    if (props.onTrainingRacingFilterChange) {
      props.onTrainingRacingFilterChange(trSelection);
    }
    logDebug('PerfSettings: Applied TRAINING/RACING filter', { selection: trSelection, mode: isDayDatasetMode() ? 'day/dataset' : 'history' });
    
    // Apply race/leg filters for day/dataset mode (using filterStore, like grade/state)
    if (isDayDatasetMode()) {
      const races = Array.from(localRaceSelections()).map(r => String(r));
      const legs = Array.from(localLegSelections()).map(l => String(l));
      setSelectedRacesAggregates(races);
      setSelectedLegsAggregates(legs);
      logDebug('PerfSettings: Applied race/leg filters', { races, legs });
    }
    
    // Update parent state with current values
    // Convert grade/state selections to comma-separated strings
    // Filter to only include valid grades (0 = ignore, 1–3) and states (H0, H1, H2)
    const validGrades = Array.from(localGradeSelections())
      .filter(g => g === 0 || g === 1 || g === 2 || g === 3)
      .sort((a, b) => a - b);
    const validStates = Array.from(localStateSelections())
      .map(s => String(s).trim().toUpperCase())
      .filter(s => s === 'H0' || s === 'H1' || s === 'H2')
      .sort();
    // Join without spaces to ensure consistent parsing (comma-separated, no spaces)
    const gradesString = validGrades.join(',');
    const statesString = validStates.join(',');
    
    if (props.onFilterGradesChange) {
      props.onFilterGradesChange(gradesString);
      setFilterGradesValue(gradesString);
    }
    if (props.onFilterYearChange) {
      props.onFilterYearChange(filterYearValue());
    }
    if (props.onFilterEventChange) {
      props.onFilterEventChange(filterEventValue());
    }
    if (props.onFilterConfigChange) {
      props.onFilterConfigChange(filterConfigValue());
    }
    if (props.onFilterStateChange) {
      props.onFilterStateChange(statesString);
      setFilterStateValue(statesString);
    }
    // Update filterStore so FleetPerformance / FleetPerformanceHistory (which read selectedStatesAggregates/selectedGradesAggregates) re-filter correctly
    setSelectedStatesAggregates(validStates);
    setSelectedGradesAggregates(validGrades.map(String));
    if (props.onFilterSourcesChange) {
      props.onFilterSourcesChange(filterSourcesValue());
    }
    
    // Save sources to persistent settings when Apply is clicked
    saveSourcesToPersistentSettings(filterSourcesValue());
    
    // Update initial values to current values (so changes are cleared)
    setInitialFilterGrades(gradesString);
    setInitialFilterYear(filterYearValue());
    setInitialFilterEvent(filterEventValue());
    setInitialFilterConfig(filterConfigValue());
    setInitialFilterState(statesString);
    setInitialFilterSources([...filterSourcesValue()]);
    
    // Update initial TRAINING/RACING selection (for both day/dataset and history mode)
    setInitialTrainingRacingSelection(localTrainingRacingSelection());
    
    // Update initial race/leg selections (for day/dataset mode)
    if (isDayDatasetMode()) {
      setInitialRaceSelections(new Set(localRaceSelections()));
      setInitialLegSelections(new Set(localLegSelections()));
    }
    
    // Update initial grade/state selections
    setInitialGradeSelections(new Set(localGradeSelections()));
    setInitialStateSelections(new Set(localStateSelections()));
    
    // Call onApplyFilters callback if provided to trigger data refetch
    if (props.onApplyFilters) {
      props.onApplyFilters();
    }
  };

  const [saveDefaultSuccessFlash, setSaveDefaultSuccessFlash] = createSignal(false);

  const handleSaveDefaultFilters = async (): Promise<void> => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    if (!className || !projectId) {
      logDebug('PerfSettings: Save default filters skipped - no class or project');
      return;
    }
    // Resolve date for project_objects save: dataset mode -> date from dataset API; day mode (FleetPerformance) -> selectedDate so save goes to the visible date
    const datasetId = persistantStore.selectedDatasetId?.();
    const id = typeof datasetId === 'function' ? Number(datasetId()) : 0;
    let rawDate: string = '';
    if (id > 0 && className && projectId) {
      try {
        const response = await getData(
          `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(id)}`
        );
        if (response?.success && response?.data?.date) {
          let dateStr = String(response.data.date);
          if (dateStr.length === 8 && !dateStr.includes('-')) {
            dateStr = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
          }
          rawDate = dateStr;
          logDebug('PerfSettings: Resolved date from dataset for save default filters', { datasetId: id, date: rawDate });
        }
      } catch (e) {
        logDebug('PerfSettings: Could not resolve date from dataset_id, using selectedDate/startDate', e);
      }
    }
    if (!rawDate) {
      // Day mode (FleetPerformance with a date): use selectedDate so we save to the date the user is viewing
      const dayDate = (persistantStore.selectedDate?.() || '').trim();
      rawDate = dayDate || startDate() || '';
    }
    const dateToSave = (() => {
      const d = (rawDate && typeof rawDate === 'string') ? rawDate.trim() : '';
      if (!d) return '1970-01-01';
      if (d.length === 8 && !d.includes('-')) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      return d;
    })();
    const validGrades = Array.from(localGradeSelections())
      .filter(g => g === 0 || g === 1 || g === 2 || g === 3)
      .sort((a, b) => a - b);
    const validStates = Array.from(localStateSelections())
      .map(s => String(s).trim().toUpperCase())
      .filter(s => s === 'H0' || s === 'H1' || s === 'H2')
      .sort();
    const grades = validGrades.length > 0 ? validGrades.join(',') : filterGradesValue();
    const state = validStates.length > 0 ? validStates.join(',') : filterStateValue();
    try {
      const response = await postData(`${apiEndpoints.app.projects}/object`, {
        class_name: className,
        project_id: projectId,
        date: dateToSave,
        object_name: 'performance_filters',
        json: JSON.stringify({ grades: grades || '', state: state || '' })
      });
      if (response?.success) {
        logDebug('PerfSettings: Saved default performance filters to project_objects', { grades, state });
        setSaveDefaultSuccessFlash(true);
        setTimeout(() => setSaveDefaultSuccessFlash(false), 1200);
      } else {
        logError('PerfSettings: Failed to save default performance filters', response?.message ?? 'Unknown error');
      }
    } catch (err) {
      logError('PerfSettings: Error saving default performance filters', err as Error);
    }
  };

  return (
    <>
      <div class="relative inline-block settings-parent">
        <Show when={props.useIconTrigger} fallback={
          <button
            onClick={() => {
              const next = !showPopup();
              setShowPopup(next);
              try { info('PerfSettings.jsx: Toggle modal', { open: next }); } catch { log('PerfSettings.jsx: Toggle modal', { open: next }); }
            }}
            onContextMenu={(e) => e.preventDefault()}
            class="dropdown py-2 px-3 rounded-md flex flex-col items-center forced-medium"
            style="background: var(--color-bg-button); color: var(--color-text-inverse); transition: all 0.3s ease;"
          >
            <span class="self-start text-xs font-medium">Settings</span>
            <span class="text-sm font-bold">Performance</span>
          </button>
        }>
          {/* Icon-only trigger - no button background */}
          <div
            onClick={() => {
              const next = !showPopup();
              setShowPopup(next);
              try { info('PerfSettings.jsx: Toggle modal', { open: next }); } catch { log('PerfSettings.jsx: Toggle modal', { open: next }); }
            }}
            onContextMenu={(e) => e.preventDefault()}
            class="performance-settings-icon cursor-pointer p-1 hover:opacity-70 transition-opacity"
          >
            <FiSettings size={24} />
          </div>
        </Show>
      </div>

      {/* Modal Overlay */}
      <Show when={showPopup()}>
        <Portal mount={typeof document !== 'undefined' ? (document.getElementById('main-content') || document.body) : undefined}>
          <div
            class="pagesettings-overlay"
          >
            <div
              ref={el => (modalContentRef = el)}
              class="pagesettings-modal"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div class="flex justify-between items-center p-4 border-b" style="border-color: var(--color-border-primary);">
                <h2 class="text-lg font-semibold" style="color: var(--color-text-primary);">Page Settings</h2>
                <Show 
                  when={!(sidebarState() === 'project' && hasDateChanges()) && !hasFilterOrHighlightChanges() && !hasSourceChanges()} 
                  fallback={
                    <div class="w-6 h-6"></div>
                  }
                >
                  <button
                    onClick={() => setShowPopup(false)}
                    class="text-gray-500 hover:text-gray-700 transition-colors"
                    style="color: var(--color-text-secondary);"
                  >
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                  </button>
                </Show>
              </div>

              {/* Modal Body */}
              <div class="p-6">
                {/* Data Sources Section - shown above Display Options when provided (dataSourcesOptions pattern) */}
                <Show when={Array.isArray(props.dataSourcesOptions) && props.dataSourcesOptions.length > 0}>
                  <div class="mb-6">
                    <div class="flex items-center justify-between mb-3">
                      <h3 class="text-base font-semibold" style="color: var(--color-text-primary);">Data Sources</h3>
                      <div class="flex gap-2">
                        <button
                          class="px-2 py-1 text-xs rounded-md"
                          style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                          onClick={() => {
                            try {
                              // Update local state to select all sources
                              if (Array.isArray(props.dataSourcesOptions)) {
                                const allIds = new Set<number>(
                                  props.dataSourcesOptions
                                    .map((opt: any) => {
                                      const match = opt.key?.match(/source-(\d+)/);
                                      return match ? Number(match[1]) : null;
                                    })
                                    .filter((id: any): id is number => id !== null)
                                );
                                setLocalSourceSelections(allIds);
                                logDebug('PerfSettings: Select All - updated local state', { count: allIds.size });
                              }
                            } catch (err) {
                              logDebug('PerfSettings: Error selecting all sources', err);
                            }
                          }}
                        >
                          Select All
                        </button>
                        <button
                          class="px-2 py-1 text-xs rounded-md"
                          style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                          onClick={() => {
                            try {
                              // Update local state to deselect all sources
                              setLocalSourceSelections(new Set<number>());
                              logDebug('PerfSettings: None - updated local state');
                            } catch (err) {
                              logDebug('PerfSettings: Error deselecting all sources', err);
                            }
                          }}
                        >
                          None
                        </button>
                      </div>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      {(() => {
                        if (!Array.isArray(props.dataSourcesOptions)) return [];
                        // Sort sources by source_id extracted from key (e.g., "source-8" -> 8)
                        // This ensures consistent ordering with ManeuverSettings and PageSettings
                        const sortedOptions = [...props.dataSourcesOptions].sort((a, b) => {
                          const aMatch = a.key?.match(/source-(\d+)/);
                          const bMatch = b.key?.match(/source-(\d+)/);
                          const aId = aMatch ? Number(aMatch[1]) : 0;
                          const bId = bMatch ? Number(bMatch[1]) : 0;
                          return aId - bId;
                        });
                        
                        return sortedOptions.map((option: any) => {
                          // Try to get source color from sourcesStore
                          const sourceName = option.label || option.name || '';
                          const sourceColor = sourcesStore.getSourceColor(sourceName);
                          
                          // Create a reactive getter that uses local state for source toggles
                          const getIsSelected = () => {
                            try {
                              // For source toggles, use local state
                              if (option.key?.startsWith('source-')) {
                                const match = option.key.match(/source-(\d+)/);
                                if (match) {
                                  const sourceId = Number(match[1]);
                                  return localSourceSelections().has(sourceId);
                                }
                              }
                              // For other toggles, use signal directly
                              const signalGetter = option.signal?.[0];
                              return signalGetter && typeof signalGetter === 'function' ? signalGetter() : false;
                            } catch {
                              return false;
                            }
                          };
                          
                          return (
                            <span
                              class={`px-3 py-1 rounded-full text-sm cursor-pointer font-medium transition-colors ${
                                getIsSelected() 
                                  ? 'bg-blue-600 text-white' 
                                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                              }`}
                              style={getIsSelected() && sourceColor ? `background-color: ${sourceColor}; color: white;` : ''}
                              onClick={() => {
                                // Handle source toggle - update local state
                                if (option.key?.startsWith('source-')) {
                                  const match = option.key.match(/source-(\d+)/);
                                  if (match) {
                                    const sourceId = Number(match[1]);
                                    const current = localSourceSelections();
                                    const next = new Set(current);
                                    if (next.has(sourceId)) {
                                      next.delete(sourceId);
                                    } else {
                                      next.add(sourceId);
                                    }
                                    setLocalSourceSelections(next);
                                    logDebug('PerfSettings: Source toggle - updated local state', { sourceId, selected: next.has(sourceId), localSelections: Array.from(next) });
                                  }
                                } else if (option.type === 'toggle' && option.signal && option.signal.length === 2) {
                                  // For non-source toggles, apply immediately
                                  const [getter, setter] = option.signal;
                                  const currentValue = typeof getter === 'function' ? getter() : getter;
                                  setter(!currentValue);
                                }
                              }}
                            >
                              {option.label}
                            </span>
                          );
                        });
                      })()}
                    </div>
                  </div>
                </Show>
                
                {/* Legacy Source Filter Section (for backward compatibility with old sources prop) */}
                <Show when={!props.dataSourcesOptions && props.sources && Array.isArray(props.sources) && props.sources.length > 0}>
                  <div class="mb-6">
                    <h3 class="text-base font-semibold mb-3" style="color: var(--color-text-primary);">Sources</h3>
                    <div class="flex flex-wrap gap-2">
                      <For each={sortedSources()}>
                        {(source) => {
                          const sourceName = typeof source === 'string' ? source : (source?.source_name || source?.name || '');
                          const sourceColor = sourcesStore.getSourceColor(sourceName);
                          const sourceId = typeof source === 'object' && source?.source_id ? source.source_id : null;
                          const isSelected = () => {
                            if (sourceId === null || typeof sourceId !== 'number') return false;
                            return filterSourcesValue().includes(sourceId);
                          };
                          
                          return (
                            <button
                              type="button"
                              onClick={(e) => handleSourceToggle(sourceName, e)}
                              onMouseDown={(e) => {
                                // Prevent mousedown from triggering outside click handler
                                e.stopPropagation();
                              }}
                              class={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                                isSelected() 
                                  ? 'bg-blue-600 text-white' 
                                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                              }`}
                              style={isSelected() && sourceColor ? `background-color: ${sourceColor}; color: white;` : ''}
                            >
                              {sourceName}
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </Show>
                
                {/* Row 1: Data Range and Filters (Project Mode) */}
                <div class="mb-6">
                  <h3 class="text-base font-semibold mb-3" style="color: var(--color-text-primary);">Filter Options</h3>
                  <Show when={sidebarState() === 'project'}>
                    <div class="pagesettings-modal-row1">
                      {/* Start Date */}
                      <div>
                        <label class="block text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Start Date</label>
                        <input
                          type="date"
                          value={currentStartDate()}
                          onInput={handleStartDateChange}
                          class="w-full px-3 py-2 rounded-md border"
                          style="background: var(--color-bg-primary); color: var(--color-text-primary); border-color: var(--color-border-primary);"
                        />
                      </div>
                      {/* End Date */}
                      <div>
                        <label class="block text-sm font-medium mb-2" style="color: var(--color-text-secondary);">End Date</label>
                        <input
                          type="date"
                          value={currentEndDate()}
                          onInput={handleEndDateChange}
                          class="w-full px-3 py-2 rounded-md border"
                          style="background: var(--color-bg-primary); color: var(--color-text-primary); border-color: var(--color-border-primary);"
                        />
                      </div>
                      {/* Grades - removed, now shown as buttons below */}
                      {/* Year */}
                      <div>
                        <label class="block text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Year</label>
                        <input
                          type="text"
                          value={filterYearValue()}
                          onInput={handleFilterYearChange}
                          placeholder="Example: 2023, 2024"
                          class="w-full px-3 py-2 rounded-md border"
                          style="background: var(--color-bg-primary); color: var(--color-text-primary); border-color: var(--color-border-primary);"
                        />
                      </div>
                    </div>
                  </Show>
                </div>

                {/* Row 2: Event, Config, State (Project Mode) OR Grades, State (Non-Project Mode) */}
                <div class="mb-6">
                  <Show when={sidebarState() === 'project'}>
                    {/* Project Mode: Event, Config, State on same row */}
                    <div class="pagesettings-modal-row2">
                      {/* Left Column - Event */}
                      <div>
                        <label class="block text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Event</label>
                        <input
                          type="text"
                          value={filterEventValue()}
                          onInput={handleFilterEventChange}
                          placeholder="Example: PERTH"
                          class="w-full px-3 py-2 rounded-md border"
                          style="background: var(--color-bg-primary); color: var(--color-text-primary); border-color: var(--color-border-primary);"
                        />
                      </div>
                      {/* Right Column - Config */}
                      <div>
                        <label class="block text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Config</label>
                        <input
                          type="text"
                          value={filterConfigValue()}
                          onInput={handleFilterConfigChange}
                          placeholder="Example: M15-HW1-C6"
                          class="w-full px-3 py-2 rounded-md border"
                          style="background: var(--color-bg-primary); color: var(--color-text-primary); border-color: var(--color-border-primary);"
                        />
                      </div>
                    </div>
                  </Show>
                  <Show when={sidebarState() !== 'project'}>
                    {/* Non-Project Mode: Grades and State on same row */}
                    <div class="pagesettings-modal-row2">
                      {/* Grades and State - removed, now shown as buttons below */}
                    </div>
                  </Show>
                </div>

                {/* Grade, State & Training/Racing Filters Section */}
                <div class="mb-6">
                  <div class="flex items-start gap-6">
                    {/* Left Column - Grade Filters */}
                    <div class="flex-1">
                      <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">Grade Filters</div>
                      <div class="flex flex-wrap gap-2">
                        {gradeOptions().map((grade) => {
                              const gradeNum = Number(grade);
                              const isSelected = () => localGradeSelections().has(gradeNum);
                              return (
                                <span
                                  class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                                    isSelected()
                                      ? "bg-orange-500 text-white"
                                      : "bg-gray-200 text-gray-700"
                                  }`}
                                  onClick={() => handleGradeClick(gradeNum)}
                                  onContextMenu={(e) => e.preventDefault()}
                                >
                                  {grade}
                                </span>
                              );
                            })}
                      </div>
                    </div>

                    {/* Middle Column - State Filters */}
                    <div class="flex-1">
                      <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">State Filters</div>
                      <div class="flex flex-wrap gap-2">
                        {stateOptions().map((state) => {
                          const isSelected = () => {
                            return Array.from(localStateSelections()).some((val: any) => String(val).trim().toLowerCase() === String(state).trim().toLowerCase());
                          };
                          return (
                            <span
                              class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                                isSelected()
                                  ? "bg-green-500 text-white"
                                  : "bg-gray-200 text-gray-700"
                              }`}
                              onClick={() => handleStateClick(state)}
                              onContextMenu={(e) => e.preventDefault()}
                            >
                              {state}
                            </span>
                          );
                        })}
                      </div>
                    </div>

                    {/* Right Column - Training/Racing Filters */}
                    <div class="flex-1">
                      <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">Training/Racing</div>
                      <div class="flex flex-wrap gap-2">
                        {(['TRAINING', 'RACING'] as const).map((type) => {
                          const isSelected = () => localTrainingRacingSelection() === type;
                          return (
                            <span
                              class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                                isSelected()
                                  ? "bg-blue-500 text-white"
                                  : "bg-gray-200 text-gray-700"
                              }`}
                              onClick={() => handleTrainingRacingClick(type)}
                              onContextMenu={(e) => e.preventDefault()}
                            >
                              {type}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Race/Leg Filters Section - Show in day/dataset mode only when RACING is selected */}
                <Show when={isDayDatasetMode() && localTrainingRacingSelection() === 'RACING'}>
                  <div class="mb-6">
                    {/* Race Filters */}
                    <Show when={raceOptions().length > 0}>
                      <div class="mb-4">
                        <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">Race Filters</div>
                        <div class="flex flex-wrap gap-2">
                          {raceOptions()
                            .filter((race) => {
                              // When RACING is selected, exclude TRAINING from race filters
                              const raceValue = race === 'TRAINING' || race === 'training' || race === '-1' || Number(race) === -1 ? 'TRAINING' : race;
                              return raceValue !== 'TRAINING';
                            })
                            .map((race) => {
                              const raceValue = race === 'TRAINING' || race === 'training' || race === '-1' || Number(race) === -1 ? 'TRAINING' : race;
                              const raceDisplay = formatRaceForDisplay(raceValue);
                              const isSelected = () => {
                                return Array.from(localRaceSelections()).some(r => isSameRace(r, raceValue));
                              };
                              return (
                                <span
                                  class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                                    isSelected()
                                      ? "bg-blue-500 text-white"
                                      : "bg-gray-200 text-gray-700"
                                  }`}
                                  onClick={() => handleRaceClick(raceValue)}
                                  onContextMenu={(e) => e.preventDefault()}
                                >
                                  {raceDisplay}
                                </span>
                              );
                            })}
                        </div>
                      </div>
                    </Show>

                    {/* Leg Filters */}
                    <Show when={legOptions().filter(leg => Number(leg) >= 0).length > 0}>
                      <div class="mb-4">
                        <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">Leg Filters</div>
                        <div class="flex flex-wrap gap-2">
                          {legOptions().filter(leg => Number(leg) >= 0).map((leg) => {
                            const legNum = Number(leg);
                            const isSelected = () => localLegSelections().has(legNum);
                            return (
                              <span
                                class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                                  isSelected()
                                    ? "bg-purple-500 text-white"
                                    : "bg-gray-200 text-gray-700"
                                }`}
                                onClick={() => handleLegClick(legNum)}
                                onContextMenu={(e) => e.preventDefault()}
                              >
                                {leg}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </Show>
                  </div>
                </Show>


                {/* Row 3: Display Options in Two Columns */}
                <div class="mb-6">
                  <h3 class="text-base font-semibold mb-3" style="color: var(--color-text-primary);">Display Options</h3>
                  <div class="pagesettings-modal-row3">
                    {/* Left Column */}
                    <div>
                      {/* X-Axis Channel - only relevant for scatter mode */}
                      <Show when={selectedPlotType() === 'Scatter'}>
                        <div class="mb-3">
                          <div class="text-sm font-medium mb-2" style="color: var(--color-text-secondary);">X-Axis Channel</div>
                          <div class="flex flex-wrap gap-2">
                            {[twsName(), bspName()].map((opt) => (
                              <span
                                class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                                  selectedXAxis() === opt ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700"
                                }`}
                                onClick={() => handleXAxisChange(opt)}
                                onContextMenu={(e) => e.preventDefault()}
                              >
                                {opt}
                              </span>
                            ))}
                          </div>
                        </div>
                      </Show>
                      
                      {/* ============================================================================
                          CLOUD DATA BUTTONS - TEMPORARILY HIDDEN
                          ============================================================================
                          TO RESTORE CLOUD DATA BUTTONS:
                          1. Remove the "return null;" line below
                          2. Uncomment the code block that follows
                          3. Ensure cloud data fetching is enabled in Performance.tsx
                          4. Ensure cloud rendering is enabled in AdvancedScatter.tsx
                          
                          The buttons allow users to select:
                          - '1Hz Scatter' (Latest cloud data)
                          - 'Recent History' (Recent cloud data)
                          - 'Fleet Data' (Fleet-wide cloud data)
                          ============================================================================ */}
                      {/* Cloud Data - TEMPORARILY HIDDEN */}
                      {(() => {
                        // TEMPORARILY DISABLED - return null to hide cloud data buttons
                        return null;
                        
                        // Allow pages to drive options; fallback to defaults
                        // const provided = props.cloudDataOptions || null;
                        // const isProjectReport = sidebarState() === 'project';
                        // const fallback = isProjectReport 
                        //   ? ['1Hz Scatter', 'Fleet Data']
                        //   : ['1Hz Scatter', 'Recent History', 'Fleet Data'];
                        // const cloudDataOptions = provided !== null ? provided : fallback;
                        
                        // if (!cloudDataOptions || cloudDataOptions.length === 0) {
                        //   return null; // hide section entirely
                        // }
                        
                        // return (
                        //   <div class="mb-3">
                        //     <div class="text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Cloud Data</div>
                        //     <div class="flex flex-wrap gap-2">
                        //       <For each={cloudDataOptions}>
                        //         {(opt) => {
                        //           const isSelected = () => {
                        //             const selected = selectedCloudData();
                        //             const matches = selected === opt;
                        //             logDebug(`PerfSettings: Option "${opt}", selected="${selected}", isSelected=${matches}`);
                        //             return matches;
                        //           };
                        //           return (
                        //             <span
                        //               class="px-3 py-1 rounded-full text-sm cursor-pointer"
                        //               classList={{
                        //                 "bg-blue-600 text-white": isSelected(),
                        //                 "bg-gray-200 text-gray-700": !isSelected()
                        //               }}
                        //               onClick={() => handleCloudDataChange(opt)}
                        //               onContextMenu={(e) => e.preventDefault()}
                        //             >
                        //               {opt}
                        //             </span>
                        //           );
                        //         }}
                        //       </For>
                        //     </div>
                        //   </div>
                        // );
                      })()}
                      
                      {/* Plot Type */}
                      <div class="mb-3">
                        <div class="text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Plot Type</div>
                        <div class="flex flex-wrap gap-2">
                          {(() => {
                            const plotTypeOptions = ['Scatter', 'Box'];
                            if (props.showDataTable) {
                              plotTypeOptions.push('Data Table');
                            }
                            return plotTypeOptions;
                          })().map((opt) => {
                            const displayText = opt === 'Scatter' ? 'Scatter Plots' : opt === 'Box' ? 'Box Plots' : 'Data Table';
                            return (
                              <span
                                class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                                  selectedPlotType() === opt ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700"
                                }`}
                                onClick={() => {
                                  setSelectedPlotTypeValue(opt);
                                  if (props.onPlotTypeChange) {
                                    props.onPlotTypeChange(opt);
                                  }
                                }}
                                onContextMenu={(e) => e.preventDefault()}
                              >
                                {displayText}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* Right Column */}
                    <div>
                      {/* Timeline Toggle */}
                      <div class="mb-3">
                        <div class="text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Timeline</div>
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleTimelineToggle}
                            class={`px-3 py-1 rounded-full text-sm cursor-pointer transition-colors ${
                              showTimeline() ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700"
                            }`}
                            onContextMenu={(e) => e.preventDefault()}
                          >
                            {showTimeline() ? 'ON' : 'OFF'}
                          </button>
                          <span class="text-xs" style="color: var(--color-text-secondary);">
                            Show timeline chart
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div class="flex justify-between items-center p-4 border-t" style="border-color: var(--color-border-primary);">
                <div class="flex gap-2">
                  <button
                    onClick={handleClearAll}
                    class="px-4 py-2 text-sm rounded-md transition-colors"
                    style="background: var(--color-text-error); color: var(--color-text-inverse);"
                    onMouseEnter={(e) => {
                      const btn = e.currentTarget;
                      if (btn) btn.style.backgroundColor = 'var(--color-bg-button-hover)';
                    }}
                    onMouseLeave={(e) => {
                      const btn = e.currentTarget;
                      if (btn) btn.style.backgroundColor = 'var(--color-text-error)';
                    }}
                  >
                    Clear Filters
                  </button>
                  <Show when={!isReader()}>
                    <button
                      onClick={() => handleSaveDefaultFilters()}
                      class="px-4 py-2 text-sm rounded-md transition-colors"
                      style={saveDefaultSuccessFlash()
                        ? 'background: #10b981; color: white; transition: background-color 0.2s ease, color 0.2s ease;'
                        : 'background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);'}
                      onMouseEnter={(e) => {
                        if (saveDefaultSuccessFlash()) return;
                        const btn = e.currentTarget;
                        if (btn) btn.style.backgroundColor = 'var(--color-bg-button-secondary-hover)';
                      }}
                      onMouseLeave={(e) => {
                        const btn = e.currentTarget;
                        if (btn) btn.style.backgroundColor = saveDefaultSuccessFlash() ? '#10b981' : 'var(--color-bg-button-secondary)';
                      }}
                    >
                      Save default filters
                    </button>
                  </Show>
                </div>
                
                <div class="flex gap-2">
                  <Show when={(props.builderRoute || true) && !isReader()}>
                    <button
                      onClick={() => {
                        setShowPopup(false);
                        const route = props.builderRoute || '/performance-builder';
                        navigate(route);
                      }}
                      class="px-4 py-2 text-sm rounded-md transition-colors font-medium"
                      style="background: #2563eb; color: white;"
                      onMouseEnter={(e) => {
                        const btn = e.currentTarget;
                        if (btn) btn.style.backgroundColor = '#1d4ed8';
                      }}
                      onMouseLeave={(e) => {
                        const btn = e.currentTarget;
                        if (btn) btn.style.backgroundColor = '#2563eb';
                      }}
                    >
                      Page Builder
                    </button>
                  </Show>
                  <Show 
                    when={(sidebarState() === 'project' && hasDateChanges()) || hasFilterOrHighlightChanges() || hasSourceChanges()} 
                    fallback={
                      <button
                        onClick={() => setShowPopup(false)}
                        class="px-4 py-2 text-sm rounded-md transition-colors"
                        style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                        onMouseEnter={(e) => {
                          const btn = e.currentTarget;
                          if (btn) btn.style.backgroundColor = 'var(--color-bg-button-secondary-hover)';
                        }}
                        onMouseLeave={(e) => {
                          const btn = e.currentTarget;
                          if (btn) btn.style.backgroundColor = 'var(--color-bg-button-secondary)';
                        }}
                      >
                        Close
                      </button>
                    }
                  >
                    <button
                      onClick={async () => {
                        // Handle source changes (for dataSourcesOptions pattern)
                        if (hasSourceChanges()) {
                          await handleApplySourceChanges();
                        }
                        
                        // Handle filter/highlight changes
                        if (hasFilterOrHighlightChanges()) {
                          handleApplyFilters();
                        }
                        
                        // Handle date changes if in project mode
                        if (sidebarState() === 'project' && hasDateChanges()) {
                          if (props.onSaveDateRange) {
                            props.onSaveDateRange(currentStartDate(), currentEndDate());
                          }
                          setInitialStartDate(currentStartDate());
                          setInitialEndDate(currentEndDate());
                        }
                        
                        // Close modal after applying changes
                        setShowPopup(false);
                      }}
                      class="px-4 py-2 text-sm rounded-md transition-colors font-medium"
                      style="background: #10b981; color: white;"
                      onMouseEnter={(e) => {
                        const btn = e.currentTarget;
                        if (btn) btn.style.backgroundColor = '#059669';
                      }}
                      onMouseLeave={(e) => {
                        const btn = e.currentTarget;
                        if (btn) btn.style.backgroundColor = '#10b981';
                      }}
                    >
                      Apply
                    </button>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}

