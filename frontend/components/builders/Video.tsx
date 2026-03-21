import { createSignal, onMount, Show, createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import { useNavigate } from "@solidjs/router";
import { For } from "solid-js/web";

import Loading from "../utilities/Loading";
import { warn, error as logError, info as logInfo, debug as logDebug, log } from "../../utils/console";
import BackButton from "../buttons/BackButton";
import { NEW_CHART_PLACEHOLDER_NAME, isNewChartPlaceholderName, isOwnerOfLoadedObject, SELECTED_SOURCE_SENTINEL, isSelectedSourceSentinel } from "../../utils/builderConstants";

import { getData, postData, deleteData } from "..\/..\/utils\/global";

import { user } from "../../store/userStore"; 
import { persistantStore } from "../../store/persistantStore";
import { setSidebarMenuRefreshTrigger } from "../../store/globalStore";
import { apiEndpoints } from "@config/env";
import { mediaFilesService } from "../../services/mediaFilesService";
const { selectedClassName, selectedProjectId, selectedPage, setSelectedPage, setSelectedMenu, selectedDate, selectedDatasetId } = persistantStore;

interface VideoBuilderProps {
    objectName?: string;
    [key: string]: any;
}

export default function VideoBuilder(props: VideoBuilderProps) {
    const navigate = useNavigate();

    const chartType = 'VIDEO';
    
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

    // Fetch when all dependencies are ready (user, class, project, object name)
    let lastFetchKey: string | null = null;
    createEffect(() => {
        const u = user();
        const cls = selectedClassName();
        const pid = selectedProjectId();
        const name = chartObjectName();

        if (!u || !u.user_id) return;
        if (!cls || !pid || !name) return;

        const key = `${u.user_id}|${cls}|${pid}|${name}`;
        if (key === lastFetchKey) return;
        lastFetchKey = key;

        setLoading(true);
        // Load video config first, then available sources (so we can use saved sources as fallback)
        fetchVideoConfig().then(() => {
            loadAvailableVideoSources();
            loadAvailableOverlays();
        }).finally(() => setLoading(false));
    });

    const [loading, setLoading] = createSignal(true);
    const [hasChanges, setHasChanges] = createSignal(false);
    const [chartNameError, setChartNameError] = createSignal<'duplicate' | null>(null);
    const [loadedChartObjectName, setLoadedChartObjectName] = createSignal<string | null>(null);
    const [isOwnerOfLoadedChart, setIsOwnerOfLoadedChart] = createSignal(true);

    // Video layout configuration
    const [layout, setLayout] = createSignal(1); // 1-4 video feeds
    const [videoSources, setVideoSources] = createSignal<any[]>([]);
    const [overlayName, setOverlayName] = createSignal('');

    // Available video sources
    const [availableVideoSources, setAvailableVideoSources] = createSignal<Array<{ source_id: number; source_name: string }>>([]);

    // Overlay options
    const [availableOverlays, setAvailableOverlays] = createSignal<string[]>([]);
    const [selectedOverlay, setSelectedOverlay] = createSignal('');
    const [overlayInitialSyncDone, setOverlayInitialSyncDone] = createSignal(false);

    // Layout options
    const layoutOptions = [
        { value: 1, label: "Single Video", description: "One video takes full width" },
        { value: 2, label: "Side by Side", description: "Two videos side by side" },
        { value: 5, label: "Stacked Vertically", description: "Two videos stacked on top of each other" },
        { value: 3, label: "One Large + Two Small", description: "One large video on left, two small on right" },
        { value: 4, label: "Four Quarters", description: "Four videos in equal quarters" }
    ];

    // Default video configuration: Auto (source name) so user doesn't need to open properties unless using a different source
    const defaultVideoConfig = {
        layout: 1,
        sources: [SELECTED_SOURCE_SENTINEL],
        overlayName: ''
    };

    // Handle layout change
    const handleLayoutChange = (newLayout) => {
        setLayout(newLayout);
        setHasChanges(true);
    };

    // Handle video source change for a specific position
    const handleVideoSourceChange = (position, source) => {
        const currentSources = [...videoSources()];
        // Ensure the array is long enough for the position
        while (currentSources.length <= position) {
            currentSources.push('');
        }
        currentSources[position] = source;
        setVideoSources(currentSources);
        setHasChanges(true);
    };

    // Resolve date for media/sources API: selectedDate, or dataset date when a dataset is selected, or today
    const getDateForMediaSources = async (): Promise<string> => {
        const sd = selectedDate();
        if (sd && String(sd).trim()) {
            const s = String(sd).trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
            if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
            return s;
        }
        const datasetId = selectedDatasetId?.();
        if (datasetId && datasetId > 0) {
            try {
                const res = await getData(
                    `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
                );
                if (res?.success && res?.data?.date) {
                    let dateStr = String(res.data.date).trim();
                    if (/^\d{8}$/.test(dateStr)) dateStr = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
                    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                        log('Using dataset date for video sources:', dateStr);
                        return dateStr;
                    }
                }
            } catch (e) {
                warn('Could not get dataset date for video sources', e);
            }
        }
        return new Date().toISOString().split('T')[0];
    };

    // Load available video sources
    const loadAvailableVideoSources = async () => {
        try {
            // Check if user is available
            if (!user() || !user().user_id) {
                warn("User not available, skipping video sources fetch");
                return;
            }

            const dateToUse = await getDateForMediaSources();
            log('Using date for video sources:', dateToUse);

            const response_json = await getData(`${apiEndpoints.media.sources}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(dateToUse)}`);

            if (response_json.success && response_json.data && response_json.data.length > 0) {
                const sources = response_json.data.map((item: { media_source: string }) => item.media_source);
                log('Available video sources from API (media table):', sources);
                setAvailableVideoSources(sources);
                // Keep only selected sources that still exist in the API list
                const validSet = new Set(sources);
                const current = videoSources();
                if (current.some((s: string) => s && !validSet.has(s))) {
                    setVideoSources(current.filter((s: string) => !s || validSet.has(s)));
                }
            } else {
                log('No video sources found for date:', dateToUse, '- only media table sources are shown');
                setAvailableVideoSources([]);
                setVideoSources([]);
            }
        } catch (error: any) {
            logError("Error loading video sources:", error.message);
            setAvailableVideoSources([]);
            setVideoSources([]);
        }
    };

    const fetchVideoConfig = async () => {
        const controller = new AbortController();
        
        try {
            // Check if user is available
            if (!user() || !user().user_id) {
                warn("User not available, skipping video config fetch");
                setLayout(defaultVideoConfig.layout);
                setVideoSources(defaultVideoConfig.sources);
                setOverlayName(defaultVideoConfig.overlayName);
                setSelectedOverlay(defaultVideoConfig.overlayName);
                setOverlayInitialSyncDone(false);
                return;
            }
            
            const response_json = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=video&object_name=${chartObjectName()}`, controller.signal);

            if (response_json.success) {
                try {
                    const data = response_json.data;
                    log('Raw API response:', data);
                    let config = data?.chart_info ?? data;
                    if (typeof config === 'string') {
                        try {
                            config = JSON.parse(config);
                        } catch (parseErr) {
                            logError('Error parsing chart_info string:', parseErr);
                            config = data;
                        }
                    }
                    log('Parsed config:', config);
                    if (config?.layout != null) {
                        setLayout(config.layout);
                    }
                    if (config?.sources) {
                        setVideoSources(config.sources);
                    }
                    if (config?.overlayName !== undefined && config?.overlayName !== null && config?.overlayName !== '') {
                        log('Setting overlay name to:', config.overlayName);
                        setOverlayName(config.overlayName);
                        setOverlayInitialSyncDone(false);
                    } else {
                        log('No overlay name found, defaulting to empty string');
                        setOverlayName('');
                        setOverlayInitialSyncDone(false);
                    }
                    setLoadedChartObjectName(chartObjectName());
                    try {
                        const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user()!.user_id)}&parent_name=video`;
                        const namesRes = await getData(namesUrl, controller.signal);
                        setIsOwnerOfLoadedChart(isOwnerOfLoadedObject(namesRes?.success ? namesRes.data : null, chartObjectName()));
                    } catch (_) {
                        setIsOwnerOfLoadedChart(true);
                    }
                } catch (parseError) {
                    logError('Error parsing video config:', parseError);
                    setLayout(defaultVideoConfig.layout);
                    setVideoSources(defaultVideoConfig.sources);
                    setOverlayName(defaultVideoConfig.overlayName);
                    setSelectedOverlay(defaultVideoConfig.overlayName);
                    setOverlayInitialSyncDone(false);
                    setLoadedChartObjectName(null);
                    setIsOwnerOfLoadedChart(true);
                }
            } else {
                logError("Error loading video config...");
                setLayout(defaultVideoConfig.layout);
                setVideoSources(defaultVideoConfig.sources);
                setOverlayName(defaultVideoConfig.overlayName);
                setSelectedOverlay(defaultVideoConfig.overlayName);
                setOverlayInitialSyncDone(false);
                setLoadedChartObjectName(null);
                setIsOwnerOfLoadedChart(true);
            }
        } catch (error: any) {
            logError("Error loading video config:", error.message);
            setLayout(defaultVideoConfig.layout);
            setVideoSources(defaultVideoConfig.sources);
            setOverlayName(defaultVideoConfig.overlayName);
            setSelectedOverlay(defaultVideoConfig.overlayName);
            setOverlayInitialSyncDone(false);
            setLoadedChartObjectName(null);
            setIsOwnerOfLoadedChart(true);
        }
    };

    // Save video configuration (optional saveAsName for Save As flow)
    const saveVideoConfig = async (saveAsName?: string) => {
        const controller = new AbortController();
        if (!user() || !user().user_id) {
            logError("User not available, cannot save video config");
            return;
        }
        const objectName = (saveAsName || chartObjectName()).trim();
        if (isNewChartPlaceholderName(objectName)) {
            warn('Video builder: Cannot save until the chart name is updated from "new chart".');
            alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
            return;
        }
        try {
            const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=video`;
            const namesResponse = await getData(namesUrl, controller.signal);
            const existingNames: string[] = (namesResponse?.success && Array.isArray(namesResponse?.data))
                ? (namesResponse.data as { object_name: string }[]).map((o) => (o.object_name || '').trim()).filter(Boolean)
                : [];
            const nameAlreadyExists = existingNames.some((n) => n.toLowerCase() === objectName.toLowerCase());
            const isUpdatingOwnChart = !saveAsName && loadedChartObjectName() !== null && (loadedChartObjectName() || '').trim().toLowerCase() === objectName.toLowerCase();
            if (nameAlreadyExists && !isUpdatingOwnChart) {
                warn('Video builder: Save blocked - chart name already exists:', objectName);
                setChartNameError('duplicate');
                alert(`A chart named "${objectName}" already exists. Please choose a different name.`);
                return;
            }
            setChartNameError(null);
            const videoConfig = {
                layout: layout(),
                sources: videoSources().slice(0, layout()),
                overlayName: overlayName() || ''
            };
            const chartObject = {
                "parent_name": "video",
                "chart_name": "default",
                "chart_info": videoConfig,
                "shared": 0
            };
            const summary_json = {
                'class_name': selectedClassName(),
                'project_id': selectedProjectId(),
                'user_id': user().user_id,
                'parent_name': 'video',
                'object_name': objectName,
                'json': JSON.stringify(chartObject, null, 2)
            };
            log("Saving video config:", JSON.stringify(videoConfig, null, 2));

            const response_json = await postData(`${apiEndpoints.app.users}/object`, summary_json, controller.signal);

            if (response_json.success) {
                log("Saved successfully!", JSON.stringify(videoConfig, null, 2));
                const previousName = loadedChartObjectName();
                const isRename = !saveAsName && previousName !== null && previousName.trim().toLowerCase() !== objectName.toLowerCase();
                if (isRename) {
                    const delete_json = {
                        class_name: selectedClassName(),
                        project_id: selectedProjectId(),
                        user_id: user().user_id,
                        parent_name: 'video',
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
                try {
                    logInfo("Video Builder: Refreshing media cache for video sources", { sources: videoConfig.sources, layout: videoConfig.layout });
                    const refreshPromises = videoConfig.sources.map(async (source: string) => {
                        if (source?.trim()) {
                            try {
                                await mediaFilesService.refreshCache(source);
                                logInfo("Video Builder: Refreshed cache for source", source);
                            } catch (error: any) {
                                logError("Video Builder: Failed to refresh cache for source", source, error);
                            }
                        }
                    });
                    await Promise.all(refreshPromises);
                    logInfo("Video Builder: Media cache refresh completed");
                } catch (error: any) {
                    logError("Video Builder: Error refreshing media cache", error);
                }
                setSelectedMenu("VIDEO");
                setSelectedPage(objectName);
                navigate("/dashboard");
            } else {
                log("Save Failed -", response_json.message);
            }
        } catch (error: any) {
            logError("Error saving video config:", error);
        }
    };

    const saveAsNewChart = async () => {
        const newName = prompt("Enter a new name for this layout:", `${chartObjectName()} Copy`);
        if (newName && newName.trim()) {
            const trimmed = newName.trim();
            if (isNewChartPlaceholderName(trimmed)) {
                warn('Video builder: Cannot use "new chart" as the layout name.');
                alert('Please choose a different name. "New chart" is only a placeholder.');
                return;
            }
            await saveVideoConfig(trimmed);
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
                'parent_name': 'video', 
                'object_name': chartObjectName()
            };

            const response_json = await deleteData(`${apiEndpoints.app.users}/object`, delete_json, controller.signal);

            if (response_json.success) {
                log("Deleted successfully!");
                setSidebarMenuRefreshTrigger(1);
                // Chart configuration deleted successfully
                
                // Navigate back to dashboard
                setSelectedMenu("VIDEO");
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

    // Load available overlays
    const loadAvailableOverlays = async () => {
        try {
            // Check if user is available
            if (!user() || !user().user_id) {
                warn("User not available, skipping overlay fetch");
                return;
            }

            const response_json = await getData(
                `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=overlay`
            );

            if (response_json.success && response_json.data) {
                // Extract object_name from response (could be array of objects or strings)
                const overlays = response_json.data.map(item => 
                    typeof item === 'string' ? item : (item.object_name || item)
                );
                log('Available overlays from API:', overlays);
                setAvailableOverlays(overlays);
                // Note: selectedOverlay will be synced automatically by the reactive effect
            } else {
                log('No overlays found');
                setAvailableOverlays([]);
            }
        } catch (error: any) {
            logError("Error loading overlays:", error.message);
            setAvailableOverlays([]);
        }
    };

    // Handle navigation to overlay builder
    const handleNavigateToOverlayBuilder = () => {
        const overlay = selectedOverlay();
        if (overlay === 'Create New Overlay') {
            // Navigate to overlay builder with "Create New Overlay" as object_name
            navigate('/overlay-builder?object_name=Create New Overlay');
        } else if (overlay) {
            // Navigate to overlay builder with object_name for editing
            navigate(`/overlay-builder?object_name=${encodeURIComponent(overlay)}`);
        } else {
            // Default: navigate to overlay builder for new overlay
            navigate('/overlay-builder?object_name=Create New Overlay');
        }
    };

    // Removed onMount fetch; replaced by reactive effect above

    // Sync selectedOverlay with overlayName when overlays are available (only during initial load)
    createEffect(() => {
        const currentOverlayName = overlayName();
        const overlays = availableOverlays();
        const currentSelected = selectedOverlay();
        const syncDone = overlayInitialSyncDone();
        
        log('Reactive effect triggered - overlayName:', currentOverlayName, 'overlays:', overlays, 'selectedOverlay:', currentSelected, 'syncDone:', syncDone);
        
        // Only sync during initial load, not after user has made changes
        if (syncDone) {
            log('Initial sync already done, skipping reactive sync');
            return;
        }
        
        // Only sync if we have overlays loaded
        if (overlays.length > 0) {
            // Mark sync as done after first successful sync
            setOverlayInitialSyncDone(true);
            
            // Only sync if we have an overlay name
            if (currentOverlayName && currentOverlayName !== '') {
                // Check if the overlay name exists in the available overlays
                if (overlays.includes(currentOverlayName)) {
                    // Only update if it's different to avoid unnecessary updates
                    if (currentSelected !== currentOverlayName) {
                        log('Initial sync: Setting selectedOverlay to:', currentOverlayName);
                        setSelectedOverlay(currentOverlayName);
                    } else {
                        log('selectedOverlay already matches overlayName:', currentOverlayName);
                    }
                } else {
                    log('Overlay name not found in available overlays:', currentOverlayName, 'Available:', overlays);
                    // Clear selection if saved overlay doesn't exist
                    if (currentSelected !== '') {
                        setSelectedOverlay('');
                    }
                }
            } else {
                // If no overlay name, ensure selectedOverlay is empty
                if (currentSelected !== '') {
                    log('Initial sync: Clearing selectedOverlay (no overlay name)');
                    setSelectedOverlay('');
                }
            }
        }
    });

    // Render video layout preview
    const sourcePreviewLabel = (src: string, fallback: string) =>
        isSelectedSourceSentinel(src) ? 'Selected source' : (src || fallback);

    const renderVideoLayout = () => {
        const currentLayout = layout();
        const sources = videoSources();
        
        switch (currentLayout) {
            case 1:
                return (
                    <div class="w-full h-64 bg-gray-200 dark:bg-gray-700 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center">
                        <div class="text-center">
                            <div class="w-full h-48 bg-gray-300 dark:bg-gray-600 rounded flex items-center justify-center mb-2">
                                <div class="text-gray-600 dark:text-gray-400 text-sm font-medium">
                                    {sourcePreviewLabel(sources[0], 'Video 1')}
                                </div>
                            </div>
                            <select
                                value={sources[0] || ''}
                                onChange={(e) => handleVideoSourceChange(0, e.target.value)}
                                class="w-full px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                            >
                                <option value="">Select video source</option>
                                <option value={SELECTED_SOURCE_SENTINEL}>Auto (SourceName)</option>
                                {availableVideoSources().map(source => (
                                    <option value={source}>{source}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                );
            
            case 2:
                return (
                    <div class="w-full h-64 bg-gray-200 dark:bg-gray-700 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 flex gap-2 p-2">
                        {[0, 1].map(index => (
                            <div class="flex-1 flex flex-col items-center justify-center">
                                <div class="w-full h-40 bg-gray-300 dark:bg-gray-600 rounded flex items-center justify-center mb-2">
                                    <div class="text-gray-600 dark:text-gray-400 text-sm font-medium">
                                        {sourcePreviewLabel(sources[index], `Video ${index + 1}`)}
                                    </div>
                                </div>
                                <select
                                    value={sources[index] || ''}
                                    onChange={(e) => handleVideoSourceChange(index, e.target.value)}
                                    class="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                >
                                    <option value="">Select source</option>
                                    <option value={SELECTED_SOURCE_SENTINEL}>Auto (Selected SourceName)</option>
                                    {availableVideoSources().map(source => (
                                        <option value={source}>{source}</option>
                                    ))}
                                </select>
                            </div>
                        ))}
                    </div>
                );
            
            case 5:
                return (
                    <div class="w-full h-64 bg-gray-200 dark:bg-gray-700 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 flex flex-col gap-2 p-2">
                        {[0, 1].map(index => (
                            <div class="flex-1 flex flex-col items-center justify-center">
                                <div class="w-full h-24 bg-gray-300 dark:bg-gray-600 rounded flex items-center justify-center mb-2">
                                    <div class="text-gray-600 dark:text-gray-400 text-sm font-medium">
                                        {sourcePreviewLabel(sources[index], `Video ${index + 1}`)}
                                    </div>
                                </div>
                                <select
                                    value={sources[index] || ''}
                                    onChange={(e) => handleVideoSourceChange(index, e.target.value)}
                                    class="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                >
                                    <option value="">Select source</option>
                                    <option value={SELECTED_SOURCE_SENTINEL}>Auto (Selected SourceName)</option>
                                    {availableVideoSources().map(source => (
                                        <option value={source}>{source}</option>
                                    ))}
                                </select>
                            </div>
                        ))}
                    </div>
                );
            
            case 3:
                return (
                    <div class="w-full h-64 bg-gray-200 dark:bg-gray-700 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 flex gap-2 p-2">
                        {/* Large video on left */}
                        <div class="w-2/3 flex flex-col items-center justify-center">
                            <div class="w-full h-48 bg-gray-300 dark:bg-gray-600 rounded flex items-center justify-center mb-2">
                                <div class="text-gray-600 dark:text-gray-400 text-sm font-medium">
                                    {sourcePreviewLabel(sources[0], 'Video 1')}
                                </div>
                            </div>
                            <select
                                value={sources[0] || ''}
                                onChange={(e) => handleVideoSourceChange(0, e.target.value)}
                                class="w-full px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                            >
                                <option value="">Select source</option>
                                <option value={SELECTED_SOURCE_SENTINEL}>Auto (Selected SourceName)</option>
                                {availableVideoSources().map(source => (
                                    <option value={source}>{source}</option>
                                ))}
                            </select>
                        </div>
                        {/* Two small videos on right */}
                        <div class="w-1/3 flex flex-col gap-2">
                            {[1, 2].map(index => (
                                <div class="flex-1 flex flex-col items-center justify-center">
                                    <div class="w-full h-20 bg-gray-300 dark:bg-gray-600 rounded flex items-center justify-center mb-1">
                                        <div class="text-gray-600 dark:text-gray-400 text-xs font-medium">
                                            {sourcePreviewLabel(sources[index], `Video ${index + 1}`)}
                                        </div>
                                    </div>
                                    <select
                                        value={sources[index] || ''}
                                        onChange={(e) => handleVideoSourceChange(index, e.target.value)}
                                        class="w-full px-1 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                    >
                                        <option value="">Select</option>
                                        <option value={SELECTED_SOURCE_SENTINEL}>Auto (Selected SourceName)</option>
                                        {availableVideoSources().map(source => (
                                            <option value={source}>{source}</option>
                                        ))}
                                    </select>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            
            case 4:
                return (
                    <div class="w-full h-64 bg-gray-200 dark:bg-gray-700 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 grid grid-cols-2 gap-2 p-2">
                        {[0, 1, 2, 3].map(index => (
                            <div class="flex flex-col items-center justify-center">
                                <div class="w-full h-20 bg-gray-300 dark:bg-gray-600 rounded flex items-center justify-center mb-1">
                                    <div class="text-gray-600 dark:text-gray-400 text-xs font-medium">
                                        {sourcePreviewLabel(sources[index], `Video ${index + 1}`)}
                                    </div>
                                </div>
                                <select
                                    value={sources[index] || ''}
                                    onChange={(e) => handleVideoSourceChange(index, e.target.value)}
                                    class="w-full px-1 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                >
                                    <option value="">Select</option>
                                    <option value={SELECTED_SOURCE_SENTINEL}>Auto (Selected SourceName)</option>
                                    {availableVideoSources().map(source => (
                                        <option value={source}>{source}</option>
                                    ))}
                                </select>
                            </div>
                        ))}
                    </div>
                );
            
            default:
                return null;
        }
    };

    return (
        <div class="builder-page bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100">
            {loading() && <Loading />}
            <div class="mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-16" style={{
                "opacity": loading() ? 0 : 1, 
                "pointer-events": loading() ? "none" : "auto", 
                "transition": "opacity 0.3s ease",
                "min-width": "1000px",
                "max-height": "100vh",
                "overflow-y": "auto"
            }}>
                {/* Header */}
                <div class="builder-page-header">
                    <div class="builder-page-title">
                        <div class="builder-page-title-content">
                            <h1>Video Layout</h1>
                            <p>Configure video layout and sources</p>
                        </div>
                    </div>
                </div>

                <form class="builder-form" style={{ "min-width": "1000px" }}>
                    {/* Video Configuration */}
                    <div class="builder-form-card mb-3" style="height: calc(100% + 50px);">
                        <div class="builder-form-header">
                            <div class="flex items-center justify-between">
                                <div class="flex items-center space-x-3">
                                    <div class="w-8 h-8 rounded-md flex items-center justify-center" style="background: var(--color-bg-button);">
                                        <span class="font-bold text-sm" style="color: var(--color-text-inverse);">1</span>
                                    </div>
                                    <div>
                                        <h2 class="text-base font-semibold" style="color: var(--color-text-primary);">Video Configuration</h2>
                                        <p class="text-xs" style="color: var(--color-text-secondary);">VIDEO</p>
                                    </div>
                                </div>
                                <div class="flex items-center space-x-3">
                                    <span class="inline-flex items-center px-2 py-1 rounded text-xs font-medium" style="background: var(--color-bg-tertiary); color: var(--color-text-secondary);">
                                        {layout()} video{layout() !== 1 ? 's' : ''}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div class="builder-form-content">
                            <div class="flex flex-wrap items-start gap-6">
                                <div class="flex-1 min-w-[400px]">
                                    <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">
                                        Layout Name
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
                                        class={`builder-form-input w-full px-4 py-2 text-sm text-gray-900 dark:text-gray-100 ${(isNewChartPlaceholderName(chartObjectName()) || chartNameError() === 'duplicate') ? 'builder-form-input-invalid' : ''}`}
                                        placeholder="Enter layout name"
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
                                <div class="min-w-[300px]">
                                    <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">
                                        Layout
                                    </label>
                                    <select
                                        value={layout()}
                                        onChange={(e) => handleLayoutChange(parseInt(e.target.value))}
                                        class="builder-form-input w-full px-4 py-2 text-sm text-gray-900 dark:text-gray-100"
                                    >
                                        {layoutOptions.map(option => (
                                            <option value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                    <p class="text-xs mt-1" style="color: var(--color-text-secondary);">
                                        {layoutOptions.find(opt => opt.value === layout())?.description}
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Layout Preview */}
                    <div class="builder-form-card">
                        <div class="builder-form-header">
                            <div class="flex items-center space-x-3">
                                <div class="w-8 h-8 rounded-md flex items-center justify-center" style="background: var(--color-bg-button);">
                                    <span class="font-bold text-sm" style="color: var(--color-text-inverse);">2</span>
                                </div>
                                <div>
                                    <h2 class="text-base font-semibold" style="color: var(--color-text-primary);">Layout Preview</h2>
                                    <p class="text-xs" style="color: var(--color-text-secondary);">Preview how videos will be arranged</p>
                                </div>
                            </div>
                        </div>
                        <div class="builder-form-content" style="padding-top: 5px; height: calc(100% + 50px);">
                            {renderVideoLayout()}
                        </div>
                    </div>

                    {/* Overlay Options */}
                    <div class="builder-form-card">
                        <div class="builder-form-header">
                            <div class="flex items-center space-x-3">
                                <div class="w-8 h-8 rounded-md flex items-center justify-center" style="background: var(--color-bg-button);">
                                    <span class="font-bold text-sm" style="color: var(--color-text-inverse);">3</span>
                                </div>
                                <div>
                                    <h2 class="text-base font-semibold" style="color: var(--color-text-primary);">Overlay Options</h2>
                                    <p class="text-xs" style="color: var(--color-text-secondary);">Select an overlay to display on videos</p>
                                </div>
                            </div>
                        </div>
                        <div class="builder-form-content">
                            <div class="flex flex-wrap items-end gap-4">
                                <div class="flex-1 min-w-[300px]">
                                    <label class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">
                                        Overlay
                                    </label>
                                    <select
                                        value={selectedOverlay()}
                                        onChange={(e) => {
                                            const newValue = e.target.value;
                                            setSelectedOverlay(newValue);
                                            // Update overlayName to match user selection
                                            setOverlayName(newValue === 'Create New Overlay' || newValue === '' ? '' : newValue);
                                            // Mark that initial sync is done so reactive effect doesn't override user changes
                                            setOverlayInitialSyncDone(true);
                                            setHasChanges(true);
                                        }}
                                        class="builder-form-input w-full px-4 py-2 text-sm text-gray-900 dark:text-gray-100"
                                    >
                                        <option value="">No overlay</option>
                                        {availableOverlays().map(overlay => (
                                            <option value={overlay}>{overlay}</option>
                                        ))}
                                        <option value="Create New Overlay">Create New Overlay</option>
                                    </select>
                                </div>
                                <div>
                                    <button
                                        type="button"
                                        onClick={handleNavigateToOverlayBuilder}
                                        class="builder-form-button px-4 py-2 text-sm"
                                        disabled={!selectedOverlay()}
                                    >
                                        {selectedOverlay() === 'Create New Overlay' ? 'Build Overlay' : 'Edit Overlay'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    {/* Save / Save As - show Save when hasChanges; disable when non-owner or placeholder */}
                    <div class="flex justify-center gap-3 mt-6">
                        {hasChanges() && (
                            <button
                                onClick={(e) => {
                                    e.preventDefault();
                                    if (loadedChartObjectName() !== null && !isOwnerOfLoadedChart()) return;
                                    if (isNewChartPlaceholderName(chartObjectName())) {
                                        warn('Video builder: Cannot save until the chart name is updated from "new chart".');
                                        alert('Please update the chart name before saving. "New chart" is only a placeholder for new charts.');
                                        return;
                                    }
                                    saveVideoConfig();
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

                    {/* Delete Button - only for owner when layout is loaded */}
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

                <BackButton />
            </div>
        </div>
    );
}
