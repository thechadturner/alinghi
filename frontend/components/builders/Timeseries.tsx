import { createSignal, onMount, Show, createEffect, createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import { useNavigate } from "@solidjs/router";
import { For } from "solid-js/web";
import * as d3 from "d3";

import { AiOutlineArrowUp, AiOutlineArrowDown } from "solid-icons/ai"; // Importing icons
import Loading from "../utilities/Loading";
import ChannelPicker from "../utilities/FileChannelPicker"; // Import ChannelPicker
import ColorPicker from "../utilities/ColorPicker"; // Import ColorPicker
import DragHandleIcon from "./DragHandleIcon";
import { reorderSeries } from "../../utils/builderReorder";
import BackButton from "../buttons/BackButton";

import { getData, getTimezoneForDate, postData, deleteData, generateUniqueId } from "..\/..\/utils\/global";
import { error as logError, log, warn } from "../../utils/console";
import { isOwnerOfLoadedObject } from "../../utils/builderConstants";

/** Placeholder name for new charts; user must change it before saving. */
const NEW_CHART_PLACEHOLDER_NAME = 'new chart';

import { user } from "../../store/userStore"; 
import { persistantStore } from "../../store/persistantStore";
import { setSidebarMenuRefreshTrigger } from "../../store/globalStore";
import { apiEndpoints } from "@config/env";
const { selectedClassName, selectedProjectId, selectedPage, setSelectedPage, setSelectedMenu, selectedDate, selectedDatasetId, setSelectedSourceName } = persistantStore;

interface TimeSeriesBuilderProps {
    objectName?: string;
    isFleet?: boolean;
    type?: string;
    [key: string]: any;
}

export default function TimeSeriesBuilder(props: TimeSeriesBuilderProps) {
    const navigate = useNavigate();

    const chartType = 'TIME SERIES';
    
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
        
        // Use selectedPage from persistent store, or "new chart" so we never open with a timestamp/default
        const pageName = selectedPage();
        log('Using selectedPage from store:', pageName);
        return (pageName && pageName.trim()) ? pageName : NEW_CHART_PLACEHOLDER_NAME;
    };
    
    const [chartObjectName, setChartObjectName] = createSignal(getObjectName());
    const [isInitialized, setIsInitialized] = createSignal(false);
    
    // Only update chartObjectName from selectedPage on initial load
    // After that, let user edit freely without interference
    createEffect(() => {
        if (!isInitialized()) {
            const pageName = selectedPage();
            if (pageName && pageName !== chartObjectName()) {
                log('Initializing chartObjectName from selectedPage:', pageName);
                setChartObjectName(pageName);
            }
            setIsInitialized(true);
        }
    });
    const [sharedFlag, setSharedFlag] = createSignal(0); // 0 = PRIVATE, 1 = PUBLIC

    const [loading, setLoading] = createSignal(true);
    const [chartObjects, setChartObjects] = createStore<any[]>([]);
    const [hasChanges, setHasChanges] = createSignal(false);

    const [showChannels, setShowChannels] = createSignal(false);
    const [showColor, setShowColor] = createSignal(false);
    const [showAxis, setShowAxis] = createSignal("");
    /** Set when save was blocked because chart name already exists; cleared when user edits the name. */
    const [chartNameError, setChartNameError] = createSignal<'duplicate' | null>(null);
    /** Name of the chart when we loaded it (null for "new chart"); used to rename-in-place instead of creating a new object. */
    const [loadedChartObjectName, setLoadedChartObjectName] = createSignal<string | null>(null);
    /** True if the loaded chart is owned by the current user (from GET /object/names isMine); true when no chart loaded so Save is shown. */
    const [isOwnerOfLoadedChart, setIsOwnerOfLoadedChart] = createSignal(true);
    /** True while a save is in progress; used to show "Saving..." and disable the Save button. */
    const [saving, setSaving] = createSignal(false);

    const [selectedChart, setSelectedChart] = createSignal(0);
    const [selectedSeries, setSelectedSeries] = createSignal(0);
    
    // Track if we're editing a y-axis (for channel picker)
    const [editingYAxis, setEditingYAxis] = createSignal<{ chartIndex: number; seriesIndex: number } | null>(null);

    const [draggedIndex, setDraggedIndex] = createSignal<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = createSignal<number | null>(null);
    
    // Fleet mode: check if isFleet prop is true or fleet query parameter is present
    // Use createMemo to make it reactive to props changes
    const isFleet = createMemo((): boolean => {
        if (props?.isFleet === true || props?.type === 'fleet') {
            return true;
        }
        // Check URL parameter
        const urlParams = new URLSearchParams(window.location.search);
        const fleetParam = urlParams.get('fleet');
        return fleetParam === 'true' || fleetParam === '1';
    });
    
    // Available sources for fleet mode
    const [availableSources, setAvailableSources] = createSignal<Array<{ source_id: number; source_name: string }>>([]);

    const colors: string[] = [
        "#FF0000", "#0000FF", "#008000", "#FFA500", "#800080",  // Red, Blue, Green, Orange, Purple
        "#808080", "#000000", "#FFFF00", "#00FFFF", "#FF00FF",  // Grey, Black, Yellow, Cyan, Magenta
        "#A52A2A", "#4682B4", "#32CD32", "#FF4500", "#9400D3",  // Brown, Steel Blue, Lime Green, Orange Red, Dark Violet
        "#C0C0C0", "#2F4F4F", "#FFD700", "#20B2AA", "#DC143C",  // Silver, Dark Slate, Gold, Light Sea Green, Crimson
        "#8B4513", "#1E90FF", "#228B22", "#FF6347", "#DA70D6",  // Saddle Brown, Dodger Blue, Forest Green, Tomato, Orchid
      ];

    // Add a new chart
    const addChart = () => {
        const newChart = { 
            unique_id: generateUniqueId(),
            series: [] 
        } 
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
                    // Handle arrays specially (like series array)
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

    // Fetch available sources for fleet mode
    const fetchAvailableSources = async () => {
        if (!isFleet()) {
            return;
        }
        
        try {
            // Get date from selectedDate or from dataset
            let dateStr = selectedDate();
            
            // If no date from selectedDate, try to get it from dataset
            if (!dateStr && selectedDatasetId() > 0) {
                const datasetResponse = await getData(
                    `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`
                );
                if (datasetResponse.success && datasetResponse.data?.date) {
                    dateStr = datasetResponse.data.date;
                    // Convert YYYYMMDD to YYYY-MM-DD if needed
                    if (dateStr.length === 8 && !dateStr.includes('-')) {
                        dateStr = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
                    }
                }
            }
            
            if (!dateStr) {
                log('No date available for fetching sources');
                setAvailableSources([]);
                return;
            }
            
            const timezone = await getTimezoneForDate(selectedClassName(), Number(selectedProjectId()), dateStr);
            let url = `${apiEndpoints.app.datasets}/date/dataset_id?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(dateStr)}`;
            if (timezone) url += `&timezone=${encodeURIComponent(timezone)}`;
            const resp = await getData(url);
            
            if (resp && (resp.data || resp)) {
                const list = resp.data || resp;
                // Unique sources
                const seen = new Set();
                const sources = [];
                list.forEach((row) => {
                    const sid = Number(row.source_id ?? row.sourceId);
                    const sname = row.source_name ?? row.sourceName;
                    if (!Number.isNaN(sid) && sname && !seen.has(sid)) {
                        seen.add(sid);
                        sources.push({ source_id: sid, source_name: sname });
                    }
                });
                setAvailableSources(sources);
                log('Fetched available sources:', sources);
            } else {
                setAvailableSources([]);
            }
        } catch (error: any) {
            logError("Error fetching available sources:", error);
            setAvailableSources([]);
        }
    };

    const fetchCharts = async () => {
        const controller = new AbortController();
        
        try {
            // Skip when user not authenticated
            if (!user() || !user().user_id) {
                if (chartObjectName().trim().toLowerCase() === NEW_CHART_PLACEHOLDER_NAME) {
                    setChartObjects([{ unique_id: generateUniqueId(), series: [] }]);
                } else {
                    setChartObjects([]);
                }
                return;
            }
            // Skip API call when class/project not selected (e.g. direct URL open) so we still render the builder
            const className = selectedClassName();
            const projectId = selectedProjectId();
            if (!className || projectId == null || projectId === 0) {
                if (chartObjectName().trim().toLowerCase() === NEW_CHART_PLACEHOLDER_NAME) {
                    setChartObjects([{ unique_id: generateUniqueId(), series: [] }]);
                }
                setLoadedChartObjectName(null);
                setIsOwnerOfLoadedChart(true);
                return;
            }
            // Derive fleet from URL so the correct parent is used on first load (avoids empty chart when opening fleet_timeseries builder)
            const urlParams = new URLSearchParams(window.location.search);
            const fleetFromUrl = urlParams.get('fleet') === 'true' || urlParams.get('fleet') === '1';
            const parentName = (fleetFromUrl || isFleet()) ? "fleet_timeseries" : "timeseries";
            const response_json = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=${parentName}&object_name=${chartObjectName()}&page_name=${parentName}`, controller.signal);

            if (response_json.success) {
                try {
                    const loadedCharts = response_json.data?.chart_info || [];
                    // Ensure all charts have unique_id
                    const chartsWithIds = loadedCharts.map((chart: any) => ({
                        ...chart,
                        unique_id: chart.unique_id || generateUniqueId()
                    }));
                    setChartObjects(chartsWithIds.length > 0 ? chartsWithIds : []);
                    // When opening "new chart" with no saved data, start with one empty chart
                    if (chartsWithIds.length === 0 && chartObjectName().trim().toLowerCase() === NEW_CHART_PLACEHOLDER_NAME) {
                        setChartObjects([{ unique_id: generateUniqueId(), series: [] }]);
                        setLoadedChartObjectName(null);
                        setIsOwnerOfLoadedChart(true);
                    } else if (chartsWithIds.length > 0) {
                        setLoadedChartObjectName(chartObjectName());
                        try {
                            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user()!.user_id)}&parent_name=${parentName}`;
                            const namesRes = await getData(namesUrl, controller.signal);
                            const namesData = namesRes?.success ? namesRes.data : null;
                            const isOwner = isOwnerOfLoadedObject(namesData, chartObjectName());
                            setIsOwnerOfLoadedChart(isOwner);
                            if (parentName === 'fleet_timeseries' || !isOwner) {
                                const arr = Array.isArray(namesData) ? namesData as { object_name?: string; isMine?: number; ismine?: number }[] : [];
                                const match = arr.find((r) => (r.object_name || '').trim().toLowerCase() === (chartObjectName() || '').trim().toLowerCase());
                                log('Timeseries builder: ownership check', {
                                    parentName,
                                    objectName: chartObjectName(),
                                    isOwner,
                                    namesCount: arr.length,
                                    namesSuccess: namesRes?.success,
                                    matchingRow: match ? { object_name: match.object_name, isMine: match.isMine, ismine: match.ismine } : null,
                                });
                            }
                        } catch (_) {
                            setIsOwnerOfLoadedChart(true);
                        }
                    }
                    // Set shared flag if available
                    if (response_json.data?.shared !== undefined) {
                        setSharedFlag(response_json.data.shared);
                    }
                } catch (parseError) {
                    if (chartObjectName().trim().toLowerCase() === NEW_CHART_PLACEHOLDER_NAME) {
                        setChartObjects([{ unique_id: generateUniqueId(), series: [] }]);
                    } else {
                        setChartObjects([]);
                    }
                    setLoadedChartObjectName(null);
                    setIsOwnerOfLoadedChart(true);
                }
            } else {
                if (chartObjectName().trim().toLowerCase() === NEW_CHART_PLACEHOLDER_NAME) {
                    setChartObjects([{ unique_id: generateUniqueId(), series: [] }]);
                } else {
                    logError("Error loading charts...");
                    setChartObjects([]);
                }
                setLoadedChartObjectName(null);
                setIsOwnerOfLoadedChart(true);
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {

                return; // Don't set default state if aborted
            }
            logError("Error loading charts:", error.message);
            if (chartObjectName().trim().toLowerCase() === NEW_CHART_PLACEHOLDER_NAME) {
                setChartObjects([{ unique_id: generateUniqueId(), series: [] }]);
            } else {
                setChartObjects([]);
            }
            setLoadedChartObjectName(null);
            setIsOwnerOfLoadedChart(true);
        }
    };

    const isNewChartPlaceholderName = (name: string) => (name || '').trim().toLowerCase() === NEW_CHART_PLACEHOLDER_NAME;

    // Save and post charts. Returns true if save succeeded and we navigated away; false otherwise.
    const saveCharts = async (saveAsName?: string): Promise<boolean> => {
        log('Timeseries builder: saveCharts() called', { saveAsName, parentName: isFleet() ? 'fleet_timeseries' : 'timeseries' });
        const controller = new AbortController();

        try {
            const className = selectedClassName();
            const projectId = selectedProjectId();
            if (!className || projectId == null || projectId === 0) {
                warn('Timeseries builder: Cannot save - missing class or project context.');
                alert('Cannot save: no class or project selected. Please open the builder from the dashboard after choosing a project and class.');
                return false;
            }
            if (!user()?.user_id) {
                warn('Timeseries builder: Cannot save - user not authenticated.');
                alert('You must be signed in to save a chart.');
                return false;
            }
            const parentName = isFleet() ? "fleet_timeseries" : "timeseries";
            const objectName = (saveAsName || chartObjectName()).trim();
            if (isNewChartPlaceholderName(objectName)) {
                warn('Timeseries builder: Cannot save until the chart name is updated from "new chart".');
                alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
                return false;
            }
            // Block save if a chart with this name already exists (unless we're updating the same chart)
            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=${parentName}`;
            const namesResponse = await getData(namesUrl, controller.signal);
            const existingNames: string[] = (namesResponse?.success && Array.isArray(namesResponse?.data))
                ? (namesResponse.data as { object_name: string }[]).map((o) => (o.object_name || '').trim()).filter(Boolean)
                : [];
            const nameAlreadyExists = existingNames.some((n) => n.toLowerCase() === objectName.toLowerCase());
            const isUpdatingOwnChart = !saveAsName && loadedChartObjectName() !== null && (loadedChartObjectName() || '').trim().toLowerCase() === objectName.toLowerCase();
            if (nameAlreadyExists && !isUpdatingOwnChart) {
                warn('Timeseries builder: Save blocked - chart name already exists:', objectName);
                setChartNameError('duplicate');
                alert(`A chart named "${objectName}" already exists. Please choose a different name.`);
                return false;
            }
            setChartNameError(null);
            const chartObject = {"parent_name": parentName, "chart_name": "default", "chart_info": chartObjects, "shared": sharedFlag()};
            const summary_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'user_id': user().user_id, 'parent_name': parentName, 'object_name': objectName, 'json': JSON.stringify(chartObject, null, 2)};

            const response_json = await postData(`${apiEndpoints.app.users}/object`, summary_json, controller.signal);

            if (response_json.success) {
                log("Saved successfully!", JSON.stringify(chartObjects, null, 2));
                const previousName = loadedChartObjectName();
                const isRename = previousName !== null && previousName.trim().toLowerCase() !== objectName.toLowerCase();
                // Only delete old chart when doing a rename (same session, name changed), not when Save As (creating a copy)
                if (!saveAsName && isRename) {
                    const delete_json = {
                        class_name: selectedClassName(),
                        project_id: selectedProjectId(),
                        user_id: user().user_id,
                        parent_name: parentName,
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
                if (saveAsName) {
                    setChartObjectName(saveAsName);
                }
                setSidebarMenuRefreshTrigger(1);
                setSelectedMenu("TIME SERIES");
                setSelectedPage(objectName);
                navigate("/dashboard");
                return true;
            } else {
                const msg = (response_json as { message?: string; error?: string }).message ?? (response_json as { message?: string; error?: string }).error ?? 'Save failed. Please try again.';
                logError('Timeseries builder: Save failed:', response_json);
                alert(`Could not save chart: ${msg}`);
                return false;
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                return false;
            }
            logError("Error saving charts:", error);
            const message = error?.message ?? String(error);
            alert(`Failed to save chart: ${message}`);
            return false;
        }
    };
    
    // Save as new chart
    const saveAsNewChart = async () => {
        const newName = prompt("Enter a new name for this chart:", `${chartObjectName()} Copy`);
        if (newName && newName.trim()) {
            const trimmed = newName.trim();
            if (isNewChartPlaceholderName(trimmed)) {
                warn('Timeseries builder: Cannot use "new chart" as the chart name.');
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
            const parentName = isFleet() ? "fleet_timeseries" : "timeseries";
            const delete_json = {
                'class_name': selectedClassName(), 
                'project_id': selectedProjectId(),
                'user_id': user().user_id, 
                'parent_name': parentName, 
                'object_name': chartObjectName()
            };

            const response_json = await deleteData(`${apiEndpoints.app.users}/object`, delete_json, controller.signal);

            if (response_json.success) {
                log("Deleted successfully!");
                setSidebarMenuRefreshTrigger(1);
                // Load next available chart on explore page, or show create-new if none left
                const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=${parentName}`;
                try {
                    const namesResponse = await getData(namesUrl, controller.signal);
                    const namesList = namesResponse?.success && Array.isArray(namesResponse?.data) ? namesResponse.data as { object_name: string }[] : [];
                    if (namesList.length > 0) {
                        setSelectedPage(namesList[0].object_name);
                    } else {
                        setSelectedPage("");
                    }
                } catch (_) {
                    setSelectedPage("");
                }
                setSelectedMenu("TIME SERIES");
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

    const handleShowColor = async (chartIndex, seriesIndex) => {
        setSelectedChart(chartIndex);
        setSelectedSeries(seriesIndex);
        setShowColor(true);
    };

    const handleColor = async (color) => {
        try {
            const chartIndex = selectedChart();
            const seriesIndex = selectedSeries();

            log("Setting color:", color, "for chart:", chartIndex, "series:", seriesIndex);
            setChartObjects(chartIndex, "series", seriesIndex, "color", color);
            setSelectedChart(0);
            setSelectedSeries(0);
            setHasChanges(true);
            setShowColor(false);
        } catch (error: any) {
            logError("Error in handleColor:", error);
        }
    };

    const handleRemoveChannel = async (chartIndex, seriesIndex) => {
        log(seriesIndex)
        setChartObjects(chartIndex, "series", (prevSeries) => {
            const updatedSeries = prevSeries.filter((_, i) => i !== seriesIndex);
            if (updatedSeries.length === 0) {
                setChartObjects((prev) => prev.filter((_, i) => i !== chartIndex));
            }
            return updatedSeries;
        });
        setHasChanges(true);
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
        setEditingYAxis(null);
        setSelectedSeries(0);
        setDraggedIndex(null);
        setDragOverIndex(null);
    };

    const handleRemoveChart = async (chartIndex) => {
        setChartObjects((prev) => prev.filter((_, i) => i !== chartIndex));
        setHasChanges(true);
    };

    // Helper function to get color based on channel name
    const getColorForChannel = (channelName: string, defaultColor: string): string => {
        if (channelName.includes("_port")) {
            return "#FF0000"; // Red for port
        } else if (channelName.includes("_stbd")) {
            return "#008000"; // Green for starboard
        }
        return defaultColor;
    };

    const handleSaveChannels = async (axis, channels) => {
        const chartIndex = selectedChart();
        
        // If we're editing a y-axis
        const editing = editingYAxis();
        if (editing && channels.length > 0) {
            if (channels.length === 1) {
                // Single channel: update the existing series
                const channel = channels[0];
                updateChartObjects(
                    editing.chartIndex,
                    "series",
                    editing.seriesIndex,
                    "yaxis",
                    "name",
                    channel
                );
                updateChartObjects(editing.chartIndex, "series", editing.seriesIndex, "label", channel);
                
                // Auto-update color based on channel name
                const defaultColor = chartObjects[editing.chartIndex]?.series?.[editing.seriesIndex]?.color || d3.schemeCategory10[editing.seriesIndex % 10];
                const newColor = getColorForChannel(channel, defaultColor);
                if (newColor !== defaultColor) {
                    updateChartObjects(
                        editing.chartIndex,
                        "series",
                        editing.seriesIndex,
                        "color",
                        newColor
                    );
                }
            } else {
                // Multiple channels: update the first one, then add new series for the rest
                const firstChannel = channels[0];
                updateChartObjects(
                    editing.chartIndex,
                    "series",
                    editing.seriesIndex,
                    "yaxis",
                    "name",
                    firstChannel
                );
                updateChartObjects(editing.chartIndex, "series", editing.seriesIndex, "label", firstChannel);
                
                // Auto-update color for the first channel
                const defaultColor = chartObjects[editing.chartIndex]?.series?.[editing.seriesIndex]?.color || d3.schemeCategory10[editing.seriesIndex % 10];
                const newColor = getColorForChannel(firstChannel, defaultColor);
                if (newColor !== defaultColor) {
                    updateChartObjects(
                        editing.chartIndex,
                        "series",
                        editing.seriesIndex,
                        "color",
                        newColor
                    );
                }
                
                // Create new series for remaining channels
                const remainingChannels = channels.slice(1);
                const currentSeriesCount = chartObjects[editing.chartIndex]?.series?.length || 0;
                const newSeries = remainingChannels.map((channel, index) => {
                    const defaultSeriesColor = d3.schemeCategory10[(currentSeriesCount + index) % 10];
                    const series = {
                        xaxis: { name: "Datetime", type: "datetime" },
                        yaxis: { name: channel, type: "float" },
                        label: channel,
                        color: getColorForChannel(channel, defaultSeriesColor),
                        strokeWidth: 1,
                        strokeStyle: "solid",
                        data: [],
                    };
                    
                    // Add colorBySource default for fleet mode
                    if (isFleet()) {
                        series.colorBySource = "ALL";
                    }
                    
                    return series;
                });
                
                setChartObjects(editing.chartIndex, "series", (prevSeries) => [
                    ...prevSeries,
                    ...newSeries,
                ]);
            }
            setEditingYAxis(null);
            setShowChannels(false);
            setHasChanges(true);
            return;
        }

        // Adding new series (not editing existing)
        if (channels.length > 0) {
            const newSeries = channels.map((channel, index) => {
                const defaultSeriesColor = d3.schemeCategory10[(selectedSeries() + index) % 10];
                const series = {
                    xaxis: { name: "Datetime", type: "datetime" },
                    yaxis: { name: channel, type: "float" },
                    label: channel,
                    color: getColorForChannel(channel, defaultSeriesColor),
                    strokeWidth: 1,
                    strokeStyle: "solid",
                    data: [],
                };
                
                // Add colorBySource default for fleet mode
                if (isFleet()) {
                    series.colorBySource = "ALL";
                }
                
                return series;
            });
            setChartObjects(chartIndex, "series", (prevSeries) => [
                ...prevSeries,
                ...newSeries,
            ]);

            setShowChannels(false);
            setHasChanges(true);
        } else {
            setShowChannels(false);
        }
    };

    // Watch for selectedDate changes and refetch sources in fleet mode
    createEffect(async () => {
        if (isFleet() && selectedDate()) {
            await fetchAvailableSources();
        }
    });

    onMount(async () => {
        try {
            if (isFleet()) {
                await fetchAvailableSources();
            }
            await fetchCharts();
        } catch (err) {
            logError('Timeseries builder: load failed', err);
            if (chartObjectName().trim().toLowerCase() === NEW_CHART_PLACEHOLDER_NAME) {
                setChartObjects([{ unique_id: generateUniqueId(), series: [] }]);
            }
            setLoadedChartObjectName(null);
            setIsOwnerOfLoadedChart(true);
        } finally {
            setLoading(false);
        }
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
                            <h1>{isFleet() ? 'Fleet Time Series Chart Builder' : 'Time Series Chart Builder'}</h1>
                            <p>Create and configure interactive time series visualizations</p>
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
                                            const value = e.target.value;
                                            setChartObjectName(value);
                                            setChartNameError(null);
                                            setHasChanges(true);
                                        }}
                                        onChange={(e) => {
                                            const value = e.target.value;
                                            setChartObjectName(value);
                                            setChartNameError(null);
                                            setHasChanges(true);
                                        }}
                                        onFocus={(e) => {
                                            e.target.select();
                                        }}
                                        class={`builder-form-input w-full px-4 py-2 text-sm ${(isNewChartPlaceholderName(chartObjectName()) || chartNameError() === 'duplicate') ? 'builder-form-input-invalid' : ''}`}
                                        placeholder="Enter chart name"
                                        style="cursor: text;"
                                        autocomplete="off"
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
                            <h3 class="text-xl font-semibold mb-2" style="color: var(--color-text-primary);">No charts yet</h3>
                            <p class="mb-8 max-w-md mx-auto" style="color: var(--color-text-secondary);">Create your first time series chart to start visualizing your data</p>
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
                                                        {chart.series?.length || 0} series
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
                                                    <h4 style="color: var(--color-text-primary);">Data Series</h4>
                                                    <div class="w-[15%]">
                                                        <button
                                                            type="button"
                                                            onClick={async (e) => {
                                                                e.preventDefault();
                                                                setSelectedChart(chartIndex);
                                                                
                                                                // In fleet mode, set the first available source for channel picker
                                                                if (isFleet() && availableSources().length > 0) {
                                                                    const firstSource = availableSources()[0];
                                                                    if (firstSource && firstSource.source_name) {
                                                                        setSelectedSourceName(firstSource.source_name);
                                                                        log('Set selectedSourceName to first available source for channel picker:', firstSource.source_name);
                                                                    }
                                                                }
                                                                
                                                                setShowChannels(true);
                                                            }}
                                                            class="builder-form-button"
                                                        >
                                                            <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                                                            </svg>
                                                            Add Series
                                                        </button>
                                                    </div>
                                                </div>
                                                
                                                <div class="overflow-x-auto">
                                                    <table class="builder-table builder-table-timeseries min-w-full" style="table-layout: fixed; width: 100%;">
                                                        <colgroup>
                                                            <col style="width: 1.5rem;" />
                                                            <col style="width: 24%;" />
                                                            <col style="width: 24%;" />
                                                            <col style="width: 10%;" />
                                                            <Show when={isFleet()}>
                                                                <col style="width: 12%;" />
                                                            </Show>
                                                            <col style="width: 12%;" />
                                                            <col style="width: 16%;" />
                                                            <col style="width: 8%;" />
                                                        </colgroup>
                                                        <thead>
                                                            <tr>
                                                                <th class="w-6"></th>
                                                                <th style="width: 24%;">Y-Axis</th>
                                                                <th style="width: 24%;">Label</th>
                                                                <th style="width: 10%;">Color</th>
                                                                <Show when={isFleet()}>
                                                                    <th style="width: 12%;">Color By</th>
                                                                </Show>
                                                                <th style="width: 12%;">Line Thickness</th>
                                                                <th style="width: 16%;">Line Style</th>
                                                                <th style="width: 8%;">Actions</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            <For each={chart.series || []}>
                                                                {(seriesItem, seriesIndex) => (
                                                                    <tr
                                                                        draggable="true"
                                                                        onDragStart={(e) => handleDragStart(e, chartIndex, seriesIndex)}
                                                                        onDragEnd={handleDragEnd}
                                                                        onDragOver={(e) => handleDragOver(e, seriesIndex)}
                                                                        onDrop={(e) => handleDrop(e, chartIndex, seriesIndex)}
                                                                        class={dragOverIndex() === seriesIndex() ? "builder-row-drag-over" : ""}
                                                                    >
                                                                        <td class="builder-drag-handle-cell px-2 py-1">
                                                                            <DragHandleIcon />
                                                                        </td>
                                                                        <td class="px-3 py-1" style="width: 24%;">
                                                                            <input
                                                                                type="text"
                                                                                value={seriesItem?.yaxis?.name || ""}
                                                                                onClick={async (e) => {
                                                                                    e.preventDefault();
                                                                                    setEditingYAxis({ chartIndex: chartIndex(), seriesIndex: seriesIndex() });
                                                                                    setSelectedChart(chartIndex());
                                                                                    
                                                                                    // In fleet mode, set the first available source for channel picker
                                                                                    if (isFleet() && availableSources().length > 0) {
                                                                                        const firstSource = availableSources()[0];
                                                                                        if (firstSource && firstSource.source_name) {
                                                                                            setSelectedSourceName(firstSource.source_name);
                                                                                            log('Set selectedSourceName to first available source for channel picker:', firstSource.source_name);
                                                                                        }
                                                                                    }
                                                                                    
                                                                                    setShowChannels(true);
                                                                                }}
                                                                                onInput={(e) => {
                                                                                    if (seriesItem && seriesItem.yaxis) {
                                                                                        const newChannelName = e.target.value;
                                                                                        updateChartObjects(
                                                                                            chartIndex(),
                                                                                            "series",
                                                                                            seriesIndex(),
                                                                                            "yaxis",
                                                                                            "name",
                                                                                            newChannelName
                                                                                        );
                                                                                        updateChartObjects(chartIndex(), "series", seriesIndex(), "label", newChannelName);
                                                                                        
                                                                                        // Auto-update color based on channel name
                                                                                        // Only apply when channel name is changed (not on initial load)
                                                                                        if (newChannelName.includes("_port")) {
                                                                                            updateChartObjects(
                                                                                                chartIndex(),
                                                                                                "series",
                                                                                                seriesIndex(),
                                                                                                "color",
                                                                                                "#FF0000" // Red for port
                                                                                            );
                                                                                        } else if (newChannelName.includes("_stbd")) {
                                                                                            updateChartObjects(
                                                                                                chartIndex(),
                                                                                                "series",
                                                                                                seriesIndex(),
                                                                                                "color",
                                                                                                "#008000" // Green for starboard
                                                                                            );
                                                                                        }
                                                                                    }
                                                                                }}
                                                                                class="builder-form-input w-full px-3 py-2 text-sm"
                                                                                placeholder="Y-Axis Channel"
                                                                                title="Click to select channel"
                                                                            />
                                                                        </td>
                                                                        <td class="px-3 py-1" style="width: 24%;">
                                                                            <input
                                                                                type="text"
                                                                                value={seriesItem?.label ?? seriesItem?.yaxis?.name ?? ""}
                                                                                onInput={(e) => {
                                                                                    updateChartObjects(
                                                                                        chartIndex(),
                                                                                        "series",
                                                                                        seriesIndex(),
                                                                                        "label",
                                                                                        e.target.value
                                                                                    );
                                                                                }}
                                                                                class="builder-form-input w-full px-3 py-2 text-sm"
                                                                                placeholder="Label"
                                                                            />
                                                                        </td>
                                                                        <td class="px-2 py-1 text-center" style="width: 10%;">
                                                                            <div class="flex justify-center">
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={(e) => {
                                                                                        e.preventDefault();
                                                                                        if (seriesItem) {
                                                                                            handleShowColor(chartIndex(), seriesIndex());
                                                                                        }
                                                                                    }}
                                                                                    class="builder-form-color-picker w-8 h-8 rounded"
                                                                                    style={{ "background-color": seriesItem?.color || "#000" }}
                                                                                    title="Click to change color"
                                                                                >
                                                                                </button>
                                                                            </div>
                                                                        </td>
                                                                        <Show when={isFleet()}>
                                                                            <td class="px-2 py-1 text-center" style="width: 12%; min-width: 5rem;">
                                                                                <select
                                                                                    value={seriesItem?.colorBySource || "ALL"}
                                                                                    onChange={(e) => {
                                                                                        updateChartObjects(
                                                                                            chartIndex(),
                                                                                            "series",
                                                                                            seriesIndex(),
                                                                                            "colorBySource",
                                                                                            e.target.value
                                                                                        );
                                                                                    }}
                                                                                    class="builder-form-input w-full px-2 py-1 text-sm"
                                                                                    title="Color by source"
                                                                                >
                                                                                    <option value="ALL">ALL</option>
                                                                                    <For each={availableSources()}>
                                                                                        {(source) => (
                                                                                            <option value={source.source_name}>{source.source_name}</option>
                                                                                        )}
                                                                                    </For>
                                                                                </select>
                                                                            </td>
                                                                        </Show>
                                                                        <td class="px-2 py-1 text-center" style="width: 12%; min-width: 4rem;">
                                                                            <input
                                                                                type="number"
                                                                                min="0"
                                                                                max="5"
                                                                                step="1"
                                                                                value={seriesItem?.strokeWidth ?? 1}
                                                                                onInput={(e) => {
                                                                                    const value = parseInt(e.target.value) || 0;
                                                                                    const clampedValue = Math.max(0, Math.min(5, value));
                                                                                    updateChartObjects(
                                                                                        chartIndex(),
                                                                                        "series",
                                                                                        seriesIndex(),
                                                                                        "strokeWidth",
                                                                                        clampedValue
                                                                                    );
                                                                                }}
                                                                                class="builder-form-input w-full px-2 py-1 text-sm text-center"
                                                                                title="Line thickness (0-5)"
                                                                            />
                                                                        </td>
                                                                        <td class="px-2 py-1 text-center" style="width: 16%; min-width: 6rem;">
                                                                            <select
                                                                                value={seriesItem?.strokeStyle || "solid"}
                                                                                onChange={(e) => {
                                                                                    updateChartObjects(
                                                                                        chartIndex(),
                                                                                        "series",
                                                                                        seriesIndex(),
                                                                                        "strokeStyle",
                                                                                        e.target.value
                                                                                    );
                                                                                }}
                                                                                class="builder-form-input w-full px-2 py-1 text-sm"
                                                                                title="Line style"
                                                                            >
                                                                                <option value="solid">Solid</option>
                                                                                <option value="dashed">Dashed</option>
                                                                                <option value="dash-dash">Dash Dash</option>
                                                                                <option value="bigdash-dash">Bigdash Dash</option>
                                                                                <option value="dotted">Dotted</option>
                                                                                <option value="dash-dot">Dash Dot</option>
                                                                            </select>
                                                                        </td>
                                                                        <td class="px-2 py-1 text-center" style="width: 8%; min-width: 3rem;">
                                                                            <div class="flex justify-center">
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={(e) => {
                                                                                        e.preventDefault();
                                                                                        handleRemoveChannel(chartIndex(), seriesIndex());
                                                                                    }}
                                                                                    class="builder-form-icon-button-delete"
                                                                                    title="Remove series"
                                                                                >
                                                                                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                                                                                    </svg>
                                                                                </button>
                                                                            </div>
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
                                type="button"
                                onClick={async (e) => {
                                    e.preventDefault();
                                    log('Timeseries builder: Save Changes clicked');
                                    if (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) {
                                        warn('Timeseries builder: Save blocked - you do not own this chart.');
                                        alert('You cannot overwrite this chart. Use "Save As" to save a copy under your name.');
                                        return;
                                    }
                                    if (isNewChartPlaceholderName(chartObjectName())) {
                                        warn('Timeseries builder: Cannot save until the chart name is updated from "new chart".');
                                        alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
                                        return;
                                    }
                                    setSaving(true);
                                    try {
                                        const saved = await saveCharts();
                                        if (saved) setHasChanges(false);
                                    } finally {
                                        setSaving(false);
                                    }
                                }}
                                class="builder-form-button-success px-6 py-3 font-semibold"
                                disabled={saving() || isNewChartPlaceholderName(chartObjectName()) || (loadedChartObjectName() !== null && !isOwnerOfLoadedChart())}
                                title={isNewChartPlaceholderName(chartObjectName()) ? 'Update the chart name before saving' : (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) ? 'Use Save As to save a copy under your name' : undefined}
                            >
                                <Show when={!saving()} fallback={<span class="inline-flex items-center"><svg class="w-4 h-4 mr-2 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>Saving…</span>}>
                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                                    </svg>
                                    Save Changes
                                </Show>
                            </button>
                        )}
                        <Show when={loadedChartObjectName() !== null}>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    saveAsNewChart();
                                }}
                                class="builder-form-button px-6 py-3 font-semibold"
                            >
                                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path>
                                </svg>
                                Save As
                            </button>
                        </Show>
                    </div>

                    {/* Delete Button - only for owner when a chart is loaded */}
                    <Show when={loadedChartObjectName() !== null && isOwnerOfLoadedChart()}>
                        <div class="flex justify-center mt-4">
                            <button
                                type="button"
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

                <Show when={showColor()}>
                    <ColorPicker
                        colors={colors}
                        onSelect={(color) => {
                            handleColor(color); // Use indices from showColor
                        }}
                    />
                </Show>

                
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
