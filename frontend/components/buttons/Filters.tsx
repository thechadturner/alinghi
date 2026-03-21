import { createSignal, createEffect, onCleanup, onMount } from "solid-js";
import { unifiedDataStore } from "../../store/unifiedDataStore";
import { setSelectedFilters } from "../../store/filterStore";
import { info, debug, log } from "../../utils/console";

interface FiltersProps {
  options?: string[];
  raceOptions?: (number | string)[];
  legOptions?: number[];
  gradeOptions?: number[];
  selectedStates?: string[] | (() => string[]);
  selectedRaces?: (number | string)[] | (() => (number | string)[]);
  selectedLegs?: number[] | (() => number[]);
  selectedGrades?: number[] | (() => number[]);
  group?: {
    charts?: Array<{
      filters?: string[];
    }>;
  };
  setRaceOptions?: (options: number[]) => void;
  setLegOptions?: (options: number[]) => void;
  setGradeOptions?: (options: number[]) => void;
  toggleFilter?: (value: string) => void;
  toggleRaceFilter?: (value: number) => void;
  toggleLegFilter?: (value: number) => void;
  toggleGradeFilter?: (value: number) => void;
  groupIndex?: number;
  label?: string;
  [key: string]: any;
}

export default function Filters(props: FiltersProps) {
  const [showPopup, setShowPopup] = createSignal(false);

  // Use options prop if provided, else default
  const filterOptions: string[] = props.options || ["Upwind", "Downwind", "Reaching", "Port", "Starboard"];

  // Get race and leg options from props, filtering out NaN values
  const raceOptions = (): (number | string)[] => (props.raceOptions || []).filter((race: any) => 
    race !== null && race !== undefined && 
    (race === 'TRAINING' || race === 'training' || !isNaN(race))
  );
  const legOptions = (): number[] => (props.legOptions || []).filter((leg: any) => !isNaN(leg) && leg !== null && leg !== undefined);
  const gradeOptions = (): number[] => (props.gradeOptions || []).filter((grade: any) => !isNaN(grade) && grade !== null && grade !== undefined);

  // Use props.group.charts[0].filters if provided, else fallback to props.selectedStates if passed
  const selected = (): string[] => {
    if (props.group?.charts?.[0]?.filters) {
      return props.group.charts[0].filters;
    }
    // Make sure we're getting the current selectedStates value
    return typeof props.selectedStates === 'function' ? props.selectedStates() : (props.selectedStates || []);
  };

  // Get selected races and legs from props, filtering out NaN values but allowing 'TRAINING'
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

  // Always show full leg options from datastore, regardless of selected races
  createEffect(async () => {
    if (!props.setLegOptions) return;
    try {
      const opts = await unifiedDataStore.getFilterOptions();
      const allLegs = (opts && (opts.legs || opts.legOptions || [])) || [];
      props.setLegOptions(allLegs.slice().sort((a: number, b: number) => a - b));
      info('Filters.jsx: Set full leg options from datastore', { legs: allLegs });
    } catch (_) {}
  });

  // Always show full race options from datastore
  createEffect(async () => {
    if (!props.setRaceOptions) return;
    try {
      const opts = await unifiedDataStore.getFilterOptions();
      const allRaces = (opts && (opts.races || [])) || [];
      props.setRaceOptions(allRaces.slice().sort((a: number, b: number) => a - b));
      info('Filters.jsx: Set full race options from datastore', { races: allRaces });
    } catch (_) {}
  });

  // Always show full grade options from datastore, with fallback to default grades
  createEffect(async () => {
    if (!props.setGradeOptions) return;
    try {
      const opts = await unifiedDataStore.getFilterOptions();
      let allGrades = (opts && (opts.grades || [])) || [];
      
      // If no grades found in datastore, provide default grades (1, 2, 3)
      if (allGrades.length === 0) {
        allGrades = [1, 2, 3];
        info('Filters.jsx: No grades in datastore, providing default grades', { grades: allGrades });
      }
      
      props.setGradeOptions(allGrades.slice().sort((a: number, b: number) => a - b));
      info('Filters.jsx: Set full grade options from datastore', { grades: allGrades });
    } catch (_) {}
  });

  // Log the filters populated when the popup opens
  createEffect(async () => {
    if (showPopup()) {
      try {
        // Refresh options from datastore on open to avoid stale lists
        const opts = await unifiedDataStore.getFilterOptions();
        debug('Filters.jsx: Retrieved filter options from datastore:', opts);
        if (opts) {
          const allRaces = (opts.races || []).slice().sort((a,b)=>a-b);
          let allGrades = (opts.grades || []).slice().sort((a,b)=>a-b);
          const allLegs = (opts.legs || opts.legOptions || []).slice().sort((a,b)=>a-b);
          
          debug('Filters.jsx: Parsed filter options:', { allRaces, allGrades, allLegs, raceToLegs: opts.raceToLegs });
          
          // If no grades found, provide default grades
          if (allGrades.length === 0) {
            allGrades = [1, 2, 3];
          }
          
          if (props.setRaceOptions) props.setRaceOptions(allRaces);
          if (props.setGradeOptions) props.setGradeOptions(allGrades);
          if (props.setLegOptions) {
            const races = selectedRaces();
            const raceToLegs = opts.raceToLegs || {};
            const legs = races.length > 0
              ? Array.from(new Set(races.flatMap(r => raceToLegs[r] || []))).sort((a,b)=>a-b)
              : allLegs;
            props.setLegOptions(legs);
          }
        } else {
          debug('Filters.jsx: No filter options found in datastore');
        }
      } catch (e) {
        debug('Filters.jsx: Error retrieving filter options:', e);
      }
      const payload = {
        statesOptions: filterOptions,
        raceOptions: raceOptions(),
        legOptions: legOptions(),
        gradeOptions: gradeOptions(),
        selectedStates: selected(),
        selectedRaces: selectedRaces(),
        selectedLegs: selectedLegs(),
        selectedGrades: selectedGrades()
      };
      try { info('Filters.jsx: Opening filter dropdown with options', payload); } catch { log('Filters.jsx: Opening filter dropdown with options', payload); }
    }
  });

  // Returns true if any filters are selected
  const anySelected = () => selected().length > 0 || selectedRaces().length > 0 || selectedLegs().length > 0 || selectedGrades().length > 0;

  // Button label logic
  const labelText = () => (anySelected() ? "APPLIED" : "NONE");

  // Close popup on outside click
  let popupRef;
  createEffect(() => {
    if (showPopup()) {
      const handler = (e) => {
        if (popupRef && !popupRef.contains(e.target)) setShowPopup(false);
      };
      document.addEventListener("mousedown", handler);
      onCleanup(() => document.removeEventListener("mousedown", handler));
    }
  });

  // Handle filter click (call parent toggleFilter and keep popup open)
  const handleFilterClick = (filter) => {
    try { info('Filters.jsx: TWA filter clicked', { filter }); } catch {}
    // Use setSelectedStates if provided (preferred method)
    if (props.setSelectedStates) {
      const currentStates = typeof props.selectedStates === 'function' ? props.selectedStates() : (props.selectedStates || []);
      const filterLower = filter.toLowerCase();
      
      if (currentStates.includes(filterLower)) {
        // Remove filter
        const newStates = currentStates.filter(state => state !== filterLower);
        props.setSelectedStates(newStates);
      } else {
        // Add filter
        const newStates = [...currentStates, filterLower];
        props.setSelectedStates(newStates);
      }
    }
    else if (props.toggleFilter) {
      props.toggleFilter(
        typeof props.groupIndex === "function"
          ? props.groupIndex()
          : props.groupIndex,
        0,
        filter.toLowerCase()
      );
    }
  };

  // Watchers to log selection changes propagated via props
  createEffect(() => {
    const v = selectedRaces();
    try { info('Filters.jsx: selectedRaces changed', v); } catch {}
  });
  createEffect(() => {
    const v = selectedLegs();
    try { info('Filters.jsx: selectedLegs changed', v); } catch {}
  });
  createEffect(() => {
    const v = selectedGrades();
    try { info('Filters.jsx: selectedGrades changed', v); } catch {}
  });
  createEffect(() => {
    const v = selected();
    try { info('Filters.jsx: selectedStates changed', v); } catch {}
  });

  // Handle race filter click
  const handleRaceClick = (race) => {
    try { info('Filters.jsx: Race clicked', { race }); } catch {}
    if (props.toggleRaceFilter) {
      props.toggleRaceFilter(race);
    }
  };

  // Handle leg filter click
  const handleLegClick = (leg) => {
    try { info('Filters.jsx: Leg clicked', { leg }); } catch {}
    if (props.toggleLegFilter) {
      props.toggleLegFilter(leg);
    }
  };

  // Handle grade filter click
  const handleGradeClick = (grade) => {
    try { info('Filters.jsx: Grade clicked', { grade }); } catch {}
    if (props.toggleGradeFilter) {
      props.toggleGradeFilter(grade);
    }
  };

  return (
    <div class="relative inline-block forced-medium">
      <button
        onClick={() => {
          const next = !showPopup();
          setShowPopup(next);
          try { info('Filters.jsx: toggle dropdown', { open: next }); } catch { log('Filters.jsx: toggle dropdown', { open: next }); }
        }}
        onContextMenu={(e) => e.preventDefault()}
        class={`dropdown py-2 px-3 rounded-md flex flex-col items-center forced-medium`}
        style="background: var(--color-bg-button); color: var(--color-text-inverse); transition: all 0.3s ease;"
      >
        <span class="self-start text-xs font-medium">Filters</span>
        <span class="text-sm font-bold">{labelText()}</span>
      </button>
      {showPopup() && (
        <div
          ref={el => (popupRef = el)}
          class="dropdown absolute z-10 border rounded shadow-lg mt-2 p-4 left-0 right-0"
          style={{ 
            "min-width": "450px", 
            "max-width": "100vw", 
            "width": "max-content",
            "background": "var(--color-bg-card)",
            "border-color": "var(--color-border-primary)",
            "transition": "all 0.3s ease"
          }}
        >
          {/* Grade Filters Row */}
          {gradeOptions().length > 0 && (
            <div class="mb-4">
              <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">Grade Filters</div>
              <div class="flex flex-wrap gap-2">
                {gradeOptions().map((grade) => (
                  <span
                    class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                      selectedGrades().includes(grade)
                        ? "bg-orange-500 text-white"
                        : "bg-gray-200 text-gray-700"
                    }`}
                    onClick={() => handleGradeClick(grade)}
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    Grade {grade}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* TWA Filters Row */}
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

          {/* Race Filters Row */}
          {raceOptions().length > 0 && (
            <div class="mb-4">
              <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">Race Filters</div>
              <div class="flex flex-wrap gap-2">
                {raceOptions().map((race) => {
                  // Show "TRAINING" if race is 'TRAINING' or race number is < 1
                  const raceLabel = (race === 'TRAINING' || race === 'training' || (typeof race === 'number' && race < 1)) ? "TRAINING" : `Race ${race}`;
                  return (
                    <span
                      class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                        selectedRaces().includes(race)
                          ? "bg-blue-500 text-white"
                          : "bg-gray-200 text-gray-700"
                      }`}
                      onClick={() => handleRaceClick(race)}
                      onContextMenu={(e) => e.preventDefault()}
                    >
                      {raceLabel}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Leg Filters Row - show if legs are selected or if races are selected */}
          {(legOptions().filter(leg => Number(leg) >= 0).length > 0) && (
            <div class="mb-2">
              <div class="text-sm font-medium mb-2" style="color: var(--color-text-primary);">Leg Filters</div>
              <div class="flex flex-wrap gap-2">
                {legOptions().filter(leg => Number(leg) >= 0).map((leg) => (
                  <span
                    class={`px-3 py-1 rounded-full text-sm cursor-pointer ${
                      selectedLegs().includes(leg)
                        ? "bg-purple-500 text-white"
                        : "bg-gray-200 text-gray-700"
                    }`}
                    onClick={() => handleLegClick(leg)}
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    Leg {leg}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Clear All Button - only show if any filters are selected */}
          {anySelected() && (
            <div class="flex justify-between mt-4">
              <button
                onClick={() => {
                  // Clear all filter types
                  if (props.toggleFilter && selected().length > 0) {
                    // Clear TWA filters
                    selected().forEach(filter => {
                      props.toggleFilter(
                        typeof props.groupIndex === "function"
                          ? props.groupIndex()
                          : props.groupIndex,
                        0,
                        filter
                      );
                    });
                  }
                  
                  // Clear selectedStates if setSelectedStates is provided
                  if (props.setSelectedStates) {
                    props.setSelectedStates([]);
                  }
                  
                  // Clear race filters
                  if (props.toggleRaceFilter && selectedRaces().length > 0) {
                    selectedRaces().forEach(race => {
                      props.toggleRaceFilter(race);
                    });
                  }
                  
                  // Clear leg filters
                  if (props.toggleLegFilter && selectedLegs().length > 0) {
                    selectedLegs().forEach(leg => {
                      props.toggleLegFilter(leg);
                    });
                  }
                  
                  // Clear grade filters
                  if (props.toggleGradeFilter && selectedGrades().length > 0) {
                    selectedGrades().forEach(grade => {
                      props.toggleGradeFilter(grade);
                    });
                  }

                  // Clear global selectedFilters store
                  setSelectedFilters([]);
                }}
                class="px-4 py-2 text-sm rounded-md transition-colors"
                style="background: var(--color-text-error); color: var(--color-text-inverse);"
                onMouseEnter={(e) => e.target['style'].backgroundColor = 'var(--color-bg-button-hover)'}
                onMouseLeave={(e) => e.target['style'].backgroundColor = 'var(--color-text-error)'}
              >
                Clear All
              </button>
              <button
                onClick={() => setShowPopup(false)}
                class="px-4 py-2 text-sm rounded-md transition-colors"
                style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                onMouseEnter={(e) => e.target['style'].backgroundColor = 'var(--color-bg-button-secondary-hover)'}
                onMouseLeave={(e) => e.target['style'].backgroundColor = 'var(--color-bg-button-secondary)'}
              >
                OK
              </button>
            </div>
          )}

          {/* OK Button - show when no filters are selected */}
          {!anySelected() && (
            <div class="flex justify-end mt-4">
              <button
                onClick={() => setShowPopup(false)}
                class="px-4 py-2 text-sm rounded-md transition-colors"
                style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                onMouseEnter={(e) => e.target['style'].backgroundColor = 'var(--color-bg-button-secondary-hover)'}
                onMouseLeave={(e) => e.target['style'].backgroundColor = 'var(--color-bg-button-secondary)'}
              >
                OK
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
