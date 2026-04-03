import { createSignal, Show, createEffect, onMount, batch } from "solid-js";
import { useNavigate } from "@solidjs/router";
import PolarRoseChart from "../../../../components/charts/PolarRose";
import Loading from "../../../../components/utilities/Loading";
import DataNotFoundMessage from "../../../../components/utilities/DataNotFoundMessage";
import PageSettings from "../../../../components/menus/PageSettings";
import { persistantStore } from "../../../../store/persistantStore";
import { user } from "../../../../store/userStore";
import { sidebarMenuRefreshTrigger } from "../../../../store/globalStore";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { applyCommonFilters } from "../../../../utils/commonFiltering";
import { applyDataFilter } from "../../../../utils/dataFiltering";
import { apiEndpoints } from "@config/env";
import UnifiedFilterService from "../../../../services/unifiedFilterService";
import { getData, postBinary } from "../../../../utils/global";
import { error as logError, log } from "../../../../utils/console";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
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
} from "../../../../store/filterStore";
import { 
  selectedRange, 
  selectedRanges,
  cutEvents, 
  hasSelection, 
  isCut
} from "../../../../store/selectionStore";

const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId, selectedSourceName, setSelectedPage, colorType, setColorType } = persistantStore;

export default function Rose(props) {
  // Only use navigate if we're not in split view
  let navigate;
  try {
    navigate = useNavigate();
  } catch (error) {
    // If useNavigate fails (e.g., in split view), set navigate to null
    navigate = null;
  }
  const [hasData, setHasData] = createSignal(false);
  const [windData, setWindData] = createSignal([]);
  const [rawWindData, setRawWindData] = createSignal([]); // Store unfiltered data for reactivity
  const [isLoading, setIsLoading] = createSignal(false);
  const [chartConfig, setChartConfig] = createSignal(null);
  const [hasChartConfig, setHasChartConfig] = createSignal(false);
  const colortypes = ["DEFAULT", "TACK", "UW/DW"]; // retained for future use, but hidden in settings
  const twaFilterOptions = ["Upwind", "Downwind", "Reaching", "Port", "Stbd"]; 
  
  // Get object name from props or use default
  const objectName = props?.objectName || 'default';
  
  // Set the selected page when component loads
  if (objectName && objectName !== 'default') {
setSelectedPage(objectName);
  }

  // Chart-specific filter logic
  const hasChartSpecificFilters = (chartConfig) => {
    return chartConfig?.filters && chartConfig.filters.length > 0;
  };

  const applyAppropriateFilters = (data, chartConfig) => {
    if (hasChartSpecificFilters(chartConfig)) {
      // Use chart-specific filters only (ignore global filters)
      return applyCommonFilters(data, {
        selectedStates: chartConfig.filters,
        selectedRaces: [],
        selectedLegs: [],
        selectedGrades: []
      });
    } else {
      // Use global filtering system
      return applyDataFilter(data);
    }
  };

  // Optimized fetch function using class-based data store
  const fetchChartAndData = async () => {
    setIsLoading(true);
    try {
      // 1. Fetch chart configuration
      const response = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=polarrose&object_name=${objectName}&page_name=rose`);
      
      if (!response.success || !response.data || !response.data.chart_info || response.data.chart_info.length === 0) {
        setChartConfig(null);
        setHasChartConfig(false);
        setHasData(false);
        return;
      }

      const chartData = response.data.chart_info[0];
      setChartConfig(chartData);
      setHasChartConfig(true);

      // 2. Get field names from configuration (use original case)
      const xAxisName = chartData.series[0].xaxis?.name;
      const yAxisName = chartData.series[0].yaxis?.name;
      
      if (!xAxisName || !yAxisName) {
        setHasData(false);
        return;
      }

      // Get dataset date so file server channel discovery uses the correct parquet path (not today's date)
      let formattedDate: string | undefined;
      try {
        const datasetInfoResponse = await getData(`${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`);
        if (datasetInfoResponse.success && datasetInfoResponse.data?.date) {
          formattedDate = String(datasetInfoResponse.data.date).replace(/-/g, '');
        }
      } catch (_) {
        // Store will resolve date from dataset info if omitted
      }

      // 3. Use unifiedDataStore with explicit timeseries dataSource
      const filterChannels = await UnifiedFilterService.getRequiredFilterChannels(selectedClassName(), 'dataset');
      const standardChannels = ['Datetime', ...filterChannels];
      // Always include Twa for filtering (PORT/STBD/UW/DW/RCH)
      // Use exact default channel name (API requires exact match)
      const twaChannelName = defaultChannelsStore.twaName();
      if (!standardChannels.includes(twaChannelName)) {
        standardChannels.push(twaChannelName);
      }
      const chartChannels = [xAxisName, yAxisName];
      const allRelevantChannels = [...standardChannels, ...chartChannels];
      
      // Decide whether to apply global filters at the data layer.
      // If this chart declares its own filters, disable global filtering here
      // so component-level filters can take precedence for this chart.
      const applyGlobal = !hasChartSpecificFilters(chartData);
      let data = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
        'polarrose',
        selectedClassName(),
        selectedSourceId().toString(),
        allRelevantChannels,
        {
          projectId: selectedProjectId(),
          className: selectedClassName(),
          datasetId: selectedDatasetId(),
          sourceName: selectedSourceName(),
          date: formattedDate, // Use dataset date so FILE channel discovery finds parquet columns
          use_v2: true, // Obsolete - kept for backward compatibility (DuckDB is now the only implementation)
          applyGlobalFilters: applyGlobal
        },
        'timeseries' // Explicitly define data source
      );

      if (!data || data.length === 0) {
        // 4. Fetch data from API and migrate to optimal store
        const datasetInfoResponse = await getData(`${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`);
        
        if (!datasetInfoResponse.success) {
          throw new Error("Failed to fetch dataset metadata.");
        }
        
        const { date: rawDate, source_name } = datasetInfoResponse.data;
        const formattedDate = rawDate.replace(/-/g, "");

        // Always include default filtering channels plus chart-specific channels
        // Use default channel name for Twa (required for filtering by PORT/STBD/UW/DW/RCH)
        const twaChannelName = defaultChannelsStore.twaName();
        const channels = [
          { name: 'Datetime', type: 'datetime' },
          { name: twaChannelName, type: 'float' },
          { name: 'Race_number', type: 'int' },
          { name: 'Leg_number', type: 'int' },
          { name: 'Grade', type: 'int' }
        ];
        
        // Add chart-specific channels if they're not already included
        if (xAxisName && !channels.some(ch => ch.name === xAxisName)) {
          channels.push({ name: xAxisName, type: 'float' });
        }
        if (yAxisName && !channels.some(ch => ch.name === yAxisName)) {
          channels.push({ name: yAxisName, type: 'float' });
        }

        const payload = {
          project_id: selectedProjectId(),
          class_name: selectedClassName(),
          date: formattedDate,
          source_name: source_name,
          channel_list: channels,
          start_ts: null,
          end_ts: null
        };
        
        const apiResponse = await postBinary(apiEndpoints.file.channelValues, payload);

        if (!apiResponse.success) {
          throw new Error(`HTTP error! Status: ${apiResponse.message}`);
        }

        const rawData = apiResponse.data;
        
        if (rawData.length === 0) {
          setHasData(false);
          return;
        }

        // Process datetime (preserve original field names)
        const processedData = rawData.map(value => {
          return {
            ...value,
            Datetime: new Date(value.Datetime)
          };
        });
        
        // Use processed data directly (skip migration for now)
        data = processedData;
      }

      // 5. Filter valid data
      
      const filteredData = data.filter(row => {
        const xValid = row[xAxisName] !== undefined && 
                      row[xAxisName] !== null && 
                      !Number.isNaN(row[xAxisName]);
        const yValid = row[yAxisName] !== undefined && 
                      row[yAxisName] !== null && 
                      !Number.isNaN(row[yAxisName]);
        
        return xValid && yValid;
      });

      // 6. Store raw data and apply appropriate filters (chart-specific or global)
      setRawWindData(filteredData); // Store unfiltered data for reactivity
      const finalData = applyAppropriateFilters(filteredData, chartData);

      setWindData(finalData);
      setHasData(true);

    } catch (error) {
      logError('Error fetching chart and data:', error);
      setHasData(false);
    } finally {
      setIsLoading(false);
    }
  };

  onMount(async () => {
    await fetchChartAndData();
  });

  // Re-fetch chart config when returning from builder (sidebar refresh trigger) so new/updated chart shows immediately
  createEffect(() => {
    const _trigger = sidebarMenuRefreshTrigger();
    if (_trigger) {
      fetchChartAndData();
    }
  });

  // React to selection and filter changes and re-filter data
  createEffect(() => {
    // Track selection signals for reactivity
    const range = selectedRange();
    const ranges = selectedRanges();
    const cuts = cutEvents();
    const hasSel = hasSelection();
    const isCutVal = isCut();
    
    // Track filter signals for reactivity
    const states = selectedStatesTimeseries();
    const races = selectedRacesTimeseries();
    const legs = selectedLegsTimeseries();
    const grades = selectedGradesTimeseries();
    
    try {
      log('Rose: Filter/Selection effect triggered', { 
        rangeLen: range?.length || 0, 
        rangesLen: ranges?.length || 0, 
        cutsLen: cuts?.length || 0,
        hasSel,
        isCutVal,
        states: states?.length || 0,
        races: races?.length || 0,
        legs: legs?.length || 0,
        grades: grades?.length || 0
      });
    } catch {}
    
    const rawData = rawWindData();
    const config = chartConfig();
    
    if (rawData && rawData.length > 0 && config) {
      log('Rose: Filters/Selection changed, re-filtering data');
      const filteredData = applyAppropriateFilters(rawData, config);
      setWindData(filteredData);
    }
  });

  return (
    <div class="grid-container">
      <Show when={hasChartConfig()}>
        <PageSettings
          useIconTrigger={true}
          options={twaFilterOptions}
          hideColorOptions={true}
          selectedStates={selectedStatesTimeseries()}
          setSelectedStates={setSelectedStatesTimeseries}
          raceOptions={raceOptions()}
          setRaceOptions={setRaceOptions}
          legOptions={legOptions()}
          setLegOptions={setLegOptions}
          gradeOptions={gradeOptions()}
          setGradeOptions={setGradeOptions}
          selectedRaces={selectedRacesTimeseries()}
          selectedLegs={selectedLegsTimeseries()}
          selectedGrades={selectedGradesTimeseries()}
          toggleFilter={(groupIndex, chartIndex, filter) => {
            const currentFilters = selectedStatesTimeseries();
            let newFilters;
            if (currentFilters.includes(filter)) {
              newFilters = currentFilters.filter(f => f !== filter);
            } else {
              newFilters = [...currentFilters, filter];
            }
            batch(() => {
              setSelectedStatesTimeseries(newFilters);
            });
          }}
          toggleRaceFilter={(race) => {
            const currentRaces = selectedRacesTimeseries();
            let newRaces;
            if (currentRaces.includes(race)) {
              newRaces = currentRaces.filter(r => r !== race);
            } else {
              newRaces = [...currentRaces, race];
            }
            batch(() => {
              setSelectedRacesTimeseries(newRaces);
            });
          }}
          toggleLegFilter={(leg) => {
            const currentLegs = selectedLegsTimeseries();
            let newLegs;
            if (currentLegs.includes(leg)) {
              newLegs = currentLegs.filter(l => l !== leg);
            } else {
              newLegs = [...currentLegs, leg];
            }
            batch(() => {
              setSelectedLegsTimeseries(newLegs);
            });
          }}
          toggleGradeFilter={(grade) => {
            const currentGrades = selectedGradesTimeseries();
            let newGrades;
            if (currentGrades.includes(grade)) {
              newGrades = currentGrades.filter(g => g !== grade);
            } else {
              newGrades = [...currentGrades, grade];
            }
            batch(() => {
              setSelectedGradesTimeseries(newGrades);
            });
          }}
          filterConfig={{
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
          }}
          builderRoute={'/polar-rose-builder'}
        />
      </Show>
      <Show 
        when={isLoading()}
        fallback={
          <Show 
            when={hasChartConfig()}
            fallback={
              <div class="flex flex-col items-center justify-center h-screen min-h-[500px] text-center p-8">
                <div class="mb-6">
                  <svg class="w-16 h-16 mx-auto text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                  </svg>
                  <h3 class="text-xl font-semibold text-gray-700 mb-2">No Charts Available</h3>
                  <p class="text-gray-500 mb-6">Would you like to add one?</p>
                </div>
                <button 
                  onClick={() => {
                    if (navigate) {
                      navigate(`/polar-rose-builder?object_name=${objectName}`);
                    } else {
                      log('Rose: Cannot navigate to polar-rose-builder in split view');
                    }
                  }}
                  class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg shadow-md hover:shadow-lg"
                >
                  Add Chart
                </button>
              </div>
            }
          >
            <Show 
              when={hasData()}
              fallback={
                <DataNotFoundMessage
                  builderRoute="/polar-rose-builder"
                  onNavigateToBuilder={() => {
                    if (navigate) navigate(`/polar-rose-builder?object_name=${objectName}`);
                    else log('Rose: Cannot navigate to polar-rose-builder in split view');
                  }}
                />
              }
            >
              <div style={{ "margin-top": "-100px" }}>
                <PolarRoseChart data={windData()} objectName={objectName} colortype={colorType && typeof colorType === 'function' ? colorType() : 'DEFAULT'} />
              </div>
            </Show>
          </Show>
        }
      >
        <Loading />
      </Show>
    </div>
  );
}
