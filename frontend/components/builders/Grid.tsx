import { createSignal, onMount, Show, createEffect, createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import { useNavigate } from "@solidjs/router";
import { For } from "solid-js/web";

import Loading from "../utilities/Loading";
import ChannelPicker from "../utilities/FileChannelPicker"; // Import ChannelPicker
import BackButton from "../buttons/BackButton";

import { getData, postData, deleteData, generateUniqueId } from "..\/..\/utils\/global";
import { error as logError, log, warn } from "../../utils/console";
import { NEW_CHART_PLACEHOLDER_NAME, isNewChartPlaceholderName, isOwnerOfLoadedObject } from "../../utils/builderConstants";

import { user } from "../../store/userStore"; 
import { unifiedDataStore } from "../../store/unifiedDataStore"; 
import { persistantStore } from "../../store/persistantStore";
import { setSidebarMenuRefreshTrigger } from "../../store/globalStore";
import { defaultChannelsStore } from "../../store/defaultChannelsStore";
import { apiEndpoints } from "@config/env";
const { selectedClassName, selectedProjectId, selectedPage, setSelectedPage, setSelectedMenu } = persistantStore;

interface GridBuilderProps {
    objectName?: string;
    [key: string]: any;
}

export default function GridBuilder(props: GridBuilderProps) {
    const navigate = useNavigate();

    const chartType = 'GRID';

    // Use defaultChannelsStore for channel names
    const { twaName, twsName } = defaultChannelsStore;
    
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
    
    // Update chartObjectName when selectedPage changes (only if user hasn't modified it)
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

    // Grid specific settings
    const [xAxisIntervals, setXAxisIntervals] = createSignal(10); // Number of x-axis bins
    const [yAxisIntervals, setYAxisIntervals] = createSignal(10); // Number of y-axis bins
    const [colorScheme, setColorScheme] = createSignal("warm-to-cold"); // Default color scheme
    const [cellContentType, setCellContentType] = createSignal("count"); // What to show in cells
    const [zAxisChannel, setZAxisChannel] = createSignal(""); // Z-axis channel for average calculation

    // Color scheme options for grid
    const colorSchemeOptions: Array<{ value: string; label: string; description: string }> = [
        { value: "warm-to-cold", label: "Warm to Cold", description: "Red to Blue gradient" },
        { value: "viridis", label: "Viridis", description: "Purple to Yellow gradient" },
        { value: "plasma", label: "Plasma", description: "Purple to Pink gradient" },
        { value: "inferno", label: "Inferno", description: "Black to Yellow gradient" },
        { value: "shades-of-red", label: "Shades of Red", description: "Light to dark red gradient" },
        { value: "shades-of-blue", label: "Shades of Blue", description: "Light to dark blue gradient" },
        { value: "rainbow", label: "Rainbow", description: "Full spectrum rainbow colors" }
    ];

    // Cell content type options
    const cellContentOptions: Array<{ value: string; label: string; description: string }> = [
        { value: "count", label: "Count", description: "Number of data points in each cell" },
        { value: "probability", label: "Probability", description: "Probability distribution" },
        { value: "channel_value", label: "Average Value", description: "Average value of selected channel" },
        { value: "min_value", label: "Min Value", description: "Minimum value in each cell" },
        { value: "max_value", label: "Max Value", description: "Maximum value in each cell" },
        { value: "std_value", label: "Standard Deviation", description: "Standard deviation in each cell" },
        { value: "sail_config", label: "Sail Configuration", description: "Best sail configuration by Vmg_perc" }
    ];

    // Initialize with a single grid chart
    const initializeGrid = () => {
        if (chartObjects.length === 0) {
            const gridChart = {
                unique_id: generateUniqueId(),
                series: [
                    {
                        xaxis: { name: twaName(), type: "float", interval: xAxisIntervals() }, // X-axis channel
                        yaxis: { name: twsName(), type: "float", interval: yAxisIntervals() }, // Y-axis channel
                        data: [],
                    },
                ],
                filters: [],
                colorScheme: colorScheme(),
                cellContentType: cellContentType(),
                zaxis: { name: zAxisChannel(), type: "float" },
            };
            setChartObjects([gridChart]);
        }
    };

    // Update grid settings
    const updateGridSettings = (settings) => {
        if (chartObjects.length > 0) {
            setChartObjects(0, (chart) => ({
                ...chart,
                colorScheme: settings.colorScheme || colorScheme(),
                cellContentType: settings.cellContentType || cellContentType(),
                zaxis: settings.zaxis || { name: zAxisChannel(), type: "float" },
                series: chart.series.map(series => ({
                    ...series,
                    xaxis: { ...series.xaxis, interval: xAxisIntervals() },
                    yaxis: { ...series.yaxis, interval: yAxisIntervals() }
                }))
            }));
            setHasChanges(true);
        }
    };

    // Update setChartObjects to track changes
    const updateChartObjects = (chartIndex, ...pathAndValue) => {
        setChartObjects((prev) => {
            const updatedCharts = [...prev];
            
            // Deep clone the chart object to ensure reactivity
            const chart = { ...updatedCharts[chartIndex] };
            updatedCharts[chartIndex] = chart;
            
            let target = chart;

            // The last element is the value, everything else is the path
            const value = pathAndValue[pathAndValue.length - 1];
            const path = pathAndValue.slice(0, -1);

            // Traverse the path to update the value
            for (let i = 0; i < path.length - 1; i++) {
                const key = path[i];
                // Ensure the nested object exists and is properly cloned
                if (!target[key]) {
                    target[key] = {};
                } else if (Array.isArray(target[key])) {
                    // Handle arrays specially
                    target[key] = [...target[key]];
                    if (target[key][path[i + 1]]) {
                        target[key][path[i + 1]] = { ...target[key][path[i + 1]] };
                    }
                } else {
                    target[key] = { ...target[key] };
                }
                target = target[key];
            }

            // Set the final value
            const lastKey = path[path.length - 1];
            target[lastKey] = value;

            return updatedCharts;
        });
        setHasChanges(true);
    };

    const fetchCharts = async () => {
        const controller = new AbortController();
        
        try {
            const response_json = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=grid&object_name=${chartObjectName()}`, controller.signal);

            if (response_json.success) {
                try {
                    const chartData = response_json.data?.chart_info;
                    if (chartData && chartData.length > 0) {
                        const chartsWithIds = chartData.map((chart: any) => ({
                            ...chart,
                            unique_id: chart.unique_id || generateUniqueId()
                        }));
                        setChartObjects(chartsWithIds);
                        setLoadedChartObjectName(chartObjectName());
                        try {
                            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user()!.user_id)}&parent_name=grid`;
                            const namesRes = await getData(namesUrl, controller.signal);
                            setIsOwnerOfLoadedChart(isOwnerOfLoadedObject(namesRes?.success ? namesRes.data : null, chartObjectName()));
                        } catch (_) {
                            setIsOwnerOfLoadedChart(true);
                        }
                        if (chartsWithIds[0] && chartsWithIds[0].series && chartsWithIds[0].series[0]) {
                            setXAxisIntervals(chartsWithIds[0].series[0].xaxis?.interval || 10);
                            setYAxisIntervals(chartsWithIds[0].series[0].yaxis?.interval || 10);
                            setColorScheme(chartsWithIds[0].colorScheme || "warm-to-cold");
                            setCellContentType(chartsWithIds[0].cellContentType || "count");
                            setZAxisChannel(chartsWithIds[0].zaxis?.name || "");
                        }
                        if (response_json.data?.shared !== undefined) {
                            setSharedFlag(response_json.data.shared);
                        }
                    } else {
                        initializeGrid();
                        setLoadedChartObjectName(null);
                        setIsOwnerOfLoadedChart(true);
                    }
                } catch (parseError) {
                    initializeGrid();
                    setLoadedChartObjectName(null);
                    setIsOwnerOfLoadedChart(true);
                }
            } else {
                logError("Error loading charts...");
                initializeGrid();
                setLoadedChartObjectName(null);
                setIsOwnerOfLoadedChart(true);
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                return; // Don't set default state if aborted
            }
            logError("Error loading charts:", error.message);
            initializeGrid();
            setLoadedChartObjectName(null);
            setIsOwnerOfLoadedChart(true);
        }
    };

    // Save and post charts (optional saveAsName for Save As flow). Returns true if save succeeded and we navigated away.
    const saveCharts = async (saveAsName?: string): Promise<boolean> => {
        const controller = new AbortController();
        const objectName = (saveAsName || chartObjectName()).trim();
        if (isNewChartPlaceholderName(objectName)) {
            warn('Grid builder: Cannot save until the chart name is updated from "new chart".');
            alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
            return false;
        }
        try {
            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=grid`;
            const namesResponse = await getData(namesUrl, controller.signal);
            const existingNames: string[] = (namesResponse?.success && Array.isArray(namesResponse?.data))
                ? (namesResponse.data as { object_name: string }[]).map((o) => (o.object_name || '').trim()).filter(Boolean)
                : [];
            const nameAlreadyExists = existingNames.some((n) => n.toLowerCase() === objectName.toLowerCase());
            const isUpdatingOwnChart = !saveAsName && loadedChartObjectName() !== null && (loadedChartObjectName() || '').trim().toLowerCase() === objectName.toLowerCase();
            if (nameAlreadyExists && !isUpdatingOwnChart) {
                warn('Grid builder: Save blocked - chart name already exists:', objectName);
                setChartNameError('duplicate');
                alert(`A chart named "${objectName}" already exists. Please choose a different name.`);
                return false;
            }
            setChartNameError(null);
            const updatedCharts = chartObjects.map(chart => ({
                ...chart,
                colorScheme: colorScheme(),
                cellContentType: cellContentType(),
                zaxis: { name: zAxisChannel(), type: "float" },
                series: chart.series.map(series => ({
                    ...series,
                    xaxis: { ...series.xaxis, interval: xAxisIntervals() },
                    yaxis: { ...series.yaxis, interval: yAxisIntervals() }
                }))
            }));
            const chartObject = {"parent_name": "grid", "chart_name": "default", "chart_info": updatedCharts, "shared": sharedFlag()};
            const summary_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'user_id': user().user_id, 'parent_name': 'grid', 'object_name': objectName, 'json': JSON.stringify(chartObject, null, 2)};

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
                        parent_name: 'grid',
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
                setSelectedMenu("GRID");
                setSelectedPage(objectName);
                navigate("/dashboard");
                return true;
            } else {
                const msg = (response_json as { message?: string; error?: string }).message ?? (response_json as { message?: string; error?: string }).error ?? 'Save failed. Please try again.';
                logError('Grid builder: Save failed:', response_json);
                alert(`Could not save grid: ${msg}`);
                return false;
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                return false;
            }
            logError("Error saving charts:", error);
            const message = error?.message ?? String(error);
            alert(`Failed to save grid: ${message}`);
            return false;
        }
    };

    const saveAsNewChart = async () => {
        const newName = prompt("Enter a new name for this grid:", `${chartObjectName()} Copy`);
        if (newName && newName.trim()) {
            const trimmed = newName.trim();
            if (isNewChartPlaceholderName(trimmed)) {
                warn('Grid builder: Cannot use "new chart" as the chart name.');
                alert('Please choose a different name. "New chart" is only a placeholder.');
                return;
            }
            const saved = await saveCharts(trimmed);
            if (saved) setHasChanges(false);
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
                'parent_name': 'grid', 
                'object_name': chartObjectName()
            };

            const response_json = await deleteData(`${apiEndpoints.app.users}/object`, delete_json, controller.signal);

            if (response_json.success) {
                log("Deleted successfully!");
                setSidebarMenuRefreshTrigger(1);
                // Chart configuration deleted successfully
                
                // Navigate back to dashboard
                setSelectedMenu("GRID");
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


    const handleRemoveChart = async (chartIndex) => {
        setChartObjects((prev) => prev.filter((_, i) => i !== chartIndex));
        setHasChanges(true);
    };

    const handleSaveChannels = async (axis, channels) => {
        const chartIndex = selectedChart();

        if (channels.length > 0) {
            // Only allow the first channel for scatter charts
            const channel = channels[0];
            
            if (axis === "zaxis") {
                // Handle z-axis channel selection
                setZAxisChannel(channel);
                updateGridSettings({ zaxis: { name: channel, type: "float" } });
            } else {
                // Use direct store update for better reactivity
                setChartObjects(chartIndex, "series", 0, axis, "name", channel);
                setChartObjects(chartIndex, "series", 0, axis, "type", "float");
            }

            setShowChannels(false);
            setHasChanges(true);
        } else {
            setShowChannels(false);
        }
    };


    const handleFitTypeChange = (chartIndex, fitType) => {
        setChartObjects(chartIndex, "series", 0, "fitType", fitType);
        setHasChanges(true);
    };

    const toggleFilter = (chartIndex, filter) => {
        setChartObjects((prev) => {
            const updatedCharts = [...prev];
            const chart = updatedCharts[chartIndex];
            const currentFilters = chart.filters || [];
            
            // Toggle the filter in the array
            let newFilters;
            if (currentFilters.includes(filter)) {
                newFilters = currentFilters.filter((f) => f !== filter); // Remove the filter
            } else {
                newFilters = [...currentFilters, filter]; // Add the filter
            }
            
            // Create a new chart object instead of mutating
            updatedCharts[chartIndex] = {
                ...chart,
                filters: newFilters
            };
            return updatedCharts;
        });
        setHasChanges(true);
    };

    onMount(async () => {
        await fetchCharts();
        // Initialize grid if no charts exist
        if (chartObjects.length === 0) {
            initializeGrid();
        }
        setLoading(false);
    });

    return (
        <div class="builder-page overflow-auto select-none">
            {loading() && <Loading />}
            <div class="mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-16" style={{
                "opacity": loading() ? 0 : 1, 
                "pointer-events": loading() ? "none" : "auto", 
                "transition": "opacity 0.3s ease",
                "min-width": "800px",
                "max-height": "100vh",
                "overflow-y": "auto"
            }}>
                {/* Header Section */}
                <div class="builder-page-header">
                    <div class="builder-page-title">
                        <div class="builder-page-title-content">
                            <h1 style="color: var(--color-text-primary);">Grid Chart Builder</h1>
                            <p style="color: var(--color-text-secondary);">Create and configure interactive grid plot visualizations</p>
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
                                        <h2 class="text-base font-semibold" style="color: var(--color-text-primary);">Chart Configuration</h2>
                                        <p class="text-xs" style="color: var(--color-text-secondary);">{chartType}</p>
                                    </div>
                                </div>
                                <div class="flex items-center space-x-3">
                                    <span class="inline-flex items-center px-2 py-1 rounded text-xs font-medium" style="background: var(--color-bg-tertiary); color: var(--color-text-secondary);">
                                        {chartObjects.length} chart{chartObjects.length !== 1 ? 's' : ''}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div class="builder-form-content">
                            <div class="flex flex-wrap items-start gap-6">
                                <div class="flex-1 min-w-[400px]">
                                    <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">
                                        Chart Name
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
                                        <option value={0}>🔒 Private - Only you can see this chart</option>
                                        <option value={1}>🌐 Public - Team mates can see this chart</option>
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
                            <h3 class="text-xl font-semibold mb-2" style="color: var(--color-text-primary);">Initializing Grid Chart</h3>
                            <p class="mb-8 max-w-md mx-auto" style="color: var(--color-text-secondary);">Setting up your grid analysis chart...</p>
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
                                                        <h3 class="text-base font-semibold" style="color: var(--color-text-primary);">Chart #{chartIndex() + 1}</h3>
                                                        <p class="text-xs" style="color: var(--color-text-secondary);">{chartType}</p>
                                                    </div>
                                                </div>
                                                <div class="flex items-center space-x-3">
                                                    <span class="inline-flex items-center px-2 py-1 rounded text-xs font-medium" style="background: var(--color-bg-tertiary); color: var(--color-text-secondary);">
                                                        Grid Analysis
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                        
                                        {/* Chart Content */}
                                        <div class="builder-form-content">
                                            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                                {/* Data Channels */}
                                                <div class="space-y-4">
                                                    <h4 style="color: var(--color-text-primary);">Data Channels</h4>
                                                    
                                                    <div class="space-y-4">
                                                        <div>
                                                            <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">X-Axis Channel</label>
                                                            <input
                                                                type="text"
                                                                value={chart.series?.[0]?.xaxis?.name || ""}
                                                                placeholder="Click to select x-axis channel"
                                                                onClick={() => {
                                                                    setSelectedChart(chartIndex);
                                                                    setShowChannels(true);
                                                                    setShowAxis("xaxis");
                                                                }}
                                                                readOnly
                                                                class="builder-form-input w-full px-4 py-2 text-sm cursor-pointer"
                                                            />
                                                        </div>
                                                        
                                                        <div>
                                                            <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">Y-Axis Channel</label>
                                                            <input
                                                                type="text"
                                                                value={chart.series?.[0]?.yaxis?.name || ""}
                                                                placeholder="Click to select y-axis channel"
                                                                onClick={() => {
                                                                    setSelectedChart(chartIndex);
                                                                    setShowChannels(true);
                                                                    setShowAxis("yaxis");
                                                                }}
                                                                readOnly
                                                                class="builder-form-input w-full px-4 py-2 text-sm cursor-pointer"
                                                            />
                                                        </div>
                                                        
                                                        <div>
                                                            <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">Z-Axis Channel (Cell Content)</label>
                                                            <select
                                                                value={cellContentType()}
                                                                onChange={(e) => {
                                                                    setCellContentType(e.target.value);
                                                                    updateGridSettings({ cellContentType: e.target.value });
                                                                }}
                                                                class="builder-form-input w-full px-4 py-2 text-sm"
                                                            >
                                                                {cellContentOptions.map(option => (
                                                                    <option value={option.value}>{option.label} - {option.description}</option>
                                                                ))}
                                                            </select>
                                                        </div>

                                                        {/* Z-Axis Channel Selection - show for statistical types that need a channel */}
                                                        <Show when={["channel_value", "min_value", "max_value", "std_value"].includes(cellContentType())}>
                                                            <div>
                                                                <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">Z-Axis Channel</label>
                                                                <input
                                                                    type="text"
                                                                    value={zAxisChannel()}
                                                                    placeholder="Click to select z-axis channel"
                                                                    onClick={() => {
                                                                        setSelectedChart(chartIndex);
                                                                        setShowChannels(true);
                                                                        setShowAxis("zaxis");
                                                                    }}
                                                                    readOnly
                                                                    class="builder-form-input w-full px-4 py-2 text-sm cursor-pointer"
                                                                />
                                                                <p style="color: var(--color-text-secondary);">Channel to calculate average values for each cell</p>
                                                            </div>
                                                        </Show>
                                                    </div>
                                                </div>

                                                {/* Chart Settings */}
                                                <div class="space-y-4">
                                                    <h4 style="color: var(--color-text-primary);">Chart Settings</h4>
                                                    
                                                    <div class="space-y-4">
                                                        <div>
                                                            <label style="color: var(--color-text-primary);">X-Axis Bin Interval</label>
                                                            <select
                                                                value={xAxisIntervals()}
                                                                onChange={(e) => {
                                                                    setXAxisIntervals(parseInt(e.target.value));
                                                                    updateGridSettings({ xAxisIntervals: parseInt(e.target.value) });
                                                                }}
                                                                class="builder-form-input"
                                                            >
                                                                <option value={1}>1</option>
                                                                <option value={2}>2</option>
                                                                <option value={5}>5</option>
                                                                <option value={10}>10</option>
                                                            </select>
                                                        </div>
                                                        
                                                        <div>
                                                            <label style="color: var(--color-text-primary);">Y-Axis Bin Interval</label>
                                                            <select
                                                                value={yAxisIntervals()}
                                                                onChange={(e) => {
                                                                    setYAxisIntervals(parseInt(e.target.value));
                                                                    updateGridSettings({ yAxisIntervals: parseInt(e.target.value) });
                                                                }}
                                                                class="builder-form-input"
                                                            >
                                                                <option value={1}>1</option>
                                                                <option value={2}>2</option>
                                                                <option value={5}>5</option>
                                                                <option value={10}>10</option>
                                                            </select>
                                                        </div>
                                                        
                                                        <div>
                                                            <label style="color: var(--color-text-primary);">Color Scheme</label>
                                                            <select
                                                                value={colorScheme()}
                                                                onChange={(e) => {
                                                                    setColorScheme(e.target.value);
                                                                    updateGridSettings({ colorScheme: e.target.value });
                                                                }}
                                                                class="builder-form-input"
                                                            >
                                                                {colorSchemeOptions.map(option => (
                                                                    <option value={option.value}>{option.label} - {option.description}</option>
                                                                ))}
                                                            </select>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Filters Section */}
                                            <div class="mt-6 pt-6 border-t" style="border-color: var(--color-border);">
                                                <h4 style="color: var(--color-text-primary);">Data Filters</h4>
                                                <div class="flex gap-1">
                                                    {["upwind", "downwind", "reaching", "port", "stbd"].map((filter) => (
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleFilter(chartIndex(), filter)}
                                                            class={`px-2 py-1 text-xs font-medium rounded transition-colors duration-200 ${
                                                                chart.filters?.includes(filter)
                                                                    ? "builder-form-button-success"
                                                                    : "builder-form-button-secondary"
                                                            }`}
                                                        >
                                                            {filter}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                    
                    {/* Save / Save As - show Save when hasChanges; disable when non-owner or placeholder */}
                    <div class="flex justify-center gap-3 mt-6">
                        {hasChanges() && (
                            <button
                                onClick={async (e) => {
                                    e.preventDefault();
                                    if (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) return;
                                    if (isNewChartPlaceholderName(chartObjectName())) {
                                        warn('Grid builder: Cannot save until the chart name is updated from "new chart".');
                                        alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
                                        return;
                                    }
                                    const saved = await saveCharts();
                                    if (saved) setHasChanges(false);
                                }}
                                class="builder-form-button-success px-6 py-3 font-semibold"
                                disabled={isNewChartPlaceholderName(chartObjectName()) || (loadedChartObjectName() !== null && !isOwnerOfLoadedChart())}
                                title={isNewChartPlaceholderName(chartObjectName()) ? 'Update the chart name before saving' : (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) ? 'Use Save As to save a copy under your name' : undefined}
                            >
                                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                                </svg>
                                Save Changes
                            </button>
                        )}
                        <Show when={loadedChartObjectName() !== null}>
                            <button
                                onClick={(e) => { e.preventDefault(); saveAsNewChart(); }}
                                class="builder-form-button px-6 py-3 font-semibold"
                            >
                                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path>
                                </svg>
                                Save As
                            </button>
                        </Show>
                    </div>

                    {/* Delete Button - only for owner when chart is loaded */}
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
                        onSave={(channels) => {
                            handleSaveChannels(showAxis(), channels);
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
