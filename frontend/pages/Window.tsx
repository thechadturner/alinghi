import { createSignal, onMount, createEffect, Switch, Match, onCleanup, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { getData } from "../utils/global";

import { apiEndpoints } from "@config/env";
import { debug as logDebug , error as logError, log } from "../utils/console";
import { user } from "../store/userStore";
import { persistantStore } from "../store/persistantStore";
const { selectedSourceName, selectedSourceId, selectedClassName, selectedProjectId, setSelectedClassName, setSelectedProjectId, setSelectedDatasetId } = persistantStore;
import { sidebarState } from "../store/globalStore";
import { streamingStore } from "../store/streamingStore";
import { liveMode, startPeriodicSync } from "../store/playbackStore";
import { sourcesStore } from "../store/sourcesStore";

interface HeaderInfo {
    className: string;
    sourceName: string;
    date: string;
    pageName: string;
}

interface MessageEvent {
    data: {
        type: string;
        payload?: any;
        windowName?: string;
        visible?: boolean;
    };
    origin: string;
}

// Pre-load all report components using Vite's glob import
// This allows Vite to discover all files at build time and create proper chunks
// The glob pattern matches all .tsx files in the reports directory
// This must be at module level (not inside a function) for Vite to process it correctly
const reportModules = import.meta.glob('../reports/**/*.tsx', { eager: false });

export default function Window() {
    const [component, setComponent] = createSignal(null);
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal(null);
    /** When true, hide the header (e.g. when ManeuverWindow is the loaded component). */
    const [hideHeader, setHideHeader] = createSignal(false);

    // State for header info
    const [headerInfo, setHeaderInfo] = createSignal<HeaderInfo>({
        className: '',
        sourceName: '',
        date: '',
        pageName: ''
    });

    // Add cross-window communication
    const setupCrossWindowCommunication = () => {
        // Listen for messages from parent window
        const handleMessage = (event: MessageEvent) => {
            // Verify origin for security
            if (event.origin !== window.location.origin) return;
            
            const messageType = event.data?.type;
            
            if (messageType === 'SELECTION_STORE_UPDATE') {
                // Handle selection store updates (selectedEvents, selection, etc.)
                const payload = event.data.payload || {};
                
                // Process even if document is hidden (for background windows)
                // The components will update when the window becomes visible
                window.dispatchEvent(new CustomEvent('selectionStoreUpdate', { 
                    detail: payload 
                }));
            } else if (messageType === 'FILTER_STORE_UPDATE') {
                // Handle filter updates
                const payload = event.data.payload || {};
                
                // Process even if document is hidden (for background windows)
                window.dispatchEvent(new CustomEvent('filterStoreUpdate', {
                    detail: payload
                }));
            } else if (messageType === 'PLAYBACK_STORE_UPDATE') {
                // Handle playback/time updates
                const payload = event.data.payload || {};
                
                // Process even if document is hidden (for background windows)
                window.dispatchEvent(new CustomEvent('playbackStoreUpdate', {
                    detail: payload
                }));
            } else if (messageType === 'GLOBAL_STORE_UPDATE') {
                // Handle global store updates (eventType, phase, color)
                const payload = event.data.payload || {};
                
                // Preserve cross-window sync markers when dispatching CustomEvent
                // This allows globalStore to distinguish cross-window updates from local events
                window.dispatchEvent(new CustomEvent('globalStoreUpdate', {
                    detail: payload
                }));
            } else if (messageType === 'PERSISTENT_STORE_UPDATE') {
                // Handle persistent store updates (selectedSourceId, selectedSourceName, etc.)
                const payload = event.data.payload || {};
                
                // Process even if document is hidden (for background windows)
                window.dispatchEvent(new CustomEvent('persistentStoreUpdate', {
                    detail: payload
                }));
            }
        };

        // Handle visibility changes
        const handleVisibilityChange = () => {
            if (window.opener && !window.opener.closed) {
                window.opener.postMessage({
                    type: 'WINDOW_VISIBILITY_CHANGE',
                    windowName: window.name,
                    visible: !document.hidden
                }, window.location.origin);
            }
        };

        window.addEventListener('message', handleMessage);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Also listen via BroadcastChannel for windows that don't have opener (moved tabs)
        // This allows windows that were moved from tabs to still receive updates
        let broadcastChannel: BroadcastChannel | null = null;
        try {
            broadcastChannel = new BroadcastChannel('global-store-updates');
            broadcastChannel.onmessage = (event) => {
                if (event.data.type === 'GLOBAL_STORE_UPDATE' && event.data.sourceWindow !== window.name) {
                    // Ignore our own messages
                    const payload = event.data.payload || {};
                    
                    // Dispatch as CustomEvent so globalStore can process it
                    // Preserve cross-window sync markers
                    window.dispatchEvent(new CustomEvent('globalStoreUpdate', {
                        detail: payload
                    }));
                }
            };
        } catch (err) {
            log('🪟 Window: BroadcastChannel not available', err);
        }

        // Send ready message to parent
        if (window.opener) {
            window.opener.postMessage({
                type: 'WINDOW_READY',
                windowName: window.name
            }, window.location.origin);
        }

        // Cleanup function
        return () => {
            window.removeEventListener('message', handleMessage);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            if (broadcastChannel) {
                broadcastChannel.close();
                broadcastChannel = null;
            }
        };
    };

    // Function to send selection updates to parent window
    const sendSelectionUpdate = (selectionData) => {
        // Only send if window is visible to reduce unnecessary traffic
        if (!document.hidden && window.opener && !window.opener.closed) {
            window.opener.postMessage({
                type: 'SELECTION_UPDATE_FROM_CHILD',
                payload: selectionData,
                windowName: window.name
            }, window.location.origin);
        }
    };

    // Make sendSelectionUpdate available globally for components to use
    if (typeof window !== 'undefined') {
        if (!window.crossWindowAPI) {
            // @ts-ignore
            window.crossWindowAPI = {};
        }
        // @ts-ignore
        window.crossWindowAPI.sendSelectionUpdate = sendSelectionUpdate;
    }

    const loadComponent = async (componentPath: string, props: Record<string, any> = {}) => {
        try {
            setLoading(true);
            setError(null);
            logDebug('Window: loadComponent called with path:', componentPath);
            
            if (componentPath && componentPath.length > 0) {
                // Remove any file extension to let Vite resolve the correct compiled file
                const basePath = componentPath.replace(/\.(jsx|tsx|js|ts)$/, '');
                
                logDebug('Window: Attempting to load component from path:', basePath);
                
                // Convert file path to the glob key format (relative to reports directory)
                // e.g., "gp50/dataset/explore/Map" -> "../reports/gp50/dataset/explore/Map.tsx"
                let globKey = `../reports/${basePath}.tsx`;
                
                // Get the loader function from the glob map (exact match first)
                let loader = reportModules[globKey];
                
                // If not found, try case-insensitive match (API may return e.g. FleetTimeseries vs file FleetTimeSeries.tsx)
                if (!loader) {
                    const matchingKey = Object.keys(reportModules).find(
                        key => key.toLowerCase() === globKey.toLowerCase()
                    );
                    if (matchingKey) {
                        loader = reportModules[matchingKey];
                        logDebug('Window: Resolved component with case-insensitive match:', matchingKey, '(requested:', globKey + ')');
                    }
                }
                
                if (!loader) {
                    throw new Error(`Component not found in glob map: ${basePath}. Available keys: ${Object.keys(reportModules).slice(0, 5).join(', ')}...`);
                }
                
                // Load the module using the glob loader
                const module = await loader();
                logDebug('Window: Successfully loaded component');
                
                if (!module || !module.default) {
                    throw new Error('Module loaded but has no default export');
                }
                
                // Create a wrapper component that passes props
                const WrappedComponent = (componentProps: Record<string, any>) => {
                    const Component = module.default;
                    return <Component {...componentProps} {...props} />;
                };
                
                setComponent(() => WrappedComponent);
                setHideHeader(false);
                logDebug('Window: Component set successfully');
            } else {
                logError('Window: Invalid componentPath:', componentPath);
                setError('Invalid component path');
            }
        } catch (error: any) {
            logError(`Window: Error loading component ${componentPath}:`, error);
            setError(`Error loading component: ${error.message}. Path: ${componentPath}`);
            setComponent(null);
            setHideHeader(false);
        } finally {
            setLoading(false);
        }
    };

    // Function to ensure sources are initialized before loading components
    // This matches the Sidebar's ensureSourcesReady logic exactly
    const ensureSourcesReady = async (): Promise<void> => {
        const className = selectedClassName();
        const projectId = selectedProjectId();
        
        if (!className || !projectId) {
            logDebug('Window: No className or projectId, skipping source initialization');
            return;
        }
        
        // Check if sources are already ready
        if (sourcesStore.isReady()) {
            logDebug('Window: Sources already ready');
            return;
        }
        
        logDebug('Window: Waiting for sources to initialize...');
        // Wait for sources to be ready (with shorter timeout for faster initial load)
        let attempts = 0;
        const maxAttempts = 10; // 1 second max wait (same as Sidebar)
        while (!sourcesStore.isReady() && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        
        if (sourcesStore.isReady()) {
            logDebug('Window: Sources initialized successfully', {
                sourceCount: sourcesStore.sources().length
            });
        } else {
            logDebug('Window: Sources not ready after waiting, proceeding anyway');
        }
    };

    const fetchPageData = async (
        className: string,
        projectId: string,
        datasetId: number,
        pageName: string,
        objectName: string | null = null,
        date: string | null = null
    ) => {
        try {
            setLoading(true);
            setError(null);
            
            logDebug('Window: fetchPageData called', {
                className,
                projectId,
                datasetId,
                pageName,
                objectName,
                date
            });

            // Helper: normalize page names for comparison (case and whitespace insensitive)
            const normalizePageName = (name: string | null | undefined) =>
                (name || '').toString().replace(/\s+/g, '').toUpperCase();
            
            // Normalize page name once for use throughout the function
            const normalizedPageName = normalizePageName(pageName);
            
            // Special handling for MANEUVERS with objectName (submenu view)
            // Only load ManeuverWindow if objectName is provided (submenu click)
            // If no objectName, load the regular Maneuvers component from database (main menu click)
            if (normalizedPageName === 'MANEUVERS' && objectName) {
                logDebug('Window: MANEUVERS with view detected, loading ManeuverWindow directly (skipping API lookup)');
                try {
                    // Ensure sources are ready before loading component (same as Sidebar)
                    await ensureSourcesReady();
                    
                    // ManeuverWindow is now in pages/, use direct import (same as Sidebar)
                    logDebug('Window: Loading ManeuverWindow with view:', objectName);
                    const module = await import(/* @vite-ignore */ `./ManeuverWindow`);
                    const Component = module.default;
                    
                    // Create a wrapper that passes view and URL context/date so fleet-history scatter works (context=fleet, no date)
                    const WrappedManeuverWindow = (wrapperProps: any) => {
                        const urlParams = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
                        return (
                            <Component
                                {...wrapperProps}
                                view={objectName}
                                context={urlParams.get('context') || undefined}
                                date={urlParams.get('date') || undefined}
                            />
                        );
                    };
                    
                    setComponent(() => WrappedManeuverWindow);
                    setHideHeader(true);
                    setLoading(false);
                    return;
                } catch (error) {
                    logError('Window: Error loading ManeuverWindow:', error);
                    setError(`Error loading ManeuverWindow: ${error.message}`);
                    setLoading(false);
                    return;
                }
            }
            
            // Determine page type based on dataset_id or date (for day/fleet views)
            const hasDate = !!date && date !== '0';
            const isDatasetContext = datasetId > 0;
            const isDayContext = !isDatasetContext && hasDate;

            let pageType;
            let useUserEndpoint = false;
            
            if (isDayContext) {
                // Day (fleet) mode - mirror Sidebar MODE 2: use day/explore via /pages/all
                pageType = 'day/explore';
                useUserEndpoint = false;
            } else if (isDatasetContext) {
                // Dataset mode - mirror Sidebar MODE 1: use dataset/explore via user-specific endpoint
                pageType = 'dataset/explore';
                useUserEndpoint = true;
            } else {
                // Pure project-level context - use project/reports via /pages/all
                pageType = 'project/reports';
            }
            
            logDebug('Window: Using page_type:', pageType, 'useUserEndpoint:', useUserEndpoint);
            
            const controller = new AbortController();
            let endpoint;
            
            if (useUserEndpoint) {
                // For datasets, use the user-specific endpoint that includes user_id
                const userId = user()?.user_id || 1; // Fallback to 1 if user not loaded yet
                endpoint = `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&user_id=${encodeURIComponent(userId)}&page_type=${encodeURIComponent(pageType)}`;
            } else {
                // For project-level, use the all pages endpoint
                endpoint = `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&page_type=${encodeURIComponent(pageType)}`;
            }
            
            logDebug('Window: Fetching from endpoint:', endpoint);
            
            let response = await getData(endpoint, controller.signal);
            
            logDebug('Window: Response received:', response);
            
            if (response.success && response.data) {
                let foundPage = response.data.find(
                    item => normalizePageName(item.page_name) === normalizePageName(pageName)
                );
                
                logDebug('Window: Found page in first attempt:', foundPage ? 'yes' : 'no');
                
                // If not found in first page type, try the other appropriate type based on context
                if (!foundPage && isDatasetContext) {
                    // Dataset mode fallback: dataset/reports via user-specific endpoint
                    logDebug('Window: Trying fallback to dataset/reports');
                    const controller2 = new AbortController();
                    const userId = user()?.user_id || 1; // Fallback to 1 if user not loaded yet
                    const fallbackEndpoint = `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&user_id=${encodeURIComponent(userId)}&page_type=dataset/reports`;
                    logDebug('Window: Fallback endpoint:', fallbackEndpoint);
                    response = await getData(fallbackEndpoint, controller2.signal);
                    if (response.success && response.data) {
                        foundPage = response.data.find(
                            item => normalizePageName(item.page_name) === normalizePageName(pageName)
                        );
                        logDebug('Window: Found page in dataset/reports:', foundPage ? 'yes' : 'no');
                    }
                } else if (!foundPage && isDayContext && date) {
                    // Day mode fallback: day report pages from day_pages (date-scoped)
                    logDebug('Window: Trying fallback to day/reports');
                    const controller2 = new AbortController();
                    const fallbackEndpoint = `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&page_type=day/reports&date=${encodeURIComponent(date)}`;
                    logDebug('Window: Fallback endpoint:', fallbackEndpoint);
                    response = await getData(fallbackEndpoint, controller2.signal);
                    if (response.success && response.data) {
                        foundPage = response.data.find(
                            item => normalizePageName(item.page_name) === normalizePageName(pageName)
                        );
                        logDebug('Window: Found page in day/reports:', foundPage ? 'yes' : 'no');
                    }
                } else if (!foundPage && !isDatasetContext && !isDayContext) {
                    // Project-level fallback: project/all/reports
                    logDebug('Window: Trying fallback to project/all/reports');
                    const controller2 = new AbortController();
                    const fallbackEndpoint = `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&page_type=project/all/reports`;
                    logDebug('Window: Fallback endpoint:', fallbackEndpoint);
                    response = await getData(fallbackEndpoint, controller2.signal);
                    if (response.success && response.data) {
                        foundPage = response.data.find(
                            item => normalizePageName(item.page_name) === normalizePageName(pageName)
                        );
                        logDebug('Window: Found page in project/all/reports:', foundPage ? 'yes' : 'no');
                    }
                }
                
                if (foundPage) {
                    // Check if page name contains 'Live' - require live mode to be enabled
                    if (pageName && pageName.toLowerCase().includes('live')) {
                        if (!liveMode()) {
                            const errorMsg = `Cannot load "${pageName}" - Live mode must be enabled first`;
                            logError('Window:', errorMsg);
                            setError(errorMsg);
                            setLoading(false);
                            return;
                        }
                        logDebug('Window: Loading Live component, live mode is enabled');
                    }
                    
                    logDebug('Window: Found page, loading component:', foundPage.file_path);
                    // Note: MANEUVERS with objectName is handled above, before this point
                    // For MANEUVERS without objectName, ensure sources are ready (same as Sidebar does for regular components)
                    if (normalizedPageName === 'MANEUVERS' && !objectName) {
                        logDebug('Window: MANEUVERS main menu detected, ensuring sources ready before loading');
                        await ensureSourcesReady();
                    }
                    
                    if (objectName && foundPage.file_path.includes('/explore/')) {
                        // For explore pages, pass the objectName as a prop
                        await loadComponent(foundPage.file_path, { objectName });
                    } else {
                        // Regular component loading
                        await loadComponent(foundPage.file_path);
                    }
                } else {
                    // Special case: MANEUVERS might not be in pages table
                    // normalizedPageName is already defined above
                    if (normalizedPageName === 'MANEUVERS') {
                        if (objectName) {
                            // MANEUVERS with view (submenu) - load ManeuverWindow directly
                            logDebug('Window: MANEUVERS with view not found in pages table, loading ManeuverWindow directly');
                            try {
                                // Ensure sources are ready before loading component (same as Sidebar)
                                await ensureSourcesReady();
                                
                                // ManeuverWindow is now in pages/, use direct import (same as Sidebar)
                                const module = await import(/* @vite-ignore */ `./ManeuverWindow`);
                                const Component = module.default;
                                
                                // Create a wrapper that passes view and URL context/date so fleet-history scatter works (context=fleet, no date)
                                const WrappedManeuverWindow = (wrapperProps: any) => {
                                    const urlParams = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
                                    return (
                                        <Component
                                            {...wrapperProps}
                                            view={objectName}
                                            context={urlParams.get('context') || undefined}
                                            date={urlParams.get('date') || undefined}
                                        />
                                    );
                                };
                                
                                setComponent(() => WrappedManeuverWindow);
                                setHideHeader(true);
                                setLoading(false);
                                return;
                            } catch (error) {
                                logError('Window: Error loading ManeuverWindow directly:', error);
                                setError(`Error loading ManeuverWindow: ${error.message}`);
                                setLoading(false);
                                return;
                            }
                        } else {
                            // MANEUVERS without objectName (main menu) - try loading from expected path
                            logDebug('Window: MANEUVERS not found in pages table, trying to load from expected path');
                            try {
                                // Ensure sources are ready before loading component
                                await ensureSourcesReady();
                                
                                // Try loading from the expected path: gp50/dataset/reports/Maneuvers
                                const expectedPath = `${className}/dataset/reports/Maneuvers`;
                                logDebug('Window: Attempting to load MANEUVERS from expected path:', expectedPath);
                                await loadComponent(expectedPath);
                                return;
                            } catch (error) {
                                logError('Window: Error loading MANEUVERS from expected path:', error);
                                // Fall through to show error message
                            }
                        }
                    }
                    
                    const errorMsg = `Page "${pageName}" not found in any page type`;
                    logError('Window:', errorMsg);
                    setError(errorMsg);
                    setLoading(false);
                }
            } else {
                const errorMsg = 'Failed to fetch page data';
                logError('Window:', errorMsg);
                setError(errorMsg);
                setLoading(false);
            }
        } catch (error: any) {
            logError('Window: Error fetching page data:', error);
            setError(`Error fetching page data: ${error.message}`);
            setLoading(false);
        }
    };

    // Fetch source name and date info for header
    const fetchHeaderInfo = async (className: string, projectId: string, datasetId: number) => {
        try {
            // Use synchronized selectedSourceName if available, otherwise fetch from API
            let sourceName = selectedSourceName() || '';
            
            // If we don't have a source name from persistent store, fetch from API
            if (!sourceName) {
                const sourcesResponse = await getData(`${apiEndpoints.app.sources}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}`);
                if (sourcesResponse.success && sourcesResponse.data && sourcesResponse.data.length > 0) {
                    // If we have a selectedSourceId, find that specific source
                    if (selectedSourceId() > 0) {
                        const matchingSource = sourcesResponse.data.find(src => src.source_id === selectedSourceId());
                        sourceName = matchingSource ? matchingSource.source_name : sourcesResponse.data[0].source_name;
                    } else {
                        sourceName = sourcesResponse.data[0].source_name;
                    }
                }
            }
            
            // Fetch dataset date if datasetId > 0
            let datasetDate = '';
            if (datasetId > 0) {
                const datasetResponse = await getData(`${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`);
                if (datasetResponse.success && datasetResponse.data && datasetResponse.data.date) {
                    datasetDate = datasetResponse.data.date;
                }
            }
            
            return { sourceName, date: datasetDate };
        } catch (error: any) {
            logError('Window: Error fetching header info:', error);
            return { sourceName: '', date: '' };
        }
    };

    // Add URL parameter handling for standalone window mode
    onMount(async () => {
        // Set window name early, before any message handlers or communication
        if (!window.name) {
            window.name = `window-${Date.now()}`;
        }
        
        // Setup cross-window communication
        const cleanup = setupCrossWindowCommunication();
        
        // Store cleanup function
        onCleanup(cleanup);

        // Ensure playback store listens for cross-window updates (e.g. selectedTime from parent)
        // so PlaybackTimeSeries and other playback-dependent components update in split view
        startPeriodicSync();

        // Request current filter, selection, persistent store, and global store state from parent window
        if (window.opener && !window.opener.closed) {
            // Wait a bit to ensure message handler is set up
            await new Promise(resolve => setTimeout(resolve, 50));
            
            window.opener.postMessage({
                type: 'REQUEST_FILTER_STATE',
                windowName: window.name
            }, window.location.origin);
            
            window.opener.postMessage({
                type: 'REQUEST_SELECTION_STATE',
                windowName: window.name
            }, window.location.origin);
            
            window.opener.postMessage({
                type: 'REQUEST_PERSISTENT_STATE',
                windowName: window.name
            }, window.location.origin);
            
            window.opener.postMessage({
                type: 'REQUEST_GLOBAL_STATE',
                windowName: window.name
            }, window.location.origin);
        }

        const urlParams = new URLSearchParams(window.location.search);
        const projectId = urlParams.get('project_id');
        const datasetId = urlParams.get('dataset_id') || '0';
        const pageName = urlParams.get('page_name');
        const className = urlParams.get('class_name');
        const objectName = urlParams.get('object_name');
        const dateParam = urlParams.get('date') || '';
        
        logDebug('URL params:', {
            projectId,
            datasetId,
            pageName,
            className,
            objectName,
            date: dateParam
        });
        
        if (projectId && pageName && className) {
            // Set persistent store values from URL params (needed for sourcesStore and components)
            setSelectedClassName(className);
            setSelectedProjectId(projectId);
            setSelectedDatasetId(parseInt(datasetId));
            
            // Fetch header info first
            const { sourceName, date } = await fetchHeaderInfo(className, projectId, parseInt(datasetId));
            
            // Set header info
            setHeaderInfo({
                className: className,
                sourceName: sourceName,
                // Prefer explicit date param (for day/fleet views); fall back to dataset date
                date: dateParam || date,
                pageName: objectName ? `${pageName}: ${objectName}` : pageName
            });
            
            // Then fetch and load the component
            try {
                await fetchPageData(className, projectId, parseInt(datasetId), pageName, objectName, dateParam || null);
            } catch (error: any) {
                logError('Window: Error in fetchPageData:', error);
                setError(`Error loading page: ${error.message || 'Unknown error'}`);
                setLoading(false);
            }
        } else {
            setError('Missing required parameters: project_id, page_name, or class_name');
        }
    });

    // Watch for selectedSourceName changes from persistent store and update header
    createEffect(() => {
        const currentSourceName = selectedSourceName();
        if (currentSourceName && currentSourceName !== '') {
            // Update header info when selectedSourceName changes (from cross-window sync)
            setHeaderInfo(prev => ({
                ...prev,
                sourceName: currentSourceName
            }));
        }
    });

    return (
        <div id="window" style="width: 100%; height: 100vh; display: flex; flex-direction: column; overflow: hidden;">
            <Show when={!hideHeader()}>
                <header class="header" style="flex-shrink: 0;">
                    <Show when={headerInfo().className && (headerInfo().sourceName || sidebarState() === 'live' || streamingStore.isInitialized)}>
                        <span class="logo-subtitle">
                            {headerInfo().className.toUpperCase()}
                            <Show when={sidebarState() !== 'live' && !streamingStore.isInitialized && headerInfo().sourceName}>
                                <span> - {headerInfo().sourceName}</span>
                            </Show>
                            <Show when={sidebarState() === 'live' || streamingStore.isInitialized}>
                                <span> - LIVE</span>
                            </Show>
                            <Show when={headerInfo().date}>
                                <span class="logo-date"> - {headerInfo().date}</span>
                            </Show>
                        </span>
                    </Show>
                </header>
            </Show>

            {/* Main content area */}
            <div id="main-content" style="flex: 1; overflow: auto; padding: 0px;">
                <Switch>
                    <Match when={loading()}>
                        <div style="padding: 20px;">Loading component...</div>
                    </Match>
                    <Match when={error()}>
                        <div style="color: red; padding: 20px;">
                            <h3>Error:</h3>
                            <p>{error()}</p>
                        </div>
                    </Match>
                    <Match when={component()}>
                        <Dynamic component={component()} />
                    </Match>
                    <Match when={!loading() && !error() && !component()}>
                        <div style="padding: 20px;">No component to display</div>
                    </Match>
                </Switch>
            </div>
        </div>
    );
}
