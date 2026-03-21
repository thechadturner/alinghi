import { createSignal, onMount, Show, onCleanup, createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import { useNavigate, useLocation } from "@solidjs/router";
import { For } from "solid-js/web";
import * as d3 from "d3";

import Loading from "../utilities/Loading";
import ChannelPicker from "../utilities/FileChannelPicker"; // Import ChannelPicker
import DragHandleIcon from "./DragHandleIcon";
import { reorderSeries } from "../../utils/builderReorder";
import { warn, error as logError, log } from "../../utils/console";
import ColorPicker from "../utilities/ColorPicker"; // Import ColorPicker
import BackButton from "../buttons/BackButton";
import { NEW_CHART_PLACEHOLDER_NAME, isNewChartPlaceholderName, isOwnerOfLoadedObject } from "../../utils/builderConstants";

import { getData, postData, deleteData, generateUniqueId } from "../../utils/global";

import { user } from "../../store/userStore"; 
import { persistantStore } from "../../store/persistantStore";
import { setSidebarMenuRefreshTrigger } from "../../store/globalStore";
import { apiEndpoints } from "@config/env";
const { selectedClassName, selectedProjectId } = persistantStore;

interface OverlayBuilderProps {
    objectName?: string;
    [key: string]: any;
}

interface Position {
    x: number;
    y: number;
}

export default function OverlayBuilder(props: OverlayBuilderProps) {
    const navigate = useNavigate();
    const location = useLocation();

    const chartType = 'OVERLAY';
    
    // Get object name from URL parameters, props, or persistent store
    const getObjectName = (): string => {
        // First check URL parameters from location (reactive)
        const urlParams = new URLSearchParams(location.search);
        const urlObjectName = urlParams.get('object_name');
        
        if (urlObjectName) {
            log('Using object_name from URL:', urlObjectName);
            return urlObjectName;
        }
        
        if (props?.objectName) {
            log('Using objectName from props:', props.objectName);
            return props.objectName;
        }
        
        return NEW_CHART_PLACEHOLDER_NAME;
    };

    /** True when opened from fleet map: only Fleet Data Table overlay type is allowed (URL has object_name=fleet_datatable or fleet_map=1) */
    const isFleetMapOnly = (): boolean => {
        const urlParams = new URLSearchParams(location.search);
        if (urlParams.get('object_name') === 'fleet_datatable') return true;
        const fm = urlParams.get('fleet_map');
        return fm === '1' || fm === 'true';
    };

    /** Parent name for user_objects API: fleet_map when building fleet datatable overlay, else overlay */
    const getOverlayParentName = (): string => (isFleetMapOnly() ? 'fleet_map' : 'overlay');

    /** Object name for user_objects API: default when building fleet datatable overlay, else overlay display name */
    const getOverlayObjectNameForApi = (): string => (isFleetMapOnly() ? 'default' : (overlayName() || chartObjectName()).trim());

    const [chartObjectName, setChartObjectName] = createSignal(getObjectName());
    
    // Watch for URL parameter changes and reload overlay
    createEffect(() => {
        const currentObjectName = getObjectName();
        const currentChartObjectName = chartObjectName();
        
        // If URL parameter changed, update and reload
        if (currentObjectName !== currentChartObjectName) {
            log('Overlay Builder: URL parameter changed, reloading overlay:', currentObjectName);
            setChartObjectName(currentObjectName);
            setLoading(true);
            fetchCharts().finally(() => {
                setLoading(false);
                // Reinitialize drag and position after loading
                setTimeout(() => {
                    updateOverlayPosition();
                    initializeDrag();
                }, 200);
            });
        }
    });

    // When opened from fleet map, ensure all charts are FleetDataTable type
    createEffect(() => {
        if (!isFleetMapOnly() || chartObjects.length === 0) return;
        chartObjects.forEach((chart, index) => {
            if ((chart.overlayType || "TextBox") !== "FleetDataTable") {
                setChartObjects(index, "overlayType", "FleetDataTable");
                setHasChanges(true);
            }
        });
    });

    const [overlayName, setOverlayName] = createSignal('');
    const [nameWarning, setNameWarning] = createSignal('');
    const [chartNameError, setChartNameError] = createSignal<'duplicate' | null>(null);
    const [loadedChartObjectName, setLoadedChartObjectName] = createSignal<string | null>(null);
    const [isOwnerOfLoadedChart, setIsOwnerOfLoadedChart] = createSignal(true);

    const [loading, setLoading] = createSignal(true);
    const [chartObjects, setChartObjects] = createStore<any[]>([]);
    const [hasChanges, setHasChanges] = createSignal(false);

    const [showChannels, setShowChannels] = createSignal(false);
    const [showColor, setShowColor] = createSignal(false);
    const [showAxis, setShowAxis] = createSignal("");

    const [selectedChart, setSelectedChart] = createSignal(0);
    const [selectedSeries, setSelectedSeries] = createSignal(0);

    const [draggedIndex, setDraggedIndex] = createSignal<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = createSignal<number | null>(null);
    const [colorPickerType, setColorPickerType] = createSignal(""); // "channel" or "background"

    // Orientation and position state
    const [orientation, setOrientation] = createSignal<"horizontal" | "vertical">("horizontal"); // "horizontal" or "vertical"
    const [position, setPosition] = createSignal<Position>({ x: 50, y: 50 }); // Position in percentage
    let previewContainerRef: HTMLElement | null = null;
    let overlayElementRef: HTMLElement | null = null;
    let dragBehavior: any = null;

    const colors: string[] = [
        "#FF0000", "#0000FF", "#008000", "#FFA500", "#800080",  // Red, Blue, Green, Orange, Purple
        "#808080", "#000000", "#FFFF00", "#00FFFF", "#FF00FF",  // Grey, Black, Yellow, Cyan, Magenta
        "#A52A2A", "#4682B4", "#32CD32", "#FF4500", "#9400D3",  // Brown, Steel Blue, Lime Green, Orange Red, Dark Violet
        "#C0C0C0", "#2F4F4F", "#FFD700", "#20B2AA", "#DC143C",  // Silver, Dark Slate, Gold, Light Sea Green, Crimson
        "#8B4513", "#1E90FF", "#228B22", "#FF6347", "#DA70D6",  // Saddle Brown, Dodger Blue, Forest Green, Tomato, Orchid
    ];

    const defaultChart = {
        unique_id: generateUniqueId(),
        series: [], // Initialize without any channels
        data: [],
        overlayName: "Overlay 1",
        overlayType: "TextBox", // Default to TextBox
        backgroundColor: "#FFFFFF",
        opacity: 1.0,
        orientation: "horizontal",
        position: { x: 50, y: 50 }
    };

    /** Default chart when in fleet-map-only mode (Fleet Data Table only); vertical = sources as rows, channels as columns (expected layout) */
    const defaultFleetDataTableChart = () => ({
        ...defaultChart,
        unique_id: generateUniqueId(),
        overlayName: "Fleet Data Table",
        overlayType: "FleetDataTable" as const,
        orientation: "vertical" as const
    });

    const fetchCharts = async () => {
        const controller = new AbortController();
        
        try {
            // Check if user is available
            if (!user() || !user().user_id) {
                warn("User not available, skipping chart fetch");
                setChartObjects([defaultChart]);
                return;
            }

            const objectName = chartObjectName();
            let overlayObjectName = objectName;
            const parentName = getOverlayParentName();
            const objectNameForApi = isFleetMapOnly() ? 'default' : overlayObjectName;

            // Handle "Create New Overlay" or placeholder case
            if (!isFleetMapOnly() && (objectName === 'Create New Overlay' || objectName === '' || isNewChartPlaceholderName(objectName))) {
                setLoadedChartObjectName(null);
                setIsOwnerOfLoadedChart(true);
                if (objectName === 'Create New Overlay' || objectName === '') {
                    const timestamp = new Date().getTime();
                    overlayObjectName = `new_overlay_${timestamp}`;
                    setChartObjectName(overlayObjectName);
                    setOverlayName('New Overlay');
                } else {
                    setOverlayName(objectName);
                }
                const emptyChart = {
                    unique_id: generateUniqueId(),
                    series: [],
                    data: [],
                    overlayName: (objectName === 'Create New Overlay' || objectName === '') ? 'New Overlay' : objectName,
                    overlayType: "TextBox",
                    backgroundColor: "#FFFFFF",
                    opacity: 1.0,
                    orientation: "horizontal",
                    position: { x: 50, y: 50 }
                };
                setChartObjects([emptyChart]);
                setOrientation("horizontal");
                setPosition({ x: 50, y: 50 });
                setLoadedChartObjectName(null);
                setIsOwnerOfLoadedChart(true);
                return;
            }

            const response_json = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=${encodeURIComponent(parentName)}&object_name=${encodeURIComponent(objectNameForApi)}`, controller.signal);

            if (response_json.success) {
                try {
                    const loadedCharts = response_json.data.chart_info || [];
                    
                    // Transform loaded charts back to builder format by merging series and series2
                    const transformedCharts = loadedCharts.map(chart => {
                        // Ensure unique_id exists
                        if (!chart.unique_id) {
                            chart.unique_id = generateUniqueId();
                        }
                        const mergedSeries = [];
                        
                        // Merge series and series2 back together
                        chart.series?.forEach((primaryItem, index) => {
                            const mergedItem = {
                                channel: primaryItem.channel,
                                color: primaryItem.color || "#000000"
                            };
                            
                            // Add channel2 if it exists in series2 (for TextBox)
                            if (chart.series2 && chart.series2[index] && chart.series2[index].channel2) {
                                mergedItem.channel2 = chart.series2[index].channel2;
                            }
                            if (chart.overlayType === "TextBox" || !chart.overlayType) {
                                mergedItem.primaryChannelLabel = primaryItem.primaryChannelLabel ?? "";
                                mergedItem.secondaryChannelLabel = chart.series2?.[index]?.secondaryChannelLabel ?? "";
                            }
                            
                            // Restore type-specific properties
                            const overlayType = chart.overlayType || "TextBox";
                            if (overlayType === "Sparkline") {
                                mergedItem.timespan = primaryItem.timespan || 30;
                                mergedItem.width = primaryItem.width || 150;
                                mergedItem.height = primaryItem.height || 60;
                            } else if (overlayType === "Donut") {
                                mergedItem.donutType = primaryItem.donutType || "basic";
                                mergedItem.height = primaryItem.height || 150; // Use height instead of width
                                mergedItem.label = primaryItem.label ?? primaryItem.channel?.name ?? "";
                                if (primaryItem.targetValue !== undefined) {
                                    mergedItem.targetValue = primaryItem.targetValue;
                                }
                                if (primaryItem.warningValue !== undefined) {
                                    mergedItem.warningValue = primaryItem.warningValue;
                                }
                                if (primaryItem.alarmValue !== undefined) {
                                    mergedItem.alarmValue = primaryItem.alarmValue;
                                }
                            } else if (overlayType === "180" || overlayType === "180 Dot") {
                                mergedItem.height = primaryItem.height || 150; // Use height instead of width
                            } else if (overlayType === "FleetDataTable") {
                                // Channel list only; no channel2 or height
                            } else if (overlayType === "TextBox" || !overlayType) {
                                mergedItem.height = primaryItem.height || 60; // Default height for TextBox
                            }
                            
                            mergedSeries.push(mergedItem);
                        });
                        
                        return {
                            ...chart,
                            overlayType: chart.overlayType || "TextBox", // Default to TextBox if not set
                            series: mergedSeries,
                            orientation: chart.orientation || "horizontal",
                            position: chart.position || { x: 50, y: 50 }
                        };
                    });
                    
                    // When opened from fleet map (object_name=fleet_datatable) and no saved overlay yet, start with one Fleet Data Table chart
                    if (objectName === 'fleet_datatable' && (!loadedCharts || loadedCharts.length === 0)) {
                        setChartObjects([defaultFleetDataTableChart()]);
                        setOverlayName('default');
                        setLoadedChartObjectName(null);
                        setOrientation("horizontal");
                        setPosition({ x: 50, y: 50 });
                    } else {
                        setChartObjects(transformedCharts);
                        setOverlayName(isFleetMapOnly() ? 'default' : overlayObjectName);
                        setLoadedChartObjectName(isFleetMapOnly() ? 'default' : overlayObjectName);
                    }
                    try {
                        const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user()!.user_id)}&parent_name=${encodeURIComponent(parentName)}`;
                        const namesRes = await getData(namesUrl, controller.signal);
                        setIsOwnerOfLoadedChart(isOwnerOfLoadedObject(namesRes?.success ? namesRes.data : null, objectNameForApi));
                    } catch (_) {
                        setIsOwnerOfLoadedChart(true);
                    }
                    
                    // Set orientation and position from first chart (Fleet Data Table defaults to vertical = sources as rows)
                    if (transformedCharts.length > 0) {
                        const first = transformedCharts[0];
                        const defaultOrientation = first.overlayType === "FleetDataTable" ? "vertical" : "horizontal";
                        setOrientation(first.orientation || defaultOrientation);
                        setPosition(first.position || { x: 50, y: 50 });
                    }
                } catch (parseError) {
                    setChartObjects(objectName === 'fleet_datatable' ? [defaultFleetDataTableChart()] : [defaultChart]);
                    setOverlayName(isFleetMapOnly() ? 'default' : overlayObjectName);
                    setLoadedChartObjectName(null);
                    setIsOwnerOfLoadedChart(true);
                }
            } else {
                logError("Error loading charts...");
                setChartObjects(objectName === 'fleet_datatable' ? [defaultFleetDataTableChart()] : [defaultChart]);
                setOverlayName(isFleetMapOnly() ? 'default' : overlayObjectName);
                setLoadedChartObjectName(null);
                setIsOwnerOfLoadedChart(true);
            }
        } catch (error: any) {
            logError("Error loading charts:", error.message);
            setChartObjects(chartObjectName() === 'fleet_datatable' ? [defaultFleetDataTableChart()] : [defaultChart]);
            const objName = chartObjectName();
            setOverlayName(isFleetMapOnly() ? 'default' : (objName !== 'Create New Overlay' ? objName : 'New Overlay'));
            setLoadedChartObjectName(null);
            setIsOwnerOfLoadedChart(true);
        }
    };

    // Check for duplicate overlay names
    const checkDuplicateName = async (nameToCheck) => {
        try {
            if (!user() || !user().user_id || !nameToCheck || nameToCheck.trim() === '') {
                return false;
            }
            
            const response = await getData(
                `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=${encodeURIComponent(getOverlayParentName())}`
            );
            
            if (response.success && response.data) {
                const existingNames = response.data.map(item => 
                    typeof item === 'string' ? item : (item.object_name || item)
                );
                // Check if name exists and is not the current object name
                const exists = existingNames.some(existingName => 
                    existingName.toLowerCase() === nameToCheck.toLowerCase() && 
                    existingName !== chartObjectName()
                );
                return exists;
            }
            return false;
        } catch (error: any) {
            logError("Error checking duplicate name:", error);
            return false;
        }
    };

    // Save and post charts (optional saveAsName for Save As flow)
    const saveCharts = async (saveAsName?: string) => {
        const controller = new AbortController();
        if (!user() || !user().user_id) {
            logError("User not available, cannot save charts");
            return;
        }
        const objectNameToSave = isFleetMapOnly() ? 'default' : (saveAsName || overlayName() || chartObjectName()).trim();
        if (!isFleetMapOnly() && isNewChartPlaceholderName(objectNameToSave)) {
            warn('Overlay builder: Cannot save until the overlay name is updated from "new chart".');
            alert('Please update the overlay name before saving. "New chart" is only a placeholder for new overlays.');
            return;
        }
        try {
            const parentNameForSave = getOverlayParentName();
            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=${encodeURIComponent(parentNameForSave)}`;
            const namesResponse = await getData(namesUrl, controller.signal);
            const existingNames: string[] = (namesResponse?.success && Array.isArray(namesResponse?.data))
                ? (namesResponse.data as { object_name?: string }[]).map((o) => (typeof o === 'string' ? o : (o?.object_name || '')).trim()).filter(Boolean)
                : [];
            const nameAlreadyExists = existingNames.some((n) => n.toLowerCase() === objectNameToSave.toLowerCase());
            const isUpdatingOwnChart = !saveAsName && loadedChartObjectName() !== null && (loadedChartObjectName() || '').trim().toLowerCase() === objectNameToSave.toLowerCase();
            if (!isFleetMapOnly() && nameAlreadyExists && !isUpdatingOwnChart) {
                warn('Overlay builder: Save blocked - overlay name already exists:', objectNameToSave);
                setChartNameError('duplicate');
                alert(`An overlay named "${objectNameToSave}" already exists. Please choose a different name.`);
                return;
            }
            setChartNameError(null);
            setNameWarning('');
            
            // Transform chartObjects to separate primary and secondary channels
            const transformedCharts = chartObjects.map((chart, index) => {
                const primarySeries = [];
                const secondarySeries = [];
                
                chart.series?.forEach(seriesItem => {
                    // Primary channel - always add to maintain row correspondence
                    const primaryEntry = {
                        channel: seriesItem.channel && seriesItem.channel.name ? seriesItem.channel : null,
                        color: seriesItem.color || "#000000"
                    };
                    // Add type-specific properties
                    if (chart.overlayType === "Sparkline") {
                        primaryEntry.timespan = seriesItem.timespan || 30;
                        primaryEntry.width = seriesItem.width || 150;
                        primaryEntry.height = seriesItem.height || 60;
                    } else if (chart.overlayType === "Donut") {
                        primaryEntry.donutType = seriesItem.donutType || "basic";
                        primaryEntry.label = seriesItem.label ?? seriesItem.channel?.name ?? "";
                        if (seriesItem.donutType === "basic") {
                            primaryEntry.color = seriesItem.color || "#10b981";
                        }
                        primaryEntry.height = seriesItem.height || 150; // Use height instead of width
                        if (seriesItem.donutType === "target") {
                            primaryEntry.targetValue = seriesItem.targetValue;
                        } else if (seriesItem.donutType === "alarm") {
                            primaryEntry.warningValue = seriesItem.warningValue;
                            primaryEntry.alarmValue = seriesItem.alarmValue;
                        }
                    } else if (chart.overlayType === "180" || chart.overlayType === "180 Dot") {
                        primaryEntry.height = seriesItem.height || 150; // Use height instead of width
                    } else if (chart.overlayType === "FleetDataTable") {
                        // Channel list only; no height or channel2
                    } else if (chart.overlayType === "TextBox" || !chart.overlayType) {
                        primaryEntry.height = seriesItem.height || 60; // Default height for TextBox
                        primaryEntry.primaryChannelLabel = seriesItem.primaryChannelLabel ?? "";
                    }
                    primarySeries.push(primaryEntry);
                    
                    // Secondary channel - always add to maintain row correspondence (for TextBox)
                    const secondaryEntry = {
                        channel: seriesItem.channel && seriesItem.channel.name ? seriesItem.channel : null,
                        channel2: seriesItem.channel2 && seriesItem.channel2.name ? seriesItem.channel2 : null,
                        color: seriesItem.color || "#000000"
                    };
                    if (chart.overlayType === "TextBox" || !chart.overlayType) {
                        secondaryEntry.secondaryChannelLabel = seriesItem.secondaryChannelLabel ?? "";
                    }
                    secondarySeries.push(secondaryEntry);
                });
                
                return {
                    overlayName: chart.overlayName || `Overlay ${index + 1}`,
                    overlayType: chart.overlayType || "TextBox",
                    backgroundColor: chart.backgroundColor || "#FFFFFF",
                    opacity: chart.opacity !== undefined ? chart.opacity : 1.0,
                    series: primarySeries,
                    series2: secondarySeries,
                    orientation: index === 0 ? orientation() : (chart.orientation || "horizontal"),
                    position: index === 0 ? position() : (chart.position || { x: 50, y: 50 })
                };
            });
            
            const chartObject = {"parent_name": parentNameForSave, "chart_name": "default", "chart_info": transformedCharts, "shared": 0};
            const summary_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(), 'user_id': user().user_id, 'parent_name': parentNameForSave, 'object_name': objectNameToSave, 'json': JSON.stringify(chartObject, null, 2)};
            
            if (!isFleetMapOnly() && objectNameToSave !== chartObjectName()) {
                setChartObjectName(objectNameToSave);
            }
            
            log("Saving overlay object:", JSON.stringify(transformedCharts, null, 2));
            log("Summary JSON:", summary_json);

            const response_json = await postData(`${apiEndpoints.app.users}/object`, summary_json, controller.signal);

            if (response_json.success) {
                log("Saved successfully!", JSON.stringify(transformedCharts, null, 2));
                const previousName = loadedChartObjectName();
                const isRename = !isFleetMapOnly() && !saveAsName && previousName !== null && previousName.trim().toLowerCase() !== objectNameToSave.toLowerCase();
                if (isRename) {
                    const delete_json = {
                        class_name: selectedClassName(),
                        project_id: selectedProjectId(),
                        user_id: user().user_id,
                        parent_name: parentNameForSave,
                        object_name: previousName
                    };
                    try {
                        await deleteData(`${apiEndpoints.app.users}/object`, delete_json, controller.signal);
                    } catch (deleteErr: any) {
                        logError("Failed to remove old overlay name after rename:", deleteErr);
                    }
                }
                setLoadedChartObjectName(objectNameToSave);
                if (saveAsName) {
                    setOverlayName(saveAsName);
                    setChartObjectName(saveAsName);
                }
                setSidebarMenuRefreshTrigger(1);
                const storageKey = `overlay_position_${objectNameToSave}`;
                try {
                    localStorage.removeItem(storageKey);
                    log('Overlay Builder: Cleared localStorage for saved position:', storageKey);
                } catch (e) {
                    logError('Overlay Builder: Error clearing localStorage:', e);
                }
                // Persist the saved overlay as the map's selected data overlay so the map shows it when user returns
                try {
                    localStorage.setItem('overlay_dataOverlayName', JSON.stringify(objectNameToSave));
                    localStorage.setItem('overlay_dataOverlayChoiceApplied', JSON.stringify(true));
                } catch (e) {
                    logError('Overlay Builder: Failed to persist selected overlay for map', e);
                }
                navigate("/dashboard");
            } else {
                log("Save Failed -", response_json.message);
            }
        } catch (error: any) {
            logError("Error saving charts:", error);
        }
    };

    const saveAsNewChart = async () => {
        const currentName = (overlayName() || chartObjectName()).trim();
        const newName = prompt("Enter a new name for this overlay:", currentName ? `${currentName} Copy` : "New Overlay");
        if (newName && newName.trim()) {
            const trimmed = newName.trim();
            if (isNewChartPlaceholderName(trimmed)) {
                warn('Overlay builder: Cannot use "new chart" as the overlay name.');
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
            const parentNameForDelete = getOverlayParentName();
            const nameToDelete = isFleetMapOnly() ? getOverlayObjectNameForApi() : (overlayName() || chartObjectName());
            
            const delete_json = {
                'class_name': selectedClassName(), 
                'project_id': selectedProjectId(),
                'user_id': user().user_id, 
                'parent_name': parentNameForDelete, 
                'object_name': nameToDelete
            };

            const response_json = await deleteData(`${apiEndpoints.app.users}/object`, delete_json, controller.signal);

            if (response_json.success) {
                log("Deleted successfully!");
                setSidebarMenuRefreshTrigger(1);
                // Chart configuration deleted successfully
                
                // Navigate back to dashboard
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
        try {
            setSelectedChart(chartIndex)
            setSelectedSeries(seriesIndex)
            setColorPickerType("channel");
            setShowColor(true);
        } catch (error: any) {
            logError("Error showing color picker:", error);
        }
    }

    const handleColor = async (color, chartIndex, seriesIndex) => {
        try {
            if (chartIndex === undefined || seriesIndex === undefined) {
                logError("Invalid chart or series index");
                return;
            }
            
            setChartObjects(chartIndex, "series", seriesIndex, "color", color); 
            setSelectedChart(0)
            setSelectedSeries(0)
            setHasChanges(true);
            setShowColor(false);
        } catch (error: any) {
            logError("Error handling color selection:", error);
            setShowColor(false); // Close color picker on error
        }
    }

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

    const handleShowBgColor = async (chartIndex) => {
        try {
            setSelectedChart(chartIndex);
            setColorPickerType("background");
            setShowColor(true);
        } catch (error: any) {
            logError("Error showing background color picker:", error);
        }
    }

    const handleBgColor = async (color, chartIndex) => {
        try {
            if (chartIndex === undefined) {
                logError("Invalid chart index");
                return;
            }
            
            setChartObjects(chartIndex, "backgroundColor", color);
            setSelectedChart(0);
            setHasChanges(true);
            setShowColor(false);
            setColorPickerType("");
        } catch (error: any) {
            logError("Error handling background color selection:", error);
            setShowColor(false);
            setColorPickerType("");
        }
    }

    const handleSaveChannels = async (axis, channels, chartIndex) => {
        if (channels.length > 0) {
            const chartIndex_ = chartIndex; // chartIndex is already a value, not a function
            const seriesIndex_ = selectedSeries();
            const chart = chartObjects[chartIndex_];
            const overlayType = chart?.overlayType || "TextBox";
            const isFleetDataTable = overlayType === "FleetDataTable";
            const isEditingExisting = typeof seriesIndex_ === "number" && seriesIndex_ >= 0 && chartObjects[chartIndex_]?.series[seriesIndex_];
            
            if (axis === "secondaryChannel") {
                const selectedChannel = channels[0];
                setChartObjects(chartIndex_, "series", seriesIndex_, "channel2", { name: selectedChannel, type: "float" });
                if (overlayType === "TextBox" || !overlayType) {
                    setChartObjects(chartIndex_, "series", seriesIndex_, "secondaryChannelLabel", selectedChannel);
                }
            } else if (isFleetDataTable && !isEditingExisting) {
                // Fleet Data Table: add all selected channels as new series entries (multi-select)
                const existingSeries = chartObjects[chartIndex_]?.series || [];
                const newEntries = channels.map((channelName) => ({
                    channel: { name: channelName, type: "float" },
                    color: "#10b981",
                }));
                setChartObjects(chartIndex_, "series", [...existingSeries, ...newEntries]);
            } else {
                if (isEditingExisting) {
                    const selectedChannel = channels[0];
                    setChartObjects(chartIndex_, "series", seriesIndex_, "channel", { name: selectedChannel, type: "float" });
                    if (overlayType === "TextBox" || !overlayType) {
                        setChartObjects(chartIndex_, "series", seriesIndex_, "primaryChannelLabel", selectedChannel);
                    }
                } else {
                    // Add each selected channel as a separate overlay item (multi-select)
                    const existingSeries = chartObjects[chartIndex_]?.series || [];
                    const newEntries = channels.map((selectedChannel) => {
                        const newChannel: any = {
                            channel: { name: selectedChannel, type: "float" },
                            color: overlayType === "TextBox" ? colors[6] : "#10b981",
                        };
                        if (overlayType === "Sparkline") {
                            newChannel.timespan = 30;
                            newChannel.width = 150;
                            newChannel.height = 60;
                        } else if (overlayType === "Donut") {
                            newChannel.donutType = "basic";
                            newChannel.height = 150;
                            newChannel.label = selectedChannel;
                        } else if (overlayType === "180" || overlayType === "180 Dot") {
                            newChannel.height = 150;
                        } else if (overlayType === "FleetDataTable") {
                            // Channel list only; no channel2
                        } else {
                            newChannel.channel2 = { name: "", type: "float" };
                            newChannel.height = 60;
                            newChannel.primaryChannelLabel = selectedChannel;
                            newChannel.secondaryChannelLabel = "";
                        }
                        return newChannel;
                    });
                    setChartObjects(chartIndex_, "series", [...existingSeries, ...newEntries]);
                }
            }

            setShowChannels(false);
            setHasChanges(true);
        } else {
            setShowChannels(false);
        }
    };


    // Add a new channel to the chart's series
    const addChannel = (chartIndex) => {
        setSelectedChart(chartIndex);
        setSelectedSeries(-1); // No row selected = adding new; prevents overwriting first row when series already has entries
        setShowChannels(true); // Open the channel picker
        setShowAxis("channel");
    };

    // Initialize drag behavior for overlay preview
    const initializeDrag = () => {
        if (!previewContainerRef || !overlayElementRef) return;

        // Clean up existing drag behavior
        if (dragBehavior) {
            dragBehavior.on("start", null).on("drag", null).on("end", null);
        }

        const container = d3.select(previewContainerRef);
        const overlay = d3.select(overlayElementRef);

        dragBehavior = d3.drag()
            .on("start", function(event) {
                d3.select(this).style("opacity", 0.7);
            })
            .on("drag", function(event) {
                const containerRect = previewContainerRef.getBoundingClientRect();
                
                // Get mouse position relative to container
                const [mouseX, mouseY] = d3.pointer(event, previewContainerRef);
                
                // Calculate new position in percentage
                let newX = (mouseX / containerRect.width) * 100;
                let newY = (mouseY / containerRect.height) * 100;
                
                // Snap to 25 positions: 5x5 grid (0, 25, 50, 75, 100 for both X and Y)
                let snappedX, snappedY;
                
                // Snap horizontally: 0 (0-20%), 25 (20-40%), 50 (40-60%), 75 (60-80%), 100 (80-100%)
                if (newX < 20) {
                    snappedX = 0;
                } else if (newX < 40) {
                    snappedX = 25;
                } else if (newX < 60) {
                    snappedX = 50;
                } else if (newX < 80) {
                    snappedX = 75;
                } else {
                    snappedX = 100;
                }
                
                // Snap vertically: 0 (0-20%), 25 (20-40%), 50 (40-60%), 75 (60-80%), 100 (80-100%)
                if (newY < 20) {
                    snappedY = 0;
                } else if (newY < 40) {
                    snappedY = 25;
                } else if (newY < 60) {
                    snappedY = 50;
                } else if (newY < 80) {
                    snappedY = 75;
                } else {
                    snappedY = 100;
                }
                
                // Update position
                setPosition({ x: snappedX, y: snappedY });
                setHasChanges(true);
                
                // Update visual position with proper transforms
                if (snappedX === 0) {
                    overlay.style("left", "0px")
                          .style("right", "auto");
                } else if (snappedX === 100) {
                    overlay.style("right", "0px")
                          .style("left", "auto");
                } else {
                    // For 25, 50, 75 - use percentage and center with transform
                    overlay.style("left", `${snappedX}%`)
                          .style("right", "auto");
                }
                
                if (snappedY === 0) {
                    overlay.style("top", "0px")
                          .style("bottom", "auto");
                } else if (snappedY === 100) {
                    overlay.style("bottom", "0px")
                          .style("top", "auto");
                } else {
                    // For 25, 50, 75 - use percentage and center with transform
                    overlay.style("top", `${snappedY}%`)
                          .style("bottom", "auto");
                }
                
                // Apply transforms to center non-edge positions (25, 50, 75)
                let transformX = (snappedX === 25 || snappedX === 50 || snappedX === 75) ? "translateX(-50%)" : "";
                let transformY = (snappedY === 25 || snappedY === 50 || snappedY === 75) ? "translateY(-50%)" : "";
                let transform = [transformX, transformY].filter(t => t).join(" ") || "none";
                overlay.style("transform", transform);
            })
            .on("end", function(event) {
                d3.select(this).style("opacity", 1);
            });

        overlay.call(dragBehavior);
    };

    // Update overlay position when orientation or position changes
    const updateOverlayPosition = () => {
        if (!overlayElementRef) return;
        
        const overlay = d3.select(overlayElementRef);
        const currentPos = position();
        
        // Apply position with proper transforms for 5x5 grid positions (0, 25, 50, 75, 100)
        if (currentPos.x === 0) {
            overlay.style("left", "0px")
                  .style("right", "auto");
        } else if (currentPos.x === 100) {
            overlay.style("right", "0px")
                  .style("left", "auto");
        } else {
            // For 25, 50, 75 - use percentage and center with transform
            overlay.style("left", `${currentPos.x}%`)
                  .style("right", "auto");
        }
        
        if (currentPos.y === 0) {
            overlay.style("top", "0px")
                  .style("bottom", "auto");
        } else if (currentPos.y === 100) {
            overlay.style("bottom", "0px")
                  .style("top", "auto");
        } else {
            // For 25, 50, 75 - use percentage and center with transform
            overlay.style("top", `${currentPos.y}%`)
                  .style("bottom", "auto");
        }
        
        // Apply transforms to center non-edge positions (25, 50, 75)
        let transformX = (currentPos.x === 25 || currentPos.x === 50 || currentPos.x === 75) ? "translateX(-50%)" : "";
        let transformY = (currentPos.y === 25 || currentPos.y === 50 || currentPos.y === 75) ? "translateY(-50%)" : "";
        let transform = [transformX, transformY].filter(t => t).join(" ") || "none";
        overlay.style("transform", transform);
    };

    // Helper function to convert hex to rgba
    const hexToRgba = (hex, alpha) => {
        if (!hex) return `rgba(255, 255, 255, ${alpha})`;
        if (hex.startsWith('#')) {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        // If already rgba or rgb, try to extract and modify
        if (hex.startsWith('rgba')) {
            return hex.replace(/[\d\.]+\)$/g, `${alpha})`);
        }
        if (hex.startsWith('rgb')) {
            return hex.replace('rgb', 'rgba').replace(')', `, ${alpha})`);
        }
        return hex;
    };

    // Update overlay visual properties when chart changes
    createEffect(() => {
        if (overlayElementRef && chartObjects.length > 0) {
            const chart = chartObjects[0];
            const overlay = d3.select(overlayElementRef);
            const bgColor = chart.backgroundColor || "#FFFFFF";
            const opacity = chart.opacity || 1.0;
            
            // Apply semi-transparent background for preview visibility
            overlay.style("background", hexToRgba(bgColor, 0.5))
                  .style("opacity", opacity * 0.8)
                  .style("width", orientation() === "horizontal" ? "200px" : "80px")
                  .style("height", orientation() === "horizontal" ? "60px" : "200px");
        }
    });

    // Watch for URL parameter changes and reload overlay
    createEffect(() => {
        const currentObjectName = getObjectName();
        const currentChartObjectName = chartObjectName();
        
        // If URL parameter changed, update and reload
        if (currentObjectName !== currentChartObjectName) {
            log('Overlay Builder: URL parameter changed, reloading overlay:', currentObjectName);
            setChartObjectName(currentObjectName);
            setLoading(true);
            fetchCharts().finally(() => {
                setLoading(false);
                // Reinitialize drag and position after loading
                setTimeout(() => {
                    updateOverlayPosition();
                    initializeDrag();
                }, 200);
            });
        }
    });

    // Reinitialize drag when orientation changes
    createEffect(() => {
        if (overlayElementRef && previewContainerRef) {
            setTimeout(() => {
                initializeDrag();
                updateOverlayPosition();
            }, 50);
        }
    });

    onMount(async () => {
        setChartObjects([]);
        await fetchCharts();
        setLoading(false);
        
        // Initialize drag and position after a short delay to ensure DOM is ready
        setTimeout(() => {
            updateOverlayPosition();
            initializeDrag();
        }, 200);
    });

    onCleanup(() => {
        if (dragBehavior) {
            dragBehavior.on("start", null).on("drag", null).on("end", null);
        }
    });

    return (
        <div class="builder-page">
            {loading() && <Loading />}
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
                            <h1>Overlay Builder</h1>
                            <p>Create and manage overlay charts for data visualization</p>
                        </div>
                    </div>
                </div>

                <form class="builder-form">
                        <Show when={chartObjects.length > 0} fallback={
                            <div class="text-center py-16">
                                <div class="mx-auto w-24 h-24 rounded-full flex items-center justify-center mb-6" style="background: var(--color-bg-tertiary);">
                                    <svg class="w-12 h-12" style="color: var(--color-text-link);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                                    </svg>
                                </div>
                                <h3 class="text-xl font-semibold mb-2" style="color: var(--color-text-primary);">No overlay data available</h3>
                                <p class="mb-8 max-w-md mx-auto" style="color: var(--color-text-secondary);">Overlay charts will be created automatically when you have data to display</p>
                            </div>
                        }>
                        <>
                            <For each={chartObjects}>
                                {(chart, chartIndex) => (
                                    <div>
                                    {/* Section 1: Overlay Configuration */}
                                    <div class="builder-form-card mb-3">
                                        <div class="builder-form-header">
                                            <div class="flex items-center justify-between">
                                                <div class="flex items-center space-x-3">
                                                    <div class="w-8 h-8 rounded-md flex items-center justify-center" style="background: var(--color-bg-button);">
                                                        <span class="font-bold text-sm" style="color: var(--color-text-inverse);">1</span>
                                                    </div>
                                                    <div>
                                                        <h2 class="text-base font-semibold" style="color: var(--color-text-primary);">Configuration</h2>
                                                        <p class="text-xs" style="color: var(--color-text-secondary);">{chartType}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="builder-form-content">
                                            <div class="space-y-6">
                                                {/* Overlay Configuration */}
                                                <div>
                                                    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                                                        {/* Overlay Name */}
                                                        <div>
                                                            <label class="block text-xs font-medium mb-2" style="color: var(--color-text-secondary);">Overlay Name</label>
                                                            <input
                                                                type="text"
                                                                value={chartIndex() === 0 ? (overlayName() || chartObjectName()) : (chart.overlayName || "")}
                                                                placeholder="Enter overlay name"
                                                                onInput={(e) => {
                                                                    if (chartIndex() === 0) {
                                                                        setOverlayName(e.target.value);
                                                                        setChartObjects(chartIndex(), "overlayName", e.target.value);
                                                                        setChartNameError(null);
                                                                        setNameWarning('');
                                                                    } else {
                                                                        setChartObjects(chartIndex(), "overlayName", e.target.value);
                                                                    }
                                                                    setHasChanges(true);
                                                                }}
                                                                class={`builder-form-input w-full ${chartIndex() === 0 && (isNewChartPlaceholderName(overlayName() || chartObjectName()) || chartNameError() === 'duplicate') ? 'builder-form-input-invalid' : ''}`}
                                                                aria-invalid={chartIndex() === 0 && (isNewChartPlaceholderName(overlayName() || chartObjectName()) || chartNameError() === 'duplicate') ? 'true' : 'false'}
                                                                aria-describedby={chartIndex() === 0 && (isNewChartPlaceholderName(overlayName() || chartObjectName()) || chartNameError() === 'duplicate') ? 'chart-name-error' : undefined}
                                                            />
                                                            <Show when={chartIndex() === 0 && nameWarning()}>
                                                                <p class="text-xs mt-1" style="color: #ef4444;">{nameWarning()}</p>
                                                            </Show>
                                                            {chartIndex() === 0 && (
                                                                <div id="chart-name-error" role="alert">
                                                                    <Show when={isNewChartPlaceholderName(overlayName() || chartObjectName())}>
                                                                        <p class="builder-form-input-error-message">
                                                                            Please change the overlay name from &quot;new chart&quot; before saving.
                                                                        </p>
                                                                    </Show>
                                                                    <Show when={chartNameError() === 'duplicate' && !isNewChartPlaceholderName(overlayName() || chartObjectName())}>
                                                                        <p class="builder-form-input-error-message">
                                                                            An overlay with this name already exists. Please choose a different name.
                                                                        </p>
                                                                    </Show>
                                                                </div>
                                                            )}
                                                        </div>
                                                        {/* Overlay Type - when opened from fleet map, only Fleet Data Table is allowed */}
                                                        <div>
                                                            <label class="block text-xs font-medium mb-2" style="color: var(--color-text-secondary);">Overlay Type</label>
                                                            <Show when={isFleetMapOnly()} fallback={
                                                                <select
                                                                    value={chart.overlayType || "TextBox"}
                                                                    onChange={(e) => {
                                                                        setChartObjects(chartIndex(), "overlayType", e.target.value);
                                                                        setHasChanges(true);
                                                                    }}
                                                                    class="builder-form-input w-full"
                                                                >
                                                                    <option value="TextBox">TextBox</option>
                                                                    <option value="Sparkline">Sparkline</option>
                                                                    <option value="Donut">Donut</option>
                                                                    <option value="FleetDataTable">Fleet Data Table</option>
                                                                </select>
                                                            }>
                                                                <select
                                                                    value="FleetDataTable"
                                                                    disabled
                                                                    class="builder-form-input w-full"
                                                                    aria-label="Overlay type (Fleet Map: Fleet Data Table only)"
                                                                >
                                                                    <option value="FleetDataTable">Fleet Data Table</option>
                                                                </select>
                                                            </Show>
                                                        </div>
                                                        {/* Background Color */}
                                                        <div>
                                                            <label class="block text-xs font-medium mb-2" style="color: var(--color-text-secondary);">Background Color</label>
                                                            <div class="flex items-center">
                                                                <svg
                                                                    width="20"
                                                                    height="20"
                                                                    class="builder-form-color-picker cursor-pointer"
                                                                    style="margin-left: 100px; margin-top: 10px;"
                                                                    onClick={() => handleShowBgColor(chartIndex)}
                                                                >
                                                                    <rect
                                                                        width="100%"
                                                                        height="100%"
                                                                        fill={chart.backgroundColor || "#FFFFFF"}
                                                                    />
                                                                </svg>
                                                            </div>
                                                        </div>
                                                        {/* Opacity */}
                                                        <div>
                                                            <label class="block text-xs font-medium mb-2" style="color: var(--color-text-secondary);">Opacity</label>
                                                            <div class="flex items-center space-x-2">
                                                                <input
                                                                    type="range"
                                                                    min="0"
                                                                    max="1"
                                                                    step="0.01"
                                                                    value={chart.opacity || 1.0}
                                                                    onInput={(e) => {
                                                                        setChartObjects(chartIndex(), "opacity", parseFloat(e.target.value));
                                                                        setHasChanges(true);
                                                                    }}
                                                                    class="flex-1"
                                                                />
                                                                <span class="text-sm w-12 text-center" style="color: var(--color-text-secondary);">{(chart.opacity || 1.0).toFixed(2)}</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Section 2: Overlay Orientation (only show for first chart) */}
                                    <Show when={chartIndex() === 0}>
                                        <div class="builder-form-card mb-3">
                                            <div class="builder-form-header">
                                                <div class="flex items-center space-x-3">
                                                    <div class="w-8 h-8 rounded-md flex items-center justify-center" style="background: var(--color-bg-button);">
                                                        <span class="font-bold text-sm" style="color: var(--color-text-inverse);">2</span>
                                                    </div>
                                                    <div>
                                                        <h2 class="text-base font-semibold" style="color: var(--color-text-primary);">Position & Orientation</h2>
                                                        <p class="text-xs" style="color: var(--color-text-secondary);">Position and orient the overlay on the page</p>
                                                    </div>
                                                </div>
                                            </div>
                                            <div class="builder-form-content" style="padding-top: 5px;">
                                                {/* Orientation Combo Box */}
                                                <div class="mb-4">
                                                    <label class="block text-sm font-medium mb-2" style="color: var(--color-text-primary);">
                                                        Orientation
                                                    </label>
                                                    <select
                                                        value={orientation()}
                                                        onChange={(e) => {
                                                            setOrientation(e.target.value);
                                                            setHasChanges(true);
                                                            // Reset position when orientation changes
                                                            if (e.target.value === "horizontal") {
                                                                setPosition({ x: 50, y: 50 });
                                                            } else {
                                                                setPosition({ x: 50, y: 50 });
                                                            }
                                                            setTimeout(() => {
                                                                updateOverlayPosition();
                                                                initializeDrag();
                                                            }, 50);
                                                        }}
                                                        class="builder-form-input w-full px-4 py-2 text-sm text-gray-900 dark:text-gray-100"
                                                    >
                                                        <option value="horizontal">Horizontal</option>
                                                        <option value="vertical">Vertical</option>
                                                    </select>
                                                </div>
                                                
                                                {/* Preview Window */}
                                                <div 
                                                    ref={(el) => previewContainerRef = el}
                                                    class="bg-gray-200 dark:bg-gray-700 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 relative mx-auto"
                                                    style={{
                                                        "position": "relative",
                                                        "aspect-ratio": "16/9",
                                                        "width": "50%",
                                                        "min-height": "150px"
                                                    }}
                                                >
                                                    {/* Draggable Overlay Object */}
                                                    <div
                                                        ref={(el) => {
                                                            overlayElementRef = el;
                                                            // Initialize color immediately when element is created
                                                            if (el) {
                                                                const bgColor = chart.backgroundColor || "#FFFFFF";
                                                                const opacity = chart.opacity || 1.0;
                                                                
                                                                // Helper to convert hex to rgba
                                                                const hexToRgba = (hex, alpha) => {
                                                                    if (!hex) return `rgba(255, 255, 255, ${alpha})`;
                                                                    if (hex.startsWith('#')) {
                                                                        const r = parseInt(hex.slice(1, 3), 16);
                                                                        const g = parseInt(hex.slice(3, 5), 16);
                                                                        const b = parseInt(hex.slice(5, 7), 16);
                                                                        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
                                                                    }
                                                                    if (hex.startsWith('rgba')) {
                                                                        return hex.replace(/[\d\.]+\)$/g, `${alpha})`);
                                                                    }
                                                                    if (hex.startsWith('rgb')) {
                                                                        return hex.replace('rgb', 'rgba').replace(')', `, ${alpha})`);
                                                                    }
                                                                    return hex;
                                                                };
                                                                
                                                                el.style.background = hexToRgba(bgColor, 0.5);
                                                                el.style.opacity = (opacity * 0.8).toString();
                                                            }
                                                        }}
                                                        class="absolute cursor-move"
                                                        style={{
                                                            "width": orientation() === "horizontal" ? "200px" : "80px",
                                                            "height": orientation() === "horizontal" ? "60px" : "200px",
                                                            "background": "rgba(255, 255, 255, 0.5)", // Will be overridden by ref callback
                                                            "opacity": 0.8, // Will be overridden by ref callback
                                                            "border": "2px dashed rgba(59, 130, 246, 0.6)",
                                                            "border-radius": "4px",
                                                            "display": "flex",
                                                            "flex-direction": "column",
                                                            "align-items": "center",
                                                            "justify-content": "center",
                                                            "box-shadow": "0 2px 8px rgba(0,0,0,0.15)",
                                                            "padding": "4px"
                                                        }}
                                                    >
                                                        <span class="text-xs font-medium" style="color: var(--color-text-primary);">
                                                            {overlayName() || "Overlay"}
                                                        </span>
                                                        <span class="text-xs" style="color: var(--color-text-secondary); opacity: 0.7; margin-top: 2px;">
                                                            Drag to position
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </Show>

                                    {/* Section 3: Overlay Channels */}
                                    <div class="builder-form-card mb-3">
                                        <div class="builder-form-header">
                                            <div class="flex items-center justify-between">
                                                <div class="flex items-center space-x-3">
                                                    <div class="w-8 h-8 rounded-md flex items-center justify-center" style="background: var(--color-bg-button);">
                                                        <span class="font-bold text-sm" style="color: var(--color-text-inverse);">3</span>
                                                    </div>
                                                    <div>
                                                        <h2 class="text-base font-semibold" style="color: var(--color-text-primary);">Channels</h2>
                                                        <p class="text-xs" style="color: var(--color-text-secondary);">Configure data channels for the overlay</p>
                                                    </div>
                                                </div>
                                                <div class="flex items-center space-x-3">
                                                    <span class="inline-flex items-center px-2 py-1 rounded text-xs font-medium" style="background: var(--color-bg-tertiary); color: var(--color-text-secondary);">
                                                        {chart.series?.length || 0} channels
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="builder-form-content">

                                                {/* Channels Section */}
                                                <div>
                                                    <div class="overflow-hidden">
                                                        <table class="builder-table min-w-full">
                                                            <thead>
                                                                <tr>
                                                                    <th class="w-10"></th>
                                                                    <Show when={chart.overlayType === "TextBox" || !chart.overlayType}>
                                                                        <th class="w-1/7" style="width: 14%;">Primary Channel</th>
                                                                        <th class="w-1/7" style="width: 14%;">Primary Label</th>
                                                                        <th class="w-1/7" style="width: 14%;">Secondary Channel</th>
                                                                        <th class="w-1/7" style="width: 14%;">Secondary Label</th>
                                                                        <th class="w-1/7 text-center" style="width: 12%;">Color</th>
                                                                        <th class="w-1/7 text-center" style="width: 12%;">Height (px)</th>
                                                                        <th class="w-1/7 text-center" style="width: 20%;">Actions</th>
                                                                    </Show>
                                                                    <Show when={chart.overlayType === "Sparkline"}>
                                                                        <th class="w-1/6" style="width: 16.67%;">Channel</th>
                                                                        <th class="w-1/6 text-center" style="width: 16.67%;">Color</th>
                                                                        <th class="w-1/6 text-center" style="width: 16.67%;">Timespan (s)</th>
                                                                        <th class="w-1/6 text-center" style="width: 16.67%;">Width (px)</th>
                                                                        <th class="w-1/6 text-center" style="width: 16.67%;">Height (px)</th>
                                                                        <th class="w-1/6 text-center" style="width: 16.67%;">Actions</th>
                                                                    </Show>
                                                                    <Show when={chart.overlayType === "Donut"}>
                                                                        <th class="w-1/6" style="width: 16.67%;">Channel</th>
                                                                        <th class="w-1/6" style="width: 16.67%;">Label</th>
                                                                        <th class="w-1/6 text-center" style="width: 16.67%;">Type</th>
                                                                        <th class="w-1/6 text-center" style="width: 16.67%;">Color</th>
                                                                        <th class="w-1/6 text-center" style="width: 16.67%;">Height (px)</th>
                                                                        <th class="w-1/6 text-center" style="width: 16.67%;">Target/Warning</th>
                                                                        <th class="w-1/6 text-center" style="width: 16.67%;">Actions</th>
                                                                    </Show>
                                                                    <Show when={chart.overlayType === "180"}>
                                                                        <th class="w-1/4" style="width: 25%;">Channel</th>
                                                                        <th class="w-1/4 text-center" style="width: 25%;">Color</th>
                                                                        <th class="w-1/4 text-center" style="width: 25%;">Height (px)</th>
                                                                        <th class="w-1/4 text-center" style="width: 25%;">Actions</th>
                                                                    </Show>
                                                                    <Show when={chart.overlayType === "180 Dot"}>
                                                                        <th class="w-1/4" style="width: 25%;">Channel</th>
                                                                        <th class="w-1/4 text-center" style="width: 25%;">Color</th>
                                                                        <th class="w-1/4 text-center" style="width: 25%;">Height (px)</th>
                                                                        <th class="w-1/4 text-center" style="width: 25%;">Actions</th>
                                                                    </Show>
                                                                    <Show when={chart.overlayType === "FleetDataTable"}>
                                                                        <th class="w-3/4" style="width: 75%;">Channel</th>
                                                                        <th class="w-1/4 text-center" style="width: 25%;">Actions</th>
                                                                    </Show>
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
                                                                            {/* TextBox columns */}
                                                                            <Show when={chart.overlayType === "TextBox" || !chart.overlayType}>
                                                                                <td class="w-1/7" style="width: 14%;">
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
                                                                                        class="builder-form-input cursor-pointer"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="w-1/7" style="width: 14%;">
                                                                                    <input
                                                                                        type="text"
                                                                                        value={series.primaryChannelLabel ?? series.channel?.name ?? ""}
                                                                                        placeholder={series.channel?.name ?? "Label for overlay"}
                                                                                        onInput={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "primaryChannelLabel", (e.target as HTMLInputElement).value);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="w-1/7" style="width: 14%;">
                                                                                    <input
                                                                                        type="text"
                                                                                        value={series.channel2?.name || ""}
                                                                                        placeholder="Click to select channel"
                                                                                        onClick={() => {
                                                                                            setSelectedChart(chartIndex);
                                                                                            setSelectedSeries(seriesIndex);
                                                                                            setShowChannels(true);
                                                                                            setShowAxis("secondaryChannel");
                                                                                        }}
                                                                                        readOnly
                                                                                        class="builder-form-input cursor-pointer"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="w-1/7" style="width: 14%;">
                                                                                    <input
                                                                                        type="text"
                                                                                        value={series.secondaryChannelLabel ?? series.channel2?.name ?? ""}
                                                                                        placeholder={series.channel2?.name ?? "Label for overlay"}
                                                                                        onInput={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "secondaryChannelLabel", (e.target as HTMLInputElement).value);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/7" style="width: 12%;">
                                                                                    <svg
                                                                                        width="20"
                                                                                        height="20"
                                                                                        class="builder-form-color-picker inline-block"
                                                                                        onClick={() => {
                                                                                            handleShowColor(chartIndex, seriesIndex);
                                                                                        }}
                                                                                    >
                                                                                        <rect
                                                                                            width="100%"
                                                                                            height="100%"
                                                                                            fill={series.color || "#000"}
                                                                                        />
                                                                                    </svg>
                                                                                </td>
                                                                                <td class="text-center w-1/7" style="width: 12%;">
                                                                                    <input
                                                                                        type="number"
                                                                                        min="40"
                                                                                        value={series.height || 60}
                                                                                        placeholder="60"
                                                                                        onInput={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "height", parseInt(e.target.value) || 60);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input text-center"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/7" style="width: 20%;">
                                                                                    <svg
                                                                                        xmlns="http://www.w3.org/2000/svg"
                                                                                        width="20"
                                                                                        height="20"
                                                                                        class="builder-form-delete-icon inline-block"
                                                                                        viewBox="0 0 24 24"
                                                                                        onClick={() => {
                                                                                            setChartObjects(chartIndex(), "series", chart.series.filter((_, i) => i !== seriesIndex()));
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                    >
                                                                                        <path d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 2v1h4V5zm-3 3v11h10V8zM9 10a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z" />
                                                                                    </svg>
                                                                                </td>
                                                                            </Show>
                                                                            {/* Fleet Data Table - channel list only */}
                                                                            <Show when={chart.overlayType === "FleetDataTable"}>
                                                                                <td class="w-3/4" style="width: 75%;">
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
                                                                                        class="builder-form-input cursor-pointer"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/4" style="width: 25%;">
                                                                                    <svg
                                                                                        xmlns="http://www.w3.org/2000/svg"
                                                                                        width="20"
                                                                                        height="20"
                                                                                        class="builder-form-delete-icon inline-block"
                                                                                        viewBox="0 0 24 24"
                                                                                        onClick={() => {
                                                                                            setChartObjects(chartIndex(), "series", chart.series.filter((_, i) => i !== seriesIndex()));
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                    >
                                                                                        <path d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 2v1h4V5zm-3 3v11h10V8zM9 10a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z" />
                                                                                    </svg>
                                                                                </td>
                                                                            </Show>
                                                                            {/* Sparkline columns */}
                                                                            <Show when={chart.overlayType === "Sparkline"}>
                                                                                <td class="w-1/6" style="width: 16.67%;">
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
                                                                                        class="builder-form-input cursor-pointer"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/6" style="width: 16.67%;">
                                                                                    <svg
                                                                                        width="20"
                                                                                        height="20"
                                                                                        class="builder-form-color-picker inline-block"
                                                                                        onClick={() => {
                                                                                            handleShowColor(chartIndex, seriesIndex);
                                                                                        }}
                                                                                    >
                                                                                        <rect
                                                                                            width="100%"
                                                                                            height="100%"
                                                                                            fill={series.color || "#10b981"}
                                                                                        />
                                                                                    </svg>
                                                                                </td>
                                                                                <td class="text-center w-1/6" style="width: 16.67%;">
                                                                                    <input
                                                                                        type="number"
                                                                                        min="1"
                                                                                        value={series.timespan || 30}
                                                                                        placeholder="30"
                                                                                        onInput={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "timespan", parseInt(e.target.value) || 30);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input text-center"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/6" style="width: 16.67%;">
                                                                                    <input
                                                                                        type="number"
                                                                                        min="50"
                                                                                        value={series.width || 150}
                                                                                        placeholder="150"
                                                                                        onInput={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "width", parseInt(e.target.value) || 150);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input text-center"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/6" style="width: 16.67%;">
                                                                                    <input
                                                                                        type="number"
                                                                                        min="40"
                                                                                        value={series.height || 60}
                                                                                        placeholder="60"
                                                                                        onInput={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "height", parseInt(e.target.value) || 60);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input text-center"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/6" style="width: 16.67%;">
                                                                                    <svg
                                                                                        xmlns="http://www.w3.org/2000/svg"
                                                                                        width="20"
                                                                                        height="20"
                                                                                        class="builder-form-delete-icon inline-block"
                                                                                        viewBox="0 0 24 24"
                                                                                        onClick={() => {
                                                                                            setChartObjects(chartIndex(), "series", chart.series.filter((_, i) => i !== seriesIndex()));
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                    >
                                                                                        <path d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 2v1h4V5zm-3 3v11h10V8zM9 10a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z" />
                                                                                    </svg>
                                                                                </td>
                                                                            </Show>
                                                                            {/* Donut columns */}
                                                                            <Show when={chart.overlayType === "Donut"}>
                                                                                <td class="w-1/6" style="width: 16.67%;">
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
                                                                                        class="builder-form-input cursor-pointer"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="w-1/6" style="width: 16.67%;">
                                                                                    <input
                                                                                        type="text"
                                                                                        value={series.label ?? series.channel?.name ?? ""}
                                                                                        placeholder="Label"
                                                                                        onInput={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "label", (e.target as HTMLInputElement).value);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/6" style="width: 16.67%;">
                                                                                    <select
                                                                                        value={series.donutType || "basic"}
                                                                                        onChange={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "donutType", e.target.value);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input text-center"
                                                                                        style="width: 100%;"
                                                                                    >
                                                                                        <option value="basic">Basic</option>
                                                                                        <option value="target">Target</option>
                                                                                        <option value="alarm">Alarm</option>
                                                                                        <option value="180">180</option>
                                                                                        <option value="180 Dot">180 Dot</option>
                                                                                    </select>
                                                                                </td>
                                                                                <td class="text-center w-1/6" style="width: 16.67%;">
                                                                                    <Show when={series.donutType === "basic" || !series.donutType}>
                                                                                        <svg
                                                                                            width="20"
                                                                                            height="20"
                                                                                            class="builder-form-color-picker inline-block"
                                                                                            onClick={() => {
                                                                                                handleShowColor(chartIndex, seriesIndex);
                                                                                            }}
                                                                                        >
                                                                                            <rect
                                                                                                width="100%"
                                                                                                height="100%"
                                                                                                fill={series.color || "#10b981"}
                                                                                            />
                                                                                        </svg>
                                                                                    </Show>
                                                                                    <Show when={series.donutType !== "basic" && series.donutType && series.donutType !== "180"}>
                                                                                        <span class="text-xs" style="color: var(--color-text-secondary);">Auto</span>
                                                                                    </Show>
                                                                                    <Show when={series.donutType === "180"}>
                                                                                        <span class="text-xs" style="color: var(--color-text-secondary);">Auto</span>
                                                                                    </Show>
                                                                                </td>
                                                                                <td class="text-center w-1/6" style="width: 16.67%;">
                                                                                    <input
                                                                                        type="number"
                                                                                        min="50"
                                                                                        value={series.height || 150}
                                                                                        placeholder="150"
                                                                                        onInput={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "height", parseInt(e.target.value) || 150);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input text-center"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/6" style="width: 16.67%;">
                                                                                    <Show when={series.donutType === "basic" || !series.donutType || series.donutType === "180" || series.donutType === "180 Dot"}>
                                                                                        <span class="text-xs" style="color: var(--color-text-secondary);">Auto</span>
                                                                                    </Show>
                                                                                    <Show when={series.donutType === "target" || series.donutType === "alarm"}>
                                                                                        <input
                                                                                            type="number"
                                                                                            value={series.targetValue || series.warningValue || ""}
                                                                                            placeholder={series.donutType === "target" ? "Target" : series.donutType === "alarm" ? "Warning" : ""}
                                                                                            onInput={(e) => {
                                                                                                const value = parseFloat(e.target.value);
                                                                                                if (series.donutType === "target") {
                                                                                                    setChartObjects(chartIndex(), "series", seriesIndex(), "targetValue", isNaN(value) ? null : value);
                                                                                                } else if (series.donutType === "alarm") {
                                                                                                    setChartObjects(chartIndex(), "series", seriesIndex(), "warningValue", isNaN(value) ? null : value);
                                                                                                }
                                                                                                setHasChanges(true);
                                                                                            }}
                                                                                            class="builder-form-input text-center"
                                                                                            style="width: 100%;"
                                                                                        />
                                                                                    </Show>
                                                                                </td>
                                                                                <td class="text-center w-1/6" style="width: 16.67%;">
                                                                                    <svg
                                                                                        xmlns="http://www.w3.org/2000/svg"
                                                                                        width="20"
                                                                                        height="20"
                                                                                        class="builder-form-delete-icon inline-block"
                                                                                        viewBox="0 0 24 24"
                                                                                        onClick={() => {
                                                                                            setChartObjects(chartIndex(), "series", chart.series.filter((_, i) => i !== seriesIndex()));
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                    >
                                                                                        <path d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 2v1h4V5zm-3 3v11h10V8zM9 10a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z" />
                                                                                    </svg>
                                                                                </td>
                                                                            </Show>
                                                                            {/* 180 columns */}
                                                                            <Show when={chart.overlayType === "180"}>
                                                                                <td class="w-1/4" style="width: 25%;">
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
                                                                                        class="builder-form-input cursor-pointer"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/4" style="width: 25%;">
                                                                                    <svg
                                                                                        width="20"
                                                                                        height="20"
                                                                                        class="builder-form-color-picker inline-block"
                                                                                        onClick={() => {
                                                                                            handleShowColor(chartIndex, seriesIndex);
                                                                                        }}
                                                                                    >
                                                                                        <rect
                                                                                            width="100%"
                                                                                            height="100%"
                                                                                            fill={series.color || "#10b981"}
                                                                                        />
                                                                                    </svg>
                                                                                </td>
                                                                                <td class="text-center w-1/4" style="width: 25%;">
                                                                                    <input
                                                                                        type="number"
                                                                                        min="50"
                                                                                        value={series.height || 150}
                                                                                        placeholder="150"
                                                                                        onInput={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "height", parseInt(e.target.value) || 150);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input text-center"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/4" style="width: 25%;">
                                                                                    <svg
                                                                                        xmlns="http://www.w3.org/2000/svg"
                                                                                        width="20"
                                                                                        height="20"
                                                                                        class="builder-form-delete-icon inline-block"
                                                                                        viewBox="0 0 24 24"
                                                                                        onClick={() => {
                                                                                            setChartObjects(chartIndex(), "series", chart.series.filter((_, i) => i !== seriesIndex()));
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                    >
                                                                                        <path d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 2v1h4V5zm-3 3v11h10V8zM9 10a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z" />
                                                                                    </svg>
                                                                                </td>
                                                                            </Show>
                                                                            {/* 180 Dot columns */}
                                                                            <Show when={chart.overlayType === "180 Dot"}>
                                                                                <td class="w-1/4" style="width: 25%;">
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
                                                                                        class="builder-form-input cursor-pointer"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/4" style="width: 25%;">
                                                                                    <svg
                                                                                        width="20"
                                                                                        height="20"
                                                                                        class="builder-form-color-picker inline-block"
                                                                                        onClick={() => {
                                                                                            handleShowColor(chartIndex, seriesIndex);
                                                                                        }}
                                                                                    >
                                                                                        <rect
                                                                                            width="100%"
                                                                                            height="100%"
                                                                                            fill={series.color || "#10b981"}
                                                                                        />
                                                                                    </svg>
                                                                                </td>
                                                                                <td class="text-center w-1/4" style="width: 25%;">
                                                                                    <input
                                                                                        type="number"
                                                                                        min="50"
                                                                                        value={series.height || 150}
                                                                                        placeholder="150"
                                                                                        onInput={(e) => {
                                                                                            setChartObjects(chartIndex(), "series", seriesIndex(), "height", parseInt(e.target.value) || 150);
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                        class="builder-form-input text-center"
                                                                                        style="width: 100%;"
                                                                                    />
                                                                                </td>
                                                                                <td class="text-center w-1/4" style="width: 25%;">
                                                                                    <svg
                                                                                        xmlns="http://www.w3.org/2000/svg"
                                                                                        width="20"
                                                                                        height="20"
                                                                                        class="builder-form-delete-icon inline-block"
                                                                                        viewBox="0 0 24 24"
                                                                                        onClick={() => {
                                                                                            setChartObjects(chartIndex(), "series", chart.series.filter((_, i) => i !== seriesIndex()));
                                                                                            setHasChanges(true);
                                                                                        }}
                                                                                    >
                                                                                        <path d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 2v1h4V5zm-3 3v11h10V8zM9 10a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z" />
                                                                                    </svg>
                                                                                </td>
                                                                            </Show>
                                                                        </tr>
                                                                    )}
                                                                </For>
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                    
                                                    {/* Add Channel Button */}
                                                    <div class="mt-4">
                                                        <button
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                addChannel(chartIndex);
                                                            }}
                                                            class="builder-form-button"
                                                            style="width: 150px;"
                                                        >
                                                            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                                                            </svg>
                                                            Add Channel
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </For>
                        
                            {/* Save / Save As - show Save when hasChanges; disable when non-owner or placeholder */}
                            <div class="flex justify-center gap-3 mt-6">
                                {hasChanges() && (
                                    <button
                                        onClick={(e) => {
                                            e.preventDefault();
                                            if (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) return;
                                            if (isNewChartPlaceholderName((overlayName() || chartObjectName()).trim())) {
                                                warn('Overlay builder: Cannot save until the overlay name is updated from "new chart".');
                                                alert('Update the overlay name before saving. "New chart" is only a placeholder for new overlays.');
                                                return;
                                            }
                                            saveCharts();
                                            setHasChanges(false);
                                        }}
                                        class="builder-form-button-success px-6 py-3 font-semibold"
                                        disabled={isNewChartPlaceholderName(overlayName() || chartObjectName()) || (loadedChartObjectName() !== null && !isOwnerOfLoadedChart())}
                                        title={isNewChartPlaceholderName(overlayName() || chartObjectName()) ? 'Update the overlay name before saving' : (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) ? 'Use Save As to save a copy under your name' : undefined}
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

                            {/* Delete - only for owner when overlay is loaded */}
                            <Show when={loadedChartObjectName() !== null && isOwnerOfLoadedChart()}>
                                <div class="flex justify-center mt-4">
                                    <button
                                        onClick={(e) => {
                                            e.preventDefault();
                                            if (confirm('Are you sure you want to delete this overlay? This action cannot be undone.')) {
                                                deleteChart();
                                            }
                                        }}
                                        class="builder-form-button-danger px-6 py-3 font-semibold"
                                    >
                                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                                        </svg>
                                        Delete Overlay
                                    </button>
                                </div>
                            </Show>
                        </>
                    </Show>
                </form>

                <Show when={showColor()}>
                    <ColorPicker
                        colors={colors}
                        onSelect={(color) => {
                            try {
                                const chartIndex = selectedChart();
                                const pickerType = colorPickerType();
                                
                                if (pickerType === "background") {
                                    // Handle background color
                                    if (chartIndex !== undefined) {
                                        handleBgColor(color, chartIndex);
                                    } else {
                                        logError("Invalid chart index when selecting background color");
                                        setShowColor(false);
                                        setColorPickerType("");
                                    }
                                } else {
                                    // Handle channel color
                                    const seriesIndex = selectedSeries();
                                    if (chartIndex !== undefined && seriesIndex !== undefined) {
                                        handleColor(color, chartIndex, seriesIndex);
                                    } else {
                                        logError("Invalid chart or series index when selecting color");
                                        setShowColor(false);
                                        setColorPickerType("");
                                    }
                                }
                            } catch (error: any) {
                                logError("Error in color selection callback:", error);
                                setShowColor(false);
                                setColorPickerType("");
                            }
                        }}
                    />
                </Show>

                
                <Show when={showChannels()}>
                    <ChannelPicker
                        selection={[]}
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
