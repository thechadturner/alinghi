import { createSignal, createEffect, onCleanup, Show, createMemo, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import { FiSettings } from "solid-icons/fi";
import { unifiedDataStore } from "../../store/unifiedDataStore";
import { apiEndpoints } from "@config/env";
import { getData } from "../../utils/global";
import { setSelectedFilters } from "../../store/filterStore";
import { persistantStore } from "../../store/persistantStore";
import { sourcesStore } from "../../store/sourcesStore";
import { info, debug, log } from "../../utils/console";
import { getRaceAndLegOptions } from "../../services/raceLegOptionsService";
import { extractFilterOptions } from "../../utils/dataFiltering";
import { user } from "../../store/userStore";
import { persistentSettingsService } from "../../services/persistentSettingsService";

interface PageSettingsProps {
  options?: string[];
  raceOptions?: (number | string)[];
  legOptions?: number[];
  gradeOptions?: number[];
  phaseOptions?: number[];
  periodOptions?: number[];
  binOptions?: number[];
  headsailOptions?: string[];
  mainsailOptions?: string[];
  configurationOptions?: string[];
  selectedStates?: string[] | (() => string[]);
  selectedRaces?: (number | string)[] | (() => (number | string)[]);
  selectedLegs?: number[] | (() => number[]);
  selectedGrades?: number[] | (() => number[]);
  selectedPhases?: number[] | (() => number[]);
  selectedPeriods?: number[] | (() => number[]);
  selectedBins?: number[] | (() => number[]);
  selectedHeadsails?: string[] | (() => string[]);
  selectedMainsails?: string[] | (() => string[]);
  selectedConfigurations?: string[] | (() => string[]);
  group?: {
    charts?: Array<{
      filters?: string[];
    }>;
  };
  useUnfilteredOptions?: boolean;
  setLegOptions?: (options: number[]) => void;
  setRaceOptions?: (options: (number | string)[]) => void;
  filterConfig?: {
    showGrades?: boolean;
    showTWA?: boolean;
    showRaces?: boolean;
    showLegs?: boolean;
    showPhases?: boolean;
    showPeriods?: boolean;
    showBins?: boolean;
    showHeadsail?: boolean;
    showMainsail?: boolean;
    showConfiguration?: boolean;
  };
  onColorTypeChange?: (colorType: string) => void;
  onApply?: () => void; // Callback when Apply button is clicked
  [key: string]: any;
}

export default function PageSettings(props: PageSettingsProps) {
  const [showPopup, setShowPopup] = createSignal(false);
  let navigate: (path: string) => void;
  
  try {
    navigate = useNavigate();
  } catch (error: any) {
    // Router not available, use fallback
    navigate = () => {
      log('PageSettings: Router not available - navigation disabled');
    };
  }

  // Local state for source selections (deferred until Apply is clicked)
  const [localSourceSelections, setLocalSourceSelections] = createSignal<Set<number>>(new Set());
  const [initialSourceSelections, setInitialSourceSelections] = createSignal<Set<number>>(new Set());

  // Track initial filter values when popup opens
  const [initialFilters, setInitialFilters] = createSignal<{
    states: string[];
    races: (number | string)[];
    legs: number[];
    grades: number[];
    phases: number[];
    periods: number[];
    bins: number[];
    headsails: string[];
    mainsails: string[];
    configurations: string[];
  } | null>(null);

  // Use options prop if provided, else default
  const filterOptions: string[] = props.options || ["Upwind", "Downwind", "Reaching", "Port", "Starboard"];

  // Get colorType and chart data scope from persistantStore if available
  const { colorType, setColorType, filterChartsBySelection, setFilterChartsBySelection } = persistantStore;

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

  // Helper functions to get array options for new filter types
  const phaseOptions = (): number[] => (props.phaseOptions || []).filter((p: any) => !isNaN(p) && p !== null && p !== undefined);
  const periodOptions = (): number[] => (props.periodOptions || []).filter((p: any) => !isNaN(p) && p !== null && p !== undefined);
  const binOptions = (): number[] => (props.binOptions || []).filter((b: any) => !isNaN(b) && b !== null && b !== undefined);
  const headsailOptions = (): string[] => (props.headsailOptions || []).filter((h: any) => h !== null && h !== undefined);
  const mainsailOptions = (): string[] => (props.mainsailOptions || []).filter((m: any) => m !== null && m !== undefined);
  const configurationOptions = (): string[] => (props.configurationOptions || []).filter((c: any) => c !== null && c !== undefined);

  // Use props.group.charts[0].filters if provided, else fallback to props.selectedStates if passed
  const selected = (): string[] => {
    if (props.group?.charts?.[0]?.filters) {
      return props.group.charts[0].filters;
    }
    return typeof props.selectedStates === 'function' ? props.selectedStates() : (props.selectedStates || []);
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
  const selectedPhases = (): number[] => {
    const phases = typeof props.selectedPhases === 'function' ? props.selectedPhases() : (props.selectedPhases || []);
    return phases.filter((phase: any) => !isNaN(phase) && phase !== null && phase !== undefined);
  };
  const selectedPeriods = (): number[] => {
    const periods = typeof props.selectedPeriods === 'function' ? props.selectedPeriods() : (props.selectedPeriods || []);
    return periods.filter((period: any) => !isNaN(period) && period !== null && period !== undefined);
  };
  const selectedBins = (): number[] => {
    const bins = typeof props.selectedBins === 'function' ? props.selectedBins() : (props.selectedBins || []);
    return bins.filter((bin: any) => !isNaN(bin) && bin !== null && bin !== undefined);
  };
  const selectedHeadsails = (): string[] => typeof props.selectedHeadsails === 'function' ? props.selectedHeadsails() : (props.selectedHeadsails || []);
  const selectedMainsails = (): string[] => typeof props.selectedMainsails === 'function' ? props.selectedMainsails() : (props.selectedMainsails || []);
  const selectedConfigurations = (): string[] => typeof props.selectedConfigurations === 'function' ? props.selectedConfigurations() : (props.selectedConfigurations || []);

  // Default filter config - show all filters if not specified
  const filterConfig = () => props.filterConfig || {
    showGrades: true,
    showTWA: true,
    showRaces: true,
    showLegs: true,
    showPhases: false,
    showPeriods: false,
    showBins: false,
    showHeadsail: false,
    showMainsail: false,
    showConfiguration: false
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
      if (props.setRaceOptions) {
        props.setRaceOptions(result.races);
        if (props.useUnfilteredOptions) setLocalRaceOptions(result.races);
        if (result.races.length > 0) {
          info("PageSettings: Set race options", { count: result.races.length, mode: context });
        }
      }
      if (props.setLegOptions) {
        props.setLegOptions(result.legs);
        if (props.useUnfilteredOptions) setLocalLegOptions(result.legs);
        if (result.legs.length > 0) {
          info("PageSettings: Set leg options", { count: result.legs.length, mode: context });
        }
      }
    } catch (err: unknown) {
      debug("PageSettings: Failed to get race/leg options", err);
      if (props.setRaceOptions) {
        props.setRaceOptions([]);
        if (props.useUnfilteredOptions) setLocalRaceOptions([]);
      }
      if (props.setLegOptions) {
        props.setLegOptions([0]);
        if (props.useUnfilteredOptions) setLocalLegOptions([0]);
      }
    }
  });

  // Always show full grade options from datastore, with fallback to default grades
  createEffect(async () => {
    if (!props.setGradeOptions) return;
    try {
      const opts = await unifiedDataStore.getFilterOptions();
      let allGrades = (opts && (opts.grades || [])) || [];
      
      if (allGrades.length === 0) {
        allGrades = [1, 2, 3];
        info('PageSettings.jsx: No grades in datastore, providing default grades', { grades: allGrades });
      }
      
      props.setGradeOptions(allGrades.slice().sort((a: number, b: number) => a - b));
      info('PageSettings.jsx: Set full grade options from datastore', { grades: allGrades });
    } catch (_) {}
  });

  // When popup opens, refresh filter options from full dataset (IndexedDB) so options are not based on selected/filtered data
  createEffect(async () => {
    if (showPopup()) {
      try {
        const { selectedDatasetId, selectedDate, selectedSourceId } = persistantStore;
        const datasetId = selectedDatasetId?.();
        const date = selectedDate?.();
        const sourceId = selectedSourceId?.();
        const context: 'dataset' | 'day' | 'fleet' | 'source' =
          datasetId && datasetId > 0 ? 'dataset'
          : date && date !== '' && date !== '0' && (!datasetId || datasetId <= 0) ? 'day'
          : sourceId && sourceId > 0 && (!datasetId || datasetId <= 0) ? 'source'
          : 'fleet';
        await extractFilterOptions([], context);
        const opts = await unifiedDataStore.getFilterOptions();
        debug('PageSettings.jsx: Retrieved filter options from datastore (full dataset):', opts);
        if (opts) {
          let allGrades = (opts.grades || []).slice().sort((a: number, b: number) => a - b);
          
          debug('PageSettings.jsx: Parsed filter options:', { allGrades, raceToLegs: opts.raceToLegs });
          
          if (allGrades.length === 0) {
            allGrades = [1, 2, 3];
          }
          
          if (props.setGradeOptions) props.setGradeOptions(allGrades);
        } else {
          debug('PageSettings.jsx: No filter options found in datastore');
        }
      } catch (e) {
        debug('PageSettings.jsx cause: Error retrieving filter options:', e);
      }
    }
  });

  // Returns true if any filters are selected
  const anySelected = () => {
    return selected().length > 0 
      || selectedRaces().length > 0 
      || selectedLegs().length > 0 
      || selectedGrades().length > 0
      || selectedPhases().length > 0
      || selectedPeriods().length > 0
      || selectedBins().length > 0
      || selectedHeadsails().length > 0
      || selectedMainsails().length > 0
      || selectedConfigurations().length > 0;
  };

  // Button label logic
  const labelText = () => (anySelected() ? "APPLIED" : "NONE");

  // ESC key handler removed - modal should only close via Apply/Close buttons

  // Initialize local source selections when modal opens or when dataSourcesOptions becomes available
  let lastDataSourcesOptionsLength = 0;
  createEffect(() => {
    const isPopupOpen = showPopup();
    const dataSourcesOptions = Array.isArray(props.dataSourcesOptions) ? props.dataSourcesOptions : [];
    const currentLength = dataSourcesOptions.length;
    
    // Track when dataSourcesOptions changes (becomes available or changes)
    const optionsChanged = currentLength !== lastDataSourcesOptionsLength;
    const wasEmpty = lastDataSourcesOptionsLength === 0;
    lastDataSourcesOptionsLength = currentLength;
    
    if (isPopupOpen && currentLength > 0) {
      // Initialize or re-initialize when:
      // 1. Popup is open AND
      // 2. Options are available AND
      // 3. Options have changed (became available or updated)
      if (optionsChanged) {
        // Capture current source selections from signals
        const currentSelections = new Set<number>();
        dataSourcesOptions.forEach((opt) => {
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
        setLocalSourceSelections(currentSelections);
        setInitialSourceSelections(new Set(currentSelections));
        debug('PageSettings: Initialized local source selections', { 
          selections: Array.from(currentSelections),
          optionsCount: currentLength,
          wasEmpty: wasEmpty
        });
      }
    } else if (!isPopupOpen) {
      // Reset when modal closes
      lastDataSourcesOptionsLength = 0;
      setLocalSourceSelections(new Set());
      setInitialSourceSelections(new Set());
    }
  });

  // Initialize filter state when popup opens (only when popup state changes, not when filters change)
  let wasPopupOpen = false;
  createEffect(() => {
    const isPopupOpen = showPopup();
    if (isPopupOpen && !wasPopupOpen) {
      // Popup just opened - capture initial state (untrack to avoid tracking filter changes)
      untrack(() => {
        setInitialFilters({
          states: [...selected()],
          races: [...selectedRaces()],
          legs: [...selectedLegs()],
          grades: [...selectedGrades()],
          phases: [...selectedPhases()],
          periods: [...selectedPeriods()],
          bins: [...selectedBins()],
          headsails: [...selectedHeadsails()],
          mainsails: [...selectedMainsails()],
          configurations: [...selectedConfigurations()],
        });
      });
    } else if (!isPopupOpen) {
      // Popup closed - reset
      setInitialFilters(null);
    }
    wasPopupOpen = isPopupOpen;
  });

  // Helper to compare arrays
  const arraysEqual = <T,>(a: T[], b: T[]): boolean => {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((val, idx) => val === sortedB[idx]);
  };

  // Check if filter selections have changed
  const hasFilterChanges = createMemo(() => {
    if (!showPopup() || !initialFilters()) return false;
    const initial = initialFilters()!;
    
    return !arraysEqual(selected(), initial.states) ||
           !arraysEqual(selectedRaces(), initial.races) ||
           !arraysEqual(selectedLegs(), initial.legs) ||
           !arraysEqual(selectedGrades(), initial.grades) ||
           !arraysEqual(selectedPhases(), initial.phases) ||
           !arraysEqual(selectedPeriods(), initial.periods) ||
           !arraysEqual(selectedBins(), initial.bins) ||
           !arraysEqual(selectedHeadsails(), initial.headsails) ||
           !arraysEqual(selectedMainsails(), initial.mainsails) ||
           !arraysEqual(selectedConfigurations(), initial.configurations);
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

  // Check if any changes (filters or sources) have been made
  const hasAnyChanges = createMemo(() => {
    return hasFilterChanges() || hasSourceChanges();
  });

  // Apply source changes
  const handleApplySourceChanges = async () => {
    const selections = localSourceSelections();
    debug('PageSettings: Applying source changes', { selections: Array.from(selections) });
    
    // Convert source IDs to source names for persistence
    const sourceNames = Array.from(selections).map(sourceId => {
      const source = sourcesStore.sources().find(s => s.source_id === sourceId);
      return source?.source_name || '';
    }).filter(Boolean);
    
    // Save to persistent settings API (not just localStorage)
    const currentUser = user();
    if (currentUser?.user_id && sourceNames.length > 0) {
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
          debug('PageSettings: Saved sources to API', sourceNames);
        } catch (error) {
          debug('PageSettings: Error saving sources to API', error);
        }
      }
    }
    
    // Apply changes to all source options
    props.dataSourcesOptions.forEach((opt) => {
      if (opt.key?.startsWith('source-') && opt.signal?.[1]) {
        const match = opt.key.match(/source-(\d+)/);
        if (match) {
          const sourceId = Number(match[1]);
          const shouldBeSelected = selections.has(sourceId);
          opt.signal[1](shouldBeSelected);
        }
      }
    });
    
    // Update initial selections to current
    setInitialSourceSelections(new Set(selections));
  };

  // Outside click handler removed - modal should only close via Apply/Close buttons
  let modalContentRef;

  // Handle display option click
  const handleDisplayOptionClick = (option) => {
    try { info('PageSettings.jsx: Display option clicked', { option }); } catch {}
    
    if (option.type === 'color' && option.signal && option.signal.length === 2) {
      // Color type selection - set via signal (immediate for non-source options)
      const [, setter] = option.signal;
      setter(option.value);
    } else if (option.type === 'toggle' && option.signal && option.signal.length === 2) {
      // Check if this is a source toggle (key starts with "source-")
      const isSourceToggle = option.key && option.key.startsWith('source-');
      
      if (isSourceToggle) {
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
          debug('PageSettings: Source toggle - updated local state', { sourceId, selected: next.has(sourceId), localSelections: Array.from(next) });
        }
      } else {
        // For non-source toggles, apply immediately
        const [getter, setter] = option.signal;
        const currentValue = typeof getter === 'function' ? getter() : getter;
        setter(!currentValue);
      }
    }
  };

  // Handle filter click
  const handleFilterClick = (filter) => {
    try { info('PageSettings.jsx: TWA filter clicked', { filter }); } catch {}
    if (props.setSelectedStates) {
      const currentStates = typeof props.selectedStates === 'function' ? props.selectedStates() : (props.selectedStates || []);
      const filterLower = filter.toLowerCase();
      
      if (currentStates.includes(filterLower)) {
        const newStates = currentStates.filter(state => state !== filterLower);
        props.setSelectedStates(newStates);
      } else {
        const newStates = [...currentStates, filterLower];
        props.setSelectedStates(newStates);
      }
    } else if (props.toggleFilter) {
      props.toggleFilter(
        typeof props.groupIndex === "function" ? props.groupIndex() : props.groupIndex,
        0,
        filter.toLowerCase()
      );
    }
  };

  // Helper function to compare races (handle 'TRAINING' string and numbers)
  const isSameRace = (r1: any, r2: any): boolean => {
    if (r1 === r2) return true;
    if ((r1 === 'TRAINING' || r1 === 'training') && (r2 === 'TRAINING' || r2 === 'training' || r2 === -1 || r2 === '-1')) return true;
    if ((r2 === 'TRAINING' || r2 === 'training') && (r1 === 'TRAINING' || r1 === 'training' || r1 === -1 || r1 === '-1')) return true;
    return Number(r1) === Number(r2);
  };

  // Handler functions for all filter types
  const handleRaceClick = (race) => {
    try { info('PageSettings.jsx: Race clicked', { race }); } catch {}
    const isMultiMode = (props.mode === 'multi')
      || (props.sourceMode === 'multi')
      || (props.isMulti === true)
      || (Array.isArray(props.dataSourcesOptions) && props.dataSourcesOptions.length > 0);
    if (isMultiMode) {
      // Enforce single selection: keep only the clicked race
      const current = selectedRaces();
      const alreadyOnlyThis = Array.isArray(current) && current.length === 1 && isSameRace(current[0], race);
      if (alreadyOnlyThis) return;
      // If we have a direct setter, set atomically to avoid transient empties
      if (typeof props.setSelectedRaces === 'function') {
        props.setSelectedRaces([race]);
        return;
      }
      // Fallback: first ensure clicked race is selected, then deselect others
      // Check if race is already selected (handle 'TRAINING' string comparison)
      const isRaceSelected = Array.isArray(current) && current.some(r => isSameRace(r, race));
      if (props.toggleRaceFilter && (!Array.isArray(current) || !isRaceSelected)) {
        props.toggleRaceFilter(race);
      }
      if (props.toggleRaceFilter && Array.isArray(current)) {
        current.forEach((r) => {
          if (!isSameRace(r, race)) {
            props.toggleRaceFilter(r);
          }
        });
      }
      return;
    }
    if (props.toggleRaceFilter) props.toggleRaceFilter(race);
  };
  const handleLegClick = (leg) => {
    try { info('PageSettings.jsx: Leg clicked', { leg }); } catch {}
    if (props.toggleLegFilter) props.toggleLegFilter(leg);
  };
  const handleGradeClick = (grade) => {
    try { info('PageSettings.jsx: Grade clicked', { grade }); } catch {}
    if (props.toggleGradeFilter) props.toggleGradeFilter(grade);
  };
  const handlePhaseClick = (phase) => {
    try { info('PageSettings.jsx: Phase clicked', { phase }); } catch {}
    if (props.togglePhaseFilter) props.togglePhaseFilter(phase);
  };
  const handlePeriodClick = (period) => {
    try { info('PageSettings.jsx: Period clicked', { period }); } catch {}
    if (props.togglePeriodFilter) props.togglePeriodFilter(period);
  };
  const handleBinClick = (bin) => {
    try { info('PageSettings.jsx: Bin clicked', { bin }); } catch {}
    if (props.toggleBinFilter) props.toggleBinFilter(bin);
  };
  const handleHeadsailClick = (headsail) => {
    try { info('PageSettings.jsx: Headsail clicked', { headsail }); } catch {}
    if (props.toggleHeadsailFilter) props.toggleHeadsailFilter(headsail);
  };
  const handleMainsailClick = (mainsail) => {
    try { info('PageSettings.jsx: Mainsail clicked', { mainsail }); } catch {}
    if (props.toggleMainsailFilter) props.toggleMainsailFilter(mainsail);
  };
  const handleConfigurationClick = (config) => {
    try { info('PageSettings.jsx: Configuration clicked', { config }); } catch {}
    if (props.toggleConfigurationFilter) props.toggleConfigurationFilter(config);
  };

  // Clear all filters
  const handleClearAll = () => {
    if (props.toggleFilter && selected().length > 0) {
      selected().forEach(filter => {
        props.toggleFilter(
          typeof props.groupIndex === "function" ? props.groupIndex() : props.groupIndex,
          0,
          filter
        );
      });
    }
    
    if (props.setSelectedStates) props.setSelectedStates([]);
    
    if (props.toggleRaceFilter && selectedRaces().length > 0) {
      selectedRaces().forEach(race => props.toggleRaceFilter(race));
    }
    if (props.toggleLegFilter && selectedLegs().length > 0) {
      selectedLegs().forEach(leg => props.toggleLegFilter(leg));
    }
    if (props.toggleGradeFilter && selectedGrades().length > 0) {
      selectedGrades().forEach(grade => props.toggleGradeFilter(grade));
    }
    if (props.togglePhaseFilter && selectedPhases().length > 0) {
      selectedPhases().forEach(phase => props.togglePhaseFilter(phase));
    }
    if (props.togglePeriodFilter && selectedPeriods().length > 0) {
      selectedPeriods().forEach(period => props.togglePeriodFilter(period));
    }
    if (props.toggleBinFilter && selectedBins().length > 0) {
      selectedBins().forEach(bin => props.toggleBinFilter(bin));
    }
    if (props.toggleHeadsailFilter && selectedHeadsails().length > 0) {
      selectedHeadsails().forEach(headsail => props.toggleHeadsailFilter(headsail));
    }
    if (props.toggleMainsailFilter && selectedMainsails().length > 0) {
      selectedMainsails().forEach(mainsail => props.toggleMainsailFilter(mainsail));
    }
    if (props.toggleConfigurationFilter && selectedConfigurations().length > 0) {
      selectedConfigurations().forEach(config => props.toggleConfigurationFilter(config));
    }

    setSelectedFilters([]);
  };

  // Render a filter group
  const renderFilterGroup = (title, options, selectedValues, onClickHandler, colorClass) => (
    <div class="mb-4">
      <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">{title}</div>
      <div class="flex flex-wrap gap-2">
        {options.map((option) => {
          // For race filters, show "TRAINING" if race number is < 1
          const displayText = (title === "Race Filters" && Number(option) < 1) ? "TRAINING" : option;
          return (
            <span
              class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                selectedValues.includes(option)
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
      <div class="relative inline-block settings-parent">
        <Show when={props.useIconTrigger} fallback={
          <button
            onClick={() => {
              const next = !showPopup();
              setShowPopup(next);
              try { info('PageSettings.jsx: Toggle modal', { open: next }); } catch { log('PageSettings.jsx: Toggle modal', { open: next }); }
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
              try { info('PageSettings.jsx: Toggle modal', { open: next }); } catch { log('PageSettings.jsx: Toggle modal', { open: next }); }
            }}
            onContextMenu={(e) => e.preventDefault()}
            class="settings-icon settings-icon-floating cursor-pointer p-1 hover:opacity-70 transition-opacity"
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
                when={!hasSourceChanges()} 
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
                            const allIds = new Set(props.dataSourcesOptions.map(opt => {
                              const match = opt.key?.match(/source-(\d+)/);
                              return match ? Number(match[1]) : null;
                            }).filter(id => id !== null));
                            setLocalSourceSelections(allIds);
                            debug('PageSettings: Select All - updated local state', { count: allIds.size });
                          } catch (err) {
                            debug('PageSettings: Error selecting all sources', err);
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
                            setLocalSourceSelections(new Set());
                            debug('PageSettings: None - updated local state');
                          } catch (err) {
                            debug('PageSettings: Error deselecting all sources', err);
                          }
                        }}
                      >
                        None
                      </button>
                    </div>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    {(() => {
                      // Sort sources by source_id extracted from key (e.g., "source-8" -> 8)
                      // This ensures consistent ordering with PerfSettings
                      const sortedOptions = [...props.dataSourcesOptions].sort((a, b) => {
                        const aMatch = a.key?.match(/source-(\d+)/);
                        const bMatch = b.key?.match(/source-(\d+)/);
                        const aId = aMatch ? Number(aMatch[1]) : 0;
                        const bId = bMatch ? Number(bMatch[1]) : 0;
                        return aId - bId;
                      });
                      
                      return sortedOptions.map((option) => {
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
                            return option.signal?.[0]?.() ?? false;
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

              {/* Display Options Section - only show if there are items */}
              <Show when={(() => {
                const hasDisplayOptions = Array.isArray(props.displayOptions) && props.displayOptions.length > 0;
                const colorOpts = props.colorOptions || ['DEFAULT','GRADE','WIND','VMG'];
                const hasColorOptions = !props.hideColorOptions && Array.isArray(colorOpts) && colorOpts.length > 0;
                return hasDisplayOptions || hasColorOptions;
              })()}>
                <div class="mb-6">
                  <h3 class="text-base font-semibold mb-3" style="color: var(--color-text-primary);">Display Options</h3>
                  <div class="space-y-3">
                  {/* Color Type Options */}
                  <Show when={colorType && setColorType && !props.hideColorOptions}>
                    <div class="mb-3">
                      <div class="text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Color By</div>
                      <div class="flex flex-wrap gap-2">
                        {(props.colorOptions || ['DEFAULT','GRADE','WIND','VMG']).map((opt) => {
                          let displayName = opt;
                          if (opt === 'DEFAULT') displayName = 'Default';
                          else if (opt === 'VMG%') displayName = 'VMG%';
                          return (
                            <span
                              class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                                colorType() === opt ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700"
                              }`}
                              onClick={() => setColorType(opt)}
                            >
                              {displayName}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </Show>

                  {/* Chart data scope: All data (filters only) vs Selection only */}
                  <div class="mb-3">
                      <div class="text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Chart data</div>
                      <div class="flex flex-wrap gap-2">
                        <span
                          class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                            !filterChartsBySelection() ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700"
                          }`}
                          onClick={() => setFilterChartsBySelection(false)}
                        >
                          All data
                        </span>
                        <span
                          class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                            filterChartsBySelection() ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700"
                          }`}
                          onClick={() => setFilterChartsBySelection(true)}
                        >
                          Selection only
                        </span>
                      </div>
                    </div>

                  {/* Overlay Options (if provided by page) */}
                  <Show when={props.displayOptions && props.displayOptions.length > 0}>
                    <div class="mb-3">
                      <Show when={!props.hideOverlayOptionsLabel}>
                        <div class="text-sm font-medium mb-2" style="color: var(--color-text-secondary);">Overlay Options</div>
                      </Show>
                      <div class="flex flex-wrap gap-2">
                        {props.displayOptions.map((option) => (
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
                // Hide all filters if hideAllFilters prop is set
                if (props.hideAllFilters) return false;
                
                const cfg = filterConfig();
                const hasGrades = cfg.showGrades && !props.hideGradeFilters && gradeOptions().length > 0;
                const hasTwa = cfg.showTWA && !props.hideTwaFilters && filterOptions.length > 0;
                const hasRaces = cfg.showRaces && raceOptions().length > 0;
                const hasLegs = cfg.showLegs && legOptions().length > 0;
                const hasPhases = cfg.showPhases && (phaseOptions().length > 0);
                const hasPeriods = cfg.showPeriods && (periodOptions().length > 0);
                const hasBins = cfg.showBins && (binOptions().length > 0);
                const hasHeadsail = cfg.showHeadsail && (headsailOptions().length > 0);
                const hasMainsail = cfg.showMainsail && (mainsailOptions().length > 0);
                const hasConfig = cfg.showConfiguration && (configurationOptions().length > 0);
                return hasGrades || hasTwa || hasRaces || hasLegs || hasPhases || hasPeriods || hasBins || hasHeadsail || hasMainsail || hasConfig;
              })()}>
              <div class="mb-6">
                <h3 class="text-base font-semibold mb-3" style="color: var(--color-text-primary);">Filter Options</h3>
                
                <Show when={filterConfig().showGrades && !props.hideGradeFilters && gradeOptions().length > 0}>
                  {renderFilterGroup("Grade Filters", gradeOptions(), selectedGrades(), handleGradeClick, "bg-orange-500")}
                </Show>

                <Show when={filterConfig().showTWA && !props.hideTwaFilters && filterOptions.length > 0}>
                  <div class="mb-4">
                    <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">TWA Filters</div>
                    <div class="flex flex-wrap gap-2">
                      {filterOptions.map((filter) => (
                        <span
                          class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                            selected().includes(filter.toLowerCase())
                              ? "bg-green-500 text-white"
                              : "bg-gray-200 text-gray-700"
                          }`}
                          onClick={() => handleFilterClick(filter)}
                          onContextMenu={(e) => e.preventDefault()}
                        >
                          {filter}
                        </span>
                      ))}
                    </div>
                  </div>
                </Show>

                <Show when={filterConfig().showRaces && raceOptions().length > 0}>
                  {renderFilterGroup("Race Filters", raceOptions(), selectedRaces(), handleRaceClick, "bg-blue-500")}
                </Show>

                <Show when={filterConfig().showLegs && legOptions().filter(leg => Number(leg) >= 0).length > 0}>
                  {renderFilterGroup("Leg Filters", legOptions().filter(leg => Number(leg) >= 0), selectedLegs(), handleLegClick, "bg-purple-500")}
                </Show>

                <Show when={filterConfig().showPhases && phaseOptions().length > 0}>
                  {renderFilterGroup("Phase Filters", phaseOptions(), selectedPhases(), handlePhaseClick, "bg-teal-500")}
                </Show>

                <Show when={filterConfig().showPeriods && periodOptions().length > 0}>
                  {renderFilterGroup("Period Filters", periodOptions(), selectedPeriods(), handlePeriodClick, "bg-indigo-500")}
                </Show>

                <Show when={filterConfig().showBins && binOptions().length > 0}>
                  {renderFilterGroup("Bin Filters", binOptions(), selectedBins(), handleBinClick, "bg-pink-500")}
                </Show>

                <Show when={filterConfig().showHeadsail && headsailOptions().length > 0}>
                  {renderFilterGroup("Headsail Filters", headsailOptions(), selectedHeadsails(), handleHeadsailClick, "bg-amber-500")}
                </Show>

                <Show when={filterConfig().showMainsail && mainsailOptions().length > 0}>
                  {renderFilterGroup("Mainsail Filters", mainsailOptions(), selectedMainsails(), handleMainsailClick, "bg-amber-500")}
                </Show>

                <Show when={filterConfig().showConfiguration && configurationOptions().length > 0}>
                  {renderFilterGroup("Configuration Filters", configurationOptions(), selectedConfigurations(), handleConfigurationClick, "bg-amber-500")}
                </Show>
              </div>
              </Show>
            </div>

            {/* Modal Footer */}
            <div class="flex justify-between items-center p-4 border-t" style="border-color: var(--color-border-primary);">
              <div class="flex gap-2">
                <Show when={anySelected()}>
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
                    Clear All
                  </button>
                </Show>
              </div>
              
              <div class="flex gap-2">
                <Show when={props.builderRoute}>
                  <button
                    onClick={() => {
                      setShowPopup(false);
                      navigate(props.builderRoute);
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
                  when={hasAnyChanges()} 
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
                    onClick={() => {
                      if (hasSourceChanges()) {
                        handleApplySourceChanges();
                      }
                      // Call onApply callback if provided (for applying filters)
                      if (props.onApply) {
                        props.onApply();
                      }
                      setShowPopup(false);
                    }}
                    class="px-4 py-2 text-sm rounded-md transition-colors font-medium"
                    style="background: #22c55e; color: white;"
                    onMouseEnter={(e) => {
                      const btn = e.currentTarget;
                      if (btn) btn.style.backgroundColor = '#16a34a';
                    }}
                    onMouseLeave={(e) => {
                      const btn = e.currentTarget;
                      if (btn) btn.style.backgroundColor = '#22c55e';
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
