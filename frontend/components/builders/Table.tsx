import { createSignal, onMount, Show, createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import { useNavigate } from "@solidjs/router";
import { For } from "solid-js/web";
import * as d3 from "d3";

import Loading from "../utilities/Loading";
import ChannelPicker from "../utilities/ChannelPicker"; // Import ChannelPicker
import DragHandleIcon from "./DragHandleIcon";
import { reorderSeries } from "../../utils/builderReorder";
import { warn, error as logError, log } from "../../utils/console";
import BackButton from "../buttons/BackButton";
import { NEW_CHART_PLACEHOLDER_NAME, isNewChartPlaceholderName, isOwnerOfLoadedObject } from "../../utils/builderConstants";

import { getData, postData, deleteData, generateUniqueId } from "..\/..\/utils\/global";

import { user } from "../../store/userStore"; 
import { persistantStore } from "../../store/persistantStore";
import { setSidebarMenuRefreshTrigger } from "../../store/globalStore";
import { apiEndpoints } from "@config/env";
const { selectedClassName, selectedProjectId, selectedPage, setSelectedPage, setSelectedMenu } = persistantStore;

interface TableBuilderProps {
    objectName?: string;
    [key: string]: any;
}

export default function TableBuilder(props: TableBuilderProps) {
    const navigate = useNavigate();

    const chartType = 'TABLE';
    
    // Get object name from URL parameters, props, or persistent store
    const getObjectName = (): string => {
        // First check URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        const urlObjectName = urlParams.get('object_name');
        
        if (urlObjectName) {
            log('Using object_name from URL:', urlObjectName);
            // Update the persistent store with the URL parameter
            setSelectedPage(urlObjectName);
            return urlObjectName;
        }
        
        if (props?.objectName) {
            log('Using objectName from props:', props.objectName);
            setSelectedPage(props.objectName);
            return props.objectName;
        }
        
        // Use selectedPage from persistent store, or "new chart" placeholder
        const pageName = selectedPage();
        log('Using selectedPage from store:', pageName);
        return (pageName && pageName.trim()) ? pageName : NEW_CHART_PLACEHOLDER_NAME;
    };
    
    const [chartObjectName, setChartObjectName] = createSignal(getObjectName());
    
    // Track if user has manually changed the chart name
    const [userModifiedName, setUserModifiedName] = createSignal(false);
    
    // Update chartObjectName when selectedPage changes
    createEffect(() => {
        const pageName = selectedPage();
        if (pageName && pageName !== chartObjectName() && !userModifiedName()) {
            log('Updating chartObjectName from selectedPage:', pageName);
            setChartObjectName(pageName);
        }
    });
    
    const [sharedFlag, setSharedFlag] = createSignal(0); // 0 = PRIVATE, 1 = PUBLIC

    const [loading, setLoading] = createSignal(true);
    const [chartObjects, setChartObjects] = createStore<any[]>([]);
    const [hasChanges, setHasChanges] = createSignal(false);

    const [showChannels, setShowChannels] = createSignal(false);
    const [showAxis, setShowAxis] = createSignal("");
    const [chartNameError, setChartNameError] = createSignal<'duplicate' | null>(null);
    const [loadedChartObjectName, setLoadedChartObjectName] = createSignal<string | null>(null);
    const [isOwnerOfLoadedChart, setIsOwnerOfLoadedChart] = createSignal(true);

    const [selectedChart, setSelectedChart] = createSignal(0);
    const [selectedSeries, setSelectedSeries] = createSignal(0);

    // Drag and drop state
    const [draggedIndex, setDraggedIndex] = createSignal<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = createSignal<number | null>(null);

    // Table builder specific state
    const [dataType, setDataType] = createSignal("Phases"); // Phases, Periods, Bins, Tacks
    const [channelSource, setChannelSource] = createSignal("events_aggregate"); // events_aggregate or maneuver_stats
    const [availableChannels, setAvailableChannels] = createSignal<any[]>([]);
    const [channelSourceLoading, setChannelSourceLoading] = createSignal(false);

    // Data type options (value used in config/API; label uppercase for display)
    const dataTypeOptions: Array<{ value: string; label: string }> = [
        { value: "Phases", label: "PHASES" },
        { value: "Periods", label: "PERIODS" },
        { value: "Bins", label: "BINS" },
        { value: "Tacks", label: "TACKS" },
        { value: "Gybes", label: "GYBES" },
        { value: "Roundups", label: "ROUNDUPS" },
        { value: "Bearaways", label: "BEARAWAYS" },
        { value: "Takeoffs", label: "TAKEOFFS" }
    ];

    // Aggregate type options for event_aggregates
    const aggregateTypeOptions: Array<{ value: string; label: string }> = [
        { value: "AVG", label: "Average" },
        { value: "STD", label: "Standard Deviation" }
    ];

    // Conversion options
    const conversionOptions: Array<{ value: string; label: string }> = [
        { value: "none", label: "None", description: "No conversion" },
        { value: "twa_to_port_stbd", label: "TWA to Port/Starboard", description: "Convert TWA to port/starboard" },
        { value: "twa_to_wind_type", label: "TWA to Upwind/Downwind/Reaching", description: "Convert TWA to wind direction type" }
    ];

    // Conditional formatting options
    const conditionalFormattingOptions = [
        { value: "none", label: "None", description: "No conditional formatting" },
        { value: "heatmap", label: "Heatmap", description: "Color scale based on value" },
        { value: "traffic_light", label: "Traffic Light", description: "Green/Yellow/Red thresholds" },
        { value: "bar_threshold", label: "Bar Threshold", description: "Bars based on thresholds" },
        { value: "arrow", label: "Arrow", description: "Up/Down arrows based on value changes" }
    ];

    const defaultChart = {
        unique_id: generateUniqueId(),
        series: [], // Initialize without any channels
        data: [],
        dataType: "Phases",
        channelSource: "events_aggregate"
    };

    // Function to determine channel source based on data type
    const getChannelSourceForDataType = (type) => {
        const maneuverTypes = ['Tacks', 'Gybes', 'Roundups', 'Bearaways', 'Takeoffs'];
        return maneuverTypes.includes(type) ? 'maneuver_stats' : 'events_aggregate';
    };

    // Function to fetch channels based on source
    const fetchChannelsForSource = async (source) => {
        setChannelSourceLoading(true);
        const controller = new AbortController();
        
        // Default channels that are always available
        const defaultChannels = [
            "State",
            "Config",
            "Race_number",
            "Leg_number",
            "Tack",
            "PointofSail"
        ];
        
        try {
            const response = await getData(`${apiEndpoints.app.data}/channels?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&table_name=${encodeURIComponent(source)}`, controller.signal);
            
            if (response.success) {
                const fetchedChannels = response.data.map(channel => channel.column_name);
                // Combine default channels with fetched channels, ensuring no duplicates
                const allChannels = [...defaultChannels];
                fetchedChannels.forEach(channel => {
                    if (!allChannels.includes(channel)) {
                        allChannels.push(channel);
                    }
                });
                setAvailableChannels(allChannels);
            } else {
                logError("Error fetching channels for source:", source);
                // Even if fetch fails, set default channels
                setAvailableChannels([...defaultChannels]);
            }
        } catch (error: any) {
            logError("Error fetching channels:", error);
            // Even if fetch fails, set default channels
            setAvailableChannels([...defaultChannels]);
        } finally {
            setChannelSourceLoading(false);
        }
    };

    // Handle data type change
    const handleDataTypeChange = (newDataType) => {
        setDataType(newDataType);
        const newSource = getChannelSourceForDataType(newDataType);
        setChannelSource(newSource);
        fetchChannelsForSource(newSource);
        setHasChanges(true);
    };

    const fetchCharts = async () => {
        const controller = new AbortController();
        
        try {
            // Check if user is available
            if (!user() || !user().user_id) {
                warn("User not available, skipping chart fetch");
                setChartObjects([defaultChart]);
                return;
            }
            
            const response_json = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=table&object_name=${chartObjectName()}`, controller.signal);

            if (response_json.success) {
                try {
                    const loadedCharts = response_json.data?.chart_info || [];
                    const chartsWithIds = loadedCharts.map((chart: any) => ({
                        ...chart,
                        unique_id: chart.unique_id || generateUniqueId()
                    }));
                    setChartObjects(chartsWithIds.length > 0 ? chartsWithIds : [defaultChart]);
                    if (chartsWithIds.length > 0) {
                        setLoadedChartObjectName(chartObjectName());
                        try {
                            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user()!.user_id)}&parent_name=table`;
                            const namesRes = await getData(namesUrl, controller.signal);
                            setIsOwnerOfLoadedChart(isOwnerOfLoadedObject(namesRes?.success ? namesRes.data : null, chartObjectName()));
                        } catch (_) {
                            setIsOwnerOfLoadedChart(true);
                        }
                    } else {
                        setLoadedChartObjectName(null);
                        setIsOwnerOfLoadedChart(true);
                    }
                    if (response_json.data?.dataType) {
                        setDataType(response_json.data.dataType);
                    }
                    if (response_json.data?.channelSource) {
                        setChannelSource(response_json.data.channelSource);
                    }
                    if (response_json.data?.shared !== undefined) {
                        setSharedFlag(response_json.data.shared);
                    }
                } catch (parseError) {
                    setChartObjects([defaultChart]);
                    setLoadedChartObjectName(null);
                    setIsOwnerOfLoadedChart(true);
                }
            } else {
                logError("Error loading charts...");
                setChartObjects([defaultChart]);
                setLoadedChartObjectName(null);
                setIsOwnerOfLoadedChart(true);
            }
        } catch (error: any) {
            logError("Error loading charts:", error.message);
            setChartObjects([defaultChart]);
            setLoadedChartObjectName(null);
            setIsOwnerOfLoadedChart(true);
        }
    };

    // Save and post charts (optional saveAsName for Save As flow)
    const saveCharts = async (saveAsName?: string) => {
        const controller = new AbortController();
        const objectName = (saveAsName || chartObjectName()).trim();
        if (isNewChartPlaceholderName(objectName)) {
            warn('Table builder: Cannot save until the chart name is updated from "new chart".');
            alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
            return;
        }
        try {
            if (!user() || !user().user_id) {
                logError("User not available, cannot save charts");
                return;
            }
            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=table`;
            const namesResponse = await getData(namesUrl, controller.signal);
            const existingNames: string[] = (namesResponse?.success && Array.isArray(namesResponse?.data))
                ? (namesResponse.data as { object_name: string }[]).map((o) => (o.object_name || '').trim()).filter(Boolean)
                : [];
            const nameAlreadyExists = existingNames.some((n) => n.toLowerCase() === objectName.toLowerCase());
            const isUpdatingOwnChart = !saveAsName && loadedChartObjectName() !== null && (loadedChartObjectName() || '').trim().toLowerCase() === objectName.toLowerCase();
            if (nameAlreadyExists && !isUpdatingOwnChart) {
                warn('Table builder: Save blocked - chart name already exists:', objectName);
                setChartNameError('duplicate');
                alert(`A chart named "${objectName}" already exists. Please choose a different name.`);
                return;
            }
            setChartNameError(null);
            const chartObject = {"parent_name": "table", "chart_name": "default", "chart_info": chartObjects, "shared": sharedFlag(), "dataType": dataType(), "channelSource": channelSource()};
            const summary_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'user_id': user().user_id, 'parent_name': 'table', 'object_name': objectName, 'json': JSON.stringify(chartObject, null, 2)};

            const response_json = await postData(`${apiEndpoints.app.users}/object`, summary_json, controller.signal);

            if (response_json.success) {
                log("Saved successfully!", JSON.stringify(chartObjects, null, 2));
                const previousName = loadedChartObjectName();
                const isRename = !saveAsName && previousName !== null && previousName.trim().toLowerCase() !== objectName.toLowerCase();
                if (isRename) {
                    const delete_json = {
                        class_name: selectedClassName(),
                        project_id: selectedProjectId(),
                        user_id: user().user_id,
                        parent_name: 'table',
                        object_name: previousName
                    };
                    try {
                        await deleteData(`${apiEndpoints.app.users}/object`, delete_json, controller.signal);
                    } catch (deleteErr: any) {
                        logError("Failed to remove old chart name after rename:", deleteErr);
                    }
                }
                setLoadedChartObjectName(objectName);
                if (saveAsName) setChartObjectName(saveAsName);
                setSidebarMenuRefreshTrigger(1);
                setSelectedMenu("TABLE");
                setSelectedPage(objectName);
                navigate("/dashboard");
            } else {
                log("Save Failed -", response_json.message);
            }
        } catch (error: any) {
            logError("Error saving charts:", error);
        }
    };

    const saveAsNewChart = async () => {
        const newName = prompt("Enter a new name for this table:", `${chartObjectName()} Copy`);
        if (newName && newName.trim()) {
            const trimmed = newName.trim();
            if (isNewChartPlaceholderName(trimmed)) {
                warn('Table builder: Cannot use "new chart" as the table name.');
                alert('Please choose a different name. "New chart" is only a placeholder.');
                return;
            }
            await saveCharts(trimmed);
            setHasChanges(false);
        }
    };

    // Delete chart object
    const deleteChart = async () => {
        const controller = new AbortController();
        
        try {
            const delete_json = {
                'class_name': selectedClassName(), 
                'project_id': selectedProjectId(),
                'user_id': user().user_id, 
                'parent_name': 'table', 
                'object_name': chartObjectName()
            };

            const response_json = await deleteData(`${apiEndpoints.app.users}/object`, delete_json, controller.signal);

            if (response_json.success) {
                log("Deleted successfully!");
                setSidebarMenuRefreshTrigger(1);
                // Chart configuration deleted successfully
                
                // Navigate back to dashboard
                setSelectedMenu("TABLE");
                setSelectedPage("");
                
                navigate("/dashboard");
            } else {
                logError("Delete failed:", response_json.message);
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                return;
            }
            logError("Error deleting chart:", error);
        }
    };

    const handleSaveChannels = async (axis, channels, chartIndex) => {
        if (channels.length > 0) {
            const seriesIndex = selectedSeries();
            const isUpdating = seriesIndex !== undefined && seriesIndex !== null;
            
            // Define channels that should have rounding set to 0
            const zeroRoundingChannels = ['Datetime','Race_number','Leg_number','PointofSail','Tack','Config','State'];
            
            if (isUpdating) {
                // Update existing series item
                const channel = channels[0]; // When updating, we only use the first channel
                const channelType = channel === "Datetime" ? "datetime" : "float";
                const shouldSetZeroRounding = zeroRoundingChannels.includes(channel);
                
                // Preserve existing values or set defaults
                const existingSeries = chartObjects[chartIndex]?.series?.[seriesIndex] || {};
                
                setChartObjects(chartIndex, "series", seriesIndex, {
                    channel: { name: channel, type: channelType },
                    aggregate: existingSeries.aggregate || (channelSource() === "events_aggregate" ? "AVG" : null),
                    header: existingSeries.header || channel,
                    formatting: existingSeries.formatting || "none",
                    rounding: existingSeries.rounding !== undefined ? existingSeries.rounding : (shouldSetZeroRounding ? 0 : 2),
                    suffix: existingSeries.suffix || ""
                });
            } else {
                // Add new channels to the chart's series
                const newChannels = channels.map((channel) => {
                    // Set type to "datetime" if channel name is "Datetime" (case-sensitive)
                    const channelType = channel === "Datetime" ? "datetime" : "float";
                    const shouldSetZeroRounding = zeroRoundingChannels.includes(channel);
                    
                    return {
                        channel: { name: channel, type: channelType },
                        aggregate: channelSource() === "events_aggregate" ? "AVG" : null, // Default to AVG for events_aggregate
                        header: channel, // Default header name is channel name
                        formatting: "none", // Default conditional formatting
                        rounding: shouldSetZeroRounding ? 0 : 2, // Zero rounding for specific channels, 2 for others
                        suffix: "" // Default suffix is empty
                    };
                });

                setChartObjects(chartIndex, "series", [
                    ...(chartObjects[chartIndex]?.series || []), // Ensure series is an array
                    ...newChannels,
                ]);
            }

            setShowChannels(false);
            setSelectedSeries(undefined); // Reset selected series after update
            setHasChanges(true);
        } else {
            setShowChannels(false);
            setSelectedSeries(undefined); // Reset selected series if cancelled
        }
    };


    // Add a new channel to the chart's series
    const addChannel = (chartIndex) => {
        setSelectedChart(chartIndex);
        setSelectedSeries(undefined); // Reset to ensure we're adding, not updating
        setShowChannels(true); // Open the channel picker
        setShowAxis("channel");
    };

    // Handle drag start
    const handleDragStart = (e, chartIndex, seriesIndex) => {
        const chartIdx = chartIndex();
        const seriesIdx = seriesIndex();
        log("Drag start - chartIndex:", chartIdx, "seriesIndex:", seriesIdx);
        setDraggedIndex(seriesIdx);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/json", JSON.stringify({ chartIndex: chartIdx, seriesIndex: seriesIdx }));
    };

    // Handle drag end
    const handleDragEnd = (e) => {
        log("Drag end");
        setDraggedIndex(null);
        setDragOverIndex(null);
    };

    // Handle drag over
    const handleDragOver = (e, seriesIndex) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const idx = seriesIndex();
        setDragOverIndex(idx);
    };

    // Handle drop - chartObjects store
    const handleDrop = (e, chartIndex, seriesIndex) => {
        e.preventDefault();
        const chartIdx = chartIndex();
        const seriesIdx = seriesIndex();
        const draggedIdx = draggedIndex();

        if (draggedIdx === null || seriesIdx === undefined || draggedIdx === seriesIdx) {
            warn("Invalid drop - draggedIdx:", draggedIdx, "targetIdx:", seriesIdx);
            return;
        }

        const chart = chartObjects[chartIdx];
        if (!chart || !chart.series) {
            warn("No series found - chartIdx:", chartIdx, "chart:", chart);
            return;
        }

        const newSeries = reorderSeries(chart.series, draggedIdx, seriesIdx);
        setChartObjects(chartIdx, "series", newSeries);
        setHasChanges(true);
        setSelectedSeries(0);
        setDraggedIndex(null);
        setDragOverIndex(null);
    };

    onMount(async () => {
        setChartObjects([]);
        await fetchCharts();
        
        // Initialize channel source and fetch channels based on loaded or default data type
        const currentDataType = dataType();
        const initialSource = getChannelSourceForDataType(currentDataType);
        setChannelSource(initialSource);
        await fetchChannelsForSource(initialSource);
        
        setLoading(false);
    });

    return (
        <div class="builder-page overflow-auto select-none">
            {loading() && <Loading />}
            <div class="mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-16" style={{
                "opacity": loading() ? 0 : 1, 
                "pointer-events": loading() ? "none" : "auto", 
                "transition": "opacity 0.3s ease",
                "min-width": "1150px",
                "max-height": "100vh",
                "overflow-y": "auto"
            }}>
                {/* Header Section */}
                <div class="builder-page-header">
                    <div class="builder-page-title">
                        <div class="builder-page-title-content">
                            <h1>Table Builder</h1>
                            <p>Create and configure data tables for visualization</p>
                        </div>
                    </div>
                </div>


                <form class="builder-form">
                    {/* Chart Configuration */}
                    <div class="builder-form-card">
                        <div class="builder-form-header">
                            <div class="flex items-center justify-between">
                                <div class="flex items-center space-x-3">
                                    <div>
                                        <h2 class="text-base font-semibold" style="color: var(--color-text-primary);">Table Configuration</h2>
                                        <p class="text-xs" style="color: var(--color-text-secondary);">TABLE</p>
                                    </div>
                                </div>
                                <div class="flex items-center space-x-3">
                                    <span class="inline-flex items-center px-2 py-1 rounded text-xs font-medium" style="background: var(--color-bg-tertiary); color: var(--color-text-secondary);">
                                        {chartObjects.length} table{chartObjects.length !== 1 ? 's' : ''}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div class="builder-form-content">
                            <div class="flex flex-wrap items-start gap-6">
                                <div class="flex-1 min-w-[400px]">
                                    <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">
                                        Table Name
                                    </label>
                                    <input
                                        type="text"
                                        value={chartObjectName()}
                                        onInput={(e) => {
                                            setChartObjectName(e.target.value);
                                            setChartNameError(null);
                                            setUserModifiedName(true);
                                            setHasChanges(true);
                                        }}
                                        class={`builder-form-input w-full px-4 py-2 text-sm ${(isNewChartPlaceholderName(chartObjectName()) || chartNameError() === 'duplicate') ? 'builder-form-input-invalid' : ''}`}
                                        placeholder="Enter chart name"
                                        aria-invalid={(isNewChartPlaceholderName(chartObjectName()) || chartNameError() === 'duplicate') ? 'true' : 'false'}
                                        aria-describedby={(isNewChartPlaceholderName(chartObjectName()) || chartNameError() === 'duplicate') ? 'chart-name-error' : undefined}
                                    />
                                    <div id="chart-name-error" role="alert">
                                        <Show when={isNewChartPlaceholderName(chartObjectName())}>
                                            <p class="builder-form-input-error-message">
                                                Please change the chart name from &quot;new chart&quot; before saving.
                                            </p>
                                        </Show>
                                        <Show when={chartNameError() === 'duplicate' && !isNewChartPlaceholderName(chartObjectName())}>
                                            <p class="builder-form-input-error-message">
                                                A chart with this name already exists. Please choose a different name.
                                            </p>
                                        </Show>
                                    </div>
                                </div>
                                <div class="min-w-[250px]">
                                    <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">
                                        Visibility
                                    </label>
                                    <select
                                        value={sharedFlag()}
                                        onChange={(e) => {
                                            setSharedFlag(parseInt(e.target.value));
                                            setHasChanges(true);
                                        }}
                                        class="builder-form-input w-full px-4 py-2 text-sm"
                                    >
                                        <option value={0}>🔒 Private - Only you can see this table</option>
                                        <option value={1}>🌐 Public - Team mates can see this table</option>
                                    </select>
                                </div>
                                <div class="min-w-[250px]">
                                    <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">
                                        Data Type
                                    </label>
                                    <select
                                        value={dataType()}
                                        onChange={(e) => handleDataTypeChange(e.target.value)}
                                        class="builder-form-input w-full px-4 py-2 text-sm"
                                    >
                                        {dataTypeOptions.map(option => (
                                            <option value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>
                    <Show when={chartObjects.length > 0} fallback={
                        <div class="text-center py-16">
                            <div class="mx-auto w-24 h-24 rounded-full flex items-center justify-center mb-6" style="background: var(--color-bg-tertiary);">
                                <svg class="w-12 h-12" style="color: var(--color-text-link);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                                </svg>
                            </div>
                            <h3 class="text-xl font-semibold mb-2" style="color: var(--color-text-primary);">No table data available</h3>
                            <p class="mb-8 max-w-md mx-auto" style="color: var(--color-text-secondary);">Table will be created automatically when you have data to display</p>
                        </div>
                    }>
                        <div class="builder-chart-container">
                            <For each={chartObjects}>
                                {(chart, chartIndex) => (
                                    <div class="builder-form-card">
                                        {/* Chart Header */}
                                        <div class="builder-form-header">
                                            <div class="flex items-center justify-between">
                                                <div class="flex items-center space-x-3">
                                                    <div class="w-8 h-8 rounded-md flex items-center justify-center" style="background: var(--color-bg-button);">
                                                        <span class="font-bold text-sm" style="color: var(--color-text-inverse);">{chartIndex() + 1}</span>
                                                    </div>
                                                    <div>
                                                        <h3 class="text-base font-semibold" style="color: var(--color-text-primary);">Table Contents</h3>
                                                    </div>
                                                </div>
                                                <div class="flex items-center space-x-3">
                                                    <span class="inline-flex items-center px-2 py-1 rounded text-xs font-medium" style="background: var(--color-bg-tertiary); color: var(--color-text-secondary);">
                                                        {chart.series?.length || 0} columns
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Chart Content */}
                                        <div class="builder-form-content">
                                            {/* Add Channel Button */}
                                            <div class="mb-4">
                                                <button
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        addChannel(chartIndex);
                                                    }}
                                                    class="builder-form-button px-6 py-3 font-semibold"
                                                    style={{ background: '#2563eb', color: 'white' }}
                                                >
                                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                                                    </svg>
                                                    Add Channel
                                                </button>
                                            </div>

                                            {/* Channels Table */}
                                            <div class="overflow-x-auto">
                                                <table class="builder-table min-w-full">
                                                    <thead>
                                                        <tr>
                                                            <th class="w-5"></th>
                                                            <th class="w-80">Channel</th>
                                                            <th class="w-80">Header Name</th>
                                                            <th class="w-36">Aggregate</th>
                                                            <th class="w-40">Formatting</th>
                                                            <th class="w-16">Rounding</th>
                                                            <th class="w-16">Suffix</th>
                                                            <th class="w-12">Actions</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        <For each={chart.series}>
                                                            {(series, seriesIndex) => (
                                                                <tr
                                                                    draggable="true"
                                                                    onDragStart={(e) => handleDragStart(e, chartIndex, seriesIndex)}
                                                                    onDragEnd={handleDragEnd}
                                                                    onDragOver={(e) => handleDragOver(e, seriesIndex)}
                                                                    onDrop={(e) => handleDrop(e, chartIndex, seriesIndex)}
                                                                    class={dragOverIndex() === seriesIndex() ? "builder-row-drag-over" : ""}
                                                                >
                                                                    <td class="builder-drag-handle-cell py-2">
                                                                        <DragHandleIcon />
                                                                    </td>
                                                                    <td class="py-2">
                                                                        <input
                                                                            type="text"
                                                                            value={series.channel?.name || ""}
                                                                            placeholder="Click to select channel"
                                                                            onClick={() => {
                                                                                setSelectedChart(chartIndex);
                                                                                setSelectedSeries(seriesIndex);
                                                                                setShowChannels(true);
                                                                                setShowAxis("channel");
                                                                            }}
                                                                            readOnly
                                                                            class="builder-form-input w-full pt-4 pb-2 text-sm cursor-pointer"
                                                                            style="width: 100%; margin-top: 6px;"
                                                                        />
                                                                    </td>
                                                                    <td class="py-2">
                                                                        <input
                                                                            type="text"
                                                                            value={series.header || series.channel?.name || ""}
                                                                            placeholder="Header name"
                                                                            onInput={(e) => {
                                                                                setChartObjects(chartIndex(), "series", seriesIndex(), "header", e.target.value);
                                                                                setHasChanges(true);
                                                                            }}
                                                                            class="builder-form-input w-full pt-4 pb-2 text-sm"
                                                                            style="width: 100%; margin-top: 6px;"
                                                                        />
                                                                        </td>
                                                                    <td class="py-2">
                                                                        {(() => {
                                                                            const channelName = series.channel?.name || "";
                                                                            const hideAggregates = ['Datetime','Race_number','Leg_number','PointofSail','Tack','Config','State'];
                                                                            const shouldHide = hideAggregates.includes(channelName);
                                                                            
                                                                            if (shouldHide) {
                                                                                return null;
                                                                            }
                                                                            
                                                                            return (
                                                                                channelSource() === "events_aggregate" ? (
                                                                                    <select
                                                                                        value={series.aggregate || "AVG"}
                                                                                        onChange={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "aggregate", e.target.value);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input w-full pt-4 pb-2 text-sm"
                                                                                        style="width: 100%; margin-top: 3px;"
                                                                                    >
                                                                                        {aggregateTypeOptions.map(option => (
                                                                                            <option value={option.value}>{option.label}</option>
                                                                                        ))}
                                                                                    </select>
                                                                                ) : (
                                                                                    <span class="text-sm" style="color: var(--color-text-secondary);">N/A</span>
                                                                                )
                                                                            );
                                                                        })()}
                                                                    </td>
                                                                    <td class="py-2">
                                                                        {(() => {
                                                                            const channelName = series.channel?.name || "";
                                                                            const hideFormattings = ['Datetime','Race_number','Leg_number','PointofSail','Tack','Config','State'];
                                                                            const shouldHide = hideFormattings.includes(channelName);
                                                                            
                                                                            if (shouldHide) {
                                                                                return null;
                                                                            }
                                                                            
                                                                            return (
                                                                                <select
                                                                                    value={series.formatting || "none"}
                                                                                    onChange={(e) => {
                                                                                        setChartObjects(chartIndex(), "series", seriesIndex(), "formatting", e.target.value);
                                                                                        setHasChanges(true);
                                                                                    }}
                                                                                    class="builder-form-input w-full pt-4 pb-2 text-sm"
                                                                                    style="width: 100%; margin-top: 3px;"
                                                                                >
                                                                                    {conditionalFormattingOptions.map(option => (
                                                                                        <option value={option.value}>{option.label}</option>
                                                                                    ))}
                                                                                </select>
                                                                            );
                                                                        })()}
                                                                    </td>
                                                                    <td class="py-2">
                                                                        {(() => {
                                                                            const channelName = series.channel?.name || "";
                                                                            const hideRoundings = ['Datetime','Race_number','Leg_number','PointofSail','Tack','Config','State'];
                                                                            const shouldHide = hideRoundings.includes(channelName);
                                                                            
                                                                            if (shouldHide) {
                                                                                return null;
                                                                            }
                                                                            
                                                                            return (
                                                                                <input
                                                                                    type="number"
                                                                                    value={series.rounding ?? 2}
                                                                                    min="0"
                                                                                    max="10"
                                                                                    onInput={(e) => {
                                                                                        setChartObjects(chartIndex(), "series", seriesIndex(), "rounding", parseInt(e.target.value) || 0);
                                                                                        setHasChanges(true);
                                                                                    }}
                                                                                    class="builder-form-input w-full pt-4 pb-2 text-sm"
                                                                                    style="width: 100%; margin-top: 6px;"
                                                                                    placeholder="Decimals"
                                                                                />
                                                                            );
                                                                        })()}
                                                                    </td>
                                                                    <td class="py-2">
                                                                        {(() => {
                                                                            const channelName = series.channel?.name || "";
                                                                            const hideSuffixes = ['Datetime','Race_number','Leg_number','PointofSail','Tack','Config','State'];
                                                                            const shouldHide = hideSuffixes.includes(channelName);
                                                                            
                                                                            if (shouldHide) {
                                                                                return null;
                                                                            }
                                                                            
                                                                            return (
                                                                                <input
                                                                                    type="text"
                                                                                    value={series.suffix || ""}
                                                                                    placeholder="e.g., %, kts, m/s"
                                                                                    onInput={(e) => {
                                                                                        setChartObjects(chartIndex(), "series", seriesIndex(), "suffix", e.target.value);
                                                                                        setHasChanges(true);
                                                                                    }}
                                                                                    class="builder-form-input w-full pt-4 pb-2 text-sm"
                                                                                    style="width: 100%; margin-top: 6px;"
                                                                                />
                                                                            );
                                                                        })()}
                                                                    </td>
                                                                    <td class="py-3 text-center">
                                                                        <svg
                                                                            xmlns="http://www.w3.org/2000/svg"
                                                                            width="20"
                                                                            height="20"
                                                                            class="inline-block"
                                                                            fill="gray"
                                                                            viewBox="0 0 24 24"
                                                                            onClick={() => {
                                                                                const chartIdx = chartIndex();
                                                                                const seriesIdx = seriesIndex();
                                                                                const newSeries = chart.series.filter((_, i) => i !== seriesIdx);
                                                                                setChartObjects(chartIdx, "series", newSeries);
                                                                                setHasChanges(true);
                                                                            }}
                                                                            style={{ cursor: "pointer" }}
                                                                        >
                                                                            <path d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 2v1h4V5zm-3 3v11h10V8zM9 10a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z" />
                                                                        </svg>
                                                                    </td>
                                                                </tr>
                                                            )}
                                                        </For>
                                                    </tbody>
                                                </table>
                                            </div>

                                            {/* Save Button - show when hasChanges; disable when non-owner or placeholder */}
                                            {hasChanges() && (
                                                <div class="flex justify-center mt-6 mb-4">
                                                    <button
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            if (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) return;
                                                            if (isNewChartPlaceholderName(chartObjectName())) {
                                                                warn('Table builder: Cannot save until the chart name is updated from "new chart".');
                                                                alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
                                                                return;
                                                            }
                                                            saveCharts();
                                                            setHasChanges(false);
                                                        }}
                                                        class="builder-form-button px-6 py-3 font-semibold"
                                                        style="background: #22c55e;"
                                                        disabled={isNewChartPlaceholderName(chartObjectName()) || (loadedChartObjectName() !== null && !isOwnerOfLoadedChart())}
                                                        title={isNewChartPlaceholderName(chartObjectName()) ? 'Update the chart name before saving' : (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) ? 'Use Save As to save a copy under your name' : undefined}
                                                    >
                                                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                                                        </svg>
                                                        Save & Generate Table
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                        
                    </Show>

                    {/* Save As - when a table is loaded */}
                    <Show when={loadedChartObjectName() !== null}>
                        <div class="flex justify-center mt-4">
                            <button
                                type="button"
                                onClick={(e) => { e.preventDefault(); saveAsNewChart(); }}
                                class="builder-form-button px-6 py-3 font-semibold"
                            >
                                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path>
                                </svg>
                                Save As
                            </button>
                        </div>
                    </Show>

                    {/* Delete Button - only for owner when table is loaded */}
                    <Show when={loadedChartObjectName() !== null && isOwnerOfLoadedChart()}>
                        <div class="flex justify-center mt-4">
                            <button
                                onClick={(e) => {
                                    e.preventDefault();
                                    if (confirm('Are you sure you want to delete this chart? This action cannot be undone.')) {
                                        deleteChart();
                                    }
                                }}
                                class="builder-form-button-danger px-6 py-3 font-semibold"
                            >
                                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                                </svg>
                                Delete Chart
                            </button>
                        </div>
                    </Show>
                </form>
                
                <Show when={showChannels()}>
                    <ChannelPicker
                        selection={[]}
                        tableName={channelSource()}
                        additionalChannels={[]} // Optional: pass additional channels to add to the default list
                        isUpdate={selectedSeries() !== undefined && selectedSeries() !== null}
                        onSave={(channel) => {
                            handleSaveChannels(showAxis(), channel, selectedChart());
                        }}
                    />
                </Show>

                {/* Back Button */}
                <div class="mt-8 flex justify-start">
                    <BackButton />
                </div>
            </div>
        </div>
    );
}
