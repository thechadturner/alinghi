import { createSignal, createEffect, Show, createMemo, onMount, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { FiSettings } from "solid-icons/fi";
import { unifiedDataStore } from "../../store/unifiedDataStore";
import { persistantStore } from "../../store/persistantStore";
import { sourcesStore } from "../../store/sourcesStore";
import { info, debug, log, error as logError } from "../../utils/console";
import { postData } from "../../utils/global";
import { apiEndpoints } from "@config/env";
import { getRaceAndLegOptions } from "../../services/raceLegOptionsService";
import { user } from "../../store/userStore";
import { persistentSettingsService } from "../../services/persistentSettingsService";
import { setRaceOptions, setLegOptions, startDate, endDate, setStartDate, setEndDate, initializeDateRange, setSelectedGradesManeuvers, setSelectedStatesManeuvers, setSelectedRacesManeuvers, setSelectedLegsManeuvers } from "../../store/filterStore";
import { sidebarState } from "../../store/globalStore";
import { isSameRace, formatRaceForDisplay } from "../../utils/raceValueUtils";

interface ManeuverSettingsProps {
  // Filter options
  raceOptions?: (number | string)[];
  legOptions?: number[];
  gradeOptions?: number[];
  stateOptions?: string[];
  // Selected filter values
  selectedRaces?: (number | string)[] | (() => (number | string)[]);
  selectedLegs?: number[] | (() => number[]);
  selectedGrades?: number[] | (() => number[]);
  selectedStates?: string[] | (() => string[]);
  // Setters for options
  setLegOptions?: (options: number[]) => void;
  setRaceOptions?: (options: (number | string)[]) => void;
  setGradeOptions?: (options: number[]) => void;
  setStateOptions?: (options: string[]) => void;
  // Toggle handlers for filters
  toggleRaceFilter?: (race: number | string) => void;
  toggleLegFilter?: (leg: number) => void;
  toggleGradeFilter?: (grade: number) => void;
  toggleStateFilter?: (state: string) => void;
  // Apply filter handler (called when Apply button is clicked)
  onApplyFilters?: () => void;
  // Project-specific filter props (Year, Event, Config, State) - same as PerfSettings
  filterYear?: string | (() => string);
  filterEvent?: string | (() => string);
  filterConfig?: string | (() => string);
  filterState?: string | (() => string);
  onFilterYearChange?: (year: string) => void;
  onFilterEventChange?: (event: string) => void;
  onFilterConfigChange?: (config: string) => void;
  onFilterStateChange?: (state: string) => void;
  // Local TRAINING/RACING filter callbacks (for history mode) - these filters are local to the page, not in filterStore
  selectedTrainingRacing?: 'TRAINING' | 'RACING' | null | (() => 'TRAINING' | 'RACING' | null);
  onTrainingRacingFilterChange?: (type: 'TRAINING' | 'RACING' | null) => void;
  /** Called when race/leg options have finished loading for the current day/dataset. Use to e.g. clear RACING filter when no races are found. */
  onRaceLegOptionsLoaded?: (racesCount: number) => void;
  // Configuration
  useUnfilteredOptions?: boolean;
  /** When true (Maneuver and Fleet Maneuver pages only), add "All" grade option (-1) meaning grade > -1 */
  includeAllGradeOption?: boolean;
  componentConfig?: {
    showGrades?: boolean;
    showTWA?: boolean;
    showRaces?: boolean;
    showLegs?: boolean;
    showStates?: boolean;
    showPhases?: boolean;
    showPeriods?: boolean;
    showBins?: boolean;
    showHeadsail?: boolean;
    showMainsail?: boolean;
    showConfiguration?: boolean;
  };
  // Legacy prop name for backward compatibility
  filterConfig?: {
    showGrades?: boolean;
    showTWA?: boolean;
    showRaces?: boolean;
    showLegs?: boolean;
    showStates?: boolean;
    showPhases?: boolean;
    showPeriods?: boolean;
    showBins?: boolean;
    showHeadsail?: boolean;
    showMainsail?: boolean;
    showConfiguration?: boolean;
  };
  // Data sources
  dataSourcesOptions?: Array<{
    key?: string;
    label?: string;
    name?: string;
    signal?: [() => boolean, (value: boolean) => void];
  }>;
  // Display options (currently hidden but may be used later)
  displayOptions?: Array<{
    label?: string;
    signal?: [() => boolean, (value: boolean) => void];
  }>;
  hideOverlayOptionsLabel?: boolean;
  // Hide Display Options section
  hideDisplayOptions?: boolean;
  // Timeline visibility
  showTimeline?: () => boolean;
  onTimelineChange?: (value: boolean) => void;
  // UI
  useIconTrigger?: boolean;
  [key: string]: any;
}

export default function ManeuverSettings(props: ManeuverSettingsProps) {
  const [showPopup, setShowPopup] = createSignal(false);

  const isReader = (): boolean => {
    const currentUser = user();
    if (!currentUser) return false;
    const userPermissions = currentUser.permissions;
    const permission = Array.isArray(userPermissions) ? userPermissions[0] : userPermissions;
    return permission === 'reader';
  };

  // Local state for source selections (deferred until Apply is clicked)
  const [localSourceSelections, setLocalSourceSelections] = createSignal<Set<number>>(new Set());
  const [initialSourceSelections, setInitialSourceSelections] = createSignal<Set<number>>(new Set());

  // Local state for filter selections (deferred until Apply is clicked)
  const [localRaceSelections, setLocalRaceSelections] = createSignal<Set<number | string>>(new Set());
  const [localLegSelections, setLocalLegSelections] = createSignal<Set<number>>(new Set());
  const [localGradeSelections, setLocalGradeSelections] = createSignal<Set<number>>(new Set());
  const [localStateSelections, setLocalStateSelections] = createSignal<Set<string>>(new Set());
  const [initialFilterSelections, setInitialFilterSelections] = createSignal<{
    races: Set<number | string>;
    legs: Set<number>;
    grades: Set<number>;
    states: Set<string>;
  }>({ races: new Set(), legs: new Set(), grades: new Set(), states: new Set() });

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

  // Load timeline preference from persistent settings on mount (background)
  onMount(() => {
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
              debug('ManeuverSettings: Loaded timeline preference from persistent settings', settings.showTimeline);
            }
          }
        }
      } catch (error) {
        debug('ManeuverSettings: Error loading timeline preference from persistent settings:', error);
      }
    })();
  });

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
          debug('ManeuverSettings: Saved timeline preference to persistent settings', newValue);
        }
      }
    } catch (error) {
      debug('ManeuverSettings: Error saving timeline preference to persistent settings:', error);
    }
    
    // Call parent callback if provided
    if (props.onTimelineChange) {
      props.onTimelineChange(newValue);
    }
  };

  // Project-specific filter state (Year, Event, Config, State) - same as PerfSettings
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
    // filterConfig prop is for the filter value (string), not the component config (object)
    // Check if it's a function first, then check if it's a string (not an object)
    if (props.filterConfig && typeof props.filterConfig === 'function') {
      return props.filterConfig();
    }
    // If it's a string, use it; if it's an object, it's the component config, so return empty string
    if (typeof props.filterConfig === 'string') {
      return props.filterConfig;
    }
    return '';
  };
  const [filterConfigValue, setFilterConfigValue] = createSignal<string>(getFilterConfig());

  const getFilterState = (): string => {
    const value = (props.filterState && typeof props.filterState === 'function') ? props.filterState() : (props.filterState || '');
    return value;
  };
  const [filterStateValue, setFilterStateValue] = createSignal<string>(getFilterState());

  // Track initial filter values when modal opens (for detecting changes)
  const [initialFilterYear, setInitialFilterYear] = createSignal('');
  const [initialFilterEvent, setInitialFilterEvent] = createSignal('');
  const [initialFilterConfig, setInitialFilterConfig] = createSignal('');
  const [initialFilterState, setInitialFilterState] = createSignal('');

  // Use date range from filterStore (not props) - same as PerfSettings
  const currentStartDate = (): string => startDate() || '';
  const currentEndDate = (): string => endDate() || '';

  // Track initial date values when modal opens (for detecting changes)
  const [initialStartDate, setInitialStartDate] = createSignal('');
  const [initialEndDate, setInitialEndDate] = createSignal('');

  // Project filter values (Year, Event, Config, State) are synced from props only when modal opens (see modal open effect).

  // Determine mode: day/dataset vs history
  const isDayDatasetMode = createMemo(() => {
    const { selectedDatasetId, selectedDate } = persistantStore;
    const datasetId = selectedDatasetId?.();
    const date = selectedDate?.();
    return (datasetId && datasetId > 0) || (date && date.trim() !== '');
  });

  // Option sources: allow bypassing prop-provided (possibly filtered) lists
  const [localRaceOptions, setLocalRaceOptions] = createSignal<(number | string)[]>([]);
  const [localLegOptions, setLocalLegOptions] = createSignal<number[]>([]);

  // Get race, leg, and grade options; prefer unfiltered lists when requested
  const raceOptions = (): (number | string)[] => {
    if (props.useUnfilteredOptions && localRaceOptions().length > 0) return localRaceOptions();
    const arr = props.raceOptions || [];
    // Allow both numbers and 'TRAINING' string
    return arr.filter((race: any) => 
      race !== null && race !== undefined && 
      (race === 'TRAINING' || race === 'training' || !isNaN(race))
    );
  };
  const legOptions = (): number[] => {
    if (props.useUnfilteredOptions && localLegOptions().length > 0) return localLegOptions();
    const arr = props.legOptions || [];
    return arr.filter((leg: any) => !isNaN(leg) && leg !== null && leg !== undefined);
  };
  const gradeOptions = (): number[] => (props.gradeOptions || []).filter((grade: any) => !isNaN(grade) && grade !== null && grade !== undefined);
  // Always include H0, H1, H2 in state options so users can deselect H0 when a dataset has no H0 data
  const BASE_STATE_OPTIONS = ['H0', 'H1', 'H2'];
  const stateOptions = (): string[] => {
    const fromProps = (props.stateOptions || []).filter((state: any) => state !== null && state !== undefined && String(state).trim() !== '');
    const normalized = fromProps.map((s: string) => String(s).trim().toUpperCase());
    const combined = new Set<string>([...BASE_STATE_OPTIONS, ...normalized]);
    return Array.from(combined).sort();
  };

  // Get selected values for all filter types, filtering out NaN values
  const selectedRaces = (): (number | string)[] => {
    const races = typeof props.selectedRaces === 'function' ? props.selectedRaces() : (props.selectedRaces || []);
    // Allow both numbers and 'TRAINING' string
    return races.filter((race: any) => 
      race !== null && race !== undefined && 
      (race === 'TRAINING' || race === 'training' || !isNaN(race))
    );
  };
  const selectedLegs = (): number[] => {
    const legs = typeof props.selectedLegs === 'function' ? props.selectedLegs() : (props.selectedLegs || []);
    return legs.filter((leg: any) => !isNaN(leg) && leg !== null && leg !== undefined);
  };
  const selectedGrades = (): number[] => {
    const grades = typeof props.selectedGrades === 'function' ? props.selectedGrades() : (props.selectedGrades || []);
    return grades.filter((grade: any) => !isNaN(grade) && grade !== null && grade !== undefined);
  };
  const selectedStates = (): string[] => {
    const states = typeof props.selectedStates === 'function' ? props.selectedStates() : (props.selectedStates || []);
    return states.filter((state: any) => state !== null && state !== undefined && String(state).trim() !== '');
  };

  // Default filter config - show grades, races, legs, and states
  // Use componentConfig if provided, otherwise fall back to filterConfig (legacy), otherwise use defaults
  const filterConfig = () => {
    // Prefer componentConfig, then filterConfig (legacy), then defaults
    const config = props.componentConfig || (props.filterConfig && typeof props.filterConfig === 'object' && !(props.filterConfig instanceof Function) ? props.filterConfig : undefined);
    return config || {
      showGrades: true,
      showTWA: false,
      showRaces: true,
      showLegs: true,
      showStates: true,
      showPhases: false,
      showPeriods: false,
      showBins: false,
      showHeadsail: false,
      showMainsail: false,
      showConfiguration: false
    };
  };

  // Races and legs via shared service (preload + HuniDB + date/races API fallback for day context)
  createEffect(async () => {
    const { selectedClassName, selectedProjectId, selectedDate, selectedDatasetId } = persistantStore;
    const className = selectedClassName && selectedClassName();
    const projectId = selectedProjectId && selectedProjectId();
    const datasetId = selectedDatasetId && selectedDatasetId();
    const date = selectedDate && selectedDate();
    if (!className || !projectId) return;
    const hasDate = date && String(date).trim() !== "";
    const hasDataset = datasetId && Number(datasetId) > 0;
    if (!hasDate && !hasDataset) return;
    try {
      const context = hasDate ? ("day" as const) : ("dataset" as const);
      const result = await getRaceAndLegOptions({
        context,
        className,
        projectId: Number(projectId),
        date: hasDate ? String(date) : undefined,
        datasetId: hasDataset ? Number(datasetId) : undefined,
        ensureEventsLoaded: true,
      });
      const racesCount = result.races.length;
      setRaceOptions(result.races.map((r) => String(r)));
      if (props.setRaceOptions) props.setRaceOptions(result.races);
      if (props.useUnfilteredOptions) setLocalRaceOptions(result.races);
      if (racesCount > 0) {
        info("ManeuverSettings: Set race options", { count: racesCount, mode: context });
      }
      // Legs are race-specific: only show when we have races
      const legsToSet = racesCount > 0 ? result.legs : [];
      setLegOptions(legsToSet.map((l) => String(l)));
      if (props.setLegOptions) props.setLegOptions(legsToSet);
      if (props.useUnfilteredOptions) setLocalLegOptions(legsToSet);
      if (legsToSet.length > 0) {
        info("ManeuverSettings: Set leg options", { count: legsToSet.length, mode: context });
      }
      if (props.onRaceLegOptionsLoaded) props.onRaceLegOptionsLoaded(racesCount);
    } catch (err: unknown) {
      debug("ManeuverSettings: Failed to get race/leg options", err);
      setRaceOptions([]);
      setLegOptions([]);
      if (props.setRaceOptions) props.setRaceOptions([]);
      if (props.setLegOptions) props.setLegOptions([]);
      if (props.useUnfilteredOptions) {
        setLocalRaceOptions([]);
        setLocalLegOptions([]);
      }
      if (props.onRaceLegOptionsLoaded) props.onRaceLegOptionsLoaded(0);
    }
  });

  // Fixed grade options: [1, 2] or with "All" [-1, 1, 2] when includeAllGradeOption (Maneuver/Fleet Maneuver only). No ">0" option — "All" covers that.
  createEffect(() => {
    if (!props.setGradeOptions) return;
    const includeAll = props.includeAllGradeOption === true;
    const options = includeAll ? [-1, 1, 2] : [1, 2];
    props.setGradeOptions(options);
    if (includeAll) info('ManeuverSettings: Set grade options to [-1, 1, 2] (All, >1, >2)');
  });

  // Returns true if any filters are selected (checking both applied and pending selections)
  const anySelected = () => {
    const applied = selectedRaces().length > 0 
      || selectedLegs().length > 0 
      || selectedGrades().length > 0
      || selectedStates().length > 0;
    const pending = localRaceSelections().size > 0
      || localLegSelections().size > 0
      || localGradeSelections().size > 0
      || localStateSelections().size > 0
      || localTrainingRacingSelection() !== null;
    return applied || pending;
  };

  // Button label logic
  const labelText = () => (anySelected() ? "APPLIED" : "SETTINGS");

  // ESC key handler removed - modal should only close via Apply/Close buttons

  // Initialize date range when component mounts (only if sidebarState is 'project')
  createEffect(async () => {
    if (sidebarState() === 'project') {
      await initializeDateRange();
    }
  });

  // Track popup open state so we only set "initial" values when modal has *just* opened (not on every effect run).
  // Use plain variable (like PerfSettings) so updating it does not trigger an extra effect run.
  let lastPopupState = false;

  // Initialize local source selections and filter selections when modal opens.
  // Read options inside untrack so parent re-renders don't re-run this effect and overwrite "None".
  createEffect(() => {
    const isOpen = showPopup();
    const wasOpen = lastPopupState;
    const isProject = sidebarState() === 'project';
    const justOpened = isOpen && !wasOpen;

    // Only set initial date and project filter values when modal has *just* opened (project mode).
    // This keeps "initial" fixed so hasDateChanges/hasFilterChanges stay correct while the user edits.
    if (justOpened && isProject) {
      // Sync local project filter state from props so inputs show current applied values
      setFilterYearValue(getFilterYear());
      setFilterEventValue(getFilterEvent());
      setFilterConfigValue(getFilterConfig());
      setFilterStateValue(getFilterState());
      setInitialStartDate(currentStartDate());
      setInitialEndDate(currentEndDate());
      setInitialFilterYear(getFilterYear());
      setInitialFilterEvent(getFilterEvent());
      setInitialFilterConfig(getFilterConfig());
      setInitialFilterState(getFilterState());
      debug('ManeuverSettings: Initialized date range and project filter values on modal open', {
        start: currentStartDate(),
        end: currentEndDate(),
        year: getFilterYear(),
        event: getFilterEvent(),
        config: getFilterConfig(),
        state: getFilterState()
      });
    }

    // When modal opens (transitions from closed to open), initialize from current signals.
    // Read options inside untrack so parent re-renders don't re-run this effect and overwrite "None".
    if (isOpen && !wasOpen) {
      const options = untrack(() => props.dataSourcesOptions);
      const hasOptions = Array.isArray(options) && options.length > 0;
      if (hasOptions) {
        const currentSelections = new Set<number>();
        options.forEach((opt: { key?: string; signal?: [() => boolean, (v: boolean) => void] }) => {
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
        debug('ManeuverSettings: Initialized local source selections', {
          selections: Array.from(currentSelections),
          count: currentSelections.size,
          reason: 'modal opened'
        });
      }
    } else if (!isOpen && wasOpen) {
      // Modal just closed - reset state
      setLocalSourceSelections(new Set<number>());
      setInitialSourceSelections(new Set<number>());
      debug('ManeuverSettings: Reset local source selections on modal close');
    }
    
    // Initialize filter selections when modal opens
    if (isOpen && !wasOpen) {
      if (isDayDatasetMode()) {
        // Day/dataset mode: use race/leg/grade/state and Training/Racing from parent (same pattern as grade/state)
        const currentRaces = new Set(selectedRaces().map(r => {
          if (r === 'TRAINING' || r === 'training') return 'TRAINING';
          const num = Number(r);
          return isNaN(num) ? r : num;
        }));
        const currentLegs = new Set(selectedLegs().map(l => Number(l)).filter(l => !isNaN(l)));
        const rawGrades = new Set(selectedGrades().map(g => Number(g)).filter(g => !isNaN(g)));
        // Migrate saved ">0" (0) to "All" (-1) since we no longer offer the >0 option
        const currentGrades = new Set(
          Array.from(rawGrades).map(g => (g === 0 && props.includeAllGradeOption) ? -1 : g)
        );
        const currentStates = new Set(selectedStates());
        const currentTR = typeof props.selectedTrainingRacing === 'function' ? props.selectedTrainingRacing() : (props.selectedTrainingRacing ?? null);
        
        setLocalRaceSelections(currentRaces);
        setLocalLegSelections(currentLegs);
        setLocalGradeSelections(currentGrades);
        setLocalStateSelections(currentStates);
        setLocalTrainingRacingSelection(currentTR);
        setInitialTrainingRacingSelection(currentTR);
        setInitialFilterSelections({
          races: new Set(currentRaces),
          legs: new Set(currentLegs),
          grades: new Set(currentGrades),
          states: new Set(currentStates)
        });
        debug('ManeuverSettings: Initialized local filter selections (day/dataset mode)', {
          races: Array.from(currentRaces),
          legs: Array.from(currentLegs),
          grades: Array.from(currentGrades),
          states: Array.from(currentStates),
          trainingRacing: currentTR
        });
      } else {
        // History mode: use TRAINING/RACING selection from props (local to page, not filterStore)
        const currentTR = typeof props.selectedTrainingRacing === 'function' ? props.selectedTrainingRacing() : (props.selectedTrainingRacing || null);
        setLocalTrainingRacingSelection(currentTR);
        setInitialTrainingRacingSelection(currentTR);
        
        // Still initialize other filters for history mode (migrate saved 0 to 1 since we no longer offer >0)
        const rawGrades = new Set(selectedGrades().map(g => Number(g)).filter(g => !isNaN(g)));
        const currentGrades = new Set(Array.from(rawGrades).map(g => g === 0 ? 1 : g));
        const currentStates = new Set(selectedStates());
        
        setLocalGradeSelections(currentGrades);
        setLocalStateSelections(currentStates);
        setInitialFilterSelections({
          races: new Set<number | string>(),
          legs: new Set<number>(),
          grades: new Set(currentGrades),
          states: new Set(currentStates)
        });
        debug('ManeuverSettings: Initialized local filter selections (history mode)', {
          trainingRacing: currentTR,
          grades: Array.from(currentGrades),
          states: Array.from(currentStates)
        });
      }
    } else if (!isOpen && wasOpen) {
      // Modal just closed - reset filter state
      setLocalRaceSelections(new Set<number | string>());
      setLocalLegSelections(new Set<number>());
      setLocalGradeSelections(new Set<number>());
      setLocalStateSelections(new Set<string>());
      setLocalTrainingRacingSelection(null);
      setInitialTrainingRacingSelection(null);
      setInitialFilterSelections({ races: new Set<number | string>(), legs: new Set<number>(), grades: new Set<number>(), states: new Set<string>() });
      debug('ManeuverSettings: Reset local filter selections on modal close');
    }
    
    // Update tracked state (plain var assignment does not trigger effect re-run)
    lastPopupState = isOpen;
  });

  // Check if source selections have changed
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

  // Check if dates have changed from initial values (for project mode)
  const hasDateChanges = createMemo(() => {
    const isOpen = showPopup();
    const isProject = sidebarState() === 'project';
    
    if (!isProject || !isOpen) return false;
    
    // Read store directly so memo reliably tracks endDate/startDate updates (Apply button)
    const currentStart = startDate() || '';
    const currentEnd = endDate() || '';
    const initialStart = initialStartDate();
    const initialEnd = initialEndDate();
    
    const startChanged = currentStart !== initialStart;
    const endChanged = currentEnd !== initialEnd;
    return startChanged || endChanged;
  });

  // Check if filter selections have changed
  const hasFilterChanges = createMemo(() => {
    if (!showPopup()) return false;
    
    // Check project-specific filters (Year, Event, Config, State)
    const currentYear = filterYearValue();
    const currentEvent = filterEventValue();
    const currentConfig = filterConfigValue();
    const currentState = filterStateValue();
    const initialYear = initialFilterYear();
    const initialEvent = initialFilterEvent();
    const initialConfig = initialFilterConfig();
    const initialState = initialFilterState();
    
    const yearChanged = currentYear !== initialYear;
    const eventChanged = currentEvent !== initialEvent;
    const configChanged = currentConfig !== initialConfig;
    const stateChanged = currentState !== initialState;
    
    if (yearChanged || eventChanged || configChanged || stateChanged) return true;
    
    // Check TRAINING/RACING changes (for both day/dataset and history mode)
    const currentTR = localTrainingRacingSelection();
    const initialTR = initialTrainingRacingSelection();
    if (currentTR !== initialTR) return true;
    
    if (isDayDatasetMode()) {
      // Day/dataset mode: check race/leg changes
      const currentRaces = localRaceSelections();
      const currentLegs = localLegSelections();
      const currentGrades = localGradeSelections();
      const currentStates = localStateSelections();
      const initial = initialFilterSelections();
      
      // Check races
      if (currentRaces.size !== initial.races.size) return true;
      for (const race of currentRaces) {
        if (!initial.races.has(race)) return true;
      }
      for (const race of initial.races) {
        if (!currentRaces.has(race)) return true;
      }
      
      // Check legs
      if (currentLegs.size !== initial.legs.size) return true;
      for (const leg of currentLegs) {
        if (!initial.legs.has(leg)) return true;
      }
      for (const leg of initial.legs) {
        if (!currentLegs.has(leg)) return true;
      }
      
      // Check grades
      if (currentGrades.size !== initial.grades.size) return true;
      for (const grade of currentGrades) {
        if (!initial.grades.has(grade)) return true;
      }
      for (const grade of initial.grades) {
        if (!currentGrades.has(grade)) return true;
      }
      
      // Check states
      if (currentStates.size !== initial.states.size) return true;
      for (const state of currentStates) {
        if (!initial.states.has(state)) return true;
      }
      for (const state of initial.states) {
        if (!currentStates.has(state)) return true;
      }
    } else {
      // History mode: check grades and states
      
      // Also check grades and states
      const currentGrades = localGradeSelections();
      const currentStates = localStateSelections();
      const initial = initialFilterSelections();
      
      if (currentGrades.size !== initial.grades.size) return true;
      for (const grade of currentGrades) {
        if (!initial.grades.has(grade)) return true;
      }
      for (const grade of initial.grades) {
        if (!currentGrades.has(grade)) return true;
      }
      
      if (currentStates.size !== initial.states.size) return true;
      for (const state of currentStates) {
        if (!initial.states.has(state)) return true;
      }
      for (const state of initial.states) {
        if (!currentStates.has(state)) return true;
      }
    }
    
    return false;
  });

  // Apply source changes
  const handleApplySourceChanges = async () => {
    const selections = localSourceSelections();
    debug('ManeuverSettings: Applying source changes', { selections: Array.from(selections) });
    
    // First, update the parent component's signals immediately (synchronous)
    // This triggers the reactive effect in the parent to refetch data
    if (Array.isArray(props.dataSourcesOptions)) {
      props.dataSourcesOptions.forEach((opt: any) => {
        if (opt.key?.startsWith('source-') && opt.signal?.[1]) {
          const match = opt.key.match(/source-(\d+)/);
          if (match) {
            const sourceId = Number(match[1]);
            const shouldBeSelected = selections.has(sourceId);
            opt.signal[1](shouldBeSelected);
          }
        }
      });
    }
    
    // Update initial selections to current (so hasSourceChanges() returns false)
    setInitialSourceSelections(new Set(selections));
    
    // Save to persistent settings API (always save, even if empty array).
    // This ensures "None" (all sources deselected) is persisted across reloads, matching PerfSettings.
    const sourceNames = Array.from(selections).map((sourceId: number) => {
      const source = sourcesStore.sources().find(s => s.source_id === sourceId);
      return source?.source_name || '';
    }).filter(Boolean);

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
            { fleetPerformanceSources: sourceNames }
          );
          debug('ManeuverSettings: Saved sources to API', sourceNames);
        } catch (error) {
          debug('ManeuverSettings: Error saving sources to API', error);
        }
      }
    }
  };

  // Apply filter changes
  const handleApplyFilterChanges = async () => {
    if (isDayDatasetMode()) {
      // Day/dataset mode: apply race/leg filters
      const races = localRaceSelections();
      const legs = localLegSelections();
      const grades = localGradeSelections();
      const states = localStateSelections();
      
      debug('ManeuverSettings: Applying filter changes (day/dataset mode)', {
        races: Array.from(races),
        legs: Array.from(legs),
        grades: Array.from(grades),
        states: Array.from(states)
      });
      
      // Get current applied selections - normalize to consistent types
      const currentRaces = new Set(selectedRaces().map(r => {
        if (r === 'TRAINING' || r === 'training') return 'TRAINING';
        const num = Number(r);
        return isNaN(num) ? r : num;
      }));
      const currentLegs = new Set(selectedLegs().map(l => Number(l)).filter(l => !isNaN(l)));
      const currentGrades = new Set(selectedGrades().map(g => Number(g)).filter(g => !isNaN(g)));
      const currentStates = new Set(selectedStates());
      
      // Determine which filters need to be toggled
      // For races
      for (const race of races) {
        if (!currentRaces.has(race) && props.toggleRaceFilter) {
          props.toggleRaceFilter(race);
        }
      }
      for (const race of currentRaces) {
        if (!races.has(race) && props.toggleRaceFilter) {
          props.toggleRaceFilter(race);
        }
      }
      
      // For legs
      for (const leg of legs) {
        if (!currentLegs.has(leg) && props.toggleLegFilter) {
          props.toggleLegFilter(leg);
        }
      }
      for (const leg of currentLegs) {
        if (!legs.has(leg) && props.toggleLegFilter) {
          props.toggleLegFilter(leg);
        }
      }
      
      // For grades - radio button behavior: set directly to the selected grade (if any)
      // If local selections are empty, preserve current grades
      if (grades.size > 0) {
        // Radio button: only one grade can be selected, so get the first (and only) one
        const selectedGrade = Array.from(grades)[0];
        // Only apply if it's different from current selection
        if (!currentGrades.has(selectedGrade) && props.toggleGradeFilter) {
          props.toggleGradeFilter(selectedGrade);
        }
      } else if (currentGrades.size > 0) {
        // If we want to clear grades, deselect the current one by toggling it
        const currentGrade = Array.from(currentGrades)[0];
        if (props.toggleGradeFilter) {
          props.toggleGradeFilter(currentGrade);
        }
      }
      
      // For states
      for (const state of states) {
        if (!currentStates.has(state) && props.toggleStateFilter) {
          props.toggleStateFilter(state);
        }
      }
      for (const state of currentStates) {
        if (!states.has(state) && props.toggleStateFilter) {
          props.toggleStateFilter(state);
        }
      }
      
      // Apply Training/Racing filter via callback (same as grade/state - parent state drives filterData)
      const trSelection = localTrainingRacingSelection();
      if (props.onTrainingRacingFilterChange) {
        props.onTrainingRacingFilterChange(trSelection);
      }
      setInitialTrainingRacingSelection(trSelection);
      
      // Update initial selections to current (so hasFilterChanges() returns false)
      setInitialFilterSelections({
        races: new Set(races),
        legs: new Set(legs),
        grades: new Set(grades),
        states: new Set(states)
      });
    } else {
      // History mode: apply TRAINING/RACING filter
      const trSelection = localTrainingRacingSelection();
      const grades = localGradeSelections();
      const states = localStateSelections();
      
      debug('ManeuverSettings: Applying filter changes (history mode)', {
        trainingRacing: trSelection,
        grades: Array.from(grades),
        states: Array.from(states)
      });
      
      // Get current applied selections - normalize to consistent types
      const currentGrades = new Set(selectedGrades().map(g => Number(g)).filter(g => !isNaN(g)));
      const currentStates = new Set(selectedStates());
      
      // Apply TRAINING/RACING filter via callback (local to page, not filterStore)
      if (props.onTrainingRacingFilterChange) {
        props.onTrainingRacingFilterChange(trSelection);
      }
      
      // For grades - radio button behavior: set directly to the selected grade (if any)
      // If local selections are empty, preserve current grades
      if (grades.size > 0) {
        // Radio button: only one grade can be selected, so get the first (and only) one
        const selectedGrade = Array.from(grades)[0];
        // Only apply if it's different from current selection
        if (!currentGrades.has(selectedGrade) && props.toggleGradeFilter) {
          props.toggleGradeFilter(selectedGrade);
        }
      } else if (currentGrades.size > 0) {
        // If we want to clear grades, deselect the current one by toggling it
        const currentGrade = Array.from(currentGrades)[0];
        if (props.toggleGradeFilter) {
          props.toggleGradeFilter(currentGrade);
        }
      }
      
      // For states
      for (const state of states) {
        if (!currentStates.has(state) && props.toggleStateFilter) {
          props.toggleStateFilter(state);
        }
      }
      for (const state of currentStates) {
        if (!states.has(state) && props.toggleStateFilter) {
          props.toggleStateFilter(state);
        }
      }
      
      // Update initial selections
      setInitialTrainingRacingSelection(trSelection);
      setInitialFilterSelections({
        races: new Set<number | string>(),
        legs: new Set<number>(),
        grades: new Set(grades),
        states: new Set(states)
      });
    }
    
    // Apply project-specific filters (Year, Event, Config, State) - only in project mode
    if (sidebarState() === 'project') {
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
        // Parse state filter value (comma-separated) and convert to uppercase
        const states = filterStateValue().split(',').map(s => s.trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
        props.onFilterStateChange(states.join(','));
        setFilterStateValue(states.join(','));
      }
      
      // Update initial filter values
      setInitialFilterYear(filterYearValue());
      setInitialFilterEvent(filterEventValue());
      setInitialFilterConfig(filterConfigValue());
      setInitialFilterState(filterStateValue());
      
      // Update initial date values
      setInitialStartDate(currentStartDate());
      setInitialEndDate(currentEndDate());
    }
    
    // Save filters to persistent settings (async, but don't block on it)
    const currentUser = user();
    if (currentUser?.user_id) {
      const { selectedClassName, selectedProjectId } = persistantStore;
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (className && projectId) {
        try {
          const races = isDayDatasetMode() ? Array.from(localRaceSelections()) : [];
          const legs = isDayDatasetMode() ? Array.from(localLegSelections()) : [];
          // Preserve grades - use local selections if they exist, otherwise use current applied grades
          const localGrades = localGradeSelections();
          const currentAppliedGrades = new Set(selectedGrades().map(g => Number(g)).filter(g => !isNaN(g)));
          const grades = localGrades.size > 0 ? Array.from(localGrades) : Array.from(currentAppliedGrades);
          const states = Array.from(localStateSelections());
          
          await persistentSettingsService.saveSettings(
            currentUser.user_id,
            className,
            projectId,
            {
              maneuverFilters: {
                grades,
                states,
                races,
                legs,
                trainingRacing: localTrainingRacingSelection()
              }
            }
          );
          debug('ManeuverSettings: Saved filters to persistent settings', {
            grades,
            states,
            races,
            legs,
            trainingRacing: localTrainingRacingSelection()
          });
        } catch (error) {
          debug('ManeuverSettings: Error saving filters to persistent settings:', error);
        }
      }
    }
    
    // Sync applied filters to filterStore for cross-window sync
    // This ensures that when filters are applied via ManeuverSettings, they sync to filterStore
    // The toggle handlers should already sync, but this ensures everything is synced after all toggles complete
    try {
      if (isDayDatasetMode()) {
        const races = Array.from(localRaceSelections());
        const legs = Array.from(localLegSelections());
        const grades = Array.from(localGradeSelections());
        const states = Array.from(localStateSelections());
        
        // Sync to filterStore (convert to string arrays as filterStore expects strings)
        if (grades.length > 0) {
          setSelectedGradesManeuvers(grades.map(g => String(g)));
        }
        if (states.length > 0) {
          setSelectedStatesManeuvers(states);
        }
        if (races.length > 0) {
          setSelectedRacesManeuvers(races.map(r => String(r)));
        }
        if (legs.length > 0) {
          setSelectedLegsManeuvers(legs.map(l => String(l)));
        }
      } else {
        // History mode: only sync grades and states (races/legs are not used in history mode)
        const grades = Array.from(localGradeSelections());
        const states = Array.from(localStateSelections());
        
        if (grades.length > 0) {
          setSelectedGradesManeuvers(grades.map(g => String(g)));
        }
        if (states.length > 0) {
          setSelectedStatesManeuvers(states);
        }
      }
      
      debug('ManeuverSettings: Synced applied filters to filterStore for cross-window sync');
    } catch (error) {
      debug('ManeuverSettings: Error syncing filters to filterStore:', error);
    }
    
    // Call parent's onApplyFilters callback if provided
    if (props.onApplyFilters) {
      props.onApplyFilters();
    }
  };

  const [saveDefaultSuccessFlash, setSaveDefaultSuccessFlash] = createSignal(false);

  const handleSaveDefaultFilters = async (): Promise<void> => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    if (!className || !projectId) {
      debug('ManeuverSettings: Save default filters skipped - no class or project');
      return;
    }
    const rawDate = startDate() || persistantStore.selectedDate?.() || '';
    const dateToSave = (() => {
      const d = (rawDate && typeof rawDate === 'string') ? rawDate.trim() : '';
      if (!d) return '1970-01-01';
      if (d.length === 8 && !d.includes('-')) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      return d;
    })();
    const grades = Array.from(localGradeSelections());
    const states = Array.from(localStateSelections());
    try {
      const response = await postData(`${apiEndpoints.app.projects}/object`, {
        class_name: className,
        project_id: projectId,
        date: dateToSave,
        object_name: 'maneuver_filters',
        json: JSON.stringify({ grades, states })
      });
      if (response?.success) {
        debug('ManeuverSettings: Saved default maneuver filters to project_objects', { grades, states });
        setSaveDefaultSuccessFlash(true);
        setTimeout(() => setSaveDefaultSuccessFlash(false), 1200);
      } else {
        logError('ManeuverSettings: Failed to save default maneuver filters', response?.message ?? 'Unknown error');
      }
    } catch (err) {
      logError('ManeuverSettings: Error saving default maneuver filters', err as Error);
    }
  };

  // Handle display option click
  const handleDisplayOptionClick = (option: any) => {
    try { info('ManeuverSettings: Display option clicked', { option }); } catch {}
    
    // Check if this is a source toggle first (by key, regardless of type property)
    const isSourceToggle = option.key && option.key.startsWith('source-');
    
    if (isSourceToggle && option.signal && option.signal.length === 2) {
      // For source toggles, update local state instead of immediately applying
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
        debug('ManeuverSettings: Source toggle - updated local state', { sourceId, selected: next.has(sourceId), localSelections: Array.from(next) });
      }
    } else if (option.type === 'color' && option.signal && option.signal.length === 2) {
      // Color type selection - set via signal (immediate for non-source options)
      const [, setter] = option.signal;
      setter(option.value);
    } else if (option.type === 'toggle' && option.signal && option.signal.length === 2) {
      // For non-source toggles, apply immediately
      const [getter, setter] = option.signal;
      const currentValue = typeof getter === 'function' ? getter() : getter;
      setter(!currentValue);
    }
  };

  // Use centralized race comparison from raceValueUtils

  // Handler functions for filter types - update local state instead of immediately applying
  const handleRaceClick = (race: any) => {
    try { info('ManeuverSettings: Race clicked', { race }); } catch {}
    const current = localRaceSelections();
    const next = new Set(current);
    if (next.has(race)) {
      next.delete(race);
    } else {
      next.add(race);
    }
    setLocalRaceSelections(next);
    debug('ManeuverSettings: Race toggle - updated local state', { race, selected: next.has(race), localSelections: Array.from(next) });
  };
  const handleLegClick = (leg: any) => {
    try { info('ManeuverSettings: Leg clicked', { leg }); } catch {}
    const current = localLegSelections();
    const next = new Set(current);
    if (next.has(leg)) {
      next.delete(leg);
    } else {
      next.add(leg);
    }
    setLocalLegSelections(next);
    debug('ManeuverSettings: Leg toggle - updated local state', { leg, selected: next.has(leg), localSelections: Array.from(next) });
  };
  const handleGradeClick = (grade: any) => {
    try { info('ManeuverSettings: Grade clicked', { grade }); } catch {}
    // Convert to number for consistent comparison
    const gradeNum = Number(grade);
    const current = localGradeSelections();
    // Radio button behavior: if same grade is clicked, deselect; otherwise select new grade
    const exists = Array.from(current).some((val: any) => Number(val) === gradeNum);
    if (exists) {
      // Deselect if clicking the same grade
      setLocalGradeSelections(new Set<number>());
      debug('ManeuverSettings: Grade deselected - updated local state', { grade, gradeNum });
    } else {
      // Select only this grade (radio button behavior)
      setLocalGradeSelections(new Set([gradeNum]));
      debug('ManeuverSettings: Grade selected - updated local state', { grade, gradeNum });
    }
  };
  const handleStateClick = (state: any) => {
    try { info('ManeuverSettings: State clicked', { state }); } catch {}
    const current = localStateSelections();
    const next = new Set(current);
    // Convert to string and trim for consistent comparison
    const stateStr = String(state).trim();
    // Check if state exists (case-insensitive)
    const exists = Array.from(next).some((val: any) => String(val).trim().toLowerCase() === stateStr.toLowerCase());
    if (exists) {
      // Remove by finding the matching value (handles case differences)
      const toRemove = Array.from(next).find((val: any) => String(val).trim().toLowerCase() === stateStr.toLowerCase());
      if (toRemove !== undefined) {
        next.delete(toRemove);
      }
    } else {
      next.add(stateStr);
    }
    setLocalStateSelections(next);
    debug('ManeuverSettings: State toggle - updated local state', { state, stateStr, selected: !exists, localSelections: Array.from(next) });
  };

  // Handler for TRAINING/RACING filter clicks (history mode)
  const handleTrainingRacingClick = (type: 'TRAINING' | 'RACING') => {
    try { info('ManeuverSettings: Training/Racing clicked', { type }); } catch {}
    const current = localTrainingRacingSelection();
    // Toggle: if same type is clicked, deselect; otherwise select new type
    if (current === type) {
      setLocalTrainingRacingSelection(null);
    } else {
      setLocalTrainingRacingSelection(type);
    }
    debug('ManeuverSettings: Training/Racing toggle - updated local state', { type, selected: current !== type });
  };

  // Handlers for date changes
  const handleStartDateChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    debug('ManeuverSettings: Start date changed', { value });
    setStartDate(value);
  };

  const handleEndDateChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    debug('ManeuverSettings: End date changed', { value });
    setEndDate(value ?? '');
  };
  // Some date pickers fire change when value is committed; handle both so Apply always activates
  const handleEndDateChangeEvent = (e: Event) => handleEndDateChange(e as InputEvent);

  // Handlers for project-specific filter changes
  const handleFilterYearChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    debug('ManeuverSettings: Filter Year changed', { value });
    setFilterYearValue(value);
  };

  const handleFilterEventChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    debug('ManeuverSettings: Filter Event changed', { value });
    setFilterEventValue(value);
  };

  const handleFilterConfigChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    debug('ManeuverSettings: Filter Config changed', { value });
    setFilterConfigValue(value);
  };

  const handleFilterStateChange = (e: InputEvent) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    debug('ManeuverSettings: Filter State changed', { value });
    setFilterStateValue(value);
  };

  // Clear all filters - update local state
  const handleClearAll = () => {
    setLocalRaceSelections(new Set<number | string>());
    setLocalLegSelections(new Set<number>());
    setLocalGradeSelections(new Set<number>());
    setLocalStateSelections(new Set<string>());
    setLocalTrainingRacingSelection(null);
    // Also clear project-specific filters and date range
    if (sidebarState() === 'project') {
      setFilterYearValue('');
      setFilterEventValue('');
      setFilterConfigValue('');
      setFilterStateValue('');
      setStartDate('');
      setEndDate('');
    }
    debug('ManeuverSettings: Clear All - updated local state');
  };

  // Render a filter group - uses local selections for display
  const renderFilterGroup = (title: string, options: any[], _selectedValues: any[], localSelections: Set<any>, onClickHandler: (value: any) => void, colorClass: string) => (
    <div class="mb-4">
      <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">{title}</div>
      <div class="flex flex-wrap gap-2">
        {options.map((option) => {
          // For race filters, show "TRAINING" if race number is < 1 or is 'TRAINING'
          // For grade filters, show ">1", ">2", ">3" instead of just the number
          let displayText: string;
          if (title === "Race Filters") {
            displayText = formatRaceForDisplay(option);
          } else if (title === "Grade Filters") {
            displayText = `>${option}`;
          } else {
            displayText = String(option);
          }
          // Always use local selections for display - they are initialized from applied selections when modal opens
          // This allows users to see their pending changes immediately (unselecting shows as unselected)
          let isSelected = false;
          if (title === "Race Filters") {
            // For races, need to check with isSameRace helper
            isSelected = Array.from(localSelections).some((val: any) => isSameRace(val, option));
          } else if (title === "Grade Filters") {
            // For grades, handle number comparison (option is number, Set may contain numbers)
            isSelected = Array.from(localSelections).some((val: any) => Number(val) === Number(option));
          } else {
            // For states and legs, use direct Set.has() comparison
            isSelected = localSelections.has(option);
          }
          return (
            <span
              class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                isSelected
                  ? `${colorClass} text-white`
                  : "bg-gray-200 text-gray-700"
              }`}
              onClick={() => onClickHandler(option)}
              onContextMenu={(e) => e.preventDefault()}
            >
              {displayText}
            </span>
          );
        })}
      </div>
    </div>
  );

  return (
    <>
      <div class="relative inline-block settings-parent maneuver-settings-wrapper">
        <Show when={props.useIconTrigger} fallback={
          <button
            onClick={() => {
              const next = !showPopup();
              setShowPopup(next);
              try { info('ManeuverSettings: Toggle modal', { open: next }); } catch { log('ManeuverSettings: Toggle modal', { open: next }); }
            }}
            onContextMenu={(e) => e.preventDefault()}
            class="dropdown py-2 px-3 rounded-md flex flex-col items-center forced-medium"
            style="background: var(--color-bg-button); color: var(--color-text-inverse); transition: all 0.3s ease;"
          >
            <span class="self-start text-xs font-medium">Settings</span>
            <span class="text-sm font-bold">{labelText()}</span>
          </button>
        }>
          {/* Icon-only trigger - no button background */}
          <div
            onClick={() => {
              const next = !showPopup();
              setShowPopup(next);
              try { info('ManeuverSettings: Toggle modal', { open: next }); } catch { log('ManeuverSettings: Toggle modal', { open: next }); }
            }}
            onContextMenu={(e) => e.preventDefault()}
            class="maneuver-settings-icon cursor-pointer p-1 hover:opacity-70 transition-opacity"
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
            class="pagesettings-modal"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div class="flex justify-between items-center p-4 border-b" style="border-color: var(--color-border-primary);">
              <h2 class="text-lg font-semibold" style="color: var(--color-text-primary);">Maneuver Settings</h2>
              <Show 
                when={!hasSourceChanges() && !hasFilterChanges() && !hasDateChanges()} 
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
              {/* Data Sources Section - shown above Display Options when provided */}
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
                              debug('ManeuverSettings: Select All - updated local state', { count: allIds.size });
                            }
                          } catch (err) {
                            debug('ManeuverSettings: Error selecting all sources', err);
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
                            debug('ManeuverSettings: None - updated local state');
                          } catch (err) {
                            debug('ManeuverSettings: Error deselecting all sources', err);
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
                      // This ensures consistent ordering with PerfSettings
                      const sortedOptions = [...props.dataSourcesOptions].sort((a, b) => {
                        const aMatch = a.key?.match(/source-(\d+)/);
                        const bMatch = b.key?.match(/source-(\d+)/);
                        const aId = aMatch ? Number(aMatch[1]) : 0;
                        const bId = bMatch ? Number(bMatch[1]) : 0;
                        return aId - bId;
                      });
                      
                      return sortedOptions.map((option: any) => {
                        // Access signal getter reactively - call it directly in JSX for reactivity
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
                            onClick={() => handleDisplayOptionClick(option)}
                          >
                            {option.label}
                          </span>
                        );
                      });
                    })()}
                  </div>
                </div>
              </Show>

              {/* Display Options Section */}
              <Show when={!props.hideDisplayOptions}>
                <div class="mb-6">
                  <h3 class="text-base font-semibold mb-3" style="color: var(--color-text-primary);">Display Options</h3>
                  <div class="space-y-3">
                  {/* Timeline Toggle - Commented out until timeseries scatter integration is ready */}
                  <Show when={false}>
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
                  </Show>

                  {/* Color Type Options - disabled for now */}
                  <Show when={false}>
                    <div class="mb-3">
                      <div class="text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Color By</div>
                    </div>
                  </Show>

                  {/* Overlay Options (if provided by page) - disabled for now */}
                  <Show when={false}>
                    <div class="mb-3">
                      <Show when={!props.hideOverlayOptionsLabel}>
                        <div class="text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Overlay Options</div>
                      </Show>
                      <div class="flex flex-wrap gap-2">
                        {Array.isArray(props.displayOptions) && props.displayOptions.map((option: any) => (
                          <span
                            class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                              option.signal?.[0]() ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700"
                            }`}
                            onClick={() => handleDisplayOptionClick(option)}
                          >
                            {option.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  </Show>
                  </div>
                </div>
              </Show>

              {/* Filter Options Section */}
              <Show when={(() => {
                const cfg = filterConfig();
                const hasGrades = cfg.showGrades && gradeOptions().length > 0;
                const hasRaces = cfg.showRaces && raceOptions().length > 0;
                const hasLegs = cfg.showLegs && legOptions().filter(leg => Number(leg) >= 0).length > 0;
                const hasStates = cfg.showStates && stateOptions().length > 0;
                const isProject = sidebarState() === 'project';
                return hasGrades || hasRaces || hasLegs || hasStates || isProject;
              })()}>
              <div class="mb-6">
                <h3 class="text-base font-semibold mb-3" style="color: var(--color-text-primary);">Filter Options</h3>
                
                {/* Project Mode: Date Range and Project Filters (Year, Event, Config, State) */}
                <Show when={sidebarState() === 'project'}>
                  <div class="mb-6">
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
                          onInput={handleEndDateChangeEvent}
                          onChange={handleEndDateChangeEvent}
                          class="w-full px-3 py-2 rounded-md border"
                          style="background: var(--color-bg-primary); color: var(--color-text-primary); border-color: var(--color-border-primary);"
                        />
                      </div>
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
                    
                    {/* Row 2: Event, Config */}
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
                  </div>
                </Show>
                
                {/* Grade & Training/Racing Filters Section */}
                <div class="mb-6">
                  <div class="flex items-start gap-6">
                    {/* Left Column - Grade Filters */}
                    <Show when={filterConfig().showGrades && gradeOptions().length > 0}>
                      <div class="flex-1">
                        <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">Grade Filters</div>
                        <div class="flex flex-wrap gap-2">
                          {gradeOptions().map((grade) => {
                            const gradeNum = Number(grade);
                            const isSelected = () => localGradeSelections().has(gradeNum);
                            const label = gradeNum === -1 ? 'All' : `>${grade}`;
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
                                {label}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </Show>

                    {/* Right Column - Training/Racing Filters: show when history mode, or when showRaces is true (so dataset/fleet maneuver pages always show All/Training/Racing), or when race options exist. */}
                    <Show when={!isDayDatasetMode() || (filterConfig().showRaces ?? true) || raceOptions().length > 0}>
                      <div class="flex-1">
                        <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">Training/Racing</div>
                        <div class="flex flex-wrap gap-2">
                          <span
                            class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                              localTrainingRacingSelection() === null
                                ? "bg-blue-500 text-white"
                                : "bg-gray-200 text-gray-700"
                            }`}
                            onClick={() => {
                              setLocalTrainingRacingSelection(null);
                              if (props.onTrainingRacingFilterChange) props.onTrainingRacingFilterChange(null);
                              setInitialTrainingRacingSelection(null);
                            }}
                            onContextMenu={(e) => e.preventDefault()}
                          >
                            All
                          </span>
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
                    </Show>
                  </div>
                </div>

                {/* State Filters Section - On its own line */}
                <Show when={filterConfig().showStates && stateOptions().length > 0}>
                  {renderFilterGroup("State Filters", stateOptions(), selectedStates(), localStateSelections(), handleStateClick, "bg-green-500")}
                </Show>

                {/* Race/Leg Filters Section - Show in day/dataset mode only when RACING is selected */}
                <Show when={isDayDatasetMode() && localTrainingRacingSelection() === 'RACING' && filterConfig().showRaces && raceOptions().length > 0}>
                  {renderFilterGroup("Race Filters", raceOptions().filter((race) => {
                    // When RACING is selected, exclude TRAINING from race filters
                    const raceValue = race === 'TRAINING' || race === 'training' || race === '-1' || Number(race) === -1 ? 'TRAINING' : race;
                    return raceValue !== 'TRAINING';
                  }), selectedRaces(), localRaceSelections(), handleRaceClick, "bg-blue-500")}
                </Show>

                <Show when={isDayDatasetMode() && localTrainingRacingSelection() === 'RACING' && filterConfig().showLegs && legOptions().filter(leg => Number(leg) >= 0).length > 0}>
                  {renderFilterGroup("Leg Filters", legOptions().filter(leg => Number(leg) >= 0), selectedLegs(), localLegSelections(), handleLegClick, "bg-purple-500")}
                </Show>
              </div>
              </Show>
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
                {/* Page Builder button removed - not needed for maneuver settings */}
                <Show 
                  when={hasSourceChanges() || hasFilterChanges() || hasDateChanges()} 
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
                      if (hasSourceChanges()) {
                        await handleApplySourceChanges();
                      }
                      if (hasFilterChanges() || hasDateChanges()) {
                        handleApplyFilterChanges();
                      }
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
