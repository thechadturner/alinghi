import { onMount, createEffect, For, Show, createSignal, onCleanup } from "solid-js";
import { selectedTime } from "../../store/playbackStore";
import { user } from "../../store/userStore"; 
import { unifiedDataStore } from "../../store/unifiedDataStore";
import { persistantStore } from "../../store/persistantStore";
import { selectedDate as selectionSelectedDate } from "../../store/selectionStore";
import { selectedRacesTimeseries, selectedLegsTimeseries, selectedGradesTimeseries } from "../../store/filterStore";
import { apiEndpoints } from "@config/env";
import { getData} from "../../utils/global";
import { warn, error as logError, debug, log } from "../../utils/console";
import { extractRequiredChannels } from "../../utils/channelExtractor";

// Static import for worker - Vite will bundle this correctly in production
import OverlayDataWorker from "../../workers/overlay-data-processor.ts?worker";

import TextBox from "./guages/TextBox";
import Sparkline from "./guages/Sparkline";
import Donut from "./guages/Donut";
import Donut180 from "./guages/Donut180";
import Donut180Dot from "./guages/Donut180Dot";

const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceName, selectedSourceId, selectedDate, overlayPositions, setOverlayPositions, savePersistentSettings } = persistantStore;

interface OverlayProps {
    padding_top?: string;
    padding_right?: string;
    color?: string;
    /** Overlay config object name for API fetch (e.g. from MapContainer: objectName). Takes precedence over overlayName. */
    objectName?: string;
    /** Legacy/alternate name for overlay config object (e.g. from Video page). Used when objectName is not provided. */
    overlayName?: string;
}

interface Position {
    x: number;
    y: number;
}

