import { createSignal, onMount, Show, createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import { useNavigate } from "@solidjs/router";
import { For } from "solid-js/web";
import * as d3 from "d3";

import LoadingOverlay from "../utilities/Loading";
import ChannelPicker from "../utilities/FileChannelPicker"; // Import ChannelPicker
import DragHandleIcon from "./DragHandleIcon";
import { reorderSeries } from "../../utils/builderReorder";
import { warn, error as logError, log } from "../../utils/console";
import BackButton from "../buttons/BackButton";
import { NEW_CHART_PLACEHOLDER_NAME, isNewChartPlaceholderName, isOwnerOfLoadedObject } from "../../utils/builderConstants";

import { getData, postData, deleteData, generateUniqueId } from "..\/..\/utils\/global";

import { user } from "../../store/userStore"; 
import { unifiedDataStore } from "../../store/unifiedDataStore"; 
import { persistantStore } from "../../store/persistantStore";
import { setSidebarMenuRefreshTrigger } from "../../store/globalStore";
import { apiEndpoints } from "@config/env";
const { selectedClassName, selectedProjectId, selectedPage, setSelectedPage, setSelectedMenu } = persistantStore;

interface ParallelBuilderProps {
    objectName?: string;
    [key: string]: any;
}

export default function ParallelBuilder(props: ParallelBuilderProps) {
    const navigate = useNavigate();

    const chartType = 'PARALLEL';
    
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

    const [draggedIndex, setDraggedIndex] = createSignal<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = createSignal<number | null>(null);

    const defaultChart: any = {
        unique_id: generateUniqueId(),
        series: [], // Initialize without any channels
        data: [],
    };

    const fetchCharts = async (): Promise<void> => {
        const controller = new AbortController();
        
        try {
            // Check if user is available
            if (!user() || !user().user_id) {
                warn("User not available, skipping chart fetch");
                setChartObjects([defaultChart]);
                return;
            }
            
            const response_json = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=parallel&object_name=${chartObjectName()}&page_name=parallel`, controller.signal);

            if (response_json.success) {
                try {
                    const loadedCharts = response_json.data?.chart_info || [];
                    const chartsWithIds = loadedCharts.map((chart: any) => ({
                        ...chart,
                        unique_id: chart.unique_id || generateUniqueId()
                    }));
                    const hasData = chartsWithIds.length > 0;
                    setChartObjects(hasData ? chartsWithIds : [defaultChart]);
                    setLoadedChartObjectName(hasData ? chartObjectName() : null);
                    if (hasData) {
                        try {
                            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user()!.user_id)}&parent_name=parallel`;
                            const namesRes = await getData(namesUrl, controller.signal);
                            setIsOwnerOfLoadedChart(isOwnerOfLoadedObject(namesRes?.success ? namesRes.data : null, chartObjectName()));
                        } catch (_) {
                            setIsOwnerOfLoadedChart(true);
                        }
                    } else {
                        setIsOwnerOfLoadedChart(true);
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
        if (!user() || !user().user_id) {
            logError("User not available, cannot save charts");
            return;
        }
        const objectName = (saveAsName || chartObjectName()).trim();
        if (isNewChartPlaceholderName(objectName)) {
            warn('Parallel builder: Cannot save until the chart name is updated from "new chart".');
            alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
            return;
        }
        try {
            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=parallel`;
            const namesResponse = await getData(namesUrl, controller.signal);
            const existingNames: string[] = (namesResponse?.success && Array.isArray(namesResponse?.data))
                ? (namesResponse.data as { object_name: string }[]).map((o) => (o.object_name || '').trim()).filter(Boolean)
                : [];
            const nameAlreadyExists = existingNames.some((n) => n.toLowerCase() === objectName.toLowerCase());
            const isUpdatingOwnChart = !saveAsName && loadedChartObjectName() !== null && (loadedChartObjectName() || '').trim().toLowerCase() === objectName.toLowerCase();
            if (nameAlreadyExists && !isUpdatingOwnChart) {
                warn('Parallel builder: Save blocked - chart name already exists:', objectName);
                setChartNameError('duplicate');
                alert(`A chart named "${objectName}" already exists. Please choose a different name.`);
                return;
            }
            setChartNameError(null);
            const chartObject = {"parent_name": "parallel", "chart_name": "default", "chart_info": chartObjects, "shared": sharedFlag()};
            const summary_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'user_id': user().user_id, 'parent_name': 'parallel', 'object_name': objectName, 'json': JSON.stringify(chartObject, null, 2)};
            log("Saving parallel object:", JSON.stringify(chartObjects, null, 2));

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
                        parent_name: 'parallel',
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
                setSelectedMenu("PARALLEL");
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
        const newName = prompt("Enter a new name for this chart:", `${chartObjectName()} Copy`);
        if (newName && newName.trim()) {
            const trimmed = newName.trim();
            if (isNewChartPlaceholderName(trimmed)) {
                warn('Parallel builder: Cannot use "new chart" as the chart name.');
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
                'parent_name': 'parallel', 
                'object_name': chartObjectName()
            };

            const response_json = await deleteData(`${apiEndpoints.app.users}/object`, delete_json, controller.signal);

            if (response_json.success) {
                log("Deleted successfully!");
                setSidebarMenuRefreshTrigger(1);
                unifiedDataStore.clearAllData(); // Clear all data after deleting
                
                // Navigate back to dashboard
                setSelectedMenu("PARALLEL");
                setSelectedPage("");
                
                navigate("/dashboard");
            } else {
                logError("Delete failed:", response_json.message);
            }
        } catch (error: any) {
            logError("Error deleting chart:", error);
        }
    };

    const handleSaveChannels = async (axis, channels, chartIndex) => {
        if (channels.length > 0) {
            // Add each selected channel to the chart's series
            const newChannels = channels.map((channel, index) => ({
                channel: { name: channel, type: "float" },
            }));

            setChartObjects(chartIndex, "series", [
                ...(chartObjects[chartIndex]?.series || []), // Ensure series is an array
                ...newChannels,
            ]);

            setShowChannels(false);
            setHasChanges(true);
        } else {
            setShowChannels(false);
        }
    };


    // Add a new channel to the chart's series
    const addChannel = (chartIndex) => {
        setSelectedChart(chartIndex);
        setShowChannels(true); // Open the channel picker
        setShowAxis("channel");
    };

    const handleDragStart = (e: DragEvent, chartIndex: () => number, seriesIndex: () => number) => {
        setDraggedIndex(seriesIndex());
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("application/json", JSON.stringify({ chartIndex: chartIndex(), seriesIndex: seriesIndex() }));
    };
    const handleDragEnd = () => {
        setDraggedIndex(null);
        setDragOverIndex(null);
    };
    const handleDragOver = (e: DragEvent, seriesIndex: () => number) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        setDragOverIndex(seriesIndex());
    };
    const handleDrop = (e: DragEvent, chartIndex: () => number, seriesIndex: () => number) => {
        e.preventDefault();
        const chartIdx = chartIndex();
        const seriesIdx = seriesIndex();
        const draggedIdx = draggedIndex();
        if (draggedIdx === null || seriesIdx === undefined || draggedIdx === seriesIdx) return;
        const chart = chartObjects[chartIdx];
        if (!chart?.series) return;
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
        setLoading(false);
    });

    return (
        <div class="builder-page overflow-auto select-none">
            <Show when={loading()}>
                <LoadingOverlay 
                    message="Loading parallel plot builder..."
                    showProgress={true}
                    type="spinner"
                />
            </Show>
            
            <div class="mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-16" style={{
                "opacity": loading() ? 0 : 1, 
                "pointer-events": loading() ? "none" : "auto", 
                "transition": "opacity 0.3s ease",
                "min-width": "800px",
                "max-height": "100vh",
                "overflow-y": "auto"
            }}>
                {/* Header */}
                <div class="builder-page-header">
                    <div class="builder-page-title">
                        <div class="builder-page-title-content">
                            <h1>Parallel Plot Builder</h1>
                            <p>Create and manage parallel coordinate plots for data visualization</p>
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

                {/* Charts Section */}
                <Show when={chartObjects.length > 0} fallback={
                    <div class="text-center py-16">
                        <div class="mx-auto w-24 h-24 rounded-full flex items-center justify-center mb-6" style="background: var(--color-bg-tertiary);">
                            <svg class="w-12 h-12" style="color: var(--color-text-link);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                            </svg>
                        </div>
                        <h3 class="text-xl font-semibold mb-2" style="color: var(--color-text-primary);">No parallel plot data available</h3>
                        <p class="mb-8 max-w-md mx-auto" style="color: var(--color-text-secondary);">Parallel plots will be created automatically when you have data to display</p>
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
                           <span class="font-bold text-sm" style="color: var(--color-text-inverse);">P</span>
                       </div>
                       <div>
                           <h3 style="color: var(--color-text-primary);">PARALLEL</h3>
                       </div>
                   </div>
                                            <div class="flex items-center space-x-3">
                                                <span class="builder-form-badge">
                                                    {chart.series?.length || 0} channels
                                                </span>
                                            </div>
                                        </div>
                                        
                                    </div>

                                    {/* Chart Content */}
                                    <div class="p-6">
                                        <div class="space-y-4">
                                            <div class="flex items-center justify-between">
                                                <h4 style="color: var(--color-text-primary);">Channels</h4>
                                                <button
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        addChannel(chartIndex);
                                                    }}
                                                    class="builder-form-button parallel-builder-add-button"
                                                >
                                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                                                    </svg>
                                                    Add Channel
                                                </button>
                                            </div>
                                            
                                            <div class="border border-gray-200 rounded-lg overflow-hidden">
                                                <div class="max-h-96 overflow-y-auto">
                                                    <table class="builder-table parallel-builder-table">
                                                        <thead>
                                                            <tr>
                                                                <th class="w-10"></th>
                                                                <th>Channel</th>
                                                                <th>Actions</th>
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
                                                                        <td class="builder-drag-handle-cell px-6 py-4">
                                                                            <DragHandleIcon />
                                                                        </td>
                                                                        <td class="px-6 py-4">
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
                                                                                class="builder-form-input"
                                                                            />
                                                                        </td>
                                                                        <td class="px-6 py-4 text-center">
                                                                            <button
                                                                                onClick={() => {
                                                                                    setChartObjects(chartIndex(), "series", chart.series.filter((_, i) => i !== seriesIndex()));
                                                                                    setHasChanges(true);
                                                                                }}
                                                                                style="color: var(--color-text-secondary);"
                                                                                title="Delete channel"
                                                                            >
                                                                                <svg
                                                                                    xmlns="http://www.w3.org/2000/svg"
                                                                                    width="16"
                                                                                    height="16"
                                                                                    fill="currentColor"
                                                                                    viewBox="0 0 24 24"
                                                                                >
                                                                                    <path d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 2v1h4V5zm-3 3v11h10V8zM9 10a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z" />
                                                                                </svg>
                                                                            </button>
                                                                        </td>
                                                                    </tr>
                                                                )}
                                                            </For>
                                                        </tbody>
                                                    </table>
                                                </div>
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
                            onClick={(e) => {
                                e.preventDefault();
                                if (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) return;
                                if (isNewChartPlaceholderName(chartObjectName())) {
                                    warn('Parallel builder: Cannot save until the chart name is updated from "new chart".');
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

                <Show when={showChannels()}>
                    <ChannelPicker
                        onSave={(channel) => {
                            handleSaveChannels(showAxis(), channel, selectedChart());
                        }}
                    />
                </Show>

                <BackButton />
            </div>
        </div>
    );
}
