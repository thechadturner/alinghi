import { createSignal, onMount, Show, createEffect, createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import { useNavigate } from "@solidjs/router";
import { For } from "solid-js/web";
import * as d3 from "d3";

import { AiOutlineArrowUp, AiOutlineArrowDown } from "solid-icons/ai"; // Importing icons
import Loading from "../utilities/Loading";
import ChannelPicker from "../utilities/FileChannelPicker"; // Import ChannelPicker
import ColorPicker from "../utilities/ColorPicker"; // Import ColorPicker
import BackButton from "../buttons/BackButton";

import { getData, postData, deleteData, generateUniqueId } from "..\/..\/utils\/global";
import { error as logError, log, warn } from "../../utils/console";
import { NEW_CHART_PLACEHOLDER_NAME, isNewChartPlaceholderName, isOwnerOfLoadedObject } from "../../utils/builderConstants";

import { user } from "../../store/userStore"; 
import { unifiedDataStore } from "../../store/unifiedDataStore"; 
import { persistantStore } from "../../store/persistantStore";
import { setSidebarMenuRefreshTrigger } from "../../store/globalStore";
import { apiEndpoints } from "@config/env";
const { selectedClassName, selectedProjectId, selectedPage, setSelectedPage, setSelectedMenu } = persistantStore;

interface ScatterBuilderProps {
    objectName?: string;
    isFleet?: boolean;
    type?: string;
    [key: string]: any;
}

export default function ScatterBuilder(props: ScatterBuilderProps) {
    const navigate = useNavigate();

    const chartType = 'SCATTER';
    
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
    const [columns, setColumns] = createSignal(0); // 0 = Auto

    const [loading, setLoading] = createSignal(true);
    const [chartObjects, setChartObjects] = createStore<any[]>([]);
    const [hasChanges, setHasChanges] = createSignal(false);

    const [showChannels, setShowChannels] = createSignal(false);
    const [showColor, setShowColor] = createSignal(false);
    const [showAxis, setShowAxis] = createSignal("");
    const [chartNameError, setChartNameError] = createSignal<'duplicate' | null>(null);
    const [loadedChartObjectName, setLoadedChartObjectName] = createSignal<string | null>(null);
    const [isOwnerOfLoadedChart, setIsOwnerOfLoadedChart] = createSignal(true);

    const [selectedChart, setSelectedChart] = createSignal(0);
    const [selectedSeries, setSelectedSeries] = createSignal(0);

    // Fleet mode: use fleet_scatter parent when in day/fleet mode
    const isFleet = createMemo((): boolean => {
        if (props?.isFleet === true || props?.type === 'fleet') return true;
        const urlParams = new URLSearchParams(window.location.search);
        const fleetParam = urlParams.get('fleet');
        return fleetParam === 'true' || fleetParam === '1';
    });
    const parentName = createMemo(() => (isFleet() ? 'fleet_scatter' : 'scatter'));

    const colors: string[] = [
        "#FF0000", "#0000FF", "#008000", "#FFA500", "#800080",  // Red, Blue, Green, Orange, Purple
        "#808080", "#000000", "#FFFF00", "#00FFFF", "#FF00FF",  // Grey, Black, Yellow, Cyan, Magenta
        "#A52A2A", "#4682B4", "#32CD32", "#FF4500", "#9400D3",  // Brown, Steel Blue, Lime Green, Orange Red, Dark Violet
        "#C0C0C0", "#2F4F4F", "#FFD700", "#20B2AA", "#DC143C",  // Silver, Dark Slate, Gold, Light Sea Green, Crimson
        "#8B4513", "#1E90FF", "#228B22", "#FF6347", "#DA70D6",  // Saddle Brown, Dodger Blue, Forest Green, Tomato, Orchid
      ];

    const colorTypeOptions: string[] = ["Fixed", "By Channel"];
    const fitTypeOptions: string[] = ["None", "Linear", "Poly 2", "Poly 3", "Loess 0.3", "Loess 0.5"];

    // Add a new chart
    const addChart = (): void => {
        const newChart = {
            unique_id: generateUniqueId(),
            series: [
                {
                    xaxis: { name: "", type: "float" },
                    yaxis: { name: "", type: "float" },
                    color: d3.schemeCategory10[chartObjects.length % 10],
                    colorType: "Fixed",
                    colorChannel: { name: "", type: "float" },
                    fitType: "None",
                    data: [],
                },
            ],
            filters: [],
        }; 
        setChartObjects([...chartObjects, newChart]);
        setHasChanges(true);
    };

    // Move chart up or down
    const moveChart = (index, direction) => {
        const targetIndex = direction === "up" ? index() - 1 : index() + 1;
        if (targetIndex < 0 || targetIndex >= chartObjects.length) return;

        setChartObjects((prev) => {
            const updatedCharts = [...prev];
            const [movedChart] = updatedCharts.splice(index(), 1); // Remove the chart at the current index
            updatedCharts.splice(targetIndex, 0, movedChart); // Insert it at the target index
            return updatedCharts;
        });
        setHasChanges(true);
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
            const response_json = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=${parentName()}&object_name=${chartObjectName()}&page_name=${parentName()}`, controller.signal);

            if (response_json.success) {
                try {
                    const loadedCharts = response_json.data?.chart_info || [];
                    const chartsWithIds = loadedCharts.map((chart: any) => ({
                        ...chart,
                        unique_id: chart.unique_id || generateUniqueId()
                    }));
                    setChartObjects(chartsWithIds);
                    if (chartsWithIds.length > 0) {
                        setLoadedChartObjectName(chartObjectName());
                        try {
                            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user()!.user_id)}&parent_name=${parentName()}`;
                            const namesRes = await getData(namesUrl, controller.signal);
                            setIsOwnerOfLoadedChart(isOwnerOfLoadedObject(namesRes?.success ? namesRes.data : null, chartObjectName()));
                        } catch (_) {
                            setIsOwnerOfLoadedChart(true);
                        }
                    } else {
                        setLoadedChartObjectName(null);
                        setIsOwnerOfLoadedChart(true);
                    }
                    if (response_json.data?.shared !== undefined) {
                        setSharedFlag(response_json.data.shared);
                    }
                    if (response_json.data?.columns !== undefined) {
                        setColumns(response_json.data.columns);
                    }
                } catch (parseError: any) {
                    setChartObjects([]);
                    setLoadedChartObjectName(null);
                    setIsOwnerOfLoadedChart(true);
                }
            } else {
                logError("Error loading charts...");
                setChartObjects([]);
                setLoadedChartObjectName(null);
                setIsOwnerOfLoadedChart(true);
            }
        } catch (err: any) {
            if (err.name === 'AbortError') {

                return; // Don't set default state if aborted
            }
            logError("Error loading charts:", err.message);
            setChartObjects([]);
            setLoadedChartObjectName(null);
            setIsOwnerOfLoadedChart(true);
        }
    };

    // Save and post charts (optional saveAsName for Save As flow)
    const saveCharts = async (saveAsName?: string) => {
        const controller = new AbortController();
        const objectName = (saveAsName || chartObjectName()).trim();
        if (isNewChartPlaceholderName(objectName)) {
            warn('Scatter builder: Cannot save until the chart name is updated from "new chart".');
            alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
            return;
        }
        try {
            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=${parentName()}`;
            const namesResponse = await getData(namesUrl, controller.signal);
            const existingNames: string[] = (namesResponse?.success && Array.isArray(namesResponse?.data))
                ? (namesResponse.data as { object_name: string }[]).map((o) => (o.object_name || '').trim()).filter(Boolean)
                : [];
            const nameAlreadyExists = existingNames.some((n) => n.toLowerCase() === objectName.toLowerCase());
            const isUpdatingOwnChart = !saveAsName && loadedChartObjectName() !== null && (loadedChartObjectName() || '').trim().toLowerCase() === objectName.toLowerCase();
            if (nameAlreadyExists && !isUpdatingOwnChart) {
                warn('Scatter builder: Save blocked - chart name already exists:', objectName);
                setChartNameError('duplicate');
                alert(`A chart named "${objectName}" already exists. Please choose a different name.`);
                return;
            }
            setChartNameError(null);
            const chartObject = {"parent_name": parentName(), "chart_name": objectName, "chart_info": chartObjects, "shared": sharedFlag(), "columns": columns()};
            const summary_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'user_id': user().user_id, 'parent_name': parentName(), 'object_name': objectName, 'json': JSON.stringify(chartObject, null, 2)};

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
                        parent_name: parentName(),
                        object_name: previousName
                    };
                    try {
                        await deleteData(`${apiEndpoints.app.users}/object`, delete_json, controller.signal);
                        log("Renamed: removed old object name", previousName);
                    } catch (deleteErr: any) {
                        logError("Failed to remove old chart name after rename:", deleteErr);
                    }
                }
                setLoadedChartObjectName(objectName);
                if (saveAsName) setChartObjectName(saveAsName);
                setSidebarMenuRefreshTrigger(1);
                setSelectedMenu("SCATTER");
                setSelectedPage(objectName);
                navigate("/dashboard");
            } else {

            }
        } catch (err: any) {
            if (err.name === 'AbortError') {

                return;
            }
            logError("Error saving charts:", err);
        }
    };

    const saveAsNewChart = async () => {
        const newName = prompt("Enter a new name for this chart:", `${chartObjectName()} Copy`);
        if (newName && newName.trim()) {
            const trimmed = newName.trim();
            if (isNewChartPlaceholderName(trimmed)) {
                warn('Scatter builder: Cannot use "new chart" as the chart name.');
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
                'parent_name': parentName(), 
                'object_name': chartObjectName()
            };

            const response_json = await deleteData(`${apiEndpoints.app.users}/object`, delete_json, controller.signal);

            if (response_json.success) {
                log("Deleted successfully!");
                setSidebarMenuRefreshTrigger(1);
                unifiedDataStore.clearAllData(); // Clear all data after deleting
                
                // Navigate back to dashboard
                setSelectedMenu("SCATTER");
                setSelectedPage("");
                
                navigate("/dashboard");
            } else {
                logError("Delete failed:", response_json.message);
            }
        } catch (err: any) {
            if (err.name === 'AbortError') {
                return;
            }
            logError("Error deleting chart:", err);
        }
    };

    const handleShowColor = async (chartIndex, seriesIndex) => {
        setSelectedChart(chartIndex);
        setSelectedSeries(seriesIndex);
        setShowColor(true);
    };

    const handleColor = async (color) => {
        try {
            const chartIndex = selectedChart();
            const seriesIndex = selectedSeries();

            setChartObjects(chartIndex, "series", seriesIndex, "color", color);
            setSelectedChart(0);
            setSelectedSeries(0);
            setHasChanges(true);
            setShowColor(false);
        } catch (err: any) {
            logError("Error in handleColor:", err);
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
            
            // Use direct store update for better reactivity
            setChartObjects(chartIndex, "series", 0, axis, "name", channel);
            setChartObjects(chartIndex, "series", 0, axis, "type", "float");

            setShowChannels(false);
            setHasChanges(true);
        } else {
            setShowChannels(false);
        }
    };

    const handleColorTypeChange = (chartIndex, colorType) => {
        setChartObjects(chartIndex, "series", 0, "colorType", colorType);
        
        // Initialize appropriate color field based on type
        if (colorType === "Fixed") {
            // Set a default color if none exists
            const currentColor = chartObjects[chartIndex]?.series?.[0]?.color;
            if (!currentColor) {
                setChartObjects(chartIndex, "series", 0, "color", d3.schemeCategory10[chartIndex % 10]);
            }
        } else if (colorType === "By Channel") {
            // Initialize colorChannel if it doesn't exist
            if (!chartObjects[chartIndex]?.series?.[0]?.colorChannel) {
                setChartObjects(chartIndex, "series", 0, "colorChannel", { name: "", type: "float" });
            }
        }
        
        setHasChanges(true);
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
                            <h1>Scatter Chart Builder</h1>
                            <p>Create and configure interactive scatter plot visualizations</p>
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
                                <div class="min-w-[150px]">
                                    <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">
                                        Layout Columns
                                    </label>
                                    <select
                                        value={columns()}
                                        onChange={(e) => {
                                            setColumns(parseInt(e.target.value));
                                            setHasChanges(true);
                                        }}
                                        class="builder-form-input w-full px-4 py-2 text-sm"
                                    >
                                        <option value={0}>Auto</option>
                                        <option value={1}>1 Column</option>
                                        <option value={2}>2 Columns</option>
                                        <option value={3}>3 Columns</option>
                                        <option value={4}>4 Columns</option>
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
                            <h3 class="text-xl font-semibold mb-2" style="color: var(--color-text-primary);">No charts yet</h3>
                            <p class="mb-8 max-w-md mx-auto" style="color: var(--color-text-secondary);">Create your first scatter chart to start visualizing your data</p>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    addChart();
                                }}
                                class="builder-form-button px-6 py-3 font-semibold"
                            >
                                <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                                </svg>
                                Create First Chart
                            </button>
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
                                                        {chart.filters?.length || 0} filters
                                                    </span>
                                                    <div class="flex items-center space-x-1">
                                                        <button
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                moveChart(chartIndex, "up");
                                                            }}
                                                            class="builder-form-icon-button builder-form-icon-compact"
                                                            title="Move up"
                                                        >
                                                            <AiOutlineArrowUp size={14} />
                                                        </button>
                                                        <button
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                moveChart(chartIndex, "down");
                                                            }}
                                                            class="builder-form-icon-button builder-form-icon-compact"
                                                            title="Move down"
                                                        >
                                                            <AiOutlineArrowDown size={14} />
                                                        </button>
                                                        <button
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                handleRemoveChart(chartIndex());
                                                            }}
                                                            class="builder-form-icon-button-delete"
                                                            title="Remove chart"
                                                        >
                                                            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                                                            </svg>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        
                                        {/* Chart Content */}
                                        <div class="builder-form-content">
                                            <div class="space-y-3">
                                                <div class="flex items-center justify-between">
                                                    <h4 style="color: var(--color-text-primary);">Data Configuration</h4>
                                                </div>
                                                
                                                <div class="overflow-x-auto">
                                                    <table class="builder-table min-w-full" style="table-layout: fixed; width: 100%;">
                                                        <colgroup>
                                                            <col style="width: 20%;" />
                                                            <col style="width: 20%;" />
                                                            <col style="width: 20%;" />
                                                            <col style="width: 20%;" />
                                                            <col style="width: 20%;" />
                                                        </colgroup>
                                                        <thead>
                                                            <tr>
                                                                <th>X-Axis</th>
                                                                <th>Y-Axis</th>
                                                                <th>Color Type</th>
                                                                <th>Color</th>
                                                                <th>Fit Type</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            <tr>
                                                                <td class="px-3 py-2">
                                                                    <input
                                                                        type="text"
                                                                        value={chart.series?.[0]?.xaxis?.name || ""}
                                                                        placeholder="Click to select X-axis channel"
                                                                        onClick={() => {
                                                                            if (chart.series?.[0]) {
                                                                                setSelectedChart(chartIndex);
                                                                                setShowChannels(true);
                                                                                setShowAxis("xaxis");
                                                                            }
                                                                        }}
                                                                        readOnly
                                                                        class="builder-form-input w-full px-3 py-2 text-sm cursor-pointer"
                                                                    />
                                                                </td>
                                                                <td class="px-3 py-2">
                                                                    <input
                                                                        type="text"
                                                                        value={chart.series?.[0]?.yaxis?.name || ""}
                                                                        placeholder="Click to select Y-axis channel"
                                                                        onClick={() => {
                                                                            if (chart.series?.[0]) {
                                                                                setSelectedChart(chartIndex);
                                                                                setShowChannels(true);
                                                                                setShowAxis("yaxis");
                                                                            }
                                                                        }}
                                                                        readOnly
                                                                        class="builder-form-input w-full px-3 py-2 text-sm cursor-pointer"
                                                                    />
                                                                </td>
                                                                <td class="px-3 py-0">
                                                                    <select
                                                                        value={chart.series?.[0]?.colorType || "Fixed"}
                                                                        onChange={(e) => handleColorTypeChange(chartIndex(), e.target.value)}
                                                                        class="builder-form-input w-full px-3 py-2 text-sm"
                                                                    >
                                                                        {colorTypeOptions.map(option => (
                                                                            <option value={option}>{option}</option>
                                                                        ))}
                                                                    </select>
                                                                </td>
                                                                <td class="px-3 py-0">
                                                                    <Show when={chart.series?.[0]?.colorType === "Fixed"}>
                                                                        <div class="flex items-center justify-center">
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => {
                                                                                    if (chart.series?.[0]) {
                                                                                        handleShowColor(chartIndex(), 0);
                                                                                    }
                                                                                }}
                                                                                class="builder-form-color-picker w-8 h-8 rounded"
                                                                                style={{ "background-color": chart.series?.[0]?.color || "#000" }}
                                                                                title="Click to change color"
                                                                            >
                                                                            </button>
                                                                        </div>
                                                                    </Show>
                                                                    <Show when={chart.series?.[0]?.colorType === "By Channel"}>
                                                                        <input
                                                                            type="text"
                                                                            value={chart.series?.[0]?.colorChannel?.name || ""}
                                                                            placeholder="Click to select color channel"
                                                                            onClick={() => {
                                                                                if (chart.series?.[0]) {
                                                                                    setSelectedChart(chartIndex);
                                                                                    setShowChannels(true);
                                                                                    setShowAxis("colorChannel");
                                                                                }
                                                                            }}
                                                                            readOnly
                                                                            class="builder-form-input w-full px-3 py-2 text-sm cursor-pointer"
                                                                        />
                                                                    </Show>
                                                                    <Show when={!chart.series?.[0]?.colorType}>
                                                                        <div class="text-center text-gray-400 text-sm py-2">
                                                                            Select type
                                                                        </div>
                                                                    </Show>
                                                                </td>
                                                                <td class="px-3 py-2">
                                                                    <select
                                                                        value={chart.series?.[0]?.fitType || "None"}
                                                                        onChange={(e) => handleFitTypeChange(chartIndex(), e.target.value)}
                                                                        class="builder-form-input w-full px-3 py-2 text-sm"
                                                                    >
                                                                        {fitTypeOptions.map(option => (
                                                                            <option value={option}>{option}</option>
                                                                        ))}
                                                                    </select>
                                                                </td>
                                                            </tr>
                                                        </tbody>
                                                    </table>
                                                </div>

                                                {/* Filters Section */}
                                                <div>
                                                    <h4 style="color: var(--color-text-primary);">Chart Filters</h4>
                                                    <div class="flex gap-2">
                                                        {["upwind", "downwind", "reaching", "port", "stbd"].map((filter) => (
                                                            <button
                                                                type="button"
                                                                onClick={() => toggleFilter(chartIndex(), filter)}
                                                                class={`px-3 py-1 text-xs font-medium rounded-full transition-colors duration-200 ${
                                                                    chart.filters?.includes(filter)
                                                                        ? "bg-green-100 text-green-700 border border-green-200"
                                                                        : "bg-gray-100 text-gray-700 border border-gray-200 hover:bg-gray-200"
                                                                }`}
                                                            >
                                                                {filter}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                        
                        {/* Add Chart Button */}
                        <div class="flex justify-center mt-6">
                            <button
                                onClick={(e) => {
                                    e.preventDefault();
                                    addChart();
                                }}
                                class="builder-form-button px-6 py-3 font-semibold"
                            >
                                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                                </svg>
                                Add Chart
                            </button>
                        </div>
                    </Show>
                    
                    {/* Save / Save As - show Save when hasChanges; disable when non-owner or placeholder */}
                    <div class="flex justify-center gap-3 mt-6">
                        {hasChanges() && (
                            <button
                                onClick={(e) => {
                                    e.preventDefault();
                                    if (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) return;
                                    if (isNewChartPlaceholderName(chartObjectName())) {
                                        warn('Scatter builder: Cannot save until the chart name is updated from "new chart".');
                                        alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
                                        return;
                                    }
                                    saveCharts();
                                    setHasChanges(false);
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
                                class="builder-form-button-danger"
                            >
                                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                                </svg>
                                Delete Chart
                            </button>
                        </div>
                    </Show>
                </form>

                <Show when={showColor()}>
                    <ColorPicker
                        colors={colors}
                        onSelect={(color) => {
                            handleColor(color);
                        }}
                    />
                </Show>

                
                <Show when={showChannels()}>
                    <ChannelPicker
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