export default function Overlay({ padding_top = "20px", padding_right = "20px", color = "#333", objectName: objectNameProp, overlayName }: OverlayProps = { padding_top: "20px", padding_right: "20px", color: "#333", overlayName: undefined }) {
    const [channels, setChannels] = createSignal<any[]>([]);
    const [display, setDisplay] = createSignal<any[]>([]);
    const [row, setRow] = createSignal<any>({});
    const [backgroundColor, setBackgroundColor] = createSignal("#FFFFFF");
    const [opacity, setOpacity] = createSignal(1.0);
    const [overlayType, setOverlayType] = createSignal("TextBox"); // Default to TextBox
    const [orientation, setOrientation] = createSignal("horizontal");
    const [position, setPosition] = createSignal<Position>({ x: 50, y: 50 }); // Position in percentage
    const [isUserDraggedPosition, setIsUserDraggedPosition] = createSignal(false); // Track if position is from localStorage (user-dragged)

    // MapContainer passes objectName; Video page passes overlayName. Use objectName first so explore/map overlay loads correctly.
    let chartObjectName = objectNameProp || overlayName || 'default'
    let containerRef: HTMLElement | null = null;
    // Declare early so onMount/onCleanup can use them (avoid TDZ)
    let sidebarObserver: MutationObserver | null = null;
    let rowUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    let mapFilterTimeout: ReturnType<typeof setTimeout> | null = null;

    // Get data and loading state from unified data store
    const [overlayData, setOverlayData] = createSignal<any[]>([]);
    const [isLoading_overlay, setIsLoading_overlay] = createSignal(false);
    const data_overlay = () => overlayData();



    /**
     * Pre-fetch all required channels for child components.
     * Data is held in memory (overlayData signal); children receive current row via props.
     */
    const prefetchAllChannels = async (chartConfig: any): Promise<void> => {
        try {
            if (!chartConfig) {
                debug('Overlay: No chart config available for channel prefetch');
                return;
            }
            
            // Extract ALL required channels from the chart configuration
            const allRequiredChannels = extractRequiredChannels(chartConfig);
            
            if (allRequiredChannels.length <= 1) { // Only Datetime
                debug('Overlay: No channels to prefetch (only Datetime)');
                return;
            }
            
            debug('Overlay: Pre-fetching all required channels:', allRequiredChannels);
            
            // Resolve date: dataset mode uses dataset info; day mode uses selectedDate
            let formattedDate = null;
            try {
                const dsId = selectedDatasetId();
                if (dsId && dsId > 0) {
                    const datasetInfoResponse = await getData(`${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(dsId)}`);
                    const raw = datasetInfoResponse?.data?.date;
                    if (raw) formattedDate = String(raw).replace(/-/g, "");
                }
            } catch (_) {}
            if (!formattedDate) {
                const day = selectionSelectedDate && selectionSelectedDate();
                if (day && typeof day === 'string') {
                    formattedDate = day.replace(/[-/]/g, "");
                }
            }
            
            if (!formattedDate) {
                debug('Overlay: No date available for channel prefetch');
                return;
            }
            
            // Fetch ALL channels at once; data is held in memory (Overlay overlayData signal).
            // Child components receive the current row from Overlay via props (dataRow).
            // IMPORTANT: Overlay uses raw file data, so validate channels against file server
            await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
                'overlay',
                selectedClassName(),
                selectedSourceId().toString(),
                allRequiredChannels,
                {
                    projectId: selectedProjectId(),
                    className: selectedClassName(),
                    datasetId: selectedDatasetId(),
                    sourceName: selectedSourceName(),
                    date: formattedDate
                },
                'timeseries' // Explicitly define data source
            );
            
            debug('Overlay: Successfully pre-fetched all channels (data held in memory)');
        } catch (error: any) {
            logError('Overlay: Error pre-fetching channels:', error);
            // Don't throw - allow child components to fetch individually as fallback
        }
    };

    const fetchChannels = async () => {
        try {
            let chartObjectNameToFetch = chartObjectName;
            let response: any = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=overlay&object_name=${encodeURIComponent(chartObjectNameToFetch)}`);
            if (!response.success) {
                logError('❌ Overlay: Failed to fetch dataset object:', response.error || response.message);
                throw new Error("Failed to fetch dataset object.");
            }
            let chartData = response.data;
            const hasConfig = chartData && chartData.chart_info && chartData.chart_info[0] && chartData.chart_info[0].series;
            if (!hasConfig && chartObjectNameToFetch !== 'default') {
                debug('Overlay: No config for object_name="' + chartObjectNameToFetch + '", falling back to "default"');
                chartObjectNameToFetch = 'default';
                response = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=overlay&object_name=default`);
                if (response?.success && response?.data) chartData = response.data;
            }
            if (chartData && chartData.chart_info && chartData.chart_info[0] && chartData.chart_info[0].series) {
                // Extract overlay configuration
                const overlayConfig = chartData.chart_info[0];
                setBackgroundColor(overlayConfig.backgroundColor || "#FFFFFF");
                setOpacity(overlayConfig.opacity || 1.0);
                const loadedOverlayType = overlayConfig.overlayType || "TextBox";
                debug('Overlay: Loading overlay type from config:', loadedOverlayType, 'full config:', overlayConfig);
                setOverlayType(loadedOverlayType); // Extract overlay type
                
                // Pre-fetch ALL required channels before child components render
                // This ensures all channel-value data is in HuniDB for child components to query
                await prefetchAllChannels(overlayConfig);
                
                // Pre-fetch ALL required channels before child components render
                // This ensures all channel-value data is in HuniDB for child components to query
                await prefetchAllChannels(overlayConfig);
                
                // Extract orientation and position from chart object (fallback source)
                const configOrientation = overlayConfig.orientation || "horizontal";
                const configPosition = overlayConfig.position || { x: 50, y: 50 };
                
                // Check if chart object position is valid
                const isValidChartPosition = configPosition && 
                                           typeof configPosition === 'object' &&
                                           typeof configPosition.x === 'number' &&
                                           typeof configPosition.y === 'number';
                
                // Helper function to validate position bounds
                const isValidBounds = (pos) => {
                    return pos && 
                           typeof pos === 'object' &&
                           typeof pos.x === 'number' &&
                           typeof pos.y === 'number' &&
                           pos.x >= 0 && pos.x <= 100 &&
                           pos.y >= 0 && pos.y <= 100;
                };
                
                log('Overlay: Loading position - chart object:', {
                    configOrientation,
                    configPosition,
                    isValidChartPosition,
                    fullOverlayConfig: overlayConfig,
                    chartObjectName: chartObjectName
                });
                
                // Priority: user settings (API) → localStorage (legacy) → chart object → defaults
                const storageKey = `overlay_position_${chartObjectName}`;
                let finalPosition = configPosition;
                let finalOrientation = configOrientation;
                let usingUserPosition = false;
                
                // 1) Check user settings (persisted to API, reused across devices)
                // Use saved position but always prefer chart config for orientation so builder layout (horizontal/vertical) wins.
                try {
                    const savedFromSettings = overlayPositions()?.[chartObjectName];
                    if (savedFromSettings?.position && isValidBounds(savedFromSettings.position)) {
                        finalPosition = savedFromSettings.position;
                        finalOrientation = configOrientation;
                        usingUserPosition = true;
                        log('Overlay: Using position from user settings:', finalPosition, 'orientation from config:', finalOrientation);
                    }
                } catch (e) {
                    logError('Overlay: Error reading overlay position from user settings:', e);
                }
                
                // 2) Fallback: localStorage (legacy / same-device). Position from saved; orientation from chart config.
                if (!usingUserPosition) {
                    try {
                        const savedPosition = localStorage.getItem(storageKey);
                        if (savedPosition) {
                            const parsed = JSON.parse(savedPosition);
                            log('Overlay: Found localStorage position:', parsed);
                            if (parsed.position && isValidBounds(parsed.position)) {
                                finalPosition = parsed.position;
                                finalOrientation = configOrientation;
                                usingUserPosition = true;
                                log('Overlay: Using validated localStorage position:', finalPosition);
                            } else {
                                log('Overlay: localStorage position invalid/out of bounds, using chart object');
                            }
                        }
                    } catch (e) {
                        logError('Overlay: Error reading localStorage:', e);
                    }
                }
                
                // If no user position, use chart object position or defaults
                if (!usingUserPosition && isValidChartPosition) {
                    finalPosition = configPosition;
                    finalOrientation = configOrientation;
                    log('Overlay: Using chart object position:', finalPosition);
                } else if (!usingUserPosition) {
                    log('Overlay: Using default position:', finalPosition);
                }
                
                // Set position and orientation
                log('Overlay: Setting final position and orientation:', {
                    finalPosition,
                    finalOrientation,
                    usingUserPosition,
                    chartObjectName: chartObjectName
                });
                setOrientation(finalOrientation);
                setPosition(finalPosition);
                setIsUserDraggedPosition(usingUserPosition);
                log('Overlay: Position and orientation set. Position signal:', position(), 'Orientation signal:', orientation());
                
                let channel_items = [{'name': 'Datetime', 'type': 'datetime'}];
                let display_items = [];

                let series_list = chartData.chart_info[0].series;
                let series2_list = chartData.chart_info[0].series2 || []; // Get secondary series if available
                const currentOverlayType = overlayConfig.overlayType || "TextBox";

                // Loop through primary channels
                series_list.forEach((item, index) => {
                    // Only process if channel exists
                    if (item && item.channel && item.channel.name) {
                        let channel_item = item.channel;
                        channel_items.push(channel_item);

                        try {
                            channel_item.color = item.color;
                        } catch {
                            channel_item.color = color;
                        }

                        // Store type-specific properties from series item
                        if (currentOverlayType === "Sparkline") {
                            channel_item.timespan = item.timespan || 30;
                            channel_item.width = item.width || 150;
                            channel_item.height = item.height || 60; // Default height matches current component height
                        } else if (currentOverlayType === "Donut") {
                            channel_item.donutType = item.donutType || "basic";
                            channel_item.label = item.label ?? item.channel?.name ?? item.name ?? "";
                            channel_item.height = item.height || 150; // Use height instead of width
                            if (item.targetValue !== undefined) {
                                channel_item.targetValue = item.targetValue;
                            }
                            if (item.warningValue !== undefined) {
                                channel_item.warningValue = item.warningValue;
                            }
                            if (item.alarmValue !== undefined) {
                                channel_item.alarmValue = item.alarmValue;
                            }
                        } else if (currentOverlayType === "180" || currentOverlayType === "180 Dot") {
                            channel_item.height = item.height || 150; // Use height instead of width
                        } else {
                            // TextBox - Check if there's a corresponding secondary channel in series2
                            channel_item.height = item.height || 60; // Default height for TextBox
                            channel_item.primaryChannelLabel = item.primaryChannelLabel ?? "";
                            channel_item.secondaryChannelLabel = series2_list[index]?.secondaryChannelLabel ?? "";
                            if (series2_list[index] && series2_list[index].channel2 && series2_list[index].channel2.name) {
                                channel_item.channel2 = series2_list[index].channel2;
                                // Use channel2 color if specified, otherwise use primary color
                                channel_item.channel2.color = series2_list[index].channel2.color || item.color;
                            }
                        }

                        display_items.push(channel_item);
                    }
                });

                // Loop through secondary channels (series2) to add channel2 to channel_items for data fetching
                // Only for TextBox type
                if (currentOverlayType === "TextBox") {
                    series2_list.forEach(item => {
                        // Only add channel2 if it exists, skip the channel field (already added from series)
                        if (item.channel2 && item.channel2.name) {
                            channel_items.push(item.channel2);
                        }
                    });
                }

                // Channel items configured
                setChannels(channel_items);
                setDisplay(display_items);
            } else {
                // No overlay config: expected when default overlay not set up; only warn for named overlays
                if (chartObjectNameToFetch !== 'default') {
                    warn('⚠️ Overlay: No chart_info or series found in response for object_name="' + chartObjectNameToFetch + '"');
                } else {
                    debug('Overlay: No chart_info or series in response (default overlay not configured)');
                }
                setChannels([]);
                setDisplay([]);
            }
        } catch (error: any) {
            logError('❌ Overlay: Error fetching channels:', error);
            setChannels([]);
            setDisplay([]);
        }
    };

    /**
     * Retrieve overlay data once: try in-memory cache first (map already loaded), else fetch.
     * Store result in memory (overlayData signal). When selectedTime changes,
     * we look up from this in-memory data only (no refetch).
     */
    const fetchAndFormatData = async () => {
        try {
            if (channels().length > 0) {
                setIsLoading_overlay(true);
                const requestedChannels = channels().map(c => c.name);
                if (requestedChannels.length === 0) {
                    warn('⚠️ Overlay: No channels defined for overlay');
                    return;
                }
                const className = selectedClassName();
                const projectId = selectedProjectId();
                const sourceId = selectedSourceId();
                const datasetId = selectedDatasetId();

                // Overlay always fetches from API (timeseries), not map cache. Map data has a reduced
                // channel set (e.g. Twa_deg); overlay needs full timeseries channels (e.g. Twa_n_deg).
                let formattedDate: string | null = null;
                try {
                    if (datasetId && datasetId > 0) {
                        const datasetInfoResponse = await getData(`${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`);
                        const raw = datasetInfoResponse?.data?.date;
                        if (raw) formattedDate = String(raw).replace(/-/g, '');
                    }
                    if (!formattedDate && selectionSelectedDate?.()) {
                        const day = selectionSelectedDate();
                        if (typeof day === 'string') formattedDate = day.replace(/[-/]/g, '').slice(0, 8);
                    }
                } catch (_) {}
                if (!formattedDate) {
                    debug('⚠️ Overlay: No date available for overlay fetch');
                    setOverlayData([]);
                    return;
                }
                const fetched = await unifiedDataStore.fetchDataWithChannelChecking(
                    'overlay',
                    className,
                    String(sourceId),
                    requestedChannels,
                    {
                        projectId: Number(projectId),
                        className,
                        datasetId,
                        sourceName: selectedSourceName(),
                        date: formattedDate
                    },
                    'timeseries'
                );
                const data = Array.isArray(fetched) && fetched.length > 0 ? fetched : null;

                if (data && data.length > 0) {
                    setOverlayData(data);
                    cachedTimeseriesData = data;
                    lastDataFetchTime = Date.now();
                } else {
                    warn('⚠️ Overlay: No data available (cache or fetch)');
                    setOverlayData([]);
                }
            }
        } catch (error: any) {
            logError('❌ Overlay: Error in fetchAndFormatData:', error);
            setOverlayData([]);
        } finally {
            setIsLoading_overlay(false);
        }
    };

    const loadDataInBackground = async () => {
        try {
            await fetchChannels();
            const processData = () => {
                return new Promise<void>((resolve) => {
                    if (window.requestIdleCallback) {
                        window.requestIdleCallback(() => {
                            fetchAndFormatData().then(resolve);
                        }, { timeout: 50 });
                    } else {
                        setTimeout(() => {
                            fetchAndFormatData().then(resolve);
                        }, 0);
                    }
                });
            };
            await processData();
        } catch (error: unknown) {
            logError('Error loading overlay data:', error as Error);
        }
    };

    // Reload overlay when objectName/overlayName changes (e.g. user applied a different overlay in Map Settings)
    createEffect(() => {
        const _ = objectNameProp || overlayName || 'default';
        loadDataInBackground();
    });

    // Time-based query: use local overlay data first (in-memory), then IndexedDB fallback
    async function findClosestTimeBased(targetDatetime) {
        try {
            if (!targetDatetime) {
                return null;
            }

            const targetTime = new Date(targetDatetime);
            if (isNaN(targetTime.getTime())) {
                return null;
            }
            
            // First try local overlay data (single source of truth, no HuniDB)
            const data = data_overlay();
            if (data && data.length > 0) {
                const closestData = findClosestTimeInCachedData(data, targetTime);
                if (closestData) {
                    return closestData;
                }
            }
            
            // Fallback to IndexedDB if no local data or miss
            return await findClosestTimeBasedFromIndexedDB(targetDatetime);
        } catch (error: any) {
            logError('❌ Overlay: Error finding closest data point:', error);
            return null;
        }
    }
    
    // Fallback function for IndexedDB lookup (original implementation)
    async function findClosestTimeBasedFromIndexedDB(targetDatetime) {
        try {
            if (!targetDatetime) {
                return null;
            }

            const targetTime = new Date(targetDatetime).getTime();
            if (isNaN(targetTime)) {
                return null;
            }
            
            // Get channels from the current overlay configuration
            const requestedChannels = channels().map(c => c.name);
            if (requestedChannels.length === 0) {
                return null;
            }
            
            // Query IndexedDB for data around the target time (within 1 minute range for better performance)
            const timeRange = {
                start: targetTime - 60000, // 1 minute before
                end: targetTime + 60000    // 1 minute after
            };
            
            // Query the channel-based IndexedDB with time range and filters
            const data = await unifiedDataStore.queryDataByChannels(
                selectedClassName(),
                selectedSourceId().toString(),
                requestedChannels,
                ['timeseries'],
                timeRange,
                {
                    raceNumbers: selectedRacesTimeseries(),
                    legNumbers: selectedLegsTimeseries(),
                    grades: selectedGradesTimeseries()
                }
            );
            
            if (!data || data.length === 0) {
                return null;
            }

            // Use worker for binary search if dataset is large
            if (data.length > 1000) {
                try {
                    // Use ?worker import - Vite bundles this correctly in production
                    const worker = new OverlayDataWorker();
                    
                    if (!worker) {
                        throw new Error('Failed to create overlay worker');
                    }
                    const messageId = `binary-search-${Date.now()}-${Math.random()}`;
                    
                    const result = await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            worker.terminate();
                            reject(new Error('Binary search timeout'));
                        }, 5000);
                        
                        const handleMessage = (event) => {
                            if (event.data.id === messageId && event.data.type === 'BINARY_SEARCH_COMPLETE') {
                                clearTimeout(timeout);
                                worker.removeEventListener('message', handleMessage);
                                worker.terminate();
                                resolve(event.data.result);
                            }
                        };
                        
                        worker.addEventListener('message', handleMessage);
                        
                        worker.postMessage({
                            id: messageId,
                            type: 'BINARY_SEARCH',
                            data: {
                                sortedData: data,
                                targetDatetime: new Date(targetTime).toISOString()
                            },
                            timestamp: Date.now()
                        });
                    });
                    
                    if (result) {
                        const timeDiff = Math.abs(new Date(result.Datetime).getTime() - targetTime);
                        log(`🎯 Overlay: Found closest point at: ${new Date(result.Datetime).toISOString()} diff: ${timeDiff} ms`);
                        return result;
                    }
                } catch (error: any) {
                    warn('Worker binary search failed, falling back to sync:', error);
                }
            }
            
            // Fallback to synchronous binary search for smaller datasets
            let left = 0;
            let right = data.length - 1;
            let closest = null;
            let minDiff = Infinity;

            while (left <= right) {
                const mid = Math.floor((left + right) / 2);
                const midTime = new Date(data[mid].Datetime).getTime();
                
                if (isNaN(midTime)) {
                    break;
                }
                
                const diff = Math.abs(midTime - targetTime);
                if (diff < minDiff) {
                    minDiff = diff;
                    closest = data[mid];
                }

                if (midTime < targetTime) {
                    left = mid + 1;
                } else if (midTime > targetTime) {
                    right = mid - 1;
                } else {
                    return data[mid];
                }
            }

            return closest;
        } catch (error: any) {
            logError('❌ Overlay: Error finding closest data point from IndexedDB:', error);
            return null;
        }
    }

    // Keep the old function for fallback
    async function findClosest(targetDatetime) {
        try {
            if (!targetDatetime) {
                return null;
            }

            const targetTime = new Date(targetDatetime).getTime();
            if (isNaN(targetTime)) {
                return null;
            }
            
            const data = data_overlay();
            
            if (!data || data.length === 0) {
                return null;
            }

            // Find the closest point using binary search
            let left = 0;
            let right = data.length - 1;
            let closest = null;
            let minDiff = Infinity;

            while (left <= right) {
                const mid = Math.floor((left + right) / 2);
                const midTime = new Date(data[mid].Datetime).getTime();
                
                if (isNaN(midTime)) {
                    break;
                }
                
                const diff = Math.abs(midTime - targetTime);
                if (diff < minDiff) {
                    minDiff = diff;
                    closest = data[mid];
                }

                if (midTime < targetTime) {
                    left = mid + 1;
                } else if (midTime > targetTime) {
                    right = mid - 1;
                } else {
                    return data[mid];
                }
            }

            return closest;
        } catch (error: any) {
            logError('Error finding closest data point:', error);
            return null;
        }
    }

    // Helper function to get current sidebar width
    const getSidebarWidth = () => {
        const isMobile = window.innerWidth <= 1000;
        // On mobile, sidebar is fixed/overlay so it doesn't take up layout space
        if (isMobile) {
            return 0;
        }
        const sidebar = document.querySelector('.sidebar:not(.mobile)');
        if (sidebar) {
            // Check if sidebar is collapsed (64px) or expanded (275px)
            return sidebar.classList.contains('collapsed') ? 64 : 275;
        }
        return 0;
    };

    // Update position when orientation or position changes
    createEffect(() => {
        const currentPos = position();
        const currentOrientation = orientation();
        const isUserPosition = isUserDraggedPosition();
        const TOP_OFFSET = 70; // Minimum distance from top of page in pixels
        
        log('Overlay: createEffect triggered - position:', currentPos, 'orientation:', currentOrientation, 
            'isUserDragged:', isUserPosition, 'containerRef:', !!containerRef, 'position type:', typeof currentPos, 'position keys:', currentPos ? Object.keys(currentPos) : 'null');
        
        // Validate position object
        if (!currentPos || typeof currentPos !== 'object' || typeof currentPos.x !== 'number' || typeof currentPos.y !== 'number') {
            logError('Overlay: Invalid position object in createEffect:', currentPos);
            return;
        }
        
        if (containerRef) {
            // Ensure position is fixed
            containerRef.style.position = 'fixed';
            containerRef.style.zIndex = '6000';
            
            // Clear all positioning styles first to prevent conflicts
            containerRef.style.left = "auto";
            containerRef.style.right = "auto";
            containerRef.style.top = "auto";
            containerRef.style.bottom = "auto";
            containerRef.style.transform = "none";
            
            // Get sidebar width for left alignment
            const sidebarWidth = getSidebarWidth();
            
            // Handle X position (0, 25, 50, 75, 100)
            if (currentPos.x === 0) {
                containerRef.style.left = `${sidebarWidth}px`;
                containerRef.style.right = "auto";
            } else if (currentPos.x === 100) {
                containerRef.style.right = "0px";
                containerRef.style.left = "auto";
            } else {
                // For 25, 50, 75 - use percentage and center with transform
                containerRef.style.left = `${currentPos.x}%`;
                containerRef.style.right = "auto";
            }
            
            // Handle Y position (top/center/bottom)
            // For top position, always use 70px offset from top
            if (currentPos.y === 0) {
                containerRef.style.top = `${TOP_OFFSET}px`;
                containerRef.style.bottom = "auto";
            } else if (currentPos.y === 100) {
                containerRef.style.bottom = "0px";
                containerRef.style.top = "auto";
            } else {
                // For 25, 50, 75 - use percentage and center with transform
                containerRef.style.top = `${currentPos.y}%`;
                containerRef.style.bottom = "auto";
            }
            
            // Apply transforms to center non-edge positions (25, 50, 75)
            let transformX = "";
            let transformY = "";
            
            // If x is 25, 50, or 75, translate horizontally to center
            if (currentPos.x === 25 || currentPos.x === 50 || currentPos.x === 75) {
                transformX = "translateX(-50%)";
            }
            
            // If y is 25, 50, or 75, translate vertically to center
            if (currentPos.y === 25 || currentPos.y === 50 || currentPos.y === 75) {
                transformY = "translateY(-50%)";
            }
            
            // Combine transforms
            const transform = [transformX, transformY].filter(t => t).join(" ") || "none";
            containerRef.style.transform = transform;
            
            log('Overlay: Applied styles - left:', containerRef.style.left, 'right:', containerRef.style.right, 
                'top:', containerRef.style.top, 'bottom:', containerRef.style.bottom, 'transform:', transform,
                'computed position:', containerRef.getBoundingClientRect());
        } else {
            log('Overlay: containerRef not available yet, will retry when ref is set');
        }
    });

    onMount(() => {
        // Initial load is triggered by createEffect when objectNameProp/overlayName is set.
        // Watch for sidebar state changes and update overlay position if left-aligned
        const sidebar = document.querySelector('.sidebar:not(.mobile)');
        if (sidebar) {
            sidebarObserver = new MutationObserver(() => {
                // Only update if overlay is left-aligned (x === 0)
                const currentPos = position();
                if (currentPos && currentPos.x === 0 && containerRef) {
                    const sidebarWidth = getSidebarWidth();
                    containerRef.style.left = `${sidebarWidth}px`;
                    log('Overlay: Updated left position due to sidebar state change:', sidebarWidth);
                }
            });
            
            sidebarObserver.observe(sidebar, {
                attributes: true,
                attributeFilter: ['class']
            });
        }
    });

    // Watch for changes in selected parameters and reload data
    createEffect(() => {
        if (selectedClassName() && selectedProjectId() && selectedDatasetId()) {
            // Reload data when parameters change
            fetchAndFormatData();
        }
    });

    onCleanup(() => {
        // Clear any pending row updates
        if (rowUpdateTimer) {
            clearTimeout(rowUpdateTimer);
            rowUpdateTimer = null;
        }
        
        // Clear map filter timeout
        if (mapFilterTimeout) {
            clearTimeout(mapFilterTimeout);
            mapFilterTimeout = null;
        }
        
        // Disconnect sidebar observer
        if (sidebarObserver) {
            sidebarObserver.disconnect();
            sidebarObserver = null;
        }
        
        // Clear overlay data from memory when component unmounts
        unifiedDataStore.clearOverlayData(selectedClassName(), selectedSourceId().toString());
        
        // The unified data store handles cleanup automatically
    });

    // Debounce timer for row updates (sidebarObserver, rowUpdateTimer, mapFilterTimeout declared at top)
    let lastProcessedTime = null;
    let cachedTimeseriesData = null;
    let lastDataFetchTime = 0;

    // Optimized function to update row for a specific time using in-memory storage
    const updateRowForTimeOptimized = async (data, time) => {
        // Clear any pending updates
        if (rowUpdateTimer) {
            clearTimeout(rowUpdateTimer);
        }
        
        // Debounce the row update to prevent rapid changes
        rowUpdateTimer = setTimeout(async () => {
            const updateRow = async () => {
                try {
                    // First use local overlay data (in-memory, single source of truth)
                    if (data && data.length > 0) {
                        const closestRowCached = findClosestTimeInCachedData(data, time);
                        if (closestRowCached) {
                            setRow(closestRowCached);
                            lastProcessedTime = time;
                            return;
                        }
                    }
                    
                    // Fallback to IndexedDB query if local data miss
                    const closestRowIndexedDB = await findClosestTimeBased(time);
                    if (closestRowIndexedDB) {
                        setRow(closestRowIndexedDB);
                        lastProcessedTime = time;
                    } else {
                        setRow({});
                    }
                } catch (error: any) {
                    logError('❌ Overlay: Error updating row for time:', error);
                    setRow({});
                }
            };
            
            // Use requestAnimationFrame for smoother updates
            requestAnimationFrame(updateRow);
        }, 8); // Reduced debounce to 8ms for more responsive updates
    };

    // Helper function to find closest time in cached data using binary search
    const findClosestTimeInCachedData = (data, targetTime) => {
        if (!data || data.length === 0 || !targetTime) {
            return null;
        }

        const targetTimestamp = new Date(targetTime).getTime();
        if (isNaN(targetTimestamp)) {
            return null;
        }

        // Binary search for closest time
        let left = 0;
        let right = data.length - 1;
        let closest = null;
        let minDiff = Infinity;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const midTime = new Date(data[mid].Datetime).getTime();
            const diff = Math.abs(midTime - targetTimestamp);

            if (diff < minDiff) {
                minDiff = diff;
                closest = data[mid];
            }

            if (midTime < targetTimestamp) {
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        return closest;
    };

    // Track selectedTime changes with optimized caching
    createEffect(() => {
        const time = selectedTime();
        
        // Skip if time hasn't actually changed
        if (time && lastProcessedTime && time.getTime() === lastProcessedTime.getTime()) {
            return;
        }
        
        // Use cached data if available and recent
        const data = data_overlay();
        if (data && data.length > 0 && time) {
            updateRowForTimeOptimized(data, time);
        }
    });

    // Track data changes
    createEffect(() => {
        const data = data_overlay();
        if (data && data.length > 0) {
            const time = selectedTime();
            if (time) {
                updateRowForTime(data, time);
            }
        }
    });

    // Watch for map data filtering changes and refetch timeseries data
    // Add debouncing to prevent infinite loops during animation (mapFilterTimeout declared at top)
    let isRefetching = false;
    let lastMapFilteredValue = 0; // Track previous value to detect actual changes
    createEffect(() => {
        const mapFiltered = unifiedDataStore.mapDataFiltered();
        
        // Only proceed if the value actually changed (increased)
        // This prevents infinite loops when the value stays > 0
        if (mapFiltered > lastMapFilteredValue && mapFiltered > 0 && selectedClassName() && selectedProjectId() && selectedDatasetId() && !isRefetching) {
            lastMapFilteredValue = mapFiltered; // Update tracked value
            
            // Clear any existing timeout to debounce the effect
            if (mapFilterTimeout) {
                clearTimeout(mapFilterTimeout);
            }
            
            // Debounce the refetch to prevent infinite loops during rapid updates
            mapFilterTimeout = setTimeout(async () => {
                if (!isRefetching) {
                    isRefetching = true;
                    log('Overlay: Map data filtered, refetching timeseries data');
                    try {
                        await fetchAndFormatData();
                    } finally {
                        isRefetching = false;
                    }
                }
                mapFilterTimeout = null;
            }, 100); // 100ms debounce
        } else if (mapFiltered === 0) {
            // Reset tracked value when mapDataFiltered is reset to 0
            lastMapFilteredValue = 0;
        }
    });

    // Legacy function for fallback
    const updateRowForTime = async (data, time) => {
        updateRowForTimeOptimized(data, time);
    };

    // Helper function to convert hex to rgba
    const hexToRgba = (hex, alpha) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    // Make overlay draggable
    const makeDraggable = (el) => {
        if (!el) return;
        containerRef = el;

        // Initial position is handled by createEffect, but ensure position is fixed
        el.style.position = 'fixed';
        el.style.zIndex = '6000';

        el.addEventListener("mousedown", (event) => {
            // Allow drag when clicking anywhere inside the overlay container (so dragging works on the content area too)
            const isClickInsideOverlay = el.contains(event.target as Node);
            
            // Don't drag if clicking on interactive elements (buttons, inputs, etc.)
            const isInteractiveElement = event.target && (
                                        (event.target as HTMLElement).tagName === 'BUTTON' ||
                                        (event.target as HTMLElement).tagName === 'INPUT' ||
                                        (event.target as HTMLElement).tagName === 'SELECT' ||
                                        (event.target as HTMLElement).tagName === 'A' ||
                                        (event.target as HTMLElement).closest('button') ||
                                        (event.target as HTMLElement).closest('input') ||
                                        (event.target as HTMLElement).closest('select') ||
                                        (event.target as HTMLElement).closest('a'));
            
            if (isClickInsideOverlay && !isInteractiveElement) {
                // Get current position using getBoundingClientRect for accurate offset calculation
                // This handles transforms and percentage positioning correctly
                const rect = el.getBoundingClientRect();
                
                // Convert bottom/right positioning to top/left for dragging
                // Do this BEFORE calculating offsets to ensure accurate positioning
                if (el.style.bottom && el.style.bottom !== "auto") {
                    // Element is positioned from bottom - convert to top
                    const bottomValue = parseFloat(el.style.bottom) || 0;
                    el.style.top = `${rect.top}px`; // Use current visual position
                    el.style.bottom = "auto";
                }
                if (el.style.right && el.style.right !== "auto") {
                    // Element is positioned from right - convert to left
                    const rightValue = parseFloat(el.style.right) || 0;
                    el.style.left = `${rect.left}px`; // Use current visual position
                    el.style.right = "auto";
                }
                
                // If element is positioned with percentage, convert to pixels
                if (el.style.left && el.style.left.includes('%')) {
                    const percentValue = parseFloat(el.style.left);
                    el.style.left = `${rect.left}px`;
                }
                if (el.style.top && el.style.top.includes('%')) {
                    const percentValue = parseFloat(el.style.top);
                    el.style.top = `${rect.top}px`;
                }
                
                // Recalculate rect after conversion to get accurate position
                const updatedRect = el.getBoundingClientRect();
                const offsetX = event.clientX - updatedRect.left;
                const offsetY = event.clientY - updatedRect.top;
                
                // Remove transform during drag and set position to fixed pixel values
                el.style.transform = "none";
                el.style.left = `${updatedRect.left}px`;
                el.style.top = `${updatedRect.top}px`;

                function onMouseMove(moveEvent) {
                    const TOP_OFFSET = 70; // Minimum distance from top of page in pixels
                    const viewportWidth = window.innerWidth;
                    const viewportHeight = window.innerHeight;
                    
                    // Get sidebar width for left constraint
                    const sidebarWidth = getSidebarWidth();
                    
                    // Calculate new position
                    let newLeft = moveEvent.clientX - offsetX;
                    let newTop = moveEvent.clientY - offsetY;
                    
                    // Get element dimensions
                    const rect = el.getBoundingClientRect();
                    const elementWidth = rect.width;
                    const elementHeight = rect.height;
                    
                    // Constrain to viewport bounds
                    // Left edge cannot go outside left side (account for sidebar)
                    newLeft = Math.max(sidebarWidth, newLeft);
                    // Right edge cannot go outside right side (left + width <= viewportWidth)
                    newLeft = Math.min(viewportWidth - elementWidth, newLeft);
                    
                    // Top edge cannot go above 70px (top >= TOP_OFFSET)
                    newTop = Math.max(TOP_OFFSET, newTop);
                    // Bottom edge cannot go outside bottom (top + height <= viewportHeight)
                    newTop = Math.min(viewportHeight - elementHeight, newTop);
                    
                    el.style.left = `${newLeft}px`;
                    el.style.top = `${newTop}px`;
                    // Ensure bottom/right are cleared when dragging
                    if (el.style.bottom) {
                        el.style.bottom = "auto";
                    }
                    if (el.style.right) {
                        el.style.right = "auto";
                    }
                }

                function onMouseUp() {
                    document.removeEventListener("mousemove", onMouseMove);
                    document.removeEventListener("mouseup", onMouseUp);
                    
                    // Get current position from the element's bounding rect (accounts for actual visual position)
                    const rect = el.getBoundingClientRect();
                    const viewportWidth = window.innerWidth;
                    const viewportHeight = window.innerHeight;
                    const TOP_OFFSET = 65; // Minimum distance from top of page in pixels
                    
                    // Get sidebar width for left alignment calculations
                    const sidebarWidth = getSidebarWidth();
                    
                    // Calculate position based on edges, not center, to ensure overlay doesn't go outside viewport
                    // For X: use left edge for left snap, right edge for right snap, center for middle snaps
                    const leftEdge = rect.left;
                    const rightEdge = rect.right;
                    const centerX = rect.left + rect.width / 2;
                    
                    // For Y: use top edge for top snap, bottom edge for bottom snap, center for middle snaps
                    const topEdge = rect.top;
                    const bottomEdge = rect.bottom;
                    const centerY = rect.top + rect.height / 2;
                    
                    // Calculate percentage positions
                    // For X: check which edge is closer to viewport edge (accounting for sidebar)
                    let newX;
                    const leftThreshold = sidebarWidth + (viewportWidth - sidebarWidth) * 0.2;
                    if (leftEdge <= leftThreshold) {
                        // Close to left edge (accounting for sidebar) - snap to left (x: 0)
                        // Check if left edge is within 10px of sidebar position
                        if (Math.abs(leftEdge - sidebarWidth) <= 10) {
                            newX = 0;
                        } else {
                            // Calculate percentage based on position relative to sidebar
                            newX = Math.max(0, ((leftEdge - sidebarWidth) / (viewportWidth - sidebarWidth)) * 100);
                        }
                    } else if (rightEdge > viewportWidth * 0.8) {
                        // Close to right edge - use right edge position (inverted)
                        newX = Math.min(100, 100 - ((viewportWidth - rightEdge) / viewportWidth) * 100);
                    } else {
                        // Middle - use center (accounting for sidebar)
                        newX = Math.max(0, Math.min(100, ((centerX - sidebarWidth) / (viewportWidth - sidebarWidth)) * 100));
                    }
                    
                    // For Y: check which edge is closer to viewport edge
                    // Account for TOP_OFFSET when calculating top position
                    let newY;
                    const availableHeight = viewportHeight - TOP_OFFSET;
                    
                    // Check if top edge is close to TOP_OFFSET (within 20% of available height from top)
                    if (topEdge <= TOP_OFFSET + availableHeight * 0.2) {
                        // Close to top edge - snap to top (y: 0)
                        // Check if top edge is within 10px of TOP_OFFSET
                        if (topEdge <= TOP_OFFSET + 10) {
                            newY = 0;
                        } else {
                            // Calculate percentage based on top edge position relative to available height
                            newY = ((topEdge - TOP_OFFSET) / availableHeight) * 100;
                        }
                    } else if (bottomEdge >= viewportHeight * 0.8) {
                        // Close to bottom edge - use bottom edge position
                        // Calculate percentage based on how close bottom edge is to viewport bottom
                        newY = 100 - ((viewportHeight - bottomEdge) / viewportHeight) * 100;
                        // Clamp to 100 if very close to bottom
                        if (bottomEdge >= viewportHeight - 10) {
                            newY = 100;
                        }
                    } else {
                        // Middle - use center, but account for TOP_OFFSET
                        newY = ((centerY - TOP_OFFSET) / availableHeight) * 100;
                    }
                    
                    // Clamp newY to valid range
                    newY = Math.max(0, Math.min(100, newY));
                    
                    log('Overlay: Drag drop - rect:', { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height, width: rect.width }, 
                        'topEdge:', topEdge, 'bottomEdge:', bottomEdge, 'leftEdge:', leftEdge, 'rightEdge:', rightEdge,
                        'centerX:', centerX, 'centerY:', centerY,
                        'newX:', newX, 'newY:', newY, 'viewport:', viewportWidth, 'x', viewportHeight, 'TOP_OFFSET:', TOP_OFFSET);
                    
                    // Snap to 25 positions: 5x5 grid (0, 25, 50, 75, 100 for both X and Y)
                    // Use distance-based snapping to find nearest grid point for more even distribution
                    const gridPositions = [0, 25, 50, 75, 100];
                    
                    // Find nearest grid position for X (always snap to nearest)
                    let snappedX = gridPositions.reduce((nearest, pos) => {
                        const distToNearest = Math.abs(newX - nearest);
                        const distToPos = Math.abs(newX - pos);
                        return distToPos < distToNearest ? pos : nearest;
                    });
                    
                    // Find nearest grid position for Y (always snap to nearest)
                    let snappedY = gridPositions.reduce((nearest, pos) => {
                        const distToNearest = Math.abs(newY - nearest);
                        const distToPos = Math.abs(newY - pos);
                        return distToPos < distToNearest ? pos : nearest;
                    });
                    
                    log('Overlay: Drag drop - snapped to:', { x: snappedX, y: snappedY });
                    
                    // Apply snapped X position
                    if (snappedX === 0) {
                        el.style.left = `${sidebarWidth}px`;
                        el.style.right = "auto";
                    } else if (snappedX === 100) {
                        el.style.right = "0px";
                        el.style.left = "auto";
                    } else {
                        // For 25, 50, 75 - use percentage and center with transform
                        el.style.left = `${snappedX}%`;
                        el.style.right = "auto";
                    }
                    
                    // Apply snapped Y position
                    // For top position, use 70px offset from top
                    if (snappedY === 0) {
                        el.style.top = `${TOP_OFFSET}px`;
                        el.style.bottom = "auto";
                    } else if (snappedY === 100) {
                        el.style.bottom = "0px";
                        el.style.top = "auto";
                    } else {
                        // For 25, 50, 75 - use percentage and center with transform
                        el.style.top = `${snappedY}%`;
                        el.style.bottom = "auto";
                    }
                    
                    // Apply transforms to center non-edge positions (25, 50, 75)
                    let transformX = (snappedX === 25 || snappedX === 50 || snappedX === 75) ? "translateX(-50%)" : "";
                    let transformY = (snappedY === 25 || snappedY === 50 || snappedY === 75) ? "translateY(-50%)" : "";
                    const transform = [transformX, transformY].filter(t => t).join(" ") || "none";
                    el.style.transform = transform;
                    
                    const currentOrientation = orientation();
                    setPosition({ x: snappedX, y: snappedY });
                    setIsUserDraggedPosition(true); // Mark as user-dragged position
                    
                    log('Overlay: Setting position after drag:', { x: snappedX, y: snappedY }, 'orientation:', currentOrientation);
                    
                    const savedData = {
                        position: { x: snappedX, y: snappedY },
                        orientation: currentOrientation
                    };
                    // Save to user settings (API + localStorage cache) so position is reused across sessions/devices
                    try {
                        setOverlayPositions((prev) => ({
                            ...prev,
                            [chartObjectName]: savedData
                        }));
                        savePersistentSettings();
                        log('Overlay: Saved user-dragged position to user settings:', savedData, 'key:', chartObjectName);
                    } catch (e) {
                        logError('Overlay: Failed to save overlay position to user settings:', e);
                    }
                    // Also write to legacy localStorage key for backward compatibility
                    const storageKey = `overlay_position_${chartObjectName}`;
                    try {
                        localStorage.setItem(storageKey, JSON.stringify(savedData));
                    } catch (e) {
                        logError('Overlay: Failed to save overlay position to localStorage:', e);
                    }
                }

                document.addEventListener("mousemove", onMouseMove);
                document.addEventListener("mouseup", onMouseUp);

                // Prevent text selection during drag
                event.preventDefault();
            }
        });
    };

    return (
        <>
        <Show when={!isLoading_overlay() && display().length > 0}>
            <div 
                ref={(el) => {
                    containerRef = el;
                    if (el) {
                        makeDraggable(el);
                        // Trigger position update when ref is set
                        // Use requestAnimationFrame to batch layout reads/writes and avoid forced reflow
                        requestAnimationFrame(() => {
                            const currentPos = position();
                            const currentOrientation = orientation();
                            const isUserPosition = isUserDraggedPosition();
                            const TOP_OFFSET = 70; // Minimum distance from top of page in pixels
                            
                            log('Overlay: Ref callback - applying position:', currentPos, 'orientation:', currentOrientation, 
                                'isUserDragged:', isUserPosition);
                            
                            // Batch all style writes together
                            // Get sidebar width before any style writes to avoid forced reflow
                            const sidebarWidth = getSidebarWidth();
                            
                            // Apply position immediately
                            el.style.position = 'fixed';
                            el.style.zIndex = '6000';
                            
                            // Handle X position (0, 25, 50, 75, 100)
                            if (currentPos.x === 0) {
                                el.style.left = `${sidebarWidth}px`;
                                el.style.right = "auto";
                            } else if (currentPos.x === 100) {
                                el.style.right = "0px";
                                el.style.left = "auto";
                            } else {
                                // For 25, 50, 75 - use percentage and center with transform
                                el.style.left = `${currentPos.x}%`;
                                el.style.right = "auto";
                            }
                            
                            // Handle Y position
                            // For top position, always use 70px offset from top
                            if (currentPos.y === 0) {
                                el.style.top = `${TOP_OFFSET}px`;
                                el.style.bottom = "auto";
                            } else if (currentPos.y === 100) {
                                el.style.bottom = "0px";
                                el.style.top = "auto";
                            } else {
                                el.style.top = `${currentPos.y}%`;
                                el.style.bottom = "auto";
                            }
                            
                            // Apply transforms to center non-edge positions (25, 50, 75)
                            let transformX = "";
                            let transformY = "";
                            if (currentPos.x === 25 || currentPos.x === 50 || currentPos.x === 75) {
                                transformX = "translateX(-50%)";
                            }
                            if (currentPos.y === 25 || currentPos.y === 50 || currentPos.y === 75) {
                                transformY = "translateY(-50%)";
                            }
                            const transform = [transformX, transformY].filter(t => t).join(" ") || "none";
                            el.style.transform = transform;
                            
                            log('Overlay: Ref callback - applied styles:', {
                                left: el.style.left,
                                right: el.style.right,
                                top: el.style.top,
                                bottom: el.style.bottom,
                                transform
                            });
                        });
                    }
                }}
                class="overlay-container" 
                style={{ 
                    "background-color": hexToRgba(backgroundColor(), opacity()),
                    "cursor": "move",
                    "display": "flex",
                    "flex-direction": orientation() === "horizontal" ? "row" : "column",
                    "align-items": "center",
                    "gap": "8px",
                    "padding": "8px"
                }}
            >
                <For each={display()}> 
                    {(item) => {
                        const currentType = overlayType();
                        
                        // Debug: log overlay type to help diagnose issues
                        debug('Overlay: Rendering overlay item', {
                            currentType,
                            channelName: item.name,
                            itemWidth: item.width,
                            itemDonutType: item.donutType
                        });
                        
                        if (currentType === "180 Dot") {
                            debug('Overlay: ✅ Detected 180 Dot type - should render Donut180Dot');
                        }
                        
                        // TextBox overlay: pass row accessor so TextBox updates when selectedTime changes
                        if (currentType === "TextBox" || !currentType) {
                            return (
                                <TextBox
                                    label={item.primaryChannelLabel || item.name}
                                    secondaryLabel={item.secondaryChannelLabel ?? item.channel2?.name ?? ""}
                                    labelColor={item.color}
                                    channelName={item.name}
                                    channel2Name={item.channel2?.name}
                                    targetColor={item.channel2?.color || item.color}
                                    hasTarget={!!(item.channel2 && item.channel2.name)}
                                    height={item.height || 60}
                                    dataRow={row}
                                />
                            );
                        }
                        
                        // Sparkline overlay
                        if (currentType === "Sparkline") {
                            return (
                                <Sparkline
                                    config={{
                                        valueChannel: item.name,
                                        channel: item.name,
                                        color: item.color || "#10b981",
                                        timespan: item.timespan || 30,
                                        width: item.width || 150,
                                        sparklineWidth: item.width || 150,
                                        height: item.height || 60
                                    }}
                                    channelName={item.name}
                                    color={item.color || "#10b981"}
                                    timespan={item.timespan || 30}
                                    sparklineWidth={item.width || 150}
                                    height={item.height || 60}
                                    backgroundColor={backgroundColor()}
                                    opacity={opacity()}
                                    dataRow={row}
                                    timeseriesData={data_overlay()}
                                />
                            );
                        }
                        
                        // 180 Dot overlay (check before Donut to avoid conflicts)
                        if (currentType === "180 Dot") {
                            return (
                                <Donut180Dot
                                    config={{
                                        valueChannel: item.name,
                                        channel: item.name,
                                        height: item.height || 150
                                    }}
                                    height={item.height || 150}
                                    backgroundColor={backgroundColor()}
                                    opacity={opacity()}
                                    dataRow={row}
                                    timeseriesData={data_overlay()}
                                />
                            );
                        }
                        
                        // 180 overlay (standard 180 gauge)
                        if (currentType === "180") {
                            return (
                                <Donut180
                                    config={{
                                        valueChannel: item.name,
                                        channel: item.name,
                                        height: item.height || 150
                                    }}
                                    height={item.height || 150}
                                    backgroundColor={backgroundColor()}
                                    opacity={opacity()}
                                    dataRow={row}
                                />
                            );
                        }
                        
                        // Donut overlay
                        if (currentType === "Donut") {
                            const donutMode = item.donutType || "basic";
                            
                            // Use Donut180Dot component if donutType is "180 Dot"
                            if (donutMode === "180 Dot") {
                                return (
                                    <Donut180Dot
                                        config={{
                                            valueChannel: item.name,
                                            channel: item.name,
                                            label: item.label ?? item.name,
                                            height: item.height || 150
                                        }}
                                        height={item.height || 150}
                                        backgroundColor={backgroundColor()}
                                        opacity={opacity()}
                                        dataRow={row}
                                        timeseriesData={data_overlay()}
                                    />
                                );
                            }
                            
                            // Use Donut180 component if donutType is "180"
                            if (donutMode === "180") {
                                return (
                                    <Donut180
                                        config={{
                                            valueChannel: item.name,
                                            channel: item.name,
                                            label: item.label ?? item.name,
                                            height: item.height || 150
                                        }}
                                        height={item.height || 150}
                                        backgroundColor={backgroundColor()}
                                        opacity={opacity()}
                                        dataRow={row}
                                    />
                                );
                            }
                            
                            // Otherwise use regular Donut
                            return (
                                <Donut
                                    config={{
                                        valueChannel: item.name,
                                        channel: item.name,
                                        label: item.label ?? item.name,
                                        height: item.height || 150,
                                        mode: donutMode === "basic" ? "auto" : donutMode, // Donut uses "auto" for basic, "target" or "alarm" for others
                                        color: donutMode === "basic" ? (item.color || "#10b981") : undefined, // Only pass color for basic mode
                                        targetValue: donutMode === "target" ? item.targetValue : undefined,
                                        warningValue: donutMode === "alarm" ? item.warningValue : undefined,
                                        alarmValue: donutMode === "alarm" ? item.alarmValue : undefined
                                    }}
                                    height={item.height || 150}
                                    backgroundColor={backgroundColor()}
                                    opacity={opacity()}
                                    dataRow={row}
                                />
                            );
                        }
                        
                        // Fallback to TextBox
                        return (
                            <TextBox
                                label={item.primaryChannelLabel || item.name}
                                secondaryLabel={item.secondaryChannelLabel ?? item.channel2?.name ?? ""}
                                labelColor={item.color}
                                channelName={item.name}
                                channel2Name={item.channel2?.name}
                                targetColor={item.channel2?.color || item.color}
                                hasTarget={!!(item.channel2 && item.channel2.name)}
                                height={item.height || 60}
                                dataRow={row}
                            />
                        );
                    }}
                </For>
            </div>
        </Show>
        </>
    );
}
