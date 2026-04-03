import { createSignal, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { unifiedDataStore } from "../../store/unifiedDataStore";
import { persistantStore } from "../../store/persistantStore";
import { user } from "../../store/userStore";
import { triggerUpdate as selectionTriggerUpdate } from "../../store/selectionStore";
import { applyDataFilter } from "../../utils/dataFiltering";
import { getData } from "../../utils/global";
import { apiEndpoints } from "@config/env";
import Loading from "../utilities/Loading";
import DataNotFoundMessage from "../utilities/DataNotFoundMessage";
import { error as logError, info as logInfo, warn as logWarn } from "../../utils/console";
import * as d3 from "d3";
import { defaultChannelsStore } from "../../store/defaultChannelsStore";
import UnifiedFilterService from "../../services/unifiedFilterService";

// Static import for worker - Vite will bundle this correctly in production
import GridWorker from "../../workers/grid-processor.ts?worker";

interface GridProps {
    objectName?: string;
}

interface AxisRange {
    min: number;
    max: number;
}

export default function Grid(props: GridProps) {
    const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId, selectedSourceName } = persistantStore;
    let navigate: (path: string) => void;
    try {
        navigate = useNavigate();
    } catch {
        navigate = () => { logInfo('Grid: Cannot navigate in split view'); };
    }

    // Chart configuration state
    const [chartConfig, setChartConfig] = createSignal<any>(null);
    const [hasChartConfig, setHasChartConfig] = createSignal(false);
    const [isLoading, setIsLoading] = createSignal(true);
    const [hasData, setHasData] = createSignal(false);

    // Grid data state
    const [gridData, setGridData] = createSignal<any[]>([]);
    const [xAxisRange, setXAxisRange] = createSignal<AxisRange>({ min: 0, max: 100 });
    const [yAxisRange, setYAxisRange] = createSignal<AxisRange>({ min: 0, max: 100 });
    const [xAxisBins, setXAxisBins] = createSignal(10);
    const [yAxisBins, setYAxisBins] = createSignal(10);
    /** Effective step used by worker (may be larger than config interval to cap at 10 bins). */
    const [effectiveXStep, setEffectiveXStep] = createSignal<number | null>(null);
    const [effectiveYStep, setEffectiveYStep] = createSignal<number | null>(null);

    // Progress tracking for worker processing
    const [isProcessing, setIsProcessing] = createSignal(false);
    const [processingProgress, setProcessingProgress] = createSignal(0);
    const [processingStatus, setProcessingStatus] = createSignal("");
    const [processingStartTime, setProcessingStartTime] = createSignal(0);
    // Cache of unfiltered flat data for fast reprocessing on selection changes
    const [rawDataCache, setRawDataCache] = createSignal<any[]>([]);
    let loadingSafetyTimeoutId: ReturnType<typeof setTimeout> | null = null;

    // Web worker for data processing
    let gridWorker: Worker | null = null;

    // Get object name from URL parameters, props, or persistent store
    const getObjectName = () => {
        const urlParams = new URLSearchParams(window.location.search);
        const urlObjectName = urlParams.get('object_name');

        if (urlObjectName) {
            return urlObjectName;
        }

        if (props?.objectName) {
            return props.objectName;
        }

        return 'default';
    };

    const objectName = getObjectName();

    // Fetch chart configuration
    const fetchChartConfig = async () => {
        try {
            const userId = user()?.user_id;
            if (!userId) {
                logWarn('Grid: No user ID available, cannot fetch chart configuration');
                setHasChartConfig(false);
                return;
            }

            const response = await getData(
                `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(userId)}&parent_name=grid&object_name=${objectName}`
            );

            if (response.success && response.data && response.data.chart_info && response.data.chart_info.length > 0) {
                const chartData = response.data.chart_info[0];
                setChartConfig(chartData);
                setHasChartConfig(true);

                // Extract grid settings
                if (chartData.series && chartData.series[0]) {
                    setXAxisBins(chartData.series[0].xaxis?.interval || 10);
                    setYAxisBins(chartData.series[0].yaxis?.interval || 10);
                }
            } else {
                setHasChartConfig(false);
            }
        } catch (error: any) {
            logError('Error fetching chart configuration:', error);
            setHasChartConfig(false);
        }
    };

    // Fetch and process data
    const fetchAndProcessData = async (options: { showLoader?: boolean } = { showLoader: true }) => {
        if (!hasChartConfig()) return;

        try {
            if (options.showLoader) setIsLoading(true);
            if (options.showLoader) {
                if (loadingSafetyTimeoutId) clearTimeout(loadingSafetyTimeoutId);
                loadingSafetyTimeoutId = setTimeout(() => {
                    if (isLoading()) {
                        try { logWarn('Grid: Loading timeout reached, forcing loader off'); } catch { }
                        setIsLoading(false);
                    }
                }, 15000);
            }

            // Use unifiedDataStore to get data (it handles fetching if necessary)
            const requiredChannelsSet = new Set([
                chartConfig().series[0].xaxis.name,
                chartConfig().series[0].yaxis.name,
                'Datetime'
            ]);

            // Add Z-axis channel if it exists
            const zAxisChannel = chartConfig().zaxis?.name;
            if (zAxisChannel) {
                requiredChannelsSet.add(zAxisChannel);
            }

            // Get filter channels from UnifiedFilterService (includes Race_number, Leg_number, Grade, State)
            const filterChannels = await UnifiedFilterService.getRequiredFilterChannels(selectedClassName(), 'dataset');
            filterChannels.forEach(channel => requiredChannelsSet.add(channel));

            // Always include Twa for filtering (PORT/STBD/UW/DW/RCH)
            // Use exact default channel name (API requires exact match)
            const twaChannelName = defaultChannelsStore.twaName();
            requiredChannelsSet.add(twaChannelName);

            const requiredChannels = Array.from(requiredChannelsSet);

            // Get dataset date for proper API calls
            const datasetInfoResponse = await getData(
                `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`
            );

            if (!datasetInfoResponse.success) {
                throw new Error("Failed to fetch dataset metadata.");
            }

            const { date: rawDate } = datasetInfoResponse.data;
            const formattedDate = rawDate.replace(/-/g, "");

            // Get data from unified data store using fetchDataWithChannelCheckingFromFile
            // This checks file server channels (matching FileChannelPicker) before fetching data
            let data = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
                'ts',
                selectedClassName(),
                selectedSourceId().toString(),
                requiredChannels,
                {
                    projectId: selectedProjectId().toString(),
                    className: selectedClassName(),
                    datasetId: selectedDatasetId().toString(),
                    sourceName: selectedSourceName(),
                    date: formattedDate,
                    applyGlobalFilters: !(chartConfig()?.filters && chartConfig().filters.length > 0)
                },
                'timeseries'
            );

            // Process data based on source (unified store vs API)
            const xAxisName = chartConfig().series[0].xaxis.name;
            const yAxisName = chartConfig().series[0].yaxis.name;

            // Check if we got the required channels - if not, force a fresh fetch
            let hasAllRequiredChannels = false;
            if (data && data.length > 0) {
                if (data[0].channel) {
                    // Channel-based format - check if we have all required channels
                    const receivedChannels = new Set<string>(data.map((item: any) => item.channel).filter(Boolean));
                    const hasXAxis = Array.from(receivedChannels).some(ch => ch.toLowerCase() === xAxisName.toLowerCase());
                    const hasYAxis = Array.from(receivedChannels).some(ch => ch.toLowerCase() === yAxisName.toLowerCase());
                    const hasZAxis = !zAxisChannel || Array.from(receivedChannels).some(ch => ch.toLowerCase() === zAxisChannel.toLowerCase());
                    hasAllRequiredChannels = hasXAxis && hasYAxis && hasZAxis;
                } else {
                    // Flat format - check if required fields exist
                    const sampleItem = data[0];
                    const hasXAxis = xAxisName in sampleItem && sampleItem[xAxisName] !== undefined;
                    const hasYAxis = yAxisName in sampleItem && sampleItem[yAxisName] !== undefined;
                    const hasZAxis = !zAxisChannel || (zAxisChannel in sampleItem && sampleItem[zAxisChannel] !== undefined);
                    hasAllRequiredChannels = hasXAxis && hasYAxis && hasZAxis;
                }
            }

            // If we don't have all required channels, force a fresh API fetch by clearing cache
            if (!hasAllRequiredChannels && data && data.length > 0) {
                try {
                    const missingChannelsList: string[] = [];
                    if (data[0].channel) {
                        // Channel-based format
                        const receivedChannels = new Set<string>(data.map((item: any) => item.channel).filter(Boolean));
                        const receivedChannelsLower = new Set(Array.from(receivedChannels).map(ch => ch.toLowerCase()));
                        if (!receivedChannelsLower.has(xAxisName.toLowerCase())) missingChannelsList.push(xAxisName);
                        if (!receivedChannelsLower.has(yAxisName.toLowerCase())) missingChannelsList.push(yAxisName);
                        if (zAxisChannel && !receivedChannelsLower.has(zAxisChannel.toLowerCase())) missingChannelsList.push(zAxisChannel);
                    } else {
                        // Flat format
                        const sampleItem = data[0];
                        if (!(xAxisName in sampleItem && sampleItem[xAxisName] !== undefined)) missingChannelsList.push(xAxisName);
                        if (!(yAxisName in sampleItem && sampleItem[yAxisName] !== undefined)) missingChannelsList.push(yAxisName);
                        if (zAxisChannel && !(zAxisChannel in sampleItem && sampleItem[zAxisChannel] !== undefined)) missingChannelsList.push(zAxisChannel);
                    }

                    logInfo('Grid: Missing required channels detected, forcing fresh API fetch', {
                        missingChannels: missingChannelsList,
                        requiredChannels: requiredChannels,
                        xAxisName,
                        yAxisName,
                        zAxisChannel: zAxisChannel || 'none'
                    });

                    // Clear the specific data source cache (this now also clears channelAvailability)
                    // This ensures we don't wait 5 minutes for channels that should be available
                    const dataKey = `timeseries_${selectedDatasetId()}_${selectedProjectId()}_${selectedSourceId()}`;
                    unifiedDataStore.clearCacheForDataSource(dataKey);

                    // Retry fetch - this should now fetch from API without any cache blocking it
                    data = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
                        'ts',
                        selectedClassName(),
                        selectedSourceId().toString(),
                        requiredChannels,
                        {
                            projectId: selectedProjectId().toString(),
                            className: selectedClassName(),
                            datasetId: selectedDatasetId().toString(),
                            sourceName: selectedSourceName(),
                            date: formattedDate,
                            applyGlobalFilters: !(chartConfig()?.filters && chartConfig().filters.length > 0)
                        },
                        'timeseries'
                    );
                } catch (retryError) {
                    logError('Grid: Error during forced API fetch retry:', retryError);
                }
            }

            // If data is still empty after fetchDataWithChannelChecking, it means:
            // 1. API was called but returned no data, OR
            // 2. Data exists but doesn't match filters, OR
            // 3. Channels genuinely don't exist in the dataset
            // In this case, we should still try to process what we have (empty array is valid)
            if (!data || data.length === 0) {
                try {
                    logWarn('Grid: No data available from unifiedDataStore after fetch. This may indicate:', {
                        reason: 'No data in cache or API returned empty',
                        suggestion: 'Check if channels exist in the dataset or if filters are too restrictive'
                    });
                } catch { }
                // Don't return early - let the processing continue with empty data
                // This ensures the component shows "No Data" message properly
                data = [];
            }

            // Check if data is from unified store (channel-based) or API (flat format)
            let processedData;
            let flatUnfilteredData;
            if (data.length > 0 && data[0].channel) {
                // Unified data store format - convert channel-based data to flat format
                const dataByDatetime = new Map();

                // Track which channels we actually received
                const receivedChannels = new Set<string>();

                data.forEach(item => {
                    if (item.channel) {
                        receivedChannels.add(item.channel);
                    }
                    if (item.data && Array.isArray(item.data)) {
                        item.data.forEach((dataPoint: any) => {
                            const datetime = dataPoint.Datetime;
                            if (!dataByDatetime.has(datetime)) {
                                dataByDatetime.set(datetime, { Datetime: datetime });
                            }

                            // Use case-insensitive matching for channel names (per repo rules: data fields are lowercase)
                            const channelLower = item.channel?.toLowerCase();
                            if (channelLower === xAxisName.toLowerCase()) {
                                dataByDatetime.get(datetime)![xAxisName] = dataPoint.value;
                            } else if (channelLower === yAxisName.toLowerCase()) {
                                dataByDatetime.get(datetime)![yAxisName] = dataPoint.value;
                            } else if (zAxisChannel && channelLower === zAxisChannel.toLowerCase()) {
                                dataByDatetime.get(datetime)![zAxisChannel] = dataPoint.value;
                            }
                        });
                    }
                });

                // Check if we have all required channels (case-insensitive matching)
                const receivedChannelsLower = new Set(Array.from(receivedChannels).map(ch => ch.toLowerCase()));
                const hasXAxis = receivedChannelsLower.has(xAxisName.toLowerCase());
                const hasYAxis = receivedChannelsLower.has(yAxisName.toLowerCase());
                const hasZAxis = !zAxisChannel || receivedChannelsLower.has(zAxisChannel.toLowerCase());

                if (!hasXAxis || !hasYAxis || !hasZAxis) {
                    const missingChannels: string[] = [];
                    if (!hasXAxis) missingChannels.push(xAxisName);
                    if (!hasYAxis) missingChannels.push(yAxisName);
                    if (!hasZAxis && zAxisChannel) missingChannels.push(zAxisChannel);

                    logWarn('Grid: Partial channel availability detected - some required channels are missing from cache', {
                        receivedChannels: Array.from(receivedChannels),
                        missingChannels: missingChannels,
                        requiredChannels: requiredChannels,
                        issue: 'One or more required channels are not in cache. This may indicate the channel was previously marked as missing and won\'t retry for 5 minutes. Consider clearing cache or waiting for cache TTL to expire.',
                        suggestion: 'The missing channels may be available in the API but were previously marked as missing. The system will retry after 5 minutes.'
                    });
                }

                // Convert to array and filter out incomplete data points
                const allDataPoints = Array.from(dataByDatetime.values());
                flatUnfilteredData = allDataPoints;
                processedData = allDataPoints.filter(item =>
                    item[xAxisName] !== undefined &&
                    item[yAxisName] !== undefined &&
                    !Number.isNaN(item[xAxisName]) &&
                    !Number.isNaN(item[yAxisName])
                );
            } else {
                // API format - data is already in flat format
                // Check if we have all required channels in the data
                if (data.length > 0) {
                    const sampleItem = data[0];
                    const hasXAxis = xAxisName in sampleItem && sampleItem[xAxisName] !== undefined;
                    const hasYAxis = yAxisName in sampleItem && sampleItem[yAxisName] !== undefined;
                    const hasZAxis = !zAxisChannel || (zAxisChannel in sampleItem && sampleItem[zAxisChannel] !== undefined);

                    if (!hasXAxis || !hasYAxis || !hasZAxis) {
                        const missingChannels: string[] = [];
                        if (!hasXAxis) missingChannels.push(xAxisName);
                        if (!hasYAxis) missingChannels.push(yAxisName);
                        if (!hasZAxis && zAxisChannel) missingChannels.push(zAxisChannel);

                        // Only log as warning if we have data but missing channels (real issue)
                        // If data is empty, this is expected and will be handled below
                        if (data.length > 0) {
                            logWarn('Grid: Partial channel availability detected in flat data format', {
                                missingChannels: missingChannels,
                                requiredChannels: requiredChannels,
                                sampleKeys: Object.keys(sampleItem).slice(0, 10),
                                issue: 'One or more required channels are missing from the returned data. This may indicate partial cache or API response.',
                                suggestion: 'The missing channels may be available in the API but were previously marked as missing. The system will retry after 5 minutes.'
                            });
                        }
                    }
                }

                flatUnfilteredData = data;
                processedData = data.filter(item =>
                    item[xAxisName] !== undefined &&
                    item[yAxisName] !== undefined &&
                    !Number.isNaN(item[xAxisName]) &&
                    !Number.isNaN(item[yAxisName])
                );
            }

            // Cache the flat unfiltered data for selection-based reprocessing
            setRawDataCache(flatUnfilteredData || []);

            // Apply unified data filtering (includes selection, cut data, and filters)
            processedData = applyDataFilter(processedData);

            if (processedData.length === 0) {
                // This is often expected when filters exclude all data, so use debug instead of warn
                try { logInfo('Grid: No valid data points found after processing (this may be expected if filters exclude all data)'); } catch { }
                setHasData(false);
                return;
            }

            // Process data with web worker (filtering already applied above)
            await processDataWithWorker(processedData);

        } catch (error: any) {
            logError('Error fetching and processing data:', error);
            setHasData(false);
        } finally {
            if (loadingSafetyTimeoutId) {
                clearTimeout(loadingSafetyTimeoutId);
                loadingSafetyTimeoutId = null;
            }
            if (options.showLoader) setIsLoading(false);
        }
    };

    // Fast reprocessing path for selection changes using cached raw data
    const reprocessFromCache = async () => {
        try {
            const cached = rawDataCache();
            if (!cached || cached.length === 0) return;

            const xAxisName = chartConfig()?.series?.[0]?.xaxis?.name;
            const yAxisName = chartConfig()?.series?.[0]?.yaxis?.name;

            if (!xAxisName || !yAxisName) {
                logWarn('Grid: Missing axis names in config, cannot reprocess');
                return;
            }

            // Filter cached flat data by required fields first
            let filtered = cached.filter(item =>
                item[xAxisName] !== undefined &&
                item[yAxisName] !== undefined &&
                !Number.isNaN(item[xAxisName]) &&
                !Number.isNaN(item[yAxisName])
            );

            // Apply unified filters including selection
            filtered = applyDataFilter(filtered);

            if (filtered.length === 0) {
                setHasData(false);
                return;
            }

            await processDataWithWorker(filtered);
        } catch (error: any) {
            logError('Grid: Error reprocessing from cache', error);
        }
    };

    // Process data with web worker
    const processDataWithWorker = async (data: any[]) => {
        return new Promise((resolve, reject) => {
            // Initialize progress tracking
            setIsProcessing(true);
            setProcessingProgress(0);
            setProcessingStatus("Initializing grid processing...");
            setProcessingStartTime(Date.now());

            // Create web worker - use ?worker import for production compatibility
            gridWorker = new GridWorker();

            if (!gridWorker) {
                reject(new Error('Failed to create grid worker'));
                return;
            }

            const config = {
                xAxisName: chartConfig().series[0].xaxis.name,
                yAxisName: chartConfig().series[0].yaxis.name,
                xAxisBins: chartConfig().series[0].xaxis?.interval || 2,
                yAxisBins: chartConfig().series[0].yaxis?.interval || 2,
                cellContentType: chartConfig().cellContentType || "count",
                zAxisChannel: chartConfig().zaxis?.name || ""
            };

            // Set up progress tracking interval
            const progressInterval = setInterval(() => {
                const elapsed = Date.now() - processingStartTime();
                const progress = Math.min(95, (elapsed / 1000) * 10); // Estimate progress based on time
                setProcessingProgress(progress);

                if (elapsed < 1000) {
                    setProcessingStatus("Processing data points...");
                } else if (elapsed < 3000) {
                    setProcessingStatus("Calculating grid bins...");
                } else {
                    setProcessingStatus("Finalizing grid data...");
                }
            }, 100);

            // Watchdog to prevent stuck processing
            const watchdogTimeout = setTimeout(() => {
                try { logWarn('Grid worker timeout: terminating and clearing processing state'); } catch { }
                clearInterval(progressInterval);
                if (gridWorker) {
                    try { gridWorker.terminate(); } catch { }
                }
                setIsProcessing(false);
                setProcessingProgress(0);
                setProcessingStatus("Timed out");
                reject(new Error('GRID_WORKER_TIMEOUT'));
            }, 15000);

            gridWorker.postMessage({
                type: 'PROCESS_GRID_DATA',
                data: data,
                config: config
            });

            gridWorker.onmessage = (event) => {
                const { type, result, error, progress, status } = event.data;

                if (type === 'GRID_DATA_PROCESSED') {
                    // Clear progress tracking
                    clearInterval(progressInterval);
                    clearTimeout(watchdogTimeout);
                    setIsProcessing(false);
                    setProcessingProgress(100);
                    setProcessingStatus("Complete!");

                    setGridData(result.gridData);
                    setXAxisRange(result.xAxisRange);
                    setYAxisRange(result.yAxisRange);
                    const xStep = result.xAxisStep ?? chartConfig().series[0].xaxis?.interval ?? 2;
                    const yStep = result.yAxisStep ?? chartConfig().series[0].yaxis?.interval ?? 2;
                    setEffectiveXStep(result.xAxisStep ?? null);
                    setEffectiveYStep(result.yAxisStep ?? null);
                    setXAxisBins(Math.round((result.xAxisRange.max - result.xAxisRange.min) / xStep));
                    setYAxisBins(Math.round((result.yAxisRange.max - result.yAxisRange.min) / yStep));
                    setHasData(true);

                    // Clear progress after a short delay
                    setTimeout(() => {
                        setProcessingProgress(0);
                        setProcessingStatus("");
                    }, 1000);

                    resolve(result);
                } else if (type === 'GRID_PROGRESS_UPDATE') {
                    // Update progress from worker
                    setProcessingProgress(progress);
                    setProcessingStatus(status);
                } else if (type === 'ERROR') {
                    clearInterval(progressInterval);
                    clearTimeout(watchdogTimeout);
                    setIsProcessing(false);
                    setProcessingProgress(0);
                    setProcessingStatus("Error occurred");
                    logError('Grid worker error:', error);
                    reject(new Error(error));
                }
            };

            gridWorker.onerror = (error) => {
                clearInterval(progressInterval);
                clearTimeout(watchdogTimeout);
                setIsProcessing(false);
                setProcessingProgress(0);
                setProcessingStatus("Error occurred");
                logError('Grid worker error:', error);
                reject(error);
            };
        });
    };

    // Get color for cell based on count or normalized value
    const getCellColor = (value: number, maxValue: number, sailConfig: string | null = null): string => {
        if (value === 0) return 'transparent';

        // Handle sail configuration with categorical colors
        if (chartConfig()?.cellContentType === 'sail_config' && sailConfig) {
            return getSailConfigColor(sailConfig);
        }

        const intensity = maxValue > 0 ? value / maxValue : 0;

        switch (chartConfig()?.colorScheme || "warm-to-cold") {
            case 'warm-to-cold':
                return d3.interpolateRdYlBu(1 - intensity);
            case 'viridis':
                return d3.interpolateViridis(intensity);
            case 'plasma':
                return d3.interpolatePlasma(intensity);
            case 'inferno':
                return d3.interpolateInferno(intensity);
            case 'shades-of-red':
                return d3.interpolateReds(intensity);
            case 'shades-of-blue':
                return d3.interpolateBlues(intensity);
            case 'rainbow':
                return d3.interpolateRainbow(1 - intensity); // Inverted: red=high, purple=low
            default:
                return d3.interpolateRdYlBu(1 - intensity);
        }
    };

    // Categorical color scale for sail configurations
    const getSailConfigColor = (sailConfig: string): string => {
        if (!sailConfig) return 'transparent';

        // Get all unique sail configurations from the current grid data
        const allSailConfigs = gridData().map(cell => cell.sailConfig).filter(config => config && config.trim() !== '');
        const uniqueConfigs = [...new Set(allSailConfigs)].sort();

        // Create a categorical color scale
        const colorScale = d3.scaleOrdinal<string, string>()
            .domain(uniqueConfigs)
            .range(d3.schemeCategory10); // D3's built-in categorical color scheme

        return colorScale(sailConfig) || 'transparent';
    };

    // Initialize component
    onMount(async () => {
        await fetchChartConfig();
        if (hasChartConfig()) {
            await fetchAndProcessData();
        }
    });

    // Cleanup web worker
    onCleanup(() => {
        if (gridWorker) {
            gridWorker.terminate();
        }
    });

    // (Reverted) No deferred fetch here; handled in onMount for faster render

    // Effect to handle selection changes - re-process data with current selection
    let hasInitializedSelectionEffect = false;
    createEffect(() => {
        const shouldTrigger = selectionTriggerUpdate();

        if (!hasInitializedSelectionEffect) {
            hasInitializedSelectionEffect = true;
            return;
        }

        if (
            shouldTrigger &&
            hasChartConfig() &&
            !isLoading() &&
            !isProcessing()
        ) {
            try { logInfo('Grid: Selection change detected, re-processing data with selection'); } catch { }
            // Reprocess from cached data to avoid triggering fetch/store updates
            reprocessFromCache();
        }
    });

    return (
        <div class="w-full h-full flex flex-col">
            <Show when={isLoading() || isProcessing()}>
                <Loading
                    message={
                        isProcessing() ? processingStatus() :
                            isLoading() ? "Loading grid data..." :
                                "Loading..."
                    }
                    showProgress={isProcessing()}
                    progress={isProcessing() ? processingProgress() : null}
                    progressMessage={isProcessing() ? processingStatus() : ""}
                    type="spinner"
                />
            </Show>

            <Show when={!isLoading() && !isProcessing() && hasData()}>
                <div class="flex-1 overflow-auto p-4 bg-transparent dark:bg-transparent">
                    <div class="bg-transparent dark:bg-transparent rounded-none shadow-none border-0 p-0">
                        <div class="mb-4">
                            <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
                                {(() => {
                                    const cellContentType = chartConfig()?.cellContentType || "count";
                                    const zAxisName = chartConfig()?.zaxis?.name;

                                    if (cellContentType === "channel_value" && zAxisName) {
                                        return `Grid colored by average channel value - ${zAxisName}`;
                                    } else if (cellContentType === "probability") {
                                        return "Grid colored by probability";
                                    } else if (cellContentType === "min_value" && zAxisName) {
                                        return `Grid colored by minimum channel value - ${zAxisName}`;
                                    } else if (cellContentType === "max_value" && zAxisName) {
                                        return `Grid colored by maximum channel value - ${zAxisName}`;
                                    } else if (cellContentType === "std_value" && zAxisName) {
                                        return `Grid colored by standard deviation - ${zAxisName}`;
                                    } else if (cellContentType === "sail_config") {
                                        return "Grid showing best sail configuration";
                                    } else if (cellContentType === "count") {
                                        return "Grid colored by cell count";
                                    }
                                    return "Grid Visualization";
                                })()}
                            </h3>
                            <p class="text-sm text-gray-600 dark:text-gray-400">
                                {(() => {
                                    const cellContentType = chartConfig()?.cellContentType || "count";
                                    const zAxisName = chartConfig()?.zaxis?.name;
                                    const xAxisName = chartConfig()?.series?.[0]?.xaxis?.name;
                                    const yAxisName = chartConfig()?.series?.[0]?.yaxis?.name;

                                    if (cellContentType === "channel_value" && zAxisName) {
                                        return `${xAxisName} vs ${yAxisName} (showing ${zAxisName} values)`;
                                    } else if (cellContentType === "probability") {
                                        return `${xAxisName} vs ${yAxisName} (showing probability percentages)`;
                                    } else if (cellContentType === "min_value" && zAxisName) {
                                        return `${xAxisName} vs ${yAxisName} (showing minimum ${zAxisName} values)`;
                                    } else if (cellContentType === "max_value" && zAxisName) {
                                        return `${xAxisName} vs ${yAxisName} (showing maximum ${zAxisName} values)`;
                                    } else if (cellContentType === "std_value" && zAxisName) {
                                        return `${xAxisName} vs ${yAxisName} (showing ${zAxisName} standard deviation)`;
                                    } else if (cellContentType === "sail_config") {
                                        return `${xAxisName} vs ${yAxisName} (showing best sail configuration by Vmg_perc)`;
                                    }
                                    return `${xAxisName} vs ${yAxisName}`;
                                })()}
                            </p>
                        </div>

                        {/* Sail Configuration Legend */}
                        <Show when={chartConfig()?.cellContentType === 'sail_config'}>
                            <div class="mt-4 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                                <h4 class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Sail Configuration Legend</h4>
                                <div class="flex flex-wrap gap-2">
                                    {(() => {
                                        const allSailConfigs = gridData().map(cell => cell.sailConfig).filter(config => config && config.trim() !== '');
                                        const uniqueConfigs = [...new Set(allSailConfigs)].sort();

                                        return uniqueConfigs.map(config => (
                                            <div class="flex items-center gap-1">
                                                <div
                                                    class="w-4 h-4 rounded border border-gray-300 dark:border-gray-600"
                                                    style={{ "background-color": getSailConfigColor(config) as string }}
                                                ></div>
                                                <span class="text-xs text-gray-600 dark:text-gray-400">{config}</span>
                                            </div>
                                        ));
                                    })()}
                                </div>
                            </div>
                        </Show>

                        <div class="overflow-auto max-h-96 grid-scroll-container">
                            <table class="w-full border-collapse">
                                <thead>
                                    <tr>
                                        <th class="border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-2 text-xs font-medium text-gray-700 dark:!text-white">
                                            {chartConfig()?.series?.[0]?.yaxis?.name} ↓ / {chartConfig()?.series?.[0]?.xaxis?.name} →
                                        </th>
                                        <For each={Array.from({ length: xAxisBins() }, (_, i) => i)}>
                                            {(xIndex) => {
                                                const xStep = effectiveXStep() ?? chartConfig()?.series?.[0]?.xaxis?.interval ?? 2;
                                                const xValue = xAxisRange().min + (xIndex + 0.5) * xStep;
                                                return (
                                                    <th class="border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-1 text-xs font-medium text-gray-700 dark:!text-white text-center">
                                                        {xValue.toFixed(1)}
                                                    </th>
                                                );
                                            }}
                                        </For>
                                    </tr>
                                </thead>
                                <tbody>
                                    <For each={Array.from({ length: yAxisBins() }, (_, i) => i)}>
                                        {(yIndex) => {
                                            const yStep = effectiveYStep() ?? chartConfig()?.series?.[0]?.yaxis?.interval ?? 2;
                                            const yValue = yAxisRange().min + (yIndex + 0.5) * yStep;
                                            return (
                                                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800">
                                                    <td class="border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-1 text-xs font-medium text-gray-700 dark:!text-white text-right">
                                                        {yValue.toFixed(1)}
                                                    </td>
                                                    <For each={Array.from({ length: xAxisBins() }, (_, i) => i)}>
                                                        {(xIndex) => {
                                                            const cellData = gridData().find(cell =>
                                                                cell.xIndex === xIndex && cell.yIndex === yIndex
                                                            );
                                                            const count = cellData?.count || 0;
                                                            const averageValue = cellData?.averageValue;
                                                            const probability = cellData?.probability;
                                                            const minValue = cellData?.minValue;
                                                            const maxValue = cellData?.maxValue;
                                                            const stdValue = cellData?.stdValue;
                                                            const sailConfig = cellData?.sailConfig;
                                                            const cellContentType = chartConfig()?.cellContentType || "count";

                                                            // Calculate color based on cell content type
                                                            let color;
                                                            if (cellContentType === "channel_value" && averageValue !== undefined && averageValue !== null) {
                                                                // Color based on average value
                                                                const allAverageValues = gridData().map(cell => cell.averageValue).filter(val => val !== undefined && val !== null);
                                                                const maxValue = Math.max(...allAverageValues, 1);
                                                                const minValue = Math.min(...allAverageValues, 0);
                                                                const normalizedValue = (averageValue - minValue) / (maxValue - minValue);
                                                                color = getCellColor(normalizedValue, 1);
                                                            } else if (cellContentType === "probability" && probability !== undefined && probability !== null) {
                                                                // Color based on probability value
                                                                const allProbabilities = gridData().map(cell => cell.probability).filter(val => val !== undefined && val !== null);
                                                                const maxProbability = Math.max(...allProbabilities, 1);
                                                                const minProbability = Math.min(...allProbabilities, 0);
                                                                const normalizedValue = (probability - minProbability) / (maxProbability - minProbability);
                                                                color = getCellColor(normalizedValue, 1);
                                                            } else if (cellContentType === "min_value" && minValue !== undefined && minValue !== null) {
                                                                // Color based on minimum value
                                                                const allMinValues = gridData().map(cell => cell.minValue).filter(val => val !== undefined && val !== null);
                                                                const maxMinValue = Math.max(...allMinValues, 1);
                                                                const minMinValue = Math.min(...allMinValues, 0);
                                                                const normalizedValue = (minValue - minMinValue) / (maxMinValue - minMinValue);
                                                                color = getCellColor(normalizedValue, 1);
                                                            } else if (cellContentType === "max_value" && maxValue !== undefined && maxValue !== null) {
                                                                // Color based on maximum value
                                                                const allMaxValues = gridData().map(cell => cell.maxValue).filter(val => val !== undefined && val !== null);
                                                                const maxMaxValue = Math.max(...allMaxValues, 1);
                                                                const minMaxValue = Math.min(...allMaxValues, 0);
                                                                const normalizedValue = (maxValue - minMaxValue) / (maxMaxValue - minMaxValue);
                                                                color = getCellColor(normalizedValue, 1);
                                                            } else if (cellContentType === "std_value" && stdValue !== undefined && stdValue !== null) {
                                                                // Color based on standard deviation value
                                                                const allStdValues = gridData().map(cell => cell.stdValue).filter(val => val !== undefined && val !== null);
                                                                const maxStdValue = Math.max(...allStdValues, 1);
                                                                const minStdValue = Math.min(...allStdValues, 0);
                                                                const normalizedValue = (stdValue - minStdValue) / (maxStdValue - minStdValue);
                                                                color = getCellColor(normalizedValue, 1);
                                                            } else if (cellContentType === "sail_config") {
                                                                // Color based on sail configuration (categorical)
                                                                color = getCellColor(count, 1, sailConfig);
                                                            } else {
                                                                // Color based on count
                                                                const maxCount = Math.max(...gridData().map(cell => cell.count), 1);
                                                                color = getCellColor(count, maxCount);
                                                            }

                                                            return (
                                                                <td
                                                                    class="border border-gray-300 dark:border-gray-700 p-1 text-xs text-center min-w-[3rem] h-8"
                                                                    style={{ "background-color": color as string }}
                                                                    title={`${chartConfig()?.series?.[0]?.xaxis?.name}: ${(xAxisRange().min + (xIndex + 0.5) * (effectiveXStep() ?? chartConfig()?.series?.[0]?.xaxis?.interval ?? 2)).toFixed(1)}, ${chartConfig()?.series?.[0]?.yaxis?.name}: ${yValue.toFixed(1)}, Count: ${count}${averageValue !== undefined ? `, Avg ${chartConfig()?.zaxis?.name}: ${averageValue.toFixed(1)}` : ''}`}
                                                                >
                                                                    {(() => {
                                                                        const cellContentType = chartConfig()?.cellContentType || "count";
                                                                        switch (cellContentType) {
                                                                            case "channel_value":
                                                                                return averageValue !== undefined && averageValue !== null ? averageValue.toFixed(1) : (count > 0 ? 'N/A' : '');
                                                                            case "probability":
                                                                                return probability !== undefined && probability !== null ? `${probability.toFixed(1)}%` : (count > 0 ? 'N/A' : '');
                                                                            case "min_value":
                                                                                return minValue !== undefined && minValue !== null ? minValue.toFixed(1) : (count > 0 ? 'N/A' : '');
                                                                            case "max_value":
                                                                                return maxValue !== undefined && maxValue !== null ? maxValue.toFixed(1) : (count > 0 ? 'N/A' : '');
                                                                            case "std_value":
                                                                                return stdValue !== undefined && stdValue !== null ? stdValue.toFixed(1) : (count > 0 ? 'N/A' : '');
                                                                            case "sail_config":
                                                                                return sailConfig || (count > 0 ? 'N/A' : '');
                                                                            case "count":
                                                                            default:
                                                                                return count > 0 ? count : '';
                                                                        }
                                                                    })()}
                                                                </td>
                                                            );
                                                        }}
                                                    </For>
                                                </tr>
                                            );
                                        }}
                                    </For>
                                </tbody>
                            </table>
                        </div>

                        <div class="mt-4 flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
                            <div>
                                <span class="font-medium text-gray-700 dark:text-gray-300">Color Scheme:</span> {chartConfig()?.colorScheme || "warm-to-cold"}
                            </div>
                            <div>
                                <span class="font-medium text-gray-700 dark:text-gray-300">Cell Content:</span> {chartConfig()?.cellContentType || "count"}
                                {chartConfig()?.cellContentType === "channel_value" && chartConfig()?.zaxis?.name && (
                                    <span class="text-gray-600 dark:text-gray-400"> ({chartConfig().zaxis.name})</span>
                                )}
                            </div>
                            <div>
                                <span class="font-medium text-gray-700 dark:text-gray-300">Grid Size:</span> {xAxisBins()} × {yAxisBins()} bins ({(effectiveXStep() ?? chartConfig()?.series?.[0]?.xaxis?.interval ?? 2)}° × {(effectiveYStep() ?? chartConfig()?.series?.[0]?.yaxis?.interval ?? 2)} per axis step)
                            </div>
                        </div>
                    </div>
                </div>
            </Show>

            <Show when={!isLoading() && !hasData()}>
                <DataNotFoundMessage
                    builderRoute="/grid-builder"
                    onNavigateToBuilder={() => navigate('/grid-builder')}
                />
            </Show>
        </div>
    );
}
