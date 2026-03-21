import { createSignal, createEffect, Show, createMemo } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import { FiSettings } from "solid-icons/fi";
import { persistantStore } from "../../store/persistantStore";
import { sourcesStore } from "../../store/sourcesStore";
import { info, debug, log, error as logError } from "../../utils/console";
import { getRaceAndLegOptions } from "../../services/raceLegOptionsService";
import { isSameRace, formatRaceForDisplay } from "../../utils/raceValueUtils";
import { user } from "../../store/userStore";
import { persistentSettingsService } from "../../services/persistentSettingsService";

interface TimeSeriesSettingsProps {
  // Fleet mode flag
  isFleet?: boolean;
  // Filter options
  raceOptions?: (number | string)[];
  legOptions?: number[];
  gradeOptions?: number[];
  // Selected filter values
  selectedRaces?: (number | string)[] | (() => (number | string)[]);
  selectedLegs?: number[] | (() => number[]);
  selectedGrades?: number[] | (() => number[]);
  // Setters for options
  setLegOptions?: (options: number[]) => void;
  setRaceOptions?: (options: (number | string)[]) => void;
  setGradeOptions?: (options: number[]) => void;
  // Toggle handlers for filters
  toggleRaceFilter?: (race: number | string) => void;
  toggleLegFilter?: (leg: number) => void;
  toggleGradeFilter?: (grade: number) => void;
  // Configuration
  useUnfilteredOptions?: boolean;
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
  // Data sources (for fleet mode)
  dataSourcesOptions?: Array<{
    key?: string;
    label?: string;
    name?: string;
    signal?: [() => boolean, (value: boolean) => void];
  }>;
  // Builder route
  builderRoute?: string;
  /** Current chart/page object name (e.g. from parent); used for builder link so it opens the chart being viewed */
  objectName?: string;
  // UI
  useIconTrigger?: boolean;
  [key: string]: any;
}

