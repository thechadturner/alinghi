import { createSignal, Show, createEffect, onMount, onCleanup } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { config } from "@config/env";
import { debug as logDebug, error as logError, log } from "../../../../utils/console";
import { persistantStore } from "../../../../store/persistantStore";
import { setCurrentDataset } from "../../../../store/datasetTimezoneStore";
import { user } from "../../../../store/userStore";
import { apiEndpoints } from "@config/env";
import { getData } from "../../../../utils/global";
import Loading from "../../../../components/utilities/Loading";
import VideoComponent from "../../../../components/charts/Video";
import Overlay from "../../../../components/charts/Overlay";
import PlayPause from "../../../../components/utilities/PlayPause";
import MapTimeSeries from "../../../../components/charts/map/MapTimeSeries";
import { registerActiveComponent, unregisterActiveComponent } from "../../../../pages/Dashboard";
import { SELECTED_SOURCE_SENTINEL } from "../../../../utils/builderConstants";
import { sourcesStore } from "../../../../store/sourcesStore";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";

interface VideoPageProps {
  objectName?: string;
  /** When true, video is in split view; show MapTimeSeries and PlayPause when the other panel is TimeSeries. */
  isInSplitView?: boolean;
  /** When in split view (right panel), the menu name of the left panel. */
  mainPanelMenu?: string | null;
  /** When in split view (left panel), the menu name of the right panel. */
  rightPanelMenu?: string | null;
  [key: string]: any;
}

const { selectedClassName, selectedProjectId, selectedDatasetId, setSelectedPage, selectedSourceName, selectedSourceId } = persistantStore;

