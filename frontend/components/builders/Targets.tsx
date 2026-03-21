import { createSignal, onMount, Show, createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import { useNavigate } from "@solidjs/router";
import { For } from "solid-js/web";

import Loading from "../utilities/Loading";
import TargetPicker from "../utilities/TargetPicker"; // Import TargetPicker for target channels
import DragHandleIcon from "./DragHandleIcon";
import { reorderSeries } from "../../utils/builderReorder";
import BackButton from "../buttons/BackButton";

import { getData, postData, deleteData, generateUniqueId } from "..\/..\/utils\/global";
import { persistantStore } from "../../store/persistantStore";
import { setSidebarMenuRefreshTrigger } from "../../store/globalStore";
import { warn, error as logError, log } from "../../utils/console";
import { NEW_CHART_PLACEHOLDER_NAME, isNewChartPlaceholderName, isOwnerOfLoadedObject } from "../../utils/builderConstants";
import { user } from "../../store/userStore";
import { apiEndpoints } from "@config/env";
const { selectedClassName, selectedProjectId, selectedPage, setSelectedPage, setSelectedMenu } = persistantStore;

interface TargetsBuilderProps {
    objectName?: string;
    [key: string]: any;
}

export default function TargetsBuilder(props: TargetsBuilderProps = {}) {
    const navigate = useNavigate();

    const chartType = 'TARGETS';
    /** Default object name used by the target page; builder uses this when no URL/selectedPage so it loads the same config. */
    const TARGETS_DEFAULT_OBJECT_NAME = 'targets_default';

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
        
        // Use selectedPage from persistent store, or default to targets_default (same as target page) so the builder loads the same object
        const pageName = selectedPage();
        log('Using selectedPage from store:', pageName);
        return (pageName && pageName.trim()) ? pageName : TARGETS_DEFAULT_OBJECT_NAME;
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
    
    const [sharedFlag, setSharedFlag] = createSignal(1); // 0 = PRIVATE, 1 = PUBLIC

    const [loading, setLoading] = createSignal(true);
    const [groupObjects, setGroupObjects] = createStore<any[]>([]); 
    const [hasChanges, setHasChanges] = createSignal(false);
    const [showChannels, setShowChannels] = createSignal(false);
    const [showAxis, setShowAxis] = createSignal("");
    const [chartNameError, setChartNameError] = createSignal<'duplicate' | null>(null);
    const [loadedChartObjectName, setLoadedChartObjectName] = createSignal<string | null>(null);
    const [isOwnerOfLoadedChart, setIsOwnerOfLoadedChart] = createSignal(true);
    const [selectedGroup, setSelectedGroup] = createSignal(0); // Track the selected group index
    const [selectedSeries, setSelectedSeries] = createSignal(0); // Track the selected series index

    const [draggedIndex, setDraggedIndex] = createSignal<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = createSignal<number | null>(null);

    // Add a new group with an initial chart
    const addGroup = (): void => {
        const newGroup = {
            name: `Group ${groupObjects.length + 1}`, // Default group name
            charts: [
                {
                    unique_id: generateUniqueId(),
                    series: [], // Initialize with no series
                    filters: [],
                },
            ],
        };
        setGroupObjects([...groupObjects, newGroup]);
        setHasChanges(true);
    };

    // Update group name
    const updateGroupName = (groupIndex: number, newName: string): void => {
        setGroupObjects(groupIndex, "name", newName);
        setHasChanges(true);
    };

    // Delete a group
    const deleteGroup = (groupIndex: number): void => {
        setGroupObjects((prev) => prev.filter((_, i) => i !== groupIndex));
        setHasChanges(true);
    };

    const fetchCharts = async () => {
        const controller = new AbortController();
        
        try {
            // Check if user is available
            if (!user() || !user().user_id) {
                warn("User not available, skipping chart fetch");
                setGroupObjects([]);
                return;
            }
            
            const url = `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=targets&object_name=${chartObjectName()}`;
            log("Fetching charts from URL:", url);
            log("User:", user());
            log("Selected class name:", selectedClassName());
            log("Selected project ID:", selectedProjectId());
            
            const response_json = await getData(url, controller.signal);

            if (response_json.success) {
                try {
                    const loadedGroups = response_json.data?.chart_info || [];
                    const groupsWithIds = loadedGroups.map((group: any) => ({
                        ...group,
                        charts: (group.charts || []).map((chart: any) => ({
                            ...chart,
                            unique_id: chart.unique_id || generateUniqueId(),
                            series: (chart.series || []).map((series: any) => ({
                                ...series,
                                info_type: series.info_type || "info",
                                info_message: series.info_message ?? "",
                            }))
                        }))
                    }));
                    setGroupObjects(groupsWithIds);
                    const loadedName = groupsWithIds.length > 0 ? chartObjectName() : null;
                    setLoadedChartObjectName(loadedName);
                    if (loadedName !== null) {
                        try {
                            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user()!.user_id)}&parent_name=targets`;
                            const namesRes = await getData(namesUrl, controller.signal);
                            setIsOwnerOfLoadedChart(isOwnerOfLoadedObject(namesRes?.success ? namesRes.data : null, loadedName));
                        } catch (_) {
                            setIsOwnerOfLoadedChart(true);
                        }
                    } else {
                        setIsOwnerOfLoadedChart(true);
                    }
                    if (response_json.data?.shared !== undefined) {
                        setSharedFlag(response_json.data.shared);
                    } else {
                        setSharedFlag(0);
                    }
                } catch (parseError) {
                    log("Error parsing chart data, starting with empty state:", parseError);
                    setGroupObjects([]);
                    setLoadedChartObjectName(null);
                    setIsOwnerOfLoadedChart(true);
                }
            } else {
                if (response_json.data === null && response_json.message?.includes('No objects found')) {
                    log("No chart object found, starting with empty state");
                } else {
                    logError("Error loading charts:", response_json.message || "Unknown error");
                }
                setGroupObjects([]);
                setLoadedChartObjectName(null);
                setIsOwnerOfLoadedChart(true);
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                return;
            }
            logError("Error loading charts:", error);
            setGroupObjects([]);
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
            warn('Targets builder: Cannot save until the chart name is updated from "new chart".');
            alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
            return;
        }
        try {
            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=targets`;
            const namesResponse = await getData(namesUrl, controller.signal);
            const existingNames: string[] = (namesResponse?.success && Array.isArray(namesResponse?.data))
                ? (namesResponse.data as { object_name: string }[]).map((o) => (o.object_name || '').trim()).filter(Boolean)
                : [];
            const nameAlreadyExists = existingNames.some((n) => n.toLowerCase() === objectName.toLowerCase());
            const isUpdatingOwnChart = !saveAsName && loadedChartObjectName() !== null && (loadedChartObjectName() || '').trim().toLowerCase() === objectName.toLowerCase();
            if (nameAlreadyExists && !isUpdatingOwnChart) {
                warn('Targets builder: Save blocked - chart name already exists:', objectName);
                setChartNameError('duplicate');
                alert(`A chart named "${objectName}" already exists. Please choose a different name.`);
                return;
            }
            setChartNameError(null);
            const chartObject = {"page_name": "targets", "chart_name": "default", "chart_info": groupObjects, "shared": sharedFlag()};
            const summary_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(), 'user_id': user().user_id, 'parent_name': 'targets', 'object_name': objectName, 'json': JSON.stringify(chartObject, null, 2)};
            log("Saving targets object:", JSON.stringify(groupObjects, null, 2));

            const response_json = await postData(apiEndpoints.app.users + '/object', summary_json, controller.signal);

            if (response_json.success) {
                log("Saved successfully!", JSON.stringify(groupObjects, null, 2));
                const previousName = loadedChartObjectName();
                const isRename = !saveAsName && previousName !== null && previousName.trim().toLowerCase() !== objectName.toLowerCase();
                if (isRename) {
                    const delete_json = {
                        class_name: selectedClassName(),
                        project_id: selectedProjectId(),
                        user_id: user().user_id,
                        parent_name: 'targets',
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
                setSelectedMenu("TARGETS");
                setSelectedPage(objectName);
                navigate("/dashboard");
            } else {
                log("Save Failed -", response_json.message);
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                return;
            }
            logError("Error saving charts:", error);
        }
    };

    const saveAsNewChart = async () => {
        const newName = prompt("Enter a new name for this targets chart:", `${chartObjectName()} Copy`);
        if (newName && newName.trim()) {
            const trimmed = newName.trim();
            if (isNewChartPlaceholderName(trimmed)) {
                warn('Targets builder: Cannot use "new chart" as the chart name.');
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
                'parent_name': 'targets', 
                'object_name': chartObjectName()
            };

            const response_json = await deleteData(`${apiEndpoints.app.users}/object`, delete_json, controller.signal);

            if (response_json.success) {
                log("Deleted successfully!");
                setSidebarMenuRefreshTrigger(1);
                // Chart configuration deleted successfully
                
                // Navigate back to dashboard
                setSelectedMenu("TARGETS");
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

    const handleSaveChannels = async (axis, channels, groupIndex) => {
        if (channels.length > 0) {
            if (axis === "yaxisEdit") {
                // Update the channel name (yaxis) for the selected series when edited via picker
                // Only take the first channel since we're editing a single channel
                const channel = channels[0];
                setGroupObjects(groupIndex, "charts", 0, "series", (series = []) => {
                    const updatedSeries = [...series];
                    const selectedIndex = selectedSeries();
                    if (selectedIndex >= 0 && selectedIndex < updatedSeries.length) {
                        updatedSeries[selectedIndex] = {
                            ...updatedSeries[selectedIndex],
                            yaxis: { name: channel, type: "float" },
                        };
                    }
                    return updatedSeries;
                });
            } else {
                channels.forEach((channel) => {
                    setGroupObjects(groupIndex, "charts", 0, "series", (series = []) => {
                        if (axis === "yaxis") {
                            // Add to the main channel (yaxis)
                            return [
                                ...series,
                                {
                                    yaxis: { name: channel, type: "float" },
                                    info_type: "info",
                                    info_message: "",
                                },
                            ];
                        }
                        return series;
                    });
                });
            }
            
            setShowChannels(false);
            setHasChanges(true);
        } else {
            setShowChannels(false);
        }
    };

    const handleUpdateChannelName = (groupIndex, seriesIndex, newName) => {
        setGroupObjects(groupIndex, "charts", 0, "series", seriesIndex, "yaxis", "name", newName);
        setHasChanges(true);
    };

    const handleUpdateInfoType = (groupIndex: number, seriesIndex: number, newType: string) => {
        setGroupObjects(groupIndex, "charts", 0, "series", seriesIndex, "info_type", newType);
        setHasChanges(true);
    };

    const handleUpdateInfoMessage = (groupIndex: number, seriesIndex: number, newMessage: string) => {
        setGroupObjects(groupIndex, "charts", 0, "series", seriesIndex, "info_message", newMessage);
        setHasChanges(true);
    };

    const toggleFilter = (groupIndex, chartIndex, filter) => {
        setGroupObjects(groupIndex, "charts", chartIndex, "filters", (filters = []) => {
            // Toggle the filter in the array
            if (filters.includes(filter)) {
                return filters.filter((f) => f !== filter); // Remove the filter
            } else {
                return [...filters, filter]; // Add the filter
            }
        });
        setHasChanges(true);
    };

    const handleRemoveChannel = (groupIndex, seriesIndex) => {
        setGroupObjects(groupIndex, "charts", 0, "series", (series = []) =>
            series.filter((_, i) => i !== seriesIndex)
        );
        setHasChanges(true);
    };

    const handleDragStart = (e: DragEvent, groupIndex: () => number, seriesIndex: () => number) => {
        setDraggedIndex(seriesIndex());
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("application/json", JSON.stringify({ groupIndex: groupIndex(), seriesIndex: seriesIndex() }));
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
    const handleDrop = (e: DragEvent, groupIndex: () => number, seriesIndex: () => number) => {
        e.preventDefault();
        const groupIdx = groupIndex();
        const seriesIdx = seriesIndex();
        const draggedIdx = draggedIndex();
        if (draggedIdx === null || seriesIdx === undefined || draggedIdx === seriesIdx) return;
        const group = groupObjects[groupIdx];
        const seriesList = group?.charts?.[0]?.series;
        if (!seriesList) return;
        const newSeries = reorderSeries(seriesList, draggedIdx, seriesIdx);
        setGroupObjects(groupIdx, "charts", 0, "series", newSeries);
        setHasChanges(true);
        setSelectedSeries(0);
        setDraggedIndex(null);
        setDragOverIndex(null);
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
                            <h1>Targets Builder</h1>
                            <p>Create and manage target groups for data visualization</p>
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
                                        {groupObjects.length} group{groupObjects.length !== 1 ? 's' : ''}
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
                                        readOnly
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
                                        disabled
                                        class="builder-form-input w-full px-4 py-2 text-sm"
                                    >
                                        <option value={0}>🔒 Private - Only you can see this chart</option>
                                        <option value={1}>🌐 Public - Team mates can see this chart</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>
                    <Show when={groupObjects.length > 0} fallback={
                        <div class="text-center py-16">
                            <div class="mx-auto w-24 h-24 rounded-full flex items-center justify-center mb-6" style="background: var(--color-bg-tertiary);">
                                <svg class="w-12 h-12" style="color: var(--color-text-link);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                                </svg>
                            </div>
                            <h3 class="text-xl font-semibold mb-2" style="color: var(--color-text-primary);">No target groups yet</h3>
                            <p class="mb-8 max-w-md mx-auto" style="color: var(--color-text-secondary);">Create your first target group to start organizing your data</p>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    addGroup();
                                }}
                                class="builder-form-button px-6 py-3 font-semibold"
                            >
                                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                                </svg>
                                Add Group
                            </button>
                        </div>
                    }>
                        <div class="builder-chart-container">
                            <For each={groupObjects}>
                                {(group, groupIndex) => {
                                    return (
                                        <div class="builder-form-card">
                                            {/* Group Header */}
                                            <div class="builder-form-header">
                                                <div class="flex items-center justify-between">
                                                    <div class="flex items-center space-x-3">
                                                        <div class="w-8 h-8 bg-blue-600 rounded-md flex items-center justify-center">
                                                            <span class="text-white font-bold text-sm">{groupIndex() + 1}</span>
                                                        </div>
                                                        <div class="flex-1">
                                                            <input
                                                                type="text"
                                                                value={group.name}
                                                                placeholder="Enter Group Name"
                                                                onInput={(e) => updateGroupName(groupIndex(), e.target.value)}
                                                                class="builder-form-input"
                                                            />
                                                        </div>
                                                    </div>
                                                    <div class="flex items-center space-x-3">
                                                        <span class="builder-form-badge">
                                                            {group.charts[0]?.series?.length || 0} channels
                                                        </span>
                                                        <button
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                deleteGroup(groupIndex());
                                                            }}
                                                            class="builder-form-button-danger p-2"
                                                            title="Delete Group"
                                                        >
                                                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                                                            </svg>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                            {/* Group Content */}
                                            <div class="p-4">
                                                {/* Channels Table - Full Width */}
                                                <div class="mb-6">
                                                    <h4 style="color: var(--color-text-primary);">Channels</h4>
                                                    <div class="overflow-x-auto border border-gray-200 rounded-lg">
                                                        <table class="builder-table builder-table-timeseries min-w-full" style={{ "table-layout": "fixed", width: "100%" }}>
                                                            <colgroup>
                                                                <col style="width: 1.5rem;" />
                                                                <col style="width: 38%;" />
                                                                <col style="width: 12%;" />
                                                                <col style="width: 36%;" />
                                                                <col style="width: 12%;" />
                                                            </colgroup>
                                                            <thead>
                                                                <tr>
                                                                    <th class="w-6"></th>
                                                                    <th style="width: 38%;">Channel</th>
                                                                    <th style="width: 12%;">Info Type</th>
                                                                    <th style="width: 36%;">Info Msg</th>
                                                                    <th style="width: 12%;">Actions</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                            <For each={group.charts[0]?.series || []}>
                                                                {(seriesItem, seriesIndex) => (
                                                                    <tr
                                                                        draggable="true"
                                                                        onDragStart={(e) => handleDragStart(e, groupIndex, seriesIndex)}
                                                                        onDragEnd={handleDragEnd}
                                                                        onDragOver={(e) => handleDragOver(e, seriesIndex)}
                                                                        onDrop={(e) => handleDrop(e, groupIndex, seriesIndex)}
                                                                        class={dragOverIndex() === seriesIndex() ? "builder-row-drag-over" : ""}
                                                                    >
                                                                            <td class="builder-drag-handle-cell px-2 py-2">
                                                                                <DragHandleIcon />
                                                                            </td>
                                                                            <td class="px-3 py-2" style="width: 38%;">
                                                                                <input
                                                                                    type="text"
                                                                                    value={seriesItem?.yaxis?.name || ""}
                                                                                    placeholder="Select Channel"
                                                                                    onInput={(e) => {
                                                                                        handleUpdateChannelName(groupIndex(), seriesIndex(), e.target.value);
                                                                                    }}
                                                                                    onClick={() => {
                                                                                        setSelectedGroup(groupIndex()); // Set the selected group
                                                                                        setSelectedSeries(seriesIndex()); // Set the selected series
                                                                                        setShowChannels(true); // Show the TargetPicker
                                                                                        setShowAxis("yaxisEdit"); // Set axis to edit channel
                                                                                    }}
                                                                                    class="builder-form-input cursor-pointer w-full"
                                                                                />
                                                                            </td>
                                                                            <td class="px-2 py-2" style="width: 12%;">
                                                                                <select
                                                                                    value={seriesItem?.info_type || "info"}
                                                                                    onChange={(e) => {
                                                                                        handleUpdateInfoType(groupIndex(), seriesIndex(), e.target.value);
                                                                                    }}
                                                                                    class="builder-form-input w-full"
                                                                                >
                                                                                    <option value="info">info</option>
                                                                                    <option value="warning">warning</option>
                                                                                </select>
                                                                            </td>
                                                                            <td class="px-3 py-2" style="width: 36%;">
                                                                                <input
                                                                                    type="text"
                                                                                    value={seriesItem?.info_message ?? ""}
                                                                                    placeholder="Info message"
                                                                                    onInput={(e) => {
                                                                                        handleUpdateInfoMessage(groupIndex(), seriesIndex(), e.target.value);
                                                                                    }}
                                                                                    class="builder-form-input w-full"
                                                                                />
                                                                            </td>
                                                                            <td class="px-2 py-2 text-center" style="width: 12%;">
                                                                            <svg
                                                                                xmlns="http://www.w3.org/2000/svg"
                                                                                width="20"
                                                                                height="20"
                                                                                class="inline-block"
                                                                                fill="gray"
                                                                                viewBox="0 0 24 24"
                                                                                onClick={() => handleRemoveChannel(groupIndex(), seriesIndex())}
                                                                                style={{ cursor: "pointer" }}
                                                                            >
                                                                                <path d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 2v1h4V5zm-3 3v11h10V8zM9 10a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 1 1 1-1zm6 0a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z" />
                                                                            </svg>
                                                                        </td>
                                                                    </tr>
                                                                )}
                                                            </For>
                                                        </tbody>
                                                        </table>
                                                    </div>
                                                </div>
                                                
                                                {/* Add Channel Button - Above Filters, Aligned Right */}
                                                <div class="mt-6 flex justify-end">
                                                    <button
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            setSelectedGroup(groupIndex()); // Set the selected group
                                                            setShowChannels(true); // Show the TargetPicker
                                                            setShowAxis("yaxis"); // Set axis to channels
                                                        }}
                                                        class="builder-form-button"
                                                    >
                                                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                                                        </svg>
                                                        Add Channel
                                                    </button>
                                                </div>
                                                
                                                {/* Filters Section - Below Add Channel Button */}
                                                <div class="mt-6">
                                                    <h4 style="color: var(--color-text-primary);">Filters</h4>
                                                    <div class="flex flex-wrap gap-2">
                                                        {["Upwind", "Downwind", "Reaching", "Port", "Starboard"].map((filter) => (
                                                            <span
                                                                class={`px-3 py-1 rounded-full text-xs cursor-pointer transition-colors duration-200 ${
                                                                    group.charts[0]?.filters?.includes(filter.toLowerCase())
                                                                        ? "bg-green-500 text-white"
                                                                        : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                                                                }`}
                                                                onClick={() => toggleFilter(groupIndex(), 0, filter.toLowerCase())}
                                                            >
                                                                {filter}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                }}
                            </For>
                            {/* Add Group Button */}
                            <div class="flex justify-end mt-6">
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        addGroup();
                                    }}
                                    class="builder-form-button"
                                >
                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                                    </svg>
                                    Add Group
                                </button>
                            </div>
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
                                        warn('Targets builder: Cannot save until the chart name is updated from "new chart".');
                                        alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
                                        return;
                                    }
                                    saveCharts();
                                    setHasChanges(false);
                                }}
                                class="builder-form-button-success"
                                disabled={isNewChartPlaceholderName(chartObjectName()) || (loadedChartObjectName() !== null && !isOwnerOfLoadedChart())}
                                title={isNewChartPlaceholderName(chartObjectName()) ? 'Update the chart name before saving' : (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) ? 'Use Save As to save a copy under your name' : undefined}
                            >
                                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                                </svg>
                                Save Changes
                            </button>
                        )}
                        {/* Save As disabled for now */}
                        <Show when={false}>
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

                    {/* Delete disabled for now */}
                    <Show when={false}>
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
                    <TargetPicker
                        selection={[]}
                        onSave={(channel) => {
                            handleSaveChannels(showAxis(), channel, selectedGroup()); 
                        }}
                    />
                </Show>

                <BackButton />
            </div>
        </div>
    );
}