export default function TimeSeriesSettings(props: TimeSeriesSettingsProps) {
  const [showPopup, setShowPopup] = createSignal(false);
  let navigate: (path: string) => void;
  
  try {
    navigate = useNavigate();
  } catch (error: any) {
    // Router not available, use fallback
    navigate = () => {
      log('TimeSeriesSettings: Router not available - navigation disabled');
    };
  }

  // Local state for source selections (deferred until Apply is clicked)
  const [localSourceSelections, setLocalSourceSelections] = createSignal<Set<number>>(new Set());
  const [initialSourceSelections, setInitialSourceSelections] = createSignal<Set<number>>(new Set());

  // Local state for filter selections (deferred until Apply is clicked)
  const [localRaceSelections, setLocalRaceSelections] = createSignal<Set<number | string>>(new Set());
  const [localLegSelections, setLocalLegSelections] = createSignal<Set<number>>(new Set());
  const [localGradeSelections, setLocalGradeSelections] = createSignal<Set<number>>(new Set());
  const [initialRaceSelections, setInitialRaceSelections] = createSignal<Set<number | string>>(new Set());
  const [initialLegSelections, setInitialLegSelections] = createSignal<Set<number>>(new Set());
  const [initialGradeSelections, setInitialGradeSelections] = createSignal<Set<number>>(new Set());

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
  /** Leg options to show in settings: only Leg_numbers > -1 */
  const visibleLegOptions = (): number[] => legOptions().filter(leg => Number(leg) > -1);
  const gradeOptions = (): number[] => (props.gradeOptions || []).filter((grade: any) => !isNaN(grade) && grade !== null && grade !== undefined);

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

  // Default filter config - show races and legs, hide grades
  const filterConfig = () => props.filterConfig || {
    showGrades: false,
    showTWA: false,
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
    if (!hasDate && !hasDataset && className.toLowerCase() !== "gp50") return;
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
          info("TimeSeriesSettings: Set race options", { count: result.races.length, mode: context });
        }
      }
      if (props.setLegOptions) {
        props.setLegOptions(result.legs);
        if (props.useUnfilteredOptions) setLocalLegOptions(result.legs);
        if (result.legs.length > 0) {
          info("TimeSeriesSettings: Set leg options", { count: result.legs.length, mode: context });
        }
      }
    } catch (err: unknown) {
      debug("TimeSeriesSettings: Failed to get race/leg options", err);
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

  // Returns true if any filters are selected
  const anySelected = () => {
    return selectedRaces().length > 0 
      || selectedLegs().length > 0 
      || selectedGrades().length > 0;
  };

  // Button label logic
  const labelText = () => (anySelected() ? "APPLIED" : "SETTINGS");

  // Initialize local selections when modal opens
  // Track the last popup state to detect when it opens
  let lastPopupState = false;
  createEffect(() => {
    const isOpen = showPopup();
    const options = props.dataSourcesOptions;
    const hasOptions = Array.isArray(options) && options.length > 0;
    
    // When modal opens (transitions from closed to open)
    if (isOpen && !lastPopupState) {
      // Initialize source selections if fleet mode
      if (hasOptions) {
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
        debug('TimeSeriesSettings: Initialized local source selections', { 
          selections: Array.from(currentSelections),
          count: currentSelections.size
        });
      }
      
      // Initialize filter selections
      const currentRaces = new Set(selectedRaces());
      const currentLegs = new Set(selectedLegs());
      const currentGrades = new Set(selectedGrades());
      setLocalRaceSelections(currentRaces);
      setLocalLegSelections(currentLegs);
      setLocalGradeSelections(currentGrades);
      setInitialRaceSelections(new Set(currentRaces));
      setInitialLegSelections(new Set(currentLegs));
      setInitialGradeSelections(new Set(currentGrades));
      debug('TimeSeriesSettings: Initialized local filter selections', {
        races: Array.from(currentRaces),
        legs: Array.from(currentLegs),
        grades: Array.from(currentGrades)
      });
    } else if (!isOpen && lastPopupState) {
      // Modal just closed - reset state
      setLocalSourceSelections(new Set<number>());
      setInitialSourceSelections(new Set<number>());
      setLocalRaceSelections(new Set());
      setLocalLegSelections(new Set());
      setLocalGradeSelections(new Set());
      setInitialRaceSelections(new Set());
      setInitialLegSelections(new Set());
      setInitialGradeSelections(new Set());
      debug('TimeSeriesSettings: Reset local selections on modal close');
    }
    
    // Update tracked state
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

  // Check if filter selections have changed
  const hasFilterChanges = createMemo(() => {
    if (!showPopup()) return false;
    
    const currentRaces = localRaceSelections();
    const currentLegs = localLegSelections();
    const currentGrades = localGradeSelections();
    const initialRaces = initialRaceSelections();
    const initialLegs = initialLegSelections();
    const initialGrades = initialGradeSelections();
    
    // Check races
    if (currentRaces.size !== initialRaces.size) return true;
    for (const race of currentRaces) {
      if (!initialRaces.has(race)) return true;
    }
    for (const race of initialRaces) {
      if (!currentRaces.has(race)) return true;
    }
    
    // Check legs
    if (currentLegs.size !== initialLegs.size) return true;
    for (const leg of currentLegs) {
      if (!initialLegs.has(leg)) return true;
    }
    for (const leg of initialLegs) {
      if (!currentLegs.has(leg)) return true;
    }
    
    // Check grades
    if (currentGrades.size !== initialGrades.size) return true;
    for (const grade of currentGrades) {
      if (!initialGrades.has(grade)) return true;
    }
    for (const grade of initialGrades) {
      if (!currentGrades.has(grade)) return true;
    }
    
    return false;
  });

  // Check if any changes (sources or filters) have been made
  const hasAnyChanges = createMemo(() => {
    return hasSourceChanges() || hasFilterChanges();
  });

  // Apply all changes (sources and filters)
  const handleApplyChanges = async () => {
    const sourceSelections = localSourceSelections();
    const raceSelections = localRaceSelections();
    const legSelections = localLegSelections();
    const gradeSelections = localGradeSelections();
    
    debug('TimeSeriesSettings: Applying all changes', { 
      sources: Array.from(sourceSelections),
      races: Array.from(raceSelections),
      legs: Array.from(legSelections),
      grades: Array.from(gradeSelections)
    });
    
    // Apply source changes (for fleet mode): set filterStore once so FleetVideo/FleetMap/FleetTimeSeries all update in one reaction
    if (Array.isArray(props.dataSourcesOptions) && props.dataSourcesOptions.length > 0) {
      const sourceNames = Array.from(sourceSelections)
        .map((sourceId: number) => {
          const source = sourcesStore.sources().find((s: any) => Number(s.source_id) === sourceId);
          return source?.source_name ?? sourcesStore.getSourceName?.(sourceId) ?? '';
        })
        .filter(Boolean);
      const { setSelectedSources } = await import('../../store/filterStore');
      setSelectedSources(sourceNames);
      debug('TimeSeriesSettings: Applied source selection to filterStore', { count: sourceNames.length, names: sourceNames });
    }

    // Apply filter changes - convert to strings and set directly
    const { setSelectedRacesTimeseries, setSelectedLegsTimeseries, setSelectedGradesTimeseries } = await import('../../store/filterStore');
    
    const raceStrings = Array.from(raceSelections).map(r => {
      if (r === 'TRAINING' || r === 'training' || r === -1 || r === '-1') {
        return 'TRAINING';
      }
      return String(r);
    });
    
    const legStrings = Array.from(legSelections).map(l => String(l));
    const gradeStrings = Array.from(gradeSelections).map(g => String(g));
    
    setSelectedRacesTimeseries(raceStrings);
    setSelectedLegsTimeseries(legStrings);
    setSelectedGradesTimeseries(gradeStrings);
    
    debug('TimeSeriesSettings: Applied filters to filterStore', {
      races: raceStrings,
      legs: legStrings,
      grades: gradeStrings
    });
    
    // Update initial selections to current (so hasAnyChanges() returns false)
    setInitialSourceSelections(new Set(sourceSelections));
    setInitialRaceSelections(new Set(raceSelections));
    setInitialLegSelections(new Set(legSelections));
    setInitialGradeSelections(new Set(gradeSelections));
    
    // Save source selections to persistent settings API (async, but don't block on it)
    if (sourceSelections.size > 0) {
      const sourceNames = Array.from(sourceSelections).map((sourceId: number) => {
        const source = sourcesStore.sources().find(s => s.source_id === sourceId);
        return source?.source_name || '';
      }).filter(Boolean);
      
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
            debug('TimeSeriesSettings: Saved sources to API', sourceNames);
          } catch (error) {
            debug('TimeSeriesSettings: Error saving sources to API', error);
          }
        }
      }
    }
  };

  // Handle display option click
  const handleDisplayOptionClick = (option: any) => {
    try { info('TimeSeriesSettings: Display option clicked', { option }); } catch {}
    
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
        debug('TimeSeriesSettings: Source toggle - updated local state', { sourceId, selected: next.has(sourceId), localSelections: Array.from(next) });
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

  // Handler functions for filter types - update local state instead of applying immediately
  const handleRaceClick = (race: any) => {
    try { info('TimeSeriesSettings: Race clicked', { race }); } catch {}
    const current = localRaceSelections();
    const next = new Set(current);
    // Normalize race for comparison
    const normalizedRace = (race === 'TRAINING' || race === 'training' || race === -1 || race === '-1') ? 'TRAINING' : race;
    const normalizedCurrent = Array.from(current).map(r => 
      (r === 'TRAINING' || r === 'training' || r === -1 || r === '-1') ? 'TRAINING' : r
    );
    
    if (normalizedCurrent.includes(normalizedRace)) {
      // Remove all matching races
      Array.from(current).forEach(r => {
        const normalized = (r === 'TRAINING' || r === 'training' || r === -1 || r === '-1') ? 'TRAINING' : r;
        if (normalized === normalizedRace) {
          next.delete(r);
        }
      });
    } else {
      next.add(race);
    }
    setLocalRaceSelections(next);
    debug('TimeSeriesSettings: Race toggle - updated local state', { race, selected: next.has(race), localSelections: Array.from(next) });
  };
  
  const handleLegClick = (leg: any) => {
    try { info('TimeSeriesSettings: Leg clicked', { leg }); } catch {}
    const current = localLegSelections();
    const next = new Set(current);
    if (next.has(leg)) {
      next.delete(leg);
    } else {
      next.add(leg);
    }
    setLocalLegSelections(next);
    debug('TimeSeriesSettings: Leg toggle - updated local state', { leg, selected: next.has(leg), localSelections: Array.from(next) });
  };
  
  const handleGradeClick = (grade: any) => {
    try { info('TimeSeriesSettings: Grade clicked', { grade }); } catch {}
    const current = localGradeSelections();
    const next = new Set(current);
    if (next.has(grade)) {
      next.delete(grade);
    } else {
      next.add(grade);
    }
    setLocalGradeSelections(next);
    debug('TimeSeriesSettings: Grade toggle - updated local state', { grade, selected: next.has(grade), localSelections: Array.from(next) });
  };

  // Clear all filters - update local state
  const handleClearAll = () => {
    setLocalRaceSelections(new Set());
    setLocalLegSelections(new Set());
    setLocalGradeSelections(new Set());
    debug('TimeSeriesSettings: Clear all - updated local state');
  };

  // Render a filter group - use local state for selection display
  const renderFilterGroup = (title: string, options: any[], onClickHandler: (value: any) => void, colorClass: string) => {
    // Get local selections based on filter type
    let localSelections: Set<any>;
    if (title === "Race Filters") {
      localSelections = localRaceSelections();
    } else if (title === "Leg Filters") {
      localSelections = localLegSelections();
    } else if (title === "Grade Filters") {
      localSelections = localGradeSelections();
    } else {
      localSelections = new Set();
    }
    
    return (
      <div class="mb-4">
        <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">{title}</div>
        <div class="flex flex-wrap gap-2">
          {options.map((option) => {
            // For race filters, use centralized display formatting
            const displayText = title === "Race Filters" ? formatRaceForDisplay(option) : String(option);
            
            // Check if option is selected in local state
            let isSelected = false;
            if (title === "Race Filters") {
              isSelected = Array.from(localSelections).some(val => isSameRace(val, option));
            } else {
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
  };

  // Get object name for builder navigation (prefer parent-provided so builder opens the chart being viewed)
  const objectNameForBuilder = (): string => {
    if (props.objectName != null && String(props.objectName).trim() !== '') return String(props.objectName).trim();
    const { selectedPage } = persistantStore;
    return selectedPage() || 'default';
  };

  // Build builder route
  const builderRoute = (): string => {
    if (props.builderRoute) return props.builderRoute;
    const objName = objectNameForBuilder();
    if (props.isFleet) {
      return `/timeseries-builder?object_name=${encodeURIComponent(objName)}&fleet=true`;
    }
    return `/timeseries-builder?object_name=${encodeURIComponent(objName)}`;
  };

  return (
    <>
      <div class="relative inline-block settings-parent timeseries-settings-wrapper">
        <Show when={props.useIconTrigger} fallback={
          <button
            onClick={() => {
              const next = !showPopup();
              setShowPopup(next);
              try { info('TimeSeriesSettings: Toggle modal', { open: next }); } catch { log('TimeSeriesSettings: Toggle modal', { open: next }); }
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
              try { info('TimeSeriesSettings: Toggle modal', { open: next }); } catch { log('TimeSeriesSettings: Toggle modal', { open: next }); }
            }}
            onContextMenu={(e) => e.preventDefault()}
            class="timeseries-settings-icon cursor-pointer p-1 hover:opacity-70 transition-opacity"
          >
            <FiSettings size={24} />
          </div>
        </Show>
      </div>

      {/* Modal Overlay */}
      <Show when={showPopup()}>
        <Portal mount={typeof document !== 'undefined' ? document.body : undefined}>
          <div
            class="pagesettings-overlay"
          >
          <div
            class="pagesettings-modal"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div class="flex justify-between items-center p-4 border-b" style="border-color: var(--color-border-primary);">
              <h2 class="text-lg font-semibold" style="color: var(--color-text-primary);">Time Series Settings</h2>
              <Show 
                when={!hasAnyChanges()} 
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
              {/* Data Sources Section - shown only for fleet mode */}
              <Show when={props.isFleet && Array.isArray(props.dataSourcesOptions) && props.dataSourcesOptions.length > 0}>
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
                              debug('TimeSeriesSettings: Select All - updated local state', { count: allIds.size });
                            }
                          } catch (err) {
                            debug('TimeSeriesSettings: Error selecting all sources', err);
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
                            debug('TimeSeriesSettings: None - updated local state');
                          } catch (err) {
                            debug('TimeSeriesSettings: Error deselecting all sources', err);
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

              {/* Filter Options Section */}
              <Show when={(() => {
                const cfg = filterConfig();
                const hasGrades = cfg.showGrades && gradeOptions().length > 0;
                const hasRaces = cfg.showRaces && raceOptions().length > 0;
                const hasLegs = cfg.showLegs && visibleLegOptions().length > 0;
                return hasGrades || hasRaces || hasLegs;
              })()}>
              <div class="mb-6">
                <h3 class="text-base font-semibold mb-3" style="color: var(--color-text-primary);">Filter Options</h3>
                
                <Show when={filterConfig().showGrades && gradeOptions().length > 0}>
                  {renderFilterGroup("Grade Filters", gradeOptions(), handleGradeClick, "bg-orange-500")}
                </Show>

                <Show when={filterConfig().showRaces && raceOptions().length > 0}>
                  {renderFilterGroup("Race Filters", raceOptions(), handleRaceClick, "bg-blue-500")}
                </Show>

                <Show when={filterConfig().showLegs && visibleLegOptions().length > 0}>
                  {renderFilterGroup("Leg Filters", visibleLegOptions(), handleLegClick, "bg-purple-500")}
                </Show>
              </div>
              </Show>
            </div>

            {/* Modal Footer */}
            <div class="flex justify-between items-center p-4 border-t" style="border-color: var(--color-border-primary);">
              <div class="flex gap-2">
                <Show when={localRaceSelections().size > 0 || localLegSelections().size > 0 || localGradeSelections().size > 0}>
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
                {/* Page Builder button */}
                <Show when={builderRoute()}>
                  <button
                    onClick={() => {
                      setShowPopup(false);
                      navigate(builderRoute());
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
                    onClick={async () => {
                      await handleApplyChanges();
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