export default function VideoPage(props: VideoPageProps) {
    // Only use router hooks if we're not in split view
    let location: ReturnType<typeof useLocation> | null;
    let navigate: ((path: string) => void) | null;
    try {
        location = useLocation();
        navigate = useNavigate();
    } catch (error: any) {
        // If router hooks fail (e.g., in split view), set to null
        location = null;
        navigate = null;
    }
    const [isLoading, setIsLoading] = createSignal<boolean>(false);
    const [chartConfig, setChartConfig] = createSignal<any | null>(null);
    const [hasChartConfig, setHasChartConfig] = createSignal<boolean>(false);
    const [isHovering, setIsHovering] = createSignal<boolean>(false); // Track mouse hover state
    const [isHoveringTimeline, setIsHoveringTimeline] = createSignal<boolean>(false); // Show play/pause only when mouse is in timeseries area
    const [isTimelineLoading, setIsTimelineLoading] = createSignal<boolean>(true); // Start true so we show loading until MapTimeSeries reports ready; updated by onLoadingChange
    
    // Get object name from props or use default
    const objectName = props?.objectName || 'default';
    const isInSplitView = () => !!props?.isInSplitView;
    /** True when the other panel is TimeSeries — show timeline so user can change time and play/pause from video. */
    const isOtherPanelTimeSeries = () => {
        const other = (props?.mainPanelMenu ?? props?.rightPanelMenu ?? "").toString();
        const norm = other.replace(/\s+/g, "").toLowerCase();
        return norm.includes("timeseries") || norm === "timeseries";
    };
    
    // Set the selected page when component loads
    if (objectName && objectName !== 'default') {
        setSelectedPage(objectName);
    }
    
    // Fetch chart configuration
    const fetchChartConfig = async () => {
        setIsLoading(true);
        try {
            logDebug('🎥 VideoPage: Fetching chart configuration', {
                objectName,
                className: selectedClassName(),
                projectId: selectedProjectId()
            });
            
            const currentUser = user();
            if (!currentUser?.user_id) {
                setChartConfig(null);
                setHasChartConfig(false);
                return;
            }
            const response = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=video&object_name=${objectName}&page_name=default`);
            
            logDebug('🎥 VideoPage: API response received', {
                success: response?.success,
                hasData: !!response?.data,
                hasChartInfo: !!response?.data?.chart_info,
                chartInfoType: typeof response?.data?.chart_info,
                fullResponse: response
            });
            
            if (!response.success || !response.data || !response.data.chart_info) {
                logDebug('🎥 VideoPage: No chart configuration found (no saved layout yet), using selected source as default', response);
                // For non-admin or first-time: default to selected sourcename / selected source as video type so video still shows
                const sname = selectedSourceName();
                const sid = selectedSourceId();
                let defaultSource = 'Youtube';
                if (typeof sname === 'string' && sname.trim() !== '' && String(sname).trim().toUpperCase() !== 'ALL') {
                    defaultSource = String(sname).trim();
                } else if (typeof sid === 'number' && Number.isFinite(sid) && sid > 0 && sourcesStore.isReady()) {
                    const nameFromId = sourcesStore.getSourceName(sid);
                    if (nameFromId) defaultSource = nameFromId;
                }
                const defaultChartData = { layout: 1, sources: [defaultSource] };
                logDebug('🎥 VideoPage: Using default chart config from selected source', { defaultSource, selectedSourceName: sname, selectedSourceId: sid });
                setChartConfig(defaultChartData);
                setHasChartConfig(true);
                return;
            }

            const chartData = response.data.chart_info;
            
            if (!chartData) {
                logError('🎥 VideoPage: Chart data is undefined', { response, chartInfo: response.data.chart_info });
                setChartConfig(null);
                setHasChartConfig(false);
                return;
            }
            
            setChartConfig(chartData);
            setHasChartConfig(true);
            
            logDebug('🎥 VideoPage: Chart configuration loaded', {
                layout: chartData.layout,
                sources: chartData.sources,
                chartName: chartData.chart_name,
                parentName: chartData.parent_name,
                fullChartData: chartData
            });
            
        } catch (error: unknown) {
            logError('🎥 VideoPage: Failed to fetch chart configuration', error as any);
            setChartConfig(null);
            setHasChartConfig(false);
        } finally {
            setIsLoading(false);
        }
    };
    
    onMount(async () => {
        // Set current dataset first so Video component gets getCurrentDatasetTimezone() for media API date (same as VideoSync)
        const className = selectedClassName();
        const projectId = selectedProjectId();
        const datasetId = typeof selectedDatasetId === "function" ? selectedDatasetId() : null;
        if (className && projectId && datasetId && datasetId > 0) {
            await setCurrentDataset(className, projectId, datasetId).catch(() => {});
        }
        fetchChartConfig();
        // Prefetch map/timeline data so MapTimeSeries can use cache when it mounts (faster timeline load)
        const sourceId = typeof selectedSourceId === "function" ? selectedSourceId() : null;
        const sourceIdNum = sourceId != null ? Number(sourceId) : 0;
        if (className && projectId && datasetId && datasetId > 0 && sourceIdNum > 0) {
            unifiedDataStore.fetchMapDataForDataset(className, projectId, datasetId, sourceIdNum).catch(() => {});
        }
    });
    
    onCleanup(() => {
        // Unregister this component
        unregisterActiveComponent('video');
    });
    
    // Register/unregister as active component based on video availability
    createEffect(() => {
        if (hasChartConfig()) {
            // Only register as active when video is available
            registerActiveComponent('video');
        } else {
            // Unregister when no video is available
            unregisterActiveComponent('video');
        }
    });
    
    // Handle navigation to VideoSync page
    const handleSyncNavigation = () => {
        logDebug('🎥 VideoPage: Navigating to video-sync page');
        if (navigate) {
            navigate('/video-sync');
        } else {
            log('Video: Cannot navigate to video-sync in split view');
        }
    };
    
    // Render video components based on layout
    const renderVideoLayout = () => {
        const config = chartConfig();
        if (!config) {
            return null;
        }
        
        const layout = config.layout || 1;
        const defaultSource = selectedSourceName() && selectedSourceName() !== 'ALL' ? selectedSourceName() : 'Youtube';
        const sources = (config.sources && config.sources.length > 0) ? config.sources : [defaultSource];
        const resolvedSources = sources.map((s: string) => s === SELECTED_SOURCE_SENTINEL ? defaultSource : s);
        
        logDebug('🎥 VideoPage: Rendering video layout', { layout, sources: resolvedSources });
        
        // Helper function to render a video component
        const renderVideoComponent = (source: string, index: number) => (
            <div class="w-full h-full flex items-center justify-center">
                <VideoComponent
                    media_source={source}
                    width="100%"
                    height="100%"
                    style="max-width: 100%; max-height: 100%; object-fit: contain;"
                />
            </div>
        );
        
        switch (layout) {
            case 1:
                // Single video full screen
                return (
                    <div class="w-full h-full flex items-center justify-center overflow-hidden">
                        {renderVideoComponent(resolvedSources[0], 0)}
                    </div>
                );
                
            case 2:
                // Two videos side by side, 50% width each
                return (
                    <div class="w-full h-full flex overflow-hidden">
                        {resolvedSources.slice(0, 2).map((source: string, index: number) => (
                            <div class="w-1/2 h-full flex items-center justify-center overflow-hidden">
                                {renderVideoComponent(source, index)}
                            </div>
                        ))}
                    </div>
                );
                
            case 3:
                // One video on left (66%), two videos on right (33% width total, stacked)
                return (
                    <div class="w-full h-full flex overflow-hidden">
                        {/* Left video - 66% width */}
                        <div class="w-2/3 h-full flex items-center justify-center overflow-hidden">
                            {renderVideoComponent(resolvedSources[0], 0)}
                        </div>
                        {/* Right videos - 33% width, stacked */}
                        <div class="w-1/3 h-full flex flex-col overflow-hidden">
                            {resolvedSources.slice(1, 3).map((source: string, index: number) => (
                                <div class="w-full h-1/2 flex items-center justify-center overflow-hidden">
                                    {renderVideoComponent(source, index + 1)}
                                </div>
                            ))}
                        </div>
                    </div>
                );
                
            case 4:
                // Four videos in a 2x2 grid, 25% width and height each
                return (
                    <div class="w-full h-full grid grid-cols-2 grid-rows-2">
                        {resolvedSources.slice(0, 4).map((source: string, index: number) => (
                            <div class="w-full h-full flex items-center justify-center">
                                {renderVideoComponent(source, index)}
                            </div>
                        ))}
                    </div>
                );
                
            case 5:
                // Two videos stacked vertically, 50% height each
                return (
                    <div class="w-full h-full grid grid-rows-2 overflow-hidden">
                        {resolvedSources.slice(0, 2).map((source: string, index: number) => (
                            <div class="w-full h-full flex items-center justify-center overflow-hidden">
                                <VideoComponent
                                    media_source={source}
                                    style="width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: contain;"
                                />
                            </div>
                        ))}
                    </div>
                );
                
            default:
                logError('🎥 VideoPage: Unknown layout', layout);
                return (
                    <div class="w-full h-full flex items-center justify-center">
                        <div class="text-red-500">Unknown layout: {layout}</div>
                    </div>
                );
        }
    };
    
    return (
        <div 
            id="video-container"
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
            class="flex flex-col w-full h-full min-h-0"
        >
            <div class="video-page-container flex flex-col flex-1 min-h-0 w-full">
                <Show when={isLoading()}>
                    <Loading />
                </Show>

                {/* Video area: flex-1 with overlay for play/pause (like explore/map) */}
                <Show when={!isLoading() && hasChartConfig()}>
                    <div class="video-area flex-1 min-h-0 w-full relative overflow-hidden">
                        <div class="w-full h-full overflow-hidden">
                            {renderVideoLayout()}
                        </div>
                        {/* Overlay component - positioned over the video */}
                        <Show when={chartConfig()?.overlayName && chartConfig().overlayName !== 'No overlay' && chartConfig().overlayName !== ''}>
                            <Overlay padding_top="50px" padding_right="25px" color="#000" overlayName={chartConfig().overlayName} />
                        </Show>
                        {/* Synchronization button - upper left over video */}
                        <Show when={isHovering()}>
                            <button
                                onClick={handleSyncNavigation}
                                class="video-sync-button"
                                style={{
                                    position: 'absolute',
                                    top: '10px',
                                    left: '10px',
                                    width: '40px',
                                    height: '40px',
                                    'border-radius': '50%',
                                    border: 'none',
                                    'background-color': 'rgba(0, 0, 0, 0.7)',
                                    color: 'white',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    'align-items': 'center',
                                    'justify-content': 'center',
                                    'z-index': 20,
                                    transition: 'background-color 0.2s ease'
                                }}
                                title="Open Video Synchronization"
                                onMouseEnter={(e) => {
                                    const target = e.currentTarget;
                                    target.style.setProperty('background-color', 'rgba(0, 0, 0, 0.9)');
                                }}
                                onMouseLeave={(e) => {
                                    const target = e.currentTarget;
                                    target.style.setProperty('background-color', 'rgba(0, 0, 0, 0.7)');
                                }}
                            >
                                <svg
                                    width="20"
                                    height="20"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    xmlns="http://www.w3.org/2000/svg"
                                    class="text-white"
                                >
                                    <path
                                        d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"
                                        fill="currentColor"
                                    />
                                </svg>
                            </button>
                        </Show>
                    </div>
                </Show>

                <Show when={!isLoading() && !hasChartConfig()}>
                    <div class="flex-1 min-h-0 w-full flex items-center justify-center">
                        <div class="text-center">
                            <div class="text-gray-500 text-lg mb-2">No video found</div>
                        </div>
                    </div>
                </Show>

                {/* Timeline section: MapTimeSeries with play/pause overlay (visible on hover). Show when not in split view, or when split with TimeSeries. */}
                <Show when={!isInSplitView() || isOtherPanelTimeSeries()}>
                    <div
                        class="video-timeline-section video-timeline-section-compact"
                        style="flex-shrink: 0; width: 100%; display: flex; flex-direction: column; border-top: 1px solid var(--color-border-primary); position: relative; z-index: 20;"
                        onMouseEnter={() => setIsHoveringTimeline(true)}
                        onMouseLeave={() => setIsHoveringTimeline(false)}
                    >
                        <div
                            class="video-timeline-container"
                            style="flex-shrink: 0; width: 100%; height: 120px; background: var(--color-bg-card); position: relative;"
                        >
                            <MapTimeSeries
                                maptype="DEFAULT"
                                samplingFrequency={1}
                                onMapUpdate={() => {}}
                                mapFilterScope="raceLegOnly"
                                videoOnly={true}
                                brushEnabled={false}
                                onLoadingChange={(loading) => setIsTimelineLoading(loading)}
                            />
                            <div class={`timeline-controls-overlay${isHoveringTimeline() ? " timeline-controls-overlay-visible" : ""}`}>
                                <PlayPause position="timeline-overlay" allowFastFwd={true} allowTimeWindow={true} />
                            </div>
                            <Show when={isTimelineLoading()}>
                                <div
                                    class="video-timeline-loading-overlay"
                                    style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--color-bg-card); z-index: 25;"
                                >
                                    <Loading message="Loading timeline..." />
                                </div>
                            </Show>
                        </div>
                    </div>
                </Show>
            </div>
        </div>
    );
}
