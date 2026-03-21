import { createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";

import Loading from "../../utilities/Loading";
import Overlay from "../Overlay";
import TimeSeriesControls from "./TimeSeriesControls";
import TimeSeriesVisualization from "./TimeSeriesVisualization";

import { unifiedDataStore } from "../../../store/unifiedDataStore";
import { tooltip, setTooltip } from "../../../store/globalStore";
import { log } from "../../../utils/console";
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
  cutEvents,
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
  legOptions,
  setLegOptions,
  gradeOptions,
  setGradeOptions
} from "../../../store/filterStore";
import { showPlayback, selectedTime, setSelectedTime, isPlaying, playbackSpeed, syncSelectedTimeManual, startPeriodicSync, requestTimeControl } from "../../../store/playbackStore";
import { logPageLoad } from "../../../utils/logging";

interface TimeSeriesContainerProps {
  objectName?: string;
  [key: string]: any;
}

export default function TimeSeriesContainer(props: TimeSeriesContainerProps) {
  let chartContainer: HTMLElement | null = null;
  
  // Get object name from props or use default
  const objectName = props?.objectName || 'timeseries_default';

  // Move AbortController inside component scope with better lifecycle management
  let abortController = new AbortController();
  let isInitializing = false;

  // Local loading state for this component
  const [isLoading, setIsLoading] = createSignal(true);

  const [xRange, setRange] = createStore({ min: 0, max: 100 });
  const [chartTypes, setChartTypes] = createSignal(["SPEED", "WIND", "VMG"]);
  const [chartType, setChartType] = createSignal("SPEED");

  const [values, setValues] = createSignal([]);
  const [samplingFrequency, setSamplingFrequency] = createSignal(2); // Default to 2Hz

  const twaFilterOptions = [
    "Upwind",
    "Downwind", 
    "Reaching",
    "Port",
    "Stbd"
  ];

  // Helper function to create new abort controller - only reset if not initializing
  const resetAbortController = () => {
    if (!isInitializing) {
      abortController.abort();
      abortController = new AbortController();
    }
  };

  // Initialize time - only set if truly uninitialized
  const initTime = () => {
    // Force sync before checking time to ensure we have the latest value
    syncSelectedTimeManual();
    
    const currentTime = selectedTime();
    const defaultTime = new Date('1970-01-01T12:00:00Z');
    
    // Only initialize if time is exactly the default value (truly uninitialized)
    // Don't reset time that has been set by other components
    const isUninitialized = currentTime && currentTime.getTime() === defaultTime.getTime();
    
    if (isUninitialized && values().length > 0 && !isPlaying()) {
      const initialTime = new Date(values()[0].Datetime);
      log('🕐 TimeSeriesContainer: Initializing time from default to first data point', initialTime.toISOString());
      if (requestTimeControl('timeseries')) {
        setSelectedTime(initialTime, 'timeseries');
      }
    } else if (isUninitialized && unifiedDataStore.data_map().length > 0 && !isPlaying()) {
      const sortedMapData = [...unifiedDataStore.data_map()].sort((a, b) => new Date(a.Datetime) - new Date(b.Datetime));
      const initialTime = new Date(sortedMapData[0].Datetime);
      log('🕐 TimeSeriesContainer: Initializing time from default to first map data point', initialTime.toISOString());
      if (requestTimeControl('timeseries')) {
        setSelectedTime(initialTime, 'timeseries');
      }
    } else if (!isUninitialized) {
      log('🕐 TimeSeriesContainer: Time already initialized, not overriding', currentTime.toISOString());
    }
  };

  // Handle chart type changes
  const handleChartType = (val) => {
    setChartType(val);
    setTriggerUpdate(true);
  };

  // Toggle functions for race and leg filters
  const toggleRaceFilter = (race) => {
    const currentRaces = selectedRacesTimeseries();
    let newRaces;
    
    if (currentRaces.includes(race)) {
      newRaces = currentRaces.filter(r => r !== race);
    } else {
      newRaces = [...currentRaces, race];
    }
    
    setSelectedRacesTimeseries(newRaces);
  };

  const toggleLegFilter = (leg) => {
    const currentLegs = selectedLegsTimeseries();
    let newLegs;
    
    if (currentLegs.includes(leg)) {
      newLegs = currentLegs.filter(l => l !== leg);
    } else {
      newLegs = [...currentLegs, leg];
    }
    
    setSelectedLegsTimeseries(newLegs);
  };

  const toggleGradeFilter = (grade) => {
    const currentGrades = selectedGradesTimeseries();
    let newGrades;
    
    if (currentGrades.includes(grade)) {
      newGrades = currentGrades.filter(g => g !== grade);
    } else {
      newGrades = [...currentGrades, grade];
    }
    
    setSelectedGradesTimeseries(newGrades);
  };

  // Clean up the timeout and abort pending requests when the component is unmounted
  onCleanup(() => {
    isInitializing = false;
    abortController.abort();
  });

  onMount(async () => {
    await logPageLoad('TimeSeriesContainer.jsx', 'Time Series Report');

    isInitializing = true;
    setIsLoading(true);
    
    // Start periodic sync for this component
    startPeriodicSync();
    
    const mountProcess = async () => {
      // Initialize time
      initTime();
      
      isInitializing = false;
      setIsLoading(false);
    };
    
    mountProcess();
  });

  return (
    <>
      {(() => {
        return isLoading() && <Loading />;
      })()}
      <div
        class="timeseries-container"
        style={{
          opacity: isLoading() ? 0.5 : 1,
          "pointer-events": isLoading() ? "none" : "auto",
          transition: "opacity 0.3s ease",
        }}
      >
        <Show when={!hasSelection()}>
          <TimeSeriesControls
            chartTypes={chartTypes()}
            chartType={chartType()}
            onChartType={handleChartType}
            twaFilterOptions={twaFilterOptions}
            selectedStates={selectedStatesTimeseries()}
            raceOptions={raceOptions()}
            legOptions={legOptions()}
            gradeOptions={gradeOptions()}
            selectedRaces={selectedRacesTimeseries()}
            selectedLegs={selectedLegsTimeseries()}
            selectedGrades={selectedGradesTimeseries()}
            onToggleFilter={(groupIndex, chartIndex, filter) => {
              const currentFilters = selectedStatesTimeseries();
              let newFilters;
              
              if (currentFilters.includes(filter)) {
                newFilters = currentFilters.filter(f => f !== filter);
              } else {
                newFilters = [...currentFilters, filter];
              }
              
              setSelectedStatesTimeseries(newFilters);
            }}
            onToggleRaceFilter={toggleRaceFilter}
            onToggleLegFilter={toggleLegFilter}
            onToggleGradeFilter={toggleGradeFilter}
          />
        </Show>
        <Overlay />
        <TimeSeriesVisualization
          ref={(el) => (chartContainer = el)}
          values={values()}
          chartType={chartType()}
          onValuesChange={setValues}
          onSamplingFrequencyChange={setSamplingFrequency}
        />
        <div
          id="tt"
          class="tooltip"
          style={{
            opacity: tooltip().visible ? 1 : 0,
            left: `${tooltip().x}px`,
            top: `${tooltip().y}px`,
          }}
          innerHTML={tooltip().content}
        ></div>
      </div>
    </>
  );
}
